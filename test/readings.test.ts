// 聚合读数接口（`GET /plugins/mcloud/api/readings`）与「一次运行」读数的测试。
//
// # 为什么这两件事要一起测
//
// 界面只调**一个**接口 —— 它成了「界面能不能显示东西」的单点。所以两条性质
// 必须钉住：
//
//   ① **空库也不能炸**。刚装上的机器、刚清过库的机器上，这个接口要被调一次，
//      而那时七个区块的读数一个都没有。任何一处 `undefined.foo` 都会让
//      整个界面变成空白 —— 而用户看到的是「插件坏了」，不是「还没数据」。
//   ② **它是只读的**。界面打开时不该因为上游慢而卡住 —— 所以这个接口
//      一个上游请求都不发。这条要能被测出来（用一个"调用就失败"的 transport）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcloudRoutes } from '../src/mcloud/routes.ts';
import {
  DAILY_DONE_KEY,
  DAILY_LAST_KEY,
  readDailyRun,
} from '../src/mcloud/dailyState.ts';
import { memStore } from '../src/store/memory.ts';
import type { Store } from '../src/store/types.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-15T01:00:00.000Z';

/** 一调用就报错的 transport：用来证明读数接口**不发上游请求**。 */
const explodingTransport: Transport = () => {
  throw new Error('读数接口不该发上游请求');
};

function deps(store: Store) {
  return {
    store,
    transport: explodingTransport,
    now: () => NOW,
    log: () => {},
  };
}

function readings(store: Store): Record<string, any> {
  const r = mcloudRoutes(deps(store)).find(
    (x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET',
  );
  assert.ok(r, '没有 readings 路由');
  const res = r.handler({ method: 'GET', path: r.path });
  assert.equal(res.status, 200);
  return JSON.parse(res.body);
}

// ── ① 空库不能炸 ──────────────────────────────────────────────────────

test('空库：七个区块都在，且不抛（刚装上的机器上会被调一次）', () => {
  const d = readings(memStore());
  for (const k of ['account', 'daily', 'exchange', 'live', 'data', 'push', 'settings']) {
    assert.ok(k in d, `缺区块 ${k}`);
  }
  assert.equal(d.account.loggedIn, false);
  assert.equal(d.account.accounts.length, 0);
  assert.equal(d.daily.last, null, '还没跑过 ⇒ null（不是空对象）');
  assert.equal(d.daily.doneToday, false);
  assert.equal(d.data.matrix.read, 0);
  assert.equal(d.data.matrix.total, 2, '矩阵是轮着读的，总共两个市场');
});

test('推送区块诚实地说「还没做」，而不是给一个看着像好的空表', () => {
  const d = readings(memStore());
  assert.equal(d.push.implemented, false, '阶段 ⑤ 之前必须是 false —— 界面据此显示"还没做"');
});

test('⚠ 它是只读的：一个上游请求都不发（transport 一调就抛）', () => {
  // 上面 readings() 用的就是 explodingTransport —— 能返回就说明没发请求。
  // 这一条是「打开页面不会因为上游慢而卡住」的可执行版本。
  const d = readings(memStore());
  assert.ok(d.at, '没返回读数');
});

test('配置被改过也不炸（口子全是空串 / 畸形值时）', () => {
  const store = memStore();
  store.setState('mcloud.baseUrl', '', NOW);
  store.setState('mcloud.live.url', 'not a url', NOW);
  const d = readings(store);
  assert.equal(typeof d.settings.baseUrl, 'string');
  assert.equal(typeof d.settings.liveUrl, 'string');
});

// ── ② 「一次运行」读数 ────────────────────────────────────────────────

test('`readDailyRun`：库里那段 JSON 坏了 ⇒ 当作"还没跑过"，不抛', () => {
  const store = memStore();
  // 手改过库 / 老版本写的 / 写到一半断电 —— 三种都可能留下半截 JSON
  for (const bad of ['{', 'null', '[]', '{"steps": "不是数组"}', '乱码']) {
    store.setState(DAILY_LAST_KEY, bad, NOW);
    assert.equal(readDailyRun(store), null, `坏值 ${bad} 该被当成"还没跑过"`);
  }
  // 整个读数接口也不能因为这一段坏 JSON 而 500（那会让界面全白）
  assert.equal(readings(store).daily.last, null);
});

test('`readDailyRun`：正常值原样读出来', () => {
  const store = memStore();
  const run = {
    at: NOW,
    ok: true,
    note: '15 步全部完成',
    steps: [
      { name: '签到', ok: true, note: '签到完成（回查 infoV3 确认今日已签）', idle: false },
      { name: '复活卡', ok: true, note: '今天不用领', idle: true },
    ],
  };
  store.setState(DAILY_LAST_KEY, JSON.stringify(run), NOW);
  const got = readDailyRun(store);
  assert.ok(got);
  assert.equal(got.note, '15 步全部完成');
  assert.equal(got.steps.length, 2);
  assert.equal(got.steps[0]!.name, '签到');
  assert.equal(got.steps[1]!.idle, true, '`idle` 要保住 —— 界面据此显示成灰色而不是绿勾');
});

test('`doneToday` 认的是标记里的日期，不是"有没有过运行记录"', () => {
  const store = memStore();
  // 跑过（有读数）但今天没成功（没标记）—— 这两种状态要分得开：
  // 界面显示「上次 08:12 失败」和「今天已完成」是两件事
  store.setState(DAILY_LAST_KEY, JSON.stringify({ at: NOW, ok: false, note: '3 步失败', steps: [] }), NOW);
  assert.equal(readings(store).daily.doneToday, false);

  store.setState(DAILY_DONE_KEY, NOW.slice(0, 10), NOW);
  assert.equal(readings(store).daily.doneToday, true);
  // 标记是**前一天**的 ⇒ 今天还没跑
  store.setState(DAILY_DONE_KEY, '2026-10-14', NOW);
  assert.equal(readings(store).daily.doneToday, false);
});
