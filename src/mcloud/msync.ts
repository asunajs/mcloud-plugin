// 直播弹幕那条链的 **MSync 报文层**（手写 proto3 编解码，**纯层**：零 IO、零网络、零时钟）。
//
// 从 mcloud 的 Rust 版移植：`crates/mcloud-upstream/src/live_msync.rs`（约 1100 行）。
// 但**判据不只来自它** —— 本文件按项目的四级口径落地：
//
// ```text
//   ① 业务/协议逻辑  → 照 mcloud（Rust）      ② 内容与判据 → 抓包（**冲突时以抓包为准**）
//   ③ ts 写法        → 照本仓既有模块（bytes.ts / h5.ts 那一套，QuickJS 里没有 Buffer/TextEncoder）
//   ④ 效果           → 实测确认（本模块做不到，见文件尾「未判定」）
// ```
//
// 抓包源：`mcloud-capture/docs/capture/app-live-ws-samples.txt`（2026-09-23，133 帧 / 73.6 s，
// 记录 id 632；另一条连接 id 1127）。凡本文件与 Rust 不同的地方，都标了 **⚠** 并写明
// 依据的抓包小节（§三 / §3.1 / §3.2 / §四 / §五 / §5.1–5.5）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 一、`command` 的命名：**照实拍**（Rust/Go 那边是反的）
// ─────────────────────────────────────────────────────────────────────────────
//
// | 值 | 方向 | 实拍含义 | 抓包 |
// |---|---|---|---|
// | `0` | 双向 | **ack / 回执**（带被确认的 msgId，无文本） | §三 / §3.2 |
// | `1` | C→S 发起，S 回 | **应用层心跳**（约 15 s 一拍） | §四 |
// | `2` | S→C | **弹幕推送** ⭐ 口令在这一类里 | §三 / §3.1 |
// | `3` | C→S，S 回 | **PROVISION 握手**（唯一带 GUID + auth + payload 的帧） | §三 / §5.5 |
//
// ⚠ Rust 的 `CMD_SYNC = 0` / `CMD_NOTICE = 2` **注释与命名是反的**（那边写着
// 「0 是服务端推弹幕」「2 是另一条推送路径」）。实拍里 0 是回执、2 才是弹幕。
// Rust 的功能靠"对 0 与 2 都试一遍"歪打正着（抓包 §三 那段专门解释了这件事）。
// 本文件导出的是**按实拍命名**的四个常量（`CMD_ACK` / `CMD_HEARTBEAT` /
// `CMD_DANMAKU` / `CMD_PROVISION`），名字与调用方（`liveWs.ts`）约定一致。
//
// ─────────────────────────────────────────────────────────────────────────────
// 二、⚠⚠ 与 mcloud 的 Rust **逐条差异**（全部以抓包为准）
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. **字段集按 command 分**（抓包 §五 + §5.1 的原始字节）：
//
//    ```text
//    cmd=3  2 GUID(68B) 3 auth(101B) 8=3 9 payload 10=0 11=0 13 14 15
//    cmd=1  8=1 11=0 13 14 15                      ← 只有 5 个顶层字段（126 B）
//    cmd=0  2 GUID 8=0 9 payload 11=0 13 14 15
//    ```
//
//    Rust 的 `live_msync_frame()` **每一条**都写 `GUID` + `auth` + `userAgent` +
//    `pov=Some(0)`（`live_msync.rs` 的第 4 条差异）—— 实拍只在 `cmd=3` 带
//    GUID/auth，`userAgent`(6) 与 `pov`(7) **三条帧里一条都没有**。
//    ⇒ 本模块**不写** `userAgent` / `pov`（连常量都不导出：留一个没人用的常量
//    只会让人以为它参与协议），也不给 cmd=1/cmd=0 写 GUID/auth。
//    ⚠ 唯一一处本模块**比实拍少写**的是 `cmd=0` 的 GUID，理由见第三节的那条。
//
// 2. **`deviceInfo`(13) = 96 字节 ASCII**（抓包 §5.2），Rust 是
//    `hex::decode(LIVE_DEVICE_INFO_HEX)` = **48 字节二进制** —— **长度差一倍**。
//    实拍那两条连接的值逐字相同 ⇒ 至少同机固定（每设备一个，不是每连接生成）。
//
// 3. **`timestamp`(14) = 4 字节大端「秒」**（抓包 §5.3：`6a b3 7c f7` = 1790147831，
//    与首帧时刻吻合、逐帧递增）。Rust 是 **8 字节大端「毫秒」**。
//    ⚠ 反方向（服务端回的 `payload.3`）**是毫秒** —— 两个方向单位不同，别互搬。
//
// 4. **`identification`(15) = 16 字节**：ASCII `cmos_im2`(8B) + 8 字节变化值（抓包 §5.4）。
//    Rust 是 `cmos_im`(7B) + 16 随机字节 = **23 字节** —— 前缀与长度都不对。
//
// 5. **`encryptType`(11) 实拍是 wire 0（非 packed）且值 0 也写**（抓包 §五 行 11、
//    §七 差异 9）。Rust 写 **packed(wire 2)**。⇒ 本模块编码**按实拍写 wire 0**
//    （`58 00`）；解码侧对 **wire 0 与 wire 2 都容忍**（packed 是 Rust/Go 那侧的
//    形状，服务端没实拍 ⇒ 两种都认比只认一种稳，Rust 的 `decode_msync` 也是这个口径）。
//    ⚠ 「repeated 的元素为 0 也要写」这条**两边一致**，照办（见第四节）。
//    同一件事在 PROVISION 的 `compressType`(5) / `encryptType`(6) 上同样成立：实拍 `28 00` / `30 00`。
//
// 6. **`cmd=3` 写 `deviceId`(10) = 0**（抓包 §五 行 10：「**写 0**」；原始字节里是 `50 00`），
//    Rust 恒 0 且不写。⇒ proto3 的"零值不写"在这里**不适用**：客户端是 protobufjs，
//    字段在对象上出现过就写出去。
//
// 7. **PROVISION 的 payload**（抓包 §5.5 + 实拍字节 `[1]`）：
//    · **不写 `networkType`(3)** —— Rust 写 `1`（`PROVISION_NETWORK_WIFI`）。
//      ⇒ 本模块连那个常量都不导出（实拍未设置 ⇒ proto3 默认 0 ⇒ 不写）。
//    · **`deviceUuid`(9) 实拍是空串但字段在**（`4a 00`：长度 0 的 bytes 也占 2 字节）。
//      Rust 写毫秒串（13 字符），而且它的 `append_string` 遇空串会**整条不写** ——
//      两个方向都不对。本模块**永远写**字段 9（调用方传空串时就得到实拍的 `4a 00`；
//      `liveWs.ts` 正是传空串）。
//    · `provinceCode`(15) 实拍也没有 ⇒ 与 Rust 一致（不写）。
//
// 8. **弹幕文本路径（逐字节核过）：`MSync.9 → .2 → .6 → .4（repeated）→ .2`**（§3.1）。
//    ⚠ 但 `.2`（`Message`）**是 repeated** —— 实拍里一条报文可以带**多条** meta
//    （conn 1127 的 `[8]` 有 3 条，`[49]` / `[58]` / `[87]` / `[107]` / `[110]` 各 2 条）。
//    Rust 的 `decode_notice_meta_payload` 只取**第一个** `.2`（那条已知缺口写在
//    `live_msync.rs:977-984`），而实拍里文本**可能落在靠后的 meta**：
//    `[8]` 文本在第 **3** 条、`[58]` 在第 **2** 条、`[110]` 却在第 **1** 条
//    ⇒ 只取第一条与只取最后一条**都会漏**。本模块遍历**所有** `.2`
//    （实拍里从未出现"两个 meta 同时带文本"，所以不会把两条弹幕拼成一条）。
//
// 9. **msgId 是 19 位十进制，必须用 `BigInt` 解**（抓包 §3.1 标注 `<19 位 msgId>`）。
//    实拍 conn 632 `[43]` 的 msgId = `1600232022104666041`，而
//    `Number('1600232022104666041')` = `1600232022104666000` —— **低 7 位被四舍五入掉**。
//    本模块内部一律 `bigint`，对外给十进制串。（`525194232852` 那种小值是巧合，别据此放松。）
//
// 10. **不移植 Rust 的"三级兜底"**（`extract_danmaku_frame`：解不开就退一级）。
//     那一级的存在本身就是"猜错过一次"的证据，而抓包已经把 `cmd=2` 的路径钉死了
//     （两条连接、每一条带文本的帧都走 `9.2.6.4.2`）。没有样本支持的兜底会增加
//     "把一段不是弹幕的字节解成文本"的面积，故**不做** —— 见文件尾「未做」。
//
// ─────────────────────────────────────────────────────────────────────────────
// 三、⚠ 本模块**故意比实拍少写**的两处（都记在这里，别当成 bug）
// ─────────────────────────────────────────────────────────────────────────────
//
// · **`cmd=0` 不写 GUID**。实拍客户端 ack（记录 632 的 `[6]` 417 B / `[8]` `[44]` 464 B）
//   顶层是 `2 GUID + 8=0 + 9 payload + 11=0 + 13 + 14 + 15`。而本模块的 `encodeAck()`
//   只有 `msgId` 一个入参（调用方约束）—— **拼不出 GUID**（它要 `guid.appKey` 与
//   `cmlive_c_<手机号>`）。抓包 §5.1 的判据支持"不写也无妨"：身份靠连接本身认，
//   `cmd=1` 心跳就一条都不带。⚠ 这一条**未判定**：服务端是否接受一条不带 GUID 的 ack。
// · **`cmd=0` 的 payload 只回显 msgId 那一层**。实拍客户端把**整条收到的消息**
//   回显进 `payload.1`（`{1:<id> 2:JID 3:JID 5:1 6:MessageBody{…}}`），我们手上只有
//   `msgId` ⇒ 只写 `payload = {1: {1: msgId}}`（抓包 §3.2 对这条帧的读法就是
//   "`9:{1:{1:<msgId>…}}`"）。⚠ 服务端是否接受这个更短的 payload **未判定**。
//
// ─────────────────────────────────────────────────────────────────────────────
// 四、proto3 那四条"写错也不报错"的规则（沿用 Rust 文件头的口径）
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. **singular 取默认值时不写**：`version=0` / `command=0` / 空串 / 空 bytes 一律不出现。
//    ⚠ 但实拍里的客户端是 protobufjs：**"字段在对象上出现过"就写**（`deviceId=0`
//    写出了 `50 00`、`command=0` 写出了 `40 00`、`deviceUuid=''` 写出了 `4a 00`）。
//    本模块按**实拍**逐条决定写不写（见上），不照搬"零值不写"这条一般规则。
// 2. **`repeated` 里的 0 要写**（它不适用第 1 条）。
// 3. **字段按编号升序出现**（protobufjs 的实际输出形状，抓包逐帧一致）。
// 4. **嵌套消息空也写**（`tag + 长度 0`），它是"字段被设置了"的表达。
//
// ─────────────────────────────────────────────────────────────────────────────
// 五、只做字节层
// ─────────────────────────────────────────────────────────────────────────────
//
// 本模块**不**做：帧的 SockJS 包装（在 `liveWs.ts`）、口令抽取（在 `liveKouling.ts`）、
// 事件消息过滤（Rust 的 `ext.msgType`，**没有移植** —— 见文件尾「未做」）。
// 依赖只有本仓的 `crypto/bytes.ts`：QuickJS 沙箱里**没有** `Buffer` / `TextEncoder` /
// `TextDecoder` / `crypto`，所以 base64 与 utf8 一律走那里的手写 helper。

