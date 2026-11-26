#!/usr/bin/env node
// 给「从面板里点开这个插件」截图 —— 用户真正的动线。
//
// 为什么单独一个脚本（而不是塞进 `shots.mjs`）：
// `shots.mjs` 是"直接打开插件页"逐块截，它的浏览器会先访问 `/plugins/mcloud/…`；
// 之后面板的 hash 路由会自己回到 `#plugin:mcloud`，那时侧栏那条文字节点**不再是叶子节点**
// （图标也在同一个 span 里），点不到、iframe 也不重新装 —— 实测三次都失败。
// 这里走的是另一条顺序：**先开面板、再点侧栏**，那条路是稳的。
//
// 用法同 `shots.mjs`（面板得先起着）：
//   node scripts/shot-in-panel.mjs http://127.0.0.1:8892 shotstoken out/
//
// 判据（脚本自己断言）：
//   ① 侧栏里能找到「移动云盘」这一条并点开；
//   ② 装出来的 iframe `src` 里含 `/plugins/mcloud/`（面板是用 iframe 嵌插件页的）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
const outDir = process.argv[4] || 'docs/shots';
if (!base || !token) {
  console.error('用法: node scripts/shot-in-panel.mjs <面板地址> <令牌> [输出目录]');
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
  console.error('找不到浏览器（用 BROWSER=… 指定）');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 收摊：杀浏览器 + 删临时 profile。
 *
 *  ⚠ 必须挂在 `process.on('exit')` 上：这个脚本有几条 `process.exit(1)` 的失败路径，
 *    只在末尾收摊的话，失败时会把一个 headless Edge **留在后台**（现场：跑挂了三次，
 *    `pgrep -f shot-panel-` 里躺着三个）。 */
function cleanup() {
  try {
    chrome?.kill();
  } catch {
    /* 已经没了 */
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile 里可能还有文件在收尾，删不掉就算了（是 /tmp） */
  }
}
process.on('exit', cleanup);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-panel-'));
const port = Number(process.env.CDP_PORT || 9336);
const chrome = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 连**页面**那个 target（不是 browser 端点 —— 连错了 `Page.navigate` 是空操作，
 *  第一版就是这么写的，表现是"永远停在 about:blank、侧栏当然找不到"）。 */
async function pageWsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('等不到页面 target');
}

const ws = new WebSocket(await pageWsUrl());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    // ⚠ 交出去的是 **`m.result`**（不是整个消息）—— 不然 `Page.captureScreenshot` 拿到的
    //   是 `{result:{data}}`，`const { data } = …` 会是 undefined（第一版就这么炸的）。
    pending.get(m.id)(m.result ?? {});
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

// 登录拿 cookie（面板的会话 cookie 在**响应头**里）
let res;
try {
  res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
} catch (e) {
  // 面板没起 / 地址写错：说人话，别甩一坨 fetch 的堆栈
  console.error(`连不上面板 ${base}：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
const setCookie = res.headers.get('set-cookie') || '';
const name = (setCookie.split('=')[0] || '').trim();
const value = (setCookie.split('=')[1] || '').split(';')[0];
if (!name || !value) {
  console.error(`登录没拿到 cookie（http ${res.status}）`);
  process.exit(2);
}
await send('Network.setCookie', { name, value, domain: new URL(base).hostname, path: '/' });
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

// 开面板 → 点侧栏那一条
await send('Page.navigate', { url: `${new URL(base).origin}/` });
await sleep(3000);
// ⚠ 面板可能**自己**就回到了 `#plugin:mcloud` 并把 iframe 装好（它记着上次看的那一页），
//   这时侧栏那条文字节点已经带着图标、不是叶子节点 ⇒ 先去等 iframe，别一上来就点。
let frameSrc0 = '';
for (let i = 0; i < 12; i++) {
  frameSrc0 = String((await ev(`(document.querySelector('iframe')?.getAttribute('src')) || ''`)) || '');
  if (frameSrc0.includes('/plugins/mcloud/')) break;
  await sleep(700);
}
if (frameSrc0.includes('/plugins/mcloud/')) {
  console.log(`  （面板自己就装好了 iframe：${frameSrc0}）`);
}
let clicked = false;
for (let i = 0; i < 12; i++) {
  clicked = (await ev(`(() => {
    const hit = [...document.querySelectorAll('*')].find(
      (n) => (n.textContent || '').trim() === '移动云盘' && n.children.length === 0,
    );
    if (!hit) return false;
    (hit.closest('a,button,li,div') || hit).click();
    return true;
  })()`)) === true;
  if (clicked) break;
  await sleep(700);
}
if (!clicked && !frameSrc0.includes('/plugins/mcloud/')) {
  console.error('侧栏里没找到「移动云盘」入口，也没自己装出 iframe');
  process.exit(1);
}
if (clicked) await sleep(3000);
const frameSrc = String((await ev(`(document.querySelector('iframe')?.getAttribute('src')) || ''`)) || '');
if (!frameSrc.includes('/plugins/mcloud/')) {
  console.error(`点开了，但 iframe 的 src 不对：${JSON.stringify(frameSrc)}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const out = path.join(outDir, '11-in-panel.png');
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`  ${out}`);
console.log(`✅ 面板里点开插件：iframe=${frameSrc}`);

ws.close();
// 收摊交给 `process.on('exit')` 那个 cleanup（成功/失败都走同一处）

