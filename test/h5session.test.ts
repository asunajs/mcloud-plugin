// H5 换票的**纯协议层**（`h5session.ts`）—— 逐条对着 `session.rs` 核。
//
// 守的是那四个"照直觉会写错"的地方（见 h5session.ts 文件头）：
//   · `toSourceId` 是调用方参数，不是端常量
//   · 页面 URL 的参数**次序与有无**逐页不同（`targetSourceId` 必须排在 `token` 之后）
//   · 两套信封（① `code` 是字符串 `"0000"`、③ 是数字 `0`）
//   · `auth.raw` 自带 `Basic ` 前缀 —— 再加一次就是 `Basic Basic …`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BASE_USER_YUN,
  H5_SALT_KEY,
  SIGN_IN_RECIPE,
  h5Headers,
  makeSign,
  normalizeAuthorization,
  pageUrl,
  parseJwtToken,
  parseServerTimestamp,
  parseSsoToken,
  specTokenRequest,
  timestampRequest,
  tyrzLoginRequest,
} from '../src/mcloud/h5session.ts';

test('① 原生族：Authorization 逐字用，body 是 `{"toSourceId":…}`，**无签名**', () => {
  const r = specTokenRequest(SIGN_IN_RECIPE, 'Basic bW9iaWxlOjE=');
  assert.equal(r.url, `${BASE_USER_YUN}/user/querySpecTokenV2`);
  assert.equal(r.method, 'POST');
  assert.equal(r.headers.Authorization, 'Basic bW9iaWxlOjE=', '逐字，不加前缀也不减');
  assert.equal(r.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.equal(r.body, '{"toSourceId":"001005"}');
  assert.equal(r.headers['x-signature'], undefined, '这一族没有签名头');
  // base 覆盖（CI 指到 mock 靠它）
  assert.equal(specTokenRequest(SIGN_IN_RECIPE, 'B', 'http://m').url, 'http://m/user/querySpecTokenV2');
});

test('② 时间戳：GET、带 H5 那套头、**不带 jwttoken**（这一步正是为了拿票）', () => {
  const r = timestampRequest(SIGN_IN_RECIPE, 'https://p/', '/p');
  assert.equal(r.method, 'GET');
  assert.equal(r.body, undefined);
  assert.equal(r.headers.activityid, 'sign_in_3');
  assert.equal(r.headers.appversion, '12.6.0.0');
  assert.equal(r.headers.showloading, 'true');
  assert.equal(r.headers.Referer, 'https://p/');
  assert.equal(r.headers.jwttoken, undefined);
});

test('③ tyrzLogin：body 的键序是**字典序**、带 Origin 与四枚签名头', () => {
  const sign = makeSign('1700000000000');
  const r = tyrzLoginRequest(SIGN_IN_RECIPE, 'SSO', sign, 'https://ref/', '/p');
  assert.equal(
    r.body,
    '{"marketName":"sign_in_3","openAccount":0,"sourceId":"1002","token":"SSO"}',
    '键序错了签名就对不上（BTreeMap 语义）',
  );
  assert.equal(r.headers.Origin, 'https://m.mcloud.139.com');
  assert.equal(r.headers.jwttoken, undefined, '这一步正是为了拿票');
  assert.ok(r.headers['x-request-id']);
  assert.ok(r.headers['x-nonce']);
  assert.equal(r.headers['x-timestamp'], '1700000000000');
  // 签名自洽：md5(盐2 + id + ts + nonce + "" + 盐2)，**不是**盐 1
  const salt = 'sekaMdYYLIZfbCfm';
  const expect = createHash('md5')
    .update(salt + sign['x-request-id'] + '1700000000000' + sign['x-nonce'] + '' + salt, 'utf8')
    .digest('hex');
  assert.equal(r.headers['x-signature'], expect);
  assert.equal(H5_SALT_KEY, 2);
});

test('页面 URL：`targetSourceId` 必须带、且排在 `token` **之后**', () => {
  const u = pageUrl(SIGN_IN_RECIPE, 'SSO');
  assert.equal(
    u,
    'https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=1002' +
      '&enableShare=1&appID=cy62d5a5e8373a272aeca467accad61722c51cfd48' +
      '&token=SSO&targetSourceId=001005',
  );
  // 参考实现漏过 targetSourceId，而当时是"照着实现写"而不是照抓包 —— 于是实现与文档一起漏
  assert.ok(u.indexOf('token=') < u.indexOf('targetSourceId='));
});

test('页面 URL：没有 appID 的那一页 `enableShare=1` 落到**后面**（两处次序都是照抄）', () => {
  const p = { ...SIGN_IN_RECIPE, h5AppId: undefined, targetSourceId: undefined };
  const u = pageUrl(p, 'SSO');
  assert.ok(!u.includes('appID='), '`undefined` 是"没有这一枚"，不是空串');
  assert.ok(!u.includes('targetSourceId='));
  assert.ok(u.endsWith('&token=SSO&enableShare=1'), u);
});

test('① 解析：双层信封，`code` 是**字符串** `"0000"`', () => {
  const ok = parseSsoToken('{"success":true,"code":"0000","message":"ok","data":{"token":"T"}}');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'T');
  // success=false ⇒ 失败，且把 code/message 带进错误里
  const bad = parseSsoToken('{"success":false,"code":"0505","message":"非法的token！"}');
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /非法的token/);
  assert.equal(parseSsoToken('{"success":true,"data":{}}').ok, false);
  assert.equal(parseSsoToken('不是 JSON').ok, false);
});