import { fromUtf8, utf8 } from '../crypto/bytes.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** `MSync.command = 0`：**回执**（ack）。⚠ 与 Rust 的 `CMD_SYNC` 同名值不同义（抓包 §三）。 */
export const CMD_ACK = 0;
/** `MSync.command = 1`：**应用层心跳**（约 15 s 一拍；⚠ Rust 叫它 `CMD_UNREAD`）。 */
export const CMD_HEARTBEAT = 1;
/** `MSync.command = 2`：**服务端弹幕推送**（⚠ Rust 叫它 `CMD_NOTICE`）。 */
export const CMD_DANMAKU = 2;
/** `MSync.command = 3`：**PROVISION 握手**（唯一带 payload 的那一帧）。 */
export const CMD_PROVISION = 3;

/** `guid.appKey`（**直播间**形态；抓包逐帧都是它）。 */
export const LIVE_APP_KEY = 'cmos#ngvlcs';
/** `guid.domain`。 */
export const LIVE_DOMAIN = 'cmosim.com';
/** `auth` 的前缀：实拍是 `"$t$" + accessToken`（101 字符），**不是**裸 token（抓包 §8.5）。 */
export const LIVE_AUTH_PREFIX = '$t$';
/** `guid.clientResource` / `Provision.resource` 的前缀（实拍 `webim_<13 位毫秒>`）。 */
export const LIVE_RESOURCE_PREFIX = 'webim_';

