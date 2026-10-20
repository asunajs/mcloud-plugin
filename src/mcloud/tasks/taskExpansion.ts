// 任务拓展（`task-expansion`）—— "把本月备份做出来"。
//
// # 四件事
//
// ```text
// ① GET  /ycloud/signin/page/taskExpansion        读状态
// ②      上传一个文件（随机名/随机内容，refuse_duplicate_content）
// ②a     backup/createSnapshot → PUT(0/0) → backup/completeSnapshot
// ③      把**自己造的**文件移进回收站（撞同名/判不了的不删）
// ```
//
// # 照 mcloud 来的讲究
//
// ① **判据是严格读到 `false`**，不是"没读到 true"（`should_upload`）：
//    没读到 ≠ 未开启备份。读成"没读到 true 就去传"，会在上游改字段时**白发一堆上传**。
// ② **只删自己造的** —— `exist:true` 是用户已有文件，`exist` 判不了同样不删；
//    只有 `ownedByUs === true` 才进 `batchTrash`。
// ③ 快照体是**空 ZIP**（mcloud 同款 22 字节 EOCD），装什么没有读数。
//
// ⚠ 这条**不领云朵**：`receiveTaskExpansion` 那一枪已按用户 2026-10-20 口径去掉，
//    只负责把备份做出来。


import { callRawText } from '../client.ts';
import { REFERER_SIGN_IN, SHOW_LOADING, buildH5Request, MCLOUD_HOST } from '../h5.ts';
import { hostBase, sessionHeaders } from './base.ts';
import {
  EMPTY_ZIP,
  RENAME_REFUSE_DUPLICATE_CONTENT,
  buildPutRequest,
  buildSnapshotCompleteRequest,
  buildSnapshotCreateRequest,
  contentHashOf,
  deterministicFile,
  parseSnapshotComplete,
  parseSnapshotCreate,
  randomHex,
} from '../cloudUpload.ts';
import { loadUpload, runUploadStep, startUpload, uploadDone } from './upload.ts';
import { trashRequest } from './cloudTrash.ts';
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

/** 本月备份读数（App 任务的月门要它）。⚠ 按月份存，跨月自动失效。 */
export const STATE_MONTH_BACKUP = 'mcloud.month.backup';

/** 把 `curMonthBackup` 落盘；`undefined`（没读到）不写，避免把“不知道”当成“没开”。 */
export function saveMonthBackup(deps: TaskDeps, backup: boolean | undefined): void {
  if (backup === undefined) return;
  const month = deps.nowIso.slice(0, 7);
  deps.store.setState(STATE_MONTH_BACKUP, JSON.stringify({ month, backup }), deps.nowIso);
}

/** 读本月备份读数；月份对不上/没记录 ⇒ `undefined`（月门不跳）。 */
export function readMonthBackup(deps: TaskDeps): boolean | undefined {
  const raw = deps.store.getState(STATE_MONTH_BACKUP);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { month?: unknown; backup?: unknown };
    if (v.month !== deps.nowIso.slice(0, 7)) return undefined;
    return typeof v.backup === 'boolean' ? v.backup : undefined;
  } catch {
    return undefined;
  }
}

export type ExpandStep =
  | 'read'
  | 'upload'
  | 'snapshot-create'
  | 'snapshot-put'
  | 'snapshot-complete'
  | 'recheck'
  | 'cleanup'
  | 'done';

interface ExpandState {
  step: ExpandStep;
  /** 这一趟属于哪一天（`YYYY-MM-DD`）。跨天/老状态没有这一格 ⇒ 重新起。 */
  day?: string | undefined;
  /** ① 读到的四样（用于文案与“下月可领”）。 */
  curMonthBackup?: boolean | undefined;
  curMonthTaskRecordCount?: number | undefined;
  nextMonthTaskRecordCount?: number | undefined;
  /** 上传完成后记下：只有 `owned === true` 才允许链尾清理。 */
  uploadFileId?: string | undefined;
  uploadOwned?: boolean | undefined;
  /** 快照那三枪要复用的字段。 */
  snapFileId?: string | undefined;
  snapUploadId?: string | undefined;
  snapUploadUrl?: string | undefined;
  snapHash?: string | undefined;
  snapSize?: number | undefined;
  snapTimestamp?: number | undefined;
  snapError?: string | undefined;
}

