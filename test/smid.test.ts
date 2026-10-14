// smid 链的组装层 —— 最强的一条断言是**整条流水线用 Node 侧解回来**：
//
//   特征体 → DES 逐字段加密改名 → gzip(OS=19) → AES-CBC → hex
//   反过来：Node 的 aes-128-cbc 解密 → base64 解 → gunzip → JSON → 逐字段看
//
// 这条断言把"四个原语串起来之后还是不是一份能解开的、字段名对得上的东西"一次验掉。
// 每个原语单看都对、但串错顺序（比如先 AES 后 gzip）在这里会当场暴露。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import {
  DEVICE_ID_PREFIX,
  SMID_HOST,
  SMID_OK_CODE,
  SMID_PATH,
  SMID_UA,
  STATE_FINGERPRINT,
  buildSmBody,
  buildSmid,
  encryptByDesRules,
  encryptSmBody,
  ensureFingerprint,
  getTn,
  loadFingerprint,
  newFingerprint,
  parseDeviceId,
  smidUploadRequest,
} from '../src/mcloud/smid.ts';
import { AES_FIXED_IV, fitKey16 } from '../src/crypto/aes.ts';
import { DES_RULE } from '../src/mcloud/smidRules.ts';
import { fromBase64, fromHex, fromUtf8, toHex } from '../src/crypto/bytes.ts';
import { md5Hex } from '../src/crypto/index.ts';
import { memStore } from '../src/store/memory.ts';

const NOW = new Date('2026-10-14T09:00:00+08:00');
const NOW_ISO = '2026-10-14T01:00:00.000Z';

/** 可复现的伪随机（不用 Math.random —— 测试要能重复）。 */
function fixedRnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('getTn：键排序、number ×10000、null 变 "null"、对象递归', () => {
  assert.equal(getTn({ b: 1, a: 2 }), '2000010000', '键排序 + 各自 ×10000');
  assert.equal(getTn({ a: 1.5 }), '15000', '非整数先 floor 再乘');
  assert.equal(getTn({ a: null }), 'null', '⚠ 是 "null" 而不是空串');
  assert.equal(getTn({ a: true }), 'true');
  assert.equal(getTn({ a: 'x' }), 'x');
  assert.equal(getTn({ a: { b: 1 } }), '10000', '对象递归');
  assert.equal(getTn({}), '');
});

test('buildSmid：yyyyMMddHHmmss + md5(uid) + 00，再拼 14 位摘要 + "0"', () => {
  const s = buildSmid(NOW, 'uid-1');
  assert.equal(s.slice(0, 14), '20261014090000', '时间串（本地时区，照抄原实现）');
  assert.equal(s.slice(14, 46), md5Hex('uid-1'), 'md5(uid)');
  assert.equal(s.slice(46, 48), '00');
  const v = s.slice(0, 48);
  assert.equal(s.slice(48, 62), md5Hex(`smsk_web_${v}`).slice(0, 14));
  assert.equal(s.slice(62), '0');
  assert.equal(s.length, 63);
});

test('encryptByDesRules：22 条加密、3 条**只改名**、其余原样', () => {
  const out = encryptByDesRules({ appId: 'default', box: 'OLD', protocol: 4, 未知字段: 'keep' });
  assert.equal(typeof out.um, 'string', 'appId → um（加密）');
  assert.notEqual(out.um, 'default', '加密之后当然不是原文');
  assert.match(out.um as string, /^[A-Za-z0-9+/]+=*$/, 'DES 那条输出 base64');
  assert.equal(out.aw, 'OLD', 'box → aw：**只改名不加密**，值原样');
  assert.equal(out.protocol, 4, '只改名的那条名字不变');
  assert.equal(out.未知字段, 'keep', '没有规则的原样带出去');
  assert.equal(out.appId, undefined, '原名不该再出现');
  assert.equal(Object.keys(DES_RULE).length, 25);
});

