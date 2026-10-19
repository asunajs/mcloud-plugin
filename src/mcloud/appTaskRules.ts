// `app-task` 的**判据层**（纯函数，零 IO）。
//
// # 为什么单独一层
//
// mcloud 的原话：「『这一条要不要传、传几个』全部落在 `upload_shape_for` 这个纯函数里，
// 于是它能**在没有网络的情况下被钉住**」。这一层照搬这个设计 —— 判据能测，
// 动作（一枪一枪的 IO）在别处。
//
// # `app-task` 是什么
//
// App 任务矩阵的**写**那一半：「把矩阵里能做的做掉」。每一发 `task/click` 都在告诉上游
// "这条我做完了"，**不可回滚**；而且某些玩法**顺带往用户网盘传文件**（名字门/按钮门）。
//
// ⚠ 与只读那一半**不是同一个 code**（只读的叫 `app-task-matrix`）——
//   拿一个 code 做两件事会让它在两处指不同的东西。
//
// 依据是 **Rust 版 `mcloud`**（不是 `mcloud-sign` 那份 TS —— 它很多已过期）：
// `crates/mcloud-tasks/src/app_task.rs` 的 `upload_shape_for` / `step_for`，
// 以及 `crates/mcloud-tasks/src/app_task/runners.rs` 的专用执行器。

/** 往网盘传文件的那一档：传几轮、在哪停、每轮间隔、扩展名、渠道。 */
export interface UploadShape {
  rounds: number;
  stopAtProcess: number;
  perRoundMs: number;
  /** ⚠ `true` 时 `process` 是"剩余量"（要补齐到 `stopAtProcess`）；
   *  `false` 时它是"闸"（循环里不变）。这两个语义**别混**。 */
  topUpFromProcess: boolean;
  fileExt: string;
  channel: 'android' | 'pc';
}

/** 106「上传一个文件」——只传一发，不看 `process`。 */
export const UPLOAD_ONE: UploadShape = {
  rounds: 1,
  stopAtProcess: 0,
  topUpFromProcess: false,
  perRoundMs: 0,
  fileExt: '.bin',
  channel: 'android',
};

/** beiyong1 的按钮门那一族 ——传十发。 */
export const UPLOAD_TEN: UploadShape = {
  rounds: 10,
  stopAtProcess: 10,
  topUpFromProcess: true,
  perRoundMs: 300,
  fileExt: '.jpg',
  channel: 'android',
};

/** 113「使用PC客户端」——形状与 106 同档，**差别只在渠道头**。 */
export const UPLOAD_ONE_PC: UploadShape = {
  rounds: 1,
  stopAtProcess: 0,
  topUpFromProcess: false,
  perRoundMs: 0,
  fileExt: '.bin',
  channel: 'pc',
};

/** 522 那一档每次运行的轮数。 */
export const ROUNDS_PER_RUN = 5;
/** 522 的闸位。 */
export const STOP_AT_PROCESS = 100;
/** 113（PC 客户端）的任务 id。 */
export const PC_UPLOAD_TASK_ID = 113;
/** 106（上传一个文件）。 */
export const UPLOAD_TASK_ID = 106;
/** 522（传 N 发）。 */
export const GATE_UPLOAD_TASK_ID = 522;

/** 分享文件（434）——它有一串自己的步骤，不是"点一下就完"。 */
export const SHARE_TASK_ID = 434;
export const SPECIAL_CLICK_STEP = 22;

/** ⚠ **不做**的任务 id。这一串是"看着能点、点了没用或会坏事"的那些。 */
export const SKIP_TASK_LIST: readonly number[] = [
  117, 437, 991, 406, 385, 480, 1022, 1018, 603, 1021, 120,
];

/** 需要先去"入口"页面的任务 id（不先进那个页面，`task/click` 会不认）。 */
export const PORTAL_ENTRY_TASK_IDS: readonly number[] = [1017, 604];

/** 只要点一下就行、没有别的步骤的任务 id。 */
export const CLICK_ONLY_TASK_IDS: readonly number[] = [
  115, 431, 435, 1009, 1010, 1013, 1016, 447, 547,
];

/** 月度闸门所在的 marketName 与 groupId。 */
export const MONTH_GATE_MARKET = 'sign_in_3';
export const MONTH_GATE_GROUP = 'month';
/** 20 号前、本月备份没开 ⇒ 不做 app 的月任务（Rust mcloud 的 month_gate_skips）。 */
export const MONTH_GATE_DAY_LIMIT = 20;

