// 任务：消息推送奖励（`msg-push`）。
//
// # ⚠ 它**不是**插件里已有的 `notice`
//
// 两个都是"开通知给豆"，但**是两族**（域名、配方、端点全不同）：
//
// | | 这一族（`msg-push`） | 已有的 `notice` |
// |---|---|---|
// | 域 | `caiyun.feixin.10086.cn` | `m.mcloud.139.com` |
// | 路径 | `/market/msgPushOn/task/*` | `/ycloud/openemailsms-service/…` |
// | 会话配方 | `marketName=msgpushon` / `sourceId=1062` | `sign_in_3` |
//
// 「同一件事有两个入口」这件事在 mcloud 那边的配方表里就有记录
// （`msgpushon`/`1062` 是独立一页）；把两族混成一个任务，
// 表现会是"有一半时候领不到，而错误码看着像另一种原因"。
//
// # 两步，一次调用一个请求
//
// ① `GET /market/msgPushOn/task/status` —— 只读，看 `secondTaskStatus`
// ② `POST /market/msgPushOn/task/obtain`（body `{"type":2}`）—— **写**，领
//
// 判据与文案照 `mcloud-sign` 的 `tasks/msg-push.ts`：
// `secondTaskStatus === 2` 才是"可领"；`pushOn === 0` 是"通知被关了"（要用户自己去 App 开）；
// 领的成功判据是 `result.obtainCode === 0`。


import { resultObject } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_STATUS = 'mcloud.msgpush.last';
/** 上一次问到的"能不能领"。第二步只在上一次说 `yes` 时才发。 */
export const STATE_CAN = 'mcloud.msgpush.can';

/** `secondTaskStatus` 的档位。**只认 2 是可领** —— 别的值一律不动手。 */
export const SECOND_STATUS_CLAIMABLE = 2;

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

export interface MsgPushStatus {
  pushOn?: number;
  onDuaration?: number;
  firstTaskStatus?: number;
  secondTaskStatus?: number;
}

/** 解状态。字段缺就是 `undefined` —— **不猜**（猜错会白发一笔领取请求）。 */
export function parseStatus(result: unknown): MsgPushStatus {
  const o = resultObject({ code: 0, message: '', result, ok: true }) as Record<string, unknown>;
  return {
    pushOn: asInt(o.pushOn),
    onDuaration: asInt(o.onDuaration),
    firstTaskStatus: asInt(o.firstTaskStatus),
    secondTaskStatus: asInt(o.secondTaskStatus),
  };
}

/** 能不能领：**只有** `secondTaskStatus === 2` 才算。 */
export function claimable(s: MsgPushStatus): boolean {
  return s.secondTaskStatus === SECOND_STATUS_CLAIMABLE;
}

/** 通知被关掉的那个值（要用户自己去 App 开）。 */
export const PUSH_ON_OFF = 0;
/** 第一份奖励"已做完"的那个值。 */
export const FIRST_TASK_DONE = 3;

/** 判定档位 —— **逐条照 mcloud 的 `plan_msg_push`**（`crates/mcloud-tasks/src/msg_push.rs`）。
 *
 *  ⚠ 四档，不是两档。`unknown` **刻意**与 `nothing` 分开：
 *  前者是"**判不了**"（判据字段缺失 ⇒ **一个写请求都不发**），
 *  后者是"**判了，现在不该领**"。把前者说成后者是一句**没根据的肯定话**。
 *
 *  ⚠ 顺序也要照抄：**先看 `pushOn`**（关了就是 `manual` —— 那是用户侧的动作），
 *  再看 `secondTaskStatus`。 */
export type MsgPushPlan = 'obtain' | 'manual' | 'nothing' | 'unknown';

export function planMsgPush(s: MsgPushStatus): MsgPushPlan {
  if (s.pushOn !== undefined && s.pushOn === PUSH_ON_OFF) return 'manual';
  if (s.secondTaskStatus === undefined) return 'unknown';
  if (s.secondTaskStatus === SECOND_STATUS_CLAIMABLE) return 'obtain';
  return 'nothing';
}

