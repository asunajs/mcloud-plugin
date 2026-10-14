// 兑换下单 —— 这一族是**唯一不可逆**的一步（真扣豆），所以这里测的重点不是"能不能下单"，
// 而是**该发的时候有没有发出去**、以及**没成交时会不会自我安慰**。
//
// 口径（用户定的，代码与这里必须一致）：
//   ① **不判** —— 本地判据（清单那几档"不能兑"、余额够不够）**一律不参与走向**。
//      不挡路的判据是装饰：算了不用，看代码的人还会以为它在起作用。
//      ⇒ 清单只做**选择**；余额那一读的身份是**成交复查的基准**，不是判据。
//   ② **滑块不属这一类** —— offset 算错那一枪**不可能成功**（回 514、不成交也不扣豆），
//      所以算不出就不发。那一枪的代价是白耗一次题面，**不是豆**。
//      （⚠ 扣豆是**成交的标志**，是目标不是损失 —— 这一点我一开始想反过。）
//   ③ 成交判据是**余额差**，不是上游响应里那句话（这一族没有幂等键，`oid` 由服务端生成）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_SLIDER_WRONG,
  SLIDE_FORM_CONTENT_TYPE,
  SLIDER_ROUNDS,
  STATE_BASE,
  STATE_ORDERED_HOUR,
  STATE_STEP,
  STEP_TEXT,
  clearOrder,
  currentStep,
  pickPrize,
  restoreOrder,
  runOrderStep,
  snapshotOrder,
  startOrder,
} from '../src/mcloud/tasks/exchangeOrder.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-14T01:00:00.000Z';
const EXCHANGE_V3 = 'exchangeV3';

function mkStore(withDevice = true) {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: '', jwt: 'J', ...(withDevice ? { deviceId: 'BDEV' } : {}), savedAt: NOW }),
    NOW,
  );
  return store;
}

// ⚠ **必须注入时钟**：链上的"等窗口 / 压整点"读的是 `deps.nowMs()`，
//   不注入就落到真 `Date.now()` —— 而测试跑的任意时刻离窗口多半超过 30 秒，
//   链会如实返回"还没到窗口"。更要紧的是：第一版没有注入时，
//   一个在 59:00 附近跑的测试会**自旋 40 分钟**（`npm test` 直接挂住）。
//
//   `NOW` 取**正好整点**：此时窗口判定与整点判定都落在"上一场尾巴"那一档
//   （整点后 15/20 秒内 ⇒ 都不等），所以链一路往下跑，一次都不自旋。
/** 假时钟：自旋时**往前推**，模拟"时间过去了"。
 *
 *  ⚠ 不推的话自旋会真的转下去 —— 而链上**确实有一处必须自旋**：
 *  预热两枪之间那 500ms（契约的一部分，`task_preheat` 的顺序与间隔）。
 *  第一版这里写的是"自旋就抛错"，于是它立刻抓到了那 500ms
 *  —— 护栏起作用了，但用法错了：测试要的是"时间会走"，不是"不许等"。
 *
 *  每次推 500ms：正好一步跨过预热间隔，同时不会让窗口/整点判定漂移
 *  （`NOW` 取的是整点，那些判定本来就不触发）。 */
function fakeClock(): { nowMs: () => number; spin: () => void } {
  let now = Date.parse(NOW);
  return {
    nowMs: () => now,
    spin: () => {
      now += 500;
    },
  };
}

const deps = (store: ReturnType<typeof mkStore>, transport: never): TaskDeps =>
  ({ store, transport, nowIso: NOW, baseUrl: undefined, ...fakeClock() }) as TaskDeps;

function upstream(routes: Record<string, unknown>) {
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    for (const [frag, body] of Object.entries(routes)) {
      if (req.url.includes(frag)) return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: {} }) };
  }) as never;
  return { transport, sent };
}

// ⚠ 夹具按**真机形状**摆（两个我踩过的点）：
//   ① 分组是「键 → **数组**」（不是 `{prizeList: [...]}`）；
//   ② 字段是 `prizeName` 与 `pOrder`（**不是** `name`/`price`）——
//      真机上 `price` 这个键根本不存在，而 `POrder`/`pOrder` 两种拼法并存。
//   夹具写错的表现很误导：不是"解析崩了"，而是"清单里没有这件奖品"。
const prize = (extra: Record<string, unknown> = {}) => ({
  prizeId: 42,
  prizeName: '钻石会员季卡',
  limit: 0,
  pOrder: 880,
  ...extra,
});
const LIST_HIT = { code: 0, result: { g1: [prize()] } };

