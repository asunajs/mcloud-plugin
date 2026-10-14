// 凭据续期 —— 判据照 mcloud 的 `decide` 逐行抄，输入输出都按它来。
//
// 这里最该盯住的不是"能不能刷"，而是三个**边界**：
//   · 三档里的 `manual-only` 与 `not-yet` 都**不打上游**，但含义完全不同；
//   · `<=` 而不是 `<`（剩余正好等于提前量时算"该刷"）；
//   · 过期段解不出来是 `0`（"该刷"）而不是 `undefined` —— 两者在判据里含义不同。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_CLIENT_TYPE,
  DEFAULT_LEAD_DAYS,
  PC_CLIENT_TYPE,
  applyRefreshResult,
  assertUsable,
  clientTypeFor,
  credentialExpireMs,
  decide,
  daysLeft,
  jwtPayload,
  jwtUserDomainId,
  parseAuthorization,
  parseRefresh,
  rebuildAuthorization,
  refreshRequest,
  runAuthRefresh,
  tokenExpireMs,
} from '../src/mcloud/authRefresh.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import { memStore } from '../src/store/memory.ts';
import { fromBase64, fromUtf8, toBase64, utf8 } from '../src/crypto/bytes.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW_ISO = '2026-10-14T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const cred = (platform: string, phone: string, token: string): string =>
  rebuildAuthorization(platform, phone, token);
const DAY = 86_400_000;

test('`Authorization` 解三段；token 里含冒号也**不许被截断**', () => {
  const raw = cred('mobile', '19100002716', 'tok|en|with|pipes');
  const seg = parseAuthorization(raw);
  assert.deepEqual(seg, { platform: 'mobile', phone: '19100002716', token: 'tok|en|with|pipes' });
  // ⚠ 用 `split(':')` 取 [2] 会在 token 含冒号时悄悄截断 —— 造一个含冒号的
  const tricky = cred('mobile', '19100002716', 'a:b:c');
  assert.equal(parseAuthorization(tricky)!.token, 'a:b:c');
  // 裸 base64（没前缀）也认 —— 落库形状两种都见过
  assert.equal(parseAuthorization(toBase64(utf8('mobile:1:t')))!.platform, 'mobile');
  assert.equal(parseAuthorization('不是 base64 !!'), null);
  assert.equal(parseAuthorization(''), null);
});

test('`rebuildAuthorization` 返回的是**带 `Basic ` 前缀的整串**', () => {
  const out = rebuildAuthorization('mobile', '19100002716', 'TOK');
  assert.ok(out.startsWith('Basic '), '不带上一个会与"刚登录的账号"发出不同的头');
  assert.equal(fromUtf8(fromBase64(out.slice(6))), 'mobile:19100002716:TOK');
});

test('`userDomainId` 藏在 jwttoken 的 **sub** 里（真机 payload 只有 iss/iat/sub/exp）', () => {
  const mk = (payload: Record<string, unknown>): string =>
    ['H', toBase64(utf8(JSON.stringify(payload))), 'S'].join('.').replace(/=+$/, '');
  // 真机形状：顶层没有，sub 是**一段 JSON 文本**
  assert.equal(
    jwtUserDomainId(mk({ iss: 'x', iat: 1, sub: '{"userDomainId":"1125330776486986478"}', exp: 2 })),
    '1125330776486986478',
  );
  // 顶层也认（另一种可能的形态）
  assert.equal(jwtUserDomainId(mk({ userDomainId: 'TOP' })), 'TOP');
  // sub 不是 JSON ⇒ null（不许抛）
  assert.equal(jwtUserDomainId(mk({ sub: 'plain-string' })), null);
  assert.equal(jwtUserDomainId('not-a-jwt'), null);
  assert.equal(jwtUserDomainId(mk({})), null);
  // base64url（`-`/`_`）也要认
  const url = toBase64(utf8(JSON.stringify({ sub: '{"userDomainId":"X"}' })))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(jwtUserDomainId(['H', url, 'S'].join('.')), 'X');
  assert.equal(jwtPayload('nope'), null);
});

test('过期段 = token 的**第 4 段**（竖线分段），解不出是 **0** 不是 undefined', () => {
  assert.equal(tokenExpireMs('a|b|c|1893456000000'), 1893456000000);
  assert.equal(tokenExpireMs('a|b|c|notanumber'), 0, '解不出 ⇒ 0（在判据里 = 该刷）');
  assert.equal(tokenExpireMs('no-pipes-at-all'), 0);
  assert.equal(tokenExpireMs('a|b|c|0'), 0);
  assert.equal(tokenExpireMs('a|b|c|1.9'), 1, '按 f64 解析再截断（照抄原实现）');
  assert.equal(credentialExpireMs('不是凭据'), -1, '解不开 ⇒ -1（= manual-only）');
});

