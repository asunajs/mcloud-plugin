// 任务：分享文件领好礼（434）**攒满 7/7 之后的「领20豆」**。
//
// # 为什么单独一步，而不放进 appTask 那台状态机
//
// 434 有两个阶段，是同一条任务、两套完全不同的动作：
//
//   ① 攒份数（1/7 ~ 6/7）：每天分享一个文件，走 appTask 的
//      `share → shareDel → trash` 那条链（建外链再删）。
//   ② 攒满 7/7：按钮变成「领20豆」，`currstep=22`，服务端把 5豆*7 + 20豆
//      的最后那 20 豆一次性结算。
//
// 抓包 2026-11-14（`mcloud-capture/mcloud/capture/app-share-434-claim-samples.txt`）
// 实拍：点一次「领20豆」**只发一发**
//
//   GET /ycloud/signin/task/click?key=task&id=434
//   → {"code":0,"msg":"success","result":{"taskId":434,"num":20}}
//
// 这一趟**没有** `receiveV3` / `receiveTask` / `receiveTaskExpansion`，
// 也没有任何建外链/删外链 —— 所以「让 appTask 继续把 434 挑成分享待办」是错的：
// 那会对着一档已经不接受分享的状态白传文件、白发外链。
//
// ⚠ 更正先前从 H5 静态代码得到的推断：H5 里 `receiveTaskAiDou` 那一支走
//   `receiveV3`，但 434 的按钮 `action` 是 **`receiveCloud`**，走的是 `task/click`。
//   静态代码不是服务端契约。
//
// # 判据与幂等
//
// · 判据全部来自**服务端**：`currStep === 22` 或按钮文案「领N豆」（`isShareClaim`）。
//   `stepTypeSet` 里有 `checktime` ⇒ 「7 天后」是服务端按时间结算的，
//   **插件不自己算 7 天**，也不自己数 7/7。
// · 幂等：`limitType=MONTH`，一个月只有这一档；按账号记 `YYYY-MM`，
//   领过就整月不再发第二发（`task/click` **不可回滚**）。
// · 成败：只有 `code===0` 且 `result.num>0` 才算到账；`code!=0` 或缺 `num`
//   一律如实说「服务端没认」，**不记幂等**（下一趟重试）、**不伪造成功**。

import { callRawText } from '../client.ts';
import { parseSignInEnvelope, resultObject } from '../envelope.ts';
import { SHARE_TASK_ID, isShareClaim } from '../appTaskRules.ts';
import { MATRIX_MARKETS, readMatrix, runAppTaskMatrix } from './appTaskMatrix.ts';
import { clickRequest } from './appTask.ts';
import { waitMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 这个月已经领过 20 豆的月份（`YYYY-MM`）。**按账号**（不同号各攒各的）。 */
export const STATE_SHARE_CLAIM_DONE = 'mcloud.shareclaim.done';

/** `result.num` —— 服务端说的到账豆数。数字或数字串都认，其余算「没给数」。 */
export function claimedBeans(env: ReturnType<typeof parseSignInEnvelope>): number | undefined {
  const raw = resultObject(env).num;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/** 一行结果：`runDaily` 用 `once()` 调一次。** */
export function runShareClaim(deps: TaskDeps): TaskOutcome {
  // ① 幂等**先判**：本月领过就直说"领过了"——
  //    放到后面会被"任务表已经是已领取"抢先命中，说成「还没攒到领奖档」（误导）。
  const month = deps.nowIso.slice(0, 7);
  const claimedMonth = deps.store.getState(STATE_SHARE_CLAIM_DONE);
  if (claimedMonth === month) {
    return { ok: true, skipped: true, note: `这个月的 20 豆已经领过了（${month}），等下一轮` };
  }

  // ② 判据：从刚刷新的矩阵读数里找 434 的「领奖档」。
  //    两个市场可能各出现一次（`readMatrix` 的口径），只要有一处是领奖档就认。
  const claim =
    readMatrix(deps.store)
      .flatMap((r) => r?.items ?? [])
      .find((item) => isShareClaim(item)) ?? undefined;
  if (claim === undefined) {
    return { ok: true, skipped: true, note: '分享还没攒到领奖档（仍然按天攒份数）' };
  }

  // ③ 发那一发。**复用 appTask 里已经验过主机/头/签名的 clickRequest** ——
  //    同路径不同主机曾让打卡回 200 而状态一条不变（appTask.ts 文件头那个坑），
  //    这里不另起一份构造。
  const res = callRawText(deps.transport, clickRequest(deps, SHARE_TASK_ID));
  if (!res.ok) {
    return { ok: false, note: `领20豆 没发出去：${res.error ?? '未知失败'}（下一趟重试）` };
  }

  // ④ 判成败：只认信封里的 `code` 与 `result.num`。
  let env: ReturnType<typeof parseSignInEnvelope>;
  try {
    env = parseSignInEnvelope(res.text);
  } catch (e) {
    return {
      ok: false,
      note: `领20豆 的回包认不出来：${e instanceof Error ? e.message : String(e)}（原样：${res.text.slice(0, 80).replace(/\s+/g, ' ')}）`,
    };
  }
  const beans = claimedBeans(env);
  if (!env.ok || beans === undefined || beans <= 0) {
    // ⚠ 不记幂等：服务端没认，下一趟还要能再试；也不把「发出去了」说成成功。
    return {
      ok: false,
      note: `领20豆 发了，但服务端没认：code=${env.code} ${env.message || ''} result.num=${String(beans ?? '没给')}（下一趟重试）`,
    };
  }

  // ⑤ **验真**：重读任务表，只有当 434 不再是「领N豆」这一档（变成 `已领取` / FINISH）才算真到账。
  //
  //  ⚠ 为什么不能只看回包：`{"code":0,"result":{"num":20}}` 里的 `num` 只是那一发答应给的数，
  //    它**不能证明豆已经进账**（2026-11-14 现场：测试/移动两个号回包都是 num=20，
  //    而同一条任务的按钮文案在领完后才从「领20豆」变成「已领取」）。
  //    你定的规矩是"只有服务端认了才算成功、不伪造成功"，所以这里以**任务表**为准。
  //  ⚠ 两个市场各读一发（V3 一次一个市场），否则 434 在哪个市场里不一定被刷到。
  const settle = Math.min(Math.max(deps.settleMs ?? 5000, 0), 8_000);
  if (settle > 0) waitMs(deps, settle);
  for (let i = 0; i < MATRIX_MARKETS.length; i++) runAppTaskMatrix(deps);
  const after = readMatrix(deps.store)
    .flatMap((r) => r?.items ?? [])
    .find((item) => item.taskId === SHARE_TASK_ID);
  const claimed = after !== undefined && (after.state === 'FINISH' || /已领取/.test(after.buttonOutText ?? ''));
  if (!claimed) {
    return {
      ok: false,
      note:
        `领20豆 发了（HTTP ${res.status}，回包 code=0 num=${beans}），但服务端任务表还没变「已领取」` +
        `（现在是 ${after === undefined ? '读不到 434 这一行' : `${after.state ?? '?'} / ${after.buttonOutText ?? '?'}`}）` +
        '，下一趟重试',
    };
  }

  deps.store.setState(STATE_SHARE_CLAIM_DONE, month, deps.nowIso);
  return { ok: true, note: `领到 ${beans} 豆（分享文件领好礼 7/7 的尾奖，任务表已确认「已领取」，本月已记）` };
}
