// 「定时抢兑」的计划表：一条计划 = 一个账号 + 一个目标 + 一个整点。
//
// # 为什么不是一条计划多账号
//
// 用户的原话是“两个号兑换不同的 id / 时间也不同”。一条计划多账号只能表达
// “这些号换同一个东西、同一个时间”；要支持不同目标/时间，最清楚的模型就是
// **一条计划一个账号**。界面上一行就是“谁、换什么、几点、提前多久”。
//
// # 为什么面板还是一条任务
//
// 面板的调度单位是“一条任务一个 cron”。这里把所有启用计划的整点取**并集**
// （`0 10,20 * * *`），到点后插件按目标整点分发：10 点只跑计划 A，20 点只跑计划 B。
// 面板任务列表里仍然只有一条「兑换」，不会变成 N 条。

import { loadAccounts } from './accounts.ts';
import { resolveTaskAccounts } from './taskAccounts.ts';
import { cronMatchesAt, nextCronTargetMs, parseCron } from './scheduleCron.ts';
import type { ReadableState, WritableState } from '../store/keys-types.ts';

export const STATE_PLANS = 'mcloud.exchange.plans';
export const STATE_PLAN_RUNS = 'mcloud.exchange.plan.runs';
/** 老单计划只迁移一次。没有它，用户把计划全删了、插件一重载又会把旧计划变回来。 */
export const STATE_PLANS_MIGRATED = 'mcloud.exchange.plans.migrated';

export interface ExchangePlan {
  /** 本地 id；编辑时不变，用来关联每号已跑次数。 */
  id: string;
  accountId: string;
  /** 稳定的兑换 id；老数据可能没有，只有名字。 */
  prizeId?: number;
  prizeName: string;
  /** 整点 cron（分必须是 0，见 scheduleCron.ts）。 */
  cron: string;
  /** 提前多少秒醒（60~300）。 */
  leadSec: number;
  /** 截止日期（YYYY-MM-DD / YYYY-MM-DDTHH:mm；空 = 不限）。 */
  until: string;
  /** 每个账号最多真正发起几次（0 = 不限）。 */
  maxRuns: number;
  enabled: boolean;
}

export function newPlanId(): string {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export function loadPlans(store: ReadableState): ExchangePlan[] {
  const raw = (store.getState(STATE_PLANS) ?? '').trim();
  if (raw === '') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is ExchangePlan => {
      if (x === null || typeof x !== 'object') return false;
      const p = x as Record<string, unknown>;
      return (
        typeof p.id === 'string' &&
        typeof p.accountId === 'string' &&
        typeof p.prizeName === 'string' &&
        typeof p.cron === 'string' &&
        typeof p.leadSec === 'number' &&
        typeof p.until === 'string' &&
        typeof p.maxRuns === 'number' &&
        typeof p.enabled === 'boolean'
      );
    });
  } catch {
    // 手改坏了：当作没有计划，不让整个兑换页崩掉。
    return [];
  }
}

export function savePlans(store: WritableState, plans: readonly ExchangePlan[], nowIso: string): void {
  store.setState(STATE_PLANS, JSON.stringify(plans), nowIso);
}

export function planTarget(plan: ExchangePlan): string {
  return plan.prizeId !== undefined ? String(plan.prizeId) : plan.prizeName;
}

export function enabledPlans(plans: readonly ExchangePlan[]): ExchangePlan[] {
  return plans.filter((p) => p.enabled);
}

/** 所有启用计划整点的并集。没有计划时给默认整点（任务本身会 paused）。 */
export function unionCron(plans: readonly ExchangePlan[]): string {
  const hours = new Set<number>();
  for (const p of plans) {
    if (!p.enabled) continue;
    try {
      for (const h of parseCron(p.cron).hours) hours.add(h);
    } catch {
      // 坏计划不参与并集；界面保存时已经校验过，这里只是兜底。
    }
  }
  if (hours.size === 0) return '0 10 * * *';
  return '0 ' + [...hours].sort((a, b) => a - b).join(',') + ' * * *';
}

export function maxLeadMs(plans: readonly ExchangePlan[]): number {
  let ms = 60_000;
  for (const p of plans) {
    if (!p.enabled) continue;
    ms = Math.max(ms, Math.min(300, Math.max(60, p.leadSec)) * 1000);
  }
  return ms;
}

