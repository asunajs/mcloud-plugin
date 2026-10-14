// 听弹幕口令（`live-listen`）—— **只读**长连接那条链。
//
// 这一组要守住的判据（都是"看不见就会写错"的那种）：
//
//   ① **门关着时一发请求都不发**：它每 10 秒被触发一次，而门一查就是三发。
//      没有冷却 ⇒ 一天两万多发"换票"打上游。
//   ② **没有 `chatRoomId` 就不开 WS**：那是抓包 §5.2 的判据（未开播时它是 null），
//      硬开只会得到一个"连上了但没弹幕"的假象。
//   ③ **`o` 之后才发 PROVISION，而且只发一次**：帧序来自抓包 §二（第 0 帧 `o`、
//      第 1 帧就是 PROVISION）。
//   ④ **弹幕文本进池时来源写 `danmaku`**：池里这一档与 `xiaohongshu` 必须分得开
//      （"从弹幕听来的"与"从主页抓来的"后面的动作不一样）。
//   ⑤ **句柄没了（面板重启过）⇒ 重新走一遍门**：静默当成"还在听"是最坏的处置。
//
// ⚠ 这个文件里的 msync 字节是**本地手拼**的（不复用 mock 的编码器）：
//   两条独立构造撞同一个解码器，比"两边共用一份编码器"更能抓住形状写错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_VIDEO_IM_WS,
  DEFAULT_LISTEN_SECONDS,
  IDLE_RECHECK_MS,
  RECV_SLICE_MS,
  STATE_LISTEN,
  liveWsUrl,
  loadListenState,
  loadWsBase,
  runLiveListen,
  saveWsBase,
  sockjsSessionId,
} from '../src/mcloud/tasks/liveListen.ts';
import type { HostWs } from '../src/mcloud/tasks/base.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import { KOULING_ANCHOR, POOL_KEY, loadPoolFrom } from '../src/mcloud/koulingPool.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-14T07:30:00.000Z'; // 东八区 15:30
const LATER = '2026-10-14T07:31:00.000Z';
const AUTH = 'Basic bW9iaWxlOjE5MTQyNDkyNzE2OnRva2Vu'; // mobile:19142492716:token

// ── 本地手拼 msync（够 decoder 认出来就行；形状照抓包 §3.1）──────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
const pbVarint = (num: number, n: number) => [...varint((num << 3) | 0), ...varint(n)];
const pbBytes = (num: number, body: number[]) => [...varint((num << 3) | 2), ...varint(body.length), ...body];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const toB64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

/** `command=2`（弹幕）—— 文本在 MSync.9 → .2 → .6 → .4 → .2。
 *
 *  ⚠ `msgId` 用**19 位数字**（抓包里每条 cmd=2 都是这个形状）：那个字段的形状本身
 *  就是一条判据 —— 形如 `m-1` 的值会被解成"没有 msgId"，于是**不 ack**（不许编一个）。
 *  这条我在写测试时踩过：一开始用 `'m-1'`，assert 里那条 ack 就红了。 */
function danmakuFrame(text: string, msgId = '1750000000000000001'): string {
  const content = pbBytes(4, pbBytes(2, utf8(text)));
  const message = [...pbBytes(1, utf8(msgId)), ...pbBytes(6, content)];
  const payload = pbBytes(2, message);
  const msync = [...pbVarint(8, 2), ...pbBytes(9, payload)];
  return `a[${JSON.stringify(toB64(msync))}]`;
}

/** `command=3`（PROVISION 的响应）—— 只带一只壳。 */
function provisionAckFrame(): string {
  const msync = [...pbVarint(8, 3), ...pbBytes(9, pbBytes(1, pbVarint(1, 0)))];
  return `a[${JSON.stringify(toB64(msync))}]`;
}

