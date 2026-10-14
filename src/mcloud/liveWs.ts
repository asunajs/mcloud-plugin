// 直播弹幕 WebSocket 的 **SockJS 帧处理 + 状态机** —— 纯层：不碰 IO、不读时钟。
//
// 权威源（四级口径，用户口径 2026-10-14 / F-026）：
//
// ```text
//   ① 业务逻辑 → 照 mcloud：crates/mcloud-upstream/src/live_ws.rs（879 行，它是 Go
//                参考的第二次移植，文件头记了「为什么状态机在纯层、连接在 io 层」）
//   ② 内容/判据 → 抓包：mcloud-capture/docs/capture/app-live-ws-samples.txt
//                （2026-09-23，两条真 WS：133 帧 / 73.6 s 与 139 帧 / 66.5 s）
//   ③ 算法     → 不适用：这一层**没有**口令抽取（抽取在 liveKouling.ts，池在 koulingPool.ts）
//   ④ 效果     → 未实测：本插件从面板走这条链只到「连接已建立」（docs/findings.md F-030）
// ```
//
// ⚠⚠ **本层与 mcloud 的 Rust 有 6 处有意差异**，每一处都在代码里就地标了依据。
// 先读这 6 条，别把差异当抄漏：
//
// | # | 差异 | 依据 |
// |---|---|---|
// | 1 | 收到 `command=2`（弹幕）**回一条 `command=0`（ack，带 msgId）** | 抓包 §3.2（客户端帧 ×38） |
// | 2 | **没有 UNREAD 这个概念**：`command=1` 是**约 15 秒一次的心跳** | 抓包 §四（5 拍、间隔 14.9–15.1 s） |
// | 3 | 心跳的**第一拍紧跟 PROVISION ack**（抓包 +608 ms，ack 在 +515 ms） | 抓包 §四 |
// | 4 | PROVISION 的 `resource` = **`webim_<毫秒>`**（Rust 是 `js_<毫秒>`） | 抓包 §5.5 |
// | 5 | `deviceUuid` **由调用方给**（实拍是**空串**；Rust 写毫秒十进制串） | 抓包 §5.5 |
// | 6 | 收到 SockJS 心跳 `h` ⇒ **不许猜**，报「未判定」交给调用方 | 抓包 §四 4.1（全程零样本） |
//
// # 状态机的形状（照 Rust）
//
// 每收到一帧调一次 [`Listener.onFrame`]，它返回**要回发的帧**与**这一帧解出的文本**；
// 连接由调用方持有。这样整条帧序列可以用一串字面量在单测里跑完 —— 而真 WS 只在
// 主播开播那一小时才存在（2026-09-22 实拍：`chatRoomId: null` ⇒ 结构性不存在）。
//
// # 一帧能表达的四类动作（对应 Rust 的 `FrameActions`）
//
// | 连接层要做的事 | 本层怎么表达 |
// |---|---|
// | 什么都不做 | `outbound` 空 且 `closed === undefined` |
// | 回文本帧 | `outbound` 里是 `["<b64>"]` 形状的字符串（SockJS 全是文本帧） |
// | 关闭连接（带原因） | `closed` 是一句**人话** |
//
// ⚠ Rust 的 `FrameKind` / `Outbound::Binary` **本文件没做**：调用方给的
// `ListenerActions` 只有 `outbound` / `texts` / `closed` 三个字段，没有「这一帧归成哪一类」
// 的通道（多塞一个字段会让调用方的 `deepEqual` 断言莫名其妙地红）。归类只在本文件内部
// 用于「连续坏帧计数要不要清零」。见文件尾「未判定 / 没做」。
//
// # 关闭原因的文本是**契约**（调用方靠前缀区分三档）
//
// ```text
//   '服务端关闭帧 c['  … 服务端关了这条连接（Rust: kind=Closed，close=None）
//   '连续 N 帧解不开'  … 我们这侧放弃（Rust: CloseReason::TooManyMalformed）
//   '收到 SockJS 心跳帧 h' … ⚠ 未判定项，见下
// ```
//
// # ⚠ 未判定（抓包答不了，所以不猜）
//
// `h`（SockJS 心跳）在 133 帧里**一次都没出现**：`h` 只在连接**静默满 25 秒**后才发，
// 而那条连接 73.6 秒发了 133 帧（业务帧每 1–2 秒一条）⇒ 从未静默到 25 秒。
// 于是「收到 `h` 该回 `h` 还是回 `[""]`」**本轮无样本 ⇒ 判为未判定**。
// 本层**不猜、不回帧**，而是把这件事报到 `closed` 上让调用方决定。

