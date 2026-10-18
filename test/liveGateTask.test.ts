// 直播日程（`live-gate`）—— **门的三步**（只读）。
//
// 这一轮真正要守住的，是三条"看不见就会写错"的判据：
//
//   ① **一次调用最多两发**（handshake 步 ①②、rooms 步 ③③）——
//      不是因为预算宽裕，而是因为 SSO token 只活几分钟（mcloud 实测），
//      ①② 拆成两次调用**必然**过期（见 liveGateTask.ts 文件头）。
//   ② **JWT 是凭据**：落盘是跨调用必需的，但 `done` 时必须抹掉，
//      而且**一律不进读数**（界面拿到的那个对象里不许有它）。
//   ③ ③ 失败就**丢掉 JWT** 退回第一步：门是只读的，重走没有代价；
//      而留着一枚坏票会让"票坏了"表现成"门一直是关的"——一个**假结论**。
//
// 夹具形状照 mock/upstream.mjs 里那两组（含两个坑：status=1 的「福建移动」、
// 两个页签里的同一间房）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_GATE,
  STATE_GATE_BASE,
  STATE_READING,
  loadGateBase,
  loadGateState,
  readGateReading,
  runLiveGate,
  saveGateBase,
} from '../src/mcloud/tasks/liveGateTask.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import {
  POOL_KEY,
  codeState,
  emptyPool,
  loadPoolFrom,
  nextRoomAt,
  note,
  normalize,
  poolSummary,
  serializePool,
  validCount,
} from '../src/mcloud/koulingPool.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import { memStore } from '../src/store/memory.ts';
import { KOULING_ANCHOR } from '../src/mcloud/koulingPool.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-14T05:40:00.000Z'; // 东八区 13:40
const AUTH = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2Vu';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 一个按路径分派的假上游 —— 记下每一发（顺序、头、body）。 */
function fakeUpstream(
  over: { failTab?: string; ssoFails?: boolean; cmpassCode?: string } = {},
): {
  transport: Transport;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const transport = ((req: Sent) => {
    sent.push({ url: req.url, method: req.method, headers: req.headers ?? {}, body: req.body });
    if (req.url.includes('/user/querySpecTokenV2')) {
      return {
        status: 200,
        headers: {},
        body: over.ssoFails
          ? JSON.stringify({ success: false, code: '9999', message: '凭据不认了' })
          : JSON.stringify({ success: true, code: '0000', data: { token: 'SSO-1' } }),
      };
    }
    if (req.url.includes('cmpassLoginByCmToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ rtnCode: over.cmpassCode ?? '0', rtnMsg: null, object: 'LIVE-JWT-1' }),
      };
    }
    if (req.url.includes('tabContentList')) {
      if (over.failTab && req.url.includes(`tabId=${over.failTab}`)) {
        return { status: 200, headers: {}, body: JSON.stringify({ rtnCode: '1001', rtnMsg: '登录态失效', object: null }) };
      }
      const tab = req.url.includes('tabId=127') ? '127' : '129';
      const dataList =
        tab === '127'
          ? [
              { room: { id: 147490, title: '福建移动福利场', status: 1, channelId: 29, expectStartTime: '', anchor: { nickname: '福建移动' } } },
              { room: { id: 147606, title: '云盘直播福利场', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR } } },
            ]
          : [
              { room: { id: 147606, title: '云盘直播福利场', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR } } },
              { room: { id: 147608, title: '云盘直播·下一场', status: 0, channelId: 134, expectStartTime: '2026-10-15 20:00:00', anchor: { nickname: KOULING_ANCHOR } } },
              { room: { id: 147609, title: '上一场回放', status: 6, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR } } },
            ];
      return { status: 200, headers: {}, body: JSON.stringify({ rtnCode: '0', rtnMsg: null, object: { dataList } }) };
    }
    throw new Error(`假上游不认识这一发：${req.url}`);
  }) as unknown as Transport;
  return { transport, sent };
}

function deps(store: ReturnType<typeof memStore>, transport: Transport) {
  return { store, transport, nowIso: NOW };
}

