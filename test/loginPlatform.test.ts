// 「客户端形态」（添加账号弹窗顶部的 Windows / macOS）这一件事的测试。
//
// # 为什么单独一条
//
// 这个控件一度**什么都没做**：点它只改一个前端变量，而出码那一路根本不带它
// （后端读的是全局偏好），账密那一路后端也没读它。用户的原话是
// 「点击这个不会切换二维码，是没必要吗」—— 所以这里把四件事钉住：
//
//   ① **进码**：出码请求带 `pcPlatform` ⇒ 码里的 `ver` 就是那一套
//      （win `8.8.6.20260829` / mac `4.2.1`）；
//   ② **冻住**：出码之后改偏好，动不到这张码 —— 码里一个版本、轮询另一个版本
//      是上游一眼可辨的矛盾组合（`QrSession.platform` 的注释）；
//   ③ **进请求头**：轮询 / 发码 / 账密都按它发（`x-yun-client-info` 里的版本号）；
//   ④ **跟着凭据落盘**：账号卡上标的那个不是猜的（原来是"恒标 Windows"）。
//
// ⚠ 还有一条**反向**断言：设置页那个下拉框不许回来（同一件事两个控件 = 用户改了
//   一个以为生效了）。它在 `test/webui.test.ts` 里守。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import { memStore } from '../src/store/memory.ts';
import { loadAccounts } from '../src/mcloud/accounts.ts';
import { aesEcbPkcs7EncryptHex } from '../src/crypto/aes.ts';
import {
  DEFAULT_PC_PLATFORM,
  LOGIN_AES_KEY,
  accountForm,
  newQrSession,
  newSmsSession,
  parsePcPlatform,
} from '../src/mcloud/login.ts';
import { loadQrSession, loadSmsSession } from '../src/mcloud/loginSession.ts';
import type { Store } from '../src/store/types.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-16T01:00:00.000Z';
const BASE = '/plugins/mcloud/api';

const WIN_VER = '8.8.6.20260829';
const MAC_VER = '4.2.1';

/** 记下每一次出站请求，按顺序。 */
function recorder(): { seen: BuiltRequest[]; transport: Transport } {
  const seen: BuiltRequest[] = [];
  const transport: Transport = (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: '{"code":0,"data":"{}"}' };
  };
  return { seen, transport };
}

/** 一个"登录成功"的上游：`data` 是 AES-ECB 密文，解开就是 userInfo。 */
function successTransport(userInfo: Record<string, unknown>, seen: BuiltRequest[]): Transport {
  const data = aesEcbPkcs7EncryptHex(LOGIN_AES_KEY, JSON.stringify(userInfo));
  return (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data }) };
  };
}

type Entry = ReturnType<typeof mcloudRoutes>[number];

function entryOf(rs: Entry[], path: string, method: string): Entry {
  const r = rs.find((x) => x.path === `${BASE}${path}` && x.method === method);
  assert.ok(r, `没有路由 ${method} ${path}`);
  return r;
}

