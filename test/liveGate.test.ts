// 直播侧「门」的**协议层**（`/cmlive` 那一族）。
//
// 这一族与签到族/小红花族最要紧的差别，就是那个**第三套信封**：
// `{rtnCode: "0", rtnMsg, object}` —— 码是**字符串**、数据键叫 `object`。
// 所以这里守的头号断言是：**数字码必须解析失败**（那是刻意留的报警灯，
// 不是兼容性问题）。剩下的都是照 mcloud 实拍钉的判据：
//   · 房间嵌在 `dataList[].room` 里（不是 `dataList[].id`）
//   · `dataList: null` 是合法的"这个页签没有房间"
//   · 门 = `status == 1` **且** 昵称**精确相等**（实拍里有「福建移动」这种 status=1 的）
//   · 两个页签的同一间房要按 id 去重（先出现的赢）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_CMLIVE,
  GATE_TAB_IDS,
  KOULING_ANCHOR,
  LIVE_SOURCE_ID,
  LIVE_USER_AGENT,
  STATUS_ENDED,
  STATUS_LIVE,
  STATUS_NOT_STARTED,
  anchorRooms,
  cmliveHeaders,
  cmliveLine,
  cmpassLoginRequest,
  gateReadingLine,
  gateSpecTokenRequest,
  koulingRooms,
  mergeRooms,
  parseCmlive,
  parseCmpassLogin,
  parseTabContentList,
  tabContentListRequest,
  toProbeRooms,
} from '../src/mcloud/liveGate.ts';
import type { LiveRoom } from '../src/mcloud/liveGate.ts';

/** 造一个 `/cmlive` 响应体（**字符串码**）。 */
function cmlive(object: unknown, rtnCode = '0', rtnMsg: string | null = null): string {
  return JSON.stringify({ rtnCode, rtnMsg, object });
}

function room(over: Partial<LiveRoom> & { nickname?: string }): Record<string, unknown> {
  const { nickname, ...rest } = over;
  return {
    room: {
      id: rest.id ?? 1,
      title: rest.title ?? '某场直播',
      status: rest.status ?? STATUS_LIVE,
      channelId: rest.channelId ?? 134,
      expectStartTime: rest.expectStartTime ?? '',
      anchor: { nickname: nickname ?? KOULING_ANCHOR },
    },
  };
}

function roomsBody(entries: Record<string, unknown>[]): string {
  return cmlive({ dataList: entries });
}

// ── 信封 ──────────────────────────────────────────────────────────────

test('信封：字符串码 `"0"` 才是成功；`rtnMsg` 缺了也不影响', () => {
  const p = parseCmlive(cmlive({ a: 1 }));
  assert.equal(p.ok, true);
  assert.equal(p.value?.rtnCode, '0');
  assert.equal(p.value?.object && (p.value.object as { a: number }).a, 1);
});

test('信封：**数字码必须解析失败**（这是刻意留的报警灯，不是兼容性问题）', () => {
  const p = parseCmlive(JSON.stringify({ rtnCode: 0, rtnMsg: 'ok', object: {} }));
  assert.equal(p.ok, false);
  // 失败信息要**说清为什么**：只说"解析失败"的话，下一个人会去改解析器"兼容"它
  assert.match(p.error ?? '', /字符串/);
});

test('信封：不是 JSON / 缺 rtnCode 都如实失败', () => {
  assert.equal(parseCmlive('<html>502</html>').ok, false);
  assert.equal(parseCmlive(JSON.stringify({ object: {} })).ok, false);
});

test('信封：失败时 `cmliveLine` 带上游原话（rtnCode + rtnMsg）', () => {
  const p = parseCmlive(cmlive(null, '1001', '登录态失效'));
  assert.equal(p.ok, true);
  assert.equal(cmliveLine(p.value!), 'rtnCode=1001（登录态失效）');
});

// ── 请求构造 ──────────────────────────────────────────────────────────

test('① 换 SSO 用的是**直播侧的** toSourceId（017027，不是签到的 001005）', () => {
  const req = gateSpecTokenRequest('Basic xxx');
  assert.equal(req.url, 'https://user-njs.yun.139.com/user/querySpecTokenV2');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['Authorization'], 'Basic xxx');
  assert.deepEqual(JSON.parse(req.body!), { toSourceId: LIVE_SOURCE_ID });
  assert.equal(LIVE_SOURCE_ID, '017027');
});

test('① 的 base 口子（CI 指到 mock）：只换主机、路径不动', () => {
  const req = gateSpecTokenRequest('Basic xxx', 'http://127.0.0.1:19000');
  assert.equal(req.url, 'http://127.0.0.1:19000/user/querySpecTokenV2');
});

test('② 换 JWT：body 是 `{cmpassToken}`，**不带** Authorization（这一步还没有票）', () => {
  const req = cmpassLoginRequest('SSO-1');
  assert.equal(req.url, `${BASE_CMLIVE}/api/user/auth/cmpassLoginByCmToken`);
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body!), { cmpassToken: 'SSO-1' });
  assert.equal(req.headers['authorization'], undefined);
  assert.equal(req.headers['content-type'], 'application/json');
});

