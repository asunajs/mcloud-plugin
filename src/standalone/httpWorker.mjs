// 独立版的 HTTP worker：Node 原生 fetch 是异步的，主线程通过 Atomics 等结果。
//
// 这样就不需要系统 curl。请求/响应仍然用临时 JSON 文件交换，body 用 base64
// 传输，二进制/NUL 不会被 UTF-8 改写。

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';

const signal = new Int32Array(workerData);

function reply(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value));
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
}

function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(key)) continue;
    out[k] = v;
  }
  return out;
}

parentPort.on('message', async (m) => {
  let timer;
  try {
    const req = JSON.parse(readFileSync(m.reqPath, 'utf8'));
    if (req.insecure === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), Math.max(1, req.timeoutMs ?? 20000));
    const method = String(req.method ?? 'GET').toUpperCase();
    const init = {
      method,
      headers: cleanHeaders(req.headers),
      redirect: req.followRedirects === true ? 'follow' : 'manual',
      signal: controller.signal,
    };
    if (req.hasBody === true && method !== 'GET' && method !== 'HEAD') {
      init.body = Buffer.from(req.bodyBase64 ?? '', 'base64');
    }
    const res = await fetch(req.url, init);
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 1024 * 1024);
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) headers['set-cookie'] = setCookies.join(', ');
    reply(m.resPath, {
      ok: true,
      status: res.status,
      headers,
      bodyBase64: buf.toString('base64'),
    });
  } catch (e) {
    reply(m.resPath, { ok: false, error: String(e?.message ?? e) });
  } finally {
    clearTimeout(timer);
  }
});
