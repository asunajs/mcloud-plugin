// 趣玩AI赢好礼（`National_playAI`）的**状态层**：键、形状、读写、逐行账。全部按账号。
//
// # 这一版只做"读"
//
// 第①步只发三发只读请求（`page/getmodule` / `timed/getmodule` / `page/prizes`），
// 把读数落下来。写口（`page/register` / `page/lottery`）在下一轮接 —— 见 `playAi.ts` 文件头。
//
// # 为什么读数与台账分开
//
// `reading` 是**给界面看的最后一份读数**（覆盖写）；
// `state` 是**这一趟的进度**（一次 drain 里跨步活着：读了什么、下一步做什么）。
// 两者混在一起就会"读到一半被界面刷新覆盖掉"。

import type { Store } from '../store/types.ts';
import type { PlayAiModule, PlayAiReading } from './playAi.ts';

/** 这一趟的进度（可恢复：面板一次调用只有 2 秒预算）。 */
export const STATE_PLAYAI = 'mcloud.playai.state';
/** 代抽开关：`'1'` / `'0'`。**没写过 = 关**（花的是用户的次数，必须显式开）。 */
export const STATE_PLAYAI_DRAW = 'mcloud.playai.draw';
/** 今天的抽奖账（`{day, drawn, wins}`）—— 上限按天算，同一天再跑也不重置。 */
export const STATE_PLAYAI_DRAW_DAY = 'mcloud.playai.draw.state';

/** 代抽开没开。缺省**开**。
 *
 *  ⚠ 2026-11-27 改的：原来是缺省关（"花次数的事必须用户点头"），但用户口径很明确 ——
 *    「获取到次数就抽」「要实现为用户可自动化那样」。所以**默认就抽**，
 *    只有显式设成 `'0'` 才不抽。
 *
 *  仍然保留这一格：有人就是不想让插件动他的抽奖次数，关掉要能关。
 */
export function playAiDrawEnabled(store: Pick<Store, 'getState'>): boolean {
  const v = store.getState(STATE_PLAYAI_DRAW);
  if (v === undefined || v === null || v === '') return true;
  return v === '1';
}

export function setPlayAiDrawEnabled(store: Store, on: boolean, nowIso: string): void {
  store.setState(STATE_PLAYAI_DRAW, on ? '1' : '0', nowIso);
}

export interface PlayAiDrawDay {
  day: string;
  drawn: number;
  wins: number;
}

export function loadDrawDay(store: Pick<Store, 'getState'>, day: string): PlayAiDrawDay {
  const raw = store.getState(STATE_PLAYAI_DRAW_DAY) ?? '';
  if (raw.trim() !== '') {
    try {
      const v = JSON.parse(raw) as PlayAiDrawDay;
      if (v.day === day && typeof v.drawn === 'number') return v;
    } catch {
      // 坏格当新的一天
    }
  }
  return { day, drawn: 0, wins: 0 };
}

export function saveDrawDay(store: Store, v: PlayAiDrawDay, nowIso: string): void {
  store.setState(STATE_PLAYAI_DRAW_DAY, JSON.stringify(v), nowIso);
}

/** 最后一份读数（给界面/调试页）。 */
export const STATE_PLAYAI_READING = 'mcloud.playai.reading';

export type PlayAiPhase = 'list' | 'register' | 'act' | 'verify' | 'draw' | 'done';

/** 这一趟挑中的那件任务。 */
export interface PlayAiTarget {
  moduleId: string;
  taskId: string;
  /** 短名（上游给的是整句营销词，见 `playAi.shortTaskName`） */
  name: string;
  /** 走哪个动作（`aiAssistant` …）；空串 = 这一件我们不会做，只登记不动作 */
  actionKey: string;
}

