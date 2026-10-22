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
import { STATE_CODES } from '../src/mcloud/tasks/liveRoom.ts';
import {
  codeState,
  emptyPool,
  loadPoolFrom,
  note,
  noteClaim,
  pickFor,
  savePoolTo,
  stopScraping,
  validCount,
} from '../src/mcloud/koulingPool.ts';
import { accountOf, claimVerdictOf } from '../src/mcloud/tasks/liveRoomRules.ts';
import { STATE_AUTH as STATE_AUTH_KEY } from '../src/mcloud/sessionExchange.ts';
import { classifyDraw, rejectedKouling } from '../src/mcloud/liveFlower.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { SignInEnvelope } from '../src/mcloud/envelope.ts';

const NOW = '2026-10-13T14:00:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'JWT-1', deviceId: 'dev-1', savedAt: NOW };

const envOf = (code: number, result?: unknown): SignInEnvelope =>
  ({ code, message: '', result, ok: code === 0 }) as SignInEnvelope;

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

test('没有本地开关：有口令就直接起一轮（手动/自动都不拦）', () => {
  const store = seeded({ codes: ['A'] });
  const { transport, sent } = fakeUpstream();
  const out = runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1, '必须真的发请求');
  assert.ok(store.getState(STATE_DRAW) !== null, '要起一轮状态');
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
  assert.match(out.note, /还没换到票|还没连上网页版|要先有票/);
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
  // ⚠ 2026-10-14 起：`甲` 已经被这一轮领过、并写进了池 ⇒ 新一轮**不再投它**
  // （再投只会回 200112「已兑换」，那不是新结果，却会污染归因）。
  assert.deepEqual(loadDrawState(store)!.codes, ['丙'], '领过的口令不再进下一轮');
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

test('口令来源：人给的在前、池里该投的在后，去重', () => {
  const store = seeded({ codes: ['甲'] });
  // ⚠ 2026-10-14 起，**自动抓到的口令从池里读**，不再读"最近一次抓主页的读数"：
  //   读数只是界面快照（解错也会原样进），池才记得住每一条的状态与谁领过。
  const { pool } = loadPoolFrom(store);
  note(pool, ['乙', '甲'], 'xiaohongshu', Date.parse(NOW));
  savePoolTo(store, pool, NOW);

  assert.deepEqual(collectCodes(store, Date.parse(NOW)), ['甲', '乙'], '人给的那份在前（那是他确认过的）');
});

test('池里判过无效的口令**不再投**（否则每轮白跑一枪 200108）', () => {
  const store = seeded({ codes: ['甲'] });
  const { pool } = loadPoolFrom(store);
  note(pool, ['甲', '乙'], 'xiaohongshu', Date.parse(NOW));
  noteClaim(pool, accountOf(store), '乙', 'invalid', Date.parse(NOW));
  savePoolTo(store, pool, NOW);

  assert.deepEqual(collectCodes(store, Date.parse(NOW)), ['甲'], '乙 已判无效 ⇒ 不再进这一轮');
});

test('这个账号领过的口令**不再投**（回 200112 不是新结果，却会把归因搅浑）', () => {
  const store = seeded({ codes: ['甲'] });
  const { pool } = loadPoolFrom(store);
  note(pool, ['甲', '乙'], 'xiaohongshu', Date.parse(NOW));
  noteClaim(pool, accountOf(store), '乙', 'claimed', Date.parse(NOW));
  savePoolTo(store, pool, NOW);

  assert.deepEqual(collectCodes(store, Date.parse(NOW)), ['甲'], '乙 这个账号领过 ⇒ 不再进这一轮');
  // 但**别的账号**仍然该投它 —— 口令是全实例共享的，领没领过是按账号算的
  assert.deepEqual(pickFor(pool, '另一个账号'), ['甲', '乙']);
});

test('领小红花没有本地开关：有口令就发请求（手动/自动都一样）', () => {
  const store = seeded({ codes: ['甲'] });
  assert.equal(claimEnabled(store), true, '不再有“默认关”');
  assert.equal(store.getState(STATE_CLAIM_ENABLED), null, '旧键不存在也不影响');

  const { transport, sent } = fakeUpstream();
  runLiveDraw({ store, transport, nowIso: NOW });
  assert.equal(sent.length, 1, '不传 force 也必须真的去领');
  setClaimEnabled(store, false, NOW);
  assert.equal(claimEnabled(store), true, '旧开关调用不会再把领取关掉');
});

// ── 池：draw 的结论**写回**（池里状态跃迁的唯一入口）
//
// 为什么这几条重要：`draw` 是整条链上**唯一会验口令**的一枪。不写回池的话，
// 判过无效的、领过的下一轮还会再投一次，而"够 2 条有效就停止抓取"这条口径
// 永远不成立（池里永远没有 valid）⇒ 主页会被一直抓下去。

function runToDone(store: ReturnType<typeof seeded>, transport: Transport) {
  for (let i = 0; i < 12; i += 1) {
    runLiveDraw({ store, transport, nowIso: NOW });
    if (loadDrawState(store)?.step === 'done') break;
  }
}

test('领到 ⇒ 池里记**有效**（"够 2 条就停止抓取"唯一的数据来源）', () => {
  const store = seeded({ codes: ['甲', '乙'], enabled: true });
  const { transport } = fakeUpstream();
  runToDone(store, transport);

  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '甲'), 'valid');
  assert.equal(codeState(pool, '乙'), 'valid');
  assert.equal(validCount(pool), 2);
  assert.equal(stopScraping(pool), true, '够 2 条有效 ⇒ 抓取侧该停了');
});

