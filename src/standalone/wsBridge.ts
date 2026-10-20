// 同步 WebSocket 客户端：Node worker 里跑异步 ws，主线程 Atomics.wait。
//
// 为什么需要它：任务层的 ws_open/ws_recv 是同步的（面板宿主 API 就是这样），
// 而 ws 是异步的。没有这一层，自动听直播和小红花都跑不起来。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WsFrame } from 'host-api';
import type { WsConfig } from './config.ts';

interface OpenOpts {
  headers?: Record<string, string>;
  timeout_ms?: number;
  tls?: 'rustls' | 'native';
}

interface WorkerReply {
  ok: boolean;
  error?: string;
  id?: number;
  frame?: WsFrame;
}

export interface WsBridge {
  open(url: string, opts?: OpenOpts): number;
  send(id: number, text: string): true;
  recv(id: number, timeoutMs?: number): WsFrame;
  close(id: number): true;
  dispose(): void;
}

export function makeWsBridge(cfg: WsConfig): WsBridge {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-ws-'));
  let seq = 0;
  let dead: string | undefined;
  let worker: Worker;
  const spawn = (): Worker => {
    const w = new Worker(new URL('./wsWorker.mjs', import.meta.url), {
      workerData: signal.buffer,
      // 不继承 --input-type/--test 这类只对主线程有意义的参数
      execArgv: [],
    });
    w.on('error', (e) => {
      if (w === worker) dead = String(e?.message ?? e);
    });
    w.on('exit', (code) => {
      if (w === worker) dead = `WebSocket worker 退出（${code}）`;
    });
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

  const call = (cmd: Record<string, unknown>, waitMs: number): WorkerReply => {
    if (dead !== undefined) throw new Error(dead);
    seq += 1;
    const reqPath = join(dir, `req-${seq}.json`);
    const resPath = join(dir, `res-${seq}.json`);
    writeFileSync(reqPath, JSON.stringify(cmd));
    Atomics.store(signal, 0, 0);
    worker.postMessage({ ...cmd, reqPath, resPath });
    const r = Atomics.wait(signal, 0, 0, waitMs);
    try {
      if (r === 'timed-out') {
        restart();
        throw new Error('WebSocket worker 超时（已重启）');
      }
      const reply = JSON.parse(readFileSync(resPath, 'utf8')) as WorkerReply;
      if (!reply.ok) throw new Error(reply.error ?? 'WebSocket 操作失败');
      return reply;
    } finally {
      rmSync(reqPath, { force: true });
      rmSync(resPath, { force: true });
    }
  };

  return {
    open(url, opts = {}) {
      const timeout = opts.timeout_ms ?? cfg.timeoutMs;
      const r = call(
        {
          cmd: 'open',
          url,
          headers: opts.headers ?? {},
          timeoutMs: timeout,
          insecure: cfg.insecure,
        },
        timeout + 10_000,
      );
      if (typeof r.id !== 'number') throw new Error('WebSocket worker 没返回句柄');
      return r.id;
    },
    send(id, text) {
      call({ cmd: 'send', id, text }, 10_000);
      return true;
    },
    recv(id, timeoutMs = 1000) {
      const r = call({ cmd: 'recv', id, timeoutMs }, timeoutMs + 10_000);
      if (r.frame === undefined) throw new Error('WebSocket worker 没返回帧');
      return r.frame;
    },
    close(id) {
      call({ cmd: 'close', id }, 10_000);
      return true;
    },
    dispose() {
      try {
        void worker.terminate();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
