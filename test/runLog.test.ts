// 「一次运行」的记录。
//
// # 这一层守的是**有界**
//
// 运行记录落在 `state` 表的一格里（一整行 JSON）。不设上限的话：
// 跑得多了这行会涨到几 MB，而**每次读它都要整段解析** ⇒ 界面越用越慢，
// 最后打不开。所以三条上限都是刻意的：每次留 N 条、每条最多 M 步、每句话截 K 字。
//
// 这类 bug 不会在开发时出现（开发时只有几条记录），只会在用户跑了两周之后出现 ——
// 所以只能靠测试钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NOTE,
  MAX_STEPS,
  RUNS_PER_TASK,
  appendRun,
  readRun,
  readRuns,
  readRunsOf,
  recentRuns,
} from '../src/mcloud/runLog.ts';
import type { Store } from '../src/store/types.ts';

function memStore(): Store {
  const m = new Map<string, string>();
  return {
    getState: (k: string) => m.get(k) ?? null,
    setState: (k: string, v: string) => void m.set(k, v),
  } as unknown as Store;
}

const step = (name: string, ok = true, idle = false) => ({ name, ok, note: `${name} 的结果`, idle });

function add(
  s: Store,
  task: 'daily' | 'exchange' | 'live',
  at: string,
  extra: { ok?: boolean; steps?: ReturnType<typeof step>[]; note?: string; ms?: number } = {},
): string {
  return appendRun(s, {
    task,
    at,
    ms: extra.ms ?? 1000,
    ok: extra.ok ?? true,
    note: extra.note ?? '跑完了',
    steps: extra.steps ?? [step('签到')],
  });
}

test('没有记录 ⇒ 空数组（不是 null）', () => {
  assert.deepEqual(readRuns(memStore()), []);
  assert.deepEqual(readRunsOf(memStore(), 'daily'), []);
  assert.equal(recentRuns(memStore(), 'daily').length, 0);
});

test('追加一条，能按 id 找回来', () => {
  const s = memStore();
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z');
  const r = readRun(s, id);
  assert.ok(r);
  assert.equal(r.task, 'daily');
  assert.equal(r.steps.length, 1);
  assert.equal(r.ok, true);
  assert.equal(readRun(s, 'daily-不存在'), null, '找不到给 null，不是空对象');
});

test('⚠ 只留最近 N 次（否则那一行会涨到几 MB，读一次就要全解析）', () => {
  const s = memStore();
  for (let i = 0; i < RUNS_PER_TASK + 7; i++) {
    // 每次隔一分钟，保证时刻单调
    const at = new Date(Date.parse('2026-10-15T00:00:00.000Z') + i * 60_000).toISOString();
    add(s, 'daily', at, { note: `第 ${i} 次` });
  }
  const runs = readRunsOf(s, 'daily');
  assert.equal(runs.length, RUNS_PER_TASK, `应该只剩 ${RUNS_PER_TASK} 条`);
  // 留下的是**最新**的那些
  assert.equal(runs[0]!.note, `第 ${RUNS_PER_TASK + 6} 次`, '最新的要在最前');
  assert.ok(!runs.some((r) => r.note === '第 0 次'), '最旧的要被挤掉');
});

test('⚠ 保留是**按任务**算的（日常跑得少，不该被兑换挤掉）', () => {
  const s = memStore();
  // 日常 3 条
  for (let i = 0; i < 3; i++) {
    add(s, 'daily', new Date(Date.parse('2026-10-15T00:00:00.000Z') + i * 60_000).toISOString());
  }
  // 兑换塞满 + 溢出
  for (let i = 0; i < RUNS_PER_TASK + 5; i++) {
    add(s, 'exchange', new Date(Date.parse('2026-10-15T10:00:00.000Z') + i * 60_000).toISOString());
  }
  assert.equal(readRunsOf(s, 'daily').length, 3, '日常的记录不该被兑换挤掉');
  assert.equal(readRunsOf(s, 'exchange').length, RUNS_PER_TASK);
});

test('⚠ 一条记录最多留 M 步（步数由上游待办条数决定，可能上百）', () => {
  const s = memStore();
  const many = Array.from({ length: MAX_STEPS + 25 }, (_, i) => step(`第 ${i} 步`));
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z', { steps: many });
  const r = readRun(s, id)!;
  assert.equal(r.steps.length, MAX_STEPS);
  assert.equal(r.truncated, true, '被截断了要标出来（否则看着像"就跑了这么多步"）');
  // 留的是**前面**那些（后面的是截断的兜底步，意义小）
  assert.equal(r.steps[0]!.name, '第 0 步');
});