/** 把两步都推完（一次调用一步 —— 这是纪律，测试里也照做）。 */
function runRound(store: ReturnType<typeof memStore>, transport: Transport) {
  const a = runLiveGate(deps(store, transport));
  const b = runLiveGate(deps(store, transport));
  return { a, b };
}

// ── handshake 步 ──────────────────────────────────────────────────────

test('没有原生凭据 ⇒ 如实失败，并且**一发请求都不发**（别拿空 Authorization 去撞上游）', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport, sent } = fakeUpstream();

  const out = runLiveGate(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note ?? '', /还没有原生凭据/);
  assert.equal(sent.length, 0);
});

test('handshake：两发同一次调用，顺序是 ①换 SSO → ②换 JWT，且 SSO 是**①回来的那个**', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport, sent } = fakeUpstream();

  const out = runLiveGate(deps(store, transport));
  assert.equal(out.ok, true);
  assert.equal(sent.length, 2, '一次调用最多两发（SSO 只活几分钟，①②不能拆）');

  assert.equal(sent[0]!.url, 'https://user-njs.yun.139.com/user/querySpecTokenV2');
  assert.deepEqual(JSON.parse(sent[0]!.body!), { toSourceId: '017027' });
  assert.equal(sent[0]!.headers['Authorization'], AUTH);

  assert.equal(sent[1]!.url, 'https://v.cmcc-cs.cn/cmlive/api/user/auth/cmpassLoginByCmToken');
  assert.deepEqual(JSON.parse(sent[1]!.body!), { cmpassToken: 'SSO-1' });

  const st = loadGateState(store)!;
  assert.equal(st.step, 'rooms');
  assert.equal(st.jwt, 'LIVE-JWT-1');
});

test('handshake：① `success !== true` ⇒ 失败，**不发第二发**（别拿没换到的票去换 JWT）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport, sent } = fakeUpstream({ ssoFails: true });

  const out = runLiveGate(deps(store, transport));
  assert.equal(out.ok, false);
  assert.equal(sent.length, 1);
  assert.match(out.note ?? '', /① 换 SSO token 失败/);
  assert.match(out.note ?? '', /9999/, '要带上游原话，不能只说"失败"');
  assert.equal(loadGateState(store), null, '没写状态 ⇒ 下一趟从第一步重来');
});

test('handshake：② 的 rtnCode 不是 "0" ⇒ 失败并带上游原话', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream({ cmpassCode: '1001' });

  const out = runLiveGate(deps(store, transport));
  assert.equal(out.ok, false);
  assert.match(out.note ?? '', /② 换直播侧 JWT 失败/);
  assert.match(out.note ?? '', /1001/, '要带上游原话');
  assert.equal(loadGateState(store), null, '没写状态 ⇒ 下一趟从第一步重来');
});

// ── rooms 步 ──────────────────────────────────────────────────────────

test('rooms：两个页签各一发（127 先、129 后），都带 JWT，且**合并去重**', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport, sent } = fakeUpstream();

  runLiveGate(deps(store, transport)); // handshake
  const before = sent.length;
  const out = runLiveGate(deps(store, transport)); // rooms

  const tabs = sent.slice(before);
  assert.equal(tabs.length, 2, 'rooms 步两发（两个页签）');
  assert.match(tabs[0]!.url, /tabId=127&contentType=0&pageNo=1&channelId=134$/);
  assert.match(tabs[1]!.url, /tabId=129&/);
  assert.equal(tabs[0]!.headers['authorization'], 'LIVE-JWT-1');
  assert.equal(tabs[0]!.headers['jwttoken'], undefined, '直播族用 Authorization，不是 jwttoken');

  // 147606 在两个页签里都有 ⇒ 合并后只算一间
  const reading = readGateReading(store)!;
  assert.deepEqual(reading.rooms.map((r) => r.roomId), [147490, 147606, 147608, 147609]);
  assert.equal(out.ok, true);
});

test('rooms：门开着 = 有「中国移动云盘」在播；`liveCount` 把两种"没有"分开', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  runRound(store, transport);

  const reading = readGateReading(store)!;
  assert.equal(reading.active, true);
  // 147490「福建移动」也是 status==1 ⇒ liveCount 是 2，而 active 只认那一间
  assert.equal(reading.liveCount, 2);
  assert.match(reading.note, /正在听/);
});

