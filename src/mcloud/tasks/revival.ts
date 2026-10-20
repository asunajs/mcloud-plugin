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
/** 这个月已经领过复活卡的月份（`YYYY-MM`）—— 之后整月不再发请求。 */
export const STATE_REVIVAL_DONE = 'mcloud.revival.done';

/** 比计划晚超过这个时间就不做了（不可逆动作的安全边界）。
 *  取 2 小时：早上那波触发因故错过，中午想起来还来得及；隔夜就不碰了。 */
export const REVIVAL_SKIP_AFTER_MS = 2 * 3600_000;

/** 文案判「已经领过了」（逐字复刻原实现的两个条件）。 */
export function revivalMessageAlreadyClaimed(message: string): boolean {
  if (!message.includes('已领取') && !message.includes('已领过')) return false;
  return message.includes('复活卡') || message.includes('回馈卡') || message.includes('奖励');
}

/** 文案判「没有可复活的记录」（原文：`2025年无云朵记录`）。
 *
 *  这不是失败：复活卡复活的是**上一年失效的 AI豆**，这个号上一年没有云朵 ⇒ 没东西可复活。
 *  Rust mcloud 对它的处置是 `TaskOutcome::skipped`（不报红、不触发 onlyError）。 */
export function revivalMessageNothingToRevive(message: string): boolean {
  return message.includes('无云朵记录');
}

export function runRevival(deps: TaskDeps): TaskOutcome {
  const month = deps.nowIso.slice(0, 7);
  if (deps.store.getState(STATE_REVIVAL_DONE) === month) {
    return { ok: true, skipped: true, note: '这个月的复活卡已经处理过了' };
  }

  // 「已领取」是**业务上的完成**，不是失败 —— 所以不能走 runTask 的失败路径。
  // 这里直接发请求、自己判。
  const out = runTask(
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
      note: `已用掉一张卡（服务端回 ${JSON.stringify(env.result ?? env.message).slice(0, 100)}）`,
      snapshot: env.result ?? null,
    }),
  );
  // 「上一年没有云朵记录」是**没得领**，不是故障：改成 skipped，别画成红。
  // 但**本月记下**：这个月不必每趟都问一次；下个月自动失效、会再试。
  if (!out.ok && revivalMessageNothingToRevive(out.note)) {
    const why = out.note.replace(/^.*?服务端说：/, '');
    // 这不是故障：把 runTask 落下的失败标记擦掉，否则状态页/推送还会当红的。
    deps.store.setState('mcloud.last_error.revival', '', deps.nowIso);
    deps.store.setState(STATE_REVIVAL_DONE, month, deps.nowIso);
    return {
      ok: true,
      skipped: true,
      note: `没有可复活的记录${why === out.note ? '' : `（服务端说：${why}）`}`,
    };
  }
  // 真领到了、或服务端说本月已领取 ⇒ 这个月不用再发。
  // ⚠ 「晚太久主动跳过」不能记成已完成（那会把本月机会白白吞掉）。
  if (out.ok && out.skipped !== true) {
    deps.store.setState(STATE_REVIVAL_DONE, month, deps.nowIso);
  }
  return out;
}

// 注：早先我在这里放过一个 `isAlreadyClaimedError()` 包装，但没有任何地方调用它 ——
// 那是死代码（"看着像处理了，其实没接上"）。现在直接把 `revivalMessageAlreadyClaimed`
// 交给 base 的 `okWhenError`，错误路径上真的会用到它。
