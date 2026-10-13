// 任务：任务清单（`task-list`）—— 签到族里最简单的**纯只读**一条。
//
// 端点：`POST /ycloud/signin/task/taskListV3`
// body 逐字节 `{"marketname":"sign_in_3","clientVersion":"12.6.0","group":""}`
// （`group` 是**空串**；这一条的可信度见 h5.ts 里 `taskListV3Body` 的注释）
//
// 这一条从"自己写一遍管道"改成了走 `base.ts` 的 `runTask` —— 底座只收掉管道
// （会话 → 构造 → 发送 → cookie 回写 → 落盘），**判定仍在这里**：
// 这一口的 `result` 是数组，和 `taskListV2`（以 group 为键的对象）不同，各写各的。

import { resultArray } from '../envelope.ts';
import { runTask, sessionHeaders } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { TASK_LIST_V3_CONTENT_TYPE, taskListV3Body } from '../h5.ts';

/** 插件声明的任务名（路由与 CI 用它枚举，避免到处写字符串）。
 *  新增任务时**这里也要加** —— CI 有一条断言会拿它和调度器里的实际任务对账。 */
export const TASK_NAMES = [
  'selftest',
  'diag',
  'session-check',
  'task-list',
  'sign',
  'backup-gift',
  'prizes',
  'cloud-snapshot',
] as const;

/** `state` 表里存最近一次清单的键。值形如 `{at, lateMs, value:{total,done,items}}`。 */
export const STATE_LAST_TASKLIST = 'mcloud.tasklist.last';
/** 失败原因的键前缀（由 base 统一写 `mcloud.last_error.<任务名>`）。 */
export const STATE_LAST_ERROR = 'mcloud.last_error.task-list';

function isFinished(t: unknown): boolean {
  if (typeof t !== 'object' || t === null) return false;
  const state = (t as Record<string, unknown>).state;
  return typeof state === 'string' && state.toUpperCase() === 'FINISH';
}

export function runTaskList(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'task-list',
      endpoint: 'taskListV3',
      method: 'POST',
      body: taskListV3Body(),
      contentType: TASK_LIST_V3_CONTENT_TYPE,
      isDeviceId: false,
      stateKey: STATE_LAST_TASKLIST,
    },
    (env) => {
      const list = resultArray(env);
      const done = list.filter(isFinished).length;
      return {
        ok: true,
        note: `清单 ${list.length} 条，已完成 ${done} 条`,
        snapshot: { total: list.length, done, items: list },
      };
    },
  );
}

export { sessionHeaders };
