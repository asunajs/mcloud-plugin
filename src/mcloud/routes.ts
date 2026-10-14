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
import { MATRIX_GROUPS, readMatrix } from './tasks/appTaskMatrix.ts';
import { VERDICT_TEXT, readExchangeList } from './tasks/exchangeList.ts';
import {
  EMPTY_SHELL_HINT_CHARS,
  clearLiveCodes,
  loadLiveCodes,
  loadLiveUrl,
  readLiveReading,
  saveLiveCodes,
  saveLiveUrl,
} from './tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from './liveKouling.ts';
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
import type { Store } from '../store/types.ts';
import type { Transport } from './client.ts';

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
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

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

/** 路由表。main.ts 遍历它去调用真的 `register_route`。 */
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

        if (Object.keys(out).length === 0) {
          return json(400, { error: '要传 baseUrl 或 liveUrl（清空就传空串）' });
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
          groups: rows.map((r, i) => ({ group: MATRIX_GROUPS[i], reading: r })),
          read: rows.filter(Boolean).length,
          total: MATRIX_GROUPS.length,
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
