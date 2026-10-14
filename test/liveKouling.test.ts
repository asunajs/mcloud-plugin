// 直播口令提取 —— 对着**黄金向量**逐条比对。
//
// 这 41 条（弹幕 36 + 小红书 5）的期望值出自**原项目 TS 源码真跑**
// （上游 `$source` 字段记着生成方式），不是手写的。所以：
//
//   ⚠ 任何一条不一致都当 **bug** 处理 —— **改实现，不改期望值**。
//
// 上游那份向量文件自己也记着一段教训：这两段**一度**是手写期望值，
// 结果与真实现不符。手写"我觉得应该是这样"的期望值等于没测。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_CODE_CHARS,
  extractKouling,
  extractKoulingFromXiaohongshuHtml,
  isKoulingHead,
  isQuestion,
  parseCodeInput,
  trimKoulingTail,
} from '../src/mcloud/liveKouling.ts';

interface KoulingVector {
  name: string;
  text: string;
  why: string;
  expect: string[];
}
interface XhsVector {
  name: string;
  html: string;
  why: string;
  expect: string[];
}
interface Fixture {
  $source: string;
  $sha256: string;
  koulingExtract: KoulingVector[];
  xiaohongshuExtract: XhsVector[];
}

const V = JSON.parse(
  readFileSync(new URL('./fixtures/live-room-vectors.json', import.meta.url), 'utf8'),
) as Fixture;

test('黄金向量：弹幕提取 36 条逐条一致', () => {
  assert.equal(V.koulingExtract.length, 36, '向量条数变了 —— 先确认夹具是不是被换过');
  const bad: string[] = [];
  for (const v of V.koulingExtract) {
    const got = extractKouling(v.text);
    if (JSON.stringify(got) !== JSON.stringify(v.expect)) {
      bad.push(`  ✗ ${v.name}（${v.why}）\n    输入 ${JSON.stringify(v.text)}\n    期望 ${JSON.stringify(v.expect)}\n    实得 ${JSON.stringify(got)}`);
    }
  }
  assert.equal(bad.length, 0, `\n有 ${bad.length} 条与黄金向量不一致：\n${bad.join('\n')}`);
});

test('黄金向量：小红书主页提取 5 条逐条一致', () => {
  assert.equal(V.xiaohongshuExtract.length, 5);
  const bad: string[] = [];
  for (const v of V.xiaohongshuExtract) {
    const got = extractKoulingFromXiaohongshuHtml(v.html);
    if (JSON.stringify(got) !== JSON.stringify(v.expect)) {
      bad.push(`  ✗ ${v.name}（${v.why}）\n    期望 ${JSON.stringify(v.expect)}\n    实得 ${JSON.stringify(got)}`);
    }
  }
  assert.equal(bad.length, 0, `\n有 ${bad.length} 条与黄金向量不一致：\n${bad.join('\n')}`);
});

// ── 下面这几条钉的是"看着像瑕疵、其实是契约"的地方。
//    黄金向量里没有这些形状（或只覆盖了一半），所以单独立几条 —— 免得后人"顺手改进"。

test('契约：`口令是相伴什么` 仍被解成口令（假阳性是刻意的）', () => {
  // `相伴什么` 去语气词后不等于表里任何疑问词 ⇒ 不是提问。
  // 实拍弹幕里真有这一条，黄金向量的 live-false-positive 钉住了它。
  assert.deepEqual(extractKouling('口令是相伴什么'), ['相伴什么']);
});

test('契约：`口令1:A口令2:B`（无空白）**不切分**，整段算一条', () => {
  // 那个前瞻要求 `\s+`，没空白就不算下一个头。Rust 侧为此专门记了一段
  // （Go 参考实现按 `pos = headEnd` 推进，会多解出一条 `B`）。
  // 在 JS 里用原式就没有这个问题 —— 这条测试守住"没有为了好看去切分它"。
  assert.deepEqual(extractKouling('口令1:A口令2:B'), ['A口令2:B']);
});

test('契约：`小红花口令：AAA 无随机` ⇒ **去尾巴后两条分支给同一条，去重后一条**', () => {
  // ⭐ 提取逻辑的**优化**（2026-10-14 实机 + 用户口径）：末尾的收批标记要去掉。
  //   原来的逻辑会解出 `AAA 无随机` 那条，拿去领白跑一枪（200108）—— 那不是"另一种实现"，
  //   是**多了一条错的口令**。
  assert.deepEqual(extractKouling('小红花口令：AAA 无随机'), ['AAA']);
});

test('契约：观众的提问要被滤掉（否则每次都白跑一枪 200108）', () => {
  assert.deepEqual(extractKouling('口令是什么？'), []);
  assert.deepEqual(extractKouling('口令是啥'), []);
  assert.deepEqual(extractKouling('第2个口令是多少'), []);
  assert.deepEqual(extractKouling('口令是什么'), [], '整句走格式 3 解出 `什么` ⇒ 被滤掉');
  // ⚠ 判据作用在**解出来的候选**上，不是整句话 —— 这条很容易写反方向
  assert.equal(isQuestion('什么'), true);
  assert.equal(isQuestion('口令是什么'), false, '整句不等于任何疑问词');
  assert.equal(isQuestion('相伴什么'), false, '判据是"整条相等"，不是"包含"');
  assert.equal(isQuestion('口令是带着云盘去上学'), false, '别把真口令误伤成提问');
});

