// login 那一组路由（18 条）：/login/state · /login/qr/start · /login/qr/poll · /login/sms/start · /login/sms/send · /login/sms/slider · /login/sms/submit · /login/app/start · /login/app/send · /login/app/slider · /login/app/submit · /login/pwd · /login/cancel · /login/device/reset · /h5 · /h5/auth · /h5/step · /auth/refresh
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { loadBaseUrl } from '../../../mcloud/session.ts';
import { runAuthRefresh } from '../../../mcloud/authRefresh.ts';
import { APP_AUTH_PREFIX } from '../../../mcloud/auth.ts';
import { currentAccount } from '../../../mcloud/accounts.ts';
import { JWT_TTL_MS, authStatus, clearAuth, jwtFresh, loadAuthRaw, loadExchange, loadJwt, maskMobile, needExchange, runExchangeStep, startExchange } from '../../../mcloud/sessionExchange.ts';
import { qrSvg } from '../../../crypto/qr.ts';
import { callOnce } from '../../../mcloud/client.ts';
import { CODES, LOGIN_AES_KEY, PC_AUTH_PREFIX, QR_TTL_SECONDS, applyPoll, classifyPoll, classifySendSms, isSuccessCode, parsePcPlatform, parseSliderPuzzle, passwordThirdloginBody, pcClient, puzzleVerfycodeEncrypt, qrExpired, qrPayload, qrRemainingMs, qrThirdloginBody, sendSmsCodeBody, sendSmsCodeBodyWithSlider, sendSmsCodeRequest, sliderAnswer, sliderPuzzleBody, sliderPuzzleRequest, smsThirdloginBody, thirdloginRequest } from '../../../mcloud/login.ts';
import type { SliderPuzzle } from '../../../mcloud/login.ts';
import { QR_POLL_MS, clearLogin, loadAppSession, loadDeviceId, loadQrSession, loadSmsSession, loginReading, resetDeviceId, saveAppSession, saveQrSession, saveSmsSession, setSmsSlider, startAppSession, startQrSession, startSmsSession } from '../../../mcloud/loginSession.ts';
import { rawStoreOf, scoped } from '../../../store/scoped.ts';
import { APP_LOGIN_AES_KEY, APP_SLIDER_PUZZLE_PATH, appPost, appSendSmsCodeRequest, appThirdloginRequest, classifyAppLogin, classifyAppSendSms, decryptAppUserInfo } from '../../../mcloud/appLogin.ts';
import { adoptLoginResult, autoPassSlider, json, loadLoginBase, loginCall, loginPlatform, newTid, readBody, sessionPlatform } from '../support.ts';
import type { RouteDeps, RouteEntry, SliderSendResult } from '../support.ts';

