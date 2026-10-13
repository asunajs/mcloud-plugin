// 会话层测试：解析、归一化、脱敏、体检、以及路由接口。
//
// 两条是**安全断言**，不是功能断言：
//   ① `sessionStatus()` 的返回值里不能出现凭据原文（它会被接口回显）
//   ② `redact()` 对短凭据也不能吐出内容（短到一定程度，前 4 位就是全部）
// 这两条如果松了，表现是「凭据悄悄出现在界面/日志里」，而且没人会立刻发现。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  importSession,
  normalizeCookie,
  parseSessionInput,
  redact,
  sessionStatus,
  verifySession,
} from '../src/mcloud/session.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { STATE_LAST_TASKLIST } from '../src/mcloud/tasks/taskList.ts';
import { SHOW_LOADING } from '../src/mcloud/h5.ts';
import { memStore } from '../src/store/memory.ts';
import { generateSignature } from '../src/mcloud/sign.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T01:00:00.000Z';
const COOKIE = 'SESSIONID=abcdef1234567890; UID=998877';

const okTransport: Transport = () => ({ status: 200, headers: {}, body: '{"code":0,"msg":"success"}' });
const logNothing = () => {};

test('解析：cookie 串 / JSON / 包一层 / cookies 数组 / jwt 别名', () => {
  // ① 纯 cookie 串
  const a = parseSessionInput(COOKIE, NOW);
  assert.equal(a.ok, true);
  assert.equal(a.ok && a.session.cookie, COOKIE);

  // ② JSON
  const b = parseSessionInput(
    JSON.stringify({ cookie: COOKIE, jwt: 'J', deviceId: 'D', userAgent: 'UA' }),
    NOW,
  );
  assert.equal(b.ok && b.session.jwt, 'J');
  assert.equal(b.ok && b.session.deviceId, 'D');

  // ③ 包一层（脚本传参常见形状）
  const c = parseSessionInput(JSON.stringify({ session: JSON.stringify({ cookie: COOKIE }) }), NOW);
  assert.equal(c.ok && c.session.cookie, COOKIE);

  // ④ cookies 数组（devtools 复制常见）
  const d = parseSessionInput(JSON.stringify({ cookies: ['a=1', 'b=2', 'bad'] }), NOW);
  assert.equal(d.ok && d.session.cookie, 'a=1; b=2');

  // ⑤ jwt 的几种叫法
  for (const key of ['jwt', 'jwttoken', 'JWT_TOKEN']) {
    const r = parseSessionInput(JSON.stringify({ cookie: COOKIE, [key]: 'T' }), NOW);
    assert.equal(r.ok && r.session.jwt, 'T', `${key} 应当被认出来`);
  }

  // 失败路径要给人话
  assert.equal(parseSessionInput('', NOW).ok, false);
  assert.equal(parseSessionInput('随便一句话', NOW).ok, false);
  assert.equal(parseSessionInput('{', NOW).ok, false);
  assert.equal(parseSessionInput('[1,2]', NOW).ok, false);
  assert.equal(parseSessionInput('{"deviceId":"D"}', NOW).ok, false);
  const noCookie = parseSessionInput('{"deviceId":"D"}', NOW);
  assert.match(noCookie.ok ? '' : noCookie.reason, /cookie/);
});

test('归一化：属性段不该出现在 cookie 头里', () => {
  assert.equal(
    normalizeCookie('SESSIONID=abc; Path=/; Domain=.139.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure'),
    'SESSIONID=abc',
  );
  assert.equal(normalizeCookie('  a=1 ;; b=2 ; '), 'a=1; b=2');
  assert.equal(normalizeCookie('Path=/'), '', '只剩属性就是空');
});

test('脱敏：短凭据也不能吐内容，长凭据只给前 4 位', () => {
  assert.equal(redact(undefined), '（无）');
  assert.equal(redact(''), '（无）');
  const short = redact('abc');
  assert.equal(short.includes('abc'), false, '太短的不能显示内容');
  const long = redact(COOKIE);
  assert.equal(long.includes(COOKIE), false);
  assert.ok(long.startsWith(COOKIE.slice(0, 4)), '前 4 位是允许的');
  assert.match(long, /共 \d+ 字符/);
});

test('安全断言：状态里没有凭据原文', () => {
  const store = memStore();
  store.ensureSchema();
  importSession(
    store,
    { cookie: COOKIE, jwt: 'JWT-SECRET-VALUE', savedAt: NOW },
    NOW,
  );
  const st = sessionStatus(store, NOW);
  const asText = JSON.stringify(st);
  assert.equal(asText.includes(COOKIE), false, 'cookie 原文不能出现在状态里');
  assert.equal(asText.includes('JWT-SECRET-VALUE'), false, 'jwt 原文不能出现在状态里');
  assert.equal(st.present, true);
  assert.equal(st.ageHours, 0);
  assert.equal(st.lastCheckOk, null, '刚导入还没验 → 不是 true 也不是 false');

  // 年龄会随 now 走
  const later = sessionStatus(store, '2026-10-13T13:00:00.000Z');
  assert.equal(later.ageHours, 12);
});

