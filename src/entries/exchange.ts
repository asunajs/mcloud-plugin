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

import { logTo } from '../ports/log.ts';
import { defineTask, panel } from '../host/panel/index.ts';
import { runAuthRefresh } from '../mcloud/authRefresh.ts';
import { hourKey } from '../mcloud/exchangeTiming.ts';
import { loadAccounts } from '../mcloud/accounts.ts';
import { appendRun } from '../mcloud/runLog.ts';
import { STATE_ORDERED_HOUR } from '../mcloud/tasks/exchangeOrder.ts';
import {
  depsForAccount,
  LONG_REQUEST_TIMEOUT_MS,
  makeStore,
  makeTransport,
  syncConfigToState,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';
import { labelOf, shortLabel } from '../mcloud/taskAccounts.ts';
import { blockersFor, syncExchangeJob } from '../mcloud/taskReadiness.ts';
import { logBoth } from '../mcloud/log.ts';
import { lineLevel, lineText, stepTally } from '../mcloud/tasks/stepLog.ts';
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

// 一个插件一条 JS 执行通道（面板默认）；开抢那一下不会被别的插件的任务拖住。

const store = await makeStore('mcloud-exchange');
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

// 面板「插件配置」里那两格先并进 state（判据见 mcloud/configOverlay.ts 文件头）。
await syncConfigToState(store);

// 老库迁移：上一版只有一条全局计划，按当时选的账号拆成多条。
if (migrateLegacyPlan(store, new Date().toISOString())) {
  logTo('info', '老库迁移：兑换的旧单计划已按账号拆成多条计划');
}

const bootAll = loadPlans(store);
const bootPlans = enabledPlans(bootAll);
const bootCron = bootPlans.length > 0 ? unionCron(bootPlans) : DEFAULT_SCHEDULE_CRON;
const bootLeadMs = maxLeadMs(bootPlans);

await defineTask(
  {
    name: '兑换',
    cron: bootCron,
    budget_ms: BUDGET_MS,
    // 提前量取所有计划里最大的那个；具体某条计划提前少一点也没关系，
    // `runExchange` 的时间闸会在窗口前等，不会提前发单。
    lead_ms: bootLeadMs,
    // 兑换是**插件页面管理的功能实例**：配置全在云盘页；面板任务列表只负责叫醒与记录。
    surface: 'plugin',
    summary: planSummary(store),
    blockers: blockersFor(store, '兑换'),
  },
  async (p: TaskPayload) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    // ⚠ 面板**不发** scheduledAt（由 defineTask 合成）。解析不出来就按"现在"算 ——
    //   以前这里 `return`，而适配层给的是空串 ⇒ 这条任务在新面板上一次都没跑过。
    const parsedTarget = Date.parse(p.scheduledAt);
    const targetMs = Number.isFinite(parsedTarget) ? parsedTarget : startedMs;

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
        logBoth(store, 'debug', '计划「' + plan.prizeName + '」：账号已删除或停用，这一趟跳过', at);
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

      // 原生 token 到期就自动续（离到期还远时零请求）—— 兑换和签到共用同一份凭据。
      const auth = await runAuthRefresh(deps);
      if (!auth.skipped) {
        logBoth(store, auth.ok ? 'debug' : 'warn', `凭据续期：${auth.note}`, at);
      }

      const r = await runExchange(deps, {
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
      const tag = `[${shortLabel(who)}]`;
      logBoth(store, 'start', `${tag} 兑换 · ${plan.prizeName}`, at);
      let prev = '';
      // 级联的“没有网页会话”不逐行刷：一个根因会拖垮十步。
      const skippedSteps: string[] = [];
      for (const line of r.detail) {
        const shown = lineText(line);
        if (shown === prev) continue;
        prev = shown;
        if (shown.includes('跳过（没有网页会话）')) {
          skippedSteps.push(shown.split('：')[0] ?? shown);
          continue;
        }
        logBoth(store, lineLevel(shown), `${tag} ${shown}`, at);
      }
      if (skippedSteps.length > 0) {
        const head = skippedSteps.slice(0, 3).join('、');
        logBoth(
          store,
          'debug',
          `${tag} 跳过 ${skippedSteps.length} 项（没有网页会话）：${head}${skippedSteps.length > 3 ? ' 等' : ''}`,
          at,
        );
      }
      const { bad, hard } = stepTally(r.steps);
      const tail =
        bad === 0
          ? `${plan.prizeName}：都成了`
          : hard === 0
            ? `${plan.prizeName}：${bad} 项跳过（没有网页会话）`
            : `${plan.prizeName}：${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', `${tag} ${tail}`, at);
    }

    if (acted === 0) {
      logBoth(
        store,
        'debug',
        '这一趟没动手 —— ' +
          plans.length +
          ' 条计划都还没到该抢的时候（或这一场已经试过了）' +
          (skipped > 0 ? '，其中 ' + skipped + ' 条被跳过' : ''),
        at,
      );
    }
  },
);

// 新装先暂停：等用户建好计划、再点“启用”。（面板没有"注册时带 paused"这个口子，
// 所以暂停是注册之后单独说一次；已有安装的开关由面板自己保留。）
if (bootPlans.length === 0) panel.setJobPaused('兑换', true);

// 注册完按**计划表**把自己那条任务的状态整一遍（cron / 暂停 / 未就绪 / 摘要）。
// 为什么加载时还要做：界面插件改计划时调的是这一套，但那一刻兑换插件可能正"按需
// 加载、还没装"，面板会回"没有这个任务" —— 于是那次改动只能等这里补上。
syncExchangeJob(store);

logTo('debug', 
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