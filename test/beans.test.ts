// 「今日AI豆」账本 —— 逐条对着 `mcloud/crates/mcloud-tasks/src/beans.rs` 核。
//
// 守的是那些"照直觉会写错"的地方：
//   · 日界是**东八区自然日**，不是运行机器时区，也不是 24 小时滑窗
//   · `insertTime` 解不出 ⇒ **抛错 / `undefined`**，绝不"按本地时区猜一下"
//   · 翻页翻到短页为止；撞 `MAX_PAGES` 还没到底 ⇒ 今日那条**如实报错**，
//     明细那条**如实标 `hasMore`**（两种"不全"的处理方式**故意不同**）
//   · `MAX_DETAIL_RECORDS` 截断也标 `hasMore`（不静默丢）
//   · `undated` 那一档：**已经在 `records` 里**，只是"不知道哪天"（≠"不是一笔"）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { memStore } from '../src/store/memory.ts';
import { testDeps } from './helpers.ts';
import type { Transport } from '../src/mcloud/client.ts';

import {
  BEIJING_OFFSET_SECS,
  MAX_DETAIL_RECORDS,
  MAX_PAGES,
  PAGE_SIZE,
  aggregateToday,
  beanQuery,
  buildRecords,
  dayStartMs,
  isToday,
  parseCloudRecords,
  parseInsertTimeMs,
  rangeSinceMs,
  readDay,
  readRecords,
  type CloudRecord,
} from '../src/mcloud/beans.ts';

// ── 参考时刻：东八区 2026-10-17 12:00:00（UTC 04:00:00）
const NOW_UTC_MS = Date.UTC(2026, 9, 17, 4, 0, 0);
const bj = (day: number, h = 12, m = 0, s = 0, ms = 0): string => {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `2026-10-${pad(day)}T${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}+08:00`;
};

// ══════════════════════════ 日界（东八区自然日）══════════════════════════

test('dayStartMs：东八区日界，不是运行机器时区', () => {
  const start = dayStartMs(NOW_UTC_MS);
  // NOW_UTC_MS = 东八区 2026-10-17 12:00 ⇒ 日界 = 东八区 10-17 00:00 = UTC 10-16 16:00
  assert.equal(start, Date.UTC(2026, 9, 16, 16, 0, 0));
  assert.ok(BEIJING_OFFSET_SECS === 8 * 3600);
});

test('isToday：东八区左闭右开，跨 UTC 零点但仍在同一天', () => {
  // 东八区 2026-10-17 07:30 = UTC 2026-10-16 23:30 ⇒ UTC 上还是"昨天"，东八区上是"今天"
  const ts = Date.UTC(2026, 9, 16, 23, 30, 0);
  assert.equal(isToday(ts, NOW_UTC_MS), true);
  // 东八区 2026-10-18 00:00（明天日界那一刻）⇒ 右开，**不算今天**
  assert.equal(isToday(dayStartMs(NOW_UTC_MS) + 86_400_000, NOW_UTC_MS), false);
});

test('rangeSinceMs：`days=1` 从今天 0 点起、`days=7` 从上周同日 0 点起、`days<=0` 不限', () => {
  const today = dayStartMs(NOW_UTC_MS);
  assert.equal(rangeSinceMs(1, NOW_UTC_MS), today);
  // 含今天共 7 天 ⇒ 回退 6 个自然日
  assert.equal(rangeSinceMs(7, NOW_UTC_MS), today - 6 * 86_400_000);
  // ⚠ "近 7 天"不是"最近 7×24 小时" —— 界面上那一档写的是自然日
  assert.notEqual(rangeSinceMs(7, NOW_UTC_MS), NOW_UTC_MS - 7 * 86_400_000);
  assert.equal(rangeSinceMs(0, NOW_UTC_MS), undefined);
  assert.equal(rangeSinceMs(-1, NOW_UTC_MS), undefined);
});

test('beanQuery：参数逐字（`aiDou=1`、`type=0`、`pageNumber`、`pageSize=100`）', () => {
  assert.equal(beanQuery(1), 'aiDou=1&type=0&pageNumber=1&pageSize=100');
  assert.equal(beanQuery(7), 'aiDou=1&type=0&pageNumber=7&pageSize=100');
});

// ══════════════════════════ insertTime 归一（不猜时区）═══════════════════

test('parseInsertTimeMs：认 Z / 认 ±HH:MM / 无偏移 ⇒ undefined（不猜）', () => {
  assert.equal(parseInsertTimeMs('2026-10-16T16:00:00.000Z'), Date.UTC(2026, 9, 16, 16));
  assert.equal(parseInsertTimeMs(bj(17, 12)), NOW_UTC_MS);
  // 负偏移也要认（`-05:00` ⇒ UTC 上比串面晚 5 小时）
  assert.equal(
    parseInsertTimeMs('2026-10-17T04:00:00.000-05:00'),
    Date.UTC(2026, 9, 17, 9),
  );
  // ⚠ 无偏移 ⇒ **不猜**：JS 的 `Date.parse` 会当本地时间解，那正是参考实现明令禁止的路径
  assert.equal(parseInsertTimeMs('2026-10-17 12:00:00'), undefined);
  assert.equal(parseInsertTimeMs('2026-10-17T12:00:00'), undefined);
  // 非法日期（月份 13、2 月 30 日）
  assert.equal(parseInsertTimeMs('2026-13-01T00:00:00Z'), undefined);
  assert.equal(parseInsertTimeMs('2026-02-30T00:00:00Z'), undefined);
});

