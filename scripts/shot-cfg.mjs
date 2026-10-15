#!/usr/bin/env node
// 给「每账号设置」弹窗截图。用法同 shot-app.mjs。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  process.env.BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);
const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
const out = process.argv[4] || '/tmp/cfg.png';
const browser = BROWSERS.find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
if (!browser) { console.error('找不到浏览器。用 BROWSER=... 指定。'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} 超时`)); }, 20000);
    });
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shotcfg-'));
const port = 9334;
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); wsUrl = (await r.json()).webSocketDebuggerUrl; if (wsUrl) break; } catch { /* 还没起来 */ }
}
if (!wsUrl) { console.error('浏览器没起来'); proc.kill(); process.exit(2); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new Cdp(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => {
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (cdp.waiting.delete(id)) reject(new Error(`${method} 超时`)); }, 20000);
  });
};
const evalJs = (e) => send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1150, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `${base}/login` });
await sleep(1200);
await evalJs(`(async () => (await fetch('${base}/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${token}' }) })).status)()`);
await send('Page.navigate', { url: `${base}/plugins/mcloud/index.html` });
await sleep(2500);
const r = await evalJs(`(() => { const b = document.querySelector('[data-acc-settings]'); if (!b) return '没有卡片'; b.click(); return 'ok'; })()`);
await sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(r.result?.value, out);
ws.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 系统会清 */ }
