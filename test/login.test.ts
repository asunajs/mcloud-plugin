// 登录三种（扫码 / 短信 / 账密）协议层的测试。
//
// # 这一层守的是什么
//
// 登录的每个字面量都有实测出处，而**错了不会报错** —— 上游的回应是一个
// 含义模糊的业务码。三个真实的坑（都在文件头写着，这里逐条钉住）：
//
//   1. **设备头缺一个** ⇒ `9999 登录失败！`（看起来像"账号被拒"）
//   2. **设备指纹没持久化** ⇒ 轮询永远停在 `200059541`（看起来像"码过期了"）
//   3. **`x-huawei-channelSrc` 跟着平台变** ⇒ mac 上又是一个 `9999`
//      （它其实是常量；**只有 `x-yun-app-channel` 随平台变**）
//
// 所以这里大量用**逐字段**断言，而不是"能跑通就行"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';

import {
  APP_AUTH_PREFIX,
  CODES,
  HUAWEI_CHANNEL_SRC,
  LOGIN_AES_KEY,
  LOGIN_HOST,
  PASSWORD_HASH_PREFIX,
  PUZZLE_AES_IV,
  PUZZLE_AES_KEY,
  QR_LOGIN_URL,
  QR_TTL_SECONDS,
  SEND_SMS_CODE_PATH,
  SLIDER_PUZZLE_PATH,
  THIRD_LOGIN_PATH,
  appChannel,
  appVersion,
  PC_AUTH_PREFIX,
  applyPoll,
  authFromUserInfo,
  formatAuth,
  maskPhone,
  userDomainIdFrom,
  classifyPoll,
  classifySendSms,
  clientType,
  cpid,
  decryptUserInfo,
  deviceInfo,
  isSuccessCode,
  newPcDeviceId,
  newQrSession,
  newSessionId,
  newSmsRandom,
  newSmsSession,
  parseLoginEnvelope,
  parseSliderPuzzle,
  passwordHash,
  passwordThirdloginBody,
  pcBusinessHeaders,
  pcClient,
  pcHeaders,
  pintype,
  puzzleVerfycodeEncrypt,
  qrExpired,
  qrExpiresAt,
  qrPayload,
  qrThirdloginBody,
  sendSmsCodeBody,
  sendSmsCodeBodyWithSlider,
  sendSmsCodeRequest,
  sliderAnswer,
  sliderPuzzleBody,
  sliderPuzzleRequest,
  smsThirdloginBody,
  thirdloginRequest,
  userAgent,
} from '../src/mcloud/login.ts';

const WIN = pcClient('windows', 'AABBCCDDEEFF00112233445566778899-ENDIN');
const MAC = pcClient('macos', 'AABBCCDDEEFF00112233445566778899-ENDIN');

// ══════════════════════════════ 平台档案 ══════════════════════════════

test('平台参数：windows / macos 的 clientType、cpid、version 各是一套', () => {
  assert.equal(clientType(WIN), '656');
  assert.equal(clientType(MAC), '710');
  assert.equal(cpid(WIN), '277');
  assert.equal(cpid(MAC), '332');
  assert.equal(appVersion(WIN), '8.8.6.20260829');
  assert.equal(appVersion(MAC), '4.2.1');
});

test('⚠ `x-huawei-channelSrc` 是**常量**，不随平台变（这里错过的那个）', () => {
  // 曾经让它与 appChannel 取同一个值 ⇒ mac 会发出 10301000。
  // 而它是登录必需的 5 个头之一，发错值上游回 `9999 登录失败！` ——
  // 看不出是头的问题。证据是客户端源码里那一行**字面量**。
  assert.equal(pcHeaders(WIN)['x-huawei-channelSrc'], '10200153');
  assert.equal(pcHeaders(MAC)['x-huawei-channelSrc'], '10200153');
  assert.equal(HUAWEI_CHANNEL_SRC, '10200153');
  // **只有** appChannel 随平台变
  assert.equal(appChannel(WIN), '10200153');
  assert.equal(appChannel(MAC), '10301000');
});

