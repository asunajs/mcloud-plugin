// 宿主 I/O 端口。
//
// # 现在的形状（P3 / P4 之后）
//
// · fetch  —— **异步**（面板的 `host.fetch` 是真 async op；Node 侧是 fetch）
// · sql    —— 只剩"从旧面板的库里搬一次"用（P4 之后状态在本地 JSON 里）
// · smtp / ws_* —— 仍是同步：面板没给异步版，而它们不在热路径上
//
// 也就是说：**网络热路径已经全是异步的**，剩下这两条同步的是有意的例外。
//
// # 为什么用"配一次再取"
//
// 端口没法逐层传（调用点遍布业务层）。所以在组合根
// （四个 entry / CLI main）里 install 一次，业务层通过 io() 取。
// 这是**唯一**允许的宿主单例，而且 P3/P4 之后它会缩到很小。

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  /** 正文（面板按 lossy UTF-8 给；要二进制走 binary: true 的 body_base64） */
  body: string;
}

/** 失败形状：`{error}` —— **不是**异常，也**没有** status/headers/body（F-006）。 */
export interface FetchError {
  error: string;
}

export type FetchOutcome = FetchResult | FetchError;

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  /** 只对 https 生效（面板先校验选项再发请求，见 client.ts 的说明） */
  tls?: 'rustls' | 'native';
  binary?: boolean;
}

export type WsFrame =
  | { type: 'text'; data: string }
  | { type: 'binary'; hex: string }
  | { type: 'timeout' }
  | { type: 'close'; reason: string }
  | { type: 'error'; message: string };

export interface SmtpOptions {
  host: string;
  port?: number;
  /** starttls（默认）/ implicit / none。⚠ 面板**拼错会报错**，不会默认成 none。 */
  tls?: string;
  user?: string;
  pass?: string;
  from: string;
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  timeout_ms?: number;
}

export interface Io {
  /** 发一个请求。**异步**（P3）：面板侧是 `host.fetch`，Node 侧是 `fetch`。
   *
   *  ⚠ 为什么必须是异步：同步 op（`http_fetch`）背后是 `sync_bridge` ——
   *  每次调用新起一个线程 + 新 runtime，而且**阻塞整个插件线程**：上游一慢，
   *  这个插件的日志/界面/别的任务全排在后面。异步之后同一个线程可以继续干活。 */
  fetch(url: string, opts?: FetchOptions): Promise<FetchOutcome>;
  /** 查询：行数组；宿主出错时给 `{error}`（保持宿主的形状，由调用方判） */
  sql(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): unknown;
  smtp(opts: SmtpOptions): { ok: boolean; response: string };
  wsOpen(url: string, opts?: { headers?: Record<string, string>; timeout_ms?: number; tls?: 'rustls' | 'native' }): number;
  wsSend(id: number, text: string): true;
  wsRecv(id: number, timeout_ms?: number): WsFrame;
  wsClose(id: number): true;
}

let installed: Io | null = null;

export function installIo(impl: Io): void {
  installed = impl;
}

export function io(): Io {
  if (installed === null) {
    throw new Error('宿主 I/O 还没装：组合根要先 installIo(...)（面板 entry / CLI main）');
  }
  return installed;
}
