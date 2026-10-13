// MD5（RFC 1321）。
//
// 上游那套接口还在用它签名 —— 这不是我们选的，是必须兼容的。
//
// 实现只做 32 位整数运算（`Math.imul` + `>>> 0`），不用 BigInt：
// QuickJS 里 BigInt 能用但没必要赌，而且 32 位路径更快。
// 正确性由 test/crypto.test.ts 对着 Node 的 `crypto.createHash('md5')` 逐用例比对。

import { lengthBits, readU32LE, writeU32LE } from './bytes.ts';

// 每轮的左移量（RFC 1321 里的 s 表）
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(|sin(i+1)| * 2^32)，现算而不是抄 64 个数。
// （这个浮点技巧在 MD5 上是被工程验证过的：真实值与整数的最小距离远大于双精度误差 5e-7。）
const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** 补位：0x80 + 0x00… + 64 位小端长度。返回的字节数是 64 的倍数。 */
export function padLE(bytes: Uint8Array): Uint8Array {
  const { hi, lo } = lengthBits(bytes.length);
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;
  writeU32LE(out, total - 8, lo);
  writeU32LE(out, total - 4, hi);
  return out;
}

export function md5(bytes: Uint8Array): Uint8Array {
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const padded = padLE(bytes);
  const m = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = readU32LE(padded, off + j * 4);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i]! + m[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, S[i]!)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  writeU32LE(out, 0, a0);
  writeU32LE(out, 4, b0);
  writeU32LE(out, 8, c0);
  writeU32LE(out, 12, d0);
  return out;
}