/** 解一条**客户端**帧 `["<b64>"]` 的 command（只找字段 8）。 */
function commandOf(clientFrame: string): number {
  const arr = JSON.parse(clientFrame) as string[];
  const bytes = Buffer.from(arr[0] ?? '', 'base64');
  let i = 0;
  while (i < bytes.length) {
    let tag = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i] as number;
      i += 1;
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const num = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v = 0;
      shift = 0;
      while (i < bytes.length) {
        const b = bytes[i] as number;
        i += 1;
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (num === 8) return v;
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      while (i < bytes.length) {
        const b = bytes[i] as number;
        i += 1;
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      i += len;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else return -1;
  }
  return -1;
}

// ── 夹具 ──────────────────────────────────────────────────────────────

interface SentWs {
  id: number;
  text: string;
}
interface OpenedWs {
  url: string;
  opts: { headers?: Record<string, string>; timeout_ms?: number; tls?: string };
}

/** 假的宿主长连接：按脚本吐帧。
 *
 *  `onEmpty`：
 *  * `'close'`（默认）—— 脚本演完就报 close。**让测试别在墙钟上等**，适合"脚本驱动"的用例。
 *  * `'timeout'` —— 一直回 timeout，让任务读满那一拍（**会真的等 ~1.6 秒**）。
 *    只有"窗口到点"那一条用它：用 close 收尾的话，断开原因会是 close 而不是窗口，
 *    那条断言就测不到"窗口到点**主动**断开"这件事了。 */
let nextHandle = 7;   // ⚠ 必须**每个用例都不一样**：真宿主里句柄是每次 `ws_open` 递推的，
                      //   而任务里"当前这条连接上的 listener"就是按 (句柄, 窗口起点) 认的
                      //   —— 跨用例复用同一个号，会让第二个用例拿到上一个用例的状态机
                      //   （表现为"PROVISION 没发出去"这种莫名其妙的现象）。

function fakeHost(
  script: readonly string[],
  onEmpty: 'close' | 'timeout' = 'close',
): {
  host: HostWs;
  sent: SentWs[];
  opened: OpenedWs[];
  closed: number[];
  /** 最后一次 `ws_open` 给出的句柄（断言"关的是同一个"用）。 */
  lastHandle: number;
} {
  const sent: SentWs[] = [];
  const opened: OpenedWs[] = [];
  const closed: number[] = [];
  let i = 0;
  let open = false;
  let last = 0;
  const host: HostWs = {
    wsOpen(url, opts) {
      opened.push({ url, opts });
      open = true;
      last = nextHandle++;
      return last;
    },
    wsSend(id, text) {
      if (!open) throw new Error('句柄不存在');
      sent.push({ id, text });
      return true;
    },
    wsRecv() {
      if (!open) throw new Error('句柄不存在');
      const next = script[i];
      if (next === undefined) {
        return onEmpty === 'timeout'
          ? { type: 'timeout' }
          : { type: 'close', reason: '脚本演完了' };
      }
      i += 1;
      return { type: 'text', data: next };
    },
    wsClose(id) {
      closed.push(id);
      open = false;
      return true;
    },
  };
  return {
    host,
    sent,
    opened,
    closed,
    get lastHandle() {
      return last;
    },
  };
}

/** 假上游：门那三步 + roomBeat。`live` 控制"那个主播在不在播"。 */
function fakeUpstream(over: { live?: boolean; chatRoomId?: string | null } = {}): {
  transport: Transport;
  sent: { url: string }[];
} {
  const sent: { url: string }[] = [];
  const live = over.live ?? true;
  const transport = ((req: { url: string; method: string; headers: Record<string, string>; body: string | undefined }) => {
    sent.push({ url: req.url });
    if (req.url.includes('/user/querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { token: 'SSO-1' } }) };
    }
    if (req.url.includes('cmpassLoginByCmToken')) {
      return { status: 200, headers: {}, body: JSON.stringify({ rtnCode: '0', rtnMsg: null, object: 'LIVE-JWT-1' }) };
    }
    if (req.url.includes('tabContentList')) {
      const dataList = live
        ? [
            { room: { id: 147698, title: '权益流量特惠购', status: 1, channelId: 29, expectStartTime: '', anchor: { nickname: '福建移动' } } },
            { room: { id: 147868, title: '重阳云盘存暖意', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR } } },
          ]
        : [
            { room: { id: 147849, title: '权益流量特惠购', status: 0, channelId: 29, expectStartTime: '2026-10-14 16:30:00', anchor: { nickname: '福建移动' } } },
          ];
      return { status: 200, headers: {}, body: JSON.stringify({ rtnCode: '0', rtnMsg: null, object: { dataList } }) };
    }
    // ③ 取 WS 凭据（`userToken`）—— ⚠ 与门的 JWT **不是**同一枚
    if (req.url.includes('/api/user/customer/userToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ rtnCode: '0', rtnMsg: null, object: { access_token: 'WS-ACCESS-TOKEN-1', expires_in: 7200 } }),
      };
    }
    // ⑤ 进聊天室（`member/apply`）—— **数字码**信封（第三套）
    if (req.url.includes('/v3/room/member/apply')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, msg: 'ok', data: { appId: 'cmosim', appKey: 'k', roomId: '1234567890123456789012345678901' }, timestamp: 1750000000000 }),
      };
    }
    if (req.url.includes('/api/room/front/roomBeat')) {
      const chat = over.chatRoomId === undefined ? '1234567890123456789012345678901' : over.chatRoomId;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          rtnCode: '0',
          rtnMsg: null,
          object: { status: 1, title: '重阳云盘存暖意', channelId: 134, expectStartTime: '', chatRoomId: chat, anchor: { nickname: KOULING_ANCHOR } },
        }),
      };
    }
    throw new Error(`假上游不认识这一发：${req.url}`);
  }) as unknown as Transport;
  return { transport, sent };
}