/** 下一条启用计划的整点（毫秒）；没有返回 null。 */
export function nextPlanTargetMs(plans: readonly ExchangePlan[], afterMs: number): number | null {
  let best: number | null = null;
  for (const p of plans) {
    if (!p.enabled) continue;
    const t = nextCronTargetMs(p.cron, afterMs);
    if (t === null) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** 这一拍的目标时刻，哪些计划该跑。 */
export function duePlans(plans: readonly ExchangePlan[], targetMs: number): ExchangePlan[] {
  return plans.filter((p) => {
    if (!p.enabled) return false;
    try {
      return cronMatchesAt(p.cron, targetMs);
    } catch {
      return false;
    }
  });
}

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:00`;
}

/** 面板卡片上的一行人话。 */
export function planSummary(store: ReadableState, nowMs: number = Date.now()): string {
  const plans = loadPlans(store);
  const on = enabledPlans(plans);
  if (on.length === 0) return plans.length === 0 ? '还没设定时计划' : `${plans.length} 个计划（都未启用）`;
  const next = nextPlanTargetMs(on, nowMs);
  const head = `${on.length} 个计划`;
  return next === null ? head : `${head} · 下次 ${fmtLocal(next)}`;
}

/** 每号已跑次数：`{planId: n}`。计划是“一条一个账号”，所以不需要再按账号分。 */
export function loadPlanRuns(store: ReadableState): Record<string, number> {
  const raw = (store.getState(STATE_PLAN_RUNS) ?? '').trim();
  if (raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function planRuns(store: ReadableState, planId: string): number {
  return loadPlanRuns(store)[planId] ?? 0;
}

export function bumpPlanRuns(store: WritableState, planId: string, nowIso: string): void {
  const all = loadPlanRuns(store);
  all[planId] = (all[planId] ?? 0) + 1;
  store.setState(STATE_PLAN_RUNS, JSON.stringify(all), nowIso);
}

export function resetPlanRuns(store: WritableState, planId: string, nowIso: string): void {
  const all = loadPlanRuns(store);
  delete all[planId];
  store.setState(STATE_PLAN_RUNS, JSON.stringify(all), nowIso);
}

/** 界面用：计划 + 账号名 + 下一次目标。 */
export function planViews(store: ReadableState): Record<string, unknown>[] {
  const accounts = loadAccounts(store as never);
  const runs = loadPlanRuns(store);
  return loadPlans(store).map((p) => {
    const a = accounts.find((x) => x.id === p.accountId);
    const next = nextCronTargetMs(p.cron, Date.now());
    return {
      id: p.id,
      accountId: p.accountId,
      accountLabel: a?.label ?? p.accountId,
      accountOk: !!a && a.disabled !== true,
      prizeId: p.prizeId ?? null,
      prizeName: p.prizeName,
      cron: p.cron,
      leadSec: p.leadSec,
      until: p.until,
      maxRuns: p.maxRuns,
      enabled: p.enabled,
      runs: runs[p.id] ?? 0,
      nextRun: p.enabled && next !== null ? new Date(next).toISOString() : '',
    };
  });
}

/** 老库一次性迁移：旧单计划按当时选的账号拆成多条计划。 */
export function migrateLegacyPlan(store: WritableState, nowIso: string): boolean {
  if (store.getState(STATE_PLANS_MIGRATED) === '1') return false;
  if (loadPlans(store).length > 0) {
    store.setState(STATE_PLANS_MIGRATED, '1', nowIso);
    return false;
  }
  const target = (store.getState('mcloud.exchange.schedule.plan') ?? '').trim();
  if (target === '') {
    store.setState(STATE_PLANS_MIGRATED, '1', nowIso);
    return false;
  }
  const name = (store.getState('mcloud.exchange.schedule.plan_name') ?? '').trim();
  const cron = (store.getState('mcloud.exchange.schedule.cron') ?? '').trim() || '0 10 * * *';
  const leadSec = Number(store.getState('mcloud.exchange.lead_sec') ?? '120') || 120;
  const until = (store.getState('mcloud.exchange.schedule.until') ?? '').trim();
  const maxRuns = Number(store.getState('mcloud.exchange.schedule.max_runs') ?? '0') || 0;
  const enabledKey = (store.getState('mcloud.exchange.schedule.enabled') ?? '').trim();
  const enabled = enabledKey === '1' || (enabledKey === '' && target !== '');
  // 老库可能没有“兑换任务账号”这一格（上一版默认全部）⇒ 退回全部启用账号，
  // 不能因为读不到选择就把老用户的计划静默丢掉。
  let accounts = resolveTaskAccounts(store, '兑换');
  if (accounts.length === 0) {
    accounts = loadAccounts(store as never)
      .filter((a) => a.disabled !== true)
      .map((a) => a.id);
  }
  const plans: ExchangePlan[] = accounts.slice(0, 8).map((accountId) => ({
    id: newPlanId(),
    accountId,
    ...(/^\d+$/.test(target) ? { prizeId: Number(target) } : {}),
    prizeName: name !== '' ? name : target,
    cron,
    leadSec,
    until,
    maxRuns,
    enabled,
  }));
  store.setState(STATE_PLANS_MIGRATED, '1', nowIso);
  if (plans.length === 0) return false;
  savePlans(store, plans, nowIso);
  return true;
}
