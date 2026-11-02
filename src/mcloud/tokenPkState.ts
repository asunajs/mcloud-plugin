// 算力大作战的**状态层**：键、形状、读写、逐行账、开关。全部按账号（走 `scoped()`）。
//
// # 为什么必须落库
//
// 整趟要发十几到几十发请求（一条任务：click → 动作 3~6 枪 → 复查 → 领奖），
// 而面板一次调用只有 2 秒预算 ⇒ 状态机必须可恢复。形状与「哪些格子是凭据」定在一处，
// 就不会出现"某一段漏存/漏清"。
//
// # 凭据
//
// 本模块**不存** jwttoken（用会话里那份）。但动作链里有两个例外：
//   · 云笔记的 `app_auth` 头（`noteAuth` 那一枪换来的）；
//   · 邮箱 AI 链的 `sid/rmkey` 与派生出来的 `Authorization`。
// 它们与 App 任务那边同源、同样只活在本机 SQLite 的状态格里，动作收尾即抹
// （`clearAttempt`），不进日志、不进读数接口。

import type { Store } from '../store/types.ts';

/** 整趟的状态（含逐行账）。 */
export const STATE_TOKENPK = 'mcloud.tokenpk.state';
/** 开关：**没写过 = 开着**（参照实现 `DefaultEnabled: true`）。 */
export const STATE_TOKENPK_ENABLED = 'mcloud.tokenpk.enabled';
/** 上传那台状态机的槽位（`tasks/upload.ts` 按 key 分槽）。 */
export const STATE_TOKENPK_UPLOAD = 'mcloud.tokenpk.upload';
/** 代抽的配置（`{enabled,max}`）。**没写过 = 不抽**（花用户的次数，必须显式开）。 */
export const STATE_TOKENPK_DRAW = 'mcloud.tokenpk.draw';
/** 代抽的**按天账**（`{day,drawn,wins}`）—— 上限按天算，第二趟同一天不重置。 */
export const STATE_TOKENPK_DRAW_DAY = 'mcloud.tokenpk.draw.state';

export type PkPhase = 'list' | 'act' | 'verify' | 'claim' | 'chance' | 'draw' | 'progress' | 'done';
export type PkKind = 'run' | 'claim' | 'reserve';

/** 计划里的一条（只留调度要用的格子 —— 任务表的原始对象不落库）。 */
export interface PkQueued {
  taskId: number;
  name: string;
  key: string;
  kind: PkKind;
  /** 上一步已经登记过（任务表里 `currstep>=1`）⇒ 不再发 `click` */
  skipClick: boolean;
}

/** 当前这一条任务的子状态机。 */
export interface PkAttempt {
  taskId: number;
  name: string;
  key: string;
  /** `click` / `upload` / `snapshot-create` / `note-auth` / `ai-mail-sso` … */
  step: string;
  /** 跨步要带的东西（都是短字符串；凭据类在收尾时整格清掉） */
  data?: Record<string, string> | undefined;
  /** 这一条**不用再登记**（上一步已经点过；`currstep>=1`） */
  skipClick?: boolean | undefined;
}

export interface PkState {
  /** UTC 日期（与日常其它族同一口径） */
  day: string;
  phase: PkPhase;
  queue: PkQueued[];
  /** 已做过的动作条数（汇总句「执行任务N项」） */
  executed: number;
  /** 已领的奖品条数（汇总句「领取奖励N项」） */
  claimedCount: number;
  /** 这一趟已经确认 FINISH 的 taskId */
  finished: number[];
  /** 已尝试领过的 taskId（防同趟重复领） */
  claimedIds: number[];
  /** 动作做完、等服务端确认的 taskId（「N项待服务端确认或跨月完成」） */
  pending: number[];
  /** 这一趟动过的 taskId（复查时逐条看它翻没翻） */
  touched: number[];
  /** 待领奖的 taskId（计划时就有 + 复查新翻出来的） */
  toClaim: number[];
  /** taskId → 名字（给用户的行要用；不落原始任务对象） */
  names: Record<string, string>;
  manual: string[];
  failed: { id: number; name: string; why: string }[];
  attempt?: PkAttempt | undefined;
  chanceReward: number;
  usedToken?: number | undefined;
  /** 给用户看的逐行（`takeLines` 一次取走并清空） */
  lines: string[];
  /** 复查过了没（避免 `verify` 在同一趟里跑两遍） */
  verified?: boolean | undefined;
}

/** 当天的日期键（UTC；与 `dailyRun` 的 `today` 同口径）。 */
export function tokenPkDay(nowIso: string): string {
  return nowIso.slice(0, 10);
}

function parse<T>(raw: string | null | undefined): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadTokenPk(store: Pick<Store, 'getState'>): PkState | null {
  const v = parse<PkState>(store.getState(STATE_TOKENPK));
  if (v === null || typeof v.day !== 'string' || typeof v.phase !== 'string') return null;
  return v;
}

export function saveTokenPk(store: Store, st: PkState, nowIso: string): void {
  store.setState(STATE_TOKENPK, JSON.stringify(st), nowIso);
}

