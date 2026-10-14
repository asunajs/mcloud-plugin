// `msg-push`（消息推送奖励）—— 两步 + 一道闸门。
//
// 真机实测过的响应（2026-10-14）：
//   {"pushOn":1,"firstTaskStatus":3,"secondTaskStatus":1,"pushTaskStatus":0,"onDuaration":10,"total":31}
// 所以夹具按这个形状摆 —— 而且**保留那几个我们用不到的字段**（`pushTaskStatus` / `total`）：
// 真响应里有它们，夹具里没有的话，"多出来的字段会不会把解析带歪"这件事就没被测到。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_CAN,
  STATE_STATUS,
  claimable,
  parseStatus,
  runMsgPushObtain,
  runMsgPushStatus,
} from '../src/mcloud/tasks/msgPush.ts';
import {
  planMsgPush,
  firstRewardPending,
} from '../src/mcloud/tasks/msgPush.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-10-14T01:00:00.000Z';

function withSession(store: ReturnType<typeof memStore>) {
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', savedAt: NOW }),
    NOW,
  );
}

/** 一个记录请求的假上游。`status` 决定第一步回什么。 */
function upstream(status: Record<string, unknown>, obtain: Record<string, unknown> = { obtainCode: 0 }) {
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const isStatus = req.url.includes('/msgPushOn/task/status');
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, msg: 'success', result: isStatus ? status : obtain }),
    };
  }) as Transport;
  return { transport, sent };
}

test('解析：字段缺就是 undefined（**不猜** —— 猜错会白发一笔领取请求）', () => {
  const s = parseStatus({ pushOn: 1, secondTaskStatus: 1, onDuaration: 10 });
  assert.equal(s.pushOn, 1);
  assert.equal(s.secondTaskStatus, 1);
  assert.equal(s.onDuaration, 10);
  assert.equal(s.firstTaskStatus, undefined, '没给的字段不许编一个默认值');
  assert.equal(claimable(s), false);
});

test('能领的判据**只有** `secondTaskStatus === 2`', () => {
  assert.equal(claimable({ secondTaskStatus: 2 }), true);
  for (const v of [0, 1, 3, 4, undefined]) {
    assert.equal(claimable({ secondTaskStatus: v }), false, `secondTaskStatus=${v} 不该可领`);
  }
  // 缺字段 ⇒ 不可领（这条是"宁可放过不可误报"）
  assert.equal(claimable(parseStatus({})), false);
});