import { fromBase64, toBase64 } from '../crypto/bytes.ts';
import {
  CMD_ACK,
  CMD_DANMAKU,
  CMD_HEARTBEAT,
  CMD_PROVISION,
  decodeMsync,
  encodeAck,
  encodeHeartbeat,
  encodeProvision,
} from './msync.ts';

// ══════════════════════════ SockJS 帧前缀 ══════════════════════════

/** SockJS 的「连接已打开」帧 —— 收到它才发 PROVISION。 */
export const SOCKJS_OPEN = 'o';

/** SockJS 的「心跳」帧 —— ⚠ **未判定**，本层不猜（见文件头）。 */
export const SOCKJS_HEARTBEAT = 'h';

/** SockJS 的「服务端关闭」帧前缀（形状 `c[3000,"Go away!"]`）。
 *
 *  ⚠ 证据档位要写清：这个形状来自 Rust 的 `SOCKJS_CLOSE_PREFIX`，**不是**本次抓包的统计段
 *  —— §二 那 133 帧是 `o` 1 + `a[` 85 + `[` 46 + `""` 1，**一条 `c[` 都没有**
 *  （那次的关闭是**客户端**主动发空串）。任务是「按抓包实现」，而抓包对 `c[…]` 只有
 *  任务口径的一句话（「服务端会推 c[…]」）⇒ 前缀按 Rust 认，这一条如实标出来。 */
export const SOCKJS_CLOSE_PREFIX = 'c[';

/** SockJS 的**数据帧**前缀（服务端推下来：`a["<base64>"]`，一条或多条消息）。
 *
 *  ⚠ 前缀与方向是**满的**（抓包 §二：`a[` 85/85 全是 S→C、`[` 46/46 全是 C→S，零反例）。 */
export const SOCKJS_DATA_PREFIX = 'a[';

/** 客户端关闭时发的**空串**帧（抓包 §二 末帧 `[132]`，C→S，`len=0`）。
 *
 *  本层只**认**它（当入站帧收到时归为 `ignored`，不算坏帧）；真关闭由调用方写出去。 */
export const CLIENT_CLOSE_FRAME = '';

// ══════════════════════════ 对外的接口 ══════════════════════════

export interface ListenerOptions {
  accessToken: string;
  chatRoomId: string;
  phone: string;
  deviceUuid: string;
  /** 心跳间隔，默认 15000（抓包 §四 实测约 15 秒：14929 / 15128 / 14896 / 15022 ms）。 */
  heartbeatMs?: number;
  /** **连续**解不开的帧数上限，超了就请调用方收工；默认 8。
   *
   *  ⚠ 这个阈值是**我们定的**（Rust 也是），没有任何实拍依据 —— 它只是「别无限挂着」的
   *  兜底，别当成协议常量。`0` = 不因坏帧关闭（一直挂着，直到调用方自己的超时）。 */
  malformedLimit?: number;
  /** 收到 SockJS 心跳帧 `h` 时**回什么**。
   *
   *  ⚠ 抓包答不了这件事（§四 4.1：`h` 只在连接静默满 25 秒后才发，而那次 73.6 秒里
   *  发了 133 帧、从未静默满 25 秒 ⇒ **零样本**）。
   *  * 不传（默认）= 不猜、不回帧，把这件事报到 `closed` 上一句人话（调用方决定）。
   *  * 传字符串（例如 `'h'`）= 原样回那一帧 —— 这条是**实机测出来的**（2026-10-14：
   *    房间安静 25 秒，服务端真的发了 `h`；回 `h` 之后连接继续可用，见 docs/findings.md F-032）。 */
  sockjsHeartbeatReply?: string | undefined;
}

export interface ListenerActions {
  /** 要写出去的**文本帧**，按顺序（`["<b64>"]` 形状或 `h`）。 */
  outbound: readonly string[];
  /** 这一帧里解出的弹幕文本（`command=2`）。 */
  texts: readonly string[];
  /** 需要断开时给一句**人话**原因，否则 `undefined`。 */
  closed: string | undefined;
}

