// 插件界面（`plugins/mcloud/index.html` + `app.js`）的**静态**一致性。
//
// # 守的是哪一类错
//
// `app.js` 里到处是 `$('some-id')`，而 `$` 是 `document.getElementById`。
// 一旦 id 写错（改名、复制粘贴、大小写），**浏览器里不会报错、也不会白屏** ——
// 只是那一段渲染静默不生效（例如"听着…"那行永远是空的）。
// 这种错在仓库里没有任何测试看得见（面板只检查自己的 web 资产，插件界面归插件管）。
//
// ⇒ 这张网把两边的 id 对一遍：
//   · `index.html` 里声明的 + `app.js` 自己的模板串里生成的（`innerHTML = '… id="x" …'`）
//   · `app.js` 里所有 `$('x')`
// 前者必须覆盖后者。语法/渲染本身**测不了**（要 DOM），这一点如实写在最后。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../plugins/mcloud/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const js = readFileSync(new URL('app.js', dir), 'utf8');
const css = readFileSync(new URL('style.css', dir), 'utf8');

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

test('`app.js` 取用的每个 id 都真的存在（写错 = 那段渲染静默不生效）', () => {
  const declared = idsIn(html);
  const dynamic = idsIn(js);
  const used = [...idsUsed(js)].sort();
  assert.ok(used.length > 10, `取用的 id 太少了（${used.length}）—— 是不是正则没跟上写法？`);
  const missing = used.filter((id) => !declared.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, [], `这些 id 在 index.html 与 app.js 的模板串里都找不到：${missing.join(', ')}`);
});

test('界面里挂的按钮都有对应的处理器（挂错 = 点了没反应）', () => {
  // ⚠ 只查"有 id 的 button/input"里那些**看起来是动作**的（有 id 就说明有代码要用它）。
  const buttons = [...html.matchAll(/<(button|input)[^>]*id="([A-Za-z0-9_-]+)"/g)].map((m) => m[2] as string);
  const unbound = buttons.filter((id) => !js.includes(`$('${id}')`));
  assert.deepEqual(unbound, [], `这些控件在 app.js 里从没被取用过：${unbound.join(', ')}`);
});

test('样式表里没有指向不存在 class 的孤儿规则（改名留下的死规则）', () => {
  // ⚠ 只查 `#id` 选择器（class 可能有动态拼接，误报会很吵）。
  const declared = idsIn(html);
  const dynamic = idsIn(js);
  const idSelectors = [...css.matchAll(/#([A-Za-z0-9_-]+)/g)].map((m) => m[1] as string);
  const orphan = [...new Set(idSelectors)].filter((id) => !declared.has(id) && !dynamic.has(id));
  assert.deepEqual(orphan, [], `样式里引用了不存在的 id：${orphan.join(', ')}`);
});
