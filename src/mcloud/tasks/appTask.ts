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
import { depsNowMs, sessionHeaders, waitGap, waitMs } from './base.ts';
import { REFERER_SIGN_IN, SHOW_LOADING, buildH5Request } from '../h5.ts';
import { loadSession } from '../../store/types.ts';
import { loadAuthRaw } from '../sessionExchange.ts';
import { parseAuth } from '../auth.ts';
import { uuidV4 } from '../rand.ts';
import { utf8 } from '../../crypto/bytes.ts';
import { MATRIX_MARKETS, judgeItem, readMatrix, runAppTaskMatrix } from './appTaskMatrix.ts';
import { clearUpload, loadUpload, runUploadStep, startUpload, uploadDone } from './upload.ts';
import { readMonthBackup } from './taskExpansion.ts';
import { parseTrashResult } from './cloudTrash.ts';
import { unregisterOwnedFile } from './ownedFiles.ts';
import { cloudFileOpHeaders, deterministicFile, randomHex } from '../cloudUpload.ts';
import { SHARE_TASK_ID, isShareClaim, monthGateSkips, shouldSkip, stepFor, uploadShapeFor } from '../appTaskRules.ts';
import type { AppRunner, TaskStep } from '../appTaskRules.ts';
import { parseSsoToken } from '../h5session.ts';
import {
  aiCameraChatRequest,
  billMailsSearchRequest,
  billPageRequest,
  logBehaviorActionRequest,
  mailReportToMqRequest,
  markMailReadRequest,
  readMessageRequest,
  aiChatRequest,
  aiRecognizeRequest,
  composeMailRequest,
  convertPdfRequest,
  getComposeIdRequest,
  mailAutologinRequest,
  marketClickRequest,
  noteAuthRequest,
  noteCreateRequest,
  peActiveReportRequest,
  noteDeleteRequest,
  parseAiRecognize,
  parseComposeId,
  parseNoteHeaders,
  cloudTaskStatusRequest,
  delOutLinkRequest,
  deriveAiAuth,
  encryptPhone,
  parseCloudTaskStatus,
  parseQueryUserToken,
  parseSse,
  queryUserTokenRequest,
  entryGetRequest,
  entryPostRequest,
  firstField,
  getOutLinkRequest,
  mailBackupRequest,
  mailCode,
  mailDirsRequest,
  mailLoginRequest,
  mailSearchRequest,
  mailSpecTokenRequest,
  newCguid,
  parseLinkIds,
  parseMailSession,
  portalPageRequest,
  portalUrl,
} from './appTaskExtra.ts';
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

export type TaskPhase =
  | 'upload'
  | 'visit'
  | 'click'
  | 'trash'
  | 'entry'
  | 'entryTwice'
  | 'portal'
  | 'share'
  | 'shareDel'
  | 'mailLogin'
  | 'mailLogin2'
  | 'mailDirs'
  | 'mailSearch'
  | 'mailBackup'
  | 'aiQuery'
  | 'aiStatus'
  | 'aiChat'
  | 'noteAuth'
  | 'noteCreate'
  | 'noteDelete'
  | 'mailActiveAction'
  | 'sendMailAction'
  | 'camRecognize'
  | 'camChat'
  | 'pdfUpload'
  | 'pdfConvert'
  | 'billViewAction'
  | 'settle'
  | 'done';

/** 这一条除了“点一下”之外还要做的动作。 */
type Special =
  | 'entry'
  | 'entryTwice'
  | 'portal'
  | 'share'
  | 'mailBackup'
  | 'aiAssistant'
  | 'aiWorkbench'
  | 'aiCamera'
  | 'note'
  | 'mailActive'
  | 'sendMail'
  | 'pdfConvert'
  | 'billView';

interface TaskState {
  gi: number;
  ii: number;
  phase: TaskPhase;
  itemId: number;
  /** 特殊动作的类型（entry/portal/share/mailBackup）；普通条目没有。 */
  special?: Special | undefined;
  /** 特殊动作的中间数据（marketName / 入口链接 / sid / mid …）。 */
  data?: Record<string, string> | undefined;
  /** 本轮为这条任务传上去的文件 id（收尾要用）。**没有就不发收尾那一枪。** */
  fileId?: string | undefined;
  /** 这个 fileId 是不是**我们造的**。`false` = 撞上用户已有文件 ⇒ 只做动作、
   *  绝不删；`undefined` = 旧状态/普通上传支（那里只有 `owned === true` 才会存
   *  `fileId`）⇒ 按我们造的收尾。 */
  fileOwned?: boolean | undefined;
  /** 已经点过的那些（防重发 —— `task/click` 不可回滚）。
   *  ⚠ 这不是"成功"名单：只有矩阵回 `FINISH` 才算成功；
   *  收摊时仍待办的那些会被移到 `unconfirmed`，**不留在 clicked**，好让下一趟重试。 */
  clicked: number[];
  /** 点了/传了，但服务端状态仍不是 `FINISH` 的条目（本地动作 ≠ 成功）。 */
  unconfirmed?: number[] | undefined;
  /** 这一趟**逐条**做过但没成的那些（带原因）。
   *
   *  ⚠ 与 `unconfirmed` 不同：那个是"动作发了、等服务端确认"，这个是**这条本身没做成**
   *  （取不到 mid / AI 没回话 / 邮箱登录失败…）。它只用于"这一趟别再撞同一条" +
   *  收尾如实报出来 —— **不挡下一趟重试**（docs/task-state.md 第 3 条）。 */
  failed?: { id: number; why: string }[] | undefined;
  /** 这条已经走起来了（`currStep != 0`）⇒ 按参考实现**不再打卡**，只做动作。
   *  上传族尤其重要：106 `currstep=1` 时旧实现不发 `task/click`。 */
  skipClick?: boolean | undefined;
  /** 上传族「先打卡、再传文件」：打完卡后下一步要起上传（参考实现 106 的顺序）。 */
  uploadAfter?: boolean | undefined;
  /** 这一条是否已经发过访问日志（参考实现是 `task/click` **之后**再发 visitlog）。 */
  journaled?: boolean | undefined;
  /** 起这条时的 `currStep`（日志里说"已走到第 N 步"要用）。 */
  currStep?: number | undefined;
  /** 动作做完后，到这个毫秒时刻再拉矩阵复查（不能刚做完就问）。 */
  settleAt?: number | undefined;
  /** `unconfirmed` 记录属于哪一天；跨天别拿昨天的"未确认"挡今天。 */
  retryDay?: string | undefined;
  /** 当天已经重试过几次（**只做日志/诊断**，不参与封顶）。 */
  retryCount?: number | undefined;
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
  entry: '固定入口（两发上报 + 补打卡）',
  entryTwice: '两轮打卡（key=task → key=task2）',
  portal: '入口页 + 打卡',
  share: '分享文件（建外链）',
  shareDel: '删外链（收尾）',
  mailLogin: '邮箱 SSO token',
  mailLogin2: '邮箱登录（sid/rmkey）',
  mailDirs: '云盘目录',
  mailSearch: '邮件列表',
  mailBackup: '邮件转存',
  aiQuery: 'AI 鉴权（queryUserToken）',
  aiStatus: 'AI 状态查询',
  aiChat: 'AI 对话（SSE）',
  noteAuth: '云笔记鉴权',
  noteCreate: '建云笔记',
  noteDelete: '删云笔记',
  mailActiveAction: '邮箱活跃 + 市场打卡',
  sendMailAction: '发邮件 + 市场打卡',
  camRecognize: 'AI 相机识图',
  camChat: 'AI 相机对话（SSE）',
  pdfUpload: '传 PDF',
  pdfConvert: 'PDF 转换',
  billViewAction: '我的账单（8 发）',
  settle: '等服务端确认',
  done: '这一趟走完了',
};

