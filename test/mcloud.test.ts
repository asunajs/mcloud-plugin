// M1 上游层的测试：签名公式、响应信封、H5 头画像、调用层与 cookie。
//
// 原则和密码学那层一致：**尽量用独立信源**，而不是「跟我自己算的一样」。
//   - 签名的期望值是**用 Node 的 md5 从字面拼接串现算**的（公式独立于我的实现）
//   - 用带前导零的时间戳钉死「timestamp 不做数值归一化」这条（`007` 不是 `7`）
//   - 信封的用例来自上游实拍的两种形状（原实现注释里写着的那些）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SALT_MAP, generateSignature, saltFor, signHeadersWith } from '../src/mcloud/sign.ts';
import { parseSignInEnvelope, resultArray, resultObject } from '../src/mcloud/envelope.ts';
import {
  H5_APP_VERSION,
  MARKET_NAME,
  TASK_CLIENT_VERSION,
  buildH5Request,
} from '../src/mcloud/h5.ts';
import { callOnce, extractSetCookies, mergeCookieJar } from '../src/mcloud/client.ts';
import type { Transport } from '../src/mcloud/client.ts';

const nodeMd5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** 把签名公式**独立地**重述一遍，用来算期望值。
 *
 *  第一版我是在每个断言里手拼字符串，结果漏了 id 那一段、还以为是实现错了 ——
 *  手拼长串这种事写一次就会错一次，所以固定成这个函数：公式只在这里出现一次。 */
const wantSign = (saltKey: number, id: string, ts: string, nonce: string, other = '') => {
  const salt = saltKey === 2 ? 'sekaMdYYLIZfbCfm' : 'seedMdYYLIZfbCxg';
  return nodeMd5(`${salt}${id}${ts}${nonce}${other}${salt}`);
};

test('盐表与回落行为（未知 key 回落第 1 个，是上游行为）', () => {
  assert.equal(saltFor(1), 'seedMdYYLIZfbCxg');
  assert.equal(saltFor(2), 'sekaMdYYLIZfbCfm');
  for (const k of [0, 3, 99, -1]) {
    assert.equal(saltFor(k), SALT_MAP[0]![1], `key=${k} 应当回落`);
  }
});

test('签名公式：salt 包裹两次，other 在尾盐之前', () => {
  // ① 空 other
  assert.equal(generateSignature('id1', 'ts1', 'n1', 1, ''), wantSign(1, 'id1', 'ts1', 'n1'));
  // ② 带 other（用第 2 个盐）
  assert.equal(
    generateSignature('id1', 'ts1', 'n1', 2, 'XYZ'),
    wantSign(2, 'id1', 'ts1', 'n1', 'XYZ'),
  );
  // ③ 未知盐 key 走回落，结果应当等于用第 1 个盐
  assert.equal(
    generateSignature('a', 'b', 'c', 42, ''),
    generateSignature('a', 'b', 'c', 1, ''),
  );
});

test('timestamp 参与拼接时**不做数值归一化**（前导零必须保留）', () => {
  // 这条钉的是一个很容易「顺手优化掉」的行为：把 '007' 当数字处理会变成 '7'，
  // 签名就对不上，而上游只会回一句「签名错误」，在真机上很难查。
  assert.equal(generateSignature('id', '007', 'n', 1, ''), wantSign(1, 'id', '007', 'n'));
  assert.notEqual(
    generateSignature('id', '007', 'n', 1, ''),
    generateSignature('id', '7', 'n', 1, ''),
  );
  // 同理：13 位毫秒串必须原样进去
  const ts = '1700000000000';
  assert.equal(generateSignature('i', ts, 'n', 1, ''), wantSign(1, 'i', ts, 'n'));
});

test('签名头用线上小写名，签名值与公式一致', () => {
  const h = signHeadersWith('i', 'n', '1700000000000', 1, '');
  assert.deepEqual(Object.keys(h).sort(), [
    'x-nonce',
    'x-request-id',
    'x-signature',
    'x-timestamp',
  ]);
  assert.equal(h['x-request-id'], 'i');
  assert.equal(h['x-nonce'], 'n');
  assert.equal(h['x-timestamp'], '1700000000000');
  assert.equal(h['x-signature'], generateSignature('i', '1700000000000', 'n', 1, ''));
});

test('签到信封：数字 code、字符串 code、msg/message 两种键名都能收', () => {
  const a = parseSignInEnvelope('{"code":0,"msg":"success","result":[]}');
  assert.equal(a.code, 0);
  assert.equal(a.message, 'success');
  assert.equal(a.ok, true);
  assert.deepEqual(resultArray(a), []);

  // 上游有时把 code 发成数字字符串
  const b = parseSignInEnvelope('{"code":"0","message":"ok","result":{}}');
  assert.equal(b.code, 0);
  assert.equal(b.ok, true);
  assert.equal(b.message, 'ok');

  // 业务失败：ok=false，但要带上游原话
  const c = parseSignInEnvelope('{"code":1001,"msg":"已签到"}');
  assert.equal(c.ok, false);
  assert.equal(c.message, '已签到');
  assert.equal(c.result, undefined);

  // 解析不出来的 code 给 -1（**不是 0** —— 0 是成功，混淆会把失败当成功）
  const d = parseSignInEnvelope('{"code":"abc"}');
  assert.equal(d.code, -1);
  assert.equal(d.ok, false);

  assert.throws(() => parseSignInEnvelope('<html>502</html>'), /不是 JSON/);
  assert.throws(() => parseSignInEnvelope('[1,2,3]'), /不是对象/);
});

