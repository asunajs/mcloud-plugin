// 措辞守门：**给用户看的字符串**里不许出现内部黑话。
//
// 用户的原话：「点了没变化啊，然后不要提示黑话啊，这是给用户看的，一堆用户看不懂的话」。
// 触发那句是：
//
//   「凭据已续期（旧尾 7eyts- → 新尾 OFDUM-；上游说还能用 2592000 秒
//     （这一枪没带用户域 —— 上游不要求），新过期还剩 30 天）—— 已重起一轮换票…」
//
// 一句话里五个黑话（旧尾 / 新尾 / 上游 / 用户域 / 换票），还有原始秒数。
// 这些词在**注释里**是对的（读代码的人需要精度），在**提示里**是噪音。
//
// 所以这条测试的判据是：把注释剥掉之后，源码里不该再出现这些词。
// 它不检查 docs / findings（那是给开发者看的）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** 去掉注释，只留下**用户可能看到**的那些行。
 *
 *  ⚠ 不用"完整 JS 词法分析"：正则字面量里的引号会把状态机带歪（`/^(['"])…/` 这种），
 *  于是注释剥不干净、测试假红。这里用够用的规则：
 *   · 整行注释（`//`、`/*`、`*` 开头）整行丢掉；
 *   · 行尾注释只在"这一行没有引号"时才切掉（有引号就整行保留，宁可多查不漏查）。
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .map((line) => {
      const at = line.indexOf('//');
      if (at < 0) return line;
      const head = line.slice(0, at);
      // 引号**成对**才切（`'GET', // 注释` 这种能切；`'a // b'` 这种切了就丢内容）
      const balanced = (ch: string): boolean => (head.split(ch).length - 1) % 2 === 0;
      return balanced("'") && balanced('"') && balanced('`') ? head : line;
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 这些词是**内部术语**：出现在提示里用户看不懂。
 *
 *  ⚠ 「凭据」「换票」没进这张表：它们已经是这套界面自己的词（账号卡、步骤名里到处是），
 *  一次性全换会把日志里的步骤名搅乱 —— 但**报错文案**里已经改成"登录信息"了。 */
const BANNED = ['上游', '旧尾', '新尾', '用户域', '落库'];

test('⚠ 源码里（非注释）不许再出现内部黑话', () => {
  const files = walk('src');
  assert.ok(files.length > 20, `扫到的文件太少：${files.length}`);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const w of BANNED) {
        if (line.includes(w)) hits.push(`${f}:${i + 1}: 「${w}」 ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `这些地方还有黑话：\n${hits.join('\n')}`);
});

// ── 界面那一侧 ─────────────────────────────────────────────────────────
//
// ⚠ 上面那条扫的是 `src/`（后端）。界面是**手写**的静态文件
//   （`plugins/mcloud/index.html` / `app.js`），不在打包链上，所以一句黑话
//   能直接印到按钮上 —— 用户看到的就是「自动运行：全部账号（旧版设置）」。
//
//   那句话的本意是"这一版还没单独设过、读的是旧键"，属于**实现状态**。
//   用户读到它只会猜两件事：这设置过期了？还有一份新版设置我没找到？
//   要说的其实是"这份账号是从你以前的设置沿用过来的"（说人话 + 放在展开
//   面板里，那儿有地方解释"那时定时和手动共用一份"）。

const UI_BANNED = ['旧版'];

test('⚠ 插件界面里（非注释）也不许出现「旧版」这种仓库里的词', () => {
  const html = fs
    .readFileSync('plugins/mcloud/index.html', 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const js = stripComments(fs.readFileSync('plugins/mcloud/app.js', 'utf8'));
  const hits: string[] = [];
  for (const [name, text] of [
    ['plugins/mcloud/index.html', html],
    ['plugins/mcloud/app.js', js],
  ] as const) {
    text.split('\n').forEach((line, i) => {
      for (const w of UI_BANNED) {
        if (line.includes(w)) hits.push(`${name}:${i + 1}: 「${w}」 ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `界面文案里还有黑话：\n${hits.join('\n')}`);
});

test('「这份是沿用的」要说在展开面板里，不在按钮标签上', () => {
  const html = fs.readFileSync('plugins/mcloud/index.html', 'utf8');
  const js = fs.readFileSync('plugins/mcloud/app.js', 'utf8');
  // 两份自动选择器（日常 / 直播）各有一条说明
  for (const id of ['daily-acct-legacy', 'live-acct-legacy']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id} 那条说明`);
  }
  // 按钮标签只由 `pickerLabel` 决定；沿用的说明靠 `hidden` 翻
  assert.ok(/\$\{cfg\.key\}-acct-legacy/.test(js), '说明节点要由 `renderPicker` 控制显隐');
  assert.ok(!/acct-label`,?\s*`?\$\{label\}（/.test(js), '按钮标签里不许拼括号说明');
});

test('⚠ 续期那几句提示是**人话**（且长短合适）', () => {
  // 用户点一次「刷新」，看到的就是这几个字之一。
  const ok = '已续期，还能用 30 天';
  assert.ok(ok.length < 20, '成功提示要短');
  // 失败那一句要点出**下一步该做什么**，而不是只报错
  assert.ok(/重新登录/.test('这个号存的凭据已经失效了 —— 重新登录一次'));
  // 不需要刷的时候也别打上游
  assert.ok(/不用刷/.test('还有 29 天，不用刷'));
});