test('没截断时 `truncated` 是 false（不谎报）', () => {
  const s = memStore();
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z', {
    steps: Array.from({ length: MAX_STEPS }, (_, i) => step(`第 ${i} 步`)),
  });
  assert.equal(readRun(s, id)!.truncated, false, `正好 ${MAX_STEPS} 步不算截断`);
});

test('⚠ 一句话截到 K 字（保留**尾部** —— 失败原因通常在后面）', () => {
  const s = memStore();
  const long = `开头这段是废话${'x'.repeat(600)}真正的原因在这里`;
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z', { note: long });
  const r = readRun(s, id)!;
  assert.ok(r.note.length <= MAX_NOTE, `实际 ${r.note.length} 字`);
  assert.ok(r.note.includes('真正的原因在这里'), '尾部要保留');
  assert.ok(r.note.startsWith('…'), '截断了要标出来');
});

test('步骤里的话也截（不然一步就能把那一行撑大）', () => {
  const s = memStore();
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z', {
    steps: [{ name: 'x'.repeat(300), ok: true, note: 'y'.repeat(900), idle: false }],
  });
  const r = readRun(s, id)!;
  assert.ok(r.steps[0]!.name.length <= 60);
  assert.ok(r.steps[0]!.note.length <= MAX_NOTE);
});

test('同一个 id（同一毫秒跑两次）⇒ 覆盖，不追加两条一样的', () => {
  const s = memStore();
  add(s, 'daily', '2026-10-15T01:00:00.000Z', { note: '第一次' });
  add(s, 'daily', '2026-10-15T01:00:00.000Z', { note: '第二次' });
  const runs = readRunsOf(s, 'daily');
  assert.equal(runs.length, 1, '同一时刻不该出现两条');
  assert.equal(runs[0]!.note, '第二次', '后来的覆盖前面的');
});

test('摘要：分别数出成功 / 失败 / 没做事（界面要分三色显示）', () => {
  const s = memStore();
  const id = add(s, 'daily', '2026-10-15T01:00:00.000Z', {
    ok: false,
    steps: [
      step('签到', true),
      step('领豆', false),
      step('备份', true, true), // idle：条件不成立，什么都没做
    ],
  });
  const sum = recentRuns(s, 'daily')[0]!;
  assert.equal(sum.id, id);
  assert.equal(sum.okCount, 1, 'idle 的不算"成功"');
  assert.equal(sum.badCount, 1);
  assert.equal(sum.idleCount, 1);
  assert.equal(sum.ok, false);
});

test('⚠ 摘要**不带 steps**（20 条 × 40 步全塞进读数 = 几百 KB 的首屏）', () => {
  const s = memStore();
  add(s, 'daily', '2026-10-15T01:00:00.000Z', { steps: Array.from({ length: 40 }, (_, i) => step(`第 ${i} 步`)) });
  const sum = recentRuns(s, 'daily')[0]!;
  assert.ok(!('steps' in sum), '摘要里不该有 steps');
  assert.ok(JSON.stringify(sum).length < 600, `摘要要短，实际 ${JSON.stringify(sum).length} 字节`);
});

test('`recentRuns` 新的在前，且能限条数', () => {
  const s = memStore();
  for (let i = 0; i < 8; i++) {
    add(s, 'daily', new Date(Date.parse('2026-10-15T00:00:00.000Z') + i * 60_000).toISOString(), {
      note: `第 ${i} 次`,
    });
  }
  const r = recentRuns(s, 'daily', 3);
  assert.equal(r.length, 3);
  assert.equal(r[0]!.note, '第 7 次');
  assert.equal(r[2]!.note, '第 5 次');
});

test('坏数据 ⇒ 空数组（不让界面 500）', () => {
  const s = memStore();
  s.setState('mcloud.run.log', '这不是 JSON', '');
  assert.deepEqual(readRuns(s), []);
  s.setState('mcloud.run.log', '{"不是":"数组"}', '');
  assert.deepEqual(readRuns(s), []);
  // 数组里混了坏条目 ⇒ 滤掉坏的，留下好的
  s.setState('mcloud.run.log', JSON.stringify([null, 'x', { id: 'daily-1', task: 'daily', at: '2026-10-15T00:00:00.000Z', ms: 1, ok: true, note: 'n', steps: [], truncated: false }]), '');
  assert.equal(readRuns(s).length, 1);
});

test('耗时是**非负整数**（时钟回拨也不能给个负数）', () => {
  const s = memStore();
  const id = appendRun(s, {
    task: 'daily',
    at: '2026-10-15T01:00:00.000Z',
    ms: -500,
    ok: true,
    note: 'n',
    steps: [],
  });
  assert.equal(readRun(s, id)!.ms, 0);
});