test('parseInsertTimeMs：闰年 2-29 认得、非闰年 2-29 拒', () => {
  assert.ok(parseInsertTimeMs('2024-02-29T00:00:00Z') !== undefined);
  assert.equal(parseInsertTimeMs('2025-02-29T00:00:00Z'), undefined);
  // 世纪规则：2100 不是闰年（`% 100 === 0 && % 400 !== 0`）
  assert.equal(parseInsertTimeMs('2100-02-29T00:00:00Z'), undefined);
  assert.ok(parseInsertTimeMs('2000-02-29T00:00:00Z') !== undefined);
});

// ══════════════════════════ 解 result.records ════════════════════════════

test('parseCloudRecords：认 `result.records`；`insertTime` 与 `inserttime` 两种键都收', () => {
  const one = parseCloudRecords({
    records: [
      { num: 10, summary: 's1', mark: 'm1', insertTime: bj(17, 8) },
      { num: '-3', summary: 's2', mark: 'm2', inserttime: bj(17, 9) },
    ],
  });
  assert.equal(one.length, 2);
  assert.equal(one[0]!.num, 10);
  // 字符串数字也收（`int_at` 那条）
  assert.equal(one[1]!.num, -3);
  assert.equal(one[1]!.insertTime, bj(17, 9));
});

test('parseCloudRecords：**没有 result.records 就抛**（不"两种形状都吃"）', () => {
  // `result` 直接给数组 —— 那是原实现特意避开的路径（形状不对要**响**，不能"兼容"过去）
  assert.throws(() => parseCloudRecords([{ num: 1 }]), /result 对象/);
  assert.throws(() => parseCloudRecords(undefined), /result 对象/);
  // `result` 是对象但里面没有 `records` 数组 ⇒ 走那条更具体的话
  assert.throws(() => parseCloudRecords({ list: [] }), /result\.records/);
});

// ══════════════════════════ 今日汇总（纯函数）═══════════════════════════

const rec = (n: Partial<CloudRecord> & Pick<CloudRecord, 'num'>): CloudRecord => ({
  summary: '',
  mark: '',
  insertTime: undefined,
  ...n,
});

test('aggregateToday：进 `>=0` 走 gained、`<0` 走 spent（取正数），net = 差', () => {
  const day = aggregateToday(
    [
      rec({ num: 10, insertTime: bj(17, 8) }),
      rec({ num: -3, insertTime: bj(17, 9) }),
      rec({ num: 0, insertTime: bj(17, 10) }),
      // 昨天的：跳过
      rec({ num: 100, insertTime: bj(16, 22) }),
    ],
    NOW_UTC_MS,
  );
  // 收 = 10 + 0（`num=0` 归收入一侧），支 = 3，净 = 7
  assert.equal(day.gained, 10);
  assert.equal(day.spent, 3);
  assert.equal(day.net, 7);
  assert.equal(day.count, 3);
});

test('aggregateToday：解不出的流水 ⇒ **抛**，不静默丢', () => {
  // 缺 insertTime
  assert.throws(() => aggregateToday([rec({ num: 5 })], NOW_UTC_MS), /没有 insertTime/);
  // 有 insertTime 但格式认不出（无偏移）
  assert.throws(
    () => aggregateToday([rec({ num: 5, insertTime: '2026-10-17T12:00:00' })], NOW_UTC_MS),
    /解不出/,
  );
});

// ══════════════════════════ readDay（今日，翻页翻到底）══════════════════

test('readDay：不满一页只取第一页；装满就取下一页', () => {
  const calls: number[] = [];
  const fetch = (p: number): CloudRecord[] => {
    calls.push(p);
    if (p === 1) {
      // 100 条**都算今天**：`i` 铺开成 `分:秒`（`i=0..59` → 01:00:00…01:00:59，
      // `i=60..99` → 01:01:00…01:01:39）。不能直接把 `i` 当秒 —— 那会造出 `:60` 这种非法值。
      return Array.from({ length: PAGE_SIZE }, (_, i) =>
        rec({ num: 1, insertTime: bj(17, 1, Math.floor(i / 60), i % 60) }),
      );
    }
    return [
      rec({ num: 5, insertTime: bj(17, 2) }),
      rec({ num: -2, insertTime: bj(16, 20) }),
    ];
  };
  const day = readDay(fetch, NOW_UTC_MS);
  assert.deepEqual(calls, [1, 2]);
  // 今日 = 100 页满 + 第二页那一条 `+5` = 105；支 = 0；昨天那条**不算**
  assert.equal(day.gained, 105);
  assert.equal(day.net, 105);
});

