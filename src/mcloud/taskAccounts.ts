// 一条任务"跑哪些账号"。
//
// # 为什么这件事归**任务**，不归账号管理
//
// 用户口径（照参考实现 `web/src/ui/account-picker.tsx` 记下来的原话）：
//
//   「任何（包括直播小红花）应该允许配置多账号/全部，点击运行后后端保证串行执行」
//
// 所以账号页上那个「切到这个」是错的 —— **切账号不是账号管理**。
// 账号页管的是"有哪些账号"（登录、改昵称、刷新、停用、移除）；
// "这一趟用哪些号跑"是**任务**的属性，它挂在任务自己的界面上。
//
// # 「全部」是独立开关，不是"把每一项都勾上"
//
// 参考实现特意写了这一条，理由很实：
//
//   「后端空数组的语义是"**我名下的全部账号**"，账号以后增加了也仍然成立
//    （勾每一项就锁死了当时的名单）。」
//
// 所以存的是 `{ all: true }` 而不是当时那份 id 列表 —— 展开时**当下**去读账号表。
// 存名单的话，以后新登录的账号永远进不来，而界面上看起来"全选"是勾着的。

import { loadAccounts } from './accounts.ts';
import type { ReadableState } from '../store/keys-types.ts';

/** 三条**排期任务**的名字 —— 就是调度器里 `register_cron` 注册的那三个。
 *
 *  ⚠ 别和 `tasks/taskList.ts` 的 `TASK_NAMES` 混了：那是**内部步骤**的名字
 *    （`sign` / `receive` / …），不是任务名。混用过的后果很具体：
 *    `/task/accounts` 拿 `TASK_NAMES` 校验，于是**每次保存账号选择都 400**
 *    （「不认识的任务：日常」），而界面上看起来只是"点了一下没反应"。 */
export const SCHEDULED_TASKS = ['日常', '兑换', '直播'] as const;

/** 一条任务选的账号。**按任务**存（键里带任务名），与账号袋无关。
 *
 *  ⚠ 这个键是 `global` 作用域：它说的是"日常这条任务用哪些号"，
 *  而**不是**"某个号自己的设置"。放进账号袋的话，A 号的任务名单会被 B 号读到。
 *
 *  # 自动 / 本次必须分开
 *
 *  旧版本只有一个 `mcloud.task.accounts.日常`：界面勾一下就写它，手动跑和定时
 *  读的是同一份。用户为了手动跑小号勾小号 ⇒ 第二天的定时也只跑小号。
 *  所以现在每个任务两份：`.<task>.auto` 给定时，`.<task>.manual` 只给手动；
 *  manual 缺省 `{follow:true}`（跟随自动），且**绝不回写 auto**。 */
export type TaskAccountMode = 'auto' | 'manual';

/** 旧版本的单一键。只用于迁移/兼容读，**不要**再写它。 */
export function legacyTaskAccountsKey(task: string): string {
  return `mcloud.task.accounts.${task}`;
}

/** 按任务 + 模式取键。 */
export function taskAccountsKey(task: string, mode: TaskAccountMode = 'auto'): string {
  return `mcloud.task.accounts.${task}.${mode}`;
}

export interface TaskAccounts {
  /** `true` = 全部账号（**当下**展开，不是当时的名单）。 */
  all: boolean;
  /** `all` 为假时用这一份。 */
  ids: string[];
}

/** 手动选择多一格：跟随自动。 */
export interface TaskManualAccounts extends TaskAccounts {
  follow: boolean;
}

export const DEFAULT_TASK_ACCOUNTS: TaskAccounts = { all: true, ids: [] };
export const DEFAULT_TASK_MANUAL_ACCOUNTS: TaskManualAccounts = {
  follow: true,
  all: false,
  ids: [],
};

/** 按任务给默认值。
 *
 * 日常/直播是“随时跑都安全”的环境型任务 ⇒ 默认全部账号，用户加完号就能用；
 * 兑换会真花 AI豆 ⇒ 默认**一个都不选**，必须用户在兑换页里显式挑账号。
 * 这条差异是刻意的：默认值也是一种“授权”，花钱的任务不能替用户授权。 */
export const DEFAULT_TASK_ACCOUNTS_BY_TASK: Record<string, TaskAccounts> = {
  兑换: { all: false, ids: [] },
};

export function defaultTaskAccounts(task: string): TaskAccounts {
  const v = DEFAULT_TASK_ACCOUNTS_BY_TASK[task];
  return v ? { ...v } : { ...DEFAULT_TASK_ACCOUNTS };
}

function parseSelection(raw: string): TaskAccounts | null {
  try {
    const v = JSON.parse(raw) as { all?: unknown; ids?: unknown };
    const ids = Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === 'string') : [];
    return { all: v.all === true, ids };
  } catch {
    return null;
  }
}

/** 读**自动**选择：新键优先；没有就读旧键（迁移），再没有才取任务默认。 */
export function loadTaskAccounts(store: ReadableState, task: string): TaskAccounts {
  const raw = (store.getState(taskAccountsKey(task, 'auto')) ?? '').trim();
  if (raw !== '') {
    const v = parseSelection(raw);
    return v ?? defaultTaskAccounts(task);
  }
  const legacy = (store.getState(legacyTaskAccountsKey(task)) ?? '').trim();
  if (legacy !== '') {
    const v = parseSelection(legacy);
    if (v !== null) return v;
  }
  return defaultTaskAccounts(task);
}

