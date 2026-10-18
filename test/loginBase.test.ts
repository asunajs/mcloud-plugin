// 「把设置页清空」之后必须成立的那件事：**六个地址口子为空 = 打真主机**。
//
// # 为什么值得单独一条
//
// 用户的要求是「彻底清空设置页面，这些 mock 内容压根不能交给用户使用」。
// 清空之后，面板上那六个口子（云盘地址 / 口令主页 / 直播日程主机 / 弹幕 WebSocket /
// 进房间主机 / 登录主机）**全都是空串**，于是"空串到底走哪条路"从"e2e 时才碰到"
// 变成了**每个用户每次都在走的那条路**。
//
// 而这里真的藏着一个：`postJson` 写的是 `base ?? LOGIN_HOST` —— `??` 只挡
// `undefined`，空串穿到底拼出**相对 URL**，宿主报 `bad uri: … is missing scheme`，
// 界面只显示"移动云盘没回应"。清空设置页之前 e2e 全程把基址指向 mock（从不是空串），
// 所以这个洞一直没露（F-068）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGIN_HOST,
  thirdloginRequest,
  sendSmsCodeRequest,
  sliderPuzzleRequest,
  pcClient,
} from '../src/mcloud/login.ts';
import { resolveUrl } from '../src/mcloud/h5.ts';
import { loadGateBase } from '../src/mcloud/tasks/liveGateTask.ts';
import { loadWsBase } from '../src/mcloud/tasks/liveListen.ts';
import { loadImBase } from '../src/mcloud/tasks/liveListen.ts';
import { loadLiveUrl } from '../src/mcloud/tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from '../src/mcloud/liveKouling.ts';
import { memStore } from '../src/store/memory.ts';
import type { Store } from '../src/store/types.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { Transport } from '../src/mcloud/client.ts';

const WIN = pcClient('windows', 'AABBCCDDEEFF00112233445566778899-ENDIN');
const BODY = { clientType: '656' };

test('⚠ 登录基址是空串/空白 ⇒ 打**真主机**，不许拼出相对 URL', () => {
  // 三种"没有覆盖"的写法都要走真主机：`undefined`（从没配过）、`''`（用户清空）、
  // `'   '`（清空时留了个空格）
  for (const base of [undefined, '', '   ']) {
    const req = thirdloginRequest(WIN, 'TID', BODY, base);
    assert.equal(
      req.url,
      `${LOGIN_HOST}/user/thirdlogin`,
      `base=${JSON.stringify(base)} 拼出来的是 ${req.url}`,
    );
    assert.ok(req.url.startsWith('https://'), '相对 URL 会被宿主拒成 bad uri');
  }
  // 另外两条登录请求走同一个 `postJson`，一起钉住
  assert.ok(sendSmsCodeRequest(WIN, 'TID', BODY, '').url.startsWith(`${LOGIN_HOST}/user/sms/getSmsCode`));
  assert.ok(sliderPuzzleRequest(WIN, 'TID', BODY, '').url.startsWith(`${LOGIN_HOST}/user/verfycode`));
});

test('登录基址有覆盖时用它，且尾斜杠不许拼成双斜杠', () => {
  const req = thirdloginRequest(WIN, 'TID', BODY, 'http://127.0.0.1:18999/');
  assert.equal(req.url, 'http://127.0.0.1:18999/user/thirdlogin');
});

test('⚠ 另外五个口子清空之后也各回各的真主机（六个一起看，别只修一个）', () => {
  const store: Store = memStore();

  // 云盘业务基址：`resolveUrl` 用的是真值判断（这个坑它在 h5.ts 那轮就修过了）
  assert.equal(
    resolveUrl('taskListV3', ''),
    'https://m.mcloud.139.com/ycloud/signin/task/taskListV3',
  );

  // 口令主页：留空 = 用发布方的默认主页（**完整 URL**，不是源）
  assert.equal(loadLiveUrl(store), XIAOHONGSHU_KOULING_PROFILE_URL);

  // 三个"源"型口子：空 ⇒ undefined / 默认值，由各自的构造点回落到真主机
  assert.equal(loadGateBase(store), undefined, '门的基址：空 ⇒ undefined（由构造点用真主机）');
  assert.equal(loadImBase(store), undefined, '进房间的基址：空 ⇒ undefined');
  assert.ok(
    loadWsBase(store).startsWith('wss://videoim.cmcc-cs.cn'),
    `弹幕长连接的默认主机：${loadWsBase(store)}`,
  );
});

