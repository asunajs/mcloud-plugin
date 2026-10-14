// 直播弹幕链的 **SockJS 帧 + 状态机**（纯层）。
//
// 帧一律**逐字照抓包 §二 的形状**（`o` / `a["<b64>"]` / `c[…]` / `""`），入站的字节
// **现造**而不是硬编码一段来路不明的 base64 —— 因为「帧长什么样」这条判据是抓包 §3.1
// 的字段路径（`MSync.9.2.6.4.2`），硬编码会把它变成"某个我看不懂的串"。
//
// ⚠ 本文件是**唯一**需要 msync.ts 到位才能跑的地方：命令、构造与解码都走它的导出
// （`encodeProvision` / `encodeHeartbeat` / `encodeAck` / `decodeMsync`），
// 一处也没自己实现 protobuf。cmd=2（弹幕）**msync 没有对应的构造函数**
// ⇒ 这里按抓包 §3.1 的字段号手拼一条最小报文，并且**开工先自检**
// （`decodeMsync` 必须把它解成 command=2）—— 那一步红了说明两边对字段号的理解不一致，
// 是**该红**的（判据以抓包为准），不是"测试写得怪"。
//
// 时间一律显式给 `nowMs`（本层不读时钟）：所以下面所有时序断言都不依赖机器时钟与时区。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_CLOSE_FRAME,
  SOCKJS_CLOSE_PREFIX,
  SOCKJS_DATA_PREFIX,
  SOCKJS_HEARTBEAT,
  SOCKJS_OPEN,
  createListener,
  sockjsDataFrames,
  sockjsSendFrame,
} from '../src/mcloud/liveWs.ts';
import type { Listener, ListenerOptions } from '../src/mcloud/liveWs.ts';
import {
  CMD_ACK,
  CMD_DANMAKU,
  CMD_HEARTBEAT,
  CMD_PROVISION,
  decodeMsync,
  encodeAck,
  encodeHeartbeat,
  encodeProvision,
} from '../src/mcloud/msync.ts';
import { fromBase64, toBase64, utf8 } from '../src/crypto/bytes.ts';

// ══════════════════════════ 夹具与工具 ══════════════════════════

/** 首帧时刻（毫秒）—— 取抓包那一场附近的整数，纯粹为了读起来像真的。 */
const T0 = 1790147831000;

/** 抓包 §四：心跳间隔实测 14929 / 15128 / 14896 / 15022 ms ⇒ 默认 15000。 */
const HEARTBEAT_MS = 15000;

const OPTS: ListenerOptions = {
  accessToken: '$t$<JWT>',
  chatRoomId: '2026092314303164901183000000000',
  phone: '19900000000',
  deviceUuid: '', // 抓包 §5.5：实拍的 deviceUuid 是**空串**（字段在、长度为 0）
};

/** 造一个监听器（默认参数 —— 与调用方用的那套一样）。 */
function listener(extra: Partial<ListenerOptions> = {}): Listener {
  return createListener({ ...OPTS, ...extra });
}

// ── 最小的 proto3 写手（**只为造 cmd=2 的入站帧**，字段号照抓包 §3.1 逐条） ──

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    const b = v & 0x7f;
    v >>>= 7;
    out.push(v === 0 ? b : b | 0x80);
  } while (v !== 0);
  return out;
}

/** `field`（length-delimited，wire type 2）+ 长度 + 内容。 */
function lenField(field: number, body: readonly number[] | Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(body.length), ...body];
}

/** 一条 `command=2`（弹幕）的 MSync：
 *
 *  ```text
 *    MSync.8 = 2                                  （command）
 *    MSync.9 = Payload
 *        .2 = Message
 *            .1 = <msgId>                         （19 位十进制，抓包 §3.1）
 *            .6 = Content
 *                .4 = { 2: "<弹幕文本>" }         ⭐ 文本在这里
 *  ```
 *
 *  ⚠ 抓包 §3.1 里那个 `4:{1:0 2:"…"}` 的 `1:0` 是 **proto3 默认值** ⇒ wire 上不出现
 *  （Rust 的 `live_msync.rs` 文件头第 1 条讲的就是这条：默认值一律不写）。 */
function danmakuBytes(msgId: string, text: string): Uint8Array {
  const element = lenField(2, utf8(text));
  const content = lenField(4, element);
  const message = [...lenField(1, utf8(msgId)), ...lenField(6, content)];
  const payload = lenField(2, message);
  return new Uint8Array([...varint((8 << 3) | 0), 2, ...lenField(9, payload)]);
}

