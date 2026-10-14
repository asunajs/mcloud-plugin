// 兑换的**时间**。
//
// # 这一层为什么必须全是纯函数
//
// 「还要等多久才到窗口」「还要等多久才发单」这两件事**没法在真实时钟上测** ——
// 你不可能等一小时看它对不对。所以时间计算全做成纯函数：给一个 `nowMs`，
// 返回"等不等、等多久"。于是边界（正好 59:40 / 正好整点 / 整点后 5 秒 /
// 59:59:59）都能穷举。
//
// # 错一条的代价
//
//   · 窗口边界写错 ⇒ **整点后 0~15 秒内触发的每一次白等 59 分钟**
//   · 整点边界写错 ⇒ 压不住整点，那一枪排在几百人后面
//   · 提前量符号写反 ⇒ 变成"整点后 10ms 发"，正好错过

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TARGET_HOUR,
  FIRE_LEAD_MS,
  WINDOW_LEAD_MS,
  WINDOW_SECOND,
  WINDOW_TAIL_MS,
  hourKey,
  hourStartMs,
  planFireWait,
  planTargetWait,
  planWindowWait,
  targetHourOf,
  timingReading,
  waitUntil,
} from '../src/mcloud/exchangeTiming.ts';

/** 2026-10-15 10:00:00 UTC 这一小时的整点。 */
const HOUR = Date.UTC(2026, 9, 15, 10, 0, 0, 0);
/** 相对整点的偏移。 */
const at = (ms: number): number => HOUR + ms;
const SEC = 1000;
const MIN = 60_000;

test('常量与参考实现同值', () => {
  assert.equal(WINDOW_SECOND, 40, '窗口在 59:40 开');
  assert.equal(WINDOW_TAIL_MS, 15_000, '整点后 15 秒内仍算在窗口里');
  assert.equal(FIRE_LEAD_MS, 10, '压着整点提前 10ms');
  assert.equal(WINDOW_LEAD_MS, 20_000, '窗口宽 20 秒');
});

test('整点截断：本小时的整点，不是"最近的整点"', () => {
  assert.equal(hourStartMs(at(0)), HOUR);
  assert.equal(hourStartMs(at(30 * MIN)), HOUR, '半小时后仍属同一小时');
  assert.equal(hourStartMs(at(59 * MIN + 59 * SEC)), HOUR);
  assert.equal(hourStartMs(at(60 * MIN)), HOUR + 3_600_000, '跨过整点就进下一小时');
});

test('⚠ 负时间戳也要给"未来那个整点"（JS 的 `%` 会给负余数）', () => {
  // `-1 % 3600000 === -1` ⇒ 不减掉它的话"整点"会跑到未来一小时
  assert.equal(hourStartMs(-1), -3_600_000);
  assert.equal(hourStartMs(-3_600_000), -3_600_000);
  assert.ok(hourStartMs(-1) <= -1, '本小时整点必须在过去或等于现在');
});

test('`hourKey` 同一小时内恒定（拿它做"这一小时发过了"的标记）', () => {
  assert.equal(hourKey(at(0)), hourKey(at(30 * MIN)));
  assert.equal(hourKey(at(59 * MIN)), hourKey(at(0)));
  assert.notEqual(hourKey(at(0)), hourKey(at(60 * MIN)));
});

// ══════════════════════ ① 窗口等待 ══════════════════════

test('① 窗口还没开（59:39）⇒ 要等到 59:40', () => {
  const w = planWindowWait(at(59 * MIN + 39 * SEC));
  assert.equal(w.needed, true);
  assert.equal(w.untilMs, at(59 * MIN + 40 * SEC));
  assert.equal(w.ms, 1000, '还差 1 秒');
});

test('① 正好 59:40 ⇒ **不等**（窗口已经开了）', () => {
  const w = planWindowWait(at(59 * MIN + 40 * SEC));
  assert.equal(w.needed, false, '>= 59:40 就不等');
  assert.equal(w.ms, 0);
});