test('全角空格（U+3000）要当空白：`口令1：AAA　口令2：BBB` 解出两条', () => {
  // 这是 JS 的 `\s` 与 Rust `regex` 的 `\s` 的差别。Rust 那边要手写字符类，
  // 在 JS 里是白拿的 —— 但**得有人守住它**，否则哪天有人把 `\s` 换成 `[ \t]` 就静默坏了。
  assert.deepEqual(extractKouling('口令1：AAA\u3000口令2：BBB'), ['AAA', 'BBB']);
});

test('越界实体不炸整页（唯一一处刻意偏离原 TS）', () => {
  // 原 TS 的 String.fromCodePoint(1114112) 会抛 RangeError ⇒ 整次提取失败。
  // 这里保留原文，因为不对称：保留原文最多多一个解不出口令的候选，
  // 抛异常则会把整页的真口令一起丢掉。
  const html = '<div>&#1114112; 小红花口令：最新一期口令在此</div>';
  assert.deepEqual(extractKoulingFromXiaohongshuHtml(html), ['最新一期口令在此']);
});

test('整行只是口令头 ⇒ 取下一行；下一行自己也是头就跳过', () => {
  assert.equal(isKoulingHead('复制口令1：'), true);
  assert.equal(isKoulingHead('  口令：  '), true, '两边都 trim 过');
  assert.equal(isKoulingHead('口令1：AAA'), false, '这行自带内容，不是"整行是头"');
  assert.deepEqual(extractKouling('复制口令1：\n复制口令2：\n短漫上新免费看'), ['短漫上新免费看']);
});

// ── 输入口（人给的口令）

test('输入口：贴弹幕原文 ⇒ 按弹幕格式解出', () => {
  const r = parseCodeInput('复制口令1：短漫上新免费看\n无随机口令');
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['短漫上新免费看']);
  assert.match(r.how, /弹幕格式/);
});

test('输入口：贴裸口令（人从页面抄的，没有任何格式）⇒ 原样收下', () => {
  const r = parseCodeInput('云盘AI高效复盘');
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['云盘AI高效复盘']);
  assert.match(r.how, /原文/);
});

test('输入口：多行裸口令 ⇒ 逐行收下并去重', () => {
  const r = parseCodeInput('云盘AI高效复盘\n短漫上新免费看\n云盘AI高效复盘');
  assert.deepEqual(r.codes, ['云盘AI高效复盘', '短漫上新免费看']);
});

test('输入口：拒绝提问（否则存进去只会换回 200108）', () => {
  for (const q of ['口令是什么', '口令是什么？', '第2个口令是多少', '口令是啥']) {
    const r = parseCodeInput(q);
    assert.equal(r.ok, false, `${q} 应该被挡下`);
    assert.deepEqual(r.codes, []);
    assert.match(r.error ?? '', /提问/);
  }
});

test('输入口：剥前缀只剥"第N个口令(是|：)"，别把真口令剥残', () => {
  // `口令红包雨` 是（假想的）真口令 —— 剥多了会变成 `红包雨` 并被误判成提问
  const r = parseCodeInput('口令红包雨');
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['口令红包雨']);
});

test('输入口：空、超长、超条数都要挡住并说清原因', () => {
  assert.equal(parseCodeInput('   ').ok, false);
  const long = parseCodeInput('阿'.repeat(MAX_CODE_CHARS + 1));
  assert.equal(long.ok, false);
  assert.match(long.error ?? '', new RegExp(String(MAX_CODE_CHARS)));
  const many = parseCodeInput(Array.from({ length: 11 }, (_, i) => `口令${i}`).join('\n'));
  assert.equal(many.ok, false);
  assert.match(many.error ?? '', /最多/);
});


test('末尾的收批标记要去掉：` 无` / ` 无随机` / `无随机口令`', () => {
  // ⚠ 2026-10-14 实机：真收到过 `秋游影集轻松做 无`，当时被当成口令去领 ⇒ 上游回 200108。
  //   三种形态都在一个出口处理（`extractKouling` 收尾那一步），分支再多也不会漏。
  const cases: Array<[string, string]> = [
    ['小红花口令：秋游影集轻松做 无', '秋游影集轻松做'],
    ['小红花口令：秋游影集轻松做 无随机', '秋游影集轻松做'],
    ['小红花口令：秋游影集轻松做无随机口令', '秋游影集轻松做'],
    // 叠写（收尾标记被转述两次）也要去干净
    ['口令是秋游美好存云盘 无随机 无', '秋游美好存云盘'],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(extractKouling(input), [want], `输入「${input}」`);
  }
  assert.equal(trimKoulingTail('秋游影集轻松做 无'), '秋游影集轻松做');
  assert.equal(trimKoulingTail('秋游影集轻松做无随机口令'), '秋游影集轻松做');
  // 只余标记 ⇒ 空串（会被滤掉，不当口令）
  assert.equal(trimKoulingTail('无随机'), '');
  assert.equal(trimKoulingTail(' 无'), '');
});

test('⚠ 不误伤"尾字本身是无"的真口令（`无` 那条**要求前面有空白**）', () => {
  // 这种错不会报错，只会安静地换回 200108 —— 所以判据宁可窄一点。
  assert.equal(trimKoulingTail('相伴到永远无'), '相伴到永远无');
  assert.deepEqual(extractKouling('口令是相伴到永远无'), ['相伴到永远无']);
});

test('人贴进来的那一路（逐行原文）也要去尾巴', () => {
  const r = parseCodeInput('秋游影集轻松做 无\n秋游美好存云盘');
  assert.deepEqual(r.codes, ['秋游影集轻松做', '秋游美好存云盘'], JSON.stringify(r));
});