/** 打卡那一枪。⚠ GET + 查询参数 `key=task&id=<id>`（实拍逐字）。 */
export function clickRequest(
  deps: TaskDeps,
  id: number,
  key = 'task',
): ReturnType<typeof buildH5Request> {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: `${CLICK_HOST}${CLICK_PATH}?key=${encodeURIComponent(key)}&id=${id}`,
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
/** 打卡之后补访问日志（参考实现 `click_with_key()` 的第二发）。
 *  只发一次；失败也只记明细，不挡后面的动作。 */
function journalOnce(deps: TaskDeps, st: TaskState): { note: string; state: TaskState } {
  if (st.journaled === true) return { note: '', state: st };
  const market = st.data?.marketName ?? 'sign_in_3';
  const res = callRawText(deps.transport, journalingRequest(deps, st.itemId, market));
  return {
    note: res.ok
      ? `访问日志已发（HTTP ${res.status}）`
      : `访问日志没发出去（${res.error ?? '未知失败'}）`,
    state: { ...st, journaled: true },
  };
}

export function journalingRequest(deps: TaskDeps, taskId: number, marketname = 'sign_in_3'): BuiltRequest {
  const session = loadSession(deps.store);
  return {
    url: `${CLICK_HOST}${JOURNALING_PATH}`,
    method: 'POST',
    headers: {
      // ⚠ 参考实现 `visitlog_journaling_request()`：**不是**通用 H5 那两枚头，
      //   `activityid` 跟本条任务的 marketName 走、`appversion` 是 11.4.1.0。
      //   缺这两枚时上游照样回 code 0，但**不记账**（106 真机踩过）。
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      activityid: marketname,
      appversion: '11.4.1.0',
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
  const failedIds = (st.failed ?? []).map((f) => f.id);
  const next = pendingItems(deps).find(
    (p) => !clicked.includes(p.itemId) && !failedIds.includes(p.itemId),
  );
  if (!next) {
    // ⚠⚠ **不能刚做完就问上游**：动作和检查之间要有间隔。
    //   矩阵读数是动作前的快照，立刻拿它判"没变"会把每一次成功都误判成失败。
    //   先进入 `settle`，等 `settleMs`（默认 5 秒）后重新拉矩阵再判。
    //   `clicked` 先原样保留；复查时才把仍未 FINISH 的移进 `unconfirmed`。
    const wait = deps.settleMs ?? 5000;
    save(deps, {
      ...st,
      phase: 'settle',
      fileId: undefined,
      fileOwned: undefined,
      special: undefined,
      data: undefined,
      clicked,
      unconfirmed: [],
      failed: st.failed ?? [],
      settleAt: depsNowMs(deps) + wait,
      day: today(deps),
    });
    return {
      // 动了而还没复查 ⇒ **先不报成功**（同一瞬间的旧矩阵不能证明它成了）。
      ok: true,
      idle: false,
      pending: clicked.length > 0,
      note: `动作走完，等 ${wait}ms 后复查服务端（不在动作前/动作后同一瞬间下结论）`,
    };
  }
  // 434 需要“手里有文件”。本趟传过就直接用；没有就先传一个。
  // ⚠ 上传族顺序照参考实现：`currStep=0` ⇒ **先打卡，再传文件**；
  //   已经走起来（currStep!=0）⇒ 不打卡，直接传。
  const clickFirst = next.needUpload && (next.currStep === undefined || next.currStep === 0);
  let phase: TaskPhase = next.needUpload ? (clickFirst ? 'click' : 'upload') : 'click';
  if (next.step.kind === 'share') {
    // ⚠ **一律自己传一个**，不看 `mcloud.upload.state`：那格里躺的可能是**上一趟**
    //   （甚至已收尾删掉）的文件 —— 拿它去建外链，上游回
    //   `1010010006 …记录已被删除 / 消息参数错误`（2026-11-01 现场：小号 434 就这么挂的）。
    // ⚠ 但**打卡那一发照样要有**（`currstep=0` 的条目参考实现是先打卡）：
    //   以前这里无条件设成 `upload`，于是从 `advance` 进来的 434 一趟都不打卡
    //   （评审 2026-11-01）。`startAppTask` 那边是 click-first，两条路必须一致。
    if (next.currStep === undefined || next.currStep === 0) {
      phase = 'click';
    } else {
      beginUpload(deps, next.itemId, next.name);
      phase = 'upload';
    }
  }
  if (next.needUpload && !clickFirst) beginUpload(deps, next.itemId, next.name);
  const special: Special | undefined =
    next.step.kind === 'entry'
      ? 'entry'
      : next.step.kind === 'entryTwice'
        ? 'entryTwice'
        : next.step.kind === 'portal'
        ? 'portal'
        : next.step.kind === 'share'
          ? 'share'
          : next.step.kind === 'runner'
            ? specialForRunner(next.step.runner)
            : undefined;
  // 已经走起来的条目（currstep != 0）不再打“先打卡”那一发 —— 参考实现的
  // `should_click` 就是这道门；1005 / 1017 实拍 currstep=1，只发补的那一发。
  if (
    next.currStep !== undefined &&
    next.currStep !== 0 &&
    special !== undefined
  ) {
    phase = phaseOfSpecial(special) ?? phase;
  }
  // 参考实现 `should_click()`：`currstep == 0` 才打卡；已经走起来的不再打，
  // 但门照样通过、动作照做。上传族（106/113/522）在 `currstep=1` 时就是这一档；
  // **runner 那几条（1014/1029/1004…）在 `currstep != 0` 时也是这一档**。
  const started = next.currStep !== undefined && next.currStep !== 0;
  const skipClick = started && (next.step.kind === 'upload' || special !== undefined);
  // ⚠ 不打卡也要把它记成"这一趟动过了"：不记的话动作做完 `advance` 又把它挑出来
  //   （现场 2026-11-01 自测：#1014 卡成 60 步死循环：打卡-传-转-收尾-再挑 1014）。
  const markHandled = skipClick && !clicked.includes(next.itemId);
  save(deps, {
    gi: next.gi,
    ii: next.ii,
    phase,
    itemId: next.itemId,
    special,
    skipClick,
    uploadAfter: clickFirst,
    currStep: next.currStep,
    data: {
      marketName: next.marketName,
      link: next.buttonEmailLink ?? next.buttonAppLink ?? '',
    },
    clicked: markHandled ? [...clicked, next.itemId] : clicked,
    // ⚠ 把"这一趟失败过的那几条"带过去：不带的话下一条选回同一条，又撞一次。
    failed: st.failed ?? [],
    day: today(deps),
  });
  // ⚠ **换条之前要隔一会儿**（随机 0.5–2 秒，`deps.gapMs`；先把下一条的状态存好再等，
   //   这样即便等到一半被 60 秒硬闸掐掉，下一次也是从新那条接着走）：
  //   实测相邻两条之间只有 33–677ms —— 那只是上一个请求的 RTT，看起来就像机器在刷；
  //   而且上一条刚收尾、下一条立刻开工，两件事会撞在同一秒里。
  //   这一段**故意不放进 drain**：drain 只认"一步"，分不清哪几步属于同一条任务，
  //   放进去会把同一串"上传→确认→转换"也拉开，白白吃掉 60 秒预算。
  const gap = waitGap(deps);
  return {
    ok: true,
    note: `下一条 #${next.itemId}（「${next.name}」）${gap > 0 ? ` —— 隔了 ${gap}ms 再打` : ''}`,
  };
}

/**
 * **这一条没成** —— 记下来、跳到下一条，**不拖垮整趟**。
 *
 * 参考实现的口径（`app_task.rs` 的逐条循环）：某一条动作失败只结束那一条
 * （`continue` 下一条），整趟只有在「取消」时才停。这里原先是 `return {ok:false}`，
 * 于是 `drain` 一停 —— 一条 AI 对话没回话，后面 10 条就再没机会做（现场 2026-11-01：
 * 三账号都停在 #609，`已完成 0 条`）。
 */
function itemFailed(deps: TaskDeps, st: TaskState, why: string): TaskOutcome {
  const keep = (st.failed ?? []).filter((f) => f.id !== st.itemId);
  const failed = [...keep, { id: st.itemId, why }];
  // ⚠ 手里还攥着**我们造的**文件时不能直接换条：`advance` 会重建 state、把 `fileId`
  //   丢掉 ⇒ 那枚文件既不进回收站、也不再被 `activeAppTaskFileId` 认领（评审 2026-11-01）。
  //   先记下"这一条没成"，再走一趟收尾。
  if (st.fileId !== undefined && st.fileOwned !== false) {
    save(deps, { ...st, phase: 'trash', failed, day: today(deps) });
    return { ok: true, note: `#${st.itemId}：「${why}」—— 先把这个文件收尾，再换下一条` };
  }
  const out = advance(deps, { ...st, failed });
  return {
    ok: true,
    note: `#${st.itemId}：「${why}」—— 这一条先记下，继续下一条。${out.note}`,
  };
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
  /** 这一条要做的事（上传 / 点击 / 入口 / 分享 / runner）。 */
  step: TaskStep;
  /** 矩阵读数的市场名（409/1005 的入口上报要它）。 */
  marketName: string;
  buttonAppLink?: string | undefined;
  buttonEmailLink?: string | undefined;
  currStep?: number | undefined;
}

export function pendingItems(deps: TaskDeps): Pending[] {
  const out: Pending[] = [];
  const skipped: number[] = [];
  lastSkipped = [];
  const readings = readMatrix(deps.store);
  const monthBackup = readMonthBackup(deps);
  const day = Number(deps.nowIso.slice(8, 10));
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
      // ⚠ **434 的「领20豆」档不进这台状态机**：它攒满 7/7 之后
      //   服务端只收一发 `task/click?key=task&id=434`（抓包 2026-11-14），
      //   再走「传文件→建外链→删外链」是白做。它由独立的 `runShareClaim` 处理。
      if (isShareClaim(item)) continue;
      // 「刻意不做」的（SKIP_TASK_LIST）不算“没搬”—— 它们本来就不该点。
      if (shouldSkip(item.taskId)) continue;
      // 月门：sign_in_3 / month、本月备份确认没开、日期 < 20 ⇒ 这一趟不动。
      if (monthGateSkips({ groupId: item.groupId, marketName: reading.group }, monthBackup, day)) {
        continue;
      }
      // ⚠ **只做"知道该做什么"的那些**（见 `stepFor` 的注释）——
      //   第一版是"不在黑名单就打"，那是重写；真机上点了 4 条状态一条没变，
      //   因为它们在 mcloud 的账本里全是"未实现"。
      const step = stepFor({
        taskId: item.taskId,
        groupId: item.groupId,
        name: item.name,
        buttonAppLink: item.buttonAppLink,
      });
      if (step === undefined) {
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
        step,
        marketName: reading.group,
        buttonAppLink: item.buttonAppLink,
        buttonEmailLink: item.buttonEmailLink,
        currStep: item.currStep,
      });
    }
  });
  lastSkipped = skipped;
  // ⚠ 顺序照参考实现：**taskId 升序**，但 **434 排最后**。
  //   434（分享）消费的是"这一趟自己传上去的文件"，而它 id 比 522/106 都小 ——
  //   按 id 排就一定排在它们前面 ⇒ 手里空着 ⇒ 每次都"没有可分享的文件"
  //   （Rust 在 `app_task.rs:1727-1731` 用一句 `sort_by_key(task_id == 434)` 钉住这层）。
  const rank = (id: number): number => (id === SHARE_TASK_ID ? 1 : 0);
  out.sort((a, b) => rank(a.itemId) - rank(b.itemId) || a.itemId - b.itemId);
  // 同一个 taskId 可能在**两个市场**各出现一次（现场：522 在 `sign_in_3` 与
  // `newsign_139mail` 都有）。打卡那一枪只带 `id`、不带市场 ⇒ **点一次两处都算**，
  // 所以这里按 id 去重（留先出现的那条），否则"待办 17 条"里有一条是重影。
  const seen = new Set<number>();
  return out.filter((p) => (seen.has(p.itemId) ? false : (seen.add(p.itemId), true)));
}

