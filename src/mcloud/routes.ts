// 插件自己的 HTTP 接口（`register_route`）—— **纯逻辑，不 import host-api**。
//
// 面板把插件路由挂在同一个端口上，路径是完整路径（`/plugins/mcloud/…`），键是
// `"{METHOD} {path}"`（大写方法、path 不含查询串）。handler 收到
// `{method, path, query, headers, body}`，返回 `{status, headers, body}`，`body` 必须是字符串。
//
// 本文件只**产出**路由表（`{path, method, handler}` 的数组），由 main.ts 真正注册。
// 这么分是为了守住那条硬约束：Node 里没有 host-api，任何 import 它的模块都加载不了 ——
// 路由逻辑要能在 Node 里跑测试，就不能碰宿主 API。（第一版我在这里 import 了 log，
// 还用了一个模块级可变注入，两样都不对。）
//
// ⚠️ 安全纪律：这些接口**不回显凭据**。状态只给 `redact()` 过的摘要（长度 + 前 4 位）。
// 想看完整 cookie 的人应该去读本机的 SQLite，而不是调一个「任何拿到面板会话的人都能调」
// 的 HTTP 接口。

import {
  STATE_BASE_URL,
  importSession,
  loadBaseUrl,
  parseSessionInput,
  sessionStatus,
  verifySession,
} from './session.ts';
import { TASK_NAMES, STATE_LAST_TASKLIST } from './tasks/taskList.ts';
import { groupView } from './groups.ts';
import { hasBigInt, sandboxCaps } from './caps.ts';
import { runAuthRefresh } from './authRefresh.ts';
import { clearOrder, runOrderStep, startOrder } from './tasks/exchangeOrder.ts';
import { drawReport } from './tasks/liveDraw.ts';
import { MATRIX_MARKETS, readMatrix } from './tasks/appTaskMatrix.ts';
import { readDailyRun } from './dailyState.ts';
import { VERDICT_TEXT, readExchangeList } from './tasks/exchangeList.ts';
import {
  EMPTY_SHELL_HINT_CHARS,
  clearLiveCodes,
  loadLiveCodes,
  loadLiveUrl,
  readLiveReading,
  readPoolSummary,
  saveLiveCodes,
  saveLiveUrl,
} from './tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from './liveKouling.ts';
import { localStamp } from './koulingPool.ts';
import {
  loadGateBase,
  loadGateState,
  readGateReading,
  runLiveGate,
  saveGateBase,
} from './tasks/liveGateTask.ts';
import {
  currentAccount,
  loadAccounts,
  maskAuth,
  removeAccount,
  selectAccount,
  upsertAccount,
} from './accounts.ts';
import {
  BASE_VIDEO_IM_WS,
  STATE_LISTEN_SECONDS,
  listenReadingLine,
  loadImBase,
  loadListenRoom,
  loadListenSeconds,
  loadWsHeartbeat,
  loadListenState,
  loadWsBase,
  runLiveListen,
  saveImBase,
  saveListenRoom,
  saveWsBase,
  saveWsHeartbeat,
} from './tasks/liveListen.ts';
import {
  JWT_TTL_MS,
  authStatus,
  clearAuth,
  loadExchange,
  loadJwt,
  maskMobile,
  runExchangeStep,
  startExchange,
  jwtFresh,
} from './sessionExchange.ts';
import {
  claimEnabled,
  collectCodes,
  loadDrawState,
  probeLiveRoom,
  runLiveDraw,
  setClaimEnabled,
} from './tasks/liveDraw.ts';
import { loadWakePlan, planTrusted } from './tasks/liveAutoTask.ts';
import { qrSvg } from '../crypto/qr.ts';
import { callOnce } from './client.ts';
import { uuidV4 } from './rand.ts';
import {
  CODES,
  PC_AUTH_PREFIX,
  QR_TTL_SECONDS,
  applyPoll,
  authFromUserInfo,
  classifyPoll,
  classifySendSms,
  decryptUserInfo,
  isSuccessCode,
  parseLoginEnvelope,
  parseSliderPuzzle,
  pcClient,
  qrExpired,
  qrPayload,
  qrThirdloginBody,
  sendSmsCodeBody,
  sendSmsCodeBodyWithSlider,
  sendSmsCodeRequest,
  sliderAnswer,
  sliderPuzzleBody,
  sliderPuzzleRequest,
  smsThirdloginBody,
  passwordThirdloginBody,
  maskPhone,
  userDomainIdFrom,
  thirdloginRequest,
  type LoginEnvelope,
  type PcPlatform,
} from './login.ts';
import {
  STATE_LOGIN_BASE,
  STATE_LOGIN_DOMAIN,
  STATE_LOGIN_PREF,
  clearLogin,
  loadDeviceId,
  loadQrSession,
  loadSmsSession,
  loginReading,
  resetDeviceId,
  saveQrSession,
  saveSmsSession,
  setSmsSlider,
  startQrSession,
  startSmsSession,
} from './loginSession.ts';
import type { Store } from '../store/types.ts';
import type { BuiltRequest } from './h5.ts';
import type { Transport } from './client.ts';
import type { HostWs } from './tasks/base.ts';

/** 插件名（= 文件名去掉扩展名）。路由路径要用它。 */
export const PLUGIN = 'mcloud';

export interface RouteRequest {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}
export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface RouteEntry {
  path: string;
  method: string;
  handler: (req: RouteRequest) => RouteResponse;
}

export interface RouteDeps {
  store: Store;
  transport: Transport;
  now(): string;
  /** 注入日志：本文件不能 import host-api（见文件头） */
  log(msg: string): void;
  baseUrl?: string | undefined;
  /** 长连接那一族（`ws_*`）—— **可选**：宿主没有它时那个口子要如实 503。
   *  `routes.ts` 同样不 import `host-api`（见文件头），所以由 main.ts 注进来。 */
  ws?: HostWs | undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 账号列表的**对外形状**：只给掩码，不给凭据（见 accounts.ts 模块头）。 */
function accountsView(store: Pick<Store, 'getState'>): {
  current: string;
  accounts: { id: string; label: string; masked: string; current: boolean; addedAt: string }[];
} {
  const cur = currentAccount(store);
  return {
    current: cur?.id ?? '',
    accounts: loadAccounts(store).map((a) => ({
      id: a.id,
      label: a.label,
      masked: maskAuth(a.auth),
      current: cur?.id === a.id,
      addedAt: a.addedAt,
    })),
  };
}

const json = (status: number, obj: unknown): RouteResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(obj),
});

