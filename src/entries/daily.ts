// 插件 \`mcloud-daily\` —— 用户可见任务「日常」。
//
// 这个文件只做三件事：建 store / 建 transport、把面板「插件配置」并进 state、
// 注册任务（名字 + cron + 预算）。**编排**（逐账号跑、日志、运行记录、推送、卡片摘要）
// 在 \`src/app/daily/run.ts\` —— 原来这些都挤在这里，一条链要翻 300 行。
//
// 业务口径（每一步做什么、为什么这么切）见 \`docs/task-state.md\`；
// "每一趟都照跑、不讲今天跑过了"的来由在 run.ts 里。

// 三条任务的开场是同一套（建 store → 并配置 → 算预算 → 注册 → 写卡片），见 ./register.ts。
import { registerTask } from './register.ts';
import { runDailyTask } from '../app/daily/run.ts';

const MAX_BUDGET_MS = 600_000;
const MIN_BUDGET_S = 60;

function dailyBudgetMs(store: { getState(k: string): string | null | undefined }): number {
  const raw = store.getState('mcloud.daily.budget_s');
  const n = raw === null || raw === undefined ? NaN : Number(String(raw).trim());
  // 缺省就是面板允许的最大值（600 秒）：多账号 + 任务间间隔，300 秒根本不够。
  const sec = Number.isFinite(n) && n >= MIN_BUDGET_S ? Math.min(n, MAX_BUDGET_MS / 1000) : MAX_BUDGET_MS / 1000;
  return Math.min(Math.round(sec * 1000), MAX_BUDGET_MS);
}
// 3 个账号串行时，单账号约 40 秒，120 秒正好在第三个账号中间被宿主强杀
// （2026-11-01 08:02 现场：不是死循环，是预算太短）。留足多账号余量。
//
// ⚠ 2026-11-03：加了任务间/任务内间隔之后，3 个账号一趟轻松超过 300 秒
//   （现场 08:05：「执行超过预算 300s，被强制中断（疑似死循环）」）。
//   预算改成读**可配置**的一格，默认 **900 秒**。

await registerTask({
  plugin: 'mcloud-daily',
  name: '日常',
  // 这是我们**建议**的排期。真正跑几次、几点跑由面板（用户）决定 ——
  // 用户可能改成每天一次或每三小时一次，代码不得假设趟数。
  cron: '0 8,20 * * *',
  budgetMs: dailyBudgetMs,
  // 日常是"随时跑都安全"的环境型任务：面板任务列表里显示；没账号时是"未就绪"（灰）。
  surface: 'panel',
  run: runDailyTask,
});