/** 状态直接推到某一步（跳过前面的枪）。 */
function goto(store: ReturnType<typeof mkStore>, st: Record<string, unknown>) {
  store.setState(STATE_STEP, JSON.stringify(st), NOW);
}

const PLAN = { prizeId: 42, prizeName: 'x', query: 'x' };

// ───────────────────────── 选择（不是判定） ─────────────────────────

test('挑奖品：名字**精确**匹配，不做子串', () => {
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
  assert.equal(startOrder(deps(store, transport), '  ').ok, false);
  assert.equal(sent.length, 0);
  assert.equal(startOrder(deps(store, transport), '钻石会员季卡').ok, true);
  assert.equal(sent.length, 0, '起单只是写字，不发请求');
});

test('清单里没有这件 ⇒ 如实说，且**只发那一枪只读清单**', () => {
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeList: LIST_HIT });
  startOrder(deps(store, transport), '不存在的奖品');
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /没有/);
  assert.equal(sent.length, 1);
});

// ───────────────────────── ① 不判 ─────────────────────────

test('⚠ **不判**：清单那几档"不能兑"**完全不参与走向**（代码里没有判定）', () => {
  for (const limit of [0, 1, 2, 4, 9, undefined] as const) {
    const store = mkStore();
    const { transport, sent } = upstream({
      exchangeList: { code: 0, result: { g1: [prize({ limit })] } },
      infoV3: { code: 0, result: { total: 5000 } },
    });
    startOrder(deps(store, transport), '钻石会员季卡');
    const out = runOrderStep(deps(store, transport));
    assert.equal(out.ok, true, `limit=${String(limit)}：${out.note}`);
    // 这条比"照样发"更强：要求 note 里**没有判定用语**（判定根本不该被算出来）
    assert.doesNotMatch(out.note, /可兑|不能兑|判不了|已兑|明日/, `limit=${String(limit)}`);
    assert.equal(sent.length, 1);
  }
});

test('⚠ **不判**：余额低于价格**完全不参与走向**；那一读是**基准**不是判据', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 100 } }, // 远低于 880
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  runOrderStep(deps(store, transport)); // ① 清单
  const out = runOrderStep(deps(store, transport)); // ② 基准
  assert.equal(out.ok, true, out.note);
  assert.doesNotMatch(out.note, /不够|不足/, '不许出现"余额不够"这种判据用语');
  assert.match(out.note, /基准/);
  assert.equal(sent.length, 2);
  assert.equal((JSON.parse(store.getState(STATE_STEP)!) as { step: string }).step, 'warm-1', '照常往下走');
  assert.equal(store.getState(STATE_BASE), '100', '基准要落库 —— ⑥ 靠它算差值，这才是这一读的作用');
});

test('⚠ 余额字段是 `total`（真机实测；写成 `point` 的现象是"没读到"）', () => {
  const store = mkStore();
  const { transport } = upstream({ infoV3: { code: 0, result: { total: 9188, beforeTotal: 5392 } } });
  startOrder(deps(store, transport), '季卡');
  goto(store, { step: 'balance', round: 0, plan: { ...PLAN, price: 50 } });
  const out = runOrderStep(deps(store, transport));
  assert.match(out.note, /9188/, `该读到 total=9188：${out.note}`);
  assert.equal(store.getState(STATE_BASE), '9188');
});

// ───────────────────────── 枪序 ─────────────────────────

test('**主线**：一步一枪，顺序与枪序一致', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
    getSlide: { code: 0, result: {} },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  for (let i = 0; i < 4; i += 1) runOrderStep(deps(store, transport));
  assert.equal(sent.length, 4);
  assert.ok(sent[0]!.url.includes('exchangeList'), sent[0]!.url);
  assert.ok(sent[1]!.url.includes('infoV3'), sent[1]!.url);
  assert.ok(sent[2]!.url.includes('optkeyword=newsignin_index_to_exchange'), sent[2]!.url);
  assert.ok(sent[3]!.url.includes('optkeyword=newsignin_index_exchange_times'), sent[3]!.url);
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[2]!.method, 'POST');
});

