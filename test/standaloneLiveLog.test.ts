// CLI 的领取日志 —— **照 mcloud-sign 的句子**，不是面板那套。
//
// 面板那套（`entries/live.ts`）是「口令「X」没领到：…」+ 条数/进账；
// 这里是 `mcloud-sign` 的 `drawRedFlowerForAccount` 原话，
// 所以逐字钉住，别让后来的“顺手统一”把 CLI 改成面板的形状。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawLogLines } from '../src/standalone/liveLog.ts';
import type { DrawRow, DrawState } from '../src/mcloud/tasks/liveDraw.ts';

function state(rows: Partial<DrawRow>[], extra: Partial<DrawState> = {}): DrawState {
  return {
    step: 'done',
    journalingSent: 5,
    drawIndex: rows.length,
    codes: rows.map((r) => r.code ?? ''),
    results: rows.map((r) => ({
      code: r.code ?? 'C',
      kind: r.kind ?? 'succeeded',
      note: '',
      flowerNum: r.flowerNum ?? 0,
      ...r,
    })),
    startedAt: '2026-10-15T01:00:00.000Z',
    ...extra,
  };
}

test('没有状态 ⇒ 一行都不说', () => {
  assert.deepEqual(drawLogLines(null), []);
});

test('照 mcloud-sign：当前红花 / 首次参与 / 逐条 / 复活花 / 最终红花', () => {
  const lines = drawLogLines(
    state(
      [
        { code: 'A', kind: 'succeeded', flowerNum: 5, prizeName: '小红花' },
        { code: 'B', kind: 'already-drawn' },
        { code: 'C', kind: 'invalid-kouling', message: '口令无效', envCode: 200108 },
        { code: 'D', kind: 'kouling-expired', message: '口令已失效', envCode: 200118 },
        { code: 'E', kind: 'other', message: '活动没开始', envCode: 200199 },
        { code: 'F', kind: 'unparsable' },
      ],
      {
        balanceBefore: 120,
        balanceAfter: 128,
        firstParticipateCode: 0,
        firstParticipateNum: 3,
        revival: 0,
      },
    ),
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      '当前红花：120',
      '首次参与惊喜奖，获得 3 朵小红花',
      '口令「A」领取成功，获得 5 朵（小红花）',
      '口令「B」已兑换过',
      '口令「C」：口令无效 (code: 200108)',
      '口令「D」：口令已失效 (code: 200118)',
      '口令「E」：活动没开始 (code: 200199)',
      '口令「F」响应异常，跳过',
      '复活花：0',
      '最终红花：128（+8）',
    ],
  );
  // 成功那几条才绿；解不出来的那条是 warn；其余是 info。
  assert.deepEqual(
    lines.map((l) => l.level),
    ['info', 'success', 'success', 'info', 'info', 'info', 'info', 'warn', 'info', 'info'],
  );
});

test('首次参与已参与过（200110）不打印；最终 +N 是首次 + 各条成功，不是余额差', () => {
  const lines = drawLogLines(
    state(
      [
        { code: 'A', kind: 'succeeded', flowerNum: 5, prizeName: '小红花' },
        { code: 'B', kind: 'succeeded', flowerNum: 7, prizeName: '小红花' },
      ],
      {
        balanceBefore: 100,
        // 余额只涨了 10（异常场次）：`+N` 仍照 mcloud-sign 累加 5+7
        balanceAfter: 110,
        firstParticipateCode: 200110,
        firstParticipateNum: undefined,
        revival: 2,
      },
    ),
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      '当前红花：100',
      '口令「A」领取成功，获得 5 朵（小红花）',
      '口令「B」领取成功，获得 7 朵（小红花）',
      '复活花：2',
      '最终红花：110（+12）',
    ],
  );
});

test('首次参与回了别的码 ⇒ 照 mcloud-sign 说「首次参与奖：原话」', () => {
  const lines = drawLogLines(
    state([], {
      balanceBefore: 0,
      balanceAfter: 0,
      firstParticipateCode: 200101,
      firstParticipateMessage: '活动未开始',
      revival: 0,
    }),
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      '当前红花：0',
      '首次参与奖：活动未开始',
      '复活花：0',
      '最终红花：0（+0）',
    ],
  );
});

test('没有奖品名时不硬编括号；成功那行仍和 mcloud-sign 同一句', () => {
  const lines = drawLogLines(
    state([{ code: 'A', kind: 'succeeded', flowerNum: 5 }], {
      balanceBefore: 0,
      balanceAfter: 5,
      firstParticipateCode: 200110,
      revival: 0,
    }),
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      '当前红花：0',
      '口令「A」领取成功，获得 5 朵',
      '复活花：0',
      '最终红花：5（+5）',
    ],
  );
});
