// 独立版的「日常」：账号选择、串行、结果汇总。
// 具体步骤在 src/mcloud/dailyRun.ts，和面板版共用。

import { runDaily } from '../mcloud/dailyRun.ts';
import { depsForAccount, forEachTaskAccount } from '../mcloud/accountRuntime.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { loadAccounts } from '../mcloud/accounts.ts';
import type { Runtime } from './runtime.ts';
import type { TaskSwitchId } from '../mcloud/tasks/taskSwitches.ts';

export interface DailyAccountResult {
  acctId: string;
  label: string;
  ok: boolean;
  note: string;
  detail: string[];
  steps: { name: string; ok: boolean; note: string; idle?: boolean }[];
}

/// 跑所有启用账号；account 为空 = 全部。
//
// `only` / `force` 是**调试**用的那一档（与面板「调试」页同一个 `parseTaskRunParams`）：
//   · `only`：只跑这几族（`null` = 全跑）；
//   · `force`：忽略**子任务开关**与**账号停用**这两层门（别的一概不放宽）。
export async function runDailyAll(
  rt: Runtime,
  opts: {
    account?: string;
    only?: TaskSwitchId[] | null;
    force?: boolean;
    /** 每一步的**过程**（「准备做 / 已上报 / 回读还没翻位」这些）。
     *
     *  ⚠ 不传的话 CLI 上只有最后那句结论 —— 而面板那边一直有（`app/daily/run.ts`
     *  把 `onNote` 接到了 `logBoth(store,'debug',…)`）。**两端该一致**（R3），
     *  所以这里也留同样的口子，由调用方决定打不打。
     */
    onNote?: (note: string) => void;
  } = {},
): Promise<DailyAccountResult[]> {
  const base = rt.store;
  const out: DailyAccountResult[] = [];
  const only = opts.account;
  const runOpts = {
    ...(opts.only === undefined || opts.only === null ? {} : { only: opts.only }),
    ...(opts.force === true ? { force: true } : {}),
    ...(opts.onNote === undefined ? {} : { onNote: opts.onNote }),
  };
  const runs =
    only === undefined
      ? await forEachTaskAccount(base, '日常', { lateMs: 0 }, rt.transport, async (deps) => await runDaily(deps, runOpts))
      : await (async () => {
          const hit = loadAccounts(rt.rawStore).find((a) => a.id === only || a.label === only);
          if (hit === undefined) return [];
          // ⚠ 调试点名的号**不看停用**（停用是"定时别拿它跑"，不是"调试不许碰它"）
          return [{ acctId: hit.id, result: await runDaily(depsForAccount(base, hit.id, { lateMs: 0 }, rt.transport), runOpts) }];
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
