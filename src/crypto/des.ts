// DES-ECB（零填充）—— smid 上报里按 `DES_RULE` 逐字段加密那一步。
//
// 权威源：`mcloud/crates/mcloud-crypto/src/des.rs`（`des_encrypt_b64`）+ mcloud-sign 的
// `smid/index.ts`（它走 crypto-js 的 `DES/ECB/NoPadding`）。两者同口径：
//
//   fit_key8(key) = key[0..8] 截断 + 用 **\0** 补齐
//   明文补到 8 的整数倍 —— **零填充**（⚠ 不是 PKCS7；AES 那边才是 PKCS7）
//   逐 8 字节块 ECB
//   输出 **base64**（⚠ AES 那边输出的是 hex）
//   空明文 ⇒ 返回**空串**（无块可加密），不是错误
//
// ⚠ 算法与五张表都是照 **crypto-js** 的形态来的（表见 `desTables.ts`），
// 尤其是 `SBOX_P` 那种"已合并 S 盒 + P 置换"的对象映射 —— 见那个文件的注释。
// 验收用 FIPS 的已知答案（`test/des.test.ts`），不测"跟我自己算的一样"。

import { toBase64, utf8 } from './bytes.ts';
import { BIT_SHIFTS, PC1, PC2, SBOX_MASK, SBOX_P } from './desTables.ts';

/** 复刻 `key.substring(0, 8).padEnd(8, "\0")`。 */
export function fitKey8(key: string): Uint8Array {
  const out = new Uint8Array(8);
  const src = utf8(key);
  out.set(src.subarray(0, 8));
  return out;
}

/** 明文补到 8 的整数倍：**零填充**。
 *
 *  ⚠ 长度正好是整数倍时**不补**（与 AES 的 PKCS7 相反 —— 那边要补一整块）。
 *  这条差异抄错的表现是"最后一块多出 8 个 0 字节"，而 base64 串只是长了一截。 */
export function zeroPadToBlock(msg: Uint8Array, blockSize: number): Uint8Array {
  const rem = msg.length % blockSize;
  if (rem === 0) return msg;
  const out = new Uint8Array(msg.length + (blockSize - rem));
  out.set(msg);
  return out;
}

/** 8 字节密钥 → 两个大端 32 位字（crypto-js 的 `WordArray` 形态）。 */
function keyWords(key: Uint8Array): [number, number] {
  const be = (o: number): number =>
    ((key[o]! << 24) | (key[o + 1]! << 16) | (key[o + 2]! << 8) | key[o + 3]!) >>> 0;
  return [be(0), be(4)];
}

/** PC1 → 56 位 → 16 组子密钥（每组 8 个 32 位掩码）。逐行照抄 crypto-js 的 `_doReset`。 */
export function desSubKeys(key: Uint8Array): number[][] {
  const [w0, w1] = keyWords(key);
  const words = [w0, w1];
  const keyBits: number[] = [];
  for (let i = 0; i < 56; i += 1) {
    const p = PC1[i]! - 1;
    keyBits[i] = (words[p >>> 5]! >>> (31 - (p % 32))) & 1;
  }

  const subKeys: number[][] = [];
  for (let n = 0; n < 16; n += 1) {
    const subKey: number[] = [];
    const bitShift = BIT_SHIFTS[n]!;
    for (let i = 0; i < 24; i += 1) {
      const left = keyBits[((PC2[i]! - 1) + bitShift) % 28]! << (31 - (i % 6));
      const right = keyBits[28 + (((PC2[i + 24]! - 1) + bitShift) % 28)]! << (31 - (i % 6));
      const a = (i / 6) | 0;
      // ⚠ `subKey[a]` 第一次是 `undefined`；JS 里 `undefined | x === x`，
      // 但 TS 不允许这么写 —— 显式兜 0，语义一样
      subKey[a] = (subKey[a] ?? 0) | left;
      subKey[4 + a] = (subKey[4 + a] ?? 0) | right;
    }
    subKey[0] = ((subKey[0]! << 1) | (subKey[0]! >>> 31)) >>> 0;
    for (let i = 1; i < 7; i += 1) subKey[i] = subKey[i]! >>> ((i - 1) * 4 + 3);
    subKey[7] = ((subKey[7]! << 5) | (subKey[7]! >>> 27)) >>> 0;
    subKeys.push(subKey);
  }
  return subKeys;
}

