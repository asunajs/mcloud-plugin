// README 与文档的一致性。
//
// # 守的是什么
//
// ① **死链**。README 里 `[文字](路径)` 那种链接最容易烂：文件改名/挪位置之后
//    链接还在，点进去 404。而**没有任何东西会因此报错** —— 只有人点到才知道。
//    这一条是纯机械检查，成本极低、收益极高。
//
// ② **README 不许描述已经删掉的结构**。这一版把「25 条一次一步的任务」
//    整个删掉了，而 README 是最容易漏改的地方 —— 它**主动误导**：
//    新来的人照着它去找那 25 条任务，然后发现一条都不在。
//    历史可以留（`docs/design-history.md`），但**必须标清是历史**。
//
// ③ **每个插件都要在 README 里出现**。少一个就是有人不知道它存在。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

/** 去掉代码块与行内代码 —— 里面的 `[x](y)` 多半是示例，不是链接。 */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

// ── ① 死链 ────────────────────────────────────────────────────────────

test('⚠ README 里每个相对链接都真的存在（死链没人报错，只有人点到才知道）', () => {
  const bad: string[] = [];
  for (const m of prose(readme).matchAll(/\]\(([^)]+)\)/g)) {
    const href = m[1]!.trim();
    // 只查仓库内的相对路径；外链与纯锚点跳过
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const path = href.split('#')[0]!;
    if (path === '') continue;
    if (!existsSync(resolve(root, path))) bad.push(href);
  }
  assert.deepEqual(bad, [], `这些链接指向不存在的路径：${bad.join(', ')}`);
});