/**
 * `deviceInfo`(13) 的**实拍值**：**96 个 ASCII 字符**（不是 48 字节二进制）。
 *
 * ⚠ 前 64 字符与 Rust 的 `LIVE_DEVICE_INFO_HEX` **相同**，后 32 字符**不同**
 * （那边是 `cc96f61dadab12f3cab1e66cb28ec05b`）。这里用**实拍值**（抓包 §5.2）。
 *
 * ⚠ 后 32 字符是 **ASCII 的 16 位 hex**（`ea316192960629f2`），像"一个 64 位随机数的
 * hex 写法" ⇒ 这一串更像 `<32 字节固定前缀> + <16 字符 hex>`，**每设备一个**。
 * 我们手上只有实拍那台设备的取值（两条连接逐字相同）；
 * ⚠ **未判定**：它是否真按设备变、以及那后 8 字节怎么生成 —— 照抄实拍值是最保守的选择。
 */
export const LIVE_DEVICE_INFO_ASCII =
  '830652084dda69b6b957e2c3a7bd9b18db65922e29051b1b342ccf15bebc0fdbd9c03439bcd8fff7ea316192960629f2';

/** `identification`(15) 的固定前缀：ASCII `cmos_im2`（**8** 字节，抓包 §5.4）。 */
export const LIVE_IDENTIFICATION_PREFIX = 'cmos_im2';

/** `Provision.osType`：`OS_JS`。 */
export const PROVISION_OS_TYPE_JS = 7;
/** `Provision.version`（**不带** `v` 前缀 —— 与 HTTP 头的 `v23.0.2` 不是一个值）。 */
export const PROVISION_VERSION = '23.0.2';
/** `Provision.appSign`。 */
export const PROVISION_APP_SIGN = 'cmlive_cmos_js_sdk';
/** `Provision.deviceName`。 */
export const PROVISION_DEVICE_NAME = 'webim';

// ── proto3 wire 基础 ─────────────────────────────────────────────────────────

/** varint。
 *
 *  **全程 `bigint`**：msgId 是 19 位十进制（> 2^53），`number` 会静默丢低位（见文件头差异 9）。 */
const WIRE_VARINT = 0;
/** 64 位定长（本协议里一个都没用到，但跳过逻辑要有）。 */
const WIRE_FIXED64 = 1;
/** 长度前缀（bytes / string / 嵌套消息 / **packed** repeated）。 */
const WIRE_BYTES = 2;
/** 32 位定长。 */
const WIRE_FIXED32 = 5;

