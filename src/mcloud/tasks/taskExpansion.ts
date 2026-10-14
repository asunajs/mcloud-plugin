// 任务拓展（`task-expansion`）—— "本月备份 + 领云朵"。
//
// # 三件事（mcloud `task_expansion.rs` 的口径）
//
// ```text
// ① GET  /ycloud/signin/page/taskExpansion        读状态
// ②      上传一个文件（触发"本月已备份"）—— 走 `tasks/upload.ts` 那三枪
// ③ GET  /ycloud/signin/page/receiveTaskExpansion 领云朵（**裸 GET**）
// ```
//
// # 三处照 mcloud 来的讲究
//
// ① **判据是严格读到 `false`**，不是"没读到 true"（`should_upload`）：
//    没读到 ≠ 未开启备份。读成"没读到 true 就去传"，会在上游改字段时**白发一堆上传**。
// ② **传上去的文件不许删** —— mcloud 的原话是"把它放进清理名单就是**删用户的东西**"，
//    所以那一档**不交 id**。本文件只负责触发，不做清理。
// ③ 领那一枪的 `result` 是**裸数字**（实拍 `result: 100`），不是对象 ⇒ 别去解形状。
//
// # ⚠ 与用户口径的一处**刻意分歧**
//
// mcloud 只在 `curMonthTaskRecordCount > 0` 时才发第 ③ 枪。本插件**不判**（用户定的）：
// 那一枪是只读 GET、成功了就有云朵、失败了什么也不花 —— 发出去**有可能成功**，
// 所以直接发，把上游的答复如实报出来。这与"清空判据只做选择"是同一条口径。
//
// # ⚠ 证据强度要说清
//
// `app_signin.rs:28` 注明：`receiveTaskExpansion` **缺成功样本**
// （两个测试号本月都已领过）。所以这一枪的**成功响应形状没被实拍验过** ——
// 实现照源码逐字，但拿不到成功样本时不要假装它被验过。

import { callRawText } from '../client.ts';
import { REFERER_SIGN_IN, SHOW_LOADING, buildH5Request } from '../h5.ts';
import { sessionHeaders } from './base.ts';
import { deterministicFile } from '../cloudUpload.ts';
import { runUploadStep, startUpload, uploadDone } from './upload.ts';
import { loadSession } from '../../store/types.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 一枪**带签名**的 GET。⚠ 这一族的接口都在签名那套里 —— 不给签名会回
 *  `501 参数校验异常`，而那句话**不提示是签名的问题**（我在兑换那条上踩过一轮）。 */
function signedGet(deps: TaskDeps, path: string): ReturnType<typeof buildH5Request> {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: withBase(deps, path),
    method: 'GET',
    body: undefined,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    marketName: 'sign_in_3',
    session: session ? sessionHeaders(session) : {},
  });
}

/** 从原始响应里取 `result`（取不到就给整个对象）。**不用** `resultObject`：
 *  那个要的是已解析的 `SignInEnvelope`，而这里要边解边看（解析失败也要能报原文）。 */
function digResult(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const r = v.result;
    return r && typeof r === 'object' ? (r as Record<string, unknown>) : v;
  } catch {
    return {};
  }
}

export const STATE_EXPAND = 'mcloud.taskexpansion.state';

export type ExpandStep = 'read' | 'upload' | 'recheck' | 'claim' | 'done';

interface ExpandState {
  step: ExpandStep;
  /** ① 读到的四样（用于文案与"下月可领"）。 */
  curMonthBackup?: boolean | undefined;
  curMonthTaskRecordCount?: number | undefined;
  nextMonthTaskRecordCount?: number | undefined;
}

const STEP_TEXT: Record<ExpandStep, string> = {
  read: '① 读任务拓展状态',
  upload: '② 传一个文件触发本月备份',
  recheck: '②b 再过一遍状态',
  claim: '③ 领云朵',
  done: '完成',
};

/** ⚠ **严格**判据：只有**读到 `false`** 才去传。
 *  `undefined`（没读到）不算 —— 那条路会在上游改字段时白发一堆上传。 */
export function shouldUpload(read: { curMonthBackup?: boolean | undefined }): boolean {
  return read.curMonthBackup === false;
}

export interface ExpandRead {
  curMonthBackup?: boolean | undefined;
  curMonthTaskRecordCount?: number | undefined;
  acceptDate?: string | undefined;
  nextMonthTaskRecordCount?: number | undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** 解析 ① 的 result。字段缺就是 `undefined`（**不猜**）。 */
export function parseExpand(result: unknown): ExpandRead {
  const o = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  return {
    curMonthBackup: typeof o.curMonthBackup === 'boolean' ? o.curMonthBackup : undefined,
    curMonthTaskRecordCount: asInt(o.curMonthTaskRecordCount),
    acceptDate: typeof o.acceptDate === 'string' ? o.acceptDate : undefined,
    nextMonthTaskRecordCount: asInt(o.nextMonthTaskRecordCount),
  };
}

function load(deps: TaskDeps): ExpandState | null {
  const raw = deps.store.getState(STATE_EXPAND);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ExpandState;
    return typeof v.step === 'string' ? v : null;
  } catch {
    return null;
  }
}
const save = (deps: TaskDeps, st: ExpandState): void =>
  deps.store.setState(STATE_EXPAND, JSON.stringify(st), deps.nowIso);

