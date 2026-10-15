// AES-128-CBC/PKCS7 —— 只为 smid 特征体那一步（`aes_encrypt_compat`）。
//
// 权威源：`mcloud/crates/mcloud-crypto/src/aes.rs`。逐字要点：
//
//   const AES_FIXED_IV = b"0102030405060708";   // ⚠ ASCII 数字，不是 0x01 0x02…
//   fit_key16(key) = key[0..16] 截断 + 用 **\0** 补齐（不是空格）
//   aes_cbc_encrypt(k, IV, msg)                 // CBC + **PKCS7**
//   hex::encode(ct)                             // ⚠ 输出 **hex**（DES 那边才是 base64）
//
// ⚠ 加密那半**生产链路才用**（smid 特征体上报，单向）。
// 解密那半是**登录链路**要的，两条独立的用途：
//
//   · `decryptWithDynamicIv` —— 滑块缺口坐标（`data.puzzleLeft` 是
//     `base64(IV ‖ AES-128-CBC/PKCS7 密文)`）。解出来就是答案，
//     **不需要图像识别**，也不需要人眼量像素。
//   · `aesEcbPkcs7DecryptHex` —— 登录成功响应里 `data` 的 `userInfo`。
//     注意它是 **ECB 不是 CBC**（客户端 `decryptByAes` 就是 ECB）；
//     模式用错的表现是"解出来是乱码"，而人往往把它当成"密钥不对"，白查半天。
//
// S 盒是**算出来的**，不是抄表：抄一张 256 字节的表，抄错一个字节的表现是
// "某个明文分段解出来是乱码"，而上游只会说参数错误。算出来的那份对着 FIPS-197
// 的已知向量验（同一套测试里）。

import { fromBase64, fromHex, fromUtf8, toBase64, toHex, utf8 } from './bytes.ts';

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

/** FIPS-197 **逆** S 盒：由正向 S 盒**求逆排列**得到，不抄第二张 256 字节的表。
 *
 *  抄表的风险与正向那张一样（抄错一个字节 ⇒ 某个分段解出来是乱码，
 *  而上游只会说"参数错误"）。求逆是 O(256)，且"确实是逆"这件事
 *  由 `INV_SBOX[SBOX[a]] === a` 这条断言钉住 —— 抄表钉不住。 */
export const INV_SBOX: Uint8Array = (() => {
  const inv = new Uint8Array(256);
  for (let a = 0; a < 256; a += 1) inv[SBOX[a]!] = a;
  return inv;
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

/** 单块解密（16 字节）。AES 的逆密码，与 [`aes128EncryptBlock`] 逐轮对称。
 *
 *  状态同样按**列主序**铺：`state[r][c] = in[r + 4c]`。 */
export function aes128DecryptBlock(rk: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error(`AES: 块必须是 16 字节（得到 ${block.length}）`);
  const s = new Uint8Array(block);

  const addRoundKey = (round: number): void => {
    for (let i = 0; i < 16; i += 1) s[i] = s[i]! ^ rk[round * 16 + i]!;
  };

  const invSubBytes = (): void => {
    for (let i = 0; i < 16; i += 1) s[i] = INV_SBOX[s[i]!]!;
  };

  // InvShiftRows：第 r 行循环**右**移 r 个（加密是左移）
  const invShiftRows = (): void => {
    for (let r = 1; r < 4; r += 1) {
      const row = [s[r]!, s[r + 4]!, s[r + 8]!, s[r + 12]!];
      for (let c = 0; c < 4; c += 1) s[r + 4 * c] = row[(c - r + 4) % 4]!;
    }
  };

  // InvMixColumns：矩阵是 [[14,11,13,9],[9,14,11,13],[13,9,14,11],[11,13,9,14]]
  const invMixColumns = (): void => {
    for (let c = 0; c < 4; c += 1) {
      const i = 4 * c;
      const a0 = s[i]!;
      const a1 = s[i + 1]!;
      const a2 = s[i + 2]!;
      const a3 = s[i + 3]!;
      s[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
      s[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
      s[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
      s[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
    }
  };

  addRoundKey(10);
  for (let round = 9; round >= 1; round -= 1) {
    invShiftRows();
    invSubBytes();
    addRoundKey(round);
    invMixColumns();
  }
  invShiftRows();
  invSubBytes();
  addRoundKey(0);
  return s;
}

/** PKCS7 去填充。**带校验**：最后那个字节必须是 1..16，且那一段必须全是它。
 *
 *  ⚠ 不校验的写法（"取最后一个字节当长度，砍掉就行"）在密钥错的时候
 *  会静默返回一段截断的垃圾 —— 而调用方看到的是"解出来是乱码"，
 *  于是去查密钥，实际上错的是模式或密钥，本来就该报错。
 *  这里宁可报错：**错的填充几乎一定意味着密钥/模式不对**。 */
export function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error(`AES: 密文长度不是 16 的整数倍（得到 ${data.length}）`);
  }
  const pad = data[data.length - 1]!;
  if (pad < 1 || pad > 16) throw new Error(`AES: PKCS7 填充长度非法（${pad}）`);
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) throw new Error('AES: PKCS7 填充字节不一致（密钥或模式不对）');
  }
  return data.subarray(0, data.length - pad);
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

/** CBC 解密（无去填充，调用方自己处理）。 */
export function aes128CbcDecrypt(key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error('AES: IV 必须是 16 字节');
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new Error(`AES: 密文必须是 16 的整数倍（得到 ${ct.length}）`);
  }
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(ct.length);
  let prev: Uint8Array = new Uint8Array(iv);
  for (let off = 0; off < ct.length; off += 16) {
    const blk = ct.subarray(off, off + 16);
    const plain = aes128DecryptBlock(rk, blk);
    for (let i = 0; i < 16; i += 1) out[off + i] = plain[i]! ^ prev[i]!;
    prev = new Uint8Array(blk); // ⚠ 用**密文**块做下一轮的链接，不是明文
  }
  return out;
}

/** ECB 解密（逐块、无链接）。ECB 是**上游协议规定的**形态，不是我们的选择。 */
export function aes128EcbDecrypt(key: Uint8Array, ct: Uint8Array): Uint8Array {
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new Error(`AES: 密文必须是 16 的整数倍（得到 ${ct.length}）`);
  }
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(ct.length);
  for (let off = 0; off < ct.length; off += 16) {
    out.set(aes128DecryptBlock(rk, ct.subarray(off, off + 16)), off);
  }
  return out;
}

/** ECB 加密（逐块、无链接），PKCS7 填充。
 *
 *  ⚠ ECB 是**上游协议规定的**形态，不是我们的选择 —— 手机端登录体就是这么发的
 *  （见 `mcloud/appLogin.ts`）。ECB 本身"相同明文块 → 相同密文块"的弱点在这里
 *  无所谓：这个请求体只发一次，而且本来就不是保密用途，是**编码**。
 *
 *  加它是为了手机端登录（`Basic base64("mobile:…")` 那条链路）—— 原来这一层
 *  只有解密，因为 PC 端登录体是明文 JSON。 */
export function aes128EcbEncrypt(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const rk = aes128KeyExpansion(key);
  const padded = pkcs7Pad(msg, 16);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    out.set(aes128EncryptBlock(rk, padded.subarray(off, off + 16)), off);
  }
  return out;
}

