// 「直播自动定时」（mcloud 的 `live_auto`）—— 逐条对着 `mcloud-core/src/live_auto.rs` 核。
//
// 守的是四个"照直觉会写错"的地方：
//   · 时刻 = **最早的「下一场」+ 1 小时**（不是开播那一刻：那一小时留给主播发口令）
//   · 比较只比**字符串**（定长 ⇒ 字典序 = 时间序），解析只用于"加一小时"
//   · **只认东八区**：用机器本地时区会让"几点醒"整体偏几小时
//   · 没有/过期的日程 ⇒ **不许凭空造一个时刻**，退回默认重查

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDLE_RECHECK_MS,
  MAX_IDLE_RECHECK_MS,
  listenReadingLine,
  loadListenSeconds,
  loadListenState,
  runLiveListen,
  type ListenDeps,
} from '../src/mcloud/tasks/liveListen.ts';
import {
  loadWakePlan,
  refreshWakePlan,
  runLiveAuto,
  saveWakePlan,
  wakeSleepMs,
} from '../src/mcloud/tasks/liveAutoTask.ts';
import {
  earliestPlusOneHour,
  formatLocalMs,
  nextIdleCheckMs,
  oneShotExpr,
  parseLocalMs,
  planDue,
  planInWindow,
  type WakePlan,
} from '../src/mcloud/liveAuto.ts';
import { emptyPool, noteProbe, savePoolTo, loadPoolFrom } from '../src/mcloud/koulingPool.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-14T08:00:00.000Z'; // = 东八区 16:00
const NOW_MS = Date.parse(NOW);

// ⚠ 期望值一律用**显式 +08:00** 写出来：这样连"跑测试的机器在哪个时区"都不参与。
const at = (local: string): number => Date.parse(`${local.replace(' ', 'T')}+08:00`);

test('东八区墙钟串 ↔ epoch：互为逆，且不依赖机器时区', () => {
  assert.equal(parseLocalMs('2026-10-15 11:00:00'), at('2026-10-15 11:00:00'));
  assert.equal(parseLocalMs('2026-10-15 11:00'), at('2026-10-15 11:00:00'), '缺秒按 0 算');
  assert.equal(formatLocalMs(at('2026-10-15 11:00:00')), '2026-10-15 11:00:00');
  assert.equal(formatLocalMs(at('2026-01-02 03:04:05')), '2026-01-02 03:04:05');
});

test('解不出来的输入一律 `undefined`（**不许瞎猜时刻**）', () => {
  assert.equal(parseLocalMs(''), undefined);
  assert.equal(parseLocalMs('2026/10/15 11:00:00'), undefined);
  assert.equal(parseLocalMs('2026-13-01 00:00:00'), undefined, '13 月');
  // ⚠ `Date.UTC` 会把 2 月 30 日静默进位成 3 月 2 日 —— 回读一遍才挡得住
  assert.equal(parseLocalMs('2026-02-30 10:00:00'), undefined);
  assert.equal(parseLocalMs('2026-10-15 25:00:00'), undefined);
});

test('时刻 = **最早的「下一场」+ 1 小时**（mcloud 口径：那一小时留给主播发口令）', () => {
  assert.equal(
    earliestPlusOneHour(['2026-10-15 20:00:00', '2026-10-15 11:00:00'], NOW_MS),
    '2026-10-15 12:00:00',
    '两场 ⇒ 取最早那场 +1h',
  );
  assert.equal(earliestPlusOneHour(['2026-10-15 11:00:00'], NOW_MS), '2026-10-15 12:00:00');
  // 跨小时 / 跨天 / 跨月都要对
  assert.equal(earliestPlusOneHour(['2026-10-15 23:30:00'], NOW_MS), '2026-10-16 00:30:00');
  assert.equal(earliestPlusOneHour(['2026-10-31 23:30:00'], NOW_MS), '2026-11-01 00:30:00');
  // 空串/坏值跳过；全坏 ⇒ 没有（不是"造一个"）
  assert.equal(earliestPlusOneHour(['', '  ', 'bogus', '2026-10-15 11:00:00'], NOW_MS), '2026-10-15 12:00:00');
  assert.equal(earliestPlusOneHour(['bogus'], NOW_MS), undefined);
  assert.equal(earliestPlusOneHour([], NOW_MS), undefined);
});

