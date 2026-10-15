// 手机端（App）登录的加解密与请求体。
//
// # 这一层为什么能离线钉死
//
// 参考实现留了两条**实拍黄金值**：一条明文 + 它经
// `lYzvvBMUjucw+h^R` 加密再「末 10 位错位」之后的线上形态。
// 逐字节对上就说明：密钥、模式、填充、错位方向、hex 大小写**全部正确**。
//
// 这件事值得离线测，因为**线上验起来很别扭**：错位方向写反、或漏掉旋转，
// 服务端回的是 `9103 输入参数不合法` —— 看起来像"字段名不对"，
// 会把人引去查请求体，而真正的错在加密那一层。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ⚠ 相对**文件本身**解析：`new URL('..', import.meta.url)` 退到的是
//   "文件的父目录的父"（`test/` 的上一级已经是仓库根了），会多退一级。
const SRC = new URL('../src/mcloud/appLogin.ts', import.meta.url);

import {
  APP_CLIENT_TYPE,
  APP_CPID,
  APP_LOGIN_AES_KEY,
  APP_LOGIN_AES_KEY_ALT,
  APP_VERSION,
  APP_X_USER_AGENT,
  APP_X_YUN_USER_AGENT,
  SEND_SMS_RANDOM,
  appSendSmsCodeRequest,
  appThirdloginRequest,
  appClientInfo,
  appDeviceInfo,
  appHeaders,
  decryptBody,
  encryptBody,
  newLoginRandom,
  sendSmsCodeBody,
  shiftHead10ToBack,
  shiftTail10ToFront,
  smsThirdloginBody,
  smsThirdloginBodySorted,
} from '../src/mcloud/appLogin.ts';

/** 实拍：实现侧键序（字母序）的明文。 */
const SORTED_PLAINTEXT =
  '{"clienttype":"412","cpid":"55","dycpwd":"429344","extInfo":{"ifOpenAccount":"1"},' +
  '"loginMode":"0","msisdn":"19900000000","pintype":"8","random":"hOjseB",' +
  '"verType":"1","version":"12.6.0"}';

/** 上面那串加密 + 错位之后的线上形态（实拍）。 */
const SORTED_WIRE =
  '17e30bcd98e6e4bdccc6b6e0c034688a3d2db656484a7de56ee67b2580af3dde4075b72cd78a1141' +
  '5da4b19ce641dbf7fad4a096f842da2556008fbbc3521d6ebf0499470b3dcf08532c25cf5ce6ac90' +
  '52c20db6035c039af766e0206a772f94c3933802caaa302cc5e6d3c7160711a3d966cfc770568650' +
  'de3a503048bb660f9e57597dc82cf15674c8f622823bc517ef2f7f51483fdff8b8191c6f1e6335d9' +
  'c48aaba2d076b067ff091c65f3a107a60bd61352d9718a0466512bce9a4397b6';

/** 实拍：**客户端原始键序**的明文（与上面同一次登录）。 */
const CAPTURED_PLAINTEXT =
  '{"cpid":"55","extInfo":{"ifOpenAccount":"1"},"dycpwd":"429344","pintype":"8",' +
  '"loginMode":"0","verType":"1","version":"12.6.0","msisdn":"19900000000",' +
  '"random":"hOjseB","clienttype":"412"}';

/** 上面那串的线上形态（实拍）。 */
const GOLDEN_WIRE =
  '2584e02d73b549d837f9fa6e4bdd4968c816497fba1be0770aeba9d7249a928db623ee6b11f26284' +
  '588aa8dd943fdca3a5e7d21a36fdc347dbf16e1a2d0d55f23c77b1409ad5afff5600844ded9a61' +
  '3635003471e71be8e07b9b7fb8bbd14639e90ffa9716c22fb01670ee5b4b208efc0d59a0b16c08' +
  '7688ad5fd68561af8860b1e1d93ad7d00150cdb6bac04a3cc792a05347c7813afd2e06ca996da5' +
  '2959d7bc92881e4584c088cf7b01dc35341927e92c11d7e66e76c1625228a8d84c0eb0';

test('⚠ 黄金值：加密 + 末 10 位错位**逐字节**命中实拍密文（字母序）', () => {
  const wire = encryptBody(SORTED_PLAINTEXT);
  assert.equal(wire.length, 384, '186 字节 → PKCS7 补 6 → 192 字节 → 384 hex');
  assert.equal(wire, SORTED_WIRE);
});

