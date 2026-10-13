// 任务：备份好礼（`backup-gift`）—— **两步步骤机**，是这套架构的第一个真实用例。
//
// 两个端点都在**另一个域**（`caiyun.feixin.10086.cn`），而且那一页的 `activityid`
// 是 `backupgift`（不是签到页的 `sign_in_3`）—— 见 `session.rs` 的配方表。
//
// # 为什么是两步，而不是"一次调用里连着发两个请求"
//
// ① 面板的单次执行预算是 2000ms，而且**打断不了阻塞中的请求** —— 一次调用里发两个
//    请求，就多一倍撞预算的机会，撞上就是"上游动作已发生、任务却报失败"。
// ② 更重要的是**安全**：`receive` 是**写**（任务清单文档特意标了「GET 却是写」）。
//    先 `info` 拿到"能不能领"，再决定要不要领 —— 这个门必须由**上游的回答**把着，
//    不能由"我们觉得应该能领"把着。
//
// 于是：一次调用只做一步，状态落 SQLite。今天先问、明天再领（或下一次触发再领）——
// 慢一轮，但每一步都能被单独观察和复现。
//
// ⚠️ 有一个必须守住的细节：**`info` 说不能领时，下一次不要再去领**。
// `receive` 的响应告诉我们上一次领没领成；没成的话，状态里保留原文，等 `info` 再变。

import { resultObject } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_INFO = 'mcloud.backupgift.info';
/** 上一次「能不能领」的判断结果，格式 `yes|no|<原文>` */
export const STATE_CAN = 'mcloud.backupgift.can_receive';

/** 判断 `info` 的响应里"能不能领"。
 *
 *  响应形状来自 mock 夹具与实拍：`{canReceive: bool}`。上游键名可能变，
 *  所以多认几个常见的写法；**认不出来就当作"不能领"**（宁可不领，不要抢跑）。 */
export function parseCanReceive(result: unknown): { can: boolean; raw: unknown } {
  const o = resultObject({ code: 0, message: '', result, ok: true });
  const v = o.canReceive ?? o.can_receive ?? o.receivable ?? o.status;
  if (typeof v === 'boolean') return { can: v, raw: v };
  if (typeof v === 'number') return { can: v === 1, raw: v };
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'can') return { can: true, raw: v };
    return { can: false, raw: v };
  }
  return { can: false, raw: result ?? null };
}

/** 第一步：问状态（只读）。 */
export function runBackupGiftInfo(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'backup-gift',
      endpoint: 'backupGiftInfo',
      method: 'GET',
      marketName: 'backupgift',
      isDeviceId: false,
      stateKey: STATE_INFO,
    },
    (env) => {
      const { can, raw } = parseCanReceive(env.result);
      deps.store.setState(STATE_CAN, can ? 'yes' : `no:${JSON.stringify(raw)?.slice(0, 80)}`, deps.nowIso);
      return {
        ok: true,
        note: can ? '备份好礼：可以领取（下一次触发会去领）' : '备份好礼：当前没有可领的',
        snapshot: env.result ?? null,
      };
    },
  );
}

/** 第二步：真的领（写）。只有上一步说"能领"才发。 */
export function runBackupGiftReceive(deps: TaskDeps): TaskOutcome {
  const can = deps.store.getState(STATE_CAN);
  if (can !== 'yes') {
    return {
      ok: true,
      skipped: true,
      note: `上次问过状态是「${can ?? '没问过'}」，不发领取请求`,
    };
  }
  const out = runTask(
    deps,
    {
      task: 'backup-gift',
      endpoint: 'backupGiftReceive',
      method: 'GET',
      marketName: 'backupgift',
      isDeviceId: false,
    },
    (env) => ({
      ok: true,
      note: `备份好礼已领取（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 120)}）`,
    }),
  );
  // 领过就不再排队（下一次 `info` 会重新判断）
  if (out.ok) deps.store.setState(STATE_CAN, 'no:claimed', deps.nowIso);
  return out;
}

/** 一步推进：先问状态，能领就（下一次调用）领。
 *
 *  调度上只挂这一个入口 —— 面板的执行预算决定了「一次调用一个请求」，
 *  所以这里每次只做一件，靠状态推进。 */
export function runBackupGift(deps: TaskDeps): TaskOutcome {
  const can = deps.store.getState(STATE_CAN);
  if (can === 'yes') return runBackupGiftReceive(deps);
  return runBackupGiftInfo(deps);
}