const STEP_TEXT: Record<ExpandStep, string> = {
  read: '① 读任务拓展状态',
  upload: '② 传一个文件触发本月备份',
  'snapshot-create': '②a 建备份快照',
  'snapshot-put': '②a 传快照体',
  'snapshot-complete': '②a 确认快照',
  recheck: '②b 再过一遍状态',
  cleanup: '③ 清理自己传的文件',
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

/** 起一趟（**一个请求都不发**）。
 *
 *  ⚠ 每天都要能重新起：`done` 是**当天**的完成标记，不是永久标记。
 *  老状态没有 `day`（或跨天）⇒ 重新起；同一天还在走 ⇒ 不重置；同一天已走完 ⇒ idle。 */
export function startExpansion(deps: TaskDeps): TaskOutcome {
  const day = deps.nowIso.slice(0, 10);
  const cur = load(deps);
  if (cur && cur.day === day) {
    if (cur.step === 'done') return { ok: true, idle: true, note: '今天这一趟已经走完' };
    return { ok: true, note: '今天这一趟还在走，接着推' };
  }
  save(deps, { step: 'read', day });
  return { ok: true, note: '已排队：读状态 → （需要时）传文件+快照触发备份 → 清理' };
}

/** 推进一步，一次调用一个请求。 */
export function runExpansionStep(deps: TaskDeps): TaskOutcome {
  const st = load(deps) ?? { step: 'read' as ExpandStep };

  if (st.step === 'done') return { ok: true, idle: true, note: '这一趟已经走完' };
  const label = STEP_TEXT[st.step];

  // ② 交给上传那台状态机（它自己知道下一步是 create 还是 put 还是 complete）
  if (st.step === 'upload') {
    const out = uploadDone(deps) ? { ok: true, idle: true, note: '' } : runUploadStep(deps);
    // ⚠ 上传一完成就**在这一步推进**游标（否则会多出一次"不发请求的空调用"）。
    if (out.idle || uploadDone(deps)) {
      const up = loadUpload(deps);
      const owned = up?.ownedByUs;
      // 撞上用户已有同名文件 / exist 判不了 ⇒ 不建快照、也不清理；只去复查+收尾。
      const step: ExpandStep = owned === true ? 'snapshot-create' : 'recheck';
      save(deps, { ...st, step, uploadFileId: up?.fileId, uploadOwned: owned });
      const why =
        owned === true
          ? '文件已传完'
          : owned === false
            ? '撞上已有同名文件（不是我们造的，不覆盖、不删）'
            : '文件已传完，但 exist 判不了（按不是我们造的算，不删）';
      return { ok: true, note: `${label}：${why} —— 下一步${owned === true ? '建快照' : '再复查'}` };
    }
    return out;
  }

  // ②a 快照三枪：createSnapshot → PUT(0/0) → completeSnapshot
  if (st.step === 'snapshot-create') {
    const hash = contentHashOf(EMPTY_ZIP);
    const timestamp = Date.parse(deps.nowIso);
    const req = buildSnapshotCreateRequest({
      fileExtension: 'zip',
      count: 1,
      size: EMPTY_ZIP.length,
      contentHash: hash,
      timestampMs: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
    const res = callRawText(deps.transport, req);
    if (!res.ok) {
      save(deps, { ...st, step: 'recheck', snapError: `建快照失败：${res.error ?? '未知失败'}` });
      return { ok: true, note: `${label}：没成（${res.error ?? '未知失败'}）—— 不挡领取，继续复查` };
    }
    const parsed = parseSnapshotCreate(res.text);
    if (!parsed.ok || !parsed.created) {
      save(deps, { ...st, step: 'recheck', snapError: parsed.error ?? '快照响应解析不了' });
      return { ok: true, note: `${label}：没成（${parsed.error ?? '响应解析不了'}）—— 不挡领取，继续复查` };
    }
    const c = parsed.created;
    const step: ExpandStep = c.rapidUpload ? 'snapshot-complete' : 'snapshot-put';
    save(deps, {
      ...st,
      step,
      snapFileId: c.fileId,
      snapUploadId: c.uploadId,
      snapUploadUrl: c.uploadUrl,
      snapHash: hash,
      snapSize: EMPTY_ZIP.length,
      snapTimestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
    return { ok: true, note: `${label}：已声明快照（${c.rapidUpload ? '秒传，直接确认' : '下一步传快照体'}）` };
  }

  if (st.step === 'snapshot-put') {
    if (!st.snapUploadUrl || !st.snapUploadId) {
      save(deps, { ...st, step: 'recheck', snapError: '快照状态缺 uploadUrl/uploadId' });
      return { ok: true, note: `${label}：没成（状态缺 uploadUrl/uploadId）—— 不挡领取，继续复查` };
    }
    const { req } = buildPutRequest(st.snapUploadUrl, EMPTY_ZIP, 'snapshot');
    const res = callRawText(deps.transport, req);
    if (!res.ok) {
      save(deps, { ...st, step: 'recheck', snapError: `快照 PUT 失败：${res.error ?? '未知失败'}` });
      return { ok: true, note: `${label}：没成（${res.error ?? '未知失败'}）—— 不挡领取，继续复查` };
    }
    save(deps, { ...st, step: 'snapshot-complete' });
    return { ok: true, note: `${label}：快照体已传完 —— 下一步确认` };
  }

  if (st.step === 'snapshot-complete') {
    if (!st.snapFileId || !st.snapHash) {
      save(deps, { ...st, step: 'recheck', snapError: '快照状态缺 fileId/contentHash' });
      return { ok: true, note: `${label}：没成（状态缺 fileId/contentHash）—— 不挡领取，继续复查` };
    }
    const req = buildSnapshotCompleteRequest({
      fileId: st.snapFileId,
      uploadId: st.snapUploadId ?? '',
      count: 1,
      contentHash: st.snapHash,
      size: st.snapSize ?? EMPTY_ZIP.length,
      timestampMs: st.snapTimestamp ?? Date.now(),
    });
    const res = callRawText(deps.transport, req);
    const parsed = res.ok ? parseSnapshotComplete(res.text) : { ok: false, error: res.error };
    save(deps, { ...st, step: 'recheck', snapError: parsed.ok ? undefined : parsed.error });
    return {
      ok: true,
      note: parsed.ok
        ? `${label}：快照已确认 —— 下一步复查`
        : `${label}：没成（${parsed.error ?? '未知失败'}）—— 不挡领取，继续复查`,
    };
  }

  if (st.step === 'cleanup') {
    const fileId = st.uploadFileId;
    if (st.uploadOwned !== true || !fileId) {
      save(deps, { ...st, step: 'done' });
      return { ok: true, note: `${label}：没有该由我们清的文件（不是我们造的 / 判不了）` };
    }
    const res = callRawText(deps.transport, trashRequest([fileId]));
    save(deps, { ...st, step: 'done' });
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    return { ok: true, note: `${label}：已移进回收站` };
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
    // 顺手落盘：App 任务的月门要 `curMonthBackup`（没读到不写）。
    saveMonthBackup(deps, read.curMonthBackup);
    const next: ExpandState = {
      ...st,
      step: 'cleanup',
      curMonthBackup: read.curMonthBackup,
      curMonthTaskRecordCount: read.curMonthTaskRecordCount,
      nextMonthTaskRecordCount: read.nextMonthTaskRecordCount,
    };

    if (st.step === 'read' && shouldUpload(read)) {
      // ⚠ 严格读到 false 才传（见 shouldUpload）。
      //    文件**随机**（名字 + 内容）：固定内容会命中秒传，固定名字会撞用户文件；
      //    mcloud 的 task_expansion 就是随机名 + 随机字节。
      const seed = randomHex(16);
      const name = `${randomHex(8)}.bin`;
      save(deps, { ...next, step: 'upload' });
      startUpload(deps, {
        name,
        bytes: deterministicFile(seed, 256),
        seed,
        // 备份支：按路径定位根目录 + refuse_duplicate_content + parallelUpload。
        locateKey: 'parentPath',
        locateValue: '/',
        renameMode: RENAME_REFUSE_DUPLICATE_CONTENT,
        parallelUpload: true,
        localCreatedAt: deps.nowIso,
        op: 'backup',
      });
      return { ok: true, note: `${label}：本月**未开启备份** ⇒ 传一个文件把它做出来 —— 下一步开始传` };
    }
    save(deps, next);
    const tail =
      read.nextMonthTaskRecordCount === undefined ? '' : `；下月可领 ${read.nextMonthTaskRecordCount} 个`;
    return {
      ok: true,
      note: `${label}：备份=${read.curMonthBackup === undefined ? '没读到' : String(read.curMonthBackup)}，可领次数=${read.curMonthTaskRecordCount ?? '没读到'}${tail} —— 下一步清理`,
    };
  }

  return { ok: false, note: `${label}：不认识的步骤` };
}

function withBase(deps: TaskDeps, path: string): string {
  // ⚠ 空串必须当成"没给"（见 `hostBase` 那段说明）
  return `${hostBase(deps, MCLOUD_HOST)}${path}`;
}
