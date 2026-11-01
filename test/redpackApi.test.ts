// 红包派对的**协议层**：签名、头、信封。
//
// 这一层要钉住的都是"看不见就会写错、而且写错了只会得到一个含糊的拒绝"的东西：
//
//   · 签名的**五项顺序**（`requestId + appId + token + salt + timestamp`，中间没分隔符）
//     —— 判据不能是我们自己的 `md5Hex`，否则改错顺序时测试跟着一起改，永远不红；
//     所以这里同时对照 **Node 自带的 md5** 与一个**手算好写死的摘要**。
//   · `tokenValidate` 的 `version` 是 `1.0`，其余 16 条是 `SYS_CONFIG_Y`
//     —— 参照实现那里是"两次展开、后面那次赢"才得到的，一眼看不出来。
//   · 换票那一枪的头里 `token` 与签名都按**空串**算（票还没有，签名却按有票算 ⇒ 上游拒）。
//   · 判成功看 `String(header.status)==="200"`，**不是**签到族那套 `code`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  REDPACK_APP_ID,
  REDPACK_BASE,
  REDPACK_SIGN_SALT,
  REDPACK_SSO_SOURCE_ID,
  REDPACK_TOKEN_VALIDATE_VERSION,
  REDPACK_VERSION,
  accountInfoRequest,
  callRedpack,
  makeRedpackCall,
  parseRedpackEnvelope,
  redpackError,
  redpackHeaders,
  redpackSign,
  redpackUrl,
  taskListRequest,
  tokenValidateRequest,
} from '../src/mcloud/redpackApi.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW_MS = 1_700_000_000_000;
const REQ_ID = '202610231200001700000000000abcdef12';
const RAND = '0123456789abcdef';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

test('签名：五项顺序由 Node 的 md5 与写死的摘要共同钉住', () => {
  // ① 与**另一个实现**对拍（不是拿 `md5Hex` 自证）
  assert.equal(
    redpackSign(REQ_ID, 'TKN', NOW_MS),
    md5(`${REQ_ID}${REDPACK_APP_ID}TKN${REDPACK_SIGN_SALT}${String(NOW_MS)}`),
  );
  // ② 写死的摘要：改顺序 / 少一项 / 加分隔符，这一条会红而 ① 不会
  assert.equal(redpackSign(REQ_ID, 'TKN', NOW_MS), 'bf201e182b662a57fd0a11f693fef21c');
  // ③ 空 token 也钉住（换票那一枪用的就是它）
  assert.equal(redpackSign(REQ_ID, '', NOW_MS), 'c8e4c8f3feee7ee10251ff0afdb4a413');
  // ④ 那颗盐就是 `md5("123456")` —— 参照实现里明文写死的值，钉住它免得被人"顺手换成随机串"
  assert.equal(REDPACK_SIGN_SALT, md5('123456'));
});

test('头：十枚都在，且时间戳在签名、`timestamp` 与 `x-DeviceInfo` 三处是同一个值', () => {
  const call = makeRedpackCall('TKN', NOW_MS, { requestId: REQ_ID, deviceRand: RAND });
  const h = redpackHeaders(call);
  assert.equal(h.appId, REDPACK_APP_ID);
  assert.equal(h.token, 'TKN');
  assert.equal(h.sign, redpackSign(REQ_ID, 'TKN', NOW_MS));
  assert.equal(h.timestamp, String(NOW_MS));
  assert.equal(h.requestId, REQ_ID);
  assert.equal(h.xChannelSrc, 'red-mcloudapp-001');
  // `x-DeviceInfo` = 固定中段 + 同一个时间戳 + 随机串 + 固定尾
  const deviceInfo = h['x-DeviceInfo'] ?? '';
  const origin = h['x-origin'] ?? '';
  const ua = h['user-agent'] ?? '';
  assert.ok(deviceInfo.includes(`|${String(NOW_MS)}${RAND}|||375X667|zh||`));
  assert.ok(origin.startsWith('https://cpactiv.buy.139.com/#/redEnvelopeParty/home'));
  assert.equal(h.Referer, 'https://cpactiv.buy.139.com/');
  assert.equal(h.Origin, 'https://cpactiv.buy.139.com');
  // 传输层那枚 Android UA 与 `x-DeviceInfo` 里那枚 iPad UA 是**两回事**，两枚都要发
  assert.match(ua, /Android 14/);
  // `deviceid` 只有给了才带（换票那一枪带，其余不带）
  assert.equal('deviceid' in h, false);
  assert.equal(redpackHeaders(call, 'DEV-1').deviceid, 'DEV-1');
});

test('`makeRedpackCall` 注入 inputs 时整条请求可复现', () => {
  const a = makeRedpackCall('TKN', NOW_MS, { requestId: REQ_ID, deviceRand: RAND });
  const b = makeRedpackCall('TKN', NOW_MS, { requestId: REQ_ID, deviceRand: RAND });
  assert.deepEqual(a, b);
  // 不注入时随机段每次都不同（防重放用，不参与判据）
  const c = makeRedpackCall('TKN', NOW_MS);
  assert.notEqual(c.requestId, makeRedpackCall('TKN', NOW_MS).requestId);
  assert.ok(c.requestId.includes(String(NOW_MS)), 'requestId 里要含那段毫秒，且与 timestamp 同源');
});