function readBody(req: RouteRequest): Record<string, unknown> {
  const raw = (req.body ?? '').trim();
  if (raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    // 不是 JSON 就当成「直接把 cookie 串贴进来了」—— 让人少一步转换
    return { session: raw };
  }
}


/** 一次调用把**七个区块要的读数**全给出来。
 *
 *  # 为什么要聚合
 *
 *  旧界面是「一个区块一个接口」，于是打开页面要打十几次请求，而且每一块各自
 *  有各自的加载/错误状态 —— 用户看到的是「有的块有数、有的块空着、有的块报错」，
 *  而**没人知道该看哪个**。那是「界面完全搞不懂」的来源之一。
 *
 *  聚合之后界面只有两种状态：**有读数** 或者 **一次都没读到**（一个错误信息）。
 *
 *  # 区块与键的对应（界面菜单栏的七块）
 *
 *  | 键 | 区块 | 里面是什么 |
 *  |---|---|---|
 *  | `account` | 账号 | 登录状态、账号列表、会话体检 |
 *  | `daily` | 日常 | 今天跑没跑、**最近一次运行的每一步结果** |
 *  | `exchange` | 兑换 | 兑换目标、奖品清单、判据文案 |
 *  | `live` | 直播 | 口令池、日程门、听窗口、下一次几点醒 |
 *  | `data` | 数据 | 沙箱能力、App 任务矩阵读数（纯读数，没有动作） |
 *  | `push` | 推送 | **阶段 ⑤ 才实现** —— 现在给一个诚实的空壳 |
 *  | `settings` | 设置 | 五个上游口子 + 听窗口参数 |
 *
 *  ⚠ 这里**只读**：一个上游请求都不发。要刷新上游读数得跑对应的任务
 *  （日常 / 直播 / 兑换），或者用区块里的「现在跑一次」按钮。
 *  这样「打开页面」永远不会因为上游慢而卡住。
 */
function buildReadings(deps: RouteDeps): Record<string, unknown> {
  const nowMs = Date.parse(deps.now());
  const nowIso = deps.now();
  const view = accountsView(deps.store);

  return {
    at: nowIso,
    account: {
      loggedIn: view.accounts.length > 0,
      current: view.current,
      accounts: view.accounts,
      session: sessionStatus(deps.store, nowIso),
    },
    // 登录会话（三种方式的进行中状态）。挂在 `account` 块里 ——
    // 界面上的「登录」那一节就是它。
    //
    // ⚠ `svg` 要在这里也带上：界面**只调 `/readings`**（见 app.js 的文件头），
    //   所以码必须由这个接口给出来。只在 `/login/qr/start` 上给的话，
    //   `act()` 之后的 `load()` 会用"没有 svg 的读数"把码**擦掉** ——
    //   表现是"点了扫码登录，二维码框是空的"。
    login: (() => {
      const r = loginReading(deps.store, nowMs, (sid, did) =>
        qrPayload(pcClient(loginPlatform(deps.store), did), sid),
      );
      return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
    })(),
    daily: {
      // 「今天跑完了吗」看标记；「上次跑成什么样」看读数。两个都要，
      // 因为它们回答的是不同的问题（用户真正会问的是后面那个）。
      doneToday: (deps.store.getState('mcloud.daily.done_date') ?? '') === nowIso.slice(0, 10),
      last: readDailyRun(deps.store),
    },
    exchange: {
      plan: deps.store.getState('mcloud.exchange.plan') ?? '',
      reading: readExchangeList(deps.store),
      verdictText: VERDICT_TEXT,
    },
    live: {
      reading: readLiveReading(deps.store),
      codes: loadLiveCodes(deps.store),
      url: loadLiveUrl(deps.store),
      pool: readPoolSummary(deps.store, localStamp(nowMs), nowMs),
      gate: readGateReading(deps.store),
      listen: {
        reading: loadListenState(deps.store),
        line: listenReadingLine(loadListenState(deps.store)),
      },
      auto: (() => {
        const plan = loadWakePlan(deps.store);
        return {
          wakeAt: plan?.wakeAt ?? '',
          wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
        };
      })(),
      // 领小红花的**结论**（四栏 + 进账）。界面第一行显示的就是 `line`。
      // ⚠ 「本场已结束」与「口令无效」分栏的理由见 liveDraw.drawReport 的注释 ——
      //   分错的后果是用户去重抄一条本来就对的口令。
      draw: (() => {
        const st = loadDrawState(deps.store);
        const r = drawReport(st);
        return {
          enabled: claimEnabled(deps.store),
          step: st?.step ?? '',
          report: r,
          line: r === null ? (claimEnabled(deps.store) ? '还没领过' : '领小红花没开启') : r.line,
        };
      })(),
    },
    data: {
      caps: sandboxCaps(),
      hasBigInt: hasBigInt(),
      matrix: {
        groups: readMatrix(deps.store).map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
        read: readMatrix(deps.store).filter(Boolean).length,
        total: MATRIX_MARKETS.length,
      },
    },
    // ⚠ 推送（10 渠道）在**阶段 ⑤**。这里给一个诚实的空壳而不是编一个假读数 ——
    //    界面据此显示「还没做」，而不是显示一个看着像好的空表。
    push: { implemented: false, channels: [], rules: {} },
    settings: {
      baseUrl: loadBaseUrl(deps.store),
      liveUrl: loadLiveUrl(deps.store),
      liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
      gateBase: loadGateBase(deps.store),
      wsBase: loadWsBase(deps.store),
      wsHeartbeat: loadWsHeartbeat(deps.store),
      listenRoom: loadListenRoom(deps.store) ?? 0,
      imBase: loadImBase(deps.store),
      listenSeconds: loadListenSeconds(deps.store),
      // 登录主机是**另一个口子**：登录那一族接口在 `user-njs.yun.139.com`，
      // 与云盘业务主机不是同一台。混用的话指到 mock 之后登录仍然打真上游。
      loginBase: loadLoginBase(deps.store),
      loginPlatform: loginPlatform(deps.store),
      loginDomain: deps.store.getState(STATE_LOGIN_DOMAIN) ?? '',
    },
  };
}