test('⚠ 登录只发那 5 个头，`x-yun-app-channel` **不在里面**', () => {
  // 上一版多发了一个 x-yun-app-channel：把"登录前/登录后两套头"合并成一套。
  // 合并的后果**不是报错**，而是登录请求多带一个上游没预期的头 —— 静默的错。
  const h = pcHeaders(WIN);
  assert.deepEqual(Object.keys(h).sort(), [
    'x-DeviceInfo',
    'x-MM-Source',
    'x-UserAgent',
    'x-huawei-channelSrc',
    'x-yun-client-info',
  ]);
  assert.ok(!('x-yun-app-channel' in h), '登录请求不该带 x-yun-app-channel');
  // 登录**后**那套才是 5 + 1
  assert.equal(pcBusinessHeaders(WIN)['x-yun-app-channel'], '10200153');
  assert.equal(Object.keys(pcBusinessHeaders(WIN)).length, 6);
});

test('⚠ `x-yun-client-info` 与 `x-DeviceInfo` 是**两个头、同一个值**', () => {
  // 不是笔误：客户端源码里就是两行 setRequestHeader（大小写不同）
  const h = pcHeaders(WIN);
  assert.equal(h['x-yun-client-info'], h['x-DeviceInfo']);
  assert.ok(h['x-yun-client-info']!.includes(WIN.deviceId), '设备信息串里要有设备指纹');
});

test('设备信息串：14 段，第 3 段是版本、第 6 段是设备指纹', () => {
  const seg = deviceInfo(WIN).split('|');
  assert.equal(seg.length, 14, `段数不对：${seg.length}`);
  assert.equal(seg[0], '');
  assert.equal(seg[1], '');
  assert.equal(seg[2], '11');
  assert.equal(seg[3], appVersion(WIN), '第 3 段就是平台差异所在');
  assert.equal(seg[4], 'PC');
  assert.equal(seg[6], WIN.deviceId, '第 6 段是设备指纹（明文，不是 base64）');
  // mac 只有第 3 段不同（其余复用同一份"原生接口兜底"模板 —— 已知的保真缺口）
  const mseg = deviceInfo(MAC).split('|');
  assert.equal(mseg[3], '4.2.1');
  assert.deepEqual(
    mseg.filter((_, i) => i !== 3),
    seg.filter((_, i) => i !== 3),
    '除了第 3 段，两平台应该完全一样',
  );
});

test('UA 反映平台（客户端自己就靠 UA 里的 mac 判断平台）', () => {
  assert.ok(userAgent(WIN).includes('Windows NT'));
  assert.ok(userAgent(MAC).includes('Macintosh'));
  assert.ok(!userAgent(WIN).includes('Macintosh'));
});

// ══════════════════════════════ 随机量 ══════════════════════════════

test('设备指纹：32 位大写 hex + `-ENDIN`', () => {
  const d = newPcDeviceId();
  assert.match(d, /^[0-9A-F]{32}-ENDIN$/, `形态不对：${d}`);
});

test('`sID`：32 位**大写**十六进制', () => {
  assert.match(newSessionId(), /^[0-9A-F]{32}$/);
});

test('⚠ 发码的 `random`：24 位**小写**十六进制（不是 UUID）', () => {
  // 客户端源码里它是两段 `Math.random().toString(16).substring(2)` 拼出来的。
  // 长度（24）与字符集（小写 hex）**都由服务端校验** ——
  // 换成 UUID 会得到 36 字符带连字符的串，形态就不对了。
  const r = newSmsRandom();
  assert.match(r, /^[0-9a-f]{24}$/, `形态不对：${r}`);
});

test('两次生成不一样（不是常量）', () => {
  assert.notEqual(newSessionId(), newSessionId());
  assert.notEqual(newPcDeviceId(), newPcDeviceId());
  assert.notEqual(newSmsRandom(), newSmsRandom());
});

// ══════════════════════════════ 二维码 ══════════════════════════════

test('二维码载荷：四段 query 拼在 `#/qrcLogin` 之后，**不发任何请求**', () => {
  const sid = 'FFEEDDCCBBAA99887766554433221100';
  const url = qrPayload(WIN, sid);
  assert.ok(url.startsWith(`${QR_LOGIN_URL}?`), url);
  assert.ok(url.includes(`dID=${WIN.deviceId}`), 'dID 必须是设备指纹');
  assert.ok(url.includes(`sID=${sid}`), 'sID 就是后面 thirdlogin 的 dycpwd');
  assert.ok(url.includes('cType=11'), 'cType=11 是 PC 端固定值');
  assert.ok(url.includes(`ver=${appVersion(WIN)}`), 'ver 跟平台版本走');
});