test('① 59:41 / 59:59 ⇒ 不等', () => {
  assert.equal(planWindowWait(at(59 * MIN + 41 * SEC)).needed, false);
  assert.equal(planWindowWait(at(59 * MIN + 59 * SEC)).needed, false);
});

test('⚠① 整点后 0~15 秒 ⇒ **不等**（上一场的尾巴，服务端那一场还没散）', () => {
  // 这一条最容易"顺手优化掉"：看着像"整点刚过，等下一个小时吧"，
  // 而那样会让整点后 0~15 秒内触发的每一次**白等 59 分钟**
  assert.equal(planWindowWait(at(0)).needed, false, '正好整点');
  assert.equal(planWindowWait(at(5 * SEC)).needed, false);
  assert.equal(planWindowWait(at(14_999)).needed, false);
});

test('⚠① 整点后 15 秒 ⇒ **要等**（尾巴结束，等下一个 59:40）', () => {
  const w = planWindowWait(at(WINDOW_TAIL_MS));
  assert.equal(w.needed, true, '15 秒整是尾巴的边界，过了就要等');
  assert.equal(w.untilMs, at(59 * MIN + 40 * SEC), '等的是**本小时**的 59:40');
  assert.equal(w.ms, 59 * MIN + 40 * SEC - WINDOW_TAIL_MS);
});

test('① 等的时候目标是**本小时**的 59:40（不是下一个小时）', () => {
  const w = planWindowWait(at(30 * MIN));
  assert.equal(w.untilMs, at(59 * MIN + 40 * SEC));
  assert.equal(w.ms, 29 * MIN + 40 * SEC);
});

test('① 窗口宽度就是 20 秒（59:40 → 整点）', () => {
  const w = planWindowWait(at(59 * MIN + 39 * SEC));
  // 窗口的尽头是**下一个整点**
  assert.equal(at(60 * MIN) - w.untilMs, WINDOW_LEAD_MS, '59:40 到整点正好 20 秒');
});

// ══════════════════════ ② 发单等待 ══════════════════════

test('② 在窗口里（59:45）⇒ 要等到 整点 − 10ms', () => {
  const w = planFireWait(at(59 * MIN + 45 * SEC));
  assert.equal(w.needed, true);
  assert.equal(w.untilMs, at(60 * MIN - FIRE_LEAD_MS));
  assert.equal(w.ms, 15 * SEC - FIRE_LEAD_MS);
});

test('② 正好 整点 − 10ms ⇒ 不等（就是现在发）', () => {
  assert.equal(planFireWait(at(60 * MIN - FIRE_LEAD_MS)).needed, false);
});

test('⚠② 已经过了 整点 − 10ms（比如只剩 5ms）⇒ **不等**，直接发', () => {
  // 算出来的目标时刻在过去时硬等会等成负数（死循环或白跑）
  assert.equal(planFireWait(at(60 * MIN - 5)).needed, false);
  assert.equal(planFireWait(at(60 * MIN - 1)).needed, false);
  assert.equal(planFireWait(at(60 * MIN)).needed, false, '正好整点');
});

test('⚠② 整点后 20 秒内 ⇒ 不等（上一场尾巴，直接发）', () => {
  assert.equal(planFireWait(at(0)).needed, false);
  assert.equal(planFireWait(at(19_999)).needed, false);
});

test('② 整点后 20 秒 ⇒ 等下一个整点 − 10ms', () => {
  const w = planFireWait(at(WINDOW_LEAD_MS));
  assert.equal(w.needed, true);
  assert.equal(w.untilMs, at(60 * MIN - FIRE_LEAD_MS), '等的是**下一个**整点（60 分钟后）');
});

test('② 提前量可调（网络慢的人该调大）', () => {
  const w50 = planFireWait(at(59 * MIN + 45 * SEC), 50);
  assert.equal(w50.untilMs, at(60 * MIN - 50));
  const w0 = planFireWait(at(59 * MIN + 45 * SEC), 0);
  assert.equal(w0.untilMs, at(60 * MIN), '提前量 0 ⇒ 正好整点');
});

