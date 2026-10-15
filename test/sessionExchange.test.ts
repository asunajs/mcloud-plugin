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
  jwtKey,
  needExchange,
  runExchangeStep,
  startExchange,
} from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY, loadSession } from '../src/store/types.ts';
import { idOf, selectAccount, upsertAccount } from '../src/mcloud/accounts.ts';
import {
  FALLBACK_RECIPE,
  recipeFor,
  recipeParams,
} from '../src/mcloud/h5session.ts';
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
    // ④ smid 风控上报（换 `deviceId`）—— 它是**另一台主机**，判据也是数字码 1100
    if (req.url.includes('/deviceprofile/v4')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 1100, detail: { deviceId: 'MOCKDEV' } }) };
    }
    return {
      status: 200,
      headers: {},
      body: over.login ?? JSON.stringify({ code: 0, msg: 'ok', result: { token: 'JWT-1', mobile: '13800000000' } }),
    };
  }) as Transport;
  return { transport, sent };
}

function drive(
  store: ReturnType<typeof memStore>,
  transport: Transport,
  recipe: 'sign-in' | 'msg-push-on' = 'sign-in',
) {
  const notes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const r = runExchangeStep({ store, transport, nowIso: NOW }, recipe);
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
    [
      '/user/querySpecTokenV2',
      '/ycloud/api/timestamp',
      '/ycloud/auth-service/auth/tyrzLogin',
      // ⚠ 第四步是**另一条链**：换 `deviceId`（smid 风控上报）。
      // 没有它，领取类接口会回 615 而文案说"活动太火爆啦"（findings F-018）
      '/deviceprofile/v4',
    ],
  );
  assert.equal(loadSession(store)!.deviceId, 'BMOCKDEV', 'deviceId 要写进会话（前面拼了 B）');
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

// ══════════════════════ 多账号：票**必须按账号分开** ══════════════════════

test('⚠ 多账号：票不能串（B 的请求不能带 A 的票）', () => {
  // # 这条钉的是**跨账号串票**
  //
  // 原来票与换票进度各占**一个全局槽位**。多账号下的实际行为是：
  //
  //     账号 A 换票  → 全局票 = A 的票
  //     账号 B 要跑  → `jwtFresh` 看到"票还新" ⇒ **B 根本不换**
  //     账号 B 发请求 → 带的是 **A 的票**
  //
  // 也就是 B 以 A 的身份发请求 —— 而 `jwttoken` 恰恰是**身份**。
  //
  // 参考实现是按账号建会话的（`mcloud-tasks/src/beans.rs`：
  // 「会话是按账号建的（`H5Client` 按主机注入 `jwttoken`）」）。
  const store = memStore();
  store.ensureSchema();
  const A = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2VuQQ=='; // …QQ（A）
  const B = 'Basic bW9iaWxlOjEzOTAwMDAwMDAwOnRva2VuQg=='; // …Qg（B）
  upsertAccount(store, A, NOW, 'A 号');
  upsertAccount(store, B, NOW, 'B 号');

  // ── A 换票 ──
  selectAccount(store, idOf(A), NOW);
  const a = fakeUpstream({ login: JSON.stringify({ code: 0, msg: 'ok', result: { token: 'JWT-A', mobile: '138' } }) });
  assert.equal(needExchange(store, NOW_MS), true, 'A 还没票 ⇒ 要换');
  startExchange(store, A, NOW);
  drive(store, a.transport);
  const jwtA = loadJwt(store);
  assert.equal(jwtA?.jwt, 'JWT-A', 'A 换到了自己的票');
  assert.equal(jwtFresh(store, NOW_MS), true);

  // ── 切到 B：**票必须是"没有"**，而不是"A 那张还新" ──
  selectAccount(store, idOf(B), NOW);
  assert.equal(
    loadJwt(store),
    null,
    'B 名下不该有票（有的话就是拿到了 A 那张）',
  );
  assert.equal(jwtFresh(store, NOW_MS), false, '⚠ B 的票不新鲜 ⇒ 必须去换');
  assert.equal(needExchange(store, NOW_MS), true, '⚠ 这里返回 false 就是串票那个 bug');

  // ── B 换票 ──
  const b = fakeUpstream({ login: JSON.stringify({ code: 0, msg: 'ok', result: { token: 'JWT-B', mobile: '139' } }) });
  startExchange(store, B, NOW);
  drive(store, b.transport);
  assert.equal(loadJwt(store)?.jwt, 'JWT-B', 'B 换到的是 B 的票');

  // ── 切回 A：A 的票**还在**（没被 B 覆盖） ──
  selectAccount(store, idOf(A), NOW);
  assert.equal(loadJwt(store)?.jwt, 'JWT-A', '⚠ A 的票被 B 覆盖了');
  assert.equal(needExchange(store, NOW_MS), false, 'A 的票还新 ⇒ 不该重换');
});

