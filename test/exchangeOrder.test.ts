// 兑换下单 —— 这一族是**唯一不可逆**的一步（真扣豆，`oid` 由服务端生成，发出去不收回来）。
// 所以这里测的重点不是"能不能下单"，而是**该不发时有没有发**。
//
// 逐条钉住四件事：
//   ① 滑块算不出来 ⇒ **一枪都不发**（拿 0 去凑是拿真豆去赌）
//   ② `514` 才重取一题，且上限 `SLIDER_ROUNDS` 轮，**不重复下单**
//   ③ 成交判据是**余额差**，不是响应里那句话
//   ④ 逐接口的入参差异（取滑块用 form、下单才有 `isdeviceid`）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_SLIDER_WRONG,
  SLIDE_FORM_CONTENT_TYPE,
  SLIDER_ROUNDS,
  STATE_STEP,
  STEP_TEXT,
  clearOrder,
  pickPrize,
  runOrderStep,
  startOrder,
} from '../src/mcloud/tasks/exchangeOrder.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-14T01:00:00.000Z';

function mkStore() {
  const store = memStore();
  store.ensureSchema();
  // 会话里要有 deviceId（不带它下单会回 615，而文案像"活动太火爆"）
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', deviceId: 'BDEV', savedAt: NOW }), NOW);
  return store;
}

/** 假上游：按路径给响应；记录每一枪。 */
function upstream(routes: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    for (const [frag, body] of Object.entries(routes)) {
      if (req.url.includes(frag)) {
        return {
          status: 200,
          headers: {},
          body: typeof body === 'function' ? (body as (r: BuiltRequest) => string)(req) : JSON.stringify(body),
        };
      }
    }
    const d = defaults['*'];
    return { status: 200, headers: {}, body: JSON.stringify(d ?? { code: 0, result: {} }) };
  }) as never;
  return { transport, sent };
}

const deps = (store: ReturnType<typeof mkStore>, transport: never): TaskDeps =>
  ({ store, transport, nowIso: NOW, baseUrl: undefined }) as TaskDeps;

// ⚠ 夹具按**真机形状**摆（两个我踩过的点）：
//   ① 分组是「键 → **数组**」（不是 `{prizeList: [...]}`）；
//   ② 字段是 `prizeName` 与 `pOrder`（**不是** `name`/`price`）——
//      真机上 `price` 这个键根本不存在，而 `POrder`/`pOrder` 两种拼法并存。
//   夹具写错的表现很误导：不是"解析崩了"，而是"清单里没有这件奖品"。
const LIST_HIT = {
  code: 0,
  result: { g1: [{ prizeId: 42, prizeName: '钻石会员季卡', limit: 0, pOrder: 880 }] },
};

test('清单里挑奖品：名字**精确**匹配，不做子串', () => {
  const prizes = [
    { prizeId: 1, name: '钻石会员季卡', limit: 0 },
    { prizeId: 2, name: '钻石会员月卡', limit: 0 },
  ] as never[];
  assert.equal(pickPrize(prizes, '2')!.prizeId, 2, '数字当 prizeId');
  assert.equal(pickPrize(prizes, '钻石会员月卡')!.prizeId, 2);
  assert.equal(pickPrize(prizes, '钻石会员')!, undefined, '子串不匹配（否则会命中另一件）');
  assert.equal(pickPrize(prizes, '没有这件')!, undefined);
});

test('起一单**一个请求都不发**；没指定奖品就拒绝', () => {
  const store = mkStore();
  const { transport, sent } = upstream({});
  assert.equal(runOrderStep(deps(store, transport)).idle, true, '没排队 ⇒ idle（不刷噪声）');
  const bad = startOrder(deps(store, transport), '  ');
  assert.equal(bad.ok, false);
  assert.equal(sent.length, 0);
  assert.equal(startOrder(deps(store, transport), '钻石会员季卡').ok, true);
  assert.equal(sent.length, 0, '起单只是写字，不发请求');
});

test('**主线**：一步一枪，顺序与枪序一致', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
    // 造一张"解得出"的题面：用底图上挖洞的那套（与 slide.test.ts 同构）
    getSlide: { code: 0, result: {} },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  const steps: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const out = runOrderStep(deps(store, transport));
    steps.push(out.note);
    void out;
  }
  assert.equal(sent.length, 4);
  assert.ok(sent[0]!.url.includes('exchangeList'), sent[0]!.url);
  assert.ok(sent[1]!.url.includes('infoV3'), sent[1]!.url);
  assert.ok(sent[2]!.url.includes('optkeyword=newsignin_index_to_exchange'), sent[2]!.url);
  assert.ok(sent[3]!.url.includes('optkeyword=newsignin_index_exchange_times'), sent[3]!.url);
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[2]!.method, 'POST');
  void steps;
});

