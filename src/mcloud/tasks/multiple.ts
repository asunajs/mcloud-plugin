// 任务：签到翻倍（`multiple`）—— GET，但**门槛必须自己判**。
//
// 原实现写得很直白（`signin.rs:471-475`）：
//
//   > 「自动备份」每月给**一次**翻倍机会：`curMonthBackup && !curMonthBackupSignAccept`
//   > （两个值都在 `infoV3` 里）。**两个都成立才去领** —— 每月只有一次机会，
//   > 条件不成立还发是**白白消耗**。
//
// 所以这条任务的第一件事是 `infoV3`：机会没用、且确实有 → 才发 `multiple`。
// 条件不成立时**什么都不发**（不是失败，是「今天没什么可做的」）——
// 在面板里它会是绿色的，理由写在 note 里。

import { fetchInfoV3 } from './info.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_MULTIPLE = 'mcloud.multiple.last';

export function runMultiple(deps: TaskDeps): TaskOutcome {
  const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `查询状态失败：${info.error}` };

  const { curMonthBackup, curMonthBackupSignAccept } = info.info;
  if (!curMonthBackup) {
    return { ok: true, skipped: true, note: '本月没有翻倍机会（infoV3.curMonthBackup=false）' };
  }
  if (curMonthBackupSignAccept) {
    return { ok: true, skipped: true, note: '本月翻倍机会已用过（infoV3.curMonthBackupSignAccept=true）' };
  }

  return runTask(
    deps,
    {
      task: 'multiple',
      endpoint: 'multiple',
      method: 'GET',
      isDeviceId: false,
      stateKey: STATE_MULTIPLE,
    },
    (env) => ({
      ok: true,
      note: `已领取翻倍（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 100)}）`,
      snapshot: env.result ?? null,
    }),
  );
}
