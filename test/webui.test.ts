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

test('⚠ 每个按钮要么有处理器，要么有**说清楚为什么点了没做**的提示', () => {
  // 旧版的问题不是"有按钮没绑"，而是"绑了但点了没反应"。
  // 这一版允许"还没做的功能"存在，但**必须说出来**（toast 一句明确的话），
  // 不许静默。
  const notYet = [...js.matchAll(/notYet\('([^']+)'\)/g)].map((m) => m[1] as string);
  assert.ok(notYet.length > 0, '还没有做的功能要用 `notYet(...)` 明说，而不是留个死按钮');
  // 提示里要说清是哪个阶段 —— 否则用户不知道"什么时候会有"。
  // ⚠ 阶段号在 `notYet` 的**定义**里（模板串中），不在每个调用点 ——
  //   所以查定义而不是查调用点（第一版查错了地方）。
  // 定义可能跨行，所以看定义那一行往后 3 行
  const lines = js.split('\n');
  const at = lines.findIndex((l) => l.includes('const notYet'));
  const def = at >= 0 ? lines.slice(at, at + 4).join(' ') : '';
  assert.ok(/②-3/.test(def), `notYet 的提示要说清阶段号：${def}`);
  for (const m of js.matchAll(/notYet\('([^']+)'\)/g)) {
    assert.ok(m[1], 'notYet 要有功能名');
  }
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

test('打开页面就画一次，而且**不自动轮询**（不然"我点了一下"和"它自己变了"分不清）', () => {
  assert.ok(/\nload\(\);\s*$/.test(js.trimEnd() + '\n'), '末尾要有一次 `load()`');
  assert.ok(!/setInterval\s*\(/.test(js), '不许自动轮询 —— 读数只在动作之后刷新');
});
