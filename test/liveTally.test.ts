// 直播收尾统计：按账号算，并按「没领到」的原因分档。
//
// 用户口径 2026-11-19：「**已经领取过不是错误；没有口令、口令错误才是错误**」。
// 现场：3 个号跑一趟，2 个领到、1 个今天已经领过 —— 卡片写「2/3 个账号好了」的 WARN，
// 读起来像有一个号坏了，其实那一个号只是**没得领**（正常收尾）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveTally } from '../src/app/live/tally.ts';

/** 真领到了 */
const worked = { ok: true, note: '2 条口令领到 2 条 · 进账 10 朵 (100 → 110)', didWork: true };
/** 已经领过（正常收尾） */
const already = {
  ok: true,
  note: '本次没发请求 —— 这一轮已跑完（1 条口令领到 1 条 · 进账 5 朵）；口令没变，不重复领',
  didWork: false,
};
/** 没有口令（错误） */
const noCode = {
  ok: true,
  note: '本次没发请求 —— 没有口令可领（池里 0 条 / 这个号能领 0 条）—— 先抓主页或把口令填进输入框',
  didWork: false,
};
/** 口令无效（错误） */
const invalid = { ok: true, note: '本次没发请求 —— 口令无效（200108）', didWork: false };

test('三个号都领到 ⇒ N/N 好了，绿色', () => {
  const t = liveTally([worked, worked, worked]);
  assert.equal(t.level, 'success');
  assert.equal(t.text, '直播完成：3/3 个账号好了');
  assert.deepEqual([t.worked, t.already, t.bad], [3, 0, 0]);
});

test('两个领到 + 一个已经领过 ⇒ 仍然 3/3 好了（不是 2/3 的警告）', () => {
  const t = liveTally([worked, worked, already]);
  assert.equal(t.level, 'success', '已经领过不是错误');
  assert.equal(t.text, '直播完成：3/3 个账号好了（1 个已经领过）');
  assert.deepEqual([t.worked, t.already, t.bad], [2, 1, 0]);
});

test('三个都已经领过 ⇒ 普通信息，不是警告', () => {
  const t = liveTally([already, already, already]);
  assert.equal(t.level, 'info');
  assert.equal(t.text, '直播：3 个账号都领过了，本次不用领');
});

test('没有口令 ⇒ 警告（用户口径：这才是错误）', () => {
  const t = liveTally([noCode, noCode, noCode]);
  assert.equal(t.level, 'warn');
  assert.match(t.text, /都没领/);
  assert.match(t.text, /没有口令可领/, '原因要说出来');
});

test('口令无效 ⇒ 警告', () => {
  const t = liveTally([invalid, invalid]);
  assert.equal(t.level, 'warn');
  assert.match(t.text, /口令无效/);
});

test('一个领到 + 两个没口令 ⇒ 1/3 好了 + 警告', () => {
  const t = liveTally([worked, noCode, noCode]);
  assert.equal(t.level, 'warn');
  assert.equal(t.text, '直播完成：1/3 个账号好了（2 个没成）');
});

test('⚠ 一步没做（票坏了/状态机卡住）不算好了', () => {
  // 2026-11-16 现场：三个号一步没做，日志却写「3/3 个账号好了」。
  // 那种原因落在 `other`（既不是已领过，也不是没口令），必须算没成。
  const stuck = { ok: true, note: '领小红花：走到时间上限（16166ms / 0 步），下一次接着走', didWork: false };
  const t = liveTally([stuck, stuck, stuck]);
  assert.equal(t.level, 'warn');
  assert.equal(t.worked, 0);
  assert.equal(t.already, 0);
  assert.equal(t.bad, 3);
});

test('⚠ 真失败（发了请求但没成）不许算好了', () => {
  // `didWork` 只说明「发了请求」，`ok: false` 才是失败本身 ——
  // 只看 didWork 会把 HTTP 500 那种算成「好了」（假绿灯）。
  const failed = { ok: false, note: '领小红花：第 5 步失败 —— code=500 msg=服务开小差', didWork: true };
  const t = liveTally([worked, failed, already]);
  assert.equal(t.level, 'warn');
  assert.equal(t.worked, 1);
  assert.equal(t.already, 1);
  assert.equal(t.bad, 1);
  assert.equal(t.text, '直播完成：2/3 个账号好了（1 个没成）');
});

test('空列表不抛', () => {
  assert.equal(liveTally([]).level, 'info');
});