export interface ListenerState {
  provisionSent: boolean;
  provisionAckSeen: boolean;
  /** 收到过 `o` **并且**收到过 PROVISION 的响应（`command=3`）才算进过房间。
   *
   *  它区分「对面把我们踢了」与「根本没收下我们」（Rust 文件头那三态表：
   *  `Disconnected` vs `PeerGone`）—— 这两件事的处置完全不同，一个该重连、一个该报错。 */
  enteredRoom: boolean;
  heartbeatCount: number;
  lastHeartbeatAtMs: number | undefined;
  closed: boolean;
}

export interface Listener {
  onFrame(text: string, nowMs: number): ListenerActions;
  state(): ListenerState;
  /** 该不该在「没收到任何帧」的空转里补一次心跳（调用方每次 ws_recv 超时后调它）。 */
  dueHeartbeat(nowMs: number): readonly string[];
}

// ══════════════════════════ SockJS 帧的包/拆 ══════════════════════════

/** 把一条已编码的 MSync 报文包成 SockJS 的**发送**形状：`["<base64>"]`。
 *
 *  ⚠ 别与入站的 `a["<base64>"]` 混起来（抓包 §二 那个方向×前缀表）：
 *
 *  ```text
 *    客户端发 → `["<b64>"]`     （无前缀，**本函数**）
 *    服务端推 → `a["<b64>"]`    （前缀 `a[`，由 `sockjsDataFrames` 拆）
 *  ```
 *
 *  前缀写错的表现是「帧被归成不认识的一类、安静丢掉」⇒「连上了、心跳也正常、
 *  就是收不到弹幕」，与别的故障症状**一模一样**。base64 的字符集只有
 *  `A-Za-z0-9+/=`，不含引号与反斜杠 ⇒ 这里不必过 `JSON.stringify`（Rust 也是手拼）。 */
export function sockjsSendFrame(msync: Uint8Array): string {
  return `["${toBase64(msync)}"]`;
}

/** `a["<b64>"]` 形状的服务端帧 ⇒ 若干 msync 字节串（**解析用**）。
 *
 *  按 JSON 解而不是 `slice(3, lastIndexOf('"]'))`：后者**只对单条消息成立**，
 *  而 SockJS 缓冲时会一次推多条（`a["QUJD","REVG"]`），那种帧被切出来是
 *  `QUJD","REVG` ⇒ 解不开 ⇒ **整帧被丢**。这一处与 Rust 的做法一致
 *  （Rust 的注释里也说它刻意偏离了原 TS 实现）。
 *
 *  ⚠ 只有「不是合法 JSON 数组」才**抛**（这是唯一能表达"这帧读不懂"的通道）；
 *  base64 用本仓的**宽容**解码器（忽略空白与非法字符），坏 base64 ⇒ 得到垃圾字节
 *  ⇒ 由 `decodeMsync` 的 `isMsync: false` 判成坏帧（与 Rust 的 `b64_decode` 失败
 *  殊途同归）。⚠ 判据看**返回值**，不是异常 —— 见下面调用点那段说明。 */
export function sockjsDataFrames(text: string): readonly Uint8Array[] {
  return splitDataFrameJson(text).map((b64) => fromBase64(b64));
}

