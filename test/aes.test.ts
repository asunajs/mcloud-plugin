// AES-128-CBC/PKCS7 —— 对着 **Node 的 openssl 实现** + **FIPS-197 官方向量**双重对拍。
//
// 为什么要双重：
//   · FIPS-197 那条是**单块**的已知答案（`69c4e0d8…`），它验的是"轮函数对不对"；
//   · Node 那条验的是**模式与填充对不对**（CBC 链接、PKCS7 补块）。
//   两个都过才算对 —— 只对得上其中一个，通常说明另一个地方错了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';

import {
  AES_FIXED_IV,
  aes128CbcEncrypt,
  aes128EncryptBlock,
  aes128KeyExpansion,
  aesEncryptCompatHex,
  fitKey16,
  pkcs7Pad,
} from '../src/crypto/aes.ts';
import { fromHex, toHex, utf8 } from '../src/crypto/bytes.ts';

function hexToBytes(h: string): Uint8Array {
  return fromHex(h);
}
function bytes(n: number, start = 0): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (start + i) & 0xff;
  return out;
}

test('FIPS-197 附录 B 的已知答案（单块，验轮函数）', () => {
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const pt = hexToBytes('00112233445566778899aabbccddeeff');
  const ct = aes128EncryptBlock(aes128KeyExpansion(key), pt);
  assert.equal(toHex(ct), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('FIPS-197 附录 A 的密钥扩展（第 1 与第 10 组）', () => {
  const rk = aes128KeyExpansion(hexToBytes('2b7e151628aed2a6abf7158809cf4f3c'));
  assert.equal(toHex(rk.subarray(0, 16)), '2b7e151628aed2a6abf7158809cf4f3c');
  assert.equal(toHex(rk.subarray(160, 176)), 'd014f9a8c9ee2589e13f0cc8b6630ca6');
});

test('**主线**：CBC + PKCS7 与 Node 的 aes-128-cbc 逐字节一致', () => {
  for (const key of ['0123456789abcdef', 'short', 'x', '']) {
    for (const msg of ['', 'a', '0123456789abcde', '0123456789abcdef', 'x'.repeat(100), '中文也走一遍']) {
      const k = fitKey16(key);
      const ours = aes128CbcEncrypt(k, AES_FIXED_IV, pkcs7Pad(utf8(msg), 16));
      const c = createCipheriv('aes-128-cbc', k, AES_FIXED_IV);
      const theirs = new Uint8Array(Buffer.concat([c.update(Buffer.from(utf8(msg))), c.final()]));
      assert.equal(toHex(ours), toHex(theirs), `key=${key} msg=${msg}`);
    }
  }
});

test('固定 IV 逐字是 `"0102030405060708"` 的 ASCII（不是 0x01 0x02…）', () => {
  // 抄成字节值 1,2,3… 是个很容易犯的错，而它只在"跟真实现对拍"时才暴露
  assert.equal(toHex(AES_FIXED_IV), '30313032303330343035303630373038');
});

test('`fit_key16`：截断到 16 字节、短了用 **\\0** 补齐', () => {
  assert.equal(toHex(fitKey16('0123456789abcdef')), toHex(utf8('0123456789abcdef')));
  assert.equal(toHex(fitKey16('0123456789abcdefEXTRA')), toHex(utf8('0123456789abcdef')), '超长要截断');
  assert.equal(
    toHex(fitKey16('abc')),
    '61626300000000000000000000000000',
    '短了补的是 NUL —— 补空格会得到一个长度对、内容错的密文',
  );
});

test('PKCS7：长度正好是块长整数倍时**仍要补一整块**', () => {
  assert.equal(pkcs7Pad(new Uint8Array(16), 16).length, 32, '不补整块 ⇒ 解出来会少字节');
  assert.equal(pkcs7Pad(new Uint8Array(15), 16).length, 16);
  assert.equal(pkcs7Pad(new Uint8Array(0), 16).length, 16);
  assert.equal(pkcs7Pad(new Uint8Array(0), 16)[15], 16, '填充值 = 补了几个字节');
});

test('`aesEncryptCompatHex`：输出是 hex、长度 = 补齐后字节数 × 2', () => {
  // 这一条对着 `aes.rs` 的 `aes_encrypt_compat` 契约（字符串进、hex 出）
  const out = aesEncryptCompatHex('0123456789abcdef', 'x');
  assert.match(out, /^[0-9a-f]{32}$/, '1 字节明文 ⇒ 补成 16 字节 ⇒ 32 个 hex 字符');
  // 64 字节正好是块长整数倍 ⇒ **仍要补一整块** ⇒ 80 字节 ⇒ 160 个 hex 字符。
  // （我第一版把这里写成 96 —— 错在"整数倍就不用补"的直觉上，而那条直觉
  //   正是上面 PKCS7 那条测试专门钉住的东西。）
  assert.equal(aesEncryptCompatHex('0123456789abcdef', 'x'.repeat(64)).length, 160);
});

test('同一输入两次结果一致（固定 IV ⇒ **确定性的**，没有随机在里面）', () => {
  assert.equal(
    aesEncryptCompatHex('0123456789abcdef', '特征体'),
    aesEncryptCompatHex('0123456789abcdef', '特征体'),
  );
});

test('参数不对要早失败：密钥长度、块长度、明文不是整数倍', () => {
  assert.throws(() => aes128KeyExpansion(new Uint8Array(15)), /16 字节/);
  assert.throws(() => aes128EncryptBlock(new Uint8Array(176), new Uint8Array(15)), /16 字节/);
  assert.throws(() => aes128CbcEncrypt(new Uint8Array(16), new Uint8Array(15), new Uint8Array(16)), /IV/);
  assert.throws(() => aes128CbcEncrypt(new Uint8Array(16), AES_FIXED_IV, new Uint8Array(17)), /整数倍/);
});

test('`bytes(n, start)` 那个小工具本身别写错（它被上面几条当输入用）', () => {
  assert.equal(toHex(bytes(4, 0xfe)), 'feff0001');
});
