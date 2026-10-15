// 插件界面（`plugins/mcloud/index.html` + `app.js` + `style.css`）的**静态**一致性。
//
// # 守的是哪几类错
//
// ① **id 对不上**。`app.js` 里到处是 `$('some-id')`（= `document.getElementById`）。
//    一旦 id 写错（改名、复制粘贴、大小写），浏览器里**不报错、不白屏** ——
//    只是那一段渲染静默不生效（例如「今天跑了吗」那行永远是空的）。
//    这种错在仓库里没有任何测试看得见（面板只检查自己的 web 资产，插件界面归插件管）。
//
// ② **按钮没挂处理器**。挂错了点下去没反应 —— 而「点了没反应」正是用户
//    抱怨过的现象之一（旧版二十几个按钮各写一遍，有的忘了绑）。
//
// ③ **样式里的孤儿 id 选择器**（改名留下的死规则）。
//
// ④ **界面又开始一个区块一个接口**。这一条是**设计约束**，不是卫生问题：
//    旧版每块各有各的加载/错误状态，用户看到「有的块有数、有的块空着、
//    有的块报错」，而没人知道该看哪个。读数必须**只走一个**聚合接口。
//
// ⑤ **菜单栏与区块一一对应**。七个词、七块、一次一块 —— 这是「极简界面」
//    那条需求的结构本身。少一块就是有东西用户点不到；多一块就是有东西
//    没进菜单（等于藏起来了，正是旧版「高级」开关的毛病）。
//
// 语法/渲染本身**测不了**（要 DOM）—— 这一点如实写在这里，不假装覆盖到了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../plugins/mcloud/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const js = readFileSync(new URL('app.js', dir), 'utf8');
const css = readFileSync(new URL('style.css', dir), 'utf8');

/** 去掉注释后的 HTML。
 *
 *  ⚠ 必须去掉：这一版 index.html 的开头有一大段**解释旧版哪里难用**的注释，
 *  里面会提到「高级」开关、「推进一步」这些**被删掉的**词。
 *  不剥注释的话，那些断言会被自己的文档判红 —— 我第一版就是这样。 */
function stripComments(t: string): string {
  return t.replace(/<!--[\s\S]*?-->/g, '');
}


/** 一个文件里出现的所有 `id="x"`（模板串里也算 —— 那是运行时会插进 DOM 的）。 */
function idsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/id="([A-Za-z0-9_-]+)"/g)) out.add(m[1] as string);
  return out;
}

/** `app.js` 里所有 `$('x')` 取用的 id。 */
function idsUsed(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) out.add(m[1] as string);
  return out;
}

// ── ① id 对得上 ────────────────────────────────────────────────────────

test('`app.js` 取用的每个 id 都真的存在（写错 = 那段渲染静默不生效）', () => {
  const declared = idsIn(html);
  const dynamic = idsIn(js);
  const used = [...idsUsed(js)].sort();
  assert.ok(used.length > 10, `取用的 id 太少了（${used.length}）—— 是不是正则没跟上写法？`);
  const missing = used.filter((id) => !declared.has(id) && !dynamic.has(id));
  assert.deepEqual(
    missing,
    [],
    `这些 id 在 index.html 与 app.js 的模板串里都找不到：${missing.join(', ')}`,
  );
});

// ── ② 按钮都挂了处理器 ────────────────────────────────────────────────

test('界面里挂的按钮都有对应的处理器（挂错 = 点了没反应）', () => {
  const buttons = [...html.matchAll(/<(button|input|textarea)[^>]*id="([A-Za-z0-9_-]+)"/g)].map(
    (m) => m[2] as string,
  );
  const unbound = buttons.filter((id) => !js.includes(`$('${id}')`));
  assert.deepEqual(unbound, [], `这些控件在 app.js 里从没被取用过：${unbound.join(', ')}`);
});

test('⚠ 每个按钮都**真的挂上了**处理器（不只是被 `$()` 取用过）', () => {
  // 旧版的问题不是"有按钮没绑"，而是"绑了但点了没反应"。
  // 所以判据要比"被取用过"更严：必须在 `addEventListener` 里出现过。
  const buttons = [...stripComments(html).matchAll(/<button[^>]*id="([A-Za-z0-9_-]+)"/g)].map(
    (m) => m[1] as string,
  );
  assert.ok(buttons.length >= 15, `按钮太少了（${buttons.length}）—— 是不是正则没跟上？`);
  const unhandled = buttons.filter((id) => !js.includes(`$('${id}').addEventListener`));
  assert.deepEqual(unhandled, [], `这些按钮没有 addEventListener：${unhandled.join(', ')}`);
});

