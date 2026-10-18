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
 *  而**不是**"某个号自己的设置"。放进账号袋的话，A 号的任务名单会被 B 号读到。 */
export function taskAccountsKey(task: string): string {
  return `mcloud.task.accounts.${task}`;
}

export interface TaskAccounts {
  /** `true` = 全部账号（**当下**展开，不是当时的名单）。 */
  all: boolean;
  /** `all` 为假时用这一份。 */
  ids: string[];
}

export const DEFAULT_TASK_ACCOUNTS: TaskAccounts = { all: true, ids: [] };

/** 读一条任务的账号选择。没设过 ⇒ **全部**（与"新装的任务先按全部跑"一致）。 */
export function loadTaskAccounts(store: ReadableState, task: string): TaskAccounts {
  const raw = (store.getState(taskAccountsKey(task)) ?? '').trim();
  if (raw === '') return { ...DEFAULT_TASK_ACCOUNTS };
  try {
    const v = JSON.parse(raw) as { all?: unknown; ids?: unknown };
    const ids = Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === 'string') : [];
    return { all: v.all === true, ids };
  } catch {
    // 库里那段坏了（手改过 / 老版本写的）⇒ 当作"全部"，
    // **不是**当作"没有账号" —— 后者会让任务静默不跑，而用户什么都看不出来。
    return { ...DEFAULT_TASK_ACCOUNTS };
  }
}

/** 写一条任务的账号选择。 */
export function saveTaskAccounts(
  store: { setState: (k: string, v: string, nowIso: string) => void },
  task: string,
  v: TaskAccounts,
  nowIso: string,
): void {
  store.setState(taskAccountsKey(task), JSON.stringify({ all: v.all, ids: v.ids }), nowIso);
}

/** 把选择**展开成具体账号**（按账号表里的顺序，串行执行时就是那个顺序）。
 *
 *  ⚠ `all` 是在**调用时**展开的 —— 见文件头那段（"以后新加的账号也仍然成立"）。
 *  ⚠ 展开结果里**不含停用的账号**：停用就是"别拿它跑"（见 `accounts.ts` 里
 *  `disabled` 的说明）。但**选中的具体 id** 如果被停用了，也会被滤掉 ——
 *  否则"停用"这个动作对已经选好的任务不起作用。 */
export function resolveTaskAccounts(store: ReadableState, task: string): string[] {
  const sel = loadTaskAccounts(store, task);
  const all = loadAccounts(store as never);
  const enabled = all.filter((a) => a.disabled !== true);
  if (sel.all) return enabled.map((a) => a.id);
  const want = new Set(sel.ids);
  return enabled.filter((a) => want.has(a.id)).map((a) => a.id);
}

/** 界面上要显示的那一份：账号表 + 当前选择。 */
export function taskAccountsView(
  store: ReadableState,
  task: string,
): { all: boolean; picked: string[]; resolved: string[]; accounts: { id: string; label: string; disabled: boolean }[] } {
  const sel = loadTaskAccounts(store, task);
  return {
    all: sel.all,
    picked: sel.ids,
    resolved: resolveTaskAccounts(store, task),
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
