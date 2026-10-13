// 任务：任务清单（`task-list`）—— 签到族里最简单的**纯只读**一条。
//
// 为什么先做它：只拉读数、不改上游账本，所以可以放心在真账号上反复跑；
// 同时它把「会话 → 构造请求 → 签名 → 发送 → 解析 → 落盘」整条链走通一遍 ——
// 后面 7 条任务都是这个形状，只是端点和 body 不同。
//
// 步骤机的形状（见 README「可恢复步骤机」）：一次 handler 调用**只发一个请求**。
// 这条任务天然只需要一步；需要多步的任务把状态写进 state 表，下次触发接着走。

import { callOnce, mergeCookieJar } from '../client.ts';
import type { CallResult, Transport } from '../client.ts';
import { resultArray } from '../envelope.ts';
import type { SignInEnvelope } from '../envelope.ts';
import {
  EP,
  SHOW_LOADING,
  REFERER_SIGN_IN,
  TASK_LIST_V3_CONTENT_TYPE,
  buildH5Request,
  taskListV3Body,
} from '../h5.ts';
import { SESSION_KEY, loadSession, saveSession } from '../../store/types.ts';
import type { Session, Store } from '../../store/types.ts';

export interface TaskDeps {
  store: Store;
  transport: Transport;
  /** 当前时刻（ISO），注入是为了测试可复现 */
  nowIso: string;
  /** 覆盖基址，测试指向 mock 用 */
  baseUrl?: string | undefined;
}

export interface TaskOutcome {
  ok: boolean;
  /** 一行结果，进 runs 表的 note */
  note: string;
}

/** `state` 表里存最近一次清单的键。 */
export const STATE_LAST_TASKLIST = 'mcloud.tasklist.last';
/** 存最近一次失败的键。 */
export const STATE_LAST_ERROR = 'mcloud.tasklist.last_error';

/** 跑一次任务清单。**不抛异常** —— 所有失败都变成 `{ok:false, note}`。
 *
 *  为什么不让它抛：面板会把异常记成 `last_error` 并计入熔断；
 *  而「上游说今天已经签过了」这种业务失败**不该**算环境故障，
 *  否则会把熔断器一路推到冷却（真到了冷却期，后面的任务全被挡）。
 *  环境炸了（网络、JSON 坏了）由调用方按 note 里的前缀判断。 */
export function runTaskList(deps: TaskDeps): TaskOutcome {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: '未登录：state 里没有会话（先跑登录流程）' };
  }

  const req = buildH5Request({
    url: (deps.baseUrl ?? '') + EP.taskListV3,
    method: 'POST',
    body: taskListV3Body(),
    contentType: TASK_LIST_V3_CONTENT_TYPE,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    session: sessionHeaders(session),
  });

  const res = callOnce(deps.transport, req);
  return absorb(deps, res, session);
}

/** 会话 → 请求头里的那几项（抽出来是因为 8 条任务都要用同一套）。 */
export function sessionHeaders(s: Session): {
  jwt: string | undefined;
  deviceId: string | undefined;
  userAgent: string | undefined;
  cookie: string | undefined;
} {
  return {
    jwt: s.jwt,
    deviceId: s.deviceId,
    userAgent: s.userAgent,
    cookie: s.cookie,
  };
}

function absorb(deps: TaskDeps, res: CallResult, session: Session): TaskOutcome {
  // 上游顺手给的 cookie 要并回去（会话续期就靠这个）
  if (res.setCookies.length > 0) {
    saveSession(
      deps.store,
      { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
      deps.nowIso,
    );
  }

  if (!res.ok) {
    deps.store.setState(
      STATE_LAST_ERROR,
      `${res.error ?? '未知失败'} @ ${deps.nowIso}`,
      deps.nowIso,
    );
    return { ok: false, note: res.error ?? '未知失败' };
  }

  // taskListV3 的 result 是**数组**（V2 是对象，形状不同就各解析各的）
  const list = resultArray(res.env as SignInEnvelope);
  const done = list.filter((t) => isFinished(t)).length;

  deps.store.setState(
    STATE_LAST_TASKLIST,
    JSON.stringify({ at: deps.nowIso, total: list.length, done, items: list }),
    deps.nowIso,
  );
  return { ok: true, note: `清单 ${list.length} 条，已完成 ${done} 条` };
}

function isFinished(t: unknown): boolean {
  if (typeof t !== 'object' || t === null) return false;
  const state = (t as Record<string, unknown>).state;
  return typeof state === 'string' && state.toUpperCase() === 'FINISH';
}
