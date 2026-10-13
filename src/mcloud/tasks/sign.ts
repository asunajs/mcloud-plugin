// 任务：每日签到（`sign`）—— 动作类，**幂等**。
//
// 端点：`GET /ycloud/signin/page/startSignIn?client=app[&deviceId=…]`
// （`h5(is_device_id, get(url), "true")` —— 有没有设备号决定发不发 `isdeviceid`）
//
// # 为什么现在只做"一步"，以及为什么这是安全的
//
// 原实现的完整流程是**两步**：先 `infoV3` 看今天签没签（状态在响应里，
// 不是在 code 里 —— `signin.rs:212` 的 "今日已签到，余额 {}" 是从状态判的），
// 只有没签才 `startSignIn`。这里目前只发 `startSignIn`，理由是原实现自己写下的：
//
//   > 签到是**无害且幂等**的动作（重复签到只会回"今日已签到"）
//
// 也就是说重复发不会造成任何后果，最坏是上游回一句"已签"。两步判断（省掉那次多余请求）
// 留到拿到**真实响应**之后再做 —— 猜 `infoV3` 的响应形状来写判断，是在没证据的情况下
// 写分支，那种分支在真机上通常就是错的。
//
// ⚠️ 已知的粗糙处（不装懂）：这里把「上游回了非 0」（例如"今日已签到"）一律记成
// `ok=false`。它其实不是失败 —— 到了有真实响应的那天，应该按上游的 code 分流成
// 「已完成」而不是「失败」，否则面板里每天都会多一条红色。这条已记进 README 的待办。

import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';

export const STATE_SIGN = 'mcloud.sign.last';

export function runSign(deps: TaskDeps): TaskOutcome {
  // 设备号就在**会话**里（导入时一起给的），不要另造一个 state 键存它 ——
  // 第一版我写的 `mcloud.session.device_hint` 是凭空发明的，于是"有设备号也不发 deviceId"，
  // 被测试当场抓到。
  const deviceId = loadSession(deps.store)?.deviceId;
  return runTask(
    deps,
    {
      task: 'sign',
      endpoint: 'startSignIn',
      method: 'GET',
      query: deviceId ? `client=app&deviceId=${encodeURIComponent(deviceId)}` : 'client=app',
      // 原实现：有设备号才发 isdeviceid
      isDeviceId: !!deviceId,
      stateKey: STATE_SIGN,
      // 签到是 catch-up（晚了也补做）：上游幂等，不设跳过阈值
    },
    (env) => ({
      ok: true,
      note: `签到已送达（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 120)}）`,
      snapshot: { result: env.result ?? null, message: env.message },
    }),
  );
}
