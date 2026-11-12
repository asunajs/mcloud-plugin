// panel-llrt 的 host-api 适配层。
//
// 旧面板（rust-plugin-panel）的 host-api 是**同步**的：`const res = http_fetch(...)`
// 这种写法在插件里几百处。panel-llrt 的 `panel:host` 全 async，但**提供了三个同步 op**
// （`http_fetch` / `sqlite_query_sync` / `sqlite_exec_sync`，见面板的 docs/host-api.md）。
//
// 这个文件把旧契约实现成新面板的能力：
//   - 同步 IO      → 面板的同步 op（阻塞桥，JS 线程等结果）
//   - 注册类       → `globalThis.__handlers`（面板按名字派发）+ register_cron/register_handler
//   - register_route → 面板的 `register_web` + 固定 handler 名 `__route`，由这里做路径分派
//
// 构建时 esbuild 用 alias 把 `host-api` 指到这里（见 scripts/build-panelllrt.mjs）。
// **不要**在插件代码里直接 import 这个文件。

import panelHost from 'panel:host';

// 面板的模块没有类型声明，这里一次性收成 any。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const host = panelHost as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globals = globalThis as any;

type Handler = (p: any) => any;

function text(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

/** 面板的日志 op 是 async；调用方是同步代码，所以发出去就不管了 ——
 *  日志失败不该让插件炸掉（这也是面板的语义：日志是旁路）。 */
function emit(op: string, msg: unknown): void {
  try {
    void Promise.resolve(host[op](text(msg))).catch(() => {});
  } catch {
    // 宿主不在（比如单测里）就静默
  }
}

export function log(msg: unknown): void {
  emit('info', msg);
}
export function debug(msg: unknown): void {
  emit('info', '[debug] ' + text(msg));
}
export function warn(msg: unknown): void {
  emit('warn', msg);
}
export function error(msg: unknown): void {
  emit('error', msg);
}
export function fatal(msg: unknown): void {
  emit('error', '[fatal] ' + text(msg));
}
export function start(msg: unknown): void {
  emit('info', '[start] ' + text(msg));
}
export function success(msg: unknown): void {
  emit('info', '[ok] ' + text(msg));
}
export function fail(msg: unknown): void {
  emit('warn', '[fail] ' + text(msg));
}

// ── 任务注册 ───────────────────────────────────────────────

/** 面板派发时给的是 `{task, plugin, manual, run_id}`，旧契约要的是 JobPayload。
 *  这里补成旧形状 —— 插件里读 `payload.manual` 的地方不少。 */
function wrapJob(name: string, handler: Handler): Handler {
  return (evt: any) => {
    const payload = {
      name,
      plugin: evt?.plugin ?? '',
      expr: '',
      runs: 0,
      scheduledAt: '',
      firedAt: new Date().toISOString(),
      lateMs: 0,
      jitterMs: 0,
      realigned: false,
      manual: evt?.manual === true,
      params: null,
    };
    return handler(payload);
  };
}

function registry(): Record<string, Handler> {
  if (globals.__handlers == null) globals.__handlers = Object.create(null);
  return globals.__handlers;
}

export function register_cron(name: string, expr: string, handler: Handler, opts?: any): void {
  registry()[name] = wrapJob(name, handler);
  const budget = typeof opts?.budget_ms === 'number' ? opts.budget_ms : 30_000;
  try {
    void Promise.resolve(host.register_cron(name, expr, budget)).catch((e: unknown) => {
      emit('error', '注册任务 ' + name + '（' + expr + '）失败: ' + text(e));
    });
  } catch (e) {
    emit('error', '注册任务 ' + name + ' 失败: ' + text(e));
  }
}

/** `500ms` / `2s` / `1m` —— 面板的 cron 解析器认 `@every <n><unit>`。 */
export function every(name: string, interval: string, handler: Handler, opts?: any): void {
  register_cron(name, '@every ' + interval, handler, opts);
}

export function register_handler(name: string, handler: Handler): void {
  const wrapped = wrapJob(name, handler);
  registry()[name] = wrapped;
  try {
    void Promise.resolve(host.register_handler(name, wrapped)).catch((e: unknown) => {
      emit('error', '登记 handler ' + name + ' 失败: ' + text(e));
    });
  } catch (e) {
    emit('error', '登记 handler ' + name + ' 失败: ' + text(e));
  }
}

// ── 存储（同步）────────────────────────────────────────────

export function sqlite_query(sql: string, params?: unknown[]): any[] {
  const r = host.sqlite_query_sync(sql, params ?? []);
  return Array.isArray(r?.rows) ? r.rows : [];
}

export function sqlite_exec(sql: string, params?: unknown[]): any {
  const r = host.sqlite_exec_sync(sql, params ?? []);
  return {
    changes: typeof r?.changes === 'number' ? r.changes : 0,
    lastInsertRowid: typeof r?.last_insert_rowid === 'number' ? r.last_insert_rowid : 0,
  };
}

// ── HTTP（同步）────────────────────────────────────────────

export function http_fetch(url: string, options?: any): any {
  try {
    const r = host.http_fetch(url, options ?? {});
    // 面板的同步 op 返回 {status, headers, body, truncated, …}；
    // 旧契约只认 status/headers/body，多给的字段不影响。
    return { status: r?.status ?? 0, headers: r?.headers ?? {}, body: r?.body ?? '' };
  } catch (e) {
    // 旧面板失败时返回 {error}（不是抛）—— 插件里到处在判 res.error
    return { error: text(e) };
  }
}

// ── 路由 ──────────────────────────────────────────────────

interface RouteEntry {
  path: string;
  method: string;
  handler: (req: any) => any;
  budgetMs?: number;
}

const routes: RouteEntry[] = [];
let webRegistered = false;

function dispatchRoute(evt: any): any {
  const method = String(evt?.method ?? 'GET').toUpperCase();
  const path = String(evt?.path ?? '');
  for (const r of routes) {
    const want = String(r.method ?? 'GET').toUpperCase();
    if (want !== method && want !== 'ANY' && want !== '*') continue;
    if (r.path !== path) continue;
    try {
      const out = r.handler({
        method,
        path,
        query: String(evt?.query ?? ''),
        headers: evt?.headers ?? {},
        body: String(evt?.body ?? ''),
      });
      return out ?? { status: 204, body: '' };
    } catch (e) {
      emit('error', '路由 ' + method + ' ' + path + ' 抛了: ' + text(e));
      return {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: text(e) }),
      };
    }
  }
  return {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: '没有这条路由: ' + method + ' ' + path }),
  };
}