/** `a["<b64>", …]` —— 服务端推下来的数据帧（抓包 §二：`a[` 85/85 全是 S→C）。
 *
 *  ⚠ 那个 `[` 由 `JSON.stringify` 给，前缀只补一个 `a`（`SOCKJS_DATA_PREFIX` 是 `a[`，
 *  再补一次就变成 `a[["…"` ⇒ 整帧判坏帧 —— 第一版就是这么写错的，这里记一笔）。 */
function inbound(...msyncs: readonly Uint8Array[]): string {
  return `a${JSON.stringify(msyncs.map((m) => toBase64(m)))}`;
}

/** 把一条**发出去**的文本帧（`["<b64>"]`）解码回 MSync —— 断言"发了什么"就靠它。 */
function sentMsync(frame: string): ReturnType<typeof decodeMsync> {
  assert.match(frame, /^\["[A-Za-z0-9+/=]+"\]$/, 'SockJS 的发送形状必须是 ["<b64>"]（抓包 §二）');
  return decodeMsync(fromBase64(frame.slice(2, -2)));
}

/** 造一条服务端回下来的 `command=3`（PROVISION 的响应）。
 *
 *  msync 没有「服务端响应」的构造函数 ⇒ 用 `encodeProvision` 的字节（它的 command 就是 3）
 *  当入站夹具；自检在第一个用到它的用例里做。 */
function provisionAckBytes(): Uint8Array {
  return encodeProvision({ accessToken: OPTS.accessToken, resource: `webim_${T0}`, deviceUuid: '', phone: OPTS.phone }, T0 + 515);
}

/** 走完「`o` → PROVISION → 服务端回 cmd=3」三步，返回已进房间的监听器。 */
function enteredRoom(extra: Partial<ListenerOptions> = {}): Listener {
  const l = listener(extra);
  l.onFrame(SOCKJS_OPEN, T0);
  l.onFrame(inbound(provisionAckBytes()), T0 + 515);
  return l;
}

// ══════════════════════════ 一、`o` ⇒ PROVISION 只发一次 ══════════════════════════

test('`o` ⇒ 一条 PROVISION（`["…"]`、command=3）；重复 `o` **不重发**', () => {
  const l = listener();

  const first = l.onFrame(SOCKJS_OPEN, T0);
  assert.equal(first.outbound.length, 1, '`o` 必须换出一条 PROVISION');
  assert.deepEqual(first.texts, [], 'PROVISION 那一帧没有弹幕文本');
  assert.equal(first.closed, undefined);
  assert.equal(sentMsync(first.outbound[0]!).command, CMD_PROVISION);
  assert.equal(l.state().provisionSent, true);

  // 重复的 `o`：SockJS 重连时会再发一次，但 PROVISION 只能发一次 —— 重复发会让
  // 服务端把这条连接当成**新会话**（Rust 就有这条注释）。这里断言的是"真的一条都没有"。
  const again = l.onFrame(SOCKJS_OPEN, T0 + 10);
  assert.deepEqual(again.outbound, [], '重复 `o` 不许再发 PROVISION');
  assert.equal(again.closed, undefined);
  assert.equal(l.state().provisionSent, true);
});

// ══════════════════════════ 二、cmd=3 前后：enteredRoom 的判据 ══════════════════════════

test('PROVISION 响应之前/之后：`enteredRoom` = 收到过 `o` **且**收到过 cmd=3', () => {
  const l = listener();
  l.onFrame(SOCKJS_OPEN, T0);

  // 只发了 PROVISION、对面还没认：连上了 TCP 而已。
  let s = l.state();
  assert.deepEqual(
    [s.provisionSent, s.provisionAckSeen, s.enteredRoom],
    [true, false, false],
    'PROVISION 发出但没响应 ⇒ 还没进过房间',
  );

  const ackBytes = provisionAckBytes();
  assert.equal(decodeMsync(ackBytes).command, CMD_PROVISION, '自检：这一帧必须解成 cmd=3');

  const ack = l.onFrame(inbound(ackBytes), T0 + 515);
  assert.deepEqual(ack.texts, []);
  assert.equal(ack.closed, undefined);

  s = l.state();
  assert.deepEqual(
    [s.provisionAckSeen, s.enteredRoom],
    [true, true],
    'o + cmd=3 ⇒ 进过房间（它区分「被踢了」与「根本没被收下」）',
  );
});

