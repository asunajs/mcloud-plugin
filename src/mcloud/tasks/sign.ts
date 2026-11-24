// 每日签到：动作类、幂等。**每次执行都提交一次**（不先问状态、也不看本地记录 —— 签到幂等，
// 「今天签没签」只有服务端说了算），然后按 infoV3 日历里今天那一格判成败。
// 判据与流程照参考实现 `mcloud-sign/packages/core/src/tasks/sign/task.ts`。

import { fetchInfoV3 } from './info.ts';
import { runTask, waitMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';

export const STATE_SIGN = 'mcloud.sign.last';
/** 提交后等多久再看状态（毫秒）：与参考实现一致（`sleep(1000)`）。 */
const SIGN_SETTLE_MS = 1000;

export async function runSign(deps: TaskDeps): Promise<TaskOutcome> {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: '还没有网页会话 —— 上面「换票」那一步说了原因' };
  }

  const deviceId = session.deviceId;
  let saidSigned = false;
  let points: number | undefined;

  const out = await runTask(
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
      const r = (env.result ?? {}) as { todaySignIn?: unknown; signInPoints?: unknown };
      saidSigned = r.todaySignIn === true || r.todaySignIn === 1 || r.todaySignIn === 'true';
      points = typeof r.signInPoints === 'number' ? r.signInPoints : undefined;
      return {
        ok: true,
        note: '网盘签到已提交',
        snapshot: { result: env.result ?? null, message: env.message },
      };
    },
  );
  if (!out.ok) return out;

  // 提交响应说"今天已签" ⇒ 就是签上了（参考实现同样认这一句）
  if (saidSigned) {
    const got = points !== undefined && points > 0 ? `，+${points} 云朵` : '';
    return { ok: true, note: `网盘签到成功${got}` };
  }

  // 否则等一秒再看日历：`currentMonth` 且 `t` 的那一格才是今天
  waitMs(deps, Math.min(Math.max(deps.settleMs ?? SIGN_SETTLE_MS, 0), 8000));
  const info = await fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `签到结果没确认上：${info.error}` };

  const today = info.info.calToday;
  if (today === undefined) return { ok: false, note: '网盘签到失败：日历里没有今天那一格' };
  if (!today.s) return { ok: false, note: `网盘签到失败：今天（${today.d} 号）还没签上` };
  const got = today.clouds > 0 ? `，+${today.clouds} 云朵` : '';
  return { ok: true, note: `网盘签到成功${got}` };
}