test('⚠ 黄金值：客户端原始键序那条也逐字节命中', () => {
  // 两条黄金值都要对 —— 只对一条的话，"实现里少了一层/多了一层"仍可能蒙混过去
  assert.equal(encryptBody(CAPTURED_PLAINTEXT), GOLDEN_WIRE);
  assert.notEqual(GOLDEN_WIRE, SORTED_WIRE, '两条必须不同，否则键序没进加密输入');
});

test('⚠ 请求体构造器产出的就是黄金值那条明文（字母序）', () => {
  // 这条把"常量对不对"与"密文对不对"接上：上面两条测的是加密，
  // 这条测的是**我们真的会发出那段明文**。
  const body = smsThirdloginBodySorted('19900000000', '429344', 'hOjseB');
  assert.equal(JSON.stringify(body), SORTED_PLAINTEXT);
});

test('请求体：App 端那几个**与 PC 不同**的值', () => {
  const b = smsThirdloginBody('19900000000', '429344', 'hOjseB');
  assert.equal(b.cpid, APP_CPID);
  assert.equal(b.clienttype, APP_CLIENT_TYPE, '全小写 t（getSmsCode 那边是 clientType）');
  assert.equal(b.pintype, '8', '⚠ 短信登录也是 8，**不是** PC 的 5');
  assert.equal(b.dycpwd, '429344', '验证码**明文**（账密登录才哈希）');
  assert.equal(b.version, APP_VERSION);
  assert.deepEqual(b.extInfo, { ifOpenAccount: '1' }, '⚠ 字符串 "1"，PC 端那里是数字');
  assert.equal(b.loginMode, '0');
  assert.equal(b.verType, '1');
});

test('发码请求体：**所有值都是字符串**，且字段名是上游拼错的 `puzzleVerfycode`', () => {
  const b = sendSmsCodeBody('19900000001');
  assert.deepEqual(b, {
    mode: '0',
    phoneNumber: '19900000001',
    reqType: '3',
    clientType: APP_CLIENT_TYPE,
    random: SEND_SMS_RANDOM,
    puzzleVerfycode: '',
  });
  assert.equal(typeof b.mode, 'string', '⚠ PC 端这里 `mode` 是数字');
  assert.equal(typeof b.reqType, 'string');
  assert.equal(b.random, 'qwert', '⚠ 硬编码常量，不是随机值');
  assert.equal(b.puzzleVerfycode, '', '首次请求是**空串**，不是 null、也不是省略');
});

test('⚠ 错位方向：反了就是 `9103`（不是"解密失败"那种报错）', () => {
  assert.equal(shiftHead10ToBack(shiftTail10ToFront(SORTED_WIRE)), SORTED_WIRE, '两步要互逆');
  // 方向反了的话，密文完全不同 —— 而服务端只会说"输入参数不合法"
  assert.notEqual(shiftHead10ToBack(SORTED_WIRE), SORTED_WIRE);
  // 短串不炸（虽然不该出现）
  assert.equal(shiftTail10ToFront('abc'), 'abc');
  assert.equal(shiftHead10ToBack('abc'), 'abc');
});

test('解密：`decryptBody` 自己会反错位（传**线上形态**，不是先手动反一次）', () => {
  // ⚠ 第一版这里写成了 `decryptBody(shiftHead10ToBack(WIRE))` —— 反了两次。
  //   而反两次**不报错**，只是解出乱码：错位不改变字符集，所以"多反一次"
  //   得到的仍是一个看起来正常的 hex 串。这正是参考实现注释里点名的坑
  //   （"只反错位不解密也能得到一个看起来正常的 hex 串"）。
  assert.equal(decryptBody(SORTED_WIRE), SORTED_PLAINTEXT, '传线上形态就对了');
  assert.equal(decryptBody(GOLDEN_WIRE), CAPTURED_PLAINTEXT);
});

test('⚠ 备用密钥解不出东西（它是排查用的判据，不是"另一个可用选项"）', () => {
  // 参考实现留备用密钥的理由：「用错这把会得到 9103」是排查密钥问题最快的判据。
  // 所以这里钉住"两把不通用" —— 通用的话那条判据就没了。
  assert.throws(() => decryptBody(SORTED_WIRE, APP_LOGIN_AES_KEY_ALT), /解密|填充/);
});

test('`newLoginRandom`：6 位字母数字（形状取自实拍 `hOjseB`）', () => {
  for (let i = 0; i < 50; i++) {
    const r = newLoginRandom();
    assert.equal(r.length, 6);
    assert.match(r, /^[A-Za-z0-9]{6}$/);
  }
  // ⚠ 只钉"形状"。参考实现自己都注明了：thirdlogin 的 random **只有 1 个样本**，
  //   "每次不同"是从"客户端为什么要随机"推的，不是实测到的。
  //   所以这里不断言"多次调用不重复"（那是在钉一个没被证实的性质）。
});

