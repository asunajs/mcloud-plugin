// 网盘上传链的第一枪与凭据判据。施工图见 `docs/upload-chain.md`。
//
// # 三枪（mcloud 权威口径）
//
// ```text
// ① POST {PERSONAL_KD}/hcy/file/create      声明"我要传一个文件" → fileId / uploadId / uploadUrl
// ② PUT  <uploadUrl>                        发**原始字节**（预签名直传，**另一台主机**）
// ③ POST {PERSONAL_KD}/hcy/file/complete    告诉上游这段传完了
// ```
//
// 相册自动备份支还有 ④ createSnapshot / ⑤ 再 PUT（`ot=system`，op 0/0）/ ⑥ completeSnapshot。
// ⚠ ② 与 ⑤ 是**同一口 URL 的两种形态**，参数不同，别混。
//
// # 本文件管什么
//
// 只放**纯构造与解析**（URL 与体的字节形状），以及那条**凭据判据**。
// 编排（状态机）在 `tasks/upload.ts` —— 面板一次调用只发一个请求，所以那条链必须可恢复。
//
// ⚠ 凭据**不在这里设**：由传输层按目标主机决定（见 `sendsAuthorizationTo`）。

import { sha256Hex } from '../crypto/index.ts';
import { utf8 } from '../crypto/bytes.ts';
import type { BuiltRequest } from './h5.ts';

/** 控制面主机（**是** `yun.139.com` 的子域 ⇒ 按判据**要**带凭据）。 */
export const PERSONAL_KD = 'https://personal-kd-njs.yun.139.com';
export const FILE_CREATE_PATH = '/hcy/file/create';
export const FILE_COMPLETE_PATH = '/hcy/file/complete';
export const BACKUP_CREATE_SNAPSHOT_PATH = '/hcy/backup/createSnapshot';
export const BACKUP_COMPLETE_SNAPSHOT_PATH = '/hcy/backup/completeSnapshot';

/** ⚠ 逐字照抄，**别"统一"**：`oct-stream` 少一个 `et`，而且同一支里
 *  `octet-stream` 也存在（抓包按 profile 分）。两个都是真值。 */
export const CREATE_CONTENT_TYPE = 'application/oct-stream';
export const CREATE_CONTENT_TYPE_OCTET = 'application/octet-stream';
export const PUT_CONTENT_TYPE = 'application/octet-stream';

/** PUT 那一枪的 origin/referer 是**云盘域**，不是 `m.mcloud.139.com`。 */
export const PUT_ORIGIN = 'https://yun.139.com';
export const PUT_REFERER = 'https://yun.139.com/';
/** 头名 `upload-complete`，值是**带问号**的 `?1`。 */
export const PUT_UPLOAD_COMPLETE = '?1';
export const PUT_UPLOAD_DRAFT_INTEROP_VERSION = '6';

export const HASH_ALGORITHM = 'SHA256';
export const FILE_TYPE_FILE = 'file';
export const FILE_TYPE_FOLDER = 'folder';

/** 渠道。mcloud 是**枚举** ⇒ 没有"未识别走 web 兜底"那种分支（本仓同样没有）。 */
export const CHANNEL_ANDROID = '10000023';
export const CHANNEL_PC = '10200153';

/** 四个改名模式（**不是**"要不要覆盖"两个）。 */
export const RENAME_AUTO = 'auto_rename';
export const RENAME_FORCE = 'force_rename';
export const RENAME_REFUSE_DUPLICATE_CONTENT = 'refuse_duplicate_content';
export const RENAME_REFUSE = 'refuse';

/** 数据面 PUT 的 `x-yun-op-type` / `x-yun-sub-op-type`。
 *
 *  ⚠ 基础支是 `2 / 200`，备份支是 `0 / 0` —— 两套值，不是一套。 */
export const OP_TYPE_UPLOAD = '2';
export const SUB_OP_TYPE_UPLOAD = '200';
export const OP_TYPE_BACKUP = '0';
export const SUB_OP_TYPE_BACKUP = '0';

/** Android 档的设备信息串（实拍逐字 —— 别"修"里面的 `127.0.0.1`）。 */
export const CLIENT_INFO_ANDROID =
  '1|127.0.0.1|1|12.6.0|Xiaomi|22041216C||02-00-00-00-00-00|android 14|1080X2360|zh||||032|0|';