test('⚠ 多账号：换票进度也要分开（否则 B 会接着 A 的半截进度走）', () => {
  const store = memStore();
  store.ensureSchema();
  const A = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2VuQQ==';
  const B = 'Basic bW9iaWxlOjEzOTAwMDAwMDAwOnRva2VuQg==';
  upsertAccount(store, A, NOW, 'A');
  upsertAccount(store, B, NOW, 'B');

  // A 只走第一步（进度停在中间态）
  selectAccount(store, idOf(A), NOW);
  const a = fakeUpstream();
  startExchange(store, A, NOW);
  runExchangeStep({ store, transport: a.transport, nowIso: NOW });
  const stepA = loadExchange(store);
  assert.ok(stepA, 'A 有进度');
  assert.notEqual(stepA.step, 'done', 'A 停在中间');

  // B 名下的进度必须是**没有**，而不是"A 那半截"
  selectAccount(store, idOf(B), NOW);
  assert.equal(
    loadExchange(store),
    null,
    '⚠ B 读到了 A 的半截进度 ⇒ B 会拿 A 的指纹去换票',
  );

  // 切回 A：进度还在，能接着走
  selectAccount(store, idOf(A), NOW);
  assert.deepEqual(loadExchange(store), stepA, 'A 的进度不该被动过');
});

test('⚠ 清票只清**当前账号**那两格（别顺手删了别人的）', () => {
  const store = memStore();
  store.ensureSchema();
  const A = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2VuQQ==';
  const B = 'Basic bW9iaWxlOjEzOTAwMDAwMDAwOnRva2VuQg==';
  upsertAccount(store, A, NOW, 'A');
  upsertAccount(store, B, NOW, 'B');

  for (const [raw, tok] of [[A, 'JWT-A'], [B, 'JWT-B']] as const) {
    selectAccount(store, idOf(raw), NOW);
    startExchange(store, raw, NOW);
    drive(store, fakeUpstream({ login: JSON.stringify({ code: 0, result: { token: tok } }) }).transport);
  }

  selectAccount(store, idOf(A), NOW);
  clearAuth(store, NOW);
  assert.equal(loadJwt(store), null, 'A 的票清了');
  selectAccount(store, idOf(B), NOW);
  assert.equal(loadJwt(store)?.jwt, 'JWT-B', '⚠ B 的票被一起清了（"清一个账号，全部要重换"）');
});

test('单账号那套（没有账号列表）仍然用**裸键**，老数据照常读得到', () => {
  const store = memStore();
  store.ensureSchema();
  // 直接往裸键里塞一张票 —— 模拟升级前的老数据
  store.setState(STATE_JWT, JSON.stringify({ jwt: 'OLD', at: NOW }), NOW);
  assert.equal(loadJwt(store)?.jwt, 'OLD', '没有当前账号 ⇒ 读裸键');
  assert.equal(jwtKey(store), STATE_JWT, '没有当前账号时键就是裸的（不用迁移）');
  assert.equal(jwtFresh(store, NOW_MS), true);
});

// ══════════════════ 配方：每页一张票 + 公共票是兜底 ══════════════════

test('⚠ 同一账号、两页：票**必须分开**（"票与票之间逐字节不等"）', () => {
  // 参考实现的实测结论：「每个页面用自己的参数换自己的票，票与票之间逐字节不等」。
  // 不分的表现是**用错页面的票** —— 而"拿签到页那张去打开启通知页的接口行不行"
  // **没有样本**（参考实现自己标的是"反向未验证"）。
  // 分开放之后"哪一页该用哪张"就是确定的。
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, AUTH, NOW, '一号');
  selectAccount(store, idOf(AUTH), NOW);

  startExchange(store, AUTH, NOW, 'sign-in');
  drive(store, fakeUpstream({ login: JSON.stringify({ code: 0, result: { token: 'JWT-SIGNIN' } }) }).transport, 'sign-in');
  startExchange(store, AUTH, NOW, 'msg-push-on');
  drive(store, fakeUpstream({ login: JSON.stringify({ code: 0, result: { token: 'JWT-MSGPUSH' } }) }).transport, 'msg-push-on');

  assert.equal(loadJwt(store, 'sign-in')?.jwt, 'JWT-SIGNIN');
  assert.equal(loadJwt(store, 'msg-push-on')?.jwt, 'JWT-MSGPUSH', '⚠ 两页的票串了');
  assert.notEqual(jwtKey(store, 'sign-in'), jwtKey(store, 'msg-push-on'), '键必须不同');
});

