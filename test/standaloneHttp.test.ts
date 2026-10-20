import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { makeNodeFetcher } from '../src/standalone/httpBridge.ts';

test('同步 HTTP：方法 / 头 / 二进制 body / set-cookie', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-http-'));
  const server = join(d, 'server.mjs');
  writeFileSync(
    server,
    `import { createServer } from 'node:http';
const s = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const b = Buffer.concat(chunks);
    res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: b.toString('latin1'), bytes: b.length }));
  });
});
s.listen(0, '127.0.0.1', () => console.log(s.address().port));
`,
  );
  const cp = spawn(process.execPath, [server], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      cp.stdout.on('data', (x) => {
        buf += x.toString();
        const m = /^(\d+)\s*$/.exec(buf);
        if (m !== null) resolve(Number(m[1]));
      });
      cp.stderr.on('data', (x) => reject(new Error(x.toString())));
      cp.on('exit', (code) => reject(new Error(`server 退出 ${code}`)));
    });
    const f = makeNodeFetcher({ timeoutMs: 5000, insecure: false, followRedirects: false });
    const body = 'A' + String.fromCharCode(0) + 'B';
    const res = f(`http://127.0.0.1:${port}/echo?q=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test': 'yes' },
      body,
    });
    assert.ok(!('error' in res), JSON.stringify(res));
    assert.equal(res.status, 200);
    assert.equal(res.headers['set-cookie'], 'a=1; Path=/, b=2; Path=/');
    const parsed = JSON.parse(res.body) as { method: string; headers: Record<string, string>; body: string; bytes: number };
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.headers['x-test'], 'yes');
    assert.equal(parsed.body, body);
    assert.equal(parsed.bytes, 3);
  } finally {
    cp.kill();
  }
});