test('rooms：结果落**池**（日程 + 门 + 场次），「下一场」当场可读', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  runRound(store, transport);

  const { pool } = loadPoolFrom(store);
  assert.equal(pool.schedule.length, 4, '日程（含预告/回放）要留在池里 —— "日程不能跟着丢"');
  assert.ok(pool.scheduleAtMs !== null, '这一趟是什么时候看到的要记下来');
  assert.ok(pool.lastLiveAtMs !== null, '看见开播了 ⇒ 记下"最近一次看见开播"');
  assert.equal(pool.gateClosedAtMs, null, '门开着 ⇒ 不该记"门关上的时刻"');

  // 「下一场」= 预告场那一间（判据在池里，不在任务里）
  // ⚠ `nextRoomAt` 收的是**房间表**（不是池），而池里那份叫 `schedule`
  const next = nextRoomAt(pool.schedule, '2026-10-14 13:40:00');
  assert.equal(next?.expectStartTime, '2026-10-15 20:00:00');
  assert.equal(poolSummary(pool, '2026-10-14 13:40:00', Date.parse(NOW)).nextStart, '2026-10-15 20:00:00');
});

test('rooms：**JWT 用完就抹**，而且读数里没有它（凭据不许进界面那条路）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  runRound(store, transport);

  const st = loadGateState(store)!;
  assert.equal(st.step, 'done');
  assert.equal(st.jwt, undefined);
  assert.equal('jwt' in st, false);

  const raw = store.getState(STATE_READING) ?? '';
  assert.equal(raw.includes('LIVE-JWT-1'), false);
  assert.equal(raw.includes(AUTH), false);
  // 状态里也不该再有那枚票（`delete` 之后连键都没有）
  assert.equal((store.getState(STATE_GATE) ?? '').includes('LIVE-JWT-1'), false);
});

test('rooms：③ 失败 ⇒ **丢掉 JWT** 退回第一步（留坏票会让"票坏了"表现成"门一直关着"）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream({ failTab: '129' });

  runLiveGate(deps(store, transport)); // handshake
  const out = runLiveGate(deps(store, transport)); // rooms：第二个页签失败

  assert.equal(out.ok, false);
  assert.match(out.note ?? '', /页签 129/);
  assert.match(out.note ?? '', /1001/);
  const st = loadGateState(store)!;
  assert.equal(st.step, 'handshake');
  assert.equal(st.jwt, undefined);
  // 失败时**不落池**（读到一半的日程不该当成完整的一趟）
  const { pool } = loadPoolFrom(store);
  assert.equal(pool.schedule.length, 0);
});

test('rooms：盘上没有 JWT（被手清过）⇒ 退回第一步，**不发请求**', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_GATE, JSON.stringify({ step: 'rooms', startedAt: NOW }), NOW);
  const { transport, sent } = fakeUpstream();

  const out = runLiveGate(deps(store, transport));
  assert.equal(out.idle, true);
  assert.equal(sent.length, 0);
  assert.equal(loadGateState(store)!.step, 'handshake');
});

test('一轮 done 之后再触发 = **新的一轮**（直播会开始，门要反复看）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport, sent } = fakeUpstream();

  runRound(store, transport);
  assert.equal(loadGateState(store)!.step, 'done');

  const again = runLiveGate(deps(store, transport)); // 新一轮的 handshake
  assert.equal(again.ok, true);
  // 一轮 = 两步 × 两发 = 4 发；第二轮刚推完 handshake ⇒ 4 + 2 = 6
  assert.equal(sent.length, 6);
  assert.equal(loadGateState(store)!.step, 'rooms');
});

// ── base 口子（CI 不碰外站）────────────────────────────────────────────

test('base 口子：一个值同时替换**两台主机**（user-njs 与 v.cmcc-cs.cn）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  saveGateBase(store, 'http://127.0.0.1:19000/', NOW);
  assert.equal(loadGateBase(store), 'http://127.0.0.1:19000', '存的时候去掉尾斜杠');

  const { transport, sent } = fakeUpstream();
  runRound(store, transport);
  assert.equal(sent.length, 4);
  for (const s of sent) assert.match(s.url, /^http:\/\/127\.0\.0\.1:19000\//);
});

