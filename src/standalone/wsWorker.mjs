// 独立版的 WebSocket worker。
//
// 任务层是同步的；这里在 worker 里跑异步 ws，主线程用 Atomics.wait 等结果。
// 主线程只通过两个临时文件交换请求/响应，避免 SharedArrayBuffer 的大小限制。

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const signal = new Int32Array(workerData);
const conns = new Map();
let nextId = 1;

function reply(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value));
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
}

function frameOf(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  return { type: 'text', data: text };
}

async function open(m) {
  const req = JSON.parse(readFileSync(m.reqPath, 'utf8'));
  const id = nextId++;
  const ws = new WebSocket(req.url, {
    headers: req.headers ?? {},
    rejectUnauthorized: req.insecure !== true,
    handshakeTimeout: req.timeoutMs ?? 15000,
    perMessageDeflate: false,
  });
  const conn = { ws, queue: [], waiters: [], closed: false, closeReason: undefined };
  conns.set(id, conn);
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      conns.delete(id);
      done({ ok: false, error: 'WS 握手超时' });
    }, (req.timeoutMs ?? 15000) + 1000);
    ws.on('open', () => done({ ok: true, id }));
    ws.on('unexpected-response', (_req, res) => {
      try { ws.terminate(); } catch { /* ignore */ }
      conns.delete(id);
      done({ ok: false, error: `WS 握手被拒：HTTP ${res.statusCode}` });
    });
    ws.on('error', (e) => {
      const msg = String(e?.message ?? e);
      if (!settled) {
        conns.delete(id);
        done({ ok: false, error: msg });
        return;
      }
      conn.closed = true;
      conn.closeReason = msg;
      while (conn.waiters.length > 0) {
        const w = conn.waiters.shift();
        w({ type: 'error', message: msg });
      }
    });
    ws.on('message', (data) => {
      const f = frameOf(data);
      const w = conn.waiters.shift();
      if (w) w(f);
      else conn.queue.push(f);
    });
    ws.on('close', (code, reason) => {
      if (!settled) {
        conns.delete(id);
        done({ ok: false, error: `WS 连接关闭（${code}）` });
        return;
      }
      conn.closed = true;
      conn.closeReason = `closed ${code}${reason?.length ? ` ${reason.toString()}` : ''}`;
      while (conn.waiters.length > 0) {
        const w = conn.waiters.shift();
        w({ type: 'close', reason: conn.closeReason });
      }
    });

  });
}

function get(id) {
  const c = conns.get(id);
  if (!c) throw new Error(`WS 句柄不存在：${id}`);
  return c;
}

async function recv(m) {
  const c = get(m.id);
  if (c.queue.length > 0) return { ok: true, frame: c.queue.shift() };
  if (c.closed) return { ok: true, frame: { type: 'close', reason: c.closeReason } };
  const timeout = m.timeoutMs ?? 1000;
  const frame = await new Promise((resolve) => {
    let timer;
    const w = (f) => {
      clearTimeout(timer);
      resolve(f);
    };
    c.waiters.push(w);
    timer = setTimeout(() => {
      const i = c.waiters.indexOf(w);
      if (i >= 0) c.waiters.splice(i, 1);
      resolve({ type: 'timeout' });
    }, timeout);
  });
  return { ok: true, frame };
}

parentPort.on('message', async (m) => {
  try {
    let out;
    if (m.cmd === 'open') out = await open(m);
    else if (m.cmd === 'send') {
      get(m.id).ws.send(String(m.text));
      out = { ok: true };
    } else if (m.cmd === 'recv') out = await recv(m);
    else if (m.cmd === 'close') {
      const c = conns.get(m.id);
      if (c) {
        try { c.ws.close(); } catch { /* ignore */ }
        conns.delete(m.id);
      }
      out = { ok: true };
    } else out = { ok: false, error: `未知 WS 命令 ${m.cmd}` };
    reply(m.resPath, out);
  } catch (e) {
    reply(m.resPath, { ok: false, error: String(e?.message ?? e) });
  }
});
