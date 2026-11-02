// 算力大作战的**动作层**：每个 `ext` 要造的那串"证据"。
//
// # 为什么这些动作不是"点一下"
//
// 抓包（2026-11-01 §8.6）看得很清楚：点「去完成」只发一发 `task/step/click` 记账，
// 真正的业务动作发生在**原生页**里（备份 / 上传照片 / 建笔记 / 分享 / 灵犀对话 / PC 端登录）。
// 服务端看的是**信号**（例：`loginPc` 那条的 `rule` 就写着 `hw_request_pc=10200153`），
// 所以插件必须自己把信号造出来，再让那条任务从 `WAIT` 翻到 `SUCCESS`。
//
// 造法照参照实现（`caiyun/tasks/activity_actions.go`），但**每一枪用的都是本仓已有的构造器**：
// 上传三枪（`tasks/upload.ts`）、快照三枪（`cloudUpload`）、云笔记（`appTaskExtra`）、
// 外链（`appTaskExtra.getOutLinkRequest`）、邮箱 AI 链（`appTaskExtra` 的 609/585 那两条）。
//
// # 谁是"完成"
//
// 这一层只负责把动作做完；**完成与否由 `tokenPk.ts` 的复查（重新拉 `task/list`）+ 领奖判**。
// 动作做完就 `finished`，不再猜状态 —— 猜错会把"没做"写成"做了"（`docs/app-task-ids.md` §2）。

import { callRawText } from '../client.ts';
import type { RawTextResult } from '../client.ts';
import type { BuiltRequest } from '../h5.ts';
import {
  buildPutRequest,
  buildSnapshotCompleteRequest,
  buildSnapshotCreateRequest,
  contentHashOf,
  deterministicFile,
  EMPTY_ZIP,
  parseSnapshotComplete,
  parseSnapshotCreate,
  randomHex,
} from '../cloudUpload.ts';
import {
  aiCameraChatRequest,
  aiChatRequest,
  aiRecognizeRequest,
  deriveAiAuth,
  getOutLinkRequest,
  mailLoginRequest,
  mailSpecTokenRequest,
  newCguid,
  noteAuthRequest,
  noteCreateRequest,
  noteDeleteRequest,
  parseAiRecognize,
  parseMailSession,
  parseNoteHeaders,
  parseQueryUserToken,
  parseSse,
  queryUserTokenRequest,
} from './appTaskExtra.ts';
import { parseAuth } from '../auth.ts';
import { loadAuthRaw } from '../sessionExchange.ts';
import { parseSsoToken } from '../h5session.ts';
import { uuidV4 } from '../rand.ts';
import { clearUpload, loadUpload, runUploadStep, startUpload, uploadDone } from './upload.ts';
import { depsNowMs, waitMs } from './base.ts';
import type { TaskDeps } from './base.ts';
import { STATE_TOKENPK_UPLOAD } from '../tokenPkState.ts';
import type { PkAttempt } from '../tokenPkState.ts';
import { sampleJpeg } from '../tokenPkAssets.ts';
import type { PkSession } from '../tokenPk.ts';
import {
  clickRequest,
  parseClaim,
  parsePk,
  receiveRequest,
  reserveRequest,
  smartAlbumRequest,
} from '../tokenPk.ts';

export interface ActionOutcome {
  ok: boolean;
  note: string;
  /** 这一条任务的动作到头了（成功或放弃）；调用方据此清 attempt、换下一条 */
  finished: boolean;
  /** 没做成（记 `failed`；与 `ok:false` 同义，单独留一格是为了读起来清楚） */
  failed?: boolean;
}

/** `click` 之后该走哪一步。`openUrl` 是特例：抓包里**只有 click**（点完就 SUCCESS）。 */
export function firstActionStep(key: string): string {
  switch (key) {
    case 'openUrl':
      return 'done';
    case 'loginPc':
    case 'uploadPhoto':
    case 'shareFile':
    case 'backup':
      return 'upload';
    case 'createNote':
      return 'note-auth';
    case 'aiCamera':
    case 'aiAssistant':
      return 'ai-mail-sso';
    case 'openAlbum':
      return 'smart-album';
    default:
      return 'done';
  }
}