test('已兑换（200112）也算**有效** —— "口令本身是对的"', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport } = fakeUpstream({ draw: { 甲: { code: 200112, msg: '已兑换过' } } });
  runToDone(store, transport);

  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '甲'), 'valid', '已兑换 ≠ 口令错');
  assert.equal(pool.claims[accountOf(store)]?.['甲'], 'alreadyClaimed');
});

test('200108 ⇒ 池里**无效**（下一轮不再投它）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport } = fakeUpstream({ draw: { 甲: { code: 200108, msg: '口令无效' } } });
  runToDone(store, transport);

  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '甲'), 'invalid');
  assert.equal(pool.codes.find((c) => c.value === '甲')?.reason, '口令无效');
  assert.deepEqual(collectCodes(store, Date.parse(NOW)), [], '判过无效 ⇒ 不再进下一轮');
});

test('200118 ⇒ 池里**无效**，但原因留成"已过期"（界面上要能看出是哪一种）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport } = fakeUpstream({ draw: { 甲: { code: 200118, msg: '口令已失效' } } });
  runToDone(store, transport);

  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '甲'), 'invalid', '行为上不可复用 ⇒ 无效');
  assert.equal(pool.codes.find((c) => c.value === '甲')?.reason, '口令已过期');
});

test('⚠ 200118 在池里算**无效**，但在协议层**不算"口令认错了"** —— 两处刻意分开', () => {
  // 合并这两处会得到"要么不停地重听、要么拿着过期口令反复投"，所以这里把
  // **两个结论**同时钉住（任何一处被"顺手统一"都会红）。
  const out = classifyDraw(envOf(200118));
  assert.equal(out.kind, 'kouling-expired');
  assert.equal(rejectedKouling(out), false, '过期说明我认得没错 ⇒ 不该触发重听');

  const pool = emptyPool();
  noteClaim(pool, 'acc', '甲', claimVerdictOf(out.kind), 1);
  assert.equal(codeState(pool, '甲'), 'invalid', '同一件事，池的答案是"不可复用"');
});

