// App 任务矩阵（`app-task-matrix`）—— `app-task` 的只读半边。
//
// 重点全在**别把没有的活报成有**、以及两个实拍坑上：
//   · `result` 是空**对象**（`{}`）而不是空数组 —— 实拍就是这样
//   · `groupid` 全小写 / `groupId` 驼峰 —— 两族的真实差异，都要认
//   · 字段不全 ⇒ 不参与（`skip`），不是"可做" —— 宁可漏报，也不要报出不存在的活
//   · 一次调用**只读一个 group**、只发一个请求，8 次覆盖一轮

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATRIX_GROUPS,
  STATE_GROUP_INDEX,
  judgeItem,
  parseMatrix,
  parseMatrixItem,
  runAppTaskMatrix,
  summarize,
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

function router(table: Array<[RegExp, () => string]>) {
  const sent: { url: string; method: string; body: string }[] = [];
  return {
    sent,
    transport: ((req: any) => {
      sent.push({ url: req.url, method: req.method ?? 'GET', body: String(req.body ?? '') });
      for (const [re, body] of table) {
        if (re.test(req.url)) return { status: 200, headers: {}, body: body() };
      }
      return { status: 404, headers: {}, body: 'mock 没这个路径' };
    }) as Transport,
  };
}

const LIST_RE = /task\/taskListV2/;

test('解析：result 是空对象也要当空（实拍就是 {}）', () => {
  assert.deepEqual(parseMatrix({}), []);
  assert.deepEqual(parseMatrix([]), []);
  assert.deepEqual(parseMatrix(undefined), []);
  // 也可能是包着一层的
  assert.equal(parseMatrix({ list: [{ id: 1, name: 'x', enable: 1 }] }).length, 1);
});

test('解析：groupid 小写与 groupId 驼峰都认（两族的真实差异）', () => {
  assert.equal(parseMatrixItem({ id: 1, groupid: 'beiyong1' })!.groupId, 'beiyong1');
  assert.equal(parseMatrixItem({ id: 2, groupId: 'cloudEmail' })!.groupId, 'cloudEmail');
  assert.equal(parseMatrixItem({ name: '永葆童心', description: '领38云朵', currstep: 4 })!.currStep, 4);
});

test('判据：FINISH 算已完成、enable=1 算可做、其余不参与（字段不全也不参与）', () => {
  assert.equal(judgeItem({ state: 'FINISH', enable: 1 }), 'done');
  assert.equal(judgeItem({ state: 'DOING', enable: 1 }), 'todo');
  assert.equal(judgeItem({ state: 'DOING', enable: 0 }), 'skip');
  // 字段不全 ⇒ 不参与，**不是**"可做" —— 宁可漏报，也不要报出不存在的活
  assert.equal(judgeItem({ name: 'x' }), 'skip');
  const s = summarize([{ state: 'FINISH', enable: 1 }, { state: 'DOING', enable: 1 }, { name: 'x' }]);
  assert.deepEqual({ done: s.done, todo: s.todo, skip: s.skip }, { done: 1, todo: 1, skip: 1 });
});

test('一步只读一个 group、只发一个请求，8 次覆盖一轮并回卷', () => {
  const store = seeded();
  const r = router([[LIST_RE, () => JSON.stringify({ code: 0, msg: 'success', result: {} })]]);
  const deps = { store, transport: r.transport, nowIso: NOW, lateMs: 0 };

  for (let i = 0; i < MATRIX_GROUPS.length; i++) {
    const before = r.sent.length;
    const out = runAppTaskMatrix(deps);
    assert.equal(out.ok, true);
    assert.equal(r.sent.length - before, 1, `第 ${i + 1} 次只该发一个请求`);
    assert.equal(r.sent[before]!.method, 'POST');
    // 请求体里带着这一次要读的 group
    assert.ok(
      r.sent[before]!.body.includes(`"group":"${MATRIX_GROUPS[i]}"`) ||
        r.sent[before]!.body.includes(`group=${MATRIX_GROUPS[i]}`),
      `第 ${i + 1} 次的体里该有 group=${MATRIX_GROUPS[i]}，实际 ${r.sent[before]!.body.slice(0, 120)}`,
    );
    assert.ok(String(out.note).includes(`group=${MATRIX_GROUPS[i]}`), out.note);
  }
  // 第 9 次回到第一个
  runAppTaskMatrix(deps);
  assert.equal(r.sent[8]!.body.includes(`"group":"${MATRIX_GROUPS[0]}"`), true);
});

test('只读：整轮下来只碰 taskListV2，一个写请求都没有', () => {
  const store = seeded();
  const r = router([
    [
      LIST_RE,
      () =>
        JSON.stringify({
          code: 0,
          msg: 'success',
          result: [{ id: 106, name: '永葆童心', groupid: 'beiyong1', state: 'DOING', enable: 1 }],
        }),
    ],
  ]);
  for (let i = 0; i < MATRIX_GROUPS.length; i++) {
    runAppTaskMatrix({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });
  }
  assert.equal(r.sent.length, MATRIX_GROUPS.length);
  for (const q of r.sent) assert.ok(LIST_RE.test(q.url), `不该碰别的端点：${q.url}`);
  // 游标真的在推进（8 次之后回到 0）
  assert.equal(store.getState(STATE_GROUP_INDEX), '0');
});

test('上游报错时如实失败，且**不推进游标**（下一轮还能重试同一个 group）', () => {
  const store = seeded();
  const r = router([[LIST_RE, () => JSON.stringify({ code: 40001, msg: '活动已结束' })]]);
  const out = runAppTaskMatrix({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(store.getState(STATE_GROUP_INDEX) ?? '0', '0', '失败了不该跳过这一组');
});

// ⚠ 真机形状（2026-10-14 实测）：`result` 是**按组名分键**的对象。
//   这一条是"只跑单测发现不了"的典型 —— 原来只找 list/tasks/taskList/items，
//   于是 8 个组全读成 0 条，而每条 note 都写着"成功"。
test('⚠ `result` 按**组名分键**（真机形状）—— 组名对上才取得到条目', () => {
  const real = {
    day: [{ id: 106, marketname: 'sign_in_3', groupid: 'day', enable: 1, name: '手动上传一个文件' }],
    month: [{ id: 607, groupid: 'month', enable: 1, name: '下月签到领惊喜福利' }],
  };
  const day = parseMatrix(real, 'day');
  assert.equal(day.length, 1);
  assert.equal(day[0]!.taskId, 106);
  assert.equal(day[0]!.groupId, 'day');
  const month = parseMatrix(real, 'month');
  assert.equal(month[0]!.taskId, 607);
  // ⚠ 空组是真的空（`group=new` 那条回 `result:{}`）—— 不是解析失败
  assert.deepEqual(parseMatrix({}, 'new'), []);
  // 组名对不上 ⇒ 取不到（不是"退回取第一个键" —— 那会把 day 的条目当成 month 的）
  assert.deepEqual(parseMatrix(real, 'nope'), []);
  // 兼容老形状（list/tasks/taskList/items）
  assert.equal(parseMatrix({ list: [{ id: 1, enable: 1 }] }, 'day').length, 1);
});
