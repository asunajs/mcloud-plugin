// 宿主 I/O 端口（**当前是同步形状**）。
//
// # 为什么现在还是同步的
//
// 面板的同步 op（http_fetch / sqlite_*_sync / ws_* / smtp_send）是给"同步步骤机"
// 那一族留的拐杖。P3 把 http 换成 Promise、P4 把 sql 换成本地 JSON 之后，
// 这个文件里只剩 ws 与 smtp 两条。所以它是个**过渡端口**，不是终态。
//
// # 为什么用"配一次再取"
//
// 同步调用没法注入（调用点遍布业务层，签名改一下就传染到底）。所以在组合根
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
  fetch(url: string, opts?: FetchOptions): FetchOutcome;
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