test('⚠ 每个动作都走 `act(...)`（统一提示 + 失败可见 + 之后重画）', () => {
  // 旧版每个按钮各写一遍 try/catch + 提示 + 刷新，于是有的忘了刷新
  // （点了没反应）、有的错误只 console.log（用户看不见）。
  // `act()` 是那个统一包装 —— 绕开它的按钮会重新长出那些毛病。
  // ⚠ 要容忍换行：多数写法是 `(e) =>\n  act(...)`，用 `=> act(` 会只数到 1 个
  const viaAct = (js.match(/=>\s*act\(/g) ?? []).length;
  const listeners = (js.match(/\.addEventListener\('click'/g) ?? []).length;
  assert.ok(viaAct >= 12, `只有 ${viaAct} 个按钮走了 act()（共 ${listeners} 个 click 监听）`);
  // `act` 本身要保证"失败看得见"：catch 里必须 toast 且标红
  const body = js.slice(js.indexOf('async function act('), js.indexOf('async function act(') + 700);
  assert.ok(/catch \(e\)/.test(body), 'act 里没有 catch ⇒ 失败会静默');
  // ⚠ 别用 `toast\([^)]*true\)`：`toast(String(...), true)` 里那个 `)`
  //   会先把 `[^)]*` 截断，于是明明标红了也判成没标红。
  assert.ok(/, true\)/.test(body), 'act 的 catch 没标红 ⇒ 用户以为成功了');
  assert.ok(/await load\(\)/.test(body), 'act 之后没重画 ⇒ 用户看不到变化');
});

// ── ③ 样式没有孤儿 id ─────────────────────────────────────────────────

test('样式表里没有指向不存在 id 的孤儿规则（改名留下的死规则）', () => {
  const declared = idsIn(html);
  const dynamic = idsIn(js);
  // ⚠ 必须把**十六进制色值**排掉：`#fff` / `#0969da` 与 id 选择器长得一样，
  //   不排的话每一条颜色都会变成一条"孤儿 id"（第一版就是这样红的）。
  const isHex = (t: string) => /^[0-9a-fA-F]{3,8}$/.test(t) && /^[0-9a-fA-F]*[0-9a-fA-F]/.test(t);
  const idSelectors = [...css.matchAll(/#([A-Za-z0-9_-]+)/g)]
    .map((m) => m[1] as string)
    .filter((t) => !isHex(t));
  const orphan = [...new Set(idSelectors)].filter((id) => !declared.has(id) && !dynamic.has(id));
  assert.deepEqual(orphan, [], `样式里引用了不存在的 id：${orphan.join(', ')}`);
});

// ── ④ 读数只走一个接口 ────────────────────────────────────────────────

test('⚠ 读数**只走一个**聚合接口（一个区块一个接口会让用户不知道看哪个）', () => {
  assert.ok(js.includes("api('/readings')"), '读数的入口必须是 `/readings`');
  // 旧版那些「一个区块一个接口」的读数调用不许回来
  const banned = ['/api/live', '/api/matrix', '/api/exchange', '/api/groups', '/api/h5', '/caps'];
  for (const b of banned) {
    assert.ok(
      !js.includes(`api('${b}'`),
      `读数不许再直接调 \`${b}\` —— 它要么并进 /readings，要么是动作（用 write 的那种）`,
    );
  }
});

test('动作接口都是**写**（带 `x-panel: 1`），否则会被面板挡成 403', () => {
  // 面板的写路由要求这个头（防跨站请求伪造）。忘了的表现是 403 加一句
  // 「写接口要求请求头 x-panel: 1」—— 不是静默失败，但用户看不懂。
  const posts = [...js.matchAll(/method: 'POST'/g)].length;
  assert.ok(posts >= 6, `写动作太少了（${posts} 个）—— 是不是有按钮没接上？`);
  assert.ok(
    /if \(write\) headers\['x-panel'\] = '1'/.test(js),
    '`call()` 里要在 write 时补 `x-panel: 1`',
  );
});

// ── ⑤ 菜单栏与区块一一对应 ────────────────────────────────────────────

test('⚠ 菜单栏七块，与七个区块一一对应（少一块 = 用户点不到）', () => {
  const items = [...html.matchAll(/class="menu-item[^"]*" data-block="([a-z]+)"/g)].map(
    (m) => m[1] as string,
  );
  assert.deepEqual(
    items,
    ['account', 'daily', 'exchange', 'live', 'data', 'push', 'settings'],
    '菜单栏的顺序与名字就是用户看到的那七个词，别随手改',
  );
  for (const name of items) {
    assert.ok(html.includes(`id="block-${name}"`), `菜单里有「${name}」，但没有对应的区块`);
  }
  // 反向：不能有区块没进菜单（那等于藏起来了 —— 正是旧版「高级」开关的毛病）
  const blocks = [...html.matchAll(/class="block[^"]*" id="block-([a-z]+)"/g)].map(
    (m) => m[1] as string,
  );
  assert.deepEqual(blocks.sort(), items.slice().sort(), '有区块没进菜单（等于藏起来了）');
});

test('⚠ 没有「高级」开关（藏东西让人怀疑"是不是有更重要的没显示"）', () => {
  const h = stripComments(html);
  // ⚠ 判据是「**有没有那个开关**」，不是「有没有那个词」：
  //   「设置」页里有一句**用户可见的好句子** ——
  //   「所有口子都平铺在这里 —— 没有藏在「高级」里的东西」，
  //   它是用来打消疑虑的。断言"不许出现这个词"会把这句话也判红（第一版就是这样）。
  const buttonTexts = [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) =>
    (m[1] as string).trim(),
  );
  assert.ok(!buttonTexts.includes('高级'), `不许再有「高级」按钮，实际按钮：${buttonTexts.join(' / ')}`);
  assert.ok(!/adv-toggle/.test(h), '旧的 adv-toggle 按钮要删掉');
  // 也不许有 `hidden` 的整块被开关控制（藏东西的另一种写法）
  assert.ok(!/data-adv|toggle-adv/.test(h), '不许再有「高级」那种折叠开关');
});

test('⚠ 没有「推进一步」那种给面板用的按钮（任务是**一次跑完**的）', () => {
  const h = stripComments(html);
  for (const bad of ['推进一步', '走一步', '算一次', '现在探一次', '只验证']) {
    assert.ok(!h.includes(bad), `「${bad}」是给旧状态机用的按钮文案，用户看不懂也不该点`);
  }
  // 三个任务各只有一个「跑一次」语义的入口
  for (const id of ['daily-run', 'ex-run', 'live-run']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id}`);
  }
});

test('打开页面就画一次；**读数不许自动刷**（不然"我点了一下"和"它自己变了"分不清）', () => {
  assert.ok(/\nload\(\);\s*$/.test(js.trimEnd() + '\n'), '末尾要有一次 `load()`');

  // ⚠ 这条原来写的是"**禁止** `setInterval`"。但参考实现的扫码登录**就是**
  //   自动轮询的（`setInterval(pollOnce, 服务端给的 poll_interval_ms)`）——
  //   它要求用户在浏览器里点"我扫完了"是**不一致**的（确认动作在**手机上**）。
  //   所以真正的规则不是"不许有定时器"，而是这两条：
  //
  //     ① 定时器**不许刷读数**（那才会让"我点了一下"和"它自己变了"分不清）
  //     ② 定时器**必须能被清掉**（否则关掉弹窗之后它还在跑，一直打接口）
  //
  //   把规则换成这两条，是因为原来那条会把"照参考实现做"判成错 —— 而一条
  //   把正确做法判错的测试，最后只会被绕过。
  // ⚠ 要先**剥注释**：注释里写 `setInterval(pollOnce, …)` 说明参考实现怎么做的，
  //   那是文档不是代码 —— 不剥的话这条测试会被自己写的说明文案判红
  //   （第一次跑就是这么红的：起了 2 个定时器但只清了 1 个）。
  // ⚠ 用**按行**去注释，不用我上一版写的那个"逐字符、认字符串"的剥法 ——
  //   那个在某个字符串上卡住了（进了"字符串态"再没出来），于是后面所有 `//`
  //   注释都被当成代码，测试反而把注释里那句话算进了"定时器个数"。
  //   这里只去 `//` 行注释就够（要看的是 `setInterval` 调用，不在块注释里）。
  const code = js
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const timers = code.match(/setInterval\s*\([\s\S]{0,200}?\)\s*;/g) ?? [];
  for (const t of timers) {
    assert.ok(
      !/\bload\s*\(/.test(t),
      `定时器里不许刷读数（读数只在动作之后刷新）：${t.slice(0, 80)}`,
    );
  }

  // 每个 `setInterval` 都要有对应的 `clearInterval`（定时器不许泄漏）
  const started = (code.match(/setInterval\s*\(/g) ?? []).length;
  const cleared = (code.match(/clearInterval\s*\(/g) ?? []).length;
  assert.ok(
    cleared >= started,
    `起了 ${started} 个定时器但只清了 ${cleared} 个 —— 关掉弹窗后它还在跑`,
  );
});