// ══════════════════════════════ 登录（②-3） ══════════════════════════════
//
// # 为什么登录是**一步一步**的，而任务不是
//
// 用户的要求是「任务不要一次一步」。但登录恰恰必须一步一步 —— 因为
// **状态机是用户本人**：出码 → 用户掏出手机扫 → 用户在手机上点确认 → 才拿得到凭据。
// 中间那几步的时间由用户决定，硬塞进一个"从头跑到尾"的函数只能变成
// "函数停在等用户输入"。所以推进的触发者是**用户点按钮**，不是定时器。
//
// 账密是例外：没有用户交互，所以它**一个路由就完成**（`/login/pwd`）。
//
// # 落盘
//
// 会话与设备指纹都在 `loginSession.ts` 落库。设备指纹**必须**落盘：
// 服务端按它定位"这次扫码是哪台设备"，每次重新生成的表现是轮询永远停在
// `200059541` —— 看起来像"码过期了"。

/** 登录那一族接口的主机。**与云盘业务主机不是同一台**，所以它有自己的口子。
 *
 *  混用业务基址的话，指到 mock 之后登录仍然打真上游 —— 而登录打真上游的
 *  表现是"账号密码不对"。 */
function loadLoginBase(store: Pick<Store, 'getState'>): string {
  return store.getState(STATE_LOGIN_BASE) ?? '';
}

/** 一次登录请求：发出去 → 解析信封。**不抛**（把失败当读数带回来）。 */
function loginCall(
  deps: RouteDeps,
  req: BuiltRequest,
): { ok: boolean; env: LoginEnvelope | null; error: string; tookMs: number } {
  const res = callOnce(deps.transport, req);
  if (!res.ok) return { ok: false, env: null, error: res.error ?? `http ${res.status}`, tookMs: res.tookMs };
  try {
    return { ok: true, env: parseLoginEnvelope(res.raw), error: '', tookMs: res.tookMs };
  } catch (e) {
    return { ok: false, env: null, error: e instanceof Error ? e.message : String(e), tookMs: res.tookMs };
  }
}

/** 一次链路追踪 id（`x-yun-tid`）。每次请求新生成一个。 */
function newTid(): string {
  return uuidV4();
}

/** 平台：跟着当前账号的记忆走，没有就用 windows（版本号更"主流"）。 */
function loginPlatform(store: Pick<Store, 'getState'>): PcPlatform {
  const pref = store.getState(STATE_LOGIN_PREF);
  return pref === 'macos' ? 'macos' : 'windows';
}

/** 登录成功之后：解 `userInfo` → 拼凭据 → 落账号。
 *
 *  ⚠ 手机号**显式当标签传进去**：`upsertAccount` 会用 `phoneOf` 从凭据里抠，
 *  而 PC 凭据是 `Basic base64(...)` —— 那个函数现在能解 base64 了，
 *  但这里已经有权威值（`userInfo.account`），没必要让它再猜一次。
 *
 *  ⚠ `userDomainId` **只有登录响应里才有**，别的地方拿不到 ⇒ 这里不存就永远丢了。 */
function adoptLoginResult(
  deps: RouteDeps,
  encrypted: string,
  note: string,
): { ok: boolean; note: string; account?: { id: string; label: string } } {
  let info: Record<string, unknown>;
  try {
    info = decryptUserInfo(encrypted);
  } catch (e) {
    return { ok: false, note: `登录成功了，但结果解不开：${e instanceof Error ? e.message : String(e)}` };
  }
  let auth: string;
  try {
    auth = authFromUserInfo(info, PC_AUTH_PREFIX);
  } catch (e) {
    return { ok: false, note: `登录结果缺字段：${e instanceof Error ? e.message : String(e)}` };
  }

  const phone = typeof info['account'] === 'string' ? info['account'] : '';
  const up = upsertAccount(deps.store, auth, deps.now(), phone === '' ? undefined : maskPhone(phone));
  // 新登录的账号一律**启用**，并且**切成当前账号** —— 用户刚扫码进来，
  // 想的就是"用这个号"，还要他再去列表里点一次是把动作做两遍。
  selectAccount(deps.store, up.account.id, deps.now());
  const domain = userDomainIdFrom(info);
  if (domain !== '') deps.store.setState(STATE_LOGIN_DOMAIN, domain, deps.now());

  clearLogin(deps.store);
  deps.log(`登录成功：${up.account.label}${up.created ? '（新账号）' : '（已有账号，凭据已更新）'}`);
  return { ok: true, note: `${note} · ${up.account.label}`, account: { id: up.account.id, label: up.account.label } };
}

