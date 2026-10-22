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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dir = new URL('../plugins/mcloud/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const js = readFileSync(new URL('app.js', dir), 'utf8');
const css = readFileSync(new URL('style.css', dir), 'utf8');

/** 读一份 src 下的源码（日志/触发这些事发生在后端那侧）。 */
const srcOf = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

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

test('数据页「刷新」强取，自动进页走缓存', () => {
  const js = srcOf('plugins/mcloud/app.js');
  assert.ok(/async function fetchBeans\(force = false\)/.test(js), 'fetchBeans 要能区分强刷');
  assert.ok(/refresh=1/.test(js), '刷新要带 refresh=1');
  assert.ok(/当前 \$\{esc\(bal\)\} 豆/.test(js), '每行要显示当前余额');
  assert.ok(/来自缓存/.test(js), '命中缓存要说明');
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

test('⚠ 页面用到的每个类都有定义（面板那份或自己那份）—— 删规则不留死角', (t) => {
  // 这条是第二十九轮（界面改用主面板的设计体系）补的。
  //
  // 为什么必须有一条：**删掉一条类规则比删掉一条 id 规则更危险**。
  // id 写错上面那条测试会红；类名写错/规则被删，浏览器**不报错、不白屏**，
  // 只是那一段变成"没有样式的裸内容" —— 而"界面看着乱七八糟"正是用户的原话。
  // 交接时最容易发生的正是这件事：别人把"和主面板重复的规则"清掉，
  // 而某个类面板**并没有**提供（比如面板只有 `.dialog`，没有 `.modal`）。
  //
  // 判据：页面上出现的每个类，要么在主面板的 `theme.css` / `components.css` 里，
  //       要么在自己的 `style.css` 里。两份都找不到 = 这个类渲染出来是裸的。
  const panelDir = new URL('../../rust-plugin-panel/web/css/', import.meta.url);
  let panel = '';
  try {
    panel = readFileSync(new URL('theme.css', panelDir), 'utf8') +
      readFileSync(new URL('components.css', panelDir), 'utf8');
  } catch {
    // 插件仓库要能**单独**测。面板仓库不在旁边时跳过这一条，而不是判红 ——
    // 判红的话，任何人克隆这一个仓库都会看到一条与他无关的失败。
    t.skip('旁边没有 rust-plugin-panel 仓库，跳过');
    return;
  }

  const used = new Set<string>();
  /** 把一段 class 串拆成类名。 */
  const addClasses = (raw: string) => {
    for (const c of raw.split(/\s+/)) {
      // ⚠ 模板串里的 `${…}` 要整个扔掉再拆：`class="card-title${x.disabled ? ' is-off' : ''}"`
      //   直接按空白拆得到的是一堆 `':'` / `"is-off'"` 这种碎片
      //   （第一次跑就是这么红的，五条"不存在的类"全是我自己的正则造出来的）。
      if (!c || c.includes('$') || /['"{}():]/.test(c)) continue;
      used.add(c);
    }
  };
  const collect = (text: string) => {
    // 注释里的类名不算：那是文档。`<!-- -->` 与 `/* */` 都剥掉。
    const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of body.matchAll(/class="([^"]+)"/g)) {
      addClasses((m[1] as string).replace(/\$\{[^}]*\}/g, ' '));
    }
    // `el('button', 'btn ghost')` / `classList.toggle('is-on', …)` 这类写法
    for (const m of body.matchAll(/el\('[a-z]+', '([^']+)'/g)) addClasses(m[1] as string);
    for (const m of body.matchAll(/classList\.(?:add|toggle|remove)\('([A-Za-z0-9_-]+)'/g)) {
      used.add(m[1] as string);
    }
    for (const m of body.matchAll(/className = '([^']+)'/g)) addClasses(m[1] as string);
  };
  collect(html);
  collect(js);

  const defines = (cls: string, text: string) =>
    new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}(?![\\w-])`).test(
      text.replace(/\/\*[\s\S]*?\*\//g, ''),
    );

  const missing = [...used].filter((c) => !defines(c, css) && !defines(c, panel)).sort();
  assert.ok(used.size > 40, `只找到 ${used.size} 个类 —— 是不是提取正则没跟上写法？`);
  assert.deepEqual(
    missing,
    [],
    `这些类在面板的 CSS 与本页的 CSS 里都没有定义（渲染出来是裸的）：${missing.join(', ')}`,
  );
});

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

test('⚠ 菜单栏五块，与五个区块一一对应（少一块 = 用户点不到）', () => {
  const items = [...html.matchAll(/class="menu-item[^"]*" data-block="([a-z]+)"/g)].map(
    (m) => m[1] as string,
  );
  // ⚠ 原来是七块：「设置」和「推送」都按用户要求删掉了。五个词就是用户看到的全部区块。
  assert.deepEqual(
    items,
    ['account', 'daily', 'exchange', 'live', 'data'],
    '菜单栏的顺序与名字就是用户看到的那五个词，别随手改',
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

test('⚠ 界面上没有「设置」页，也没有那六个地址口子（那是搭测试环境的东西）', () => {
  // 用户的原话：「彻底清空设置页面，这些 mock 内容压根不能交给用户使用，
  // 用户看不懂，还会导致一堆问题」。删的是**界面**；`/config` 那条路由还在
  // （e2e 靠它把基址指到 mock），只是不再从界面上暴露。
  const h = stripComments(html);
  for (const gone of ['block-settings', 'data-block="settings"']) {
    assert.ok(!h.includes(gone), `「${gone}」跟着设置页一起删了，别再加回来`);
  }
  // ⚠ 用 `id="cfg-` 这个前缀而不是逐个 id：设置页那一整族的 id 都是 `cfg-*`，
  //   漏一个就是漏一个口子。**别写成 `'cfg-save'`** —— 账号卡片那个弹窗里有
  //   `acct-cfg-save`，子串会撞上（第一版就是这么误报的）。
  assert.ok(!/id="cfg-/.test(h), '设置页那一族的 id（`cfg-*`）不该再出现在界面上');
  assert.ok(!/id="selftest-run"/.test(h), '「跑自检」是装机器的人看的，不该在用户界面上');
  // app.js 里也不许再引用那些 id（引用了 = 那段渲染静默不生效）
  assert.ok(!/\$\('cfg-/.test(js), 'app.js 还在取用 `cfg-*` 那些 id');
  assert.ok(!/\$\('selftest-/.test(js), 'app.js 还在取用自检那几个 id');
  // 「账号配置」那个跳设置页的按钮也得走 —— 留着就是个跳空的死按钮
  assert.ok(!h.includes('acct-config'), '「账号配置」跳的是设置页，它跟着一起删');
});

test('⚠ 没有「高级」开关（藏东西让人怀疑"是不是有更重要的没显示"）', () => {
  const h = stripComments(html);
  // ⚠ 判据是「**有没有那个开关**」，不是「有没有那个词」：
  //   （原来「设置」页里有一句用户可见的好句子——「所有口子都平铺在这里 ——
  //   没有藏在「高级」里的东西」——断言"不许出现这个词"会把那句话也判红；
  //   那一页现在整个删了，所以这里只剩"别让开关回来"这一半。）
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
  // 日常 / 直播各有一个「跑一次」入口；兑换的手动动作在清单行里（立即兑换），
  // 页面不再铺一颗干跑按钮。
  for (const id of ['daily-run', 'live-run']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id}`);
  }
  assert.ok(!html.includes('id="ex-run"'), '兑换页不再有干跑按钮');
});

test('⚠ 奖品清单旁边就有「读一次」（提示答应的事要在原地兑现）', () => {
  const h = stripComments(html);
  // 标题行的形状：`.row.between` 里左边是 `h3`、右边那颗按钮
  assert.ok(
    /<div class="row between">\s*<h3 class="h3">奖品清单<\/h3>\s*<button[^>]*id="ex-read"[^>]*>读一次<\/button>/s.test(h),
    '「奖品清单」那一行要带「读一次」',
  );
  // ⚠ 2026-10-17 换了绑法：这一颗不再走干跑，改成与上面「刷新清单」**同一枪**（只读清单）。
  //   原来绑 `tryExchange` 是因为那时**没有**只读清单的入口；现在有了（`/exchange/picks`），
  //   而干跑会把余额 / 预热 / 取题一起打出去 —— "看一眼清单"不该惊动整条链。
  assert.ok(
    /\$\('ex-read'\)\.addEventListener[\s\S]{0,160}refreshPicks/.test(js),
    'ex-read 要绑到 refreshPicks（只读清单那一枪）',
  );
  assert.ok(
    /api\('\/exchange\/picks', \{ method: 'POST', write: true \}\)/.test(js),
    'refreshPicks 要打进那条只读路由',
  );
  // 提示指的那颗按钮必须真是就地那颗
  assert.ok(/还没读到清单 —— 点旁边那颗「读一次」读一遍。/.test(js), '提示要指旁边那颗「读一次」');
  assert.ok(!/还没有清单读数 —— 点「现在试一次」/.test(js), '别再指那颗被日志挤出去的按钮');
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

// ── ⑥ 客户端形态只有**一个**入口，而且它是真的 ────────────────────────

test('⚠ 形态只有一个入口（设置页那个下拉框不许回来）', () => {
  // 这一条是用户报的：「点击这个不会切换二维码，是没必要吗」。
  // 查下来是**两个控件**：设置页的「登录时冒充的客户端」（真在生效）与
  // 添加账号弹窗的「客户端形态」（没接上）。同一件事两个控件 = 用户改了
  // 一个以为生效了 —— 所以设置页那个删掉，只留弹窗这一处。
  const h = stripComments(html);
  assert.ok(
    !h.includes('cfg-loginPlatform'),
    '设置页的「登录时冒充的客户端」删掉了，别再加回来（形态的入口是添加账号弹窗）',
  );
  // 弹窗那两个按钮还在，而且**两个都在**（少一个就是"只有 macOS 可选"）
  assert.ok(h.includes('id="add-win"') && h.includes('id="add-mac"'), '弹窗里的形态按钮缺了');
  // ⚠ 设置页**保存**时也不许再带这一格（带了就等于它还活着，只是没画出来）
  assert.ok(
    !js.includes("loginPlatform: $('cfg-loginPlatform')"),
    '保存设置时不许再发 loginPlatform —— 那一格已经不在页面上了',
  );
});

test('⚠ 形态真的进了请求（不是只改个高亮）', () => {
  // 判据要能"有牙"：出码与短信这两条**必须**把选择带上（后端据它冻进会话），
  // 账密与凭据那两条本来就在带。少一处 = 那一路静默用错形态。
  assert.ok(
    js.includes('body: { pcPlatform: addPc }'),
    '出码要带 `pcPlatform`（后端据它冻进会话、拼码里的 `ver`）',
  );
  assert.ok(
    /body: \{ phone, pcPlatform: addPc \}/.test(js),
    '短信开一趟也要带 `pcPlatform`（号码从输入框取，见 `requestCode`）',
  );
  assert.ok(js.includes('body.pcPlatform = addPc'), '贴凭据那一路要带 `pcPlatform`');
  assert.ok(/pcPlatform: addPc,/.test(js), '账密那一路要带 `pcPlatform`');
  // 换了形态要**作废进行中的会话**（码里的版本号与轮询请求体必须同一套档案）
  assert.ok(
    /function setAddPc\(v\)[\s\S]{0,900}?stopQrPoll\(\)/.test(js),
    '换形态要停掉进行中的轮询并作废会话，否则旧码配新档案',
  );
  assert.ok(
    /function syncAddPcFromReading\(\)/.test(js) && /syncAddPcFromReading\(\);/.test(js),
    '开弹窗时要跟读数对齐（进行中的会话优先），否则按钮与屏幕上的码不一致',
  );
});

// ── ⑦ 出码之后**真的去问上游**（F-067：这条链从来没跑过）──────────────

test('⚠ 出码之后必须开始轮询（`startQrPoll` 不许只定义不调用）', () => {
  // F-067 的现场：`startQrPoll` 定义了、注释里也写着"出码后 setInterval"，
  // 但**没有任何一处调用它** —— 于是出码之后面板从来不问上游，
  // 手机扫了、在手机上点了确认，这边永远不知道。用户的原话是「这二维码扫不了」。
  //
  // 这条测试的判据故意是**调用次数**而不是"有没有那个函数"：
  // 老代码里有函数、有注释、有一切，就是没有调用 —— 而那正是 bug 的全部。
  const calls = js.match(/startQrPoll\(/g) ?? [];
  assert.ok(
    calls.length >= 3,
    // 1 处是定义（`function startQrPoll(ms)`），其余必须是**调用**。
    // HEAD 上这个数是 1 —— 也就是说这条断言在改之前是红的。
    `\`startQrPoll\` 只出现 ${calls.length} 次（1 处定义 + 至少 2 处调用才对）`,
  );
  // ① 出码那一次：用服务端给的间隔（界面不许写死）
  assert.ok(
    /startQrPoll\(r\.pollMs\)/.test(js),
    '出码之后要用**服务端给的** `pollMs` 起轮询，不许自己写死一个数',
  );
  // ② 刷新 / 重开弹窗那一次：读数里那张码还活着就接着轮
  assert.ok(
    /function syncQrPoll\(qr\)[\s\S]{0,500}?startQrPoll\(qr\.pollMs\)/.test(js),
    '读数里还有一张活的码时要接着轮（刷新页面 / 面板重启之后）',
  );
  assert.ok(/syncQrPoll\(qr\);/.test(js), 'renderLogin 要调用 syncQrPoll');
  // ③ 间隔得从读数下来 —— 否则"接着轮"那一次没有间隔可用
  assert.ok(
    js.includes("api('/login/qr/poll'"),
    '轮询要打 `/login/qr/poll`',
  );
});

test('⚠ 轮询**没问成**要退一步（空响应不等于"码没了"）', () => {
  // F-070 现场：真机上移动云盘会连着回几个空体。2 秒一次地硬问，既把限流喂得更狠，
  // 也更容易错过"手机上确认成功"那一枪 —— 而那一枪只在一瞬间有效。
  assert.ok(/function backoffQrPoll\(base\)/.test(js), '缺退避');
  assert.ok(/function resetQrPoll\(base\)/.test(js), '缺"回到正常间隔"');
  assert.ok(/const QR_POLL_MAX_MS = 6000/.test(js), '退避要有上限（别退到用户以为卡死了）');
  assert.ok(/Math\.min\(\(qrPollMs \|\| base \|\| 2000\) \* 2/.test(js), '退避是"×2，最多 6 秒"');
  assert.ok(/if \(r\.retry\) \{/.test(js), '服务端说 retry 才退避');
  assert.ok(/if \(qrFailStreak === 1\) retryQrNow\(\)/.test(js), '第一次没问成要**立刻重问**（成功那一枪只有一次）');
  assert.ok(/else backoffQrPoll\(r\.pollMs\)/.test(js), '连着两次没问成才退一步');
  assert.ok(/qrFailStreak = 0;\n      resetQrPoll\(r\.pollMs\)/.test(js), '问成了要清零并回到服务端给的间隔');
  // ⚠ 退避只在"没问到"时发生：`stop` 那一支要**先 return**，别把退避也跑一遍
  assert.ok(
    /if \(r\.stop\) \{[\s\S]{0,400}?await load\(\);\n      return;\n    \}/.test(js),
    '`stop` 那一支要提前 return（否则停掉的轮询还会被重新起一个定时器）',
  );
});

test('⚠ 过期的码不许画得像还活着（"剩 0 秒"看起来完全像还能扫）', () => {
  assert.ok(
    /if \(qr\.expired\)[\s\S]{0,600}?二维码过期了/.test(js),
    '读数说这张码过期了 ⇒ 撤掉码 + 直说"点「生成二维码」重新出码"',
  );
  assert.ok(
    /if \(qr\.expired\)[\s\S]{0,300}?\$'?qr-box'?\)\.hidden = true/.test(js) ||
      /qr\.expired[\s\S]{0,300}?qr-box[\s\S]{0,80}?hidden = true/.test(js),
    '过期的码要从屏幕上撤掉，别留一张扫不出结果的图',
  );
});

test('⚠「手机端」页签下不出现「客户端形态」（那一路没有 win/mac 之分）', () => {
  // 用户的原话：「手机端哪来的 macOS 和 Windows」。
  // 形态是弹窗级的（扫码 / 短信 / 账密 / 凭据都按它来），但**手机端那一路走
  // App 自己的身份**，摆着那两个按钮不是信息、是噪音 —— 所以按页签收起来。
  assert.ok(
    html.includes('id="add-form"'),
    '形态那一块要有 id（`add-form`），否则没法按页签收起来',
  );
  assert.ok(
    /function showAddTab\(name\)[\s\S]{0,800}?\$\('add-form'\)\.hidden = name === 'app'/.test(js),
    '`showAddTab` 里要按页签收起形态那一块（app 页签收，其余四个放）',
  );
  // 手机端那一块自己也不许再"指上面"（上面已经没有那个选择了）
  const appPane = /data-pane="app"[\s\S]{0,700}?<\/p>/.exec(stripComments(html))?.[0] ?? '';
  assert.ok(
    !appPane.includes('上面那个形态'),
    '手机端那一块不该再说"上面那个形态选择"—— 那个页签下它已经不在了',
  );
});

test('⚠ 轮询回来那一行要**带倒计时**（不然第一次轮询之后倒计时就没了）', () => {
  // 画码时 `renderLogin` 拼的是「note · 剩 N 秒」，而轮询每 2 秒把那行重写一次 ——
  // 轮询那一侧不带倒计时的话，用户第一次看到的就是一句没有倒计时的提示，
  // 而"这张码还活着吗"全靠那一行（F-068）。
  assert.ok(/function qrNoteText\(r\)/.test(js), '缺 `qrNoteText`');
  assert.ok(
    /qrNoteText\(r\)[\s\S]{0,200}?expiresInMs/.test(js) ||
      /expiresInMs[\s\S]{0,200}?剩 \$\{Math\.ceil/.test(js),
    '`qrNoteText` 要用服务端给的 `expiresInMs` 拼出「· 剩 N 秒」',
  );
  assert.ok(/setText\('qr-note', qrNoteText\(r\)\)/.test(js), '轮询里要真的用它写那一行');
});

// ── ⑧ 手机号 / 验证码：**一屏**，排布照参考实现的登录页（F-069）────────

test('⚠ 一屏：手机号那格右端嵌着「获取验证码」，下面验证码，再下面整宽「登录」', () => {
  // 用户的原话：「设计下排布，可以搜索参考」——然后把**参考实现自己的登录页**
  // 截图发过来。那一页是一屏：
  //     手机号  [ 请输入手机号 | 获取验证码 ]
  //     验证码  [ 请输入验证码                ]
  //             [          登录              ]
  // 第一版我做成了"两步"（下一步 → 登录），照参考改成一屏：别让用户先点一次
  // 「下一步」才看到验证码那一格。
  for (const kind of ['sms', 'app']) {
    const from = html.indexOf(`data-pane="${kind}"`);
    const next = html.indexOf('data-pane=', from + 12);
    const pane = html.slice(from, next === -1 ? undefined : next);
    assert.ok(from !== -1, `找不到 ${kind} 这一块`);
    // 一屏：不再有"第 1 步 / 第 2 步"这种分块
    assert.ok(!pane.includes(`${kind}-step1`) && !pane.includes(`${kind}-step2`), `${kind} 不该再分两步`);
    assert.ok(!pane.includes(`${kind}-start`), `${kind} 不该再有「下一步」`);
    assert.ok(!pane.includes(`${kind}-change`), `${kind} 不该再有「改」（号码就在输入框里）`);
    // 手机号那一格：输入框 + 行内按钮**合成一格**
    assert.ok(
      new RegExp(`<div class="input-group">[\\s\\S]{0,400}?id="${kind}-phone"[\\s\\S]{0,400}?id="${kind}-send"`).test(pane),
      `${kind}：手机号那一格要包在 \`input-group\` 里，「获取验证码」在里面`,
    );
    assert.ok(pane.includes(`>获取验证码<`), `${kind}：行内按钮写「获取验证码」`);
    // 验证码那一格是独立一行（不再和按钮挤在一起）
    assert.ok(
      new RegExp(`id="${kind}-code"[^>]*placeholder="请输入验证码"`).test(pane),
      `${kind}：验证码输入框占满一行`,
    );
    // 唯一的整宽主按钮是「登录」
    assert.ok(new RegExp(`class="btn primary" id="${kind}-submit"`).test(pane), `${kind}-submit 要是主按钮`);
    assert.ok(pane.includes('>登录<'), `${kind}：主按钮写「登录」`);
    // 一行里不该再并排出现"输入框 + 两个动作"
    assert.ok(!/id="\w+-send"[^>]*>[\s\S]{0,80}?id="\w+-submit"/.test(pane), '发码与登录不许并排');
  }
  // 渲染：会话状态只影响那一行说明与按钮开关，不再切"步骤"
  assert.ok(/function paintCodePane\(kind, s\)/.test(js), '缺 `paintCodePane`');
  assert.ok(/paintCodePane\('sms', sms\)/.test(js) && /paintCodePane\('app', app\)/.test(js), 'renderLogin 要调用它');
  assert.ok(
    /paintCodePane\('sms', null\)/.test(js) && /paintCodePane\('app', null\)/.test(js),
    '没有会话时也要画一次（按钮开关要按当前输入算）',
  );
});

test('⚠ 「获取验证码」这一个按钮干两件事：先开会话再发码（用户看到的是一屏）', () => {
  // 参考实现是一屏，而这一侧的后端**要先有会话**才肯发码（`/login/sms/start`
  // 校验号码、并把形态冻进会话）——所以界面里把两步串起来，而不是让用户点两次。
  assert.ok(/async function requestCode\(kind\)/.test(js), '缺 `requestCode`');
  assert.ok(
    /function requestCode\(kind\)[\s\S]{0,700}?api\('\/login\/sms\/start'[\s\S]{0,300}?api\('\/login\/sms\/send'/.test(js),
    '短信那一路：start → send',
  );
  assert.ok(
    /function requestCode\(kind\)[\s\S]{0,900}?api\('\/login\/app\/start'[\s\S]{0,300}?api\('\/login\/app\/send'/.test(js),
    '手机端那一路：start → send',
  );
  assert.ok(/requestCode\('sms'\)/.test(js) && /requestCode\('app'\)/.test(js), '两条路都要走它');
  // 每次点都重新 start：形态可能刚被改过，"界面上的选择"必须就是这一趟用的档案
  assert.ok(/body: \{ phone, pcPlatform: addPc \}/.test(js), 'start 要带上当前形态');
});

test('⚠ 两个主按钮按**位数**开关，不是点了才报错', () => {
  assert.ok(/function gate\(btnId, value, need\)/.test(js), '缺 `gate`');
  // 手机号 11 位 ⇒ 放开「获取验证码」；验证码 6 位 ⇒ 放开「登录」
  assert.ok(/gate\(`\$\{kind\}-send`, phone\.value, 11\)/.test(js), '手机号满 11 位才放开「获取验证码」');
  assert.ok(/gate\(`\$\{kind\}-submit`, code\.value, 6\)/.test(js), '验证码满 6 位才放开「登录」');
  // 输入时只留数字、并重算开关
  assert.ok(/replace\(\/\\D\/g, ''\)/.test(js), '输入框要滤掉非数字');
  assert.ok(
    /wireCodeForm\('sms', \$\('sms-phone'\), \$\('sms-code'\)\)/.test(js) &&
      /wireCodeForm\('app', \$\('app-phone'\), \$\('app-code'\)\)/.test(js),
    '两个页签都要接上（输入框当参数传，界面测试按字面 id 查）',
  );
  // 回车等于点那个主按钮（手机上少一次瞄准）
  assert.ok(/ev\.key === 'Enter'/.test(js), '回车要能提交');
  // 但**不许自动提交**：填满 6 位只把焦点交给「登录」
  assert.ok(!/length === 6\)[^;]*\.click\(\)/.test(js), '填满 6 位不许自动提交（点了才算）');
});

test('⚠ 发码之后要进重发倒计时（连点只会喂限流）', () => {
  assert.ok(/function startResend\(kind/.test(js) && /function stopResend\(kind/.test(js), '缺重发倒计时');
  assert.ok(/startResend\('sms'\)/.test(js) && /startResend\('app'\)/.test(js), '两条路发码成功后都要起倒计时');
  assert.ok(/重新获取（\$\{left\} 秒）/.test(js), '倒计时里按钮上要写还剩几秒');
  // ⚠ 倒计时接管按钮之后，`act` 与 `gate` 都**不许**碰它 ——
  //   否则会出现"按钮写着「获取验证码」、其实是可点的"的窗口（连点正是要防的）。
  assert.ok(/btn\.dataset\.resend = '1'/.test(js), '倒计时要标记按钮已被接管');
  assert.ok(
    /dataset\.resend !== '1'[\s\S]{0,120}?btn\.disabled = false/.test(js),
    '`act` 的收尾要跳过被倒计时接管的按钮',
  );
  assert.ok(
    /if \(!owned\) btn\.textContent = '…'/.test(js),
    '`act` 对已接管的按钮连"转圈"都不该画（会闪一下）',
  );
  assert.ok(
    /function gate\(btnId, value, need\)[\s\S]{0,400}?dataset\.resend !== '1'/.test(js),
    '`gate` 也要跳过它 —— 每次动作后的 `load()` 都会重画一次按钮',
  );
  assert.ok(/function stopResend\(kind\)[\s\S]{0,400}?delete btn\.dataset\.resend/.test(js), '停掉时要摘掉标记');
});

test('⚠ 验证码框要用 `one-time-code`（别写成 off）', () => {
  // MDN：短信 / 邮件 / 验证器来的 OTP 就用这个值，系统会把收到的码直接填进来。
  for (const kind of ['sms', 'app']) {
    assert.ok(
      new RegExp(`id="${kind}-code"[^>]*autocomplete="one-time-code"`).test(html),
      `${kind} 的验证码框要带 autocomplete="one-time-code"`,
    );
    assert.ok(
      new RegExp(`id="${kind}-code"[^>]*inputmode="numeric"`).test(html),
      `${kind} 的验证码框要弹数字键盘`,
    );
  }
  assert.ok(!/autocomplete="off"/.test(html), '别把自动填充关掉（MDN 那条明确不建议）');
});

test('⚠ 说明文字里的号码要打码（它会一直留在屏幕上）', () => {
  assert.ok(/function maskPhone\(p\)/.test(js), '缺 `maskPhone`');
  assert.ok(/\*\*\*\*/.test(js), '要打码成 `138****0000` 那种');
  assert.ok(/验证码已发到 \$\{maskPhone\(s\.phone\)\}/.test(js), '那一行说明要用它');
  // 两条路同构：短信与手机端同一套结构（它们本来就是同一条流程的两套身份）
  for (const suffix of ['phone', 'code', 'send', 'submit', 'note']) {
    assert.ok(html.includes(`id="sms-${suffix}"`) && html.includes(`id="app-${suffix}"`), `两条路都要有 ${suffix}`);
  }
});

test('⚠ 界面里**不许再有滑块图**（坐标是解出来的，摆图等于要人眼看像素）', () => {
  // 用户的原话：「手机号登录需要滑块，你这是让我肉眼看像素吗」。
  // 参考实现是协议优先：自动取题 → 解坐标 → 带答案重发，人只负责等短信。
  for (const id of ['slider-box', 'slider-bg', 'slider-note', 'app-slider-box', 'app-slider-bg', 'app-slider-note']) {
    assert.ok(!html.includes(`id="${id}"`), `界面里还有 #${id}`);
  }
  assert.ok(!/needSlider/.test(js), '界面这一层不该再处理"要滑块"这个中间态（后端自己过）');
  // 发码只有两个结局：`sent` 或者一句人话
  assert.ok(/if \(r\.sent\) \{[\s\S]{0,200}?throw new Error\(r\.note/.test(js), '发码那一路要收成"成了/没成"两种');
});

test('⚠ 登录成功之后弹窗要**自己关掉**（四条进账号的路都要）', () => {
  // 用户的原话：「登录成功弹窗不自动关闭」。原来只有扫码与贴凭据顺手关了，
  // 短信与手机端登进去之后弹窗还杵在那儿 —— 用户只能自己点「关闭」。
  assert.ok(/function closeAddDialog\(\)/.test(js), '缺统一的收尾函数');
  // 四条路都走它：短信提交、手机端提交、贴凭据、扫码成功
  const calls = js.match(/closeAddDialog\(\);/g) ?? [];
  assert.ok(calls.length >= 4, `只有 ${calls.length} 处收尾（四条进账号的路都要）`);
  // 短信那条：成功分支里必须有关弹窗
  assert.ok(
    /if \(r\.account\) \{\n\s+\/\/ ⚠ 先关弹窗再提示[\s\S]{0,120}?closeAddDialog\(\);/.test(js),
    '短信登录成功要关弹窗',
  );
  // 手机端那条：同上
  assert.ok(
    /if \(r\.account\) \{\n\s+closeAddDialog\(\);/.test(js),
    '手机端登录成功要关弹窗',
  );
  // 收尾要**顺手停掉定时器**（弹窗看不见了还在问接口是最难查的一类问题）
  assert.ok(
    /function closeAddDialog\(\)[\s\S]{0,400}?stopQrPoll\(\)[\s\S]{0,200}?stopResend\('sms'\)[\s\S]{0,200}?stopResend\('app'\)/.test(js),
    '收尾要停掉轮询与两个倒计时',
  );
  // 验证码要清掉（它属于刚才那一趟会话）
  assert.ok(
    /function closeAddDialog\(\)[\s\S]{0,600}?\['sms-code', 'app-code'\]/.test(js),
    '收尾要清掉两个验证码框',
  );
});

test('⚠ 提示里不许有黑话（这是给用户看的）', () => {
  // 用户的原话：「不要提示黑话啊，这是给用户看的，一堆用户看不懂的话」。
  // 上一版那句是：「凭据已续期（旧尾 7eyts- → 新尾 OFDUM-；上游说还能用 2592000 秒
  // （这一枪没带用户域 —— 上游不要求），新过期还剩 30 天）—— 已重起一轮换票…」
  // ⚠ 只看**用户能看到的字符串**：注释里写「上游」是给读代码的人看的，不算。
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const jargon = ['旧尾', '新尾', '用户域', '换票', '上游', 'jwttoken', 'userDomainId', 'refreshToken'];
  for (const w of jargon) {
    assert.ok(!code.includes(w), `界面代码里还有黑话「${w}」`);
  }
  // 卡片上那句话也说人话
  assert.ok(/\$\{x\.expireDays\} 天后过期/.test(js), '卡片要写"N 天后过期"');
  assert.ok(!/凭据 \$\{x\.expireDays\} 天后/.test(js), '别再写"凭据 N 天后"');
});

test('⚠ 运行日志是**终端样式**，接的是面板的日志流（SSE）', () => {
  // 用户的原话：「先把日志接过来，终端样式的运行日志」。
  // 数据源是面板自己的 `/api/logs/stream`（插件里每句 log 都在那儿），
  // 不是插件那套"一次一条"的运行记录 —— 那个适合列表，不适合"看着它跑"。
  for (const key of ['daily', 'exchange', 'live']) {
    assert.ok(html.includes(`id="${key}-term"`), `缺 ${key} 的终端面板`);
    assert.ok(html.includes(`id="${key}-term-body"`), `缺 ${key} 的终端输出区`);
    assert.ok(html.includes(`id="${key}-term-follow"`), `缺 ${key} 的「跟随」开关`);
    assert.ok(html.includes(`id="${key}-term-level"`), `缺 ${key} 的级别选择`);
  }
  // 三个插件名要对（面板日志按插件过滤）
  assert.ok(/plugin: 'mcloud-daily'/.test(js), '日常要连 mcloud-daily 的日志');
  assert.ok(/plugin: 'mcloud-exchange'/.test(js), '兑换要连 mcloud-exchange');
  assert.ok(/plugin: 'mcloud-live'/.test(js), '直播要连 mcloud-live');
  // 连的是面板那条流，且带 channel/plugin/level
  assert.ok(/new EventSource\('\/api\/logs\/stream\?'/.test(js), '要用面板的日志流');
  assert.ok(/channel: 'plugin'/.test(js), '只看插件通道');
  // 只在**这一块显示时**才连（三块各连一条流没必要，同域 SSE 还有并发上限）
  assert.ok(/function syncTerms\(/.test(js), '缺开关函数');
  assert.ok(/showBlock[\s\S]{0,800}?syncTerms\(name\)/.test(js), '切块时要开关日志流');
  // 行数有上限，且日志一律走 textContent（里面有用户可控字符串）
  assert.ok(/TERM_MAX_LINES/.test(js), '行数要封顶');
  assert.ok(/msg\.textContent = String\(d\.msg/.test(js), '日志文本要用 textContent 画');
  assert.ok(!/innerHTML[^\n]*d\.msg/.test(js), '不许把日志塞进 innerHTML');
  // 换级别要重连（过滤在服务端）：处理器是字面量，重连逻辑在 `reload()` 里
  assert.ok(/\$\('daily-term-level'\)\.addEventListener\('change', \(\) => termHandle\('daily'\)\.reload\(\)\)/.test(js),
    '换级别要重连（daily）');
  assert.ok(/function reload\(\)[\s\S]{0,200}?close\(\)[\s\S]{0,200}?open\(\)/.test(js), 'reload 要真的重连');
});

test('⚠ 「最近几次」那一整块**没有了**（用户看不懂那串"未登录：state 里没有会话"）', () => {
  // 用户的原话：「这一块没必要了，用户看不懂」。它列的是每步的原始结果，
  // 而那正是"看着它跑"该由**日志**回答的事。
  for (const id of ['daily-recent', 'daily-steps', 'daily-when', 'ex-recent', 'ex-steps', 'live-recent', 'live-steps']) {
    assert.ok(!html.includes(`id="${id}"`), `界面里还有 #${id}`);
  }
  assert.ok(!/最近几次/.test(html), '标题也要删');
  assert.ok(!/renderRecent/.test(js), '画它的函数也该删（留着就是死代码）');
});

test('⚠ 第二行那句"它自己什么时候跑"来自**面板的任务表**，不是写死的文案', () => {
  // 原来是写死的「白天每 30 分钟跑一次」，而排期早改成 `0 8,20 * * *` ——
  // 用户看到的就是一句错话。
  assert.ok(/fetch\('\/api\/state'/.test(js), '要读面板的任务表');
  assert.ok(/function jobOf\(plugin, name\)/.test(js), '缺按插件+任务名找 job');
  assert.ok(/function scheduleText\(job\)/.test(js), '缺"排期说人话"');
  // 一天两次那种要说得出来
  assert.ok(/每天 \$\{hours\} 各跑一次/.test(js), '`0 8,20 * * *` 要说成"每天 8:00、20:00 各跑一次"');
  // 认不出的形状**不许编**：说"按面板里设的时间跑"
  assert.ok(/按面板里设的时间跑/.test(js), '认不出的排期要老实说');
  // 而且它要跟着读数一起拉
  assert.ok(/Promise\.all\(\[api\('\/readings'\), loadJobs\(\)\]\)/.test(js), 'loadJobs 要跟读数一起拉');
});

test('⚠ 界面上**没有**「连接」这种按钮（参考实现里换票是任务自己做的事）', () => {
  // 用户看到红字「未登录：state 里没有会话」时，我第一版在账号卡上加了个「连接」——
  // 用户的原话：「这个连接是什么鬼，看看 mcloud」。参考实现里没有这一步：
  // 换票（拿网页会话）是**任务自己**在跑之前做的。
  assert.ok(!/data-acc-connect/.test(js), '账号卡上不许有「连接」');
  assert.ok(!/点「连接」/.test(js), '文案里不许让人去点一个不存在的按钮');
  assert.ok(!/howto-session/.test(js), '界面里不许出现 docs 路径');
});

test('⚠ 任务自己**开一轮**换票（`runExchangeStep` 只接着走，不会开始）', () => {
  const daily = srcOf('src/entries/daily.ts') + srcOf('src/mcloud/dailyRun.ts');
  // ⚠ 两种情况都要开新的：没有那一轮（`null`）、上一轮已经 `done`（票过期要再换）
  // ⚠ 必须用**这一趟这个账号**的 store（多账号下模块级那份会读到别的号的票 —— F-095）
  assert.ok(/const st = loadExchange\(deps\.store, page\);/.test(daily), '先看那一轮的状态（按账号）');
  assert.ok(/startExchange\(deps\.store, loadAuthRaw\(deps\.store\)/.test(daily), '开新一轮也要按账号');
  assert.ok(/if \(needExchange\(deps\.store, Date\.now\(\), page\)\)/.test(daily), '判据也按账号');
  assert.ok(!/needExchange\(store, Date\.now\(\)/.test(daily), '不许再用模块级 store');
  assert.ok(/if \(st === null \|\| st\.step === 'done'\) \{/.test(daily), 'null 与 done 都要开新的');
  assert.ok(/startExchange\(deps\.store, loadAuthRaw\(deps\.store\), deps\.nowIso, page\)/.test(daily), '开一轮要用**这个账号**的凭据');
  assert.ok(!/startExchange\(store, /.test(daily), '不许再用模块级 store 开票');
});

test('⚠ 日志一行一步，形状照参考实现（成功 / 跳过 / 失败 + 原因）', () => {
  const daily = srcOf('src/entries/daily.ts') + srcOf('src/mcloud/dailyRun.ts');
  // `mcloud-sign` 的 logger 有 start/success/fail 三种类型，控制台打 `[success] … 成功 签到`
  // 一行一个用户认得的任务，结论只有三种说法（`tasks/stepLog.ts::userLine`）
  assert.ok(/const line = userLine\(one\);/.test(daily), '日志行走 userLine');
  const stepLog2 = srcOf('src/mcloud/tasks/stepLog.ts');
  assert.ok(/if \(!step\.ok\) return `\$\{step\.name\}：没成\$\{why === '' \? '' : ` —— \$\{why\}`\}`;/.test(stepLog2), '没成要带原因');
  assert.ok(/return `\$\{step\.name\}：\$\{why === '' \? '好了' : why\}`;/.test(stepLog2), '成了也把"发生了什么"说出来，不写"成了"');

  // 两个小工具在共享模块里（三块任务页都用同一套，别各写一份）
  const stepLog = srcOf('src/mcloud/tasks/stepLog.ts');
  assert.ok(/export function stepCap\(note: string\): boolean/.test(stepLog), '「走到第 N 步就停了」不是成功');
  // ⚠ 三种写法都认：改文案那天起只认一种的话，「还有没做完的」会静默变回「成了」
  assert.ok(/note\.includes\('步数上限'\)/.test(stepLog), '旧记录写法一');
  assert.ok(/走到第 \\d\+ 步就停了/.test(stepLog), '旧记录写法二');
  assert.ok(/note\.includes\('还有没做完的'\)/.test(stepLog), '现在的写法');
  assert.ok(/export function trimNote\(name: string, note: string\): string/.test(stepLog), '要剥掉重复的"步骤名："');
  assert.ok(/服务端说：\$\{msg\}/.test(stepLog), '`code=500 msg=…` 要说人话');
  assert.ok(/from '\.\.\/mcloud\/tasks\/stepLog\.ts'/.test(daily), '日常要用共享的那两个');
  assert.ok(/from '\.\.\/mcloud\/tasks\/stepLog\.ts'/.test(srcOf('src/entries/live.ts')), '直播也要用同一套');
  assert.ok(/const line = userLine\(one\);/.test(daily), '格式由 `userLine` 决定：`签到：网盘签到成功` / `复活卡：没成 —— 原因`');
  // 段头 / 段尾：照 mcloud-sign，用 start/success/fail 着色，不再画 `------【】------`
  // 段头/段尾都走 `logBoth`（面板日志流 + 重启后还在的环，见 F-085）
  assert.ok(/const tag = `\[\$\{shortLabel\(who\)\}\]`;/.test(daily), '账号前缀要用短名');
  assert.ok(/logBoth\(store, 'start', tag, nowIso\)/.test(daily), '缺段头');
  assert.ok(/const tail =\s*bad === 0/.test(daily), '缺段尾');
  assert.ok(/logBoth\(store, hard > 0 \? 'warn' : 'debug', `\$\{tag\} \$\{tail\}`, nowIso\)/.test(daily), '段尾也要进两个去处');
  assert.ok(/项没成/.test(daily), '段尾说"几项没成"');
  // 旧写法（同一件事说两遍 + 那一长串名字）不许回来
  assert.ok(!/步失败：/.test(daily), '`11/16 步失败：签到、领取AI豆、…` 那种汇总行不要了');
  assert.ok(!/`  · \$\{line\}`/.test(daily), '`  · ` 那种缩进行不要了');
});


test('⚠ 「跑一次」要**等它真跑完**再说结果（面板那个接口只是"交给它了"）', () => {
  // 原来的写法是 `act(btn, () => runTask('daily'), '跑完了 —— 看下面的每一步')`：
  // 触发接口是异步的，它回 `{ok:true}` 只表示"收下了"，任务还要跑几十秒 ——
  // 于是用户看到"跑完了"、读数却还是上一次的。
  assert.ok(/async function runTaskAndWait\(key, btn\)/.test(js), '缺"触发并等完"');
  assert.ok(/async function waitRun\(/.test(js), '缺"等这一次跑完"');
  assert.ok(/\/api\/runs\?plugin=/.test(js), '判据要看面板的运行记录');
  assert.ok(/if \(!one \|\| !one\.finished_at\) return null;/.test(js), '没有 finished_at 就是没跑完');
  assert.ok(/Date\.parse\(String\(one\.started_at\)\.replace\(' ', 'T'\)\) < sinceMs/.test(js),
    '只认**这一次**（上一次的记录会立刻被当成"完成"）');
  // 按钮上写秒数 = 证明它还活着
  assert.ok(/btn\.textContent = `跑着呢 \$\{Math\.round\(ms \/ 1000\)\}s`/.test(js), '按钮要说"跑着呢 N 秒"');
  // 三个入口都用它：日常 / 直播 / 贴口令
  assert.ok(/\$\('daily-run'\)\.addEventListener\('click', \(e\) => runTaskAndWait\('daily'/.test(js), '日常要等');
  assert.ok(/\$\('live-run'\)\.addEventListener\('click', \(e\) => runTaskAndWait\('live'/.test(js), '直播要等');
  assert.ok(/await waitRun\('mcloud-live', '直播', t0, null\)/.test(js), '贴口令那条也要等');
  // 超时**不许**假装成功
  assert.ok(/if \(one === null\) \{\n\s+toast\('还没跑完/.test(js), '超时要老实说没跑完');
});

test('⚠ 跑的时候有「停止」，且触发请求不能挡住按钮状态', () => {
  const js = srcOf('plugins/mcloud/app.js');
  const html = srcOf('plugins/mcloud/index.html');
  for (const id of ['daily-stop', 'live-stop']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id}`);
    assert.ok(js.includes(`$('${id}').addEventListener`), `${id} 没挂处理器`);
  }
  assert.ok(/async function stopRunning\(/.test(js), '缺 stopRunning');
  assert.ok(/\/stop`/.test(js), '要调面板的 stop 路由');
  const start = js.indexOf('async function runTaskAndWait(');
  const body = js.slice(start, js.indexOf('async function stopRunning(', start));
  assert.ok(/run\?async=1/.test(body), '触发要走进队模式，不能等任务跑完');
  assert.ok(/stopBtn\.hidden = false;/.test(body), '跑起来要显示停止按钮');
});

test('⚠ 每个号一个 chip，点开看那一次的每一步（三块任务页都有）', () => {
  // 用户要的是"哪个号成了"一眼看到 —— 而不是去翻日志或那一长串步骤表。
  for (const [box, detail] of [
    ['daily-accounts', 'daily-account-detail'],
    ['exchange-accounts', 'exchange-account-detail'],
    ['live-accounts', 'live-account-detail'],
  ]) {
    assert.ok(html.includes(`id="${box}"`), `缺 #${box}`);
    assert.ok(html.includes(`id="${detail}"`), `缺 #${detail}`);
  }
  // 同一次触发的几条按 `at` 归组（id 里带账号，各不相同）
  assert.ok(/const runAt = list\[0\]\.at;/.test(js), '按触发时刻归组');
  assert.ok(/list\.filter\(\(x\) => x\.at === runAt\)/.test(js), '只画这一次的');
  // 名字用记录里的 `who`，不靠 note 猜
  assert.ok(/const who = one\.who \|\|/.test(js), '要用记录里的 who');
  // 明细点开才拉
  assert.ok(/api\('\/runs\?id=' \+ encodeURIComponent\(runId\)\)/.test(js), '点开才拉那一次的步骤');
  assert.ok(/sort\(\(a, b\) => Number\(a\.ok\) - Number\(b\.ok\)\)/.test(js), '失败的要排前面');
  // 一行一个**用户认得的任务**，说的是**发生了什么**（不写"成了/成功"这种抽象词）
  assert.ok(/function stepLine\(step\)/.test(js), '缺 stepLine');
  assert.ok(/if \(!step\.ok\) return `\$\{name\}：没成/.test(js), '没成要带原因');
  assert.ok(/return `\$\{name\}：\$\{why === '' \? '好了' : why\}`;/.test(js), '成了也说"发生了什么"');
  // ⚠ 到步数上限也报「成了」：那是内部预算，而且"刚好做完"和"到上限"在这一步分不出
  assert.ok(!/还有没做完的/.test(js), '不许对用户说"还有没做完的"（可能是假话）');
  assert.ok(!/步数上限/.test(js), '不许把步数漏到界面上');
  // 管道步骤由后端标 `plumb`（界面不许自己维护名字表 —— 那本身就是黑话漏进界面）
  assert.ok(/if \(step\.plumb === true && step\.ok\) return null;/.test(js), '管道步骤成功时不出现');
  assert.ok(!/换票/.test(js), '界面代码里不许出现「换票」这种词');
});

test('定时弹窗：cron / 提前秒数 / 截止时间 / 每号次数', () => {
  for (const id of ['ex-plan-cron', 'ex-plan-until', 'ex-plan-lead-sec', 'ex-plan-max', 'ex-plan-account']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id}`);
  }
  // 保存时要把这些一起交给后端；只写目标的话，界面上调了也不生效。
  for (const k of ['cron', 'until', 'maxRuns', 'leadSec', 'prizeId', 'prizeName', 'accountId']) {
    // 保存体是多行对象；从 `action: 'save'` 往后找这个字段即可。
    assert.ok(new RegExp(`action: 'save',[\\s\\S]*?${k}`).test(js), `保存没带 ${k}`);
  }
  // 一天多个整点：cron 的占位/说明要出现，不能又退回单个“几点”下拉。
  assert.ok(/0 10,20 \* \* \*/.test(html), '要给出多整点示例');
  assert.ok(!/id="ex-plan-hour"/.test(html), '不再有单独的“每天几点”输入');
  assert.ok(/提前 \$\{leadSec\}s 启动/.test(js), '预览要写提前秒数');
});

test('⚠ 定时抢兑由弹窗负责，页面上不再铺一块定时设置', () => {
  // 入口在清单/关注行的「定时」；弹窗里有时刻、提前量和实时预览。
  assert.ok(/id="ex-plan-dialog"/.test(html), '缺定时弹窗');
  assert.ok(/function openPlanDialog\(/.test(js), '缺打开弹窗');
  assert.ok(/function updatePlanPreview\(/.test(js), '缺排期预览');
  assert.ok(!/id="ex-plan-open"/.test(html), '页面上不再有「设置定时」区块');
  // 时长要进位：`1278 分 34 秒` 没人算得出那是多久
  assert.ok(/return m === 0 \? `\$\{h\} 小时` : `\$\{h\} 小时 \$\{m\} 分`;/.test(js), '超过一小时要进位');
});

test('⚠ 运行日志重启后还在（面板的内存环重启就空，插件自己留一份）', () => {
  // 用户的原话：「你每次重启后运行日志里的旧记录就没了」。
  // 面板的 SSE 底子是内存环；插件这一侧把同样的行写进 state（SQLite），重启照旧在。
  assert.ok(/path: `\$\{base\}\/log\/tail`/.test(srcOf('src/mcloud/routes.ts')), '缺 /log/tail');
  assert.ok(/export function appendRing\(/.test(srcOf('src/mcloud/logRing.ts')), '缺环形副本');
  assert.ok(/export const RING_MAX = 400;/.test(srcOf('src/mcloud/logRing.ts')), '要有上限');
  assert.ok(/'mcloud\.log\.ring': 'global'/.test(srcOf('src/store/keys.ts')), '环是全局的（不属于某个号）');
  assert.ok(/export function logBoth\(/.test(srcOf('src/mcloud/log.ts')), '两个去处要收在一处');
  // 三块任务页都走 logBoth
  for (const f of ['src/entries/daily.ts', 'src/entries/exchange.ts', 'src/entries/live.ts']) {
    assert.ok(/logBoth\(store,/.test(srcOf(f)), `${f} 还没走 logBoth`);
  }
  // 界面：**先连实时流，再异步补历史**。`/log/tail` 是插件路由，任务在跑时
  // 会排队到任务结束；等它回来才 connect 就是"日志要等任务跑完才出现"。
  assert.ok(/async function seed\(\)/.test(js), '缺"铺历史"');
  assert.ok(/connect\(q\);\s*void seed\(\);/.test(js), '顺序必须是先实时后历史');
  assert.ok(/if \(shown > 0\) return;/.test(js), '历史回来时实时已有行就不许清屏');
  assert.ok(/上面是上次留下的，下面是新的/.test(js), '要标出"这里是分界"');
  // ⚠ 分界线不能用 `.term-empty`：`paint()` 每画一行都会把它删掉
  assert.ok(/gap\.className = 'term-gap';/.test(js), '分界线要自己的类');
  // 环里存 ISO，面板给的是本地时间 —— 两边都要能显示对
  assert.ok(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(js), '两种时间形状都要吃');
});

test('⚠ 级别下拉对**历史**也生效（原来只管实时流：选「只看错误」下面照样一排 info）', () => {
  // 用户圈的正是这个自相矛盾：页头写「只显示「只看错误」」，行里全是 `info`。
  // 根因：`level` 是发给服务端的参数，而服务端只滤**实时流**；
  // 历史是本地从 `/log/tail` 铺的，不经那道闸 ⇒ 必须在 `seed()` 里自己滤。
  assert.ok(/function levelPasses\(lv\)/.test(js), '缺"这一行过不过门槛"的判断');
  assert.ok(/if \(!levelPasses\(one\.l\)\) continue;/.test(js), '铺历史时要按级别跳过');
  // 顺序：先判门槛再画（不是画完再删 —— 那样分界线/计数都会算错）
  const seed = js.slice(js.indexOf('async function seed()'), js.indexOf('function open()'));
  assert.ok(
    seed.indexOf('levelPasses') < seed.indexOf('paint({ data:'),
    '门槛要在 paint 之前',
  );
  // 一行都没滤出来别写"上面是上次留下的"，也**别留白屏**（F-091 那张截图）
  assert.ok(/没有过这道门槛的/.test(js), '历史被滤空时要说清为什么');
  // 认不出的级别当最低档，不猜它是高的
  assert.ok(/LEVEL_RANK\[lv\] \?\? 0/.test(js), '未知级别要按最低档');
});

test('⚠ 页头那个数报**屏上摆了几行**，不再报服务端环（用户：「按筛选结果更新缓冲数一起改了吧」）', () => {
  // 原来那句是 `mcloud-live · 缓冲 15 行 · 只显示「只看错误」` —— 筛到屏上只剩 6 行，
  // 页头还报环里的全量。同一句话里"只显示 X"和"缓冲 15"自己打自己。
  assert.ok(/function setMeta\(tail\)/.test(js), '页头那句要有一个统一的出处');
  assert.ok(/显示 \$\{shown\} 行/.test(js), '那句要报屏上的行数');
  assert.ok(!/缓冲 \$\{/.test(js), '「缓冲 ${…}」那口径不许回来');
  // `shown` 只数 `.term-line`（分界线与空态那句不算）
  assert.ok(/el\.className = `term-line term-line-\$\{lv\}`/.test(js), '每行都带 .term-line');
  assert.ok(
    /if \(cut\.classList\.contains\('term-line'\)\) shown -= 1;/.test(js),
    '超 400 行从上面砍时，屏上的数要跟着减（否则页头会越报越多）',
  );
  // 环的数字只在**真丢了东西**时出场 —— 那才是"日志少了一段"需要的解释
  assert.ok(/p\.dropped \? `环里淘汰了 \$\{p\.dropped\} 行` : '已连上'/.test(js), '环的口径只留淘汰数');
  // 换筛选/清空/重铺历史都要归零，不然数是上一道的
  for (const fn of ['async function seed()', 'function clearNow()', 'function reload()']) {
    const body = js.slice(js.indexOf(fn), js.indexOf(fn) + 900);
    assert.ok(/shown = 0;/.test(body), `${fn} 里要把屏上的行数归零`);
  }
  // 每画一行都会调 setMeta ⇒ 文本没变就别碰 DOM
  assert.ok(/if \(meta\.textContent !== text\) meta\.textContent = text;/.test(js), '写之前要比一下');
});

test('⚠ 直播页第一行说"在听什么"，不是"池子里有几条口令"', () => {
  // 用户的原话：这两件事接不上。顺序必须是：正在听 > 下一场几点 > 还没探到。
  assert.ok(/const listening = !!\(l\.listen && l\.listen\.reading && l\.listen\.reading\.step === 'listen'\)/.test(js), '先判在不在听');
  assert.ok(/listening \? `正在听/.test(js), '在听就说在听');
  assert.ok(/next \? `下一场 \$\{next\}` : '还没探到下一场'/.test(js), '没在听就说下一场');
  assert.ok(!/setText\('live-hero', valid > 0/.test(js), '第一行不许是口令条数');
  // 口令条数降级到第二行，并且说清"要人贴"
  // 口令条数**不在**第二行（那是口令池那一块的属性）
  assert.ok(!/手里有 \$\{valid\} 条口令能用/.test(js), '第二行不报口令条数');
  assert.ok(/const poolHead = valid > 0 \? `手里有 \$\{valid\} 条能用的口令` : '还没有能用的口令';/.test(js), '条数挪到口令池那行');
  // 第二行说"在不在听 + 为什么"
  assert.ok(/现在没在听：\$\{why\}/.test(js), '要带原因');
  assert.ok(/谁都没开播/.test(js), '一间都没播');
  assert.ok(/有 \$\{g\.liveCount\} 间在播，但没有「\$\{target\}」的房间/.test(js), '别人在播要说清不是哪个主播');
  assert.ok(/g\.target \|\| '目标主播'/.test(js), '旧读数没有名字时要有个不别扭的兜底');
});

test('直播页能设听弹幕时长（照 mcloud Rust 的 5–1800 秒）', () => {
  const html = srcOf('plugins/mcloud/index.html');
  assert.ok(html.includes('id="live-listen-seconds"'), '要有输入框');
  assert.ok(/id="live-listen-seconds"[^>]*min="5"[^>]*max="1800"/.test(html), '范围要写清 5–1800');
  assert.ok(/\/live\/listen-seconds/.test(js), '保存走任务级接口');
  assert.ok(/live-listen-save/.test(js), '要有保存按钮');
  assert.ok(/听弹幕中/.test(srcOf('src/entries/live.ts')), '长连接期间要打进度，不能 70 秒零日志');
});

test('⚠ 听弹幕那行只说人关心的：几条弹幕、几条口令', () => {
  const src = srcOf('src/mcloud/tasks/liveListen.ts');
  assert.ok(/收到 \$\{st\.danmakuFrames\} 条弹幕/.test(src), '要报弹幕数');
  assert.ok(/捡到 \$\{st\.codes\.length\} 条口令/.test(src), '要报口令数');
  assert.ok(!/帧 \$\{st\.frames\}/.test(src), '帧数/心跳是排查用的，不进这行');
});

test('⚠ 兑换页那一行不许把"翻译表"当字符串印出来（`[object Object]`）', () => {
  // `e.verdictText` 是一张 `verdict → 中文` 的表；`setText` 会 `String(表)`。
  assert.ok(!/setText\('ex-note', r \? e\.verdictText/.test(js), '不许把整张表塞进这一行');
  // ⚠ 2026-10-17：数据源的名字从 `rows` 换成 `exPicks`（全量清单那份缓存）。
  //   "先数出几件能换"这件事**不许丢**，所以判据跟着换名，不是删掉。
  assert.ok(/const can = exPicks\.filter\(\(p\) => p\.verdict === 'ok'\)\.length;/.test(js), '要先数出几件能换');
  assert.ok(/件，其中 \$\{can\} 件现在能换/.test(js), '结论要具体');
  // 表格里的"能不能换"要走那张表翻成人话，不许直接印 ok / tomorrow 这种码
  assert.ok(/const say = \(v\) => \(e\.verdictText && e\.verdictText\[v\]\) \|\| v \|\| '';/.test(js), '要翻成人话');
  assert.ok(/\$\{esc\(say\(p\.verdict\)\)\}/.test(js), '表格要用翻译后的说法');
});

test('⚠ 直播页的时间说人话（`2026-10-20 14:30:00` → `10-20 14:30`）', () => {
  assert.ok(/function shortWhen\(v\)/.test(js), '缺 shortWhen');
  assert.ok(/if \(day === today\) return `今天 \$\{hm\}`;/.test(js), '今天直说');
  assert.ok(/if \(day === tomorrow\) return `明天 \$\{hm\}`;/.test(js), '明天直说');
  assert.ok(/const next = shortWhen\(pool\.nextStart/.test(js), 'hero 里要用它');
});

test('⚠ 直播那两句内部说法（门开着/门关着）不许出现在给用户看的句子里', () => {
  for (const f of ['src/mcloud/tasks/liveRoomRules.ts', 'src/mcloud/liveGate.ts', 'src/mcloud/tasks/liveListen.ts']) {
    const src = srcOf(f);
    assert.ok(!/门关着：|门开着：/.test(src), `${f} 里还有"门"这种说法`);
  }
  assert.ok(/正在听：\$\{KOULING_ANCHOR\} 开播了/.test(srcOf('src/mcloud/tasks/liveRoomRules.ts')), '开播要说"正在听"');
  assert.ok(/现在没在听：谁都没开播/.test(srcOf('src/mcloud/tasks/liveRoomRules.ts')), '没播要说"没在听"');
});

test('⚠ 老记录里的旧说法就地翻掉（冷却十几小时，不能等下次真探）', () => {
  const src = srcOf('src/mcloud/tasks/liveListen.ts');
  assert.ok(src.includes('门关着（合并后 (\\d+) 间房）'), '要把"合并后 N 间房"翻过来');
  assert.ok(/\.replace\(\/门关着\/g, '现在没在听'\)/.test(src), '老记录里的"门关着"也要翻');
});

test('⚠ 直播：口令只收**一次**（一个账号听到，所有账号都能用）', () => {
  const live = srcOf('src/entries/live.ts');
  // 用户口径 2026-10-17：「一个听到其他人就能用了」
  assert.ok(/function collectOnce\(/.test(live), '收口令要独立成一支');
  assert.ok(/function drawOnce\(/.test(live), '领取才是按账号的那一支');
  assert.ok(/if \(index === 0 && !manual\) \{[\s\S]{0,160}?collectOnce\(deps, startedMs\)/.test(live),
    '只有第一个账号去收，且人贴了口令就不收');
  assert.ok(/return drawOnce\(deps, startedMs\);/.test(live), '每个账号都领');
  // 听窗口不能再按账号摊预算
  assert.ok(!/runLive\(deps, startedMs\)/.test(live), '不再有"每账号跑一遍"');
  assert.ok(/const listenDeadline = runStartMs \+ BUDGET_MS - 20_000;/.test(live), '截止按整趟算');
  // 收口令那一段的日志不挂在某个账号名下
  assert.ok(/logBoth\(store, 'start', '口令', at\)/.test(live), '收口令要单独一段');
});

test('⚠ 直播收口令读**第一个账号的袋**，不能读模块级 store', () => {
  const live = srcOf('src/entries/live.ts');
  const start = live.indexOf('function collectOnce(');
  const end = live.indexOf('function drawOnce(');
  assert.ok(start >= 0 && end > start, '两段要能切开');
  const body = live.slice(start, end);
  // 模块级 store 是 default 袋；直播读数/池子写在 159 的袋里。
  // 读错袋的实拍：159 的读数 active=true，日志却报「2 间福建移动」然后跳过。
  assert.ok(/readGateReading\(deps\.store\)/.test(body), '门读数必须从 deps.store 读');
  assert.ok(/loadPoolFrom\(deps\.store\)/.test(body), '池子必须从 deps.store 读');
  assert.ok(!/readGateReading\(store\)/.test(body), '不许再读模块级 store');
  assert.ok(!/loadPoolFrom\(store\)/.test(body), '不许再读模块级 store');
});

test('⚠ 每行日志都带账号短名前缀（昵称原样，手机号 3+4）', () => {
  for (const f of ['src/entries/daily.ts', 'src/entries/live.ts', 'src/entries/exchange.ts']) {
    const s = srcOf(f);
    assert.ok(/const tag = `\[\$\{shortLabel\(who\)\}\]`;/.test(s), `${f} 缺短名前缀`);
    assert.ok(/`\$\{tag\} \$\{shown\}`/.test(s), `${f} 的步骤行没带前缀`);
    assert.ok(/`\$\{tag\} \$\{tail\}`/.test(s), `${f} 的段尾没带前缀`);
  }
  assert.ok(
    /if \(\/\^1\\d\{10\}\$\/\.test\(label\)\) return `\$\{label\.slice\(0, 3\)\}\*\*\*\*\$\{label\.slice\(-4\)\}`;/.test(
      srcOf('src/mcloud/taskAccounts.ts'),
    ),
    '手机号要掩成 3+4',
  );
});

test('⚠ 直播没开始就整趟跳过：不逐账号输出「领小红花没开 / 都成了」', () => {
  const live = srcOf('src/entries/live.ts');
  // 第一段说“没在播”时，后面的账号连 drawOnce 都不进
  assert.ok(/if \(one\.stopped\) stopAll = true;/.test(live), '要记住“整趟停”');
  assert.ok(
    /if \(stopAll\) return \{ steps: \[\] as RunStep\[\], detail: \[\] as string\[\]/.test(live),
    '停掉之后不许再发领取请求',
  );
  assert.ok(/if \(c !== null && c\.stopped\)/.test(live), '日志侧也要早退');
  assert.ok(
    /这一趟不领 —— \$\{reason\}；跳过 \$\{runs\.length\} 个账号/.test(live),
    '只留一行“跳过 N 个账号”',
  );
  // 早退必须在“每个账号一段”之前，否则还是每个号都印
  assert.ok(
    live.indexOf('c.stopped') < live.indexOf('for (const one of runs)'),
    '早退要在账号循环之前',
  );
});

test('⚠ 先验开播再决定要不要听（参考 mcloud `live_room.rs:1603`）', () => {
  const live = srcOf('src/entries/live.ts');
  assert.ok(/if \(gate === null \|\| gate\.active !== true\) \{/.test(live), '没开播要早退');
  assert.ok(/今天没有直播（谁都没在播）/.test(live), '一间都没播');
  assert.ok(/间在播，但没有一间是「\$\{KOULING_ANCHOR\}」的/.test(live), '别人在播');
  // 早退发生在小红书之前
  const atGate = live.indexOf('if (gate === null || gate.active !== true) {');
  const atRoom = live.indexOf("step('主播发口令没有'");
  assert.ok(atGate > 0 && atRoom > atGate, '小红书必须在开播之后');
  // 排期：一天两次
  assert.ok(/'30 10,15 \* \* \*'/.test(live), '每天 10:30 / 15:30');
  assert.ok(!/'\*\/5 \* \* \* \*'/.test(live), '每 5 分钟太频繁');
});

test('⚠ 门失败 ≠ 今天没直播（参考 mcloud-sign `hasActiveLiveRoom`：警告一句、继续试）', () => {
  const live = srcOf('src/entries/live.ts');
  assert.ok(/if \(!gateOut\.ok\) \{/.test(live), '门失败要单独一条路');
  assert.ok(/（继续试一次）/.test(live), '一天两次机会，偶发失败别丢掉整场');
  assert.ok(live.indexOf('if (!gateOut.ok) {') < live.indexOf('if (gate === null || gate.active !== true)'),
    '先判门失败，再判没开播');
});


test('⚠ 保存账号选择校验的是**排期任务名**，不是内部步骤名（曾经每次 400）', () => {
  const routes = srcOf('src/mcloud/routes.ts');
  const ta = srcOf('src/mcloud/taskAccounts.ts');
  assert.ok(/export const SCHEDULED_TASKS = \['日常', '兑换', '直播'\] as const;/.test(ta), '要有这一份');
  assert.ok(/SCHEDULED_TASKS as readonly string\[\]\)\.includes\(task\)/.test(routes), '路由要用它');
  assert.ok(!/TASK_NAMES as readonly string\[\]\)\.includes\(task\)/.test(routes), '不能再用步骤名那套');
  // 三份排期注册的名字要和常量对得上（防漂移）
  const pairs: [string, string][] = [
    ['src/entries/daily.ts', '日常'],
    ['src/entries/exchange.ts', '兑换'],
    ['src/entries/live.ts', '直播'],
  ];
  for (const [f, name] of pairs) {
    assert.ok(new RegExp(`register_cron\\(\\s*'${name}'`).test(srcOf(f)), `${f} 注册的名字要是 ${name}`);
  }
});

test('⚠ 账号选择：取消一格 = 剩下那些（不能反成"只留这一格"）', () => {
  // `all:true` 时每一格都是勾着的；按"勾了它"去推会得到 ids:['移动'] —— 正好反了
  assert.ok(/const ids = \[\.\.\.panel\.querySelectorAll\('input\[data-pick\]'\)\]/.test(js), '要以 DOM 为准');
  assert.ok(!/const has = \(cur\.picked \|\| \[\]\)\.includes\(id\);/.test(js), '别再自己推');
});

test('⚠ 日志筛在「提醒以上」时必须自己解释（用户：「没看到任何日志」）', () => {
  assert.ok(/function levelNote\(\)/.test(js), '要有个"当前筛选叫什么"的小函数');
  assert.ok(/只显示「\$\{only\}」/.test(js), '空态要说清筛选');
  assert.ok(/切回「全部」/.test(js), '要给出怎么看到');
  // 单发一条 toast 会被 0.4 秒后的「跑完了」覆盖 ⇒ 提示跟在结果那句里
  assert.ok(/const hidden = only === '' \? '' : ` · 日志只显示「\$\{only\}」，这趟的行大多被挡掉了`;/.test(js), '提示要跟结果一起说');
});

test('⚠ 级别要从 `TERMS[k].el()` 里取（`TERMS[k].level` 是 undefined）', () => {
  assert.ok(/const lv = TERMS\[key\] \? TERMS\[key\]\.el\(\)\.level\.value : 'info';/.test(js), '要经 el()');
  assert.ok(!/TERMS\[key\]\.level \?/.test(js), '别直接读 .level');
});

test('⚠ 级别下拉每次进页面都回「全部」（浏览器会恢复上次的选择 ⇒ 空屏）', () => {
  assert.ok(/function resetTermLevels\(\)/.test(js), '要有显式复位');
  assert.ok(/el\.level\.value = 'info';/.test(js), '回「全部」');
  assert.ok(/addEventListener\('pageshow', resetTermLevels\)/.test(js), 'pageshow 之后再复位一次（恢复发生在它之前）');
  // 别用 autocomplete="off"（项目里有用例禁它，MDN 也不建议）
  assert.ok(!/autocomplete="off"/.test(srcOf('plugins/mcloud/index.html')), 'HTML 里不许出现');
});

test('⚠ 自检要探「宿主有没有 native TLS」——直播那条链全靠它', () => {
  const st = srcOf('src/selftest.ts');
  // 面板被重编成不带 `--features legacy-tls` 时，直播第一步就 warn「没成」，
  // 而自检那时候是绿的 —— 2026-10-17 真撞到过。
  assert.ok(/宿主支持 native TLS（直播那条链要它）/.test(st), '要有一条检查');
  assert.ok(/tls: 'native'/.test(st), '探法要真的用 native');
  // ⚠ http_fetch 失败是**返回 {error}**，不是抛 —— 只写 catch 会永远判 false
  assert.ok(/\{ error\?: string \}\)\.error/.test(st), '要读 {error} 字段');
  assert.ok(/!\/legacy-tls\/\.test\(err\)/.test(st), '判据是"错误里没有 legacy-tls 那句"');
});

test('⚠ 票的事内部处理：界面不提"手机端凭据几点过期"（用户不关心）', () => {
  const s = srcOf('src/mcloud/session.ts');
  assert.ok(/export function jwtExpiryOf\(raw: string, nowIso: string\)/.test(s), '内部要有"票还有效吗"的判据');
  // 卡片上不许出现这条 —— 那是机制，不是用户要做的事
  assert.ok(!/手机端凭据/.test(js), '账号卡不许写"手机端凭据…"');
  // 续不上时才给下一步，且不提时间
  const d = srcOf('src/entries/daily.ts') + srcOf('src/mcloud/dailyRun.ts');
  assert.ok(/登录状态失效了，去「账号」页重新导入会话/.test(d), '走投无路时给动作');
  assert.ok(!/手机端凭据 \$\{clock\} 过期了/.test(d), '别把"几点过期"摆给用户');
  // 续票本身要按账号（F-095）
  assert.ok(/needExchange\(deps\.store, /.test(d), '续票按账号');
});


test('⚠ 三个号同一句话时合成一枚 chip（三枚一模一样的是噪声）', () => {
  const js = srcOf('plugins/mcloud/app.js');
  assert.ok(/new Set\(sameRun\.map\(restOf\)\)\.size === 1/.test(js), '要判"是不是同一句话"');
  assert.ok(/name\.textContent = `\$\{sameRun\.length\} 个账号`/.test(js), '合成后要说清是几个号');
  // 只有**一次运行**里的记录才比（跨轮的旧记录不能混进来）
  assert.ok(/const sameRun = list\.filter\(\(x\) => x\.at === runAt\);/.test(js), '只比同一趟');
});

test('⚠ 「领小红花没开」是全局开关，不许画成账号 chip（同一句话只说一遍）', () => {
  const js = srcOf('plugins/mcloud/app.js');
  assert.ok(
    /const liveRecent = \(l\.recent \|\| \[\]\)\.filter\(\s*\(x\) => !\/领小红花没开\/\.test/.test(js),
    '要把它从账号 chip 里滤掉',
  );
  assert.ok(/renderAcctChips\('live-accounts', 'live-account-detail', liveRecent\)/.test(js), '传滤过的');
});

test('⚠ 颜色一律走面板 token（写死的深色在浅色主题下会翻车）', () => {
  const css = srcOf('plugins/mcloud/style.css');
  // 面板 theme.css 里**没有** --bg-2 / --fg-dim 这两个名字
  assert.ok(!/var\(--bg-2/.test(css), '--bg-2 不是面板的 token');
  assert.ok(!/var\(--fg-dim/.test(css), '--fg-dim 不是面板的 token');
  // 终端块曾经写死 #0b0e14：浅色主题下就是白纸上的一条黑砖
  assert.ok(!/background:\s*#0b0e14/.test(css), '终端底色要走 --bg-deep');
  assert.ok(/background:\s*var\(--bg-deep\)/.test(css), '终端底色 = --bg-deep（与面板的 .console 同源）');
  // 语义色也别写死（亮绿/亮红在白底上看不清）
  for (const bad of ['#56d364', '#ff7b72', '#e8a0a0', '#8b949e', '#c9d1d9', '#e3b341']) {
    assert.ok(!css.includes(bad), `别写死 ${bad}`);
  }
});

test('⚠ 面板缺直播支持时：当成**构建缺陷**报出来，并且别再去试', () => {
  const live = srcOf('src/entries/live.ts');
  const cap = srcOf('src/mcloud/hostCap.ts');
  // 判据要在最前面（门之前）—— 否则每条路都以同一条 TLS 报错收场
  const capAt = live.indexOf("cap.verdict === 'no'");
  const gateAt = live.indexOf("drain(runLiveGate");
  assert.ok(capAt > 0 && capAt < gateAt, '能力判据必须排在"有没有开播"之前');
  // 给用户的话不许提 --features（那是编面板的人的事）
  assert.ok(!/capNote[\s\S]{0,400}--features/.test(cap), '不给用户看 --features');
  assert.ok(/构建缺陷/.test(cap), '要说清这是构建缺陷，不是配置问题');
  assert.ok(/换一个正常的面板构建/.test(cap), '要给唯一能做的动作');
  // 默认就带 —— 所以"缺"只可能是编漏了；级别必须是 error（warn 会被当成偶发）
  assert.ok(/capOnly/.test(live), '要认出"这一段只有能力那一步"');
  assert.ok(
    /logBoth\(store, 'error', c\.detail\[0\]/.test(live),
    '用 error 级别、且只印一行（段头+步骤+段尾说同一句话 = 噪声）',
  );
  // logBoth 要真的支持 error/fatal 和语义类型
  const logSrc = srcOf('src/mcloud/log.ts');
  assert.ok(/export type LogLevel =/.test(logSrc), 'logBoth 要有类型联合');
  for (const lv of ['debug', 'info', 'warn', 'error', 'fatal', 'start', 'success', 'fail']) {
    assert.ok(logSrc.includes(`'${lv}'`), `logBoth 要收 ${lv}`);
  }
  assert.ok(/case 'fatal':\s*fatal\(msg\)/.test(logSrc), 'fatal 要真的转发给面板');
  // 结论要缓存，别每次都探
  assert.ok(/export const CAP_TTL_MS/.test(cap), '要缓存');
});

test('⚠ 「数据」页第一格是主动请求的：开这一页自己取，只有"要新的"才点刷新', () => {
  const js = srcOf('plugins/mcloud/app.js');
  const html = srcOf('plugins/mcloud/index.html');
  // 切到「数据」就自动取一次
  assert.ok(/if \(name === 'data'\) autoFetchBeansOnce\(\);/.test(js), '开这一页要自己取');
  // 只取一次（切回来不重打 —— 那是按账号一枪的请求）
  assert.ok(/let beansAutoFetched = false;/.test(js), '要有"只自动取一次"的闸');
  // 按钮叫「刷新」（不是「取一次」—— 用户不用先点一下）
  assert.ok(/id="beans-refresh"[^>]*>刷新</.test(html), '按钮要叫「刷新」');
  assert.ok(!/取一次/.test(html), '不许再让人"点一下才取"');
  // 卡片式布局：数据页里每格各自一张 card（沙箱能力那张已删，现在两张）
  const dataBlock = html.slice(html.indexOf('id="block-data"'), html.indexOf('</main>'));
  const cards = (dataBlock.match(/<div class="card">/g) || []).length;
  assert.ok(cards >= 2, `数据页要卡片式（现在 ${cards} 张）`);
  assert.ok(/<span class="card-title">AI豆<\/span>/.test(html), '标题用面板的 card-title');
  assert.ok(/当前余额/.test(html) && /缓存 2 小时/.test(html), '数据页要说清当前余额和 2 小时缓存');
});

test('WebUI 里不再有「推送」这一块（配置/试发/规则全删）', () => {
  const html = srcOf('plugins/mcloud/index.html');
  const js = srcOf('plugins/mcloud/app.js');
  assert.ok(!html.includes('data-block="push"'), '菜单里不该还有推送');
  assert.ok(!html.includes('id="block-push"'), '不该还有推送区块');
  assert.ok(!/id="push-/.test(html), '不该还有 push-* 输入/按钮');
  assert.ok(!/function renderPush\(/.test(js), '渲染函数要删');
  assert.ok(!/const PUSH_FIELDS/.test(js), '渠道表单定义要删');
  assert.ok(!/post\('push\//.test(js), '不该再从界面调 push 接口');
});

test('⚠ 日志终端先连 SSE，再异步补历史（否则任务跑完才看到日志）', () => {
  const js = srcOf('plugins/mcloud/app.js');
  const start = js.indexOf('function open() {', js.indexOf('function makeTerm('));
  const end = js.indexOf('function connect(q) {', start);
  assert.ok(start >= 0 && end > start, '要能切开 open()');
  const body = js.slice(start, end);
  assert.ok(/connect\(q\);\s*void seed\(\);/.test(body), '顺序必须是先 connect、再 seed');
  assert.ok(!/seed\(\)\.then\(/.test(body), '不许再等 /log/tail 回来才连流');
  assert.ok(/if \(shown > 0\) return;/.test(js), '历史回来时实时已有行就不许清屏');
});

test('⚠ 日常**不设"今天跑过就跳过"**：一天两趟都跑，第二趟是兜底', () => {
  const d = srcOf('src/entries/daily.ts');
  // 那道闸必须没了 —— 插件没法证明所有小任务都到了预期，跳过就等于放弃兜底
  assert.ok(!/doneToday && !manual/.test(d), '不许再有"今天跑过就跳过"');
  assert.ok(/forEachTaskAccount\(store, '日常', p, transport, \(deps, acctId\) =>/.test(d), '每个账号都照跑');
  assert.ok(/runDaily\(deps, \{\s*onPhase/.test(d), '步骤/阶段要边跑边打');
  assert.ok(/第二次跑是容错/.test(d), '理由要写在代码里（下次别又加回去）');
  // 面板侧那一格 `manual` 仍然有用（别的地方要判"谁触发的"）
  const t = srcOf('src/host-api.d.ts');
  assert.ok(/manual\?: boolean;/.test(t), '载荷类型要有 manual');
});


test('⚠ App 任务：已完成默认折叠、点开是按组展开的', () => {
  const js = srcOf('plugins/mcloud/app.js');
  // 折叠行：带组标记与条数
  assert.ok(/data-more="1" data-g="\$\{esc\(g\.group\)\}" data-n="\$\{restItems\.length\}"/.test(js), '折叠行要带组和条数');
  // 按组展开（两个市场共用一个 <ul>，按父节点找会连另一组一起收）
  assert.ok(/if \(\(li\.dataset\.g \|\| ''\) !== g\) continue;/.test(js), '只展开本组');
  // 条数从 data-n 拿（展开后那句话里没有数字，re 不出来）
  assert.ok(/const n = more\.dataset\.n \|\| '';/.test(js), '条数来自 data-n');
  // 没做完的在前、折叠行在那几条之后
  const todoAt = js.indexOf('for (const it of todoItems) rows.push(line(it, false));');
  const moreAt = js.indexOf('data-more="1"', todoAt);
  assert.ok(todoAt > 0 && moreAt > todoAt, '折叠行要排在"没做完"那几条之后');
});

test('任务状态可切账号；每条带 taskId 和未完成时的步进', () => {
  const html = srcOf('plugins/mcloud/index.html');
  const js = srcOf('plugins/mcloud/app.js');
  assert.ok(/id="matrix-account"/.test(html), '任务状态卡要有账号下拉');
  assert.ok(/id="matrix-refresh"/.test(html), '任务状态卡要有刷新按钮');
  assert.ok(/\/matrix\?account=/.test(js), '切账号读 /matrix?account=');
  assert.ok(/refresh=1/.test(js), '刷新按钮必须真请求（refresh=1）');
  assert.ok(!/totalSteps/.test(js), '不许再猜 24 这种总步数');
  assert.ok(/本机已上传/.test(js) && /本机已点过/.test(js), '本机证据要显示出来');
  assert.ok(/matrixAccountId/.test(js), '要记住用户选的账号');
  assert.ok(/taskId/.test(js) && /第 \$\{typeof it\.currStep === 'number' \? it\.currStep : 0\} 步/.test(js), '每条任务要带 id 和步号');
  assert.ok(/完成进度/.test(js) && /buttonOutDay/.test(js), '通知任务要显示完成进度');
  assert.ok(/本月备份/.test(js) && /BACKUP_STEP_TEXT/.test(js), '备份进度要显示出来');
  assert.ok(/只读本地缓存，不发新请求/.test(js), '默认不请求上游要说清');
  assert.ok(/renderData\(r\.data \|\| \{\}, r\.account \|\| \{\}\)/.test(js), 'renderData 必须拿到账号表（否则下拉是空的）');
});

test('⚠ App 任务徽章**照抄上游那句**，不许一刀切印成「待做」（mcloud 的同一个错：`694e35f`）', () => {
  const js = srcOf('plugins/mcloud/app.js');
  // 一刀切那个词不许回来（用户原话：「这个待做容易误导，请与原接口文案一致」）
  assert.ok(!/'待做'/.test(js), '界面上还有写死的「待做」标签');
  assert.ok(!/待做 \$\{/.test(js), '计数那行还在写「待做 N」');
  // 徽章的词来自上游那三档 + 阶段线索，读不出才回落状态词
  assert.ok(/function appTaskView\(it\)/.test(js), '没有"照抄上游文案"的那个函数');
  for (const f of ['buttonOutText', 'buttonTextMiddle', 'buttonTextFinish', 'buttonActionMiddle']) {
    assert.ok(js.includes(f), `徽章没读上游那一格：${f}`);
  }
  assert.ok(/label: pick\(it\.buttonTextFinish, it\.buttonOutText\) \|\| '已完成'/.test(js), 'FINISH 要先看 textFinish');
  assert.ok(/\|\| '未完成'/.test(js), '读不出上游文案时要回落「未完成」，不是猜一个');
  // 桶（排序/折叠）与词（徽章）是两件事，但桶必须与写的那半同一条判据
  assert.ok(/function appTaskBucket\(it\)/.test(js), '排序的桶要单独一个函数');
  assert.ok(/if \(it\.state === 'FINISH'\) return 'done';\n  if \(it\.enable === 1\) return 'todo';/.test(js), '桶要与 judgeItem 同一条');
  // 上游文案是**网络来的字符串**，进 DOM 前必须 esc
  assert.ok(/<span class="badge \$\{view\.badge\}">\$\{esc\(view\.label\)\}<\/span>/.test(js), '徽章文案没转义');
});

test('⚠ 跨账号的同一句解释只说一遍（领小红花那个括号）', () => {
  const log = srcOf('src/mcloud/tasks/stepLog.ts');
  assert.ok(/export function onceHint/.test(log), '要有 onceHint');
  assert.ok(/ONCE_HINTS = \['（要先在服务端那边开启）'\]/.test(log), '只对固定后缀生效，别做"任意重复就去重"');
  const d = srcOf('src/entries/daily.ts');
  assert.ok(/const onceHints = new Set<string>\(\)/.test(d), 'daily 一趟一个 set');
  assert.ok(/onceHint\(line, onceHints\)/.test(d), 'daily 记日志时过一遍');
  const l = srcOf('src/entries/live.ts');
  assert.ok(/onceHint\(line, onceHints\)/.test(l), '直播那条链也一样');
});

test('CI 的 state 断言脚本：正例过、反例必须红（别让 CI 断言本身坏了没人知道）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-state-'));
  // 类型写明：下面几条反例会改字段（runtime / error），别让 TS 按字面量推成 null
  const good: {
    plugins: { name: string; runtime: string; error: string | null }[];
    jobs: { name: string; plugin: string; schedule: string; last_error: string | null }[];
  } = {
    plugins: [
      { name: 'mcloud', runtime: 'js', error: null },
      { name: 'mcloud-daily', runtime: 'js', error: null },
      { name: 'mcloud-exchange', runtime: 'js', error: null },
      { name: 'mcloud-live', runtime: 'js', error: null },
    ],
    jobs: [
      { name: '日常', plugin: 'mcloud-daily', schedule: '0 8,20 * * *', last_error: null },
      { name: '兑换', plugin: 'mcloud-exchange', schedule: '0 10 * * *', last_error: null },
      { name: '直播', plugin: 'mcloud-live', schedule: '30 10,15 * * *', last_error: null },
    ],
  };
  const run = (cmd: string, obj: unknown) => {
    const p = join(dir, `${cmd}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return spawnSync('python3', [join(ROOT, 'scripts/ci_state_check.py'), cmd, p], { encoding: 'utf8' });
  };

  assert.equal(run('ready', good).status, 0, '正例：ready 应为 0');
  assert.equal(run('loaded', good).status, 0, '正例：loaded 应为 0');
  assert.equal(
    run('selftest', { ok: true, detail: '7/7 通过', checks: [{ name: 'md5', ok: true }] }).status,
    0,
    '正例：自检过',
  );

  // 反例：这些正是"CI 应该拦住"的形态，一个都不能放过
  const missingJob = structuredClone(good);
  missingJob.jobs = missingJob.jobs.filter((j) => j.name !== '兑换');
  assert.equal(run('ready', missingJob).status, 1, '少一条任务：ready 必须 1');
  assert.equal(run('loaded', missingJob).status, 1, '少一条任务：loaded 必须 1');

  const jobBack = structuredClone(good);
  jobBack.jobs.push({ name: 'selftest', plugin: 'mcloud', schedule: '*/5 * * * *', last_error: null });
  assert.equal(run('loaded', jobBack).status, 1, 'selftest 又变回任务了：必须红（防回归）');

  const badRuntime = structuredClone(good);
  badRuntime.plugins[0]!.runtime = 'py';
  assert.equal(run('loaded', badRuntime).status, 1, 'runtime 不对：必须红');

  const err = structuredClone(good);
  err.plugins[1]!.error = 'boom';
  assert.equal(run('loaded', err).status, 1, '插件报错：必须红');

  assert.equal(
    run('selftest', { ok: false, detail: '6/7 通过', checks: [{ name: 'md5', ok: false }] }).status,
    1,
    '自检没过：必须红',
  );
});

test('每个任务都有独立的自动/本次账号选择器，手动不回写自动', () => {
  const html = srcOf('plugins/mcloud/index.html');
  for (const id of ['daily-acct-btn', 'daily-manual-btn', 'live-acct-btn', 'live-manual-btn']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  assert.ok(/mode: 'manual'/.test(js), '前端要标明写的是 manual');
  assert.ok(/daily-manual-follow/.test(js), '本次要能跟随自动');
  assert.ok(/body: \{ task: cfg\.task, mode: cfg\.mode, all, ids, follow: follow === true \}/.test(js), '保存时要带 mode/follow');
  assert.ok(/auto: TaskAccounts/.test(srcOf('src/mcloud/taskAccounts.ts')), '视图要分 auto/manual');
});
