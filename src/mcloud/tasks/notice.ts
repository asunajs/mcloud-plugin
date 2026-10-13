// 任务：开启通知领AI豆（`notice`）—— 查两个槽 → **能领就（下一次调用）领**。
//
// 与 `backup-gift` 同一形状的两步机（一次调用一个请求，状态落 SQLite）。
// 但这条任务有三处**必须照实说**的地方，都是去 mcloud 源码逐条核对出来的，
// 不是猜的：
//
// ① **判据字段缺任何一个都不参与判断**。
//    上游没给 `cloudStatus` / `taskStatus` 时，读数是"没说"，不是"说了没完成"。
//    把 `None` 当成 `Some(0)` 会让这条链**静默漏领** —— 所以缺字段时
//    我们**不发写请求**，并且把"上游没给全"这句话原样报出来。
//
// ② **`reward` 报不出到账数**。实拍响应是 `{"code":0,"msg":"success"}` ——
//    连 `result` 都没有。所以"到底领没领上"只能靠**回查**。本插件的做法是：
//    领完不清账，下一次触发照常从 `getTaskInfo` 开始 —— 回查就自然落在下一轮。
//
// ③ **"通知未开启"那一档今天判不出来**。实拍的两个字段读不出"通知开没开"
//    （`cloudStatus` 的 1/2 已经和"领没领"绑在一起用了，同一个字段不能同时
//    当两件事用）；旧 TS 说的 `day` / `canReceive` 两个字段**一条实拍都没有**；
//    而"未开启"态的响应**零样本**（上游很可能回非 0 码，那种形态会直接报错，
//    压根到不了判定层）。
//    ⇒ 所以 `noticeNeedsManual()` **恒回 false**，并且**就地声明**它是未被断言的分支。
//    造不出反例的分支要写出来，不能因为"没红过"就当成不重要。
//
// 手动前置是真的存在（要去移动云盘 App 里开启「邮箱通知 / 短信通知」），
// 只是**我们判不出来** —— 这一句只能由人看文档知道，别假装代码能判。

import { resultObject } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 上一次「能不能领」的判断结果：`yes` / `no` / `unknown:<原因>` */
export const STATE_CAN = 'mcloud.notice.can_claim';
/** 最近一次两槽的读数原文（截断），排障时看它 */
export const STATE_INFO = 'mcloud.notice.info';

/** 上游取值口径（来自 mcloud 源码）：
 *  * `NOTICE_CLOUD_STATUS_UNCLAIMED = 1` —— 读作"这一槽**未入账**"（**猜的**，
 *    定法需要真账号：开通知前读一次、开完再读一次）
 *  * `NOTICE_CLOUD_STATUS_CLAIMED = 2` —— 读作"已入账"（同样是猜的）
 *  * `NOTICE_TASK_STATUS_DONE = 3` —— 读作"任务本身已完成"（**实拍两槽都是 3**）
 */
export const NOTICE_CLOUD_STATUS_UNCLAIMED = 1;
export const NOTICE_CLOUD_STATUS_CLAIMED = 2;
export const NOTICE_TASK_STATUS_DONE = 3;

/** 一个槽的读数。四个字段名来自实拍：`cloudStatus` / `sum` / `progress` / `taskStatus`。
 *
 *  `sum` 与 `progress` 的**含义未经证实**（`progress` 看着像天数进度），
 *  所以这里只**原样搬运**，不在文案里给它们编意思。 */
export interface NoticeSlot {
  cloudStatus?: number;
  sum?: number;
  progress?: number;
  taskStatus?: number;
}

export interface NoticeInfo {
  one?: NoticeSlot;
  two?: NoticeSlot;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** 解一个槽。**字段缺失就是缺失**（不填默认值 —— 见文件头 ①）。 */
export function parseNoticeSlot(raw: unknown): NoticeSlot | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const slot: NoticeSlot = {
    cloudStatus: asInt(o.cloudStatus ?? o.cloud_status),
    sum: asInt(o.sum),
    progress: asInt(o.progress),
    taskStatus: asInt(o.taskStatus ?? o.task_status),
  };
  const any =
    slot.cloudStatus !== undefined ||
    slot.sum !== undefined ||
    slot.progress !== undefined ||
    slot.taskStatus !== undefined;
  return any ? slot : undefined;
}

/** 解 `result.taskOneInfo` / `taskTwoInfo`。 */
export function parseNoticeInfo(result: unknown): NoticeInfo {
  const o = resultObject({ code: 0, message: '', result, ok: true });
  return {
    one: parseNoticeSlot(o.taskOneInfo ?? o.task_one_info),
    two: parseNoticeSlot(o.taskTwoInfo ?? o.task_two_info),
  };
}

