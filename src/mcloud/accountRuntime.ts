// 账号循环与 TaskDeps 的装配 —— 不依赖 host-api，面板入口和独立入口共用。

import type { Store } from '../store/types.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';
import { resolveTaskAccounts } from './taskAccounts.ts';
import { loadBaseUrl } from './session.ts';
import { loadAuthRaw } from './sessionExchange.ts';
import { authorizeRequest } from './cloudUpload.ts';
import type { Transport } from './client.ts';
import type { TaskDeps } from './tasks/base.ts';

export function forEachTaskAccount<T>(
  base: Store,
  task: string,
  payload: { lateMs: number },
  transport: Transport,
  fn: (deps: TaskDeps, acctId: string, index: number, total: number) => T,
): { acctId: string; result: T }[] {
  // ⚠ `all` 在**这里**展开（不是存的时候）—— 以后新登录的账号也进得来。
  const targets = resolveTaskAccounts(rawStoreOf(base), task);
  const out: { acctId: string; result: T }[] = [];
  for (const [i, acctId] of targets.entries()) {
    // ⚠ **每个账号一个 store**：`scoped(base, acctId)` 让这一趟里所有按账号的
    //   读写都落到那一条的袋里。不这么做的话，循环里第二次跑的还是第一个号的
    //   状态（"拿 A 的票发 B 的请求"），而那正是 F-048/F-049 那一类。
    const one = scoped(rawStoreOf(base), acctId);
    const deps = taskDeps(one, transport, payload);
    out.push({ acctId, result: fn(deps, acctId, i, targets.length) });
  }
  return out;
}

/** 只给**一个**账号造 deps（多计划里每条计划一个账号）。 */
export function depsForAccount(
  base: Store,
  acctId: string,
  payload: { lateMs: number },
  transport: Transport,
): TaskDeps {
  return taskDeps(scoped(rawStoreOf(base), acctId), transport, payload);
}

export function taskDeps(
  store: Store,
  transport: Transport,
  payload: { lateMs: number },
): TaskDeps {
  // 云盘 / 邮箱那几族靠 `Authorization` 鉴权；构造器只给 x-yun-* 头。
  // ⚠ **按账号包一层**：transport 是四个入口共用的，注入时必须读**这个 deps 的 store**，
  //   否则多账号遍历会拿当前界面的号去发别人的请求。
  const authorized: Transport = (req) => transport(authorizeRequest(req, loadAuthRaw(store)));
  return {
    store,
    transport: authorized,
    nowIso: new Date().toISOString(),
    // 基址**每次触发时从 state 读**，不用启动时的快照 ——
    // 否则「刚把基址指到 mock，任务却还在打真上游」
    baseUrl: loadBaseUrl(store),
    lateMs: payload.lateMs,
  };
}
