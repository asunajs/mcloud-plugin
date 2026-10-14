// 直播弹幕链的 **MSync 报文层** —— 字节级测试。
//
// # 判据来源（照项目的四级口径排序）
//
// ```text
//   ① 抓包字面量   = mcloud-capture/har/live-room-raw-2026-09-23.json（记录 632，133 帧）
//   ② Rust 的字节级用例 = mcloud/crates/mcloud-upstream/src/live_msync/tests.rs
//   ③ 手算期望值   = 按抓包的文字小节（§3.1 / §3.2 / §4 / §五 / §5.5）自己拼字节
// ```
//
// 本文件里的实拍字节**只把同长度的敏感值换掉**（换值不换形，见 `sanitize-guide.md`）：
//
// ```text
//   手机号 15909397542 → 19900000000（都是 11 位）
//   手机号 19802021150 → 19900000001（都是 11 位）
//   cmliveAccount 的 32 位 hex → 32 个 '0'
//   发信人 clientResource 的毫秒 → 与 GUID 那个毫秒对齐（19 字符）
// ```
//
// ⚠ 替换**只落在 bytes 字段的内容上**（见 `scrubValues` 的说明）——varint 里的值一个都没动，
// 否则 `msgId` 会被悄悄改掉，而那种改动只有逐字节比才看得出来。
// 三处敏感值都在行尾注释里标了原值形态。
//
// # 为什么必须逐字节，而不是"解回来对不对"
//
// `pov` 少写 2 个字节、`deviceId` 多写 2 个字节、`timestamp` 用 8 字节毫秒而不是 4 字节秒
// —— **两边都解得开、字段也读得出**。所以下面每一处编码断言都落在**独立算出来**的判据上：
// 完整十六进制字面量、总长度、字段号与 wire type、某个字节的位置。
// 「encode 完再 decode 断言相等」在下面只当**补充**（标了「往返」），从不单独承担判据。
//
// 时间一律显式传 `nowMs`（本层不读时钟）⇒ 全部断言与机器时钟、时区无关。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CMD_ACK,
  CMD_DANMAKU,
  CMD_HEARTBEAT,
  CMD_PROVISION,
  LIVE_APP_KEY,
  LIVE_AUTH_PREFIX,
  LIVE_DEVICE_INFO_ASCII,
  LIVE_IDENTIFICATION_PREFIX,
  PROVISION_APP_SIGN,
  PROVISION_DEVICE_NAME,
  PROVISION_OS_TYPE_JS,
  PROVISION_VERSION,
  decodeMsync,
  encodeAck,
  encodeHeartbeat,
  encodeProvision,
  extractDanmakuTexts,
  isMsyncFrame,
} from '../src/mcloud/msync.ts';
import { fromHex, toHex, utf8 } from '../src/crypto/bytes.ts';

// ══════════════════════════════ 实拍字面量 ══════════════════════════════

/** 抓包记录 632 的第 3 帧（C→S，**126 B**，`command=1`）：心跳的原始字节。
 *
 *  ⚠ 这一帧**一个敏感值都没有**（deviceInfo 是应用级常量、identification 是每连接值、
 *  timestamp 是时刻）⇒ **原样照抄**，是下面 `encodeHeartbeat` 的逐字节判据。
 *  抓包 §5.1 把它逐字段列了出来（`40 01 / 58 00 / 6a 60 … / 72 04 … / 7a 10 …`）。 */
const CAPTURE_HEARTBEAT_126 =
  '400158006a603833303635323038346464613639623662393537653263336137' +
  '6264396231386462363539323265323930353162316233343263636631356265' +
  '6263306664626439633033343339626364386666663765613331363139323936' +
  '30363239663272046ab37cf77a10636d6f735f696d32a105dd9fd3d5c77a';

/** 抓包记录 632 的第 9 帧（S→C，**94 B**，`command=0`）：服务端对我们 ack 的**回执**。
 *
 *  抓包 §3.2 的形状：`{1:0 2:GUID 8:0 9:{1:{1:0} 2:<msgId> 3:<msgId>}}`。
 *  ⚠ 手机号已按同长度替换（`15909397542` → `19900000000`）。 */
const CAPTURE_ACK_RECEIPT_94 =
  '080012440a0b636d6f73236e67766c63731214636d6c6976655f635f31393930' +
  '303030303030301a0a636d6f73696d2e636f6d2213776562696d5f3137393031' +
  '343738333039383940004a120a02080010948890c0a40f18948890c0a40f';

/** 抓包记录 632 的第 43 帧（S→C，**622 B**，`command=2`）：带口令文本的那条弹幕。
 *
 *  抓包 §3.1 把它的完整字段树列了出来，文本在 `MSync.9.2.6.4.2`。
 *  ⚠ 手机号 ×2 与 cmliveAccount 已按同长度替换。 */