test('体检：没有会话时一个请求都不发', () => {
  const store = memStore();
  store.ensureSchema();
  let called = 0;
  const r = verifySession({
    store,
    transport: () => {
      called += 1;
      return { status: 200, headers: {}, body: '{}' };
    },
    nowIso: NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /没有会话/);
  assert.equal(called, 0);
});

test('体检：发出去的请求形状正确，成功与失败都记录在案', () => {
  const store = memStore();
  store.ensureSchema();
  importSession(store, { cookie: COOKIE, jwt: 'J', deviceId: 'D', savedAt: NOW }, NOW);

  // 用桩**捕获**发出去的请求：体检这条路径的验重点是「构造对不对」，
  // 真 HTTP 往返由 tasklist 那条用例覆盖（那里有 mock 上游）
  let sent: { url: string; method: string; headers: Record<string, string>; body?: string } | null = null;
  const capture: Transport = (req) => {
    sent = req;
    return { status: 200, headers: {}, body: '{"code":0,"msg":"ok"}' };
  };

  const ok = verifySession({ store, transport: capture, nowIso: NOW });
  assert.equal(ok.ok, true);
  assert.match(ok.note, /会话有效/);

  const req = sent as unknown as { url: string; method: string; headers: Record<string, string>; body?: string };
  assert.ok(req, '应当发过一次请求');
  // 精确到 query：`infoV3` 是 **GET + ?client=app**（我把 POST 写错过，真面板回了 405）——
  // 所以这里连 query 一起钉住，免得哪天被"顺手"改回 POST
  assert.equal(req.url, 'https://m.mcloud.139.com/ycloud/signin/page/infoV3?client=app');
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'GET 不该有 body');
  assert.equal(req.headers.jwttoken, 'J', '体检也要带凭据');
  assert.equal(req.headers.cookie, COOKIE);
  assert.equal(req.headers.deviceid, 'D');
  // 原实现这一口也是 `showloading: "true"` —— 我第一版按「体检应该安静点」写成 '0'，
  // 那是脑补，不是事实（同族错误见 h5.ts 的 EP_METHOD 表那段注释）
  assert.equal(req.headers.showloading, SHOW_LOADING);
  // 签名自洽：用发出去的值重算
  assert.equal(
    req.headers['x-signature'],
    generateSignature(req.headers['x-request-id']!, req.headers['x-timestamp']!, req.headers['x-nonce']!, 1, ''),
  );

  const check = JSON.parse(store.getState('mcloud.session.last_check')!);
  assert.equal(check.ok, true);
  assert.equal(check.at, NOW);

  // 上游说凭据过期 → 记为失效，并把上游原话留在 note 里
  const bad = verifySession({
    store,
    transport: () => ({ status: 200, headers: {}, body: '{"code":4001,"msg":"登录已过期"}' }),
    nowIso: NOW,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /登录已过期/);
  assert.equal(JSON.parse(store.getState('mcloud.session.last_check')!).ok, false);
});

test('路由：状态不回显凭据、导入后立刻真验、坏输入 400、能清空', () => {
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes({
    store,
    transport: okTransport,
    now: () => NOW,
    log: logNothing,
  });
  const call = (method: string, path: string, body?: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    assert.ok(r, `没有这条路由：${method} ${path}`);
    return r.handler({ method, path, body });
  };

  // GET 状态：空的时候也 200，且不泄漏
  const g0 = call('GET', '/plugins/mcloud/api/session');
  assert.equal(g0.status, 200);
  assert.equal(JSON.parse(g0.body).present, false);

  // 导入：坏输入 → 400 且带上人话
  const bad = call('POST', '/plugins/mcloud/api/session', '随便一句话');
  assert.equal(bad.status, 400);
  assert.ok(JSON.parse(bad.body).error);

  // 导入：cookie 串 → 200 + 真验通过
  const imp = call('POST', '/plugins/mcloud/api/session', JSON.stringify({ session: COOKIE }));
  assert.equal(imp.status, 200);
  const impBody = JSON.parse(imp.body);
  assert.equal(impBody.imported, true);
  assert.equal(impBody.verified, true);
  assert.equal(imp.body.includes(COOKIE), false, '导入响应里不能回显 cookie');

  // 再取状态：这次 present=true
  const g1 = JSON.parse(call('GET', '/plugins/mcloud/api/session').body);
  assert.equal(g1.present, true);
  assert.equal(g1.lastCheckOk, true);

  // 主动验一次
  const v = call('POST', '/plugins/mcloud/api/session/verify');
  assert.equal(JSON.parse(v.body).verified, true);

  // 清空
  const c = call('POST', '/plugins/mcloud/api/session', JSON.stringify({ clear: true }));
  assert.equal(JSON.parse(c.body).cleared, true);
  assert.equal(JSON.parse(call('GET', '/plugins/mcloud/api/session').body).present, false);

  // 任务侧状态
  store.setState(STATE_LAST_TASKLIST, JSON.stringify({ at: NOW, total: 3, done: 2 }), NOW);
  const t = JSON.parse(call('GET', '/plugins/mcloud/api/tasks').body);
  assert.equal(t.lastTaskList.total, 3);
  assert.equal(t.lastError, null);
});
