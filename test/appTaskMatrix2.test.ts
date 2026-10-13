// App 任务矩阵的读数与接口 —— 只读任务采集、界面展示这条链。
//
// 为什么值得单独测：读数**按 group 存**（不是只留最后一条），界面要一次看到 8 个；
// 而且"没读到"和"读到 0 条"必须分得开 —— 前者界面上写"还没读到"，后者是"这一组真没有"。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATRIX_GROUPS,
  matrixKey,
  readMatrix,
  runAppTaskMatrix,
} from '../src/mcloud/tasks/appTaskMatrix.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T08:05:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'J', deviceId: 'dev-1', savedAt: NOW };

function seeded() {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  return store;
}

const LIST_RE = /task\/taskListV2/;
const okTransport = (body: () => string): Transport =>
  ((req: any) =>
    LIST_RE.test(req.url)
      ? { status: 200, headers: {}, body: body() }
      : { status: 404, headers: {}, body: 'no' }) as Transport;

test('读数：按 group 存 —— 连读 3 次，三个格子有数、其余是"还没读到"', () => {
  const store = seeded();
  const body = JSON.stringify({
    code: 0,
    msg: 'success',
    result: [{ id: 106, name: '永葆童心', groupid: 'beiyong1', state: 'DOING', enable: 1 }],
  });
  const deps = { store, transport: okTransport(() => body), nowIso: NOW, lateMs: 0 };
  for (let i = 0; i < 3; i++) runAppTaskMatrix(deps);

  const rows = readMatrix(store);
  assert.equal(rows.length, MATRIX_GROUPS.length, '八格都要在（没读到的给 null）');
  assert.equal(rows.filter(Boolean).length, 3, '读了 3 个 group ⇒ 3 格有数');
  assert.equal(rows[0]!.group, MATRIX_GROUPS[0]);
  assert.equal(rows[0]!.todo, 1);
  assert.deepEqual(rows[0]!.todoNames, ['永葆童心']);
  // 第 4 格起还没读到
  assert.equal(rows[3], null);
  assert.equal(store.getState(matrixKey(MATRIX_GROUPS[0]))!.includes('"todo":1'), true);
});

test('读数：读到 0 条与"还没读到"是两件事', () => {
  const store = seeded();
  const empty = JSON.stringify({ code: 0, msg: 'success', result: {}, groupState: {} });
  runAppTaskMatrix({ store, transport: okTransport(() => empty), nowIso: NOW, lateMs: 0 });
  const rows = readMatrix(store);
  // 第一格：读过了，只是这一组真没有
  assert.notEqual(rows[0], null);
  assert.deepEqual({ done: rows[0]!.done, todo: rows[0]!.todo, skip: rows[0]!.skip }, { done: 0, todo: 0, skip: 0 });
  // 第二格：还没读
  assert.equal(rows[1], null);
});