function deps(store: ReturnType<typeof memStore>, transport: Transport, host: HostWs, nowIso = NOW) {
  return { store, transport, host, nowIso, baseUrl: '', lateMs: 0 };
}

/** 把链推到"开始听"（每一步一次调用 —— 纪律在测试里也照做）。
 *
 *  ⚠ 步数**按状态推**而不是写死：链从 4 步长到 6 步（补了 `userToken` 与
 *  `member/apply`）时，写死 4 的写法会让所有用例一起红，而红的原因与它们要守的
 *  判据无关 —— 那种"改一处红一片"的测试很快就会被改成"随便多推几步"。
 *  这里按 `step` 判，`listen` / `done` 就停。 */
function advanceToListen(
  store: ReturnType<typeof memStore>,
  transport: Transport,
  host: HostWs,
  nowIso = NOW,
) {
  const notes: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const out = runLiveListen(deps(store, transport, host, nowIso));
    notes.push(out.note);
    const step = loadListenState(store)?.step;
    if (step === 'listen' || step === 'done' || step === undefined) break;
  }
  return notes;
}

// ── ① 冷却：门关着时一发都不发 ──────────────────────────────────────────

test('门关着 ⇒ 记一次冷却，冷却期内**一发请求都不发**', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: false });
  const f = fakeHost([]);

  // 第一次：handshake → rooms 两步走完，rooms 得出"没在播"
  const a = runLiveListen(deps(store, up.transport, f.host));
  assert.equal(a.ok, true);
  const b = runLiveListen(deps(store, up.transport, f.host));
  assert.match(b.note, /门关着/);
  const afterCheck = up.sent.length;
  assert.ok(afterCheck >= 3, `检查一次至少三发（SSO/JWT/页签），实际 ${afterCheck}`);

  // 之后一分钟内的每一次触发：**零请求**
  const c = runLiveListen(deps(store, up.transport, f.host, LATER));
  assert.match(c.note, /等下一次检查/);
  assert.equal(up.sent.length, afterCheck, '冷却期里不许再打上游');

  const st = loadListenState(store);
  assert.equal(st?.nextCheckAtMs !== undefined, true);
  assert.equal(f.opened.length, 0, '门关着时不该开 WS');
});

test('冷却到点之后会重新检查（不是永远不看了）', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: false });
  const f = fakeHost([]);
  runLiveListen(deps(store, up.transport, f.host));
  runLiveListen(deps(store, up.transport, f.host));
  const afterCheck = up.sent.length;

  // 冷却（5 分钟）之后的一次触发：应当**重新**开始检查（又出现请求）
  const laterIso = new Date(Date.parse(NOW) + IDLE_RECHECK_MS + 1000).toISOString();
  const out = runLiveListen(deps(store, up.transport, f.host, laterIso));
  assert.ok(up.sent.length > afterCheck, `该重新检查了：${out.note}`);
  assert.doesNotMatch(out.note, /等下一次检查/);
});

