import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { makeWsBridge } from '../src/standalone/wsBridge.ts';

test('同步 WS 桥：open/send/recv/timeout/close + 两拍之间缓存', async () => {
  const code = `import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws) => {
  ws.send('hello');
  ws.send('queued');
  ws.on('message', (m) => ws.send('echo:' + m));
});
wss.on('listening', () => console.log(wss.address().port));
`;
  const cp = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      cp.stdout.on('data', (x) => {
        buf += x.toString();
        const m = /^(\d+)\s*$/.exec(buf);
        if (m !== null) resolve(Number(m[1]));
      });
      cp.stderr.on('data', (x) => reject(new Error(x.toString())));
      cp.on('exit', (c) => reject(new Error(`ws server 退出 ${c}`)));
    });
    const b = makeWsBridge({ insecure: false, timeoutMs: 3000 });
    try {
      const id = b.open(`ws://127.0.0.1:${port}`, { timeout_ms: 3000 });
      assert.deepEqual(b.recv(id, 1000), { type: 'text', data: 'hello' });
      assert.deepEqual(b.recv(id, 1000), { type: 'text', data: 'queued' });
      b.send(id, 'x');
      const echo = b.recv(id, 1000);
      assert.deepEqual(echo, { type: 'text', data: 'echo:x' });
      assert.deepEqual(b.recv(id, 30), { type: 'timeout' });
      b.close(id);
    } finally {
      b.dispose();
    }
  } finally {
    cp.kill();
  }
});