export function register_route(
  path: string,
  method: string,
  handler: (req: any) => any,
  opts?: { budget_ms?: number },
): void {
  routes.push({ path, method, handler, budgetMs: opts?.budget_ms });
  if (!webRegistered) {
    webRegistered = true;
    try {
      // 顺序有讲究：先登记 handler，再声明「这个插件自己处理路由」——
      // 反过来的话第一个请求可能落在一个还不存在的 handler 上。
      void Promise.resolve(host.register_web(dispatchRoute)).catch((e: unknown) =>
        emit('error', '登记路由失败: ' + text(e)),
      );
    } catch (e) {
      emit('error', '登记路由失败: ' + text(e));
    }
  }
}

// ── 面板没有的能力：明确报错，不装作有 ─────────────────────

export function register_nav(_opts: unknown): void {
  // 面板的侧栏是静态的（7 项），插件入口在「插件」页的「界面」按钮上。
  emit('info', '[nav] 这个面板没有侧栏注册，插件页面走 插件页 → 界面');
}

export function worker_hint(_hint: string): void {
  // 面板一插件一 runtime，独占线程是默认的。
}

export function set_job_paused(_name: string, _paused: boolean): void {}
export function set_job_blockers(_name: string, _blockers: string[]): void {}
export function set_job_summary(_name: string, _text2: string): void {}
export function set_job_schedule(_name: string, _opts: unknown): void {}

function missing(what: string): never {
  throw new Error('panel-llrt 还没有 ' + what + '：这个功能在这台面板上不可用');
}

export function ws_open(_url: string, _options?: unknown): number {
  return missing('WebSocket 客户端');
}
export function ws_send(_id: number, _text2: string): true {
  return missing('WebSocket 客户端');
}
export function ws_recv(_id: number, _timeoutMs?: number): any {
  return missing('WebSocket 客户端');
}
export function ws_close(_id: number): true {
  return missing('WebSocket 客户端');
}
export function smtp_send(_opts: unknown): any {
  return missing('SMTP 发送');
}
