// 「一次运行」的记录 —— 三条任务共用。
//
// # 为什么插件要自己记一份（面板不是有日志吗）
//
// 面板的日志是**环形 200 行**、而且**混着所有插件**。用它来回答
// 「昨天那次兑换为什么没成」是做不到的：可能早就被别的插件的日志挤掉了。
//
// 所以「一次运行 = 一条记录」落在插件自己的库里，界面读它。
//
// # 三个决定
//
// ① **一次运行一条**，不是"一步一条"。用户问的是"这次跑成没有"，
//    而步骤是**那一条的细节**（挂在 `steps` 里），不是并列的条目。
//
// ② **留最近 N 次**，不是只留最后一次。只留最后一次的话，
//    "上次明明好的"这类问题永远查不了 —— 而下次跑完就把现场覆盖了。
//
// ③ **有上限，而且截断**。库是一张 KV 表（`state`），一条记录是一整行 JSON。
//    不设上限的话：跑得多了这行会涨到几 MB，而**每次读它都要整段解析**
//    ⇒ 界面越用越慢，最后打不开。所以：每次留 N 条、每条最多 M 步、
//    每句话截到 K 字。三个数都是**刻意的取舍**，不是随手写的。


import type { Store } from '../store/types.ts';

/** 运行记录落在这一格（一个 JSON 数组）。 */
export const RUN_LOG_KEY = 'mcloud.run.log';

/** 每个任务留最近几次。
 *
 *  20 次：日常一天一次 ⇒ 20 天；兑换/直播一天可能好几次 ⇒ 几天。
 *  够回答"上次为什么失败"，又不至于把那一行撑大。 */
export const RUNS_PER_TASK = 20;

/** 一条记录最多留多少步。
 *
 *  ⚠ 必须有上限：`drain` 的步数由**上游的待办条数**决定，
 *  上游多给几条就是几十步；而一条坏数据可能给上百步。 */
export const MAX_STEPS = 40;

/** 一句话最多留多少字。超了就截断并标出来。 */
export const MAX_NOTE = 300;

/** 三条任务的键（与 `pushConfig.TASK_KEYS` 同一套）。 */
export type RunTask = 'daily' | 'exchange' | 'live';

/** 一趟里的一步。 */
export interface RunStep {
  /** 步骤名（人话，直接显示在界面上） */
  name: string;
  ok: boolean;
  note: string;
  /** 这一步什么都没做（条件不成立）—— 界面据此显示成灰色而不是绿勾 */
  idle: boolean;
}

/** 一次运行。 */
export interface RunRecord {
  /** 标识：`<任务>-<毫秒时间戳>`。界面要能用它定位"那一次"。 */
  id: string;
  task: RunTask;
  /** 开始时刻（ISO） */
  at: string;
  /** 跑了多久（毫秒）。**用户判断"是不是卡住了"靠的就是它。** */
  ms: number;
  ok: boolean;
  /** 一行摘要 */
  note: string;
  steps: RunStep[];
  /** 步骤被截断了吗（超了 `MAX_STEPS`） */
  truncated: boolean;
}

/** 截断一句话（保留尾部 —— 失败原因通常在后面）。 */
function clip(s: unknown, max: number = MAX_NOTE): string {
  const t = typeof s === 'string' ? s : String(s ?? '');
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
}

/** 把一步规整成能存的形状。 */
function cleanStep(s: RunStep): RunStep {
  return {
    name: clip(s.name, 60),
    ok: s.ok === true,
    note: clip(s.note),
    idle: s.idle === true,
  };
}

/** 读全部记录。坏数据 ⇒ 空数组（**不让界面 500**）。 */
export function readRuns(store: Pick<Store, 'getState'>): RunRecord[] {
  const raw = store.getState(RUN_LOG_KEY);
  if (raw === undefined || raw === null || raw === '') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is RunRecord =>
        typeof r === 'object' && r !== null && typeof (r as RunRecord).id === 'string',
    );
  } catch {
    return [];
  }
}

/** 某个任务的记录，**新的在前**。 */
export function readRunsOf(store: Pick<Store, 'getState'>, task: RunTask): RunRecord[] {
  return readRuns(store)
    .filter((r) => r.task === task)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** 按 id 找一次。 */
export function readRun(
  store: Pick<Store, 'getState'>,
  id: string,
): RunRecord | null {
  return readRuns(store).find((r) => r.id === id) ?? null;
}

/** 追加一条记录，并把超出的旧记录丢掉。
 *
 *  @returns 这条记录的 id（调用方要用它做日志关联）
 */
export function appendRun(
  store: Store,
  rec: {
    task: RunTask;
    at: string;
    ms: number;
    ok: boolean;
    note: string;
    steps: RunStep[];
  },
): string {
  const steps = rec.steps.slice(0, MAX_STEPS).map(cleanStep);
  const id = `${rec.task}-${Date.parse(rec.at) || 0}`;

  const all = readRuns(store);
  const next: RunRecord = {
    id,
    task: rec.task,
    at: rec.at,
    ms: Math.max(0, Math.round(rec.ms)),
    ok: rec.ok === true,
    note: clip(rec.note),
    steps,
    truncated: rec.steps.length > MAX_STEPS,
  };

  // 同一个 id 已经在了（同一毫秒里跑了两次）⇒ 覆盖，不追加两条一样的
  const kept = all.filter((r) => r.id !== id);
  kept.push(next);

  // 每个任务各留 `RUNS_PER_TASK` 条（新的留下）
  const byTask = new Map<RunTask, RunRecord[]>();
  for (const r of kept) {
    const list = byTask.get(r.task) ?? [];
    list.push(r);
    byTask.set(r.task, list);
  }
  const trimmed: RunRecord[] = [];
  for (const list of byTask.values()) {
    list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    trimmed.push(...list.slice(0, RUNS_PER_TASK));
  }
  // 整体按时刻倒序存 —— 界面直接遍历就是"新的在前"
  trimmed.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  store.setState(RUN_LOG_KEY, JSON.stringify(trimmed), rec.at);
  return id;
}

/** 界面要的读数：某个任务的最近几次（**只给摘要，步骤按需再取**）。
 *
 *  # 为什么不把 steps 一起给
 *
 *  20 条 × 40 步 = 800 句话，全塞进一次读数里 ⇒ 首屏就是几百 KB 的 JSON，
 *  而这个界面在 iframe 里。所以列表只给**一行摘要**，
 *  用户点开某一次才取它的步骤（`readRun`）。 */
export interface RunSummary {
  id: string;
  at: string;
  ms: number;
  ok: boolean;
  note: string;
  /** 几步成功 / 几步失败 / 几步没做事 */
  okCount: number;
  badCount: number;
  idleCount: number;
  truncated: boolean;
}

export function summarize(r: RunRecord): RunSummary {
  return {
    id: r.id,
    at: r.at,
    ms: r.ms,
    ok: r.ok,
    note: r.note,
    okCount: r.steps.filter((s) => s.ok && !s.idle).length,
    badCount: r.steps.filter((s) => !s.ok).length,
    idleCount: r.steps.filter((s) => s.idle).length,
    truncated: r.truncated,
  };
}

/** 某个任务的最近几次（新的在前）。 */
export function recentRuns(
  store: Pick<Store, 'getState'>,
  task: RunTask,
  limit = 5,
): RunSummary[] {
  return readRunsOf(store, task).slice(0, limit).map(summarize);
}