// ══════════════════════════════ 登录方式 ══════════════════════════════

test('pintype：扫码 21 / 短信 5 / 账密 9；ifOpenAccount 只有短信是 1', () => {
  assert.equal(pintype('qr'), '21');
  assert.equal(pintype('sms'), '5');
  assert.equal(pintype('password'), '9');
  assert.equal(qrThirdloginBody(WIN, 'S')['extInfo']!['ifOpenAccount' as never], 0);
  assert.equal(smsThirdloginBody(WIN, '13800000000', '123456')['extInfo']!['ifOpenAccount' as never], 1);
});

test('⚠ `thirdlogin` 请求体按 JSON key **字典序**，且三种方式共用同一个形状', () => {
  const keys = Object.keys(qrThirdloginBody(WIN, 'S'));
  assert.deepEqual(keys, [
    'clientType',
    'cpid',
    'dycpwd',
    'extInfo',
    'loginMode',
    'msisdn',
    'pintype',
    'verType',
    'version',
  ]);
  // 三种方式的 key 集合必须完全一致（差异只该在值上）
  assert.deepEqual(Object.keys(smsThirdloginBody(WIN, 'p', 'c')), keys);
  assert.deepEqual(Object.keys(passwordThirdloginBody(WIN, 'u', 'p')), keys);
});

test('三种方式的**值**差异：dycpwd 与 msisdn 各是什么', () => {
  // 扫码：dycpwd = sID 原样，msisdn 空
  const qr = qrThirdloginBody(WIN, 'SID-1');
  assert.equal(qr['dycpwd'], 'SID-1');
  assert.equal(qr['msisdn'], '');
  // 短信：dycpwd = **6 位明文验证码**（不是哈希），msisdn = 手机号
  const sms = smsThirdloginBody(WIN, '13800000000', '123456');
  assert.equal(sms['dycpwd'], '123456');
  assert.equal(sms['msisdn'], '13800000000');
  // 账密：dycpwd = **哈希**，msisdn = 用户名
  const pwd = passwordThirdloginBody(WIN, '13800000000', '123456');
  assert.equal(pwd['dycpwd'], passwordHash('123456'));
  assert.equal(pwd['msisdn'], '13800000000');
  assert.equal(pwd['verType'], '2');
  assert.equal(pwd['loginMode'], '0');
});

// ══════════════════════════════ 口令哈希 ══════════════════════════════

test('⚠ 口令哈希 = `SHA1("fetion.com.cn:" + 口令)` 的**大写** hex', () => {
  assert.equal(PASSWORD_HASH_PREFIX, 'fetion.com.cn:');
  // 期望值由 Node 的 crypto 独立算出（不是"跑一遍看看是多少"）
  assert.equal(passwordHash('123456'), '871D0A9E95ABA22B4604224CFBA24E605FABBC34');
  assert.equal(passwordHash('a'), '93A4C900797A150487A2949E37A4F77FDC2B98E3');
  assert.equal(passwordHash(''), 'E645623F1F75C2A21B61B6D0723A2B8AB2A7566D');
  // 大写是协议要求（客户端 encryptByHash 取 toUpperCase）
  assert.equal(passwordHash('123456'), passwordHash('123456').toUpperCase());
  // 前缀确实参与了（不是裸 SHA1）
  assert.notEqual(passwordHash('123456'), '7C4A8D09CA3762AF61E59520943DC26494F8941B');
});

// ══════════════════════════════ 滑块 ══════════════════════════════

test('⚠ 滑块答案加密：AES-128-CBC/PKCS7，输出 `base64(IV ‖ 密文)`', () => {
  assert.equal(PUZZLE_AES_KEY, 'CREATPUZZLE03F9A');
  assert.equal(PUZZLE_AES_IV, 'E526E1F3F9765444');
  // 期望值由 Node 的 crypto 独立算出
  assert.equal(puzzleVerfycodeEncrypt('461'), 'RTUyNkUxRjNGOTc2NTQ0NPXSgBfdneawSGgfCa/g/Rg=');
});

