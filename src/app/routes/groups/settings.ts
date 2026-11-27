// settings 那一组路由（8 条）：/readings · /session · /session · /session/verify · /config · /daily-budget · /listen-seconds · /config
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { STATE_BASE_URL, importSession, loadBaseUrl, parseSessionInput, sessionStatus } from '../../../mcloud/session.ts';
import { STATE_LEAD_MS } from '../../../mcloud/tasks/exchangeOrder.ts';
import { STATE_TARGET_HOUR } from '../../../mcloud/exchangeTiming.ts';
import { loadLiveUrl, saveLiveUrl } from '../../../mcloud/tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from '../../../mcloud/liveKouling.ts';
import { loadGateBase, saveGateBase } from '../../../mcloud/tasks/liveGateTask.ts';
import { BASE_VIDEO_IM_WS, loadImBase, loadListenRoom, loadListenSeconds, loadWsBase, loadWsHeartbeat, saveImBase, saveListenRoom, saveTaskListenSeconds, saveWsBase, saveWsHeartbeat } from '../../../mcloud/tasks/liveListen.ts';
import { DEFAULT_PC_PLATFORM, parsePcPlatform } from '../../../mcloud/login.ts';
import { STATE_LOGIN_BASE, STATE_LOGIN_PREF } from '../../../mcloud/loginSession.ts';
import { buildReadings } from '../readings.ts';
import { json, loginPlatform, readBody } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';
import { setWishExchangeEnabled } from '../../../mcloud/tasks/wishCodes.ts';

/** settings 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function settingsRoutes(deps: RouteDeps, base: string, verify: () => Promise<{ ok: boolean; note: string }>): RouteEntry[] {
  void verify;
  return [
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
      handler: async (req) => {
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
        const check = await verify();
        const st = sessionStatus(deps.store, deps.now());
        // 日志只出结论与脱敏摘要
        deps.log(`导入会话：${check.note}（cookie ${st.cookie}）`);
        return json(200, { imported: true, verified: check.ok, note: check.note, status: st });
      },
    },

{
      // 许愿活动「用 AI豆换抽奖码」的开关。**缺省关** —— 花的是用户的豆。
      path: `${base}/wish/exchange`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (typeof body.on !== 'boolean') return json(400, { error: '需要 {"on": true|false}' });
        setWishExchangeEnabled(deps.store, body.on, deps.now());
        deps.log(`许愿码豆换码：${body.on ? '开' : '关'}`);
        return json(200, {
          exchangeEnabled: body.on,
          note: body.on ? '豆换码已开：每趟最多换 1 张（300 豆/张）' : '豆换码已关',
        });
      },
    },

{
      path: `${base}/session/verify`,
      method: 'POST',
      handler: async () => {
        const check = await verify();
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
          baseUrl: loadBaseUrl(deps.store) || '(真主机)',
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
      // 日常这一趟的**单次预算**（秒）。默认 600（= 面板硬上限）；
      // ⚠ 面板不允许声明超过 600000ms，超了会**抛异常、插件整个加载失败**
      //   （2026-11-03 09:58 现场），所以这里把上限写死在同一处并说明白。
      path: `${base}/daily-budget`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const n = Number(body.seconds ?? body.budgetSeconds);
        if (!Number.isInteger(n) || n < 60 || n > 600) {
          return json(400, {
            error: '单次预算要给 60..600 之间的整数（秒）—— 面板对单任务有 10 分钟硬上限，超过它会拒绝加载插件',
          });
        }
        deps.store.setState('mcloud.daily.budget_s', String(n), deps.now());
        deps.log(`日常单次预算改为 ${n} 秒（下次加载插件时生效）`);
        return json(200, {
          ok: true,
          budgetSeconds: n,
          // 配置统一之后这一格在 `config.json` 里，**下一次运行就读到**（不再等重载）。
          note: `已设为 ${n} 秒 —— 下次跑就用新值（存在唯一配置文件里，不用重载插件）`,
        });
      },
    },

{
      path: `${base}/listen-seconds`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const n = Number(body.seconds ?? body.listenSeconds);
        if (!Number.isInteger(n) || n < 5 || n > 1800) {
          return json(400, { error: '听弹幕时长要给 5..1800 之间的整数（秒）' });
        }
        const saved = saveTaskListenSeconds(deps.store, n, deps.now());
        deps.log(`听弹幕时长改为 ${saved} 秒`);
        return json(200, {
          ok: true,
          listenSeconds: saved,
          note: `听弹幕时长已设为 ${saved} 秒`,
        });
      },
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
          deps.log(v ? `接口基址已改为 ${v}` : '接口基址已恢复成真主机');
          out.baseUrl = v || '(真主机)';
        }

        // ── 兑换的两个时间参数（③-3）───────────────────────────────
        //
        // 两个都是"用户的网络/习惯决定的"，所以必须是可配的：
        //   · `targetHour`：几点抢（参考实现是一天一次 10 点）
        //   · `leadMs`：压着整点提前多少毫秒发 —— 它是**本地到云端的传输耗时补偿**，
        //     所以**网络慢的人该调大**。默认 10。
        if ('targetHour' in body) {
          const raw = body.targetHour;
          const v = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
          if (v !== '') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 23) {
              return json(400, { error: '兑换时刻要是 0~23 的整点（清空 = 每小时都试）' });
            }
          }
          deps.store.setState(STATE_TARGET_HOUR, v, deps.now());
          deps.log(v === '' ? '兑换时刻：每小时都试' : `兑换时刻：每天 ${v} 点`);
          out.targetHour = v;
        }

        if ('leadMs' in body) {
          const raw = body.leadMs;
          const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
          if (!Number.isFinite(n) || n < 0 || n > 2000) {
            return json(400, { error: '提前量要是 0~2000 毫秒（网络慢就调大）' });
          }
          deps.store.setState(STATE_LEAD_MS, String(Math.round(n)), deps.now());
          deps.log(`兑换提前量：${Math.round(n)}ms`);
          out.leadMs = String(Math.round(n));
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

        // 形态的**记忆**（"上次用的是哪种"）。写它的只有添加账号弹窗那两个按钮 ——
        // 它是预填值，不是身份来源：一次登录用哪种形态，是出码时冻进会话的那一个。
        if ('loginPlatform' in body) {
          const v = parsePcPlatform(body.loginPlatform) ?? DEFAULT_PC_PLATFORM;
          deps.store.setState(STATE_LOGIN_PREF, v, deps.now());
          out.loginPlatform = v;
        }

        if ('gateBase' in body) {
          const v = typeof body.gateBase === 'string' ? body.gateBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'gateBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          saveGateBase(deps.store, v, deps.now());
          deps.log(v ? `直播日程的接口基址已改为 ${v}` : '直播日程的接口基址已恢复成真主机');
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
          if (!Number.isInteger(n) || n < 5 || n > 1800) {
            return json(400, { error: 'listenSeconds 要给 5..1800 之间的整数（秒）' });
          }
          const saved = saveTaskListenSeconds(deps.store, n, deps.now());
          deps.log(`听弹幕的窗口改为 ${saved} 秒`);
          out.listenSeconds = String(saved);
        }

        if (Object.keys(out).length === 0) {
          return json(400, {
            error: '要传 baseUrl / liveUrl / gateBase / wsBase / imBase / wsHeartbeat / listenRoom / listenSeconds（清空就传空串）',
          });
        }
        return json(200, out);
      },
    }
  ];
}