test('等价 cron（读数用）：⚠ 没有年字段 ⇒ 它是"每年今天"', () => {
  assert.equal(oneShotExpr('2026-10-15 11:00:00'), '0 0 11 15 10 *');
  assert.equal(oneShotExpr('2026-01-02 03:04:05'), '5 4 3 2 1 *');
  assert.equal(oneShotExpr('坏'), undefined);
});

test('到点判据：提前醒**不算**（否则又变回轮询）；过期计划不算"在窗口里"', () => {
  const plan: WakePlan = {
    wakeAt: '2026-10-15 11:00:00',
    wakeAtMs: at('2026-10-15 11:00:00'),
    fromStart: '2026-10-15 10:00:00',
    computedAt: '2026-10-14 16:00:00',
    windowMs: 10 * 60 * 1000,
  };
  assert.equal(planDue(plan, plan.wakeAtMs - 1), false);
  assert.equal(planDue(plan, plan.wakeAtMs), true);
  assert.equal(planDue(null, NOW_MS), false);
  assert.equal(planInWindow(plan, plan.wakeAtMs + 1000), true);
  assert.equal(planInWindow(plan, plan.wakeAtMs + plan.windowMs), false, '窗口过完');
});

test('凌晨 3 点前不打扰上游：下一次检查推到 3 点', () => {
  // 东八区 01:00 ⇒ 推到当天 03:00（= 2 小时）
  const oneAm = at('2026-10-15 01:00:00');
  const ms = nextIdleCheckMs(oneAm, IDLE_RECHECK_MS);
  assert.equal(formatLocalMs(oneAm + ms), '2026-10-15 03:00:00');
  // 白天 ⇒ 就是默认那点时间
  const fourPm = at('2026-10-15 16:00:00');
  assert.equal(nextIdleCheckMs(fourPm, IDLE_RECHECK_MS), IDLE_RECHECK_MS);
});

// ── 与池子/任务的集成 ────────────────────────────────────────────────────

function storeWithSchedule(opts: { expectStartTime: string; seenAtMs: number }): ReturnType<typeof memStore> {
  const store = memStore();
  store.ensureSchema();
  const pool = emptyPool();
  noteProbe(
    pool,
    [
      {
        roomId: 147868,
        title: '云盘直播福利场',
        status: 0, // 预告场
        expectStartTime: opts.expectStartTime,
        anchorNickname: KOULING_ANCHOR_OF_TEST,
      },
    ],
    false,
    opts.seenAtMs,
  );
  savePoolTo(store, pool, new Date(opts.seenAtMs).toISOString());
  return store;
}

// 与 `liveGate.KOULING_ANCHOR` 同一个昵称（这里写死是为了让测试一眼看出"判据是昵称"）
const KOULING_ANCHOR_OF_TEST = '中国移动云盘';

test('池里有「下一场」⇒ 排出"那一刻 + 1 小时"；日程太旧 ⇒ 不排', () => {
  const depsOf = (store: ReturnType<typeof memStore>): Parameters<typeof refreshWakePlan>[0] => ({
    store,
    transport: (() => ({ status: 200, headers: {}, body: '{}' })) as Transport,
    nowIso: NOW,
  });

  const fresh = storeWithSchedule({ expectStartTime: '2026-10-15 11:00:00', seenAtMs: NOW_MS });
  const r1 = refreshWakePlan(depsOf(fresh), { windowMs: 600_000 });
  assert.equal(r1.plan?.wakeAt, '2026-10-15 12:00:00');
  assert.equal(r1.plan?.fromStart, '2026-10-15 11:00:00');
  assert.equal(r1.plan?.expr, '0 0 12 15 10 *');
  assert.equal(loadWakePlan(fresh)?.wakeAt, '2026-10-15 12:00:00', '要落库');

  // 日程是 12 小时前看的 ⇒ 不信它（退回默认重查），并把计划清掉
  const stale = storeWithSchedule({
    expectStartTime: '2026-10-15 11:00:00',
    seenAtMs: NOW_MS - 12 * 3600 * 1000,
  });
  const r2 = refreshWakePlan(depsOf(stale), { windowMs: 600_000 });
  assert.equal(r2.plan, null);
  assert.match(r2.why, /太旧/);
  assert.equal(loadWakePlan(stale), null);
});

