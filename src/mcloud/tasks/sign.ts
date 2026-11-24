// 每日签到：动作类、幂等。**一趟就是一次完整尝试**（读 → 提交 → 再确认一次），
// 每次执行都是独立的一次完整尝试：不假设还有下一次（用户可能一天只让它跑一次）。

import { fetchInfoV3 } from './info.ts';
import { localDay, runTask, waitMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';
import type { Store } from '../../store/types.ts';

export const STATE_SIGN = 'mcloud.sign.last';
/** 纯诊断（这一趟提交了几次），不参与判断。 */
export const STATE_STAGE = 'mcloud.sign.stage';
/** 今天已签：`{day, at, by:'cal'}`。只认本地当天 + 日历确认过的。 */
export const STATE_SIGN_DONE = 'mcloud.sign.done';

/** 一趟最多提交几次。 */
export const SIGN_MAX_SUBMITS = 3;
/** 提交后等多久再确认一次（毫秒）。测试传 `settleMs: 0`。 */
const SIGN_SETTLE_MS = 5000;

interface DoneMark {
  day: string;
  at: string;
  by: string;
}

/** 只认日历确认过的当天记录：旧的裸日期串没有时刻，分不清是确认过还是随口说签了。 */
function readDone(store: Pick<Store, 'getState'>, today: string): DoneMark | null {
  const raw = store.getState(STATE_SIGN_DONE) ?? '';
  if (raw.trim() === '') return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const m = o as Partial<DoneMark>;
  if (typeof m.day !== 'string' || m.day !== today) return null;
  if (typeof m.at !== 'string' || localDay(m.at) !== today) return null;
  if (m.by !== 'cal') return null;
  return { day: m.day, at: m.at, by: m.by };
}

function markDone(deps: TaskDeps, day: string): void {
  deps.store.setState(STATE_SIGN_DONE, JSON.stringify({ day, at: deps.nowIso, by: 'cal' }), deps.nowIso);
  deps.store.setState(STATE_STAGE, '', deps.nowIso);
}

function markAttempt(deps: TaskDeps, day: string, submits: number): void {
  deps.store.setState(STATE_STAGE, JSON.stringify({ last: 'pending', day, at: deps.nowIso, submits }), deps.nowIso);
}

/** 日历里有今天那一格时以它为准：顶层 `todaySignIn` 跨日不重置，残留过 true。 */
function evidenceOf(i: { calTodaySigned?: boolean | undefined; todaySigned: boolean }): 'cal' | 'weak' | 'none' {
  if (i.calTodaySigned === true) return 'cal';
  if (i.calTodaySigned === false) return 'none';
  return i.todaySigned ? 'weak' : 'none';
}

function judgeSubmit(
  env: { result?: unknown; message?: unknown },
  hit: { said: boolean; points: number | undefined },
) {
  const r = (env.result ?? {}) as { todaySignIn?: unknown; signInPoints?: unknown };
  hit.said = r.todaySignIn === true || r.todaySignIn === 1 || r.todaySignIn === 'true';
  hit.points = typeof r.signInPoints === 'number' ? r.signInPoints : undefined;
  return {
    ok: true,
    note: hit.said ? '网盘签到已提交（服务端说已签，待确认）' : '网盘签到已提交',
    snapshot: { result: env.result ?? null, message: env.message },
  };
}

export async function runSign(deps: TaskDeps): Promise<TaskOutcome> {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: '还没有网页会话 —— 上面「换票」那一步说了原因' };
  }

  const today = localDay(deps.nowIso);
  const todayDom = Number(today.slice(8, 10));
  const read = () =>
    fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl, todayDom });

  if (readDone(deps.store, today) !== null) {
    return { ok: true, idle: true, note: '网盘今日已签到' };
  }

  const info = await read();
  if (!info.ok) return { ok: false, note: `查询签到状态失败：${info.error}` };
  if (evidenceOf(info.info) === 'cal') {
    markDone(deps, today);
    return { ok: true, idle: true, note: '网盘今日已签到' };
  }

  // 只有"日历当天格已签"才跳过；其余（含顶层说签了）都去提交 —— 签到幂等。
  const deviceId = session.deviceId;
  let submits = 0;
  while (submits < SIGN_MAX_SUBMITS) {
    submits += 1;
    const hit = { said: false, points: undefined as number | undefined };
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
      (env) => judgeSubmit(env, hit),
    );
    if (!out.ok) return out;

    waitMs(deps, Math.min(Math.max(deps.settleMs ?? SIGN_SETTLE_MS, 0), 8000));
    const after = await read();
    const got = hit.points !== undefined && hit.points > 0 ? `，+${hit.points} 云朵` : '';
    if (after.ok && evidenceOf(after.info) === 'cal') {
      markDone(deps, today);
      return { ok: true, note: `签到成功${got}` };
    }
    // 只是顶层字段/提交响应说已签：算这次成功，但不写"今天已签"（写进去会把今天的后续执行一起挡掉）。
    if (after.ok && evidenceOf(after.info) === 'weak') {
      return { ok: true, note: `签到成功${got}（今天的签到日历还没刷出来）` };
    }
    if (!after.ok) {
      // 确认那一步没回话：不许说成功，也不许把云朵数报出去（那只是提交响应里的数字）。
      markAttempt(deps, today, submits);
      return {
        ok: true,
        pending: true,
        note: `签到提交了，但没等到服务端的确认（${after.error}）—— 过一会儿点「现在跑一次」再看看`,
      };
    }
  }

  markAttempt(deps, today, submits);
  return {
    ok: true,
    pending: true,
    note: `签到没成：提交了 ${submits} 次，服务端都没确认 —— 过一会儿点「现在跑一次」再试`,
  };
}
