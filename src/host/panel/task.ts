// 任务注册的**唯一**出口。
//
// # 为什么必须有这一层
//
// 面板的 `register_cron(name, cron, budget)` **只认名字**：handler 必须落在引擎预建的
// `globalThis.__handlers` 表里（`engine.rs` 的 BOOTSTRAP + `op_register_handler`）。
// 拿这个全局表当"随便写"的接口，就是「插件上下文污染」的来源 —— 四个入口各写一遍，
// 谁都能改别人的 handler。所以：**全仓只有这里碰它**。
//
// # 为什么这里要合成 payload
//
// 面板真实发的事件只有 `{task, plugin, manual, run_id, params, early, lead_ms}`。
// 业务侧读的 `scheduledAt / lateMs / runs` 面板**不发** —— 以前那个适配层给的是空串，
// 于是「兑换」在 `Date.parse('')` 那里 `return`，整条任务在新面板上**从来没跑过**。
//
// 这里的合成规则：
//   · `scheduledAt` = 现在 + （提前唤醒时）lead_ms；手动触发就是现在
//   · `leadMs`      = 事件里的 lead_ms
//   · `lateMs`      = 0（面板不发；用它做"迟到多久"的判据的代码要知道这一格不可信）
//   · `runs`        = 0（面板不发；运行次数以面板的 runs 表为准）
//   · `realigned`   = 提前唤醒那一拍（`early: true`）

import type { PanelEvent, TaskDef, TaskHandler, TaskPayload } from '../../ports/panel.ts';
import { handlersTable, panel } from './impl.ts';

/** 一次派发 = 一个 payload。导出给测试用（不必真起面板）。 */
export function payloadOf(def: TaskDef, evt: PanelEvent, nowMs: number): TaskPayload {
  const lead = typeof evt.lead_ms === 'number' ? evt.lead_ms : 0;
  const early = evt.early === true;
  const manual = evt.manual === true;
  // 提前唤醒那一拍的"计划时刻"在将来；其余就是现在。
  const scheduledMs = manual ? nowMs : nowMs + (early ? lead : 0);
  return {
    name: def.name,
    plugin: typeof evt.plugin === 'string' ? evt.plugin : '',
    expr: def.cron,
    runs: 0,
    scheduledAt: new Date(scheduledMs).toISOString(),
    firedAt: new Date(nowMs).toISOString(),
    lateMs: 0,
    jitterMs: 0,
    realigned: early,
    manual,
    params: evt.params ?? null,
    ...(lead > 0 ? { leadMs: lead } : {}),
  };
}

/** 注册一条任务。handler 可以是 async（面板会等它跑完）。
 *
 *  **返回 Promise**：`await` 之后这条任务才真的进了面板的任务表。入口在加载期
 *  `await defineTask(...)` 再给这条任务写摘要/阻塞原因 —— 不 await 的话，
 *  `setJobSummary` 会先到，面板回"没有这个任务"（启动期那 6 条 warn 就是这么来的）。 */
export function defineTask(def: TaskDef, handler: TaskHandler): Promise<void> {
  const wrapped = (evt: PanelEvent): unknown => handler(payloadOf(def, evt ?? {}, Date.now()));
  // 重名注册 = 两个模块抢同一个名字，必须当场看得见（否则后注册的静默覆盖前者）
  if (handlersTable()[def.name] !== undefined) {
    throw new Error('任务名重复：「' + def.name + '」（同一个插件里 handler 名必须唯一）');
  }
  // ⚠ 交回引擎的必须是 handler 的**返回值本身**（可能是 Promise）：
  //   吞掉它 = 面板以为这一拍已经跑完，预算 / 排队 / 日志全按「秒回」算。
  return panel.registerTask(def, wrapped as unknown as TaskHandler);
}