test('② 解析：数字与字符串都认，但**保持字符串**形态', () => {
  assert.equal(parseServerTimestamp('{"code":0,"result":1700000000000}').value, '1700000000000');
  assert.equal(parseServerTimestamp('{"result":"1700000000000"}').value, '1700000000000');
  assert.equal(parseServerTimestamp('{"code":0}').ok, false);
  assert.equal(parseServerTimestamp('{"result":true}').ok, false, '布尔不是整数');
});

test('③ 解析：数字 0 与字符串 "0000" 都算成功；失败样本**没有 success 字段**', () => {
  const a = parseJwtToken('{"code":0,"msg":"success","result":{"token":"JWT","mobile":"13800000000"}}');
  assert.equal(a.ok, true);
  assert.equal(a.value!.jwt, 'JWT');
  assert.equal(a.value!.mobile, '13800000000');

  const b = parseJwtToken('{"code":"0000","result":{"token":"JWT"}}');
  assert.equal(b.ok, true, '字符串形式的 0 也要认');

  // ⚠ 实拍失败样本：没有 `success` 字段 ⇒ 判据不能只看 success
  const c = parseJwtToken('{"code":200050409,"msg":"token 已失效"}');
  assert.equal(c.ok, false);
  assert.match(c.error!, /200050409/);
  assert.match(c.error!, /token 已失效/);

  assert.equal(parseJwtToken('{"code":0,"result":{}}').ok, false, '没有 result.token');
  // mobile 缺失**不该**让整次登录失败（它只是回显）
  assert.equal(parseJwtToken('{"code":0,"result":{"token":"J"}}').ok, true);
});

test('凭据：带前缀的收下（**绝不**补第二次 `Basic `）', () => {
  // 双前缀会得到 `Basic Basic bW9iaWxl…`，而上游回的是「非法的token！」
  // —— 那句话听起来像"凭据过期了"，会把排查带到隔壁
  assert.equal(normalizeAuthorization('Basic bW9iaWxlOjE=').value, 'Basic bW9iaWxlOjE=');
  // `basic` 小写也归一成 `Basic `（同一串，只是大小写；上游不区分，但存两种写法没好处）
  assert.equal(normalizeAuthorization('basic bW9iaWxlOjE=').value, 'Basic bW9iaWxlOjE=');
  assert.equal(normalizeAuthorization('  Bearer eyJhbGci  ').value, 'Bearer eyJhbGci');
});

