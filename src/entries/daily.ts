// 插件 \`mcloud-daily\` —— 用户可见任务「日常」。
//
// 这个文件只做三件事：建 store / 建 transport、把面板「插件配置」并进 state、
// 注册任务（名字 + cron + 预算）。**编排**（逐账号跑、日志、运行记录、推送、卡片摘要）
// 在 \`src/app/daily/run.ts\` —— 原来这些都挤在这里，一条链要翻 300 行。
//
// 业务口径（每一步做什么、为什么这么切）见 \`docs/task-state.md\`；
// "日常"这条任务的两跳（08:00 / 20:00）与"第二趟是兜底不是重复"的来由在 run.ts 里。

import { defineTask } from '../host/panel/index.ts';
import { blockersFor, summaryFor, syncOwnTask } from '../mcloud/taskReadiness.ts';
import { runDailyTask } from '../app/daily/run.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  makeStore,
  makeTransport,
  notify,
  syncConfigToState,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

const store = await makeStore('mcloud-daily');
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

// ⚠ 必须在 `BUDGET_MS` **之前**：预算就是加载期算的（下面 `dailyBudgetMs`），
//   顺序反了的话面板上改的预算要等下一次重载才生效。
await syncConfigToState(store);

/** 日常这一趟的**单次预算**（毫秒）。
 *
 *  为什么做成可配：3 个账号 + 每条任务之间 0.5–2 秒的间隔，一趟本就要好几分钟；
 *  写死一个数就必然出现"跑到一半被宿主强杀"（2026-11-03 现场：300s 被中断）。
 *
 *  读的是 `mcloud.daily.budget_s`（秒）。缺省 **900**；允许 60–3600。
 *  ⚠ 面板自己对单任务预算有上限（`hostapi.rs` 的 `MAX_DECLARED_BUDGET_MS`，10 分钟），
 *  超过会被夹；这里先按上限夹一道，免得"配了 900 实际只有 600"没人知道。 */
/** 面板对单任务预算的**硬上限**：`hostapi.rs` 的 `MAX_DECLARED_BUDGET_MS`。
 *  ⚠ 超了不是"夹一下"，是**抛异常、插件整个加载失败**（2026-11-03 09:58 现场：
 *  声明 900s ⇒ `Error: budget_ms 太大（900000ms），最多 600000ms`，日常任务直接消失）。
 *  所以这里必须先按它夹住，**永远不往宿主递一个超限的数**。 */
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
const BUDGET_MS = dailyBudgetMs(store);

// ── 注册 ──

await defineTask(
  {
    name: '日常',
    // 白天两跳：低配盒子不常在线时，上线之后的那一跳就是兜底
    // （面板不补跑，见 run.ts 头注）。整趟成功后剩下那些跳是零请求的秒返回。
    cron: '0 8,20 * * *',
    budget_ms: BUDGET_MS,
    // 日常是“随时跑都安全”的环境型任务：面板任务列表里显示，默认 cron 保留。
    // 没账号时是“未就绪”（灰），不是“失败”（红）。
    surface: 'panel',
    summary: summaryFor(store, '日常'),
    blockers: blockersFor(store, '日常'),
  },
  (p: TaskPayload) =>
    runDailyTask(
      {
        store,
        transport,
        budgetMs: BUDGET_MS,
        // 推送要宿主能力（smtp / http），领域层不认识 ⇒ 由入口注入
        notify: (taskKey, title, text, hadFailure) => notify(store, transport, taskKey, title, text, hadFailure),
      },
      p,
    ),
);

// 注册完再写一次自己那张卡片：\`defineTask\` 的 opts.summary/blockers **面板不认**
// （register_cron 只收 params/lead_ms），卡片上的字只能靠 set_job_* 写；
// 而这是自己的任务，刚注册完，一定写得进。
syncOwnTask(store, '日常');