/** 单块（64 位）加解密。`decrypt` 只是把子密钥倒过来用 —— 与 crypto-js 一致。 */
export function desCryptBlock(
  l: number,
  r: number,
  subKeys: number[][],
): [number, number] {
  let L = l >>> 0;
  let R = r >>> 0;

  const exLR = (off: number, mask: number): void => {
    const t = ((L >>> off) ^ R) & mask;
    R = (R ^ t) >>> 0;
    L = (L ^ (t << off)) >>> 0;
  };
  const exRL = (off: number, mask: number): void => {
    const t = ((R >>> off) ^ L) & mask;
    L = (L ^ t) >>> 0;
    R = (R ^ (t << off)) >>> 0;
  };

  // 初始置换（一串位交换）
  exLR(4, 0x0f0f0f0f);
  exLR(16, 0x0000ffff);
  exRL(2, 0x33333333);
  exRL(8, 0x00ff00ff);
  exLR(1, 0x55555555);

  for (let round = 0; round < 16; round += 1) {
    const sk = subKeys[round]!;
    let f = 0;
    for (let i = 0; i < 8; i += 1) {
      // ⚠ `& SBOX_MASK[i]` 的结果可能是负数（掩码最高位是 1），所以必须 `>>> 0`
      // 变成无符号 —— `SBOX_P` 的键是**无符号**值，用负数查会全部落空（查不到就是 0），
      // 而那样得到的是一份"结构完整但完全错"的密文
      const idx = ((R ^ sk[i]!) & SBOX_MASK[i]!) >>> 0;
      f |= SBOX_P[i]![idx] ?? 0;
    }
    const nl = R;
    const nr = (L ^ f) >>> 0;
    L = nl;
    R = nr;
  }

  // 撤掉最后一轮的交换
  const t = L;
  L = R;
  R = t;

  // 末端置换
  exLR(1, 0x55555555);
  exRL(8, 0x00ff00ff);
  exRL(2, 0x33333333);
  exLR(16, 0x0000ffff);
  exLR(4, 0x0f0f0f0f);

  return [L >>> 0, R >>> 0];
}

/** ECB 加密（零填充，逐块）。返回原始密文字节。 */
export function desEcbEncrypt(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 8) throw new Error(`DES: 密钥必须是 8 字节（得到 ${key.length}）`);
  const padded = zeroPadToBlock(msg, 8);
  // ⚠ 空明文 ⇒ 无块可加密 ⇒ 输出也是空（不是"一个全零块"）
  if (padded.length === 0) return new Uint8Array(0);
  const subKeys = desSubKeys(key);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 8) {
    const l = ((padded[off]! << 24) | (padded[off + 1]! << 16) | (padded[off + 2]! << 8) | padded[off + 3]!) >>> 0;
    const r = ((padded[off + 4]! << 24) | (padded[off + 5]! << 16) | (padded[off + 6]! << 8) | padded[off + 7]!) >>> 0;
    const [cl, cr] = desCryptBlock(l, r, subKeys);
    out[off] = (cl >>> 24) & 0xff;
    out[off + 1] = (cl >>> 16) & 0xff;
    out[off + 2] = (cl >>> 8) & 0xff;
    out[off + 3] = cl & 0xff;
    out[off + 4] = (cr >>> 24) & 0xff;
    out[off + 5] = (cr >>> 16) & 0xff;
    out[off + 6] = (cr >>> 8) & 0xff;
    out[off + 7] = cr & 0xff;
  }
  return out;
}

/** `des.rs::des_encrypt_b64` 的等价物：字符串 + 密钥 → base64 密文。 */
export function desEncryptBase64(message: string, key: string): string {
  const padded = zeroPadToBlock(utf8(message), 8);
  if (padded.length === 0) return ''; // 空明文 ⇒ 空串（照抄原实现）
  return toBase64(desEcbEncrypt(fitKey8(key), padded));
}
