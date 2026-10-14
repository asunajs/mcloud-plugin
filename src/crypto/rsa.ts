// RSA 加密（PKCS#1 v1.5）—— 只为 smid 那条链的 `ep` 一个用途。
//
// 权威源：`mcloud/crates/mcloud-crypto/src/rsa.rs`（`rsa_pkcs1v15_encrypt_base64_with_b64_key`）。
//
// ⚠ 为什么这里能用 `BigInt`：面板沙箱实测 `BigInt=function`（见 `GET /api/caps`）。
// 没有它就得手写大数模幂（几百行、极易写错）—— 那是另一件事，不是同一条路。
// 而公钥是 **1024 位**（不是 2048），`BigInt` 完全够用。
//
// ⚠ 为什么 `rng` 是**入参**而不是内部直接调 `Math.random()`：
// PKCS#1 v1.5 的填充含随机字节 ⇒ 输出**不可对拍**。把随机源变成入参之后，
// 「给定同一份随机，输出逐字节可复现」就成了一个**可测的断言** ——
// Rust 那边就是按这个可测性设计的（`smid.rs` 的 `ep(uid, rng)`）。

import { fromBase64, toBase64 } from './bytes.ts';

/** RSA 公钥的两个分量。`e` 通常是 65537。 */
export interface RsaPublicKey {
  n: bigint;
  e: bigint;
}

/** 取随机字节的函数（`n` 个）。生产传 `mcloud/rand.ts` 那个，测试传定值。 */
export type RngBytes = (n: number) => Uint8Array;

/** 读一个 DER 的 tag + length。
 *
 *  只实现 SPKI 里会出现的形态：单字节 tag、短长度、以及**长长度**（`0x82` 那种，
 *  1024 位模数必然用到 —— 长度超过 127 就得长形式）。 */
function derRead(buf: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = buf[at]!;
  let p = at + 1;
  let len = buf[p]!;
  p += 1;
  if ((len & 0x80) !== 0) {
    const nLenBytes = len & 0x7f;
    if (nLenBytes === 0 || nLenBytes > 4) {
      throw new Error(`RSA: 不支持的长度形式（0x80|${nLenBytes}）`);
    }
    len = 0;
    for (let i = 0; i < nLenBytes; i += 1) len = len * 256 + buf[p + i]!;
    p += nLenBytes;
  }
  return { tag, start: p, end: p + len };
}

/** 解析 base64 的 **SPKI** 公钥（`MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC…` 那个形状）。
 *
 *  结构：`SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }`
 *
 *  ⚠ 只认这一种形状，别的直接抛 —— 不要"尽力而为"地猜。
 *  猜错的表现是加密出一个**长度对但内容错**的串，而服务端只会回一句
 *  "参数错误"，看不出是解析错了。 */
export function parseSpkiRsaPublicKey(b64: string): RsaPublicKey {
  const der = fromBase64(b64);
  const outer = derRead(der, 0);
  if (outer.tag !== 0x30) throw new Error('RSA: SPKI 不是 SEQUENCE');
  // 跳过 AlgorithmIdentifier（它整段是外层里的第一个 SEQUENCE）
  const algo = derRead(der, outer.start);
  if (algo.tag !== 0x30) throw new Error('RSA: AlgorithmIdentifier 缺失');
  const bits = derRead(der, algo.end);
  if (bits.tag !== 0x03) throw new Error('RSA: BIT STRING 缺失');
  // BIT STRING 的首字节是"未用位数"，这里必然是 0
  if (der[bits.start] !== 0) throw new Error('RSA: BIT STRING 有未用位');
  const inner = derRead(der, bits.start + 1);
  if (inner.tag !== 0x30) throw new Error('RSA: 公钥不是 SEQUENCE');

  const intAt = (p: number): { v: bigint; next: number } => {
    const it = derRead(der, p);
    if (it.tag !== 0x02) throw new Error('RSA: 期望 INTEGER');
    let v = 0n;
    for (let i = it.start; i < it.end; i += 1) v = (v << 8n) | BigInt(der[i]!);
    return { v, next: it.end };
  };
  const nn = intAt(inner.start);
  const ee = intAt(nn.next);
  if (nn.v <= 0n || ee.v <= 0n) throw new Error('RSA: 公钥分量非正数');
  return { n: nn.v, e: ee.v };
}

/** `base^exp mod m`（平方-乘）。 */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** 大端字节 → BigInt。 */
function bytesToBig(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i += 1) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/** BigInt → 定长（`len` 字节）大端。**短了要左补零** —— 补不补决定长度对不对。 */
function bigToBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error(`RSA: 模幂结果装不进 ${len} 字节`);
  return out;
}

/** RSA PKCS#1 v1.5 加密：返回**定长**密文字节（= 模长）。
 *
 *  编码：`0x00 || 0x02 || PS(非零随机，长度 = k - mLen - 3) || 0x00 || M`
 *
 *  ⚠ `PS` 里的字节**必须非零**（标准要求），而"随便取随机字节"有 1/256 的概率取到 0 ——
 *  取到 0 的后果是**服务端解不出来**（回一句参数错误），而不是本地报错。
 *  所以这里重取而不是"凑合用"。 */
export function rsaEncryptPkcs1v15(
  key: RsaPublicKey,
  message: Uint8Array,
  rng: RngBytes,
): Uint8Array {
  const k = Math.ceil(key.n.toString(16).length / 2);
  if (message.length > k - 11) {
    throw new Error(`RSA: 明文太长（${message.length} > ${k - 11}）`);
  }
  const psLen = k - message.length - 3;
  const ps = new Uint8Array(psLen);
  let filled = 0;
  // ⚠ 取随机字节这件事有个**会挂死**的失败模式：随机源要是一直回 0（或坏掉），
  // 下面那个 while 永远填不满。所以给一个明确的上限 —— 挂死的表现是"任务不返回"，
  // 而面板那边只会看到一次超时，看不出是这里。
  let rounds = 0;
  // 一个字节一个字节地取，取到 0 就丢 —— 别为了"省一次调用"改成批量取再过滤，
  // 那样长度会变，而长度一变后面全是错的
  while (filled < psLen) {
    if ((rounds += 1) > 64) {
      throw new Error('RSA: 随机源像是坏了（连取 64 轮都填不满 PS，取到的几乎全是 0）');
    }
    const chunk = rng(Math.max(8, psLen - filled));
    for (let i = 0; i < chunk.length && filled < psLen; i += 1) {
      if (chunk[i] !== 0) {
        ps[filled] = chunk[i]!;
        filled += 1;
      }
    }
  }
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(message, 3 + psLen);

  const c = modPow(bytesToBig(em), key.e, key.n);
  return bigToBytes(c, k);
}

/** 便捷：base64 的 SPKI 公钥 + 明文 → base64 密文（API 要的形状）。 */
export function rsaEncryptBase64(publicKeyB64: string, message: Uint8Array, rng: RngBytes): string {
  return toBase64(rsaEncryptPkcs1v15(parseSpkiRsaPublicKey(publicKeyB64), message, rng));
}
