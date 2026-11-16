// DES-ECB（零填充）—— 双重验收：**FIPS 已知答案** + **crypto-js 的黄金向量**。
//
// 为什么两个都要：
//   · FIPS 那条验的是**算法本身**（轮函数、置换、密钥编排）对不对；
//   · 黄金向量验的是**契约**（密钥截断补 \0、明文零填充、ECB、base64）对不对 ——
//     算法对而契约错，产出的是"能解开但内容不是那个"的密文。
//
// 黄金向量是用 `crypto-js` 现算的（`mcloud-sign` 用的就是它），
// 而 crypto-js 自己也对上了 FIPS 向量 ⇒ 两者同源可信。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  desCryptBlock,
  desDecryptBase64,
  desEcbEncrypt,
  desEncryptBase64,
  desSubKeys,
  fitKey8,
  zeroPadToBlock,
} from '../src/crypto/des.ts';
import { fromBase64, fromHex, toHex, utf8 } from '../src/crypto/bytes.ts';

test('FIPS 已知答案：key=133457799bbcdff1 / plain=0123456789abcdef ⇒ 85e813540f0ab405', async () => {
  const key = fromHex('133457799bbcdff1');
  const pt = fromHex('0123456789abcdef');
  const l = ((pt[0]! << 24) | (pt[1]! << 16) | (pt[2]! << 8) | pt[3]!) >>> 0;
  const r = ((pt[4]! << 24) | (pt[5]! << 16) | (pt[6]! << 8) | pt[7]!) >>> 0;
  const [cl, cr] = desCryptBlock(l, r, desSubKeys(key));
  const hex =
    cl.toString(16).padStart(8, '0') + cr.toString(16).padStart(8, '0');
  assert.equal(hex, '85e813540f0ab405');
});

test('**黄金向量**：与 crypto-js 的 DES/ECB/NoPadding 逐条一致', async () => {
  // 现算自 crypto-js（同一份输入的输出），契约 = mcloud 的 `des_encrypt_b64`
  const cases: [string, string, string][] = [
    ['v', 'a9kbown8', 'qbl5L2OIDpM='],
    ['hello world', 'a9kbown8', '3jMyM6IpThFvUzLXCA4sVA=='],
    ['0123456789abcdef', 'llj8yd1x', 'ZtzsBiRgkvYb0hYrnfp0+A=='],
    ['xxxxxxxxxxxxxxxxxxxxxxx', 'f1zlae4b', 'XSngPy8+vRRdKeA/Lz69FM3dkyN14gdj'],
    ['', 'a9kbown8', ''],
    ['Mozilla/5.0 (Linux; Android 14)', 'a9kbown8', '9fiPgZkIaK2kt5Jmzfev6x3g2t1VX2Ih7a+RAJpmmQA='],
    ['0_0_0_0_390_844_390_844', 'a9kbown8', 'OZ5ZT5LA0fmGHZAwSnn6LpZoyGHvEF3V'],
  ];
  for (const [msg, key, want] of cases) {
    assert.equal(desEncryptBase64(msg, key), want, `msg=${msg} key=${key}`);
  }
});

test('⚠ 非 ASCII：**照 Rust 按字节补**，与 mcloud-sign 的 TS 版**故意不一致**', async () => {
  // 这条分歧是真发现，不是我们抄错：
  //
  //   `des.rs`          pad_zero_to_block(message.**as_bytes()**)  ← 按**字节**补到 8 的倍数
  //   `smid/index.ts`   pad8(String(message))                      ← 按**字符**补
  //
  // ASCII 下两者等价（所以线上一直没暴露）；非 ASCII 下 TS 那份会补出一个
  // **不是 8 的倍数**的字节长度（`中文也走一遍`：6 字符 = 18 字节 ⇒ 补 2 个 \0 ⇒ 20 字节），
  // 而 CryptoJS 的 NoPadding 会照单收下 —— 它不会报错，只会给出一个
  // 块数都不整的结果。Rust 那边补成 24 字节，是对的。
  //
  // 我们照 **Rust**（它才是权威实现），所以这一条的期望值来自我们自己的口径，
  // 而**不是** crypto-js 那条黄金向量。⚠ 别"顺手改成跟 crypto-js 一致"。
  const s = '中文也走一遍';
  assert.equal(utf8(s).length, 18, '6 个字符 = 18 字节');
  assert.equal(zeroPadToBlock(utf8(s), 8).length, 24, '按字节补到 8 的倍数');
  // mcloud-sign 的口径会补成 20 字节（不是 8 的倍数）—— 这里把它算出来钉住
  const byChar = s + '\0'.repeat(8 - (s.length % 8));
  assert.equal(utf8(byChar).length, 20, '按字符补 ⇒ 20 字节，块都不整');
  assert.equal(desEncryptBase64(s, 'bewicpxu'), 'RSMrad5srdCSTnwkESxxYqtza7qmIO+I');
});

