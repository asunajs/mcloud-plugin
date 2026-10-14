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
import { cloudFileOpHeaders, deterministicFile } from '../cloudUpload.ts';
import { shouldSkip, uploadShapeFor } from '../appTaskRules.ts';
import type { BuiltRequest } from '../h5.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_TASK = 'mcloud.apptask.state';

/** 「开启通知」那条链上的打卡口 —— ⚠ **GET 却是写**，而且主机**带端口**。 */
export const CLICK_HOST = 'https://caiyun.feixin.10086.cn:7071';
export const CLICK_PATH = '/ycloud/signin/task/click';

/** 收尾：批量移进回收站。 */
export const BATCH_TRASH_URL = 'https://personal-kd-njs.yun.139.com/hcy/recyclebin/batchTrash';

export type TaskPhase = 'upload' | 'click' | 'trash' | 'done';

interface TaskState {
  gi: number;
  ii: number;
  phase: TaskPhase;
  itemId: number;
  /** 本轮为这条任务传上去的文件 id（收尾要用）。**没有就不发收尾那一枪。** */
  fileId?: string | undefined;
  /** 已经点过的那些（防重发 —— `task/click` 不可回滚）。 */
  clicked: number[];
  /** ⚠ 上面那份名单**按天重置**：矩阵读数是**慢**的（8 个 group 轮着读），
   *  所以同一份读数会被反复消费；不清名单就会重复点，清得太早又会在读数刷新前重点。
   *  按天划一条线 —— 一天之内绝不重复点同一条。 */
  day: string;
}

const PHASE_TEXT: Record<TaskPhase, string> = {
  upload: '传文件（过名字门/按钮门）',
  click: '打卡（不可回滚）',
  trash: '收尾（移进回收站）',
  done: '这一趟走完了',
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

/** 收尾那一枪。⚠ **空数组不发**（见文件头 ②）。
 *
 *  ⚠ 它**不走 H5 签名**（那是 `m.mcloud.139.com` 那一族的做法）：这一口在**云盘主机**
 *  `personal-kd-njs.yun.139.com` 上，要的是**云盘族的头** + 传输层注入的 `Authorization`。
 *  真机教训：照 H5 签名发会回 **404 / `04000005 认证失败`**。
 *  ⚠ 凭据**不在这里设**（由传输层按主机判 —— 见 `sendsAuthorizationTo`）。 */
export function trashRequest(deps: TaskDeps, fileIds: string[]): BuiltRequest {
  void deps;
  return {
    url: BATCH_TRASH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cloudFileOpHeaders('upload') },
    body: JSON.stringify({ fileIds }),
  };
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

/** 今天（按面板的时钟）。 */
function today(deps: TaskDeps): string {
  return deps.nowIso.slice(0, 10);
}

/** 过了一天就把"已点过"那份名单清掉（见 `day` 的注释）。 */
function freshClicked(st: TaskState, deps: TaskDeps): number[] {
  return st.day === today(deps) ? st.clicked : [];
}

/** 换到下一条待办（跳过今天已经点过的）。没有下一条 ⇒ 收摊。 */
function advance(deps: TaskDeps, st: TaskState): TaskOutcome {
  const clicked = freshClicked(st, deps);
  const next = pendingItems(deps).find((p) => !clicked.includes(p.itemId));
  if (!next) {
    // ⚠ **不清空**：清成 `''` 会把"今天点过"那份名单一起毁掉，于是下一趟
    //   拿着同一份（没刷新的）读数就会**重复点**。标成 `done` 把名单留着。
    save(deps, { ...st, phase: 'done', fileId: undefined, clicked, day: today(deps) });
    return { ok: true, note: `待办都走完了（这一趟点了 ${clicked.length} 条）` };
  }
  if (next.needUpload) beginUpload(deps, next.itemId, next.name);
  save(deps, {
    gi: next.gi,
    ii: next.ii,
    phase: next.needUpload ? 'upload' : 'click',
    itemId: next.itemId,
    clicked,
    day: today(deps),
  });
  return { ok: true, note: `下一条 #${next.itemId}（「${next.name}」）` };
}

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
  // ⚠ **今天的"已点过"名单要接着用**：矩阵读数是慢的（8 个 group 轮着读），
  //   所以同一份读数会被反复消费 —— 起新一趟时若把名单清成 `[]`，
  //   那些今天已经点过的条目就会被**重复点**（而 `task/click` 不可回滚）。
  const prev = load(deps);
  const clicked = prev ? freshClicked(prev, deps) : [];
  const all = pendingItems(deps);
  if (all.length === 0) {
    return { ok: true, idle: true, note: '矩阵里没有待办（先跑一次 `app-task-matrix` 把读数填上）' };
  }
  const todo = all.filter((p) => !clicked.includes(p.itemId));
  if (todo.length === 0) {
    return {
      ok: true,
      idle: true,
      note: `读数里 ${all.length} 条待办**今天都点过了** —— 不重发（读数刷新后会自然变 FINISH）`,
    };
  }
  const first = todo[0]!;
  if (first.needUpload) beginUpload(deps, first.itemId, first.name);
  save(deps, {
    gi: first.gi,
    ii: first.ii,
    phase: first.needUpload ? 'upload' : 'click',
    itemId: first.itemId,
    clicked,
    day: today(deps),
  });
  return { ok: true, note: `已排队 ${todo.length} 条待办（今天已点过 ${clicked.length} 条），从 #${first.itemId} 开始` };
}

