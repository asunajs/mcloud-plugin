// 口令池（业务档）—— 逐条对着 mcloud 的 `mcloud-core/src/kouling.rs` 的用例核。
//
// 这里守的是**四条会被人"顺手改好"的判据**（每一条 mcloud 都吃过亏）：
//
// ```text
//   ① 已知无效的口令不许再进池   —— 弹幕里有人复读，让它进池 = "够 2 条"永远凑不够
//   ② 有效只升不降               —— 别的账号领过只会回"已领过"，不该退回未知
//   ③ 过期算无效、但原因留着     —— 界面上要能看出"口令错"还是"过期了"
//   ④ 门关 + 宽限才封场          —— 门会因网络抖动闪一下，立刻封场会把一场直播切碎
// ```
//
// ⚠ 时刻一律是**毫秒数**（与 mcloud 的 `i64` 同口径），不是 ISO 串：
// 这个池要在"5 小时""10 分钟""180 秒"这些量上做减法。
// ⚠ 所有断言都用**固定毫秒**（`T0 + n`），不依赖运行机器的时钟或时区（F-019 的教训）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CYCLE_TTL_MS,
  GATE_CLOSE_GRACE_MS,
  KOULING_ANCHOR,
  MAX_POOL_CODES,
  MAX_SESSIONS,
  POOL_KEY,
  SCRAPE_MIN_INTERVAL_MS,
  VALID_ENOUGH,
  XHS_MIN_INTERVAL_MS,
  accountClaimed,
  accountKey,
  codeState,
  earliestPreviewIn,
  emptyPool,
  isStale,
  loadPoolFrom,
  localStamp,
  nextRoomAt,
  note,
  noteClaim,
  noteGate,
  noteProbe,
  noteScrape,
  noteXhs,
  normalize,
  parsePool,
  pickFor,
  poolSummary,
  savePoolTo,
  scrapeReady,
  serializePool,
  stopScraping,
  validCount,
  validValues,
  xhsReady,
  xhsWaitMs,
} from '../src/mcloud/koulingPool.ts';
import type { ProbeRoom } from '../src/mcloud/koulingPool.ts';
import { memStore } from '../src/store/memory.ts';

const T0 = 1_790_000_000_000;
const ACC_A = 'acc-a';
const ACC_B = 'acc-b';

function codes(v: string[]): string[] {
  return v;
}

function room(over: Partial<ProbeRoom> = {}): ProbeRoom {
  return {
    roomId: 1,
    title: '',
    status: 0,
    expectStartTime: '',
    anchorNickname: KOULING_ANCHOR,
    ...over,
  };
}

// ══════════════════════════ 口令进出池 ══════════════════════════

test('抓到的口令进池是**未知**状态，且去重', () => {
  const pool = emptyPool();
  const added = note(pool, codes(['甲', '乙', '甲', '  ']), 'xiaohongshu', T0);
  assert.equal(added, 2, '空串丢掉、重复只收一次');
  assert.equal(codeState(pool, '甲'), 'unknown', '抓到了 ≠ 验过了');
  assert.equal(validCount(pool), 0, '未知不算有效（否则"够 2 条"会提前为真）');
});