test('**整条流水线**：Node 侧 aes-128-cbc 解密 → gunzip → JSON 能读回字段', () => {
  const fp = newFingerprint(fixedRnd(7));
  const body = buildSmBody(fp, 'OLD-DEVICE', NOW, fixedRnd(11));
  const priId = md5Hex('some-uid').slice(0, 16);
  const hex = encryptSmBody(body, priId);

  // 反向：AES-CBC（PKCS7）解密 → 得到 gzip 的 base64 → gunzip → JSON
  const dec = createDecipheriv('aes-128-cbc', fitKey16(priId), AES_FIXED_IV);
  const gzB64 = new Uint8Array(Buffer.concat([dec.update(Buffer.from(fromHex(hex))), dec.final()]));
  // 链子要走完：AES 明文 = **base64 文本** → 解出 gzip 字节 → gunzip → JSON 文本
  // ⚠ 少任何一步都是这里踩过的坑（`fromBase64` 给的是**字节**，不是字符串）
  const gz = fromBase64(fromUtf8(gzB64));
  const json = JSON.parse(fromUtf8(new Uint8Array(gunzipSync(Buffer.from(gz))))) as Record<
    string,
    unknown
  >;

  // 字段名必须是**改名之后**的
  assert.equal(typeof json.um, 'string', 'appId 已改名成 um');
  assert.equal(json.aw, 'OLD-DEVICE', 'box → aw 且值原样（只改名不加密）');
  assert.equal(json.protocol, 4);
  assert.equal(json.version, '3.0.0');
  // 加密字段必须是 base64 串，且**解出来不是原文**
  for (const k of ['um', 'pu', 'sb', 'qb']) {
    assert.match(json[k] as string, /^[A-Za-z0-9+/]*=*$/, `${k} 该是 base64`);
  }
  assert.notEqual(json.pu, SMID_UA, 'ua 被加密了（不该原样出现）');
  assert.equal(json.ua, undefined, '原字段名不该还在');
  // ⚠ `rtype`/`os` **也在加密那 22 条里** —— 它们连名字都改了（fm / lz）。
  // 第一版我在这里断言 `json.rtype === 'all'`，那是错的：只有**没有规则**的字段才原样。
  assert.ok(json.fm, 'rtype → fm（加密）');
  assert.ok(json.lz, 'os → lz（加密）');
  assert.equal(json.rtype, undefined);
  assert.equal(json.os, undefined);
  // 真正**没有规则**的那几个才原样带出去 —— 这条同时验了"漏规则"那条路径
  assert.equal(typeof json.smid, 'string', 'smid 没有规则 ⇒ 原样');
  assert.equal(json.cpucount, fp.cpucount, 'cpucount 没有规则 ⇒ 原样且值不变');
  assert.ok(json.battery, 'battery 没有规则（它的两个子键也不是规则表里的键）');
  // tn 是 md5 hex（32 字符）—— 它在规则里是**加密**的，所以出来是 base64，长度对得上
  assert.ok(json.qb, 'tn → qb');
});

test('**顺带验 gzip 那一层**：解开来的字节里能看见 JSON 的痕迹（说明没被压掉）', () => {
  const fp = newFingerprint(fixedRnd(3));
  const body = buildSmBody(fp, '', NOW, fixedRnd(5));
  const priId = md5Hex('u').slice(0, 16);
  const hex = encryptSmBody(body, priId);
  const dec = createDecipheriv('aes-128-cbc', fitKey16(priId), AES_FIXED_IV);
  const gz = fromBase64(
    fromUtf8(new Uint8Array(Buffer.concat([dec.update(Buffer.from(fromHex(hex))), dec.final()]))),
  );
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  assert.equal(gz[9], 19, 'OS 字节 19 要一路留到最后');
  const plain = fromUtf8(new Uint8Array(gunzipSync(Buffer.from(gz))));
  assert.match(plain, /"um":"/, 'stored 块不压缩 ⇒ 明文痕迹还在（也说明我们没压坏）');
});

test('parseDeviceId：1100 ⇒ "B" + 值；别的码与缺字段都如实报错', () => {
  assert.equal(parseDeviceId('{"code":1100,"detail":{"deviceId":"ABC"}}').deviceId, 'BABC');
  assert.equal(DEVICE_ID_PREFIX + 'ABC', 'BABC');
  assert.equal(SMID_OK_CODE, 1100);
  const bad = parseDeviceId('{"code":1101,"msg":"x"}');
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /1101/);
  assert.equal(parseDeviceId('{"code":1100,"detail":{}}').ok, false, '缺 deviceId');
  assert.equal(parseDeviceId('不是 JSON').ok, false);
});

