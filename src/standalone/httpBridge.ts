// 独立版的 HTTP：直接用 Node 的 `fetch`（异步）。
//
// 原来这里是「worker 线程里跑 fetch + 主线程 Atomics.wait」的同步桥 —— 那是给
// **同步端口**（`io().http_fetch`）用的：面板那边只有同步 op，CLI 要形状一致就得阻塞。
// P3 把端口整体改成 Promise 之后，这层桥就没有理由了：CLI 跑在 Node 上，
// `fetch` 本来就是异步的。所以 worker、SharedArrayBuffer、临时文件全删。
//
// 保留下来的两个细节（都是踩过的）：
//   · body 的编码要按**内容**判：全是 `\u0000-\u00ff` 说明是二进制（latin1 承载），
//     否则是 JSON（UTF-8）。一律 UTF-8 会把上传字节改写坏。
//   · 响应 body 只留前 1 MiB：CLI 的用法都是读 JSON，几 MB 的页面只会占内存。

import type { FetchError, FetchOptions, FetchResult } from '../ports/io.ts';
import type { HttpConfig } from './config.ts';

const MAX_BODY = 1024 * 1024;

/** 不要把「由 fetch 自己算」的头原样转给上游（转过去就是两套 content-length 打架）。 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
]);

function cleanHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 字符串 body 有两种来源：JSON（UTF-8）与上传字节（latin1）。 */
function bodyBuffer(body: string): Buffer {
  const utf8 = /[^\u0000-\u00ff]/.test(body);
  return Buffer.from(body, utf8 ? 'utf8' : 'latin1');
}

export function makeNodeFetcher(
  cfg: HttpConfig,
): (url: string, options?: FetchOptions) => Promise<FetchResult | FetchError> {
  return async (url, options = {}) => {
    const timeout = options.timeout_ms ?? cfg.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
    const method = (options.method ?? 'GET').toUpperCase();
    const init: RequestInit = {
      method,
      headers: cleanHeaders(options.headers),
      redirect: cfg.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    };
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = bodyBuffer(options.body);
    }
    // ⚠ 自签证书：`fetch` 没有"只对这一次跳过校验"的口子，只能整个进程关掉校验。
    //   CLI 是**一次性进程**（跑完就退），所以这个全局开关不会溢出到别处。
    if (cfg.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await fetch(url, init);
      const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BODY);
      const headers: Record<string, string> = {};
      for (const [k, v] of res.headers) headers[k] = v;
      // fetch 会把多个 Set-Cookie 合并成一条；`getSetCookie` 才拿得到原文
      const setCookies =
        typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
          ? (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
          : [];
      if (setCookies.length > 0) headers['set-cookie'] = setCookies.join(', ');
      return { status: res.status, headers, body: buf.toString('utf8') };
    } catch (e) {
      // 与面板那侧同一形状：错误走返回值，不抛（调用方到处都只判 `'error' in r`）
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 没有线程要收了（保留这个出口：调用方不必知道桥是怎么实现的）。 */
export function disposeNodeFetcher(f: unknown): void {
  void f;
}
