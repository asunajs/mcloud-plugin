// 直播口令（`live-room`）—— **只读那一半**。
//
// 重点在四条"照实说"的地方：
//   · 它**不需要凭据**（主页是公开 GET）—— 这是全插件第一条，很容易被误当成"要 jwt"
//   · 整轮**只发一个请求**（面板执行预算 2000ms，见 liveRoom.ts 文件头）
//   · 没读到口令**不是失败**（多半是"这期没发"），报红只会在面板上刷噪声
//   · "空壳页"与"这期没发"在解析层**长得一样** ⇒ 只能给**标注为猜测**的提示，不能下结论

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_SHELL_HINT_CHARS,
  STATE_CODES,
  STATE_READING,
  clearLiveCodes,
  loadLiveCodes,
  loadLiveUrl,
  readLiveReading,
  runLiveRoom,
  saveLiveCodes,
  saveLiveUrl,
} from '../src/mcloud/tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL, xiaohongshuProfileHeaders } from '../src/mcloud/liveKouling.ts';
import {
  codeState,
  loadPoolFrom,
  note,
  noteClaim,
  savePoolTo,
  validCount,
} from '../src/mcloud/koulingPool.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import { memStore } from '../src/store/memory.ts';
import { startMock } from '../mock/upstream.mjs';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T14:00:00.000Z';

/** 一页"真的像主页"的 HTML（**故意做大** —— 免得踩到"小页面 = 空壳"那条提示）。 */
function bigPage(note: string): string {
  const filler = '<div>关注 · 粉丝 · 笔记</div>'.repeat(400);
  return `<html><head><script>window.__INITIAL_STATE__={"noteList":[{"displayTitle":"${note}"}]}</script></head><body>${filler}</body></html>`;
}

function transportReturning(body: string, status = 200): { transport: Transport; sent: { url: string; method: string; headers: Record<string, string> }[] } {
  const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
  const transport = ((req: any) => {
    sent.push({ url: req.url, method: req.method ?? 'GET', headers: req.headers ?? {} });
    return { status, headers: {}, body };
  }) as Transport;
  return { transport, sent };
}

test('只读且**不需要凭据**：store 里没有会话也照样抓（第一条这样的任务）', () => {
  const store = memStore();
  store.ensureSchema(); // ⚠ 故意**不**写 SESSION_KEY
  const { transport, sent } = transportReturning(bigPage('小红花口令：最新一期口令在此'));

  const out = runLiveRoom({ store, transport, nowIso: NOW });

  assert.equal(out.ok, true, '没有会话也该能跑 —— 主页是公开 GET');
  assert.equal(sent.length, 1, '整轮只该发一个请求（执行预算 2000ms）');
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[0]!.url, XIAOHONGSHU_KOULING_PROFILE_URL);
  // 伪装头是必须的：非常规 UA 会被回一个空壳页，而空壳与"没发"在解析层分不开
  assert.match(sent[0]!.headers['user-agent'] ?? '', /Chrome/);
  assert.equal(sent[0]!.headers['referer'], 'https://www.xiaohongshu.com/');

  const r = readLiveReading(store);
  assert.deepEqual(r!.codes, ['最新一期口令在此']);
  assert.match(out.note, /最新一期口令在此/);
});

test('没读到口令**不算失败**，但要把两种可能都说出来', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport } = transportReturning(bigPage('今天的云盘真好看'));

  const out = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(out.ok, true, '这多半是"这期没发" ⇒ 报红只会在面板上刷噪声');
  assert.match(out.note, /没读到口令/);
  assert.match(out.note, /也可能是这期没发/, '必须说清"空壳与没发长得一样"');
  assert.deepEqual(readLiveReading(store)!.codes, []);
});

test('页面小得可疑时给**标注为猜测**的提示（不是判据）', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport } = transportReturning('<html><body>请开启 JavaScript</body></html>');

  const out = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(out.ok, true);
  assert.ok(readLiveReading(store)!.chars < EMPTY_SHELL_HINT_CHARS);
  assert.match(out.note, /猜/, '要说清这是猜的');
  assert.match(out.note, /不是判据/);
});

test('网络失败：如实失败，且**不写读数**（免得界面上出现一份假读数）', () => {
  const store = memStore();
  store.ensureSchema();
  const transport = (() => ({ error: '请求失败: http status: 403' })) as unknown as Transport;

  const out = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(out.ok, false);
  assert.match(out.note, /403/);
  assert.equal(readLiveReading(store), null);
});

test('HTTP 非 200 也算失败，且把正文留在日志里', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport } = transportReturning('被挡了', 403);
  const out = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(out.ok, false);
  assert.match(out.note, /HTTP 403/);
  assert.equal(readLiveReading(store), null);
});

// ── 输入口（人给的口令）

