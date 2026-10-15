// 任务：每日签到（`sign`）—— 动作类、**幂等**、**判据必须回查**。
//
// # 三段式（一次调用只走一段，状态落盘）
//
//   ① 问状态：`infoV3` → `todaySignIn` 已经是 true → 收工（今天签过了）
//   ② 动手：`startSignIn`（GET + `?client=app[&deviceId=]`）→ 记下"待回查"
//   ③ 回查：再问 `infoV3` → **这才是成败判据**
//
// 为什么非要③：原实现里写着（`signin.rs:167-170`）——
//
//   > ⚠ 判据是 `infoV3`，不是 `startSignIn` 的响应 …… 它说没签，
//   > 但紧接着 `infoV3` 已经是 `s:true` 了。**判成败一律回查 `infoV3`。**
//
// 也就是说动作响应会**撒谎**（说的是提交那一刻的状态，不是最终状态）。
// 拿它当判据就会每天误报一次失败。
//
// # 为什么调度要密（而不是"每天 8:05 打一枪"）
//
// 三段式需要三次调用。挂在"每天一次"的 cron 上，就要三天才签完一次 ✗。
// 所以这条任务挂在**白天每 15 分钟**：每次只发一个请求（便宜），
// 状态说不需要动作时就只是一次只读检查。副作用是**对盒子不常在线这件事很宽容** ——
// 8 点整没开机，9 点上线照样会把今天补上（这正是 mcloud 任务表里 catch-up 的意思）。


import { fetchInfoV3 } from './info.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';

export const STATE_SIGN = 'mcloud.sign.last';
/** '' | 'need-verify'：下一步该干嘛 */
export const STATE_STAGE = 'mcloud.sign.stage';

export function runSign(deps: TaskDeps): TaskOutcome {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: '未登录：state 里没有会话（见 docs/howto-session.md）' };
  }

  const stage = deps.store.getState(STATE_STAGE) ?? '';

  // ③ 回查：上一次已经把签到提交出去了，这次看结果
  if (stage === 'need-verify') {
    const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
    if (!info.ok) return { ok: false, note: `回查失败：${info.error}` };
    if (info.info.todaySigned) {
      deps.store.setState(STATE_STAGE, '', deps.nowIso);
      return { ok: true, note: '签到完成（回查 infoV3 确认今日已签）' };
    }
    // 提交过了但状态还没变：**如实报失败**，别自己安慰自己
    return { ok: false, note: '已提交签到，但回查 infoV3 显示今日仍未签（上游可能延迟入账）' };
  }

  // ① 问状态
  const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `查询签到状态失败：${info.error}` };
  if (info.info.todaySigned) {
    return { ok: true, note: '今日已签到（infoV3 判据）' };
  }

  // ② 动手
  const deviceId = session.deviceId;
  const out = runTask(
    deps,
    {
      task: 'sign',
      endpoint: 'startSignIn',
      method: 'GET',
      query: deviceId ? `client=app&deviceId=${encodeURIComponent(deviceId)}` : 'client=app',
      isDeviceId: !!deviceId,
      stateKey: STATE_SIGN,
    },
    (env) => ({
      ok: true,
      // ⚠️ 这里**不说"签到成功"** —— 动作响应不是判据（见文件头）。
      note: `签到已提交（下次触发回查状态；上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
      snapshot: { result: env.result ?? null, message: env.message },
    }),
  );
  if (out.ok) deps.store.setState(STATE_STAGE, 'need-verify', deps.nowIso);
  return out;
}