test('⚠ 带滑块的发码体：字段名是 `puzzleVerfycode`（`verfy` 不是 `verify`）', () => {
  // 客户端源码在这里专门写了句「大坑！！！」—— 拼错的表现是服务端解不开。
  const body = sendSmsCodeBodyWithSlider(WIN, '13800000000', 'a'.repeat(24), '461');
  assert.ok('puzzleVerfycode' in body, `字段名不对：${Object.keys(body).join(',')}`);
  assert.ok(!('puzzleVerifycode' in body), '拼成 verifycode 是那个"大坑"');
  // 基础字段一个不少
  assert.equal(body['phoneNumber'], '13800000000');
  assert.equal(body['mode'], 0);
  assert.equal(body['reqType'], 3);
  assert.equal(body['clientType'], clientType(WIN));
});

test('基础发码体：`mode` / `reqType` 是固定值，不暴露成参数', () => {
  const body = sendSmsCodeBody(WIN, '13800000000', 'b'.repeat(24));
  assert.deepEqual(body, {
    phoneNumber: '13800000000',
    random: 'b'.repeat(24),
    mode: 0,
    reqType: 3,
    clientType: '656',
  });
});

test('取滑块体：`{account, type:2}`；路径是 `verfycode`（没有 i）', () => {
  assert.deepEqual(sliderPuzzleBody('13800000000'), { account: '13800000000', type: 2 });
  assert.equal(SLIDER_PUZZLE_PATH, '/user/verfycode');
  assert.ok(!SLIDER_PUZZLE_PATH.includes('verifycode'), '拼成 verifycode 就错了');
});

test('`parseSliderPuzzle` → `sliderAnswer` 闭环：解出来就是答案（**不需要图像识别**）', () => {
  const answer = '461';
  const env = parseLoginEnvelope(
    JSON.stringify({
      code: '0000',
      data: {
        picture: 'JPEG-BASE64',
        puzzle: 'PUZZLE-BASE64',
        picWidth: '640', // ⚠ 上游给的是**字符串**
        puzzleWidth: 44, // 也容忍数字
        puzzleLeft: puzzleVerfycodeEncrypt(answer),
      },
    }),
  );
  const p = parseSliderPuzzle(env);
  assert.equal(p.backgroundB64, 'JPEG-BASE64');
  assert.equal(p.picWidth, 640);
  assert.equal(p.puzzleWidth, 44);
  assert.equal(sliderAnswer(p), answer);
});

test('`sliderAnswer` 的自检：不是十进制数 / 超出图宽都要报错', () => {
  const mk = (enc: string, width: number | null) => ({
    backgroundB64: 'x',
    puzzleB64: 'y',
    picWidth: width,
    puzzleWidth: null,
    leftEncrypted: enc,
  });
  // 坐标超出图宽 ⇒ 报错（宁可报错也不要发一个荒谬的坐标上去 ——
  // 那会被判滑块失败，而**失败次数是有限的**）
  assert.throws(() => sliderAnswer(mk(puzzleVerfycodeEncrypt('9999'), 640)), /超出图宽/);
  // 解出来不是数字 ⇒ 报错
  assert.throws(
    () => sliderAnswer(mk(puzzleVerfycodeEncrypt('abc'), null)),
    /不是十进制数/,
  );
  // 正常范围不报
  assert.equal(sliderAnswer(mk(puzzleVerfycodeEncrypt('0'), 640)), '0');
});

test('`parseSliderPuzzle` 缺字段要**报错并说出字段名**（别返回空图）', () => {
  const withData = (data: unknown) => parseLoginEnvelope(JSON.stringify({ code: '0000', data }));
  assert.throws(() => parseSliderPuzzle(withData({ puzzle: 'p', puzzleLeft: 'l' })), /缺少 picture/);
  assert.throws(
    () => parseSliderPuzzle(withData({ picture: '', puzzle: 'p', puzzleLeft: 'l' })),
    /缺少 picture/,
  );
  assert.throws(() => parseSliderPuzzle(withData(null)), /没有 data/);
});

// ══════════════════════════════ 信封与归类 ══════════════════════════════