/** 一个已扫出来的字段。 */
interface ProtoField {
  readonly num: number;
  readonly wire: number;
  /** wire 0 的值。 */
  readonly value: bigint;
  /** wire 2 的内容。 */
  readonly raw: Uint8Array;
}

/** 解一个 varint。**越界一律抛**（由 `scanProtoFields` 的调用方转成"这不是 MSync"）。 */
function readVarint(data: Uint8Array, pos: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = pos; i < data.length; i += 1) {
    const b = data[i]!;
    const idx = i - pos;
    // 64 位最多 10 字节；第 10 字节只允许低 1 位有效（照抄 Rust 的两道界）。
    if (idx >= 10) throw new Error(`varint 超过 10 字节（第 ${idx + 1} 字节 = 0x${b.toString(16)}）`);
    if (idx === 9 && b > 1) throw new Error(`varint 溢出（第 10 字节 = 0x${b.toString(16)}）`);
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  throw new Error('varint 被截断');
}

/**
 * 扫出顶层字段。
 *
 * 做成"先扫一遍、再按字段号分派"而不是每个消息手写一个循环：三个入站包装
 * （payload / Message / MessageBody）都要走同一套跳过逻辑，各写一份的话，
 * 某一份漏处理一个 wire type 的表现是**静默解出空串** —— 而那正好与
 * "这条弹幕没有文本"长得一模一样（Rust 的注释也是这个理由）。
 */
function scanProtoFields(data: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < data.length) {
    const key = readVarint(data, i);
    i = key.next;
    const num = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (num === 0) throw new Error(`字段号为 0（key = ${key.value.toString()}）`);
    // 字段号本身也是 varint ⇒ 理论上能到 2^61；这里只要求它别超出安全整数。
    if (!Number.isSafeInteger(num)) throw new Error(`字段号超出安全整数（key = ${key.value.toString()}）`);
    let value = 0n;
    let raw: Uint8Array = new Uint8Array(0);
    if (wire === WIRE_VARINT) {
      const v = readVarint(data, i);
      i = v.next;
      value = v.value;
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(data, i);
      i = len.next;
      const size = Number(len.value);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`字段 ${num} 的声明长度超出范围`);
      if (data.length - i < size) {
        throw new Error(`字段 ${num} 声明长度 ${size}，实际只剩 ${data.length - i} 字节`);
      }
      // ⚠ 拷一份（而不是 `subarray`）：TS 5.7 的 TypedArray 泛型下
      //   `subarray()` 归 `Uint8Array<ArrayBufferLike>`，而 `ProtoField.raw` 是
      //   `Uint8Array<ArrayBuffer>` —— 运行期毫无差别，纯类型围栏。
      raw = new Uint8Array(data.subarray(i, i + size));
      i += size;
    } else if (wire === WIRE_FIXED64) {
      if (data.length - i < 8) throw new Error(`字段 ${num} 的 64 位定长值被截断`);
      i += 8;
    } else if (wire === WIRE_FIXED32) {
      if (data.length - i < 4) throw new Error(`字段 ${num} 的 32 位定长值被截断`);
      i += 4;
    } else {
      // group（3 / 4）在 proto3 里已废弃、protobufjs 也不会产出 ⇒ 认出就报错，
      // 别"跳过 8 字节试试"（Rust 的 `scan_proto_fields` 同样拒）。
      throw new Error(`不支持的 wire type ${wire}（字段 ${num}）`);
    }
    out.push({ num, wire, value, raw });
  }
  return out;
}

/** 宽容版：解不开就当作"没有字段"。
 *
 *  ⚠ 只有**嵌套**那一层用它 —— 顶层解不开要能被 `isMsync` 区分出来（见 `decodeMsync`）。 */
function fieldsOf(data: Uint8Array): ProtoField[] {
  try {
    return scanProtoFields(data);
  } catch {
    return [];
  }
}

/** 取某个字段号的**最后一个** wire 2 字段（proto3 的 singular 语义：后者覆盖前者）。 */
function lastBytesField(fields: readonly ProtoField[], num: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const f of fields) if (f.num === num && f.wire === WIRE_BYTES) found = f.raw;
  return found;
}

/** 取某个字段号的**最后一个** varint 字段。 */
function lastVarintField(fields: readonly ProtoField[], num: number): bigint | undefined {
  let found: bigint | undefined;
  for (const f of fields) if (f.num === num && f.wire === WIRE_VARINT) found = f.value;
  return found;
}

// ── 写 ───────────────────────────────────────────────────────────────────────