test('输入口：存进去能读回；解析失败时**什么都不写**（半截数据比没有更难查）', () => {
  const store = memStore();
  store.ensureSchema();

  const bad = saveLiveCodes(store, '口令是什么', NOW);
  assert.equal(bad.ok, false);
  assert.equal(store.getState(STATE_CODES), null, '解析失败不该留下任何东西');

  const ok = saveLiveCodes(store, '复制口令1：短漫上新免费看\n无随机口令', NOW);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.codes, ['短漫上新免费看']);
  assert.deepEqual(loadLiveCodes(store)!.codes, ['短漫上新免费看']);
  assert.match(loadLiveCodes(store)!.how, /弹幕格式/);

  clearLiveCodes(store, NOW);
  assert.equal(loadLiveCodes(store), null);
});

// ── 路由（界面吃这两个）

function callRoute(deps: Parameters<typeof mcloudRoutes>[0], method: string, path: string, body?: unknown) {
  const key = `${method} ${path}`;
  const entry = mcloudRoutes(deps).find((r) => `${r.method} ${r.path}` === key);
  assert.ok(entry, `没有这条路由：${key}`);
  return entry.handler({ method, path, query: '', headers: {}, body: body === undefined ? '' : JSON.stringify(body) });
}

test('路由 GET /api/live：把读数、口令、以及"口令要人给"那句话都给界面', () => {
  const store = memStore();
  store.ensureSchema();
  const deps = testDeps(store, { now: NOW });

  const r = callRoute(deps, 'GET', '/plugins/mcloud/api/live');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body) as { reading: unknown; codes: unknown; url: string; note: string };
  assert.equal(d.reading, null, '还没抓过 ⇒ null（不是编一个空读数）');
  assert.equal(d.codes, null);
  assert.equal(d.url, XIAOHONGSHU_KOULING_PROFILE_URL);
  assert.match(d.note, /没法自动化/, '界面必须写清"口令要人给"，否则用户会以为插件坏了');
});

test('路由 POST /api/live/codes：存 / 清空 / 拒绝提问', () => {
  const store = memStore();
  store.ensureSchema();
  const logged: string[] = [];
  const deps = testDeps(store, { now: NOW, log: (m) => logged.push(m) });

  const ok = callRoute(deps, 'POST', '/plugins/mcloud/api/live/codes', { codes: '云盘AI高效复盘' });
  assert.equal(ok.status, 200);
  assert.equal((JSON.parse(ok.body) as { saved: number }).saved, 1);

  const bad = callRoute(deps, 'POST', '/plugins/mcloud/api/live/codes', { codes: '口令是什么' });
  assert.equal(bad.status, 400);
  assert.match((JSON.parse(bad.body) as { error: string }).error, /提问/);

  const cleared = callRoute(deps, 'POST', '/plugins/mcloud/api/live/codes', { clear: true });
  assert.equal(cleared.status, 200);
  assert.equal(loadLiveCodes(store), null);

  // 日志只出条数与来源，不出正文 —— 日志行会被面板截断，塞正文只会挤掉结论
  assert.ok(logged.some((l) => l.includes('存了 1 条')), logged.join('\n'));
});

test('路由 POST /api/live/codes：贴纯文本 body 也能存（少一步转换）', () => {
  const store = memStore();
  store.ensureSchema();
  const deps = testDeps(store, { now: NOW });

  const entry = mcloudRoutes(deps).find((r) => r.path.endsWith('/live/codes'))!;
  const r = entry.handler({ method: 'POST', path: entry.path, query: '', headers: {}, body: '短漫上新免费看' });
  assert.equal(r.status, 200);
  assert.deepEqual(loadLiveCodes(store)!.codes, ['短漫上新免费看']);
});

test('路由 GET /api/live：读数落库后能读回（界面卡片靠这个）', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport } = transportReturning(bigPage('小红花口令：云盘AI高效复盘'));
  runLiveRoom({ store, transport, nowIso: NOW });

  const deps = testDeps(store, { transport, now: NOW });
  const r = callRoute(deps, 'GET', '/plugins/mcloud/api/live');
  const d = JSON.parse(r.body) as { reading: { codes: string[]; chars: number } };
  assert.deepEqual(d.reading.codes, ['云盘AI高效复盘']);
  assert.ok(d.reading.chars > EMPTY_SHELL_HINT_CHARS);
});

test('读数与输入口是两个键 —— 抓主页不会把人给的口令冲掉', () => {
  const store = memStore();
  store.ensureSchema();
  saveLiveCodes(store, '云盘AI高效复盘', NOW);
  const { transport } = transportReturning(bigPage('小红花口令：另一条'));
  runLiveRoom({ store, transport, nowIso: NOW });

  assert.deepEqual(loadLiveCodes(store)!.codes, ['云盘AI高效复盘']);
  assert.deepEqual(readLiveReading(store)!.codes, ['另一条']);
  assert.notEqual(STATE_CODES, STATE_READING);
});