test('⚠② 提前量不能把目标算到过去去（提前量大于剩余时间）', () => {
  // 离整点只剩 3ms，而提前量是 10ms ⇒ 目标在过去 ⇒ 不等
  assert.equal(planFireWait(at(60 * MIN - 3), 10).needed, false);
});

// ══════════════════════ 两段连起来 ══════════════════════

test('⚠ 两段是**两件不同的事**：59:30 时窗口要等、发单不用等（先等窗口）', () => {
  const t = at(59 * MIN + 30 * SEC);
  assert.equal(planWindowWait(t).needed, true, '还没到窗口');
  // 发单那一刻在窗口之后，所以此时算"发单等待"是没有意义的 ——
  // 它会把整点 − 10ms 当成目标（10.5 秒后），但**必须先做预热和取题**。
  // 这一条钉的是"顺序"：链上必须先 `planWindowWait` 再 `planFireWait`。
  assert.equal(planFireWait(t).needed, true);
  assert.ok(planFireWait(t).untilMs > planWindowWait(t).untilMs, '发单在窗口之后');
});

test('时刻读数：界面上要能看到"离窗口/整点还有多久"', () => {
  const r = timingReading(at(59 * MIN + 35 * SEC));
  assert.equal(r.msToHour, 25 * SEC);
  assert.equal(r.inWindow, false);
  assert.equal(r.msToWindow, 5 * SEC);
  assert.equal(r.msToFire, 25 * SEC - FIRE_LEAD_MS);
  assert.equal(r.windowSecond, 40);
  assert.equal(r.leadMs, 10);
  assert.ok(r.hourAt.endsWith('Z'), r.hourAt);
});

test('时刻读数：已经过了整点 ⇒ `msToHour` 是**负数**（不是回绕）', () => {
  const r = timingReading(at(5 * SEC));
  assert.equal(r.msToHour, -5 * SEC + 3_600_000, '指向**下一个**整点');
  assert.equal(r.inWindow, true, '整点后 5 秒还在窗口里');
});

// ══════════════════════ 自旋等待 ══════════════════════

test('⚠ `waitUntil` 用注入的时钟 —— 真自旋 20 秒的测试没人会跑', () => {
  let now = 1000;
  let spins = 0;
  const waited = waitUntil(1500, () => now, () => {
    spins++;
    now += 100; // 每自旋一次"过" 100ms
  });
  assert.ok(now >= 1500, `时钟要走过目标，实际 ${now}`);
  // ⚠ 返回的是**实际等了多久**（1000→1500 = 500），不是"最后一次的剩余量"
  assert.equal(waited, 500);
  assert.equal(spins, 5, '1000→1500 要自旋 5 次');
});

test('目标已过 ⇒ 一次都不自旋', () => {
  let n = 0;
  const waited = waitUntil(500, () => 1000, () => {
    n++;
  });
  assert.equal(n, 0);
  assert.equal(waited, 0);
});

test('⚠ 自旋有上限（时钟不动时不能死循环）', () => {
  // 时钟不走（比如宿主给的时刻卡住了）⇒ 必须有兜底，否则那条线程永远回不来。
  // 这里用"spin 抛错"模拟上限机制：真实现里靠预算（看门狗按 start+budget 判定）。
  let n = 0;
  assert.throws(() => {
    waitUntil(2000, () => 1000, () => {
      n++;
      if (n > 10) throw new Error('自旋上限');
    });
  }, /自旋上限/);
  assert.equal(n, 11);
});

// ══════════════════════ 目标时刻可配（③-3）══════════════════════