// ───────────────────────── ② 滑块：这一类**不发** ─────────────────────────

test('⚠ 滑块解不出来 ⇒ **不发 exchangeV3**（那一枪发出去是无效的）', () => {
  const store = mkStore();
  const { transport, sent } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
    getSlide: { code: 0, result: { puzzleImg: 'bm90YXBuZw==', pictureImg: 'bm90YXBuZw==' } },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  for (let i = 0; i < 4; i += 1) runOrderStep(deps(store, transport)); // 清单/基准/预热×2
  const out = runOrderStep(deps(store, transport)); // 取题 → 解不出
  assert.equal(out.ok, false, out.note);
  assert.match(out.note, /不发下单那一枪/);
  assert.match(out.note, /不可能成功|白耗/, '理由要说"这一枪不可能成功"，不是"省豆"');
  assert.equal(sent.filter((r) => r.url.includes(EXCHANGE_V3)).length, 0, '一个字都不许发');
  assert.equal(sent.length, 5, '清单/基准/预热×2/取题 —— 就到取题为止');
});

// ───────────────────────── 下单的前置与形状 ─────────────────────────

test('⚠ 没有 deviceId ⇒ 停在下单前（不回 615 让上游说"活动太火爆"）', () => {
  const store = mkStore(false);
  const { transport, sent } = upstream({});
  goto(store, { step: 'order', round: 0, plan: PLAN, offset: 137 });
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /deviceId/);
  assert.equal(sent.filter((r) => r.url.includes(EXCHANGE_V3)).length, 0);
});

test('内部状态缺 offset ⇒ 作废（**不发一个没算出来的数**）', () => {
  const store = mkStore();
  const { transport, sent } = upstream({});
  goto(store, { step: 'order', round: 0, plan: PLAN });
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /缺 offset/);
  assert.equal(sent.length, 0);
});

test('下单那一枪的形状：六个键 + `isdeviceid` + origin，offset 原样带上', () => {
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeV3: { code: 0, result: {} } });
  goto(store, { step: 'order', round: 0, plan: PLAN, offset: 137 });
  runOrderStep(deps(store, transport));
  assert.equal(sent[0]!.headers.isdeviceid, 'true');
  assert.equal(sent[0]!.headers.origin, 'https://m.mcloud.139.com');
  const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
  assert.equal(body.prizeId, 42);
  assert.equal(body.puzzleOffset, 137, 'offset 要**原样**带上（不是字符串）');
  assert.equal(body.deviceId, 'BDEV');
  assert.equal(body.client, 'app');
  assert.equal(body.clientVersion, '12.6.0');
  assert.equal(body.smsCode, '');
});

test('逐接口的入参差异：取滑块用 **form** 的 content-type', () => {
  assert.equal(SLIDE_FORM_CONTENT_TYPE, 'application/x-www-form-urlencoded;charset=UTF-8');
});

// ───────────────────────── 514 与成交判据 ─────────────────────────

test('`514` 才重取一题，上限 2 轮，且**不重复下单**', () => {
  assert.equal(SLIDER_ROUNDS, 2);
  assert.equal(CODE_SLIDER_WRONG, 514);
  const store = mkStore();
  const sent: BuiltRequest[] = [];
  const t2 = ((req: BuiltRequest) => {
    sent.push(req);
    const isOrder = req.url.includes(EXCHANGE_V3);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify(isOrder ? { code: 0, result: { code: 514 } } : { code: 0, result: {} }),
    };
  }) as never;
  goto(store, { step: 'order', round: 0, plan: PLAN, offset: 137 });
  const r1 = runOrderStep(deps(store, t2));
  assert.equal(r1.ok, true);
  assert.match(r1.note, /514/);
  const st1 = JSON.parse(store.getState(STATE_STEP)!) as { step: string; round: number };
  assert.equal(st1.step, 'slide', '要回到取题那一步（重取一题）');
  assert.equal(st1.round, 1);
  assert.equal(sent.length, 1, '这一枪就是"重取一题"的起点，不是重复下单');
  // 到上限就得停手
  goto(store, { step: 'order', round: SLIDER_ROUNDS, plan: PLAN, offset: 137 });
  const r2 = runOrderStep(deps(store, t2));
  assert.equal(r2.ok, false);
  assert.match(r2.note, /停手/);
});