/** 这一族三种动作的 op 码（`android_op_codes`）。 */
export type CloudOp = 'upload' | 'backup' | 'snapshot';
export function androidOpCodes(op: CloudOp): { opType: string; subOpType: string } {
  const code = op === 'backup' ? 2 : op === 'upload' ? 1 : 0;
  return { opType: String(code), subOpType: String(code * 100) };
}

/** ⚠ 这一族的**头画像**（与别的族都不同）。
 *
 *  真机教训：少了这几枚，`/hcy/file/create` 回 **HTTP 404** ——
 *  网关按这些头路由，缺了**看着就像"路径不存在"**（F-015 那个坑的第三次）。
 *  出处：mcloud 的 `cloud_file_op_headers`。 */
export function cloudFileOpHeaders(op: CloudOp, channel: string = CHANNEL_ANDROID): Record<string, string> {
  const { opType, subOpType } = androidOpCodes(op);
  return {
    // base 三枚（三档都有）
    'x-yun-api-version': 'v1',
    'x-yun-app-channel': channel,
    'x-yun-op-type': opType,
    // Android 档那三枚
    'x-huawei-channelSrc': channel,
    'x-yun-client-info': CLIENT_INFO_ANDROID,
    'x-yun-sub-op-type': subOpType,
  };
}

/** 应带凭据的主机后缀。⚠ 照抄 mcloud 的 `AUTH_DOMAINS`（`endpoints.rs:6`）。 */
export const AUTH_DOMAINS: readonly string[] = [
  'yun.139.com',
  'mcloud.139.com',
  'feixin.10086.cn',
  'mail.10086.cn',
];

/** 从 URL 里取主机名（小写）。取不到 ⇒ `''`。
 *
 *  ⚠ 不依赖 `new URL(...)`：插件沙箱里有没有它没验过，而这里只需要主机名。
 *  也刻意**不**做"宽松解析"（比如把 `://` 后的第一个 `/` 当结尾就够）——
 *  解析失败必须是"不给凭据"，而不是"猜一个主机"。 */
export function hostOf(rawUrl: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl);
  if (!m) return '';
  let host = m[1]!.toLowerCase();
  // 去掉 userinfo 与端口
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.lastIndexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host;
}

/** 这一枪该不该带凭据。**逐字照抄** mcloud 的 `sends_authorization_to`：
 *  解析不出主机就不带；主机与四条后缀做 `endsWith`。 */
export function sendsAuthorizationTo(rawUrl: string): boolean {
  const host = hostOf(rawUrl);
  if (host === '') return false;
  return AUTH_DOMAINS.some((suffix) => host.endsWith(suffix));
}

// ───────────────────────── ① create ─────────────────────────

export interface CreateInput {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 字节数。 */
  size: number;
  /** 内容摘要（小写 hex）。 */
  contentHash: string;
  /** 定位：**两支用的是不同的键**（`parentFileId` 按 id / `parentPath` 按路径）。 */
  locate: { key: 'parentFileId' | 'parentPath'; value: string };
  contentType?: string | undefined;
  renameMode?: string | undefined;
  parallelUpload?: boolean | undefined;
  localCreatedAt?: string | undefined;
  /** 这一族三种动作之一（默认 `backup` —— 与 PUT 那一枪的 `2/200` 一致）。 */
  op?: CloudOp | undefined;
}

/** 由内容算出 `contentHash`（第 ③ 枪要用**同一份**，所以先算好、落库）。 */
export function contentHashOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** ① 的体。**逐枚插**、不是一个 `json!` —— 因为"哪些键会缺席"（尤其定位键）
 *  是这一枪的语义，写成一次性字面量会让它变成"读代码才看得见"。 */