/** 起一趟（**一个请求都不发**）。 */
export function startExpansion(deps: TaskDeps): TaskOutcome {
  save(deps, { step: 'read' });
  return { ok: true, note: '已排队：读状态 → （需要时）传文件触发备份 → 领云朵' };
}

/** 推进一步，一次调用一个请求。 */
export function runExpansionStep(deps: TaskDeps): TaskOutcome {
  const st = load(deps) ?? { step: 'read' as ExpandStep };

  if (st.step === 'done') return { ok: true, idle: true, note: '这一趟已经走完' };
  const label = STEP_TEXT[st.step];

  // ② 交给上传那台状态机（它自己知道下一步是 create 还是 put 还是 complete）
  if (st.step === 'upload') {
    if (uploadDone(deps)) {
      save(deps, { ...st, step: 'recheck' });
      return { ok: true, note: `${label}：文件已传完 —— 下一步再过一遍状态` };
    }
    // 字节在这里重建（**确定的**，所以摘要能对上 ① 那一步算出来的）
    const out = runUploadStep(deps, deterministicFile(EXPAND_FILE_SEED, EXPAND_FILE_BYTES));
    // ⚠ 上传一完成就**在这一步推进**游标（否则会多出一次"不发请求的空调用：
    //   下一次进来才发现传完了）。空闲同理。
    if (out.idle || uploadDone(deps)) {
      save(deps, { ...st, step: 'recheck' });
      return {
        ok: true,
        note: out.idle
          ? `${label}：没有待传的（可能上次已传完）—— 下一步再过一遍状态`
          : `${label}：文件已传完 —— 下一步再过一遍状态`,
      };
    }
    return out;
  }

  if (st.step === 'read' || st.step === 'recheck') {
    const res = callRawText(deps.transport, signedGet(deps, '/ycloud/signin/page/taskExpansion'));
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    let read: ExpandRead;
    try {
      read = parseExpand(digResult(res.text));
    } catch (e) {
      return { ok: false, note: `${label}：响应解析不了（${e instanceof Error ? e.message : String(e)}）` };
    }
    const next: ExpandState = {
      step: 'claim',
      curMonthBackup: read.curMonthBackup,
      curMonthTaskRecordCount: read.curMonthTaskRecordCount,
      nextMonthTaskRecordCount: read.nextMonthTaskRecordCount,
    };

    if (st.step === 'read' && shouldUpload(read)) {
      // ⚠ 严格读到 false 才传（见 shouldUpload）
      save(deps, { ...next, step: 'upload' });
      startUpload(deps, { name: EXPAND_FILE_NAME, bytes: deterministicFile(EXPAND_FILE_SEED, EXPAND_FILE_BYTES) });
      return { ok: true, note: `${label}：本月**未开启备份** ⇒ 传一个文件把它做出来 —— 下一步开始传` };
    }
    save(deps, next);
    const tail =
      read.nextMonthTaskRecordCount === undefined ? '' : `；下月可领 ${read.nextMonthTaskRecordCount} 个`;
    return {
      ok: true,
      note: `${label}：备份=${read.curMonthBackup === undefined ? '没读到' : String(read.curMonthBackup)}，可领次数=${read.curMonthTaskRecordCount ?? '没读到'}${tail} —— 下一步领`,
    };
  }

  // ③ 领 —— **裸 GET**（抓包 §3.6.6：不许写 `?acceptDate=`，那是另一个请求）
  const res = callRawText(deps.transport, signedGet(deps, '/ycloud/signin/page/receiveTaskExpansion'));
  save(deps, { ...st, step: 'done' });
  if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
  let out: Record<string, unknown> | undefined;
  try {
    out = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    out = undefined;
  }
  // ⚠ `result` 是**裸数字**（实拍 `result: 100`），不是对象 —— 所以两种都认，
  //   认不出来就如实回显原文，**不编一个"领到 N 个"**
  const raw = out?.result;
  if (typeof raw === 'number') {
    return { ok: true, note: `${label}：上游回 ${raw}（这一族的 result 是裸数字）` };
  }
  return {
    ok: true,
    note: `${label}：上游回 ${res.text.slice(0, 120)}（⚠ 这一枪**缺成功样本**，形状没被实拍验过）`,
  };
}

/** 触发备份用的那个文件：**确定**内容（夹具与摘要都可复现）。 */
export const EXPAND_FILE_NAME = 'panel-backup-marker.txt';
export const EXPAND_FILE_SEED = 'mcloud-panel-backup-marker-v1';
export const EXPAND_FILE_BYTES = 256;

function withBase(deps: TaskDeps, path: string): string {
  return `${deps.baseUrl ?? 'https://m.mcloud.139.com'}${path}`;
}