test('上报请求的形状：URL、三枚头、body 六个键', () => {
  const fp = newFingerprint(fixedRnd(1));
  const req = smidUploadRequest(fp, '', NOW, fixedRnd(2));
  assert.equal(req.url, `${SMID_HOST}${SMID_PATH}`);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.ok(req.headers.origin?.startsWith('https://m.mcloud.139.com'));
  assert.ok(req.headers['user-agent']?.includes('Chrome/128'));
  const body = JSON.parse(req.body!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['appId', 'organization', 'ep', 'data', 'os', 'encode', 'compress']);
  assert.equal(body.appId, 'default');
  assert.equal(body.os, 'web');
  assert.equal(body.encode, 5);
  assert.equal(body.compress, 2);
  assert.equal(fromBase64(body.ep as string).length, 128, 'RSA-1024 ⇒ 128 字节');
  assert.match(body.data as string, /^[0-9a-f]{32,}$/, 'data 是 **hex**（AES 那条路）');
});

test('稳定特征**存一次、之后复用**（每次重掷是最容易触发风控的姿态）', () => {
  const store = memStore();
  store.ensureSchema();
  const a = ensureFingerprint(store, NOW_ISO, fixedRnd(1));
  const b = ensureFingerprint(store, NOW_ISO, fixedRnd(999)); // 换随机源也**不该**变
  assert.deepEqual(b, a, '第二次必须拿到同一份');
  assert.ok(store.getState(STATE_FINGERPRINT), '落盘了');
  assert.deepEqual(loadFingerprint(store), a);
  // 存坏了当没有（而不是拿半截数据去上报）
  store.setState(STATE_FINGERPRINT, '{坏的', NOW_ISO);
  assert.equal(loadFingerprint(store), null);
  assert.ok(ensureFingerprint(store, NOW_ISO, fixedRnd(4)));
});

test('每次现算的那一半**确实在变**（smid / vpw / trees / 时间戳）', () => {
  const fp = newFingerprint(fixedRnd(1));
  const a = buildSmBody(fp, '', NOW, fixedRnd(1));
  const b = buildSmBody({ ...fp }, '', new Date(NOW.getTime() + 1000), fixedRnd(2));
  assert.notEqual(a.smid, b.smid, 'smid 每次都变');
  assert.notEqual(a.vpw, b.vpw);
  assert.notEqual(a.trees, b.trees);
  assert.notEqual(a.svm, b.svm);
  // 而稳定那部分不变
  assert.equal(a.platform, b.platform);
  assert.equal(a.res, b.res, '屏幕那几项也稳定');
  assert.equal(a.canvas, b.canvas);
});

test('`tn` 是**最后**算并写回自己的（摘要输入是"还没有 tn 的那一份"）', () => {
  const fp = newFingerprint(fixedRnd(1));
  const body = buildSmBody(fp, '', NOW, fixedRnd(1));
  const tn = body.tn as string;
  assert.match(tn, /^[0-9a-f]{32}$/);
  const recomputed = md5Hex(getTn({ ...body, tn: '' }));
  assert.equal(tn, recomputed, 'tn 必须等于「把 tn 清空后」的摘要');
  assert.notEqual(tn, md5Hex(getTn(body)), '拿带 tn 的那份算会得到另一个值 —— 这是个容易犯的错');
});

test('crc 那层：`data` 的 hex 长度是 16 的倍数（AES 块对齐）', () => {
  const fp = newFingerprint(fixedRnd(1));
  const req = smidUploadRequest(fp, '', NOW, fixedRnd(2));
  const data = (JSON.parse(req.body!) as { data: string }).data;
  assert.equal(data.length % 32, 0, 'AES-CBC + PKCS7 ⇒ 16 字节对齐 ⇒ 32 个 hex 字符的倍数');
  assert.equal(toHex(fromHex(data)).length, data.length);
});
