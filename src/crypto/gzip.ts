// gzip（OS 字节写 19）—— smid 上报体里 `data` 的最后一步。
//
// 权威源：`mcloud/crates/mcloud-crypto/src/gzip.rs`（`gzip_with_os19_base64`）。
//
// ⚠ **这里刻意用 DEFLATE 的 stored 块，不做任何压缩。**
//
// 理由不是"偷懒"，是**收益与风险不成比例**：
//   · 要压就得实现 Huffman 编码（~300 行），而它是这条链里**最难对拍**的一段 ——
//     不同实现的压缩结果**本来就不一样**（同一份数据可以有无数种合法 DEFLATE 流），
//     所以"跟 mcloud 的输出逐字节比"这条最有力的验证手段**在这里根本用不了**；
//   · stored 块是**合法 DEFLATE**，任何解压器都收；
//   · 代价只是上报体大一点（特征体约 1-2 KB），而它不是带宽敏感的东西。
//
// ⇒ 换来的是：这一段可以用"**用 Node 的 zlib 解回来，逐字节等于原文**"来验，
// 而那是比"跟我自己算的一样"强得多的assertion。

import { toBase64 } from './bytes.ts';

/** gzip 头里的 OS 字节。**19** 是 mcloud 逐字照抄的值（不是 3=Unix、也不是 255=未知）。
 *
 *  个别服务端会看这一位来判"这是哪个客户端"—— 所以它不是无关紧要的字节。 */
export const GZIP_OS = 19;

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** gzip 尾部的 CRC32（IEEE，与 `zlib.crc32` 同口径）。 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DEFLATE 的**非压缩（stored）**块序列：每块最多 65535 字节。
 *
 *  ⚠ 长度 0 的输入**也要发一个块**（一个空的 stored 块带 `BFINAL=1`）——
 *  一个字节都不发的话那份流是**不完整的**，解压器会报"unexpected end of file"。 */
export function deflateStored(data: Uint8Array): Uint8Array {
  const MAX = 65535;
  const chunks = data.length === 0 ? [data.subarray(0, 0)] : [];
  for (let off = 0; off < data.length; off += MAX) {
    chunks.push(data.subarray(off, Math.min(off + MAX, data.length)));
  }
  // 每块 5 字节头（1 字节 BFINAL/BTYPE + LEN/NLEN 各 2 字节）+ 数据
  let total = 0;
  for (const c of chunks) total += 5 + c.length;
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach((c, i) => {
    const last = i === chunks.length - 1;
    // BFINAL(1 bit) + BTYPE=00(2 bits)，其余位补零 ⇒ 首字节就是 0 或 1
    out[p++] = last ? 1 : 0;
    const len = c.length;
    out[p++] = len & 0xff;
    out[p++] = (len >>> 8) & 0xff;
    out[p++] = ~len & 0xff;
    out[p++] = (~len >>> 8) & 0xff;
    out.set(c, p);
    p += len;
  });
  return out;
}

/** 合法 gzip 成员：10 字节头 + DEFLATE + CRC32 + ISIZE。 */
export function gzipWithOs19(data: Uint8Array): Uint8Array {
  const body = deflateStored(data);
  const out = new Uint8Array(10 + body.length + 8);
  out[0] = 0x1f;
  out[1] = 0x8b;
  out[2] = 8; // CM = deflate
  out[3] = 0; // FLG
  // MTIME 四字节留 0（= "没有时间戳"）；写成当前时间会让输出每次都不一样
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0; // XFL
  out[9] = GZIP_OS;
  out.set(body, 10);
  const crc = crc32(data);
  const n = data.length >>> 0;
  const tail = 10 + body.length;
  out[tail] = crc & 0xff;
  out[tail + 1] = (crc >>> 8) & 0xff;
  out[tail + 2] = (crc >>> 16) & 0xff;
  out[tail + 3] = (crc >>> 24) & 0xff;
  out[tail + 4] = n & 0xff;
  out[tail + 5] = (n >>> 8) & 0xff;
  out[tail + 6] = (n >>> 16) & 0xff;
  out[tail + 7] = (n >>> 24) & 0xff;
  return out;
}

/** `gzip.rs::gzip_with_os19_base64` 的等价物：原始字节 → 标准 base64 的 gzip。 */
export function gzipWithOs19Base64(data: Uint8Array): string {
  return toBase64(gzipWithOs19(data));
}