export function createBody(input: CreateInput): string {
  const body: Record<string, unknown> = {
    name: input.name,
    type: FILE_TYPE_FILE,
    size: input.size,
    fileRenameMode: input.renameMode ?? RENAME_FORCE,
    contentHash: input.contentHash,
    contentHashAlgorithm: HASH_ALGORITHM,
    contentType: input.contentType ?? CREATE_CONTENT_TYPE,
    parallelUpload: input.parallelUpload ?? false,
  };
  // ⚠ 定位键是**两支不同**的：按 id 传 `parentFileId`，按路径传 `parentPath`。
  //   两个都塞进去是错的（上游按哪一支认，另一个就是多余键）。
  body[input.locate.key] = input.locate.value;
  if (input.localCreatedAt !== undefined) body.localCreatedAt = input.localCreatedAt;
  // ⚠ 单片也是**数组**，且带 `parallelHashCtx.partOffset` —— 不是裸的 `{partNumber, partSize}`
  body.partInfos = [
    { parallelHashCtx: { partOffset: 0 }, partNumber: 1, partSize: input.size },
  ];
  return JSON.stringify(body);
}

export function buildCreateRequest(input: CreateInput): BuiltRequest {
  return {
    url: `${PERSONAL_KD}${FILE_CREATE_PATH}`,
    method: 'POST',
    // ⚠ 真机实测（2026-10-14）：这一口**要 `application/json`**。
    //   写成 `application/oct-stream` / `octet-stream` 会回 `04000018 请求体媒体格式不支持`。
    //   ⚠ 我一开始把 404 归因成 content-type —— **认错了**：那次同时改了两样（头画像 +
    //   content-type），而真因是**缺头画像**。一次只改一样才分得清。
    headers: { 'Content-Type': 'application/json', ...cloudFileOpHeaders(input.op ?? 'backup') },
    body: createBody(input),
  };
}

/** ① 的响应。 */
export interface Created {
  fileId: string;
  uploadId: string;
  /** ⚠ 预签名直传地址 —— 按**凭据**对待：绝不进日志、夹具、错误文本。 */
  uploadUrl: string;
  rapidUpload: boolean;
}