/** 这一槽"能不能判"（两个判据字段都给全了）。 */
export function slotJudged(slot: NoticeSlot | undefined): boolean {
  return !!slot && slot.cloudStatus !== undefined && slot.taskStatus !== undefined;
}

/** 这一槽"该领吗"。**两个判据字段缺任何一个都回 false**（= 不参与判断，见文件头 ①）。 */
export function slotClaimable(slot: NoticeSlot | undefined): boolean {
  if (!slotJudged(slot)) return false;
  return (
    slot!.cloudStatus === NOTICE_CLOUD_STATUS_UNCLAIMED && slot!.taskStatus === NOTICE_TASK_STATUS_DONE
  );
}

/** "得有人去 App 里开通知" —— **恒回 false，且判据未被断言**（见文件头 ③）。
 *
 *  留着这个函数是为了让"这一档存在但判不出来"这件事**在代码里可见**，
 *  而不是靠谁记得。真要做，前提是拿到两趟真账号读数（开通知前 / 开通知后）。 */
export function noticeNeedsManual(_info: NoticeInfo): boolean {
  return false;
}

export interface NoticePlan {
  /** 有没有槽该领 */
  claimable: boolean;
  /** 有没有槽的判据字段不齐（齐了才参与判断） */
  unjudged: boolean;
  /** 给人看的一句判断依据 */
  detail: string;
}

export function noticePlan(info: NoticeInfo): NoticePlan {
  const slots: [string, NoticeSlot | undefined][] = [
    ['槽一', info.one],
    ['槽二', info.two],
  ];
  const claimable = slots.filter(([, s]) => slotClaimable(s)).map(([n]) => n);
  const unjudged = slots.filter(([, s]) => s && !slotJudged(s)).map(([n]) => n);
  const missing = slots.filter(([, s]) => !s).map(([n]) => n);

  const parts: string[] = [];
  if (claimable.length) parts.push(`${claimable.join('/')}可领`);
  if (unjudged.length) parts.push(`${unjudged.join('/')}判据字段不全（不参与判断，避免静默漏领）`);
  if (missing.length) parts.push(`${missing.join('/')}上游没给`);
  if (!parts.length) parts.push('两槽都已入账或无可领');

  return {
    claimable: claimable.length > 0,
    unjudged: unjudged.length > 0,
    detail: parts.join('；'),
  };
}

/** 第一步：查两个槽（只读）。 */
export function runNoticeInfo(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'notice',
      endpoint: 'noticeInfo',
      method: 'GET',
      marketName: 'sign_in_3',
      isDeviceId: false,
      stateKey: STATE_INFO,
    },
    (env) => {
      const info = parseNoticeInfo(env.result);
      const plan = noticePlan(info);
      deps.store.setState(STATE_CAN, plan.claimable ? 'yes' : `no:${plan.detail}`, deps.nowIso);
      return {
        ok: true,
        note: plan.claimable
          ? `通知任务：${plan.detail}（下一次触发会去领）`
          : `通知任务：${plan.detail}`,
        snapshot: { one: info.one ?? null, two: info.two ?? null },
      };
    },
  );
}

/** 第二步：真的领（写）。只有上一步说"能领"才发。
 *
 *  ⚠️ 这一枪**报不出到账数**（见文件头 ②）—— 所以成功后**不清账成"已领"**，
 *  只记"发过了"，让下一次触发从 `getTaskInfo` 重新读数当回查。 */
export function runNoticeReward(deps: TaskDeps): TaskOutcome {
  const can = deps.store.getState(STATE_CAN);
  if (can !== 'yes') {
    return { ok: true, skipped: true, note: `上次问过状态是「${can ?? '没问过'}」，不发领取请求` };
  }
  const out = runTask(
    deps,
    {
      task: 'notice',
      endpoint: 'noticeReward',
      method: 'GET',
      marketName: 'sign_in_3',
      isDeviceId: false,
    },
    (env) => ({
      ok: true,
      // 上游不报到账数 —— 这句必须说，否则下一个人会以为这里能看到领了多少
      note: `通知任务：已发领取请求（上游不报到账数，下一次触发回查 ${JSON.stringify(
        env.message ?? 'success',
      ).slice(0, 40)}）`,
    }),
  );
  if (out.ok) deps.store.setState(STATE_CAN, 'no:sent', deps.nowIso);
  return out;
}

/** 一步推进：上次说能领就去领，否则先查。 */
export function runNotice(deps: TaskDeps): TaskOutcome {
  const can = deps.store.getState(STATE_CAN);
  if (can === 'yes') return runNoticeReward(deps);
  return runNoticeInfo(deps);
}
