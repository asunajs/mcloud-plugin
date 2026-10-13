// 密码学这一层的测试 —— 用的是「两个独立信源」而不是一个：
//
//   ① 公开测试向量（RFC 1321 / FIPS 180-4 里的那几串）：硬编码在测试里，
//      不依赖任何库。写错一个常量，这几条先炸。
//   ② 对 Node 内置 crypto 的**逐用例比对**：长度覆盖补位边界
//      （55/56/63/64/119/120/128），内容覆盖 UTF-8（中文、emoji 代理对）、
//      全零、随机字节。
//
// 为什么这么较真：哈希写错的表现是「上游回一个签名错误」，在真机上排查这个
// 会浪费掉一整晚 —— 而在这里只要一秒。插件里没有 crypto，所以这一层只能自己扛。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  fromBase64,
  fromHex,
  fromUtf8,
  hmacMd5,
  hmacSha1,
  hmacSha256,
  md5,
  md5Hex,
  padBE,
  padLE,
  sha1,
  sha1Hex,
  sha256,
  sha256Hex,
  toBase64,
  toHex,
  utf8,
} from '../src/crypto/index.ts';

const nodeHex = (algo: string, data: Uint8Array) => createHash(algo).update(data).digest('hex');

const enc = (s: string) => new TextEncoder().encode(s);

/** 确定性伪随机（不依赖随机种子，失败可复现） */
function lcgBytes(n: number, seed = 12345): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

test('公开测试向量（不依赖 Node 的独立信源）', () => {
  // RFC 1321 附录 A.5
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(
    md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );
  // FIPS 180-4
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  // UTF-8 中文：这里**不硬编码**摘要值（我背不出「中文」的 sha256，
  // 编一个出来只会污染测试），让 Node 当裁判；真正独立核验的是上面那几条公开向量
  assert.equal(sha256Hex('中文'), nodeHex('sha256', enc('中文')));
  assert.equal(md5Hex('中文'), nodeHex('md5', enc('中文')));
});

test('补位边界：55/56/63/64/119/120/128 逐个对 Node', () => {
  // 这几个长度是补位最容易错的地方（长度字段要不要多开一个块）
  for (const n of [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 127, 128, 129, 1000]) {
    const data = lcgBytes(n);
    assert.equal(toHex(md5(data)), nodeHex('md5', data), `md5 @${n}`);
    assert.equal(toHex(sha1(data)), nodeHex('sha1', data), `sha1 @${n}`);
    assert.equal(toHex(sha256(data)), nodeHex('sha256', data), `sha256 @${n}`);
  }
});

test('补位函数的形状：长度是 64 的倍数，尾部是长度字段', () => {
  for (const n of [0, 55, 56, 64, 65, 128]) {
    const p = padLE(lcgBytes(n));
    assert.equal(p.length % 64, 0);
    assert.ok(p.length > n + 8, `@${n} 至少要留出 1 字节 0x80 和 8 字节长度`);
    assert.equal(p[n], 0x80);
    const q = padBE(lcgBytes(n));
    assert.equal(q.length, p.length, '两种端序的补位长度应当一致');
    assert.equal(q[n], 0x80);
  }
});

test('UTF-8 与 Node/TextEncoder 逐字节一致（含代理对与孤立代理）', () => {
  const cases = [
    '',
    'ascii',
    '中文测试',
    '🎉 emoji 与中文混排',
    'ﬁ ligature',
    '\u0000\u007f\u0080\u07ff\u0800\uffff\ufffe',
    'a'.repeat(200),
    // 孤立的代理项：规范要求替换成 U+FFFD
    '\ud800',
    'x\udc00y',
    '\ud83c',  // 半个 emoji
  ];
  for (const s of cases) {
    assert.deepEqual(Array.from(utf8(s)), Array.from(enc(s)), `utf8(${JSON.stringify(s)})`);
    assert.equal(fromUtf8(utf8(s)), new TextDecoder().decode(enc(s)), `roundtrip(${JSON.stringify(s)})`);
  }
  // 往返：随机字节里合法 UTF-8 的部分不保证，所以只测「编码→解码→再编码」稳定
  const b = lcgBytes(256);
  assert.deepEqual(Array.from(utf8(fromUtf8(b))), Array.from(utf8(new TextDecoder().decode(b))));
});

test('hex / base64 与 Node 一致', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33, 100]) {
    const b = lcgBytes(n, 999);
    assert.equal(toHex(b), Buffer.from(b).toString('hex'), `hex @${n}`);
    assert.equal(toBase64(b), Buffer.from(b).toString('base64'), `base64 @${n}`);
    assert.deepEqual(Array.from(fromHex(toHex(b))), Array.from(b), `fromHex @${n}`);
    assert.deepEqual(Array.from(fromBase64(toBase64(b))), Array.from(b), `fromBase64 @${n}`);
  }
  // 宽容解码：上游有时会带换行/空白（MIME base64）
  const wrapped = 'aGVsbG8s\nIHdvcmxk\n';
  assert.equal(fromUtf8(fromBase64(wrapped)), 'hello, world');
});

test('HMAC 对 Node 一致：密钥长度跨过块长 64', () => {
  const msg = utf8('the quick brown fox jumps over the lazy dog');
  for (const keyLen of [0, 1, 16, 32, 63, 64, 65, 100, 200]) {
    const key = lcgBytes(keyLen, 7);
    assert.equal(
      toHex(hmacMd5(key, msg)),
      createHmac('md5', key).update(msg).digest('hex'),
      `hmac-md5 @key=${keyLen}`,
    );
    assert.equal(
      toHex(hmacSha1(key, msg)),
      createHmac('sha1', key).update(msg).digest('hex'),
      `hmac-sha1 @key=${keyLen}`,
    );
    assert.equal(
      toHex(hmacSha256(key, msg)),
      createHmac('sha256', key).update(msg).digest('hex'),
      `hmac-sha256 @key=${keyLen}`,
    );
  }
});

test('随机字节也能对上（每次跑 64 组）', () => {
  for (let i = 0; i < 64; i += 1) {
    const data = randomBytes(1 + ((i * 37) % 300));
    assert.equal(toHex(md5(data)), nodeHex('md5', data));
    assert.equal(toHex(sha1(data)), nodeHex('sha1', data));
    assert.equal(toHex(sha256(data)), nodeHex('sha256', data));
  }
});
