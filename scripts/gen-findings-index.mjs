#!/usr/bin/env node
// 给 `docs/findings.md` 生成**目录**（F-编号 + 标题）。
//
// 为什么需要：那份文件已经 8000 多行、150+ 条。想查"某个坑以前记过没有"，
// 只能全文搜 —— 而搜到之后还得自己判断哪条是当时那条。
//
// 用法：
//   node scripts/gen-findings-index.mjs          # 重写文件里的目录
//   node scripts/gen-findings-index.mjs --check   # 只检查（CI / 测试用），不一致就非零退出
//
// ⚠ 目录写在两个标记之间，**别手改那一段** —— 手改会被下一次生成覆盖，
//   而且 `test/docs.test.ts` 会红（它跑的就是这里的 `buildIndex`）。

import fs from 'node:fs';

export const START = '<!-- FINDINGS-INDEX:START -->';
export const END = '<!-- FINDINGS-INDEX:END -->';

/** 从正文里抽 `## F-xxx 标题`，生成一段 markdown 目录。 */
export function buildIndex(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^## (F-\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    // 标题里的 `|` 会把表格撑坏，转义一下
    rows.push(`| ${m[1]} | ${m[2].replace(/\|/g, '\\|')} |`);
  }
  const lines = [
    START,
    '',
    '## 目录（脚本生成，别手改）',
    '',
    `共 ${rows.length} 条。改标题后跑 \`node scripts/gen-findings-index.mjs\` 重生成。`,
    '',
    '| 编号 | 标题 |',
    '| --- | --- |',
    ...rows,
    '',
    END,
  ];
  return lines.join('\n');
}

/** 把目录写回正文（替换已有那段；没有就插在第一个 `## F-` 之前）。 */
export function withIndex(text) {
  const block = buildIndex(text);
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s >= 0 && e > s) return text.slice(0, s) + block + text.slice(e + END.length);
  const at = text.indexOf('\n## F-');
  if (at < 0) throw new Error('找不到第一条 `## F-`，这份文件的结构变了');
  return text.slice(0, at) + '\n' + block + '\n' + text.slice(at);
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-findings-index.mjs');
if (isMain) {
  const file = 'docs/findings.md';
  const before = fs.readFileSync(file, 'utf8');
  const after = withIndex(before);
  if (process.argv.includes('--check')) {
    if (before !== after) {
      console.error('✗ docs/findings.md 的目录不是最新的 —— 跑 `node scripts/gen-findings-index.mjs`');
      process.exit(1);
    }
    console.log('ok: 目录是最新的');
  } else {
    fs.writeFileSync(file, after);
    const n = (after.match(/^\| F-\d+/gm) || []).length;
    console.log(`✅ 目录已重生成（${n} 条）`);
  }
}