const CAPTURE_DANMAKU_622 =
  '080012440a0b636d6f73236e67766c63731214636d6c6976655f635f31393930' +
  '303030303030301a0a636d6f73696d2e636f6d2213776562696d5f3137393031' +
  '343738333039383940024aa1040a38121f323032363039323331343330333136' +
  '343930313138333030303030303030301a15636f6e666572656e63652e636d6f' +
  '73696d2e636f6d12e40308b9df839ebbd1ca9a1612440a0b636d6f73236e6776' +
  '6c63731214636d6c6976655f635f31393930303030303030311a0a636d6f7369' +
  '6d2e636f6d2213776562696d5f313739303134373833303938391a450a0b636d' +
  '6f73236e67766c6373121f323032363039323331343330333136343930313138' +
  '333030303030303030301a15636f6e666572656e63652e636d6f73696d2e636f' +
  '6d20c7eb81e98c34280132c102080312221214636d6c6976655f635f31393930' +
  '303030303030311a0a636d6f73696d2e636f6d1a2d121f323032363039323331' +
  '343330333136343930313138333030303030303030301a0a636d6f73696d2e63' +
  '6f6d222608001222e5b08fe7baa2e88ab1e58fa3e4bba4efbc9ae4b880e994ae' +
  '39e59bbee587bae59c882a0c0a06697346616e73100118012a0c0a066f726967' +
  '696e100218022a0d0a076d736754797065100218042a180a08757365724e616d' +
  '651007320ae794a8e688b7313135302a0e0a087573657254797065100218052a' +
  '130a0961766174617255726c100732046e756c6c2a120a037365781007320975' +
  '6e646566696e65642a0f0a09757365724c6576656c100218022a330a0d636d6c' +
  '6976654163636f756e7410073220303030303030303030303030303030303030' +
  '3030303030303030303030303030';

/** 抓包两条连接（632 / 1127）**逐字相同**的 96 字符 deviceInfo（§5.2）。
 *
 *  ⚠ 它是 **ASCII 文本**（96 字节），而 Rust 的 `LIVE_DEVICE_INFO_HEX` 走
 *  `hex::decode` ⇒ 48 字节二进制 —— 长度差一倍。本文件用它当判据，不引用实现里的常量。 */
const DEVICE_INFO_ASCII_96 =
  '830652084dda69b6b957e2c3a7bd9b18db65922e29051b1b342ccf15bebc0fdbd9c03439bcd8fff7ea316192960629f2';

/** 实拍那条 `identification` 的后 8 字节（§5.4：每连接重新起算、逐帧缓慢变化）。
 *
 *  ⚠ 前 8 字节是 `cmos_im2`、总长 **16** 字节。 */
const CAPTURE_IDENT_TAIL_HEX = 'a105dd9fd3d5c77a';

/** 抓包 `cmd=3` 那帧的时间（秒字段 = `6a b3 7c f7` = 1790147831）；identification 也取自它。 */
const CAPTURE_NOW_MS = 1790147831000;

/** 抓包 `cmd=3` 那帧的 GUID（68 B）：`cmos#ngvlcs` + `cmlive_c_<手机号>` + 域名 + `webim_<毫秒>`。
 *  ⚠ 手机号已同长度替换；毫秒取实拍值 `1790147830989`（resource 与它同值）。 */
const CAPTURE_GUID_HEX_SANITIZED =
  '0a0b636d6f73236e67766c63731214636d6c6976655f635f3139393030303030' +
  '3030301a0a636d6f73696d2e636f6d2213776562696d5f313739303134373833' +
  '30393839';

/** 抓包 `cmd=3` 的 **payload**（167 B，`Provision`）；token 已换成 98 个 `T`（同长度）。 */
const CAPTURE_PROVISION_PAYLOAD_HEX_SANITIZED =
  '0807120632332e302e322212636d6c6976655f636d6f735f6a735f73646b2800' +
  '30004a006205776562696d6a13776562696d5f31373930313437383330393839' +
  '7265247424545454545454545454545454545454545454545454545454545454' +
  '5454545454545454545454545454545454545454545454545454545454545454' +
  '5454545454545454545454545454545454545454545454545454545454545454' +
  '54545454545454';

/** 98 字符的假 token（实拍那个 JWT 是 98 字符 ⇒ 用它才能对上实拍的 auth 长度 101）。 */
const FAKE_TOKEN = 'T'.repeat(98);
/** 实拍 `cmd=3` 的毫秒（GUID.clientResource / resource 都是它）。 */
const PROVISION_NOW_MS = 1790147830989;

// ══════════════════════════════ 测试自己的 wire 工具 ══════════════════════════════
//
// **故意不复用被测模块的内部函数**：拿实现自己的扫描器去验证它的编码器，
// 只能证明"两边一致"，证明不了"字节对"。

interface Scanned {
  num: number;
  wire: number;
  /** wire 0 的值（bigint：19 位 msgId 用 number 会丢低位）。 */
  value: bigint | undefined;
  /** wire 2 的内容。 */
  bytes: Uint8Array | undefined;
}

/** 扫顶层字段（**独立实现**：与 msync.ts 无关，只按 proto3 的 wire 规则走）。 */
function scan(bytes: Uint8Array, pos = 0, end = bytes.length): Scanned[] {
  const out: Scanned[] = [];
  let i = pos;
  const varint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= end) throw new Error('varint 被截断');
      const b = bytes[i]!;
      i += 1;
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (i < end) {
    const key = varint();
    const num = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      out.push({ num, wire, value: varint(), bytes: undefined });
    } else if (wire === 2) {
      const size = Number(varint());
      out.push({ num, wire, value: undefined, bytes: bytes.subarray(i, i + size) });
      i += size;
    } else if (wire === 5) {
      out.push({ num, wire, value: undefined, bytes: undefined });
      i += 4;
    } else if (wire === 1) {
      out.push({ num, wire, value: undefined, bytes: undefined });
      i += 8;
    } else {
      throw new Error(`wire ${wire}`);
    }
  }
  return out;
}

/** 顶层字段号的列表（断言"写了哪几个字段"用）。 */
function fieldNums(bytes: Uint8Array): number[] {
  return scan(bytes).map((f) => f.num);
}

