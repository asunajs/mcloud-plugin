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
/** 最后一份读数（给界面/调试页）。 */
export const STATE_PLAYAI_READING = 'mcloud.playai.reading';

export type PlayAiPhase = 'list' | 'register' | 'act' | 'verify' | 'done';

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
