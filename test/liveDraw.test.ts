// 领小红花（写那半）—— 步骤机。
//
// 守的是四条：
//   · **一次调用只发一个请求**（面板预算 2000ms；跑完一整条链会被判超时，
//     而那时上游的账已经记了）
//   · **默认关**：关着时一个请求都不发，而且**不记 run**（否则每 5 分钟刷一行）
//   · 这一族**要凭据**：没有 jwt 就别打上游
//   · 进账是 **⑥ − ①**，不是把各口令的 flowerNum 加起来

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_CLAIM_ENABLED,
  STATE_DRAW,
  claimEnabled,
  collectCodes,
  loadDrawState,
  runLiveDraw,
  setClaimEnabled,
  stepRequest,
} from '../src/mcloud/tasks/liveDraw.ts';
import { STATE_CODES, STATE_READING } from '../src/mcloud/tasks/liveRoom.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-10-13T14:00:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'JWT-1', deviceId: 'dev-1', savedAt: NOW };

function seeded(opts: { session?: boolean; codes?: string[]; enabled?: boolean } = {}) {
  const store = memStore();
  store.ensureSchema();
  if (opts.session !== false) store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  if (opts.codes) {
    store.setState(
      STATE_CODES,
      JSON.stringify({ at: NOW, codes: opts.codes, raw: opts.codes.join('\n'), how: '测试' }),
      NOW,
    );
  }
  if (opts.enabled) setClaimEnabled(store, true, NOW);
  return store;
}

/** 一个记账的假上游：按 URL 回不同结果，并记下**每个**请求。 */
function fakeUpstream(over: { draw?: Record<string, unknown> } = {}) {
  const sent: BuiltRequest[] = [];
  let balance = 100;
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const u = req.url;
    if (u.includes('/user/info')) {
      const body = JSON.stringify({ code: 0, msg: 'success', result: { flowerCnt: balance } });
      balance += 10; // 模拟：第一次 100、第二次 110（进账 10，其中含③惊喜奖）
      return { status: 200, headers: {}, body };
    }
    if (u.includes('/redFlower/draw')) {
      const code = decodeURIComponent(u.split('code=')[1] ?? '');
      const r = over.draw?.[code] ?? { code: 0, result: { prizeId: 1, flowerNum: 10, prizeName: '小红花' } };
      return { status: 200, headers: {}, body: JSON.stringify({ msg: 'x', ...r }) };
    }
    if (u.includes('/firstParticipate/give')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success' }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 3 }) };
  }) as Transport;
  return { transport, sent };
}

test('默认**关**：一个请求都不发，而且标成 idle（否则每 5 分钟刷一行）', () => {
  const store = seeded({ codes: ['A'] });
  const { transport, sent } = fakeUpstream();
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.idle, true);
  assert.equal(sent.length, 0);
  assert.equal(store.getState(STATE_DRAW), null, '关着时连状态都不该起');
  assert.match(out.note, /未开启/);
});

test('没有口令 ⇒ idle、不发请求（cron 每 5 分钟跑一次，不能刷噪声）', () => {
  const store = seeded({ enabled: true });
  const { transport, sent } = fakeUpstream();
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.idle, true);
  assert.equal(sent.length, 0);
});

test('没有 jwt ⇒ 如实失败，且**一个请求都不发**（这一族要凭据）', () => {
  const store = seeded({ session: false, codes: ['A'], enabled: true });
  const { transport, sent } = fakeUpstream();
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.ok, false);
  assert.equal(sent.length, 0, '没凭据就别打上游');
  assert.match(out.note, /未登录/);
});

test('全链推进：一次调用一个请求，顺序与形状都对', () => {
  const store = seeded({ codes: ['甲', '乙'], enabled: true });
  const { transport, sent } = fakeUpstream();

  const notes: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const out = runLiveDraw({ store, transport, nowIso: NOW });
    notes.push(out.note);
    if (loadDrawState(store)?.step === 'done') break;
  }

  // 1(余额) + 5(埋点) + 1(惊喜奖) + 2(口令) + 1(复活花) + 1(再读余额) = 11
  assert.equal(sent.length, 11, `该 11 个请求，实际 ${sent.length}：\n${notes.join('\n')}`);
  assert.deepEqual(
    sent.map((r) => r.url.replace('https://m.mcloud.139.com/ycloud', '').split('?')[0]),
    [
      '/liveRoomFeedback/user/info',
      '/visitlog/journaling',
      '/visitlog/journaling',
      '/visitlog/journaling',
      '/visitlog/journaling',
      '/visitlog/journaling',
      '/liveRoomFeedback/firstParticipate/give',
      '/liveRoomFeedback/redFlower/draw',
      '/liveRoomFeedback/redFlower/draw',
      '/liveRoomFeedback/redFlower/queryRevivalFlowers',
      '/liveRoomFeedback/user/info',
    ],
  );
  // 口令按**人给的顺序**逐个领，且编码过
  assert.ok(sent[7]!.url.endsWith(`code=${encodeURIComponent('甲')}`), sent[7]!.url);
  assert.ok(sent[8]!.url.endsWith(`code=${encodeURIComponent('乙')}`), sent[8]!.url);
  // 每次调用只发一个
  assert.equal(sent.filter((r) => r.url.includes('/redFlower/draw')).length, 2);

  const st = loadDrawState(store)!;
  assert.equal(st.step, 'done');
  // ⚠ 进账是 ⑥ − ① = 110 − 100 = 10，**不是**两条口令的 flowerNum 相加（那是 20）
  assert.equal(st.balanceBefore, 100);
  assert.equal(st.balanceAfter, 110);
  assert.match(st.summary!, /进账 10 朵/);
  assert.equal(st.results.length, 2);
  assert.ok(st.results.every((r) => r.kind === 'succeeded'));
});

