// 三条任务入口的**同一套开场**：建 store/transport → 把面板「插件配置」并进 state →
// 注册任务 → 写完自己那张卡片。
//
// 为什么值得收成一个函数：这五步在三个入口里各写了一遍，而**顺序是有讲究的** ——
//   · 预算要在 `syncConfigToState` **之后**算（面板上改的值就在那里并进 state，
//     先算就永远是上一次的旧值，「改了预算要重载才生效」那种怪毛病）
//   · 卡片摘要/未就绪要在 `defineTask` **之后**写（面板的 `register_cron` 只收
//     params/lead_ms，opts 里的 summary/blockers 它不认）
// 顺序写错不会报错，只会静默地不生效。收成一处之后，"三条任务的开场"只有一种写法。
//
// ⚠ 这一层是**入口层**：可以 import host/panel（宿主存在），所以不进 src/app/（R3 拦）。

import { defineTask } from '../host/panel/index.ts';
import type { Store } from '../store/types.ts';
import type { Transport } from '../mcloud/client.ts';
import type { TaskKey } from '../mcloud/pushConfig.ts';
import { SCHEDULED_TASKS } from '../mcloud/taskAccounts.ts';
import { blockersFor, summaryFor, syncOwnTask } from '../mcloud/taskReadiness.ts';
import { LONG_REQUEST_TIMEOUT_MS, makeStore, makeTransport, notify } from './shared.ts';
import type { TaskPayload } from './shared.ts';

/** 任务显示名（面板里那一行字）：只认这三条。 */
export type TaskName = (typeof SCHEDULED_TASKS)[number];

/** 交给编排层（`src/app/<任务>/run.ts`）的"整趟全局件"。 */
export interface TaskRunCtx {
  /** 全局 store（不是 scoped 到某个账号的那个） */
  store: Store;
  /** 长预算 transport（20 秒） */
  transport: Transport;
  /** 这条任务声明的预算（毫秒） */
  budgetMs: number;
  /** 推送：跑完之后按规则发一条（实现由这一层注入 —— 要宿主能力，领域层不认识） */
  notify(taskKey: TaskKey, title: string, text: string, hadFailure: boolean): Promise<unknown>;
}

export interface TaskRegistration {
  /** 插件名（决定 store 落在哪：`mcloud-daily` / `mcloud-exchange` / `mcloud-live`） */
  plugin: string;
  name: TaskName;
  /** 时钟。写死一个串，或按 store 算（兑换的 cron 是「所有启用计划的整点并集」）。 */
  cron: string | ((store: Store) => string);
  /** 预算（毫秒）。做成函数是为了能按配置算（配置在 `makeStore` 里已经统一好）。 */
  budgetMs: number | ((store: Store) => number);
  /** 提前量（毫秒）。兑换按计划表算，其它两条不需要。 */
  leadMs?: number | ((store: Store) => number);
  /** 注册**之前**要做的准备（兑换的老库迁移 + 计划表快照）。能拿到 store。 */
  prepare?: (store: Store) => void;
  /** 面板任务列表里显不显示：环境型任务 `panel`，插件页面管理的 `plugin`。 */
  surface?: 'panel' | 'plugin';
  run: (ctx: TaskRunCtx, p: TaskPayload) => Promise<void>;
  /** 注册完之后那一手。缺省 = `syncOwnTask`（把自己的 cron/未就绪/摘要写一遍）。 */
  after?: (store: Store) => void;
}

/** 取「常量或按 store 算」两种写法里的那个值。 */
function resolve<T>(v: T | ((store: Store) => T), store: Store): T {
  return typeof v === 'function' ? (v as (s: Store) => T)(store) : (v as T);
}

/** 建 store、并配置、注册任务、写完卡片。返回 `TaskRunCtx`（入口后面还要用它读数）。 */
export async function registerTask(spec: TaskRegistration): Promise<TaskRunCtx> {
  const store = await makeStore(spec.plugin);
  const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
  // ⚠ 必须在算预算**之前**：面板「插件配置」里那几格就是在这一步并进 state 的。
  // 用户配置在 `makeStore` 里已经统一好了（`ensureUnifiedConfig`），这里不用再做一次。
  spec.prepare?.(store);
  const budgetMs = resolve(spec.budgetMs, store);
  const leadMs = spec.leadMs === undefined ? undefined : resolve(spec.leadMs, store);
  const ctx: TaskRunCtx = {
    store,
    transport,
    budgetMs,
    notify: (taskKey, title, text, hadFailure) =>
      notify(store, transport, taskKey, title, text, hadFailure),
  };
  await defineTask(
    {
      name: spec.name,
      cron: resolve(spec.cron, store),
      budget_ms: budgetMs,
      ...(leadMs === undefined ? {} : { lead_ms: leadMs }),
      surface: spec.surface ?? 'panel',
      summary: summaryFor(store, spec.name),
      blockers: blockersFor(store, spec.name),
    },
    (p: TaskPayload) => spec.run(ctx, p),
  );
  // 注册完再写一次自己那张卡片：`defineTask` 的 opts.summary/blockers **面板不认**
  // （register_cron 只收 params/lead_ms），卡片上的字只能靠 set_job_* 写。
  if (spec.after === undefined) syncOwnTask(store, spec.name);
  else spec.after(store);
  return ctx;
}