/** login 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function loginRoutes(deps: RouteDeps, base: string, verify: () => Promise<{ ok: boolean; note: string }>): RouteEntry[] {
  void verify;
  return [
{
      // 登录页的读数（一次给全）。凭据**不进这里** —— 只给掩码过的形状。
      path: `${base}/login/state`,
      method: 'GET',
      handler: async () =>
        json(200, {
          ...(() => {
            const r = loginReading(deps.store, Date.parse(deps.now()), (sid, did) =>
              qrPayload(pcClient(sessionPlatform(deps.store), did), sid),
            );
            // 二维码由**插件这一侧**渲染成 SVG（浏览器里没有二维码库）
            return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
          })(),
          platform: sessionPlatform(deps.store),
        }),
    },

{
      // 出码。**不发任何上游请求** —— 客户端源码里就是字符串拼接，
      // 实测 1622 个 body 文件里也没有对应的取码接口。
      path: `${base}/login/qr/start`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { pcPlatform?: unknown };
        // ⚠ 形态**在这一刻定下来**（用户出码前选的那个），冻进会话；
        //   之后改界面上的选择也不会改到这张码 —— 想换就重新出码。
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const nowMs = Date.parse(deps.now());
        const s = startQrSession(deps.store, nowMs, deps.now(), platform);
        const c = pcClient(s.platform, s.deviceId);
        const payload = qrPayload(c, s.sessionId);
        deps.log(`扫码登录：已出码（${s.platform === 'macos' ? 'macOS' : 'Windows'}），等手机扫`);
        return json(200, {
          sessionId: s.sessionId,
          payload,
          platform: s.platform,
          // **在插件这一侧编码**、界面只画格子：浏览器里没有二维码库，
          // 在那里现写一个等于把"码对不对"交给前端（见 crypto/qr.ts 的文件头）。
          svg: qrSvg(payload),
          expiresInMs: QR_TTL_SECONDS * 1000,
          // ⚠ 轮询间隔**由这一侧给**，界面不许自己写死一个数 ——
          //   参考实现的注释：「客户端写死一个数会和状态机分叉」。
          //   2 秒是"人扫完到界面看到"的延迟与上游压力的折中。
          pollMs: QR_POLL_MS,
          note: '用手机上的移动云盘 App 扫这个码，然后在手机上确认',
        });
      },
    },

{
      // 轮一次。**"还没扫"不是错误** —— 轮询期间绝大多数响应都是它。
      path: `${base}/login/qr/poll`,
      method: 'POST',
      handler: async () => {
        const s = loadQrSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的扫码登录（先点「扫码登录」）' });
        const nowMs = Date.parse(deps.now());
        // ⚠ 每一次回应都带上"这张码还剩多少毫秒"：界面上那一行要显示倒计时，
        //   而轮询每 2 秒就会把那行重写一次 —— 不带这个数的话，第一次轮询之后
        //   倒计时就消失了（用户判断"码还活着吗"全靠它）。
        const remain = qrRemainingMs(s, nowMs);
        if (qrExpired(s, nowMs)) {
          return json(200, {
            stop: true,
            ok: false,
            note: '二维码过期了，点「扫码登录」重新出码',
            expiresInMs: 0,
            pollMs: QR_POLL_MS,
          });
        }
        const c = pcClient(s.platform, s.deviceId);
        const r = await loginCall(
          deps,
          // ⚠ 用**会话里那一个** `x-yun-tid`（整趟复用），不要每轮新生成 ——
          //   参考实现的会话表存的就是 `(qr, tid, owner)`（F-071）。
          thirdloginRequest(c, s.tid, qrThirdloginBody(c, s.sessionId), loadLoginBase(deps.store)),
        );
        // ⚠⚠ 判据是「**有没有拿到信封**」（`r.env === null`），**不是** `r.ok`。
        //
        //  `callOnce` 的 `ok` 只对 `code === 0` 成立，而扫码登录轮询里绝大多数响应
        //  是 `code=200059541`（未找到设备的二维码信息 = **还没扫到**）—— 那是个
        //  **正常状态**，不是失败。写成 `!r.ok` 的后果：真上游一直在这一支里，
        //  界面上永远显示"移动云盘没回应（200）"，而码其实好好地在那儿等着。
        //  （这个洞和 F-067 那个"没人轮询"是叠在一起的：轮询从来没跑过 ⇒ 这一支
        //   也就从来没被真上游走到过。清空设置页、真的去打上游之后当场露出来。）
        if (r.env === null) {
          // ⚠ 到这儿才算"没问到"：网络失败**不当作登录失败**，会话还在，再点一次就好。
          //
          // ⚠ 这句话是**给用户看的**（它显示在二维码下面那一行）：
          //   写「移动云盘」而不是「上游」；原始错误压一下 —— 能抠出状态码就
          //   写「（404）」，抠不出来才原样带上（docs/ui-wording.md：
          //   「HTTP 502 不算说明」，但也要求留下原始文本，别只回一个数字）。
          //   ⚠ 只认 `HTTP 502` / `http status: 404` 这两种写法里的数字：
          //   宽松地抓"头三位数字"会把上游的 `code=200059541` 抓成「200」，
          //   于是界面上一句"移动云盘没回应（200）"看着像上游好好的（F-068）。
          //   ⚠ **空响应**单独说（F-070）：真机上实测到移动云盘偶尔回一个空体，
          //   而 `Unexpected end of JSON input` 这种解析器原话贴在二维码下面
          //   只会让人以为是自己哪里填错了。原文进日志。
          //   ⚠ **连不上**也单独说（F-071）：`io: Connection refused (os error 61)`
          //   是宿主那一层的话，用户看了只会以为是自己弄坏了什么。
          const err = r.error ?? '没有回应';
          deps.log(`扫码登录：问服务端没成（${err}）`);
          const empty = /不是 JSON/.test(err);
          const offline = /Connection refused|connection reset|io: |dns error|timed out|timeout/i.test(err);
          const code = /\b(?:HTTP|status:)\s*(\d{3})\b/.exec(err)?.[1];
          const why = empty
            ? '移动云盘回了个空响应 —— 过一会儿再点一次'
            : offline
              ? '连不上移动云盘 —— 过一会儿再点一次'
              : `移动云盘没回应（${code ?? err}），过一会儿再点一次`;
          return json(200, {
            stop: false,
            ok: true,
            note: why,
            retry: true,
            expiresInMs: remain,
            pollMs: QR_POLL_MS,
          });
        }
        const out = classifyPoll(r.env);
        const applied = applyPoll(s, out, nowMs);
        saveQrSession(deps.store, applied.session, deps.now());
        if (applied.encrypted !== undefined) {
          const adopted = adoptLoginResult(
            deps,
            applied.encrypted,
            '扫码登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform,
          );
          return json(200, { ...applied, ...adopted, stop: true });
        }
        // ⚠ 记日志的判据是「**结论变了**」，并且要带上上游的原话（`code`）。
        //
        //   原来只在 `applied.stop` 时记一条：于是"手机扫到了"这一步在日志里**没有痕迹**，
        //   真机上出问题只能靠猜（2026-10-17 排"扫了没用"就卡在这里：日志里只有出码
        //   与超时，中间那几十次轮询到底说了什么，一个字都没留下）。
        //   按"结论变了"记既补上了这条链，又不会每 2 秒刷一行。
        if (applied.note !== s.lastNote) {
          const raw = `${r.env.code ?? '无 code'}${r.env.message ? ` ${r.env.message}` : ''}`;
          deps.log(`扫码登录：${applied.note}（服务端 code=${raw}）`);
        }
        return json(200, {
          stop: applied.stop,
          ok: applied.ok,
          note: applied.note,
          scanned: applied.session.scanned,
          // ⚠ 终态（过期 / 会话对不上 / 限流）时剩余时间必须给 0：
          //   否则界面上会出现「二维码过期了 · 剩 119 秒」这种自相矛盾的一行
          //   （实测到过：出码后第一次轮询恰好撞上上游回 `200059542`）。
          expiresInMs: applied.stop ? 0 : remain,
          pollMs: QR_POLL_MS,
        });
      },
    },

{
      path: `${base}/login/sms/start`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { phone?: unknown; pcPlatform?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: '手机号要 11 位、以 1 开头' });
        // 形态同样在这一刻冻进会话（发码 / 取滑块 / 提交三步同一套档案）
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const s = startSmsSession(deps.store, phone, Date.parse(deps.now()), deps.now(), platform);
        return json(200, { phone: s.phone, platform: s.platform, note: '点「发验证码」' });
      },
    },

{
      // 发码。**可能被风控拦下** ⇒ 这一侧**自己去过滑块**，人只负责等短信。
      path: `${base}/login/sms/send`,
      method: 'POST',
      handler: async () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const base = loadLoginBase(deps.store);

        // 发一次（`answer` 为空 = 不带滑块答案）
        const attempt = async (answer?: string): Promise<SliderSendResult> => {
          const body =
            answer === undefined
              ? sendSmsCodeBody(c, s.phone, s.random)
              : sendSmsCodeBodyWithSlider(c, s.phone, s.random, answer);
          const r = await loginCall(deps, sendSmsCodeRequest(c, newTid(), body, base));
          // ⚠ 判据是「**有没有拿到信封**」（`r.env === null`）：非零 `code` 是
          //   **上游的回答**，要交给分类去说人话（"要过滑块" / "验证码不对"），
          //   不是网络故障。写成 `!r.ok` 的话，真上游的每一种回答都会被压成一句
          //   "发码请求没成功"，而那几句人话（分类）就成了永远走不到的死代码。
          if (r.env === null) return { kind: 'other', note: `发码请求没成功：${r.error}` };
          const out = classifySendSms(r.env);
          if (out.kind === 'sent') return { kind: 'sent', remainGetTimes: out.remainGetTimes };
          if (out.kind === 'need-slider') return { kind: 'need-slider' };
          if (out.kind === 'slider-exhausted') return { kind: 'exhausted' };
          return { kind: 'other', note: `发码没成：${out.message || `code=${out.code}`}` };
        };

        // 取一道**新**题并解出坐标（缺口坐标是解出来的，不是量出来的）
        const fetchAnswer = async (): Promise<{ answer: string } | { error: string }> => {
          const pr = await loginCall(deps, sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), base));
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            // 会话里留一份：界面上不画它，但排障时能对得上"这一轮用的哪道题"
            saveSmsSession(deps.store, { ...s, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };

        let sent: { remainGetTimes: number | null } | null = null;
        const first = await attempt();
        if (first.kind === 'sent') {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === 'other') {
          return json(200, { ok: false, note: first.note });
        } else {
          // 要过滑块（或旧题作废）⇒ **自动**取新题、解坐标、带答案重发
          deps.log(`短信登录：要过滑块（${first.kind === 'exhausted' ? '旧图已作废' : '首次发码被拦'}），自动过`);
          const passed = await autoPassSlider(deps, '短信登录', fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }

        const next = { ...s, sent: true, lastNote: '验证码已发出' };
        saveSmsSession(deps.store, next, deps.now());
        deps.log('短信登录：验证码已发出');
        return json(200, {
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note: '看手机短信，把 6 位验证码填进来',
        });
      },
    },

{
      // 取滑块拼图。**缺口坐标是解出来的**，不需要图像识别。
      path: `${base}/login/sms/slider`,
      method: 'POST',
      handler: async () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = await loginCall(
          deps,
          sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `取滑块失败：${r.error}` });
        if (!isSuccessCode(r.env.code)) {
          return json(200, { ok: false, note: `取滑块被拒：${r.env.message || `code=${r.env.code}`}` });
        }
        let puzzle;
        try {
          puzzle = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(502, { error: `滑块响应看不懂：${e instanceof Error ? e.message : String(e)}` });
        }
        // 先自检一遍能不能解出坐标 —— 解不开就别把图发给用户白拖
        let answer: string;
        try {
          answer = sliderAnswer(puzzle);
        } catch (e) {
          return json(502, { error: `滑块缺口解不开（服务端换字段了？）：${e instanceof Error ? e.message : String(e)}` });
        }
        setSmsSlider(deps.store, s, puzzle, deps.now());
        return json(200, {
          ok: true,
          background: puzzle.backgroundB64,
          piece: puzzle.puzzleB64,
          picWidth: puzzle.picWidth,
          puzzleWidth: puzzle.puzzleWidth,
          answer,
          note: '答案已经解出来了，点「带滑块发码」',
        });
      },
    },

{
      // 提交验证码。
      path: `${base}/login/sms/submit`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { code?: unknown };
        const code = typeof b.code === 'string' ? b.code.trim() : '';
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: '验证码要 4–8 位数字' });
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = await loginCall(
          deps,
          thirdloginRequest(c, newTid(), smsThirdloginBody(c, s.phone, code), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            '短信登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform,
          );
          return json(200, { ...adopted, stop: true });
        }
        const note =
          r.env.code === CODES.SMS_CODE_WRONG
            ? '验证码不对（或者过期了），再看一眼短信'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: false, note });
      },
    },

{
      path: `${base}/login/app/start`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { phone?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: '手机号要 11 位（1 开头）' });
        const a = startAppSession(deps.store, phone, Date.parse(deps.now()), deps.now());
        deps.log('手机端登录：手机号记下了');
        return json(200, { ok: true, phone: a.phone, note: '手机号记下了 —— 点「发验证码」' });
      },
    },

{
      path: `${base}/login/app/send`,
      method: 'POST',
      handler: async () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const nowMs = Date.parse(deps.now());

        // 发一次（`answer` 为空 = 不带滑块答案）
        const attempt = async (answer?: string): Promise<SliderSendResult> => {
          const puzzle = answer === undefined ? '' : puzzleVerfycodeEncrypt(answer);
          const r = await loginCall(
            deps,
            appSendSmsCodeRequest(deviceId, nowMs, a.phone, puzzle, loadLoginBase(deps.store)),
          );
          if (r.env === null) return { kind: 'other', note: `发码请求没成功：${r.error}` };
          const out = classifyAppSendSms(r.env);
          if (out.kind === 'sent') return { kind: 'sent', remainGetTimes: out.remainGetTimes };
          if (out.kind === 'need-captcha') return { kind: 'need-slider' };
          if (out.kind === 'slider-exhausted') return { kind: 'exhausted' };
          return { kind: 'other', note: out.note };
        };

        // 取一道**新**题并解出坐标（App 那条路径与 PC 同一个 `/user/verfycode`）
        const fetchAnswer = async (): Promise<{ answer: string } | { error: string }> => {
          const pr = await loginCall(
            deps,
            appPost(
              APP_SLIDER_PUZZLE_PATH,
              JSON.stringify(sliderPuzzleBody(a.phone)),
              deviceId,
              nowMs,
              loadLoginBase(deps.store),
            ),
          );
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            saveAppSession(deps.store, { ...a, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };

        let sent: { remainGetTimes: number | null } | null = null;
        const first = await attempt();
        if (first.kind === 'sent') {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === 'other') {
          return json(200, { ok: false, sent: false, note: first.note });
        } else {
          // ⚠ `exhausted` **不是**"账号被限流了"，而是"这一道题的尝试次数用完了"
          //   ⇒ 换一道新题。这一侧**自己去过**，不让用户拖。
          deps.log(`手机端登录：要过滑块（${first.kind === 'exhausted' ? '旧图已作废' : '首次发码被拦'}），自动过`);
          const passed = await autoPassSlider(deps, '手机端登录', fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, sent: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }

        saveAppSession(deps.store, { ...a, sent: true, lastNote: '验证码已发出' }, deps.now());
        deps.log('手机端登录：验证码已发出');
        return json(200, {
          ok: true,
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note:
            sent.remainGetTimes === null
              ? '验证码已发出'
              : `验证码已发出（今天还能发 ${sent.remainGetTimes} 次）`,
        });
      },
    },

{
      path: `${base}/login/app/slider`,
      method: 'POST',
      handler: async () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        // 题面体与 PC **一样**（`{account, type: 2}`，`type` 是数字）—— 路径也同一个
        //（`/user/verfycode`）。差别只在**请求头**是 App 那套。
        const r = await loginCall(
          deps,
          appPost(
            APP_SLIDER_PUZZLE_PATH,
            JSON.stringify(sliderPuzzleBody(a.phone)),
            deviceId,
            Date.parse(deps.now()),
            loadLoginBase(deps.store),
          ),
        );
        if (r.env === null) return json(502, { error: `取题面没成功：${r.error}` });
        let p: SliderPuzzle;
        try {
          p = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(200, { ok: false, note: `题面解不开：${e instanceof Error ? e.message : String(e)}` });
        }
        saveAppSession(deps.store, { ...a, slider: p, lastNote: '题面已取到' }, deps.now());
        return json(200, {
          ok: true,
          background: p.backgroundB64,
          note: '题面已取到 —— 缺口位置由这一侧解出，再点一次「发验证码」会带着答案发',
        });
      },
    },

{
      path: `${base}/login/app/submit`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { code?: unknown };
        const code = typeof b.code === 'string' ? b.code.trim() : '';
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: '验证码要 4–8 位数字' });
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const r = await loginCall(
          deps,
          appThirdloginRequest(
            deviceId,
            Date.parse(deps.now()),
            a.phone,
            code,
            a.random,
            undefined,
            loadLoginBase(deps.store),
          ),
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });

        const out = classifyAppLogin(r.env);
        if (out.kind === 'success') {
          // ⚠ 前缀是 **`mobile`**，钥匙是 **App 那把** —— 两处都与 PC 不同。
          const adopted = adoptLoginResult(deps, out.encrypted, '手机端登录成功', APP_AUTH_PREFIX, APP_LOGIN_AES_KEY, undefined, decryptAppUserInfo);
          return json(200, { ...adopted, stop: true });
        }
        return json(200, { ok: false, stop: false, note: out.note });
      },
    },

{
      // 账密登录**一个路由就完成** —— 它没有用户交互，所以不是状态机。
      path: `${base}/login/pwd`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { phone?: unknown; password?: unknown; pcPlatform?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        const password = typeof b.password === 'string' ? b.password : '';
        if (phone === '') return json(400, { error: '要填手机号' });
        if (password === '') return json(400, { error: '要填口令' });
        // ⚠ 这里原来**没读** `pcPlatform`（界面一直在发它）—— 于是"选了 macOS"
        //   在账密这一路上静默变成 Windows。形态是**请求里带的那一个**。
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const c = pcClient(platform, loadDeviceId(deps.store, deps.now()));
        const r = await loginCall(
          deps,
          thirdloginRequest(c, newTid(), passwordThirdloginBody(c, phone, password), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `登录请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            '账密登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            platform,
          );
          return json(200, { ...adopted, stop: true });
        }
        // ⚠ 错误信息里**不许回显口令**（日志与响应都不行）
        const note =
          r.env.code === CODES.LOGIN_FAILED
            ? '服务端说登录失败 —— 手机号或口令不对（也可能是设备头被拒）'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: true, note });
      },
    },

{
      path: `${base}/login/cancel`,
      method: 'POST',
      handler: async () => {
        clearLogin(deps.store);
        deps.log('登录：已取消');
        return json(200, { ok: true, note: '已取消' });
      },
    },

{
      // 「我的码一直扫不出来」的救命按钮。
      // ⚠ 换设备指纹**必须同时清会话** —— 旧会话的 dID 是旧指纹，继续轮只会
      //   一直 200059541（而这看起来像"码过期了"）。
      path: `${base}/login/device/reset`,
      method: 'POST',
      handler: async () => {
        const fresh = resetDeviceId(deps.store, deps.now());
        deps.log('登录：换了设备指纹（旧会话已清）');
        return json(200, { deviceId: fresh, note: '设备指纹已换新，旧会话已清 —— 重新出码' });
      },
    },

{
      // H5 换票（三步）：凭据状态 + 进度 + 换到的票。**都不回显凭据本身。**
      path: `${base}/h5`,
      method: 'GET',
      handler: async () => {
        const jwt = loadJwt(deps.store);
        return json(200, {
          auth: authStatus(deps.store),
          exchange: loadExchange(deps.store),
          // ⚠ 票**不**回显（长度也不给 —— 它比凭据更接近"能直接用"）
          jwt: jwt
            ? {
                present: true,
                at: jwt.at,
                fresh: jwtFresh(deps.store, Date.now()),
                // 脱敏放**响应边界**（存储里留真值）：回显值不是凭据，
                // 但也没必要整串进界面与日志 —— 与凭据的处理同一套纪律。
                // ⚠ 上游字段叫 `mobile`，但真机上它不是手机号（见 maskMobile）
                mobile: jwt.mobile ? maskMobile(jwt.mobile) : null,
                ttlMinutes: Math.round(JWT_TTL_MS / 60000),
              }
            : { present: false },
          note:
            '贴一份**原生凭据**（`Basic base64("mobile:号:token")`，' +
            '也就是 mcloud 的 `auth.raw` 那个形状），插件自己走三步换成 H5 的 jwttoken，' +
            '并按 100 分钟自动续 —— 不用再手工从浏览器抄票（它 2 小时就废）。',
        });
      },
    },

{
      // ⚠ **这条没有界面入口了**（2026-10-15 删掉了那个「H5 换票」按钮）。
      //
      // 为什么删：它是个**用户看不懂**的按钮 —— 而参考实现里根本没有它。
      // 那边换票是**任务里自动的一步**，而且**每个页面有自己的票**
      // （`SessionRecipe`：`SignInPage` → `sign_in_3`/`1002`、
      //  `MsgPushOn` → `msgpushon`/`1062`；实拍一趟抓到**三张互不相等的
      //  `jwttoken`**）。一个叫「H5 换票」的按钮会让人以为换的是"通用的票"。
      //
      // 留着这条路由的理由：它是**单账号那套**（`mcloud.h5.auth`）唯一的写入口，
      // 而 `loadAuthRaw` 还回落到那一格（老数据）。也留一条不带界面的
      // "清空"路径（`{clear:true}`）。
      //
      // 界面上的凭据入口是 `/accounts` 的 `op:'add'`（那个「凭据」页签）。
      path: `${base}/h5/auth`,
      method: 'POST',
      handler: async (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearAuth(deps.store, deps.now());
          deps.log('原生凭据与换到的票：已清空');
          return json(200, { cleared: true });
        }
        const raw =
          typeof body.authorization === 'string'
            ? body.authorization
            : typeof body.session === 'string'
              ? body.session
              : '';
        if (!raw.trim()) {
          return json(400, { error: '需要 {"authorization": "Basic …"} 或 {"clear": true}' });
        }
        const r = startExchange(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error });
        // ⚠ 日志只出指纹，不出凭据
        deps.log(`原生凭据已收下（指纹 ${r.fingerprint}）—— 点「换票」走三步`);
        return json(200, { stored: true, fingerprint: r.fingerprint, ...authStatus(deps.store) });
      },
    },

{
      // **推进一步**（一次调用一个上游请求）。界面上的按钮循环调这里直到 done。
      path: `${base}/h5/step`,
      method: 'POST',
      handler: async (req) => {
        // ⚠ 可以**指定账号**（`{id}`）：卡片上那个「连接」是给**那一条**连的，
        //   而默认那条路用的是"当前账号"。不指定时行为与以前完全一样。
        const b = readBody(req) as { id?: unknown };
        const id = typeof b.id === 'string' ? b.id : '';
        const one = id === '' ? deps.store : scoped(rawStoreOf(deps.store), id);
        // ⚠ `runExchangeStep` 只**接着走**已有那一轮，它不会**开始**一轮 ——
        //   开始是 `startExchange`。少了这一句，"连接"永远回"没有待换票的任务"。
        // ⚠ 上一轮 `done`（票过期要再换一张）时也要开新的 —— 只判 `null` 的话，
        //   票一过期这里就永远回"没有待换票的任务"。
        // ⚠ 只有"真需要换"时才开新一轮（`needExchange` 会看票新不新鲜）——
        //   否则每点一次都会白换一张票。
        if (needExchange(one, Date.now())) {
          const st0 = loadExchange(one);
          if (st0 === null || st0.step === 'done') {
            startExchange(one, loadAuthRaw(one), deps.now());
          }
        }
        const r = await runExchangeStep({
          store: one,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`换票${id === '' ? '' : `（${id}）`}：${r.note}`);
        return json(200, { ...r, exchange: loadExchange(one) });
      },
    },

{
      // 凭据续期。默认**按判据**（离过期还远就一个请求都不发）；
      // `{"force":true}` 对应 mcloud CLI 的 `--force`，用来"我现在就想试一下"。
      path: `${base}/auth/refresh`,
      method: 'POST',
      handler: async (req) => {
        const b = readBody(req) as { force?: unknown; leadDays?: unknown };
        const force = b.force === true;
        const leadDays = typeof b.leadDays === 'number' ? b.leadDays : undefined;
        const cur = currentAccount(deps.store);
        const r = await runAuthRefresh(
          { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) },
          force,
          leadDays,
          // 明确"刷当前这一条、写回这一条"（没有账号时才是单账号那格）
          cur === undefined ? {} : { auth: cur.auth, accountId: cur.id },
        );
        deps.log(`凭据续期：${r.note}`);
        return json(200, { ...r, auth: authStatus(deps.store) });
      },
    }
  ];
}
