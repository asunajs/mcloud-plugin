// RSA PKCS#1 v1.5 —— 对着 **Node 的 openssl 实现**对拍。
//
// 这类原语的错误有个共同特征：**本地看不出来**。模幂写错、填充少一个字节、
// 定长没补零 —— 全都会产出一个"长度对、内容错"的串，而上游只会回一句
// "参数错误"。所以这里不测"跟我自己算的一样"，而是：
//
//   造一对临时钥匙 → 用本模块加密 → **用 Node 的私钥解出来** → 对拍明文
//
// 这一步把"模幂对不对""填充对不对""SPKI 解析对不对"三件事一次验掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';

import {
  modPow,
  parseSpkiRsaPublicKey,
  rsaEncryptBase64,
  rsaEncryptPkcs1v15,
} from '../src/crypto/rsa.ts';
import { fromBase64, utf8 } from '../src/crypto/bytes.ts';

/** 生产用的那个随机源在 `mcloud/rand.ts`；测试里用一个可复现的伪随机。 */
function fixedRng(seed: number) {
  let s = seed >>> 0;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      s = (s * 1664525 + 1013904223) >>> 0;
      // ⚠ 避开 0：PS 里不允许 0，而"随机取到 0"会让实现多转一轮 ——
      // 测试里要的是可复现，不是去碰那个分支
      out[i] = ((s >>> 24) & 0xff) || 1;
    }
    return out;
  };
}

test('modPow：小值对照（含 exp=0、底数大于模数）', () => {
  assert.equal(modPow(2n, 10n, 1000n), 24n); // 1024 % 1000
  assert.equal(modPow(7n, 0n, 13n), 1n); // 任何数的 0 次方是 1
  assert.equal(modPow(12345n, 3n, 97n), 12345n ** 3n % 97n);
  assert.equal(modPow(5n, 3n, 3n), 2n, '底数要先取模');
});

test('SPKI 解析：认得出 1024 位公钥，且 e 是 65537', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const key = parseSpkiRsaPublicKey(spki.toString('base64'));
  assert.equal(key.e, 65537n, 'e 不是 65537 ⇒ 解析串位了');
  assert.equal(key.n.toString(2).length, 1024, '模长不是 1024 位');
});

test('**主线**：本模块加密 → Node 的私钥解出来 = 原文', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const b64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');

  for (const msg of ['v', 'hello world', 'B'.repeat(117), '中文也走一遍']) {
    const ct = rsaEncryptBase64(b64, utf8(msg), fixedRng(0x1234));
    const back = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(fromBase64(ct)),
    );
    assert.equal(back.toString('utf8'), msg, `明文对不上：${msg}`);
  }
});

test('密文长度 = 模长（1024 位 ⇒ 128 字节）；补零漏了这里就不齐', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const b64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  const ct = rsaEncryptBase64(b64, utf8('v'), fixedRng(7));
  assert.equal(fromBase64(ct).length, 128);
});

test('给定同一份随机 ⇒ 输出**逐字节可复现**（这就是 rng 做成入参换来的东西）', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const b64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  const a = rsaEncryptBase64(b64, utf8('v'), fixedRng(99));
  const b = rsaEncryptBase64(b64, utf8('v'), fixedRng(99));
  assert.equal(a, b);
  // 换一份随机 ⇒ 必须不一样（否则说明随机根本没进填充，而那样**每次密文相同**，
  // 是个会被上游当成重放的特征）
  assert.notEqual(a, rsaEncryptBase64(b64, utf8('v'), fixedRng(100)));
});

test('明文过长要**早失败**，不能悄悄截断', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const key = parseSpkiRsaPublicKey(
    (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  );
  assert.throws(() => rsaEncryptPkcs1v15(key, new Uint8Array(118), fixedRng(1)), /太长/);
  // 117 = 128 - 11，正好是上限 ⇒ 必须能过
  assert.equal(rsaEncryptPkcs1v15(key, new Uint8Array(117), fixedRng(1)).length, 128);
});

test('随机源坏掉（一直回 0）⇒ **抛错**，不能挂死', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const key = parseSpkiRsaPublicKey(
    (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  );
  const zeroRng = (n: number) => new Uint8Array(n);
  assert.throws(() => rsaEncryptPkcs1v15(key, utf8('v'), zeroRng), /随机源/);
});

test('不是 SPKI 的输入要直接抛（别"尽力而为"地猜）', () => {
  assert.throws(() => parseSpkiRsaPublicKey('AAAA'));
  assert.throws(() => parseSpkiRsaPublicKey(''));
});

test('**真公钥**（mcloud 那个 SKLAND_PUBLIC_KEY_B64）解析得出、且是 1024 位', () => {
  // 逐字来自 mcloud/crates/mcloud-crypto/src/lib.rs:49
  const REAL =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8KHAcHbkCn5rxGgGJE+07tY+pt86D/oZ7sA51FaEBv2jgno2TI9zHJVYKJynmiKpixgwUcv93EfWIrU/p/UCs5Vu+odS3I4UBp3R7IZ1A0W01FkumAHYW2PQpMm8ueQKPLUq/idkpG/9b2JDv/qU+Ks36nbUPwlW4CjdfrV+V9QIDAQAB';
  const k = parseSpkiRsaPublicKey(REAL);
  assert.equal(k.e, 65537n);
  assert.equal(k.n.toString(2).length, 1024);
  // 明文 `uid` 是个 36 字符的 uuid ⇒ 远小于 117 的上限
  assert.equal(rsaEncryptBase64(REAL, utf8('8-4-4-4-12 uuid 的形状就这么长'), fixedRng(3)).length, 172,
    '1024 位 ⇒ 128 字节 ⇒ base64 172 字符');
});