/** 把 `a[...]` 拆成 base64 字符串数组（**只认 JSON 形状**，不碰 base64）。 */
function splitDataFrameJson(text: string): string[] {
  // 跳过前缀里的 `a`，把剩下的 `[...]` 当 JSON 数组解。
  const json = text.slice(SOCKJS_DATA_PREFIX.length - 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (e) {
    throw new Error(`SockJS 数据帧不是合法 JSON 数组：${String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('SockJS 数据帧不是 JSON 数组');
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new Error('SockJS 数据帧的数组元素必须是 base64 字符串');
    }
    out.push(item);
  }
  return out;
}

// ══════════════════════════ 帧的归类（内部）══════════════════════════

/** 一帧被归成了哪一类 —— **仅供本文件内部**决定「连续坏帧计数要不要清零」。
 *
 *  ⚠ 它**不导出**：调用方的 `ListenerActions` 没有这一档的位置（见文件头）。 */
type Kind =
  | 'ignored'
  | 'heartbeat'
  | 'open'
  | 'closed'
  | 'provision_ack'
  | 'danmaku'
  | 'silent'
  | 'malformed';

interface Handled {
  kind: Kind;
  outbound: string[];
  texts: string[];
  closed: string | undefined;
}

// ══════════════════════════ 状态机 ══════════════════════════

const DEFAULT_HEARTBEAT_MS = 15000;
/** Rust 的默认值也是 8（`malformed_limit: 8`，附注：我们定的兜底，不是协议常量）。 */
const DEFAULT_MALFORMED_LIMIT = 8;

/** 关闭原因的三档前缀（调用方靠它区分，见文件头）。 */
export const CLOSE_REASON_SERVER = '服务端关闭帧 c[';
export const CLOSE_REASON_MALFORMED = '连续 ';
export const CLOSE_REASON_SOCKJS_HEARTBEAT = '收到 SockJS 心跳帧 h';

interface Machine {
  /** 收到过 `o`（与 `provisionAckSeen` 一起构成 `enteredRoom` 的判据）。 */
  openSeen: boolean;
  /** PROVISION **只发一次** —— 重复发会让服务端把这条连接当成**新会话**（Rust 注释）。 */
  provisionSent: boolean;
  provisionAckSeen: boolean;
  heartbeatCount: number;
  lastHeartbeatAtMs: number | undefined;
  /** **连续**解不开的帧数（任何一帧能被归类都清零）。 */
  consecutiveMalformed: number;
  /** 已定的关闭原因；一旦有值，之后一律静默（并且把同一句原因重复报出去）。 */
  closeReason: string | undefined;
}

/** 造一个监听器（纯状态机，**不持有连接、不取时钟**）。 */
export function createListener(o: ListenerOptions): Listener {
  const heartbeatMs = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const malformedLimit = o.malformedLimit ?? DEFAULT_MALFORMED_LIMIT;

  const st: Machine = {
    openSeen: false,
    provisionSent: false,
    provisionAckSeen: false,
    heartbeatCount: 0,
    lastHeartbeatAtMs: undefined,
    consecutiveMalformed: 0,
    closeReason: undefined,
  };

  /** 收工：记下原因并把它报出去（幂等 —— 后续帧重复报同一句）。 */
  const giveUp = (reason: string): ListenerActions => {
    st.closeReason = reason;
    return { outbound: [], texts: [], closed: reason };
  };

  /** 心跳帧（`["<b64>"]`，command=1）。 */
  const heartbeatFrame = (nowMs: number): string => {
    st.heartbeatCount += 1;
    st.lastHeartbeatAtMs = nowMs;
    return sockjsSendFrame(encodeHeartbeat(nowMs));
  };

  const onFrameInner = (text: string, nowMs: number): Handled => {
    // ── `h`：SockJS 心跳 ⇒ ⚠ **未判定，不许猜**（抓包 §四 4.1 全程零样本） ──────
    //
    // Rust 回一个 `h`（`SOCKJS_HEARTBEAT` 原样回）。抓包**答不了**这件事
    // ——`h` 只在连接静默满 25 秒后才发，而那次 73.6 秒发了 133 帧、从未静默满 25 秒。
    // 所以这里**不猜、不回帧**，把这件事报到 `closed` 上（一句人话）：
    // 回 `h`、回 `[""]`、还是干脆断开，交给调用方 —— 无样本时"选一个"就是编。
    //
    // ⚠ 它**不**置 `st.closeReason`：状态机自己没被这件事关掉，调用方若选择继续
    // （例如它另有判据），后续帧照常工作。每收到一次 `h` 就重新报一次。
    if (text === SOCKJS_HEARTBEAT) {
      if (o.sockjsHeartbeatReply !== undefined) {
        // 实机测过的那条路：回一帧（内容由调用方给，我们只负责"原样回"）。
        return {
          kind: 'heartbeat',
          outbound: [o.sockjsHeartbeatReply],
          texts: [],
          closed: undefined,
        };
      }
      return {
        kind: 'heartbeat',
        outbound: [],
        texts: [],
        closed:
          `${CLOSE_REASON_SOCKJS_HEARTBEAT}：抓包 §四 4.1 全程零样本（业务帧太密，` +
          '从未静默满 25 秒）⇒「h 该回什么」判为**未判定**，本层不猜、不回帧；' +
          '请调用方决定（回 "h" / 回 [""] / 忽略并断开）',
      };
    }

    // ── `c[...]`：服务端关闭 ⇒ 报关闭，之后什么都不回 ────────────────────────
    //
    // ⚠ 与 Rust 的一处口径差：Rust 里 `kind == Closed` 但 `close` 留 `None`
    // （「连接已经是关的，没有『再去关一次』这件事」）。本接口只有一个 `closed` 通道，
    // 且任务口径是「`c[…]` ⇒ 报关闭」⇒ 这里报到 `closed` 上，原因文案是那句契约前缀。
    if (text.startsWith(SOCKJS_CLOSE_PREFIX)) {
      return {
        kind: 'closed',
        outbound: [],
        texts: [],
        closed: `${CLOSE_REASON_SERVER}…]：服务端关闭了这条连接，不再往上写任何东西`,
      };
    }

    // ── `o`：连接打开 ⇒ 发 PROVISION（**只发一次**） ─────────────────────────
    if (text === SOCKJS_OPEN) {
      st.openSeen = true;
      if (st.provisionSent) {
        // 重复的 `o`：SockJS 重连时会再发一次，但 PROVISION 只能发一次
        // —— 重复发会让服务端把这条连接当成新会话。
        return { kind: 'open', outbound: [], texts: [], closed: undefined };
      }
      // ⚠ `resource` = `webim_<13 位毫秒>`（抓包 §5.5 的字段 13）——**这里与 mcloud 的
      // Rust 不同**（Rust 写 `js_<毫秒>`），理由是抓包 §5.5 逐字节核过：
      // `resource: "webim_<13位毫秒>"`，而 `deviceUuid`（字段 9）实拍是**空串**。
      // （`deviceUuid` 由调用方给 —— 见 options.deviceUuid 的说明。）
      const resource = `webim_${nowMs}`;
      const frame = sockjsSendFrame(
        encodeProvision(
          { accessToken: o.accessToken, resource, deviceUuid: o.deviceUuid, phone: o.phone },
          nowMs,
        ),
      );
      st.provisionSent = true;
      return { kind: 'open', outbound: [frame], texts: [], closed: undefined };
    }

    // ── 其余都不是数据帧：不认识的帧安静丢掉（Rust 同样） ────────────────────
    //
    // ⚠ 空串（客户端关闭那一帧，抓包 §二 末帧）落在这里 ⇒ `ignored`。
    // 它不是坏帧（「这条连接还在说我们的协议」），所以会把连续坏帧计数**清零**。
    if (!text.startsWith(SOCKJS_DATA_PREFIX)) {
      return { kind: 'ignored', outbound: [], texts: [], closed: undefined };
    }

    // ── 数据帧：`a["<b64>", …]` ────────────────────────────────────────────
    let pieces: string[];
    try {
      pieces = splitDataFrameJson(text);
    } catch {
      // 整帧读不懂（JSON 形状不对）⇒ 坏帧。
      return { kind: 'malformed', outbound: [], texts: [], closed: undefined };
    }

    const outbound: string[] = [];
    const texts: string[] = [];
    let kind: Kind = 'silent';
    let malformed = false;

    for (const piece of pieces) {
      // ⚠⚠ 坏帧判据**不能靠异常**：`decodeMsync` 是"解不开也不抛"的设计
      //   （它返回 `isMsync: false`），而 `fromBase64` 是宽容解码器（垃圾字节能进来）。
      //   靠 `try/catch` 的结果是**那一支永远不触发** —— "坏 base64 ⇒ 计坏帧"
      //   这句注释里的行为根本不成立（2026-10-15 由 msync 的作者指出，我改掉了）。
      const decoded = decodeMsync(fromBase64(piece));
      if (!decoded.isMsync) {
        // 一条解不开**不算**这一帧的失败：`a[...]` 里可以有多条，也还有下一帧。
        malformed = true;
        continue;
      }
      const command = decoded.command;
      const msgId = decoded.msgId;
      const frameTexts = decoded.texts;

      // command 的取值照抓包 §三（⚠ Go/Rust 的枚举**命名是反的**：
      // 那边 `CmdSync=0` / `CmdNotice=2`，实拍里 0 是 ack、2 才是弹幕）：
      //   0 双向 ack/回执 · 1 心跳（C 发起、S 回）· 2 S→C 弹幕 · 3 PROVISION 握手
      switch (command) {
        case CMD_PROVISION: {
          kind = 'provision_ack';
          // 「这条连接真的建立起来了」—— 它区分「直播结束（从未建起来）」与「被断开」。
          st.provisionAckSeen = true;
          // ⚠ 与 Rust 的**有意差异**：Rust 在这里补发一条 `command=1` 并把它叫 UNREAD
          // （"少了这一条服务端不推弹幕"）。抓包 §四**不支持**这个解释：那条 command=1
          // 只是**心跳序列的第一拍**（共 5 拍、间隔约 15 秒），全程既没有 UNREAD 这个概念、
          // 也没有任何"补发"的痕迹。所以这里按**心跳**实现：第一拍紧跟 ack
          // （抓包：ack +515 ms、第一拍 +608 ms；那 93 ms 是客户端自己的调度抖动，纯层不建模），
          // 之后的每一拍由 `dueHeartbeat` 驱动。
          if (st.lastHeartbeatAtMs === undefined) {
            outbound.push(heartbeatFrame(nowMs));
          }
          break;
        }
        case CMD_DANMAKU: {
          kind = 'danmaku';
          if (frameTexts.length > 0) {
            texts.push(...frameTexts);
          }
          // ⚠⚠ 与 Rust 的**有意差异**：真实客户端**每收到一条 command=2 就回一条
          // command=0**（带被确认的 msgId），服务端再回一条 command=0 作回执 ——
          // 抓包 §3.2 逐字段核过（客户端 464 B ×38、服务端 94 B ×39）。
          // Rust 的 `live_ws.rs` **不回 ack**（只对 cmd=3 特判），这是它自己记在
          // 「与 Go 实现的差异汇总」第 2 条里的一条真实行为差异。
          if (msgId === undefined) {
            // ⚠ 无 msgId 就**不能** ack —— 不许编一个（抓包里每条 cmd=2 都带 19 位
            // msgId，所以这一支**没有样本**，标成未判定）。也不计入坏帧：这一帧确实
            // 解开了，只是缺字段，「对面不是我们以为的端点」那个判据不成立。
            break;
          }
          outbound.push(sockjsSendFrame(encodeAck(msgId, nowMs)));
          break;
        }
        case CMD_ACK:
          // 服务端对我们 ack 的**回执**（抓包 §3.2 那 94 B / 39 条）⇒ 不回。
          break;
        case CMD_HEARTBEAT:
          // 服务端对心跳的回应（抓包 §四 那 87 B）⇒ 不回（回了就是回环）。
          break;
        default:
          // 别的 command（4 LOGOUT / 5 / 6 ROUTE / 7 …）：当前零样本，安静丢掉。
          break;
      }
    }

    // 一帧里只要有一条读得懂，这一帧就说明「这条连接还在说我们的协议」⇒ 不算坏帧。
    if (malformed && kind === 'silent') {
      kind = 'malformed';
    }
    return { kind, outbound, texts, closed: undefined };
  };

  const onFrame = (text: string, nowMs: number): ListenerActions => {
    // 已经定了收工原因（服务端关了 / 我们放弃了）：什么都别写出去
    // （往一条已关的连接写只会得到错误），但把那句人话**重复报**出去，幂等。
    if (st.closeReason !== undefined) {
      return { outbound: [], texts: [], closed: st.closeReason };
    }

    const r = onFrameInner(text, nowMs);

    // ⚠ 清零只在这**一个**地方做 —— 它看的是**归类结果**，不是内层的局部量。
    // Rust 的早先写法是「只在数据帧那一段记账」，于是 `h` / `o` / `c[...]` 那些
    // early return 都**绕过了清零** ⇒ 连续坏帧计数只增不减，一条正常的心跳流
    // 也会在攒够 8 个坏帧后被判成「对面不是我们的端点」（它的
    // `a_good_frame_resets_the_malformed_counter` 抓出来的 bug）。
    if (r.kind === 'malformed') {
      st.consecutiveMalformed += 1;
    } else {
      st.consecutiveMalformed = 0;
    }

    if (r.kind === 'malformed' && malformedLimit !== 0 && st.consecutiveMalformed >= malformedLimit) {
      // `malformedLimit === 0` = 不因坏帧关闭（Rust 同义）。
      // ⚠ 单个坏帧是**正常**的（协议会演进）；**连续**坏帧才说明对面不是这个端点，
      // 而那时继续挂着只会一直烧时间，且表现是「连上了、就是没弹幕」，与真正该查的
      // 方向（授权、房间号）无关。
      return giveUp(
        `${CLOSE_REASON_MALFORMED}${st.consecutiveMalformed} 帧解不开（上限 ${malformedLimit} 帧）` +
          '：这条连接还在通，但说的不是我们的协议 ⇒ 请收工（别挂到超时）',
      );
    }

    if (r.kind === 'closed') {
      // 服务端关闭：**封口** —— 之后再收到任何帧都不回东西（`closeReason` 一旦有值，
      // 下一次 `onFrame` 会在最上面直接返回同一句原因）。
      st.closeReason = r.closed;
    }

    // ⚠ `h`（kind === 'heartbeat'）那一支**故意不封口**：状态机没被它关掉，
    // 只是把「未判定」这件事报出去（见 onFrameInner 里那段注释）。
    return { outbound: r.outbound, texts: r.texts, closed: r.closed };
  };

  const dueHeartbeat = (nowMs: number): readonly string[] => {
    // 收工之后不再写（往已关的连接写只会得到错误）。
    if (st.closeReason !== undefined) {
      return [];
    }
    // 抓包 §四：心跳序列以 PROVISION 的响应为起点（第一拍 +608 ms，心跳本身在 ack 之前
    // 一次都没有出现）⇒ 还没进房间就别发心跳。⚠ 这一条是**从抓包序列推出来的**：
    // 「ack 之前有没有心跳」在实拍里没有反例，但也没有正面样本（ack 来得太快）。
    if (!st.provisionAckSeen) {
      return [];
    }
    if (st.lastHeartbeatAtMs !== undefined && nowMs - st.lastHeartbeatAtMs < heartbeatMs) {
      return [];
    }
    return [heartbeatFrame(nowMs)];
  };

  const state = (): ListenerState => ({
    provisionSent: st.provisionSent,
    provisionAckSeen: st.provisionAckSeen,
    // 判据照 Rust：收到过 `o` **并且**收到过 PROVISION 的响应（cmd=3）才算进过房间。
    enteredRoom: st.openSeen && st.provisionAckSeen,
    heartbeatCount: st.heartbeatCount,
    lastHeartbeatAtMs: st.lastHeartbeatAtMs,
    closed: st.closeReason !== undefined,
  });

  return { onFrame, state, dueHeartbeat };
}

// ══════════════════════════ 未判定 / 没做（别当抄漏） ══════════════════════════
//
// 1. **`h` 该回什么 —— 未判定**（抓包 §四 4.1 全程零样本）。本层报到 `closed` 上，
//    不猜、不回帧。要拍它得让连接**真的静默 25 秒以上**。
// 2. **`command=2` 里没有 msgId 时怎么办 —— 未判定**。抓包里每条 cmd=2 都带 msgId
//    ⇒ 这一支无样本。本层的处置是「不 ack（不许编一个）且不计坏帧」。
// 3. **`c[…]` 在本次抓包里没出现过**（§二 那 133 帧是 `o`1 + `a[`85 + `[`46 + `""`1）。
//    形状按 Rust 的前缀 `c[` 认；本次那场是**客户端**主动发空串关的。
// 4. **事件消息（`ext.msgType` 2 入场 / 5 点赞 / 6 系统 / 7 礼物）的过滤不在本文件**：
//    Rust 的 `is_event_message` 在 MSync 那一层，本层的 `decodeMsync` 只回
//    `command` / `msgId` / `texts` ⇒ 过滤由 msync.ts 负责（本文件只把 texts 上抛）。
// 5. **口令抽取不在本文件**：那是 `liveKouling.ts`（全形态抽取器）与 `koulingPool.ts`
//    （池）的事 —— Rust 的 `live_ws.rs` 里那套 `is_kouling_head` 跨帧拼接 / `codes`
//    去重属于"口令"范畴，本层**不重复实现**（否则同一条链上会有两份判据）。
// 6. **`FrameKind` / `Outbound::Binary` 没搬**：调用方的 `ListenerActions` 只有三个字段
//    （见文件头）。归类只在本文件内部活着，用于坏帧计数。
// 7. **IO 一律不在本文件**：连、发、收、超时、重连、`ws_recv` 的 timeout 语义都在调用方；
//    本层不读时钟（`nowMs` 由调用方给，单测才能钉住时序）。