test('⚠ 成交判据是**余额差**，不是响应里那句话', () => {
  const store = mkStore();
  const transport = (() =>
    ({ status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { total: 4120 } }) })) as never;
  goto(store, { step: 'verify', round: 0, plan: PLAN });
  store.setState(STATE_BASE, '5000', NOW);
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /成交/);
  assert.match(out.note, /扣了 880 豆/);
});

test('没扣豆 ⇒ 如实报"没成交"（哪怕上游回了个成功码）', () => {
  const store = mkStore();
  const transport = (() =>
    ({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, result: { total: 5000, msg: '兑换成功' } }),
    })) as never;
  goto(store, { step: 'verify', round: 0, plan: PLAN });
  store.setState(STATE_BASE, '5000', NOW);
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /没成交/);
  assert.match(out.note, /只有余额差算数/);
});

test('拿不到基准 ⇒ 如实说"不知道"，不自我安慰', () => {
  const store = mkStore();
  const transport = (() =>
    ({ status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { total: 5000 } }) })) as never;
  goto(store, { step: 'verify', round: 0, plan: PLAN }); // 基准没落库
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note, /不知道/);
});

// ───────────────────────── 收尾 ─────────────────────────

test('`clearOrder` 把这一单彻底清掉（再做一单不会续上旧的）', () => {
  const store = mkStore();
  const { transport } = upstream({});
  startOrder(deps(store, transport), '季卡');
  assert.ok(store.getState(STATE_STEP));
  clearOrder(deps(store, transport));
  assert.equal(store.getState(STATE_STEP), '');
  assert.equal(runOrderStep(deps(store, transport)).idle, true);
});

test('走完之后再触发 ⇒ idle（不重复走）', () => {
  const store = mkStore();
  const { transport } = upstream({});
  goto(store, { step: 'done', round: 0, plan: PLAN });
  const out = runOrderStep(deps(store, transport));
  assert.equal(out.idle, true);
  assert.match(out.note, /已经走完/);
});

test('⚠ 离窗口还远 ⇒ **不自旋**，如实返回 idle（粗粒度等待是调度器的活）', () => {
  // 没有这一条的话，`@every 5s` 的任务在 59:00 被触发时会自旋 40 分钟：
  // 占住一条线程、面板上看是"卡住了"，而且中间那 8 次触发全排在后面。
  const store = mkStore();
  const { transport } = upstream({
    exchangeList: LIST_HIT,
    infoV3: { code: 0, result: { total: 5000 } },
    journaling: { code: 0 },
  });
  startOrder(deps(store, transport), '钻石会员季卡');
  // 先把链推到 `warm-1`（前两步要发请求，用正常时钟）
  runOrderStep(deps(store, transport));
  runOrderStep(deps(store, transport));

  // 现在把时钟拨到"整点后 5 分钟"—— 离 59:40 还有 55 分钟
  let now = Date.parse(NOW) + 5 * 60_000;
  let spins = 0;
  const before = now;
  const d = {
    store,
    transport,
    nowIso: NOW,
    nowMs: () => now,
    spin: () => {
      spins++;
      now += 1000;
    },
  } as unknown as TaskDeps;

  const out = runOrderStep(d);
  assert.equal(out.idle, true, `该如实返回 idle，实际：${out.note}`);
  assert.equal(spins, 0, '一次都不该自旋');
  assert.equal(now, before, '时钟不该被推动');
  assert.ok(out.note.includes('还没到窗口'), out.note);
  assert.ok(out.note.includes('零请求'), `要说清本次没发请求：${out.note}`);
});