test('⚠ 判据是**三档**，不是"刷/不刷"两档', () => {
  assert.equal(decide(-1, NOW_MS), 'manual-only', '凭据坏了：要重新登录，不是"晚点再刷"');
  assert.equal(decide(0, NOW_MS), 'needed', '没有过期段：当成该刷');
  assert.equal(decide(NOW_MS + 3 * DAY, NOW_MS), 'needed');
  assert.equal(decide(NOW_MS + 30 * DAY, NOW_MS), 'not-yet');
  assert.equal(decide(NOW_MS + 30 * DAY, NOW_MS, 40), 'needed', '提前量给大了就该刷');
});

test('⚠ 边界是 `<=`：剩余**正好**等于提前量时算"该刷"', () => {
  assert.equal(decide(NOW_MS + 10 * DAY, NOW_MS), 'needed', '刚好 10 天 ⇒ 该刷');
  assert.equal(decide(NOW_MS + 10 * DAY + 1, NOW_MS), 'not-yet');
  assert.equal(decide(NOW_MS + DEFAULT_LEAD_DAYS * DAY, NOW_MS), 'needed', '默认提前量也是 10 天');
});

test('`clientType`：App 412、PC 414', () => {
  assert.equal(clientTypeFor('mobile'), APP_CLIENT_TYPE);
  assert.equal(clientTypeFor('pc'), PC_CLIENT_TYPE);
  assert.equal(APP_CLIENT_TYPE, '412');
  assert.equal(PC_CLIENT_TYPE, '414');
});

test('请求体：**键序**照实拍（userDomainId 在前），且值走过转义', () => {
  const req = refreshRequest(cred('mobile', '1', 'T'), '112233', 'mobile');
  assert.equal(req.method, 'POST');
  assert.ok(req.url.endsWith('/user/auth/refreshToken'), req.url);
  assert.equal(req.body, '{"userDomainId":"112233","clientType":"412"}');
  assert.ok(req.body!.indexOf('userDomainId') < req.body!.indexOf('clientType'), '键序反了');
  // 转义：值里有引号也不许把体拼坏
  const weird = refreshRequest(cred('mobile', '1', 'T'), 'a"b', 'mobile');
  assert.equal(JSON.parse(weird.body!).userDomainId, 'a"b');
});

test('⚠ 判成功要看**两处**：success 与 code', () => {
  const ok = parseRefresh('{"success":true,"code":"0000","data":{"token":"NEW","expireTime":2592000}}');
  assert.equal(ok.ok, true);
  assert.equal(ok.result!.token, 'NEW');
  assert.equal(ok.result!.expireSeconds, 2592000);
  // 只看一个会把另一种失败读成成功 —— 这比"明确报失败"糟得多
  assert.equal(parseRefresh('{"success":true,"code":"0001","data":{"token":"X"}}').ok, false, 'success 真但 code 非 0');
  assert.equal(parseRefresh('{"success":false,"code":"0000","data":{"token":"X"}}').ok, false, 'code 0 但 success 假');
  assert.equal(parseRefresh('{"code":"0000"}').ok, false, '没有 data');
  assert.equal(parseRefresh('{"code":"0000","data":{}}').ok, false, 'data 里没有 token');
  assert.equal(parseRefresh('{"code":"0000","data":{"token":""}}').ok, false, 'token 是空串');
  assert.equal(parseRefresh('不是 JSON').ok, false);
  // 数字码也认；msg 与 message 都读过
  assert.equal(parseRefresh('{"code":0,"data":{"token":"X"}}').ok, true);
  assert.match(parseRefresh('{"code":"9","msg":"随便"}').error!, /随便/);
});

test('重拼 + 落库前的兜底校验', () => {
  const raw = cred('mobile', '19100002716', 'OLD');
  const applied = applyRefreshResult(raw, { token: 'NEW' });
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(parseAuthorization(applied.raw)!.token, 'NEW');
    assert.equal(parseAuthorization(applied.raw)!.phone, '19100002716', '手机号要原样保留');
    assert.equal(assertUsable(applied.raw).ok, true);
  }
  // 缺手机号段 ⇒ 拼不回整串（那就不该落库）
  assert.equal(applyRefreshResult(toBase64(utf8('mobile:TOKENONLY')), { token: 'N' }).ok, false);
  assert.equal(assertUsable('Basic ' + toBase64(utf8('::'))).ok, false, '段全空 ⇒ 拒绝落库');
  assert.equal(assertUsable('垃圾').ok, false);
});

test('剩余天数只给文案用；过期段缺失时不给数字（不编）', () => {
  assert.equal(daysLeft(NOW_MS + 3 * DAY, NOW_MS), 3);
  assert.equal(daysLeft(0, NOW_MS), undefined);
  assert.equal(daysLeft(-1, NOW_MS), undefined);
});

