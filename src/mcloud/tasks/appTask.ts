// `app-task` 的**动作层**：把 App 任务矩阵里能做的做掉。判据在 `appTaskRules.ts`（纯函数）。
//
// # 一枪一步
//
// 每条待办要走的腿：`upload`（需要时才走，本身是三枪）→ `click` → `trash`（收尾）。
// 面板一次调用只给一个请求的预算，所以这里也是可恢复状态机，游标是
// `(groupIdx, itemIdx, phase)`。
//
// # ⚠ 为什么读的那半不在这里
//
// 只读那一半是**另一个 code**（`app-task-matrix`）：拿一个 code 做两件事会让它在
// 两处指不同的东西。所以本文件**消费**矩阵的读数（`readMatrix`），不自己读矩阵。
//
// # ⚠ 收尾不是可选项
//
// 这一族为了过"名字门/按钮门"会**往用户网盘传文件**。传完不收拾，用户网盘里就会
// 慢慢堆出一堆垃圾 —— mcloud 的取向是**自己收尾**（移进回收站）。本文件照办。
//
// # 三条不该发的边界
//
// ① `task/click` **不可回滚** ⇒ 同一轮里**不重发**（发过就记下来）
// ② `batchTrash` **不许发空的 `fileIds`**（mcloud 专门记了这条：忘了挡的表现是发一枪
//   `{"fileIds":[]}` 出去，而上游回什么**没有样本**）
// ③ 判据说"不做"的（`SKIP_TASK_LIST`）**一枪都不发**

import { callRawText } from '../client.ts';
import { sessionHeaders } from './base.ts';
import { REFERER_SIGN_IN, SHOW_LOADING, buildH5Request } from '../h5.ts';
import { loadSession } from '../../store/types.ts';
import { judgeItem, readMatrix } from './appTaskMatrix.ts';
import { runUploadStep, startUpload, uploadDone } from './upload.ts';
import { deterministicFile } from '../cloudUpload.ts';
import { shouldSkip, uploadShapeFor } from '../appTaskRules.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_TASK = 'mcloud.apptask.state';

/** 「开启通知」那条链上的打卡口 —— ⚠ **GET 却是写**，而且主机**带端口**。 */
export const CLICK_HOST = 'https://caiyun.feixin.10086.cn:7071';
export const CLICK_PATH = '/ycloud/signin/task/click';

/** 收尾：批量移进回收站。 */
export const BATCH_TRASH_URL = 'https://personal-kd-njs.yun.139.com/hcy/recyclebin/batchTrash';

export type TaskPhase = 'upload' | 'click' | 'trash';

interface TaskState {
  gi: number;
  ii: number;
  phase: TaskPhase;
  itemId: number;
  /** 本轮为这条任务传上去的文件 id（收尾要用）。**没有就不发收尾那一枪。** */
  fileId?: string | undefined;
  /** 已经点过的那条（防同一轮重发 —— `task/click` 不可回滚）。 */
  clicked: number[];
}

const PHASE_TEXT: Record<TaskPhase, string> = {
  upload: '传文件（过名字门/按钮门）',
  click: '打卡（不可回滚）',
  trash: '收尾（移进回收站）',
};

/** 打卡那一枪。⚠ GET + 查询参数 `key=task&id=<id>`（实拍逐字）。 */
export function clickRequest(deps: TaskDeps, id: number): ReturnType<typeof buildH5Request> {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: `${CLICK_HOST}${CLICK_PATH}?key=task&id=${id}`,
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

/** 收尾那一枪。⚠ **空数组不发**（见文件头 ②）。 */
export function trashRequest(deps: TaskDeps, fileIds: string[]): ReturnType<typeof buildH5Request> {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: BATCH_TRASH_URL,
    method: 'POST',
    body: JSON.stringify({ fileIds }),
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    marketName: 'sign_in_3',
    session: session ? sessionHeaders(session) : {},
  });
}

function load(deps: TaskDeps): TaskState | null {
  const raw = deps.store.getState(STATE_TASK);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as TaskState;
    return typeof v.phase === 'string' ? v : null;
  } catch {
    return null;
  }
}
const save = (deps: TaskDeps, st: TaskState): void =>
  deps.store.setState(STATE_TASK, JSON.stringify(st), deps.nowIso);

/** 待办清单：从**矩阵的读数**里挑（本文件不自己读矩阵）。 */
export interface Pending {
  gi: number;
  ii: number;
  itemId: number;
  needUpload: boolean;
  /** 条目名（上传的文件名用它 —— 门是按**名字**判的，文件名取一致的好对账）。 */
  name: string;
}

export function pendingItems(deps: TaskDeps): Pending[] {
  const out: Pending[] = [];
  const readings = readMatrix(deps.store);
  readings.forEach((reading, gi) => {
    if (!reading) return;
    // ⚠ 老读数（这一环补上之前落的）没有 `items` —— 那时只能当"读不出条目"，
    //   不能当"没有待办"（后者会让这一族静默地什么都不做）。
    for (const [ii, item] of (reading.items ?? []).entries()) {
      if (judgeItem(item) !== 'todo') return;
      if (shouldSkip(item.taskId)) return; // ③ 判据说"不做"的一枪都不发
      out.push({
        gi,
        ii,
        itemId: item.taskId ?? 0,
        name: item.name ?? `task-${item.taskId ?? 0}`,
        needUpload:
          uploadShapeFor({
            taskId: item.taskId,
            groupId: item.groupId,
            name: item.name,
            buttonAppLink: item.buttonAppLink,
          }) !== undefined,
      });
    }
  });
  return out;
}