test('别的码（未分类）**不改池里的状态**，但这条口令对这个账号到此为止', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  const { transport } = fakeUpstream({ draw: { 甲: { code: 200103, msg: '红花数不够' } } });
  runToDone(store, transport);

  const { pool } = loadPoolFrom(store);
  const account = accountOf(store);
  // ① 池里的**状态**不变（连条目都不建）：未分类的码不能当有效性判据
  assert.equal(codeState(pool, '甲'), undefined, '没分类 ⇒ 不建条目、不改状态');
  assert.equal(pool.claims[account]?.['甲'], 'other', '但账号级的结论如实记下');
  // ② 这个账号**不再被投**这条口令 —— 这是 mcloud `pick_for` 的口径：
  //    它按"这个账号对这条口令有没有过结论"筛，**不是**按结论的内容筛。
  assert.deepEqual(collectCodes(store, Date.parse(NOW)), [], '有过结论（哪怕是未分类）⇒ 这个账号不再投它');
  // ③ 而**别的账号**照样投 —— 池里的状态没变，口令本身没被判定为坏
  assert.deepEqual(pickFor(pool, '另一个账号'), []);
  note(pool, ['甲'], 'xiaohongshu', Date.parse(NOW));
  assert.deepEqual(pickFor(pool, '另一个账号'), ['甲'], '换账号就投（那是账号级的记录）');
});

test('失败的那一枪**不写回池**（没拿到信封 = 什么都没验过）', () => {
  const store = seeded({ codes: ['甲'], enabled: true });
  let fail = true;
  const transport = ((req: BuiltRequest) => {
    const u = req.url;
    if (u.includes('/redFlower/draw')) {
      if (fail) return { error: '请求失败: http status: 502' };
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'ok', result: { flowerNum: 1 } }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'ok', result: { flowerCnt: 100 } }) };
  }) as Transport;

  runToDone(store, transport);
  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '甲'), undefined, '请求失败 ⇒ 池里连这条都不该有（它只从"验证"进池）');

  fail = false;
  runToDone(store, transport);
  assert.equal(codeState(loadPoolFrom(store).pool, '甲'), 'valid', '下一次成功才写回');
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

test('**换账号**之后，同一批口令必须重新领 —— 判据不能只看"口令变没变"', () => {
  // ⚠ 2026-10-14 实机踩出来的：口令是**共享资源**（谁拿到都能用），余额是**每个账号
  //   自己的**。第二、第三个账号跑的时候，因为"口令没变"，那一轮被直接跳过 ⇒
  //   **一条都领不到，而界面看起来一切正常**。守卫要连账号一起比。
  const store = seeded({ codes: ['秋游影集轻松做'], enabled: true });
  const up = fakeUpstream();
  const deps = { store, transport: up.transport, nowIso: NOW };

  // 账号 A 跑完一轮
  for (let i = 0; i < 20; i += 1) {
    const out = runLiveDraw(deps);
    if (out.idle || (loadDrawState(store)?.step ?? '') === 'done') break;
  }
  const first = loadDrawState(store);
  assert.equal(first?.step, 'done');
  assert.equal(first?.account, accountOf(store), '第一轮要把账号记下来');

  // 同一个账号再跑：跳过（这是原本就有的判据，要保住）
  const again = runLiveDraw(deps);
  assert.equal(again.idle, true, '同一账号 + 同一批口令 ⇒ 不重复领');
  assert.match(again.note, /没变/);

  // **换账号**再跑：必须重新起一轮（否则第二个账号永远领不到）
  // 换一个账号：`accountOf` 是从 `Authorization` 里解手机号的（同一副凭据形状）
  const other = 'Basic ' + Buffer.from('mobile:13900000001:tok', 'utf8').toString('base64');
  store.setState(STATE_AUTH_KEY, other, NOW);
  assert.notEqual(accountOf(store), first?.account, '换了账号之后 accountOf 必须变（否则这条测试没意义）');
  const third = runLiveDraw(deps);
  assert.notEqual(third.idle, true, `换账号之后不该被跳过；实际 note=${third.note}`);
  const st2 = loadDrawState(store);
  assert.equal(st2?.account, accountOf(store), '新的一轮记的是新账号');
});