test('设备串：形状与抓包一致', () => {
  const d = appDeviceInfo('DEV123');
  assert.ok(d.startsWith('1|192.168.3.179|2|12.6.0|APPLE|iPad8,6|DEV123|AAA000000000|'));
  assert.ok(d.includes('ipados 26.6'), '⚠ 设备串里是小写 `ipados`（UA 里是 `iOS`）');
  assert.ok(d.endsWith('|'), '末尾那个空段是契约的一部分');
  assert.ok(appClientInfo('DEV123').endsWith('aVBhZA==|0|;'));
});

test('⚠ 请求头：**故意不发** `hcy-cool-flag`', () => {
  // 带上它（任意值）服务端会把响应体换成一段 144 字节的加密串，
  // 而我们没有那把密钥 ⇒ 整条登录链断在这里。所以这不是漏了，是故意的。
  const h = appHeaders('DEV123', 1700000000000);
  assert.equal(
    Object.keys(h).some((k) => k.toLowerCase() === 'hcy-cool-flag'),
    false,
    '带上它会拿到解不开的响应体',
  );
  assert.equal(h['service_identifier_key'], 'service_identifier_userDomain');
  assert.equal(h['x-yun-user-timestamp'], '1700000000000');
  assert.equal(h['Content-Type'], 'application/json;charset=UTF-8');
  assert.ok(
    (h['x-yun-client-info'] ?? '').startsWith(h['x-DeviceInfo'] ?? ''),
    'client-info = device-info + 尾巴',
  );
});

// ────────────────────── 请求构造 ──────────────────────

test('⚠ App 的三枪：头是 App 那套，体是**密文**', () => {
  const send = appSendSmsCodeRequest('DEV1', 1700000000000, '13800000000');
  assert.equal(send.url, 'https://user-njs.yun.139.com/user/sms/getSmsCode');
  assert.equal(send.method, 'POST');
  // 头必须走 App 那套（不是 PC 的 `pcHeaders`）
  assert.equal(send.headers['x-UserAgent'], APP_X_USER_AGENT);
  assert.equal(send.headers['x-yun-user-agent'], APP_X_YUN_USER_AGENT);
  // ⚠ 发码是**明文**体
  const body = JSON.parse(send.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['phoneNumber'], '13800000000');
  assert.equal(body['clientType'], APP_CLIENT_TYPE);

  const third = appThirdloginRequest('DEV1', 1700000000000, '13800000000', '123456', 'rnd123');
  assert.equal(third.url, 'https://user-njs.yun.139.com/user/thirdlogin');
  // ⚠ 体**不是 JSON** —— 它是 hex 文本。这条钉的就是"加密这一步没被漏掉"：
  //   漏掉的话这里会是一段能 parse 的 JSON，而下面这行会红。
  assert.equal(third.body !== undefined && third.body.trim().startsWith('{'), false, '体不该是明文 JSON');
  assert.match(third.body ?? '', /^[0-9a-f]+$/, '体该是一串 hex');
  // 而且**能解回**那份明文（密钥对了才解得开）
  const plain = decryptBody(third.body ?? '');
  const back = JSON.parse(plain) as Record<string, unknown>;
  // ⚠ 字段名是 **`msisdn` / `dycpwd`**（不是 phoneNumber / smsCode）——
  //   这条顺带把字段名也钉住了：改错了这里会红，而线上表现是
  //   `9103 输入参数不合法`，看起来像加密不对，会把人引去查加密层。
  assert.equal(back['msisdn'], '13800000000');
  assert.equal(back['dycpwd'], '123456');
  assert.equal(back['pintype'], '8');
  assert.equal(back['clienttype'], APP_CLIENT_TYPE);
});

test('⚠ 加密在构造里完成，调用点**没有**"忘了加密"这个选项', () => {
  // 这是参考实现的原话：「传进来的是明文，加密在这里完成 —— 这样"忘了加密"
  // 在类型层面就不可能发生」。所以 `appThirdloginRequest` 收的是**明文参数**，
  // 不收支密文（收密文的话调用点可以先忘了加密再传进来）。
  const src = readFileSync(SRC, 'utf8');
  const fn = src.slice(src.indexOf('export function appThirdloginRequest'));
  const sig = fn.slice(0, fn.indexOf('{'));
  assert.ok(!/cipher|wire|encrypted/i.test(sig), `签名里不该出现密文参数：${sig}`);
  assert.ok(/phone: string/.test(sig) && /smsCode: string/.test(sig), '签名该收明文手机号与验证码');
});