// ───────────────────────── 执行体 ─────────────────────────

function mkStore(raw: string) {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, raw, NOW_ISO);
  return store;
}

test('⚠ `not-yet`：**一个请求都不发**（每天跑不等于每天打上游）', () => {
  const store = mkStore(cred('mobile', '19100002716', `a|b|c|${NOW_MS + 30 * DAY}`));
  let sent = 0;
  const out = runAuthRefresh({
    store,
    transport: (() => {
      sent += 1;
      return { status: 200, headers: {}, body: '{}' };
    }) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(sent, 0, '离过期还远却打了上游');
  assert.equal(out.skipped, true);
  assert.match(out.note, /还有 30 天|还远/);
});

test('⚠ `manual-only`：凭据解不开时**也不打上游**，而且说"要重新贴"', () => {
  const store = mkStore('不是凭据');
  let sent = 0;
  const out = runAuthRefresh({
    store,
    transport: (() => {
      sent += 1;
      return { status: 200, headers: {}, body: '{}' };
    }) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(sent, 0);
  assert.equal(out.skipped, true);
  assert.match(out.note, /重新贴/);
  assert.equal(out.ok, true, '这一档不是"任务失败"，是"这事得你做"');
});

test('该刷但手里没有 jwttoken ⇒ 如实失败，且**一个请求都不发**', () => {
  const store = mkStore(cred('mobile', '19100002716', `a|b|c|${NOW_MS + 1 * DAY}`));
  let sent = 0;
  const out = runAuthRefresh({
    store,
    transport: (() => {
      sent += 1;
      return { status: 200, headers: {}, body: '{}' };
    }) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(sent, 0);
  assert.equal(out.ok, false);
  assert.match(out.note, /jwttoken/);
});

test('拿掉凭据：不刷（先贴一份）', () => {
  const store = memStore();
  store.ensureSchema();
  const out = runAuthRefresh({
    store,
    transport: (() => ({ status: 200, headers: {}, body: '{}' })) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(out.skipped, true);
  assert.match(out.note, /先贴/);
});

test('真刷一枪：请求形状对、新凭据落库、且**拒绝落库**路径有效', () => {
  const days = 1;
  const raw = cred('mobile', '19100002716', `a|b|c|${NOW_MS + days * DAY}`);
  const store = mkStore(raw);
  // 造一枚带 userDomainId 的 jwttoken（`sub` 是 JSON 文本 —— 真机的形状）
  const payload = toBase64(utf8(JSON.stringify({ sub: JSON.stringify({ userDomainId: '112233' }) })))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  store.setState('mcloud.h5.jwt', JSON.stringify({ at: NOW_ISO, jwt: `H.${payload}.S` }), NOW_ISO);

  const sent: BuiltRequest[] = [];
  const out = runAuthRefresh(
    {
      store,
      transport: ((req: BuiltRequest) => {
        sent.push(req);
        return {
          status: 200,
          headers: {},
          body: '{"success":true,"code":"0000","data":{"token":"BRANDNEW","expireTime":2592000}}',
        };
      }) as never,
      nowIso: NOW_ISO,
      baseUrl: undefined,
    },
    true, // force
  );
  assert.equal(out.ok, true, out.note);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!.body!).userDomainId, '112233');
  assert.equal(sent[0]!.headers.Authorization, raw, '续期要用**当前**那条证明身份');
  const neu = store.getState(STATE_AUTH)!;
  assert.equal(parseAuthorization(neu)!.token, 'BRANDNEW');
  assert.equal(parseAuthorization(neu)!.phone, '19100002716');
  assert.notEqual(neu, raw);
  assert.ok(store.getState('mcloud.auth.refresh.last'), '留了流水（只记指纹，不记凭据）');
  assert.equal(
    store.getState('mcloud.auth.refresh.last')!.includes('BRANDNEW'),
    false,
    '⚠ 不许把新凭据写进流水',
  );
});

test('上游回失败 ⇒ 不落库（旧凭据原样留着）', () => {
  const raw = cred('mobile', '19100002716', `a|b|c|${NOW_MS}`);
  const store = mkStore(raw);
  const payload = toBase64(utf8(JSON.stringify({ sub: '{"userDomainId":"1"}' })))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  store.setState('mcloud.h5.jwt', JSON.stringify({ at: NOW_ISO, jwt: `H.${payload}.S` }), NOW_ISO);
  const out = runAuthRefresh(
    {
      store,
      transport: (() => ({ status: 200, headers: {}, body: '{"success":false,"code":"0505","message":"没戏"}' })) as never,
      nowIso: NOW_ISO,
      baseUrl: undefined,
    },
    true,
  );
  assert.equal(out.ok, false);
  assert.match(out.note, /没戏/);
  assert.equal(store.getState(STATE_AUTH), raw, '失败了就不该动库里的凭据');
});