/** 推进一步，一次调用一个请求。 */
export function runAppTaskStep(deps: TaskDeps): TaskOutcome {
  const st = load(deps);
  if (!st) return { ok: true, idle: true, note: '没有在跑的 app-task' };
  if (st.phase === 'done') {
    return { ok: true, idle: true, note: '这一趟已经走完（读数刷新后新出现的待办要重新起一趟）' };
  }

  const pend = pendingItems(deps);
  const cur = pend.find((p) => p.gi === st.gi && p.ii === st.ii);
  if (!cur) {
    // 这条已经不在待办里了（比如读数刷新后它变成 FINISH）⇒ 换下一条
    return advance(deps, st);
  }

  // ① 传文件（需要时才走；它自己是三枪的状态机）
  if (st.phase === 'upload') {
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      save(deps, { ...st, phase: 'click', fileId: up.fileId, day: today(deps) });
      return { ok: true, note: `文件已传完（收尾要用它的 id）—— 下一步打卡` };
    }
    const out = runUploadStep(deps, deterministicFile(`app-task-${st.itemId}`, 256));
    if (out.idle) {
      save(deps, { ...st, phase: 'click' });
      return { ok: true, note: '没有待传的 —— 下一步打卡' };
    }
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      save(deps, { ...st, phase: 'click', fileId: up.fileId, day: today(deps) });
    }
    return out;
  }

  // ② 打卡
  if (st.phase === 'click') {
    if (freshClicked(st, deps).includes(st.itemId)) {
      // ⚠ 不重发（`task/click` 不可回滚），而且**必须换下一条** ——
      //   早先这里把 phase 又设回 `click`，于是永远停在同一条上（真机上一眼看出来的）。
      if (st.fileId) {
        save(deps, { ...st, phase: 'trash', day: today(deps) });
        return { ok: true, note: `#${st.itemId} 今天已经点过了 —— 不重发，去收尾` };
      }
      const out = advance(deps, st);
      return { ok: true, note: `#${st.itemId} 今天已经点过了 —— 不重发。${out.note}` };
    }
    const res = callRawText(deps.transport, clickRequest(deps, st.itemId));
    if (!res.ok) return { ok: false, note: `打卡 #${st.itemId} 失败：${res.error ?? '未知失败'}` };
    // 点了就记下来（哪怕响应不理想 —— 不可回滚的东西不能"当没发过"）
    const clicked = [...freshClicked(st, deps), st.itemId];
    if (st.fileId) {
      save(deps, { ...st, phase: 'trash', clicked, day: today(deps) });
      return { ok: true, note: `打卡 #${st.itemId}（HTTP ${res.status}）—— 下一步收尾` };
    }
    const out = advance(deps, { ...st, clicked });
    return { ok: true, note: `打卡 #${st.itemId}（HTTP ${res.status}）—— 这条没有要收尾的文件。${out.note}` };
  }

  // ③ 收尾
  if (!st.fileId) {
    // ⚠ **不许发空 fileIds** ⇒ 换下一条
    const out = advance(deps, st);
    return { ok: true, note: `这条没有要收尾的文件 —— 不发空数组那一枪。${out.note}` };
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
  const out = advance(deps, { ...st, fileId: undefined });
  return ok
    ? { ok: true, note: `收尾 #${st.itemId}：文件已移进回收站。${out.note}` }
    : { ok: false, note: `收尾 #${st.itemId} 被拒 ${why}` };
}

/** 还剩几条（面板显示用）。 */
export function remainingCount(deps: TaskDeps): number {
  return pendingItems(deps).length;
}