test('没收到 `o`、只收到 cmd=3 ⇒ `enteredRoom` 仍是 false（判据是两个都要）', () => {
  const l = listener();
  l.onFrame(inbound(provisionAckBytes()), T0);
  const s = l.state();
  assert.deepEqual(
    [s.provisionSent, s.provisionAckSeen, s.enteredRoom],
    [false, true, false],
    'enteredRoom 不是"收到过 cmd=3"，而是"o **且** cmd=3"',
  );
});

// ══════════════════════════ 三、心跳（抓包 §四：约 15 秒一次） ══════════════════════════

test('心跳第一拍紧跟 PROVISION 的响应（抓包 §四：ack +515 ms、第一拍 +608 ms）', () => {
  const l = listener();
  l.onFrame(SOCKJS_OPEN, T0);

  const ack = l.onFrame(inbound(provisionAckBytes()), T0 + 515);
  assert.equal(ack.outbound.length, 1, 'ack 之后客户端就发了第一条 command=1');
  assert.equal(sentMsync(ack.outbound[0]!).command, CMD_HEARTBEAT, '第一拍是心跳，不是"补发"别的东西');
  const s = l.state();
  assert.deepEqual([s.heartbeatCount, s.lastHeartbeatAtMs], [1, T0 + 515]);
});

test('`dueHeartbeat`：进房间之前不发；到 15 秒才发；同一时刻不重复发', () => {
  const l = listener();
  // 还没收到任何帧：心跳一次都不该有（抓包里 ack 之前没有任何 command=1）。
  assert.deepEqual([...l.dueHeartbeat(T0)], [], '没进房间就不发心跳');

  l.onFrame(SOCKJS_OPEN, T0);
  assert.deepEqual([...l.dueHeartbeat(T0 + 14_999)], [], '只有 `o`、对面还没认 ⇒ 不发');

  l.onFrame(inbound(provisionAckBytes()), T0 + 515); // 这一帧已带出第一拍

  assert.deepEqual([...l.dueHeartbeat(T0 + 515 + HEARTBEAT_MS - 1)], [], '差 1 ms 也不发');
  const due = l.dueHeartbeat(T0 + 515 + HEARTBEAT_MS);
  assert.equal(due.length, 1, '到了 15 秒就发一条');
  assert.equal(sentMsync(due[0]!).command, CMD_HEARTBEAT);
  assert.deepEqual([...l.dueHeartbeat(T0 + 515 + HEARTBEAT_MS)], [], '同一时刻重复调用不重复发');

  // 15.1 秒的间隔（抓包实测就是 14.9–15.1 这种抖动）⇒ 下一拍照常发。
  const next = l.dueHeartbeat(T0 + 515 + HEARTBEAT_MS + 15_132);
  assert.equal(next.length, 1);
  const s = l.state();
  assert.deepEqual([s.heartbeatCount, s.lastHeartbeatAtMs], [3, T0 + 515 + HEARTBEAT_MS + 15_132]);
});

test('`heartbeatMs` 可改（抓包那 5 拍的间隔是**实测**值，不是协议常量）', () => {
  const l = enteredRoom({ heartbeatMs: 1000 });
  assert.deepEqual([...l.dueHeartbeat(T0 + 515 + 999)], []);
  assert.equal(l.dueHeartbeat(T0 + 515 + 1000).length, 1);
});

// ══════════════════════════ 四、服务端的 ack 回执与心跳回应：不回 ══════════════════════════

test('服务端回下来的 cmd=1（心跳回应）与 cmd=0（ack 回执）⇒ 我们**不回**任何东西', () => {
  const l = enteredRoom();

  const srvHeartbeat = l.onFrame(inbound(encodeHeartbeat(T0 + 600)), T0 + 600);
  assert.deepEqual(srvHeartbeat.outbound, [], '服务端的心跳回应（抓包 §四 那 87 B）不该换来一条回帧');

  const srvAck = l.onFrame(inbound(encodeAck('1790147831000000001', T0 + 620)), T0 + 620);
  assert.deepEqual(srvAck.outbound, [], '服务端对 ack 的回执（抓包 §3.2 那 94 B）也不回');
  assert.deepEqual([...srvAck.texts], []);
  assert.equal(srvAck.closed, undefined);
});