function fail(note: string): ActionOutcome {
  return { ok: false, note, finished: true, failed: true };
}

function done(note: string): ActionOutcome {
  return { ok: true, note, finished: true };
}

function more(note: string): ActionOutcome {
  // 只是"下一步"，不是完成 —— `finished:false` 让调用方继续 drain
  return { ok: true, note, finished: false };
}

/** 把一步的结果收进 attempt：`step` 前进、`data` 合并。 */
function advance(a: PkAttempt, step: string, data?: Record<string, string>): void {
  a.step = step;
  if (data !== undefined) a.data = { ...(a.data ?? {}), ...data };
}

function send(deps: TaskDeps, req: BuiltRequest): RawTextResult {
  return callRawText(deps.transport, req);
}

/** 推进一步（**一次调用最多一发上游请求**）。 */
export function stepAction(deps: TaskDeps, s: PkSession, a: PkAttempt): ActionOutcome {
  const data = a.data ?? {};

  // ── 登记 / 预约 ───────────────────────────────────────────────────
  if (a.step === 'reserve') {
    const res = send(deps, reserveRequest(s, a.taskId, a.key, deps.baseUrl));
    if (!res.ok) return fail(`预约「${a.name}」没成：${res.error ?? '未知失败'}`);
    return done(`已预约「${a.name}」`);
  }

  if (a.step === 'click') {
    if (a.skipClick === true) {
      // 之前已经登记过（`currstep>=1`）：不再重复发写请求
      const next = firstActionStep(a.key);
      if (next === 'done') return done(`「${a.name}」已经登记过`);
      advance(a, next);
      return more(`「${a.name}」已经登记过 —— 下一步「${next}」`);
    }
    const res = send(deps, clickRequest(s, a.taskId, a.key, deps.baseUrl));
    if (!res.ok) return fail(`登记「${a.name}」没成：${res.error ?? '未知失败'}`);
    const next = firstActionStep(a.key);
    if (next === 'done') return done(`已点「${a.name}」—— 这一条只认点击`);
    advance(a, next);
    return more(`已登记「${a.name}」—— 下一步「${next}」`);
  }

  // ── 上传（loginPc / uploadPhoto / shareFile / backup 共用）─────────
  if (a.step === 'upload') return stepUpload(deps, a, data);

  // ── 快照三枪（backup 专用）───────────────────────────────────────
  if (a.step === 'snapshot-create') {
    const hash = contentHashOf(EMPTY_ZIP);
    const ts = depsNowMs(deps);
    const req = buildSnapshotCreateRequest({
      fileExtension: 'zip',
      count: 1,
      size: EMPTY_ZIP.length,
      contentHash: hash,
      timestampMs: ts,
    });
    const res = send(deps, req);
    if (!res.ok) return fail(`备份快照没建起来：${res.error ?? '未知失败'}`);
    const parsed = parseSnapshotCreate(res.text);
    if (!parsed.ok || !parsed.created) return fail(`备份快照响应解析不了：${parsed.error ?? ''}`);
    advance(a, parsed.created.rapidUpload ? 'snapshot-complete' : 'snapshot-put', {
      snapFileId: parsed.created.fileId,
      snapUploadId: parsed.created.uploadId,
      snapUploadUrl: parsed.created.uploadUrl,
      snapHash: hash,
      snapSize: String(EMPTY_ZIP.length),
      snapTs: String(ts),
    });
    return more('备份快照已声明 —— 下一步传快照体');
  }

  if (a.step === 'snapshot-put') {
    if (!data.snapUploadUrl || !data.snapUploadId) return fail('备份快照缺 uploadUrl/uploadId');
    const { req, leaksCredential } = buildPutRequest(data.snapUploadUrl, EMPTY_ZIP, 'snapshot');
    if (leaksCredential) return fail('备份快照的目标主机不该带凭据 ⇒ 不发');
    const res = send(deps, req);
    if (!res.ok) return fail(`备份快照体没传成：${res.error ?? '未知失败'}`);
    advance(a, 'snapshot-complete');
    return more('备份快照体已传 —— 下一步确认');
  }

  if (a.step === 'snapshot-complete') {
    if (!data.snapFileId || !data.snapHash) return fail('备份快照缺 fileId/contentHash');
    const req = buildSnapshotCompleteRequest({
      fileId: data.snapFileId,
      uploadId: data.snapUploadId ?? '',
      count: 1,
      contentHash: data.snapHash,
      size: Number(data.snapSize ?? EMPTY_ZIP.length),
      timestampMs: Number(data.snapTs ?? depsNowMs(deps)),
    });
    const res = send(deps, req);
    const parsed = res.ok ? parseSnapshotComplete(res.text) : { ok: false, error: res.error };
    if (!parsed.ok) return fail(`备份快照没确认：${parsed.error ?? '未知失败'}`);
    return done(`备份了一次文件（含快照）——「${a.name}」`);
  }

  // ── 分享外链（shareFile 上传之后）────────────────────────────────
  if (a.step === 'outlink') {
    const fileId = loadUpload(deps, STATE_TOKENPK_UPLOAD)?.fileId;
    if (fileId === undefined || fileId === '') return fail('分享文件：上传没有给出 fileId');
    const req = getOutLinkRequest(deps, [fileId]);
    if (req === undefined) return fail('分享文件：造不出外链请求（缺账号）');
    const res = send(deps, req);
    if (!res.ok) return fail(`分享文件：建外链没成（${res.error ?? '未知失败'}）`);
    return done(`分享了一个文件 ——「${a.name}」`);
  }

  // ── 云笔记（createNote）──────────────────────────────────────────
  if (a.step === 'note-auth') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    if (auth === undefined || auth.token === '') return fail('云笔记：这个号没有 authToken');
    const res = send(deps, noteAuthRequest(auth.token, auth.phone));
    if (!res.ok) return fail(`云笔记鉴权没成：${res.error ?? '未知失败'}`);
    const headers = parseNoteHeaders(res.text);
    if (headers === undefined) return fail('云笔记：鉴权响应里没有 headers.app_auth');
    const noteId = uuidV4().replace(/-/g, '').padEnd(32, '0').slice(0, 32);
    advance(a, 'note-create', {
      noteId,
      noteTitle: noteId.slice(0, 3),
      noteHeaders: JSON.stringify(headers),
    });
    return more('云笔记鉴权好了 —— 下一步建笔记');
  }

  if (a.step === 'note-create') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(data.noteHeaders ?? '{}') as Record<string, string>;
    } catch {
      headers = {};
    }
    const res = send(
      deps,
      noteCreateRequest(data.noteId ?? '', data.noteTitle ?? '', auth?.phone ?? '', headers, Date.now()),
    );
    advance(a, 'note-wait');
    return more(res.ok ? '云笔记已建 —— 等一下再删' : `建笔记没成（旧实现也忽略）：${res.error ?? ''}`);
  }

  if (a.step === 'note-wait') {
    // 参照实现 sleep 2 秒再删；测试里 `settleMs:0` 直接跳过
    waitMs(deps, deps.settleMs ?? 2000);
    advance(a, 'note-delete');
    return more('等好了 —— 下一步把笔记移进回收站');
  }

  if (a.step === 'note-delete') {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(data.noteHeaders ?? '{}') as Record<string, string>;
    } catch {
      headers = {};
    }
    const res = send(deps, noteDeleteRequest(data.noteId ?? '', headers));
    return done(res.ok ? `建了一条云笔记（已移进回收站）——「${a.name}」` : `云笔记删失败（旧实现也忽略）：${res.error ?? ''}`);
  }

  // ── 邮箱 AI 链（aiAssistant / aiCamera 共用前三步）──────────────────
  if (a.step === 'ai-mail-sso') {
    const res = send(deps, mailSpecTokenRequest(deps));
    if (!res.ok) return fail(`灵犀：换邮箱 SSO 没成（${res.error ?? '未知失败'}）`);
    const p = parseSsoToken(res.text);
    if (!p.ok || p.value === undefined) return fail(`灵犀：${p.error ?? '邮箱 SSO 响应里没有 token'}`);
    advance(a, 'ai-mail-login', { sso: p.value });
    return more('灵犀：邮箱 SSO 到手 —— 下一步登录邮箱');
  }

  if (a.step === 'ai-mail-login') {
    const res = send(deps, mailLoginRequest(data.sso ?? ''));
    if (!res.ok) return fail(`灵犀：邮箱登录没成（${res.error ?? '未知失败'}）`);
    const sess = parseMailSession(res.text);
    if (sess === undefined) return fail('灵犀：邮箱登录响应里没有 sid/rmkey');
    advance(a, 'ai-query', { sid: sess.sid, rmkey: sess.rmkey, cguid: newCguid() });
    return more('灵犀：邮箱登录好了 —— 下一步拿 AI 鉴权');
  }

  if (a.step === 'ai-query') {
    const res = send(
      deps,
      queryUserTokenRequest({ sid: data.sid ?? '', rmkey: data.rmkey ?? '' }, data.cguid ?? newCguid()),
    );
    if (!res.ok) return fail(`灵犀：queryUserToken 没成（${res.error ?? '未知失败'}）`);
    const tok = parseQueryUserToken(res.text);
    const auth = tok === undefined ? undefined : deriveAiAuth(tok);
    if (auth === undefined) return fail('灵犀：queryUserToken 没给全 account/token 或解不出手机号');
    const next = a.key === 'aiCamera' ? 'ai-recognize' : 'ai-chat';
    advance(a, next, {
      phone: auth.phone,
      authz: auth.authorization,
      domain: auth.userDomainId,
    });
    return more(`灵犀：AI 鉴权到手 —— 下一步${next === 'ai-recognize' ? '拍照识图' : '对话'}`);
  }

  if (a.step === 'ai-chat') {
    const res = send(deps, aiChatRequest(data.authz ?? '', data.domain ?? '', '你好'));
    const sse = res.ok ? parseSse(res.text) : { events: 0, text: '' };
    // ⚠ 没回话**不判死**：与 App 任务 609 同一条口径（成败看服务端认不认）
    return done(
      sse.events > 0 && sse.text !== ''
        ? `和灵犀聊了一句（${sse.text.slice(0, 12)}…）——「${a.name}」`
        : `灵犀对话没取到输出（events=${sse.events}）——「${a.name}」记下，等服务端认`,
    );
  }

  if (a.step === 'ai-recognize') {
    const native = parseAuth(loadAuthRaw(deps.store))?.raw ?? '';
    const tid = uuidV4().replace(/-/g, '').slice(0, 16);
    const res = send(deps, aiRecognizeRequest(native, data.domain ?? '', tid, s.deviceId ?? ''));
    const rec = res.ok ? parseAiRecognize(res.text) : undefined;
    if (rec === undefined || !rec.success || rec.fileId === undefined) {
      return fail(`AI 相机识图没成：${rec?.message ?? res.error ?? '没有 fileId'}`);
    }
    advance(a, 'ai-camera-chat', { fileId: rec.fileId, camTaskId: rec.taskId ?? '' });
    return more('AI 相机识图好了 —— 下一步对话');
  }

  if (a.step === 'ai-camera-chat') {
    const native = parseAuth(loadAuthRaw(deps.store))?.raw ?? '';
    const tid = uuidV4().replace(/-/g, '').slice(0, 16);
    const res = send(
      deps,
      aiCameraChatRequest(native, data.domain ?? '', data.fileId ?? '', data.camTaskId ?? '', tid),
    );
    const sse = res.ok ? parseSse(res.text) : { events: 0, text: '' };
    return done(
      sse.events > 0 || sse.text !== ''
        ? `拍了一张问 AI（events=${sse.events}）——「${a.name}」`
        : 'AI 相机对话没取到输出 —— 记下，等服务端认',
    );
  }

  // ── 开启智能相册（openAlbum）──────────────────────────────────────
  if (a.step === 'smart-album') {
    const res = send(deps, smartAlbumRequest(s, deps.baseUrl));
    if (!res.ok) return fail(`开启智能相册没成（${res.error ?? '未知失败'}）`);
    return done(`开启了智能相册 ——「${a.name}」`);
  }

  // `done` 是终局（调用方在 finished 之后不会再进来）；留一条兜底避免死循环
  return done(`「${a.name}」没有更多动作`);
}

