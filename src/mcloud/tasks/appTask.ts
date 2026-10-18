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
import { stepFor, uploadShapeFor } from '../appTaskRules.ts';
import type { BuiltRequest } from '../h5.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_TASK = 'mcloud.apptask.state';

/** 打卡那一口的主机 —— ⚠ **`m.mcloud.139.com`**，与矩阵同一个域。
 *
 *  ⚠ 这里我**错过一次**（2026-10-14，用户一句"你确定没有用错接口"点出来的）：
 *  原先写的是 `caiyun.feixin.10086.cn:7071` —— 那是**「开启通知」那条链**的打卡口
 *  （`app_notice.rs` 的 `NOTICE_SIGNIN_TASK_CLICK`）。两处路径**字面相同**
 *  （`/ycloud/signin/task/click`），所以看着"抄对了"，而主机不同。
 *  真机后果：请求被接受、回 **HTTP 200**，而**状态一条都不变**。
 *  ⇒ 同路径不同主机这种"长得一样"的坑，只能靠**核对 import 的主机常量**发现，
 *    不能靠"路径对了就算对了"。 */
export const CLICK_HOST = 'https://m.mcloud.139.com';
export const CLICK_PATH = '/ycloud/signin/task/click';
/** 访问日志（"我点了哪条任务"）—— ⚠ **点之前要先发这一枪**，否则打卡可能不生效。 */
export const JOURNALING_PATH = '/ycloud/visitlog/journaling';
export const JOURNALING_SOURCE_ID = '1077';

/** 收尾：批量移进回收站。 */
export const BATCH_TRASH_URL = 'https://personal-kd-njs.yun.139.com/hcy/recyclebin/batchTrash';

export type TaskPhase = 'upload' | 'visit' | 'click' | 'trash' | 'done';

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
  visit: '记访问日志（"我点了哪条任务"）',
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

/** 访问日志那一枪：`POST /ycloud/visitlog/journaling`，**form 体**。
 *
 *  体（mcloud 逐字）：`module=uservisit&optkeyword=139newsignin_index_task_<id>&sourceid=1077&marketName=<mn>`
 *
 *  ⚠ 这一枪我一开始**整个漏了** —— 少了它，打卡回 200 但状态不变。 */
export function journalingRequest(deps: TaskDeps, taskId: number, marketname = 'sign_in_3'): BuiltRequest {
  const session = loadSession(deps.store);
  return {
    url: `${CLICK_HOST}${JOURNALING_PATH}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      ...(session ? sessionHeaders(session) : {}),
    },
    body:
      `module=uservisit&optkeyword=139newsignin_index_task_${taskId}` +
      `&sourceid=${JOURNALING_SOURCE_ID}&marketName=${marketname}`,
  };
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

/** ⚠ **判据是状态变了，不是 HTTP 200**。
 *
 *  真机教训（2026-10-14）：点了 `time` 组三条（548/549/550），三枪全回 **200**，
 *  而**状态一条都没变**（还是 `WAIT`）；同一次里 `month` 的 607 点了就真变成 `FINISH`。
 *  ⇒ `task/click` 回 200 **只说明"请求被接受了"**，不说明"这条做完了"。
 *  ⇒ 复查只能靠**再读一次矩阵**：点过的条目如果还是 `todo`，那就要**如实报出来**。 */
function clickedButIneffective(deps: TaskDeps, st: TaskState): number[] {
  const clicked = freshClicked(st, deps);
  if (clicked.length === 0) return [];
  const still = pendingItems(deps).filter((p) => clicked.includes(p.itemId));
  return still.map((p) => p.itemId);
}

/** 换到下一条待办（跳过今天已经点过的）。没有下一条 ⇒ 收摊。 */
function advance(deps: TaskDeps, st: TaskState): TaskOutcome {
  const clicked = freshClicked(st, deps);
  const next = pendingItems(deps).find((p) => !clicked.includes(p.itemId));
  if (!next) {
    // ⚠ **不清空**：清成 `''` 会把"今天点过"那份名单一起毁掉，于是下一趟
    //   拿着同一份（没刷新的）读数就会**重复点**。标成 `done` 把名单留着。
    save(deps, { ...st, phase: 'done', fileId: undefined, clicked, day: today(deps) });
    // ⚠ 收摊时**必须**把"点了但状态没变"的那些报出来 —— 否则面板上会是一句
    //   "都走完了"，而实际上一大半根本没生效（真机上就是这样）。
    const dead = clickedButIneffective(deps, { ...st, clicked });
    const warn =
      dead.length === 0
        ? ''
        : `。⚠ 其中 ${dead.length} 条**点了但状态没变**（#${dead.join('、')}）—— ` +
          'HTTP 200 只说明"请求被接受了"。这类多半要**先做那个动作**（开启备份 / 开启通知），' +
          '光点一下不算数';
    return { ok: dead.length === 0, note: `待办都走完了（这一趟点了 ${clicked.length} 条）${warn}` };
  }
  if (next.needUpload) beginUpload(deps, next.itemId, next.name);
  save(deps, {
    gi: next.gi,
    ii: next.ii,
    phase: next.needUpload ? 'upload' : 'visit',
    itemId: next.itemId,
    clicked,
    day: today(deps),
  });
  return { ok: true, note: `下一条 #${next.itemId}（「${next.name}」）` };
}