/** 取某个字段号的第一个 wire 2 字段。 */
function fieldBytes(bytes: Uint8Array, num: number): Uint8Array {
  const hit = scan(bytes).find((f) => f.num === num && f.wire === 2);
  assert.ok(hit?.bytes, `字段 ${num}（wire 2）必须存在`);
  return hit.bytes;
}

/** 取某个字段号的第一个 wire 0 字段。 */
function fieldVarint(bytes: Uint8Array, num: number): bigint {
  const hit = scan(bytes).find((f) => f.num === num && f.wire === 0);
  assert.ok(hit, `字段 ${num}（wire 0）必须存在`);
  return hit.value!;
}

/** 字段是否存在（"不写"的判据要能被断言）。 */
function hasField(bytes: Uint8Array, num: number, wire?: number): boolean {
  return scan(bytes).some((f) => f.num === num && (wire === undefined || f.wire === wire));
}

/** `command` 字段（8）。 */
function commandOf(bytes: Uint8Array): bigint {
  return fieldVarint(bytes, 8);
}

// 造报文用的小工具（**独立于 msync.ts**，形状照抓包 §3.1）。
//
// ⚠ 走 `bigint`：msgId 是 19 位十进制，用 `>>>`（32 位）或 `number` 的除法会把它截断
// —— 这一条本身就被下面那个 `1208222740` 教训过（`525194232852` 被 32 位截成它）。
function varintBytes(n: number | bigint): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v === 0n ? b : b | 0x80);
  } while (v !== 0n);
  return out;
}
function lenField(field: number, body: readonly number[] | Uint8Array): number[] {
  return [...varintBytes(field << 3 | 0x02), ...varintBytes(body.length), ...body];
}
function varField(field: number, value: number | bigint): number[] {
  return [...varintBytes(field << 3), ...varintBytes(value)];
}

/** 一条最小 `cmd=2`：`MSync.8=2` + `MSync.9.2.6.4.2 = text`（字段号照抓包 §3.1）。 */
function danmakuBytes(msgIdField: readonly number[], texts: readonly string[]): Uint8Array {
  const body = texts.flatMap((t) => lenField(4, lenField(2, utf8(t))));
  const message = [...msgIdField, ...lenField(6, body)];
  return new Uint8Array([...varField(8, 2), ...lenField(9, lenField(2, message))]);
}

/** 一条 `cmd=0`（服务端**回执**形状，照抓包 §3.2）：`MSync.8=0` + `MSync.9 = {2: id 3: id}`。
 *
 *  ⚠ 那两条是 **varint（wire 0）**，不是长度前缀 —— 抓包的实拍是真 varint
 *  （`10948890c0a40f` = 525194232852），抄成 wire 2 就变成另一条报文了。 */
function ackReceiptBytes(id: number): Uint8Array {
  return new Uint8Array([...varField(8, 0), ...lenField(9, [...varField(2, id), ...varField(3, id)])]);
}

// ══════════════════════════════ 一、实拍字面量自洽 ══════════════════════════════

test('实拍字面量的长度与字段集（先证字面量本身是那段字节）', () => {
  const hb = fromHex(CAPTURE_HEARTBEAT_126);
  const ack = fromHex(CAPTURE_ACK_RECEIPT_94);
  const danmaku = fromHex(CAPTURE_DANMAKU_622);

  assert.equal(hb.length, 126, '抓包 §5.1：`cmd=1` 是 126 B');
  assert.equal(ack.length, 94, '抓包 §3.2：服务端 ack 是 94 B');
  assert.equal(danmaku.length, 622, '抓包 §三：`command=2` 那条 622 B');

  // `cmd=1` 只有 5 个顶层字段，顺序升序（抓包 §5.1 的原始字节）。
  assert.deepEqual(fieldNums(hb), [8, 11, 13, 14, 15], '⚠ 心跳**不写** GUID/auth/userAgent/pov');
  assert.equal(commandOf(hb), BigInt(CMD_HEARTBEAT));
  // `cmd=2` 的顶层里有 GUID(2) / command(8) / payload(9)（服务端帧）
  assert.deepEqual(fieldNums(danmaku), [1, 2, 8, 9]);
  assert.equal(commandOf(danmaku), BigInt(CMD_DANMAKU));
  // ack 回执：`1:0 2:GUID 8:0 9:{…}`
  assert.deepEqual(fieldNums(ack), [1, 2, 8, 9]);
  assert.equal(commandOf(ack), BigInt(CMD_ACK));
});

test('deviceInfo(13) 是 **96 字节 ASCII**（不是 48 字节二进制）', () => {
  assert.equal(LIVE_DEVICE_INFO_ASCII.length, 96, '96 个 ASCII 字符');
  assert.match(LIVE_DEVICE_INFO_ASCII, /^[0-9a-f]{96}$/, '逐字是 hex 的文本形态');
  assert.equal(DEVICE_INFO_ASCII_96, LIVE_DEVICE_INFO_ASCII, '模块常量必须等于实拍值（§5.2）');

  const hb = fromHex(CAPTURE_HEARTBEAT_126);
  const d13 = fieldBytes(hb, 13);
  assert.equal(d13.length, 96, '抓包 `cmd=1` 的字段 13 是 96 B');
  assert.equal(toHex(d13), toHex(utf8(DEVICE_INFO_ASCII_96)), '⚠ 是 ASCII 文本的字节，不是 hex 解码后的 48 B');
  assert.notEqual(d13.length, 48, 'Rust 的 `hex::decode` 会给 48 B —— 长度差一倍');
});

