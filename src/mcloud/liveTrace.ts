// 直播这条链的**追踪环**：为什么要有它，一句话 —— 它最长、最容易"没成但看不出在哪"。
//
// # 它解决什么
//
// 直播一趟要经过：查开播（门）→ 抓第三方主页 → 解析口令 → 逐条领 → 逐账号领 → 收尾。
// 任何一环不同，用户在界面上看到的都是同一句"没成"。以前的排查靠翻日志（几十行里
// 夹着三个账号的输出），而"上一次到底走到哪一步就停了"没有结构化的答案。
// 这个环就是那份答案：**每一步一条**，带时刻、成败、一句话。
//
// # 边界
//
// · 只留最近 {@link TRACE_MAX} 条：这是"上一趟的现场"，不是审计日志；
// · 一**趟**开始时清空（`traceBegin`），所以环里永远是最近那一趟；
// · 不写凭据、不写口令原文（口令只写指纹/长度，见 `maskCode`）；
// · 存 state（全局键 `mcloud.live.trace`）⇒ 面板重启之后还看得到。

import type { Store } from '../store/types.ts';

export const TRACE_KEY = 'mcloud.live.trace';
/** 一趟直播最多几步？给个上限，别让环把 state 撑大。 */
export const TRACE_MAX = 120;

export interface TraceEntry {
  /** 时刻（ISO） */
  t: string;
  /** 哪一步：gate / xhs / codes / claim / account / done … */
  step: string;
  /** 这一步成没成（没给 = 只是一条进度） */
  ok?: boolean;
  /** 一句人话（**不带凭据**） */
  note?: string;
  /** 这一步花了多久（毫秒，可选） */
  ms?: number;
}

function parse(raw: string | null | undefined): TraceEntry[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is TraceEntry => typeof x === 'object' && x !== null && typeof (x as TraceEntry).step === 'string',
    );
  } catch {
    return [];
  }
}

/** 口令只留"可对得上"的部分：前 2 个字 + 长度。 */
export function maskCode(code: string): string {
  const head = code.trim().slice(0, 2);
  return head + '…（' + String(code.trim().length) + ' 字）';
}

/** 开一趟：清空环。 */
export function traceBegin(store: Pick<Store, 'setState'>, nowIso: string): void {
  store.setState(TRACE_KEY, '[]', nowIso);
}

/** 记一步。**不抛** —— 追踪是旁路，它自己炸了不该带着任务一起炸。 */
export function traceStep(
  store: Pick<Store, 'getState' | 'setState'>,
  nowIso: string,
  step: string,
  note?: string,
  extra: { ok?: boolean; ms?: number } = {},
): void {
  try {
    const all = parse(store.getState(TRACE_KEY));
    const e: TraceEntry = { t: nowIso, step };
    if (note !== undefined && note !== '') e.note = note;
    if (extra.ok !== undefined) e.ok = extra.ok;
    if (extra.ms !== undefined) e.ms = Math.max(0, Math.round(extra.ms));
    all.push(e);
    const kept = all.length > TRACE_MAX ? all.slice(all.length - TRACE_MAX) : all;
    store.setState(TRACE_KEY, JSON.stringify(kept), nowIso);
  } catch {
    /* 旁路 */
  }
}

/** 读回来（旧的在前，和日志一致）。 */
export function readTrace(store: Pick<Store, 'getState'>): TraceEntry[] {
  return parse(store.getState(TRACE_KEY));
}
