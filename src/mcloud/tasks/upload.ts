// 网盘上传的**可恢复状态机**（三枪）。施工图见 `docs/upload-chain.md`。
//
// ```text
// create  →  [put]  →  complete  →  done
//              ↑
//      秒传（rapidUpload）时跳过 —— 2026-10-07 真机上 `uploadId: null` 那一支就是它
// ```
//
// # 为什么必须可恢复
//
// 面板一次调用只给 2000ms，而这一条链要发 2-3 枪、中间还要传字节。
// 所以状态落 SQLite、`step` 当游标（与 `sessionExchange.ts`、`exchangeOrder.ts` 同构）。
//
// # ⚠ 传上去的文件**不许删**
//
// mcloud 在这一点上有明确的话（`task_expansion.rs:18`）：
// "把它放进清理名单就是**删用户的东西**" ⇒ 那一档**不交 id**（`upload_file_id` 留空）。
// 所以这个状态机**只负责传**，不做任何清理；要不要留 id 由调用方决定，而
// "触发备份"这一档的答案是**不留**。
//
// # 两种定位
//
// 按 id（`parentFileId`）或按路径（`parentPath`）—— **两支不同**，由调用方给。

import { callRawText } from '../client.ts';
import {
  buildCompleteRequest,
  buildCreateRequest,
  buildPutRequest,
  contentHashOf,
  parseComplete,
  parseCreate,
} from '../cloudUpload.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_UPLOAD = 'mcloud.upload.state';

export type UploadStep = 'create' | 'put' | 'complete' | 'done';

export interface UploadState {
  step: UploadStep;
  name: string;
  size: number;
  contentHash: string;
  locateKey: 'parentFileId' | 'parentPath';
  locateValue: string;
  /** ① 的产出。`uploadUrl` 是**预签名直传地址**，按凭据对待（只落本机库，不进日志）。 */
  fileId?: string | undefined;
  uploadId?: string | undefined;
  uploadUrl?: string | undefined;
  /** 秒传 ⇒ 跳过 PUT。 */
  rapidUpload?: boolean | undefined;
}

const STEP_TEXT: Record<UploadStep, string> = {
  create: '① 声明要传一个文件',
  put: '② 传字节（预签名直传）',
  complete: '③ 告诉上游传完了',
  done: '完成',
};

export function loadUpload(deps: TaskDeps): UploadState | null {
  const raw = deps.store.getState(STATE_UPLOAD);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as UploadState;
    return typeof v.step === 'string' ? v : null;
  } catch {
    return null;
  }
}

function save(deps: TaskDeps, st: UploadState): void {
  deps.store.setState(STATE_UPLOAD, JSON.stringify(st), deps.nowIso);
}

export function clearUpload(deps: TaskDeps): void {
  deps.store.setState(STATE_UPLOAD, '', deps.nowIso);
}

/** 排队的上传（**一个请求都不发**：只是把"要传什么"与摘要写下来）。 */
export function startUpload(
  deps: TaskDeps,
  opts: {
    name: string;
    bytes: Uint8Array;
    locateKey?: 'parentFileId' | 'parentPath';
    locateValue?: string;
  },
): TaskOutcome {
  if (opts.name.trim() === '') return { ok: false, note: '上传要有文件名' };
  if (opts.bytes.length === 0) return { ok: false, note: '上传的内容是空的' };
  const st: UploadState = {
    step: 'create',
    name: opts.name,
    size: opts.bytes.length,
    // ⚠ 摘要在这里就算好：第 ③ 枪 `complete` 要用**同一份**，而且它必须跨调用活下来
    contentHash: contentHashOf(opts.bytes),
    locateKey: opts.locateKey ?? 'parentFileId',
    locateValue: opts.locateValue ?? '/',
  };
  save(deps, st);
  // ⚠ 字节本身**不落库**：它在第 ② 枪时要重新给（由调用方从"确定的文件体"重建，
  //   见 `deterministicFile`）—— 把 1 KB 的 base64 塞进 state 只会让库变脏。
  return {
    ok: true,
    note: `已排队上传「${opts.name}」（${st.size} 字节，摘要 ${st.contentHash.slice(0, 12)}…）—— 每次触发走一步`,
  };
}