// ── 主页地址可配置（CI 必须能把它指到 mock，否则就得去敲真站点）

test('主页地址可改：指到哪就抓哪（CI 靠这个口子不碰外站）', () => {
  const store = memStore();
  store.ensureSchema();
  assert.equal(loadLiveUrl(store), XIAOHONGSHU_KOULING_PROFILE_URL, '默认是发布方的主页');

  saveLiveUrl(store, 'http://127.0.0.1:19040/xhs/profile', NOW);
  assert.equal(loadLiveUrl(store), 'http://127.0.0.1:19040/xhs/profile');

  const { transport, sent } = transportReturning(bigPage('小红花口令：云盘AI高效复盘'));
  runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(sent[0]!.url, 'http://127.0.0.1:19040/xhs/profile', '指到 mock 就该打 mock');
  assert.equal(readLiveReading(store)!.url, 'http://127.0.0.1:19040/xhs/profile');

  saveLiveUrl(store, '', NOW);
  assert.equal(loadLiveUrl(store), XIAOHONGSHU_KOULING_PROFILE_URL, '清空 = 回到默认');
});

test('改口令主页**不会**把上游基址一起抹掉（配置项互相踩是最难查的一类错）', () => {
  const store = memStore();
  store.ensureSchema();
  const deps = testDeps(store, { now: NOW });

  callRoute(deps, 'POST', '/plugins/mcloud/api/config', { baseUrl: 'http://127.0.0.1:19040' });
  assert.equal(store.getState('mcloud.base_url'), 'http://127.0.0.1:19040');

  callRoute(deps, 'POST', '/plugins/mcloud/api/config', { liveUrl: 'http://127.0.0.1:19040/xhs' });
  assert.equal(
    store.getState('mcloud.base_url'),
    'http://127.0.0.1:19040',
    '只改 liveUrl 却把 baseUrl 清了 ⇒ 所有云盘任务都会打真上游',
  );

  // 反过来也一样
  callRoute(deps, 'POST', '/plugins/mcloud/api/config', { baseUrl: 'http://127.0.0.1:9' });
  assert.equal(store.getState('mcloud.live.url'), 'http://127.0.0.1:19040/xhs');

  // 两个都不传 ⇒ 400（不是"默默把两个都清空"）
  assert.equal(callRoute(deps, 'POST', '/plugins/mcloud/api/config', {}).status, 400);
});

test('路由 GET /api/live：主页地址取的是**当前配置**，不是写死的常量', () => {
  const store = memStore();
  store.ensureSchema();
  const deps = testDeps(store, { now: NOW });

  saveLiveUrl(store, 'http://127.0.0.1:19040/xhs/profile', NOW);
  const d = JSON.parse(callRoute(deps, 'GET', '/plugins/mcloud/api/live').body) as { url: string };
  assert.equal(d.url, 'http://127.0.0.1:19040/xhs/profile');
});

// ── 口令池（业务档）：两条口径 + 一处真 bug 的修复

test('⚠ 两次抓主页之间至少隔 30 分钟（抓太勤会被风控挡成空壳，而那与"没发"长得一样）', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport, sent } = transportReturning(bigPage('小红花口令：云盘AI高效复盘'));

  const first = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(first.ok, true);
  assert.equal(sent.length, 1, '第一次照抓');

  const second = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(second.idle, true, '同一分钟内第二次 ⇒ **不是失败**，是按口径不抓');
  assert.equal(sent.length, 1, '一个请求都不发');
  // 原因写在代码注释里；日志只说"什么时候再看"
  assert.match(second.note, /分钟后再看/);

  // 30 分钟之后照抓（用同一份读数覆盖：这里只验"窗口过了就放行"）
  const later = new Date(Date.parse(NOW) + 31 * 60 * 1000).toISOString();
  const third = runLiveRoom({ store, transport, nowIso: later });
  assert.equal(third.ok, true);
  assert.equal(sent.length, 2, '窗口过了就放行');
});

test('⚠ 够 2 条**有效** ⇒ 停止抓取（这一场只发那么几条，继续抓只会重复撞同一批）', () => {
  const store = memStore();
  store.ensureSchema();
  const { pool } = loadPoolFrom(store);
  note(pool, ['甲', '乙'], 'xiaohongshu', Date.parse(NOW));
  noteClaim(pool, 'acc', '甲', 'claimed', Date.parse(NOW));
  noteClaim(pool, 'acc', '乙', 'alreadyClaimed', Date.parse(NOW));
  savePoolTo(store, pool, NOW);

  const { transport, sent } = transportReturning(bigPage('小红花口令：丙'));
  const out = runLiveRoom({ store, transport, nowIso: NOW });
  assert.equal(out.idle, true);
  assert.equal(sent.length, 0, '够了两条就不再抓');
  assert.match(out.note, /不用再抓/);
});

