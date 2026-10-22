// 任务：听弹幕口令（**只读**）—— 直播那场里主播在弹幕里发的「小红花口令」。
//
// # 这一支是「面板的能力」而不是「插件的算法」的产物
//
// 在第二十一轮之前，弹幕这一支在插件侧是**结构性不可及**的：宿主只有
// `http_fetch`（一次请求一次响应），接不了长连接。第二十一轮补了 `ws_*`，
// 第二十二轮补了「只给 CBC 套件的主机」那条 TLS 路（`tls:"native"`），
// 于是**这条链第一次真的能跑**（实机见 docs/findings.md F-031）。
//
// # 与 mcloud 的两处**有意**差异（都以抓包为准，见 F-029 更正那份实拍）
//
// 1. **不回 UNREAD、改按 15 秒心跳**：mcloud 的 `live_ws.rs` 在 PROVISION 之后补发
//    一次「UNREAD（它编号里的 command=1）」。实拍（133 帧）里 command=1 是
//    **约 15 秒一拍的周期心跳**（共 5 拍），第一条只是**第一拍**，不是"补发"。
// 2. **收到弹幕要回 ack（command=0，带 msgId）**：实拍里客户端每收到一条
//    command=2 就回一条 ack（464 B ×38）；mcloud 的 Rust **不回**。
//
// # 为什么这次是"一步一步推"（而不是像 mcloud 那样一口气听 45 秒）
//
// 面板的单次执行预算 2000ms，而且**打断不了正在阻塞的宿主调用**（F-001 那一族）。
// 所以一次调用只能读 ~1.6 秒，状态落 SQLite（阶段/句柄/窗口/心跳时刻）。
//
// ⚠ **但"读得慢"不等于"会漏"**：宿主侧那条入队通道是**无界的**
// （`src/wsclient.rs` 的 `Out: unbounded_channel`）—— 两次调用之间服务端推的帧
// 会在宿主里排队，下一次调用一次性读出来。所以**节奏影响的是"多快看到口令"，
// 不是"看不看得到"**。这一点决定了这里的间隔可以放得很宽松（默认 10 秒一次）。
//
// # 幂等与代价
//
// * 全链**只读**：门的 ③ + roomBeat + WS 订阅，一个字节都不改上游。
// * 门关着的时候**一个请求都不发**（`nextCheckAtMs` 冷却，见 [`listenerIdle`]）——
//   否则每 10 秒就重跑一次"三发换票"，一天两万多发请求，那是不可接受的。
// * JWT 与 WS 句柄都**只在窗口内活**，窗口结束就 `ws_close` + 抹掉状态。


import { callRawText } from '../client.ts';
import { clearError, recordError } from './base.ts';
import type { HostWs, TaskDeps, TaskOutcome } from './base.ts';
import {
  LIVE_ORIGIN,
  LIVE_USER_AGENT,
  GATE_TAB_IDS,
  cmpassLoginRequest,
  gateSpecTokenRequest,
  koulingRooms,
  mergeRooms,
  parseCmlive,
  parseCmpassLogin,
  parseRoomBeat,
  parseTabContentList,
  parseUserToken,
  roomBeatRequest,
  tabContentListRequest,
  userTokenRequest,
} from '../liveGate.ts';
import { applyRoomRequest, parseApplyRoom } from '../liveIm.ts';
import { wakeSleepMs } from './liveAutoTask.ts';
import { parseSsoToken } from '../h5session.ts';
import { STATE_AUTH, loadAuthRaw } from '../sessionExchange.ts';
import { parseAuthorization } from '../authRefresh.ts';
import { extractKouling, hasKouling, isKoulingHead, isKoulingMarker } from '../liveKouling.ts';
import { KOULING_ANCHOR, loadFreshPool, note, savePoolTo } from '../koulingPool.ts';
import { createListener, sockjsDataFrames } from '../liveWs.ts';
import { CMD_ACK, decodeMsync } from '../msync.ts';
import type { Listener } from '../liveWs.ts';
import type { LiveRoom } from '../liveGate.ts';
import type { Store } from '../../store/types.ts';

/** 一轮的状态（**含凭据与句柄** —— 窗口结束就抹）。 */
export const STATE_LISTEN = 'mcloud.live.listen';
/** WS 主机基址（**CI 的口子**，与门的 `gateBase` 同一套路）。 */
export const STATE_WS_BASE = 'mcloud.live.ws_base';

/** "收到 SockJS 心跳帧 `h` 回什么" 的口子（空串 = 不回）。
 *
 *  ⚠ 抓包答不了这件事（`h` 只在连接静默满 25 秒后才发，而那次 73.6 秒里发了 133 帧、
 *  从未静默满 25 秒 ⇒ **零样本**）。2026-10-14 实机第一次拿到样本：
 *  房间安静满 25 秒 ⇒ 服务端真的发了 `h`，**回一帧 `h` 之后连接继续可用**
 *  （96 秒里帧数 3→10、`closedReason` 一直空）。
 *  ⇒ 默认就是 `'h'`。留这个口子是为了让"**不回**会怎样"那一支也能在真机上被验一次
 *  （F-039），而不是靠猜。 */
export const STATE_WS_HEARTBEAT = 'mcloud.live.ws_heartbeat_reply';

/** "听哪一间房" 的**诊断口子**（空 = 按主播昵称选，正常路径）。
 *
 *  ⚠ 为什么要有它：`h`（SockJS 心跳帧）只在**服务端**静默满 25 秒后才发 ——
 *  正常那间房一直有人说话，这个分支**根本走不到**（F-039 里就这么"没复现"了一次）。
 *  指定一间**安静的房间**就能把它逼出来。
 *
 *  它与 `gateBase` / `wsBase` / `imBase` 是同一族（**测试/诊断用**，界面上照实标出），
 *  不影响"按主播选房"那条正常路径 —— 那种选房判据（昵称精确匹配 + 只算在播）
 *  是业务判据，不该被一个诊断口子替掉。 */
export const STATE_LISTEN_ROOM = 'mcloud.live.listen_room';

