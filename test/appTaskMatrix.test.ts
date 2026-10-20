// App 任务矩阵（`app-task-matrix`）—— `app-task` 的只读半边。
//
// 重点全在**别把没有的活报成有**、以及两个实拍坑上：
//   · `result` 是空**对象**（`{}`）而不是空数组 —— 实拍就是这样
//   · `groupid` 全小写 / `groupId` 驼峰 —— 两族的真实差异，都要认
//   · 字段不全 ⇒ 不参与（`skip`），不是"可做" —— 宁可漏报，也不要报出不存在的活
//   · 一次调用**只读一个 group**、只发一个请求，2 次覆盖一轮

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATRIX_MARKETS,
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

const LIST_RE = /task\/taskListV3/;

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

// 界面徽章那句"照抄上游"依赖这一格 —— 词不许由我们造（mcloud 的同一个错：`694e35f`）。
test('⚠ 解析：按钮那一格按**端**优先取（email → app → out），同端里 buttonProperty 先于 button', () => {
  // 1021 那种：只有 `button`、没有 `buttonProperty`
  const only = parseMatrixItem({
    id: 1021,
    state: 'WAIT',
    enable: 1,
    button: { out: { text: '开启中', day: '5', total: 31, canReceive: 0 } },
  })!;
  assert.equal(only.buttonOutText, '开启中');
  assert.equal(only.buttonOutDay, '5');
  assert.equal(only.buttonOutTotal, '31');
  // 1029 那种：两份都在，取 `buttonProperty`
  const both = parseMatrixItem({
    id: 1029,
    state: 'WAIT',
    enable: 1,
    buttonProperty: { app: { text: '去完成' } },
    button: { app: { text: '旧的那份' } },
  })!;
  assert.equal(both.buttonOutText, '去完成');
  // ⚠ **外层是端、内层才是形状**：`button.email` 要赢过 `buttonProperty.app`
  //   （App 渲染的是 email/app 那一份，用户就是拿 App 比 —— mcloud 2026-10-11 口径）
  const ends = parseMatrixItem({
    id: 1017,
    state: 'WAIT',
    enable: 1,
    buttonProperty: { app: { text: '属性里的 app' } },
    button: { email: { text: '邮箱端那份' }, out: { text: '外部端那份' } },
  })!;
  assert.equal(ends.buttonOutText, '邮箱端那份');
  // V2 那三档也带着（V3 通常只给 `text`）
  const v2 = parseMatrixItem({
    id: 551,
    state: 'WAIT',
    enable: 1,
    button: { app: { text: '去开启', textMiddle: '开启中', textFinish: '领AI豆', actionMiddle: 'jump' } },
  })!;
  assert.equal(v2.buttonTextMiddle, '开启中');
  assert.equal(v2.buttonTextFinish, '领AI豆');
  assert.equal(v2.buttonActionMiddle, 'jump');
  // 两种形状都没有 ⇒ `undefined`（界面回落状态词，**不猜**一个出来）
  const none = parseMatrixItem({ id: 106, state: 'WAIT', enable: 1 })!;
  assert.equal(none.buttonOutText, undefined);
  // 少一层 / 不是字符串都不算数
  assert.equal(parseMatrixItem({ id: 1, button: { app: { text: 42 } } })!.buttonOutText, undefined);
  assert.equal(parseMatrixItem({ id: 1, button: { text: '漏了一层' } })!.buttonOutText, undefined);
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

test('一步只读一个**市场**、只发一个请求，2 次覆盖一轮并回卷（V3：每市场一发）', () => {
  const store = seeded();
  const r = router([[LIST_RE, () => JSON.stringify({ code: 0, msg: 'success', result: {} })]]);
  const deps = { store, transport: r.transport, nowIso: NOW, lateMs: 0 };

  for (let i = 0; i < MATRIX_MARKETS.length; i++) {
    const before = r.sent.length;
    const out = runAppTaskMatrix(deps);
    assert.equal(out.ok, true);
    assert.equal(r.sent.length - before, 1, `第 ${i + 1} 次只该发一个请求`);
    assert.equal(r.sent[before]!.method, 'POST');
    // ⚠ V3：`group` 是**空串**，市场在 `marketname` 上（一发拿整个市场）
    assert.ok(
      r.sent[before]!.body.includes(`"marketname":"${MATRIX_MARKETS[i]}"`),
      `第 ${i + 1} 次的体里该有 marketname=${MATRIX_MARKETS[i]}，实际 ${r.sent[before]!.body.slice(0, 120)}`,
    );
    assert.ok(
      r.sent[before]!.body.includes('"group":""'),
      `V3 的 group 该是空串，实际 ${r.sent[before]!.body.slice(0, 120)}`,
    );
    // 日志里不再出现 `market=…`（那是给排查用的）；读数里仍有
    assert.ok(String(out.note).includes('已完成'), out.note);
  }
  // 第 3 次回到第一个（2 个市场 ⇒ 两发一轮）
  const before = r.sent.length;
  runAppTaskMatrix(deps);
  assert.equal(r.sent.length - before, 1);
  assert.equal(r.sent[before]!.body.includes(`"marketname":"${MATRIX_MARKETS[0]}"`), true);
});

test('只读：整轮下来只碰 taskListV3，一个写请求都没有', () => {
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
  for (let i = 0; i < MATRIX_MARKETS.length; i++) {
    runAppTaskMatrix({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });
  }
  assert.equal(r.sent.length, MATRIX_MARKETS.length);
  for (const q of r.sent) assert.ok(LIST_RE.test(q.url), `不该碰别的端点：${q.url}`);
  // 游标真的在推进（2 次之后回到 0）
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
