// 本账号「我们造的文件」登记表 —— 日常链尾兜底清理的依据。
//
// # 为什么要多一张表
//
// 上传状态机只记得**这一次**传的是什么（`mcloud.upload.state` 一个格子）。
// 任务自己收尾时会把它删掉，但下面三种情况会漏：
//   · 上传完、链路还没走到收尾就被打断（超时 / 步数用完）；
//   · 跨天：`task-expansion` 把状态重置成 `read`、`app-task` 重建状态对象，
//     昨天的 `fileId` 就没了；
//   · 某条路径本来就没收尾（PDF / 分享，已单独接上）。
// 参考实现的 `ctx.state.files` 是同一用途：任务只管传，`afterTask` 按 list 统一删。
//
// # 只登记 `ownedByUs === true`
//
// 撞上用户已有文件（`exist:true`）那一档**绝不进来**；`undefined`（判不了）也
// 按不删处理。这条纪律与 `upload.ts` / `cloudTrash.ts` 一致：宁可留一个我们传的
// 文件，也不能删用户的。
//
// # 清理成功才注销
//
// `batchTrash` 可能 HTTP 200 但 `success:false`。收尾成功后调用方要显式
// `unregisterOwnedFile`；这里链尾清理也只在响应确认成功时清空 list。
// 没成的那一份留着，下一趟日常继续试。

import { callRawText } from '../client.ts';
import { parseTrashResult, trashRequest } from './cloudTrash.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_OWNED_FILES = 'mcloud.cloud.owned';

function load(deps: TaskDeps): string[] {
  const raw = deps.store.getState(STATE_OWNED_FILES);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x !== '');
  } catch {
    // 坏 JSON 当空表：宁可少一份兜底名单，也不要让整趟日常在收尾时炸掉。
    return [];
  }
}

function save(deps: TaskDeps, ids: readonly string[]): void {
  deps.store.setState(STATE_OWNED_FILES, JSON.stringify(ids), deps.nowIso);
}

/** 登记一个我们自己造的 fileId（幂等）。 */
export function registerOwnedFile(deps: TaskDeps, fileId: string | undefined): void {
  if (fileId === undefined || fileId === '') return;
  const ids = load(deps);
  if (ids.includes(fileId)) return;
  save(deps, [...ids, fileId]);
}

/** 收尾成功后注销（幂等）。 */
export function unregisterOwnedFile(deps: TaskDeps, fileId: string | undefined): void {
  if (fileId === undefined || fileId === '') return;
  const ids = load(deps);
  const next = ids.filter((x) => x !== fileId);
  if (next.length !== ids.length) save(deps, next);
}

/** 当前待清理名单（诊断/测试用）。 */
export function ownedFileIds(deps: TaskDeps): string[] {
  return load(deps);
}

/** 链尾兜底清理：一次 `batchTrash`，成功才清掉已经删掉的那些。
 *
 *  `opts.skip` 是**今天这一趟还在用**的 fileId（见 `activeAppTaskFileId` /
 *  `activeExpansionFileId`）：任务还没走到收尾，文件删了下一趟就用不了。
 *  它们留在名单里，等状态跨天/收摊后再清。
 */
export function runOwnedCleanup(
  deps: TaskDeps,
  opts: { skip?: readonly string[] | undefined } = {},
): TaskOutcome {
  const all = load(deps);
  const skip = new Set(opts.skip ?? []);
  const ids = all.filter((id) => !skip.has(id));
  if (ids.length === 0) {
    return {
      ok: true,
      idle: true,
      note: skip.size > 0 ? `没有要清理的文件（${skip.size} 个还在任务里用）` : '没有要清理的文件',
    };
  }

  const res = callRawText(deps.transport, trashRequest(ids));
  if (!res.ok) {
    return {
      ok: false,
      note: `清理 ${ids.length} 个文件没成 —— ${res.error ?? '请求失败'}（下一趟再试）`,
    };
  }
  const parsed = parseTrashResult(res.text);
  if (!parsed.ok) {
    return {
      ok: false,
      note: `清理 ${ids.length} 个文件被拒 —— ${parsed.why}（下一趟再试）`,
    };
  }
  // 只从名单里移除**这次确认删掉的**；还在用的那些留着。
  save(deps, all.filter((id) => skip.has(id)));
  const tail = skip.size > 0 ? `；${skip.size} 个还在任务里用，没动` : '';
  return { ok: true, note: `已把 ${ids.length} 个自己传的文件移进回收站${tail}` };
}
