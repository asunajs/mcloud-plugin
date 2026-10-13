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
      // 上游基址：CI 指向 mock 用；生产留空 = 用真地址
      path: `${base}/config`,
      method: 'GET',
      handler: () => json(200, { baseUrl: loadBaseUrl(deps.store) || '(真上游)' }),
    },
    {
      path: `${base}/config`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const v = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
        if (v && !/^https?:\/\//.test(v)) {
          return json(400, { error: 'baseUrl 要以 http:// 或 https:// 开头（清空就传空串）' });
        }
        deps.store.setState(STATE_BASE_URL, v.replace(/\/+$/, ''), deps.now());
        deps.log(v ? `上游基址已改为 ${v}` : '上游基址已恢复为真上游');
        return json(200, { baseUrl: v || '(真上游)' });
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
