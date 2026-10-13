// 新一批任务的测试：prizes / cloud-snapshot / sign / backup-gift，
// 外加底座那条「错过太久就不做」的策略。
//
// 三条是**行为断言**（不是功能断言），它们才是这里真正的价值：
//   ① 备份好礼**不能抢跑**：`info` 说不能领时，绝不发领取请求
//   ② 手动触发（`lateMs` 负数）**不能**被跳过策略当成"晚" —— 否则点「立即执行」
//      反而什么都不做（面板 F-001 的连带影响）
//   ③ 每个请求的 query 逐字正确（params 抄错是最容易犯、最难查的错）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRIZE_QUERY, STATE_PRIZES, prizeQuery, runPrizes } from '../src/mcloud/tasks/prizes.ts';
import {
  PAGE_SIZE,
  STATE_SNAPSHOT,
  snapshotQuery,
  runCloudSnapshot,
} from '../src/mcloud/tasks/cloudSnapshot.ts';
import { runSign } from '../src/mcloud/tasks/sign.ts';
import {
  STATE_CAN,
  parseCanReceive,
  runBackupGift,
  runBackupGiftInfo,
} from '../src/mcloud/tasks/backupGift.ts';
import { runTask } from '../src/mcloud/tasks/base.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T01:00:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'J', deviceId: 'dev-1', savedAt: NOW };

function seeded() {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  return store;
}
const ok = (result: unknown): Transport => () => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ code: 0, msg: 'success', result }),
});

/** 记录发出去的请求，并按序回放响应。 */
function recorder(responses: unknown[]): { transport: Transport; sent: { url: string; method: string }[] } {
  const sent: { url: string; method: string }[] = [];
  let i = 0;
  return {
    sent,
    transport: (req) => {
      sent.push({ url: req.url, method: req.method });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: r }) };
    },
  };
}

test('prizes：query 逐字（type=1 / 第 1 页 / 每页 10，抄自调用点）', () => {
  assert.equal(PRIZE_QUERY.status, 1);
  assert.equal(PRIZE_QUERY.pageSize, 10);
  assert.equal(prizeQuery('sign_in_3'), 'marketname=sign_in_3&type=1&pageNumber=1&pageSize=10');

  const store = seeded();
  const { transport, sent } = recorder([[{ id: 1, state: 'UNRECEIVED' }, { id: 2, state: 'RECEIVED' }]]);
  const out = runPrizes({ store, transport, nowIso: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.note, '奖品 2 条（未领取 1 条）');
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(
    sent[0]!.url,
    'https://m.mcloud.139.com/ycloud/signin/public/record?marketname=sign_in_3&type=1&pageNumber=1&pageSize=10',
  );
  const saved = JSON.parse(store.getState(STATE_PRIZES)!);
  assert.equal(saved.value.length, 2);
});

test('cloud-snapshot：query 逐字；一页装满就如实说「可能还有下一页」', () => {
  assert.equal(snapshotQuery(), 'aiDou=1&type=0&pageNumber=1&pageSize=100');

  const store = seeded();
  // 不满一页
  const few = runCloudSnapshot({
    store,
    transport: ok([{ id: 1, aiDou: 5, typeName: '签到' }]),
    nowIso: NOW,
  });
  assert.equal(few.ok, true);
  assert.match(few.note, /流水 1 条/);
  assert.match(few.note, /最新一笔 5/);
  assert.doesNotMatch(few.note, /下一页/);

  // 正好装满 → 必须提醒可能还有下一页（原实现的分页规则：== pageSize 就要下一页）
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i + 1, aiDou: 1, typeName: 'x' }));
  const store2 = seeded();
  const out = runCloudSnapshot({ store: store2, transport: ok(full), nowIso: NOW });
  assert.match(out.note, /可能还有下一页/);
  const saved = JSON.parse(store2.getState(STATE_SNAPSHOT)!);
  assert.equal(saved.value.truncated, true);
  assert.equal(saved.value.entries.length, PAGE_SIZE);
});

test('sign：有设备号才发 isdeviceid 与 deviceId（且要走到"提交"那一步 GET 出去）', () => {
  // 注意：签到现在是三段式（问状态 → 提交 → 回查，见 tasks2.test.ts）。
  // 这条只盯「提交那一步的请求长什么样」，所以要真的走到提交那一步。
  const notSigned = JSON.stringify({
    code: 0,
    msg: 'success',
    result: { todaySignIn: false, cal: [], receiveList: [] },
  });

  const store = seeded(); // 会话里带 deviceId
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = (req) => {
    sent.push({ url: req.url, headers: req.headers });
    return { status: 200, headers: {}, body: notSigned };
  };
  runSign({ store, transport, nowIso: NOW, lateMs: 0 }); // ① 问状态
  assert.match(sent[0]!.url, /infoV3/);
  runSign({ store, transport, nowIso: NOW, lateMs: 0 }); // ② 提交
  const submit = sent.find((x) => /startSignIn/.test(x.url));
  assert.ok(submit, '第二次应当去提交签到');
  assert.equal(
    submit.url,
    'https://m.mcloud.139.com/ycloud/signin/page/startSignIn?client=app&deviceId=dev-1',
  );
  assert.equal(submit.headers['isdeviceid'], 'true');

  // 没有设备号：只带 client=app，不发 isdeviceid
  const store2 = memStore();
  store2.ensureSchema();
  store2.setState(SESSION_KEY, JSON.stringify({ cookie: 'c=1', savedAt: NOW }), NOW);
  const sent2: { url: string; headers: Record<string, string> }[] = [];
  const t2: Transport = (req) => {
    sent2.push({ url: req.url, headers: req.headers });
    return { status: 200, headers: {}, body: notSigned };
  };
  runSign({ store: store2, transport: t2, nowIso: NOW, lateMs: 0 });
  runSign({ store: store2, transport: t2, nowIso: NOW, lateMs: 0 });
  const submit2 = sent2.find((x) => /startSignIn/.test(x.url))!;
  assert.equal(submit2.url, 'https://m.mcloud.139.com/ycloud/signin/page/startSignIn?client=app');
  assert.equal(submit2.headers['isdeviceid'], undefined);
  assert.equal(submit2.headers.activityid, 'sign_in_3');
});

