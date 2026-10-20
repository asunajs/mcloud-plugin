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