test('⚠ `code` 可能是数字也可能是字符串，两种都要归一', () => {
  assert.equal(parseLoginEnvelope('{"code":"0000"}').code, 0);
  assert.equal(parseLoginEnvelope('{"code":0}').code, 0);
  assert.equal(parseLoginEnvelope('{"code":"200059541"}').code, 200_059_541);
  assert.equal(parseLoginEnvelope('{"code":200059541}').code, 200_059_541);
  assert.equal(parseLoginEnvelope('{"code":"9999"}').code, 9999);
  // 非数字文本 ⇒ null（不是 0 —— 0 是**成功**）
  assert.equal(parseLoginEnvelope('{"code":"abc"}').code, null);
  assert.equal(parseLoginEnvelope('{}').code, null);
  // 原始文本要保住（排障用：归一化会丢掉 `"0000"` 的形态）
  assert.equal(parseLoginEnvelope('{"code":"0000"}').rawCode, '0000');
});

test('`message` 与 `msg` 两个键名都认', () => {
  assert.equal(parseLoginEnvelope('{"code":1,"message":"甲"}').message, '甲');
  assert.equal(parseLoginEnvelope('{"code":1,"msg":"乙"}').message, '乙');
});

test('不是 JSON 要报错（别当成"空响应"）', () => {
  assert.throws(() => parseLoginEnvelope('<html>502</html>'), /不是 JSON/);
});

test('`isSuccessCode`：0 与 200 都算成功', () => {
  assert.ok(isSuccessCode(0));
  assert.ok(isSuccessCode(200));
  assert.ok(!isSuccessCode(null));
  assert.ok(!isSuccessCode(9999));
  assert.ok(!isSuccessCode(200_059_541));
});

test('⚠ `classifyPoll` 六个分支逐条', () => {
  const c = (code: number | string, data?: unknown) =>
    classifyPoll(parseLoginEnvelope(JSON.stringify({ code, data })));

  assert.equal(c(CODES.QR_NOT_SCANNED).kind, 'not-scanned');
  assert.equal(c(CODES.QR_SCANNED).kind, 'scanned');
  assert.equal(c(CODES.QR_MISMATCH).kind, 'session-mismatch');
  assert.equal(c(CODES.QR_EXPIRED).kind, 'expired');
  assert.equal(c(CODES.QR_TOO_FREQUENT).kind, 'too-frequent');

  // 成功必须**带着密文**回来
  const ok = c(0, 'DEADBEEF');
  assert.equal(ok.kind, 'success');
  assert.equal(ok.kind === 'success' ? ok.encrypted : '', 'DEADBEEF');

  // ⚠ 成功码但 data 不是字符串 ⇒ 如实报"形状不对"，**不伪造空凭据**
  const weird = c(0, { token: 'x' });
  assert.equal(weird.kind, 'other');
  assert.ok(weird.kind === 'other' && weird.message.includes('密文字符串'));

  // 未知码原样带回（上游在活动期会加新码，别硬编码成错误）
  const unknown = c(123_456);
  assert.equal(unknown.kind, 'other');
  assert.equal(unknown.kind === 'other' ? unknown.code : null, 123_456);
});

test('⚠ `classifySendSms`：已发出 / 要滑块 / 滑块作废 三分支', () => {
  const c = (code: number | string, data?: unknown) =>
    classifySendSms(parseLoginEnvelope(JSON.stringify({ code, data })));

  const sent = c(0, { remainGetTimes: 4 });
  assert.equal(sent.kind, 'sent');
  assert.equal(sent.kind === 'sent' ? sent.remainGetTimes : null, 4);

  const need = c(CODES.NEED_SLIDER, { captchaType: 2 });
  assert.equal(need.kind, 'need-slider');
  assert.equal(need.kind === 'need-slider' ? need.captchaType : null, 2);

  // ⚠ 滑块挑战作废 ⇒ **必须重新取图**，不能复用旧挑战
  const dead = c(CODES.SLIDER_EXHAUSTED, { captchaType: 2 });
  assert.equal(dead.kind, 'slider-exhausted');
  // 与 need-slider 是**不同**的分支（混成一个的表现是复用一张已作废的图，
  // 然后一直失败到把配额烧光）
  assert.notEqual(dead.kind, need.kind);

  assert.equal(c(9441, undefined).kind, 'other');
});

// ══════════════════════════════ 会话推进 ══════════════════════════════

test('⚠ 未扫码**不是错误**（当成错误会拿异常做流程控制，日志也会被刷满）', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  const r = applyPoll(s, { kind: 'not-scanned' }, 2000);
  assert.equal(r.ok, true);
  assert.equal(r.stop, false, '要继续轮询');
  assert.equal(r.session.scanned, false);
});