test('换票那一枪：头与签名按空 token 算，体里的 `version` 是 1.0', () => {
  const call = makeRedpackCall('TKN', NOW_MS, { requestId: REQ_ID, deviceRand: RAND });
  const req = tokenValidateRequest(call, 'SSO-TOKEN', 'DEV-1');
  assert.equal(req.url, `${REDPACK_BASE}/user/tokenValidate`);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.token, '');
  assert.equal(req.headers.sign, redpackSign(REQ_ID, '', NOW_MS));
  assert.equal(req.headers.deviceid, 'DEV-1');
  const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
  // ⚠ 这一条**不是** `SYS_CONFIG_Y`（其余 16 条才是）：参照实现那两次展开后者赢
  assert.equal(body.version, REDPACK_TOKEN_VALIDATE_VERSION);
  assert.notEqual(body.version, REDPACK_VERSION);
  assert.equal(body.token, 'SSO-TOKEN', 'SSO 票在**体**里，不在头里');
  assert.equal(body.deviceId, 'DEV-1');
  assert.equal(body.pintype, 13);
  assert.equal(body.loginConfig, 'redpacketLoginConfig');
});

test('其余请求：默认体里带 `SYS_CONFIG_Y`，路径逐字照参照实现', () => {
  const call = makeRedpackCall('TKN', NOW_MS, { requestId: REQ_ID, deviceRand: RAND });
  const list = taskListRequest(call);
  assert.equal(list.url, `${REDPACK_BASE}/redpacket/configTaskLoginList`);
  assert.deepEqual(JSON.parse(list.body ?? '{}'), { version: REDPACK_VERSION });
  const acc = accountInfoRequest(call);
  assert.equal(acc.url, `${REDPACK_BASE}/redpacket/userAccountInfo`);
  assert.deepEqual(JSON.parse(acc.body ?? '{}'), { version: REDPACK_VERSION, platformType: 1 });
  // ⚠ 这一族**不**用签到族的 `toSourceId`：换 SSO 票时用的是它自己那一个
  assert.equal(REDPACK_SSO_SOURCE_ID, '001216');
});

test('基址口子：去尾斜杠、路径不丢', () => {
  assert.equal(redpackUrl(undefined, '/redpacket/userSign'), `${REDPACK_BASE}/redpacket/userSign`);
  assert.equal(
    redpackUrl('http://127.0.0.1:8080/mock/', '/redpacket/userSign'),
    'http://127.0.0.1:8080/mock/redpacket/userSign',
  );
  // 空串 / 全空白 = 用真主机（不能拼出没有 scheme 的相对 URL）
  assert.equal(redpackUrl('   ', '/x'), `${REDPACK_BASE}/x`);
});

test('信封：判成功看 `header.status`，错误文案按 data → header 依次取', () => {
  // 数字 200 与字符串 "200" 都算成功（上游给的是数字，参照实现也是 String 比）
  assert.equal(parseRedpackEnvelope('{"header":{"status":200},"data":{}}').ok, true);
  assert.equal(parseRedpackEnvelope('{"header":{"status":"200"}}').ok, true);
  assert.equal(parseRedpackEnvelope('{"header":{"status":500}}').ok, false);
  // ⚠ 没有 `header` 也不许当成功（签到族那套解析器会在这里悄悄放行）
  assert.equal(parseRedpackEnvelope('{"code":"0000","data":{}}').ok, false);
  // 但 `data` 照样原样给出去 —— 判失败与"能不能读到内容"是两件事，别在这里替调用方丢掉
  assert.deepEqual(parseRedpackEnvelope('{"code":"0000","data":{"canAmount":300}}').data, { canAmount: 300 });

  // 错误文案的优先序：`data.errorMsg` 赢过 `header.errMsg` 赢过 `header.respMsg`
  const env = {
    header: { status: 500, errMsg: 'H1', respMsg: 'R1' },
    data: { errorMsg: 'D1' },
  };
  assert.equal(redpackError(env), 'D1');
  assert.equal(redpackError({ header: { status: 500, errMsg: 'H1', respMsg: 'R1' } }), 'H1');
  assert.equal(redpackError({ header: { status: 500, respMsg: 'R1' } }), 'R1');
  assert.equal(redpackError({ header: { status: 500 } }), '活动站没给原因');
  // `data` 是数组时它没有 errorMsg ⇒ 照样往后两档走
  assert.equal(redpackError({ header: { status: 500, errMsg: 'H2' }, data: [1, 2] }), 'H2');
});

test('非 JSON 的响应不当成功，而且把原文留着', () => {
  const r = parseRedpackEnvelope('<html>502</html>');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不是 JSON/);
  assert.equal(r.raw, '<html>502</html>', '日志要能贴出原文');
});

test('`callRedpack`：HTTP 层失败与业务失败都折成 `ok:false`，正文里的原因不丢', () => {
  const ok: Transport = () => ({ status: 200, headers: {}, body: '{"header":{"status":200},"data":{"token":"T"}}' });
  const env = callRedpack(ok, taskListRequest(makeRedpackCall('TKN', NOW_MS)));
  assert.equal(env.ok, true);
  assert.equal(env.httpError, undefined);

  // 非 200 但正文里有原因（有些活动站把错误写在正文里）
  const bad: Transport = () => ({
    status: 500,
    headers: {},
    body: '{"header":{"status":500},"data":{"errorMsg":"票过期了"}}',
  });
  const e2 = callRedpack(bad, taskListRequest(makeRedpackCall('TKN', NOW_MS)));
  assert.equal(e2.ok, false);
  assert.match(e2.error ?? '', /票过期了/);
  assert.equal(e2.httpError !== undefined, true);

  // 传输层直接失败（宿主回的是 `{"error": …}`，**没有** status / body）
  const down: Transport = () => ({ error: '连不上' });
  const e3 = callRedpack(down, taskListRequest(makeRedpackCall('TKN', NOW_MS)));
  assert.equal(e3.ok, false);
  assert.equal(e3.error, '连不上');
});
