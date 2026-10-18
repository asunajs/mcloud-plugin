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
import { loadAccounts, selectAccount, upsertAccount } from '../src/mcloud/accounts.ts';
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

/** 一个"永远回成功"的上游（续期那一枪就够用）。 */
function okTransport() {
  return ((_req: unknown) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      success: true,
      code: '0000',
      data: { token: `NEW|1|RCS|${NOW_MS + 30 * DAY}|x`, expireTime: 2592000 },
    }),
  })) as never;
}

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
  assert.match(out.note, /重新登录/);
  assert.equal(out.ok, true, '这一档不是"任务失败"，是"这事得你做"');
});

test('⚠ 该刷但手里没有用户域 ⇒ **照样刷**（上游不要求它）', () => {
  // 用户的原话：「据我所知，刷新不需要这个 id，或者如果需要这个 id 的唯一源也不是 jwt」。
  // 2026-10-17 真机实测：只发 `{"clientType":"414"}` 一样回
  // `{"success":true,"code":"0000","data":{"token":…}}`。
  // 原来这里写成"拿不到 ⇒ 直接失败、先跑一次换票"，而换票又要求凭据能用 ——
  // 于是刚登录进来还没换过票的账号，第一次续期必然失败。
  const raw = cred('mobile', '19100002716', `a|b|c|${NOW_MS + 1 * DAY}`);
  const store = mkStore(raw);
  const seen: { body?: string | undefined }[] = [];
  const out = runAuthRefresh({
    store,
    transport: ((req: { body?: string | undefined }) => {
      seen.push(req);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          code: '0000',
          data: { token: `NEW|1|RCS|${NOW_MS + 30 * DAY}|x`, expireTime: 2592000 },
        }),
      };
    }) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(seen.length, 1, '该发的那一枪要发出去');
  assert.equal(out.ok, true, `续期该成功：${out.note}`);
  assert.ok(!/userDomainId/.test(seen[0]!.body ?? ''), `没域就不该写这一格：${seen[0]!.body}`);
  // ⚠ 文案是**给用户看**的：不许出现 旧尾/新尾/用户域/换票/上游/凭据 这类黑话
  assert.equal(out.note, '已续期，还能用 30 天', `提示要说人话：${out.note}`);
  for (const jargon of ['旧尾', '新尾', '用户域', '换票', '上游', '凭据']) {
    assert.ok(!out.note.includes(jargon), `提示里有黑话「${jargon}」：${out.note}`);
  }
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
  assert.match(out.note, /先加/);
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

test('⚠ 有用户域时仍然带上（照实拍形状：`userDomainId` 在前）', () => {
  const raw = cred('mobile', '19100002716', `a|b|c|${NOW_MS + 1 * DAY}`);
  const store = mkStore(raw);
  // ⚠ 域现在在**账号**上（登录响应写进去的），不是全局一格 —— 见 F-076
  const up = upsertAccount(store, raw, NOW_ISO, undefined, undefined, '1125330776486986478');
  selectAccount(store, up.account.id, NOW_ISO);
  const seen: { body?: string | undefined }[] = [];
  const out = runAuthRefresh({
    store,
    transport: ((req: { body?: string | undefined }) => {
      seen.push(req);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          success: true,
          code: '0000',
          data: { token: `NEW|1|RCS|${NOW_MS + 30 * DAY}|x`, expireTime: 2592000 },
        }),
      };
    }) as never,
    nowIso: NOW_ISO,
    baseUrl: undefined,
  });
  assert.equal(out.ok, true);
  const body = seen[0]!.body ?? '';
  assert.equal(body, '{"userDomainId":"1125330776486986478","clientType":"412"}', `请求体：${body}`);
  assert.ok(body.indexOf('userDomainId') < body.indexOf('clientType'), '键序要照实拍');
  assert.ok(!/没带用户域/.test(out.note), '带上了就不该说"没带"');
});

// ─────────────── 刷完要**落到账号记录上**（F-077） ───────────────
//
// 用户的原话：「点了没变化啊，然后不要提示黑话啊」。
// 根因：`loadAuthRaw` 读的是 `Account.auth`（账号列表那一格），而续期把新串写进
// `STATE_AUTH`（或 `scoped()` 路由到的账号袋）—— 卡片读列表 ⇒ 天数永远不变。

