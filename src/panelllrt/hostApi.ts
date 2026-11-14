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
  // params / lead_ms 是注册期就给面板的（面板存着，每拍原样交回 payload.params）。
  const extra: Record<string, unknown> = {};
  if (opts != null && 'params' in opts) extra.params = opts.params ?? null;
  if (typeof opts?.lead_ms === 'number') extra.lead_ms = opts.lead_ms;
  const extraArg = Object.keys(extra).length ? extra : undefined;
  try {
    void Promise.resolve(host.register_cron(name, expr, budget, extraArg)).catch((e: unknown) => {
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

// ── 配置 ───────────────────────────────────────────────────
//
// 面板的「插件配置」页写 `plugin-data/<插件>/config.json`，改完会**重载这个插件**
// （`web.rs` 的 `plugin_config_put`）⇒ 加载期读一次就是最新的，不用轮询。
// 宿主给的是 JSON 文本（`op_self_config`），这里解成对象；空文件/没有文件是 `{}`。

export async function self_config(): Promise<Record<string, unknown>> {
  try {
    // ⚠ 面板的 JS 垫片已经把 `raw.self_config()` 的 JSON 文本 `JSON.parse` 过了
    //   （见 panel-llrt `src/hostapi.rs` 的 `self_config: async () => JSON.parse(...)`），
    //   所以这里拿到的是**对象**。字符串那支留着是为了别家宿主 —— 2026-11-14 现场：
    //   只认字符串 ⇒ 永远返回 {}，面板上填的预算一格都没生效，而且不报错。
    const v = (await host.self_config()) as unknown;
    const obj = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : {};
  } catch (e) {
    // 读不到不该让插件炸掉：说一句，按"没配过"继续（字段的默认值都在插件里）。
    emit('warn', '读插件配置（plugin-data/config.json）失败: ' + text(e));
    return {};
  }
}

// ── HTTP（同步）────────────────────────────────────────────

export function http_fetch(url: string, options?: any): any {
  try {
    // options 整包透传：tls:'native' 会走面板的平台 TLS 那条路（只有它能谈 CBC 套件）
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

/** 侧栏入口 —— 面板**有**这个能力：`host.sidebar({ title, order })`（host-api.md §sidebar）。
 *
 * ⚠ 以前这里写的是"面板没有侧栏注册"，于是「移动云盘」永远不出现在侧栏里
 *   （用户 2026-11-13 现场：侧栏只有 咪咕音乐 / 套件演示）。`/api/state` 里
 *   我们的 `nav` 是 `null`，而 mgmusic 是 `{title:'咪咕音乐', order:80}` —— 差别就在这一步。
 *
 * 旧契约的 `label` → 面板的 `title`；`order` 原样透传（面板缺省 100，越小越靠上）。 */
export function register_nav(opts: unknown): void {
  const o = (opts ?? {}) as { label?: unknown; title?: unknown; order?: unknown };
  const title = typeof o.title === 'string' ? o.title : typeof o.label === 'string' ? o.label : undefined;
  const payload: Record<string, unknown> = {};
  if (title !== undefined && title.trim() !== '') payload.title = title.trim();
  if (typeof o.order === 'number' && Number.isFinite(o.order)) payload.order = o.order;
  try {
    void Promise.resolve(host.sidebar(payload)).catch((e: unknown) => {
      emit('error', '侧栏注册失败: ' + text(e));
    });
  } catch (e) {
    emit('error', '侧栏注册失败: ' + text(e));
  }
}

export function worker_hint(_hint: string): void {
  // 面板一插件一 runtime，独占线程是默认的。
}

// ── 面板版本（能力降级用，不是硬拒）──────────────────────────
//
//   if (panel.atLeast('0.3.0')) { /* 新路径 */ } else { /* 兼容路径 + 一句提示 */ }
//
// 版本比较是 semver：0.3 ≡ 0.3.0、v 前缀被忽略、0.3.0-rc.1 < 0.3.0；
// 非法版本串**抛错**（「版本写错了」和「版本不够」是两件事）。
export const panel = {
  version: (): string => String(host.panel_version()),
  atLeast: (v: string): boolean => host.panel_at_least(String(v)) === true,
};
// 基线的契约：panel 同时是**全局**，裸名 panel.version() 也能用。
globals.panel = panel;

// ── 任务状态（面板 2026-11-12 起支持）──────────────────────────
// 面板侧是 async，插件侧是同步调用点：发出去就不等（失败记一条日志，不抛）。
// 目标写法：'任务名'（自己的）或 '插件名/任务名'（同组 mcloud-* 的）。
function jobCall(op: string, ...args: unknown[]): void {
  try {
    void Promise.resolve(host[op](...args)).catch((e: unknown) => {
      emit('warn', '[job] ' + op + ' 失败: ' + text(e));
    });
  } catch (e) {
    emit('warn', '[job] ' + op + ' 失败: ' + text(e));
  }
}

export function set_job_paused(name: string, paused: boolean): void {
  jobCall('set_job_paused', name, !!paused);
}
export function set_job_blockers(name: string, blockers: string[]): void {
  jobCall('set_job_blockers', name, blockers ?? []);
}
export function set_job_summary(name: string, text2: string): void {
  jobCall('set_job_summary', name, text2 ?? '');
}
export function set_job_schedule(name: string, opts: unknown): void {
  jobCall('set_job_schedule', name, opts ?? {});
}

function missing(what: string): never {
  throw new Error('panel-llrt 还没有 ' + what + '：这个功能在这台面板上不可用');
}

// ── WebSocket（面板 2026-11-12 起支持）────────────────────────
// 面板那边是同步语义：ws_recv 带超时，超时返回 {type:'timeout'}（不是错误）。
export function ws_open(url: string, options?: any): number {
  return host.ws_open(url, options ?? {});
}
export function ws_send(id: number, text: string): true {
  return host.ws_send(id, text) as true;
}
export function ws_recv(id: number, timeout_ms?: number): any {
  return host.ws_recv(id, timeout_ms);
}
export function ws_close(id: number): true {
  return host.ws_close(id) as true;
}
export function smtp_send(opts: unknown): any {
  // 面板的 smtp_send 是**同步** op（和 http_fetch 同构），形状与旧面板一致：
  //   { ok: true, response: '250 ...' }；失败抛错，错误文本是服务器那句原话。
  const res = host.smtp_send(opts);
  return { ok: res?.ok === true, response: String(res?.response ?? '') };
}