// ── 路由 ──────────────────────────────────────────────────────────────

function callRoute(
  d: Parameters<typeof mcloudRoutes>[0],
  method: string,
  path: string,
  body?: unknown,
) {
  const entry = mcloudRoutes(d).find((r) => `${r.method} ${r.path}` === `${method} ${path}`)!;
  const req = { method, path, body: body === undefined ? undefined : JSON.stringify(body) };
  return entry.handler(req as never);
}

test('路由 POST /api/live/gate/step：一步一发（两步推完），读数跟着回来', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  const logged: string[] = [];
  const d = testDeps(store, { transport, now: NOW, log: (m) => logged.push(m) });

  const first = JSON.parse(callRoute(d, 'POST', '/plugins/mcloud/api/live/gate/step').body) as {
    ok: boolean;
    done: boolean;
    step: string;
    reading: unknown;
  };
  assert.equal(first.ok, true);
  assert.equal(first.done, false);
  assert.equal(first.step, 'rooms');
  assert.equal(first.reading, null, '还没探完 ⇒ 读数是 null（不是半截数据）');

  const second = JSON.parse(callRoute(d, 'POST', '/plugins/mcloud/api/live/gate/step').body) as {
    done: boolean;
    step: string;
    reading: { active: boolean; liveCount: number };
    pool: { validCount: number };
  };
  assert.equal(second.done, true);
  assert.equal(second.step, 'done');
  assert.equal(second.reading.active, true);
  assert.equal(second.reading.liveCount, 2);
  assert.equal(second.pool.validCount, 0, '门是只读的：它不改口令的有效性');
});

test('路由 GET /api/live：带上门的读数（界面那一行）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  const d = testDeps(store, { transport, now: NOW });
  runRound(store, transport);

  const body = JSON.parse(callRoute(d, 'GET', '/plugins/mcloud/api/live').body) as {
    gate: { active: boolean; rooms: unknown[] };
  };
  assert.equal(body.gate.active, true);
  assert.equal(body.gate.rooms.length, 4);
});

test('路由 POST /api/config：`gateBase` 与 `baseUrl` **互不影响**（只改传了的那个）', () => {
  const store = memStore();
  store.ensureSchema();
  const d = testDeps(store, { now: NOW });

  callRoute(d, 'POST', '/plugins/mcloud/api/config', { baseUrl: 'http://127.0.0.1:19000' });
  callRoute(d, 'POST', '/plugins/mcloud/api/config', { gateBase: 'http://127.0.0.1:19001' });
  assert.equal(loadGateBase(store), 'http://127.0.0.1:19001');
  assert.equal(store.getState('mcloud.base_url'), 'http://127.0.0.1:19000', 'baseUrl 不该被抹掉');

  const get = JSON.parse(callRoute(d, 'GET', '/plugins/mcloud/api/config').body) as {
    gateBase: string;
    baseUrl: string;
  };
  assert.equal(get.gateBase, 'http://127.0.0.1:19001');
  assert.equal(get.baseUrl, 'http://127.0.0.1:19000');

  const bad = callRoute(d, 'POST', '/plugins/mcloud/api/config', { gateBase: 'ftp://x' });
  assert.equal(bad.status, 400);
});

test('池里的口令状态**不受门影响**（门只写日程与门开没开）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const { transport } = fakeUpstream();
  // 先往池里放一条"抓到的口令" —— ⚠ 用池**自己的**构造器播种，
  //   别手写那份 JSON：字段名一改，手写的夹具会**静默**变成一份空池（我自己就踩过）
  const seeded = emptyPool();
  normalize(seeded, Date.parse(NOW));
  note(seeded, ['云盘AI高效复盘'], 'xiaohongshu', Date.parse(NOW));
  store.setState(POOL_KEY, serializePool(seeded), NOW);

  runRound(store, transport);
  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '云盘AI高效复盘'), 'unknown', '门不改口令状态（唯一的验证途径是拿去领）');
  assert.equal(validCount(pool), 0);
});
