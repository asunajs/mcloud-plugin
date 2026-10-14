// IM 那一族（`videoim.cmcc-cs.cn:20103`）—— **进房间**（`member/apply`）与它的两个签名头。
//
// # ⚠⚠ 这一族是**第三套信封**
//
// ```text
// 小红花（`m.mcloud.139.com/ycloud`）   {code: 0, msg, result}          数字码 + result
// 直播（`v.cmcc-cs.cn/cmlive`）         {rtnCode: "0", rtnMsg, object}  字符串码 + object
// IM（`videoim.cmcc-cs.cn:20103`）      {code: 0, msg, data, timestamp} 数字码 + data
// ```
//
// 三套都在同一条链路上，**不能共用解析**：`/cmlive` 那一套取 `object`，这里取 `data`
// —— 混用会让 `data` 永远取不到（表现是"进房间成功但没回显"）。mcloud 把这条写进了
// 它的模块头（坑表 #108），照抄。
//
// # 为什么这一族是"必须做"而不是"锦上添花"
//
// 2026-10-14 实机：门、`roomBeat`、WS 握手、PROVISION **全过了**，但**一条弹幕都没有**
// —— 只收到自己的心跳回包。原因是漏了 mcloud 链里的两步：
//
// ```text
//   ⓐ WS 凭据来自 `userToken`（`object.access_token`），**不是**门换来的那个 JWT；
//     PROVISION 的 `auth` 是 `$t$<accessToken>`。
//   ⓑ 建 WS **之前**要 `member/apply` 进聊天室，否则服务端不往这条连接推房间消息。
// ```
//
// 少了 `member/apply` 的表现是「连接建得起来、心跳也通、就是没有弹幕」——
// 与"这间房没人说话"从外面看**完全一样**（这也是我先前误判成"观众安静"的原因）。
//
// # 两个签名头：形状照实拍，但**服务端不校验它们**
//
// 2026-09-23 的反证实验（抓包 §8.6）：把 `systemMd5` / `tokenMd5` 都打成全 0，
// 服务端照样回 `{"code":0}` ⇒ 它们**不是闸门**。这里仍然按实拍的算式算出来
// —— 不校验不等于可以省：省掉之后，报文就与原客户端不同，而"哪里不同"
// 只会在某天服务端真的开始校验时暴露。
//
// ⚠ 两个算式都**按字节**求 MD5（`deviceInfo` 解码后那 48 字节里有非 UTF-8 序列，
//   先转字符串会把这些字节改写成 U+FFFD ⇒ 摘要就不对了）。

import { fromHex, toHex, utf8 } from '../crypto/bytes.ts';
import { md5 } from '../crypto/md5.ts';
import { LIVE_DEVICE_INFO_ASCII } from './msync.ts';
import { LIVE_ORIGIN, LIVE_USER_AGENT } from './liveGate.ts';
import { rootOrDefault } from './h5.ts';
import type { BuiltRequest } from './h5.ts';

/** IM 的 HTTPS 入口。⚠ **带端口 20103**，与 WS 那个 20102 不是一回事。 */
export const BASE_VIDEO_IM = 'https://videoim.cmcc-cs.cn:20103';


/** `member/apply` 的 `Version` 头（照实拍）。 */
export const LIVE_APPLY_VERSION = 'v23.0.2';

// `Origin` / UA 与 `/cmlive` 那一族共用（实拍：两处逐字相同）——
// ⚠ `export ... from` **不会**把名字带进本模块作用域，所以要 import 一份自己用。

/** 取时间戳字符串的**末 10 位**。
 *
 *  ⚠ 长度不足 10 时**原样返回**（对齐 JS 的 `String.prototype.slice(-10)`）——
 *  别在这里加长度校验：那会把一次**协议差异**变成"参数错误"，
 *  而真正该看见的是**签名对不上**。 */
export function timestampSuffix10(timestamp: string): string {
  return timestamp.length <= 10 ? timestamp : timestamp.slice(timestamp.length - 10);
}

const md5HexBytes = (bytes: Uint8Array): string => toHex(md5(bytes));

/** `systemMd5` = `md5( hexDecode(deviceInfo) ‖ utf8(ts 末 10 位) )`。
 *
 *  ⚠ 第一段是**解码后的 48 字节**，不是那 96 个 hex 字符本身。 */