function post(rs: Entry[], path: string, body?: unknown): { status: number; json: any } {
  const r = entryOf(rs, path, 'POST');
  const res = r.handler({
    method: 'POST',
    path: r.path,
    body: body === undefined ? '' : JSON.stringify(body),
  });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

function get(rs: Entry[], path: string): any {
  const r = entryOf(rs, path, 'GET');
  const res = r.handler({ method: 'GET', path: r.path });
  assert.equal(res.status, 200);
  return JSON.parse(res.body);
}

function readings(rs: Entry[]): any {
  return get(rs, '/readings');
}

/** 设备头里那个 14 段串的第 2 段就是版本号 —— 一眼能看出这一枪冒充的是谁。 */
function clientInfoOf(req: BuiltRequest): string {
  const h = req.headers ?? {};
  const v = h['x-yun-client-info'] ?? h['x-DeviceInfo'] ?? '';
  return typeof v === 'string' ? v : '';
}

// ── ① 词表收口 ────────────────────────────────────────────────────────

test('形态的两套词表：界面 `win`/`mac`、档案 `windows`/`macos` —— 只在一处归一', () => {
  assert.equal(parsePcPlatform('win'), 'windows');
  assert.equal(parsePcPlatform('mac'), 'macos');
  assert.equal(parsePcPlatform('windows'), 'windows');
  assert.equal(parsePcPlatform('macos'), 'macos');
  // 认不出 ⇒ null。**不许在这里悄悄回落默认**：调用方才知道这是"填错了"
  // 还是"这次没带"（回落的话，拼错的形态会静默变成 Windows）。
  assert.equal(parsePcPlatform(''), null);
  assert.equal(parsePcPlatform('MacOS'), null);
  assert.equal(parsePcPlatform(undefined), null);
  assert.equal(parsePcPlatform(1), null);

  // 账号里存的是另一套词表（参考实现界面上的写法）—— 转换只做一次
  assert.equal(accountForm('windows'), 'win');
  assert.equal(accountForm('macos'), 'mac');
});

test('会话默认形态是 Windows（版本号更"主流"），显式给的那一个要粘住', () => {
  assert.equal(DEFAULT_PC_PLATFORM, 'windows');
  assert.equal(newQrSession('DID', 0).platform, 'windows');
  assert.equal(newQrSession('DID', 0, 'macos').platform, 'macos');
  assert.equal(newSmsSession('13800000000', 0).platform, 'windows');
  assert.equal(newSmsSession('13800000000', 0, 'macos').platform, 'macos');
});

// ── ② 形态进码、且冻住 ────────────────────────────────────────────────

test('出码带形态：`pcPlatform: mac` ⇒ 码里的 `ver` 是 macOS 那一套', () => {
  const store = memStore();
  const { transport } = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));

  const r = post(rs, '/login/qr/start', { pcPlatform: 'mac' });
  assert.equal(r.status, 200);
  assert.equal(r.json.platform, 'macos');
  assert.ok(r.json.payload.includes(`ver=${MAC_VER}`), `码里应当是 mac 的版本：${r.json.payload}`);
  assert.ok(r.json.svg.startsWith('<svg'), '码要由插件这一侧渲染成 SVG');

  // 会话里冻着的就是它（轮询照这个发）
  assert.equal(loadQrSession(store)?.platform, 'macos');
  assert.equal(readings(rs).login.qr.platform, 'macos');
});

test('⚠ 形态**冻在会话里**：出码之后改偏好，动不到这张码', () => {
  const store = memStore();
  const { transport } = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));

  post(rs, '/login/qr/start', { pcPlatform: 'mac' });
  // 用户跑去别处把偏好改成 windows（设置页那个下拉框删了，但接口还在 ——
  // 它现在是"记忆"，不是身份来源）
  post(rs, '/config', { loginPlatform: 'windows' });
  assert.equal(readings(rs).settings.loginPlatform, 'windows', '偏好确实改了');

  const after = readings(rs).login.qr;
  assert.equal(after.platform, 'macos', '正在进行的这一趟仍然是 mac');
  assert.ok(
    after.payload.includes(`ver=${MAC_VER}`),
    '码不许被改画成另一个形态 —— 否则就是"码说一个版本、轮询发另一个版本"',
  );
});

test('⚠ 轮询按**会话**的形态发（不是现读全局偏好）', () => {
  const store = memStore();
  const rec = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport: rec.transport, now: NOW }));

  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  post(rs, '/config', { loginPlatform: 'macos' }); // 中途改了偏好
  assert.equal(rec.seen.length, 0, '出码是本地拼接、改偏好只写库 —— 这两条都不发上游');

  post(rs, '/login/qr/poll');
  assert.equal(rec.seen.length, 1);
  const info = clientInfoOf(rec.seen[0] as BuiltRequest);
  assert.ok(info.includes(`|${WIN_VER}|`), `轮询该按冻住的 win 发，实际：${info}`);
  assert.ok(!info.includes(`|${MAC_VER}|`), '不许现读偏好改成 mac');
});

test('没带形态时用"上次那种"（记忆只当预填值用）', () => {
  const store = memStore();
  const { transport } = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));

  post(rs, '/config', { loginPlatform: 'macos' });
  const r = post(rs, '/login/qr/start'); // 界面没带形态
  assert.equal(r.json.platform, 'macos', '回落成记忆里的那一种');
  assert.ok(r.json.payload.includes(`ver=${MAC_VER}`));
  assert.equal(get(rs, '/login/state').platform, 'macos');
});

// ── ③ 形态进请求头（短信 / 账密这两条也真的用它）────────────────────