test('目标时刻：读设置，坏的/越界的回落默认（不让链跑到不存在的时刻上）', () => {
  const mk = (v: string | null) => ({ getState: () => v });
  assert.equal(targetHourOf(mk(null)), DEFAULT_TARGET_HOUR, '没设过 ⇒ 默认 10 点');
  assert.equal(targetHourOf(mk('10')), 10);
  assert.equal(targetHourOf(mk('0')), 0, '0 点是合法的（不是"没设"）');
  assert.equal(targetHourOf(mk('23')), 23);
  assert.equal(targetHourOf(mk('')), null, '空串 = 每小时都试（**显式**的选择）');
  assert.equal(targetHourOf(mk('24')), DEFAULT_TARGET_HOUR, '越界回落');
  assert.equal(targetHourOf(mk('-1')), DEFAULT_TARGET_HOUR);
  assert.equal(targetHourOf(mk('abc')), DEFAULT_TARGET_HOUR);
  assert.equal(targetHourOf(mk('10.5')), DEFAULT_TARGET_HOUR, '非整数回落');
});

test('⚠ 目标时刻的窗口**跨整点**：(H-1):59:40 → H:00:15', () => {
  // 用**本地时间**构造，因为目标小时是本地语义
  const local = (h: number, m: number, sec: number, ms = 0): number =>
    new Date(2026, 9, 15, h, m, sec, ms).getTime();

  // 9:59:40 ⇒ 10 点那一场的窗口**刚开**，要跑
  assert.equal(planTargetWait(local(9, 59, 40), 10).needed, false, '9:59:40 是窗口开头');
  assert.equal(planTargetWait(local(9, 59, 59), 10).needed, false);
  // 10:00:00 ～ 10:00:15 ⇒ 尾巴，仍要跑
  assert.equal(planTargetWait(local(10, 0, 0), 10).needed, false, '整点那一刻');
  assert.equal(planTargetWait(local(10, 0, 14), 10).needed, false);
});

test('⚠ 目标时刻：不在窗口里就**明确不等**（还差多久要算对）', () => {
  const local = (h: number, m: number, sec: number): number =>
    new Date(2026, 9, 15, h, m, sec, 0).getTime();

  // 9:00 ⇒ 离 9:59:40 还有 59 分 40 秒
  const w = planTargetWait(local(9, 0, 0), 10);
  assert.equal(w.needed, true);
  assert.equal(Math.round(w.ms / 1000), 59 * 60 + 40, `实际 ${Math.round(w.ms / 1000)}s`);

  // 10:00:16 ⇒ 尾巴过了 ⇒ 等**明天**的 9:59:40
  const w2 = planTargetWait(local(10, 0, 16), 10);
  assert.equal(w2.needed, true);
  assert.ok(w2.ms > 20 * 3_600_000, `该等到明天，实际只差 ${Math.round(w2.ms / 1000)}s`);

  // 15:00 ⇒ 也是等明天
  const w3 = planTargetWait(local(15, 0, 0), 10);
  assert.equal(w3.needed, true);
  assert.ok(w3.ms > 18 * 3_600_000, `实际 ${Math.round(w3.ms / 3_600_000)}h`);
});

test('目标时刻 `null`（每小时都试）⇒ 退化成"每小时抢一次"', () => {
  const local = (h: number, m: number, sec: number): number =>
    new Date(2026, 9, 15, h, m, sec, 0).getTime();
  // 与 planWindowWait 一致
  assert.equal(planTargetWait(local(9, 59, 45), null).needed, false);
  assert.equal(planTargetWait(local(9, 30, 0), null).needed, true);
});

test('⚠ 目标 0 点：窗口跨**午夜**（23:59:40 → 00:00:15）', () => {
  const local = (h: number, m: number, sec: number): number =>
    new Date(2026, 9, 15, h, m, sec, 0).getTime();
  assert.equal(planTargetWait(local(23, 59, 40), 0).needed, false, '23:59:40 是 0 点那一场的窗口');
  assert.equal(planTargetWait(local(0, 0, 5), 0).needed, false, '0:00:05 是尾巴');
  const w = planTargetWait(local(0, 30, 0), 0);
  assert.equal(w.needed, true, '0:30 不在窗口里');
});