// ══════════════════════════ 五、弹幕 ⇒ 文本上抛 + ack ══════════════════════════

test('收到 cmd=2 弹幕 ⇒ 文本上抛，并回一条 cmd=0 ack（**带被确认的 msgId**）', () => {
  const l = enteredRoom();
  assert.equal(decodeMsync(danmakuBytes('1', 'x')).command, CMD_DANMAKU, '自检：手拼的字节要解成 cmd=2');

  const msgId = '1790147831719000001';
  const act = l.onFrame(inbound(danmakuBytes(msgId, '小红花口令：一键9图出圈')), T0 + 700);

  assert.deepEqual([...act.texts], ['小红花口令：一键9图出圈'], '文本要原样上抛（口令抽取是另一层的事）');
  assert.equal(act.outbound.length, 1, '每收到一条 cmd=2 就回一条 cmd=0（抓包 §3.2）');
  const reply = sentMsync(act.outbound[0]!);
  assert.equal(reply.command, CMD_ACK);
  assert.equal(reply.msgId, msgId, 'ack 里带的必须是**这一条**弹幕的 msgId');
  assert.equal(act.closed, undefined);
});

test('一条 `a[...]` 里两条消息（SockJS 会缓冲）⇒ 两条文本、两条 ack，顺序不乱', () => {
  const l = enteredRoom();
  const act = l.onFrame(
    inbound(danmakuBytes('1790147831719000001', '小红花口令：一键9图出圈'), danmakuBytes('1790147831719000002', '小红花口令：中秋美好存云盘')),
    T0 + 800,
  );

  assert.deepEqual([...act.texts], ['小红花口令：一键9图出圈', '小红花口令：中秋美好存云盘']);
  assert.equal(act.outbound.length, 2);
  assert.deepEqual(
    act.outbound.map((f) => sentMsync(f).msgId),
    ['1790147831719000001', '1790147831719000002'],
  );
});

test('cmd=2 但**没有 msgId** ⇒ 不 ack（不许编一个），也不因此判坏帧', () => {
  const l = enteredRoom();
  // 手拼一条只有 command=2、没有 payload 的报文（抓包没有这种样本 ⇒ 未判定那一支）。
  const noMsgId = new Uint8Array([...varint((8 << 3) | 0), 2]);
  assert.equal(decodeMsync(noMsgId).command, CMD_DANMAKU, '自检：它确实是 cmd=2');

  const act = l.onFrame(inbound(noMsgId), T0 + 900);
  assert.deepEqual(act.outbound, [], '没有 msgId 就没有可确认的对象');
  assert.equal(act.closed, undefined, '这一帧读得懂，不该被当成"对面不是我们的端点"');
});

// ══════════════════════════ 六、关闭 ══════════════════════════

test('服务端 `c[…]` ⇒ 报关闭（人话），并且之后再收到什么都没反应', () => {
  const l = enteredRoom();

  const act = l.onFrame(`${SOCKJS_CLOSE_PREFIX}3000,"Go away!"]`, T0 + 1000);
  assert.equal(typeof act.closed, 'string');
  assert.ok(act.closed!.startsWith('服务端关闭帧 c['), `关闭原因的文案是契约（调用方按前缀分档）：${act.closed}`);
  assert.deepEqual(act.outbound, []);
  assert.equal(l.state().closed, true);

  const after = l.onFrame(SOCKJS_OPEN, T0 + 1001);
  assert.deepEqual(after.outbound, [], '往一条已关的连接写只会得到错误 ⇒ 一条都不发');
  assert.equal(typeof after.closed, 'string', '关闭原因重复报出去（幂等），调用方不会因为丢了一次消息就不知道');
});

test('空串帧：不算坏帧、不关闭，机器照常能用（抓包 §二 末帧 = 客户端关闭那一帧）', () => {
  const l = enteredRoom();
  const blank = l.onFrame(CLIENT_CLOSE_FRAME, T0 + 1100);
  assert.deepEqual(blank.outbound, []);
  assert.equal(blank.closed, undefined);
  assert.equal(l.state().closed, false, '空串是**客户端**关连接用的帧，不是"服务端把我们关了"');

  // 「照常能用」要**看得见**：后面那条弹幕照样拿到文本、照样 ack 出去。
  const act = l.onFrame(inbound(danmakuBytes('1790147831719000003', '口令1:MClaw全能小助手')), T0 + 1200);
  assert.deepEqual([...act.texts], ['口令1:MClaw全能小助手']);
  assert.equal(act.outbound.length, 1);
});

