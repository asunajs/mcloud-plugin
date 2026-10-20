// 独立版的兑换：直接复用任务层 runExchange，不经过面板计划/调度。

import { loadAccounts } from '../mcloud/accounts.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { runExchange } from '../mcloud/tasks/exchangeRun.ts';
import { runExchangeList } from '../mcloud/tasks/exchangeList.ts';
import type { Runtime } from './runtime.ts';

function pickAccounts(rt: Runtime, who?: string | number): { id: string; label: string }[] {
  const enabled = loadAccounts(rt.rawStore).filter((a) => a.disabled !== true);
  if (who === undefined) return enabled;
  if (typeof who === 'number') {
    const a = enabled[who];
    return a === undefined ? [] : [{ id: a.id, label: a.label }];
  }
  return enabled
    .filter((a) => a.id === who || a.label === who)
    .map((a) => ({ id: a.id, label: a.label }));
}

function exchangeOne(
  rt: Runtime,
  prize: string | number,
  who?: string | number,
  offset = 10,
  skipWait = false,
): boolean {
  const picked = pickAccounts(rt, who);
  if (picked.length === 0) {
    console.log('[兑换] 没有匹配的启用账号');
    return false;
  }
  let allOk = true;
  for (const acct of picked) {
    const deps = rt.depsFor(acct.id);
    const r = runExchange(deps, {
      target: String(prize),
      // 旧版 offset 是“整点前多少秒”，任务层自己会算窗口；这里只把它作为
      // 等待上限的提示，不改变下单时刻。
      maxWaitMs: skipWait ? 0 : Math.max(60_000, offset * 1000),
    });
    console.log(`[${acct.label}] 兑换：${r.note}`);
    for (const line of r.detail) console.log(`[${acct.label}] ${line}`);
    if (!r.ok) allOk = false;
  }
  return allOk;
}

/** 兼容旧签名；返回 void。 */
export async function exchange(
  prizeIdOrName: string | number | Array<[string | number, string | number]>,
  accountOrOffset?: string | number,
  offset = 10,
  skipWait = false,
  configPath?: string,
): Promise<void> {
  const { createRuntime } = await import('./runtime.ts');
  const rt = await createRuntime({ configPath });
  try {
    if (Array.isArray(prizeIdOrName)) {
      for (const [prize, account] of prizeIdOrName) {
        exchangeOne(rt, prize, account, offset, skipWait);
      }
    } else {
      exchangeOne(rt, prizeIdOrName, accountOrOffset, offset, skipWait);
    }
  } finally {
    rt.close();
  }
}

/** 打印兑换清单（只读，不需要登录）。 */
export async function printExchangeList(configPath?: string): Promise<void> {
  const { createRuntime } = await import('./runtime.ts');
  const rt = await createRuntime({ configPath });
  try {
    const acct = loadAccounts(rt.rawStore).find((a) => a.disabled !== true);
    if (acct === undefined) {
      console.log('暂无可兑换的奖品');
      return;
    }
    const deps = rt.depsFor(acct.id);
    const r = runExchangeList(deps);
    console.log(r.note);
  } finally {
    rt.close();
  }
}

export { labelOf };