test('已扫码 ⇒ 提示用户去手机上确认（唯一值得对外提示进度的中间态）', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  const r = applyPoll(s, { kind: 'scanned' }, 2000);
  assert.equal(r.ok, true);
  assert.equal(r.stop, false);
  assert.equal(r.session.scanned, true);
  assert.ok(r.note.includes('确认'), r.note);
});

test('成功 ⇒ 停，并把密文带出来', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  const r = applyPoll(s, { kind: 'success', encrypted: 'CT' }, 2000);
  assert.equal(r.stop, true);
  assert.equal(r.ok, true);
  assert.equal(r.session.done, true);
  assert.equal(r.encrypted, 'CT');
});

test('⚠ 限流 ⇒ 停，但**不换码**（换码会再吃一次限流）', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  const r = applyPoll(s, { kind: 'too-frequent' }, 2000);
  assert.equal(r.ok, true, '限流不是"登录失败"，不该标红');
  assert.equal(r.stop, true, '要停下来让用户等，而不是继续轮');
  assert.ok(r.note.includes('不要重新出码'), r.note);
  assert.equal(r.session.sessionId, s.sessionId, '不许换 sID');
});

test('过期 / 会话错位 ⇒ 停且标失败，提示**重新出码**', () => {
  for (const kind of ['expired', 'session-mismatch'] as const) {
    const r = applyPoll(newQrSession(WIN.deviceId, 1000), { kind }, 2000);
    assert.equal(r.stop, true, kind);
    assert.equal(r.ok, false, kind);
    assert.ok(r.note.includes('重新出码'), `${kind}: ${r.note}`);
  }
});

test('二维码 TTL：120 秒，`qrExpired` 按开始时刻算', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  assert.equal(qrExpiresAt(s), 1000 + QR_TTL_SECONDS * 1000);
  assert.equal(qrExpired(s, 1000 + 119_999), false);
  assert.equal(qrExpired(s, 1000 + 120_000), true);
});

test('⚠ 会话的 `deviceId` 与 `sessionId` 都要在里面（丢了任何一个轮询都会卡住）', () => {
  const s = newQrSession(WIN.deviceId, 1000);
  assert.equal(s.deviceId, WIN.deviceId, '设备指纹丢了 ⇒ 永远 200059541');
  assert.match(s.sessionId, /^[0-9A-F]{32}$/);
  assert.equal(s.done, false);
});

test('短信会话：手机号 + 24 位小写 hex 的 random', () => {
  const s = newSmsSession('13800000000', 1000);
  assert.equal(s.phone, '13800000000');
  assert.match(s.random, /^[0-9a-f]{24}$/);
  assert.equal(s.sent, false);
  assert.equal(s.slider, null);
});

// ══════════════════════════════ 请求构造 ══════════════════════════════

test('请求构造：路径、方法、头（设备头 + tid + content-type）', () => {
  const req = thirdloginRequest(WIN, 'tid-1', qrThirdloginBody(WIN, 'S'));
  assert.equal(req.url, `${LOGIN_HOST}${THIRD_LOGIN_PATH}`);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-yun-tid'], 'tid-1');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.ok(req.headers['x-yun-client-info'], '设备头一个都不能少');
  assert.equal(req.headers['x-UserAgent'], 'PC');
  assert.ok(!('x-yun-app-channel' in req.headers));
});

test('三个请求构造器各自的路径', () => {
  assert.equal(
    sendSmsCodeRequest(WIN, 't', {}).url,
    `${LOGIN_HOST}${SEND_SMS_CODE_PATH}`,
  );
  assert.equal(
    sliderPuzzleRequest(WIN, 't', {}).url,
    `${LOGIN_HOST}${SLIDER_PUZZLE_PATH}`,
  );
  assert.equal(THIRD_LOGIN_PATH, '/user/thirdlogin');
  assert.equal(SEND_SMS_CODE_PATH, '/user/sms/getSmsCode');
});