test('短信：形态冻进会话，发码那一枪按它发', () => {
  const store = memStore();
  const rec = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport: rec.transport, now: NOW }));

  const start = post(rs, '/login/sms/start', { phone: '13800000000', pcPlatform: 'mac' });
  assert.equal(start.json.platform, 'macos');
  assert.equal(loadSmsSession(store)?.platform, 'macos');

  post(rs, '/login/sms/send');
  assert.equal(rec.seen.length, 1);
  assert.ok(
    clientInfoOf(rec.seen[0] as BuiltRequest).includes(`|${MAC_VER}|`),
    `发码该按 mac 发：${clientInfoOf(rec.seen[0] as BuiltRequest)}`,
  );
});

test('⚠ 账密：后端原来**没读** `pcPlatform`（界面一直在发它）', () => {
  const store = memStore();
  const seen: BuiltRequest[] = [];
  const userInfo = { account: '13800000000', authToken: 'TOK', userDomainId: 'DOM' };
  const rs = mcloudRoutes(
    testDeps(store, { transport: successTransport(userInfo, seen), now: NOW }),
  );

  const r = post(rs, '/login/pwd', { phone: '13800000000', password: 'PW', pcPlatform: 'mac' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `账密该登录成功：${JSON.stringify(r.json)}`);
  assert.equal(seen.length, 1);
  assert.ok(
    clientInfoOf(seen[0] as BuiltRequest).includes(`|${MAC_VER}|`),
    `账密这一枪该按 mac 发：${clientInfoOf(seen[0] as BuiltRequest)}`,
  );
});

// ── ④ 形态跟着凭据落盘 ───────────────────────────────────────────────

test('⚠ 登录成功后账号记下这一趟的形态（原来恒标 Windows）', () => {
  const store = memStore();
  const seen: BuiltRequest[] = [];
  const userInfo = { account: '13900000001', authToken: 'TOK2', userDomainId: 'DOM2' };
  const rs = mcloudRoutes(
    testDeps(store, { transport: successTransport(userInfo, seen), now: NOW }),
  );

  post(rs, '/login/pwd', { phone: '13900000001', password: 'PW', pcPlatform: 'mac' });
  const acc = readings(rs).account.accounts;
  assert.equal(acc.length, 1);
  assert.equal(acc[0].platform, 'pc');
  assert.equal(acc[0].pcPlatform, 'mac', '账号卡上标的形态必须是这一趟真用的那一个');
});

test('⚠ 扫码登录成功也落盘（原来是"没传 ⇒ 恒 win"）', () => {
  const store = memStore();
  const seen: BuiltRequest[] = [];
  const userInfo = { account: '13900000002', authToken: 'TOK3', userDomainId: 'DOM3' };
  const rs = mcloudRoutes(
    testDeps(store, { transport: successTransport(userInfo, seen), now: NOW }),
  );

  post(rs, '/login/qr/start', { pcPlatform: 'mac' });
  const poll = entryOf(rs, '/login/qr/poll', 'POST');
  const res = poll.handler({ method: 'POST', path: poll.path, body: '' });
  assert.equal(res.status, 200);
  const acc = readings(rs).account.accounts;
  assert.equal(acc.length, 1);
  assert.equal(acc[0].pcPlatform, 'mac');
});

test('老会话（没有 platform 那一格）不许被判死', () => {
  const store: Store = memStore();
  // 模拟"面板升级前存下的会话"：直接写库，缺 platform
  store.setState(
    'mcloud.login.qr',
    JSON.stringify({ sessionId: 'SID', deviceId: 'DID', startedAtMs: Date.parse(NOW), scanned: false, done: false, lastNote: '等手机扫码' }),
    NOW,
  );
  const s = loadQrSession(store);
  assert.ok(s, '老会话要能继续轮');
  assert.equal(s.platform, DEFAULT_PC_PLATFORM);
});

// ── 轮询的每个**结论变化**都要在日志里留痕（真机排障只靠它） ──────────────

test('⚠ 扫码的三种结论各记一条，且带上游的原话（`code`）', () => {
  // 2026-10-17 真机排"扫了没用"时，日志里**只有出码与超时**：手机扫到过这件事
  // 一个字都没留下（原来只在 `stop` 时记），于是只能靠猜。
  // 判据改成"结论变了"之后：未扫 → 已扫 → 回退成未扫，三步都在。
  const store: Store = memStore();
  const logs: string[] = [];
  const codes = [200_059_541, 200_059_548, 200_059_541];
  let i = 0;
  const transport: Transport = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: codes[Math.min(i++, codes.length - 1)] }),
  });
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW, log: (m) => logs.push(m) }));
  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  for (let k = 0; k < 3; k += 1) post(rs, '/login/qr/poll');

  const qrLogs = logs.filter((l) => l.includes('扫码登录'));
  assert.ok(
    qrLogs.some((l) => l.includes('已扫码') && l.includes('200059548')),
    `"手机扫到了"没留痕：\n${qrLogs.join('\n')}`,
  );
  assert.ok(
    qrLogs.some((l) => l.includes('扫到了，但手机上没确认') && l.includes('200059541')),
    `"回退成没扫到"没留痕：\n${qrLogs.join('\n')}`,
  );
  // 同一结论重复轮询**不许刷屏**（"还没扫到"是轮询期绝大多数响应）
  assert.equal(qrLogs.filter((l) => l.includes('等手机扫码')).length, 0, '重复的结论不该记');
});

