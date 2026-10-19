// 三条定时任务的「就绪状态」与「卡片摘要」。
//
// # 为什么需要这一层
//
// 面板把「插件加载」当成「任务可以跑了」。但 mcloud 的账号、兑换奖品都是**运行期**
// 才有的配置：插件加载时可能一个号都没有。没有这层，任务会按默认 cron 照跑，
// 界面上是一堆红日志（更糟的是半配置下的错误运行）。
//
// 所以每条任务声明两类东西：
//   - blockers：未就绪原因。非空 ⇒ 面板调度器**不触发**（手动“运行一次”仍可）；
//   - summary：面板卡片上的一行人话（“3 个账号 · 目标：xxx”）。
//
// # 为什么用 mcloud-xxx/任务名
//
// 账号/奖品只在界面插件（mcloud）里改得到，而任务挂在另外三个插件名下。
// 面板的宿主 API 允许**同组**（名字第一个 - 前面那段相同）插件互相改任务状态，
// 所以这里用全名寻址；本插件自己的任务也可以只写任务名。
//
// # 老面板
//
// 这些宿主函数是这一版面板才有的。走 `globalThis.host`（两个运行时都会装）+ 可选调用，
// 老面板上直接跳过，不让插件因为“面板太旧”而加载失败。
//
// ⚠ 不用 `import ... from 'host-api'`：单测（node --test）没有那个解析器，
//   一个静态 import 就会让所有 import 了 routes 的测试整套挂掉。

import { loadAccounts } from './accounts.ts';
import { resolveTaskAccounts, saveTaskAccounts, taskAccountsKey } from './taskAccounts.ts';

type Store = { getState(k: string): string | null | undefined };

const H = ((globalThis as Record<string, unknown>).host ??
  (globalThis as Record<string, unknown>).host_api ??
  {}) as Record<string, unknown>;

function call(name: string, ...args: unknown[]): void {
  const fn = H[name];
  if (typeof fn !== 'function') return; // 老面板：没有这个能力，跳过
  try {
    (fn as (...a: unknown[]) => void)(...args);
  } catch {
    // 任务还没注册（插件加载顺序）/ 面板拒绝：都不是插件该崩的理由。
  }
}

/** 启用的账号数（停用的不算“可用”）。 */
export function enabledAccountCount(store: Store): number {
  return loadAccounts(store as never).filter((a) => a.disabled !== true).length;
}

/** 兑换的定时目标（奖品那一句）；空 = 还没选。 */
export function exchangePlan(store: Store): string {
  return (store.getState('mcloud.exchange.schedule.plan') ?? '').trim();
}

/** 一条任务的未就绪原因。 */
export function blockersFor(store: Store, task: string): string[] {
  if (task === '兑换') {
    const out: string[] = [];
    if (resolveTaskAccounts(store as never, '兑换').length === 0) out.push('还没有选账号');
    if (exchangePlan(store) === '') out.push('还没设定时奖品');
    return out;
  }
  return enabledAccountCount(store) === 0 ? ['还没有账号'] : [];
}

function accountLabels(store: Store, ids: string[]): string {
  const all = loadAccounts(store as never);
  const out = ids.map((id) => all.find((a) => a.id === id)?.label ?? id);
  return out.length === 0 ? '无' : out.join('、');
}

/** 一条任务在面板卡片上的一行人话。 */
export function summaryFor(store: Store, task: string): string {
  if (task === '兑换') {
    const ids = resolveTaskAccounts(store as never, '兑换');
    const n = ids.length;
    const plan = exchangePlan(store);
    const lead = (store.getState('mcloud.exchange.lead_sec') ?? '120').trim() || '120';
    if (plan === '') return n > 0 ? n + ' 个账号 · 还没设定时奖品' : '还没选账号和奖品';
    // “哪个账号跑的、换的是哪一件、参数是什么”要在卡片上一眼看到 ——
    // 这正是兑换任务不该藏在面板任务列表里的原因（它是插件里的一个功能实例）。
    return n + ' 个账号（' + accountLabels(store, ids) + '） · 目标：' + plan + ' · 提前 ' + lead + 's';
  }
  const n = enabledAccountCount(store);
  if (n === 0) return '还没有账号';
  const ids = loadAccounts(store as never)
    .filter((a) => a.disabled !== true)
    .map((a) => a.id);
  return n <= 3 ? n + ' 个账号（' + accountLabels(store, ids) + '）' : n + ' 个账号';
}

/** 三条任务的全名（面板里按 插件名/任务名 寻址）。 */
export const TASK_KEYS: Record<string, string> = {
  日常: 'mcloud-daily/日常',
  兑换: 'mcloud-exchange/兑换',
  直播: 'mcloud-live/直播',
};

/** 运行期设置一条任务在面板卡片上的一行人话。 */
export function setTaskSummary(task: string, text: string): void {
  call('set_job_summary', TASK_KEYS[task] ?? task, text);
}

/** 运行期设置一条任务的未就绪原因（空数组 = 就绪）。 */
export function setTaskBlockers(task: string, blockers: string[]): void {
  call('set_job_blockers', TASK_KEYS[task] ?? task, blockers);
}

/** 运行期改一条任务的调度（写面板的 override，插件更新不会丢）。 */
export function setTaskSchedule(task: string, expr: string, leadMs?: number): void {
  call('set_job_schedule', TASK_KEYS[task] ?? task, { expr, lead_ms: leadMs });
}

/** 运行期启用/暂停一条任务的定时。 */
export function setTaskPaused(task: string, paused: boolean): void {
  call('set_job_paused', TASK_KEYS[task] ?? task, paused);
}

/** 老库一次性迁移：上一版兑换默认“全部账号”，且定时默认是启用的。
 *
 * 判据用 `schedule.enabled` 这一格：它是这一版才有的，老库没有。
 * 新用户（从没设过定时目标）不会被迁移，仍从“空账号 + 暂停”开始。 */
export function migrateLegacyExchange(store: Store & { setState(k: string, v: string, now: string): void }, nowIso: string): boolean {
  if (exchangePlan(store) === '') return false;
  if ((store.getState('mcloud.exchange.schedule.enabled') ?? '').trim() !== '') return false;
  if ((store.getState(taskAccountsKey('兑换')) ?? '').trim() !== '') return false;
  saveTaskAccounts(store as never, '兑换', { all: true, ids: [] }, nowIso);
  store.setState('mcloud.exchange.schedule.enabled', '1', nowIso);
  return true;
}

/** 把三条任务的就绪状态与摘要同步给面板。 */
export function syncTaskReadiness(store: Store, tasks: string[] = ['日常', '兑换', '直播']): void {
  for (const task of tasks) {
    const key = TASK_KEYS[task] ?? task;
    call('set_job_blockers', key, blockersFor(store, task));
    call('set_job_summary', key, summaryFor(store, task));
  }
}
