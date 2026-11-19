// 验证阶段领到的账要并进「领取」那一段 —— 否则日志会说反话。
//
// 2026-11-19 现场：小号在收口令阶段被拿去验了两条口令（310→315、315→320，
// 共 10 朵），到领取那一段状态机已 `done`、一步不发，于是日志写
// 「本次没发请求 —— 这一轮已跑完（进账 5 朵 (315 → 320)）」—— 只报了最后一次，
// 收尾还算成「2/3 个账号好了」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVerifiedClaims, type DrawResult } from '../src/app/live/mergeVerified.ts';
import { lineLevel } from '../src/mcloud/tasks/stepLog.ts';

function idleResult(): DrawResult {
  const note = '本次没发请求 —— 这一轮已跑完（1 条口令领到 1 条 · 进账 5 朵 (315 → 320)）';
  return {
    steps: [
      { name: '凭据续期', ok: true, note: '不用续', idle: true },
      { name: '领小红花', ok: true, note, idle: true },
    ],
    detail: ['凭据续期：不用续', '领小红花：' + note],
    ok: true,
    note,
    didWork: false,
  };
}

test('验证时领过 ⇒ 改写成真结论，并算作做了事', () => {
  const r = idleResult();
  const changed = mergeVerifiedClaims(r, { codes: ['云盘AI助力办公', '下单赢实用好礼'], gained: 10 });
  assert.equal(changed, true);
  assert.equal(r.didWork, true, '领过就是做了事（否则收尾会算成没成）');
  assert.match(r.note, /验证时领到 2 条/, '要说出几条（「领到」才判成功绿）');
  assert.match(r.note, /进账 10 朵/, '要说出这一趟真正进账多少（不是最后一次的 5）');
  // 「没发请求」那条被换掉，不留两条互相打脸的结论
  const claim = r.steps.filter((s) => s.name === '领小红花');
  assert.equal(claim.length, 1, '领小红花只该有一条');
  assert.equal(claim[0]?.idle, false, '这是真结果，不是灰色跳过');
  assert.equal(claim[0]?.ok, true);
  assert.ok(r.detail.some((l) => l.includes('验证时领到')), '明细也要跟着换');
  assert.ok(!r.detail.some((l) => l.includes('本次没发请求')), '不能还留着「没发请求」');
  // ⚠ 措辞必须让 `lineLevel` 判成 success（绿）：真进账了却涂成灰色，
  //   用户会以为什么都没发生（2026-11-19 现场：「已领」被判成 debug）。
  assert.equal(lineLevel('领小红花：' + r.note), 'success', '领到了就该是绿色');
});

test('验证时没真领到 ⇒ 一个字都不改（「没做事」要照实说）', () => {
  const r = idleResult();
  assert.equal(mergeVerifiedClaims(r, { codes: [], gained: 0 }), false);
  assert.equal(r.didWork, false);
  assert.match(r.note, /本次没发请求/);
  assert.equal(mergeVerifiedClaims(r, undefined), false);
  assert.equal(r.didWork, false);
});

test('领取阶段自己发过请求 ⇒ 不覆盖它的真结果', () => {
  const r: DrawResult = {
    steps: [{ name: '领小红花', ok: true, note: '2 条口令领到 2 条 · 进账 10 朵 (100 → 110)', idle: false }],
    detail: [],
    ok: true,
    note: '2 条口令领到 2 条 · 进账 10 朵 (100 → 110)',
    didWork: true,
  };
  assert.equal(mergeVerifiedClaims(r, { codes: ['甲'], gained: 5 }), false);
  assert.match(r.note, /2 条口令领到 2 条/, '原来的结果不能被验证那一段盖掉');
});

test('算不出进账就不硬编一个数', () => {
  const r = idleResult();
  assert.equal(mergeVerifiedClaims(r, { codes: ['甲'], gained: 0 }), true);
  assert.match(r.note, /验证时已领 1 条/);
  assert.ok(!r.note.includes('进账'), '没数就别写「进账 0 朵」');
  // 没进账 ⇒ 灰色（过程信息），别假装这次又领了一次
  assert.equal(lineLevel('领小红花：' + r.note), 'debug');
});