test('readDay：翻满 `MAX_PAGES` 还是满页 ⇒ 抛（不报可能少算的数）', () => {
  const fetch = (): CloudRecord[] =>
    Array.from({ length: PAGE_SIZE }, () => rec({ num: 1, insertTime: bj(17, 1) }));
  assert.throws(() => readDay(fetch, NOW_UTC_MS), /翻满 20 页/);
});

// ══════════════════════════ readRecords（明细，倒序 / undated / hasMore）═

test('readRecords：解不出时间的**照样列**（排最后），窗口外才丢', () => {
  const all: CloudRecord[] = [
    rec({ num: 10, summary: 'today', insertTime: bj(17, 8) }),
    rec({ num: -3, summary: 'yest', insertTime: bj(16, 8) }),
    rec({ num: 7, summary: 'undated' }),
    rec({ num: 1, summary: 'far', insertTime: bj(1, 1) }),
  ];
  const r = buildRecords(all, rangeSinceMs(7, NOW_UTC_MS), 100, false);
  // `far`（10-01）落在"近 7 天"之外 ⇒ 丢；`undated` 因没 `atMs` ⇒ 留
  assert.deepEqual(
    r.records.map((x) => x.summary),
    ['today', 'yest', 'undated'],
  );
  assert.equal(r.undated, 1);
  assert.equal(r.hasMore, false);
});

test('readRecords：`days=0` 不限窗口 ⇒ 全留（含时间解不出的）', () => {
  const all: CloudRecord[] = [
    rec({ num: 1, insertTime: bj(1, 1) }),
    rec({ num: 2 }),
  ];
  const r = buildRecords(all, undefined, 100, false);
  assert.equal(r.records.length, 2);
  assert.equal(r.undated, 1);
});

test('readRecords：撞 `MAX_DETAIL_RECORDS` ⇒ 截并 `hasMore=true`（不静默丢）', () => {
  const all: CloudRecord[] = Array.from(
    { length: MAX_DETAIL_RECORDS + 5 },
    (_, i) =>
      // 秒位要 `i % 60`（`i` 到 505 会造出 `:60` 那种非法秒），分位取 `i / 60`
      rec({ num: 1, insertTime: bj(17, 1 + Math.floor(i / 3600), Math.floor(i / 60) % 60, i % 60) }),
  );
  const r = buildRecords(all, undefined, MAX_DETAIL_RECORDS, false);
  assert.equal(r.records.length, MAX_DETAIL_RECORDS);
  assert.equal(r.hasMore, true);
});

test('readRecords：翻到 `MAX_PAGES` 还是满页 ⇒ 也标 `hasMore`（今日那条会抛，这一条**不抛**）', () => {
  const fetch = (): CloudRecord[] =>
    Array.from({ length: PAGE_SIZE }, (_, i) =>
      rec({ num: 1, insertTime: bj(17, 1, Math.floor(i / 60), i % 60) }),
    );
  const r = readRecords(fetch, undefined, MAX_DETAIL_RECORDS);
  assert.equal(r.hasMore, true);
});

test('readRecords：解不出的那一笔**已经在 records 里**（只是 `atMs=undefined`）', () => {
  const r = readRecords(
    () => [rec({ num: 5, summary: 'x' })],
    rangeSinceMs(1, NOW_UTC_MS),
    100,
  );
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0]!.atMs, undefined);
  assert.equal(r.records[0]!.rawTime, undefined);
  assert.equal(r.undated, 1);
});

// ══════════════════════════ 路由的执行预算（面板默认 2 秒会打断它）══════════
//
// 表现过一次线上故障：点「取一次」回 `500 路由处理超过预算 2s，被强制中断`。
// 根因不是逻辑错，是**预算**——面板对没声明 `budget_ms` 的路由只给 2 秒，
// 而这两条要"逐账号 × 翻页"地打上游（每发 `cloudRecordV2` 的超时就有 1500ms），
// 两个账号各读两页就顶到 2 秒。所以它们**必须自己声明预算**。
// 这一条钉住"声明了"这件事：哪天有人改回默认档，这里先红，而不是等界面 500。
const PANEL_DEFAULT_BUDGET_MS = 2_000;
const NOW_ISO = new Date(NOW_UTC_MS).toISOString();
const exploding: Transport = () => {
  throw new Error('这条测试不该发上游请求');
};
const routeBy = (path: string) => {
  const r = mcloudRoutes(testDeps(memStore(), { transport: exploding, now: NOW_ISO })).find(
    (x) => x.path === `/plugins/mcloud/api/${path}` && x.method === 'GET',
  );
  assert.ok(r, `没有 ${path} 路由`);
  return r!;
};

for (const path of ['beans/today', 'beans/records']) {
  test(`${path}：声明了比面板默认档更宽的预算（不然读完就被看门狗打断成 500）`, () => {
    const r = routeBy(path);
    assert.ok(
      typeof r.budget_ms === 'number' && r.budget_ms > PANEL_DEFAULT_BUDGET_MS,
      `${path} 的 budget_ms=${r.budget_ms} —— 逐账号 × 翻页的只读链撑不进默认 ${PANEL_DEFAULT_BUDGET_MS}ms`,
    );
  });
}
