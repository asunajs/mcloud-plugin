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
// # 清理由调用方决定
//
// 这个状态机只负责传，不做清理。它把 `ownedByUs` 记下来：
//   · `true`  = 这次是我们造的文件 ⇒ 调用方可以 `batchTrash`
//   · `false` = 撞上用户已有文件（`exist:true`）⇒ **绝不删**
//   · `undefined` = 判不了（`exist` 缺席且没有新上传会话）⇒ 按不删处理
// `task-expansion` 会用它决定链尾要不要清理；`app-task` 用它决定收尾。
//
// # 两种定位
//
// 按 id（`parentFileId`）或按路径（`parentPath`）—— **两支不同**，由调用方给。
//
// # ⚠ 一台状态机 = 一个**槽位**，槽位按任务分
//
// 这个文件原来是"一个账号一格"（`mcloud.upload.state`），于是**两条任务共用一格**：
// `task-expansion`（备份支）与 `app-task`（手动上传支）都往同一格写游标，
// 而 `uploadDone()` 只问"这格是不是 done"。现场（2026-11-01）三条账号上都是
// 「App 任务的 `asign-*.bin` 躺在格子里，而任务拓展记着自己的 `uploadFileId`」——
// 两边都对不上，"到底是谁传的、传完没有"从读数里判不出来。
//
// 所以所有函数都收一个 `key`：**调用方按任务给槽位**（默认仍是老那格，
// App 任务不用改）。槽位本身是**账号袋里的键** ⇒ 账号那一维由 `scoped()` 负责，
// 这里只多出"任务"这一维。


import { callRawText } from '../client.ts';
import {
  buildCompleteRequest,
  buildCreateRequest,
  buildPutRequest,
  contentHashOf,
  deterministicFile,
  parseComplete,
  parseCreate,
} from '../cloudUpload.ts';
import type { CloudOp } from '../cloudUpload.ts';
import { registerOwnedFile } from './ownedFiles.ts';
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
  /** 重建字节用的种子（不落原始字节；`runUploadStep` 缺 bytes 时用它重算）。 */
  seed?: string | undefined;
  /** 走哪一档（`android` 缺省 / `pc` 给 113）—— 头画像整组跟着变。 */
  channel?: 'android' | 'pc' | undefined;
  /** 改名模式 / 并行上传 / localCreatedAt / op：由调用方按支路口径给。 */
  renameMode?: string | undefined;
  parallelUpload?: boolean | undefined;
  localCreatedAt?: string | undefined;
  op?: CloudOp | undefined;
  /** `true` = 这次是我们造的文件；`false` = 撞上用户已有文件；`undefined` = 判不了。
   *  只有 `true` 才允许链尾清理。 */
  ownedByUs?: boolean | undefined;
}

const STEP_TEXT: Record<UploadStep, string> = {
  create: '① 声明要传一个文件',
  put: '② 传字节（预签名直传）',
  complete: '③ 告诉服务端传完了',
  done: '完成',
};

export function loadUpload(deps: TaskDeps, key: string = STATE_UPLOAD): UploadState | null {
  const raw = deps.store.getState(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as UploadState;
    return typeof v.step === 'string' ? v : null;
  } catch {
    return null;
  }
}

function save(deps: TaskDeps, st: UploadState, key: string): void {
  deps.store.setState(key, JSON.stringify(st), deps.nowIso);
}

/** 清掉一个槽位（`key` 缺省 = App 任务那一格）。 */
export function clearUpload(deps: TaskDeps, key: string = STATE_UPLOAD): void {
  deps.store.setState(key, '', deps.nowIso);
}

/** 排队的上传（**一个请求都不发**：只是把"要传什么"与摘要写下来）。 */
export function startUpload(
  deps: TaskDeps,
  opts: {
    name: string;
    bytes: Uint8Array;
    locateKey?: 'parentFileId' | 'parentPath';
    locateValue?: string;
    seed?: string;
    renameMode?: string;
    parallelUpload?: boolean;
    localCreatedAt?: string;
    op?: CloudOp;
    /** `pc` = 113 那档（头画像整组不同，见 `cloudFileOpHeaders`）。 */
    channel?: 'android' | 'pc';
    /** 哪个槽位（**按任务分**，见文件头。缺省 = App 任务那格）。 */
    key?: string;
  },
): TaskOutcome {
  const key = opts.key ?? STATE_UPLOAD;
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
    seed: opts.seed,
    renameMode: opts.renameMode,
    parallelUpload: opts.parallelUpload,
    localCreatedAt: opts.localCreatedAt,
    op: opts.op,
    channel: opts.channel,
  };
  save(deps, st, key);
  // ⚠ 字节本身**不落库**：它在第 ② 枪时要重新给（由调用方从"确定的文件体"重建，
  //   见 `deterministicFile`）—— 把 1 KB 的 base64 塞进 state 只会让库变脏。
  return {
    ok: true,
    note: `已排队上传「${opts.name}」（${st.size} 字节，摘要 ${st.contentHash.slice(0, 12)}…）—— 每次触发走一步`,
  };
}