/** 第一份奖励还在等 —— **字段缺失时回 `false`**。
 *
 *  ⚠ mcloud 的注释点了这个坑：**旧项目（TS）写的是 `!== 3`**，而 `undefined !== 3`
 *  恒真 ⇒ 缺字段时旧版会误判成"该领" ✗。照 mcloud 的口径：**缺字段就不算待领**。 */
export function firstRewardPending(s: MsgPushStatus): boolean {
  return s.firstTaskStatus !== undefined && s.firstTaskStatus !== FIRST_TASK_DONE;
}

/** 第一步：问状态（**只读**）。 */
export function runMsgPushStatus(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'msg-push',
      endpoint: 'msgPushStatus',
      method: 'GET',
      // ⚠ 这一族的 `activityid` 是 **msgpushon**，不是签到页那个 `sign_in_3`：
      // 「每个页面用自己的参数换自己的票，票与票之间逐字节不等」（见 session.rs 的配方表）
      marketName: 'msgpushon',
      isDeviceId: false,
      stateKey: STATE_STATUS,
    },
    (env) => {
      const s = parseStatus(env.result);
      const plan = planMsgPush(s);
      const can = plan === 'obtain';
      // ⚠ 三档写盘：`unknown` 不能被压成 `no`（那会让第二步与小结都说成"没得领"）
      deps.store.setState(STATE_CAN, can ? 'yes' : plan === 'unknown' ? 'unknown' : 'no', deps.nowIso);
      let note: string;
      if (plan === 'unknown') {
        note = '消息推送：判据字段缺失（没读到 secondTaskStatus）⇒ **判不了**，一个写请求都不发';
      } else if (s.pushOn === 0) {
        // 通知被关了 —— 这是**用户侧**的动作，我们去开不了，所以如实说而不是报失败
        note = '消息推送：通知已被关闭，需要你在 App 里手动打开（这一步我们做不了）';
      } else if (can) {
        note = '消息推送：有可领的奖励（下一次触发会去领）';
      } else if (s.firstTaskStatus !== undefined && s.firstTaskStatus !== 3) {
        note = '消息推送：首次奖励未领 —— 那一步要在 App 里手动完成，我们做不了';
      } else {
        note = `消息推送：暂无可领${s.onDuaration === undefined ? '' : `（已开启 ${s.onDuaration} 天）`}`;
      }
      return { ok: true, note, snapshot: env.result ?? null };
    },
  );
}

/** 第二步：真的领（**写**）。只有上一步说"能领"才发。 */
export function runMsgPushObtain(deps: TaskDeps): TaskOutcome {
  const can = deps.store.getState(STATE_CAN);
  if (can !== 'yes') {
    return {
      ok: true,
      skipped: true,
      note: `上次问到的状态是「${
        can === 'unknown' ? '判不了（判据字段缺失）' : can === 'no' ? '不该领' : can === 'yes' ? '该领' : '没问过'
      }」，不发领取请求`,
    };
  }
  const out = runTask(
    deps,
    {
      task: 'msg-push',
      endpoint: 'msgPushObtain',
      method: 'POST',
      body: JSON.stringify({ type: 2 }),
      marketName: 'msgpushon',
      isDeviceId: false,
    },
    (env) => {
      const o = resultObject(env) as Record<string, unknown>;
      const code = asInt(o.obtainCode);
      // ⚠ 判据是 `obtainCode === 0`，**不是**"HTTP 200 就算领到了"：
      // 这一族的信封里 `code` 与 `obtainCode` 是两件事，只看前者会把失败读成成功
      if (code === 0) return { ok: true, note: '消息推送奖励：已领取' };
      return {
        ok: false,
        note: `消息推送奖励：没领到（obtainCode=${code ?? '缺字段'}；服务端回 ${JSON.stringify(env.result ?? env.message).slice(0, 120)}）`,
      };
    },
  );
  // 领过就不再排队（下一次问状态会重新判断）
  if (out.ok) deps.store.setState(STATE_CAN, 'no', deps.nowIso);
  return out;
}
