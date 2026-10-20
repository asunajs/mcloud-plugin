// 独立版的 host-api 替身。
//
// 源码里所有 `import ... from 'host-api'` 在独立构建时都指到这里。
// 注意：这里不是给面板用的；面板构建仍然把 host-api 标成 external，由面板注入。

import type { FetchOptions, FetchResult, FetchError } from 'host-api';

type Fetcher = (url: string, options?: FetchOptions) => FetchResult | FetchError;

let fetcher: Fetcher = () => ({ error: '独立版 HTTP 还没初始化（createRuntime 未调用）' });

/** 由 runtime 注入 fetcher（默认是 Node worker 的 fetch）。 */
export function installFetcher(f: Fetcher): void {
  fetcher = f;
}

export function http_fetch(url: string, options?: FetchOptions): FetchResult | FetchError {
  return fetcher(url, options);
}

function stamp(level: string, msg: unknown): void {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  console.log(`[${new Date().toISOString()}] [${level}] ${text ?? String(msg)}`);
}

export function log(msg: unknown): void {
  stamp('info', msg);
}
export function debug(msg: unknown): void {
  stamp('debug', msg);
}
export function warn(msg: unknown): void {
  stamp('warn', msg);
}
export function error(msg: unknown): void {
  stamp('error', msg);
}
export function fatal(msg: unknown): void {
  stamp('fatal', msg);
}
export function start(msg: unknown): void {
  stamp('start', msg);
}
export function success(msg: unknown): void {
  stamp('success', msg);
}
export function fail(msg: unknown): void {
  stamp('fail', msg);
}

export function register_cron(..._args: unknown[]): void {
  // 独立版没有内置调度器；用户自己的 cron 调 mcloud-sign。
}
export function register_route(..._args: unknown[]): void {}
export function register_nav(..._args: unknown[]): void {}
export function worker_hint(..._args: unknown[]): void {}
export function set_job_paused(..._args: unknown[]): void {}
export function set_job_blockers(..._args: unknown[]): void {}
export function set_job_summary(..._args: unknown[]): void {}
export function set_job_schedule(..._args: unknown[]): void {}

export function sqlite_query(..._args: unknown[]): never {
  throw new Error('独立版不走 SQLite：状态在 .mcloud/state.json');
}
export function sqlite_exec(..._args: unknown[]): never {
  throw new Error('独立版不走 SQLite：状态在 .mcloud/state.json');
}

export function smtp_send(..._args: unknown[]): never {
  throw new Error('独立版 v1 不支持 SMTP 推送；请用 HTTP 推送渠道');
}

// ── WebSocket：由 wsBridge 在 runtime 里注入 ──
type WsOpen = (url: string, opts: { headers?: Record<string, string>; timeout_ms?: number; tls?: 'rustls' | 'native' }) => number;
type WsSend = (id: number, text: string) => true;
type WsRecv = (id: number, timeoutMs?: number) => unknown;
type WsClose = (id: number) => true;

let wsOpenImpl: WsOpen = () => {
  throw new Error('独立版 WebSocket 还没初始化');
};
let wsSendImpl: WsSend = () => {
  throw new Error('独立版 WebSocket 还没初始化');
};
let wsRecvImpl: WsRecv = () => {
  throw new Error('独立版 WebSocket 还没初始化');
};
let wsCloseImpl: WsClose = () => {
  throw new Error('独立版 WebSocket 还没初始化');
};

export function installWs(impl: { open: WsOpen; send: WsSend; recv: WsRecv; close: WsClose }): void {
  wsOpenImpl = impl.open;
  wsSendImpl = impl.send;
  wsRecvImpl = impl.recv;
  wsCloseImpl = impl.close;
}

export function ws_open(url: string, opts: { headers?: Record<string, string>; timeout_ms?: number; tls?: 'rustls' | 'native' }): number {
  return wsOpenImpl(url, opts);
}
export function ws_send(id: number, text: string): true {
  return wsSendImpl(id, text);
}
export function ws_recv(id: number, timeoutMs?: number): unknown {
  return wsRecvImpl(id, timeoutMs);
}
export function ws_close(id: number): true {
  return wsCloseImpl(id);
}