export function loadListenRoom(store: Pick<Store, 'getState'>): number | undefined {
  const v = (store.getState(STATE_LISTEN_ROOM) ?? '').trim();
  if (v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function saveListenRoom(store: Store, v: string, nowIso: string): void {
  store.setState(STATE_LISTEN_ROOM, v.trim(), nowIso);
}
export const DEFAULT_WS_HEARTBEAT = 'h';

export function loadWsHeartbeat(store: Pick<Store, 'getState'>): string {
  const v = store.getState(STATE_WS_HEARTBEAT);
  // ⚠ 没配过（`null`）⇒ 用默认；配成**空串** ⇒ 就是"不回"（那是用户的显式选择）
  return v === null || v === undefined ? DEFAULT_WS_HEARTBEAT : v;
}

export function saveWsHeartbeat(store: Store, v: string, nowIso: string): void {
  store.setState(STATE_WS_HEARTBEAT, v, nowIso);
}

/** 生产 WS 端点。**逐字**来自抓包 §一：`wss://videoim.cmcc-cs.cn:20102`。 */
export const BASE_VIDEO_IM_WS = 'wss://videoim.cmcc-cs.cn:20102';

/** 默认监听窗口（秒）。窗口到点就断开、把状态归零；下一次触发重新走一遍门。 */
export const DEFAULT_LISTEN_SECONDS = 600;
/** 没开播时**默认**过多久再看一次（毫秒）。
 *
 *  ⚠ 它只是**兜底**。有「直播自动定时」的计划时，冷却会睡到那一刻
 *  （`live-auto` 按「下一场」+1 小时算出来，mcloud 的口径）——
 *  固定 5 分钟的话，一天要白问 288 次门。 */
export const IDLE_RECHECK_MS = 5 * 60 * 1000;
/** 冷却的上限（毫秒）：没有计划时不许比这个更久，有计划时也不许睡过头（12 小时）。 */
export const MAX_IDLE_RECHECK_MS = 12 * 60 * 60 * 1000;

/** **这一次**该隔多久再看门。
 *
 *  有「下一场」的计划 ⇒ 睡到那一刻（那是 `live-auto` 算的，mcloud 口径）；
 *  没有/计划已到点 ⇒ 退回默认的 [`IDLE_RECHECK_MS`]。
 *  ⚠ 上限 [`MAX_IDLE_RECHECK_MS`]：日程可能被平台改成很久以后，
 *  但"睡 12 小时以上"这件事本身就该被怀疑（上游日程是几天前的读数）。 */
function idleCooldownMs(deps: ListenDeps, nowMs: number): number {
  const sleep = wakeSleepMs(deps.store, nowMs, loadListenSeconds(deps.store) * 1000);
  if (sleep === undefined || sleep <= 0) return IDLE_RECHECK_MS;
  return Math.min(sleep, MAX_IDLE_RECHECK_MS);
}
/** 单次调用里最多读多久（毫秒）—— 预算是 2000ms，留出余量给心跳/落库/日志。 */
export const READ_BURST_MS = 1600;
/** 一次 `ws_recv` 等多久（毫秒）。loop 起来凑满 [`READ_BURST_MS`]。 */
export const RECV_SLICE_MS = 700;
/** 握手超时（毫秒）—— 与 `ws_open` 的默认一致。 */
export const WS_OPEN_TIMEOUT_MS = 8000;

export type ListenStep =
  | 'handshake'
  | 'rooms'
  /** 取 WS 凭据（`userToken`）—— ⚠ 不是门那个 JWT（见 `liveGate.userTokenRequest`）。 */
  | 'userToken'
  | 'roomBeat'
  /** 进聊天室（`member/apply`）—— **不发给房间推消息**，这是"听不到"的根因。 */
  | 'apply'
  | 'open'
  | 'listen'
  | 'done';

/** 这个任务**额外**需要宿主的长连接能力（`ws_*`）。
 *  用"交叉类型"而不是往公共 `TaskDeps` 里加字段：这样只有它自己知道这个前提。 */
export type ListenDeps = TaskDeps & { host: HostWs };

export interface ListenState {
  step: ListenStep;
  /** 窗口起点（毫秒）—— 窗口长度按它算。 */
  windowStartMs: number;
  /** 冷却：到这个时刻之前**一个请求都不发**（门关着时用它）。 */
  nextCheckAtMs?: number;
  jwt?: string;
  /** WS 凭据（`userToken` 换来的 `access_token`）。PROVISION 的 `auth` 用它。 */
  accessToken?: string;
  roomId?: number;
  chatRoomId?: string;
  /** `member/apply` 过了没有。 */
  applied?: boolean;
  /** 按 `command` 分的收帧计数（`{"0":n,"1":n,"2":n,...}`）—— 诊断用。 */
  kinds?: Record<string, number>;
  /** 上一帧是"口令头"（`复制口令1：` 结尾），口令内容在**下一帧**。
   *
   *  ⚠ 这一格必须**落盘**：两次调用之间服务端可能已经把下一帧推过来了，
   *  而我们的调用是分拍的（一拍照 1.6 秒）。只在内存里记 = 一跨拍就丢。
   *  ⚠ 参考实现（`mcloud-sign` 的 `live-room-kouling.ts:245-260`）就是这么做的：
   *  `pendingKouling` 标记 + 下一帧"不是口令头、不是标记词"就当作口令收下。 */
  pendingHead?: boolean;
  /** 连"是不是 SockJS 数据帧"都没认出来的文本帧条数（探针自己的失败计数）。 */
  decodeFail?: number;
  /** **上次真的去探门**是什么时候（ISO）。
   *
   *  ⚠ 它存在的理由：空闲时这条任务每 10 秒醒一次、每次都返回同一句"门关着"，
   *  而"在探门"与"只是把旧读数重复说一遍"在**日志**里长得一样
   *  （2026-10-14 soak 里我就是靠数 ①/② 那两行才分清的）。把时刻摆进读数，
   *  一眼就能看出最后一次真探是什么时候。 */
  probedAt?: string;
  /** 收到过几帧 SockJS 心跳 `h`。
   *
   *  ⭐ 这一格是"实验有没有真的走到那个分支"的判据 —— 没有它，
   *  一次"没复现"与一次"复现了但没事"在读数上**长得一样**（F-039 就吃过这个亏）。 */
  sockjsHb?: number;
  /** 收到的**服务端回执帧**（`cmd=0`）条数。
   *
   *  ⭐ 这是"我们那条**缩短过的 ack** 服务端认不认"的**证据位**：
   *  我们每收到一条弹幕就回一条 `{1:{1:msgId}}`（实拍客户端回的是 464 B 整条回显），
   *  服务端如果**明白**我们在确认，就会回一条 94 B 的 `cmd=0`。
   *  所以这个数只要在涨，就说明短 ack 是被理解的（F-032 里那一支"未判定"）。
   *  ⚠ 它**不涨**也可能是"服务端不回执"，不能单凭它下结论说 ack 被拒。 */
  serverAcks?: number;
  /** WS 句柄（宿主侧的编号；**面板重启后就失效** ⇒ 那时必须重新 `ws_open`）。 */
  handle?: number;
  lastHeartbeatAtMs?: number;
  /** 这一轮的读数。 */
  frames: number;
  danmakuFrames: number;
  acks: number;
  codes: string[];
  /** 上一次结束的原因（人话）。 */
  closedReason?: string;
  startedAt: string;
  finishedAt?: string;
  note?: string;
}

const parseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export function loadListenState(store: Pick<Store, 'getState'>): ListenState | null {
  return parseJson<ListenState>(store.getState(STATE_LISTEN));
}

export function loadWsBase(store: Pick<Store, 'getState'>): string {
  const v = store.getState(STATE_WS_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : BASE_VIDEO_IM_WS;
}

export function saveWsBase(store: Store, base: string, nowIso: string): void {
  store.setState(STATE_WS_BASE, base.trim().replace(/\/+$/, ''), nowIso);
}

/** 拼 SockJS 端点。**形状逐字来自抓包 §一**
 *  （`wss://videoim.cmcc-cs.cn:20102/ws/<serverId 0-999>/<sessionId>/websocket`）。 */
export function liveWsUrl(base: string, serverId: number, sessionId: string): string {
  return `${base.replace(/\/+$/, '')}/ws/${serverId}/${sessionId}/websocket`;
}

/** 随机 sessionId（8 字符）。**它不参与鉴权**（抓包 §一：路径里两段都是随机的），
 *  所以这里用 `Math.random` 就够 —— 唯一的代价是"可复现性"，而那是测试的事：
 *  测试一律显式把 url 传进来，不走这个函数。 */
export function sockjsSessionId(rand: () => number = Math.random): string {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alpha[Math.floor(rand() * alpha.length)] ?? 'a';
  return out;
}

export function randomServerId(rand: () => number = Math.random): number {
  return Math.floor(rand() * 1000);
}

/** WS 升级请求要带的头。
 *
 *  ⚠ 抓包 §一那三条判据：**不带** `systemmd5`/`tokenmd5`（身份只在 PROVISION 的
 *  `auth` 里）、UA 用 **iPad** 那个、`Origin` 必须是直播页那个。 */
export function wsHandshakeHeaders(): Record<string, string> {
  return { origin: LIVE_ORIGIN, 'user-agent': LIVE_USER_AGENT };
}

/** 现在该不该**啥也不干**（冷却里）。
 *
 *  它存在的理由只有一个：门关着时**不能**每 10 秒重跑一次"三发换票"。
 *  返回一句话给日志，`undefined` = 该干活了。 */
export function listenerIdle(st: ListenState, nowMs: number): string | undefined {
  if (st.nextCheckAtMs !== undefined && nowMs < st.nextCheckAtMs) {
    // ⚠ 说**本地时间**。`toISOString()` 是 UTC —— 用户在日志里看到 `03:54Z`
    //   会以为那是"凌晨三点"（本地是 11:54），这种时间戳比没有还糟。
    const d = new Date(st.nextCheckAtMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `现在没在听，${at} 之后再去看`;
  }
  return undefined;
}

// ── 当前这条连接上的那个"听"对象 ────────────────────────────────────────────
//
// ⚠⚠ **它必须在两次调用之间活着**，不能每拍新建一个：状态机里那些字段
// （`provisionSent` / `enteredRoom` / 心跳时刻 / 已 ack 过的 msgId）就是
// "对面认不认我们"的全部记忆。每拍新建 ⇒ 每次都是"还没进房间"⇒ 不回 ack、
// 不发心跳（第一版就是这么写的，测试里那条 ack 断言当场红）。
//
// 它能活的原因：插件的模块在 QuickJS 上下文里**只加载一次**，cron 回调之间
// 是同一个上下文 ⇒ 模块级的这个变量跨调用有效。
//
// ⚠ 面板重启后它会没（进程没了），而**句柄也会跟着失效** —— 两件事同生共死，
// 所以"句柄不在 ⇒ 重新走一遍门"这条判据同时也覆盖了它。
let current:
  | { handle: number; windowStartMs: number; chatRoomId: string; listener: Listener }
  | undefined;

/** `h`（SockJS 心跳）的处置档位 —— **两档**（2026-10-14 实测定下来的）。
 *
 *  * `reply` —— 回一帧 `h`（默认）
 *  * `none`  —— 不回
 *
 *  ⚠⚠ 原来还有第三档"不回且收尾"，**实测之后删掉了**：在那间安静的房里 90 秒里
 *  服务端发了 **6 拍 `h`**，我们**一次都没回**，连接**一直活着**（`closedReason` 始终空）
 *  ⇒ "不回会被踢"这个担心不成立 ⇒ 收到 `h` 收尾是白白丢掉听的时间。
 *
 *  ⇒ 现在**两档都不把 `h` 当成收尾理由**（只记进读数 `sockjsHb`），差别只在"回不回那一帧"。 */
export type HbPolicy = 'reply' | 'none';

export function hbPolicyOf(v: string): HbPolicy {
  return v === 'h' ? 'reply' : 'none';
}

/** 口子那格字符串 ⇒ listener 的选项（`none` 档 = `undefined` = 不回）。 */
function parseHeartbeatReply(v: string): string | undefined {
  return hbPolicyOf(v) === 'reply' ? v : undefined;
}

function listenerFor(
  deps: ListenDeps,
  st: ListenState,
  nowMs: number,
  opts: { accessToken: string; chatRoomId: string; phone: string },
): Listener {
  const handle = st.handle ?? -1;
  if (
    current !== undefined &&
    current.handle === handle &&
    current.windowStartMs === st.windowStartMs &&
    current.chatRoomId === opts.chatRoomId
  ) {
    return current.listener;
  }
  const listener = createListener({
    accessToken: opts.accessToken,
    chatRoomId: opts.chatRoomId,
    phone: opts.phone,
    // ⚠ 这一格照抓包给**空串**（§5.5：字段在、长度为 0），不是毫秒串。
    deviceUuid: '',
    // ⚠⚠ `h`（SockJS 心跳）抓包**零样本**（§四 4.1），所以这一格是**实机试出来的**：
    //   2026-10-14 那场房间里安静满 25 秒 ⇒ 服务端真的发了 `h`；回一帧 `h`
    //   之后连接继续可用（读数与判据见 docs/findings.md F-032）。
    //   回 `[""]` 是**错的**：那是 SockJS 的**关闭**帧（抓包 §二 末帧）。
    sockjsHeartbeatReply: parseHeartbeatReply(loadWsHeartbeat(deps.store)),
  });
  current = {
    handle,
    windowStartMs: st.windowStartMs,
    chatRoomId: opts.chatRoomId,
    listener,
  };
  return listener;
}

/** 推进一步。一次调用**最多两发上游请求**（与门同一条纪律）。 */
export function runLiveListen(deps: ListenDeps): TaskOutcome {
  const nowMs = Date.parse(deps.nowIso);
  const prev = loadListenState(deps.store);
  const windowMs = loadListenSeconds(deps.store) * 1000;

  // ① **冷却优先，而且优先于"重置状态"**：上一轮判完"门关着"之后，
  //    状态里那个 `nextCheckAtMs` 就是这一段时间里唯一要记住的东西。
  //    ⚠ 先重置再判冷却的话，冷却会被**自己抹掉** —— 于是每 10 秒重跑一次三发换票。
  //    （这个坑我在写第一版时真的踩了：见测试「门关着 ⇒ 冷却期内一发请求都不发」。）
  if (prev !== null && prev.step === 'done') {
    const idle = listenerIdle(prev, nowMs);
    if (idle !== undefined) return { ok: true, note: idle };
  }

  // ② 只有这三种情况才算"新的一轮"：没状态 / 上一轮已收尾 / 窗口过时。
  //    ⚠ **别把"进度中"也算成过时** —— 那会让 handshake → rooms → roomBeat 这条链
  //      永远停在第一步（每一步都被重置回去）。
  //    ⚠⚠ `listen` / `open` 例外：那两个阶段的"窗口到点"必须由**它们自己**处置
  //      （要先 `ws_close` 再收尾）。用这里的外层判据去重置，会让"主动断开"那一支
  //      永远走不到 —— 句柄就一直挂在那儿。
  const inWindow = prev !== null && (prev.step === 'listen' || prev.step === 'open');
  const stale =
    prev === null ||
    prev.step === 'done' ||
    (!inWindow && nowMs - prev.windowStartMs > windowMs);
  const st: ListenState = !stale
    ? (prev as ListenState)
    : {
        step: 'handshake',
        windowStartMs: nowMs,
        frames: 0,
        danmakuFrames: 0,
        acks: 0,
        codes: [],
        startedAt: deps.nowIso,
      };

  switch (st.step) {
    case 'handshake':
      return handshakeStep(deps, st);
    case 'rooms':
      return roomsStep(deps, st, nowMs);
    case 'userToken':
      return userTokenStep(deps, st);
    case 'roomBeat':
      return roomBeatStep(deps, st, nowMs);
    case 'apply':
      return applyStep(deps, st, nowMs);
    case 'open':
      return openStep(deps, st, nowMs);
    case 'listen':
      return listenStep(deps, st, nowMs, windowMs);
    default:
      return finish(deps, st, '窗口已结束');
  }
}

/** 监听窗口（秒）的配置口子 —— 与 `gateBase` 同源：一个 state 键就够。 */
export const STATE_LISTEN_SECONDS = 'mcloud.live.listen_seconds';

export function loadListenSeconds(store: Pick<Store, 'getState'>): number {
  const raw = store.getState(STATE_LISTEN_SECONDS);
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : DEFAULT_LISTEN_SECONDS;
}

function persist(deps: ListenDeps, st: ListenState): void {
  deps.store.setState(STATE_LISTEN, JSON.stringify(st), deps.nowIso);
}

function stepFail(deps: ListenDeps, st: ListenState, note: string): TaskOutcome {
  recordError(deps.store, 'live-listen', note, deps.nowIso);
  // ⚠ 失败时**不丢状态**：下一拍还能接着推（换票这步可重试）。
  persist(deps, st);
  return { ok: false, note };
}

/** ①+②：换 SSO 再换直播侧 JWT。**必须同一次调用**（SSO 只活几分钟 —— 门那边实测过）。 */
function handshakeStep(deps: ListenDeps, st: ListenState): TaskOutcome {
  const base = loadGateBaseOf(deps.store);
  const auth = loadAuthRaw(deps.store);
  if (auth === '') {
    return stepFail(deps, st, '听弹幕要**原生凭据**（`Authorization`）：先去界面贴一份');
  }

  const r1 = callRawText(deps.transport, gateSpecTokenRequest(auth, base));
  if (!r1.ok) return stepFail(deps, st, `① 换 SSO token 失败：${r1.error ?? '未知失败'}`);
  const sso = parseSsoToken(r1.text);
  if (!sso.ok || sso.value === undefined) {
    return stepFail(deps, st, `① 换 SSO token 失败：${sso.error ?? '响应里没有 data.token'}`);
  }

  const r2 = callRawText(deps.transport, cmpassLoginRequest(sso.value, base));
  if (!r2.ok) return stepFail(deps, st, `② 换直播侧 JWT 失败：${r2.error ?? '未知失败'}`);
  const env = parseCmlive(r2.text);
  if (!env.ok || env.value === undefined) {
    return stepFail(deps, st, `② 换直播侧 JWT 失败：${env.error ?? '响应解不出来'}`);
  }
  const jwt = parseCmpassLogin(env.value);
  if (!jwt.ok || jwt.value === undefined) {
    return stepFail(deps, st, `② 换直播侧 JWT 失败：${jwt.error ?? 'object 不是 JWT'}`);
  }

  st.jwt = jwt.value;
  st.step = 'rooms';
  persist(deps, st);
  clearError(deps.store, 'live-listen', deps.nowIso);
  return { ok: true, note: '开始听了' };
}

/** ③ 两个页签各一发 → 合并 → 找那个主播的**在播**房间。 */
function roomsStep(deps: ListenDeps, st: ListenState, nowMs: number): TaskOutcome {
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? '';
  if (jwt === '') return stepFail(deps, st, '③ 没有票（上一拍的 JWT 不在）');

  const groups: LiveRoom[][] = [];
  for (const tabId of GATE_TAB_IDS) {
    const r = callRawText(deps.transport, tabContentListRequest(tabId, jwt, base));
    if (!r.ok) return stepFail(deps, st, `③ 页签 ${tabId} 失败：${r.error ?? '未知失败'}`);
    const env = parseCmlive(r.text);
    if (!env.ok || env.value === undefined) {
      return stepFail(deps, st, `③ 页签 ${tabId} 失败：${env.error ?? '响应解不出来'}`);
    }
    const parsed = parseTabContentList(env.value);
    if (!parsed.ok || parsed.value === undefined) {
      return stepFail(deps, st, `③ 页签 ${tabId} 失败：${parsed.error ?? '房间列表解不出来'}`);
    }
    groups.push([...parsed.value]);
  }
  // ⚠ 去重交给 `mergeRooms`（**两个页签里同一间房会出现两次**：实机确认过）
  const merged = mergeRooms(groups);
  void nowMs;

  // 门那条判据：**按主播昵称精确匹配 + 只算在播**（同一刻可能有两间房在播，实测过）
  //
  // ⚠ 诊断口子优先：指定了房间号就直接用那一间（`status` 不筛 —— 用它就是为了
  //   去一间"可能在播但没人说话"的房，把 `h` 那个分支逼出来）。房号不在列表里也算数：
  //   `roomBeat` 会自己告诉我们那间房有没有聊天室（那一步的判据不该被这里预先否决）。
  const forced = loadListenRoom(deps.store);
  // ⚠ 两条路只在"选哪一间"上不同，**后面的所有判据都共用**（roomBeat 才是"有没有聊天室"
  //   的唯一判据，见 liveGate 的注释）。所以这里收敛成一个 `chosen`，而不是分叉整段逻辑。
  const chosen: number | undefined =
    forced !== undefined ? forced : koulingRooms(merged)[0]?.id;
  if (chosen === undefined) {
    st.step = 'done';
    const coolMs = idleCooldownMs(deps, Date.parse(deps.nowIso));
    st.nextCheckAtMs = Date.parse(deps.nowIso) + coolMs;
    st.closedReason = '那个主播没在播';
    st.finishedAt = deps.nowIso;
    st.probedAt = deps.nowIso;
    st.note =
      forced !== undefined
        ? `指定的房间 ${forced} 不在这次探到的 ${merged.length} 间房里（诊断口子）`
        : coolMs > IDLE_RECHECK_MS
          // 「门」是内部说法；用户看到的是"现在没在听，为什么、什么时候再看"
          ? `现在没在听（看到 ${merged.length} 间房，但没有「${KOULING_ANCHOR}」的）—— 到下一场之后再去看（${hours(coolMs)}）`
          : `现在没在听（看到 ${merged.length} 间房，但没有「${KOULING_ANCHOR}」的）—— 隔 ${hours(coolMs)}再看` +
            // ⚠ 带上"上次真探"的时刻：空闲时这条任务每 10 秒醒一次、读数**一模一样**，
            //   日志去重之后一个窗口只会留一行 —— 那一行必须能回答"这次是真探过，还是
            //   只是把旧读数重复了一遍"（2026-10-14 soak 里我就是靠数 ①/② 那两行才分清的）。
            `（上次真探 ${deps.nowIso.slice(11, 19)}）`;
    persist(deps, st);
    // ⚠ 这句是**存下来的**（冷却期十几小时，不会重写）—— 出日志前统一翻一遍
    return { ok: true, note: humanNote(st.note) };
  }
  st.roomId = chosen;
  // ⚠ 顺序照 mcloud 的 `listen_danmaku_with`：先取 **WS 凭据**，再问聊天室号，再进房间。
  st.step = 'userToken';
  st.probedAt = deps.nowIso;
  persist(deps, st);
  return {
    ok: true,
    note:
      forced === undefined
        ? `找到了：房间 ${st.roomId} 在播，接着去听`
        : `诊断口子：直接听指定的房间 ${st.roomId}，接着取 WS 凭据`,
  };
}

/** 老记录里的内部说法就地翻掉（冷却期很长，不能等下次真探）。 */
function humanNote(note: string): string {
  return note
    .replace(/门关着（合并后 (\d+) 间房）/g, '现在没在听（看到 $1 间房）')
    .replace(/门关着/g, '现在没在听')
    .replace(/门开着/g, '正在听')
    // 「（720 分钟）」→「（12 小时）」
    .replace(/（(\d+) 分钟）/g, (_m, n: string) => `（${hours(Number(n) * 60000)}）`);
}

/** `720 分钟` 不如 `12 小时` 好读 —— 超过 90 分钟就换成小时。 */
function hours(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 90) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return `${h} 小时`;
}

/** ③ 取 WS 凭据（`userToken`）。
 *
 *  ⚠⚠ 2026-10-14 实机：漏了这一步（拿门的 JWT 当 WS 凭据）⇒ **一条弹幕都收不到**
 *  （只有自己的心跳回包）。表现与"这间房没人说话"完全一样，所以我先误判成后者。 */
function userTokenStep(deps: ListenDeps, st: ListenState): TaskOutcome {
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? '';
  if (jwt === '') return stepFail(deps, st, '③ 没有票（上一拍的 JWT 不在）');
  const r = callRawText(deps.transport, userTokenRequest(jwt, base));
  if (!r.ok) return stepFail(deps, st, `③ 取 WS 凭据失败：${r.error ?? '未知失败'}`);
  const parsed = parseUserToken(r.text);
  if (!parsed.ok || parsed.value === undefined) {
    return stepFail(deps, st, `③ 取 WS 凭据失败：${parsed.error ?? '响应里没有 access_token'}`);
  }
  st.accessToken = parsed.value.accessToken;
  st.step = 'roomBeat';
  persist(deps, st);
  return { ok: true, note: `③ 取到 WS 凭据（${parsed.value.accessToken.length} 字符，${parsed.value.expiresIn}s）` };
}

/** ④ roomBeat → `chatRoomId`。**没有它就不该开 WS**（抓包 §一/§5.2 的判据）。 */
function roomBeatStep(deps: ListenDeps, st: ListenState, nowMs: number): TaskOutcome {
  void nowMs;
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? '';
  if (st.roomId === undefined || jwt === '') {
    return stepFail(deps, st, '④ 缺房间号或票（上一拍的状态不完整）');
  }
  const r = callRawText(deps.transport, roomBeatRequest(st.roomId, jwt, base));
  if (!r.ok) return stepFail(deps, st, `④ roomBeat 失败：${r.error ?? '未知失败'}`);
  const parsed = parseRoomBeat(r.text);
  if (!parsed.ok || parsed.value === undefined) {
    return stepFail(deps, st, `④ roomBeat 失败：${parsed.error ?? '响应解不出来'}`);
  }
  const beat = parsed.value;
  // ⚠ 空/缺 `chatRoomId` = **没有聊天室** ⇒ 这里就停下，不发 WS。
  //   用"没有"而不是"给了个空串"是因为后面的动作完全相反（见 liveGate 的注释）。
  if (beat.chatRoomId === undefined) {
    st.step = 'done';
    st.nextCheckAtMs = Date.parse(deps.nowIso) + idleCooldownMs(deps, Date.parse(deps.nowIso));
    st.closedReason = `房间 ${st.roomId} 没有聊天室（status=${beat.status}）`;
    st.finishedAt = deps.nowIso;
    st.note = st.closedReason;
    persist(deps, st);
    return { ok: true, note: st.note };
  }
  st.chatRoomId = beat.chatRoomId;
  st.step = 'apply';
  persist(deps, st);
  return {
    ok: true,
    note: `房间 ${st.roomId}（${beat.title || '无标题'}）聊天室 ${st.chatRoomId}，接着进房间`,
  };
}

/** ⑤ 进聊天室（`member/apply`）—— **建 WS 之前**那一步。
 *
 *  ⚠⚠ 这是"听不到弹幕"的**根因**：连得上、心跳通、PROVISION 也回了，但服务端
 *  不往这条连接推房间消息（2026-10-14 实机对照：补上这一步之前 96 秒零弹幕）。
 *
 *  ⚠ 两个签名头**服务端不校验**（抓包 §8.6 反证实验：打全 0 照样 `code:0`），
 *  但仍然按实拍算式算出来 —— 报文与原客户端一致，别的地方才不会在某天突然露出来。 */
function applyStep(deps: ListenDeps, st: ListenState, nowMs: number): TaskOutcome {
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null) return stepFail(deps, st, '⑤ 进房间要手机号（`userName` 用 `cmlive_c_<手机>`）');
  if (st.chatRoomId === undefined || st.accessToken === undefined) {
    return stepFail(deps, st, '⑤ 进房间缺聊天室号或 WS 凭据（上一拍的状态不完整）');
  }
  // ⚠ `userName` 与 `invoker` **同一个串**（照 mcloud 的调用点）。
  const userName = `cmlive_c_${parsed.phone}`;
  const req = applyRoomRequest(st.chatRoomId, userName, userName, st.accessToken, String(nowMs), {
    // 没配口子 ⇒ `applyRoomRequest` 自己用真主机（`BASE_VIDEO_IM`）
    base: loadImBase(deps.store),
  });
  const r = callRawText(deps.transport, req);
  if (!r.ok) return stepFail(deps, st, `⑤ 进房间失败：${r.error ?? '未知失败'}`);
  const out = parseApplyRoom(r.text);
  if (!out.ok) return stepFail(deps, st, `⑤ 进房间失败：${out.error}`);
  st.applied = true;
  st.step = 'open';
  persist(deps, st);
  return {
    ok: true,
    note: `⑤ 进房间成功（appId=${out.value.appId || '?'}，回显聊天室 ${out.value.roomId || '?'}）`,
  };
}

/** 开 WS + 等 `o` + 发 PROVISION。**这三件事必须同一次调用**：
 *  `o` 是立刻到的（握手响应），而 PROVISION 只能**在收到 `o` 之后**发。 */
function openStep(deps: ListenDeps, st: ListenState, nowMs: number): TaskOutcome {
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null) {
    return stepFail(deps, st, 'WS 那一步要手机号（PROVISION 的 `guid.name` 用它）—— 凭据解不出来');
  }
  if (st.chatRoomId === undefined || st.jwt === undefined) {
    return stepFail(deps, st, '开 WS 缺聊天室号或票（上一拍的状态不完整）');
  }

  const url = liveWsUrl(loadWsBase(deps.store), randomServerId(), sockjsSessionId());
  const opts: { headers: Record<string, string>; timeout_ms: number; tls?: 'native' } = {
    headers: wsHandshakeHeaders(),
    timeout_ms: WS_OPEN_TIMEOUT_MS,
  };
  // ⚠ 这条守卫与 HTTP 那条（`hostFetchOptions`）**同一个理由**，别省：
  //   宿主对 `tls:"native"` 是**先校验选项再连接** ⇒ 给 `ws://`（CI 的 mock 就是这个）
  //   填它，在没有 `legacy-tls` 的宿主上会**直接报错**，连"反正明文用不上"的机会都没有。
  //   有它，e2e 才能在**默认构建**的面板上跑（否则每次 e2e 都得挂一个 feature 构建）。
  if (url.startsWith('wss:')) opts.tls = 'native'; // 真主机只给 CBC 套件 ⇒ 必须平台 TLS
  let handle: number;
  try {
    handle = deps.host.wsOpen(url, opts);
  } catch (e) {
    return stepFail(deps, st, `开 WS 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  st.handle = handle;
  const listener = listenerFor(deps, st, nowMs, {
    accessToken: st.jwt,
    chatRoomId: st.chatRoomId,
    phone: parsed.phone,
  });

  // 第一读：`o` 应当立刻到；到了就发 PROVISION。没到就把句柄存下来，下一拍接着等。
  let first;
  try {
    first = deps.host.wsRecv(handle, RECV_SLICE_MS);
  } catch (e) {
    // ⚠ 宿主对**句柄不存在**是**抛**（不是返回 close）—— 见 listen 步那段同样的说明。
    try {
      deps.host.wsClose(handle);
    } catch {
      /* 幂等 */
    }
    current = undefined;
    st.handle = undefined;
    st.step = 'done';
    st.closedReason = `句柄失效（${e instanceof Error ? e.message : String(e)}）`;
    st.finishedAt = deps.nowIso;
    persist(deps, st);
    return { ok: false, note: `WS 句柄失效：${st.closedReason}` };
  }
  if (first.type === 'close' || first.type === 'error') {
    deps.host.wsClose(handle);
    st.handle = undefined;
    st.step = 'done';
    st.closedReason = first.type === 'close' ? first.reason : first.message;
    st.finishedAt = deps.nowIso;
    persist(deps, st);
    return { ok: false, note: `WS 刚连上就断了：${st.closedReason ?? ''}` };
  }

  let sent = 0;
  if (first.type === 'text') {
    const actions = listener.onFrame(first.data, nowMs);
    sent += flush(deps, handle, actions.outbound);
    st.frames += 1;
  }
  if (sent === 0) {
    // 还没收到 `o`（少见但正常）：留着句柄，下一拍再等。
    persist(deps, st);
    return { ok: true, note: 'WS 连上了，还没等到 SockJS 的 `o`（下一拍接着等）' };
  }
  st.lastHeartbeatAtMs = nowMs;
  st.step = 'listen';
  persist(deps, st);
  return { ok: true, note: `WS 连上了（句柄 ${handle}），PROVISION 已发 —— 开始听弹幕` };
}

/** 听一拍：读满 [`READ_BURST_MS`]，把该回的回了，把口令落池。 */
function listenStep(deps: ListenDeps, st: ListenState, nowMs: number, windowMs: number): TaskOutcome {
  const handle = st.handle;
  if (handle === undefined) {
    // 句柄没了（**面板重启过**就是这一种）⇒ 重新走一遍，别假装还在听。
    current = undefined;
    st.step = 'handshake';
    persist(deps, st);
    return { ok: true, note: 'WS 句柄不在了（面板重启过？）⇒ 重新走一遍门' };
  }
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null || st.jwt === undefined || st.chatRoomId === undefined) {
    return stepFail(deps, st, '听的那一步缺凭据/票/聊天室号');
  }
  const listener = listenerFor(deps, st, nowMs, {
    accessToken: st.jwt,
    chatRoomId: st.chatRoomId,
    phone: parsed.phone,
  });

  const deadline = Date.now() + READ_BURST_MS;
  const found: string[] = [];
  let endReason: string | undefined;
  // ⚠ 循环的**唯一**退出条件：读满这一段墙钟。`timeout` 是正常结果，
  //   不是错误（宿主 API 的语义），所以这里不停地在 timeout 上继续。
  while (Date.now() < deadline) {
    const sliceMs = Math.min(RECV_SLICE_MS, Math.max(120, deadline - Date.now()));
    let frame;
    try {
      frame = deps.host.wsRecv(handle, sliceMs);
    } catch (e) {
      // ⚠ 宿主对**句柄不存在**是**抛**（不是返回 close）—— 面板重启过 / 已经关过
      //   都会走到这里。不接住的话异常会冒到路由上（现象是一个 500，
      //   而真正该看见的是"这条连接没了，重新走一遍门"）。
      endReason = `句柄失效（${e instanceof Error ? e.message : String(e)}）`;
      break;
    }
    if (frame.type === 'close') {
      endReason = frame.reason;
      break;
    }
    if (frame.type === 'error') {
      endReason = frame.message;
      break;
    }
    if (frame.type !== 'text') continue; // timeout / binary：继续等
    st.frames += 1;
    if (frame.data === 'h') st.sockjsHb = (st.sockjsHb ?? 0) + 1;
    // ⚠ 这里自己解一遍**只是为了计数**（状态机那边已经解过了）。按 `command` 分类记：
    //
    //   `cmd=0` = 服务端对我们 ack 的**回执** ⇒ 这一格只要在涨，就说明
    //   **我们那条缩短过的 ack 是被理解的**（实拍客户端回 464 B 整条回显，
    //   我们只回 `{1:{1:msgId}}` —— F-032 里这一支标的是"未判定"）。
    //
    //   ⚠⚠ 探针**不许影响主流程**：`sockjsDataFrames` 只认 `a[...]`，遇到 `h`/`o`/`c[`
    //   会抛 ⇒ 必须自己接住。第一版没接住、而且接错了位置（那段替换没落在循环里），
    //   现象是"回执恒 0 而主流程看着正常" —— 探针把自己的读数弄坏了两次。
    try {
      for (const bytes of sockjsDataFrames(frame.data)) {
        const cmd = decodeMsync(bytes).command;
        const k = String(cmd);
        st.kinds = { ...(st.kinds ?? {}), [k]: ((st.kinds ?? {})[k] ?? 0) + 1 };
        if (cmd === CMD_ACK) st.serverAcks = (st.serverAcks ?? 0) + 1;
      }
    } catch {
      st.decodeFail = (st.decodeFail ?? 0) + 1;
    }
    const actions = listener.onFrame(frame.data, Date.now());
    flush(deps, handle, actions.outbound);
    if (actions.outbound.length > 0) st.acks += 1;
    if (actions.texts.length > 0) {
      st.danmakuFrames += 1;
      for (const text of actions.texts) {
        // ① 上一帧是"口令头"（`复制口令1：`）⇒ 这一帧就是口令内容
        //   （参考实现同一套：`pendingKouling` → 下一帧直接收下）
        if (st.pendingHead === true) {
          const t = text.trim();
          // 不是"又一句口令头"、也不是标记词，才算内容（否则会把下一句弹幕当口令）
          if (t !== '' && !isKoulingHead(t) && !isKoulingMarker(t)) {
            found.push(t);
          }
          st.pendingHead = false;
        }
        // ② 正常提取（单行/多行都能切）
        if (hasKouling(text)) {
          for (const code of extractKouling(text)) found.push(code);
        }
        // ③ 这一帧以口令头结尾 ⇒ 内容在下一帧，记下来
        if (isKoulingHead(text)) st.pendingHead = true;
      }
    }
    if (actions.closed !== undefined) {
      // ⚠ 收到 SockJS 心跳 `h` **不是**收尾理由（2026-10-14 实测：不回也活了 6 拍 / 90 秒）。
      //   只把它记进读数（`sockjsHb`），继续听 —— 原来那一版收到就收尾，是在白丢听的时间。
      if (actions.closed.includes('SockJS 心跳帧')) continue;
      endReason = actions.closed;
      break;
    }
  }

  if (found.length > 0) {
    // ⚠ 来源写 `danmaku` —— 池里这一档早就留好了（`xiaohongshu` 是另一档），
    //   它让"这条口令是从弹幕里听来的"与"从小红书主页抓来的"在池里分得开。
    const { pool } = loadFreshPool(deps.store, Date.now());
    note(pool, found, 'danmaku', Date.now());
    savePoolTo(deps.store, pool, deps.nowIso);
    for (const code of found) if (!st.codes.includes(code)) st.codes.push(code);
  }

  // 心跳：**每一拍都要看一眼**它到点没（15 秒一拍，而我们的调用间隔是 10 秒）
  const due = listener.dueHeartbeat(Date.now());
  if (due.length > 0) {
    flush(deps, handle, due);
    st.lastHeartbeatAtMs = Date.now();
  }

  if (endReason !== undefined) {
    try {
      deps.host.wsClose(handle);
    } catch {
      // 已经关了就是幂等的；抛出来只可能是句柄失效，那更该忽略。
    }
    current = undefined;
    st.handle = undefined;
    st.step = 'done';
    st.closedReason = endReason;
    st.finishedAt = deps.nowIso;
    st.note = `弹幕连接结束：${endReason}（这一段里收到 ${st.frames} 帧、弹幕 ${st.danmakuFrames} 条）`;
    persist(deps, st);
    return { ok: true, note: st.note };
  }

  if (Date.now() - st.windowStartMs >= windowMs) {
    try {
      deps.host.wsClose(handle);
    } catch {
      /* 幂等 */
    }
    current = undefined;
    st.handle = undefined;
    st.step = 'done';
    st.closedReason = '窗口到点';
    st.finishedAt = deps.nowIso;
    st.note = `窗口到点，主动断开（收到 ${st.frames} 帧、弹幕 ${st.danmakuFrames} 条、口令 ${st.codes.length} 条）`;
    persist(deps, st);
    return { ok: true, note: st.note };
  }

  persist(deps, st);
  const got = found.length > 0 ? `，本轮口令 ${found.join(' / ')}` : '';
  return {
    ok: true,
    // 与 `listenReadingLine` 同一套说法：只报弹幕/口令，帧数是排查用的
    note: `正在听（收到 ${st.danmakuFrames} 条弹幕，捡到 ${st.codes.length} 条口令${got}）`,
  };
}

function flush(deps: ListenDeps, handle: number, outbound: readonly string[]): number {
  let n = 0;
  for (const text of outbound) {
    try {
      deps.host.wsSend(handle, text);
      n += 1;
    } catch {
      // 发不出去 = 句柄没了（面板重启过 / 已经关了）。下一拍会走"重新走一遍门"。
      break;
    }
  }
  return n;
}

function finish(deps: ListenDeps, st: ListenState, note: string): TaskOutcome {
  current = undefined;
  if (st.handle !== undefined) {
    try {
      deps.host.wsClose(st.handle);
    } catch {
      /* 幂等 */
    }
    st.handle = undefined;
  }
  st.step = 'done';
  st.finishedAt = deps.nowIso;
  st.note = note;
  persist(deps, st);
  return { ok: true, note };
}

/** 进房间那一台（`videoim.cmcc-cs.cn:20103`）的口子。
 *
 *  ⚠ 与门的 `gateBase` **不是同一个键**：门在 `v.cmcc-cs.cn`（HTTPS，直播侧），
 *  进房间在 `videoim`（HTTPS，**带端口 20103**）。混成一个的后果是 CI 里
 *  `member/apply` 打到真主机上 —— 现象是一个 **401**（我第一版就是这样，
 *  而 401 看起来像"凭据不对"，会让人去查 token 而不是查配置）。 */
export const STATE_IM_BASE = 'mcloud.live.im_base';

export function loadImBase(store: Pick<Store, 'getState'>): string | undefined {
  const v = store.getState(STATE_IM_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : undefined;
}

export function saveImBase(store: Store, base: string, nowIso: string): void {
  store.setState(STATE_IM_BASE, base.trim().replace(/\/+$/, ''), nowIso);
}

/** 取门那个 `gateBase` 口子（**同一个键**：两台主机在 CI 里就是同一个 mock）。 */
function loadGateBaseOf(store: Pick<Store, 'getState'>): string | undefined {
  const v = store.getState('mcloud.live.gate_base');
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : undefined;
}

/** SockJS 的一条服务端帧拆出来的字节串（导出给测试用 —— 它的形状就是"解析"那一半）。 */
export { sockjsDataFrames };

/** 给界面/日志用的一行读数。 */
export function listenReadingLine(st: ListenState | null): string {
  if (st === null) return '还没听过';
  if (st.step === 'listen') {
    // 用户只关心"听到几条弹幕、捡到几条口令"；帧数/心跳是排查用的，不写
    const bits = [`收到 ${st.danmakuFrames} 条弹幕`];
    if (st.codes.length > 0) bits.push(`捡到 ${st.codes.length} 条口令`);
    if ((st.serverAcks ?? 0) > 0) bits.push(`回了 ${st.serverAcks} 次`);
    return `正在听（${bits.join('、')}）`;
  }
  if (st.step === 'done') {
    // ⚠ 老记录里存的是旧说法（「门关着（合并后 N 间房）」）。冷却期长达十几小时，
    //   期间一直显示**存下来的那句** —— 所以在这里就地翻一遍，不等下次真探。
    return humanNote(st.note ?? '这一轮结束');
  }
  return `准备中（${st.step}）`;
}