test('result 形状不同就各取各的，不做「两种都吃」的兼容', () => {
  // 原实现特意强调过：写一个「数组和对象都能吃」的解析器，
  // 上游改形状时这条链不会响。这里用两个取值函数把选择权交给调用方。
  const arr = parseSignInEnvelope('{"code":0,"result":[{"id":1}]}');
  assert.equal(resultArray(arr).length, 1);
  assert.deepEqual(resultObject(arr), {});

  const obj = parseSignInEnvelope('{"code":0,"result":{"beiyong1":[{"id":596}]}}');
  assert.deepEqual(resultArray(obj), []);
  assert.ok('beiyong1' in resultObject(obj));
});

test('H5 头画像：appversion 四段、jwttoken 小写、GET 不发 content-type', () => {
  const common = {
    url: 'https://example.invalid/x',
    referer: 'https://example.invalid/r',
    showLoading: '1',
    isDeviceId: false,
    saltKey: 1,
    session: {},
    signInputs: { id: 'i', nonce: 'n', timestampMs: '1700000000000' },
  } as const;

  const get = buildH5Request({ ...common, method: 'GET' });
  assert.equal(get.headers.Accept, '*/*');
  assert.equal(get.headers.activityid, MARKET_NAME);
  assert.equal(get.headers.appversion, H5_APP_VERSION);
  assert.equal(H5_APP_VERSION, '12.6.0.0', 'appversion 是四段');
  assert.equal(TASK_CLIENT_VERSION, '12.6.0', 'body 里的 clientVersion 是三段');
  assert.equal(get.headers.showloading, '1');
  assert.equal(get.headers['isdeviceid'], undefined, '没要求就不发 isdeviceid');
  assert.equal(get.headers['content-type'], undefined, 'GET 不发 content-type');
  assert.equal(get.body, undefined);
  assert.equal(get.headers['x-signature'], generateSignature('i', '1700000000000', 'n', 1, ''));

  const post = buildH5Request({ ...common, method: 'POST', body: '{"a":1}', isDeviceId: true });
  assert.equal(post.headers['isdeviceid'], 'true');
  assert.equal(post.headers['content-type'], 'application/json');
  assert.equal(post.body, '{"a":1}');

  // POST 没给 body 时发字面量 null（原实现里有的端点就是发 `null`）
  assert.equal(buildH5Request({ ...common, method: 'POST' }).body, 'null');

  // jwt 头名是小写 jwttoken —— 驼峰化会让「哪枚生效」变成传输层的事
  const withJwt = buildH5Request({
    ...common,
    method: 'GET',
    session: { jwt: 'T', deviceId: 'D', userAgent: 'UA', cookie: 'a=1' },
  });
  assert.equal(withJwt.headers.jwttoken, 'T');
  assert.equal(withJwt.headers.jwtToken, undefined);
  assert.equal(withJwt.headers.deviceid, 'D');
  assert.equal(withJwt.headers['user-agent'], 'UA');
  assert.equal(withJwt.headers.cookie, 'a=1');
});

test('调用层：成功 / HTTP 失败 / 非 JSON / 传输层抛异常，都不抛给调用方', () => {
  const okTransport: Transport = () => ({
    status: 200,
    headers: {},
    body: '{"code":0,"msg":"success","result":[]}',
  });
  const r = callOnce(okTransport, {
    url: 'u',
    method: 'GET',
    headers: {},
    body: undefined,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.tookMs >= 0);
  assert.equal(r.error, undefined);

  const bizFail: Transport = () => ({ status: 200, headers: {}, body: '{"code":1001,"msg":"已签到"}' });
  const f = callOnce(bizFail, { url: 'u', method: 'GET', headers: {}, body: undefined });
  assert.equal(f.ok, false);
  assert.match(f.error ?? '', /code=1001/);
  assert.match(f.error ?? '', /msg=已签到/);

  const http500: Transport = () => ({ status: 500, headers: {}, body: 'boom' });
  const e5 = callOnce(http500, { url: 'u', method: 'GET', headers: {}, body: undefined });
  assert.equal(e5.ok, false);
  assert.equal(e5.error, 'HTTP 500');
  assert.equal(e5.env, undefined);

  const notJson: Transport = () => ({ status: 200, headers: {}, body: '<html>' });
  const nj = callOnce(notJson, { url: 'u', method: 'GET', headers: {}, body: undefined });
  assert.equal(nj.ok, false);
  assert.match(nj.error ?? '', /不是 JSON/);

  const thrown: Transport = () => {
    throw new Error('connection reset');
  };
  const th = callOnce(thrown, { url: 'u', method: 'GET', headers: {}, body: undefined });
  assert.equal(th.status, 0);
  assert.equal(th.ok, false);
  assert.match(th.error ?? '', /connection reset/);
});

test('cookie：多枚合一、Expires 里的逗号不能被当成分隔符', () => {
  // 这一条是 cookie 解析的经典坑：`Expires=Wed, 21 Oct 2015 07:28:00 GMT` 里也有逗号
  const h = {
    'set-cookie':
      'a=1; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT, b=2; Path=/; HttpOnly',
  };
  assert.deepEqual(extractSetCookies(h), ['a=1', 'b=2']);

  assert.deepEqual(extractSetCookies({ 'Set-Cookie': 'x=9' }), ['x=9']);
  assert.deepEqual(extractSetCookies({}), []);

  assert.equal(mergeCookieJar('a=1; b=2', ['b=3']), 'a=1; b=3');
  assert.equal(mergeCookieJar('', ['a=1', 'b=2']), 'a=1; b=2');
  // 空值 = 上游让这个 cookie 失效
  assert.equal(mergeCookieJar('a=1; b=2', ['b=']), 'a=1');
});