test('⚠ 一页的三枪打的是**同一页**的参数（不是签到页那套）', () => {
  // 步骤是跨多次调用走的（面板预算 2000ms，三步要跳三次），所以"这一轮是哪一页"
  // 必须**存在状态里**，不能靠调用方每次都记得传对。
  //
  // 这里钉两件事：
  //   ① 状态里记了配方（跨调用找得回来）
  //   ② 打出去的参数确实是**那一页**的（不是签到页那套）
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, AUTH, NOW, '一号');
  selectAccount(store, idOf(AUTH), NOW);
  startExchange(store, AUTH, NOW, 'msg-push-on');
  assert.equal(loadExchange(store, 'msg-push-on')?.recipe, 'msg-push-on');

  const up = fakeUpstream();
  drive(store, up.transport, 'msg-push-on');

  // ⚠ 第一枪**两条配方是同一个** `toSourceId=001005` —— 这不是 bug：
  //   参考实现注明 `MsgPushOn` 的第一步沿用 `001005`（依据是旁证：Go 侧记的
  //   拍拍页两步流程第一步打的也是它）。所以差异在**第三枪**（`tyrzLogin`）。
  assert.equal(up.sent[0]?.body, '{"toSourceId":"001005"}', '第一枪两页相同');

  const login = up.sent.find((r) => r.url.includes('tyrzLogin'));
  assert.ok(login, '发了 tyrzLogin 那一枪');
  const lb = JSON.stringify(login.body ?? '');
  assert.ok(lb.includes('msgpushon'), `tyrzLogin 该带这一页的 marketName：${lb}`);
  assert.ok(lb.includes('1062'), `…和 sourceId：${lb}`);
  assert.equal(lb.includes('sign_in_3'), false, '⚠ 打成签到页那套了');

  // ⚠ 传错配方 = "没有待换的任务"（安全失败），不是"打错页" —— 这一点也要钉住，
  //   因为它决定了"调用方忘了传"的后果是**不发请求**而不是**发错请求**。
  const up2 = fakeUpstream();
  const r = runExchangeStep({ store, transport: up2.transport, nowIso: NOW }, 'sign-in');
  assert.equal(up2.sent.length, 0, '⚠ 传错配方不该发任何请求');
  assert.equal(r.done, true);
});

test('兜底：不知道配方的页面走公共票（`recipeFor`）', () => {
  // 「公共票是兜底」：参考实现只有两页拿到完整实拍，其余页面**映射到签到页那一套**。
  // 注意这是"不知道自己配方的走兜底"，**不是**"所有页面都用签到页那一套"。
  assert.equal(recipeFor('sign-in'), 'sign-in');
  assert.equal(recipeFor('msg-push-on'), 'msg-push-on', '这一页有实拍 ⇒ 用自己的');
  assert.equal(FALLBACK_RECIPE, 'sign-in');
  // 两页的参数确实不同（逐条都是实拍差异，不是"忘了填"）
  const a = recipeParams('sign-in');
  const b = recipeParams('msg-push-on');
  assert.equal(a.marketName, 'sign_in_3');
  assert.equal(b.marketName, 'msgpushon');
  assert.equal(a.sourceId, '1002');
  assert.equal(b.sourceId, '1062');
  assert.equal(a.h5AppId !== undefined, true, '签到页**有** appID');
  assert.equal(b.h5AppId, undefined, '⚠ 开启通知页**没有** appID（实拍如此，别顺手补齐）');
  assert.equal(a.portalPage, 'mobilecloud');
  assert.equal(b.portalPage, 'hcyview', '⚠ 两页的入口路径段不同');
  assert.equal(a.targetSourceId, '001005');
  assert.equal(b.targetSourceId, undefined, '⚠ 开启通知页**没有** targetSourceId');
});
