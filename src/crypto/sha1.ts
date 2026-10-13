// SHA-1（FIPS 180-4）。上游接口里跟 MD5 混着用，所以两个都要有。
//
// SHA-1 已经不抗碰撞，但这里不是拿它做安全边界 —— 它只是上游协议的既有格式。
// 这一点必须写在代码里，免得后人以为「这里用 SHA-1 是没问题的」。

import { lengthBits, readU32BE, writeU32BE } from './bytes.ts';

/** 补位：0x80 + 0x00… + 64 位**大端**长度（SHA 家族用大端，MD5 用大端/小端要注意区分）。 */
export function padBE(bytes: Uint8Array): Uint8Array {
  const { hi, lo } = lengthBits(bytes.length);
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;
  writeU32BE(out, total - 8, hi);
  writeU32BE(out, total - 4, lo);
  return out;
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function sha1(bytes: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const padded = padBE(bytes);
  const w = new Uint32Array(80);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = readU32BE(padded, off + i * 4);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  writeU32BE(out, 0, h0);
  writeU32BE(out, 4, h1);
  writeU32BE(out, 8, h2);
  writeU32BE(out, 12, h3);
  writeU32BE(out, 16, h4);
  return out;
}