test('⚠ 登录主机**可以指到别处**（指到 mock；指不到的话 CI 会打真上游）', () => {
  const req = thirdloginRequest(WIN, 't', {}, 'http://127.0.0.1:19001');
  assert.equal(req.url, `http://127.0.0.1:19001${THIRD_LOGIN_PATH}`);
  // 尾部斜杠要容忍（配置里多打一个不该拼出 `//user/thirdlogin`）
  const req2 = thirdloginRequest(WIN, 't', {}, 'http://127.0.0.1:19001/');
  assert.equal(req2.url, `http://127.0.0.1:19001${THIRD_LOGIN_PATH}`);
});

test('登录主机与云盘业务主机不是同一台（所以它要自己的配置口子）', () => {
  assert.ok(LOGIN_HOST.includes('user-njs'), LOGIN_HOST);
  assert.ok(!LOGIN_HOST.includes('m.mcloud.139.com'), '别把它写成业务主机');
});

// ══════════════════════════════ 成功响应解密 ══════════════════════════════

test('⚠ 登录数据的解密是 **ECB**（不是 CBC）—— 模式用错会"解出来是乱码"', () => {
  const info = { userInfo: { msisdn: '13800000000', nickname: '甲' } };
  const c = createCipheriv('aes-128-ecb', Buffer.from(LOGIN_AES_KEY, 'utf8'), null);
  const ct = Buffer.concat([c.update(JSON.stringify(info), 'utf8'), c.final()]);
  assert.deepEqual(decryptUserInfo(ct.toString('hex')), info);

  // 用错密钥必须**报错**，而不是返回一段乱码。
  // ⚠ 具体报哪一条取决于填充碰巧合不合法：多数落在 PKCS7 填充校验，
  //   偶尔填充合法但 JSON 解不开。两条都算「报错了」，所以两个都收。
  assert.throws(() => decryptUserInfo(ct.toString('hex'), '2ErfJus1Ofr@2o24'), /填充|乱码|JSON/);
});



// ══════════════════════════════ 凭据 ══════════════════════════════

test('⚠ 凭据是 `Basic base64("pc:<手机号>:<authToken>")` —— 前缀只有一个来源', () => {
  assert.equal(PC_AUTH_PREFIX, 'pc');
  assert.equal(APP_AUTH_PREFIX, 'mobile');
  const a = formatAuth('pc', '13800000000', 'TOK');
  assert.equal(a, `Basic ${Buffer.from('pc:13800000000:TOK', 'utf8').toString('base64')}`);
  // 前缀不给默认值 ⇒ 套错了会看得出来
  assert.notEqual(formatAuth('mobile', '13800000000', 'TOK'), a);
  // 缺一个就报错（别拼出一个 `Basic base64("pc::")` 那种看着像好的东西）
  assert.throws(() => formatAuth('pc', '', 'TOK'), /缺少账号/);
  assert.throws(() => formatAuth('pc', '13800000000', ''), /缺少账号/);
});

test('`authFromUserInfo`：两个字段都必须是**非空字符串**', () => {
  assert.equal(
    authFromUserInfo({ account: '13800000000', authToken: 'TOK' }),
    formatAuth('pc', '13800000000', 'TOK'),
  );
  // 数字类型要报错，不是"宽容地转成字符串" ——
  // 上游从来都是字符串，容忍它只会让"上游改了类型"静默通过
  assert.throws(() => authFromUserInfo({ account: 138, authToken: 'TOK' }), /缺少字段 account/);
  assert.throws(() => authFromUserInfo({ account: '138', authToken: '' }), /缺少字段 authToken/);
  assert.throws(() => authFromUserInfo({}), /缺少字段 account/);
});

test('手机号掩码：前 2 + `****` + 后 2；短号原样返回', () => {
  assert.equal(maskPhone('19900000001'), '19****01');
  assert.equal(maskPhone('13800000000'), '13****00');
  // ⚠ 短号原样返回：掩码成 `****` 会让"这是个短号"这件事消失，
  //   而短号只可能来自脏数据，原样显示更利于排查
  assert.equal(maskPhone('123'), '123');
  assert.equal(maskPhone(''), '');
});

test('`userDomainIdFrom`：只有登录响应里有它，取不到就是空串', () => {
  assert.equal(userDomainIdFrom({ userDomainId: 'D-1' }), 'D-1');
  assert.equal(userDomainIdFrom({ userDomainId: 1 }), '', '类型不对当没有，别猜');
  assert.equal(userDomainIdFrom({}), '');
});