test('⚠ 清单说不能兑 ⇒ 后面**一枪都不发**（余额、预热、下单全免）', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: { code: 0, result: { g1: [{ prizeId: 42, prizeName: '季卡', limit: 2, pOrder: 880 }] } },
  });
  startOrder(deps(store, transport), '季卡');
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.equal(sent.length, 1, `只该有那一次只读清单，实际 ${sent.length}`);
  assert.match(out.note, /不能兑|不发下一枪/);
});

test('⚠ 余额不够 ⇒ 也不往下走（第 2 枪之后就停）', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 100 } },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  runOrderStep(deps(store, transport)); // ① 清单
  const out = runOrderStep(deps(store, transport)); // ② 余额
  assert.equal(out.ok, false);
  assert.match(out.note, /余额 100 < 价格 880|不做/);
  assert.equal(sent.length, 2, '不该有第 3 枪');
});

test('⚠ 滑块解不出来 ⇒ **不发下单那一枪**，而且如实说是"没发"', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
    // 题面给两张**不是 PNG** 的垃圾 ⇒ 解码失败 ⇒ 必须不发
    getSlide: { code: 0, result: { puzzleImg: 'bm90YXBuZw==', pictureImg: 'bm90YXBuZw==' } },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  for (let i = 0; i < 3; i += 1) runOrderStep(deps(store, transport)); // 清单/余额/预热1
  runOrderStep(deps(store, transport)); // 预热2
  const out = runOrderStep(deps(store, transport)); // 取题 → 解不出
  assert.equal(out.ok, false);
  assert.match(out.note, /不发下单那一枪/);
  assert.equal(sent.filter((r) => r.url.includes('exchangeV3')).length, 0, '一个字都不许发给 exchangeV3');
});

test('⚠ 没有 deviceId ⇒ 停在下单前（不回 615 让上游说"活动太火爆"）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  for (let i = 0; i < 4; i += 1) runOrderStep(deps(store, transport));
  // 直接把状态推到 order 那一步（跳过取题，专测 deviceId 这条闸门）
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'order', round: 0, plan: { prizeId: 42, prizeName: 'x', query: 'x' }, offset: 137 }),
    NOW,
  );
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /deviceId/);
  assert.equal(sent.filter((r) => r.url.includes('exchangeV3')).length, 0);
});

test('`514` ⇒ 重取一题再来一枪，上限 2 轮，且**只有它**能重来', () => {
  assert.equal(SLIDER_ROUNDS, 2);
  assert.equal(CODE_SLIDER_WRONG, 514);
  // 状态推到"刚取到 offset、准备下单"
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeV3: { code: 0, result: { code: 514 } } });
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'order', round: 0, plan: { prizeId: 42, prizeName: 'x', query: 'x' }, offset: 137 }),
    NOW,
  );
  const r1 = runOrderStep(deps(store, transport));
  assert.equal(r1.ok, true);
  assert.match(r1.note, /514/);
  const st1 = JSON.parse(store.getState(STATE_STEP)!) as { step: string; round: number };
  assert.equal(st1.step, 'slide', '要回到取题那一步（重取一题）');
  assert.equal(st1.round, 1);
  assert.equal(sent.length, 1);
  // 第二轮再 514 ⇒ 超过上限就得停手
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'order', round: 2, plan: { prizeId: 42, prizeName: 'x', query: 'x' }, offset: 137 }),
    NOW,
  );
  const r2 = runOrderStep(deps(store, transport));
  assert.equal(r2.ok, false);
  assert.match(r2.note, /停手/);
});

test('⚠ 成交判据是**余额差**，不是响应里那句话', () => {
  const store = mkStore();
  // ⚠ 这里状态直接从 `verify` 起步（基准是手工塞的），所以**只有一枪** `infoV3`
  //   —— 它回的就是"成交之后"的那个数
  const after = { code: 0, result: { total: 4120 } };
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status: 200, headers: {}, body: JSON.stringify(after) };
  }) as never;
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'verify', round: 0, plan: { prizeId: 42, prizeName: 'x', query: 'x' } }),
    NOW,
  );
  store.setState('mcloud.exchange.order.baseline', '5000', NOW);
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /成交/);
  assert.match(out.note, /扣了 880 豆/);
});

