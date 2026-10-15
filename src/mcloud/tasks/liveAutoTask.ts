// 「直播自动定时」（`live-auto`）任务 —— 只**算时刻**，一个上游请求都不发。
//
// 算法层在 [`../liveAuto.ts`]（纯函数、不碰状态与时钟）；这里只做
// "读池 → 算 → 落库 → 给界面一句读数"。
//
// # 它跟听弹幕那条链的关系
//
// ```text
// live-auto（@every 5m，零请求）  ⇒  池里的「下一场」+ 1 小时 = 醒来的时刻
// live-listen（@every 10s）       ⇒  被判"没开播/没聊天室"时，冷却不再固定 5 分钟，
//                                     而是**睡到那个时刻**（没日程时才退回 5 分钟）
// ```
//
// ⚠ 为什么不把"到点跑一轮"也塞进这个任务：听弹幕那条链本来就带着"窗口到点 → 收尾 →
// 下一拍重走门"的自恢复逻辑（见 `liveListen.ts`）。定时器只需要负责**叫醒它**，
// 而不是再当第二个驱动源 —— 两个驱动源抢同一个状态机是这一族最容易出的错。
//
// ⚠ 还要防"计划过期"：面板睡了一晚上再起来，池里那份日程可能是几天前看的
// ⇒ 那时**不能**按它定时刻（会定在一个已经过去的时刻上），退回默认的 5 分钟重查。
// 判据在 [`planTrusted`]（`scheduleAtMs` 有多新）。


import type { Store } from '../../store/types.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadPoolFrom, poolSummary } from '../koulingPool.ts';
import {
  ONE_HOUR_MS,
  earliestPlusOneHour,
  formatLocalMs,
  oneShotExpr,
  planDue,
  planInWindow,
  type WakePlan,
} from '../liveAuto.ts';

export const TASK = 'live-auto';
const STATE_WAKE_PLAN = 'mcloud.live.wake_plan';

/** 这份日程多新才算可信（超过就退回"默认重查"，不按它睡）。 */
export const SCHEDULE_TRUST_MS = 6 * ONE_HOUR_MS;

export function loadWakePlan(store: Pick<Store, 'getState'>): WakePlan | null {
  const raw = store.getState(STATE_WAKE_PLAN);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WakePlan;
    return typeof v?.wakeAtMs === 'number' && typeof v?.wakeAt === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function saveWakePlan(store: Store, plan: WakePlan | null, nowIso: string): void {
  store.setState(STATE_WAKE_PLAN, plan === null ? '' : JSON.stringify(plan), nowIso);
}

/** 池里那份日程还新不新（`undefined` = 池里没有日程信息）。 */
export function planTrusted(scheduleAtMs: number | null, nowMs: number): boolean {
  return scheduleAtMs !== null && nowMs - scheduleAtMs <= SCHEDULE_TRUST_MS;
}

/** 从池里算一份新计划（纯计算 + 落库，零上游请求）。 */
export function refreshWakePlan(
  deps: TaskDeps,
  opts: { windowMs: number },
): { plan: WakePlan | null; why: string } {
  const nowMs = Date.parse(deps.nowIso);
  const { pool } = loadPoolFrom(deps.store);
  const summary = poolSummary(pool, formatLocalMs(nowMs), nowMs);
  const trusted = planTrusted(summary.scheduleAtMs, nowMs);
  const fromStart = summary.nextStart ?? '';
  const wakeAt = trusted && fromStart !== '' ? earliestPlusOneHour([fromStart], nowMs) : undefined;

  if (wakeAt === undefined) {
    saveWakePlan(deps.store, null, deps.nowIso);
    return {
      plan: null,
      why:
        fromStart === ''
          ? '池里没有「下一场」⇒ 不排定时（等门下次探到日程再说）'
          : '池里那份日程太旧（超过 6 小时）⇒ 不按它睡，退回默认重查',
    };
  }
  const plan: WakePlan = {
    wakeAt,
    wakeAtMs: Date.parse(`${wakeAt.replace(' ', 'T')}+08:00`),
    fromStart,
    computedAt: formatLocalMs(nowMs),
    expr: oneShotExpr(wakeAt),
    windowMs: opts.windowMs,
  };
  // ⚠ 时刻是**东八区墙钟串**，`Date.parse` 认 `+08:00` 后缀 ⇒ 这里显式带上，
  //   免得落到机器本地时区（那会让"几点醒"整体偏几小时）。
  saveWakePlan(deps.store, plan, deps.nowIso);
  return { plan, why: `按「${fromStart}」+1 小时 ⇒ ${wakeAt}` };
}

/** 任务本体：刷新计划，并给界面一句读数。 */
export function runLiveAuto(deps: TaskDeps, opts: { windowMs: number }): TaskOutcome {
  const nowMs = Date.parse(deps.nowIso);
  const before = loadWakePlan(deps.store);
  const { plan, why } = refreshWakePlan(deps, opts);
  const changed = before?.wakeAt !== plan?.wakeAt;
  // ⚠ 这里**没有** `deps.log`（`TaskDeps` 只有 store/transport/nowIso/baseUrl/lateMs）——
  //   任务的日志是面板按 `outcome.note` 记的 ⇒ 变化这件事写进 note，
  //   别自己去加一个宿主没有的口子。
  const due = planDue(plan, nowMs);
  return {
    ok: true,
    note:
      plan === null
        ? `不排定时（${why}）`
        : `${changed ? '排定' : '仍是'} ${plan.wakeAt} 醒（= ${plan.fromStart} +1h；等价 cron ${plan.expr ?? '?'}）${
            due ? ' —— 已到点' : ''
          }`,
  };
}

/** 给听弹幕那条链用：**现在该不该按计划睡**。
 *
 *  返回 `undefined` = 照旧（默认冷却）；返回数值 = 睡到那一刻（毫秒）。
 *  判据三条：有计划、计划可信、还没到点。**已到点 ⇒ 不睡**（那是"该醒"）。 */
export function wakeSleepMs(
  store: Pick<Store, 'getState'>,
  nowMs: number,
  windowMs: number,
): number | undefined {
  const plan = loadWakePlan(store);
  if (plan === null) return undefined;
  if (!planInWindow(plan, nowMs) && planDue(plan, nowMs)) {
    // 计划到点了但窗口已经过完（面板睡了很久）⇒ 别睡，让链重走一遍门
    // （重走会顺手刷新计划）。
    return undefined;
  }
  if (planDue(plan, nowMs)) return undefined;
  void windowMs;
  return plan.wakeAtMs - nowMs;
}