/** 把上传那台状态机**起起来**（只写字、不发请求）。
 *
 *  ⚠ 这一步不能省：`runUploadStep` 是"推进一步"的语义 —— 没有排队的上传时它回
 *  `idle`，于是"传文件"那条腿会**一步都不走**，而流程却以为已经传完了。 */
function beginUpload(deps: TaskDeps, itemId: number, name: string): void {
  // ⚠ 随机名 + 随机内容（mcloud 的 `random_plan_with_ext`）：固定内容会命中秒传，
  //    固定名字会撞用户文件；这一条要的是“真的传一个文件”。
  const seed = randomHex(16);
  void name;
  // ⚠ **113「使用PC客户端」要按 PC 档发**（`UPLOAD_ONE_PC`）：头画像整组不同，
  //   拿安卓档传的话上游当我们是手机，这条任务永远不翻（参考实现 `app_task.rs` 的
  //   `upload_shape_for` 为它单开了一档）。
  const shape = uploadShapeFor({ taskId: itemId });
  startUpload(deps, {
    name: `asign-${randomHex(8)}${shape?.fileExt ?? '.bin'}`,
    bytes: deterministicFile(seed, 256),
    seed,
    renameMode: 'force_rename',
    parallelUpload: false,
    // ⚠ 手动上传支**不带** localCreatedAt（备份支才带；见 Rust app_task.rs）。
    op: 'upload',
    channel: shape?.channel ?? 'android',
  });
}

/** 生成一个**小而合法**的 PDF（参考 mcloud 的 pdf_convert_runner）。
 *
 *  # 为什么故意做小
 *
 *  `体验"PDF转换"` 那条的转换后端是 **AI**，扣的是 **token**（不是"次数"）——
 *  实测同一口径：`1010010111 用户权益已经使用完` 就是当天 token 用光了。
 *  token 随**渲染面积**涨，所以页面从 612×792（Letter）缩到了 **240×240**
 *  （面积 1/8.4），仍然是 1 页 1 行字。再缩的收益要看那边按什么计（方块 vs 像素），
 *  没有样本，先停在这里。
 *
 *  ⚠ 顺带把 **xref 偏移算对**：老版本那串 `0000000223 00000 n` 是**硬编码**的，
 *  而内容流长度随 `ts` 位数变 ⇒ 偏移本来就是错的（只是阅读器都容忍）。
 *  现在按实际字节数算，`startxref` 真的指向 `xref`。 */
export function makePdf(ts: number): string {
  const text = `asign pdf ${ts}`;
  const stream = `BT\n/F1 12 Tf\n16 210 Td\n(${text}) Tj\nET\n`;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

function beginPdfUpload(deps: TaskDeps): number {
  const ts = Date.now();
  startUpload(deps, { name: `asign-pdf-${ts}.pdf`, bytes: utf8(makePdf(ts)) });
  return ts;
}

/** 今天这一趟是否已经有状态。跨天的 `done` 不算 —— 否则昨天的「做完了」会把今天永远挡住。 */
export function appTaskFresh(deps: TaskDeps): boolean {
  const st = load(deps);
  if (st === null || st.day !== today(deps)) return false;
  // 正在等复查：不要把它当成"没起过"再起一条，让日常去跑 settle。
  if (st.phase === 'settle') return true;
  // 本机动过、服务端仍是待办 ⇒ 不能算"今天做完了"。
  // ⚠ 用户口径：**不限制重试次数** —— 只要服务端没确认，下一趟就继续试。
  //   重试次数只用于日志/诊断，不参与"今天做完了"的判断。
  const pend = pendingItems(deps);
  const stillTodo = (id: number): boolean => pend.some((p) => p.itemId === id);
  const dead = [
    ...clickedButIneffective(deps, st),
    ...(st.unconfirmed ?? []).filter(stillTodo),
  ];
  return dead.length === 0;
}

/** 起一趟（**一个请求都不发**）。 */
export function startAppTask(deps: TaskDeps): TaskOutcome {
  // ⚠ **今天的"已点过"名单要接着用**：矩阵读数是慢的（8 个 group 轮着读），
  //   所以同一份读数会被反复消费 —— 起新一趟时若把名单清成 `[]`，
  //   那些今天已经点过的条目就会被**重复点**（而 `task/click` 不可回滚）。
  const prev = load(deps);
  // ⚠ 上一趟"点过"不等于成功：仍待办的必须从名单里剔掉，否则会走进
  //   `todo.length===0` 的 idle 分支，永远不重试（106 的现场就是这样）。
  const dead = prev ? clickedButIneffective(deps, prev) : [];
  const clicked = (prev ? freshClicked(prev, deps) : []).filter((id) => !dead.includes(id));
  const all = pendingItems(deps);
  // 说人话：能替你做的一条都没有；剩下的要么得你去 App 里点，要么还没搬。
  // ⚠ 这个数以前永远是 0（`lastSkipped` 只读不写），于是日志把“没搬”说成了“没有”。
  const extra =
    lastSkipped.length === 0
      ? ''
      : `，另有 ${lastSkipped.length} 条还没搬（当前要在 App 里手动做）`;
  if (all.length === 0) {
    return { ok: true, idle: true, note: `没有能替你做的了${extra}` };
  }
  const todo = all.filter((p) => !clicked.includes(p.itemId));
  if (todo.length === 0) {
    return {
      ok: true,
      idle: true,
      note: `今天这 ${all.length} 条都点过了${extra}`,
    };
  }
  const first = todo[0]!;
  // 与 `advance` 同一条顺序：上传族先打卡，再上传。
  const clickFirst = first.needUpload && (first.currStep === undefined || first.currStep === 0);
  let phase: TaskPhase = first.needUpload ? (clickFirst ? 'click' : 'upload') : 'click';
  if (first.step.kind === 'share') {
    const up = (() => {
      try {
        return JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string };
      } catch {
        return {};
      }
    })();
    if (!up.fileId) {
      beginUpload(deps, first.itemId, first.name);
      phase = 'upload';
    }
  }
  if (first.needUpload && !clickFirst) beginUpload(deps, first.itemId, first.name);
  const special: Special | undefined =
    first.step.kind === 'entry'
      ? 'entry'
      : first.step.kind === 'entryTwice'
        ? 'entryTwice'
        : first.step.kind === 'portal'
        ? 'portal'
        : first.step.kind === 'share'
          ? 'share'
          : first.step.kind === 'runner'
            ? specialForRunner(first.step.runner)
            : undefined;
  if (
    first.currStep !== undefined &&
    first.currStep !== 0 &&
    special !== undefined
  ) {
    phase = phaseOfSpecial(special) ?? phase;
  }
  // 同 `advance`：上传族已经走起来（currStep != 0）⇒ 不打卡。
  const skipClick = first.step.kind === 'upload' && first.currStep !== undefined && first.currStep !== 0;
  const markHandled = skipClick && !clicked.includes(first.itemId);
  save(deps, {
    gi: first.gi,
    ii: first.ii,
    phase,
    itemId: first.itemId,
    special,
    skipClick,
    uploadAfter: clickFirst,
    currStep: first.currStep,
    data: {
      marketName: first.marketName,
      link: first.buttonEmailLink ?? first.buttonAppLink ?? '',
    },
    clicked: markHandled ? [...clicked, first.itemId] : clicked,
    day: today(deps),
  });
  return { ok: true, note: `已排队 ${todo.length} 条待办（今天已点过 ${clicked.length} 条），从 #${first.itemId} 开始` };
}

/** 专用 runner → 特殊动作标记。 */
function specialForRunner(runner: AppRunner): Special {
  switch (runner) {
    case 'aiAssistant':
      return 'aiAssistant';
    case 'aiWorkbench':
      return 'aiWorkbench';
    case 'aiCamera':
      return 'aiCamera';
    case 'note':
      return 'note';
    case 'mailActive':
      return 'mailActive';
    case 'sendMail':
      return 'sendMail';
    case 'pdfConvert':
      return 'pdfConvert';
    case 'billView':
      return 'billView';
    default:
      return 'mailBackup';
  }
}

