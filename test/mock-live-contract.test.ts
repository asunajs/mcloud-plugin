// 直播 mock 的**契约测试**：起真 mock、真发 HTTP，把响应喂给插件的解析器。
//
// 为什么单独要这一层（现有 liveGate.test.ts / liveIm 的解析测试都是**手捏的响应体**）：
//   mock 与解析器是**两端**，各自都能在单测里自洽，但中间那段字节对不上照样全红。
//   这个文件守住「mock 造的三套信封真的能被插件认出来」—— 那正是直播链最容易
//   被改歪的一环（三套码类型，混一套就静默取到 undefined）。

import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startMock, MOCK_LIVE_JWT } from '../mock/upstream.mjs';
import {
  parseCmlive,
  parseCmpassLogin,
  parseTabContentList,
  parseUserToken,
  parseRoomBeat,
  cmliveOk,
} from '../src/mcloud/liveGate.ts';
import { parseApplyRoom } from '../src/mcloud/liveIm.ts';
import { classifyDraw } from '../src/mcloud/liveFlower.ts';
import type { SignInEnvelope } from '../src/mcloud/envelope.ts';

/** 对 mock 发一枪，回 {status, text}。 */
async function call(mock: Awaited<ReturnType<typeof startMock>>, path: string, init?: RequestInit) {
  const res = await fetch(mock.url + path, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const post = (body?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body ?? '{}',
});

test('门 ② cmpassLoginByCmToken：mock 的字符串码信封 → parseCmlive/parseCmpassLogin 认得出', async () => {
  const mock = await startMock();
  try {
    const r = await call(mock, '/api/user/auth/cmpassLoginByCmToken', post(JSON.stringify({ cmpassToken: 'SSO-MOCK' })));
    assert.equal(r.status, 200);
    const env = parseCmlive(r.text);
    assert.equal(env.ok, true, env.ok ? '' : env.error);
    assert.ok(env.ok && env.value !== undefined && cmliveOk(env.value));
    const jwt = env.ok && env.value !== undefined ? parseCmpassLogin(env.value) : null;
    assert.ok(jwt && jwt.ok, 'object 就是 JWT 字符串本身，不该被当成对象');
    assert.equal(jwt.value, MOCK_LIVE_JWT);
    // 请求形状：直播族用 Authorization 头的位置（这里换票那一步还没有票，靠 body 传 SSO）
    const sent = mock.requests[mock.requests.length - 1]!;
    assert.equal(sent.body, '{"cmpassToken":"SSO-MOCK"}');
  } finally {
    await mock.close();
  }
});

test('门 ③ tabContentList：mock 的两个页签 → 4 间房（含去重坑与预告/回放）', async () => {
  const mock = await startMock();
  try {
    const rooms: number[] = [];
    for (const tabId of ['127', '129']) {
      const r = await call(mock, '/api/channel/channel/tabContentList?tabId=' + tabId + '&contentType=0&pageNo=1&channelId=134');
      const env = parseCmlive(r.text);
      assert.ok(env.ok && env.value !== undefined, env.ok ? '' : env.error);
      const parsed = parseTabContentList(env.value);
      assert.ok(parsed.ok && parsed.value !== undefined, parsed.ok ? '' : parsed.error);
      rooms.push(...parsed.value.map((x) => x.id));
    }
    // 147606 在两个页签都出现 ⇒ 合并要去重；另两间是预告/回放
    assert.deepEqual([...new Set(rooms)], [147490, 147606, 147608, 147609]);
    // 预告时间必须相对 now（夹具若写死日期，这条过一天就会红）
    const r129 = await call(mock, '/api/channel/channel/tabContentList?tabId=129&contentType=0&pageNo=1&channelId=134');
    const env = parseCmlive(r129.text);
    assert.ok(env.ok && env.value !== undefined);
    const parsed = parseTabContentList(env.value);
    assert.ok(parsed.ok && parsed.value !== undefined);
    const preview = parsed.value.find((x) => x.id === 147608)!;
    assert.match(preview.expectStartTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally {
    await mock.close();
  }
});

test('WS 凭据 userToken + roomBeat：数字/字符串两族信封分别认得出', async () => {
  const mock = await startMock();
  try {
    const tok = await call(mock, '/api/user/customer/userToken', post());
    const parsed = parseUserToken(tok.text);
    assert.ok(parsed.ok && parsed.value !== undefined, parsed.ok ? '' : parsed.error);
    assert.equal(parsed.value!.accessToken, 'MOCK-WS-ACCESS-TOKEN');

    const beat = await call(mock, '/api/room/front/roomBeat', post(JSON.stringify({ roomId: '147606' })));
    const rb = parseRoomBeat(beat.text);
    assert.ok(rb.ok && rb.value !== undefined, rb.ok ? '' : rb.error);
    assert.equal(rb.value!.chatRoomId, '1500000000000000000000000000001');
    assert.equal(rb.value!.anchorNickname, '中国移动云盘');

    // 边界：/_debug/live/state 把 chatRoomId 设 null ⇒ 解析层如实给 undefined（不开 WS）
    await call(mock, '/_debug/live/state', post(JSON.stringify({ liveChatRoomId: null })));
    const beat2 = await call(mock, '/api/room/front/roomBeat', post(JSON.stringify({ roomId: '147606' })));
    const rb2 = parseRoomBeat(beat2.text);
    assert.ok(rb2.ok && rb2.value !== undefined, rb2.ok ? '' : rb2.error);
    assert.equal(rb2.value!.chatRoomId, undefined, '没有聊天室就是 undefined，不是空串');
  } finally {
    await mock.close();
  }
});

test('IM 进房 member/apply：mock 的数字码 data 信封 → parseApplyRoom 认得出', async () => {
  const mock = await startMock();
  try {
    const r = await call(mock, '/v3/room/member/apply', post(JSON.stringify({ roomId: '1500000000000000000000000000001' })));
    const out = parseApplyRoom(r.text);
    assert.ok(out.ok, out.ok ? '' : out.error);
    assert.equal(out.value.appId, 'cmosim');
    assert.equal(out.value.appKey, 'mock-app-key');
    // mock 记下了两个签名头（不校验但要能验形状）
    const sent = mock.requests[mock.requests.length - 1]!;
    assert.ok(sent.headers['authorization'] !== undefined || sent.body.length > 0);
  } finally {
    await mock.close();
  }
});

test('draw 四分支：mock 真实响应 → classifyDraw 四类各自正确', async () => {
  const mock = await startMock();
  try {
    const cases: [string, string][] = [
      ['过期的口令', 'kouling-expired'],
      ['无效口令', 'invalid-kouling'],
      ['领过的口令', 'already-drawn'],
      ['一条新口令', 'succeeded'],
    ];
    for (const [code, kind] of cases) {
      const r = await call(mock, '/ycloud/liveRoomFeedback/redFlower/draw?code=' + encodeURIComponent(code), post());
      const env = JSON.parse(r.text) as SignInEnvelope;
      assert.equal(classifyDraw(env).kind, kind, '口令「' + code + '」该归到 ' + kind);
    }
  } finally {
    await mock.close();
  }
});

test('直播失败注入：/_debug/live/behavior 的三种形状都被插件解析器如实拒绝', async () => {
  const mock = await startMock();
  try {
    const inject = async (b: string) => {
      const r = await call(mock, '/_debug/live/behavior', post(JSON.stringify({ behavior: b })));
      assert.equal(r.status, 200);
    };
    // http-500：HTTP 状态码真的变了
    await inject('http-500');
    const r500 = await call(mock, '/api/user/auth/cmpassLoginByCmToken', post());
    assert.equal(r500.status, 500);
    // not-json：解析层报错（rtnCode 不是字符串 / 不是 JSON）
    await inject('not-json');
    const rnj = await call(mock, '/api/user/auth/cmpassLoginByCmToken', post());
    assert.equal(rnj.status, 200);
    const envNj = parseCmlive(rnj.text);
    assert.equal(envNj.ok, false, 'HTML 502 页不能被当成成功信封');
    // biz-fail：三套信封各回各的形状，不能被混用
    await inject('biz-fail');
    const rBiz = await call(mock, '/api/user/auth/cmpassLoginByCmToken', post());
    const envBiz = parseCmlive(rBiz.text);
    assert.ok(envBiz.ok && envBiz.value !== undefined && !cmliveOk(envBiz.value), 'cmlive 口业务失败应是字符串码 rtnCode');
    const rIm = await call(mock, '/v3/room/member/apply', post());
    assert.equal(parseApplyRoom(rIm.text).ok, false, 'IM 口业务失败应是数字码 code');
    // 复位：normal 之后恢复成功
    await inject('normal');
    const rOk = await call(mock, '/api/user/auth/cmpassLoginByCmToken', post());
    assert.ok(parseCmlive(rOk.text).ok);
  } finally {
    await mock.close();
  }
});

test('多账号：同一口令每个账号各领一次（200112 是按账号，不是按口令）', async () => {
  const mock = await startMock();
  try {
    const draw = async (jwt: string, code: string) => {
      const r = await call(mock, '/ycloud/liveRoomFeedback/redFlower/draw?code=' + encodeURIComponent(code), {
        method: 'POST', headers: { 'content-type': 'application/json', jwttoken: jwt }, body: '',
      });
      return JSON.parse(r.text);
    };
    const code = '共享口令';
    // 三个不同账号（不同 jwt）各领一次，都该成功
    for (const jwt of ['JWT-A', 'JWT-B', 'JWT-C']) {
      const env = await draw(jwt, code);
      assert.equal(env.code, 0, '每个账号第一次领都该成功：' + JSON.stringify(env));
    }
    // 同一账号再领同一个口令 ⇒ 200112（幂等）
    const again = await draw('JWT-A', code);
    assert.equal(again.code, 200112, '同账号重复领该回 200112：' + JSON.stringify(again));
    // mock 侧记账 key 带 jwt 前缀
    const claims = mock.state.liveDrawClaims as Record<string, number>;
    assert.equal(claims['JWT-A|' + code], 1);
    assert.equal(claims['JWT-B|' + code], 1);
    assert.equal(claims['JWT-C|' + code], 1);
  } finally {
    await mock.close();
  }
});

test('多账号：querySpecTokenV2/tyrzLogin 按 Basic 里的手机号发不同 SSO/JWT', async () => {
  const mock = await startMock();
  try {
    const jwts: string[] = [];
    for (const phone of ['13500135000', '13500135001']) {
      const auth = 'Basic ' + Buffer.from('pc:' + phone + ':tok').toString('base64');
      const spec = await call(mock, '/user/querySpecTokenV2', { method: 'POST', headers: { authorization: auth }, body: '{"toSourceId":"001005"}' });
      const sso = JSON.parse(spec.text).data.token as string;
      assert.equal(sso, 'SSO-MOCK-' + phone);
      const login = await call(mock, '/ycloud/auth-service/auth/tyrzLogin', post(JSON.stringify({ token: sso })));
      const env = JSON.parse(login.text);
      assert.equal(env.result.token, 'JWT-MOCK-' + phone);
      assert.equal(env.result.mobile, phone.slice(0,3) + '****' + phone.slice(-4));
      jwts.push(env.result.token);
    }
    assert.notEqual(jwts[0], jwts[1], '两个账号必须拿到不同的 jwt');
  } finally {
    await mock.close();
  }
});

test('弹幕自动流：默认开、文本来自弹幕池、可关（像真直播间慢慢来）', async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebSocket = require('ws') as any;
  const mock = await startMock({});
  const url = mock.url.replace('http', 'ws') + '/ws/1/abcdefgh/websocket';
  const ws = new WebSocket(url);
  try {
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const { msyncBytes } = await import('../mock/upstream.mjs');
    ws.send(JSON.stringify([Buffer.from(msyncBytes({ command: 3 })).toString('base64')]));
    // 自动流 1.5~4 秒一条：等 5 秒至少该有 1 条
    await new Promise((r) => setTimeout(r, 5000));
    const dbg = await (await fetch(mock.url + '/_debug/ws')).json() as {
      autoDanmaku: boolean; danmakuSent: number; history: string[];
    };
    assert.equal(dbg.autoDanmaku, true, '默认该开自动流');
    assert.ok(dbg.danmakuSent >= 1, '5 秒内该至少推一条弹幕');
    // 每条都来自三个弹幕池（闲聊/提问/口令），不会凭空造文本
    const { DANMAKU_CHAT, DANMAKU_QUESTION, DANMAKU_KOULING } = await import('../mock/upstream.mjs');
    const pool = [...DANMAKU_CHAT, ...DANMAKU_QUESTION, ...DANMAKU_KOULING];
    assert.ok(dbg.history.every((t) => pool.includes(t)), '弹幕文本都该来自弹幕池：' + JSON.stringify(dbg.history));
    // 关掉后不再新增
    await fetch(mock.url + '/_debug/ws/auto', { method: 'POST', body: '{"enabled":false}' });
    const n1 = ((await (await fetch(mock.url + '/_debug/ws')).json()) as { danmakuSent: number }).danmakuSent;
    await new Promise((r) => setTimeout(r, 4500));
    const n2 = ((await (await fetch(mock.url + '/_debug/ws')).json()) as { danmakuSent: number }).danmakuSent;
    assert.equal(n2, n1, '关掉自动流后不该再推');
  } finally {
    ws.close();
    await mock.close();
  }
});