// ══════════════════════════════ 二、encodeHeartbeat ══════════════════════════════

test('encodeHeartbeat 逐字节等于实拍那条 126 字节帧', () => {
  const got = encodeHeartbeat(CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  assert.equal(toHex(got), CAPTURE_HEARTBEAT_126, '整帧逐字节（含 96 B deviceInfo / 4 B 秒 / 16 B identification）');
  assert.equal(got.length, 126);
});

test('encodeHeartbeat 的字段集：8 / 11 / 13 / 14 / 15，**没有** 2 / 3 / 6 / 7 / 10', () => {
  const got = encodeHeartbeat(CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  assert.deepEqual(fieldNums(got), [8, 11, 13, 14, 15], '顺序也必须是升序（protobufjs 的实际形状）');
  for (const num of [1, 2, 3, 6, 7, 10]) {
    assert.equal(hasField(got, num), false, `⚠ 实拍的心跳**不写**字段 ${num}（Rust 每条都写 2/3/6/7）`);
  }
  // command=1 与 encryptType=0 都是"非默认值也要在那个位置"，但值 **0 的那条要写出来**。
  assert.equal(toHex(got.subarray(0, 4)), '40015800', '`40 01`（command=1）+ `58 00`（encryptType=0 也要写）');
  assert.equal(fieldVarint(got, 11), 0n, '`repeated` 的元素 0 必须写出去（proto3 的第 1 条例外）');
  assert.equal(scan(got).find((f) => f.num === 11)!.wire, 0, '⚠ 实拍是 **wire 0（非 packed）**，Rust 写 wire 2');
});

test('timestamp(14) 是 **4 字节大端「秒」**（不是 8 字节毫秒）', () => {
  const tail = fromHex(CAPTURE_IDENT_TAIL_HEX);
  const f14 = fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS, tail), 14);
  assert.equal(f14.length, 4, '4 字节');
  assert.equal(toHex(f14), '6ab37cf7', '抓包 §5.3 的原始字节；= 1790147831（该帧所在的那一秒）');
  // 同一个「秒」内的两个毫秒值 ⇒ 同样的字节（判据是秒，不是毫秒）。
  assert.equal(toHex(fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS + 999, tail), 14)), '6ab37cf7');
  // 跨一秒 ⇒ 末字节 +1（大端：高字节在前，值越大字符串序也越大）。
  assert.equal(toHex(fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS + 1000, tail), 14)), '6ab37cf8');
  assert.ok(
    toHex(fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS + 60000, tail), 14)) > '6ab37cf8',
    '大端：秒变大时 hex 字符串序也变大',
  );
});

test('identification(15) = ASCII `cmos_im2` + 8 字节；前缀与总长照实拍', () => {
  assert.equal(utf8(LIVE_IDENTIFICATION_PREFIX).length, 8, '前缀是 8 字节 ASCII');
  const f15 = fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX)), 15);
  assert.equal(f15.length, 16, '⚠ 实拍是 16 B；Rust 的 `cmos_im`+16B = 23 B');
  assert.equal(toHex(f15.subarray(0, 8)), toHex(utf8('cmos_im2')), '前缀逐字节（⚠ 有那个 `2`）');
  assert.equal(toHex(f15.subarray(8)), CAPTURE_IDENT_TAIL_HEX, '后 8 字节按注入值原样写');

  // 不注入时用 `nowMs` 的 64 位大端（确定性替代 —— 实拍那 8 字节的算式未判定）。
  const auto = fieldBytes(encodeHeartbeat(CAPTURE_NOW_MS), 15).subarray(8);
  assert.equal(auto.length, 8);
  assert.equal(toHex(auto), '000001a0cd2024d8', 'BE64(1790147831000)：确定性、可断言（⚠ 与实拍值不同）');
  assert.throws(
    () => encodeHeartbeat(CAPTURE_NOW_MS, fromHex('a105dd9f')),
    /8 字节/,
    '注入的 tail 必须是 8 字节（开发期错误 ⇒ 当场炸）',
  );
});

// ══════════════════════════════ 三、encodeProvision ══════════════════════════════

/** 实拍那一帧的入参（token 换成同长度的假值、deviceUuid 照实拍给空串）。 */
const PROVISION_INPUT = {
  accessToken: FAKE_TOKEN,
  resource: `webim_${PROVISION_NOW_MS}`,
  deviceUuid: '',
  phone: '19900000000',
};

