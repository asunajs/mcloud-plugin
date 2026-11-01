// 「今日云朵」读数 —— 数据源是**当前的** `cloudRecordV2`，不是参考实现的旧端点。
//
// 守四件事：
//   ① 端点/参数是 `cloudRecordV2?aiDou=1&type=0&pageNumber=1&pageSize=100`
//      （旧 `mrp…/market/signin/public/cloudRecord` 一枪都不打）
//   ② 只数**东八区今天**、只数进账（`num > 0`）；支出不算进「N 次」
//   ③ 与面板「今日AI豆」共用同一条翻页链（满页就翻下一页）
//   ④ 读失败/解析失败只让这一行说“没读到”，**不把整趟日常染红**

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import { runTodayCloud } from '../src/mcloud/tasks/todayCloud.ts';

// 东八区 2026-10-23 12:00 = UTC 04:00
const NOW = '2026-10-23T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);

type Replies = string | ((url: string) => string);

function mkDeps(replies: Replies, status = 200) {
  const store = memStore();
  store.ensureSchema();
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const body =
      typeof replies === 'function' ? replies(req.url) : replies;
    return { status, headers: {}, body };
  }) as never;
  // 会话与 JWT 都种成“新鲜的”：否则 `withTokenGate` 会先去换票，
  // 而这条测试要看的只是读数那一枪。
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA-TEST', savedAt: NOW }),
    NOW,
  );
  store.setState(
    STATE_JWT,
    JSON.stringify({ at: new Date().toISOString(), jwt: 'JWT', referer: '', fingerprint: 'f' }),
    new Date().toISOString(),
  );
  const deps = {
    store,
    transport,
    nowIso: NOW,
    nowMs: () => NOW_MS,
    baseUrl: undefined,
  } as TaskDeps;
  return { deps, sent };
}

const envelope = (records: unknown[], total = records.length): string =>
  JSON.stringify({ code: 0, msg: 'success', result: { records, total } });

test('请求打当前端点：cloudRecordV2、aiDou=1、type=0、一页 100 条', () => {
  const { deps, sent } = mkDeps(
    envelope([{ num: 3, inserttime: '2026-10-23T09:00:00.000+08:00' }]),
  );
  const out = runTodayCloud(deps);
  assert.equal(out.ok, true);
  assert.equal(out.idle, true);
  assert.equal(out.note, '今日获得1次云朵数量共：3');

  assert.equal(sent.length, 1);
  const req = sent[0]!;
  assert.equal(req.method, 'GET');
  assert.ok(req.url.startsWith('https://m.mcloud.139.com/ycloud/signin/public/cloudRecordV2?'));
  assert.match(req.url, /aiDou=1/);
  assert.match(req.url, /type=0/);
  assert.match(req.url, /pageNumber=1/);
  assert.match(req.url, /pageSize=100/);
  // 旧端点一枪都不打
  assert.ok(!sent.some((q) => q.url.includes('/market/signin/public/cloudRecord?')));

  // H5 票在这一枪上；Authorization 由传输层按主机注入，构造器自己不塞
  assert.equal(req.headers.jwttoken, 'JWT');
  assert.equal(req.headers.deviceid, 'D1');
  assert.equal(req.headers['user-agent'], 'UA-TEST');
  assert.equal(req.headers.cookie, 'c=1');
});

test('baseUrl 覆盖主机（测试/mock 口径）', () => {
  const { deps, sent } = mkDeps(envelope([]));
  runTodayCloud({ ...deps, baseUrl: 'http://127.0.0.1:9/' });
  assert.ok(
    sent[0]!.url.startsWith('http://127.0.0.1:9/ycloud/signin/public/cloudRecordV2?'),
    sent[0]!.url,
  );
});

test('只数东八区今天、只数进账；支出与 0 不进「N 次」', () => {
  const body = envelope([
    { num: 3, inserttime: '2026-10-23T09:00:00.000+08:00' },
    { num: '6', inserttime: '2026-10-23T10:00:00.000+08:00' },
    { num: -2, inserttime: '2026-10-23T11:00:00.000+08:00' }, // 支出：不进次数
    { num: 4, inserttime: '2026-10-22T23:59:59.000+08:00' }, // 昨天
    { num: 0, inserttime: '2026-10-23T12:00:00.000+08:00' }, // 0：也不是一笔“获得”
  ]);
  const out = runTodayCloud(mkDeps(body).deps);
  assert.equal(out.note, '今日获得2次云朵数量共：9');
});

test('日界按东八区：UTC 还是 10-23，北京已经是 10-24', () => {
  // 北京 2026-10-24 00:10 = UTC 2026-10-23 16:10
  const nowMs = Date.parse('2026-10-23T16:30:00.000Z');
  const body = envelope([
    { num: 5, inserttime: '2026-10-23T16:10:00.000+00:00' }, // 北京 10-24：今天
    { num: 9, inserttime: '2026-10-23T15:50:00.000+00:00' }, // 北京 10-23 23:50：昨天
  ]);
  const { deps, sent } = mkDeps(body);
  // 只改判日界用的 nowMs；`nowIso` 仍给一个合法值（换票层会读它，但这里票是新鲜的）
  const out = runTodayCloud({ ...deps, nowMs: () => nowMs });
  assert.equal(out.note, '今日获得1次云朵数量共：5');
  assert.equal(sent.length, 1);
});

test('满一页就翻下一页（与面板「今日AI豆」同一条翻页链）', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    num: 1,
    inserttime: '2026-10-23T09:00:00.000+08:00',
  }));
  const page2 = [{ num: 5, inserttime: '2026-10-23T10:00:00.000+08:00' }];
  const { deps, sent } = mkDeps((url) =>
    url.includes('pageNumber=2') ? envelope(page2) : envelope(page1, 101),
  );
  const out = runTodayCloud(deps);
  assert.equal(out.note, '今日获得101次云朵数量共：105');
  assert.deepEqual(
    sent.map((q) => /pageNumber=(\d+)/.exec(q.url)?.[1]),
    ['1', '2'],
  );
});

test('读失败不染红整趟：ok=true + idle，说「没读到」而不是「失败」', () => {
  const http = mkDeps('boom', 500);
  const out1 = runTodayCloud(http.deps);
  assert.equal(out1.ok, true);
  assert.equal(out1.idle, true);
  assert.match(out1.note, /没读到云朵记录/);
  assert.doesNotMatch(out1.note, /失败/);

  const bad = mkDeps(JSON.stringify({ code: 0, msg: 'success', result: {} }));
  const out2 = runTodayCloud(bad.deps);
  assert.equal(out2.ok, true);
  assert.match(out2.note, /result\.records/);
});

test('没有记录 ⇒ 0 次 0 朵（参考实现也是这么打）', () => {
  const { deps } = mkDeps(envelope([]));
  const out = runTodayCloud(deps);
  assert.equal(out.note, '今日获得0次云朵数量共：0');
});