// ══════════════════════════ 七、连续坏帧 ══════════════════════════

test('连续解不开的帧到上限 ⇒ 要求收工（原因里有"解不开"与上限）', () => {
  const l = enteredRoom({ malformedLimit: 3 });

  assert.equal(l.onFrame('a[{}]', T0 + 2000).closed, undefined, '第 1 个坏帧还不该收工');
  assert.equal(l.onFrame('a[123]', T0 + 2001).closed, undefined, '第 2 个同理');
  const third = l.onFrame('a[', T0 + 2002);
  assert.equal(typeof third.closed, 'string');
  assert.ok(third.closed!.startsWith('连续 3 帧解不开'), `第 3 个到上限 ⇒ 收工：${third.closed}`);
  assert.equal(l.state().closed, true);

  const after = l.onFrame(inbound(danmakuBytes('1', '小红花口令：x')), T0 + 2003);
  assert.deepEqual(after.outbound, [], '收工之后不再往这条连接写');
});

test('能被归类的帧会**清零**连续坏帧（Rust 那个 early-return bug 的回归）', () => {
  // 坏 → 坏 →（可归类的一帧）→ 坏 → 坏：不算到上限；再来一个坏帧才收工。
  // ⚠ 少了清零就会在第 5 帧（坏 #3）收工 —— 那正是 Rust 修过的那个 bug：
  // 心跳 / `o` / `c[...]` 那些 early return 绕过了清零，一条正常帧流也会被攒满坏帧判死。
  const viaOpen = enteredRoom({ malformedLimit: 3 });
  viaOpen.onFrame('a[{}]', T0);
  viaOpen.onFrame('a[{}]', T0 + 1);
  assert.equal(viaOpen.onFrame(SOCKJS_OPEN, T0 + 2).closed, undefined, '重复的 `o` 也是可归类的帧');
  viaOpen.onFrame('a[{}]', T0 + 3);
  assert.equal(viaOpen.onFrame('a[', T0 + 4).closed, undefined, '清零过 ⇒ 这里是坏 #2，不该收工');
  assert.equal(typeof viaOpen.onFrame('a[{}]', T0 + 5).closed, 'string', '坏 #3 才收工');

  // 空串（ignored）同样清零。
  const viaBlank = enteredRoom({ malformedLimit: 3 });
  viaBlank.onFrame('a[{}]', T0);
  viaBlank.onFrame('a[{}]', T0 + 1);
  assert.equal(viaBlank.onFrame(CLIENT_CLOSE_FRAME, T0 + 2).closed, undefined);
  viaBlank.onFrame('a[{}]', T0 + 3);
  assert.equal(viaBlank.onFrame('a[', T0 + 4).closed, undefined);
  assert.equal(typeof viaBlank.onFrame('a[{}]', T0 + 5).closed, 'string');
});

test('`malformedLimit = 0` ⇒ 不因为坏帧收工（Rust 的 0 = 一直挂着）', () => {
  const l = enteredRoom({ malformedLimit: 0 });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(l.onFrame('a[{}]', T0 + 3000 + i).closed, undefined);
  }
  assert.equal(l.state().closed, false);
});

// ══════════════════════════ 八、`h`：未判定项 ══════════════════════════

test('`h`（SockJS 心跳）⇒ 抓包零样本，判为**未判定**：不回帧、上报给调用方', () => {
  const l = enteredRoom();

  const act = l.onFrame(SOCKJS_HEARTBEAT, T0 + 4000);
  assert.deepEqual(act.outbound, [], '不许猜 —— 所以既不回 "h" 也不回 [""]');
  assert.equal(typeof act.closed, 'string', '明确的失败/上报：把这件事报出去让调用方决定');
  assert.ok(act.closed!.startsWith('收到 SockJS 心跳帧 h'));
  assert.ok(act.closed!.includes('未判定'), `文案里要写明这是未判定：${act.closed}`);
  assert.equal(l.state().closed, false, '状态机没被 `h` 关掉（"要不要断"是调用方的决定）');

  // 调用方若选择继续，后续帧照常工作 —— 用一条弹幕证明。
  const after = l.onFrame(inbound(danmakuBytes('1790147831719000004', '小红花口令：中秋美好存云盘')), T0 + 4100);
  assert.deepEqual([...after.texts], ['小红花口令：中秋美好存云盘']);
  assert.equal(after.outbound.length, 1, 'ack 照发');
});