test('没扣豆 ⇒ 如实报"没成交"（哪怕上游回了个成功码）', () => {
  const store = mkStore();
  const transport = ((req: BuiltRequest) => {
    if (req.url.includes('infoV3')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { total: 5000 } }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { msg: '兑换成功' } }) };
  }) as never;
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'verify', round: 0, plan: { prizeId: 42, prizeName: 'x', query: 'x' } }),
    NOW,
  );
  store.setState('mcloud.exchange.order.baseline', '5000', NOW);
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /没成交/);
  assert.match(out.note, /只有余额差算数/);
});

test('逐接口的入参差异：取滑块用 **form**、下单才有 `isdeviceid`', () => {
  assert.equal(SLIDE_FORM_CONTENT_TYPE, 'application/x-www-form-urlencoded;charset=UTF-8');
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeV3: { code: 0, result: {} }, getSlide: { code: 0, result: {} } });
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'order', round: 0, plan: { prizeId: 42, prizeName: 'x', query: 'x' }, offset: 137 }),
    NOW,
  );
  runOrderStep(deps(store, transport));
  assert.equal(sent[0]!.headers.isdeviceid, 'true');
  assert.equal(sent[0]!.headers.origin, 'https://m.mcloud.139.com');
  const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
  assert.equal(body.prizeId, 42);
  assert.equal(body.puzzleOffset, 137, 'offset 要**原样**带上（不是字符串）');
  assert.equal(body.deviceId, 'BDEV');
  assert.equal(body.client, 'app');
  assert.equal(body.clientVersion, '12.6.0');
});

test('`clearOrder` 把这一单彻底清掉（再做一单不会续上旧的）', () => {
  const store = mkStore();
  const { transport } = upstream({});
  startOrder(deps(store, transport), '季卡');
  assert.ok(store.getState(STATE_STEP));
  clearOrder(deps(store, transport));
  assert.equal(store.getState(STATE_STEP), '');
  assert.equal(runOrderStep(deps(store, transport)).idle, true);
});

test('步骤文案齐全（面板要靠它显示走到哪了）', () => {
  for (const k of ['list', 'balance', 'warm-1', 'warm-2', 'slide', 'order', 'verify', 'done'] as const) {
    assert.ok(STEP_TEXT[k], `缺 ${k}`);
  }
});


test('⚠ 余额字段是 `total`（真机实测；写成 `point` 的现象是"没读到"）', () => {
  // 真机 infoV3 的 result 键：beforeTotal / signInPoints / total / time / … —— **没有** `point`
  const store = mkStore();
  const transport = ((req: BuiltRequest) =>
    ({ status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { total: 9188, beforeTotal: 5392 } }) })) as never;
  startOrder(deps(store, transport), '季卡');
  // 推到 ② 读余额
  store.setState(
    STATE_STEP,
    JSON.stringify({ step: 'balance', round: 0, plan: { prizeId: 42, prizeName: 'x', price: 50, query: 'x' } }),
    NOW,
  );
  const out = runOrderStep(deps(store, transport));
  assert.match(out.note, /9188/, `该读到 total=9188：${out.note}`);
  assert.equal(store.getState('mcloud.exchange.order.baseline'), '9188', '基准要落库（⑥ 靠它算差值）');
});


test('⚠ 判不了（缺 `limit`）⇒ **也不发** —— 放宽等于把"不确定"当成"可以花豆"', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: { code: 0, result: { g1: [{ prizeId: 42, prizeName: '季卡', pOrder: 880 }] } },
  });
  startOrder(deps(store, transport), '季卡');
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /判不了/);
  assert.equal(sent.length, 1, '只该有那次只读清单');
});

test('判据回到"**只有 ok 才走**"：四档否定各拦一次', () => {
  for (const [limit, word] of [[1, '明日'], [2, '已兑'], [4, '已兑'], [9, '判不了']] as const) {
    const store = mkStore();
    const { transport, sent } = upstream({
      exchangeList: { code: 0, result: { g1: [{ prizeId: 42, prizeName: '季卡', limit, pOrder: 880 }] } },
    });
    startOrder(deps(store, transport), '季卡');
    const out = runOrderStep(deps(store, transport));
    assert.equal(out.ok, false, `limit=${limit} 该被拦住`);
    assert.match(out.note, new RegExp(word), `limit=${limit}：${out.note}`);
    assert.equal(sent.length, 1, `limit=${limit} 不该有第二枪`);
  }
});
