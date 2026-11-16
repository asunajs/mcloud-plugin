// panel:host 的**唯一**使用者。
//
// 把面板的 async op 收成端口：
//   · 日志   → info / warn / error（async，发出去就不等：日志是旁路）
//   · Http   → fetch（异步 op；P3 之后只剩它，http_fetch 不再用）
//   · 存储   → sqlite_*_sync（P4 换成本地 JSON，这一条就没了）
//   · 注册   → register_cron / register_web / sidebar / set_job_*
//   · 配置   → self_config
//
// 这里不写任何业务判断，也不 import 业务代码 —— 它只做"形状翻译"。

import panelHost from 'panel:host';
import type { Io, FetchOutcome, SmtpOptions, WsFrame } from '../../ports/io.ts';
import { isNotLoadedYet } from '../../ports/panel.ts';
import type { PanelEvent, PanelHost, RouterRequest, TaskDef, TaskHandler } from '../../ports/panel.ts';
import type { LogLevel } from '../../ports/log.ts';

// 面板的模块没有类型声明，一次性收成 any；本文件之外不许再出现 panel:host。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const host = panelHost as any;

function text(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

/** 面板的日志 op 是 async；调用方是同步代码 ⇒ 发出去就不管。
 *  日志失败不该让插件炸掉（面板的语义也是"日志是旁路"）。 */
function emit(op: string, msg: string): void {
  try {
    void Promise.resolve(host[op](msg)).catch(() => {});
  } catch {
    // 宿主不在（单测）就静默
  }
}

export function panelLogger(level: LogLevel, msg: string): void {
  switch (level) {
    case 'debug':
      emit('info', '[debug] ' + msg);
      return;
    case 'warn':
      emit('warn', msg);
      return;
    case 'error':
      emit('error', msg);
      return;
    case 'fatal':
      emit('error', '[fatal] ' + msg);
      return;
    case 'start':
      emit('info', '[start] ' + msg);
      return;
    case 'success':
      emit('info', '[ok] ' + msg);
      return;
    case 'fail':
      emit('warn', '[fail] ' + msg);
      return;
    default:
      emit('info', msg);
  }
}

// ── I/O（同步 op；P3/P4 会缩到只剩 ws + smtp）────────────────────────

export const panelIo: Io = {
  async fetch(url, opts) {
    try {
      // options 整包透传：tls:'native' 会走面板的平台 TLS（只有它能谈 CBC 套件）。
      // ⚠ 用**异步** op fetch（rquickjs 的 Async），不是 http_fetch ——
      //   后者背后是 sync_bridge（新起线程 + 新 runtime，并阻塞整个插件线程）。
      const r = await host.fetch(url, opts ?? {});
      return { status: r?.status ?? 0, headers: r?.headers ?? {}, body: r?.body ?? '' } as FetchOutcome;
    } catch (e) {
      // 面板失败时返回 {error}（不是抛）—— 业务侧到处在判 res.error
      return { error: text(e) } as FetchOutcome;
    }
  },
  sql(sql, params) {
    return host.sqlite_query_sync(sql, params ?? []);
  },
  exec(sql, params) {
    return host.sqlite_exec_sync(sql, params ?? []);
  },
  smtp(opts) {
    // 面板的 smtp_send 是同步 op，形状 { ok, response }；失败抛错（文本是服务器原话）
    const r = host.smtp_send(opts as SmtpOptions);
    return { ok: r?.ok === true, response: String(r?.response ?? '') };
  },
  wsOpen(url, opts) {
    return host.ws_open(url, opts ?? {});
  },
  wsSend(id, t) {
    return host.ws_send(id, t) as true;
  },
  wsRecv(id, timeout_ms) {
    return host.ws_recv(id, timeout_ms) as WsFrame;
  },
  wsClose(id) {
    return host.ws_close(id) as true;
  },
};

// ── 路由：面板只给「一个插件的兜底 handler」，路径分派在插件侧 ──────────

interface RouteEntry {
  path: string;
  method: string;
  handler: (req: RouterRequest) => unknown;
  budgetMs?: number;
}

const routes: RouteEntry[] = [];
let webRegistered = false;

function dispatchRoute(evt: unknown): unknown {
  const e = (evt ?? {}) as Record<string, unknown>;
  const method = String(e.method ?? 'GET').toUpperCase();
  const path = String(e.path ?? '');
  for (const r of routes) {
    const want = r.method.toUpperCase();
    if (want !== method && want !== 'ANY' && want !== '*') continue;
    if (r.path !== path) continue;
    try {
      const out = r.handler({
        method,
        path,
        query: String(e.query ?? ''),
        headers: (e.headers ?? {}) as Record<string, string>,
        body: String(e.body ?? ''),
      });
      return out ?? { status: 204, body: '' };
    } catch (err) {
      emit('error', '路由 ' + method + ' ' + path + ' 抛了: ' + text(err));
      return {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: text(err) }),
      };
    }
  }
  return {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: '没有这条路由: ' + method + ' ' + path }),
  };
}

