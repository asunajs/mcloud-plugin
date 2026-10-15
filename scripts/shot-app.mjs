#!/usr/bin/env node
// 给「手机端」页签截图。**只做这一件事** —— `shots.mjs` 是七个区块的全景，
// 而这个页签要先开弹窗再切页签，那两步得点。
//
// 用法: node scripts/shot-app.mjs <面板地址> <令牌> [输出文件]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  process.env.BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
const out = process.argv[4] || '/tmp/app-tab.png';
if (!base || !token) {
  console.error('用法: node scripts/shot-app.mjs <面板地址> <令牌> [输出文件]');
  process.exit(2);
}
const browser = BROWSERS.find((p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
if (!browser) {
  console.error('找不到浏览器。用 BROWSER=/path/to/chrome 指定。');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error)));
      else w.resolve(m.result);
    });
  }
  /** **浏览器级**的调用（`Target.*`）不带 `sessionId`；页面级的用下面那个包装。 */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} 超时`));
      }, 20000);
    });
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shotapp-'));
const port = 9333;
const proc = spawn(
  browser,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl = '';
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {
    /* 还没起来 */
  }
}
if (!wsUrl) {
  console.error('浏览器没起来');
  proc.kill();
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const cdp = new Cdp(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => {
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (cdp.waiting.delete(id)) reject(new Error(`${method} 超时`));
    }, 20000);
  });
};
const evalJs = (expression) =>
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 1150,
  deviceScaleFactor: 2,
  mobile: false,
});
// 登录（面板的会话 cookie）
await send('Page.navigate', { url: `${base}/login` });
await sleep(1200);
await evalJs(`(async () => {
  const r = await fetch('${base}/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '${token}' }),
  });
  return r.status;
})()`);
await send('Page.navigate', { url: `${base}/plugins/mcloud/index.html` });
await sleep(2500);
// 开弹窗 → 切到「手机端」
await evalJs(`document.getElementById('acct-add').click()`);
await sleep(300);
await evalJs(`document.querySelector('#add-tabs [data-tab="app"]').click()`);
await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(out);
ws.close();
proc.kill();
// ⚠ 临时 profile 的清理**不许**让脚本失败：Chrome 退出时还在往里写，
//   `rmSync` 会撞 ENOTEMPTY。截图已经写完了，那才是这一趟的目的
//  —— `shots.mjs` 当初就是被这个坑到 exit 1。
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* 留着就留着，系统会清 */
}