test('⚠ 发过单之后记下"这一小时发过了"（它是防重复花豆的闸）', () => {
  // 链里那段自旋会让排在后面的触发**积压**，跑完之后它们立刻依次执行 ——
  // 而那时已经过了整点，`planFireWait` 会判"现在就发" ⇒ 每一枪都真花豆。
  // 所以发单之后必须留一个"这一小时发过了"的标记，让下一次触发零请求返回。
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeV3: { code: 0, result: {} } });
  const d = deps(store, transport);
  assert.equal(store.getState(STATE_ORDERED_HOUR), null, '一开始没有这个标记');

  // 直接跳到下单那一步（走完整条链要一张能解码的滑块图，那不是这一条要测的）
  goto(store, { step: 'order', round: 0, plan: PLAN, offset: 137 });
  runOrderStep(d);
  assert.ok(
    sent.some((r) => r.url.includes('exchangeV3')),
    '应该已经发过下单那一枪',
  );
  assert.equal(
    store.getState(STATE_ORDERED_HOUR),
    String(Date.parse(NOW) - (Date.parse(NOW) % 3_600_000)),
    '发单之后要记下这一小时',
  );
});

test('⚠ `514`（滑块算错）**不**记那个标记 —— 那一枪没被受理，重取一题再来是安全的', () => {
  const store = mkStore();
  const { transport, sent } = upstream({ exchangeV3: { code: 514, msg: '滑块错误' } });
  const d = deps(store, transport);
  goto(store, { step: 'order', round: 0, plan: PLAN, offset: 137 });
  runOrderStep(d);
  assert.ok(sent.some((r) => r.url.includes('exchangeV3')));
  assert.equal(
    store.getState(STATE_ORDERED_HOUR),
    null,
    '514 是"这一单没成立"，不该上闸（否则滑块那一轮白算）',
  );
});

// ───────────────────────── 多账号：状态快照 / 恢复 ─────────────────────────

test('⚠ 快照/恢复：两个账号各自的进度**不能互相覆盖**', () => {
  // 多账号是**两阶段**跑的：先把每个账号都推到"只差下单"，再等到整点依次发单。
  // 而链的状态是**一整块** blob（`STATE_STEP` 里那个 JSON）—— 不分别存下来的话，
  // 第二个账号的 `startOrder` 会把第一个账号的进度**覆盖掉**，
  // 表现是"第一个账号的滑块白算了，整点那一刻从头再取一次题"。
  const store = mkStore();
  const { transport } = upstream({ exchangeList: LIST_HIT, infoV3: { code: 0, result: { total: 5000 } } });
  const d = deps(store, transport);

  // 账号 A：推到只差下单
  startOrder(d, '钻石会员季卡');
  runOrderStep(d);
  runOrderStep(d);
  const snapA = snapshotOrder(store);
  assert.equal(currentStep(store), 'warm-1', `A 应该停在 warm-1，实际 ${currentStep(store)}`);

  // 账号 B：清掉再推
  clearOrder(d);
  startOrder(d, '钻石会员季卡');
  runOrderStep(d);
  const snapB = snapshotOrder(store);
  assert.equal(currentStep(store), 'balance', 'B 的进度是它自己的');

  // 恢复 A ⇒ A 的进度必须回来（不是 B 的）
  restoreOrder(store, snapA, NOW);
  assert.equal(currentStep(store), 'warm-1', 'A 的进度被 B 覆盖了');
  assert.notEqual(snapA.step, snapB.step);

  // 恢复 B ⇒ 换回 B
  restoreOrder(store, snapB, NOW);
  assert.equal(currentStep(store), 'balance');
});

test('快照/恢复：空状态也能恢复（没跑过的账号）', () => {
  const store = mkStore();
  const empty = snapshotOrder(store);
  assert.equal(empty.step, null);
  assert.equal(currentStep(store), null);
  // 恢复一个空快照不该炸
  restoreOrder(store, empty, NOW);
  assert.equal(currentStep(store), null);
});

test('⚠ `currentStep`：坏数据 ⇒ null（不让多账号驱动卡住）', () => {
  const store = mkStore();
  store.setState(STATE_STEP, '这不是 JSON', NOW);
  assert.equal(currentStep(store), null);
  store.setState(STATE_STEP, '{"step":123}', NOW);
  assert.equal(currentStep(store), null, 'step 不是字符串就当没在跑');
});

test('步骤文案齐全（面板要靠它显示走到哪了）', () => {
  for (const k of ['list', 'balance', 'warm-1', 'warm-2', 'slide', 'order', 'verify', 'done'] as const) {
    assert.ok(STEP_TEXT[k], `缺 ${k}`);
  }
});
