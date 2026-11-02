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
//
// # 「已完成」的判据是**备份真的开了**，不是"步骤走完了"
//
// 现场（2026-11-01，三个号都一样）：快照那一枪被上游打回 `04000003`，
// 而当时的实现照样把这一步写进 `done` —— 数据页于是显示
// 「本月备份：未开启（任务拓展：已完成）」，一句自相矛盾的话。
//
// 现在收尾分三档（见 {@link ExpandStep}）：
//   · `done`    —— 复查**读到** `curMonthBackup === true`（或本来就不用凑）
//   · `blocked` —— 凑过了、复查仍读到 `false`（或快照没建上），**没成**
//   · `unknown` —— 复查那一次**读不到**这一格，判不了
// 后两档都**不是**当天的完成标记：Auto **不再重传文件**（省得一天传一堆），
// 但每趟仍做一次**只读复查**（一个 GET，见 `retryMode`）—— 备份是上游自己记账的，
// 但手动「现在跑一次」可以再来一次 —— 这是"逐步判断和修复"要的那个口子。


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
import { parseTrashResult, trashRequest } from './cloudTrash.ts';
import { unregisterOwnedFile } from './ownedFiles.ts';
import { loadSession } from '../../store/types.ts';
import { depsNowMs, waitMs } from './base.ts';
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

/** 任务拓展**自己的**上传槽位。
 *
 *  ⚠ 与 App 任务分开（App 任务用的是 `mcloud.upload.state`）。原来两条任务共用一格，
 *  `uploadDone()` 只问"这格是不是 done" ⇒ 后跑的那条会把前一条的游标覆盖掉，
 *  两条任务互相把对方的上传当成自己的（现场 2026-11-01：三个号的格子里都躺着
 *  App 任务的 `asign-*.bin`，而任务拓展记的是另一个 fileId —— 谁传的判不出来）。
 *  槽位按任务分之后，两边的证据才各自成立，才能一条一条判。 */
export const STATE_UPLOAD_EXPANSION = 'mcloud.upload.state.expansion';

/** 上传完到复查之间等多久（毫秒）。等的是"服务端把这一次备份记进当月"。
 *
 *  ⚠ 参考实现是 20 秒（`backup_wait_secs || 20`）；面板是同步沙箱，等待
 *  走 `waitMs`（硬上限 10 秒），所以这里取 5 秒 —— 与 App 任务的 `settleMs`
 *  同一条口径：**测试传 0**，生产缺省 5 秒。 */
const BACKUP_WAIT_MS = 5000;

export type ExpandStep =
  | 'read'
  | 'upload'
  | 'snapshot-create'
  | 'snapshot-put'
  | 'snapshot-complete'
  /** 快照发完了，等一会儿再复查（上游记账不是同一瞬间）。 */
  | 'wait'
  | 'recheck'
  | 'cleanup'
  /** ✅ 复查**读到**备份已开启（或本来就不用凑）—— 今天的完成标记。 */
  | 'done'
  /** ❌ 凑过了、复查仍读到未开启（或快照没建上）—— 当天不再自动重试。 */
  | 'blocked'
  /** ❓ 复查那一次没读到这一格 —— 判不了，同样不自动重试。 */
  | 'unknown';

