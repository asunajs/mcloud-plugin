// 红包派对的**状态**：键、形状、读写与"给用户看的行"的账。
//
// # 为什么单独一个文件
//
// 这一族的编排要跨两个模块（整趟的状态机 + 单条任务的链条状态机），两边都要读写
// 同一份台账。形状与"哪些算凭据、什么时候抹"定在一处，就不会出现两边各存一套、
// 其中一边漏抹凭据的情况。
//
// # 哪些东西**只在本趟活**
//
// `token`（活动站给自己的那张票）与 `hwToken`（华为侧的票）都是**凭据**，落盘只为
// 了跨 drain 的几步；整趟走完（或这一趟被打断后重新起）就抹掉。
// ⚠ 参照实现把 token 常驻在 `ctx.state` 里跨轮复用，而它**没有**一条实拍说明这张票
// 的有效期 —— 我们宁可每趟重换（两发只读，代价很小），也不留一份"不知道什么时候烂"
// 的凭据在盘上。
//
// # `written` 是**按天**的，不是按趟
//
// 面板的日常一天跑两趟（08:00 / 20:00，第二趟是兜底，见 `entries/daily.ts`）。
// 参照实现一天只跑一次，所以它只需要"这一趟最多写一次"。我们要是只按趟记，
// 第二趟就会把第一趟**登记过但状态还是 0** 的那几条再登记一遍
// （真机读数里 `已登记: 打开云手机消息通知 (未完成)` 就是这种：写过了，表里还是 0）。
// ⇒ 按天记：同一个 taskCode 今天写过就不再写。

import type { Store } from '../../store/types.ts';
import type { RedpackKind } from '../redpackRules.ts';

/** 本趟进度（含按天的 `written`）。 */
export const STATE_REDPACK = 'mcloud.redpack.state';
/** 开没开（**没写过 = 开着**，与参照实现 `红包派对.开启` 的默认一致）。 */
export const STATE_REDPACK_ENABLED = 'mcloud.redpack.enabled';
/** 指到别处用的基址口子（CI / 只读探针）。空 = 真站点。 */
export const STATE_REDPACK_BASE = 'mcloud.redpack.base';

export type RedpackPhase =
  | 'login'
  | 'list'
  | 'balanceBefore'
  | 'sign'
  | 'signReward'
  | 'walk'
  | 'balanceAfter'
  | 'done';

/** 单条任务的链条走到哪一段。 */
export type RedpackStage =
  | 'begin'
  | 'complete'
  | 'waitBrowse'
  | 'browse'
  | 'phones'
  | 'rcs'
  | 'apps'
  | 'hw'
  | 'status'
  | 'installStart'
  | 'installPoll'
  | 'report'
  | 'topicList'
  | 'topicAnswer'
  | 'confirm'
  /** 「每日使用云机」的回查：它**不说**「已登记」，只说「需云机内实际使用」 */
  | 'confirmUse'
  /** 装机的回查：成了就说成了；没成还要**换下一个应用**或说「已安装应用: X」 */
  | 'confirmInstall'
  | 'reward';

/** 队列里的一条（表存的是解析过的窄形状，不是原始响应）。 */
export interface RedpackQueueItem {
  taskCode: string;
  taskName: string;
  /** 上游的 id，**原样**存（发 `userCompleteTask` 时照它的形式） */
  id: unknown;
  status?: number | undefined;
  amount?: number | undefined;
  /** 组名（`新手任务` / `每日任务` / `每月任务`）—— 换组时要能打那一行 */
  group: string;
}

/** 装机链里的一个应用（只留用得着的那几格）。 */
export interface RedpackQueueApp {
  id: unknown;
  packageId: string;
  packageName: string;
  apkName: string;
}

/** 一条任务当前这一趟的处置。 */
export interface RedpackJob {
  taskCode: string;
  taskName: string;
  /** 活动站的编号，**原样**存（`userCompleteTask` / `userInstallApp` 要 `string | number`，
   *  发之前由 `idForSend` 收窄；上游给的是数字还是字符串都照它）。 */
  id: unknown;
  /** 读表时那一条的 `userStatus`（`已登记: X (未完成)` 那一行要说它，回查后会被更新） */
  status?: number | undefined;
  amount?: number | undefined;
  kind: RedpackKind;
  stage: RedpackStage;
  /** 浏览确认前已累计的等待（参照实现是 15 秒；这里切成小口，见 `waitBrowse`） */
  sleptMs?: number | undefined;
  instanceId?: string | undefined;
  apps?: RedpackQueueApp[] | undefined;
  appIndex?: number | undefined;
  /** 装机任务的 id（`apkInstall` 回的） */
  installTaskId?: string | undefined;
  pollTries?: number | undefined;
  topicId?: unknown;
  topicQuestion?: string | undefined;
  /** 由题面查出来的答案字母（`A`–`D`）。存下来是因为「取题」和「作答」
   *  分两段：断点回来时不必重新读一遍题库。 */
  topicAnswer?: string | undefined;
  topicTries?: number | undefined;
  /** 华为侧的票（**凭据**，只在本趟用） */
  hwToken?: string | undefined;
  /** 已经装好、只上报过的那一条（`installStatus === 2`） */
  reportedExists?: boolean | undefined;
}