test('encodeProvision 的字段集与总长（照实拍：2/3/8/9/10/11/13/14/15）', () => {
  const got = encodeProvision(PROVISION_INPUT, PROVISION_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  assert.deepEqual(fieldNums(got), [2, 3, 8, 9, 10, 11, 13, 14, 15], '升序，且**没有** 1(version) / 6(userAgent) / 7(pov)');
  assert.equal(got.length, 471, '抓包 §二：`cmd=3` 那帧是 471 B（98 字符 token / 13 字符 resource / 空 deviceUuid）');
  assert.equal(commandOf(got), BigInt(CMD_PROVISION));
  // ⚠ 字段 10 `deviceId`：实拍**写 0**（Rust 不写）。
  assert.equal(scan(got).find((f) => f.num === 10)!.wire, 0);
  assert.equal(fieldVarint(got, 10), 0n, '⚠ `50 00`：deviceId=0 也被写出去（protobufjs 的"字段在对象上"行为）');
  assert.equal(fieldVarint(got, 11), 0n, 'encryptType=0 也被写出去（wire 0）');
  // 长度判据：GUID 68 / auth 101 / deviceInfo 96（抓包 §五 那三栏）
  assert.equal(fieldBytes(got, 2).length, 68, 'GUID 68 B');
  assert.equal(fieldBytes(got, 3).length, 101, `auth = "$t$" + 98 = 101 B（抓包 §五 行 3）`);
  assert.equal(fieldBytes(got, 13).length, 96, 'deviceInfo 96 B');
  assert.equal(fieldBytes(got, 14).length, 4, 'timestamp 4 B');
  assert.equal(fieldBytes(got, 15).length, 16, 'identification 16 B');
});

test('encodeProvision 的前三段逐字节等于实拍（GUID / auth / payload 长度）', () => {
  const got = encodeProvision(PROVISION_INPUT, PROVISION_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  const head = toHex(got.subarray(0, 2 + 68 + 2 + 101));
  assert.equal(
    head,
    '1244' + CAPTURE_GUID_HEX_SANITIZED + '1a65' + toHex(utf8(`${LIVE_AUTH_PREFIX}${FAKE_TOKEN}`)),
    '⚠ GUID.4 是 `webim_<毫秒>`（实拍）；Rust 写 `js_<毫秒>` —— 大小写前缀那一处**按实拍改**',
  );
  // `40 03`（command=3）+ `4a a7 01`（payload 167 B，varint 长度是 3 字节：0xa7 0x01）
  assert.equal(toHex(got.subarray(2 + 68 + 2 + 101, 2 + 68 + 2 + 101 + 5)), '40034aa701');
  const payload = fieldBytes(got, 9);
  assert.equal(payload.length, 167, '抓包 §5.5 那一段是 167 B');
  assert.equal(toHex(payload), CAPTURE_PROVISION_PAYLOAD_HEX_SANITIZED, 'payload 逐字节（token 已同长度替换）');
});

test('encodeProvision 的 payload：**不写 networkType(3)**、deviceUuid 空串也写 `4a 00`', () => {
  const payload = fieldBytes(
    encodeProvision(PROVISION_INPUT, PROVISION_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX)),
    9,
  );
  assert.deepEqual(fieldNums(payload), [1, 2, 4, 5, 6, 9, 12, 13, 14], '⚠ 没有 3（networkType）也没有 15（provinceCode）');
  assert.equal(fieldVarint(payload, 1), BigInt(PROVISION_OS_TYPE_JS), 'osType = 7 (OS_JS)');
  assert.equal(toHex(fieldBytes(payload, 2)), toHex(utf8(PROVISION_VERSION)), 'version = "23.0.2"（不带 v）');
  assert.equal(toHex(fieldBytes(payload, 4)), toHex(utf8(PROVISION_APP_SIGN)));
  assert.equal(fieldVarint(payload, 5), 0n, 'compressType = 0（wire 0，实拍 `28 00`）');
  assert.equal(fieldVarint(payload, 6), 0n, 'encryptType = 0（wire 0，实拍 `30 00`）');
  assert.equal(fieldBytes(payload, 9).length, 0, '⚠ deviceUuid 是**空串**（抓包 §5.5 ⚠2）');
  assert.ok(toHex(payload).includes('4a00'), '⚠ 空串也要写出来（`4a 00` 两个字节），不能整条不写');
  assert.equal(toHex(fieldBytes(payload, 13)), toHex(utf8(`webim_${PROVISION_NOW_MS}`)), 'resource = webim_<毫秒>');
  assert.equal(toHex(fieldBytes(payload, 14)), toHex(utf8(`${LIVE_AUTH_PREFIX}${FAKE_TOKEN}`)), 'payload 的 auth 与 MSync 的 auth 同值');

  // 调用方给了一个非空 deviceUuid 时：字段 9 照写（长度跟着变，位置不变）。
  const withUuidPayload = fieldBytes(
    encodeProvision({ ...PROVISION_INPUT, deviceUuid: '1790147830989' }, PROVISION_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX)),
    9,
  );
  assert.deepEqual(fieldNums(withUuidPayload), [1, 2, 4, 5, 6, 9, 12, 13, 14]);
  assert.equal(toHex(fieldBytes(withUuidPayload, 9)), toHex(utf8('1790147830989')), '字段 9 就是调用方给的那个串');
  assert.ok(
    toHex(withUuidPayload).includes('4a0d' + toHex(utf8('1790147830989'))),
    '`4a 0d …`：长度 13 —— 同一个字段，只有长度跟着值走',
  );
});