test('抓到的口令**进池**（状态是"未知"：抓到了 ≠ 验过了）', () => {
  const store = memStore();
  store.ensureSchema();
  const { transport } = transportReturning(bigPage('小红花口令：云盘AI高效复盘'));
  runLiveRoom({ store, transport, nowIso: NOW });

  const { pool } = loadPoolFrom(store);
  assert.equal(codeState(pool, '云盘AI高效复盘'), 'unknown');
  assert.equal(validCount(pool), 0, '没验过不算有效');
  assert.equal(pool.codes[0]?.source, 'xiaohongshu', '来源如实标');
});

test('⚠ 人贴进来的一栏文本：**空白也算分隔符**（原先会被当成一条口令发上去）', () => {
  const store = memStore();
  store.ensureSchema();

  // 这条是 mcloud 吃过的亏：「我明明填了两条，怎么只领了一条还说口令错」
  const r = saveLiveCodes(store, '短漫上新免费看 云盘AI高效复盘', NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['短漫上新免费看', '云盘AI高效复盘'], '空白分隔');

  const full = saveLiveCodes(store, '甲\u3000乙', NOW);
  assert.deepEqual(full.codes, ['甲', '乙'], '全角空格（手机输入法默认就是这个）');

  const mixed = saveLiveCodes(store, '口令是什么 云盘AI高效复盘', NOW);
  assert.deepEqual(mixed.codes, ['云盘AI高效复盘'], '切完之后**还要滤一次提问**（整行不是提问，切出来那段是）');

  // ⚠ 算法层的契约**没动**（`extractKouling` 仍然回 `['AAA 无随机','AAA']` 两条候选，
  //   那是它刻意的"更全"）；这里是**另一个问题**：到底拿哪几条去发。
  //   按 mcloud 的分隔符口径，`AAA 无随机` 切开就是 `AAA` + 标记 ⇒ 只发一条。
  const marker = saveLiveCodes(store, '小红花口令：AAA 无随机', NOW);
  assert.deepEqual(marker.codes, ['AAA'], '收尾标记不是口令，别拿它去白跑一枪');
});

test('路由 GET /api/live：带上池快照（界面要能看见"够没够两条""还要等多久"）', () => {
  const store = memStore();
  store.ensureSchema();
  const deps = testDeps(store, { now: NOW });

  const d = JSON.parse(callRoute(deps, 'GET', '/plugins/mcloud/api/live').body) as {
    pool: { validCount: number; stopScraping: boolean; xhsWaitMs: number; codes: unknown[] };
  };
  assert.equal(d.pool.validCount, 0);
  assert.equal(d.pool.stopScraping, false);
  assert.equal(d.pool.xhsWaitMs, 0, '没抓过 ⇒ 现在就能抓');
  assert.deepEqual(d.pool.codes, []);
});

// ── 线上层：起 mock 当真站点，把**真实响应**喂给任务
//
// 宿主 API 的请求是**同步**的，所以这里没法让任务自己去发 ——
// 但可以真发一次拿到响应，再把它当宿主返回喂进去。这样覆盖的是**夹具与提取器两端**
// （mock 造的 HTML 真的能被解析出那一条口令），而那正是最容易被写歪的一环。

test('③ 线上层：mock 上的"主页"真发一次，解析出的就是夹具里那一条口令', async () => {
  const mock = await startMock();
  try {
    const url = `${mock.url}/xhs/profile`;
    const resp = await fetch(url, { headers: xiaohongshuProfileHeaders() });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/html/);

    const store = memStore();
    store.ensureSchema();
    saveLiveUrl(store, url, NOW);

    const transport = ((req: any) => {
      assert.equal(req.url, url, '任务该打配置里那个地址');
      assert.equal(req.method, 'GET');
      return { status: 200, headers: {}, body: html };
    }) as Transport;

    const out = runLiveRoom({ store, transport, nowIso: NOW });
    assert.equal(out.ok, true);

    const r = readLiveReading(store)!;
    assert.deepEqual(r.codes, ['云盘AI高效复盘'], '夹具的 HTML 解不出这条 ⇒ 夹具或提取器有一边歪了');
    assert.ok(r.chars > EMPTY_SHELL_HINT_CHARS, '夹具页面必须比"空壳"阈值大，否则断言在测夹具');

    const sent = mock.requests[mock.requests.length - 1]!;
    assert.match(sent.headers['user-agent'] ?? '', /Chrome/, 'UA 伪装丢了会被回空壳页');
  } finally {
    await mock.close();
  }
});