test('⚠ 已知**无效**的口令不许再进池（弹幕里有人复读同一条死口令）', () => {
  const pool = emptyPool();
  note(pool, codes(['甲']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'invalid', T0);
  const added = note(pool, codes(['甲']), 'danmaku', T0 + 1000);
  assert.equal(added, 0, '死口令再进池 = "够 2 条有效"永远凑不够 ⇒ 一直抓');
  assert.equal(codeState(pool, '甲'), 'invalid');
});

test('领到与"已兑换"**都算有效**（口令本身是对的）', () => {
  const pool = emptyPool();
  note(pool, codes(['甲', '乙']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'claimed', T0);
  noteClaim(pool, ACC_B, '乙', 'alreadyClaimed', T0);
  assert.equal(validCount(pool), 2);
  assert.deepEqual(validValues(pool), ['甲', '乙']);
  assert.equal(stopScraping(pool), true, `够 ${VALID_ENOUGH} 条有效 ⇒ 全场停止抓取`);
});

test('过期算**无效**，但原因留着"已过期"（界面要能区分是哪一种）', () => {
  const pool = emptyPool();
  note(pool, codes(['甲', '乙']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'invalid', T0);
  noteClaim(pool, ACC_A, '乙', 'expired', T0);
  const a = pool.codes.find((c) => c.value === '甲');
  const b = pool.codes.find((c) => c.value === '乙');
  assert.equal(a?.state, 'invalid');
  assert.equal(b?.state, 'invalid', '过期在**行为上**不可复用');
  assert.equal(a?.reason, '口令无效');
  assert.equal(b?.reason, '口令已过期');
});

test('未分类的结论**不改状态**，但账号级的记录照记（下一轮不再投给它）', () => {
  const pool = emptyPool();
  note(pool, codes(['甲']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'other', T0);
  assert.equal(codeState(pool, '甲'), 'unknown', '池里的状态不变');
  assert.equal(accountClaimed(pool, ACC_A, '甲'), true, '但这个账号有过结论');
  assert.deepEqual(pickFor(pool, ACC_A), [], '有过结论 ⇒ 不再投给它');
  assert.deepEqual(pickFor(pool, ACC_B), ['甲'], '别的账号照样投');
});

test('⚠ "有效"只升不降：别的账号领过（已兑换）不该把它退回未知', () => {
  const pool = emptyPool();
  note(pool, codes(['甲']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'claimed', T0);
  noteClaim(pool, ACC_B, '甲', 'alreadyClaimed', T0 + 1);
  assert.equal(codeState(pool, '甲'), 'valid', '否则"够 2 条"会反复丢失');
  assert.equal(pool.codes.find((c) => c.value === '甲')?.validAtMs, T0, '有效时刻取**第一次**验出来的那次');
});

test('手工口令**验证后进池**（用户口径：与抓到的同等待遇）', () => {
  const pool = emptyPool();
  assert.equal(pool.codes.length, 0);
  noteClaim(pool, ACC_A, '手抄来的口令', 'claimed', T0);
  const c = pool.codes.find((x) => x.value === '手抄来的口令');
  assert.equal(c?.state, 'valid');
  assert.equal(c?.source, 'manual', '来源如实标 manual');
});

test('池有上限（防呆：弹幕里什么都可能被当成口令）', () => {
  const pool = emptyPool();
  const many = Array.from({ length: MAX_POOL_CODES + 20 }, (_, i) => `口令${i}`);
  note(pool, many, 'danmaku', T0);
  assert.equal(pool.codes.length, MAX_POOL_CODES);
});

// ══════════════════════════ 周期与门 ══════════════════════════

test('5 小时 TTL 到点翻篇：口令与领取记录**一起清**', () => {
  const pool = emptyPool();
  note(pool, codes(['甲']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'claimed', T0);
  assert.equal(isStale(pool, T0 + CYCLE_TTL_MS), false, '正好到点不算过期（> 才算）');

  normalize(pool, T0 + CYCLE_TTL_MS + 1);
  assert.equal(pool.codes.length, 0);
  assert.deepEqual(pool.claims, {}, '领取记录必须跟着清 —— 新一场的口令是新的');
  assert.equal(pool.cycleAtMs, T0 + CYCLE_TTL_MS + 1);
});

test('门关上 + 宽限过了才封场（抖动切不碎一场直播）', () => {
  const pool = emptyPool();
  normalize(pool, T0);
  noteGate(pool, false, T0 + 1000);
  assert.equal(isStale(pool, T0 + 1000 + GATE_CLOSE_GRACE_MS), false, '宽限期内不封场');
  assert.equal(isStale(pool, T0 + 1000 + GATE_CLOSE_GRACE_MS + 1), true);
});

test('再看见门开着 ⇒ 封场计时取消（宽限重新开始算）', () => {
  const pool = emptyPool();
  normalize(pool, T0);
  noteGate(pool, false, T0 + 1000);
  noteGate(pool, true, T0 + 2000);
  assert.equal(pool.gateClosedAtMs, null);
  assert.equal(pool.lastLiveAtMs, T0 + 2000);
  assert.equal(isStale(pool, T0 + 2000 + GATE_CLOSE_GRACE_MS + 1), false, 'TTL 还远，门又开了 ⇒ 这一场还在');
});

test('场次的起止：门开 ⇒ 开场；散场时刻取"最后一次看到它在播"', () => {
  const pool = emptyPool();
  normalize(pool, T0); // 新池子要先定下周期起点（否则 isStale 永远是"新池子"）
  noteProbe(pool, [], true, T0);
  assert.equal(pool.sessions.length, 1, '看见开播 ⇒ 开一场');
  assert.equal(pool.sessions[0]?.startedAtMs, T0);
  assert.equal(pool.sessions[0]?.endedAtMs, undefined, '还在播');

  // 再看一次还是"在播" ⇒ **不能**再开一场（否则每分钟的探测会把它切成很多场）
  noteProbe(pool, [], true, T0 + 60_000);
  assert.equal(pool.sessions.length, 1, '同一场只能有一条');

  // 门关了，但**宽限期内**不散场（抖动切不碎一场直播）
  noteGate(pool, false, T0 + 120_000);
  normalize(pool, T0 + 120_000);
  assert.equal(pool.sessions[0]?.endedAtMs, undefined, '宽限期内不散场');

  // 过了 5 小时 TTL + 宽限 ⇒ 翻篇 ⇒ 散场
  const late = T0 + CYCLE_TTL_MS + GATE_CLOSE_GRACE_MS + 1000;
  normalize(pool, late);
  assert.equal(
    pool.sessions[0]?.endedAtMs,
    T0 + 60_000,
    '散场 = **最后一次看到它在播**，不是晚几小时的"发现它关了"（否则会把没看的那几小时也算进去）',
  );
  assert.equal(poolSummary(pool, '2026-10-01 00:00:00', late).sessions.length, 1, '翻篇不清历史');
  assert.equal(pool.codes.length, 0, '口令随翻篇清掉');
});

test('场次只留最近 MAX_SESSIONS 条（不无限长）', () => {
  const pool = emptyPool();
  normalize(pool, T0);
  let t = T0;
  for (let i = 0; i < MAX_SESSIONS + 3; i += 1) {
    noteProbe(pool, [room({ status: 1 })], true, t); // 开一场
    noteGate(pool, false, t + 1); // 门关
    t = t + GATE_CLOSE_GRACE_MS + 2;
    normalize(pool, t); // 宽限过了 ⇒ 翻篇（散场 + 开新周期）
    t += 1000;
  }
  assert.equal(pool.sessions.length, MAX_SESSIONS);
});

// ══════════════════════════ 日程与「下一场」══════════════════════════

test('日程保留**门会筛掉**的房间（预告/回放）—— "日程不能跟着丢"', () => {
  const pool = emptyPool();
  const rooms = [
    room({ roomId: 1, status: 1, title: '正在播' }),
    room({ roomId: 2, status: 0, title: '下一场', expectStartTime: '2026-10-14 20:00:00' }),
    room({ roomId: 3, status: 2, title: '回放' }),
  ];
  noteProbe(pool, rooms, true, T0);
  assert.equal(pool.schedule.length, 3, '全都要留在日程里');
  assert.equal(pool.scheduleAtMs, T0);
});

test('「下一场」：只认目标主播 + 只认预告场 + **跳过已经过去**的场次', () => {
  const rooms = [
    room({ roomId: 1, status: 0, expectStartTime: '2026-10-14 15:00:00' }), // 已经过去
    room({ roomId: 2, status: 0, expectStartTime: '2026-10-14 20:00:00', title: '晚场' }),
    room({ roomId: 3, status: 0, expectStartTime: '2026-10-14 22:00:00' }),
    room({ roomId: 4, status: 1, expectStartTime: '2026-10-14 18:00:00' }), // 在播 ≠ 预告
  ];
  const next = nextRoomAt(rooms, '2026-10-14 16:31:00');
  assert.equal(next?.roomId, 2, '用户实测踩过：16:31 时显示 15:00 那场 ⇒ 必须跳过已过去的');
});

test('⚠ 上游列表里混着**别的主播** ⇒ 昵称不匹配就当作没有（宁可说没有，也不给错的）', () => {
  const rooms = [
    room({ roomId: 1, status: 0, expectStartTime: '2026-10-14 20:00:00', anchorNickname: '福建移动' }),
    room({ roomId: 2, status: 0, expectStartTime: '2026-10-14 21:00:00', anchorNickname: '移动心选' }),
  ];
  assert.equal(nextRoomAt(rooms, '2026-10-14 16:00:00'), undefined, '认不出目标主播 ⇒ 不显示');
  // 而"不筛主播"那一支（给池内部用）能挑到最早的预告
  assert.equal(earliestPreviewIn(rooms, false, '2026-10-14 16:00:00')?.roomId, 1);
});

test('⚠ 昵称是**精确相等**，不是包含：`福建移动` 不算', () => {
  const rooms = [room({ roomId: 1, status: 0, expectStartTime: '2026-10-14 20:00:00', anchorNickname: '福建移动' })];
  assert.equal(nextRoomAt(rooms, '2026-10-14 16:00:00'), undefined);
  const ok = [room({ roomId: 2, status: 0, expectStartTime: '2026-10-14 20:00:00' })];
  assert.equal(nextRoomAt(ok, '2026-10-14 16:00:00')?.roomId, 2);
});

test('快照里的「下一场」三个字段**同源**（要么都有，要么都没有）', () => {
  const pool = emptyPool();
  noteProbe(
    pool,
    [room({ roomId: 7, status: 0, title: '十月晚场', expectStartTime: '2026-10-14 20:00:00' })],
    false,
    T0,
  );
  const s = poolSummary(pool, '2026-10-14 16:00:00', T0);
  assert.equal(s.nextStart, '2026-10-14 20:00:00');
  assert.equal(s.nextTitle, '十月晚场');
  assert.equal(s.nextAnchor, KOULING_ANCHOR);
  assert.equal(s.scheduleAtMs, T0);

  const none = poolSummary(emptyPool(), '2026-10-14 16:00:00', T0);
  assert.equal(none.nextStart, undefined);
  assert.equal(none.nextTitle, undefined);
  assert.equal(none.nextAnchor, undefined);
  assert.equal(none.scheduleAtMs, null, '没探测过 ⇒ null（界面要能说"还没探测过"）');
});

// ══════════════════════════ 节流 ══════════════════════════

test('抓取去重：一次抓取窗口内只放行一趟（空池天然放行、跨重启也成立）', () => {
  const pool = emptyPool();
  assert.equal(scrapeReady(pool, T0), true, '没抓过 ⇒ 谁先到谁抓');
  noteScrape(pool, T0);
  assert.equal(scrapeReady(pool, T0 + SCRAPE_MIN_INTERVAL_MS - 1), false);
  assert.equal(scrapeReady(pool, T0 + SCRAPE_MIN_INTERVAL_MS), true);
  // ⚠ 跨重启也成立：这是**持久化**字段，不是进程内标志（用户口径：一个实例只需要一个抓取）
  noteScrape(pool, T0);
  assert.equal(scrapeReady(parsePool(serializePool(pool)).pool, T0 + 2000), false, '读盘后仍在窗口内');
});

test('小红书主页限速 30 分钟（抓太勤会被风控挡成空壳，而那与"没发"长得一样）', () => {
  const pool = emptyPool();
  assert.equal(xhsReady(pool, T0), true);
  noteXhs(pool, T0);
  assert.equal(xhsReady(pool, T0 + XHS_MIN_INTERVAL_MS - 1), false);
  assert.equal(xhsReady(pool, T0 + XHS_MIN_INTERVAL_MS), true);
  assert.equal(xhsWaitMs(pool, T0), XHS_MIN_INTERVAL_MS);
  assert.equal(xhsWaitMs(pool, T0 + XHS_MIN_INTERVAL_MS), 0);
});

test('翻篇**不重置**限速（那是防封的节流，不是这一场的数据）', () => {
  const pool = emptyPool();
  normalize(pool, T0);
  noteXhs(pool, T0);
  noteScrape(pool, T0);
  // ⚠ 这里**不能**用 5 小时 TTL 来验：那时候限速窗口（30 分钟）早就过了，
  // 无论清没清都是"可以请求" ⇒ 断言成了**恒真**。改用"门关 + 宽限"让它 ~10 分钟
  // 就翻篇 —— 此时仍在 30 分钟窗口内，才验得出来。（mcloud 的用例同款理由。）
  noteGate(pool, true, T0);
  noteGate(pool, false, T0 + 1000);
  const t = T0 + 1000 + GATE_CLOSE_GRACE_MS + 1;
  normalize(pool, t);
  assert.equal(pool.cycleAtMs, t, '先确认：确实翻篇了');
  assert.equal(pool.codes.length, 0, '先确认：口令确实清了');
  assert.equal(xhsReady(pool, t + 1), false, '翻篇不该把限速一起清掉');
  // 抓取去重那个窗口只有 180 秒，t 时早就过了 ⇒ 这里只断言**时间戳没被清**
  // （拿 `scrapeReady` 断言会得到一个恒真的句子，等于没测）
  assert.equal(pool.lastScrapeAtMs, T0, '抓取去重的时间戳也不该被翻篇清掉');
});

// ══════════════════════════ 落盘 ══════════════════════════

test('落盘往返：形状不变（这是**跨重启**的唯一依据）', () => {
  const pool = emptyPool();
  note(pool, codes(['甲']), 'xiaohongshu', T0);
  noteClaim(pool, ACC_A, '甲', 'claimed', T0);
  noteProbe(pool, [room({ roomId: 9, status: 0, expectStartTime: '2026-10-14 20:00:00' })], true, T0);

  const back = parsePool(serializePool(pool));
  assert.equal(back.reset, false);
  assert.deepEqual(back.pool, pool);
});

test('坏文本 ⇒ 空池 + `reset`（**必须说出来**：那一场的领取记录是丢的）', () => {
  const bad = parsePool('{不是 json');
  assert.equal(bad.reset, true);
  assert.equal(bad.pool.codes.length, 0);
  assert.equal(parsePool('').reset, false, '没盘过 ≠ 坏了');
  assert.equal(parsePool(null).reset, false);
  assert.equal(parsePool('[1,2]').reset, true, '形状不对也算坏');
});

test('缺字段的旧文件照样读（加字段不能把老实例读崩）', () => {
  const old = JSON.stringify({ cycleAtMs: T0, codes: [{ value: '甲', state: 'valid', source: 'xiaohongshu' }] });
  const { pool, reset } = parsePool(old);
  assert.equal(reset, false);
  assert.equal(codeState(pool, '甲'), 'valid');
  assert.equal(pool.codes[0]?.firstSeenMs, 0, '缺的时刻退成 0（不是 NaN）');
  assert.equal(pool.lastXhsAtMs, null);
});

test('认不出的状态按 **unknown** 收（保守方向：还要再验一次，而不是当成有效）', () => {
  const weird = JSON.stringify({ codes: [{ value: '甲', state: '大概是好的' }] });
  assert.equal(codeState(parsePool(weird).pool, '甲'), 'unknown');
});

test('store 适配层：写进去能读回来', () => {
  const store = memStore();
  store.ensureSchema();
  const { pool } = loadPoolFrom(store);
  note(pool, codes(['甲']), 'manual', T0);
  savePoolTo(store, pool, '2026-10-14T00:00:00.000Z');
  assert.ok(store.getState(POOL_KEY), '确实落到了 state 表');
  assert.equal(codeState(loadPoolFrom(store).pool, '甲'), 'unknown');
});

// ══════════════════════════ 账号键 ══════════════════════════

test('账号键：稳定、不落手机号原文', () => {
  const a = accountKey('13800000000');
  assert.equal(a, accountKey('13800000000'), '同号同键');
  assert.notEqual(a, accountKey('13900000001'), '不同号不同键');
  assert.ok(!a.includes('138'), '键里不许出现手机号本身');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(accountKey(''), 'default', '拿不到手机号 ⇒ 如实退化成一个常量键');
});

test('⚠ 账号键**不跟着凭据换票变**（否则池会把同一个账号当成两个人）', () => {
  // 键取的是手机号（凭据里唯一稳定的那一段）的哈希，**不是**整串凭据的指纹：
  // 换票会改写 Authorization ⇒ 指纹会变 ⇒ "领过的口令"会被再投一次。
  const before = accountKey('13800000000');
  const after = accountKey('13800000000'); // 同一份手机号、换过 token
  assert.equal(before, after);
});

// ══════════════════════════ 时刻串 ══════════════════════════

test('本地时刻串：格式对得上上游（**不断言具体值** —— 它跟机器时区走，F-019 的教训）', () => {
  assert.match(localStamp(T0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(localStamp(T0).length, 19, '定长 ⇒ 字典序等于时间序');
});
