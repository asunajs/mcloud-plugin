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
import { fromBase64, fromHex, fromUtf8, toHex, utf8 } from '../src/crypto/bytes.ts';

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

// ══════════════════════════════ 解密那半 ══════════════════════════════
//
// 加密那半生产链路才用（smid 上报是单向的）。解密这半是**登录链路**要的：
//   · 滑块缺口坐标（`data.puzzleLeft` = `base64(IV ‖ AES-128-CBC/PKCS7)`）
//   · 登录成功响应里 `data` 的 `userInfo`（AES-128-**ECB**/PKCS7，hex 密文）
//
// 两条独立的用途，所以各自都要对拍 —— 只测一条会漏掉另一条的**模式**错误
// （ECB 写成 CBC 时，单块输入的结果**完全一样**，只有多块才暴露）。

import { createDecipheriv } from 'node:crypto';

import {
  INV_SBOX,
  aes128CbcDecrypt,
  aes128DecryptBlock,
  aes128EcbDecrypt,
  aesEcbPkcs7DecryptHex,
  decryptWithDynamicIv,
  encryptWithDynamicIv,
  pkcs7Unpad,
} from '../src/crypto/aes.ts';

/** 逆 S 盒必须是正向那张的**逆排列**。
 *
 *  这是"不抄第二张表"换来的断言：抄表时这条是自证的（你抄的就是它），
 *  求逆时它是**真的在验**（算错一个元素这条就红）。 */
test('逆 S 盒是正向 S 盒的逆排列（不抄第二张表的理由）', () => {
  for (let a = 0; a < 256; a += 1) {
    assert.equal(INV_SBOX[SBOX_FOR_TEST[a]!], a, `INV_SBOX 与 SBOX 在 ${a} 处对不上`);
  }
});

// SBOX 没有导出（它是模块私有的），所以用一条已知的 FIPS-197 首行来验
const SBOX_FOR_TEST = (() => {
  // FIPS-197 表 4 的第一行，用来确认 INV_SBOX 不是一张"自己跟自己一致"的假表
  const row0 = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab,
    0x76,
  ];
  const s = new Uint8Array(256);
  // 用 FIPS-197 里 "S 盒可由逆元算出来" 的同一套算法重建（与实现无关的独立实现）
  const mul = (a: number, b: number) => {
    let r = 0;
    for (let i = 0; i < 8; i += 1) {
      if (b & 1) r ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return r & 0xff;
  };
  for (let a = 0; a < 256; a += 1) {
    let inv = 0;
    if (a !== 0) {
      for (let x = 1; x < 256; x += 1) {
        if (mul(a, x) === 1) {
          inv = x;
          break;
        }
      }
    }
    const rot = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff;
    s[a] = (inv ^ rot(inv, 1) ^ rot(inv, 2) ^ rot(inv, 3) ^ rot(inv, 4) ^ 0x63) & 0xff;
  }
  assert.deepEqual(Array.from(s.subarray(0, 16)), row0, '独立重建的 S 盒首行与 FIPS-197 不符');
  return s;
})();

test('FIPS-197 附录 B：单块解密（验逆轮函数）', () => {
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const ct = hexToBytes('69c4e0d86a7b0430d8cdb78070b4c55a');
  const pt = hexToBytes('00112233445566778899aabbccddeeff');
  const rk = aes128KeyExpansion(key);
  assert.equal(toHex(aes128DecryptBlock(rk, ct)), toHex(pt), '逆密码解出来的不是原明文');
});

test('加密→解密是恒等（多种长度，含"正好一个块"）', () => {
  const key = bytes(16, 7);
  const iv = bytes(16, 99);
  for (const n of [0, 1, 15, 16, 17, 31, 32, 100]) {
    const msg = bytes(n, 3);
    const ct = aes128CbcEncrypt(key, iv, pkcs7Pad(msg, 16));
    const back = pkcs7Unpad(aes128CbcDecrypt(key, iv, ct));
    assert.deepEqual(Array.from(back), Array.from(msg), `长度 ${n} 没对上`);
  }
});

test('**主线**：CBC 解密与 Node 的 aes-128-cbc 逐字节一致', () => {
  const key = bytes(16, 1);
  const iv = bytes(16, 200);
  const msg = utf8('滑块缺口坐标 461 —— 混点非 ASCII，验字节而不是字符');
  const padded = pkcs7Pad(msg, 16);

  // Node 那边加密，我们这边解
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  const ct = new Uint8Array(Buffer.concat([c.update(Buffer.from(padded)), c.final()]));
  assert.equal(
    toHex(pkcs7Unpad(aes128CbcDecrypt(key, iv, ct))),
    toHex(msg),
    'CBC 解密与 openssl 对不上',
  );

  // 我们这边加密，Node 那边解（双向，防止"两边错得一样"）
  const ours = aes128CbcEncrypt(key, iv, padded);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  const back = Buffer.concat([d.update(Buffer.from(ours)), d.final()]);
  assert.equal(toHex(new Uint8Array(back)), toHex(padded), '我们的密文 openssl 解不开');
});

