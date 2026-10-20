// 独立版的「日常」：账号选择、串行、结果汇总。
// 具体步骤在 src/mcloud/dailyRun.ts，和面板版共用。

import { runDaily } from '../mcloud/dailyRun.ts';
import { depsForAccount, forEachTaskAccount } from '../mcloud/accountRuntime.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { loadAccounts } from '../mcloud/accounts.ts';
import type { Runtime } from './runtime.ts';

export interface DailyAccountResult {
  acctId: string;
  label: string;
  ok: boolean;
  note: string;
  detail: string[];
  steps: { name: string; ok: boolean; note: string; idle?: boolean }[];
}

/** 跑所有启用账号；account 为空 = 全部。 */
export function runDailyAll(rt: Runtime, opts: { account?: string } = {}): DailyAccountResult[] {
  const base = rt.store;
  const out: DailyAccountResult[] = [];
  const only = opts.account;
  const runs =
    only === undefined
      ? forEachTaskAccount(base, '日常', { lateMs: 0 }, rt.transport, (deps) => runDaily(deps))
      : (() => {
          const hit = loadAccounts(rt.rawStore).find((a) => a.id === only || a.label === only);
          if (hit === undefined) return [];
          return [{ acctId: hit.id, result: runDaily(depsForAccount(base, hit.id, { lateMs: 0 }, rt.transport)) }];
        })();
  for (const one of runs) {
    const r = one.result;
    out.push({
      acctId: one.acctId,
      label: labelOf(base, one.acctId),
      ok: r.ok,
      note: r.note,
      detail: r.detail,
      steps: r.steps,
    });
  }
  return out;
}
