// 调试页那一排小卡的数据源：`GET /plugins/mcloud/api/debug/last`。
//
// 它回答"这一族上次跑成了没有"，**只读运行记录**，不新造状态。
// 判据：每族取运行记录里**最近一条**包含该族步骤的记录；没有就回 `null`（不编一个"成功"）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { appendRun } from '../src/mcloud/runLog.ts';
import { testDeps } from './helpers.ts';

const NOW = '2026-11-26T04:00:00.000Z';

function storeWithRuns() {
  const store = memStore();
  store.ensureSchema();
  // 旧的一条：算力失败
  appendRun(store, {
    task: 'daily',
    acct: 'a',
    who: '小号',
    at: '2026-11-25T01:00:00.000Z',
    ms: 1000,
    ok: false,
    note: '第 1 步失败',
    steps: [{ name: '算力大作战', ok: false, note: '还没有可用的 H5 票', idle: false }],
  });
  // 新的一条：算力成功、签到成功
  appendRun(store, {
    task: 'daily',
    acct: 'a',
    who: '小号',
    at: NOW,
    ms: 900,
    ok: true,
    note: '都成了',
    steps: [
      { name: '签到', ok: true, note: '网盘今日已签，+3 云朵', idle: false },
      { name: '算力大作战', ok: true, note: '执行任务 1 项', idle: false },
    ],
  });
  return store;
}

test('每族取"最近一条包含该族步骤"的记录；从没出现过的回 null', async () => {
  const store = storeWithRuns();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const route = routes.find((x) => x.path === '/plugins/mcloud/api/debug/last' && x.method === 'GET')!;
  assert.ok(route, '要有 /debug/last 这条路由');
  const r = await route.handler({ query: '' });
  const body = JSON.parse(r.body) as {
    tasks: Record<string, { at: string; ok: boolean; note: string } | null>;
    switches: { id: string; label: string }[];
  };
  assert.equal(body.switches.length, 6, '六族都要列出来（界面按它画卡）');
  assert.equal(body.tasks['signin']?.ok, true);
  assert.equal(body.tasks['signin']?.at, NOW, '要取**最近**那条');
  assert.equal(body.tasks['tokenpk']?.ok, true, '旧的失败被新的成功盖掉');
  assert.equal(body.tasks['tokenpk']?.note, '执行任务 1 项');
  // 从没出现在记录里的族 ⇒ null，不编
  assert.equal(body.tasks['redpack'], null);
  assert.equal(body.tasks['expansion'], null);
});

test('一条记录都没有 ⇒ 全是 null（不是空对象、不是编"成功"）', async () => {
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const route = routes.find((x) => x.path === '/plugins/mcloud/api/debug/last' && x.method === 'GET')!;
  const body = JSON.parse((await route.handler({ query: '' })).body) as {
    tasks: Record<string, unknown>;
  };
  for (const k of ['signin', 'expansion', 'appTask', 'redpack', 'tokenpk', 'playAI']) {
    assert.equal(body.tasks[k], null, `${k} 应该是 null`);
  }
});

test('读数里带上趣玩AI 上次读到的那一份（没读过就是 null）', async () => {
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const rd = routes.find((x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET')!;
  const before = JSON.parse((await rd.handler({ query: '' })).body) as {
    playai?: { line: string; reading: unknown; drawEnabled: boolean } | null;
  };
  // 没读过时**仍给一份壳**（代抽开关要能看），但读数是空的 —— 不编一个空读数
  assert.equal(before.playai?.line, '', '没读过时读数是空串');
  assert.equal(before.playai?.reading, null, '没读过就没有 reading');
  assert.equal(before.playai?.drawEnabled, false);

  const { savePlayAiSnapshot } = await import('../src/mcloud/playAiState.ts');
  savePlayAiSnapshot(
    store,
    {
      at: NOW,
      ok: true,
      line: '2 个模块 · 5 件任务 · 2 件可做',
      reading: { modules: [], total: 5, done: 0, runnable: 2, manual: 1, todayGot: 0, canDraw: 0 },
      error: '',
    },
    NOW,
  );
  const after = JSON.parse((await rd.handler({ query: '' })).body) as {
    playai: { line: string; at: string } | null;
  };
  assert.equal(after.playai?.line, '2 个模块 · 5 件任务 · 2 件可做');
  assert.equal(after.playai?.at, NOW);
});

test('代抽开关：缺省关、能开能关，且与读数分开给（读数没跑过也能看开关）', async () => {
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const rd = routes.find((x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET')!;
  const before = JSON.parse((await rd.handler({ query: '' })).body) as {
    playai: { drawEnabled: boolean; line: string } | null;
  };
  assert.equal(before.playai?.drawEnabled, false, '缺省必须是关（花的是用户的次数）');
  assert.equal(before.playai?.line, '', '没读过时读数是空，不是编一个');

  const post = routes.find((x) => x.path === '/plugins/mcloud/api/playai/draw' && x.method === 'POST')!;
  assert.ok(post, '要有代抽开关这条路由');
  const bad = await post.handler({ query: '', body: JSON.stringify({ on: 'yes' }) });
  assert.equal(bad.status, 400, 'on 必须是布尔');

  const on = await post.handler({ query: '', body: JSON.stringify({ on: true }) });
  assert.equal(on.status, 200);
  const after = JSON.parse((await rd.handler({ query: '' })).body) as {
    playai: { drawEnabled: boolean };
  };
  assert.equal(after.playai.drawEnabled, true);

  await post.handler({ query: '', body: JSON.stringify({ on: false }) });
  const off = JSON.parse((await rd.handler({ query: '' })).body) as { playai: { drawEnabled: boolean } };
  assert.equal(off.playai.drawEnabled, false);
});

test('每族映射的步骤名，必须真的出现在 `dailyRun` 的 push 里（防静默失配）', async () => {
  // ⚠ 这条是补一次真实事故：`/debug/last` 原来按"开关 label"去运行记录里找步骤名，
  //   而 `dailyRun` push 的是「签到」「红包派对」这种**不同的词** ⇒ 六族全部回 null，
  //   界面上每格都写「还没跑过」。现在有一张显式映射表，这里再钉一遍"表里的名字真的有"。
  const fs = await import('node:fs');
  const daily = fs.readFileSync('src/mcloud/dailyRun.ts', 'utf8');
  // 两种写法都算：`push({ name: 'X' … })` 与 `push(await once('X', …))`
  const pushed = new Set(
    [
      ...daily.matchAll(/push\(\{\s*name: '([^']+)'/g),
      ...daily.matchAll(/name: '([^']+)', ok/g),
      ...daily.matchAll(/push\(await once\('([^']+)'/g),
    ].map((m) => m[1]),
  );
  const meta = fs.readFileSync('src/app/routes/groups/meta.ts', 'utf8');
  const block = /const STEP_NAMES: Record<string, string\[\]> = \{([\s\S]*?)\};/.exec(meta);
  assert.ok(block, '要有 STEP_NAMES 那张表');
  // ⚠ 先剥注释：注释里举了 `once('…')` 这种例子，直接抽会把 `…` 当成一个名字
  const names = [...block[1]!.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, `表里要有各族的步骤名：${names.join(',')}`);
  const missing = names.filter((n) => !pushed.has(n));
  assert.deepEqual(missing, [], `这些名字在 dailyRun 里没有对应的 push（会静默失配）：${missing.join(',')}`);
});