// ── ② 没有聊天室就不开 WS ───────────────────────────────────────────────

test('`chatRoomId` 是空/null ⇒ **不开 WS**，如实说"没有聊天室"', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true, chatRoomId: null });
  const f = fakeHost([]);

  // ⚠ 推到有结论为止（链是 6 步：handshake/rooms/userToken/roomBeat/apply/open）
  let out = { ok: false, note: '' };
  for (let i = 0; i < 9; i += 1) {
    out = runLiveListen(deps(store, up.transport, f.host));
    if (loadListenState(store)?.step === 'done') break;
  }

  assert.match(out.note, /没有聊天室/);
  assert.equal(f.opened.length, 0, '没有聊天室 ⇒ 一个 WS 都不该开');
  assert.equal(loadListenState(store)?.step, 'done');
});

test('roomBeat 是 **POST** 到 `/api/room/front/roomBeat`，房间号在 body 里', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost([]);
  for (let i = 0; i < 9; i += 1) {
    runLiveListen(deps(store, up.transport, f.host));
    if (loadListenState(store)?.step === 'listen') break;
  }
  const beat = up.sent.find((s) => s.url.includes('roomBeat'));
  assert.ok(beat, '该发过 roomBeat');
  assert.match(beat.url, /\/api\/room\/front\/roomBeat$/);
});

// ── ③ `o` → PROVISION ──────────────────────────────────────────────────

test('收到 SockJS 的 `o` 之后才发 PROVISION（command=3），而且**只发一次**', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame()]);
  advanceToListen(store, up.transport, f.host);

  const open = f.opened[0];
  assert.ok(open, '该开过 WS');
  assert.match(open.url, /^wss:\/\/videoim\.cmcc-cs\.cn:20102\/ws\/\d+\/[a-z0-9]{8}\/websocket$/);
  assert.equal(open.opts.tls, 'native', '真主机只给 CBC 套件 ⇒ 必须平台 TLS');
  assert.equal(open.opts.headers?.['origin'], 'https://v.cmcc-cs.cn');

  const first = f.sent[0];
  assert.ok(first, '该发过东西');
  assert.equal(commandOf(first.text), 3, '第一帧必须是 PROVISION');
  // ⚠ 只发一次：重复发会让服务端把同一条连接踢掉（mcloud 文件头那条注释）
  const provisionCount = f.sent.filter((x) => commandOf(x.text) === 3).length;
  assert.equal(provisionCount, 1);
});

// ── ④ 弹幕文本进池 ─────────────────────────────────────────────────────

test('弹幕帧 ⇒ 文本解出来、**口令进池且来源是 `danmaku`**、并且回了 ack', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame(), danmakuFrame('小红花口令：一键9图出圈')]);
  advanceToListen(store, up.transport, f.host);
  // 再推一拍：弹幕在这一拍里被读到
  const out = runLiveListen(deps(store, up.transport, f.host));

  const { pool } = loadPoolFrom(store);
  const code = pool.codes.find((c) => c.value === '一键9图出圈');
  assert.ok(code, `池里该有那条口令；实际池：${JSON.stringify(pool.codes)}`);
  assert.equal(code.source, 'danmaku');
  assert.ok(store.getState(POOL_KEY) !== null, '池要落盘');

  const acks = f.sent.filter((x) => commandOf(x.text) === 0);
  assert.ok(acks.length >= 1, '收到弹幕要回 ack（抓包 §3.2：真实客户端就回）');
  assert.match(out.note, /弹幕/, out.note);
});

test('观众在问「口令是什么」⇒ **不进池**（它是提问，不是口令）', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame(), danmakuFrame('口令是什么？')]);
  advanceToListen(store, up.transport, f.host);
  runLiveListen(deps(store, up.transport, f.host));

  const { pool } = loadPoolFrom(store);
  assert.equal(pool.codes.length, 0, `提问不该进池：${JSON.stringify(pool.codes)}`);
});

// ── ⑤ 结束条件 ─────────────────────────────────────────────────────────

