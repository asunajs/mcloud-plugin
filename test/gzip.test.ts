// gzip（stored 块）—— 对着 **Node 的 zlib** 验：解回来必须逐字节等于原文。
//
// 这一段之所以能用这么强的断言，正是因为**刻意不做压缩**：
// 一旦真压缩，"跟 mcloud 的输出逐字节比"就永远用不了了
// （同一份数据有很多种合法 DEFLATE 流）。stored 块把那个不可比的问题消掉了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { GZIP_OS, crc32, deflateStored, gzipWithOs19, gzipWithOs19Base64 } from '../src/crypto/gzip.ts';
import { fromBase64, toHex, utf8 } from '../src/crypto/bytes.ts';

test('CRC32 与 zlib 同口径（几个已知值）', () => {
  assert.equal(crc32(utf8('')), 0);
  assert.equal(crc32(utf8('123456789')), 0xcbf43926, 'CRC-32 的标准校验值');
  assert.equal(crc32(utf8('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('**主线**：Node 的 zlib 能解开，且逐字节等于原文', () => {
  for (const s of ['', 'a', 'x'.repeat(70000), '{"smid":"签到·AI豆🎉"}', '\u0000\u0001\u00ff']) {
    const raw = utf8(s);
    const gz = gzipWithOs19(raw);
    assert.equal(toHex(new Uint8Array(gunzipSync(Buffer.from(gz)))), toHex(raw), `原文对不上：${s.slice(0, 20)}`);
  }
});

test('**OS 字节必须是 19**（不是 3、也不是 255）', () => {
  const gz = gzipWithOs19(utf8('x'));
  assert.equal(gz[9], GZIP_OS);
  assert.equal(gz[9], 19);
  assert.equal(toHex(gz.subarray(0, 3)), '1f8b08', 'gzip 魔数 + CM=deflate');
  assert.equal(toHex(gz.subarray(4, 8)), '00000000', 'MTIME 留 0 ⇒ 输出可复现');
});

test('超长输入要分块（stored 块上限 65535）', () => {
  // 70000 = 65535 + 4465 ⇒ 两块
  const raw = new Uint8Array(70000).fill(7);
  const gz = gzipWithOs19(raw);
  assert.equal(gunzipSync(Buffer.from(gz)).length, 70000);
  // 头 10 + 两块头 10 + 数据 70000 + 尾 8
  assert.equal(gz.length, 10 + 10 + 70000 + 8);
});

test('**空输入也要发一个块**，不然流不完整、解压器会报 unexpected end', () => {
  const d = deflateStored(new Uint8Array(0));
  assert.equal(d.length, 5, '一个空的 stored 块 = 5 字节头');
  assert.equal(d[0], 1, 'BFINAL=1 并且 BTYPE=00');
  assert.equal(gunzipSync(Buffer.from(gzipWithOs19(new Uint8Array(0)))).length, 0);
});

test('stored 块头的 LEN/NLEN 互为反码', () => {
  const d = deflateStored(new Uint8Array(300).fill(1));
  const len = d[1]! | (d[2]! << 8);
  const nlen = d[3]! | (d[4]! << 8);
  assert.equal(len, 300);
  assert.equal(nlen, (~300) & 0xffff, 'NLEN 写错的话解压器会判"损坏"');
});

test('base64 那层：解出来还是同一份 gzip', () => {
  const raw = utf8('smid');
  const b64 = gzipWithOs19Base64(raw);
  assert.equal(toHex(new Uint8Array(gunzipSync(Buffer.from(fromBase64(b64))))), toHex(raw));
});

test('同一个输入两次输出**完全相同**（没有时间戳、没有随机）', () => {
  assert.equal(gzipWithOs19Base64(utf8('x')), gzipWithOs19Base64(utf8('x')));
});