test('凭据：不管用户怎么贴，都归一成能直接当请求头的形状', () => {
  const want = 'Basic bW9iaWxlOjE=';
  const cases: Array<[string, string]> = [
    ['裸 base64（没前缀）', 'bW9iaWxlOjE='],
    ['多空格', 'basic     bW9iaWxlOjE='],
    ['制表 + 换行', 'Basic\n\tbW9iaWxlOjE=\n'],
    ['外层引号', '"Basic bW9iaWxlOjE="'],
    ['单引号', "'bW9iaWxlOjE='"],
    ['整行头', 'Authorization: Basic bW9iaWxlOjE='],
    ['双前缀', 'Basic Basic bW9iaWxlOjE='],
    ['没分隔符的前缀', 'BasicbW9iaWxlOjE='],
    ['冒号当分隔符', 'basic:bW9iaWxlOjE='],
    ['base64 中间夹空格（抄断/换行）', 'bW9iaWxl OjE='],
    ['零宽字符', 'Basic bW9iaWxl\u200bOjE='],
    ['全角空格', 'Basic\u3000bW9iaWxlOjE='],
    ['到处都是空白', '  basic \n  bW9iaWxlOjE=  \n '],
  ];
  for (const [name, input] of cases) {
    const r = normalizeAuthorization(input);
    assert.equal(r.ok, true, `${name} 该被接住`);
    assert.equal(r.value, want, `${name} 归一结果不对`);
  }
  // 空的不行；只有 scheme 也不行
  assert.equal(normalizeAuthorization('   ').ok, false);
  assert.equal(normalizeAuthorization('Basic   ').ok, false);
  // 认不出来的**报错**（不硬塞一个猜测的形状）
  const bad = normalizeAuthorization('这不是 base64');
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /认不出|形状/);
});

test('凭据：贴**明文** `pc:手机号:token|…` 会自动编成 Basic', () => {
  const plain = 'pc:19142492716:3ybfyHGZ|1|RCS|1796100727482|abc';
  const r = normalizeAuthorization(plain);
  assert.equal(r.ok, true);
  assert.equal(r.value, `Basic ${Buffer.from(plain, 'utf8').toString('base64')}`);
  // 编出来的这串能解回去，而且手机号认得出来
  const back = Buffer.from(r.value!.slice('Basic '.length), 'base64').toString('utf8');
  assert.equal(back, plain);
});

test('`h5Headers`：`jwttoken` 只在给了票时才加，且头名小写', () => {
  const noJwt = h5Headers(SIGN_IN_RECIPE, 'r', undefined, 'true');
  assert.equal(noJwt.jwttoken, undefined);
  const withJwt = h5Headers(SIGN_IN_RECIPE, 'r', 'J', 'true');
  assert.equal(withJwt.jwttoken, 'J');
  assert.equal(withJwt.jwtToken, undefined, '不能驼峰化');
});
test('口子给**空串**（= 用真上游）时 URL 仍然是绝对的 —— 2026-10-14 实机踩出来的洞', () => {
  // ⚠ 背景：`loadBaseUrl()` 用 `''` 表示"没配 ⇒ 用真上游"（界面也这么显示），
  //   而构建函数原来写 `base ?? DEFAULT` —— `??` 只挡 `undefined`，空串一路穿到底
  //   ⇒ 拼出**相对 URL**（`/user/querySpecTokenV2`）⇒ 宿主报 `missing uri scheme`，
  //   **换票一步都发不出去**。e2e 里口子指着 mock，所以这个洞一直被挡着。
  const sign = makeSign('0000000000000');
  const cases: Array<{ name: string; url: string }> = [
    { name: 'specToken', url: specTokenRequest(SIGN_IN_RECIPE, 'Basic x', '').url },
    { name: 'timestamp', url: timestampRequest(SIGN_IN_RECIPE, 'https://x/y', '').url },
    { name: 'tyrzLogin', url: tyrzLoginRequest(SIGN_IN_RECIPE, 'SSO', sign, 'https://x/y', '').url },
  ];
  for (const c of cases) {
    assert.match(c.url, /^https:\/\//, `${c.name} 的空串口子必须落到默认主机，实际是 ${c.url}`);
  }
  // 空白同理（界面上手输一个空格是常事）
  assert.match(timestampRequest(SIGN_IN_RECIPE, 'https://x/y', '   ').url, /^https:\/\//);
});