/** 上传那一步：**一次调用**里先"起一个"（0 请求）再推进一步（1 请求）。
 *
 *  ⚠ 起上传这一步不能单独占一次调用：`runUploadStep` 在没有排队上传时回 `idle`，
 *  而 `drain` 见到 `idle` 就收工 —— 表现是"文件一步都没传"却当成做完了。 */
function stepUpload(deps: TaskDeps, a: PkAttempt, data: Record<string, string>): ActionOutcome {
  const key = STATE_TOKENPK_UPLOAD;
  const jpg = a.key === 'uploadPhoto' || a.key === 'backup';
  const seed = data.uploadSeed ?? randomHex(16);
  const bytes = jpg ? sampleJpeg() : deterministicFile(seed, 256);
  const name =
    a.key === 'backup'
      ? `tokenpk-backup-${randomHex(6)}.jpg`
      : a.key === 'uploadPhoto'
        ? `tokenpk-photo-${randomHex(6)}.jpg`
        : `tokenpk-${a.key}-${randomHex(6)}.bin`;

  let up = loadUpload(deps, key);
  // ⚠ 槽位是这一族共用的：上一条任务（比如 backup）传了一半就失败，留下的半截
  //   会被下一条（比如 shareFile）当成"自己的"接着传 —— 种子不同就说明不是这一条。
  if (up !== null && up.seed !== seed) {
    clearUpload(deps, key);
    up = null;
  }
  if (up === null || up.step === 'done') {
    clearUpload(deps, key);
    startUpload(deps, {
      name,
      bytes,
      seed,
      renameMode: 'force_rename',
      op: a.key === 'backup' ? 'backup' : 'upload',
      channel: a.key === 'loginPc' ? 'pc' : 'android',
      key,
    });
    advance(a, 'upload', { uploadSeed: seed });
  }
  const out = runUploadStep(deps, bytes, key);
  if (!out.ok) return fail(`上传「${a.name}」没成：${out.note}`);
  if (!uploadDone(deps, key)) return more(`上传中 —— ${out.note}`);
  const fileId = loadUpload(deps, key)?.fileId ?? '';
  if (a.key === 'shareFile') {
    advance(a, 'outlink', fileId === '' ? {} : { fileId });
    return more('文件传完了 —— 下一步建外链');
  }
  if (a.key === 'backup') {
    advance(a, 'snapshot-create');
    return more('备份文件已传 —— 下一步触发快照');
  }
  return done(`${a.key === 'loginPc' ? '用 PC 档传了一个文件' : '上传了一张照片'} ——「${a.name}」`);
}