export function systemMd5(deviceInfoHex: string, timestamp: string): string {
  const device = fromHex(deviceInfoHex);
  const ts = utf8(timestampSuffix10(timestamp));
  const payload = new Uint8Array(device.length + ts.length);
  payload.set(device, 0);
  payload.set(ts, device.length);
  return md5HexBytes(payload);
}

/** `tokenMd5` = `md5( "Bearer " + token 前 10 字符 + ts 末 10 位 + token 其余 )`。
 *
 *  ⚠ 时间戳被**插在 token 的第 10 个字符之后** —— 它不是"对 token 求哈希"。
 *  这个形状是 2026-09-23 实拍逐字验过的（§8.3）。
 *
 *  ⚠ 短于 10 字符的 token：JS 的 `slice(0,10)` 给整串、`slice(10)` 给空串
 *  —— 照抄那个语义（mcloud 的黄金向量 `short-token` 就是这条）。 */
export function tokenMd5(accessToken: string, timestamp: string): string {
  const head = accessToken.length > 10 ? accessToken.slice(0, 10) : accessToken;
  const tail = accessToken.length > 10 ? accessToken.slice(10) : '';
  return md5HexBytes(utf8(`Bearer ${head}${timestampSuffix10(timestamp)}${tail}`));
}

/** `member/apply` 请求（**进聊天室**，建 WS 之前的那一步）。 */
export function applyRoomRequest(
  chatRoomId: string,
  userName: string,
  invoker: string,
  accessToken: string,
  timestamp: string,
  opts: { base?: string | undefined; deviceInfoHex?: string | undefined } = {},
): BuiltRequest {
  const deviceInfoHex = opts.deviceInfoHex ?? LIVE_DEVICE_INFO_ASCII;
  return {
    url: `${rootOrDefault(opts.base, BASE_VIDEO_IM)}/v3/room/member/apply`,
    method: 'POST',
    headers: {
      accept: '*/*',
      version: LIVE_APPLY_VERSION,
      timestamp,
      authorization: `Bearer ${accessToken}`,
      origin: LIVE_ORIGIN,
      'user-agent': LIVE_USER_AGENT,
      deviceinfo: deviceInfoHex,
      systemmd5: systemMd5(deviceInfoHex, timestamp),
      tokenmd5: tokenMd5(accessToken, timestamp),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ invoker, message: '', roomId: chatRoomId, userName }),
    // ⚠ 这个主机与直播侧**同一类问题**：2026-10-14 实测只给 CBC 套件
    //   （`ECDSA/ECDHE-RSA-AES128-SHA`），rustls 谈不下来 ⇒ 必须平台 TLS。
    tls: 'native',
  };
}

/** `member/apply` 的读数。 */
export interface ApplyRoomResult {
  appId: string;
  appKey: string;
  /** 回显的聊天室 id（与请求里的同值）。 */
  roomId: string;
  serverTimestamp: number;
}

/** 解析 `member/apply` 的响应。**数字码 `code`**（不是 `/cmlive` 的 `rtnCode`）。 */
export function parseApplyRoom(body: string): { ok: true; value: ApplyRoomResult } | { ok: false; error: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `进聊天室的响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v['code'];
  // ⚠ 数字码这一族：`code` 必须是数字 0。字符串 "0" **不算** ——
  //   与 `/cmlive` 那条"只认字符串码"是同一条理由的反面：
  //   抹平类型差异就等于把"上游换了信封"这个信号抹掉。
  if (code !== 0) {
    const msg = typeof v['msg'] === 'string' ? (v['msg'] as string) : '';
    return { ok: false, error: `进聊天室失败：code=${JSON.stringify(code)} msg=${msg || '(无)'}` };
  }
  const data = (typeof v['data'] === 'object' && v['data'] !== null ? v['data'] : {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      appId: typeof data['appId'] === 'string' ? (data['appId'] as string) : '',
      appKey: typeof data['appKey'] === 'string' ? (data['appKey'] as string) : '',
      roomId: typeof data['roomId'] === 'string' ? (data['roomId'] as string) : '',
      serverTimestamp: typeof v['timestamp'] === 'number' ? (v['timestamp'] as number) : 0,
    },
  };
}