/** 新的一趟（不带上一趟的任何格 —— 计划重新从 `task/list` 出）。 */
export function newTokenPk(day: string): PkState {
  return {
    day,
    phase: 'list',
    queue: [],
    executed: 0,
    claimedCount: 0,
    finished: [],
    claimedIds: [],
    pending: [],
    touched: [],
    toClaim: [],
    names: {},
    manual: [],
    failed: [],
    chanceReward: 0,
    lines: [],
  };
}

/** 接着今天那一份走；没有 / 跨天 / 上一趟已经 `done` ⇒ 另起一份。 */
export function beginLeg(store: Store, nowIso: string): PkState {
  const day = tokenPkDay(nowIso);
  const prev = loadTokenPk(store);
  if (prev === null || prev.day !== day || prev.phase === 'done') {
    const fresh = newTokenPk(day);
    saveTokenPk(store, fresh, nowIso);
    return fresh;
  }
  return prev;
}

/** 记一行给用户看的话（**一行一个用户认得的条目**）。 */
export function pkLine(st: PkState, line: string): void {
  st.lines.push(line);
}

/** 取走这一趟的逐行并清空（`dailyRun` 用它组 `DailyStep.lines`）。 */
export function takeTokenPkLines(store: Store, nowIso: string): string[] {
  const st = loadTokenPk(store);
  if (st === null || st.lines.length === 0) return [];
  const lines = [...st.lines];
  saveTokenPk(store, { ...st, lines: [] }, nowIso);
  return lines;
}

/** 开没开。**没写过 = 开着**（参照实现的默认值就是 true）。 */
export function tokenPkEnabled(store: Pick<Store, 'getState'>): boolean {
  const v = store.getState(STATE_TOKENPK_ENABLED);
  // ⚠ `getState` 在"没写过"时回的是 **null**（不是 undefined）—— e2e 抓到的：
  //   写成 `v === undefined` 时，新号读到的 null 落到下面 ⇒ `false` ⇒ 「这一族没开」。
  if (v === null || v === undefined || v === '') return true;
  return v === 'true' || v === '1';
}

export function setTokenPkEnabled(store: Store, on: boolean, nowIso: string): void {
  store.setState(STATE_TOKENPK_ENABLED, on ? 'true' : 'false', nowIso);
}

// ── 代抽（`lottery`）──────────────────────────────────────────────────

export interface PkDrawConfig {
  enabled: boolean;
  /** 每天最多抽几次；0 = 不抽。 */
  max: number;
}

/** 开了但没写上限时的默认值：10 次（通常一天也就一两次机会，等于"抽完为止"）。 */
export const DEFAULT_DRAW_MAX = 10;

/** 代抽配置。**缺省关闭** —— 这一族其它格都是"缺省开"，唯独花次数这件事不是。 */
export function tokenPkDraw(store: Pick<Store, 'getState'>): PkDrawConfig {
  const raw = parse<Partial<PkDrawConfig>>(store.getState(STATE_TOKENPK_DRAW));
  if (raw === null) return { enabled: false, max: DEFAULT_DRAW_MAX };
  const max =
    typeof raw.max === 'number' && Number.isFinite(raw.max) && raw.max >= 0
      ? Math.floor(raw.max)
      : DEFAULT_DRAW_MAX;
  return { enabled: raw.enabled === true, max };
}

export function setTokenPkDraw(store: Store, cfg: PkDrawConfig, nowIso: string): void {
  const max = Number.isFinite(cfg.max) && cfg.max >= 0 ? Math.floor(cfg.max) : DEFAULT_DRAW_MAX;
  store.setState(STATE_TOKENPK_DRAW, JSON.stringify({ enabled: cfg.enabled, max }), nowIso);
}

/** 某一天已经抽了几次、中了什么。跨天/没写过 ⇒ 全新一份。 */
export interface PkDrawDay {
  day: string;
  drawn: number;
  wins: string[];
  /** 今天还剩几次（`queryRemainChance` 读一次、之后按每次抽奖的回执更新）。
   *  `undefined` = 还没读过 ⇒ 代抽前先读一次，别拿"上限"去撞"0 次机会"。 */
  remaining?: number | undefined;
}

export function loadDrawDay(store: Pick<Store, 'getState'>, day: string): PkDrawDay {
  const v = parse<PkDrawDay>(store.getState(STATE_TOKENPK_DRAW_DAY));
  if (v === null || v.day !== day) return { day, drawn: 0, wins: [] };
  return {
    day,
    drawn: typeof v.drawn === 'number' && v.drawn >= 0 ? Math.floor(v.drawn) : 0,
    wins: Array.isArray(v.wins) ? v.wins.filter((x): x is string => typeof x === 'string') : [],
    ...(typeof v.remaining === 'number' && v.remaining >= 0 ? { remaining: Math.floor(v.remaining) } : {}),
  };
}

export function saveDrawDay(store: Store, d: PkDrawDay, nowIso: string): void {
  store.setState(STATE_TOKENPK_DRAW_DAY, JSON.stringify(d), nowIso);
}

/** 抹掉当前这一条动作的中间态（动作收尾 / 失败都要调一次 —— 里面可能有凭据）。 */
export function clearAttempt(st: PkState): void {
  st.attempt = undefined;
}
