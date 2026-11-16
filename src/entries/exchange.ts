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

// 三条任务的开场是同一套（建 store → 并配置 → 算预算 → 注册 → 写卡片），见 ./register.ts。
// 兑换多两手：老库迁移 + 计划表快照（`prepare`），以及注册之后按计划表把自己那条任务
// 的状态整一遍（`after`）—— 它不是自己的 cron，是「所有启用计划的整点并集」。
import { logTo } from '../ports/log.ts';
import { panel } from '../host/panel/index.ts';
import { syncExchangeJob } from '../mcloud/taskReadiness.ts';
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
import { registerTask } from './register.ts';

// 计划表快照：`prepare` 里算，`cron`/`leadMs`/`after` 里用。
let bootPlans: ReturnType<typeof enabledPlans> = [];
let bootCron = DEFAULT_SCHEDULE_CRON;
let bootLeadMs = 0;

await registerTask({
  plugin: 'mcloud-exchange',
  name: '兑换',
  prepare: (store) => {
    // 老库迁移：上一版只有一条全局计划，按当时选的账号拆成多条。
    if (migrateLegacyPlan(store, new Date().toISOString())) {
      logTo('info', '老库迁移：兑换的旧单计划已按账号拆成多条计划');
    }
    bootPlans = enabledPlans(loadPlans(store));
    bootCron = bootPlans.length > 0 ? unionCron(bootPlans) : DEFAULT_SCHEDULE_CRON;
    bootLeadMs = maxLeadMs(bootPlans);
  },
  cron: () => bootCron,
  budgetMs: () => BUDGET_MS,
  // 提前量取所有计划里最大的那个；具体某条计划提前少一点也没关系，
  // `runExchange` 的时间闸会在窗口前等，不会提前发单。
  leadMs: () => bootLeadMs,
  // 兑换是**插件页面管理的功能实例**：配置全在云盘页；面板任务列表只负责叫醒与记录。
  surface: 'plugin',
  run: runExchangeTask,
  after: (store) => {
    // 新装先暂停：等用户建好计划、再点"启用"。（面板没有"注册时带 paused"这个口子，
    // 所以暂停是注册之后单独说一次；已有安装的开关由面板自己保留。）
    if (bootPlans.length === 0) panel.setJobPaused('兑换', true);
    // 按**计划表**把自己那条任务的状态整一遍（cron / 暂停 / 未就绪 / 摘要）。
    // 为什么加载时还要做：界面插件改计划时调的是这一套，但那一刻兑换插件可能正"按需
    // 加载、还没装"，面板会回"没有这个任务" —— 于是那次改动只能等这里补上。
    syncExchangeJob(store);
    logTo(
      'debug',
      `mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1000}s，独占线程）—— ${bootPlans.length} 条计划，cron ${bootCron}，提前 ${bootLeadMs / 1000}s 醒`,
    );
  },
});