test('`live-auto` 一个上游请求都不发（它只算时刻）', () => {
  const store = storeWithSchedule({ expectStartTime: '2026-10-15 11:00:00', seenAtMs: NOW_MS });
  let asked = 0;
  const transport = (() => {
    asked += 1;
    return { status: 200, headers: {}, body: '{}' };
  }) as Transport;
  const out = runLiveAuto({ store, transport, nowIso: NOW }, { windowMs: 600_000 });
  assert.equal(out.ok, true);
  assert.match(out.note, /10-15 12:00/);
  assert.equal(asked, 0, '零请求是这条任务的意义（"没开播时也别去问"）');
});

test('听弹幕那条链的冷却：有计划就睡到那一刻，没计划才是 5 分钟', () => {
  const store = storeWithSchedule({ expectStartTime: '2026-10-15 11:00:00', seenAtMs: NOW_MS });
  // ⚠ 计划要先算出来（`live-auto` 每隔 5 分钟算一次；这里直接调同一个函数）
  refreshWakePlan({ store, transport: (() => ({ status: 200, headers: {}, body: '{}' })) as Transport, nowIso: NOW }, { windowMs: 600_000 });
  assert.equal(wakeSleepMs(store, NOW_MS, 600_000), at('2026-10-15 12:00:00') - NOW_MS);

  // 计划已到点 ⇒ 不睡（那是"该醒"，让链重走门）
  const due: WakePlan = {
    wakeAt: '2026-10-14 15:00:00',
    wakeAtMs: at('2026-10-14 15:00:00'),
    fromStart: '2026-10-14 14:00:00',
    computedAt: '2026-10-14 10:00:00',
    windowMs: 600_000,
  };
  saveWakePlan(store, due, NOW);
  assert.equal(wakeSleepMs(store, NOW_MS, 600_000), undefined);

  // 没有计划 ⇒ 默认
  assert.equal(wakeSleepMs(memStore(), NOW_MS, 600_000), undefined);
  assert.ok(MAX_IDLE_RECHECK_MS > IDLE_RECHECK_MS, '上限要比默认大（否则"睡到那时"没意义）');
});

test('门关着时的冷却真的按计划设：睡到"下一场 + 1 小时"', () => {
  // ⚠ 这条是端到端的接线判据：`live-auto` 算出来的时刻，必须**真的**进到
  //   听弹幕那条链的 `nextCheckAtMs` 里 —— 否则"到点才醒"只是句漂亮话。
  const store = storeWithSchedule({ expectStartTime: '2026-10-15 11:00:00', seenAtMs: NOW_MS });
  refreshWakePlan({ store, transport: (() => ({ status: 200, headers: {}, body: '{}' })) as Transport, nowIso: NOW }, { windowMs: 600_000 });

  // 门关着（上游回的房间里没有目标主播）
  const deps = {
    store,
    transport: (() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ rtnCode: '0', rtnMsg: null, object: { dataList: [] } }),
    })) as Transport,
    nowIso: NOW,
  } as unknown as ListenDeps;

  // 先让它把票换到（握手那步要真响应不好造）—— 直接看 rooms 步：把状态摆到 rooms
  const st = loadListenState(store) ?? {
    step: 'handshake' as const,
    windowStartMs: NOW_MS,
    frames: 0,
    danmakuFrames: 0,
    acks: 0,
    codes: [] as string[],
    startedAt: NOW,
  };
  store.setState(
    'mcloud.live.listen',
    JSON.stringify({ ...st, step: 'rooms', windowStartMs: NOW_MS, jwt: 'JWT' }),
    NOW,
  );
  const out = runLiveListen(deps);
  assert.match(out.note, /没在听/);
  const after = loadListenState(store);
  assert.ok(after?.nextCheckAtMs !== undefined);
  // ⚠ 有**上限**（[`MAX_IDLE_RECHECK_MS`] = 12 小时）：这一场是明天 11 点（还差 20 小时），
  //   所以冷却被截到 12 小时 —— 12 小时后重查一次（3 个请求），再继续睡。
  //   上限的意义是**兜住过期的计划**（面板睡了一晚、池里那份日程已经不可信）。
  const want = Math.min(at('2026-10-15 12:00:00') - NOW_MS, MAX_IDLE_RECHECK_MS);
  assert.equal(after!.nextCheckAtMs, NOW_MS + want, '冷却要正好是"到那一刻醒"（受上限约束）');
  assert.ok(want > IDLE_RECHECK_MS, '总得比默认的 5 分钟长，否则这条优化没生效');
  assert.match(listenReadingLine(after), /这一轮结束|没在听|准备中/);
});