interface ExpandState {
  step: ExpandStep;
  /** 这一趟属于哪一天（`YYYY-MM-DD`）。跨天/老状态没有这一格 ⇒ 重新起。 */
  day?: string | undefined;
  /** ① 读到的四样（用于文案与“下月可领”）。 */
  curMonthBackup?: boolean | undefined;
  curMonthTaskRecordCount?: number | undefined;
  nextMonthTaskRecordCount?: number | undefined;
  /** 这一趟**凑过**（起过上传）—— 决定收尾是 done 还是 blocked。 */
  attempted?: boolean | undefined;
  /** 复查那一次的读数（`true`/`false`/`undefined`）。收尾只看它，不看"步骤走完没"。 */
  backupOn?: boolean | undefined;
  /** 没成的那一句原因（给界面/运行记录用：为什么 blocked/unknown）。 */
  blockedWhy?: string | undefined;
  /** 这一趟是**只读复查**（上一趟已经传过文件了，这一趟不再传）。 */
  retryMode?: 'recheck' | undefined;
  /** 那个我们自己造的文件**已经清过了** —— 复查那一趟不许再拿同一个 id 去删。 */
  cleanupDone?: boolean | undefined;
  /** 等待复查的时刻（毫秒）。跨调用活着，被打断也不会把 5 秒缩成 0。 */
  waitAt?: number | undefined;
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
  wait: '②b 等移动云盘记账',
  recheck: '②b 再过一遍状态',
  cleanup: '③ 清理自己传的文件',
  done: '完成',
  blocked: '没成',
  unknown: '判不了',
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

/** 今天这一趟还在用、**不能提前收尾**的文件 id。
 *
 *  链尾兜底清理会跳过它：上传完 → 快照还没走完时把文件删掉，下一趟就没有触发备份的
 *  那一枚了。跨天/已走完的状态不算（那才是该清的遗留）。 */
export function activeExpansionFileId(deps: TaskDeps): string | undefined {
  const st = load(deps);
  if (st === null) return undefined;
  if (st.day !== deps.nowIso.slice(0, 10)) return undefined;
  // 三档终局都不再"还在用"：done 是走完了，blocked/unknown 是当天收手了（文件已清）。
  if (st.step === 'done' || st.step === 'blocked' || st.step === 'unknown') return undefined;
  return st.uploadOwned === true ? st.uploadFileId : undefined;
}

/** 起一趟（**一个请求都不发**）。
 *
 *  ⚠ 每天都要能重新起：`done` 是**当天**的完成标记，不是永久标记。
 *  老状态没有 `day`（或跨天）⇒ 重新起；同一天还在走 ⇒ 不重置；同一天已走完 ⇒ idle。
 *
 *  ⚠ `blocked` / `unknown` **不是**完成标记：那天不再自动重试（省得每趟都往网盘
 *  传一个凑数的文件），但**手动**那一趟（`lateMs < 0`，见 base.ts 的 F-001 那条）
 *  可以再来一次 —— 用户在 App 里开了自动备份之后，"现在跑一次"就该真的重跑。 */
export function startExpansion(deps: TaskDeps): TaskOutcome {
  const day = deps.nowIso.slice(0, 10);
  const cur = load(deps);
  const manual = (deps.lateMs ?? 0) < 0;
  if (cur && cur.day === day) {
    // ⚠ `done` 也要看**目标**：旧版本（2026-11-01 之前）快照失败也写 done，
    //   库里那些"已完成"并没有证明备份开了。拿 `backupOn` 复核；
    //   老状态没有这一格就看 `curMonthBackup`。
    const goal = cur.backupOn ?? cur.curMonthBackup;
    if (cur.step === 'done' && goal === true) return { ok: true, idle: true, note: '今天这一趟已经走完' };
    if (cur.step === 'done' || cur.step === 'blocked' || cur.step === 'unknown') {
      const why =
        cur.blockedWhy ??
        (goal === false ? '上一趟记下的读数是「未开启」' : '上一趟没记下复查读数');
      if (manual) {
        save(deps, { step: 'read', day });
        return { ok: true, note: `手动再来一次：再读一遍，需要时重新凑一次 —— ${why}` };
      }
      // 自动那趟：**只读复查**（一个 GET），不再传文件。
      //  ⚠ 别整天不看了：备份是**上传之后上游自己记账**的 —— 现场 2026-11-01
      //  12:52 那次传完读到 `false`，13:40 再读就是 `true`（中间没人做任何事）。
      //  所以"今天没成"不能等于"今天不再看"。
      // ⚠ 旧版本写下的 `done` 走过 cleanup（文件已清）⇒ 复查时不能再删一遍
      //   （同一个 id 再 trash 会被回"文件不存在"，把干净的复查染成失败）。
      const cleaned = cur.step === 'done' ? true : cur.cleanupDone;
      // `attempted: true` —— 这一趟**只读**：今天已经试过了，别在读那一步又起一次上传。
      save(deps, { ...cur, step: 'read', retryMode: 'recheck', cleanupDone: cleaned, attempted: true });
      return { ok: true, note: '上一趟没成，这一趟只复查（不再传文件）' };
    }
    return { ok: true, note: '今天这一趟还在走，接着推' };
  }
  save(deps, { step: 'read', day });
  return { ok: true, note: '已排队：读状态 → （需要时）传文件+快照触发备份 → 清理' };
}

/** 复查之后等多久（毫秒）。测试传 `settleMs: 0` ⇒ 不真等。 */
function backupWaitMs(deps: TaskDeps): number {
  return deps.settleMs ?? BACKUP_WAIT_MS;
}

/** 起一次"凑备份"的上传（只写字、不发请求）。**任务拓展自己的槽位**。 */
function startExpansionUpload(deps: TaskDeps): TaskOutcome {
  // ⚠ 文件**随机**（名字 + 内容）：固定内容会命中秒传，固定名字会撞用户文件；
  //    mcloud 的 task_expansion 就是随机名 + 随机字节。
  const seed = randomHex(16);
  return startUpload(deps, {
    name: `${randomHex(8)}.bin`,
    bytes: deterministicFile(seed, 256),
    seed,
    // 备份支：按路径定位根目录 + refuse_duplicate_content + parallelUpload。
    locateKey: 'parentPath',
    locateValue: '/',
    renameMode: RENAME_REFUSE_DUPLICATE_CONTENT,
    parallelUpload: true,
    localCreatedAt: deps.nowIso,
    op: 'backup',
    key: STATE_UPLOAD_EXPANSION,
  });
}

/** 上传完了 ⇒ 下一步（建快照 / 等一会儿再复查）。两个出口共用。 */
function afterUpload(deps: TaskDeps, st: ExpandState, label: string): TaskOutcome {
  const up = loadUpload(deps, STATE_UPLOAD_EXPANSION);
  const owned = up?.ownedByUs;
  // 撞上用户已有同名文件 / exist 判不了 ⇒ 不建快照、也不清理；只去复查+收尾。
  const step: ExpandStep = owned === true ? 'snapshot-create' : 'wait';
  save(deps, {
    ...st,
    step,
    uploadFileId: up?.fileId,
    uploadOwned: owned,
    waitAt: owned === true ? undefined : depsNowMs(deps) + backupWaitMs(deps),
  });
  const why =
    owned === true
      ? '文件已传完'
      : owned === false
        ? '撞上已有同名文件（不是我们造的，不覆盖、不删）'
        : '文件已传完，但 exist 判不了（按不是我们造的算，不删）';
  return { ok: true, note: `${label}：${why} —— 下一步${owned === true ? '建快照' : '等一会儿再复查'}` };
}

/** 收尾判据：`done` 只在**复查真的读到备份已开启**时成立。
 *
 *  这是「本月备份：未开启（任务拓展：已完成）」那句自相矛盾的话的根治处：
 *  `done` 以前是"步骤走完了"，现在是"目标达成了"。 */
function verdictOf(st: ExpandState): { step: ExpandStep; why: string } {
  // ⚠ 与 `startExpansion` 的 `goal = cur.backupOn ?? cur.curMonthBackup` **同一判据**：
  //   进程在"读完"和"清理完"之间被杀时，状态里可能只有 `curMonthBackup`，
  //   只认 `backupOn` 会把"明明读到了已开启"判成 `unknown`（评审 2026-11-01）。
  const on = st.backupOn ?? st.curMonthBackup;
  if (on === true) return { step: 'done', why: '' };
  const bits: string[] = [];
  if (on === false) {
    bits.push(st.attempted === true ? '凑过一次备份，重读仍是「未开启」' : '重读仍是「未开启」');
  } else {
    bits.push('重读时没读到本月备份状态');
  }
  if (st.snapError !== undefined && st.snapError !== '') bits.push(`快照没建上：${st.snapError}`);
  if (st.uploadOwned === false) bits.push('撞上你已有的同名文件（没覆盖、也没删）');
  return { step: on === undefined ? 'unknown' : 'blocked', why: bits.join('；') };
}

/** 推进一步，一次调用一个请求。 */
/** 这个号**本月备份开没开** —— 只读，给「App 任务状态」那一步补一句用。
 *
 *  判据与 `verdictOf` 一致：先看 `backupOn`（本次复查读到的），再回落到
 *  `curMonthBackup`（读数那一格）。`undefined` = 还没读到，**不要**当成"没开"。 */
export function readBackupOn(store: { getState(k: string): string | null | undefined }): boolean | undefined {
  const raw = store.getState(STATE_EXPAND);
  if (!raw) return undefined;
  try {
    const st = JSON.parse(raw) as { backupOn?: unknown; curMonthBackup?: unknown };
    if (typeof st.backupOn === 'boolean') return st.backupOn;
    return typeof st.curMonthBackup === 'boolean' ? st.curMonthBackup : undefined;
  } catch {
    return undefined;
  }
}

export function runExpansionStep(deps: TaskDeps): TaskOutcome {
  let st = load(deps) ?? { step: 'read' as ExpandStep };

  if (st.step === 'done') return { ok: true, idle: true, note: '这一趟已经走完' };
  const label = STEP_TEXT[st.step];

  // 到了两档终局（不是这一趟该做的事）：把原因原样交回去。
  //  ⚠ 这两档**不是**失败重跑的口子：当天已经下过结论了，下一趟只是复述。
  if (st.step === 'blocked' || st.step === 'unknown') {
    return {
      ok: true,
      skipped: true,
      idle: true,
      note: st.blockedWhy === undefined || st.blockedWhy === '' ? label : st.blockedWhy,
    };
  }

  // ② 交给上传那台状态机（它自己知道下一步是 create 还是 put 还是 complete）。
  //  ⚠ 用**任务拓展自己的槽位**（见 STATE_UPLOAD_EXPANSION）：与 App 任务那一格分开，
  //    否则 `uploadDone()` 会把对方传完的文件当成自己传完了。
  if (st.step === 'upload') {
    if (uploadDone(deps, STATE_UPLOAD_EXPANSION)) return afterUpload(deps, st, label);
    const out = runUploadStep(deps, undefined, STATE_UPLOAD_EXPANSION);
    if (uploadDone(deps, STATE_UPLOAD_EXPANSION)) return afterUpload(deps, st, label);
    if (out.idle) {
      // 槽位是空的（从没起 / 被清掉）⇒ **重新起一个**，绝不能当成"传完了"：
      // 那会让后面去建一个没有触发过备份的快照，而日志说"文件已传完"。
      startExpansionUpload(deps);
      return { ok: true, note: `${label}：上传状态没了 ⇒ 重新起一个（不是传完了）` };
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
      return { ok: true, note: `${label}：没成（${res.error ?? '未知失败'}）—— 照实记下，继续复查` };
    }
    const parsed = parseSnapshotCreate(res.text);
    if (!parsed.ok || !parsed.created) {
      save(deps, { ...st, step: 'recheck', snapError: parsed.error ?? '快照响应解析不了' });
      return { ok: true, note: `${label}：没成（${parsed.error ?? '响应解析不了'}）—— 照实记下，继续复查` };
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
      return { ok: true, note: `${label}：没成（状态缺 uploadUrl/uploadId）—— 照实记下，继续复查` };
    }
    const { req } = buildPutRequest(st.snapUploadUrl, EMPTY_ZIP, 'snapshot');
    const res = callRawText(deps.transport, req);
    if (!res.ok) {
      save(deps, { ...st, step: 'recheck', snapError: `快照 PUT 失败：${res.error ?? '未知失败'}` });
      return { ok: true, note: `${label}：没成（${res.error ?? '未知失败'}）—— 照实记下，继续复查` };
    }
    save(deps, { ...st, step: 'snapshot-complete' });
    return { ok: true, note: `${label}：快照体已传完 —— 下一步确认` };
  }

  if (st.step === 'snapshot-complete') {
    if (!st.snapFileId || !st.snapHash) {
      save(deps, { ...st, step: 'recheck', snapError: '快照状态缺 fileId/contentHash' });
      return { ok: true, note: `${label}：没成（状态缺 fileId/contentHash）—— 照实记下，继续复查` };
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
    if (!parsed.ok) {
      save(deps, { ...st, step: 'recheck', snapError: parsed.error });
      return { ok: true, note: `${label}：没成（${parsed.error ?? '未知失败'}）—— 照实记下，继续复查` };
    }
    // ✅ 快照三枪都成了 ⇒ **等一会儿**再复查（上游记账不是同一瞬间）。
    const waitAt = depsNowMs(deps) + backupWaitMs(deps);
    save(deps, { ...st, step: 'wait', snapError: undefined, waitAt });
    return { ok: true, note: `${label}：快照已确认 —— 等 ${backupWaitMs(deps)}ms 再看备份开没开` };
  }

  if (st.step === 'wait') {
    const wait = (st.waitAt ?? 0) - depsNowMs(deps);
    if (wait > 0) waitMs(deps, wait);
    save(deps, { ...st, step: 'recheck', waitAt: undefined });
    return { ok: true, note: `${label}：等满了（${Math.max(0, wait)}ms）—— 下一步复查` };
  }

  if (st.step === 'cleanup') {
    const fileId = st.uploadFileId;
    const v = verdictOf(st);
    // 只读复查那一趟：没翻成 `true` 也只是"还没记账"，不该再染一次红
    //（当天第一次已经如实报过没成了）。
    const soft = st.retryMode === 'recheck' && v.step !== 'done';
    const finish = (note: string): TaskOutcome => {
      save(deps, { ...st, step: v.step, blockedWhy: v.why, retryMode: undefined });
      return { ok: v.step === 'done' || soft, skipped: soft, note };
    };
    if (st.uploadOwned !== true || !fileId || st.cleanupDone === true) {
      return finish(
        v.step === 'done'
          ? `${label}：没有该由我们清的文件（不是我们造的 / 判不了 / 上一趟已经清过）`
          : // ⚠ 结算这句**先说结论**：它会原样进用户日志（userLine 只剥掉步骤名前缀），
            //   "③ 清理自己传的文件：…" 那种开头会让人以为失败的是清理。
            soft
            ? `复查仍是「未开启」（${v.why}）—— 下一趟再读`
            : `备份仍未开启（${v.why}）—— 上传已发，下一趟再读`,
      );
    }
    const res = callRawText(deps.transport, trashRequest([fileId]));
    // ⚠ 清失败**不推进游标**：文件还在网盘里，下一趟要接着清（链尾那一枪也还留着它）。
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}（文件先留着，下一趟再清）` };
    const parsed = parseTrashResult(res.text);
    if (!parsed.ok) return { ok: false, note: `${label}被拒：${parsed.why}（文件先留着，下一趟再清）` };
    // 确认删掉了才从兜底名单里注销；否则留给链尾那一枪重试。
    unregisterOwnedFile(deps, fileId);
    // 记下"这枚已经清过"：只读复查那趟再走到 cleanup 时不能拿同一个 id 再删一次
    //（那会被上游回一句"文件不存在"，把一次干净的复查染成失败）。
    st = { ...st, cleanupDone: true };
    if (v.step === 'done') return finish(`${label}：已移进回收站`);
    return finish(
      soft
        ? `复查仍是「未开启」（${v.why}）—— 下一趟再读`
        : `备份仍未开启（${v.why}）—— 上传已发，下一趟再读`,
    );
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
      // 复查那一次的读数就是**收尾判据**（不是"步骤走完"）。
      backupOn: read.curMonthBackup,
      curMonthTaskRecordCount: read.curMonthTaskRecordCount,
      nextMonthTaskRecordCount: read.nextMonthTaskRecordCount,
    };

    if (st.step === 'read' && shouldUpload(read) && st.attempted !== true) {
      // ⚠ 严格读到 false 才传（见 shouldUpload）。
      //    文件**随机**（名字 + 内容）：固定内容会命中秒传，固定名字会撞用户文件；
      //    mcloud 的 task_expansion 就是随机名 + 随机字节。
      save(deps, { ...next, step: 'upload', attempted: true });
      startExpansionUpload(deps);
      return { ok: true, note: `${label}：本月**未开启备份** ⇒ 传一个文件把它做出来 —— 下一步开始传` };
    }
    save(deps, next);
    const tail =
      read.nextMonthTaskRecordCount === undefined ? '' : `；下月可领 ${read.nextMonthTaskRecordCount} 个`;
    const only = st.attempted === true ? '（这一趟只复查，不再传文件）' : '';
    return {
      ok: true,
      note: `${label}：备份=${read.curMonthBackup === undefined ? '没读到' : String(read.curMonthBackup)}，可领次数=${read.curMonthTaskRecordCount ?? '没读到'}${tail}${only} —— 下一步清理`,
    };
  }

  return { ok: false, note: `${label}：不认识的步骤` };
}

function withBase(deps: TaskDeps, path: string): string {
  // ⚠ 空串必须当成"没给"（见 `hostBase` 那段说明）
  return `${hostBase(deps, MCLOUD_HOST)}${path}`;
}