/** 上一次 `pendingItems` 里"未实现"的那些 id（只用于文案）。 */
let lastSkipped: number[] = [];

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
  const skipped: number[] = [];
  const readings = readMatrix(deps.store);
  readings.forEach((reading, gi) => {
    if (!reading) return;
    // ⚠ 老读数（这一环补上之前落的）没有 `items` —— 那时只能当"读不出条目"，
    //   不能当"没有待办"（后者会让这一族静默地什么都不做）。
    for (const [ii, item] of (reading.items ?? []).entries()) {
      // ⚠ **`continue`，不是 `return`** —— 这里在 `forEach` 的**回调**里套了一个
      //   `for...of`，`return` 退的是**整个回调**（这一份读数里剩下的条目全被跳过 ✗）。
      //   真机/测试里的症状：只要**第一条**是"未实现"的（548），后面全部消失 ⇒
      //   `pendingItems` 回 `[]`，看着像"这账号没有任务"。我查了好几轮才定位到。
      if (judgeItem(item) !== 'todo') continue;
      // ⚠ **只做"知道该做什么"的那些**（见 `stepFor` 的注释）——
      //   第一版是"不在黑名单就打"，那是重写；真机上点了 4 条状态一条没变，
      //   因为它们在 mcloud 的账本里全是"未实现"。
      if (stepFor({ taskId: item.taskId, groupId: item.groupId, name: item.name, buttonAppLink: item.buttonAppLink }) === undefined) {
        skipped.push(item.taskId ?? 0);
        continue; // ⚠ 同上：不能 `return`（那会退掉整份读数）
      }
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
    const sk = lastSkipped;
    // 说人话：能替你做的一条都没有；剩下的要么得你去 App 里点，要么还没支持
    const extra =
      sk.length === 0
        ? ''
        : `，另有 ${sk.length} 条要在 App 里手动做（我们替不了）`;
    return { ok: true, idle: true, note: `没有能替你做的了${extra}` };
  }
  const todo = all.filter((p) => !clicked.includes(p.itemId));
  if (todo.length === 0) {
    return {
      ok: true,
      idle: true,
      note: `今天这 ${all.length} 条都点过了`,
    };
  }
  const first = todo[0]!;
  if (first.needUpload) beginUpload(deps, first.itemId, first.name);
  save(deps, {
    gi: first.gi,
    ii: first.ii,
    phase: first.needUpload ? 'upload' : 'visit',
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
    // 括号里那句是给排查用的，用户不需要 —— 只说做完了
    return { ok: true, idle: true, note: '这一趟做完了' };
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
      save(deps, { ...st, phase: 'visit', fileId: up.fileId, day: today(deps) });
      return { ok: true, note: `文件已传完（收尾要用它的 id）—— 下一步记访问日志` };
    }
    const out = runUploadStep(deps, deterministicFile(`app-task-${st.itemId}`, 256));
    if (out.idle) {
      save(deps, { ...st, phase: 'visit', day: today(deps) });
      return { ok: true, note: '没有待传的 —— 下一步记访问日志' };
    }
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      save(deps, { ...st, phase: 'visit', fileId: up.fileId, day: today(deps) });
    }
    return out;
  }

  // ①b 记访问日志（漏了它打卡不生效）
  if (st.phase === 'visit') {
    const res = callRawText(deps.transport, journalingRequest(deps, st.itemId));
    if (!res.ok) return { ok: false, note: `记访问日志 #${st.itemId} 失败：${res.error ?? '未知失败'}` };
    save(deps, { ...st, phase: 'click', day: today(deps) });
    return { ok: true, note: `已记访问日志 #${st.itemId}（HTTP ${res.status}）—— 下一步打卡` };
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
    // ⚠ **要把 `advance` 的结论带出去**：这一趟可能以"有条目点了没生效"收摊，
    //   那时 `advance` 回 `ok: false` —— 吞掉它就会把"没生效"报成成功。
    //   （打卡本身回 200 是真的，但**整趟的结论**不是"成功"。）
    return {
      ok: out.ok,
      note: `打卡 #${st.itemId}（HTTP ${res.status}）—— 这条没有要收尾的文件。${out.note}`,
    };
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
