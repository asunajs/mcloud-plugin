// 一次领取的**结论**（四栏 + 进账）。
//
// # 这一层守的是什么
//
// 分栏分错的后果不是"显示难看"，而是**排查方向一开始就错**：
//
//   | 上游的码 | 说成什么 | 用户会怎么做 |
//   |---|---|---|
//   | `200108` | 口令无效 | 去重抄口令 ✓ |
//   | `200118` | **本场已结束** | 等下一场 ✓ |
//   | `200118` | ~~口令无效~~ | **去重抄一条本来就对的口令** ✗ |
//   | `200112` | 已领过（不是失败） | 没事 ✓ |
//   | 别的 | 未分类 | 去看原始码 ✓ |
//   | 别的 | ~~口令无效~~ | 触发一次毫无意义的 60 秒重听 ✗ |
//
// 所以这里逐条钉住"哪个码进哪一栏"，以及**进账是 ⑥−① 不是把各口令相加**。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawReport, type DrawState, type DrawRow } from '../src/mcloud/tasks/liveDraw.ts';

function state(rows: Partial<DrawRow>[], extra: Partial<DrawState> = {}): DrawState {
  return {
    step: 'done',
    journalingSent: 0,
    drawIndex: rows.length,
    codes: rows.map((r) => r.code ?? ''),
    results: rows.map((r) => ({
      code: r.code ?? 'C',
      kind: r.kind ?? 'succeeded',
      note: '',
      flowerNum: r.flowerNum ?? 0,
    })),
    startedAt: '2026-10-15T01:00:00.000Z',
    ...extra,
  };
}

test('没有跑过 ⇒ 没有结论（不是"一份空结论"）', () => {
  assert.equal(drawReport(null), null);
});

test('⚠ 四栏分开：领到 / 已领过 / 口令无效 / 本场已结束 / 未分类', () => {
  const r = drawReport(
    state([
      { code: 'A', kind: 'succeeded' },
      { code: 'B', kind: 'already-drawn' },
      { code: 'C', kind: 'invalid-kouling' },
      { code: 'D', kind: 'kouling-expired' },
      { code: 'E', kind: 'other' },
      { code: 'F', kind: 'unparsable' },
    ]),
  )!;
  assert.equal(r.attempted, 6);
  assert.equal(r.succeeded, 1);
  assert.deepEqual(r.alreadyDrawn, ['B'], '已领过不是失败，要单独一栏');
  assert.deepEqual(r.invalid, ['C'], '200108 才是"值得重听一次"的那一栏');
  assert.deepEqual(r.expired, ['D'], '200118 要单独一栏 —— 口令是对的');
  assert.deepEqual(r.other, ['E']);
  assert.deepEqual(r.unparsable, ['F']);
});

test('⚠ `200118`（本场已结束）**不进**「口令无效」那一栏', () => {
  const r = drawReport(state([{ code: 'X', kind: 'kouling-expired' }]))!;
  assert.deepEqual(r.invalid, [], '混进 invalid 会让用户去重抄一条本来就对的口令');
  assert.deepEqual(r.expired, ['X']);
  assert.ok(r.line.includes('本场已经结束'), r.line);
  // 那句话里必须出现"不是口令抄错"（或同义），否则用户还是会去重抄
  assert.ok(/不是口令抄错|口令是对的/.test(r.line), `结论里要说清不是口令的问题：${r.line}`);
});

test('⚠ `other`（没见过的码）**不进**「口令无效」那一栏', () => {
  // 混进去会触发一次毫无意义的 60 秒重听，而且把真正的原因藏起来
  const r = drawReport(state([{ code: 'Z', kind: 'other' }]))!;
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.other, ['Z']);
  assert.ok(r.line.includes('没见过的结果'), r.line);
});

test('⚠ 进账是 **⑥ − ①**，不是把各口令的 `flowerNum` 加起来', () => {
  // 相加会漏掉「首次参与惊喜奖」进账的那几朵 —— 它**不属于任何一个口令**，
  // 而那正是"总数对不上"最常见的来源。
  const r = drawReport(
    state([{ code: 'A', kind: 'succeeded', flowerNum: 10 }], {
      balanceBefore: 120,
      balanceAfter: 135, // 领到 10 朵 + 惊喜奖 5 朵
    }),
  )!;
  assert.equal(r.gained, 15, '进账必须是余额差（15），不是口令的 flowerNum 之和（10）');
  assert.equal(r.succeeded, 1);
  assert.ok(r.line.includes('进账 15 朵'), r.line);
  assert.ok(r.line.includes('120 → 135'), r.line);
});

test('读数缺一半时不瞎报进账（宁可不显示也不要报一个错的数）', () => {
  assert.equal(drawReport(state([], { balanceBefore: 100 }))!.gained, 0);
  assert.equal(drawReport(state([], { balanceAfter: 100 }))!.gained, 0);
  // 只有两边都在才有意义
  assert.equal(drawReport(state([], { balanceBefore: 100, balanceAfter: 120 }))!.gained, 20);
});

test('一条口令都没发出去时说"还没发出口令"，不说"领到 0 条"', () => {
  // 两者含义不同：前者是"没开始/没口令"，后者是"发了但都没成"
  const r = drawReport(state([]))!;
  assert.equal(r.attempted, 0);
  assert.ok(r.line.includes('还没发出口令'), r.line);
});

test('全部领到时结论简短（别把四栏都写成"0 条"）', () => {
  const r = drawReport(
    state(
      [
        { code: 'A', kind: 'succeeded' },
        { code: 'B', kind: 'succeeded' },
      ],
      { balanceBefore: 10, balanceAfter: 30 },
    ),
  )!;
  assert.equal(r.succeeded, 2);
  assert.ok(!r.line.includes('无效'), r.line);
  assert.ok(!r.line.includes('已经结束'), r.line);
  assert.ok(r.line.includes('2 条口令领到 2 条'), r.line);
});

test('同一份状态永远给同一份结论（纯函数）', () => {
  const s = state([{ code: 'A', kind: 'invalid-kouling' }], { balanceBefore: 1, balanceAfter: 1 });
  assert.deepEqual(drawReport(s), drawReport(s));
});