test('② 备份好礼不能抢跑：info 说不能领就绝不发领取请求', () => {
  // 能领 → 第二次调用才去领
  const yes = seeded();
  const r1 = recorder([{ canReceive: true }]);
  runBackupGiftInfo({ store: yes, transport: r1.transport, nowIso: NOW });
  assert.equal(yes.getState(STATE_CAN), 'yes');
  const r2 = recorder([{ done: true }]);
  const out2 = runBackupGift({ store: yes, transport: r2.transport, nowIso: NOW });
  assert.equal(out2.ok, true);
  assert.equal(r2.sent.length, 1);
  assert.match(r2.sent[0]!.url, /backupgift\/receive$/);
  assert.equal(r2.sent[0]!.url.startsWith('https://caiyun.feixin.10086.cn'), true, '在另一个域上');
  assert.equal(yes.getState(STATE_CAN), 'no:claimed', '领过就不再排队');

  // 不能领 → 第二次调用只问，不发领取
  const no = seeded();
  const n1 = recorder([{ canReceive: false }]);
  runBackupGiftInfo({ store: no, transport: n1.transport, nowIso: NOW });
  assert.match(no.getState(STATE_CAN)!, /^no:/);
  const n2 = recorder([{ canReceive: false }]);
  const outNo = runBackupGift({ store: no, transport: n2.transport, nowIso: NOW });
  assert.equal(outNo.ok, true);
  assert.equal(n2.sent.length, 1, '只发了一次请求');
  assert.match(n2.sent[0]!.url, /backupgift\/info$/, '而且发的是 info，不是 receive');

  // info 的响应认不出来 → 当作不能领（宁可不领，不要抢跑）
  assert.equal(parseCanReceive({ weird: true }).can, false);
  assert.equal(parseCanReceive(undefined).can, false);
  assert.equal(parseCanReceive({ canReceive: 1 }).can, true);
  assert.equal(parseCanReceive({ canReceive: 'true' }).can, true);
});

test('③ 底座：错过太久就跳过，但**手动触发（负数）不算晚**', () => {
  const spec = {
    task: 'x',
    endpoint: 'prizeRecord' as const,
    method: 'GET' as const,
    skipIfLaterThanMs: 2 * 3600_000,
  };
  const judge = () => ({ ok: true, note: 'done' });

  // 晚了 3 小时 → 跳过（不是失败）
  const s1 = seeded();
  let called = 0;
  const out1 = runTask(
    { store: s1, transport: () => { called += 1; return ok(1)({} as never); }, nowIso: NOW, lateMs: 3 * 3600_000 },
    spec,
    judge,
  );
  assert.equal(out1.skipped, true);
  assert.equal(out1.ok, true, '跳过不是失败');
  assert.equal(called, 0, '跳过了就不该发请求');
  assert.match(out1.note, /错过太久/);

  // 晚了 1 小时 → 照做（在阈值内）
  const s2 = seeded();
  const out2 = runTask({ store: s2, transport: ok({}), nowIso: NOW, lateMs: 3600_000 }, spec, judge);
  assert.equal(out2.skipped, undefined);
  assert.equal(out2.ok, true);

  // ⚠️ 关键：手动触发时面板给的 lateMs 是**负数**（F-001）—— 不能当成"晚"
  const s3 = seeded();
  const out3 = runTask({ store: s3, transport: ok({}), nowIso: NOW, lateMs: -290918 }, spec, judge);
  assert.equal(out3.skipped, undefined, '手动触发必须照做');
  assert.equal(out3.ok, true);
});

test('底座：失败原因落盘，成功时清掉；没有会话不发请求', () => {
  const store = seeded();
  const fail: Transport = () => ({ status: 200, headers: {}, body: '{"code":401,"msg":"凭据无效"}' });
  const out = runPrizes({ store, transport: fail, nowIso: NOW });
  assert.equal(out.ok, false);
  assert.match(store.getState('mcloud.last_error.prizes')!, /凭据无效/);

  const okOut = runPrizes({ store, transport: ok([]), nowIso: NOW });
  assert.equal(okOut.ok, true);
  assert.equal(store.getState('mcloud.last_error.prizes'), '', '成功后要清掉上次的失败');

  // 没有会话
  const empty = memStore();
  empty.ensureSchema();
  let n = 0;
  const out2 = runPrizes({
    store: empty,
    transport: () => {
      n += 1;
      return { status: 200, headers: {}, body: '{}' };
    },
    nowIso: NOW,
  });
  assert.equal(out2.ok, false);
  assert.match(out2.note, /未登录/);
  assert.equal(n, 0);
});