/** 推进一步。`bytes` 只在 `put` 那一步需要（第 ① ③ 枪只用摘要）。 */
export function runUploadStep(
  deps: TaskDeps,
  bytes?: Uint8Array,
  key: string = STATE_UPLOAD,
): TaskOutcome {
  const st = loadUpload(deps, key);
  if (!st) return { ok: true, idle: true, note: '没有在排队的上传' };
  if (st.step === 'done') return { ok: true, idle: true, note: '这一次上传已经走完' };
  const label = STEP_TEXT[st.step];

  if (st.step === 'create') {
    const req = buildCreateRequest({
      name: st.name,
      size: st.size,
      contentHash: st.contentHash,
      locate: { key: st.locateKey, value: st.locateValue },
      renameMode: st.renameMode,
      parallelUpload: st.parallelUpload,
      localCreatedAt: st.localCreatedAt,
      op: st.op,
      channel: st.channel,
    });
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    const parsed = parseCreate(res.text);
    if (!parsed.ok || !parsed.created) return { ok: false, note: `${label}：${parsed.error}` };
    const c = parsed.created;
    // 三种状态：true=我们造的 / false=用户的 / undefined=判不了（同样按不删处理）。
    const ownedByUs = c.ownedByUs;
    const next: UploadState = { ...st, fileId: c.fileId, ownedByUs };
    if (ownedByUs === false) {
      // 撞上用户已有同名文件：上游按 refuse 语义把那一枚交回来 ⇒ **不是我们造的**，
      // 既不 PUT 也不进清理名单。
      next.step = 'done';
      save(deps, next, key);
      return { ok: true, note: `${label}：撞上已有同名文件（不是我们造的，不覆盖、不删）` };
    }
    if (c.rapidUpload) {
      // 秒传 ⇒ **没有 PUT 可发**（真机那一支就是 `uploadId: null`）
      next.step = 'done';
      next.rapidUpload = true;
      save(deps, next, key);
      // 只有明确“是我们造的”才登记；撞同名/判不了不进兜底名单。
      if (ownedByUs === true) registerOwnedFile(deps, c.fileId);
      return { ok: true, note: `${label}：秒传命中（fileId ${c.fileId.length} 字符）⇒ 不用传字节，这次上传已完成` };
    }
    next.step = 'put';
    next.uploadId = c.uploadId;
    next.uploadUrl = c.uploadUrl;
    next.rapidUpload = false;
    save(deps, next, key);
    // ⚠ 不打印 uploadUrl（按凭据对待），只说长度
    return { ok: true, note: `${label}：拿到 fileId 与预签名地址（${c.uploadUrl.length} 字符）—— 下一步传字节` };
  }

  if (st.step === 'put') {
    const body = bytes ?? (st.seed !== undefined ? deterministicFile(st.seed, st.size) : undefined);
    if (body === undefined) {
      return { ok: false, note: `${label}：这次调用没带字节，且状态里没有可重建的字节（缺 bytes/seed）⇒ 不发` };
    }
    if (!st.uploadUrl || !st.uploadId) {
      return { ok: false, note: `${label}：状态里没有 uploadUrl/uploadId ⇒ 这一趟作废（重起一次上传）` };
    }
    if (body.length === 0) {
      // ⚠ 空体**不发**：那会把一个 0 字节文件传上去（不是"失败"，是"传错了东西"）
      return { ok: false, note: `${label}：字节是空的 ⇒ 不发（拿空体去 PUT 会真的传一个 0 字节文件上去）` };
    }
    const { req, leaksCredential } = buildPutRequest(st.uploadUrl, body, st.op ?? false);
    if (leaksCredential) {
      // 照设计不该发生；真发生了就**不发** —— 凭据泄漏到存储主机比这次上传失败严重得多
      return {
        ok: false,
        note: `${label}：目标主机落在应带凭据的域里（不是预签名直传该有的形状）⇒ 不发，先查 create 的响应`,
      };
    }
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    save(deps, { ...st, step: 'complete' }, key);
    return { ok: true, note: `${label}：${body.length} 字节已发（HTTP ${res.status}）—— 下一步确认` };
  }

  // complete
  const res = callRawText(
    deps.transport,
    buildCompleteRequest(st.fileId!, st.uploadId!, st.contentHash, st.op ?? 'backup', st.channel ?? 'android'),
  );
  if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
  const parsed = parseComplete(res.text);
  if (!parsed.ok) return { ok: false, note: `${label}：${parsed.error}` };
  save(deps, { ...st, step: 'done' }, key);
  if (st.ownedByUs === true) registerOwnedFile(deps, st.fileId);
  return { ok: true, note: `${label}：已确认（fileId ${(st.fileId ?? '').length} 字符）—— 这次上传完成` };
}

/** 上传是否已经走完（`task-expansion` 靠它决定要不要进入"等一会儿再复查"那一步）。
 *
 *  ⚠ 只问**自己那个槽位**：按任务分槽之前，这里会把 App 任务传完的那一格
 *  当成"任务拓展也传完了"（反之亦然）—— 见文件头那段现场。 */
export function uploadDone(deps: TaskDeps, key: string = STATE_UPLOAD): boolean {
  return loadUpload(deps, key)?.step === 'done';
}
