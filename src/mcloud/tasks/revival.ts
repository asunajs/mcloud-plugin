// 任务：复活卡 / 回馈卡（`revival`）—— 动作类，**不可逆**。
//
// 两件事让它与其它任务不同：
//
// ① **不可逆**：原实现的任务表给它的语义是 `skip`（不是 catch-up）——
//    错过就别补做。所以这里设了 `skipIfLaterThanMs`：比计划晚太久就不动手，
//    并如实记成「主动跳过」而不是失败。
//
// ② **"已领取"要从文案判**。原实现明确这么写（`app_signin.rs:833-838`）：
//
//      fn revival_message_already_claimed(message: &str) -> bool {
//          if !message.contains("已领取") && !message.contains("已领过") { return false; }
//          message.contains("复活卡") || message.contains("回馈卡") || message.contains("奖励")
//      }
//
//    注意它是**两个条件都要**：光有「已领取」不够，还得提到复活卡/回馈卡/奖励 ——
//    否则别的接口文案里出现「已领取」就会被误判成"这张卡用过了"。
//    这种判定当然是脆的，但它是**上游给的唯一信号**；脆而明确好过装作能结构化解析。
//
// ⚠️ 没做的那部分（不装懂）：原实现还认「没有可复活的记录」也算"没得领"，
// 那句话的原文我没在源码里确认到，所以这里**不猜**：认不出来就当失败并保留上游原话，
// 等有真实响应再补。这条已记进 README 的待办。

import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_REVIVAL = 'mcloud.revival.last';

/** 比计划晚超过这个时间就不做了（不可逆动作的安全边界）。
 *  取 2 小时：早上那波触发因故错过，中午想起来还来得及；隔夜就不碰了。 */
export const REVIVAL_SKIP_AFTER_MS = 2 * 3600_000;

/** 文案判「已经领过了」（逐字复刻原实现的两个条件）。 */
export function revivalMessageAlreadyClaimed(message: string): boolean {
  if (!message.includes('已领取') && !message.includes('已领过')) return false;
  return message.includes('复活卡') || message.includes('回馈卡') || message.includes('奖励');
}

export function runRevival(deps: TaskDeps): TaskOutcome {
  // 「已领取」是**业务上的完成**，不是失败 —— 所以不能走 runTask 的失败路径。
  // 这里直接发请求、自己判。
  return runTask(
    deps,
    {
      task: 'revival',
      endpoint: 'receiveRevivalReward',
      method: 'POST',
      body: '{}',
      stateKey: STATE_REVIVAL,
      // 不可逆：晚了太久就不做
      skipIfLaterThanMs: REVIVAL_SKIP_AFTER_MS,
      // 「已领取」是**完成**，不是失败（否则面板每天多一条红）
      okWhenError: revivalMessageAlreadyClaimed,
    },
    (env) => ({
      ok: true,
      note: `已用掉一张卡（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 100)}）`,
      snapshot: env.result ?? null,
    }),
  );
}

// 注：早先我在这里放过一个 `isAlreadyClaimedError()` 包装，但没有任何地方调用它 ——
// 那是死代码（"看着像处理了，其实没接上"）。现在直接把 `revivalMessageAlreadyClaimed`
// 交给 base 的 `okWhenError`，错误路径上真的会用到它。