/** 月门：只在**确认**本月备份没开（`false`）且日期 < 20 时跳过；
 *  `undefined`（没读到）不跳 —— 把“不知道”当成“没开”会白跳一次。 */
export function monthGateSkips(
  item: { groupId?: string | undefined; marketName?: string | undefined },
  monthBackup: boolean | undefined,
  day: number | undefined,
): boolean {
  if (day === undefined || monthBackup !== false) return false;
  return item.groupId === MONTH_GATE_GROUP && item.marketName === MONTH_GATE_MARKET && day < MONTH_GATE_DAY_LIMIT;
}

/** beiyong1 的**名字门**：名字里有"上传"且有"图"或"照"。 */
export function beiyong1NameGate(name: string): boolean {
  return name.includes('上传') && (name.includes('图') || name.includes('照'));
}

/** beiyong1 的**按钮门**：按钮链接里有 `uploadView`。 */
export function beiyong1ButtonGate(link: string | undefined | null): boolean {
  return typeof link === 'string' && link.includes('uploadView');
}

/** 判据要的那几个字段（从矩阵读回来的条目上取）。 */
export interface AppTaskItem {
  taskId?: number | undefined;
  groupId?: string | undefined;
  name?: string | undefined;
  buttonAppLink?: string | undefined;
}

/** 这一条要不要传、按哪一档传。判不了（不传）⇒ `undefined`。
 *
 * ⚠ 顺序**是判据的一部分**：`beiyong1` 那一组先看**名字门**，名字门没中才看按钮门。
 *  反过来的话，615「记录国庆节欢乐瞬间」（名字里既没有"上传"也没有"图/照"）会被
 *  名字门判成"不传"，而它其实该走按钮门传十发。 */
export function uploadShapeFor(item: AppTaskItem): UploadShape | undefined {
  if (item.taskId === PC_UPLOAD_TASK_ID) return UPLOAD_ONE_PC;
  if (item.taskId === UPLOAD_TASK_ID) return UPLOAD_ONE;
  if (item.taskId === GATE_UPLOAD_TASK_ID) {
    return {
      rounds: ROUNDS_PER_RUN,
      stopAtProcess: STOP_AT_PROCESS,
      // ⚠ 522 是"闸"不是"剩余量"：那个 `process` 在循环里不会变
      topUpFromProcess: false,
      perRoundMs: 500,
      fileExt: '.bin',
      channel: 'android',
    };
  }
  if (item.groupId === 'beiyong1') {
    // ① 名字门
    if (typeof item.name === 'string' && beiyong1NameGate(item.name)) return UPLOAD_ONE;
    // ② 按钮门（名字门没中才看它 —— 旧 TS 的顺序）
    if (beiyong1ButtonGate(item.buttonAppLink)) return UPLOAD_TEN;
  }
  return undefined;
}

/** 这一条在"不做"名单里。 */
export function shouldSkip(taskId: number | undefined): boolean {
  return taskId !== undefined && SKIP_TASK_LIST.includes(taskId);
}

/** 这一条只要点一下。 */
export function isClickOnly(taskId: number | undefined): boolean {
  return taskId !== undefined && CLICK_ONLY_TASK_IDS.includes(taskId);
}

/** 这一条要先过"入口"页面。 */
export function needsPortalEntry(taskId: number | undefined): boolean {
  return taskId !== undefined && PORTAL_ENTRY_TASK_IDS.includes(taskId);
}

/** 这一条是分享（有自己的步骤链）。 */
export function isShare(taskId: number | undefined): boolean {
  return taskId === SHARE_TASK_ID;
}

// ───────────────────────── 这一条走哪一步（mcloud 的步骤表） ─────────────────────────

/** 这一条要走的动作。`undefined` = **mcloud 里没实现** ⇒ 本插件也**不动它**。
 *
 *  # ⚠ 为什么必须有这张表（用户点出来的错）
 *
 *  我第一版是"**不在黑名单就打**" —— 那是**重写**，不是迁移。
 *  真机后果：点了 `time` 组的 548/549/550 与 `month` 的 607，四枪全回 **HTTP 200**，
 *  而**状态一条都不变**（还是 `WAIT`）——
 *  因为它们在 mcloud 的账本里**全是"未实现"**（`docs/app-task-status.md` §2）。
 *
 *  mcloud 的口径是**逐条实拍**：只有真知道"这条要做什么动作"的才动手，
 *  其余一律不动（`⚠ 谁拿它做什么必须逐条看`）。凭空点一下不但没用，
 *  还会按"状态没变 ⇒ 失败"的判据**报出一堆假失败**。
 *
 *  ⚠ 与 `SKIP_TASK_LIST` 是两件事：那一串是"**刻意不打**"（打了有副作用或无意义），
 *  这一层是"**还不知道怎么打**"。两者都不打，但**理由不同** —— 报出来的话也要不同。 */
