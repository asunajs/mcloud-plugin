// 插件 `mcloud-live` —— 用户可见任务「直播」。
//
// # 一句话：**口令只收一次，领取按账号各领一次**
//
// 口令是**共享资源**：一个账号从弹幕里听到，所有账号都能拿去领小红花。
// 所以「听」不能按账号分（分着听 = 3 倍请求、3 倍时间，还重复撞同一批弹幕），
// 而「领」必须按账号分（"这个号领过哪条"要分开记，不然会白跑一枪 `200112`）。
//
// 于是这一趟是两段：
//
// ```text
//   ① 收口令（整趟一次，用第一个账号的凭据）
//       开门（房间列表）
//         ├─ 没开播 / 开播的不是「中国移动云盘」 ⇒ 到此为止（零请求）
//         └─ 开播 ⇒ 看小红书 → 听弹幕
//   ② 领（每个账号各一次，用共享池里的口令）
// ```
//
// 日志也照这个结构分两段：`------【口令】------` 一段（不属于任何账号），
// 然后每个账号一段。业务口径（为什么这么切、四条共享池规则、领取结果怎么分类）
// 在 [`docs/live-spec.md`](../../docs/live-spec.md)。
//
// # 两种模式
//
//   ① **手动**：用户在开播期间把口令贴进来（一条或多条）⇒ **直接领**：
//      不开门、不看小红书、不听弹幕（口令已经在手里了，那些都是白跑；
//      而且门偶发失败会把一趟本来能跑完的领取拖黄）。
//   ② **自动**：开播**时间**固定、**日期**不固定 ⇒ 每天两次碰运气
//      （`30 10,15 * * *` = 10:30 / 15:30）。碰上了才去小红书和弹幕里捡。
//
// 两种模式共用同一个 `runLiveDraw`。旧版本那五条 cron（口令/日程/听/定时/领）
// 已经并成这一条 —— 那五行的名字看不出"它们是同一件事的零件"。
//
// # 为什么预算要到分钟级
//
// 弹幕是**实时**的，而"听"要在**连续时间**里反复读帧。一次触发连听 5 分钟，
// 比"每 10 秒看一眼"稳：两帧之间漏掉的东西只能靠宿主的无界队列补，
// 补不补得上取决于队列有多深。门关着时第一次调用就 `idle` 停下 —— 零请求。
//
// ⚠ 面板对 `budget_ms` 的上限是 10 分钟（`rust-plugin-panel/src/hostapi.rs`
//   的 `MAX_DECLARED_BUDGET_MS`），5 分钟留足了余量。


import { defineTask } from '../host/panel/index.ts';
import { blockersFor, setTaskSummary, summaryFor, syncOwnTask } from '../mcloud/taskReadiness.ts';
import { LONG_REQUEST_TIMEOUT_MS, makeHost, makeStore, makeTransport, syncConfigToState } from './shared.ts';
import type { TaskPayload } from './shared.ts';
import { runLive } from '../app/live/run.ts';

// 共享粗粒度 lane：听窗口是连续几十秒的占用，但不需要毫秒级；
// 和日常排队即可。只有 exchange 和路由插件需要独占（见 shared.ts 文件头）。

const store = await makeStore('mcloud-live');
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
const host = makeHost();

// 面板「插件配置」里那几格先并进 state（判据见 mcloud/configOverlay.ts 文件头）。
await syncConfigToState(store);

/** 听窗口预算。一天只来两次（10:30 / 15:30），所以每次听久一点：
 *  5 分钟。面板对预算的上限是 10 分钟（`MAX_DECLARED_BUDGET_MS`）。 */
const BUDGET_MS = 600_000;

// 这一条只是**注册**：名字 + cron + 预算 + 交给 app/live。
// 编排（收口令 → 每账号领 → 落运行记录 → 写卡片）在 src/app/live/run.ts。
await defineTask(
  {
    name: '直播',
    // 用户口径（2026-10-17）：「太频繁了，每天上午 10:30 / 下午 15:30 两次」。
    // 没在播时第一次调用就早退（零请求）。
    cron: '30 10,15 * * *',
    budget_ms: BUDGET_MS,
    // 直播也是环境型任务：面板任务列表里显示；没账号时“未就绪”。
    surface: 'panel',
    summary: summaryFor(store, '直播'),
    blockers: blockersFor(store, '直播'),
  },
  (p: TaskPayload) => runLive({ store, transport, host, budgetMs: BUDGET_MS }, p),
);

// 同 daily：卡片上的字面板不认 opts，只能注册完自己写一遍
syncOwnTask(store, '直播');