/** 某个特殊动作对应的阶段（没有就 `undefined`）。 */
function phaseOfSpecial(s: Special | undefined): TaskPhase | undefined {
  switch (s) {
    case 'entry':
      return 'entry';
    case 'entryTwice':
      return 'entryTwice';
    case 'portal':
      return 'portal';
    case 'share':
      return 'share';
    // ⚠ **凡是要邮箱会话的，入口一律先 `mailLogin`**。
    //   `st.data`（sid/rmkey）在 `advance` 换条目时就没了 —— 直接进
    //   `sendMailAction`/`pdfUpload` 这些"用会话"的阶段，带出去的是**空 sid**：
    //   现场 2026-11-01 自测就是这么挂的（1004 回 `FA_INVALID_PARAMETER`、
    //   1014 回 `FA_INVALID_SESSION User Session Expired`）。
    case 'mailBackup':
    case 'aiAssistant':
    case 'aiWorkbench':
    case 'aiCamera':
    case 'mailActive':
    case 'sendMail':
    case 'pdfConvert':
    case 'billView':
      return 'mailLogin';
    case 'note':
      return 'noteAuth';
    default:
      return undefined;
  }
}

/** 这条已经做完（或已经动手）：把它记进“今天点过”，`advance` 才会换下一条。 */
function doneState(deps: TaskDeps, st: TaskState): TaskState {
  const clicked = freshClicked(st, deps);
  return {
    ...st,
    clicked: clicked.includes(st.itemId) ? clicked : [...clicked, st.itemId],
  };
}

/** 打卡之后该去哪个特殊阶段（没有就 `undefined`）。 */
function specialPhase(st: TaskState): TaskPhase | undefined {
  return phaseOfSpecial(st.special);
}

