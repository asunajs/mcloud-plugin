// H5 换票的**编排层**（`sessionExchange.ts`）—— 步骤机 + 可续期判据。
//
// 守的四条：
//   · **一次调用只发一个请求**（面板预算 2000ms；三步要跳三次）
//   · **SSO token 不留盘**（一次性，实测 4 分钟后就重放不了）
//   · 失败**不每 2 分钟重试**（否则面板上刷一片红，真信息被淹）
//   · 票新鲜时**一个请求都不发**（续票 cron 每 2 分钟一跳）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JWT_TTL_MS,
  RETRY_AFTER_MS,
  STATE_AUTH,
  STATE_EXCHANGE,
  STATE_JWT,
  authStatus,
  clearAuth,
  jwtFresh,
  loadExchange,
  loadJwt,
  maskMobile,
  needExchange,
  runExchangeStep,
  startExchange,
} from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY, loadSession } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-10-14T08:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const AUTH = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2Vu';

function fakeUpstream(over: { specFail?: boolean; login?: string } = {}) {
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    if (req.url.includes('querySpecTokenV2')) {
      return {
        status: 200,
        headers: {},
        body: over.specFail
          ? JSON.stringify({ success: false, code: '0505', message: '凭据不认' })
          : JSON.stringify({ success: true, code: '0000', message: 'ok', data: { token: 'SSO' } }),
      };
    }
    if (req.url.includes('/api/timestamp')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: 1700000000000 }) };
    }
    return {
      status: 200,
      headers: {},
      body: over.login ?? JSON.stringify({ code: 0, msg: 'ok', result: { token: 'JWT-1', mobile: '13800000000' } }),
    };
  }) as Transport;
  return { transport, sent };
}

function drive(store: ReturnType<typeof memStore>, transport: Transport) {
  const notes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const r = runExchangeStep({ store, transport, nowIso: NOW });
    notes.push(r.note);
    if (r.done) return { notes, last: r };
  }
  throw new Error(`跑了 6 步还没结束：\n${notes.join('\n')}`);
}

test('收凭据：只收下、**不发请求**；坏的输入什么都不写', () => {
  const store = memStore();
  store.ensureSchema();
  const bad = startExchange(store, 'bW9iaWxl OjE=', NOW);
  assert.equal(bad.ok, false);
  assert.equal(store.getState(STATE_AUTH), null, '坏的输入不该留下凭据');

  const ok = startExchange(store, AUTH, NOW);
  assert.equal(ok.ok, true);
  assert.equal(store.getState(STATE_AUTH), AUTH);
  assert.equal(loadExchange(store)!.step, 'spec-token', '收下 = 起一轮，但不推');

  // 只读状态**不回显凭据**
  const st = authStatus(store);
  assert.equal(st.present, true);
  assert.equal(st.fingerprint!.length, 16);
  assert.ok(!JSON.stringify(st).includes('bW9iaWxl'));
});

test('三步：一次调用一个请求，顺序固定，跑完存住票', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport, sent } = fakeUpstream();
  const { notes, last } = drive(store, transport);

  assert.equal(last.ok, true, notes.join('\n'));
  assert.deepEqual(
    sent.map((r) => r.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]),
    ['/user/querySpecTokenV2', '/ycloud/api/timestamp', '/ycloud/auth-service/auth/tyrzLogin'],
  );
  const rec = loadJwt(store)!;
  assert.equal(rec.jwt, 'JWT-1');
  assert.equal(rec.mobile, '13800000000');
  assert.ok(rec.referer.includes('token=SSO'), 'referer 是那一页的（带本次 SSO）');
  assert.equal(jwtFresh(store, NOW_MS), true);
});

test('⚠ SSO token **不留盘**（它是一次性的，留着只是"下次也许还能用"的错觉）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport, sent } = fakeUpstream();
  // 走两步：SSO 换到了、还没换票
  runExchangeStep({ store, transport, nowIso: NOW });
  runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(loadExchange(store)!.ssoToken, 'SSO', '中途要用它，所以在状态里');

  drive(store, transport);
  // ⚠ 判据是**字段没了**，不是"字符串里没有 SSO" —— referer 里本来就含 `token=SSO`
  assert.equal(loadExchange(store)!.ssoToken, undefined, '跑完就不该留着');
  assert.equal((loadExchange(store) as { ts?: string }).ts, undefined, '时间戳也一样');
  assert.equal(sent.length >= 3, true);
});

