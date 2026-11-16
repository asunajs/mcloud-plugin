// 独立版（CLI）的 HTTP：直接 await Node 的 fetch。
//
// 这一层原来有「worker + Atomics 同步桥 + 临时文件交换」，P3 把端口改成 Promise 之后
// 全删了。删掉之后**必须证明它真能用**：CLI 一条命令要打十几次上游，编码错一次就是
// "上传的文件坏了"这种最难查的现场。所以这里对着一个真 http server 打：

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeNodeFetcher } from '../src/standalone/httpBridge.ts';
import type { HttpConfig } from '../src/standalone/config.ts';

const cfg: HttpConfig = {
  timeoutMs: 5000,
  followRedirects: true,
  insecure: false,
};

/** 起一个一次性 server，返回基址与收到的请求记录。 */
async function serve(
  handler: (req: import('node:http').IncomingMessage, body: Buffer) => { status: number; headers?: Record<string, string>; body?: string },
): Promise<{ base: string; seen: { method: string; url: string; headers: Record<string, unknown>; body: Buffer }[]; close: () => Promise<void> }> {
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers as Record<string, unknown>, body });
      const out = handler(req, body);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('GET：拿得到状态、头、body', async () => {
  const s = await serve(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }));
  try {
    const r = await makeNodeFetcher(cfg)(`${s.base}/ping`);
    assert.ok(!('error' in r), JSON.stringify(r));
    if ('error' in r) return;
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"ok":true}');
    assert.match(r.headers['content-type'] ?? '', /application\/json/);
  } finally {
    await s.close();
  }
});

test('POST：JSON body 原样上去（UTF-8），且 content-length 由 fetch 自己算', async () => {
  const s = await serve((_q, body) => ({ status: 200, body: String(body.length) }));
  try {
    const text = '{"name":"移动云盘"}';
    const r = await makeNodeFetcher(cfg)(`${s.base}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999' },
      body: text,
    });
    assert.ok(!('error' in r));
    if ('error' in r) return;
    const got = s.seen[0];
    assert.ok(got !== undefined);
    assert.equal(got.body.toString('utf8'), text, 'JSON body 要逐字原样');
    assert.equal(String(got.headers['content-length']), String(Buffer.byteLength(text)), '调用方写的 content-length 要被丢掉');
  } finally {
    await s.close();
  }
});

test('POST：二进制 body（latin1 承载）不被 UTF-8 改写', async () => {
  const s = await serve(() => ({ status: 200 }));
  try {
    // 0x00 0xFF 0x80 是"不是合法 UTF-8 文本"的字节，用 latin1 承载
    const bin = String.fromCharCode(0x00, 0xff, 0x80, 0x7f);
    const r = await makeNodeFetcher(cfg)(`${s.base}/upload`, { method: 'POST', body: bin });
    assert.ok(!('error' in r));
    if ('error' in r) return;
    const got = s.seen[0];
    assert.ok(got !== undefined);
    assert.equal(
      createHash('sha256').update(got.body).digest('hex'),
      createHash('sha256').update(Buffer.from([0x00, 0xff, 0x80, 0x7f])).digest('hex'),
      `上传字节被改写了：${[...got.body].map((b) => b.toString(16))}`,
    );
  } finally {
    await s.close();
  }
});

test('4xx 不是"错误"：那是上游的答复（要原样交给调用方判）', async () => {
  const s = await serve(() => ({ status: 401, body: '{"code":"401"}' }));
  try {
    const r = await makeNodeFetcher(cfg)(`${s.base}/nope`);
    assert.ok(!('error' in r), '状态码不该变成 error');
    if ('error' in r) return;
    assert.equal(r.status, 401);
    assert.equal(r.body, '{"code":"401"}');
  } finally {
    await s.close();
  }
});

test('连不上 ⇒ {error}（不抛：调用方到处只判 `error in r`）', async () => {
  const r = await makeNodeFetcher(cfg)('http://127.0.0.1:1/none', { timeout_ms: 2000 });
  assert.ok('error' in r);
  if (!('error' in r)) return;
  assert.ok(typeof r.error === 'string' && r.error !== '');
});

test('超时 ⇒ {error}（不是一直挂着）', async () => {
  // 一个**永远不回**的服务：真超时只能这么造（handler 里 sleep 会把"等响应"变成"等 handler"）
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    const started = Date.now();
    const r = await makeNodeFetcher(cfg)(`http://127.0.0.1:${port}/slow`, { timeout_ms: 300 });
    assert.ok('error' in r, '超时必须是 error');
    assert.ok(Date.now() - started < 2500, '不该等满 3 秒');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