/** `aes128EcbEncrypt` 的 hex 形态（手机端登录体就是 hex 字符串）。 */
export function aesEcbPkcs7EncryptHex(key: string, message: string): string {
  return toHex(aes128EcbEncrypt(fitKey16(key), utf8(message)));
}

/** 动态 IV 加密：输出 `base64(IV ‖ 密文)`。
 *
 *  IV 在**明文里带着**，所以解密方不需要事先知道它 —— 这是协议的选择，
 *  不是"IV 复用"那种错（每次调用方给的 IV 是固定常量，见 PUZZLE_AES_IV）。 */
export function encryptWithDynamicIv(key: Uint8Array, iv: Uint8Array, plaintext: string): string {
  const ct = aes128CbcEncrypt(key, iv, pkcs7Pad(utf8(plaintext), 16));
  const joined = new Uint8Array(16 + ct.length);
  joined.set(iv);
  joined.set(ct, 16);
  return toBase64(joined);
}

/** 动态 IV 解密，输入为 `base64(IV ‖ 密文)`。
 *
 *  ⚠ `raw.length < 32` 直接判非法：至少 IV + 一个块，否则不可能是合法密文。
 *  不判的话，短输入会走到 `subarray` 拿到空块，报的错就变成
 *  "密文长度不是 16 的整数倍（得到 0）" —— 离真正的原因（输入根本不是密文）很远。 */
export function decryptWithDynamicIv(key: Uint8Array, payloadB64: string): string {
  const raw = fromBase64(payloadB64);
  if (raw.length < 32) throw new Error('AES: 动态 IV 载荷太短（至少 IV + 一个块）');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  return fromUtf8(pkcs7Unpad(aes128CbcDecrypt(key, iv, ct)));
}

/** AES-128-ECB/PKCS7 解密，输入是 **hex 字符串**（不是 base64）。
 *
 *  ⚠ 与上面的 CBC 路径**模式不同**，不能互相替代 —— 用错了表现为
 *  "解出来是乱码"，而调用方往往会把它当成"密钥不对"。 */
export function aesEcbPkcs7DecryptHex(key: string, ciphertextHex: string): string {
  const ct = fromHex(ciphertextHex.trim());
  return fromUtf8(pkcs7Unpad(aes128EcbDecrypt(fitKey16(key), ct)));
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
