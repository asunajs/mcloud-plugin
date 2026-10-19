import assert from 'node:assert/strict';
import test from 'node:test';
import {
  duePlans,
  maxLeadMs,
  nextPlanTargetMs,
  planSummary,
  planTarget,
  unionCron,
  type ExchangePlan,
} from '../src/mcloud/exchangePlans.ts';

function plan(over: Partial<ExchangePlan>): ExchangePlan {
  return {
    id: 'p1',
    accountId: 'a1',
    prizeId: 100,
    prizeName: '奖品',
    cron: '0 10 * * *',
    leadSec: 120,
    until: '',
    maxRuns: 0,
    enabled: true,
    ...over,
  };
}

function store(plans: ExchangePlan[]) {
  const m = new Map<string, string>([['mcloud.exchange.plans', JSON.stringify(plans)]]);
  return {
    getState: (k: string) => m.get(k) ?? null,
    setState: (k: string, v: string) => void m.set(k, v),
  };
}

test('并集 cron：只取启用计划的整点，去重排序', () => {
  const plans = [
    plan({ id: 'a', cron: '0 20 * * *' }),
    plan({ id: 'b', cron: '0 10,20 * * *' }),
    plan({ id: 'c', cron: '0 9 * * *', enabled: false }),
  ];
  assert.equal(unionCron(plans), '0 10,20 * * *');
  assert.equal(unionCron([]), '0 10 * * *');
});

test('到点分发：只跑目标整点匹配且启用的计划', () => {
  const plans = [
    plan({ id: 'a', cron: '0 10 * * *', prizeId: 111 }),
    plan({ id: 'b', cron: '0 20 * * *', prizeId: 222 }),
    plan({ id: 'c', cron: '0 10 * * *', prizeId: 333, enabled: false }),
  ];
  const at10 = new Date(2026, 9, 19, 10, 0, 0, 0).getTime();
  const at20 = new Date(2026, 9, 19, 20, 0, 0, 0).getTime();
  assert.deepEqual(duePlans(plans, at10).map((p) => p.id), ['a']);
  assert.deepEqual(duePlans(plans, at20).map((p) => p.id), ['b']);
  // 非整点不跑（cron 的分必须是 0）
  assert.deepEqual(duePlans(plans, at10 + 60_000), []);
});

test('提前量取最大；下一次目标取最早', () => {
  const plans = [
    plan({ id: 'a', cron: '0 10 * * *', leadSec: 60 }),
    plan({ id: 'b', cron: '0 20 * * *', leadSec: 300 }),
    plan({ id: 'c', cron: '0 9 * * *', leadSec: 200, enabled: false }),
  ];
  assert.equal(maxLeadMs(plans), 300_000);
  const now = new Date(2026, 9, 19, 8, 0, 0, 0).getTime();
  assert.equal(nextPlanTargetMs(plans, now), new Date(2026, 9, 19, 10, 0, 0, 0).getTime());
});

test('目标：有 prizeId 用 id，没有才退回名字', () => {
  assert.equal(planTarget(plan({ prizeId: 424242 })), '424242');
  assert.equal(planTarget(plan({ prizeId: undefined, prizeName: '旧名字' })), '旧名字');
});

test('摘要：条数 + 下次时间；全暂停说清楚', () => {
  const now = new Date(2026, 9, 19, 8, 0, 0, 0).getTime();
  const s = store([plan({ cron: '0 10 * * *' }), plan({ id: 'p2', cron: '0 20 * * *' })]);
  assert.match(planSummary(s as never, now), /^2 个计划 · 下次 10-19 10:00$/);
  const off = store([plan({ enabled: false })]);
  assert.equal(planSummary(off as never, now), '1 个计划（都未启用）');
  assert.equal(planSummary(store([]) as never, now), '还没设定时计划');
});