/** 专用执行器（与 mcloud 的 `AppRunner` 对齐）。目前先接 1020；
 *  107/472/473/1004/1014/1028/585/609 在 mcloud 里也有实现，后续按同一形状补。 */
export type AppRunner =
  | 'mailBackup'
  | 'aiAssistant'
  | 'aiWorkbench'
  | 'aiCamera'
  | 'note'
  | 'mailActive'
  | 'sendMail'
  | 'pdfConvert'
  | 'billView';

export type TaskStep =
  | { kind: 'upload'; shape: UploadShape }
  | { kind: 'clickOnly' }
  /** 409 / 1005：固定入口两发上报 + 专用 key 补打卡。 */
  | { kind: 'entry' }
  /** 1017 / 604：入口页（`button.email.link` / `button.app.link`）+ 打卡。 */
  | { kind: 'portal' }
  /** 434：分享本趟传上去的第一个文件，再删外链。 */
  | { kind: 'share' }
  /** 专用执行器（1020 邮件转存 …）。 */
  | { kind: 'runner'; runner: AppRunner };

/** mcloud 里**已实现**的那些（`docs/app-task-status.md` §0）：
 *  106、113、409、434、522、547、604、609、615 —— 加上判定门 118。
 *
 *  ⚠ 这里只列**本插件已经搬好的**步骤。像 434（分享）、609（AI 对话）这类
 *  需要额外链路（建外链 / AI 鉴权 + SSE）的，**还没搬 ⇒ 现在也不该点**
 *  （点了同样不变状态）。 */
export function stepFor(item: AppTaskItem): TaskStep | undefined {
  if (shouldSkip(item.taskId)) return undefined;
  // 409 / 1005：固定入口（两发上报 + 补打卡）。
  if (item.taskId === 409 || item.taskId === 1005) return { kind: 'entry' };
  // 1017 / 604：入口页。
  if (needsPortalEntry(item.taskId)) return { kind: 'portal' };
  // 434：分享文件。
  if (isShare(item.taskId)) return { kind: 'share' };
  // 1020：邮件转存。
  if (item.taskId === 1020) return { kind: 'runner', runner: 'mailBackup' };
  // 609：和 AI 助手对话（mcloud 真机验过：打卡不够，必须真对话）。
  if (item.taskId === 609) return { kind: 'runner', runner: 'aiAssistant' };
  // 1028 / 1057：AI 工作台（mcloud 的 AppRunner::AiWorkbench）。
  if (item.taskId === 1028 || item.taskId === 1057) return { kind: 'runner', runner: 'aiWorkbench' };
  // 585 / 618：AI 相机（mcloud 的 AppRunner::AiCamera）。
  if (item.taskId === 585 || item.taskId === 618) return { kind: 'runner', runner: 'aiCamera' };
  // 107：创建云笔记。
  if (item.taskId === 107) return { kind: 'runner', runner: 'note' };
  // 472 / 473：体验 139 邮箱。
  if (item.taskId === 472 || item.taskId === 473) return { kind: 'runner', runner: 'mailActive' };
  // 1004：给好友发邮件。
  if (item.taskId === 1004) return { kind: 'runner', runner: 'sendMail' };
  // 1014：PDF 转换。
  if (item.taskId === 1014) return { kind: 'runner', runner: 'pdfConvert' };
  // 1029：查看“我的账单”。
  if (item.taskId === 1029) return { kind: 'runner', runner: 'billView' };
  const shape = uploadShapeFor(item);
  if (shape) return { kind: 'upload', shape };
  if (isClickOnly(item.taskId)) return { kind: 'clickOnly' };
  return undefined;
}

/** 这一条 mcloud 里**没实现**（本插件也不动它）—— 报出来用。 */
export function isUnimplemented(taskId: number | undefined): boolean {
  if (taskId === undefined) return true;
  // 刻意不做的（SKIP_TASK_LIST）不是“没实现”，是“不做”。
  if (shouldSkip(taskId)) return false;
  // ⚠ 必须走 `stepFor`：上传族（106/113/522）以前会被这句误报成“没实现”。
  return stepFor({ taskId }) === undefined;
}
