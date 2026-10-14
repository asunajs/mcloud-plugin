// 多账号：账号列表 + "当前用哪一个"。
//
// # 为什么要有这一层
//
// mcloud 是**账号列表**（一条定时带着它要跑的账号），而这个插件到现在都是**单账号**：
// 一份凭据放在 `mcloud.h5.auth` 那一格里，所有任务直接读它。
//
// ⇒ 这一层补"列表 + 当前账号"，并且保证**旧的单凭据照原样工作**：
//   `loadAuthRaw`（在 sessionExchange.ts，见那里的注释）优先取列表里的当前账号，
//   列表为空就回落到那一格。这样**任何调用点都不用知道现在是单账号还是多账号** ——
//   迁移是一格一格来的，不是一次性翻掉。
//
// ⚠ 凭据是**秘密**：这个模块只负责存取，**不许**把它写进日志/读数/界面
//   （要给界面看的一律走 `maskAuth`）。

import type { Store } from '../store/types.ts';

export const STATE_ACCOUNTS = 'mcloud.accounts';
/** 当前用哪一个（存 `id`）。没设过 = 用 `mcloud.h5.auth` 那一格（单账号那套）。 */
export const STATE_CURRENT_ACCOUNT = 'mcloud.account.current';

export type Account = {
  /** 稳定的短标识：能从凭据里认出手机号就用手机号，否则用凭据的短哈希。 */
  id: string;
  /** 给人看的名字（手机号或 `账号 N`）。 */
  label: string;
  /** 原始凭据（`Authorization` 那一串）。**不许**进日志/界面。 */
  auth: string;
  addedAt: string;
};

/** 只给界面看的一眼认得出的形状：`1****2716 · 302 字符`。 */
export function maskAuth(raw: string): string {
  const phone = phoneOf(raw);
  const len = raw.length;
  if (phone !== undefined) return `${phone.slice(0, 1)}****${phone.slice(-4)} · ${len} 字符`;
  return `（认不出手机号）· ${len} 字符`;
}

/** 从凭据里抠手机号（认不出就 `undefined`）。 */
export function phoneOf(raw: string): string | undefined {
  const m = /1\d{10}/.exec(raw);
  return m === null ? undefined : m[0];
}

/** 稳定 id：手机号优先（人能对上），否则凭据的短哈希。 */
export function idOf(raw: string): string {
  const phone = phoneOf(raw);
  if (phone !== undefined) return phone;
  // ⚠ 只用它做标识，不做安全用途：碰撞概率够低即可（真撞了也只是"列表里认错一个"）。
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `anon-${(h >>> 0).toString(36)}`;
}

export function loadAccounts(store: Pick<Store, 'getState'>): Account[] {
  const raw = store.getState(STATE_ACCOUNTS);
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ⚠ 坏数据当成"没有列表"：**不要**在这里抛 —— 抛出去会让每个任务都挂掉，
    //   而真正该发生的是"回落到单账号那格"（用户还能用）。
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Account[] = [];
  for (const it of parsed) {
    if (it === null || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.auth !== 'string' || o.auth === '') continue;
    out.push({
      id: o.id,
      label: typeof o.label === 'string' && o.label !== '' ? o.label : o.id,
      auth: o.auth,
      addedAt: typeof o.addedAt === 'string' ? o.addedAt : '',
    });
  }
  return out;
}

export function saveAccounts(store: Store, list: readonly Account[], nowIso: string): void {
  store.setState(STATE_ACCOUNTS, JSON.stringify(list), nowIso);
}

/** 加一个账号（同一个人再加一次 = **更新**那份凭据，不新增一条）。 */
export function upsertAccount(
  store: Store,
  auth: string,
  nowIso: string,
  label?: string,
): { list: Account[]; account: Account; created: boolean } {
  const list = loadAccounts(store);
  const id = idOf(auth);
  const idx = list.findIndex((a) => a.id === id);
  const account: Account = {
    id,
    label: label !== undefined && label !== '' ? label : (phoneOf(auth) ?? `账号 ${list.length + 1}`),
    auth,
    addedAt: idx >= 0 ? list[idx]!.addedAt : nowIso,
  };
  if (idx >= 0) list[idx] = account;
  else list.push(account);
  saveAccounts(store, list, nowIso);
  return { list, account, created: idx < 0 };
}

export function removeAccount(store: Store, id: string, nowIso: string): Account[] {
  const list = loadAccounts(store).filter((a) => a.id !== id);
  saveAccounts(store, list, nowIso);
  // ⚠ 删掉的正好是"当前"那一格 ⇒ 把当前也清掉，否则会留一个指向空气的 id
  if (store.getState(STATE_CURRENT_ACCOUNT) === id) store.setState(STATE_CURRENT_ACCOUNT, '', nowIso);
  return list;
}

export function selectAccount(store: Store, id: string, nowIso: string): boolean {
  if (id !== '' && !loadAccounts(store).some((a) => a.id === id)) return false;
  store.setState(STATE_CURRENT_ACCOUNT, id, nowIso);
  return true;
}

/** 当前账号（没设 / 设的 id 已不在列表里 ⇒ `undefined`）。 */
export function currentAccount(store: Pick<Store, 'getState'>): Account | undefined {
  const id = (store.getState(STATE_CURRENT_ACCOUNT) ?? '').trim();
  if (id === '') return undefined;
  return loadAccounts(store).find((a) => a.id === id);
}
