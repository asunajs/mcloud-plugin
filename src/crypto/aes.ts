// AES-128-CBC/PKCS7 —— 只为 smid 特征体那一步（`aes_encrypt_compat`）。
//
// 权威源：`mcloud/crates/mcloud-crypto/src/aes.rs`。逐字要点：
//
//   const AES_FIXED_IV = b"0102030405060708";   // ⚠ ASCII 数字，不是 0x01 0x02…
//   fit_key16(key) = key[0..16] 截断 + 用 **\0** 补齐（不是空格）
//   aes_cbc_encrypt(k, IV, msg)                 // CBC + **PKCS7**
//   hex::encode(ct)                             // ⚠ 输出 **hex**（DES 那边才是 base64）
//
// ⚠ 这一层**没有解密**：生产链路不需要（上报是单向的）。
// mcloud 那边留了一份解密只是为了它的测试能证明"发出去的那一份里装的确实是特征"——
// 我们这边的等价物是**对着 Node 的 openssl 对拍**（见 test/aes.test.ts）。
//
// S 盒是**算出来的**，不是抄表：抄一张 256 字节的表，抄错一个字节的表现是
// "某个明文分段解出来是乱码"，而上游只会说参数错误。算出来的那份对着 FIPS-197
// 的已知向量验（同一套测试里）。

import { toHex, utf8 } from './bytes.ts';

/** GF(2^8) 乘法（`aes` 素数 0x11b）。 */
function gfMul(a: number, b: number): number {
  let r = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  while (y > 0) {
    if (y & 1) r ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return r & 0xff;
}

function rotl8(x: number, n: number): number {
  return ((x << n) | (x >> (8 - n))) & 0xff;
}

/** FIPS-197 S 盒：先求 GF(2^8) 逆元（`x^254`），再做仿射变换。 */
const SBOX: Uint8Array = (() => {
  const s = new Uint8Array(256);
  for (let a = 0; a < 256; a += 1) {
    let inv = 0;
    if (a !== 0) {
      let r = 1;
      let b = a;
      let e = 254;
      while (e > 0) {
        if (e & 1) r = gfMul(r, b);
        b = gfMul(b, b);
        e >>= 1;
      }
      inv = r;
    }
    s[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
  }
  return s;
})();

/** 复刻 `key.substring(0, 16).padEnd(16, "\0")`。 */
export function fitKey16(key: string): Uint8Array {
  const out = new Uint8Array(16);
  // ⚠ 按**字节**截，不是按字符 —— 密钥是 ASCII（`md5` 的前 16 个 hex），
  // 但按字符截在遇到非 ASCII 时会产出不同的字节序列
  // ⚠ 用本仓自己的 `utf8`，**不是** `TextEncoder` —— 沙箱里没有那个东西
  // （`main.ts` 的文件头写着；用它的表现是运行时 `TextEncoder is not defined`）
  const src = utf8(key);
  out.set(src.subarray(0, 16));
  return out;
}

/** AES-128 轮密钥：11 组 × 16 字节 = 176 字节。 */
export function aes128KeyExpansion(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error(`AES: 密钥必须是 16 字节（得到 ${key.length}）`);
  const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 4; i < 44; i += 1) {
    let t0 = w[(i - 1) * 4]!;
    let t1 = w[(i - 1) * 4 + 1]!;
    let t2 = w[(i - 1) * 4 + 2]!;
    let t3 = w[(i - 1) * 4 + 3]!;
    if (i % 4 === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0;
      t0 = SBOX[t1]! ^ RCON[i / 4 - 1]!;
      t1 = SBOX[t2]!;
      t2 = SBOX[t3]!;
      t3 = SBOX[tmp]!;
    }
    const p = (i - 4) * 4;
    w[i * 4] = w[p]! ^ t0;
    w[i * 4 + 1] = w[p + 1]! ^ t1;
    w[i * 4 + 2] = w[p + 2]! ^ t2;
    w[i * 4 + 3] = w[p + 3]! ^ t3;
  }
  return w;
}

/** 单块加密（16 字节）。状态按**列主序**铺：`state[r][c] = in[r + 4c]`。 */
export function aes128EncryptBlock(rk: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error(`AES: 块必须是 16 字节（得到 ${block.length}）`);
  const s = new Uint8Array(block);

  const addRoundKey = (round: number): void => {
    for (let i = 0; i < 16; i += 1) s[i] = s[i]! ^ rk[round * 16 + i]!;
  };

  const subBytes = (): void => {
    for (let i = 0; i < 16; i += 1) s[i] = SBOX[s[i]!]!;
  };

  // ShiftRows：第 r 行循环左移 r 个（行 r 的四个字节在 i = r, r+4, r+8, r+12）
  const shiftRows = (): void => {
    for (let r = 1; r < 4; r += 1) {
      const row = [s[r]!, s[r + 4]!, s[r + 8]!, s[r + 12]!];
      for (let c = 0; c < 4; c += 1) s[r + 4 * c] = row[(c + r) % 4]!;
    }
  };

  const mixColumns = (): void => {
    for (let c = 0; c < 4; c += 1) {
      const i = 4 * c;
      const a0 = s[i]!;
      const a1 = s[i + 1]!;
      const a2 = s[i + 2]!;
      const a3 = s[i + 3]!;
      s[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
      s[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
      s[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
      s[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
    }
  };

  addRoundKey(0);
  for (let round = 1; round <= 9; round += 1) {
    subBytes();
    shiftRows();
    mixColumns();
    addRoundKey(round);
  }
  subBytes();
  shiftRows();
  addRoundKey(10);
  return s;
}

/** PKCS7 填充（**这是 AES 那条路的填充**；DES 那边是零填充，别抄混）。
 *
 *  ⚠ 明文长度正好是块长整数倍时，**仍然要补一整块**（值 = 块长）。
 *  "看着够了就不补"是最常见的错法，而它的表现是最后一块解出来少几个字节。 */
export function pkcs7Pad(msg: Uint8Array, blockSize: number): Uint8Array {
  const pad = blockSize - (msg.length % blockSize);
  const out = new Uint8Array(msg.length + pad);
  out.set(msg);
  out.fill(pad, msg.length);
  return out;
}

/** CBC 加密（无填充，调用方自己补）。 */
export function aes128CbcEncrypt(key: Uint8Array, iv: Uint8Array, msg: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error('AES: IV 必须是 16 字节');
  if (msg.length % 16 !== 0) throw new Error(`AES: 明文必须是 16 的整数倍（得到 ${msg.length}）`);
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(msg.length);
  let prev: Uint8Array = new Uint8Array(iv);
  for (let off = 0; off < msg.length; off += 16) {
    const blk = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) blk[i] = msg[off + i]! ^ prev[i]!;
    prev = aes128EncryptBlock(rk, blk);
    out.set(prev, off);
  }
  return out;
}

/** 固定 IV —— 逐字照抄 `AES_FIXED_IV`（ASCII 的 `"0102030405060708"`）。 */
export const AES_FIXED_IV: Uint8Array = (() => {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = '0102030405060708'.charCodeAt(i);
  return out;
})();

/** `aes.rs::aes_encrypt_compat` 的等价物：字符串 → **hex 密文**。 */
export function aesEncryptCompatHex(key: string, message: string): string {
  const padded = pkcs7Pad(utf8(message), 16);
  return toHex(aes128CbcEncrypt(fitKey16(key), AES_FIXED_IV, padded));
}
