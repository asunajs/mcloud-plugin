// 纯 JS 密码学。
//
// 为什么自己写：面板的插件沙箱里**没有 crypto**（没有 Node、没有 WebCrypto），
// 而 mcloud 调上游要签名。两条路里选了「自带」：插件自包含、Node/CPython 适配器也能跑
// 同一份代码、面板零改动。代价是要自己测 —— 见 test/crypto.test.ts
// （对着 Node 的 crypto 逐用例比对 + 公开测试向量双重校验）。
//
// 只用 32 位整数运算，不用 BigInt：QuickJS 里 BigInt 能用，但没必要赌。

export { utf8, fromUtf8, toHex, fromHex, toBase64, fromBase64 } from './bytes.ts';
export { md5, padLE } from './md5.ts';
export { sha1, padBE } from './sha1.ts';
export { sha256 } from './sha256.ts';
export {
  hmac,
  hmacMd5,
  hmacSha1,
  hmacSha256,
  md5Hex,
  sha1Hex,
  sha256Hex,
  hmacSha256Hex,
} from './hmac.ts';
export type { HashFn } from './hmac.ts';