test('零填充：长度是 8 的整数倍时**不补**（与 AES 的 PKCS7 相反）', async () => {
  assert.equal(zeroPadToBlock(new Uint8Array(8), 8).length, 8, '补了就会多出一整块 0');
  assert.equal(zeroPadToBlock(new Uint8Array(16), 8).length, 16);
  assert.equal(zeroPadToBlock(new Uint8Array(9), 8).length, 16);
  assert.equal(zeroPadToBlock(new Uint8Array(0), 8).length, 0);
  // 上面那条黄金向量里 `0123456789abcdef`（16 字节）⇒ 密文也是 16 字节 ⇒ base64 24 字符
  assert.equal(fromBase64('ZtzsBiRgkvYb0hYrnfp0+A==').length, 16);
});

test('空明文 ⇒ 空串（原实现如此：无块可加密，不是错误也不是全零块）', async () => {
  assert.equal(desEncryptBase64('', 'a9kbown8'), '');
  assert.equal(desEcbEncrypt(fitKey8('a9kbown8'), new Uint8Array(0)).length, 0);
});

test('`fit_key8`：截断到 8 字节、短了用 **\\0** 补齐', async () => {
  assert.equal(toHex(fitKey8('a9kbown8')), toHex(utf8('a9kbown8')));
  assert.equal(toHex(fitKey8('a9kbown8EXTRA')), toHex(utf8('a9kbown8')), '超长截断');
  assert.equal(toHex(fitKey8('ab')), '6162000000000000', '短了补 NUL');
});

test('输出是 **base64**（不是 hex —— AES 那边才是 hex）', async () => {
  const out = desEncryptBase64('v', 'a9kbown8');
  assert.match(out, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(out.length % 4, 0);
  assert.equal(fromBase64(out).length, 8, '8 字节明文 ⇒ 8 字节密文');
});

test('同一输入两次结果一致（ECB 无 IV、无随机）', async () => {
  assert.equal(desEncryptBase64('abc', 'a9kbown8'), desEncryptBase64('abc', 'a9kbown8'));
});

test('密钥长度不对要早失败', async () => {
  assert.throws(() => desEcbEncrypt(new Uint8Array(7), utf8('x')), /8 字节/);
  assert.throws(() => desEcbEncrypt(new Uint8Array(9), utf8('x')), /8 字节/);
});

test('逐块独立：多块密文 = 各块单独加密的拼接（ECB 的定义）', async () => {
  const key = fitKey8('a9kbown8');
  const two = desEcbEncrypt(key, utf8('0123456789abcdef'));
  const first = desEcbEncrypt(key, utf8('01234567'));
  const second = desEcbEncrypt(key, utf8('89abcdef'));
  assert.equal(toHex(two), toHex(first) + toHex(second));
});

test('⚠ 解密要**去掉 PKCS#5 填充**（AI 域的 Authorization 就靠这一格）', async () => {
  // 现场 2026-11-01：`disk:queryUserToken` 的 `account` 解出来是
  // `13700137001\x05\x05\x05\x05\x05`，多出来的五个 0x05 被拼进
  // `Basic mobile:<手机号>:<token>` ⇒ 服务端回 `01000002 鉴权失败`，
  // 609/1057 两条 AI 对话全挂在这。参考实现按"最后一个字节给长度"去填充。
  const key = '139_mail';
  const plain = '13700137001';
  const padLen = 8 - (plain.length % 8); // 11 → 5
  const padded = plain + String.fromCharCode(padLen).repeat(padLen);
  const b64 = desEncryptBase64(padded, key);
  assert.equal(desDecryptBase64(b64, key), plain, '填充必须去掉');
  // 没带填充的串也要照常解（不能把正常的尾巴误砍成填充）
  assert.equal(desDecryptBase64(desEncryptBase64('abc', key), key).slice(0, 3), 'abc');
});