test('⚠ 文档目录里的每个 `.md` 都在 README 的文档表里被提到', () => {
  // 少一个就是"有人写了文档但没人知道它在哪"。
  const docs = readdirSync(resolve(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'README.md');
  const missing = docs.filter((f) => !readme.includes(`docs/${f}`));
  assert.deepEqual(missing, [], `这些文档没进 README 的索引：${missing.join(', ')}`);
});

// ── ② 不许描述已经删掉的结构 ─────────────────────────────────────────

test('⚠ README 里提「已删掉的结构」时**必须同时标出那是旧的**', () => {
  // 完全不提是最差的做法之一（新来的人不知道为什么要这么设计），
  // 但**只提不标**更糟 —— 那会让人照着去找不存在的东西。
  // 所以判据不是"不许出现这个词"，而是"出现时周围有没有对照标记"。
  const p = prose(readme);
  const marks = ['前一版', '上一版', '而不是', '推翻', '已经删掉', '删掉了', '换成了'];
  for (const bad of ['25 条', '30 条任务', '可恢复的步骤机', '一次调用一个请求', '一次一步']) {
    let at = p.indexOf(bad);
    while (at >= 0) {
      const around = p.slice(Math.max(0, at - 60), at + bad.length + 30);
      assert.ok(
        marks.some((m) => around.includes(m)),
        `README 里「${bad}」这一处没说清是旧的：…${around.replace(/\n/g, ' ')}…`,
      );
      at = p.indexOf(bad, at + 1);
    }
  }
});

test('README 必须说清现在是**三条**任务（而不是 25 条 / 12 条）', () => {
  const p = prose(readme);
  assert.ok(/三条任务|三条\b/.test(p), 'README 没说清现在是三条任务');
  for (const name of ['日常', '兑换', '直播']) {
    assert.ok(p.includes(name), `README 里没提「${name}」这条任务`);
  }
});

test('README 必须说清是**四条**插件，且四条都在', () => {
  // ⚠ 查**原文**而不是去掉行内代码之后的正文：插件名在表格里是 `` `mcloud-daily` ``，
  //   `prose()` 会把反引号里的内容删掉，于是这里永远找不到（第一版就是这样红的）。
  for (const plugin of ['mcloud', 'mcloud-daily', 'mcloud-exchange', 'mcloud-live']) {
    assert.ok(readme.includes(plugin), `README 里没提插件 ${plugin}`);
  }
  assert.ok(/四条插件/.test(prose(readme)), 'README 没说清现在是四条插件');
});

test('README 必须指向阶段计划（那是进度的唯一权威）', () => {
  assert.ok(readme.includes('docs/redesign-plan.md'), 'README 没有指向 redesign-plan');
});

// ── ③ 历史文档必须标清是历史 ─────────────────────────────────────────

test('⚠ `docs/design-history.md` 必须在开头就说清「这是历史」（否则和 README 打架）', () => {
  const hist = readFileSync(resolve(root, 'docs/design-history.md'), 'utf8');
  const head = hist.slice(0, 1200);
  assert.ok(/历史/.test(head), '开头没说这是历史');
  assert.ok(/已经被推翻|被推翻/.test(head), '没说清里面有被推翻的判断');
  assert.ok(head.includes('README.md'), '没指向现状（README）');
  // 那份稿子里"可恢复的步骤机"确实在，但那是在历史文件里 —— 允许
  assert.ok(hist.includes('可恢复的步骤机'), '历史文件应该保留当初的推演');
});

// ── ④ 交叉引用：计划与 README 不能各说各话 ────────────────────────────

test('README 说的任务数，与 `split_check` 断言的条数一致', () => {
  // 这一条把"文档说的"与"脚本在真面板上断言的"钉在一起 ——
  // 光改文档不改脚本（或反过来）都会红。
  const split = readFileSync(resolve(root, 'scripts/split_check.py'), 'utf8');
  // ⚠ 查的是脚本里那张**映射表**，不是我凭记忆写的另一种写法
  //   （第一版按 `('mcloud-daily', '日常')` 找，而脚本里是
  //   `TASK_PLUGIN = {"日常": "mcloud-daily", ...}` —— 断言自己写错了格式）。
  for (const [task, plugin] of [
    ['日常', 'mcloud-daily'],
    ['兑换', 'mcloud-exchange'],
    ['直播', 'mcloud-live'],
  ]) {
    assert.ok(
      split.includes(`"${task}": "${plugin}"`),
      `split_check 里没有「${task} → ${plugin}」这条映射`,
    );
  }
  // 插件名单也要一致
  assert.ok(
    split.includes('PLUGIN_NAMES = ["mcloud", "mcloud-daily", "mcloud-exchange", "mcloud-live"]'),
    'split_check 的插件名单与 README 说的四条对不上',
  );
  assert.ok(readme.includes('三条'), 'README 与 split_check 对不上了');
});

// ── ⑤ 用词规则要**可执行**（不然它只是一张纸） ──────────────────────

test('⚠ UI 里不许有**字面 Markdown 标记**（HTML 不渲染它，会原样显示）', () => {
  // 实测抓到的：`<p class="hint">「提前多少毫秒发」是**你到云端的传输耗时**。</p>`
  // —— 页面上真的显示出了那四个星号。HTML 不是 Markdown，`**` 就是两个字符。
  // ⚠ 截图之前看不出来（静态测试不会"看"页面）—— 这类缺陷只有渲染才暴露。
  const html = readFileSync(new URL('../plugins/mcloud/index.html', import.meta.url), 'utf8');
  // ⚠ HTML 注释里的 `**` 是**给维护者看的**文档，不算（它不会被渲染）
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  const hits = visible.match(/\*\*[^*\n]{1,60}\*\*/g) ?? [];
  assert.deepEqual(hits, [], `可见文本里出现了字面 Markdown：${hits.join(' / ')}`);
});

test('⚠ 界面里不许出现用词规则禁掉的那些词', () => {
  // `docs/ui-wording.md` 写了规则，但规则写成文档就只是"一张纸" ——
  // 这一版的新界面就是**规则写完才做的**，于是当场踩了四处（`上游` ×4）。
  // 所以把它变成测试：改了界面忘了改用词，这里红。
  const ui = readFileSync(resolve(root, 'plugins/mcloud/index.html'), 'utf8');
  const js = readFileSync(resolve(root, 'plugins/mcloud/app.js'), 'utf8');
  // 去掉注释：HTML 顶部那段注释是**解释旧版毛病**的，里面会提到那些被删掉的词
  const visible = ui.replace(/<!--[\s\S]*?-->/g, '');
  const jsCode = js.replace(/^\s*\/\/.*$/gm, '');

  const banned = ['上游', 'mock', '表达式', 'cron', 'budget_ms', '推进一步', '只验证', '换一步'];
  // ⚠ **例外**：「上游状态」这个按钮/页名保留 —— 参考实现自己就叫这个
  //   （`web/src/ui/nav.ts` / `app-task-list.tsx`）。规则管的是**说明文字**，
  //   不管参考实现已经定下的名字。所以先把这一处替掉再查其余的。
  const stripAllowed = (t: string): string => t.replaceAll('上游状态', '「状态」');
  for (const [name, textRaw] of [
    ['index.html', visible],
    ['app.js', jsCode],
  ] as const) {
    const text = stripAllowed(textRaw);
    const hits = banned.filter((w) => text.includes(w));
    assert.deepEqual(
      hits,
      [],
      `${name} 里出现了用词规则禁掉的词：${hits.join(', ')}（见 docs/ui-wording.md）`,
    );
  }
});

test('用词规则里要求的替代说法，界面上真的有', () => {
  const ui = readFileSync(resolve(root, 'plugins/mcloud/index.html'), 'utf8');
  // 「上游」要写成「移动云盘」
  assert.ok(ui.includes('移动云盘'), '界面上没出现「移动云盘」—— 那「上游」该叫什么？');
  // 三个动作按钮要说人话
  assert.ok(ui.includes('现在跑一次'), '缺「现在跑一次」');
  assert.ok(ui.includes('贴进去领取'), '缺「贴进去领取」');
  assert.ok(ui.includes('扫码登录'), '缺「扫码登录」');
});

test('用词规则文档自己要与现状一致（不许还写着「高级」那一角）', () => {
  const w = readFileSync(resolve(root, 'docs/ui-wording.md'), 'utf8');
  // 「高级」那一角已经删了；文档里提它必须是在说"没有它了"
  let at = w.indexOf('「高级」');
  while (at >= 0) {
    const around = w.slice(Math.max(0, at - 80), at + 80);
    assert.ok(
      /没有|删|不再|改过一次|留下来/.test(around),
      `用词规则里提「高级」时没说清它已经没了：…${around.replace(/\n/g, ' ')}…`,
    );
    at = w.indexOf('「高级」', at + 1);
  }
});

test('⚠ 文档里不许让人去找**已经删掉的任务**（比死链更隐蔽的误导）', () => {
  // 死链点一下就发现；"去找一个不存在的任务"要点半天才发现。
  // 25 条任务合并成 3 条之后，文档里还留着 `session-check` 这种名字。
  // ⚠ **不含 `ui-wording.md`**：它是**规则表**，天生要把禁掉的那些词列出来
  //   （「任务名（`live-listen`…）→ 不出现」）。在规则表里提它们是对的用法，
  //   判它"没说清它没了"是**断言写错了对象**（第一版就是这样红的）。
  const docs = ['docs/howto-session.md', 'README.md', 'docs/redesign-plan.md'];
  const gone = ['session-check', 'live-draw', 'live-listen', 'app-task-matrix', 'exchange-list'];
  for (const f of docs) {
    // ⚠ 先去掉**行内代码**与**路径样式**的 token：`test/live-draw-report.test.ts`
    //   这种文件名里当然含 `live-draw`，但它不是在让人去找那条任务
    //   （第一版就是这样误报的）。
    const text = readFileSync(resolve(root, f), 'utf8')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[\w./-]*\/[\w./-]+/g, ' ');
    for (const name of gone) {
      let at = text.indexOf(name);
      while (at >= 0) {
        const around = text.slice(Math.max(0, at - 100), at + name.length + 100);
        assert.ok(
          /已经没有了|删掉|合并成|不再|早先|历史|前一版/.test(around),
          `${f} 里提到已删掉的任务名「${name}」但没说清它没了：…${around.replace(/\n/g, ' ')}…`,
        );
        at = text.indexOf(name, at + 1);
      }
    }
  }
});