/** 打 `set_job_*` 的失败。**对方插件还没加载**这类降成 debug（见 isNotLoadedYet）。 */
function jobFail(op: string, e: unknown): void {
  const t = text(e);
  if (isNotLoadedYet(t)) {
    emit('debug', '[job] ' + op + ' 跳过：对方插件还没加载（' + t.slice(0, 80) + '）');
    return;
  }
  emit('warn', '[job] ' + op + ' 失败: ' + t);
}

function jobCall(op: string, ...args: unknown[]): void {
  try {
    void Promise.resolve(host[op](...args)).catch((e: unknown) => {
      jobFail(op, e);
    });
  } catch (e) {
    jobFail(op, e);
  }
}

// ── 任务 ───────────────────────────────────────────────────────────

/** 面板的 handler 表（引擎建好的那个全局对象）。**只有 task.ts 用**。 */
export function handlersTable(): Record<string, (e: PanelEvent) => unknown> {
  const g = globalThis as unknown as { __handlers?: Record<string, (e: PanelEvent) => unknown> };
  if (g.__handlers === undefined) {
    g.__handlers = Object.create(null) as Record<string, (e: PanelEvent) => unknown>;
  }
  return g.__handlers;
}

export const panel: PanelHost = {
  async registerTask(def: TaskDef, handler: TaskHandler): Promise<void> {
    handlersTable()[def.name] = handler as (e: PanelEvent) => unknown;
    const opts: Record<string, unknown> = {};
    if (def.params !== undefined) opts.params = def.params;
    if (typeof def.lead_ms === 'number') opts.lead_ms = def.lead_ms;
    try {
      await host.register_cron(def.name, def.cron, def.budget_ms, Object.keys(opts).length > 0 ? opts : undefined);
    } catch (e) {
      // 注册失败不抛给调用方：单个任务坏了不该让整个插件装不上（面板日志里有痕迹）
      emit('error', '注册任务 ' + def.name + '（' + def.cron + '）失败: ' + text(e));
    }
  },

  registerRoute(path, method, handler, budgetMs) {
    routes.push({ path, method, handler, ...(budgetMs !== undefined ? { budgetMs } : {}) });
    if (webRegistered) return;
    webRegistered = true;
    try {
      // 先登记 dispatch 再声明"这个插件自己处理路由" —— 反过来的话第一个请求
      // 可能落在一个还不存在的 handler 上。
      void Promise.resolve(host.register_web(dispatchRoute)).catch((e: unknown) =>
        emit('error', '登记路由失败: ' + text(e)),
      );
    } catch (e) {
      emit('error', '登记路由失败: ' + text(e));
    }
  },

  sidebar(opts) {
    const payload: Record<string, unknown> = {};
    if (typeof opts.title === 'string' && opts.title.trim() !== '') payload.title = opts.title.trim();
    if (typeof opts.order === 'number' && Number.isFinite(opts.order)) payload.order = opts.order;
    try {
      void Promise.resolve(host.sidebar(payload)).catch((e: unknown) =>
        emit('error', '侧栏注册失败: ' + text(e)),
      );
    } catch (e) {
      emit('error', '侧栏注册失败: ' + text(e));
    }
  },

  async selfConfig(): Promise<Record<string, unknown>> {
    try {
      // 面板的垫片已经 JSON.parse 过了；字符串那支留给别家宿主（踩过：只认字符串 ⇒ 永远 {}）
      const v = (await host.self_config()) as unknown;
      const obj = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
      return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
        ? (obj as Record<string, unknown>)
        : {};
    } catch (e) {
      emit('warn', '读插件配置（plugin-data/config.json）失败: ' + text(e));
      return {};
    }
  },

  setJobSummary(name, t) {
    jobCall('set_job_summary', name, t ?? '');
  },
  setJobBlockers(name, list) {
    jobCall('set_job_blockers', name, list ?? []);
  },
  setJobPaused(name, paused) {
    jobCall('set_job_paused', name, !!paused);
  },
  setJobSchedule(name, opts) {
    jobCall('set_job_schedule', name, opts ?? {});
  },

  version: () => String(host.panel_version()),
  atLeast: (v: string): boolean => host.panel_at_least(String(v)) === true,
  pluginDataDir: async () => String(await host.plugin_data_dir()),
  pluginDir: async () => {
    const d = await host.plugin_dir();
    return typeof d === 'string' && d !== '' ? d : null;
  },
};
