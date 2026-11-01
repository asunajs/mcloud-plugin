// 云盘收尾：把**我们自己造的**文件移进回收站。
//
// ⚠ 只允许传我们自己造的 fileId（撞同名那一档是用户的文件，绝不能进来）。
// ⚠ 空数组**不发** —— 上游对空 fileIds 的行为没有读数，发了就是白打一枪。
// ⚠ 这一口在云盘主机（personal-kd-njs.yun.139.com）上，要云盘族的头；
//    Authorization 由传输层按主机注入。

import { cloudFileOpHeaders } from '../cloudUpload.ts';
import type { BuiltRequest } from '../h5.ts';

export const BATCH_TRASH_URL =
  'https://personal-kd-njs.yun.139.com/hcy/recyclebin/batchTrash';

export function trashRequest(fileIds: string[]): BuiltRequest {
  if (fileIds.length === 0) throw new Error('batchTrash 不许发空 fileIds');
  return {
    url: BATCH_TRASH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cloudFileOpHeaders('upload') },
    body: JSON.stringify({ fileIds }),
  };
}

/** 收尾响应是不是**真的成了**（HTTP 200 不够）。
 *
 *  真机这一口的信封是**字符串 code + `success`**（与 `rabactive/*` 那套不同）；
 *  只看 HTTP 会把「被拒」记成已清理，然后把它从登记表里注销掉 —— 文件就留在
 *  用户网盘里再也没人认领。解不出也按没成处理（宁可下一趟重试）。 */
export function parseTrashResult(text: string): { ok: boolean; code: string; why: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, code: '', why: '响应不是 JSON' };
  }
  const code = typeof v.code === 'string' ? v.code : String(v.code ?? '');
  const ok = v.success === true || code === '0000' || code === '0';
  const msg = typeof v.msg === 'string' ? v.msg : '';
  return { ok, code, why: ok ? '' : `code=${code}${msg === '' ? '' : ` ${msg}`}` };
}