/** 读**本次**选择；缺省/坏值 ⇒ 跟随自动（不是"没账号"）。 */
export function loadManualTaskAccounts(store: ReadableState, task: string): TaskManualAccounts {
  const raw = (store.getState(taskAccountsKey(task, 'manual')) ?? '').trim();
  if (raw === '') return { ...DEFAULT_TASK_MANUAL_ACCOUNTS };
  try {
    const v = JSON.parse(raw) as { follow?: unknown; all?: unknown; ids?: unknown };
    if (v.follow === true) return { ...DEFAULT_TASK_MANUAL_ACCOUNTS };
    const ids = Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === 'string') : [];
    return { follow: false, all: v.all === true, ids };
  } catch {
    return { ...DEFAULT_TASK_MANUAL_ACCOUNTS };
  }
}

/** 写选择。`mode` 默认 auto，旧调用点不受影响。 */
export function saveTaskAccounts(
  store: { setState: (k: string, v: string, nowIso: string) => void },
  task: string,
  v: TaskAccounts | TaskManualAccounts,
  nowIso: string,
  mode: TaskAccountMode = 'auto',
): void {
  if (mode === 'manual') {
    const follow = (v as TaskManualAccounts).follow === true;
    const body = follow
      ? { follow: true }
      : { follow: false, all: v.all, ids: v.ids };
    store.setState(taskAccountsKey(task, 'manual'), JSON.stringify(body), nowIso);
    return;
  }
  store.setState(
    taskAccountsKey(task, 'auto'),
    JSON.stringify({ all: v.all, ids: v.ids }),
    nowIso,
  );
}

/** 实际生效的选择：手动 `follow` ⇒ 回落到自动。 */
export function effectiveTaskAccounts(
  store: ReadableState,
  task: string,
  mode: TaskAccountMode = 'auto',
): TaskAccounts {
  if (mode !== 'manual') return loadTaskAccounts(store, task);
  const m = loadManualTaskAccounts(store, task);
  return m.follow ? loadTaskAccounts(store, task) : { all: m.all, ids: m.ids };
}

function expand(store: ReadableState, sel: TaskAccounts): string[] {
  const all = loadAccounts(store as never);
  const enabled = all.filter((a) => a.disabled !== true);
  if (sel.all) return enabled.map((a) => a.id);
  const want = new Set(sel.ids);
  return enabled.filter((a) => want.has(a.id)).map((a) => a.id);
}

/** 把选择**展开成具体账号**（按账号表里的顺序，串行执行时就是那个顺序）。
 *
 *  ⚠ `all` 是在**调用时**展开的 —— 见文件头那段（"以后新加的账号也仍然成立"）。
 *  ⚠ 展开结果里**不含停用的账号**：停用就是"别拿它跑"（见 `accounts.ts` 里
 *  `disabled` 的说明）。但**选中的具体 id** 如果被停用了，也会被滤掉 ——
 *  否则"停用"这个动作对已经选好的任务不起作用。 */
export function resolveTaskAccounts(
  store: ReadableState,
  task: string,
  mode: TaskAccountMode = 'auto',
): string[] {
  return expand(store, effectiveTaskAccounts(store, task, mode));
}

/** 界面上要显示的那一份：账号表 + 自动/本次两份选择。 */
export function taskAccountsView(store: ReadableState, task: string): {
  auto: TaskAccounts;
  manual: TaskManualAccounts;
  /** auto 是从旧版单一键继承来的（界面要标一下，别让用户以为手动选择还在生效）。 */
  legacyAuto: boolean;
  resolvedAuto: string[];
  resolvedManual: string[];
  /** 兼容旧界面字段（自动那份）。 */
  all: boolean;
  picked: string[];
  resolved: string[];
  accounts: { id: string; label: string; disabled: boolean }[];
} {
  const auto = loadTaskAccounts(store, task);
  const manual = loadManualTaskAccounts(store, task);
  const resolvedAuto = expand(store, auto);
  const legacyAuto =
    (store.getState(taskAccountsKey(task, 'auto')) ?? '').trim() === '' &&
    (store.getState(legacyTaskAccountsKey(task)) ?? '').trim() !== '';
  return {
    auto,
    manual,
    legacyAuto,
    resolvedAuto,
    resolvedManual: expand(store, effectiveTaskAccounts(store, task, 'manual')),
    all: auto.all,
    picked: auto.ids,
    resolved: resolvedAuto,
    accounts: loadAccounts(store as never).map((a) => ({
      id: a.id,
      label: a.label,
      disabled: a.disabled === true,
    })),
  };
}

/** 界面上/日志里怎么称呼这个账号。找不到就回 id —— **不编一个名字**。 */
export function labelOf(store: ReadableState, acctId: string): string {
  const a = loadAccounts(store as never).find((x) => x.id === acctId);
  return a?.label || a?.id || acctId;
}

/** 日志前缀用的短名：昵称原样；纯 11 位手机号只留前 3 后 4。
 *  已经是 `138****8000` 这种形状的不再二次处理。 */
export function shortLabel(label: string): string {
  if (/^1\d{10}$/.test(label)) return `${label.slice(0, 3)}****${label.slice(-4)}`;
  return label;
}