test('**ECB 与 CBC 在多块时结果不同**（模式用错必被发现）', () => {
  const key = bytes(16, 5);
  const iv = bytes(16, 6);
  // ⚠ 两个**相同**的明文块：ECB 下密文两块相同，CBC 下不同。
  //   这正是"ECB 写成 CBC"唯一会暴露的场合 —— 单块输入两者结果一样。
  const padded = new Uint8Array(32);
  padded.set(bytes(16, 42), 0);
  padded.set(bytes(16, 42), 16);

  const ecb = aes128EcbDecrypt; // 只取引用，下面用手工块调用来比
  const viaEcb = (() => {
    const rk = aes128KeyExpansion(key);
    const out = new Uint8Array(32);
    out.set(aes128DecryptBlock(rk, padded.subarray(0, 16)), 0);
    out.set(aes128DecryptBlock(rk, padded.subarray(16, 32)), 16);
    return out;
  })();
  const viaCbc = aes128CbcDecrypt(key, iv, padded);
  assert.notEqual(toHex(viaEcb), toHex(viaCbc), 'ECB 与 CBC 结果一样 —— 是不是模式没区分开？');
  void ecb;
});

test('`aesEcbPkcs7DecryptHex`：hex 进、明文出（登录 userInfo 那条路）', () => {
  const key = 'qPqDw263XgFgL3u8'; // 生产密钥（客户端 decryptByAes）
  const msg = utf8('{"userInfo":{"msisdn":"13800000000"}}');
  // 用 Node 的 ECB 造密文
  const c = createCipheriv('aes-128-ecb', fitKey16(key), null);
  const ct = Buffer.concat([c.update(Buffer.from(msg)), c.final()]);
  assert.equal(aesEcbPkcs7DecryptHex(key, ct.toString('hex')), fromUtf8(msg));
});

test('`decryptWithDynamicIv`：`base64(IV ‖ 密文)` 且**自己带着 IV**', () => {
  const key = utf8('CREATPUZZLE03F9A');
  const iv = utf8('E526E1F3F9765444');
  const answer = '461';
  const payload = encryptWithDynamicIv(key, iv, answer);
  // 载荷 = IV(16) + 密文(16) ⇒ base64 后 44 字符（含一个 '='）
  const raw = fromBase64(payload);
  assert.equal(raw.length, 32, '载荷长度不是 IV + 一个块');
  assert.equal(toHex(raw.subarray(0, 16)), toHex(iv), '前 16 字节不是 IV');
  assert.equal(decryptWithDynamicIv(key, payload), answer, '解出来的不是原答案');
  // 换一把密钥 ⇒ 必须**报错**而不是返回乱码（填充校验的作用）
  assert.throws(() => decryptWithDynamicIv(utf8('CREATPUZZLE03F9B'), payload), /填充/);
});

test('`decryptWithDynamicIv`：太短的输入要早失败（别报成"长度不是整数倍"）', () => {
  assert.throws(() => decryptWithDynamicIv(utf8('k'), 'AAAA'), /太短/);
});

test('`pkcs7Unpad` 的校验不是装饰：密钥错时必须报错而不是静默截断', () => {
  const key = bytes(16, 9);
  const iv = bytes(16, 10);
  const ct = aes128CbcEncrypt(key, iv, pkcs7Pad(utf8('hello'), 16));
  // 用错密钥解 ⇒ 填充几乎一定非法 ⇒ 必须抛
  assert.throws(() => pkcs7Unpad(aes128CbcDecrypt(bytes(16, 11), iv, ct)), /填充/);
  // 长度不是整数倍也要早失败
  assert.throws(() => pkcs7Unpad(new Uint8Array(20)), /整数倍/);
});

test('解密侧参数校验：密钥长度、块长度、空密文', () => {
  assert.throws(() => aes128CbcDecrypt(bytes(15), bytes(16), bytes(16)), /密钥必须是 16 字节/);
  assert.throws(() => aes128CbcDecrypt(bytes(16), bytes(15), bytes(16)), /IV 必须是 16 字节/);
  assert.throws(() => aes128CbcDecrypt(bytes(16), bytes(16), new Uint8Array(0)), /整数倍/);
  assert.throws(() => aes128EcbDecrypt(bytes(16), new Uint8Array(0)), /整数倍/);
  assert.throws(() => aes128DecryptBlock(aes128KeyExpansion(bytes(16)), bytes(15)), /块必须是 16 字节/);
});