/** 推进一步。`bytes` 只在 `put` 那一步需要（第 ① ③ 枪只用摘要）。 */
export function runUploadStep(deps: TaskDeps, bytes?: Uint8Array): TaskOutcome {
  const st = loadUpload(deps);
  if (!st) return { ok: true, idle: true, note: '没有在排队的上传' };
  if (st.step === 'done') return { ok: true, idle: true, note: '这一次上传已经走完' };
  const label = STEP_TEXT[st.step];

  if (st.step === 'create') {
    const req = buildCreateRequest({
      name: st.name,
      size: st.size,
      contentHash: st.contentHash,
      locate: { key: st.locateKey, value: st.locateValue },
    });
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    const parsed = parseCreate(res.text);
    if (!parsed.ok || !parsed.created) return { ok: false, note: `${label}：${parsed.error}` };
    const c = parsed.created;
    const next: UploadState = { ...st, fileId: c.fileId };
    if (c.rapidUpload) {
      // 秒传 ⇒ **没有 PUT 可发**（真机那一支就是 `uploadId: null`）
      next.step = 'done';
      next.rapidUpload = true;
      save(deps, next);
      return { ok: true, note: `${label}：秒传命中（fileId ${c.fileId.length} 字符）⇒ 不用传字节，这次上传已完成` };
    }
    next.step = 'put';
    next.uploadId = c.uploadId;
    next.uploadUrl = c.uploadUrl;
    next.rapidUpload = false;
    save(deps, next);
    // ⚠ 不打印 uploadUrl（按凭据对待），只说长度
    return { ok: true, note: `${label}：拿到 fileId 与预签名地址（${c.uploadUrl.length} 字符）—— 下一步传字节` };
  }

  if (st.step === 'put') {
    if (!st.uploadUrl || !st.uploadId) {
      return { ok: false, note: `${label}：状态里没有 uploadUrl/uploadId ⇒ 这一趟作废（重起一次上传）` };
    }
    if (!bytes || bytes.length === 0) {
      // ⚠ 没给字节就**不发空体**：那会把一个 0 字节文件传上去（不是"失败"，是"传错了东西"）
      return {
        ok: false,
        note: `${label}：这次调用没带字节 ⇒ 不发（拿空体去 PUT 会真的传一个 0 字节文件上去）`,
      };
    }
    const { req, leaksCredential } = buildPutRequest(st.uploadUrl, bytes, false);
    if (leaksCredential) {
      // 照设计不该发生；真发生了就**不发** —— 凭据泄漏到存储主机比这次上传失败严重得多
      return {
        ok: false,
        note: `${label}：目标主机落在应带凭据的域里（不是预签名直传该有的形状）⇒ 不发，先查 create 的响应`,
      };
    }
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    save(deps, { ...st, step: 'complete' });
    return { ok: true, note: `${label}：${bytes.length} 字节已发（HTTP ${res.status}）—— 下一步确认` };
  }

  // complete
  const res = callRawText(deps.transport, buildCompleteRequest(st.fileId!, st.uploadId!, st.contentHash));
  if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
  const parsed = parseComplete(res.text);
  if (!parsed.ok) return { ok: false, note: `${label}：${parsed.error}` };
  save(deps, { ...st, step: 'done' });
  return { ok: true, note: `${label}：已确认（fileId ${(st.fileId ?? '').length} 字符）—— 这次上传完成` };
}

/** 上传是否已经走完（`task-expansion` 靠它决定要不要进入"等一会儿再复查"那一步）。 */
export function uploadDone(deps: TaskDeps): boolean {
  return loadUpload(deps)?.step === 'done';
}