test('② `object` **就是那串 JWT 本身**（不是包着它的对象）', () => {
  const ok = parseCmpassLogin({ rtnCode: '0', object: 'JWT-180-CHARS' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'JWT-180-CHARS');
  // 包在对象里是**另一种形状** ⇒ 必须报错（上游若改了形状，这里要响）
  const bad = parseCmpassLogin({ rtnCode: '0', object: { token: 'JWT' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /字符串/);
  assert.equal(parseCmpassLogin({ rtnCode: '0', object: '' }).ok, false);
});

test("TLS：cmlive 那两枪带 `tls:'native'`，而 SSO 那枪**不带**", () => {
  // 判据来自 2026-10-14 实机（docs/findings.md F-030/F-031）：
  //   `v.cmcc-cs.cn` **只给 CBC 套件**（ECDHE-RSA-AES128-SHA），rustls 不实现 CBC
  //   ⇒ 凡是打这个主机的请求都必须走平台 TLS（面板 `legacy-tls` + `tls:"native"`）。
  //   而 `user-njs.yun.139.com` 是现代套件（TLS 1.3，实测）—— **它不该带**：
  //   带了会在没编那个 feature 的宿主上直接报错，白搭一次失败。
  assert.equal(cmpassLoginRequest('SSO-1').tls, 'native');
  assert.equal(tabContentListRequest(127, 'JWT').tls, 'native');
  assert.equal(tabContentListRequest(129, 'JWT').tls, 'native');
  assert.equal(gateSpecTokenRequest('Basic xxx').tls, undefined);
  // ⚠ 主机判据是**同一个常量**：换主机必须同时换这一处，否则"只给 CBC"那个事实会被忘掉
  assert.ok(cmpassLoginRequest('SSO-1').url.startsWith(BASE_CMLIVE));
  assert.ok(!gateSpecTokenRequest('Basic xxx').url.startsWith(BASE_CMLIVE));
});

test('③ 两个页签的 URL 逐字：`tabId→contentType→pageNo→channelId` 顺序照实拍', () => {
  const a = tabContentListRequest(127, 'JWT');
  const b = tabContentListRequest(129, 'JWT');
  assert.equal(a.url, `${BASE_CMLIVE}/api/channel/channel/tabContentList?tabId=127&contentType=0&pageNo=1&channelId=134`);
  assert.equal(b.url, `${BASE_CMLIVE}/api/channel/channel/tabContentList?tabId=129&contentType=0&pageNo=1&channelId=134`);
  assert.equal(a.method, 'GET');
  assert.equal(a.body, undefined);
  assert.deepEqual(GATE_TAB_IDS, [127, 129]);
});

test('③ 的头：鉴权走 `Authorization`（**不是**签到族的 jwttoken），且不伪造浏览器/Cookie', () => {
  const h = tabContentListRequest(127, 'JWT-LIVE').headers;
  assert.equal(h['authorization'], 'JWT-LIVE');
  assert.equal(h['jwttoken'], undefined);
  assert.equal(h['user-agent'], LIVE_USER_AGENT);
  assert.equal(h['origin'], 'https://v.cmcc-cs.cn');
  assert.equal(h['x-requested-with'], 'XMLHttpRequest');
  // 这几个是浏览器/WebView 自己产生的，纯协议实现里不该有
  for (const k of ['cookie', 'connection', 'sec-fetch-mode', 'x-tingyun']) {
    assert.equal(h[k], undefined, `不该带 ${k}`);
  }
});

test('头：没有票时**不发**空的 Authorization（空串比"没有这一枚"更糟）', () => {
  assert.equal(cmliveHeaders()['authorization'], undefined);
  assert.equal(cmliveHeaders('')['authorization'], undefined);
});

// ── 房间解析 ──────────────────────────────────────────────────────────

test('解析：房间嵌在 `dataList[].room` 里 —— `dataList[].id` **不是**房间 id', () => {
  const body = cmlive({
    dataList: [
      { id: 999999, type: 1, room: { id: 147606, title: '云盘直播福利场', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR } } },
    ],
  });
  const p = parseTabContentList(parseCmlive(body).value!);
  assert.equal(p.ok, true);
  assert.equal(p.value?.length, 1);
  assert.equal(p.value?.[0]?.id, 147606);
  assert.equal(p.value?.[0]?.anchorNickname, KOULING_ANCHOR);
});

test('解析：`dataList: null` 是**合法**的"这个页签没有房间" ⇒ 回空表，不是报错', () => {
  const p = parseTabContentList(parseCmlive(cmlive({ dataList: null })).value!);
  assert.equal(p.ok, true);
  assert.deepEqual(p.value, []);
});

test('解析：`dataList` 不是数组才是错（形状变了要响）', () => {
  const p = parseTabContentList(parseCmlive(cmlive({ dataList: {} })).value!);
  assert.equal(p.ok, false);
});

test('解析：`rtnCode != 0` 如实带原话失败（不能当成"没有房间"）', () => {
  const p = parseTabContentList(parseCmlive(cmlive(null, '1001', '登录态失效')).value!);
  assert.equal(p.ok, false);
  assert.match(p.error ?? '', /1001/);
  assert.match(p.error ?? '', /登录态失效/);
});

test('解析：缺字段的房**不丢**（id 缺了给 0、昵称缺了给空串）—— 丢房间等于漏一场口令', () => {
  const p = parseTabContentList(parseCmlive(cmlive({ dataList: [{ room: {} }] })).value!);
  assert.equal(p.ok, true);
  assert.equal(p.value?.length, 1);
  assert.equal(p.value?.[0]?.id, 0);
  assert.equal(p.value?.[0]?.status, -1);
  assert.equal(p.value?.[0]?.anchorNickname, '');
});

test('解析：没有 `room` 的那一层（活动/视频包装）跳过，不算房间', () => {
  const p = parseTabContentList(parseCmlive(cmlive({ dataList: [{ type: 2, activity: {} }] })).value!);
  assert.equal(p.ok, true);
  assert.deepEqual(p.value, []);
});

// ── 门的判据 ──────────────────────────────────────────────────────────

test('门：**两个条件都要** —— status==1 且昵称精确相等', () => {
  const rooms: LiveRoom[] = [
    { id: 1, title: '在播·那个主播', status: STATUS_LIVE, channelId: 134, expectStartTime: '', anchorNickname: KOULING_ANCHOR },
    { id: 2, title: '在播·福建移动', status: STATUS_LIVE, channelId: 29, expectStartTime: '', anchorNickname: '福建移动' },
    { id: 3, title: '预告·那个主播', status: STATUS_NOT_STARTED, channelId: 134, expectStartTime: '2026-10-15 20:00:00', anchorNickname: KOULING_ANCHOR },
    { id: 4, title: '回放·那个主播', status: STATUS_ENDED, channelId: 134, expectStartTime: '', anchorNickname: KOULING_ANCHOR },
  ];
  assert.deepEqual(koulingRooms(rooms).map((r) => r.id), [1]);
  // 日程要**留着**预告与回放（`expectStartTime` 只在预告那一档有用）
  assert.deepEqual(anchorRooms(rooms).map((r) => r.id), [1, 3, 4]);
  assert.equal(STATUS_NOT_STARTED, 0);
  assert.equal(STATUS_ENDED, 6);
});

test('门：昵称是**精确相等** —— 「移动心选」这类含"移动"的一个都拦不住包含式判据', () => {
  const rooms: LiveRoom[] = ['移动心选', '移动臻选', '中国移动云盘官方'].map((n, i) => ({
    id: i + 1,
    title: n,
    status: STATUS_LIVE,
    channelId: 134,
    expectStartTime: '',
    anchorNickname: n,
  }));
  assert.deepEqual(koulingRooms(rooms), []);
  assert.deepEqual(anchorRooms(rooms), []);
});

test('去重：两个页签的同一间房按 id 合并，**先出现的赢**', () => {
  const a: LiveRoom = { id: 147606, title: '福利场', status: 1, channelId: 134, expectStartTime: '', anchorNickname: KOULING_ANCHOR };
  const b: LiveRoom = { ...a, title: '回放页签里那份（标题不同）' };
  const merged = mergeRooms([[a], [b]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.title, '福利场');
  // 三个页签也照样合并（`GATE_TAB_IDS` 以后可能变长）
  assert.equal(mergeRooms([[a], [b], [{ ...a, id: 2 }]]).length, 2);
});

test('桥到池：`toProbeRooms` 丢掉不参与判据的字段（channelId 就是其中一个）', () => {
  const rooms: LiveRoom[] = [
    { id: 7, title: 'T', status: 1, channelId: 29, expectStartTime: '2026-10-15 20:00:00', anchorNickname: KOULING_ANCHOR },
  ];
  const probes = toProbeRooms(rooms);
  assert.deepEqual(probes, [
    { roomId: 7, title: 'T', status: 1, expectStartTime: '2026-10-15 20:00:00', anchorNickname: KOULING_ANCHOR },
  ]);
  assert.equal('channelId' in probes[0]!, false);
});

// ── 人话 ──────────────────────────────────────────────────────────────

test('人话：门开/没开/开着的不是他 —— **三种都要说得出来**', () => {
  const live = (nick: string, id: number): LiveRoom => ({
    id,
    title: `场${id}`,
    status: STATUS_LIVE,
    channelId: 134,
    expectStartTime: '',
    anchorNickname: nick,
  });
  const preview: LiveRoom = { ...live(KOULING_ANCHOR, 9), status: STATUS_NOT_STARTED, title: '下一场' };

  assert.match(gateReadingLine([live(KOULING_ANCHOR, 1)]), /门开着/);
  assert.match(gateReadingLine([live('福建移动', 2)]), /都不是「中国移动云盘」/);
  assert.match(gateReadingLine([preview]), /门关着：谁都没在播/);
});