// ── 路由级：真上游的"正常回答"不许被当成网络故障 ──────────────────────
//
// 真上游（2026-10-17 实测，不带设备头直连也回同一形状）：
//   `POST https://user-njs.yun.139.com/user/thirdlogin` → HTTP 200
//   `{"success":false,"code":"200059541","message":"未找到设备的二维码信息",…}`
// 那是**还没扫到**，是轮询期间绝大多数的回答。而 `callOnce` 的 `ok` 只对
// `code === 0` 成立 ⇒ 用 `!r.ok` 当判据的写法会把它归到"没问到"那一支，
// 界面上永远显示"移动云盘没回应"，码其实好好地在那儿等着（F-068）。

const NOW = '2026-10-17T00:00:00.000Z';
const API = '/plugins/mcloud/api';

function routeOf(rs: ReturnType<typeof mcloudRoutes>, path: string, method: string) {
  const r = rs.find((x) => x.path === `${API}${path}` && x.method === method);
  assert.ok(r, `没有路由 ${method} ${path}`);
  return r;
}

function callPost(
  rs: ReturnType<typeof mcloudRoutes>,
  path: string,
  body?: unknown,
): { status: number; json: any } {
  const r = routeOf(rs, path, 'POST');
  const res = r.handler({
    method: 'POST',
    path: r.path,
    body: body === undefined ? '' : JSON.stringify(body),
  });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

/** 出码一次，返回 store（后续轮询都打这份会话）。 */
function startedStore(transport: Transport): Store {
  const store = memStore();
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const started = callPost(rs, '/login/qr/start', { pcPlatform: 'win' });
  assert.equal(started.status, 200);
  return store;
}

test('⚠ 轮询把真上游的「未找到设备的二维码信息」当**状态**，不是"没回应"', () => {
  const seen: BuiltRequest[] = [];
  // 逐字照真上游的回包（`success:false` + `code` 是**字符串**）
  const transport: Transport = (req) => {
    seen.push(req);
    return {
      status: 200,
      headers: {},
      body: '{"success":false,"code":"200059541","message":"未找到设备的二维码信息","data":null}',
    };
  };
  const store = startedStore(transport);
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));

  const polled = callPost(rs, '/login/qr/poll');
  assert.equal(polled.status, 200);
  assert.equal(polled.json.ok, true, '这是**正常状态**，不是失败');
  assert.equal(polled.json.stop, false, '还得继续轮');
  assert.match(polled.json.note, /等手机扫码/, `提示应当是"等手机扫码"，实际：${polled.json.note}`);
  assert.ok(
    !/没回应/.test(polled.json.note),
    `把上游的正常回答写成"没回应"了：${polled.json.note}`,
  );
  // 打的是真主机（登录基址为空 = 用户没配过 / 清空过）
  assert.ok(
    seen.every((r) => r.url.startsWith('https://user-njs.yun.139.com/')),
    `出站地址：${seen.map((r) => r.url).join(' / ')}`,
  );
});

test('⚠ 真的没问到（网络层失败）才说"移动云盘没回应"，并带上状态码', () => {
  const transport: Transport = () => ({ error: '请求失败: http status: 502' });
  const store = startedStore(transport);
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const polled = callPost(rs, '/login/qr/poll');
  assert.equal(polled.status, 200);
  assert.equal(polled.json.retry, true, '网络失败不该判死会话 —— 再点一次就好');
  assert.match(polled.json.note, /移动云盘没回应（502）/, `实际：${polled.json.note}`);
});

