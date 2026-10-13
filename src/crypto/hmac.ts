// HMAC（RFC 2104）+ 便捷封装。
//
// 泛型写法：HMAC 跟具体哈希无关，只要块长对。三个哈希的块长都是 64 字节。

import { toHex, utf8 } from './bytes.ts';
import { md5 } from './md5.ts';
import { sha1 } from './sha1.ts';
import { sha256 } from './sha256.ts';

export type HashFn = (bytes: Uint8Array) => Uint8Array;

export function hmac(hash: HashFn, blockSize: number, key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > blockSize) k = hash(k);

  // 先算 inner 再按它的真实长度分配 opad —— 这样不用为了拿「摘要多长」多哈希一次
  const ipad = new Uint8Array(blockSize + msg.length);
  for (let i = 0; i < blockSize; i += 1) {
    ipad[i] = (i < k.length ? k[i]! : 0) ^ 0x36;
  }
  ipad.set(msg, blockSize);
  const inner = hash(ipad);

  const opad = new Uint8Array(blockSize + inner.length);
  for (let i = 0; i < blockSize; i += 1) {
    opad[i] = (i < k.length ? k[i]! : 0) ^ 0x5c;
  }
  opad.set(inner, blockSize);
  return hash(opad);
}

export const BLOCK = 64;

export function hmacMd5(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmac(md5, BLOCK, key, msg);
}
export function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmac(sha1, BLOCK, key, msg);
}
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmac(sha256, BLOCK, key, msg);
}

// ── 便捷封装：上游签名大多是「按顺序拼一串，然后取 hex」这一件事 ──────────────

export const md5Hex = (d: Uint8Array | string): string => toHex(md5(anyBytes(d)));
export const sha1Hex = (d: Uint8Array | string): string => toHex(sha1(anyBytes(d)));
export const sha256Hex = (d: Uint8Array | string): string => toHex(sha256(anyBytes(d)));
export const hmacSha256Hex = (key: string, msg: string): string => toHex(hmacSha256(utf8(key), utf8(msg)));

function anyBytes(d: Uint8Array | string): Uint8Array {
  return typeof d === 'string' ? utf8(d) : d;
}