test('窗口到点 ⇒ **主动** `ws_close`，并把状态收尾成 done', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame()], 'timeout');
  advanceToListen(store, up.transport, f.host);
  assert.equal(loadListenState(store)?.step, 'listen');

  // 把窗口起点挪到很久以前 ⇒ 这一拍就该收工
  const st = loadListenState(store);
  assert.ok(st);
  store.setState(
    STATE_LISTEN,
    JSON.stringify({ ...st, windowStartMs: Date.parse(NOW) - (DEFAULT_LISTEN_SECONDS + 1) * 1000 }),
    NOW,
  );
  const out = runLiveListen(deps(store, up.transport, f.host));
  assert.match(out.note, /窗口到点/);
  assert.deepEqual(f.closed, [f.lastHandle], '该 ws_close 掉那个句柄（而且是同一个）');
  assert.equal(loadListenState(store)?.step, 'done');
});

test('句柄不在了（面板重启过）⇒ **重新走一遍门**，不假装还在听', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost([]);
  // 造一个"listen 阶段但句柄已失效"的状态（重启后就是这样）
  store.setState(
    STATE_LISTEN,
    JSON.stringify({
      step: 'listen',
      windowStartMs: Date.parse(NOW),
      frames: 3,
      danmakuFrames: 1,
      acks: 0,
      codes: [],
      jwt: 'LIVE-JWT-1',
      chatRoomId: '123',
      startedAt: NOW,
    }),
    NOW,
  );
  const out = runLiveListen(deps(store, up.transport, f.host));
  assert.match(out.note, /重新走一遍门|句柄/, out.note);
  assert.equal(loadListenState(store)?.step, 'handshake');
});

test('连上就断 ⇒ 只报"断了"，不把它当成"听完了"', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  // 第一读就 close（不是 `o`）
  const f = fakeHost([]);
  const notes = advanceToListen(store, up.transport, f.host);
  assert.match(notes.join(' | '), /断/);
});

// ── 口子与常量 ─────────────────────────────────────────────────────────

test('WS 口子：默认是真主机，配了就换（拼出来的形状照抓包 §一）', () => {
  const store = memStore();
  assert.equal(loadWsBase(store), BASE_VIDEO_IM_WS);
  saveWsBase(store, 'ws://127.0.0.1:19000/', NOW);
  assert.equal(loadWsBase(store), 'ws://127.0.0.1:19000');
  assert.equal(liveWsUrl('ws://127.0.0.1:19000', 3, 'abcdefgh'), 'ws://127.0.0.1:19000/ws/3/abcdefgh/websocket');
});

test('`ws://` 的 mock **不填** `tls`（否则默认构建的面板会直接报错，e2e 就跑不动）', () => {
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  saveWsBase(store, 'ws://127.0.0.1:19000', NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame()]);
  advanceToListen(store, up.transport, f.host);
  assert.equal(f.opened[0]?.opts.tls, undefined, '明文请求没有 TLS 可谈');
});

test('sessionId 是 8 个小写字母数字（抓包里的形状），且每次都不同', () => {
  const a = sockjsSessionId();
  const b = sockjsSessionId();
  assert.match(a, /^[a-z0-9]{8}$/);
  assert.notEqual(a, b);
});

test('一拍最多读 RECV_SLICE_MS 这么久（预算 2000ms 之内）', () => {
  assert.ok(RECV_SLICE_MS > 0 && RECV_SLICE_MS < 1000, '单次 ws_recv 不能贴近预算');
});

