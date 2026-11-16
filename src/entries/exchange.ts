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
import { blockersFor, syncExchangeJob, syncOwnTask } from '../mcloud/taskReadiness.ts';
import {
  enabledPlans,
  loadPlans,
  maxLeadMs,
  migrateLegacyPlan,
  planSummary,
  unionCron,
} from '../mcloud/exchangePlans.ts';
import { BUDGET_MS, DEFAULT_SCHEDULE_CRON } from '../mcloud/tasks/exchangeRun.ts';
import { runExchangeTask } from '../app/exchange/run.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  makeStore,
  makeTransport,
  notify,
  syncConfigToState,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';


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

// ── 注册 ──
//
// 这一条只是**注册**：名字 + 由计划表算出来的 cron/提前量/预算。
// 编排（哪些计划该跑、逐计划发单、日志、运行记录、推送）在 src/app/exchange/run.ts。

await defineTask(
  {
    name: '兑换',
    cron: bootCron,
    budget_ms: BUDGET_MS,
    // 提前量取所有计划里最大的那个；具体某条计划提前少一点也没关系，
    // \`runExchange\` 的时间闸会在窗口前等，不会提前发单。
    lead_ms: bootLeadMs,
    // 兑换是**插件页面管理的功能实例**：配置全在云盘页；面板任务列表只负责叫醒与记录。
    surface: 'plugin',
    summary: planSummary(store),
    blockers: blockersFor(store, '兑换'),
  },
  (p: TaskPayload) =>
    runExchangeTask(
      {
        store,
        transport,
        budgetMs: BUDGET_MS,
        notify: (taskKey, title, text, hadFailure) => notify(store, transport, taskKey, title, text, hadFailure),
      },
      p,
    ),
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