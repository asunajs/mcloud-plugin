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
    return { ok: false, note: '还没有网页会话 —— 上面「换票」那一步说了原因' };
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
    return { ok: false, note: '已提交签到，但回查 infoV3 显示今日仍未签（服务端可能延迟入账）' };
  }

  // ① 问状态
  const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `查询签到状态失败：${info.error}` };
  if (info.info.todaySigned) {
    // 参考实现原话（`mcloud-sign/packages/core/src/tasks/sign/task.ts`）：
    // 「网盘今日已签到获得 N 云朵」——它只说事实，不说"成功/跳过"
    return { ok: true, idle: true, note: '网盘今日已签到' };
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
    (env) => {
      // ⚠️ 动作响应**一般**不是判据（见文件头）。但有一种情况它比 `infoV3` 更可信：
      //   响应里**明确**说 `todaySignIn: true` —— 那是"这一枪打中了"的直接证据。
      //
      //   现场（2026-10-17）：响应 `{"todaySignIn":true,"signInPoints":3,"signCount":17}`，
      //   而紧接着的 `infoV3` 还是 `false` —— 用户手机上打开 App 一看**确实签上了**。
      //   于是"只认 infoV3"的结果是：`need-verify` 卡在那里，每一趟都报一次失败。
      //
      //   为什么这时候信响应是安全的：签到**幂等**。万一响应撒谎（说成了其实没成），
      //   下一趟 ① 问状态就会发现没签、再打一枪 —— 代价是晚一天，而不是错报。
      const r = (env.result ?? {}) as { todaySignIn?: unknown };
      const said = r.todaySignIn === true || r.todaySignIn === 1 || r.todaySignIn === 'true';
      if (said) {
        deps.store.setState(STATE_STAGE, '', deps.nowIso);
        return {
          ok: true,
          // 参考实现确认成功后打的就是这一句
          note: '网盘签到成功',
          snapshot: { result: env.result ?? null, message: env.message },
        };
      }
      return {
        ok: true,
        // 响应里没给判据 ⇒ 照旧记"待回查"，下一次触发去看 infoV3
        note: '网盘签到已提交，下一次确认',
        snapshot: { result: env.result ?? null, message: env.message },
      };
    },
  );
  if (out.ok && deps.store.getState(STATE_STAGE) !== '') {
    deps.store.setState(STATE_STAGE, 'need-verify', deps.nowIso);
  }
  return out;
}
