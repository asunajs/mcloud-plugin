// 插件 `mcloud-exchange` —— 用户可见任务「兑换」。
//
// # 一条计划 = 一个账号 + 一个目标 + 一个整点
//
// 面板的调度单位是「一条任务一个 cron」。为了让两个号能换不同的东西、不同的整点，
// 这里把所有启用计划的整点取**并集**注册成一条任务（例如 `0 10,20 * * *`），
// 到点后按目标整点分发：10 点只跑计划 A 的账号，20 点只跑计划 B 的账号。
// 面板任务列表里仍然只有一条「兑换」。
//
// 目标存 **prizeId**（稳定），名字只用于显示；老库只有名字时按名字兼容。

import { log, register_cron, worker_hint } from 'host-api';
import { hourKey } from '../mcloud/exchangeTiming.ts';
import { loadAccounts } from '../mcloud/accounts.ts';
import { appendRun } from '../mcloud/runLog.ts';
import { STATE_ORDERED_HOUR } from '../mcloud/tasks/exchangeOrder.ts';
import { depsForAccount, LONG_REQUEST_TIMEOUT_MS, makeStore, makeTransport } from './shared.ts';
import type { TaskPayload } from './shared.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { blockersFor } from '../mcloud/taskReadiness.ts';
import { logBoth } from '../mcloud/log.ts';
import {
  BUDGET_MS,
  DEFAULT_SCHEDULE_CRON,
  runExchange,
  scheduleUntilAllowed,
} from '../mcloud/tasks/exchangeRun.ts';
import {
  bumpPlanRuns,
  duePlans,
  enabledPlans,
  loadPlans,
  maxLeadMs,
  migrateLegacyPlan,
  planRuns,
  planSummary,
  planTarget,
  unionCron,
} from '../mcloud/exchangePlans.ts';

// 独占线程：开抢那一下不能被别的任务拖住（见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

// 老库迁移：上一版只有一条全局计划，按当时选的账号拆成多条。
if (migrateLegacyPlan(store, new Date().toISOString())) {
  log('老库迁移：兑换的旧单计划已按账号拆成多条计划');
}

const bootAll = loadPlans(store);
const bootPlans = enabledPlans(bootAll);
const bootCron = bootPlans.length > 0 ? unionCron(bootPlans) : DEFAULT_SCHEDULE_CRON;
const bootLeadMs = maxLeadMs(bootPlans);

register_cron(
  '兑换',
  bootCron,
  (p: TaskPayload) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    const targetMs = Date.parse(p.scheduledAt);
    if (!Number.isFinite(targetMs)) return;

    // 这一拍的目标整点，哪些计划该跑（cron 的日/月/周匹配也在这里判）。
    const plans = duePlans(loadPlans(store), targetMs);
    if (plans.length === 0) return;
    const targetHour = new Date(targetMs).getHours();
    const thisHour = hourKey(targetMs);
    const accounts = loadAccounts(store);
    let acted = 0;
    let skipped = 0;

    for (const plan of plans) {
      const acct = accounts.find((a) => a.id === plan.accountId);
      if (!acct || acct.disabled === true) {
        skipped += 1;
        log('计划「' + plan.prizeName + '」：账号已删除或停用，这一趟跳过');
        continue;
      }
      const untilGate = scheduleUntilAllowed(store, targetMs, plan.until);
      if (!untilGate.ok) {
        skipped += 1;
        continue;
      }
      const done = planRuns(store, plan.id);
      if (plan.maxRuns > 0 && done >= plan.maxRuns) {
        skipped += 1;
        continue;
      }

      // 每个账号一个 store：按账号的票、进度、小时闸都落到自己的袋里。
      const deps = depsForAccount(store, plan.accountId, p, transport);
      // 小时闸：这一小时已经发过单了 ⇒ 零请求秒返回。
      if (deps.store.getState(STATE_ORDERED_HOUR) === thisHour) {
        skipped += 1;
        continue;
      }

      const r = runExchange(deps, {
        maxWaitMs: BUDGET_MS - 10_000,
        targetHour,
        target: planTarget(plan),
      });
      // 真正发起了一次（不是离窗口还远）⇒ 计数；失败也算，按计划各算。
      if (r && !r.idle) bumpPlanRuns(store, plan.id, deps.nowIso);

      if (!r || r.idle) {
        // 离窗口还远 ⇒ 不写日志（这一趟一个请求都没发），但读数照样更新。
        store.recordRun({
          task: p.name,
          runs: p.runs,
          scheduledAt: p.scheduledAt,
          firedAt: p.firedAt,
          lateMs: p.lateMs,
          ok: true,
          note: r ? r.note : '这一趟没动手',
        });
        continue;
      }

      acted += 1;
      const who = acct.label || labelOf(store, plan.accountId);
      const note = who + ' · ' + plan.prizeName + '：' + r.note;
      appendRun(store, {
        task: 'exchange',
        acct: plan.accountId,
        who,
        at,
        ms: Date.now() - startedMs,
        ok: r.ok,
        note,
        steps: r.steps,
      });
      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: r.ok,
        note,
      });
      logBoth(store, 'info', '------【' + who + ' · ' + plan.prizeName + '】------', at);
      for (const line of r.detail) {
        logBoth(store, line.includes('没成') ? 'warn' : 'info', line, at);
      }
      const bad = r.steps.filter((x) => !x.ok).length;
      const tail =
        bad === 0
          ? '------【' + who + '】都成了------'
          : '------【' + who + '】' + bad + ' 项没成------';
      logBoth(store, bad > 0 ? 'warn' : 'info', tail, at);
    }

    if (acted === 0) {
      log(
        '这一趟没动手 —— ' +
          plans.length +
          ' 条计划都还没到该抢的时候（或这一场已经试过了）' +
          (skipped > 0 ? '，其中 ' + skipped + ' 条被跳过' : ''),
      );
    }
  },
  {
    budget_ms: BUDGET_MS,
    // 提前量取所有计划里最大的那个；具体某条计划提前少一点也没关系，
    // `runExchange` 的时间闸会在窗口前等，不会提前发单。
    lead_ms: bootLeadMs,
    // 兑换是**插件页面管理的功能实例**：面板任务列表不显示它，配置全在云盘页。
    surface: 'plugin',
    // 新装先暂停：等用户建好计划、点“启用”再跑。已有安装的 paused 由面板保留。
    paused: bootPlans.length === 0,
    manage_url: '#/plugin/mcloud',
    summary: planSummary(store),
    blockers: blockersFor(store, '兑换'),
  },
);

log(
  'mcloud-exchange：任务「兑换」（预算 ' +
    BUDGET_MS / 1000 +
    's，独占线程）—— ' +
    bootPlans.length +
    ' 条计划，cron ' +
    bootCron +
    '，提前 ' +
    bootLeadMs / 1000 +
    's 醒',
);