test('encodeProvision 的尾段：deviceId / encryptType / deviceInfo / 秒 / identification', () => {
  const got = encodeProvision(PROVISION_INPUT, PROVISION_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  // 从 `50 00`（deviceId）起算：4 个字节的两条"零值也要写" + 96 + 4 + 16 的定长段。
  const tail = toHex(got.subarray(-(4 + 2 + 96 + 2 + 4 + 2 + 16)));
  assert.equal(
    tail,
    '5000' +
      '5800' +
      '6a60' +
      toHex(utf8(DEVICE_INFO_ASCII_96)) +
      '7204' +
      '6ab37cf6' +
      '7a10' +
      toHex(utf8('cmos_im2')) +
      CAPTURE_IDENT_TAIL_HEX,
    // ⚠ 实拍那一帧的秒是 `6ab37cf7`（1790147831），而它的 GUID.4 是 1790147830989 ——
    // 客户端的这两个值取自两个瞬间，我们只有一个 `nowMs` ⇒ 取整（1790147830）。
    '实拍尾部形状：deviceId=0 + encryptType=0 + 96 B deviceInfo + 4 B 秒 + 16 B identification',
  );
});

// ══════════════════════════════ 四、encodeAck ══════════════════════════════

test('encodeAck 逐字节等于手算期望（payload = {1:{1:msgId}}，19 位 id 走 BigInt）', () => {
  const msgId = '1600232022104666041'; // 实拍 conn 632 帧 [43] 的 msgId（> 2^53）
  const got = encodeAck(msgId, CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  // 期望值是手算的：`40 00` + `4a 0c` + payload(`0a 0a` + `08` + 9 字节 varint) + `58 00` + 13/14/15
  const expected =
    '4000' +
    '4a0c' +
    '0a0a08b9df839ebbd1ca9a16' +
    '5800' +
    '6a60' +
    toHex(utf8(DEVICE_INFO_ASCII_96)) +
    '72046ab37cf7' +
    '7a10' +
    toHex(utf8('cmos_im2')) +
    CAPTURE_IDENT_TAIL_HEX;
  assert.equal(toHex(got), expected, '整帧逐字节');
  assert.equal(got.length, 140);
});

test('encodeAck 的字段集：8 / 9 / 11 / 13 / 14 / 15，command=0 也要写出来', () => {
  const got = encodeAck('525194252007', CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  assert.deepEqual(fieldNums(got), [8, 9, 11, 13, 14, 15], '⚠ 不含 GUID(2) —— 理由见 msync.ts 文件头第三节');
  assert.equal(toHex(got.subarray(0, 2)), '4000', '⚠ `command=0` **写出来**了（proto3 的一般规则是不写）');
  assert.equal(commandOf(got), BigInt(CMD_ACK));
  assert.equal(fieldVarint(got, 11), 0n);
  // payload：抓包 §3.2 读法是 `9:{1:{1:<msgId>…}}`。
  // 这一条的值取自实拍 conn 632 帧 [44]（客户端 ack）的真实 id，varint 字节手算。
  assert.equal(toHex(fieldBytes(got, 9)), '0a0708e79d91c0a40f', 'payload = {1:{1: 525194252007}}');
  assert.equal(decodeMsync(got).msgId, '525194252007', '往返：解回来还是那个十进制串');
});

test('encodeAck 的入参是开发期契约：非十进制串当场炸', () => {
  assert.throws(() => encodeAck('', 0), /十进制串/);
  assert.throws(() => encodeAck('007', 0), /十进制串/, '前导零会让"写进去的 id"与"解出来的 id"不是同一个串');
  assert.throws(() => encodeAck('cmos#ngvlcs', 0), /十进制串/);
});

// ══════════════════════════════ 五、decodeMsync ══════════════════════════════

test('实拍 94 字节的 ack 回执：command=0、msgId 解得出、**没有文本**', () => {
  const got = decodeMsync(fromHex(CAPTURE_ACK_RECEIPT_94));
  assert.equal(got.command, CMD_ACK);
  assert.equal(got.msgId, '525194232852', '抓包 §3.2：`9:{1:{1:0} 2:<msgId> 3:<msgId>}` ⇒ 取字段 2');
  assert.deepEqual([...got.texts], [], '⚠ ack 帧**没有文本**（这正是"0 不是弹幕"的判据）');
  assert.equal(got.isMsync, true);
  assert.equal(isMsyncFrame(fromHex(CAPTURE_ACK_RECEIPT_94)), true);
});

test('实拍 622 字节的弹幕帧：command=2、文本走 9.2.6.4.2', () => {
  const got = decodeMsync(fromHex(CAPTURE_DANMAKU_622));
  assert.equal(got.command, CMD_DANMAKU);
  assert.deepEqual([...got.texts], ['小红花口令：一键9图出圈'], '抓包 §3.1 逐字节核过的那条路径');
  assert.deepEqual([...extractDanmakuTexts(fromHex(CAPTURE_DANMAKU_622))], [...got.texts], '同一个结果（同一个入口）');
  assert.equal(got.isMsync, true);
});

test('msgId 是 19 位十进制 ⇒ 必须用 BigInt（`Number` 会悄悄改值）', () => {
  const got = decodeMsync(fromHex(CAPTURE_DANMAKU_622));
  assert.equal(got.msgId, '1600232022104666041');
  assert.equal(Number('1600232022104666041'), 1600232022104666000, '⚠ 走 number 会丢低 7 位 —— 这就是不能用 number 的证据');
  assert.notEqual(String(Number('1600232022104666041')), '1600232022104666041');
  // 解出来的 msgId 能原样喂给 encodeAck（ack 要回的就是它）。
  const ackBytes = encodeAck(got.msgId!, CAPTURE_NOW_MS, fromHex(CAPTURE_IDENT_TAIL_HEX));
  assert.equal(decodeMsync(ackBytes).msgId, got.msgId, '往返：19 位 id 逐字符不变');
});

test('认不出的字段被跳过（proto3 前向兼容）', () => {
  // 实拍那帧里就有一堆我们不读的字段（`payload.2.3` / `.4` / `.5`、`MessageBody.5` 的 ext…），
  // 解码照样拿到文本 ⇒ 这本身就是"跳过"的证据（上面那条已经覆盖）。
  // 再补一条**没有实拍**的：未知的高编号字段 + packed（wire 2）的 encryptType(11)。
  const known = [...varField(8, 2), ...lenField(9, lenField(2, [...lenField(1, utf8('42')), ...lenField(6, lenField(4, lenField(2, utf8('口令是AAA'))))]))];
  const weird = new Uint8Array([
    ...varField(99, 7), // 未知字段（wire 0）
    ...lenField(100, utf8('whatever')), // 未知字段（wire 2）
    ...known,
    ...lenField(11, new Uint8Array([0x00])), // ⚠ packed(wire 2) 的 encryptType —— Rust/Go 那侧的形状
  ]);
  const got = decodeMsync(weird);
  assert.equal(got.command, CMD_DANMAKU);
  assert.deepEqual([...got.texts], ['口令是AAA']);
  assert.equal(got.msgId, '42');
  assert.equal(got.isMsync, true, '认不出的字段不该让整帧判成"这不是 MSync"');
  // wire 0 与 wire 2 两种 encryptType 都不影响诊断（本模块不读那个字段，只要求"别解坏"）。
  assert.equal(hasField(weird, 11, 2), true);
});

test('`payload.2` 是 repeated：文本落在**哪一条** meta 都要拿得到（Rust 只取第一条 ⇒ 会漏）', () => {
  const textMeta = (id: string, text: string): number[] => [
    ...lenField(1, utf8(id)),
    ...lenField(6, lenField(4, lenField(2, utf8(text)))),
  ];
  const emptyMeta = (id: string): number[] => [...lenField(1, utf8(id)), ...lenField(6, new Uint8Array(0))];

  // ① 文本在**后**一条 meta：实拍 conn 1127 的 [58]（2 条 meta，第 2 条带文本）
  //    与 [8]（3 条 meta，第 3 条带 `中国移动云盘`）。
  const later = new Uint8Array([
    ...varField(8, 2),
    ...lenField(9, [...lenField(2, emptyMeta('1')), ...lenField(2, textMeta('2', '送了1个鲜花'))]),
  ]);
  assert.deepEqual([...decodeMsync(later).texts], ['送了1个鲜花']);
  assert.equal(decodeMsync(later).msgId, '2', 'singular 语义：**最后一条** meta 覆盖前面（protobufjs 的实际行为）');

  // ② 文本在**前**一条 meta：实拍 conn 1127 的 [110]（文本在第 1 条，第 2 条没有）
  //    ⇒ 只取最后一条的实现会**漏掉**这条。
  const earlier = new Uint8Array([
    ...varField(8, 2),
    ...lenField(9, [...lenField(2, textMeta('7', '加入直播间')), ...lenField(2, emptyMeta('8'))]),
  ]);
  assert.deepEqual([...decodeMsync(earlier).texts], ['加入直播间'], '⚠ 只看第一条 / 只看最后一条都会漏掉实拍里的一类');
  assert.equal(decodeMsync(earlier).msgId, '8');

  // ③ 三条 meta、只有中间那条带文本（实拍 conn 1127 [8] 的形状：3 条里第 3 条带）。
  const middle = new Uint8Array([
    ...varField(8, 2),
    ...lenField(9, [
      ...lenField(2, emptyMeta('1')),
      ...lenField(2, textMeta('2', '中国移动云盘')),
      ...lenField(2, emptyMeta('3')),
    ]),
  ]);
  assert.deepEqual([...decodeMsync(middle).texts], ['中国移动云盘']);
});

test('一条报文里的多个 content 按 repeated 顺序；只有 type 没有 text 的片段不产出', () => {
  const withTwo = danmakuBytes([...lenField(1, utf8('9'))], ['小红花口令：', '一键9图出圈']);
  assert.deepEqual([...decodeMsync(withTwo).texts], ['小红花口令：', '一键9图出圈'], '顺序 = repeated 的顺序，**不拼接**（拼是调用方的事）');
  // `4:{1:0}`（只有类型）不是文本 —— 实拍 conn 632 [44] 的 MessageBody 里就有这个形状。
  const onlyType = new Uint8Array([
    ...varField(8, 2),
    ...lenField(9, lenField(2, [...lenField(1, utf8('1')), ...lenField(6, lenField(4, new Uint8Array([...varField(1, 0)])))])),
  ]);
  assert.deepEqual([...decodeMsync(onlyType).texts], [], '没有字段 2 的 content 不产出空串');
});

test('msgId 的两种编码都认：实拍是 varint，十进制串也认（同仓夹具的形状）', () => {
  const asVarint = danmakuBytes([...varField(1, 7)], ['x']);
  assert.equal(decodeMsync(asVarint).msgId, '7', '⚠ 实拍形状：varint(wire 0)');

  const asString = danmakuBytes([...lenField(1, utf8('1790147831719000001'))], ['x']);
  assert.equal(decodeMsync(asString).msgId, '1790147831719000001', '十进制串(wire 2)：19 位逐字符不变');

  // 字段 1 是**非数字串**时不当作 msgId（否则会把 JID 的 appKey 解成 id）。
  const notAnId = danmakuBytes([...lenField(1, utf8('cmos#ngvlcs'))], ['x']);
  assert.equal(decodeMsync(notAnId).msgId, undefined);
  assert.deepEqual([...decodeMsync(notAnId).texts], ['x'], '认不出 id 不影响文本');
});

test('`cmd=2` 但没有 payload / 没有 msgId ⇒ msgId 是 undefined（不是空串、不是 0）', () => {
  const bare = decodeMsync(new Uint8Array([...varField(8, 2)]));
  assert.equal(bare.command, CMD_DANMAKU);
  assert.equal(bare.msgId, undefined);
  assert.deepEqual([...bare.texts], []);
  assert.equal(bare.isMsync, true, '它是一条**读得懂的** MSync（只是缺字段）');

  const noId = decodeMsync(danmakuBytes([], ['文本在但没 id']));
  assert.equal(noId.msgId, undefined);
  assert.deepEqual([...noId.texts], ['文本在但没 id']);
});

test('解不开的报文**不抛**，并且能和"这不是 MSync"分开', () => {
  // Rust 的五个坏例（`malformed_payload_reports_an_error`）+ 空字节。
  const malformed = [
    [0x80], // 截断的 varint
    [0x00], // 字段号为 0
    [0x0a, 0x05, 0x01], // 声明长度超出实际字节
    [0x0b], // 未知 wire type（3 = group，proto3 已废弃）
    [0x0a, 0x80], // 长度前缀本身是截断的 varint
  ];
  for (const hex of malformed) {
    const bytes = new Uint8Array(hex);
    const got = decodeMsync(bytes);
    assert.equal(got.isMsync, false, `0x${toHex(bytes)} 不是一条 MSync`);
    assert.equal(got.command, 0, '默认值（不抛异常来当控制流）');
    assert.equal(got.msgId, undefined);
    assert.deepEqual([...got.texts], []);
    assert.equal(isMsyncFrame(bytes), false);
  }
  // 空字节：抓包里那条是 SockJS 的**关闭**帧（§二 末帧），不是 MSync。
  assert.equal(isMsyncFrame(new Uint8Array(0)), false);

  // 反面：**顶层**解不开才算"不是 MSync"；嵌套坏了仍然是 MSync（那一段读不出内容而已）。
  const brokenNested = new Uint8Array([...varField(8, 2), ...lenField(9, new Uint8Array([0x80]))]);
  const got = decodeMsync(brokenNested);
  assert.equal(got.isMsync, true, '顶层字段规规矩矩 ⇒ 它仍是一条 MSync');
  assert.deepEqual([...got.texts], [], '内层解不开 ⇒ 没有文本，但不抛');

  // 只有未知字段的一条合法报文：仍然是 MSync，只是什么都不认识。
  const unknownOnly = new Uint8Array([...varField(99, 1)]);
  assert.equal(decodeMsync(unknownOnly).isMsync, true);
  assert.equal(decodeMsync(unknownOnly).command, 0);
});

test('command 的命名按实拍：0=ack、2=弹幕（⚠ 与 Rust 的 CMD_SYNC/CMD_NOTICE 反着）', () => {
  assert.equal(CMD_ACK, 0);
  assert.equal(CMD_HEARTBEAT, 1);
  assert.equal(CMD_DANMAKU, 2);
  assert.equal(CMD_PROVISION, 3);
  // 编号本身是抓包事实（§三 那张表）：`0` 双向 ack / `1` 心跳 / `2` S→C 弹幕 / `3` PROVISION。
  assert.equal(decodeMsync(fromHex(CAPTURE_ACK_RECEIPT_94)).command, 0);
  assert.equal(decodeMsync(fromHex(CAPTURE_DANMAKU_622)).command, 2);
  assert.equal(decodeMsync(fromHex(CAPTURE_HEARTBEAT_126)).command, 1);
  assert.equal(LIVE_APP_KEY, 'cmos#ngvlcs');
  assert.equal(LIVE_AUTH_PREFIX, '$t$');
});

// ══════════════════════════════ 六、三条帧之间的互相印证 ══════════════════════════════

test('出站帧能被自己的解码器读回来（往返 —— 只作补充判据）', () => {
  const identTail = fromHex(CAPTURE_IDENT_TAIL_HEX);
  const hb = encodeHeartbeat(CAPTURE_NOW_MS, identTail);
  assert.equal(decodeMsync(hb).command, CMD_HEARTBEAT, '心跳：无文本、无 msgId');
  assert.deepEqual([...decodeMsync(hb).texts], []);
  assert.equal(decodeMsync(hb).msgId, undefined);

  const prov = encodeProvision(PROVISION_INPUT, PROVISION_NOW_MS, identTail);
  assert.equal(decodeMsync(prov).command, CMD_PROVISION, 'PROVISION 的 command=3（调用方拿它当入站的 cmd=3 夹具）');

  // decodeMsync 不读 `command=3` 的 GUID/auth/payload ⇒ 文本恒空（不会被误当弹幕）。
  assert.deepEqual([...decodeMsync(prov).texts], []);

  // 一条 `cmd=0` 的**服务端回执**（形状现造，照抓包 §3.2）⇒ command=0、msgId 取字段 2、无文本。
  const receipt = ackReceiptBytes(525194232852);
  const gotReceipt = decodeMsync(receipt);
  assert.equal(gotReceipt.command, CMD_ACK);
  assert.equal(gotReceipt.msgId, '525194232852', '与那 94 字节实拍帧同一条规则（字段 2）');
  assert.deepEqual([...gotReceipt.texts], []);

  // 「回显」形状里 `{1:{1:0}}` 的 0 是"没有 id"，**不是** msgId 0（免得把空回执报成 '0'）。
  const echoZero = new Uint8Array([...varField(8, 0), ...lenField(9, lenField(1, varField(1, 0)))]);
  assert.equal(decodeMsync(echoZero).msgId, undefined);
});