/** 台账：读数与计数，最后凝成一句小结。 */
export interface RedpackBoard {
  counts: { todo: number; done: number; blocked: number; unknown: number };
  writes: number;
  manual: number;
  balance?: { can?: number | undefined; total?: number | undefined } | undefined;
  balanceAfter?: { can?: number | undefined; total?: number | undefined } | undefined;
  sign?: { status?: number | undefined; amount?: number | undefined; wrote: boolean; done: boolean } | undefined;
}

export interface RedpackState {
  /** 这一份状态属于哪一天（本地日）。跨天 ⇒ 整份重开。 */
  day: string;
  startedAt: string;
  phase: RedpackPhase;
  /** 本趟的活动站票（**凭据**，`done` 时抹） */
  token?: string | undefined;
  /** 本趟的队（任务表解析过的窄形状，按组序） */
  queue: RedpackQueueItem[];
  cursor: number;
  /** 队列里已经打过的组名（换组那一行只打一次） */
  groupsShown: string[];
  job?: RedpackJob | undefined;
  /** **按天**记：今天已经发过写请求的 taskCode */
  written: string[];
  /** 给用户看的行（参照实现那些 `已完成: …` 的句子） */
  lines: string[];
  /** 已经交给日志的行数（避免下一趟重复交一遍） */
  reported: number;
  board: RedpackBoard;
}

/** 开没开（**默认开**）。 */
export function redpackEnabled(store: Pick<Store, 'getState'>): boolean {
  return (store.getState(STATE_REDPACK_ENABLED) ?? '').trim() !== '0';
}

export function setRedpackEnabled(store: Store, on: boolean, nowIso: string): void {
  store.setState(STATE_REDPACK_ENABLED, on ? '1' : '0', nowIso);
}

/** 基址口子（空 = 真站点）。照 `liveGateTask.loadGateBase` 的口径去尾斜杠。 */
export function loadRedpackBase(store: Pick<Store, 'getState'>): string | undefined {
  const v = store.getState(STATE_REDPACK_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : undefined;
}

/** 今天（**本地**日）。
 *
 *  ⚠ 不能像 `appTask.today()` 那样切 `nowIso` 的前十位：那是 UTC 日，
 *  而 UTC 的日界正好落在北京 08:00 —— 面板的日常一天跑两趟（08:00 / 20:00），
 *  按 UTC 分的话这两趟会落进两个"天"里，`written` 那道闸就形同没有
 *  （08:00 登记过的，20:00 再登记一遍）。 */
export function redpackDay(nowIso: string): string {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) return nowIso.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 起新的一趟（`written` 与 `day` 留着 —— 那是按天的账）。 */
export function newRedpackState(day: string, nowIso: string, written: string[] = []): RedpackState {
  return {
    day,
    startedAt: nowIso,
    phase: 'login',
    queue: [],
    cursor: 0,
    groupsShown: [],
    written,
    lines: [],
    reported: 0,
    board: { counts: { todo: 0, done: 0, blocked: 0, unknown: 0 }, writes: 0, manual: 0 },
  };
}

/** 读这一份状态。形状不对 / 不是今天 ⇒ `null`（当作"还没起过这一趟"）。 */
export function loadRedpackState(store: Pick<Store, 'getState'>, day: string): RedpackState | null {
  const raw = store.getState(STATE_REDPACK);
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.day !== day) return null;
  const st = v as RedpackState;
  // ⚠ 只兜住"跑不下去"的那几格：队列与账目缺了会把后面的步骤全架空，
  //   而"架空"在日志里长得像"今天没事做"—— 那是假结论，所以补齐成空值而不是 null。
  return {
    ...st,
    phase: typeof st.phase === 'string' ? st.phase : 'login',
    queue: Array.isArray(st.queue) ? st.queue : [],
    cursor: typeof st.cursor === 'number' ? st.cursor : 0,
    groupsShown: Array.isArray(st.groupsShown) ? st.groupsShown : [],
    written: Array.isArray(st.written) ? st.written : [],
    lines: Array.isArray(st.lines) ? st.lines : [],
    reported: typeof st.reported === 'number' ? st.reported : 0,
    board:
      typeof st.board === 'object' && st.board !== null
        ? { ...st.board, counts: padCounts(st.board.counts) }
        : { counts: padCounts(undefined), writes: 0, manual: 0 },
  };
}