/** 解析 ① 的响应。`rapidUpload === true` ⇒ 秒传（**不用再 PUT**）。 */
export function parseCreate(body: string): { ok: boolean; created?: Created; error?: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `create 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.code !== undefined && v.code !== 0 && v.code !== '0000' && v.code !== '0') {
    return { ok: false, error: `create 失败：code=${String(v.code)}` };
  }
  const data = (v.data ?? v.result) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return { ok: false, error: 'create 响应没有 data/result' };
  const fileId = data.fileId;
  const uploadId = data.uploadId;
  // ⚠ **真机形状**（2026-10-14）：`uploadUrl` 在 **`data.partInfos[0].uploadUrl`** 里，
  //   **不在** `data.uploadUrl`。实拍：
  //   `{success:true,code:"0000",data:{fileId,type,fileName,rapidUpload:false,uploadId,
  //     partInfos:[{partNumber:1,partSize:null,uploadUrl:"https://hcyykj-eos-….cmecloud.cn/…"}]}}`
  //   顶层那个键**根本不存在** —— 照顶层读的后果是"看着像成功了却没有地址可用"。
  const parts = Array.isArray(data.partInfos) ? (data.partInfos as unknown[]) : [];
  const first = parts[0];
  const nested =
    first !== null && typeof first === 'object'
      ? ((first as Record<string, unknown>).uploadUrl as string | undefined)
      : undefined;
  const uploadUrl = nested ?? (data.uploadUrl as string | undefined);
  const rapid = data.rapidUpload === true;
  if (typeof fileId !== 'string' || fileId === '') return { ok: false, error: 'create 响应缺 fileId' };
  if (!rapid) {
    if (typeof uploadId !== 'string' || uploadId === '') {
      return { ok: false, error: 'create 响应缺 uploadId（且不是秒传）' };
    }
    if (typeof uploadUrl !== 'string' || uploadUrl === '') {
      return { ok: false, error: 'create 响应缺 uploadUrl（且不是秒传）' };
    }
  }
  return {
    ok: true,
    created: {
      fileId,
      uploadId: typeof uploadId === 'string' ? uploadId : '',
      uploadUrl: typeof uploadUrl === 'string' ? uploadUrl : '',
      rapidUpload: rapid,
    },
  };
}

// ───────────────────────── ② PUT（数据面，另一台主机） ─────────────────────────

/** ② 的请求。**这一枪不带凭据**（除非预签名地址恰好落在 `AUTH_DOMAINS` 里，
 *  而那按设计不该发生 —— 所以下面直接断言一次，让"凭据泄漏到存储主机"编不出来）。 */
export function buildPutRequest(
  uploadUrl: string,
  bytes: Uint8Array,
  backup = false,
): { req: BuiltRequest; leaksCredential: boolean } {
  const req: BuiltRequest = {
    url: uploadUrl,
    method: 'PUT',
    headers: {
      'Content-Type': PUT_CONTENT_TYPE,
      origin: PUT_ORIGIN,
      referer: PUT_REFERER,
      // ⚠ 值是**带问号**的 `?1`
      'upload-complete': PUT_UPLOAD_COMPLETE,
      'upload-draft-interop-version': PUT_UPLOAD_DRAFT_INTEROP_VERSION,
      'x-yun-op-type': backup ? OP_TYPE_BACKUP : OP_TYPE_UPLOAD,
      'x-yun-sub-op-type': backup ? SUB_OP_TYPE_BACKUP : SUB_OP_TYPE_UPLOAD,
    },
    // 二进制体：插件里用 latin1 字符串承载（每个字符一个字节）
    body: latin1FromBytes(bytes),
  };
  return { req, leaksCredential: sendsAuthorizationTo(uploadUrl) };
}

/** 字节 → 每字符一字节的字符串（沙箱里没有 `Buffer`，也没有 `TextEncoder`）。
 *
 *  ⚠ 用 `String.fromCharCode.apply` 会在大体上抛 `RangeError`（沙箱实测十万实参就炸），
 *  所以分块拼。 */
export function latin1FromBytes(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let s = '';
    for (let j = i; j < end; j += 1) s += String.fromCharCode(bytes[j]!);
    out += s;
  }
  return out;
}

// ───────────────────────── ③ complete ─────────────────────────

/** ③ 的体：4 键（抓包实拍 206 字节）。 */
export function completeBody(fileId: string, uploadId: string, contentHash: string): string {
  return JSON.stringify({
    fileId,
    uploadId,
    contentHash,
    contentHashAlgorithm: HASH_ALGORITHM,
  });
}

export function buildCompleteRequest(
  fileId: string,
  uploadId: string,
  contentHash: string,
  op: CloudOp = 'backup',
): BuiltRequest {
  return {
    url: `${PERSONAL_KD}${FILE_COMPLETE_PATH}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cloudFileOpHeaders(op) },
    body: completeBody(fileId, uploadId, contentHash),
  };
}

/** ③ 的判据：成交与否看 `code`（**这一族有 idempotency 的吗？没有** —— 所以只要不是
 *  明确的成功码，就如实报失败，别当"大概成了"）。 */
export function parseComplete(body: string): { ok: boolean; error?: string } {
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    const code = v.code;
    if (code === undefined || code === 0 || code === '0000' || code === '0') return { ok: true };
    return { ok: false, error: `complete 失败：code=${String(code)}` };
  } catch (e) {
    return { ok: false, error: `complete 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 一个小的确定性文件体 —— `task-expansion` 只要"触发备份"，内容不必随机。
 *
 *  ⚠ 刻意**确定**（不是随机）：这样夹具、日志、`contentHash` 都可复现；
 *  mcloud-sign 那边是随机内容，但随机对"触发备份"这件事没有额外好处。 */
export function deterministicFile(seed: string, bytes = 1024): Uint8Array {
  const out = new Uint8Array(bytes);
  const base = utf8(seed);
  for (let i = 0; i < bytes; i += 1) {
    // ⚠ **不许出现 NUL（0x00）**：这一族把体当**字符串**交给宿主，
    //   而"字符串里的 NUL 能不能原样过到线上"**没验过** —— 真机验的时候
    //   就是因为体里有 NUL 才吃了一个 **403**（预签名覆盖了 `content-length`，
    //   而 NUL 在传输路径上被截断 ⇒ 长度与签名不符）。
    //   内容对"触发备份"这件事没有意义，所以取**可打印范围**（0x21–0x7E）。
    out[i] = 0x21 + (((base[i % base.length]! ^ (i & 0x7f)) - 0x21 + 94) % 94);
  }
  return out;
}