test('⚠ 刷完把新串写回**账号记录**（卡片上的天数才会变）', () => {
  const raw = cred('pc', '19100002716', `a|b|c|${NOW_MS + 1 * DAY}`);
  const store = memStore();
  store.ensureSchema();
  const up = upsertAccount(store, raw, NOW_ISO, '测试', 'win');
  selectAccount(store, up.account.id, NOW_ISO);

  const out = runAuthRefresh(
    { store, transport: okTransport(), nowIso: NOW_ISO, baseUrl: undefined },
    true,
  );
  assert.equal(out.ok, true, `续期该成功：${out.note}`);
  // 账号列表里那串必须是**新的**
  const after = loadAccounts(store).find((a) => a.id === up.account.id)!;
  assert.notEqual(after.auth, raw, '账号记录里的凭据没换 ⇒ 卡片永远不变');
  assert.equal(
    credentialExpireMs(after.auth),
    NOW_MS + 30 * DAY,
    `账号里那串还是旧的（过期时刻没变成 30 天后）：${after.auth.slice(0, 20)}…`,
  );
  // 天数要跟着变（卡片就是读这个）
  assert.ok(
    daysLeft(credentialExpireMs(after.auth), NOW_MS)! > 20,
    `续期之后天数没变：${daysLeft(credentialExpireMs(after.auth), NOW_MS)}`,
  );
  assert.equal(out.note, '已续期，还能用 30 天');
});

test('⚠ 点哪一条就刷哪一条：**不许**刷成当前账号', () => {
  const a = cred('pc', '19100000001', `A|1|RCS|${NOW_MS + 1 * DAY}|a`);
  const b = cred('pc', '19100000002', `B|1|RCS|${NOW_MS + 1 * DAY}|b`);
  const store = memStore();
  store.ensureSchema();
  const ua = upsertAccount(store, a, NOW_ISO, '甲', 'win');
  const ub = upsertAccount(store, b, NOW_ISO, '乙', 'win');
  selectAccount(store, ua.account.id, NOW_ISO); // 当前是「甲」

  const seen: string[] = [];
  const out = runAuthRefresh(
    {
      store,
      transport: ((req: { headers?: Record<string, string> }) => {
        seen.push(req.headers?.['Authorization'] ?? '');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            code: '0000',
            data: { token: `NEW|1|RCS|${NOW_MS + 30 * DAY}|x`, expireTime: 2592000 },
          }),
        };
      }) as never,
      nowIso: NOW_ISO,
      baseUrl: undefined,
    },
    true,
    undefined,
    // 用户点的是「乙」
    { auth: ub.account.auth, accountId: ub.account.id },
  );
  assert.equal(out.ok, true);
  assert.equal(seen[0], b, '拿去刷的必须是**被点那条**的凭据');
  const list = loadAccounts(store);
  assert.equal(list.find((x) => x.id === ub.account.id)!.auth.startsWith('Basic '), true);
  assert.notEqual(list.find((x) => x.id === ub.account.id)!.auth, b, '「乙」要换成新串');
  assert.equal(list.find((x) => x.id === ua.account.id)!.auth, a, '「甲」不许被顺手刷掉');
});

test('⚠ 刷的那一枪必须带 `Basic ` 前缀（缺了上游回 05050009，是假线索）', () => {
  // 用户从 mcloud 复制过来的那串**没有** `Basic `（288 vs 294 字符），
  // `parseAuth` 容忍缺前缀 ⇒ 账号看着正常，但请求头是坏的。
  const b64 = Buffer.from(`pc:17823734979:C6l6qV71|1|RCS|${NOW_MS + 17 * DAY}|x`, 'utf8').toString('base64');
  const store = memStore();
  store.ensureSchema();
  // 故意塞"坏形状"：没有前缀
  const up = upsertAccount(store, b64, NOW_ISO, '移动', 'win');
  selectAccount(store, up.account.id, NOW_ISO);
  const seen: string[] = [];
  const out = runAuthRefresh(
    {
      store,
      transport: ((req: { headers?: Record<string, string> }) => {
        seen.push(req.headers?.['Authorization'] ?? '');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            code: '0000',
            data: { token: `NEW|1|RCS|${NOW_MS + 30 * DAY}|x`, expireTime: 2592000 },
          }),
        };
      }) as never,
      nowIso: NOW_ISO,
      baseUrl: undefined,
    },
    true,
  );
  assert.equal(out.ok, true, out.note);
  assert.ok(seen[0]!.startsWith('Basic '), `请求头缺前缀：${seen[0]!.slice(0, 20)}…`);
  assert.ok(seen[0]!.endsWith(b64), '前缀之后必须是原来那段 base64');
});