/** 计数那一格**逐格补**（不是 `{...默认, ...给的}`）。
 *
 *  ⚠ 先用默认值再用展开会被 TS 判成"这些默认永远不生效"（TS2783），而这里恰恰
 *  要它们生效：盘上那一份可能是**旧版本**写的，少一两格是常态。 */
function padCounts(v: unknown): RedpackBoard['counts'] {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const one = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { todo: one(o.todo), done: one(o.done), blocked: one(o.blocked), unknown: one(o.unknown) };
}

export function saveRedpackState(store: Store, st: RedpackState, nowIso: string): void {
  store.setState(STATE_REDPACK, JSON.stringify(st), nowIso);
}

/** 往台账里加一行**给用户看**的话。
 *
 *  ⚠ **不去重**：参照实现在整趟的头和尾各打一次余额，两句**完全一样**的时候
 *  也照打（那两行说的是"进来时有多少 / 出去时有多少"）。去重就会少掉用户看得到的一行。 */
export function rpLine(st: RedpackState, line: string): void {
  if (line.trim() === '') return;
  st.lines.push(line);
}

/** 取"还没交给日志"的行并推进 `reported`。
 *
 *  ⚠ 这一步是**读+确认**：调用方拿到之后日志就认这批行了。 */
export function takeRedpackLines(store: Store, nowIso: string): string[] {
  const day = redpackDay(nowIso);
  const st = loadRedpackState(store, day);
  if (st === null || st.lines.length <= st.reported) return [];
  const out = st.lines.slice(st.reported);
  st.reported = st.lines.length;
  saveRedpackState(store, st, nowIso);
  return out;
}

/** 这一趟的小结（还没有台账时给 `undefined`，让调用方用自己的话）。 */
export function redpackSummary(store: Pick<Store, 'getState'>, day: string): string | undefined {
  const st = loadRedpackState(store, day);
  if (st === null) return undefined;
  return summarize(st);
}

/** 小结那一句话。
 *
 *  ⚠ 只说用户认得的东西：几条没做、几条做了、几条今天做不了、几条要他动手，
 *  外加余额。**不写**"发了几枪写请求"这种内部计数（用词规则：界面只说"你要做什么、
 *  成了没有"，见 `docs/ui-wording.md`）。 */
export function summarize(st: RedpackState): string {
  const c = st.board.counts;
  const parts = [`未完成 ${c.todo}`, `已完成 ${c.done}`];
  if (c.blocked > 0) parts.push(`暂不可做 ${c.blocked}`);
  if (c.unknown > 0) parts.push(`状态不认识 ${c.unknown}`);
  if (st.board.sign?.done === true) parts.push('每日签到好了');
  if (st.board.manual > 0) parts.push(`需手动完成 ${st.board.manual} 项`);
  const can = (st.board.balanceAfter ?? st.board.balance)?.can;
  if (can !== undefined) parts.push(`余额可用 ${String((Number(can) || 0) / 100)} 元`);
  return parts.join('、');
}

/** 这条任务今天已经写过了吗（写过就**不再写**，见文件头）。 */
export function alreadyWritten(st: RedpackState, taskCode: string): boolean {
  return st.written.includes(taskCode);
}

/** 记一笔"这条今天写过了"。`taskCode` 空的条目**不记**（也没法记）。 */
export function markWritten(st: RedpackState, taskCode: string): void {
  if (taskCode === '') return;
  if (!st.written.includes(taskCode)) st.written.push(taskCode);
}

/** 抹掉这一趟的凭据（活动站票 + 华为侧票），并把 `phase` 落成 `done`。
 *
 *  ⚠ 台账（`lines` / `board`）**留着**：小结那一句话与"这一趟看到了什么"要在
 *  `done` 之后还能读一次（`dailyRun` 就是在 drain 回来之后取行的）。 */
export function finishRedpack(st: RedpackState): void {
  delete st.token;
  delete st.job;
  st.phase = 'done';
}