// ══════════════════════════ 九、SockJS 包/拆 ══════════════════════════

test('`sockjsSendFrame` 是 `["<b64>"]`；`sockjsDataFrames` 能把它原样拆回来', () => {
  const bytes = danmakuBytes('1790147831719000005', '小红花口令：一键9图出圈');
  const frame = sockjsSendFrame(bytes);
  assert.equal(frame, `["${toBase64(bytes)}"]`, 'C→S 的发送形状（抓包 §二：`[` 46/46 全是 C→S）');
  assert.equal(frame.startsWith('a['), false, '别把发送形状与入站形状混起来（前缀写错的表现是"收不到弹幕"）');

  const back = sockjsDataFrames(`a${frame}`);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], bytes, '包一层 `a` 之后要能逐字节拆回来');
  assert.equal(`a${frame}`.startsWith(SOCKJS_DATA_PREFIX), true, '入站形状带 `a[` 前缀（方向×前缀是满的）');
});

test('`sockjsDataFrames`：多条保序；不是 JSON 数组就抛（调用方据此记坏帧）', () => {
  const a = danmakuBytes('1', '甲');
  const b = danmakuBytes('2', '乙');
  const many = sockjsDataFrames(inbound(a, b));
  assert.equal(many.length, 2);
  assert.deepEqual(many[0], a);
  assert.deepEqual(many[1], b);

  // 三档读不懂（⚠ `'a[{}]'` 切掉前缀那个 `a` 之后是 `[{}]` —— **是**合法 JSON 数组，
  // 只是元素不是字符串 ⇒ 那句报错说的是"元素"，不是"不是数组"）。
  assert.throws(() => sockjsDataFrames(SOCKJS_OPEN), /JSON/); // `o` 切掉 `o` 剩空串 ⇒ 语法错
  assert.throws(() => sockjsDataFrames('a"x"'), /不是 JSON 数组/);
  assert.throws(() => sockjsDataFrames('a[{}]'), /base64 字符串/);
  assert.throws(() => sockjsDataFrames('a[["x"]]'), /base64 字符串/);
});

test('坏 base64 ⇒ 计成坏帧（判据是 `isMsync`，不是异常 —— 这条守的是"注释写的行为真的成立"）', () => {
  // ⚠ 背景：`decodeMsync` 有意**不抛**（解不开就返回 `isMsync:false`），
  //   而 `fromBase64` 是宽容解码器 ⇒ 早先那版用 `try/catch` 判坏帧，
  //   结果是**那一支永远不触发**：`a["!!!!"]` 会被静默当成"解开了、只是没文本"。
  const l = createListener({
    accessToken: 'JWT',
    chatRoomId: '123',
    phone: '19142492716',
    deviceUuid: '',
    malformedLimit: 3,
  });
  const opened = l.onFrame(SOCKJS_OPEN, 1_750_000_000_000);
  assert.ok(opened.outbound.length > 0, '先要有 `o` 那一拍');
  l.onFrame(inbound(provisionAckBytes()), 1_750_000_000_100);
  assert.equal(l.state().enteredRoom, true);

  // 垃圾 base64：既不是 MSync，也不该被当成"空弹幕"
  const bad = l.onFrame('a["!!!!not-base64!!!!"]', 1_750_000_000_200);
  assert.equal(bad.texts.length, 0);
  assert.equal(bad.outbound.length, 0, '坏帧不该引出任何要发的东西');
  // 攒够上限（3）就该要求收工 —— 走的是**坏帧判据**那条路，不是异常那条。
  // ⚠ 上面那条 `bad` 已经是**第 1 帧**坏帧，所以这里再发 2 帧就到上限。
  l.onFrame('a["!!!!not-base64!!!!"]', 1_750_000_000_300);
  const third = l.onFrame('a["!!!!not-base64!!!!"]', 1_750_000_000_400);
  assert.ok(
    third.closed !== undefined && third.closed.includes('解不开'),
    `连续坏帧到上限该要求收工；closed=${String(third.closed)}`,
  );
});
