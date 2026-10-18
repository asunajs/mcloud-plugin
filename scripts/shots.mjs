#!/usr/bin/env node
// ⚠ 输出目录里除了 PNG 还有 `README.md`（截图说明表）。脚本**只写不删** ——
//   别为了"清干净"去 `rm -rf` 那个目录，会把 README 一起删掉，
//   而 `test/docs.test.ts` 会因为 README 里那条链接变成死链而红。
// 给插件界面截图 —— 用来**真的看一眼**菜单栏七个区块长什么样。
//
// # 为什么值得单独一个脚本
//
// 静态测试能钉住「id 对得上」「七个菜单项」「没有高级开关」，但**钉不住**
// 「它看起来是不是还是乱七八糟」—— 而后者才是用户的原话
// （「界面完全搞不懂，文字一大堆，按钮点哪个都不知道」）。
//
// 所以这个脚本干一件事：起面板 → 设 cookie → 打开插件页 → 每个区块截一张。
// 零依赖：Node 22+ 自带 fetch 与 WebSocket，直接讲 CDP。
//
// 用法（面板得先自己起着）：
//   PANEL_TOKEN=t PLUGINS_DIR=$PWD/plugins BIND_ADDR=127.0.0.1:8791 \
//     /path/to/plugin-panel &
//   node scripts/shots.mjs http://127.0.0.1:8791 t out/
//
// 浏览器用 `BROWSER=/path/to/chrome` 指定，否则按候选路径找。

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
  '/usr/bin/chromium',
].filter(Boolean);

const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
const outDir = process.argv[4] || 'docs/shots';

if (!base || !token) {
  console.error('用法: node scripts/shots.mjs <面板地址> <令牌> [输出目录]');
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

/** 极简 CDP 客户端：连上 → 发命令 → 收结果。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }
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

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const port = 9333 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 等 CDP 端口起来
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) {
    chrome.kill();
    console.error('浏览器没起来');
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

  // 这一层是「带着 sessionId 发」的包装（flatten 模式）
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

  await send('Page.enable');
  await send('Runtime.enable');
  // 窄一点的手机宽度 + 2x，看得清字
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 900,
    deviceScaleFactor: 2,
    mobile: true,
  });

  // 设 cookie：面板的会话 cookie 名是 **`panel_session`**（不是 `session`）。
  // ⚠ cookie 在 **响应头** 里，不在 JSON 体里 —— 体里只有 `{"ok":true}`。
  //   从体里找 cookie 的话会一直"登录没拿到 cookie"（我第一版就是这样）。
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const name = (setCookie.split('=')[0] || '').trim();
  const value = (setCookie.split('=')[1] || '').split(';')[0];
  if (!name || !value) {
    console.error(`登录没拿到 cookie（http ${res.status}，set-cookie=${JSON.stringify(setCookie)}）`);
    process.exit(2);
  }
  await send('Network.enable');
  await send('Network.setCookie', {
    name,
    value,
    domain: new URL(base).hostname,
    path: '/',
  });

  const url = `${base}/plugins/mcloud/index.html`;
  await send('Page.navigate', { url });
  await sleep(2500);

  fs.mkdirSync(outDir, { recursive: true });

  // 顶栏 + 菜单栏 + 当前区块的合影
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const p = path.join(outDir, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    console.log(`  ${p}`);
  };

  await shot('01-account');

  // 添加账号那一路：**先打开弹窗，再点里面的「生成二维码」**。
  //
  // ⚠ 原来只有后半句。界面改成"工具栏 + 弹窗"之后，`login-qr` 住在弹窗里，
  //   直接 `.click()` 它是能跑的（隐藏的元素也收得到程序化的 click），但**弹窗没开** ——
  //   于是截出来的图里只有底部那句提示，看不到二维码。脚本是给"看一眼"用的，
  //   看到的东西不对等于没截。
  await send('Runtime.evaluate', { expression: `document.getElementById('acct-add').click()` });
  await sleep(200);
  await send('Runtime.evaluate', {
    expression: `document.getElementById('login-qr').click()`,
  });
  await sleep(1500);
  await shot('01b-qr');
  // 收起来，别把弹窗带进后面几张
  await send('Runtime.evaluate', { expression: `document.getElementById('add-close').click()` });
  await sleep(200);

  // 逐块切过去截（⚠「设置」那一块已经删了 —— 见 findings F-068）
  const blocks = [
    ['daily', '02-daily'],
    ['exchange', '03-exchange'],
    ['live', '04-live'],
    ['data', '05-data'],
    ['push', '06-push'],
  ];
  for (const [block, name] of blocks) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.menu-item[data-block="${block}"]').click()`,
    });
    await sleep(400);
    await shot(name);
  }

  // 回到「日常」，真跑一次，再截一张 —— 「最近几次」那个列表只有真跑过才有内容
  await send('Runtime.evaluate', {
    expression: `document.querySelector('.menu-item[data-block="daily"]').click()`,
  });
  await sleep(300);
  await send('Runtime.evaluate', { expression: `document.getElementById('daily-run').click()` });
  await sleep(8000);
  await shot('08-daily-recent');

  ws.close();
  // ⚠ 先等浏览器**真的退出**再删 profile 目录。
  //   原来 `kill()` 之后立刻 `rmSync` —— 而 `kill` 只是发信号，进程还在写
  //   profile（Chrome 退出时会落盘一堆状态文件）⇒ 实测报
  //   `ENOTEMPTY, Directory not empty`。截图本身是成功的，但退出码非 0，
  //   而"截图脚本报错"会让人以为截图坏了。
  await stopChrome(chrome);
  rmProfile(profile);
  console.log('✅ 截完');
}

/** 发 SIGTERM 并等它真的退出（有上限，别把脚本挂住）。 */
function stopChrome(chrome) {
  return new Promise((resolve) => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      chrome.kill('SIGKILL');
      resolve();
    }, 5000);
    chrome.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    chrome.kill();
  });
}

/** 删 profile 目录。**带重试** —— 退出瞬间还可能有一两个文件在收尾。 */
function rmProfile(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 4) {
        // 删不掉就**别让脚本失败**：它只是临时目录，系统会清。
        console.warn(`（临时目录没删干净，不影响截图：${e.code ?? e.message}）`);
        return;
      }
      // 忙等一小会儿再试（同步上下文里没有 await）
      const until = Date.now() + 200;
      while (Date.now() < until) {
        /* 等目录句柄释放 */
      }
    }
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