function putVarint(out: number[], value: bigint): void {
  let v = value;
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function putTag(out: number[], num: number, wire: number): void {
  putVarint(out, (BigInt(num) << 3n) | BigInt(wire));
}

/** singular 标量，**取零值时不写**（proto3 的一般规则；本模块只在实拍不写的地方用它）。 */
function putScalar(out: number[], num: number, value: bigint): void {
  if (value === 0n) return;
  putTag(out, num, WIRE_VARINT);
  putVarint(out, value);
}

/** singular 标量，**零值也写**（实拍里 `deviceId=0` / `encryptType=0` / `command=0` 都写）。 */
function putScalarForced(out: number[], num: number, value: bigint): void {
  putTag(out, num, WIRE_VARINT);
  putVarint(out, value);
}

/** 字符串，空串**不写**。 */
function putString(out: number[], num: number, value: string): void {
  if (value.length === 0) return;
  putBytesRaw(out, num, utf8(value));
}

/** 字符串，**空串也写**（实拍 PROVISION 的 `deviceUuid`：`4a 00`）。 */
function putStringKeepingEmpty(out: number[], num: number, value: string): void {
  putBytesRaw(out, num, utf8(value));
}

function putBytesRaw(out: number[], num: number, body: Uint8Array): void {
  putTag(out, num, WIRE_BYTES);
  putVarint(out, BigInt(body.length));
  for (let i = 0; i < body.length; i += 1) out.push(body[i]!);
}

/** bytes，空字节**不写**。 */
function putBytes(out: number[], num: number, body: Uint8Array): void {
  if (body.length === 0) return;
  putBytesRaw(out, num, body);
}

/** 嵌套消息，**空消息也写**（`tag + 长度 0` = "字段被设置了"）。 */
function putMessage(out: number[], num: number, body: Uint8Array): void {
  putBytesRaw(out, num, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 编码
// ─────────────────────────────────────────────────────────────────────────────

/** `encodeProvision()` 的入参（调用方 `liveWs.ts` 按这个形状给）。 */
export interface ProvisionInput {
  /** PROVISION 的 `auth` = `"$t$" + accessToken`（前缀常量是 [`LIVE_AUTH_PREFIX`]）。 */
  accessToken: string;
  /** 房间资源串（`Provision.resource`，字段 13）。实拍是 `webim_<13 位毫秒>`。 */
  resource: string;
  /** `Provision.deviceUuid`（字段 9）。
   *
   *  ⚠ **抓包 §5.5：实拍这里是空串**（字段在、长度为 0）。那个毫秒串实际落在
   *  `resource`（字段 13）上。本函数按签名把调用方给的值写进字段 9
   *  ——**传 `''` 才与实拍逐字节一致**（`4a 00`，仍然会写出去）。 */
  deviceUuid: string;
  /** `guid.name` 用的手机号：实拍是 `cmlive_c_<11 位手机号>`。 */
  phone: string;
}

/** 8 字节大端（毫秒值那一类小整数用；`bigint` 进来，避免任何隐式取整）。 */
function be64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 4 字节大端「秒」（抓包 §5.3：`timestamp`(14) 是**秒**，不是毫秒）。 */
function secondsBytes(nowMs: number): Uint8Array {
  if (!Number.isFinite(nowMs)) throw new Error(`nowMs 必须是有限数：${nowMs}`);
  const sec = Math.floor(nowMs / 1000);
  if (sec < 0 || sec > 0xffffffff) {
    throw new Error(`nowMs=${nowMs} 换算成秒后超出 4 字节（${sec}）—— 本协议只给 32 位秒`);
  }
  return new Uint8Array([(sec >>> 24) & 0xff, (sec >>> 16) & 0xff, (sec >>> 8) & 0xff, sec & 0xff]);
}

/** `identification`(15)：ASCII `cmos_im2`(8) + 8 字节变化值。
 *
 *  ⚠⚠ **那 8 字节的生成规则未判定**：抓包只看得见"两条连接的起始值不同
 *  （`…c77a` vs `…c971`）、同一条连接内逐帧缓慢变化"。没有样本能定出算式。
 *  所以这里给两个口子：
 *
 *  · `identTail` 由调用方给（测试拿实拍值回放；连测试都钉不住的东西不能靠猜）；
 *  · 不给时用 `nowMs` 的 64 位大端 —— **确定性**替代（可断言、不引随机源：
 *    QuickJS 里没有 `crypto`，而"每次调用都换一个随机值"会让这一层无法对拍）。
 *
 *  ⚠ 两者都与实拍的那 8 个字节**不同**；差异只在这 8 字节里（前缀与总长度已对齐实拍）。 */
function identificationBytes(nowMs: number, identTail?: Uint8Array): Uint8Array {
  const prefix = utf8(LIVE_IDENTIFICATION_PREFIX);
  if (prefix.length !== 8) {
    throw new Error(`identification 前缀必须是 8 字节 ASCII，实际 ${prefix.length} 字节`);
  }
  const tail = identTail ?? be64(BigInt(Math.floor(nowMs)));
  if (tail.length !== 8) throw new Error(`identification 的后半段必须是 8 字节，实际 ${tail.length}`);
  const out = new Uint8Array(16);
  out.set(prefix, 0);
  out.set(tail, 8);
  return out;
}

/** GUID（`MSync.2` / `Jid`，字段 1–4 全是 string）。实拍：`cmos#ngvlcs` + `cmlive_c_<手机号>` + 域名 + `webim_<毫秒>`。
 *
 *  ⚠ Rust 有**两条**分支：有 phone ⇒ `cmos#ngvlcs` + `cmlive_c_<phone>`；
 *  没有 phone ⇒ `cmos_js_sdk` + `cmlive_<roomId>`。本模块**只做直播间形态**
 *  （调用方的接口只给 phone）；那条 SDK 形态**没有实拍**，故不移植（见文件尾「没做」）。 */
function encodeJid(phone: string, nowMs: number): Uint8Array {
  const out: number[] = [];
  putString(out, 1, LIVE_APP_KEY);
  putString(out, 2, `cmlive_c_${phone}`);
  putString(out, 3, LIVE_DOMAIN);
  // ⚠ 实拍是 `webim_<毫秒>`（抓包 §5.2 / 实拍帧 `[1]` 的 GUID.4），
  // **Rust 写 `js_<毫秒>`** ⇒ 按实拍改。
  putString(out, 4, `${LIVE_RESOURCE_PREFIX}${Math.floor(nowMs)}`);
  return new Uint8Array(out);
}

/** PROVISION 那一帧的 payload（`Provision`，字段号见抓包 §5.5）。 */
function encodeProvisionPayload(input: ProvisionInput, auth: string): Uint8Array {
  const out: number[] = [];
  putScalar(out, 1, BigInt(PROVISION_OS_TYPE_JS));
  putString(out, 2, PROVISION_VERSION);
  // ⚠ 字段 3 `networkType` **不写**（抓包 §5.5 ⚠1 与实拍字节：没有 `18 01`）。
  putString(out, 4, PROVISION_APP_SIGN);
  // 下面两个恒为 [0]：实拍是 wire 0（`28 00` / `30 00`）且**值 0 也写**。
  putScalarForced(out, 5, 0n);
  putScalarForced(out, 6, 0n);
  // ⚠ 字段 9：实拍是**空串但字段在**（`4a 00`）⇒ 用"空也写"那一支。
  putStringKeepingEmpty(out, 9, input.deviceUuid);
  putString(out, 12, PROVISION_DEVICE_NAME);
  putString(out, 13, input.resource);
  putString(out, 14, auth);
  // ⚠ 字段 15 `provinceCode`：实拍没有 ⇒ 不写（原实现给空串，proto3 下同样不写）。
  return new Uint8Array(out);
}

/**
 * `command=3` 那一帧的 MSync 字节（PROVISION，**唯一**带 GUID + auth + payload 的帧）。
 *
 * 形状（照实拍，抓包 §五 + §5.5）：`2 GUID(68) 3 auth(101) 8=3 9 payload 10=0 11=0
 * 13 deviceInfo(96 ASCII) 14 timestamp(4 秒) 15 identification(16)`。
 *
 * 参数字段的长度决定总长：实拍（98 字符 token + `webim_<13 位毫秒>` resource +
 * 空 `deviceUuid`）是 **471 字节**。
 */
export function encodeProvision(input: ProvisionInput, nowMs: number, identTail?: Uint8Array): Uint8Array {
  const auth = `${LIVE_AUTH_PREFIX}${input.accessToken}`;
  const out: number[] = [];
  putMessage(out, 2, encodeJid(input.phone, nowMs));
  putString(out, 3, auth);
  putScalarForced(out, 8, BigInt(CMD_PROVISION));
  putMessage(out, 9, encodeProvisionPayload(input, auth));
  // ⚠ 字段 10 `deviceId`：实拍**写 0**（`50 00`），Rust 不写。
  putScalarForced(out, 10, 0n);
  // ⚠ 字段 11 `encryptType`：实拍 wire 0（`58 00`），Rust 写 packed(wire 2)。
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}

/**
 * `command=1`：应用层心跳。
 *
 * ⚠⚠ 抓包 §五 的实拍表：这一帧**只有 5 个顶层字段** `8 / 11 / 13 / 14 / 15`
 * （126 字节，§5.1 把原始字节逐条列了出来）——**不写** GUID / auth / userAgent / pov，
 * 而 Rust 的 `live_msync_frame` 每条都写那四个（抓包 §七 差异 4）。
 * "服务端靠连接本身认会话"是这一条的物理依据（§5.1 结尾那句）。
 *
 * ⚠ 它**不是**"PROVISION 之后补发一次"：抓包 §四 从时间点上证明了它是
 * **约 15 秒一拍的周期心跳**（第一拍恰好紧跟 ack，看着像补发而已）。本层不建模时序，
 * 什么时候发由状态机（`liveWs.ts`）决定。
 */
export function encodeHeartbeat(nowMs: number, identTail?: Uint8Array): Uint8Array {
  const out: number[] = [];
  putScalarForced(out, 8, BigInt(CMD_HEARTBEAT));
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}

/**
 * `command=0`：**回执**（带上被确认的 msgId）。
 *
 * 抓包 §3.2：客户端每收到一条 `cmd=2` 就回一条 `cmd=0`（464 B ×38），服务端再回一条
 * `cmd=0` 作回执（94 B ×39）。本帧形状**照实拍**：`8=0 9 payload 11=0 13 14 15`，
 * 其中 `payload = {1: {1: msgId}}`（实拍那条 `9:{1:{1:<msgId>…}}` 的**最小回显**）。
 *
 * ⚠ 比实拍**少写**两处（理由见文件头第三节）：不带 GUID(2)，payload 不回显被确认的
 * 整条消息（我们只有 msgId）。两处都**未判定**（服务端认不认要等下次开播）。
 *
 * ⚠ `msgId` 是**十进制串**，且长度可达 19 位 —— 内部走 `BigInt`，
 * 用 `Number` 会丢低位（见文件头差异 9）。
 */
export function encodeAck(msgId: string, nowMs: number, identTail?: Uint8Array): Uint8Array {
  if (!/^(0|[1-9][0-9]*)$/.test(msgId)) {
    // 这是**开发期错误**（调用方给的不是 msgId），不是运行时状况 ⇒ 当场炸，
    // 而不是发一条带着错误 id 的回执出去。
    throw new Error(`encodeAck 的 msgId 必须是十进制串（无前导零），收到 ${JSON.stringify(msgId)}`);
  }
  const out: number[] = [];
  putScalarForced(out, 8, BigInt(CMD_ACK));
  putMessage(out, 9, ackPayload(BigInt(msgId)));
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}

/** ack 的 payload：`{1: {1: msgId}}`（抓包 §3.2 那条帧的 `9:{1:{1:<msgId>…}}` 形状）。 */
function ackPayload(msgId: bigint): Uint8Array {
  const inner: number[] = [];
  putScalarForced(inner, 1, msgId);
  const out: number[] = [];
  putMessage(out, 1, new Uint8Array(inner));
  return new Uint8Array(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// 解码
// ─────────────────────────────────────────────────────────────────────────────

/** `decodeMsync()` 的结果。 */
export interface DecodedMsync {
  /** `MSync.8`（缺字段 ⇒ 0，proto3 的默认值）。 */
  command: number;
  /** 服务端推的 msgId（ack 要用）；认不出就是 `undefined`。**十进制串**（19 位，别过 Number）。 */
  msgId: string | undefined;
  /** `command=2` 时解出来的弹幕文本：一条报文可能带多条，按 repeated 顺序。 */
  texts: readonly string[];
  /**
   * ⚠ **本模块新增的字段**（约定的三个字段之外）：「这一段字节是不是一条 MSync」。
   *
   * `false` = **顶层** wire 解不开（长度/varint/字段号/wire type 不合法，或空字节）
   * ⇒ 调用方据此记"坏帧"。用**返回值**表达而不是抛异常：解不开是数据问题，
   * 不是程序问题（Rust 那边是 `Result`，到了这一层要能被状态机当成一类帧来数）。
   */
  isMsync: boolean;
}

/**
 * 解一条服务端 MSync。
 *
 * · **不抛**：顶层解不开 ⇒ `isMsync: false` + `command: 0` + 空 `texts`；
 *   嵌套解不开（例如 payload 被截断）⇒ `isMsync: true` 但那一层没有内容。
 * · **认不出的字段直接跳过**（proto3 的前向兼容要求：新版本加字段不该让老客户端炸）。
 * · `command=2` 的文本路径是 `9 → 2 → 6 → 4(repeated) → 2`（抓包 §3.1，逐字节核过）。
 */
export function decodeMsync(bytes: Uint8Array): DecodedMsync {
  let fields: ProtoField[];
  try {
    fields = scanProtoFields(bytes);
  } catch {
    return { command: 0, msgId: undefined, texts: [], isMsync: false };
  }
  // 空字节：proto3 里"全默认值的一条空消息"合法，但抓包里长度 0 的那一帧是
  // SockJS 的**关闭**帧（§二 末帧）⇒ 不算 MSync（否则每条空帧都要被当成 cmd=0）。
  if (fields.length === 0) return { command: 0, msgId: undefined, texts: [], isMsync: false };

  const command = Number(lastVarintField(fields, 8) ?? 0n) & 0xff;
  const payload = lastBytesField(fields, 9);

  if (command === CMD_DANMAKU && payload !== undefined) {
    return { command, ...danmakuOf(payload), isMsync: true };
  }
  if (command === CMD_ACK && payload !== undefined) {
    return { command, msgId: ackMsgIdOf(payload), texts: [], isMsync: true };
  }
  return { command, msgId: undefined, texts: [], isMsync: true };
}

/** 弹幕帧的 `{msgId, texts}`（`payload.2 → .6 → .4 → .2`）。 */
function danmakuOf(payload: Uint8Array): { msgId: string | undefined; texts: string[] } {
  const texts: string[] = [];
  let msgId: string | undefined;
  // ⚠ 遍历**所有** `payload.2`（实拍里可以有多条 meta，文本落在哪一条**不一定**：
  // conn 1127 `[8]` 在第 3 条、`[58]` 在第 2 条、`[110]` 在第 1 条）。
  // Rust 只取第一条 ⇒ 会漏 `[8]` / `[58]` 那两条（见文件头差异 8）。
  for (const meta of fieldsOf(payload)) {
    if (meta.num !== 2) continue;
    if (meta.wire === WIRE_VARINT) {
      // 非实拍形状（实拍 `payload.2` 是 Message 消息）。仍然当"一个 id"读出来，
      // 而不是丢掉：《raw 里 field 2 是 varint》正是服务端 ack 的形状，
      // 报文混着来时至少不会把它误当成文本。
      msgId = meta.value.toString();
      continue;
    }
    if (meta.wire !== WIRE_BYTES) continue;
    const inner = fieldsOf(meta.raw);
    for (const body of inner) {
      if (body.num !== 6 || body.wire !== WIRE_BYTES) continue;
      for (const content of fieldsOf(body.raw)) {
        if (content.num !== 4 || content.wire !== WIRE_BYTES) continue;
        const text = lastBytesField(fieldsOf(content.raw), 2);
        // ⚠ 「只有 type、没有 text」的 content **不产出**（`4:{1:0}` 就是它；
        // 一个只有类型的片段不是文本，产出空串会让调用方拿它去拼口令）。
        if (text !== undefined) texts.push(fromUtf8(text));
      }
    }
    const id = msgIdOf(inner);
    // proto3 的 singular 语义：多条 message 时**最后一条**覆盖前面的
    // （protobufjs 的实际行为；Rust 取第一条，见文件头差异 8）。
    if (id !== undefined) msgId = id;
  }
  return { msgId, texts };
}

/** 从 `Message` 里读 msgId（字段 1）。两种编码都认，理由见下面。 */
function msgIdOf(messageFields: readonly ProtoField[]): string | undefined {
  const v = lastVarintField(messageFields, 1);
  if (v !== undefined) return v.toString();
  // ⚠ 实拍是 **varint**（wire 0，抓包 §3.1）。这里额外容忍 wire 2 的**十进制串**：
  // proto3 里 int64 用字符串表示是常见编码，而"报文里字段 1 是字符串"这件事
  // 在同一个仓库的 `liveWs.ts` 测试夹具里就是这么造的（`lenField(1, utf8(msgId))`）。
  // 只认数字串 —— 否则会把 JID 的 `appKey`（`cmos#ngvlcs`）当成 msgId。
  const s = lastBytesField(messageFields, 1);
  if (s === undefined) return undefined;
  const asText = fromUtf8(s);
  return /^[0-9]+$/.test(asText) ? asText : undefined;
}

/** 服务端 ack 回执（`cmd=0`）里的 msgId。 */
function ackMsgIdOf(payload: Uint8Array): string | undefined {
  const fields = fieldsOf(payload);
  // 实拍（抓包 §3.2 那 94 B）：`9:{1:{1:0} 2:<msgId> 3:<msgId>}` ⇒ 字段 2 就是 msgId。
  const direct = lastVarintField(fields, 2);
  if (direct !== undefined) return direct.toString();
  // 兜底：客户端那种"回显"形状（`9:{1:{1:<msgId> …}}`）。实拍里 `{1:{1:0}}` 的 0
  // 是"没有 id"（不是 msgId 0）⇒ 只有非 0 才算，免得把一条没有任何 id 的帧报成 '0'。
  const one = lastBytesField(fields, 1);
  if (one === undefined) return undefined;
  const inner = lastVarintField(fieldsOf(one), 1);
  return inner !== undefined && inner > 0n ? inner.toString() : undefined;
}

/** 「这一段字节是不是一条 MSync」—— [`decodeMsync`] 的 `isMsync` 那一位。 */
export function isMsyncFrame(bytes: Uint8Array): boolean {
  return decodeMsync(bytes).isMsync;
}

/**
 * 只要文本那一半（`decodeMsync().texts`）。
 *
 * ⚠ 拿它判断"这是不是一条口令弹幕"是**不够的** —— 事件消息（入场/点赞/系统/礼物）
 * 也有文本（抓包 §3.1 的实拍文本里就有 `加入直播间` / `点赞` / `送了1个火箭`）。
 * 真正的判据是上游 `ext.msgType`，而**本模块不移植它**（见文件尾「未做」）。
 */
export function extractDanmakuTexts(bytes: Uint8Array): readonly string[] {
  return decodeMsync(bytes).texts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 未判定 / 未做（**别把没判定的东西写成断言**）
// ─────────────────────────────────────────────────────────────────────────────
//
// 未判定（要等下一次开播才有样本）：
//   1. `identification`(15) 后 8 字节的生成规则 —— 只知道每连接重新起算、逐帧缓慢变化
//      （抓包 §5.4）。本模块用 `nowMs` 的 64 位大端替代，并留了 `identTail` 注入。
//   2. `deviceInfo`(13) 的后 32 个 ASCII 字符是否真按设备变 —— 手上只有一台设备的实拍值。
//   3. 服务端是否接受"少了 GUID(2)、payload 只回显 msgId"的 ack（文件头第三节）。
//   4. 抓包 §七 的原话：**这些差异一条都没有"服务端认不认"的判据** ——
//      本模块只保证"形状与实拍对齐"，不保证服务端接受。
//
// 没做：
//   1. `ext.msgType` 的读出与事件过滤（Rust 的 `msg_type_of` / `is_event_message`）
//      —— 不在本模块约定的接口里；实拍取值 `2/5/6/7`=事件、`4`=口令（抓包 §3.1 的 ext 列表）。
//   2. Rust 的"三级兜底"（外层解不开就把整段 payload 当 MessageBody 再解一次）。
//      抓包已把 `cmd=2` 的路径钉死（两条连接全部命中 `9.2.6.4.2`），
//      兜底只会增加"把非弹幕字节解成文本"的面积 ⇒ 不做。
//   3. 别的东西：`cmd=4/5/6/7` 的语义、PROVISION 响应的 payload（实拍 `{5:0 8:{1:0} 13:resource}`）
//      —— 都零样本或与本层无关，解码时当未知字段跳过。
//   4. Rust 的 **非直播间形态** GUID（`cmos_js_sdk` + `cmlive_<roomId>`）：调用方的接口
//      只给 phone，而那条分支**没有实拍**（抓包两条连接都是 `cmos#ngvlcs` + `cmlive_c_<手机号>`）。
