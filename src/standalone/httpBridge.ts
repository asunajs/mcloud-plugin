// 同步 HTTP：Node worker 里跑原生 fetch，主线程 Atomics.wait。
//
// 不再依赖系统 curl；请求/响应通过临时文件交换，body 用 base64 保二进制。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FetchError, FetchOptions, FetchResult } from 'host-api';
import type { HttpConfig } from './config.ts';

interface Reply {
  ok: boolean;
  error?: string;
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

/** 字符串 body 有两种来源：JSON（UTF-8）与上传字节（latin1）。 */
function bodyToBase64(body: string): string {
  const utf8 = /[^\u0000-\u00ff]/.test(body);
  return Buffer.from(body, utf8 ? 'utf8' : 'latin1').toString('base64');
}

export function makeNodeFetcher(
  cfg: HttpConfig,
): (url: string, options?: FetchOptions) => FetchResult | FetchError {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-http-'));
  let seq = 0;
  let dead: string | undefined;
  let worker: Worker;

  const spawn = (): Worker => {
    const w = new Worker(new URL('./httpWorker.mjs', import.meta.url), {
      workerData: signal.buffer,
      execArgv: [],
    });
    w.on('error', (e) => {
      if (w === worker) dead = String(e?.message ?? e);
    });
    w.on('exit', (code) => {
      if (w === worker) dead = `HTTP worker 退出（${code}）`;
    });
    // 不阻塞进程退出；同步调用期间 Atomics.wait 仍然等得到结果
    w.unref();
    return w;
  };
  worker = spawn();

  const restart = (): void => {
    const old = worker;
    dead = undefined;
    worker = spawn();
    try {
      void old.terminate();
    } catch {
      /* ignore */
    }
  };

  return (url, options = {}) => {
    if (dead !== undefined) return { error: dead };
    seq += 1;
    const reqPath = join(dir, `req-${seq}.json`);
    const resPath = join(dir, `res-${seq}.json`);
    const timeout = options.timeout_ms ?? cfg.timeoutMs;
    const hasBody = options.body !== undefined;
    writeFileSync(
      reqPath,
      JSON.stringify({
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        timeoutMs: timeout,
        followRedirects: cfg.followRedirects,
        insecure: cfg.insecure,
        hasBody,
        bodyBase64: hasBody ? bodyToBase64(options.body ?? '') : '',
      }),
    );
    Atomics.store(signal, 0, 0);
    worker.postMessage({ reqPath, resPath });
    const waited = Atomics.wait(signal, 0, 0, timeout + 5000);
    try {
      if (waited === 'timed-out') {
        restart();
        return { error: `请求超时（${timeout}ms）：${url}` };
      }
      const reply = JSON.parse(readFileSync(resPath, 'utf8')) as Reply;
      if (!reply.ok) return { error: reply.error ?? 'HTTP 请求失败' };
      return {
        status: reply.status ?? 0,
        headers: reply.headers ?? {},
        body: Buffer.from(reply.bodyBase64 ?? '', 'base64').toString('utf8'),
      };
    } catch (e) {
      return { error: `HTTP worker 响应读不了：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      rmSync(reqPath, { force: true });
      rmSync(resPath, { force: true });
    }
  };
}

export function disposeNodeFetcher(f: unknown): void {
  void f;
}