export interface PlayAiState {
  /** UTC 日期（与其它族同一口径） */
  day: string;
  phase: PlayAiPhase;
  /** 页面模块与主题模块（原样留 —— 做任务要用 `(moduleId, taskId)` 这对） */
  modules: PlayAiModule[];
  /** 逐行账（给 `DailyStep.lines`）：一族一条、人话 */
  lines: string[];
  /** 这一趟读到的范围（`全部 / 只读`）—— 写进读数，排查时知道"这份读数是怎么来的" */
  at: string;
  /** 这一趟挑中的任务（`register` / `act` / `verify` 三段共用） */
  target?: PlayAiTarget | undefined;
  /** **今天已经点过**的 `(moduleId|taskId)` → 时间。
   *
   *  ⚠ 为什么要记：`register` 的回执零信息，而"点过但没做成"再点一次也不会变
   *    （服务端按任务去重，规则成文"相同任务只能获得 1 次"）⇒ 一天点一次就够，
   *    别每趟都拿同一件任务去撞。 */
  tried?: Record<string, string> | undefined;
  /** 动作层正在走的那一段（`tokenPkActions.PkAttempt` 的形状）。 */
  attempt?: unknown;
  /** 这一趟已经抽了几次。上限 `PLAYAI_DRAWS_PER_RUN`（=5，与上游每日次数一致）。
   *
   *  ⚠ 用户口径：「获取到次数就抽」。所以抽完不直接收工，还有次数就回 `draw` 再来一次。 */
  drawnThisRun?: number | undefined;
  /** 这一趟已经回读了几次（见 `verify` 那段的"再读一次"）。 */
  verifyTries?: number | undefined;
  /** 动作那一步**成了没有**。没成的话不必等那 3 秒 —— 服务端不会因为等一会儿就翻位。 */
  actOk?: boolean | undefined;
  /** 这一趟已经做完了**几件**（回读翻位的）。
   *
   *  为什么要记：一趟现在会连做几件（`PLAYAI_TASKS_PER_RUN`），而每件之间要
   *  `verify → list` 回到挑任务那一步。不记的话分不清"这一趟做了 3 件"和
   *  "绕回 list 又挑了同一件"——后者会无限转（`tried` 只能防"点过的"，
   *  防不住"回读没翻位但也没记进 tried"那条路）。
   *  它与 `tried` 不是一回事：`tried` 是"点过"，这个是"**做成了**"。 */
  doneCount?: number | undefined;
  /** 这一趟做成的任务名（给逐行账用，一件一行）。 */
  doneNames?: string[] | undefined;
}

export function loadPlayAi(store: Pick<Store, 'getState'>): PlayAiState | null {
  const raw = store.getState(STATE_PLAYAI) ?? '';
  if (raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as PlayAiState;
    if (typeof v.day !== 'string' || typeof v.phase !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}

export function savePlayAi(store: Store, st: PlayAiState, nowIso: string): void {
  store.setState(STATE_PLAYAI, JSON.stringify(st), nowIso);
}

export function newPlayAi(day: string, at: string): PlayAiState {
  return { day, phase: 'list', modules: [], lines: [], at };
}

/** 取走这一趟的逐行并清空（`dailyRun` 用它组 `DailyStep.lines`）。 */
export function takePlayAiLines(store: Store, nowIso: string): string[] {
  const st = loadPlayAi(store);
  if (st === null || st.lines.length === 0) return [];
  const lines = [...st.lines];
  savePlayAi(store, { ...st, lines: [] }, nowIso);
  return lines;
}

// ── 读数 ────────────────────────────────────────────────────────────

export interface PlayAiSnapshot {
  at: string;
  ok: boolean;
  /** 送给界面的那一行（`3 个模块 · 18 件任务 · 2 件可做 …`） */
  line: string;
  reading: PlayAiReading | null;
  /** 读失败时的原因（成功时是空串） */
  error: string;
}

export function loadPlayAiSnapshot(store: Pick<Store, 'getState'>): PlayAiSnapshot | null {
  const raw = store.getState(STATE_PLAYAI_READING) ?? '';
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as PlayAiSnapshot;
  } catch {
    return null;
  }
}

export function savePlayAiSnapshot(store: Store, snap: PlayAiSnapshot, nowIso: string): void {
  store.setState(STATE_PLAYAI_READING, JSON.stringify(snap), nowIso);
}