test('跑完之后再触发：口令没变就 idle（不重复领）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport, sent } = fakeUpstream();
  for (let i = 0; i < 12; i += 1) {
    runLiveDraw({ store, transport, nowIso: NOW });
    if (loadDrawState(store)?.step === 'done') break;
  }
  const before = sent.length;
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.idle, true);
  assert.equal(sent.length, before, '口令没变就不该再发请求');
  assert.match(out.note, /已跑完/);
});

test('口令变了 ⇒ 自动起新一轮（新一期直播发了新口令）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport, sent } = fakeUpstream();
  for (let i = 0; i < 12; i += 1) {
    runLiveDraw({ store, transport, nowIso: NOW });
    if (loadDrawState(store)?.step === 'done') break;
  }
  // 人又填了一条新口令
  store.setState(
    STATE_CODES,
    JSON.stringify({ at: NOW, codes: ['甲', '丙'], raw: '甲\n丙', how: '测试' }),
    NOW,
  );
  const before = sent.length;
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.idle, undefined);
  assert.equal(sent.length, before + 1, '起新一轮 = 先读一次余额');
  assert.equal(loadDrawState(store)!.step, 'journaling');
  assert.deepEqual(loadDrawState(store)!.codes, ['甲', '丙']);
});

test('⚠ 200118（本场已结束）记成 kouling-expired，**不是**"口令无效"', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport } = fakeUpstream({ draw: { 甲: { code: 200118, msg: '口令已失效' } } });
  for (let i = 0; i < 12; i += 1) {
    runLiveDraw({ store, transport, nowIso: NOW });
    if (loadDrawState(store)?.step === 'done') break;
  }
  const st = loadDrawState(store)!;
  assert.equal(st.results.length, 1);
  assert.equal(st.results[0]!.kind, 'kouling-expired');
  assert.match(st.results[0]!.note, /本场已结束/);
  assert.ok(!/口令无效/.test(st.results[0]!.note), '别把"直播结束了"写成"口令抄错了"');
});

test('上游失败 ⇒ 停在这一步，下一次接着试（不跳步）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  let fail = true;
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    if (fail) return { error: '请求失败: http status: 502' };
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'ok', result: { flowerCnt: 1 } }) };
  }) as Transport;

  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.ok, false);
  assert.match(out.note, /502/);
  assert.equal(loadDrawState(store)!.step, 'balance-before', '失败了不该推进');

  fail = false;
  const out2 = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out2.ok, true);
  assert.equal(loadDrawState(store)!.step, 'journaling');
});

// ── 口令来源与开关

test('口令来源：人给的在前、自动抓的在后，去重', () => {
  const store = seeded({ codes: ['甲'] });
  store.setState(
    STATE_READING,
    JSON.stringify({ at: NOW, url: 'u', codes: ['乙', '甲'], chars: 9000, tookMs: 1, note: '' }),
    NOW,
  );
  assert.deepEqual(collectCodes(store), ['甲', '乙'], '人给的那份在前（那是他确认过的）');
});

test('开关：默认关；`force` 只给手动那一枪（开关只管 cron）', () => {
  const store = seeded({ codes: ['甲'] });
  assert.equal(claimEnabled(store), false);
  assert.equal(store.getState(STATE_CLAIM_ENABLED), null, '默认连键都没有 ⇒ 关');

  const { transport, sent } = fakeUpstream();
  // 手动那一枪不受开关限制
  runLiveDraw({ store, transport, nowIso: NOW }, { force: true });
  assert.equal(sent.length, 1);

  setClaimEnabled(store, true, NOW);
  assert.equal(claimEnabled(store), true);
});

test('`stepRequest` 是纯函数：不推进状态、也不发请求', () => {
  const st = {
    step: 'draw' as const,
    journalingSent: 0,
    drawIndex: 1,
    codes: ['甲', '乙'],
    results: [],
    startedAt: NOW,
  };
  const s = stepRequest(st)!;
  assert.ok(s.request.url.endsWith(`code=${encodeURIComponent('乙')}`));
  assert.match(s.label, /2\/2/);
  assert.equal(st.drawIndex, 1, '不能改传进来的状态');
  assert.equal(stepRequest({ ...st, step: 'done' }), null);
  // 下标越界 ⇒ null（调用方会跳到收尾，不卡在半路）
  assert.equal(stepRequest({ ...st, drawIndex: 9 }), null);
});

test('⚠ baseUrl 指到 mock 时，六步链**全部**打 mock（一个字节都不许外流）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport, sent } = fakeUpstream();
  const base = 'http://127.0.0.1:19040';
  for (let i = 0; i < 12; i += 1) {
    runLiveDraw({ store, transport, nowIso: NOW, baseUrl: base });
    if (loadDrawState(store)?.step === 'done') break;
  }
  assert.ok(sent.length > 0);
  const stray = sent.filter((r) => !r.url.startsWith(base));
  assert.deepEqual(stray.map((r) => r.url), [], '有请求打到真上游了 —— 这是"测试污染真环境"');
});
