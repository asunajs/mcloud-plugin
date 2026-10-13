// 请求签名 —— 逐字复刻 mcloud 的 `mcloud_crypto::sign`。
//
// 协议（来自 `crates/mcloud-crypto/src/sign.rs` 的模块文档，不是猜的）：
//
//   data = salt + id + timestamp + nonce + other + salt
//   sign = MD5(data)           // 小写 hex
//
// 盐值只有两个，未知 key 回落到 1（对齐原实现的 `|| SALT_MAP[1]`）。
//
// ⚠ 这里有一个**必须照抄**的细节：`timestamp` 以**字符串**参与拼接。
// 原实现在注释里写了理由（避免 i64 / f64 的格式化差异）；JS 这边同理 ——
// `String(1700000000000)` 与浮点格式化不是一回事，中途过一遍 number 只是多一次
// 「可能不一致」的机会。所以本文件里 timestamp 全程是字符串，不做数值运算。
//
// 复刻的验收方式见 test/sign.test.ts：断言的是**公式本身**
// （salt 包裹两次、other 在尾盐之前、盐表回落），而不是「跟我自己算的一样」。

import { md5Hex } from '../crypto/index.ts';

/** 签名盐值表。key 只有 1 和 2 有意义，其余回落 1。 */
export const SALT_MAP: ReadonlyArray<readonly [number, string]> = [
  [1, 'seedMdYYLIZfbCxg'],
  [2, 'sekaMdYYLIZfbCfm'],
];

/** 取盐值；未知 key 回落第一个（上游行为，不是我们的选择）。 */
export function saltFor(saltKey: number): string {
  return saltKey === 2 ? SALT_MAP[1]![1] : SALT_MAP[0]![1];
}

/** 计算签名（小写 hex）。 */
export function generateSignature(
  id: string,
  timestamp: string,
  nonce: string,
  saltKey: number,
  other: string,
): string {
  const salt = saltFor(saltKey);
  return md5Hex(salt + id + timestamp + nonce + other + salt);
}

/** 四个签名头（名字即线上形式，小写）。 */
export interface SignHeaders {
  'x-request-id': string;
  'x-timestamp': string;
  'x-nonce': string;
  'x-signature': string;
}

/** 用指定的 id / nonce 造签名头 —— 显式传入随机量，测试才可复现。 */
export function signHeadersWith(
  id: string,
  nonce: string,
  timestampMs: string,
  saltKey: number,
  other: string,
): SignHeaders {
  return {
    'x-request-id': id,
    'x-timestamp': timestampMs,
    'x-nonce': nonce,
    'x-signature': generateSignature(id, timestampMs, nonce, saltKey, other),
  };
}