test('换到的票顺手补进**既有会话**（已配好 cookie 的人什么都不用改）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: 'c=1', jwt: 'OLD', savedAt: NOW }), NOW);
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream();
  drive(store, transport);
  assert.equal(loadSession(store)!.jwt, 'JWT-1', '旧票该被换掉');
  assert.equal(loadSession(store)!.cookie, 'c=1', 'cookie 不是这条链管的');
});

test('⚠ 没有会话时要**新建**一个 —— 只贴原生凭据的人也必须能用', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream();
  drive(store, transport);
  // 这一条差点漏掉：只写 `STATE_JWT` 的话，任务读票走的是 `loadSession`，
  // 于是"换票成功却依然未登录" —— 而这正是这个功能的目标场景
  const sess = loadSession(store);
  assert.ok(sess, '换到票就该有一份会话');
  assert.equal(sess.jwt, 'JWT-1');
  assert.equal(sess.cookie, '', 'cookie 留空是合法的');
});

test('只有票、没有 cookie 也算一份会话（H5 那族本来就不发 cookie）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream();
  drive(store, transport);
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'JWT-1', savedAt: NOW }), NOW);
  assert.equal(loadSession(store)!.jwt, 'JWT-1');
  // 两样都没有 ⇒ 仍然没有会话（这一步没放松）
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: '', savedAt: NOW }), NOW);
  assert.equal(loadSession(store), null);
});

test('上游失败：如实说、且**结束这一轮**（不让界面的循环一直转）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream({ specFail: true });
  const r = runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.done, true);
  assert.match(r.note, /凭据不认/);
  assert.equal(loadExchange(store)!.ok, false);
  assert.equal(loadJwt(store), null, '失败了不该留下一张票');
});

test('HTTP 失败：停在**那一步**（不是从头再来）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  let fail = true;
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    if (fail) return { error: '请求失败: http status: 502' };
    return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { token: 'SSO' } }) };
  }) as Transport;
  const r = runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(r.ok, false);
  assert.match(r.note, /502/);
  assert.equal(loadExchange(store)!.step, 'done');

  // 重新起一轮（等价于"再点一次换票"）
  startExchange(store, AUTH, NOW);
  fail = false;
  const r2 = runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(r2.ok, true);
  assert.equal(loadExchange(store)!.step, 'timestamp');
});

test('`needExchange`：没凭据/票新鲜 ⇒ 不发；过期/从没换过 ⇒ 换', () => {
  const store = memStore();
  store.ensureSchema();
  assert.equal(needExchange(store, NOW_MS), false, '没凭据 —— 换不了，也别报错');

  startExchange(store, AUTH, NOW);
  assert.equal(needExchange(store, NOW_MS), true, '起了轮但还没跑完 ⇒ 接着走');

  const { transport } = fakeUpstream();
  drive(store, transport);
  assert.equal(needExchange(store, NOW_MS), false, '票新鲜 ⇒ 一个请求都不发');
  // 过期后 ⇒ 该续
  assert.equal(jwtFresh(store, NOW_MS + JWT_TTL_MS + 1000), false);
  assert.equal(needExchange(store, NOW_MS + JWT_TTL_MS + 1000), true);
});

test('`needExchange`：失败之后**隔 30 分钟**才再试（否则每 2 分钟刷一片红）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream({ specFail: true });
  runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(loadExchange(store)!.ok, false);

  assert.equal(needExchange(store, NOW_MS + 60_000), false, '刚失败过 ⇒ 别急着再试');
  assert.equal(needExchange(store, NOW_MS + RETRY_AFTER_MS + 1000), true, '隔够了就该再试');
});

test('清空：凭据、进度、票一起清（**不能只清票**）', () => {
  const store = memStore();
  store.ensureSchema();
  startExchange(store, AUTH, NOW);
  const { transport } = fakeUpstream();
  drive(store, transport);
  clearAuth(store, NOW);
  for (const k of [STATE_AUTH, STATE_EXCHANGE, STATE_JWT]) {
    assert.equal(store.getState(k), '', `${k} 该被清掉`);
  }
  assert.equal(authStatus(store).present, false);
});

test('没有待换票的任务时：一步都不发，直接 done', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport, sent } = fakeUpstream();
  const r = runExchangeStep({ store, transport, nowIso: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal(sent.length, 0);
});

test('手机号脱敏：只留前 3 后 4', () => {
  assert.equal(maskMobile('13800000000'), '138****0000');
  assert.equal(maskMobile('123'), '***');
});