test('⚠ 上游的 `code=200059541` 不许被当成"状态码 200"写进提示里', () => {
  // 宽松地抓"头三位数字"会把这个 code 抓成 200 —— 于是界面上一句
  // 「移动云盘没回应（200）」看着像上游好好的（这一条钉的是那个正则）
  const transport: Transport = () => ({
    status: 200,
    headers: {},
    body: '{"success":false,"code":"200059541","message":"未找到设备的二维码信息"}',
  });
  const store = startedStore(transport);
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const polled = callPost(rs, '/login/qr/poll');
  assert.ok(!/（200）/.test(polled.json.note), `提示：${polled.json.note}`);
});

test('⚠ 轮询的每一次回应都带剩余毫秒（界面上那一行要一直有倒计时）', () => {
  // 轮询每 2 秒把那行字重写一次；不带 `expiresInMs` 的话倒计时在第一次轮询之后
  // 就消失了 —— 而用户判断"码还活着吗"全靠它（`qrNoteText` 拼的就是它）。
  const transport: Transport = () => ({
    status: 200,
    headers: {},
    body: '{"success":false,"code":"200059541","message":"未找到设备的二维码信息"}',
  });
  const store = startedStore(transport);
  // 走 30 秒之后再轮：剩下的应当是 120 - 30 = 90 秒上下
  const later = new Date(Date.parse(NOW) + 30_000).toISOString();
  const rs = mcloudRoutes(testDeps(store, { transport, now: later }));
  const polled = callPost(rs, '/login/qr/poll');
  assert.equal(typeof polled.json.expiresInMs, 'number', '轮询回应里缺 expiresInMs');
  assert.ok(
    polled.json.expiresInMs > 85_000 && polled.json.expiresInMs <= 90_000,
    `剩余毫秒：${polled.json.expiresInMs}（期望 90 秒上下）`,
  );
  // ⚠ 每一次轮询回应都要带 `pollMs`：界面靠它决定"下一次隔多久"（退避之后
  //   要能回到服务端给的间隔，见 F-070）。缺一次就会让界面退到兜底值上。
  // 1000ms：照参考实现（`QR_POLL_INTERVAL_MS = 1000`）与客户端源码的 `setInterval`。
  // 这一侧原来写 2000，而扫码成功那一枪只出现一次 ⇒ 一半的机会直接跳过它（F-071）。
  assert.equal(polled.json.pollMs, 1000, '轮询间隔要是 1000ms（照参考实现）');
});

// ── 大响应（F-072：`raw` 是**截断到 500 字符**的日志串，不能拿去解析）──────

test('⚠ 超过 500 字节的登录响应也要能解析（否则扫码永远"没回应"）', () => {
  // 现场：扫码确认之后移动云盘回的 `userInfo` 有 1–2 KB，而 `callOnce` 的 `raw`
  // 只留前 500 字符（那是给日志用的）⇒ `JSON.parse` 报 "Unexpected end of JSON input"
  // ⇒ 界面上一句"移动云盘回了个空响应"，而登录其实已经成功、凭据就这么丢了。
  const big = JSON.stringify({
    success: false,
    code: '200059541',
    message: '未找到设备的二维码信息',
    pad: 'x'.repeat(2000),
  });
  assert.ok(big.length > 500, '这个夹具必须比 500 字符长，否则测不出截断');
  const transport: Transport = () => ({ status: 200, headers: {}, body: big });
  const store = startedStore(transport);
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const polled = callPost(rs, '/login/qr/poll');
  assert.match(polled.json.note, /等手机扫码/, `大响应没被解析出来：${polled.json.note}`);
  assert.notEqual(polled.json.retry, true, '这是正常态，不该报"没问成"');
});

test('⚠ 终态那一行不许再写"剩 N 秒"（过期了还说剩 119 秒是自相矛盾）', () => {
  // 实测撞到过：出码后第一次轮询上游回 `200059542 二维码已失效`，
  // 界面那一行变成「二维码过期了（超过 120 秒）· 剩 119 秒」。
  const transport: Transport = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ success: false, code: '200059542', message: '二维码已失效' }),
  });
  const store = startedStore(transport);
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const polled = callPost(rs, '/login/qr/poll');
  assert.equal(polled.json.stop, true, '过期是终态');
  assert.match(polled.json.note, /过期/, `提示不对：${polled.json.note}`);
  assert.equal(polled.json.expiresInMs, 0, `终态还带着剩余时间：${polled.json.expiresInMs}`);
});
