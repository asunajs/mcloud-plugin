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

test('⚠ README 里每个相对链接都真的存在（死链没人报错，只有人点到才知道）', async () => {
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

test('⚠ 文档目录里的每个 `.md` 都在 README 的文档表里被提到', async () => {
  // 少一个就是"有人写了文档但没人知道它在哪"。
  const docs = readdirSync(resolve(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'README.md');
  const missing = docs.filter((f) => !readme.includes(`docs/${f}`));
  assert.deepEqual(missing, [], `这些文档没进 README 的索引：${missing.join(', ')}`);
});

// ── ② 不许描述已经删掉的结构 ─────────────────────────────────────────

test('⚠ README 里提「已删掉的结构」时**必须同时标出那是旧的**', async () => {
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

test('README 必须说清现在是**三条**任务（而不是 25 条 / 12 条）', async () => {
  const p = prose(readme);
  assert.ok(/三条任务|三条\b/.test(p), 'README 没说清现在是三条任务');
  for (const name of ['日常', '兑换', '直播']) {
    assert.ok(p.includes(name), `README 里没提「${name}」这条任务`);
  }
});

test('README 必须说清是**四条**插件，且四条都在', async () => {
  // ⚠ 查**原文**而不是去掉行内代码之后的正文：插件名在表格里是 `` `mcloud-daily` ``，
  //   `prose()` 会把反引号里的内容删掉，于是这里永远找不到（第一版就是这样红的）。
  for (const plugin of ['mcloud', 'mcloud-daily', 'mcloud-exchange', 'mcloud-live']) {
    assert.ok(readme.includes(plugin), `README 里没提插件 ${plugin}`);
  }
  assert.ok(/四条插件/.test(prose(readme)), 'README 没说清现在是四条插件');
});

test('README 要指向设计总纲，且**说清那是历史**（2026-11-26 改口径）', async () => {
  assert.ok(readme.includes('docs/redesign-plan.md'), 'README 没有指向 redesign-plan');
  // ⚠ 那份计划的进度日志停在 2026-10-31，原文却写着"每个会话开始时先读它、唯一事实来源"。
  //   现在它的头注已经改成"历史"，README 那一行也标了「历史」—— 两边必须一致。
  const plan = readFileSync(resolve(root, 'docs/redesign-plan.md'), 'utf8');
  assert.ok(/这份文件现在是\*\*历史\*\*/.test(plan), 'redesign-plan 的头注要标历史');
  const row = readme.split('\n').find((l) => l.includes('docs/redesign-plan.md') && l.startsWith('|'));
  assert.ok(row && row.includes('历史'), `README 那一行要标「历史」：${row}`);
});

// ── ③ 历史文档必须标清是历史 ─────────────────────────────────────────

test('⚠ `docs/design-history.md` 必须在开头就说清「这是历史」（否则和 README 打架）', async () => {
  const hist = readFileSync(resolve(root, 'docs/design-history.md'), 'utf8');
  const head = hist.slice(0, 1200);
  assert.ok(/历史/.test(head), '开头没说这是历史');
  assert.ok(/已经被推翻|被推翻/.test(head), '没说清里面有被推翻的判断');
  assert.ok(head.includes('README.md'), '没指向现状（README）');
  // 那份稿子里"可恢复的步骤机"确实在，但那是在历史文件里 —— 允许
  assert.ok(hist.includes('可恢复的步骤机'), '历史文件应该保留当初的推演');
});

// ── ④ 交叉引用：计划与 README 不能各说各话 ────────────────────────────

test('README 说的任务数，与 `ci_state_check` 断言的条数一致', async () => {
  // 这一条把"文档说的"与"脚本在真面板上断言的"钉在一起 ——
  // 光改文档不改脚本（或反过来）都会红。
  const split = readFileSync(resolve(root, 'scripts/ci_state_check.py'), 'utf8');
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
    split.includes('PLUGINS = ("mcloud", "mcloud-daily", "mcloud-exchange", "mcloud-live")'),
    'ci_state_check 的插件名单与 README 说的四条对不上',
  );
  assert.ok(readme.includes('三条'), 'README 与 split_check 对不上了');
});

// ── ⑤ 用词规则要**可执行**（不然它只是一张纸） ──────────────────────

test('⚠ UI 里不许有**字面 Markdown 标记**（HTML 不渲染它，会原样显示）', async () => {
  // 实测抓到的：`<p class="hint">「提前多少毫秒发」是**你到云端的传输耗时**。</p>`
  // —— 页面上真的显示出了那四个星号。HTML 不是 Markdown，`**` 就是两个字符。
  // ⚠ 截图之前看不出来（静态测试不会"看"页面）—— 这类缺陷只有渲染才暴露。
  const html = readFileSync(new URL('../webui/index.html', import.meta.url), 'utf8');
  // ⚠ HTML 注释里的 `**` 是**给维护者看的**文档，不算（它不会被渲染）
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  const hits = visible.match(/\*\*[^*\n]{1,60}\*\*/g) ?? [];
  assert.deepEqual(hits, [], `可见文本里出现了字面 Markdown：${hits.join(' / ')}`);
});

test('⚠ 界面里不许出现用词规则禁掉的那些词', async () => {
  // `docs/ui-wording.md` 写了规则，但规则写成文档就只是"一张纸" ——
  // 这一版的新界面就是**规则写完才做的**，于是当场踩了四处（`上游` ×4）。
  // 所以把它变成测试：改了界面忘了改用词，这里红。
  const ui = readFileSync(resolve(root, 'webui/index.html'), 'utf8');
  const js = readFileSync(resolve(root, 'webui/app.js'), 'utf8');
  // 去掉注释：HTML 顶部那段注释是**解释旧版毛病**的，里面会提到那些被删掉的词
  const visible = ui.replace(/<!--[\s\S]*?-->/g, '');
  const jsCode = js.replace(/^\s*\/\/.*$/gm, '');

  const banned = ['上游', 'mock', 'budget_ms', '推进一步', '只验证', '换一步'];
  // ⚠ 例外**已经没有了**：2026-11-25 用户要求删掉「上游状态」那个按钮（它只是跳
  //   「数据」区块，而区块导航就在页面顶部）。现在界面上一个「上游」都不许出现 ——
  //   所以这里不再放行，发现谁写回来就是红。
  const stripAllowed = (t: string): string => t;
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

test('用词规则里要求的替代说法，界面上真的有', async () => {
  const ui = readFileSync(resolve(root, 'webui/index.html'), 'utf8');
  // 「上游」要写成「移动云盘」
  assert.ok(ui.includes('移动云盘'), '界面上没出现「移动云盘」—— 那「上游」该叫什么？');
  // 三个动作按钮要说人话
  assert.ok(ui.includes('现在跑一次'), '缺「现在跑一次」');
  assert.ok(ui.includes('贴进去领取'), '缺「贴进去领取」');
  assert.ok(ui.includes('扫码登录'), '缺「扫码登录」');
});

test('用词规则文档自己要与现状一致（不许还写着「高级」那一角）', async () => {
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

test('⚠ 文档里不许让人去找**已经删掉的任务**（比死链更隐蔽的误导）', async () => {
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

test('⚠ 长 token 的容器必须能断行（不然会把整块撑破、下面的文字也不换行）', async () => {
  // 用户圈出来的现象是"说明文字被切在'不受影'那里"。看着像文字被裁，
  // 根因却在**上一行**：`<code class="finger">` 里那串指纹有几十个字符、
  // 中间没有空格 —— 它把容器撑宽，撑宽之后下面那段自然也不换行了。
  //
  // 而 `.finger` 这个类当时**根本没有样式**（写了类名没写规则）——
  // 静态测试钉"id 对得上"是钉不住这种事的，只有真看一眼才发现。
  const css = readFileSync(resolve(root, 'webui/style.css'), 'utf8');
  const rule = /\.finger\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '`style.css` 里没有 `.finger` 规则 —— 长指纹会把容器撑破');
  assert.ok(
    /overflow-wrap:\s*anywhere|word-break:\s*break-all/.test(rule[1] ?? ''),
    `\`.finger\` 必须能断行（参考实现那里是 \`class="break-all"\`）：${rule[1]}`,
  );

  // 而且界面上**只有一个**「换一台设备」——参考实现就只有一个。
  // 曾经挂过第二个「我的码一直扫不出来」（同一个动作、按症状命名），
  // 用户圈出来之后删了。
  const ui = readFileSync(resolve(root, 'webui/index.html'), 'utf8');
  assert.equal(
    (ui.match(/id="device-reset"/g) ?? []).length,
    1,
    '「换一台设备」只能有一个（参考实现只有一个按钮）',
  );
  // ⚠ 只看**可见文字**：那句话在 HTML 注释里还留着（说明它为什么被删），
  //   不剥注释的话这条断言会被自己的说明文案判红。
  const visible = ui.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!visible.includes('我的码一直扫不出来'), '那个按症状命名的第二个按钮已经删了');
});

test('⚠ 文档里提到的 `src/**.ts` 路径必须真的存在（改名/搬家后文档会静默过期）', async () => {
  // 只查**看起来是路径**的片段：`src/…​.ts`，前后不能紧挨着字母数字（否则 `…src/x.ts.bak` 也算）。
  // 说明性文字里偶尔会写"曾经的 `src/foo.ts`"，那种就用反引号包住并加上"曾经"——
  // 这里不做语义判断，凡是写出来的路径都要求存在；要写历史路径就写**不带 `src/` 前缀**的文件名。
  const { readFileSync } = await import('node:fs');
  // ⚠ **只查"当前口径"的文档**：findings / 历史 / 计划类写的是当时那个文件，
  //   要求它们指向现在存在的路径是错的（它们本来就该保留旧路径）。
  const CURRENT = ['README.md', 'docs/architecture.md', 'docs/install.md', 'docs/play-ai.md', 'docs/standalone.md', 'docs/prize-claim.md'];
  const md = CURRENT.filter((f) => {
    try {
      readFileSync(f, 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  const missing: string[] = [];
  for (const f of md) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?<![A-Za-z0-9_./-])src\/[A-Za-z0-9_./-]+\.ts(?![A-Za-z0-9_])/g)) {
      const p = m[0];
      try {
        readFileSync(p, 'utf8');
      } catch {
        missing.push(`${f}: ${p}`);
      }
    }
  }
  assert.deepEqual(missing, [], `这些文档里的代码路径不存在了：\n${missing.join('\n')}`);
});

test('⚠ README「面板为此补了什么」表里的宿主 op 名，必须在同步来的契约里存在', async () => {
  // 2026-11-26 两次踩到同一类：①-1 写 `worker_hint('exclusive')`、①-3 写 `register_nav` ——
  // 那两个都是**旧面板**的 op，新面板一个叫"默认行为"、一个改名叫 `sidebar`。
  // 判据：表格里出现的 `xxx(` 形状的 op，要么在 `types/panel-host.d.ts` 里有，要么这一行
  // 明确写着"旧面板"（历史对照）。
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync('README.md', 'utf8');
  const contract = readFileSync('types/panel-host.d.ts', 'utf8');
  const table = readme.slice(readme.indexOf('| # | 能力 |'), readme.indexOf('## 仓库结构'));
  assert.ok(table.includes('| ①-1 |'), '找不到那张能力表（README 改结构了？）');
  const bad: string[] = [];
  for (const line of table.split('\n')) {
    if (!line.startsWith('| ①-')) continue;
    if (line.includes('旧面板')) continue; // 历史对照，允许写旧名字
    for (const m of line.matchAll(/`([a-z_]+)\(/g)) {
      const op = m[1]!;
      if (!contract.includes(op)) bad.push(`${op}（${line.slice(0, 24)}…）`);
    }
  }
  assert.deepEqual(bad, [], `这些 op 在 types/panel-host.d.ts 里没有：${bad.join('、')}`);
});

test('⚠ `findings.md` 的目录必须是最新的（154 条、8000 行，靠人翻不现实）', async () => {
  const { readFileSync } = await import('node:fs');
  const { buildIndex, START, END } = await import('../scripts/gen-findings-index.mjs');
  const text = readFileSync('docs/findings.md', 'utf8');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  assert.ok(s >= 0 && e > s, '`docs/findings.md` 里没有目录标记（被删了？）');
  const actual = text.slice(s, e + END.length);
  assert.equal(
    actual,
    buildIndex(text),
    '目录过期了 —— 跑 `node scripts/gen-findings-index.mjs` 重生成',
  );
});

test('⚠ README 说"产物提交进仓库"就错了 —— `dist/` 是 gitignore 的', async () => {
  // 2026-11-26 撞到：README 的仓库结构里还写着 `dist/panel-llrt/*.js … 提交进仓库，CI 检查是否最新`，
  // 而 `.gitignore` 里 `dist/` 整条忽略、`git ls-files dist` 是空的，CI 的注释也写着"产物不再提交"。
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync('README.md', 'utf8');
  const ignore = readFileSync('.gitignore', 'utf8');
  assert.ok(/^dist\/$/m.test(ignore), '.gitignore 里应该整条忽略 dist/');
  const line = readme.split('\n').find((l) => l.includes('dist/') && l.includes('提交进仓库'));
  assert.equal(line, undefined, `README 还写着产物提交进仓库：${line}`);
  assert.ok(readme.includes('构建产物（**gitignore，不进仓库**）'), 'README 要写清 dist/ 不进仓库');
});