test('第一步只读：一个 GET，`activityid` 是 **msgpushon** 而不是 sign_in_3', () => {
  const store = memStore();
  withSession(store);
  const { transport, sent } = upstream({ pushOn: 1, firstTaskStatus: 3, secondTaskStatus: 1, onDuaration: 10 });
  const out = runMsgPushStatus({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, 'GET');
  assert.ok(sent[0]!.url.endsWith('/market/msgPushOn/task/status'), sent[0]!.url);
  assert.equal(
    sent[0]!.headers.activityid,
    'msgpushon',
    '这一族的 activityid 是 msgpushon —— 混成签到页那个是"另一页的票配这一页的头"',
  );
  assert.equal(store.getState(STATE_CAN), 'no');
  assert.ok(store.getState(STATE_STATUS), '状态落盘了');
  assert.match(out.note, /已开启 10 天/);
});

test('⚠ 闸门：上一步说不可领 ⇒ **一个请求都不发**（否则就是白发一笔写请求）', () => {
  const store = memStore();
  withSession(store);
  store.setState(STATE_CAN, 'no', NOW);
  const { transport, sent } = upstream({ secondTaskStatus: 2 }, { obtainCode: 0 });
  const out = runMsgPushObtain({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(sent.length, 0, '闸门没挡住');
  assert.equal(out.skipped, true);
  assert.match(out.note, /没问过|不该领/);
});

test('没问过状态也**不发**（默认就是不发）', () => {
  const store = memStore();
  withSession(store);
  const { transport, sent } = upstream({ secondTaskStatus: 2 });
  assert.equal(runMsgPushObtain({ store, transport, nowIso: NOW, baseUrl: undefined }).skipped, true);
  assert.equal(sent.length, 0);
});

test('可领 ⇒ 第二步发出 POST `{"type":2}`，且**判据是 obtainCode === 0**', () => {
  const store = memStore();
  withSession(store);
  store.setState(STATE_CAN, 'yes', NOW);
  const { transport, sent } = upstream({}, { obtainCode: 0 });
  const out = runMsgPushObtain({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, 'POST');
  assert.equal(sent[0]!.body, '{"type":2}');
  assert.equal(sent[0]!.headers.activityid, 'msgpushon');
  assert.equal(store.getState(STATE_CAN), 'no', '领过就不再排队');
});

test('⚠ `obtainCode !== 0` ⇒ 如实失败 —— 不能因为 HTTP 200 就当领到了', () => {
  const store = memStore();
  withSession(store);
  store.setState(STATE_CAN, 'yes', NOW);
  const { transport } = upstream({}, { obtainCode: 5 });
  const out = runMsgPushObtain({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, false, 'HTTP 200 但业务码非 0 ⇒ 没领到');
  assert.match(out.note, /obtainCode=5/);
  assert.equal(store.getState(STATE_CAN), 'yes', '失败不该把它标成已领');
});

test('`pushOn === 0`：如实说"要你去 App 开"，而不是报失败', () => {
  const store = memStore();
  withSession(store);
  const { transport } = upstream({ pushOn: 0, secondTaskStatus: 1 });
  const out = runMsgPushStatus({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, true, '这不是我们的失败，是用户侧的动作');
  assert.match(out.note, /App/);
  assert.match(out.note, /手动/);
});

test('首次奖励没领 ⇒ 同样如实说要做 App 里的那一步', () => {
  const store = memStore();
  withSession(store);
  const { transport } = upstream({ pushOn: 1, firstTaskStatus: 0, secondTaskStatus: 1 });
  const out = runMsgPushStatus({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, true);
  assert.match(out.note, /首次奖励/);
});

test('没有会话 ⇒ 一个请求都不发', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport, sent } = upstream({ secondTaskStatus: 2 });
  const out = runMsgPushStatus({ store, transport, nowIso: NOW, baseUrl: undefined });
  assert.equal(out.ok, false);
  assert.equal(sent.length, 0);
});

test('判定档位**逐条照 mcloud 的四档**（unknown 不许压成 nothing）', () => {
  // mcloud: plan_msg_push —— 先 pushOn，再 secondTaskStatus；缺失 ⇒ unknown
  assert.equal(planMsgPush({ pushOn: 0, secondTaskStatus: 2 }), 'manual', '⚠ pushOn 先判');
  assert.equal(planMsgPush({ secondTaskStatus: 2 }), 'obtain');
  assert.equal(planMsgPush({ secondTaskStatus: 1 }), 'nothing');
  assert.equal(planMsgPush({ secondTaskStatus: 3 }), 'nothing');
  assert.equal(planMsgPush({}), 'unknown', '⚠ 判据字段缺失 ⇒ 判不了（一个写请求都不发）');
  assert.equal(planMsgPush({ pushOn: 1 }), 'unknown');
});

test('第一份奖励：**字段缺失时不算待领**（旧 TS 的 `!== 3` 会误判）', () => {
  // mcloud 注释点名的坑：`undefined !== 3` 恒真 ⇒ 旧版缺字段时会误判成"该领"
  assert.equal(firstRewardPending({}), false, '⚠ 缺字段 ⇒ false');
  assert.equal(firstRewardPending({ firstTaskStatus: 3 }), false, '已完成');
  assert.equal(firstRewardPending({ firstTaskStatus: 1 }), true);
  assert.equal(firstRewardPending({ firstTaskStatus: 0 }), true);
});