/** 路由表。四个入口遍历它去调用真的 `register_route`。 */
export function mcloudRoutes(deps: RouteDeps): RouteEntry[] {
  const base = `/plugins/${PLUGIN}/api`;
  // 基址**每次调用时从 state 读**，而不是用注入的那份快照 ——
  // 否则「刚把基址指到 mock，导入会话却去打了真上游」：配置改了要立刻生效
  const verify = (): { ok: boolean; note: string } =>
    verifySession({
      store: deps.store,
      transport: deps.transport,
      nowIso: deps.now(),
      baseUrl: loadBaseUrl(deps.store),
    });

  return [
    {
      // 沙箱能力（**随时可问**，不用等 5 分钟一跳的自检）
      path: `${base}/caps`,
      method: 'GET',
      handler: () => json(200, { caps: sandboxCaps(), hasBigInt: hasBigInt() }),
    },

    // ── 登录：读数 ──────────────────────────────────────────────────
    {
      // 登录页的读数（一次给全）。凭据**不进这里** —— 只给掩码过的形状。
      path: `${base}/login/state`,
      method: 'GET',
      handler: () =>
        json(200, {
          ...(() => {
            const r = loginReading(deps.store, Date.parse(deps.now()), (sid, did) =>
              qrPayload(pcClient(loginPlatform(deps.store), did), sid),
            );
            // 二维码由**插件这一侧**渲染成 SVG（浏览器里没有二维码库）
            return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
          })(),
          platform: loginPlatform(deps.store),
        }),
    },

    // ── 登录：扫码 ──────────────────────────────────────────────────
    {
      // 出码。**不发任何上游请求** —— 客户端源码里就是字符串拼接，
      // 实测 1622 个 body 文件里也没有对应的取码接口。
      path: `${base}/login/qr/start`,
      method: 'POST',
      handler: () => {
        const nowMs = Date.parse(deps.now());
        const s = startQrSession(deps.store, nowMs, deps.now());
        const c = pcClient(loginPlatform(deps.store), s.deviceId);
        const payload = qrPayload(c, s.sessionId);
        deps.log('扫码登录：已出码，等手机扫');
        return json(200, {
          sessionId: s.sessionId,
          payload,
          // **在插件这一侧编码**、界面只画格子：浏览器里没有二维码库，
          // 在那里现写一个等于把"码对不对"交给前端（见 crypto/qr.ts 的文件头）。
          svg: qrSvg(payload),
          expiresInMs: QR_TTL_SECONDS * 1000,
          note: '用手机上的移动云盘 App 扫这个码',
        });
      },
    },
    {
      // 轮一次。**"还没扫"不是错误** —— 轮询期间绝大多数响应都是它。
      path: `${base}/login/qr/poll`,
      method: 'POST',
      handler: () => {
        const s = loadQrSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的扫码登录（先点「扫码登录」）' });
        const nowMs = Date.parse(deps.now());
        if (qrExpired(s, nowMs)) {
          return json(200, { stop: true, ok: false, note: '二维码过期了，点「扫码登录」重新出码' });
        }
        const c = pcClient(loginPlatform(deps.store), s.deviceId);
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), qrThirdloginBody(c, s.sessionId), loadLoginBase(deps.store)),
        );
        if (!r.ok || r.env === null) {
          // ⚠ 网络失败**不当作登录失败**：会话还在，用户再点一次就好。
          return json(200, { stop: false, ok: true, note: `还没问到上游（${r.error}），再点一次`, retry: true });
        }
        const out = classifyPoll(r.env);
        const applied = applyPoll(s, out, nowMs);
        saveQrSession(deps.store, applied.session, deps.now());
        if (applied.encrypted !== undefined) {
          const adopted = adoptLoginResult(deps, applied.encrypted, '扫码登录成功');
          return json(200, { ...applied, ...adopted, stop: true });
        }
        if (applied.stop) deps.log(`扫码登录：${applied.note}`);
        return json(200, { stop: applied.stop, ok: applied.ok, note: applied.note, scanned: applied.session.scanned });
      },
    },

    // ── 登录：短信 ──────────────────────────────────────────────────
    {
      path: `${base}/login/sms/start`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { phone?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: '手机号要 11 位、以 1 开头' });
        const s = startSmsSession(deps.store, phone, Date.parse(deps.now()), deps.now());
        return json(200, { phone: s.phone, note: '点「发验证码」' });
      },
    },
    {
      // 发码。**可能被风控拦下** ⇒ 回 `need-slider`，那时界面要去取图。
      path: `${base}/login/sms/send`,
      method: 'POST',
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(loginPlatform(deps.store), loadDeviceId(deps.store, deps.now()));
        // 已经有滑块挑战 ⇒ 带上去（这是**异常路径**，首次发码被拦下才走）
        let body: Record<string, unknown>;
        if (s.slider !== null) {
          let answer: string;
          try {
            answer = sliderAnswer(s.slider);
          } catch (e) {
            return json(400, { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` });
          }
          body = sendSmsCodeBodyWithSlider(c, s.phone, s.random, answer);
        } else {
          body = sendSmsCodeBody(c, s.phone, s.random);
        }
        const r = loginCall(deps, sendSmsCodeRequest(c, newTid(), body, loadLoginBase(deps.store)));
        if (!r.ok || r.env === null) return json(502, { error: `发码请求没成功：${r.error}` });
        const out = classifySendSms(r.env);
        if (out.kind === 'sent') {
          const next = { ...s, sent: true, lastNote: '验证码已发出' };
          saveSmsSession(deps.store, next, deps.now());
          deps.log('短信登录：验证码已发出');
          return json(200, { sent: true, remainGetTimes: out.remainGetTimes, note: '看手机短信，把 6 位验证码填进来' });
        }
        if (out.kind === 'need-slider' || out.kind === 'slider-exhausted') {
          // ⚠ 两种都要**重新取图**：`slider-exhausted` 是"同一张图校验失败次数超限"，
          //   旧挑战已经作废，复用它只会一直失败到把配额烧光。
          const next = setSmsSlider(deps.store, s, null, deps.now());
          saveSmsSession(deps.store, next, deps.now());
          deps.log(`短信登录：要过滑块（${out.kind === 'slider-exhausted' ? '旧图已作废，' : ''}去取新图）`);
          return json(200, {
            needSlider: true,
            exhausted: out.kind === 'slider-exhausted',
            note: out.kind === 'slider-exhausted' ? '这张滑块图作废了，重新取一张' : '要先过滑块，去取图',
          });
        }
        return json(200, { ok: false, note: `发码没成：${out.message || `code=${out.code}`}`, code: out.code });
      },
    },
    {
      // 取滑块拼图。**缺口坐标是解出来的**，不需要图像识别。
      path: `${base}/login/sms/slider`,
      method: 'POST',
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(loginPlatform(deps.store), loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), loadLoginBase(deps.store)),
        );
        if (!r.ok || r.env === null) return json(502, { error: `取滑块失败：${r.error}` });
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
          return json(502, { error: `滑块缺口解不开（上游换字段了？）：${e instanceof Error ? e.message : String(e)}` });
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
      handler: (req) => {
        const b = readBody(req) as { code?: unknown };
        const code = typeof b.code === 'string' ? b.code.trim() : '';
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: '验证码要 4–8 位数字' });
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(loginPlatform(deps.store), loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), smsThirdloginBody(c, s.phone, code), loadLoginBase(deps.store)),
        );
        if (!r.ok || r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(deps, out.encrypted, '短信登录成功');
          return json(200, { ...adopted, stop: true });
        }
        const note =
          r.env.code === CODES.SMS_CODE_WRONG
            ? '验证码不对（或者过期了），再看一眼短信'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: false, note });
      },
    },

    // ── 登录：账密 ──────────────────────────────────────────────────
    {
      // 账密登录**一个路由就完成** —— 它没有用户交互，所以不是状态机。
      path: `${base}/login/pwd`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { phone?: unknown; password?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        const password = typeof b.password === 'string' ? b.password : '';
        if (phone === '') return json(400, { error: '要填手机号' });
        if (password === '') return json(400, { error: '要填口令' });
        const c = pcClient(loginPlatform(deps.store), loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), passwordThirdloginBody(c, phone, password), loadLoginBase(deps.store)),
        );
        if (!r.ok || r.env === null) return json(502, { error: `登录请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(deps, out.encrypted, '账密登录成功');
          return json(200, { ...adopted, stop: true });
        }
        // ⚠ 错误信息里**不许回显口令**（日志与响应都不行）
        const note =
          r.env.code === CODES.LOGIN_FAILED
            ? '上游说登录失败 —— 手机号或口令不对（也可能是设备头被拒）'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: true, note });
      },
    },

    // ── 登录：取消 / 换设备 ─────────────────────────────────────────
    {
      path: `${base}/login/cancel`,
      method: 'POST',
      handler: () => {
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
      handler: () => {
        const fresh = resetDeviceId(deps.store, deps.now());
        deps.log('登录：换了设备指纹（旧会话已清）');
        return json(200, { deviceId: fresh, note: '设备指纹已换新，旧会话已清 —— 重新出码' });
      },
    },

    {
      // **七个区块的读数一次给全** —— 界面只调这一个
      path: `${base}/readings`,
      method: 'GET',
      handler: () => json(200, buildReadings(deps)),
    },
    {
      path: `${base}/session`,
      method: 'GET',
      handler: () => json(200, sessionStatus(deps.store, deps.now())),
    },
    {
      path: `${base}/session`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);

        if (body.clear === true) {
          deps.store.setState('mcloud.session', '', deps.now());
          deps.log('会话已清空');
          return json(200, { cleared: true, status: sessionStatus(deps.store, deps.now()) });
        }

        const raw = typeof body.session === 'string' ? body.session : '';
        if (!raw) {
          return json(400, { error: '需要 {"session": "<cookie 串或 JSON>"} 或 {"clear": true}' });
        }
        const parsed = parseSessionInput(raw, deps.now());
        if (!parsed.ok) return json(400, { error: parsed.reason });

        importSession(deps.store, parsed.session, deps.now());
        // 导入后立刻真验一次：「能不能用」要靠上游回答，不是靠格式对不对
        const check = verify();
        const st = sessionStatus(deps.store, deps.now());
        // 日志只出结论与脱敏摘要
        deps.log(`导入会话：${check.note}（cookie ${st.cookie}）`);
        return json(200, { imported: true, verified: check.ok, note: check.note, status: st });
      },
    },
    {
      path: `${base}/session/verify`,
      method: 'POST',
      handler: () => {
        const check = verify();
        return json(200, {
          verified: check.ok,
          note: check.note,
          status: sessionStatus(deps.store, deps.now()),
        });
      },
    },
    {
      // 上游基址：CI 指向 mock 用；生产留空 = 用真地址。
      // 口令主页地址：同一条路（**完整 URL**，不是源 —— 见 liveRoom.ts 的 loadLiveUrl）
      path: `${base}/config`,
      method: 'GET',
      handler: () =>
        json(200, {
          baseUrl: loadBaseUrl(deps.store) || '(真上游)',
          liveUrl: loadLiveUrl(deps.store),
          liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
          // 门的两个主机（user-njs / v.cmcc-cs.cn）—— 一个口子，见 liveGateTask.loadGateBase
          gateBase: loadGateBase(deps.store) || '(真主机)',
          // 弹幕那条 WS 的主机（videoim.cmcc-cs.cn:20102）—— **另一个口子**：
          // 它是 `wss://` 且带端口，与上面那两台 http 主机不是同一族（混成一个会写出
          // "指到 mock 之后协议的 scheme/端口丢了"这种错）。
          wsBase: loadWsBase(deps.store),
          // 收到 SockJS 心跳帧 `h` 回什么（空=不回）。默认 `h`（2026-10-14 真机验过）。
          wsHeartbeat: loadWsHeartbeat(deps.store) || '(不回)',
          // 听哪一间房的**诊断口子**（空 = 按主播昵称选）。见 liveListen.loadListenRoom 的注释。
          listenRoom: loadListenRoom(deps.store) ?? 0,
          // 进房间那一台（videoim.cmcc-cs.cn:20103，HTTPS）—— **第三个口子**：
          // 与上面两台 http 主机、以及带端口的 wss 主机都不是同一个。
          imBase: loadImBase(deps.store) || '(真主机)',
          listenSeconds: loadListenSeconds(deps.store),
        }),
    },
    {
      path: `${base}/config`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const out: Record<string, string> = {};

        // ⚠️ 只改**传了的**那个字段。
        // 早先这里无条件写 `baseUrl`（没传就当空串），于是"只想改口令主页"会把
        // 上游基址一起抹掉 —— 抹掉之后所有云盘任务都会打**真上游**（CI 里就是打公网）。
        // 这正是"看着只是多了个配置项、实际把另一个配置清了"的那类错。
        if ('baseUrl' in body) {
          const v = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'baseUrl 要以 http:// 或 https:// 开头（清空就传空串）' });
          }
          deps.store.setState(STATE_BASE_URL, v.replace(/\/+$/, ''), deps.now());
          deps.log(v ? `上游基址已改为 ${v}` : '上游基址已恢复为真上游');
          out.baseUrl = v || '(真上游)';
        }

        if ('liveUrl' in body) {
          const v = typeof body.liveUrl === 'string' ? body.liveUrl.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, {
              error: 'liveUrl 要以 http:// 或 https:// 开头（清空 = 用默认主页）',
            });
          }
          saveLiveUrl(deps.store, v, deps.now());
          deps.log(v ? `口令主页已改为 ${v}` : '口令主页已恢复为默认（发布方的小红书主页）');
          out.liveUrl = v || XIAOHONGSHU_KOULING_PROFILE_URL;
        }

        if ('loginBase' in body) {
          const v = typeof body.loginBase === 'string' ? body.loginBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'loginBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          deps.store.setState(STATE_LOGIN_BASE, v.replace(/\/+$/, ''), deps.now());
          deps.log(v ? `登录主机已改为 ${v}` : '登录主机已恢复为真主机');
          out.loginBase = v || '(真主机)';
        }

        if ('loginPlatform' in body) {
          const v = body.loginPlatform === 'macos' ? 'macos' : 'windows';
          deps.store.setState(STATE_LOGIN_PREF, v, deps.now());
          out.loginPlatform = v;
        }

        if ('gateBase' in body) {
          const v = typeof body.gateBase === 'string' ? body.gateBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'gateBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          saveGateBase(deps.store, v, deps.now());
          deps.log(v ? `直播日程的上游已改为 ${v}` : '直播日程的上游已恢复为真主机');
          out.gateBase = v || '(真主机)';
        }

        if ('wsBase' in body) {
          const v = typeof body.wsBase === 'string' ? body.wsBase.trim() : '';
          // ⚠ 判据是 **ws:// 或 wss://**，不是 http —— 写成 http 这条口子在 CI 里
          //   连不上 mock，而现象是"WS 握手失败"，会让人去查协议而不是查配置。
          if (v && !/^wss?:\/\//.test(v)) {
            return json(400, { error: 'wsBase 要以 ws:// 或 wss:// 开头（清空 = 用真主机）' });
          }
          saveWsBase(deps.store, v, deps.now());
          deps.log(v ? `听弹幕的 WS 主机已改为 ${v}` : '听弹幕的 WS 主机已恢复为真主机');
          out.wsBase = v || BASE_VIDEO_IM_WS;
        }

        if ('imBase' in body) {
          const v = typeof body.imBase === 'string' ? body.imBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'imBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          saveImBase(deps.store, v, deps.now());
          deps.log(v ? `进房间的主机已改为 ${v}` : '进房间的主机已恢复为真主机');
          out.imBase = v || '(真主机)';
        }

        if ('wsHeartbeat' in body) {
          // ⚠ 先把人话别名归一（`none` ⇒ 空串），再校验 —— 否则"校验里放行 none、
          //   下面又比较 none"会被 TS 判成不可达分支（那一支真的是死的）。
          const given = typeof body.wsHeartbeat === 'string' ? body.wsHeartbeat.trim() : '';
          const raw = given === 'none' ? '' : given;
          // ⚠ 只认这两档：`h`（默认，实测有效）与空（不回）。别让它变成"回任意字符串"——
          //   那是往一条协议连接里写自由文本，出错时的现象是"服务端把我们踢了"，
          //   而原因在日志里根本看不出来。
          // 两档（2026-10-14 实测定下来）：`h`（回，默认）/ 空或 none（不回）。
          // ⚠ 两档都**不**把 `h` 当收尾理由 —— 实测不回也活了 6 拍/90 秒。
          if (raw !== '' && raw !== 'h') {
            return json(400, { error: 'wsHeartbeat 只能是 "h"（默认）或 "none"（不回）' });
          }
          saveWsHeartbeat(deps.store, raw, deps.now());
          deps.log(raw === '' ? '读到 SockJS 心跳帧 h 时**不回**' : '读到 h 时回一帧 h');
          out.wsHeartbeat = raw === '' ? '(不回)' : raw;
        }

        if ('listenRoom' in body) {
          const raw = String(body.listenRoom ?? '').trim();
          if (raw !== '' && !/^\d+$/.test(raw)) {
            return json(400, { error: 'listenRoom 要给房间号（纯数字）或空串（= 按主播昵称选）' });
          }
          saveListenRoom(deps.store, raw, deps.now());
          deps.log(raw === '' ? '听弹幕：恢复按主播昵称选房' : `听弹幕：诊断口子 —— 只听房间 ${raw}`);
          out.listenRoom = raw === '' ? '0' : raw;
        }

        if ('listenSeconds' in body) {
          const n = Number.parseInt(String(body.listenSeconds), 10);
          if (!Number.isFinite(n) || n <= 0 || n > 3600) {
            return json(400, { error: 'listenSeconds 要给 1..3600 之间的整数（秒）' });
          }
          deps.store.setState(STATE_LISTEN_SECONDS, String(n), deps.now());
          deps.log(`听弹幕的窗口改为 ${n} 秒`);
          out.listenSeconds = String(n);
        }

        if (Object.keys(out).length === 0) {
          return json(400, {
            error: '要传 baseUrl / liveUrl / gateBase / wsBase / imBase / wsHeartbeat / listenRoom / listenSeconds（清空就传空串）',
          });
        }
        return json(200, out);
      },
    },
    {
      // 兑换清单的读数（只读任务采集，界面展示）—— 含"没有余额读数"那句提醒
      path: `${base}/exchange`,
      method: 'GET',
      handler: () => {
        const reading = readExchangeList(deps.store);
        return json(200, {
          reading,
          // 界面上必须写出来：没有余额读数 ⇒ 标"可兑"的仍可能被余额挡下
          note: '没有余额读数：标「可兑」的仍可能被余额挡下（但那次挡下有错误码，不会静默）',
          verdictText: VERDICT_TEXT,
        });
      },
    },
    {
      // App 任务矩阵的读数（8 个 group 各一条）—— 只读任务采集，界面展示。
      // 界面要能看见，否则"只读"就只是日志里的一行数。
      path: `${base}/matrix`,
      method: 'GET',
      handler: () => {
        const rows = readMatrix(deps.store);
        return json(200, {
          // ⚠ 标签必须跟着 **market** 走，不是 group：`readMatrix` 返回的是
          //   按市场的两条（游标早就从 group 改成 market 了，见 appTaskMatrix.ts
          //   里那句「游标现在是**市场**（不是 group）」）。
          //   用 MATRIX_GROUPS 打标签的话，`sign_in_3` 会被标成 "new"、
          //   `newsign_139mail` 标成 "beiyong1"，而且 total 报 8 ——
          //   界面会显示 8 行、只有 2 行有数、两行还都标错。
          //   （这个 bug 是给 readings 写测试时顺带发现的。）
          groups: rows.map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
          read: rows.filter(Boolean).length,
          total: MATRIX_MARKETS.length,
        });
      },
    },
    {
      // 直播口令（只读那半）：自动抓到的读数 + **人给的口令**。
      // 界面要能看见 —— 否则"抓主页"就只是日志里的一行数。
      path: `${base}/live`,
      method: 'GET',
      handler: () =>
        json(200, {
          reading: readLiveReading(deps.store),
          codes: loadLiveCodes(deps.store),
          url: loadLiveUrl(deps.store),
          emptyShellHintChars: EMPTY_SHELL_HINT_CHARS,
          // 口令池（业务档，照 mcloud）：**口令的权威来源**（读数只是最近一次抓取的快照）。
          // 界面要能看见「够没够 2 条有效」「还要等多久才能再抓」「哪些判过无效」。
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
          // 直播日程（门）：只读探针的读数 —— 门开没开、看到几间房、「下一场」在 pool 里
          gate: readGateReading(deps.store),
          // 听弹幕（第二十三轮）：窗口里的过程事实 —— 收到几帧、几条弹幕、哪几条口令
          listen: {
            reading: loadListenState(deps.store),
            line: listenReadingLine(loadListenState(deps.store)),
          },
          // 直播自动定时（mcloud 的 `live_auto`）：**下一次几点醒**。
          // 它只有读数、没有动作 —— 定时器算时刻，听弹幕那条链到点才动。
          auto: (() => {
            const nowMs = Date.parse(deps.now());
            const plan = loadWakePlan(deps.store);
            const sum = readPoolSummary(deps.store, localStamp(nowMs), nowMs);
            return {
              nextStart: sum.nextStart ?? '',
              wakeAt: plan?.wakeAt ?? '',
              wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
              expr: plan?.expr ?? '',
              fromStart: plan?.fromStart ?? '',
              trusted: planTrusted(sum.scheduleAtMs, nowMs),
              line:
                plan === null
                  ? sum.nextStart === undefined || sum.nextStart === ''
                    ? '没有日程 ⇒ 不排定时（门探到「下一场」才会排）'
                    : '日程太旧 ⇒ 不按它睡（等门下次探到再说）'
                  : `下一次醒 ${plan.wakeAt}（= ${plan.fromStart} +1 小时）`,
            };
          })(),
          note:
            '口令本身**没法自动化**（主播在弹幕/小红书发，那边无法鉴权）⇒ 要人给；' +
            '能自动的只有「抓主页 + 列出看到的口令」。',
          // 写那半（领小红花）：默认关，开关在这里
          claim: {
            enabled: claimEnabled(deps.store),
            codes: collectCodes(deps.store),
            state: loadDrawState(deps.store),
          },
        }),
    },
    {
      // H5 换票（三步）：凭据状态 + 进度 + 换到的票。**都不回显凭据本身。**
      path: `${base}/h5`,
      method: 'GET',
      handler: () => {
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
      path: `${base}/h5/auth`,
      method: 'POST',
      handler: (req) => {
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
      handler: () => {
        const r = runExchangeStep({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`换票：${r.note}`);
        return json(200, { ...r, exchange: loadExchange(deps.store) });
      },
    },
    {
      // 兑换下单 —— **不可逆**（真扣豆）。起单只是写字（**不发请求**），
      // 后面每次 `step` 走一步、发一枪。见 tasks/exchangeOrder.ts 的枪序。
      path: `${base}/exchange/order`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { query?: unknown; action?: unknown };
        const d = { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) };
        if (b.action === 'clear') {
          clearOrder(d);
          return json(200, { ok: true, note: '这一单已清掉' });
        }
        if (b.action === 'step') {
          const r = runOrderStep(d);
          deps.log(`兑换：${r.note}`);
          return json(200, r);
        }
        const r = startOrder(d, typeof b.query === 'string' ? b.query : '');
        deps.log(`兑换起单：${r.note}`);
        return json(200, { ...r, queue: deps.store.getState('mcloud.exchange.order.step') ?? '' });
      },
    },
    {
      // 凭据续期。默认**按判据**（离过期还远就一个请求都不发）；
      // `{"force":true}` 对应 mcloud CLI 的 `--force`，用来"我现在就想试一下"。
      path: `${base}/auth/refresh`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { force?: unknown; leadDays?: unknown };
        const force = b.force === true;
        const leadDays = typeof b.leadDays === 'number' ? b.leadDays : undefined;
        const r = runAuthRefresh(
          { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) },
          force,
          leadDays,
        );
        deps.log(`凭据续期：${r.note}`);
        return json(200, { ...r, auth: authStatus(deps.store) });
      },
    },
    {
      // **只读探针**：一枪 `user/info`，回答"这一族能不能通"（不记账、不写状态）。
      // 没有它，"验请求头"得先有真口令，而口令只在直播那一小时有效。
      path: `${base}/live/draw/probe`,
      method: 'POST',
      handler: () => {
        const r = probeLiveRoom({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`小红花探针：${r.note}`);
        return json(200, r);
      },
    },
    {
      // 账号列表（多账号第 2 片，见 accounts.ts 模块头）。
      //
      // ⚠ 只回**掩码**：凭据本身不许出这个口子（它已经能从别处拿，但少一个出口就少一处泄露面）。
      path: `${base}/accounts`,
      method: 'GET',
      handler: () => json(200, { ...accountsView(deps.store) }),
    },
    {
      path: `${base}/accounts`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const op = typeof body.op === 'string' ? body.op : '';
        const now = deps.now();
        if (op === 'add') {
          const auth = typeof body.auth === 'string' ? body.auth.trim() : '';
          if (auth === '') return json(400, { error: '要传 auth（原生凭据那一串）' });
          const r = upsertAccount(deps.store, auth, now);
          // ⚠ 日志里只说"谁"，不说凭据
          deps.log(`账号：${r.created ? '添加' : '更新'} ${r.account.label}`);
          if (loadAccounts(deps.store).length === 1) selectAccount(deps.store, r.account.id, now);
          return json(200, { ...accountsView(deps.store), note: `${r.created ? '已添加' : '已更新'} ${r.account.label}` });
        }
        if (op === 'select') {
          const id = typeof body.id === 'string' ? body.id : '';
          if (!selectAccount(deps.store, id, now)) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(id === '' ? '账号：清掉"当前"（回到单账号那格）' : `账号：当前切到 ${id}`);
          return json(200, { ...accountsView(deps.store), note: id === '' ? '已清掉当前账号' : `当前：${id}` });
        }
        if (op === 'remove') {
          const id = typeof body.id === 'string' ? body.id : '';
          removeAccount(deps.store, id, now);
          deps.log(`账号：删掉 ${id}`);
          return json(200, { ...accountsView(deps.store), note: `已删掉 ${id}` });
        }
        return json(400, { error: '需要 {"op":"add|select|remove", …}' });
      },
    },
    {
      // 开关：领小红花（写）。默认关。
      path: `${base}/live/claim`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (typeof body.enabled !== 'boolean') {
          return json(400, { error: '需要 {"enabled": true|false}' });
        }
        setClaimEnabled(deps.store, body.enabled, deps.now());
        deps.log(`领小红花：${body.enabled ? '已开启（会真往账号里写）' : '已关闭'}`);
        return json(200, { enabled: claimEnabled(deps.store) });
      },
    },
    {
      // **推进一步**（一次调用一个上游请求 —— 面板执行预算 2000ms，见 liveDraw.ts 文件头）。
      //
      // 为什么是"一步"而不是"跑完整条链"：一个从头发到尾的函数会在第 2、3 个请求处
      // 被判超时，而那时**上游的账已经记了**。界面上那个按钮是**浏览器循环调这里**
      // 直到 `done` —— 每步一次 HTTP，每次一个上游请求。
      path: `${base}/live/draw/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveDraw(
          {
            store: deps.store,
            transport: deps.transport,
            nowIso: deps.now(),
            baseUrl: loadBaseUrl(deps.store),
          },
          { force: true }, // 手动那一枪不受开关限制（开关只管 cron）
        );
        const state = loadDrawState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: state?.step === 'done' || out.idle === true,
          state,
        });
      },
    },
    {
      // 直播日程（门）：**推进一步**（handshake 步两发 / rooms 步两发，见 liveGateTask.ts）。
      // 与 `live/draw/step` 同一个形状：界面上的按钮是浏览器循环调这里直到 `done`。
      path: `${base}/live/gate/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveGate({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
        });
        const st = loadGateState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || out.idle === true,
          step: st?.step ?? 'handshake',
          reading: readGateReading(deps.store),
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
        });
      },
    },
    {
      // 听弹幕推进一步（界面上的「听一拍」/ e2e 用）。
      // ⚠ 与门那个 step 口子同样的形状（`done` + `note` + `reading`），
      //   因为它们是**同一类**东西：一个按步骤推进的只读探针。
      path: `${base}/live/listen/step`,
      method: 'POST',
      handler: () => {
        const st0 = loadListenState(deps.store);
        if (deps.ws === undefined) {
          // ⚠ 宿主没有长连接能力时**明确说不**，而不是走到一半才发现
          //   （Python / Node 适配器都是"函数存在、调用时抛"）。
          return json(503, { error: '宿主没有长连接能力（ws_*）—— 这一族只有嵌入式 JS 宿主有' });
        }
        const out = runLiveListen({
          store: deps.store,
          transport: deps.transport,
          host: deps.ws,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
          lateMs: 0,
        });
        const st = loadListenState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || st?.step === undefined,
          step: st?.step ?? 'idle',
          reading: st,
          line: listenReadingLine(st),
          windowOpen: st0?.step === 'listen' || st0?.step === 'open',
        });
      },
    },
    {
      path: `${base}/live/codes`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearLiveCodes(deps.store, deps.now());
          deps.log('直播口令：已清空');
          return json(200, { cleared: true });
        }
        // `readBody` 对"不是 JSON 的 body"会兜成 `{session: 原文}`（让人少一步转换）
        // —— 这里顺着那个约定，贴纯文本也能存
        const raw =
          typeof body.codes === 'string'
            ? body.codes
            : typeof body.session === 'string'
              ? body.session
              : '';
        if (!raw.trim()) {
          return json(400, { error: '需要 {"codes": "<口令，一行一条>"} 或 {"clear": true}' });
        }
        const r = saveLiveCodes(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error ?? '解不出口令' });
        // ⚠ 口令不是账号凭据（它是**共享资源**，谁拿到都能用），所以这里如实回显
        deps.log(`直播口令：存了 ${r.codes.length} 条（${r.how}）`);
        return json(200, {
          saved: r.codes.length,
          codes: r.codes,
          how: r.how,
          stored: loadLiveCodes(deps.store),
        });
      },
    },
    {
      // 分组视图：把 20 条云盘任务按**风险与依赖**分组，附每条的实际状态。
      // 界面（M4）直接吃这个; 现在也能 curl 看。
      path: `${base}/groups`,
      method: 'GET',
      handler: () => json(200, groupView(deps.store)),
    },
    {
      path: `${base}/tasks`,
      method: 'GET',
      handler: () => {
        let last: unknown = null;
        const raw = deps.store.getState(STATE_LAST_TASKLIST);
        try {
          last = raw ? JSON.parse(raw) : null;
        } catch {
          last = { broken: true };
        }
        // 每条任务各自的最近失败原因（base.ts 写的 `mcloud.last_error.<任务名>`）。
        // 给界面用，也让 CI 能断言「这一批任务都没报错」——如果没有这个字段，
        // 那种断言会因为拿不到数据而**永远通过**（我第一版就是这么写的，等于没测）。
        const lastErrorByTask: Record<string, string> = {};
        for (const t of TASK_NAMES) {
          const v = deps.store.getState(`mcloud.last_error.${t}`);
          if (v) lastErrorByTask[t] = v;
        }
        return json(200, {
          lastTaskList: last,
          lastErrorByTask,
          recent: deps.store.recentRuns(20),
        });
      },
    },
  ];
}