/** 推进一步，一次调用一个请求。 */
export function runAppTaskStep(deps: TaskDeps): TaskOutcome {
  const loaded = load(deps);
  if (!loaded) return { ok: true, idle: true, note: '没有在跑的 app-task' };
  let st: TaskState = loaded;
  if (st.phase === 'done') {
    // ⚠ 不能只说"做完了"：本地动作做了、服务端仍未确认的，要如实说出来。
    //   否则日志会把"106 还没完成"报成成功（用户现场就是这么被误导的）。
    const pend = pendingItems(deps);
    const stillTodo = (id: number): boolean => pend.some((p) => p.itemId === id);
    const dead = [
      ...clickedButIneffective(deps, st),
      ...(st.unconfirmed ?? []).filter(stillTodo),
    ];
    // ⚠ 同一条可能既在 `dead`（本机动过）又在 `failed`（这一条没成）—— 别数两遍。
    const deadSet = new Set(dead);
    const failedWhy = (st.failed ?? []).filter((f) => stillTodo(f.id) && !deadSet.has(f.id));
    return dead.length === 0 && failedWhy.length === 0
      ? { ok: true, idle: true, note: '这一趟做完了（服务端已确认）' }
      : {
          ok: false,
          idle: true,
          pending: true,
          note: `这一趟没有全确认：${dead.length} 条本机动过、服务端仍是待办（#${dead.join('、')}）${
            failedWhy.length === 0
              ? ''
              : `；${failedWhy.length} 条没做成（${failedWhy.map((f) => `#${f.id} ${f.why}`).join('；')}）`
          } —— 下一趟继续重试（不设上限）`,
        };
  }

  // ①′ 动作与复查之间必须隔一段时间；到点后**重新拉矩阵**再判。
  if (st.phase === 'settle') {
    const wait = (st.settleAt ?? 0) - depsNowMs(deps);
    // 真等：动作和复查之间必须有间隔，不能同一瞬间拿旧矩阵下结论。
    // 面板是同步沙箱，没有 setTimeout，所以这里同步等（有 10 秒硬上限）。
    waitMs(deps, wait);
    // 生产环境默认 5 秒；测试传 0 时直接用它手里的 mock 矩阵。
    if ((deps.settleMs ?? 5000) > 0) {
      for (let i = 0; i < MATRIX_MARKETS.length; i++) runAppTaskMatrix(deps);
    }
    const dead = clickedButIneffective(deps, st);
    // 逐条失败的那些（没打卡/没传成功，只在 `failed` 里）也要进 `unconfirmed`：
    // 否则下一趟会被当成"今天没碰过"，或者反过来被"今天做完了"骗过去。
    const failed = st.failed ?? [];
    const failedIds = failed.map((f) => f.id);
    const kept = st.clicked.filter((id) => !dead.includes(id));
    const retryCount = dead.length > 0 || failed.length > 0 ? (st.retryCount ?? 0) + 1 : 0;
    save(deps, {
      ...st,
      phase: 'done',
      clicked: kept,
      unconfirmed: [...dead, ...failedIds.filter((id) => !dead.includes(id))],
      settleAt: undefined,
      retryDay: today(deps),
      retryCount,
      day: today(deps),
    });
    const bits: string[] = [];
    if (dead.length > 0) {
      bits.push(`${dead.length} 条本机动过、服务端仍是待办（#${dead.join('、')}）`);
    }
    if (failed.length > 0) {
      bits.push(`${failed.length} 条没做成（${failed.map((f) => `#${f.id} ${f.why}`).join('；')}）`);
    }
    const warn = bits.length === 0 ? '' : `；⚠ ${bits.join('；')} —— 只有矩阵回 FINISH 才算成功，下一趟会重试`;
    return {
      ok: bits.length === 0,
      idle: true,
      pending: bits.length > 0,
      note: `复查完成（已等 ${deps.settleMs ?? 5000}ms，重新拉过矩阵）${warn}`,
    };
  }

  const pend = pendingItems(deps);
  const cur = pend.find((p) => p.gi === st.gi && p.ii === st.ii);
  if (!cur) {
    // 这条已经不在待办里了（比如读数刷新后它变成 FINISH）⇒ 换下一条
    return advance(deps, st);
  }

  // ① 传文件（需要时才走；它自己是三枪的状态机）
  if (st.phase === 'upload') {
    // currStep != 0 的上传族没有打卡这一发；visitlog 仍补一次（best-effort）。
    if (st.journaled !== true) {
      const j = journalOnce(deps, st);
      st = j.state;
      save(deps, st);
      if (j.note !== '') return { ok: true, note: j.note };
    }
    // 上传族是「先打卡、再传」：打完卡后 `clicked` 已经包含这一条。
    // 传完不该再去 visit/click（那会重复打），有我们造的文件就收尾，否则换下一条。
    const base = st;
    const afterClick = freshClicked(base, deps).includes(base.itemId);
    const finishUpload = (ours: string | undefined): TaskOutcome => {
      // ⚠ 434（分享）是**上传的消费者**：传完要去分享，不是去收尾 ——
      //   以前这一支对"已打卡"的条目一律进 trash，于是刚传上去的文件当场被删，
      //   分享那一格永远"手里没有文件"。
      if (base.special === 'share' && ours !== undefined) {
        save(deps, { ...base, phase: 'share', fileId: ours, fileOwned: true, day: today(deps) });
        return { ok: true, note: '文件已传完 —— 下一步分享它' };
      }
      if (afterClick) {
        if (ours !== undefined) {
          save(deps, { ...base, phase: 'trash', fileId: ours, fileOwned: true, day: today(deps) });
          return { ok: true, note: '文件已传完 —— 下一步收尾' };
        }
        const out = advance(deps, base);
        return { ok: true, note: `文件已传完（不是我们造的）—— ${out.note}` };
      }
      save(deps, { ...base, phase: 'visit', fileId: ours, fileOwned: true, day: today(deps) });
      return {
        ok: true,
        note: ours ? '文件已传完（收尾要用它的 id）—— 下一步记访问日志' : '文件已传完，但不是我们造的 ⇒ 不收尾',
      };
    };
    if (uploadDone(deps)) {
      const up = loadUpload(deps);
      return finishUpload(up?.ownedByUs === true ? up.fileId : undefined);
    }
    const out = runUploadStep(deps);
    if (out.idle) {
      // 没有上传状态（或旧的已失效）：重新起一个，不能当成传完。
      beginUpload(deps, st.itemId, '');
      return { ok: true, note: '没有在排队的上传 —— 重新起一个' };
    }
    if (uploadDone(deps)) {
      const up = loadUpload(deps);
      // ⚠ `ownedByUs === undefined`（判不了）要按**我们造的**处理：秒传那一支
      //   上游回 `exist: null` + `uploadId: null`，正好落到"判不了" ⇒ 以前当成
      //   "不是我们造的"⇒ 文件既不登记也不收尾，**永久留在用户网盘**（评审 2026-11-01）。
      return finishUpload(up !== null && up.ownedByUs !== false ? up.fileId : undefined);
    }
    // ⚠ 上传三枪失败（create/PUT/complete）也是**这一条**没成，不是整趟别做了。
    //   以前这里直接 `return out`（ok:false）⇒ drain 当场收工（评审 2026-11-01 抓到的漏洞）。
    if (!out.ok) return itemFailed(deps, st, out.note);
    return out;
  }

  // ①b 记访问日志（漏了它打卡不生效）
  if (st.phase === 'visit') {
    const res = callRawText(deps.transport, journalingRequest(deps, st.itemId));
    if (!res.ok) return itemFailed(deps, st, `记访问日志失败：${res.error ?? '未知失败'}`);
    save(deps, { ...st, phase: 'click', day: today(deps) });
    return { ok: true, note: `已记访问日志 #${st.itemId}（HTTP ${res.status}）—— 下一步打卡` };
  }

  // ② 打卡
  if (st.phase === 'click') {
    if (st.skipClick === true) {
      // ⚠ 参考实现：已经走起来的条目不再打卡，但动作照做。
      //   106 `currstep=1` 属于这一档；以前我们照点，结果服务端一直 WAIT。
      // 不打卡也要把它记成"这条动作做过了"，否则 advance 会立刻又选中同一条，
      // 上传会无限重来。后续仍未 FINISH ⇒ 收摊时进 unconfirmed，下一趟重试。
      const handled = [...freshClicked(st, deps), st.itemId];
      beginUpload(deps, st.itemId, '');
      save(deps, {
        ...st,
        phase: 'upload',
        clicked: handled,
        skipClick: undefined,
        uploadAfter: false,
        day: today(deps),
      });
      return { ok: true, note: `#${st.itemId} 已走到第 ${st.currStep ?? '?'} 步 —— 按参考实现不打卡，直接传文件` };
    }
    if (freshClicked(st, deps).includes(st.itemId)) {
      // ⚠ 不重发（`task/click` 不可回滚），而且**必须换下一条** ——
      //   早先这里把 phase 又设回 `click`，于是永远停在同一条上（真机上一眼看出来的）。
      const j = journalOnce(deps, st);
      const stj = j.state;
      const jn = j.note !== '' ? `；${j.note}` : '';
      if (stj.uploadAfter === true) {
        beginUpload(deps, stj.itemId, '');
        save(deps, { ...stj, phase: 'upload', uploadAfter: false, day: today(deps) });
        return { ok: true, note: `#${stj.itemId} 今天已经点过了 —— 不重发，去传文件${jn}` };
      }
      const sp = specialPhase(stj);
      if (sp !== undefined) {
        save(deps, { ...stj, phase: sp, day: today(deps) });
        return { ok: true, note: `#${stj.itemId} 今天已经点过了 —— 不重发，去做「${sp}」${jn}` };
      }
      if (stj.fileId) {
        save(deps, { ...stj, phase: 'trash', fileOwned: stj.fileOwned ?? true, day: today(deps) });
        return { ok: true, note: `#${stj.itemId} 今天已经点过了 —— 不重发，去收尾${jn}` };
      }
      const out = advance(deps, stj);
      return { ok: true, note: `#${stj.itemId} 今天已经点过了 —— 不重发。${jn}${out.note}` };
    }
    const res = callRawText(deps.transport, clickRequest(deps, st.itemId));
    // 打卡失败也只是**这一条**没成（参考实现里它是 `continue` 下一条，不是整趟停）。
    if (!res.ok) return itemFailed(deps, st, `打卡失败：${res.error ?? '未知失败'}`);
    // 点了就记下来（哪怕响应不理想 —— 不可回滚的东西不能"当没发过"）
    const clicked = [...freshClicked(st, deps), st.itemId];
    // 参考实现：`task/click` 之后补一发 visitlog（`click_with_key` 的第二发）。
    const j = journalOnce(deps, { ...st, clicked });
    const stj = j.state;
    const jn = j.note !== '' ? `；${j.note}` : '';
    const sp = specialPhase(stj);
    if (sp !== undefined) {
      save(deps, { ...stj, phase: sp, day: today(deps) });
      return { ok: true, note: `打卡 #${stj.itemId}（HTTP ${res.status}）${jn} —— 下一步「${sp}」` };
    }
    if (stj.uploadAfter === true) {
      beginUpload(deps, stj.itemId, '');
      save(deps, { ...stj, phase: 'upload', uploadAfter: false, day: today(deps) });
      return { ok: true, note: `打卡 #${stj.itemId}（HTTP ${res.status}）${jn} —— 下一步传文件` };
    }
    if (stj.fileId) {
      save(deps, { ...stj, phase: 'trash', fileOwned: stj.fileOwned ?? true, day: today(deps) });
      return { ok: true, note: `打卡 #${stj.itemId}（HTTP ${res.status}）${jn} —— 下一步收尾` };
    }
    const out = advance(deps, stj);
    // ⚠ `advance` 现在只回 `ok:true`（"没生效"由收尾那次矩阵复查判，见 `settle`）
    //   —— 这里写死 `true`，别再写 `out.ok` 让人以为还有判死逻辑（评审 2026-11-01）。
    return {
      ok: true,
      note: `打卡 #${st.itemId}（HTTP ${res.status}）${jn} —— 这条没有要收尾的文件。${out.note}`,
    };
  }


  // ③ 特殊动作（入口 / 入口页 / 分享 / 邮件转存）
  if (st.phase === 'entry') {
    const market = st.data?.marketName ?? 'sign_in_3';
    const a = callRawText(deps.transport, entryPostRequest(deps, market));
    // ⚠ 同一阶段里的连发也要隔（0.5–2 秒）：三枪连着打，上游那边还没记完上一枪。
    waitGap(deps);
    const b = callRawText(deps.transport, entryGetRequest(deps));
    waitGap(deps);
    // 409 / 1005 的“补那一发”都是 task2（参考实现 409 实测靠它翻 FINISH）。
    const c = callRawText(deps.transport, clickRequest(deps, st.itemId, 'task2'));
    const bits = [a.ok ? 'doTaskPost ok' : `doTaskPost 没成：${a.error ?? ''}`, b.ok ? 'page/doTask ok' : `page/doTask 没成：${b.error ?? ''}`];
    if (!c.ok) bits.push(`补打卡没成：${c.error ?? '未知失败'}`);
    const out = advance(deps, doneState(deps, st));
    return {
      // `advance` 现在只回 `ok:true`；这里写死 true，别让人以为还有判死逻辑（评审 2026-11-01）。
      ok: true,
      note: `固定入口 #${st.itemId}（${bits.join('；')}）。${out.note}`,
    };
  }

  // ②b 两轮打卡（619 那一族）—— 顺序**逐字照实拍**（2026-11-14 12:52–12:53）：
  //
  //    round1: doTaskPost → click(key=task)      ⇒ currstep 0 → 1（仍 WAIT）
  //    round2: doTaskPost → click(key=task2)     ⇒ FINISH / currstep=3（已完成）
  //
  //  ⚠ 只打 `task2` 一发（旧入口族的做法）推不动这一条；
  //  ⚠ 也不发 `market/signin/page/doTask` —— 抓包里没有那一发。
  if (st.phase === 'entryTwice') {
    const market = st.data?.marketName ?? 'sign_in_3';
    const bits: string[] = [];
    // 第 1 轮
    const a1 = callRawText(deps.transport, entryPostRequest(deps, market));
    bits.push(a1.ok ? 'doTaskPost ok' : `doTaskPost 没成：${a1.error ?? ''}`);
    waitGap(deps);
    const c1 = callRawText(deps.transport, clickRequest(deps, st.itemId, 'task'));
    bits.push(c1.ok ? 'key=task ok' : `key=task 没成：${c1.error ?? ''}`);
    // 第 2 轮（两轮之间要隔 —— 抓包里两轮相差约 35 秒；这里用任务间隔，
    // 不硬等 35 秒：`currstep` 的推进由服务端结算，隔一个 gap 足够让上一枪落账）
    waitGap(deps);
    const a2 = callRawText(deps.transport, entryPostRequest(deps, market));
    bits.push(a2.ok ? 'doTaskPost#2 ok' : `doTaskPost#2 没成：${a2.error ?? ''}`);
    waitGap(deps);
    const c2 = callRawText(deps.transport, clickRequest(deps, st.itemId, 'task2'));
    bits.push(c2.ok ? 'key=task2 ok' : `key=task2 没成：${c2.error ?? ''}`);
    const out = advance(deps, doneState(deps, st));
    return {
      // 四发里有一发没发出去才判失败；状态是否真的翻 FINISH 由收尾那次矩阵复查判。
      ok: true,
      note: `两轮打卡 #${st.itemId}（${bits.join('；')}）—— 等复查确认。${out.note}`,
    };
  }

  if (st.phase === 'portal') {
    const market = st.data?.marketName ?? 'sign_in_3';
    const a = callRawText(deps.transport, entryPostRequest(deps, market));
    waitGap(deps);
    const b = callRawText(deps.transport, entryGetRequest(deps));
    const link = st.data?.link ?? '';
    const url = link === '' ? undefined : portalUrl(link, deps);
    let page = '没有入口链接';
    if (url !== undefined) {
      waitGap(deps);
      const p = callRawText(deps.transport, portalPageRequest(deps, url));
      page = p.ok ? `入口页 HTTP ${p.status}（${p.text.length} 字节）` : `入口页没取成：${p.error ?? ''}`;
    }
    // 1017 的 gate 在 currstep=1 时不会打，参考实现用 task2 补；604 的 gate 会自己打。
    if (st.itemId === 1017) {
      waitGap(deps);
      const c = callRawText(deps.transport, clickRequest(deps, st.itemId, 'task2'));
      if (!c.ok) page += `；补打卡没成：${c.error ?? ''}`;
    }
    const bits = [a.ok ? 'doTaskPost ok' : 'doTaskPost 没成', b.ok ? 'page/doTask ok' : 'page/doTask 没成', page];
    const out = advance(deps, doneState(deps, st));
    return { ok: true, note: `入口页 #${st.itemId}（${bits.join('；')}）。${out.note}` };
  }

  if (st.phase === 'share') {
    // ⚠ **传完就建外链**这一步之间不能是 0ms：上传是不是"上游已经落账"没有保证
    //   （实测两枪之间只有 ~350ms，见 F-130）。上一条刚传完就建链，可能拿到
    //   `1010010006`（记录已被删除/参数错误）之类，而那是**没有错误提示**的失败。
    waitGap(deps);
    // ⚠ 收尾要用这个文件的 id 和归属：上传状态机只记得“这一次”，
    //   而分享跑完就 `advance` 会把 fileId 丢掉 —— 那正是以前留在云盘里的原因。
    let fileId = st.fileId;
    let fileOwned = st.fileOwned ?? (fileId === undefined ? undefined : true);
    if (!fileId) {
      // ⚠ 参考实现是"拿这一趟自己传的那个文件"（`share_first_uploaded(&result.file_ids)`）；
      //   手里空着就**自己传一个**，而不是放弃（现场 2026-11-01：522 的文件收尾后
      //   上传槽是空的 ⇒ 434 直接"不发空外链"，白白丢一条）。
      beginUpload(deps, st.itemId, '');
      save(deps, { ...st, phase: 'upload', fileId: undefined, fileOwned: undefined, day: today(deps) });
      return { ok: true, note: `分享 #${st.itemId}：手里没有文件 —— 自己传一个再分享` };
    }
    /** 建链失败/没 linkID 时也要收尾：文件是我们传的，不能因为分享没成就留着。
     *
     *  ⚠ **必须记进 `failed`**，不能只写一句 note 就 `ok: true`：
     *  那样这一条既没成、也不会出现在复查那句话里 —— 用户看到的就是
     *  "日志说分享成功了，云朵却没涨，而且没有任何错误提示"（2026-11-02 用户口径）。
     *  记进 `failed` 之后，复查会把 `#434 建外链失败：…` 原样念出来。 */
    const trashNext = (why: string): TaskOutcome => {
      const failed = [...(st.failed ?? []).filter((f) => f.id !== st.itemId), { id: st.itemId, why }];
      if (fileOwned === true) {
        save(deps, { ...st, phase: 'trash', fileId, fileOwned: true, failed, day: today(deps) });
        return { ok: true, note: `分享 #${st.itemId} 没成：${why} —— 先把文件收尾（原因已记下）` };
      }
      const out = advance(deps, { ...doneState(deps, { ...st, fileId: undefined, fileOwned: undefined }), failed });
      return { ok: false, note: `分享 #${st.itemId} 没成：${why}${out.note}` };
    };
    const req = getOutLinkRequest(deps, [fileId]);
    if (!req) return trashNext(`外链请求没造出来（拿不到手机号/凭据？）`);
    const res = callRawText(deps.transport, req);
    // ⚠ 分享失败也**不拖垮整趟**（参考实现里它只是这一条的 problem）——
    //   但"这一条没成"这件事必须说出来，见上面 `trashNext` 的注释。
    if (!res.ok) {
      return trashNext(`建外链失败：${res.error ?? '未知失败'}`);
    }
    const ids = parseLinkIds(res.text);
    if (ids.length === 0) {
      return trashNext(
        `响应里没有 linkID（${res.text.slice(0, 80).replace(/\s+/g, ' ')}）`,
      );
    }
    save(deps, {
      ...st,
      phase: 'shareDel',
      fileId,
      fileOwned: fileOwned ?? true,
      data: { ...(st.data ?? {}), linkIds: JSON.stringify(ids) },
      day: today(deps),
    });
    return { ok: true, note: `分享 #${st.itemId}：外链已建（${ids.length} 条），下一步删掉` };
  }

  if (st.phase === 'shareDel') {
    // 建链与删链之间同样不能 0ms：链刚建出来就删，上游那边可能还没落账。
    waitGap(deps);
    let ids: string[] = [];
    try {
      ids = JSON.parse(st.data?.linkIds ?? '[]') as string[];
    } catch {
      ids = [];
    }
    const req = delOutLinkRequest(deps, ids);
    const res = req ? callRawText(deps.transport, req) : undefined;
    // 外链删没删成，文件都要收尾（外链没了，文件留着也没有用途）。
    // ⚠ 只认 `fileOwned === true`：判不了的一律不删。
    if (st.fileId !== undefined && st.fileOwned === true) {
      // 删链失败也要**记进 `failed`**：只写 note 的话，这一条到底成没成，
      // 复查那句话里一个字都不会提（用户口径：失败要有错误提示）。
      const delWhy = req === undefined ? '' : res!.ok ? '' : `删外链失败：${res!.error ?? '未知失败'}`;
      const failed =
        delWhy === ''
          ? st.failed ?? []
          : [...(st.failed ?? []).filter((f) => f.id !== st.itemId), { id: st.itemId, why: delWhy }];
      save(deps, { ...st, phase: 'trash', fileOwned: true, failed, day: today(deps) });
      return {
        ok: res?.ok ?? true,
        note: !req
          ? `分享 #${st.itemId}：没有 linkID 可删 —— 下一步收尾`
          : res!.ok
            ? `分享 #${st.itemId}：外链已删 —— 下一步收尾`
            : `分享 #${st.itemId}：${delWhy} —— 下一步收尾（原因已记下）`,
      };
    }
    const out = advance(deps, doneState(deps, { ...st, fileId: undefined, fileOwned: undefined }));
    return {
      // ⚠ 删外链失败**不许判死**：`trash` 已经排在下一步，判死会让它这一趟根本不执行
      //   （评审 2026-11-01）。失败写进 note，文件照旧收尾。
      ok: true,
      note: !req
        ? `分享 #${st.itemId}：没有 linkID 可删。${out.note}`
        : res!.ok
          ? `分享 #${st.itemId}：外链已删。${out.note}`
          : `分享 #${st.itemId}：删外链失败（${res!.error ?? '未知失败'}）。${out.note}`,
    };
  }

  // ③b 1020 邮件转存：一次一步
  if (st.phase === 'mailLogin') {
    const res = callRawText(deps.transport, mailSpecTokenRequest(deps));
    if (!res.ok) return itemFailed(deps, st, `邮箱 SSO token 失败：${res.error ?? '未知失败'}`);
    const parsed = parseSsoToken(res.text);
    if (!parsed.ok || parsed.value === undefined) {
      return itemFailed(deps, st, `邮箱 SSO token 没换到：${parsed.error}`);
    }
    save(deps, {
      ...st,
      phase: 'mailLogin2',
      data: { ...(st.data ?? {}), sso: parsed.value },
      day: today(deps),
    });
    return { ok: true, note: '邮箱 SSO token 已换到 —— 下一步登录邮箱' };
  }

  if (st.phase === 'mailLogin2') {
    const sso = st.data?.sso ?? '';
    const res = callRawText(deps.transport, mailLoginRequest(sso));
    if (!res.ok) return itemFailed(deps, st, `邮箱登录失败：${res.error ?? '未知失败'}`);
    const sess = parseMailSession(res.text);
    if (!sess) return itemFailed(deps, st, '邮箱登录响应里没有 var.sid / var.rmkey');
    const nextPhase =
      st.special === 'aiAssistant' || st.special === 'aiWorkbench' || st.special === 'aiCamera'
        ? 'aiQuery'
        : st.special === 'mailActive'
          ? 'mailActiveAction'
          : st.special === 'sendMail'
            ? 'sendMailAction'
            : st.special === 'pdfConvert'
              ? 'pdfUpload'
              : st.special === 'billView'
                ? 'billViewAction'
                : 'mailDirs';
    save(deps, {
      ...st,
      phase: nextPhase,
      data: { ...(st.data ?? {}), sso: '', sid: sess.sid, rmkey: sess.rmkey, cguid: newCguid() },
      day: today(deps),
    });
    return {
      ok: true,
      note: `邮箱登录成功（sid/rmkey 已拿到）—— 下一步${nextPhase === 'aiQuery' ? '派生 AI 鉴权' : nextPhase === 'mailActiveAction' ? '打邮箱活跃' : nextPhase === 'sendMailAction' ? '发邮件' : nextPhase === 'pdfUpload' ? '传 PDF' : nextPhase === 'billViewAction' ? '看账单' : '取云盘目录'}`,
    };
  }

  if (st.phase === 'noteAuth') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    if (!auth || auth.token === '') {
      const out = advance(deps, doneState(deps, st));
      return { ok: true, note: `云笔记 #${st.itemId}：没有 authToken，跳过。${out.note}` };
    }
    const res = callRawText(deps.transport, noteAuthRequest(auth.token, auth.phone));
    if (!res.ok) return itemFailed(deps, st, `云笔记鉴权失败：${res.error ?? '未知失败'}`);
    const headers = parseNoteHeaders(res.text);
    if (!headers) {
      const out = advance(deps, doneState(deps, st));
      return { ok: true, note: `云笔记 #${st.itemId}：鉴权响应没有 headers.app_auth，跳过。${out.note}` };
    }
    const noteId = uuidV4().replace(/-/g, '').padEnd(32, '0').slice(0, 32);
    save(deps, {
      ...st,
      phase: 'noteCreate',
      data: { ...(st.data ?? {}), noteId, title: noteId.slice(0, 3), headers: JSON.stringify(headers) },
      day: today(deps),
    });
    return { ok: true, note: '云笔记鉴权成功 —— 下一步建笔记' };
  }

  if (st.phase === 'noteCreate') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(st.data?.headers ?? '{}') as Record<string, string>;
    } catch {
      headers = {};
    }
    const res = callRawText(
      deps.transport,
      noteCreateRequest(st.data?.noteId ?? '', st.data?.title ?? '', auth?.phone ?? '', headers, Date.now()),
    );
    save(deps, { ...st, phase: 'noteDelete', day: today(deps) });
    return {
      ok: true,
      note: res.ok ? '云笔记已创建 —— 下一步移进回收站' : `建笔记没成（旧实现也忽略）：${res.error ?? ''} —— 下一步移进回收站`,
    };
  }

  if (st.phase === 'noteDelete') {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(st.data?.headers ?? '{}') as Record<string, string>;
    } catch {
      headers = {};
    }
    const res = callRawText(deps.transport, noteDeleteRequest(st.data?.noteId ?? '', headers));
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: res.ok ? `云笔记已移进回收站。${out.note}` : `删云笔记没成（旧实现也忽略）：${res.error ?? ''}。${out.note}`,
    };
  }

  if (st.phase === 'mailActiveAction') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const a = callRawText(deps.transport, mailAutologinRequest(sess));
    waitGap(deps);
    const b = callRawText(deps.transport, marketClickRequest(st.itemId, 'sign_in_3'));
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: `邮箱活跃 #${st.itemId}（autologin ${a.ok ? 'ok' : '没成'}；市场打卡 ${b.ok ? 'ok' : '没成'}）。${out.note}`,
    };
  }

  if (st.phase === 'sendMailAction') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const a = callRawText(deps.transport, getComposeIdRequest(sess));
    const composeId = a.ok ? parseComposeId(a.text) : undefined;
    if (!composeId) {
      return itemFailed(
        deps,
        { ...st },
        `发邮件：取不到 composeId（HTTP ${a.status}，原文 ${a.text.slice(0, 80).replace(/\s+/g, ' ')}）`,
      );
    }
    const auth = parseAuth(loadAuthRaw(deps.store));
    const account = `${auth?.phone ?? ''}@139.com`;
    waitGap(deps);
    const b = callRawText(
      deps.transport,
      composeMailRequest(sess, {
        composeId,
        account,
        to: account,
        subject: `签到任务测试 ${Date.now()}`,
        content: '本邮件由 mcloud 插件自动发送，可忽略。',
      }),
    );
    const code = b.ok ? mailCode(b.text) : { ok: false, code: '', summary: b.error ?? '' };
    // ③ PE 活跃上报（`eventType "3"` = 发邮件）：参考实现发信成功后才发，**best-effort**。
    //    少了这一枪，上游大概只当"接口被调过"，不当"这个客户端真的发了信"
    //    （2026-11-01 实测：光发信 + 打卡，1004 仍是 `第 1 步`）。
    // ⚠ 用**本条会话**的 cguid（`mailLogin2` 已经生成过），别再新造一个 ——
    //   同一会话两个 cguid，"这次活跃算不算这个会话的"就说不清了（评审 2026-11-01）。
    if (code.ok) waitGap(deps);
    const pe = code.ok
      ? callRawText(deps.transport, peActiveReportRequest(sess, st.data?.cguid ?? newCguid(), Date.now()))
      : undefined;
    // ⚠ 参考实现这一发打的是 `taskClickV2` —— 但那个口**已经死了**：
    //   `caiyun…:7071/ycloud/signin/task/taskClickV2` 回 **404 访问资源不存在**，
    //   换 `m.mcloud.139.com` 又回 405（2026-11-01 实测，Rust 那边 2026-10-07 也记的 404）。
    // ⚠ 而且**这一条开头已经打过卡了**（`click` 阶段那一发，同一趟）——
    //   `task/click` 不可回滚，同一趟打两发是文件头第 ① 条明令禁止的
    //   （评审 2026-11-01：实测一趟两发 id=1004）。已打过就只做 PE 上报。
    const already = freshClicked(st, deps).includes(1004);
    if (!already && pe !== undefined) waitGap(deps);
    const c = already
      ? { ok: true, status: 0, text: '', chars: 0, tookMs: 0, error: undefined }
      : callRawText(deps.transport, clickRequest(deps, 1004));
    const out = advance(deps, doneState(deps, st));
    return {
      // ⚠ 业务失败**不停整趟**（参考实现里 runner 失败只记账，continue 下一条）：
      //   这一条进 `clicked`、收尾那段复查会把它列进"本机动过、服务端仍是待办"。
      ok: true,
      note: code.ok
        ? `邮件已发送到 ${account}（PE 上报 ${pe?.ok ? 'ok' : `没成：${pe?.error ?? '未知'}`}；市场打卡 ${c.ok ? 'ok' : '没成'}）。${out.note}`
        : `发邮件没成（code=${code.code} ${code.summary}）—— 记下，收尾看服务端认不认。${out.note}`,
    };
  }

  if (st.phase === 'camRecognize') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    const s = loadSession(deps.store);
    const tid = uuidV4().replace(/-/g, '').slice(0, 16);
    const res = callRawText(
      deps.transport,
      aiRecognizeRequest(auth?.raw ?? '', st.data?.domain ?? '', tid, s?.deviceId ?? ''),
    );
    const rec = res.ok ? parseAiRecognize(res.text) : undefined;
    if (!rec || !rec.success || !rec.fileId) {
      return itemFailed(deps, st, `AI 相机识图没成：${rec?.message ?? res.error ?? '没有 fileId'}`);
    }
    save(deps, {
      ...st,
      phase: 'camChat',
      data: { ...(st.data ?? {}), fileId: rec.fileId, camTaskId: rec.taskId ?? '' },
      day: today(deps),
    });
    return { ok: true, note: `AI 相机识图成功（fileId ${rec.fileId.length} 字符）—— 下一步对话` };
  }

  if (st.phase === 'camChat') {
    const auth = parseAuth(loadAuthRaw(deps.store));
    const tid = uuidV4().replace(/-/g, '').slice(0, 16);
    const res = callRawText(
      deps.transport,
      aiCameraChatRequest(
        auth?.raw ?? '',
        st.data?.domain ?? '',
        st.data?.fileId ?? '',
        st.data?.camTaskId ?? '',
        tid,
      ),
    );
    const sse = res.ok ? parseSse(res.text) : { events: 0, text: '' };
    const got = sse.events > 0 || sse.text !== '' || (res.ok && res.text.includes('"success":true'));
    // ⚠ 参考实现（`runners.rs` 的 AiCamera）也是"没回话只记一条 note"，
    //   成败交给收尾的矩阵复查 —— 不在这里判死。
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: got
        ? `AI 相机对话完成（events=${sse.events}）。${out.note}`
        : `AI 相机对话没取到输出（events=${sse.events}）—— 记下，等到收尾看服务端认不认。${out.note}`,
    };
  }

  if (st.phase === 'aiQuery') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const res = callRawText(
      deps.transport,
      queryUserTokenRequest(sess, st.data?.cguid ?? newCguid()),
    );
    if (!res.ok) return itemFailed(deps, st, `AI 鉴权 queryUserToken 失败：${res.error ?? '未知失败'}`);
    const t = parseQueryUserToken(res.text);
    const auth = t ? deriveAiAuth(t) : undefined;
    if (!t || !auth) return itemFailed(deps, st, 'queryUserToken 没给全 account/token 或解不出手机号');
    if (auth.userDomainId === '') return itemFailed(deps, st, 'queryUserToken 没给 userDomainId');
    const next = st.special === 'aiCamera' ? 'camRecognize' : 'aiStatus';
    save(deps, {
      ...st,
      phase: next,
      data: {
        ...(st.data ?? {}),
        phone: auth.phone,
        auth: auth.authorization,
        domain: auth.userDomainId,
      },
      day: today(deps),
    });
    return {
      ok: true,
      note: `AI 鉴权已派生（userDomainId ${auth.userDomainId.length} 字符）—— 下一步${next === 'camRecognize' ? '识图' : '查状态'}`,
    };
  }

  if (st.phase === 'aiStatus') {
    const phone = st.data?.phone ?? '';
    const rsa = encryptPhone(phone);
    const res = callRawText(deps.transport, cloudTaskStatusRequest(rsa, st.itemId));
    const cs = res.ok ? parseCloudTaskStatus(res.text) : undefined;
    save(deps, { ...st, phase: 'aiChat', day: today(deps) });
    return {
      ok: true,
      note: cs
        ? `AI 状态读数（taskId=${st.itemId}）：taskStatus=${String(cs.taskStatus)} cloudStatus=${String(cs.cloudStatus)} —— 下一步对话`
        : `AI 状态没读到（不影响对话）—— 下一步对话`,
    };
  }

  if (st.phase === 'aiChat') {
    const auth = st.data?.auth ?? '';
    const domain = st.data?.domain ?? '';
    const res = callRawText(deps.transport, aiChatRequest(auth, domain, '你好'));
    const sse = res.ok ? parseSse(res.text) : { events: 0, text: '' };
    const out = advance(deps, doneState(deps, st));
    return {
      // ⚠⚠ **这里不许判死**：参考实现（`runners.rs:453-465`）遇到"没回话"只记一条
      //   note（`acted` 不算），整趟照常往下走；而这一条到底成没成，由收尾那次
      //   矩阵复查说（用户口径：成功与否看状态变化，不看我们发了啥）。
      //   以前这里 `ok:false` ⇒ `drain` 当场停 ⇒ 后面每条都没机会做
      //   （现场 2026-11-01：三账号全停在 #609，`已完成 0 条`）。
      ok: true,
      note:
        sse.events > 0 && sse.text !== ''
          ? `AI 对话成功（events=${sse.events}，回复 ${sse.text.slice(0, 20)}…）。${out.note}`
          : `AI 对话没取到输出（events=${sse.events}${sse.code === undefined ? '' : ` code=${sse.code}`}${
              sse.message === undefined ? '' : ` ${sse.message}`
            }）${res.ok ? '' : `：${res.error ?? ''}`} —— 记下，等到收尾看服务端认不认。${out.note}`,
    };
  }

  if (st.phase === 'pdfUpload') {
    let ts = Number(st.data?.pdfTs ?? 0);
    if (ts === 0) {
      ts = beginPdfUpload(deps);
      save(deps, { ...st, data: { ...(st.data ?? {}), pdfTs: String(ts) }, day: today(deps) });
    }
    const pdfUploaded = () => {
      const up = JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as {
        fileId?: string;
        ownedByUs?: boolean;
      };
      // 转换要用 fileId；但只有明确是我们造的才允许收尾时删（撞同名时那是用户的文件）。
      save(deps, {
        ...st,
        phase: 'pdfConvert',
        fileId: up.fileId,
        fileOwned: up.ownedByUs === true,
        day: today(deps),
      });
      return { ok: true as const, note: 'PDF 已传完 —— 下一步转换' };
    };
    if (uploadDone(deps)) return pdfUploaded();
    const out = runUploadStep(deps, utf8(makePdf(ts)));
    if (uploadDone(deps)) return pdfUploaded();
    if (!out.ok) return itemFailed(deps, st, out.note);
    return out;
  }

  if (st.phase === 'pdfConvert') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const ts = Number(st.data?.pdfTs ?? Date.now());
    const res = callRawText(
      deps.transport,
      convertPdfRequest(
        sess,
        `asign-pdf-${ts}.pdf`,
        utf8(makePdf(ts)).length,
        st.fileId ?? '',
        String(Math.random()),
        st.data?.cguid ?? newCguid(),
      ),
    );
    const code = res.ok ? mailCode(res.text) : { ok: false, code: '', summary: res.error ?? '未知失败' };
    // ⚠ 转换完要先收尾：以前这里直接 `advance` 会把 fileId 清掉，
    //   传上去的 PDF 就永远留在用户网盘里。
    if (st.fileId !== undefined) {
      save(deps, { ...st, phase: 'trash', day: today(deps) });
      return {
        ok: true,
        note: code.ok
          ? 'PDF 转换完成 —— 下一步收尾'
          : `PDF 转换没成（code=${code.code} ${code.summary}）—— 仍然先收尾（文件不能留在网盘里）`,
      };
    }
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: code.ok ? `PDF 转换完成。${out.note}` : `PDF 转换没成（code=${code.code} ${code.summary}）—— 记下，收尾看服务端认不认。${out.note}`,
    };
  }

  if (st.phase === 'billViewAction') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const cguid = st.data?.cguid ?? newCguid();
    const a = callRawText(deps.transport, billPageRequest(sess, cguid));
    // ⚠ 这一阶段原先一口气 6 枪（账单页 → 搜邮件 → 标已读 → 读信 → 埋点）：
    //   中间没有一拍，等于把"看账单"这件事在一秒里演完。逐枪之间隔 0.5–2 秒。
    waitGap(deps);
    const b = callRawText(deps.transport, billMailsSearchRequest(sess, cguid));
    const mid = b.ok ? firstField(b.text, 'mid') : undefined;
    if (!mid) {
      return itemFailed(deps, st, '账单：邮件列表里取不到 mid');
    }
    waitGap(deps);
    const c = callRawText(deps.transport, markMailReadRequest(sess, cguid, mid));
    waitGap(deps);
    const d = callRawText(deps.transport, readMessageRequest(sess, cguid, mid));
    const mq: boolean[] = [];
    waitGap(deps);
    for (const [actionType, clientType, channel] of [
      ['1003', '2', ''],
      ['1003', '2', ''],
      ['1017', '1', '10242400'],
    ] as const) {
      const r = callRawText(
        deps.transport,
        mailReportToMqRequest(sess, cguid, String(Math.random()), actionType, clientType, mid, channel),
      );
      mq.push(r.ok);
    }
    waitGap(deps);
    const e = callRawText(deps.transport, logBehaviorActionRequest(sess, 111631, 261, cguid, '110542_6'));
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: `账单 #${st.itemId}（页 ${a.ok ? 'ok' : '没成'}；mid 已取；标读 ${c.ok ? 'ok' : '没成'}；读信 ${d.ok ? 'ok' : '没成'}；MQ ${mq.filter(Boolean).length}/3；像素 ${e.ok ? 'ok' : '没成'}）—— 记下，收尾看服务端认不认。${out.note}`,
    };
  }

  if (st.phase === 'mailDirs') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const res = callRawText(deps.transport, mailDirsRequest(sess, st.data?.cguid ?? newCguid()));
    const dir = res.ok ? firstField(res.text, 'directoryId') : undefined;
    save(deps, {
      ...st,
      phase: 'mailSearch',
      data: { ...(st.data ?? {}), directoryId: dir ?? '' },
      day: today(deps),
    });
    return {
      ok: true,
      note: res.ok
        ? `云盘目录已取${dir === undefined ? '（没有 directoryId，落点留空）' : ''} —— 下一步找一封邮件`
        : `云盘目录没取到（落点留空）：${res.error ?? '未知失败'} —— 下一步找一封邮件`,
    };
  }

  if (st.phase === 'mailSearch') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const res = callRawText(deps.transport, mailSearchRequest(sess, st.data?.cguid ?? newCguid()));
    const mid = res.ok ? firstField(res.text, 'mid') : undefined;
    if (!mid) {
      return itemFailed(deps, st, `邮件列表里取不到 mid：${res.error ?? '响应里没有 mid'}`);
    }
    save(deps, { ...st, phase: 'mailBackup', data: { ...(st.data ?? {}), mid }, day: today(deps) });
    return { ok: true, note: `找到邮件 mid（${mid.length} 字符）—— 下一步转存` };
  }

  if (st.phase === 'mailBackup') {
    const sess = { sid: st.data?.sid ?? '', rmkey: st.data?.rmkey ?? '' };
    const res = callRawText(
      deps.transport,
      mailBackupRequest(sess, st.data?.cguid ?? newCguid(), st.data?.mid ?? '', st.data?.directoryId ?? ''),
    );
    const code = res.ok ? mailCode(res.text) : { ok: false, code: '', summary: res.error ?? '未知失败' };
    const out = advance(deps, doneState(deps, st));
    return {
      ok: true,
      note: code.ok
        ? `邮件转存已提交（服务端认了）。${out.note}`
        : `邮件转存没成（code=${code.code} ${code.summary}）—— 记下，收尾看服务端认不认。${out.note}`,
    };
  }

  // ③ 收尾
  if (!st.fileId) {
    // ⚠ **不许发空 fileIds** ⇒ 换下一条
    const out = advance(deps, st);
    return { ok: true, note: `这条没有要收尾的文件 —— 不发空数组那一枪。${out.note}` };
  }
  if (st.fileOwned === false) {
    // 撞上用户已有文件：只做动作，绝不删。
    const out = advance(deps, doneState(deps, { ...st, fileId: undefined, fileOwned: undefined }));
    return { ok: true, note: `这条的文件不是我们造的 ⇒ 不删。${out.note}` };
  }
  const fileId = st.fileId;
  const res = callRawText(deps.transport, trashRequest(deps, [fileId]));
  const parsed = res.ok
    ? parseTrashResult(res.text)
    : { ok: false, code: '', why: res.error ?? '未知失败' };
  if (!parsed.ok) {
    // 登记表里还留着：链尾那一枪会再试，跨天也不会丢。
    // ⚠ 收尾失败**不拖垮整趟**（参考实现里它只是这一条的 problem）。
    const out0 = advance(deps, doneState(deps, { ...st, fileId: undefined, fileOwned: undefined }));
    return { ok: true, note: `收尾 #${st.itemId} 被拒（${parsed.why}）—— 文件留着，链尾再清。${out0.note}` };
  }
  unregisterOwnedFile(deps, fileId);
  // ⚠ 上传槽里如果躺着的正是刚删掉的这一枚，要清掉：434（分享）会用
  //   `mcloud.upload.state.fileId` 当"这一趟传的文件"，不清就会拿着**已删的 id**
  //   去建外链 ⇒ 上游回 `1010010006 …记录已被删除`（现场 2026-11-01 自测）。
  // ⚠ 而且必须清在 `advance` **之前**：`advance` 会给下一条排队上传、把槽覆盖，
  //   那时"槽里正好是刚删的那枚"永远不成立，这一枪就白清了（评审 2026-11-01）。
  try {
    if ((JSON.parse(deps.store.getState('mcloud.upload.state') ?? '{}') as { fileId?: string }).fileId === fileId) {
      clearUpload(deps);
    }
  } catch {
    // 槽里不是 JSON 就不管
  }
  // ⚠ 收尾也要把这一条记成"动过了"：`fileId` 那支以前只清 id 不记 clicked，
  //   于是不打卡的 runner（`currstep != 0`）收完尾又被挑回来 —— 1014 那次 60 步死循环。
  const out = advance(deps, doneState(deps, { ...st, fileId: undefined, fileOwned: undefined }));
  return { ok: true, note: `收尾 #${st.itemId}：文件已移进回收站。${out.note}` };
}

/** 今天这一趟还在用、**不能提前收尾**的文件 id。
 *
 *  链尾兜底清理会跳过它：上传完 → 分享/打卡还没做完时删掉，下一趟就用不了那一枚了。
 *  跨天、已收摊（done/settle）的状态不算 —— 那些才是该清的遗留。 */
export function activeAppTaskFileId(deps: TaskDeps): string | undefined {
  const st = load(deps);
  if (st === null) return undefined;
  if (st.day !== today(deps)) return undefined;
  if (st.phase === 'done' || st.phase === 'settle') return undefined;
  if (st.fileId === undefined) return undefined;
  return st.fileOwned === false ? undefined : st.fileId;
}

/** 还剩几条（面板显示用）。 */
export function remainingCount(deps: TaskDeps): number {
  return pendingItems(deps).length;
}