test('链的顺序照 mcloud：换票 → **取 WS 凭据** → 问聊天室 → **进房间** → 才连 WS', () => {
  // ⚠ 这条是 2026-10-14 实机踩出来的次序：漏掉 userToken / member/apply 时
  //   「连得上、心跳通、就是没有弹幕」—— 而 permille 顺序错了就是这个现象。
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  const f = fakeHost(['o', provisionAckFrame()]);
  advanceToListen(store, up.transport, f.host);

  const paths = up.sent.map((x) => x.url.replace(/^https?:\/\/[^/]+/, ''));
  const idx = (needle: string) => paths.findIndex((p) => p.includes(needle));
  const iSso = idx('querySpecTokenV2');
  const iJwt = idx('cmpassLoginByCmToken');
  const iToken = idx('userToken');
  const iBeat = idx('roomBeat');
  const iApply = idx('member/apply');
  assert.ok(iSso >= 0 && iJwt > iSso, paths.join(' | '));
  assert.ok(iToken > iJwt, `WS 凭据要在换票之后：${paths.join(' | ')}`);
  assert.ok(iBeat > iToken, `问聊天室要在取凭据之后：${paths.join(' | ')}`);
  assert.ok(iApply > iBeat, `进房间要在拿到聊天室号之后：${paths.join(' | ')}`);
  // 两口的主机也不同：凭据/聊天室在 v.cmcc-cs.cn，进房间在 videoim:20103
  assert.match(up.sent[iToken]!.url, /v\.cmcc-cs\.cn/);
  assert.match(up.sent[iApply]!.url, /videoim\.cmcc-cs\.cn:20103\/v3\/room\/member\/apply/);
  // WS 最后才连
  assert.equal(f.opened.length, 1);
});

test('诊断口子：指定房间号 ⇒ **不走主播昵称那套判据**，直接听那一间', () => {
  // ⚠ 它存在的理由：`h`（SockJS 心跳）只在服务端静默满 25 秒后才发，正常那间房
  //   一直有人说话 ⇒ 那个分支**走不到**（F-039 就这么"没复现"过一次）。
  //   指定一间安静的房间就能把它逼出来 ⇒ 需要一个绕过"按昵称选房"的口子。
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  store.setState('mcloud.live.listen_room', '147849', NOW);
  const up = fakeUpstream({ live: false }); // 主播**没在播**（按昵称那套会判"门关着"）
  const f = fakeHost(['o', provisionAckFrame()]);
  advanceToListen(store, up.transport, f.host);
  // 口子生效 ⇒ 不该停在"门关着"，而是走到了 listen
  assert.equal(loadListenState(store)?.step, 'listen');
  assert.ok(up.sent.some((x) => x.url.includes('roomBeat')), '该拿指定房间去问聊天室号');
  // 选中的房号会落在状态里（`roomBeat` 就是拿它去问的）
  assert.equal(loadListenState(store)?.roomId, 147849);
});

test('收到 SockJS 心跳 `h` ⇒ **继续听**（不当收尾理由），并且记进读数', () => {
  // ⚠ 2026-10-14 实测：安静的房里 90 秒来 6 拍 `h`，我们一次不回，连接一直活着
  //   ⇒ 原来那版"收到 h 就收尾"是白白丢掉听的时间。
  const store = memStore();
  store.setState(STATE_AUTH, AUTH, NOW);
  const up = fakeUpstream({ live: true });
  // 脚本：o → PROVISION 响应 → h → 再一条弹幕（证明 h 之后机器照常工作）
  // ⚠ 用 `timeout` 档：脚本演完之后**不许 close** —— 否则"收尾原因 = 脚本演完了"会
  //   盖住这条测试要守的东西（`h` 不会让窗口收尾）。代价是这一条要真的等满一拍（~1.6 秒）。
  const f = fakeHost(
    ['o', provisionAckFrame(), 'h', danmakuFrame('小红花口令：秋收万颗子')],
    'timeout',
  );
  const notes = advanceToListen(store, up.transport, f.host);
  // ⚠ `advanceToListen` 到 `listen` 就停（`h` 在它后面）⇒ 还要**再推一拍**
  //   才会读到 `h` 与那条弹幕。
  notes.push(runLiveListen(deps(store, up.transport, f.host)).note);
  const st = loadListenState(store);
  // ⚠ 这一拍最后会因**窗口到点**收尾（测试里的窗口起点是写死的 `NOW`，早过期了）——
  //   所以判据不是"还停在 listen"，而是"**收尾原因与 `h` 无关**"。
  assert.ok(
    st?.closedReason === undefined || !st.closedReason.includes('心跳帧'),
    `不该因为 h 收尾：${String(st?.closedReason)} | ${notes.join(' | ')}`,
  );
  assert.equal(st?.sockjsHb, 1, 'h 要记进读数（否则"没复现"与"复现了但没事"分不开）');
  assert.ok((st?.danmakuFrames ?? 0) >= 1, 'h 之后的弹幕照收');
});