test('⚠ 给用户看的那句话里不许出现「上游」/解析器原话（F-070）', () => {
  // 真机截图里那一行曾经写着「已扫到过，但上游又说没扫到 —— 再扫一次」：
  //   · 「上游」是**界面禁词**（ui-wording.md：对用户叫「移动云盘」）
  //   · "我们记录过什么"跟用户没关系，他要的是"现在该做什么"
  // 另一处：移动云盘偶尔回空体，`Unexpected end of JSON input` 被原样贴到二维码下面。
  const banned = ['上游', 'JSON', 'mock', '表达式'];
  const notes: string[] = [];
  const store: Store = memStore();
  const bodies = [
    JSON.stringify({ code: 200_059_548 }), // 已扫、等确认
    JSON.stringify({ code: 200_059_541 }), // 回退成"没扫到"
    '', // 空体（真机上见过）
    JSON.stringify({ code: 200_059_541 }),
  ];
  let i = 0;
  const transport: Transport = () => ({ status: 200, headers: {}, body: bodies[Math.min(i++, bodies.length - 1)]! });
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  for (let k = 0; k < bodies.length; k += 1) {
    const r = post(rs, '/login/qr/poll');
    if (typeof r.json.note === 'string') notes.push(r.json.note);
  }
  assert.ok(notes.length >= 3, `拿到的提示太少：${notes.join(' / ')}`);
  for (const note of notes) {
    for (const bad of banned) {
      assert.ok(!note.includes(bad), `提示里出现了「${bad}」：${note}`);
    }
  }
  // 回退那一句要**说清该做什么**（扫一次 + 在手机上点确认），不是描述我们的内部状态
  assert.ok(
    notes.some((n) => n.includes('再扫一次') && n.includes('确认登录')),
    `回退那一句没给出动作：${notes.join(' / ')}`,
  );
  // 空体那一句不许把解析器原话贴出来
  assert.ok(
    notes.some((n) => n.includes('空响应')),
    `空体那一句没认出来：${notes.join(' / ')}`,
  );
});

// ── ⑤ 整趟一个 `x-yun-tid`（F-071：每轮换一个 = 每轮换一个问话的人）──────────

test('⚠ 扫码轮询整趟复用同一个 `x-yun-tid`（参考实现的会话表存的就是它）', () => {
  // 真机现场：`200059548 已扫码` 之后紧接着一次空响应、然后 `200059541 未找到设备`，
  // 成功那一枪永远抓不到。参考实现（`mcloud`）的会话表存 `(qr, tid, owner)`、
  // CLI 也是 `let tid = new_tid()` 之后每轮复用 —— 这一侧原来**每轮新生成一个**。
  const store: Store = memStore();
  const { seen, transport } = recorder();
  const rs = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  for (let i = 0; i < 3; i += 1) post(rs, '/login/qr/poll');

  const tids = seen.map((r) => (r.headers ?? {})['x-yun-tid']).filter(Boolean);
  assert.equal(tids.length, 3, `三轮都该带 x-yun-tid：${JSON.stringify(tids)}`);
  assert.equal(new Set(tids).size, 1, `整趟必须是同一个 tid，实际：${JSON.stringify(tids)}`);
  // 而且是**落盘**的：面板重启之后接着轮，还是同一个（否则"换个进程就换个问话的人"）
  const saved = loadQrSession(store);
  assert.ok(saved, '会话要落盘');
  assert.equal(saved.tid, tids[0], '落盘的那个 tid 必须就是发出去的那个');

  // 新的一趟 ⇒ 新的 tid（两趟共用一个 tid 会让上游把两张码当成同一次问话）
  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  post(rs, '/login/qr/poll');
  const tids2 = seen.map((r) => (r.headers ?? {})['x-yun-tid']).filter(Boolean);
  assert.equal(new Set(tids2).size, 2, `第二趟要有自己的 tid：${JSON.stringify(tids2)}`);
});

