// 面板端口：注册（任务/路由/侧栏）、任务状态、插件配置、版本。
//
// 只有 `src/host/panel/*` 实现它；业务层不 import 这个文件里的"实现"，只 import 类型。

/** 面板交给 handler 的事件（**面板真实发的**就这几个字段）。
 *
 * ⚠ 面板不发 scheduledAt / lateMs / runs —— 这几个由 `defineTask` 合成，见
 * `src/host/panel/task.ts` 的说明。 */
export interface PanelEvent {
  task?: string;
  plugin?: string;
  manual?: boolean;
  run_id?: number;
  params?: unknown;
  early?: boolean;
  lead_ms?: number;
}

/** 任务 handler 拿到的 payload（业务侧读的就是这个）。 */
export interface TaskPayload {
  name: string;
  plugin: string;
  expr: string;
  runs: number;
  scheduledAt: string;
  firedAt: string;
  lateMs: number;
  jitterMs: number;
  realigned: boolean;
  manual?: boolean;
  leadMs?: number;
  params?: unknown;
}

export type TaskHandler = (p: TaskPayload) => void | Promise<void>;

export interface TaskDef {
  name: string;
  cron: string;
  /** 单次执行预算（毫秒）。面板上限 90 分钟，越界**报错**。 */
  budget_ms: number;
  /** 注册期交给面板、每次触发原样交回 */
  params?: unknown;
  /** 提前唤醒量（毫秒，≤1 小时） */
  lead_ms?: number;
  /** `panel`（任务列表里显示）/ `plugin`（插件页面里管理） */
  surface?: 'panel' | 'plugin';
  summary?: string;
  blockers?: string[];
}

export interface PanelHost {
  /** 注册一条任务。**返回 Promise**：面板那边的登记是异步的（消息通道），
   *  `await` 它之后这条任务才真的在面板的任务表里 —— 紧接着调 `setJobSummary` 才不会
   *  撞上"没有这个任务"（启动期那 6 条 warn 就是这么来的）。 */
  registerTask(def: TaskDef, handler: TaskHandler): Promise<void>;
  registerRoute(path: string, method: string, handler: (req: RouterRequest) => unknown, budgetMs?: number): void;
  sidebar(opts: { title?: string; order?: number }): void;
  selfConfig(): Promise<Record<string, unknown>>;
  setJobSummary(name: string, text: string): void;
  setJobBlockers(name: string, list: string[]): void;
  setJobPaused(name: string, paused: boolean): void;
  setJobSchedule(name: string, opts: { expr?: string; lead_ms?: number }): void;
  version(): string;
  atLeast(v: string): boolean;
  /** 数据目录（`plugin-data/<name>`）；单文件插件也有 */
  pluginDataDir(): Promise<string>;
  /** 插件自己的目录（目录式插件才有；单文件是 null） */
  pluginDir(): Promise<string | null>;
}

export interface RouterRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

export interface RouterResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

// ── 访问器 ────────────────────────────────────────────────────────────
//
// 业务层偶尔要说"把这个任务的卡片摘要改一下"（taskReadiness / 路由），
// 而它不能静态 import host（单测里没有 panel:host 这个模块）。
// 所以在组合根装一次，业务层用 panelAccess() 拿；没装时返回 null（单测就是这一档）。

/** 面板回"没有这个任务 / 插件未加载"⇒ 那个插件还没装（按需加载）。
 *
 *  ⚠ 这不是故障，是**顺序**：`mcloud`（服务插件）改账号时，另外三个任务插件
 *  常常正处"用到才装"的状态，写它们的任务状态必然失败；它们各自加载时
 *  （`syncOwnTask`）会补一次。所以这类失败按 debug 记 —— 打成 warn 的话
 *  每次启动 6 条，把真问题淹掉。（面板 `hostapi.rs::job_target` 其实**支持**
 *  跨插件写，只是要求对方已经加载。见 docs/findings.md F-143。） */
export function isNotLoadedYet(msg: string): boolean {
  return msg.includes('没有这个任务') || msg.includes('插件未加载');
}

let installed: PanelHost | null = null;

/** 装/卸宿主。传 `null` = 卸掉（单测收尾用，免得串到下一条用例）。 */
export function installPanel(p: PanelHost | null): void {
  installed = p;
}

export function panelAccess(): PanelHost | null {
  return installed;
}