/** 领奖那一发（独立于动作：`SUCCESS` 的任务才走这里）。 */
export function claimAction(
  deps: TaskDeps,
  s: PkSession,
  taskId: number,
  name: string,
): { ok: boolean; note: string; prizes: string[] } {
  const res = callRawText(deps.transport, receiveRequest(s, taskId, deps.baseUrl));
  if (!res.ok) return { ok: false, note: `领奖「${name}」没成：${res.error ?? '未知失败'}`, prizes: [] };
  const env = parsePk(res.text);
  if (!env.ok) {
    return { ok: false, note: `领奖「${name}」没成：服务端说 ${env.message || `code=${env.code}`}`, prizes: [] };
  }
  const out = parseClaim(env.result);
  if (out.prizes.length === 0 && out.failures.length === 0) {
    // `code=0` 但 `allSuccess=false`、又不给奖品/原因：不能当成功（那是"看着像领了"）
    if (!out.allSuccess) {
      return { ok: false, note: `领奖「${name}」没成：服务端 code=0 但 allSuccess=false`, prizes: [] };
    }
    return { ok: true, note: `领奖「${name}」：服务端说成功（没报奖品名）`, prizes: [] };
  }
  if (out.failures.length > 0 && out.prizes.length === 0) {
    return { ok: false, note: `领奖「${name}」没到：${out.failures.join('；')}`, prizes: [] };
  }
  const suffix = out.failures.length > 0 ? `（另有 ${out.failures.length} 项没到：${out.failures.join('；')}）` : '';
  return { ok: true, note: `领取「${name}」→ ${out.prizes.join('、')}${suffix}`, prizes: out.prizes };
}