/** 把上传那台状态机**起起来**（只写字、不发请求）。
 *
 *  ⚠ 这一步不能省：`runUploadStep` 是"推进一步"的语义 —— 没有排队的上传时它回
 *  `idle`，于是"传文件"那条腿会**一步都不走**，而流程却以为已经传完了。 */
function beginUpload(deps: TaskDeps, itemId: number, name: string): void {
  startUpload(deps, {
    name: `${name}.bin`,
    bytes: deterministicFile(`app-task-${itemId}`, 256),
  });
}

/** 起一趟（**一个请求都不发**）。 */
export function startAppTask(deps: TaskDeps): TaskOutcome {
  const pend = pendingItems(deps);
  if (pend.length === 0) {
    return { ok: true, idle: true, note: '矩阵里没有待办（先跑一次 `app-task-matrix` 把读数填上）' };
  }
  const first = pend[0]!;
  if (first.needUpload) beginUpload(deps, first.itemId, first.name);
  save(deps, {
    gi: first.gi,
    ii: first.ii,
    phase: first.needUpload ? 'upload' : 'click',
    itemId: first.itemId,
    clicked: [],
  });
  return { ok: true, note: `已排队 ${pend.length} 条待办，从 #${first.itemId} 开始` };
}

/** 推进一步，一次调用一个请求。 */
export function runAppTaskStep(deps: TaskDeps): TaskOutcome {
  const st = load(deps);
  if (!st) return { ok: true, idle: true, note: '没有在跑的 app-task' };

  const pend = pendingItems(deps);
  const cur = pend.find((p) => p.gi === st.gi && p.ii === st.ii);
  if (!cur) {
    // 这条已经不在待办里了（比如上一次已经点掉了）⇒ 推进到下一条
    const next = pend[0];
    if (!next) {
      save(deps, { ...st, phase: 'click' });
      deps.store.setState(STATE_TASK, '', deps.nowIso);
      return { ok: true, note: '待办都走完了' };
    }
    if (next.needUpload) beginUpload(deps, next.itemId, next.name);
    save(deps, {
      gi: next.gi,
      ii: next.ii,
      phase: next.needUpload ? 'upload' : 'click',
      itemId: next.itemId,
      clicked: st.clicked,
    });
    return { ok: true, note: `换到下一条 #${next.itemId}` };
  }

  // ① 传文件（需要时才走；它自己是三枪的状态机）
  if (st.phase === 'upload') {
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      save(deps, { ...st, phase: 'click', fileId: up.fileId });
      return { ok: true, note: `文件已传完（收尾要用它的 id）—— 下一步打卡` };
    }
    const out = runUploadStep(deps, deterministicFile(`app-task-${st.itemId}`, 256));
    if (out.idle) {
      save(deps, { ...st, phase: 'click' });
      return { ok: true, note: '没有待传的 —— 下一步打卡' };
    }
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      save(deps, { ...st, phase: 'click', fileId: up.fileId });
    }
    return out;
  }

  // ② 打卡
  if (st.phase === 'click') {
    if (st.clicked.includes(st.itemId)) {
      // ⚠ 同一轮不重发（`task/click` 不可回滚）
      save(deps, { ...st, phase: st.fileId ? 'trash' : 'click' });
      return { ok: true, note: `#${st.itemId} 这一轮已经点过了 —— 不重发` };
    }
    const res = callRawText(deps.transport, clickRequest(deps, st.itemId));
    if (!res.ok) return { ok: false, note: `打卡 #${st.itemId} 失败：${res.error ?? '未知失败'}` };
    // 点了就记下来（哪怕响应不理想 —— 不可回滚的东西不能"当没发过"）
    const clicked = [...st.clicked, st.itemId];
    if (st.fileId) {
      save(deps, { ...st, phase: 'trash', clicked });
      return { ok: true, note: `打卡 #${st.itemId}（HTTP ${res.status}）—— 下一步收尾` };
    }
    save(deps, { ...st, phase: 'click', clicked });
    return { ok: true, note: `打卡 #${st.itemId}（HTTP ${res.status}）—— 这条没有要收尾的文件` };
  }

  // ③ 收尾
  if (!st.fileId) {
    // ⚠ **不许发空 fileIds**
    save(deps, { ...st, phase: 'click' });
    return { ok: true, note: '这条没有要收尾的文件 —— 不发空数组那一枪' };
  }
  const res = callRawText(deps.transport, trashRequest(deps, [st.fileId]));
  if (!res.ok) return { ok: false, note: `收尾 #${st.itemId} 失败：${res.error ?? '未知失败'}` };
  let ok = true;
  let why = '';
  try {
    const v = JSON.parse(res.text) as Record<string, unknown>;
    // ⚠ 这一口是**字符串 code** + `success` 那套信封（与 `rabactive/*` 那套不同）
    const code = typeof v.code === 'string' ? v.code : String(v.code ?? '');
    ok = v.success === true || code === '0000' || code === '0';
    if (!ok) why = `（code=${code}${typeof v.msg === 'string' ? ` ${v.msg}` : ''}）`;
  } catch {
    ok = false;
    why = '（响应不是 JSON）';
  }
  save(deps, { ...st, phase: 'click', fileId: undefined });
  return ok
    ? { ok: true, note: `收尾 #${st.itemId}：文件已移进回收站 —— 下一步下一条` }
    : { ok: false, note: `收尾 #${st.itemId} 被拒 ${why}` };
}

/** 还剩几条（面板显示用）。 */
export function remainingCount(deps: TaskDeps): number {
  return pendingItems(deps).length;
}