test('⚠ 老会话（没有 tid 那一格）补一个并固定下来，不许判死', () => {
  const store: Store = memStore();
  store.setState(
    'mcloud.login.qr',
    JSON.stringify({
      sessionId: 'SID',
      deviceId: 'DID',
      startedAtMs: Date.parse(NOW),
      scanned: false,
      done: false,
      lastNote: '等手机扫码',
    }),
    NOW,
  );
  const a = loadQrSession(store);
  assert.ok(a, '老会话要能继续轮');
  assert.ok(typeof a.tid === 'string' && a.tid.length === 36, `补出来的 tid 要像 UUID：${a.tid}`);
  const b = loadQrSession(store);
  assert.ok(b, '第二次读也要能读到');
  assert.equal(a.tid, b.tid, '补出来的这个必须稳定（每次读都换一个就等于没补）');
});

test('⚠ 扫码成功的载荷有 1–2 KB：也要落成账号（F-072 的真实形状）', () => {
  // 真机 `userInfo` 的形状（`mcloud-capture` 记的字段名）：密文 hex 一段就有 ~1 KB，
  // 整个响应必然超过 `callOnce` 那个 500 字符的日志截断 ⇒ 曾经一律解析失败。
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  const userInfo = {
    account: '13900000003',
    authToken: 'AT3',
    token: 'TOK3',
    userDomainId: 'DOM3',
    // 真响应里还有一堆字段（`userExtInfo` / `routerInfo` / `serverinfo` …），
    // 这里用等量长度占位：要的就是"响应 > 500 字节"这个性质。
    userExtInfo: { padding: 'y'.repeat(1200) },
  };
  const rs = mcloudRoutes(testDeps(store, { transport: successTransport(userInfo, seen), now: NOW }));
  const started = post(rs, '/login/qr/start', { pcPlatform: 'win' });
  assert.equal(started.status, 200);
  const polled = post(rs, '/login/qr/poll');
  assert.equal(polled.json.stop, true, `成功那一次要收尾：${JSON.stringify(polled.json)}`);
  const acc = readings(rs).account.accounts;
  assert.equal(acc.length, 1, `大载荷没落成账号：${JSON.stringify(polled.json)}`);
  assert.equal(acc[0].pcPlatform, 'win');
});

test('⚠ 登录响应里的用户域要落到**这个账号**上，全局那格清空（F-076）', () => {
  // 它回答"**这个账号**属于哪个用户域"，是账号级事实。原来存全局一格
  // `mcloud.login.userDomainId` —— 换账号登录一次就把上一号的域盖掉，
  // 而它决定业务请求里的 `x-yun-uni`。
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  const userInfo = { account: '13900000009', authToken: 'AT9', token: 'TOK9', userDomainId: '1125330776486986478' };
  // 先塞一份"上一版写进全局那格"的脏值：登录之后必须被清掉
  store.setState('mcloud.login.userDomainId', '9999999999999999999', NOW);
  const rs = mcloudRoutes(testDeps(store, { transport: successTransport(userInfo, seen), now: NOW }));
  post(rs, '/login/qr/start', { pcPlatform: 'win' });
  const polled = post(rs, '/login/qr/poll');
  assert.equal(polled.json.stop, true, `登录没成：${JSON.stringify(polled.json)}`);

  const list = loadAccounts(store);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.userDomainId, '1125330776486986478', '域要在账号上');
  assert.equal(
    store.getState('mcloud.login.userDomainId'),
    '',
    '全局那格要清掉（两个地方都能读到域，正是这个结构问题本身）',
  );
  // 读数里那一格现在说的是"当前账号的域"
  const r = readings(rs);
  const hit = JSON.stringify(r).match(/"loginDomain":"(\d+)"/);
  assert.ok(hit, `读数里没有 loginDomain：${Object.keys(r).join(',')}`);
  assert.equal(hit![1], '1125330776486986478');
});
