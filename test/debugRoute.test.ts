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
    tasks: Record<string, { at: string; state: string; note: string } | null>;
    switches: { id: string; label: string }[];
  };
  assert.equal(body.switches.length, 6, '六族都要列出来（界面按它画卡）');
  assert.equal(body.tasks['signin']?.state, 'done');
  assert.equal(body.tasks['signin']?.at, NOW, '要取**最近**那条');
  assert.equal(body.tasks['tokenpk']?.state, 'done', '旧的失败被新的成功盖掉');
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
    playai?: { line: string; reading: unknown } | null;
  };
  // 没读过时**仍给一份壳**（代抽开关要能看），但读数是空的 —— 不编一个空读数
  assert.equal(before.playai?.line, '', '没读过时读数是空串');
  assert.equal(before.playai?.reading, null, '没读过就没有 reading');

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

test('⚠ 抽奖开关**整条删了**：没有 `POST /playai/draw`，读数里也没有 `drawEnabled`', async () => {
  // 2026-11-27 用户拍板：「抽奖不应该有开关，我都去做了还不抽，有病吧，只有开了做，就一定抽」。
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  assert.equal(
    routes.some((x) => x.path === '/plugins/mcloud/api/playai/draw'),
    false,
    '那条路由该删了',
  );
  const rd = routes.find((x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET')!;
  const body = JSON.parse((await rd.handler({ query: '' })).body) as {
    playai: Record<string, unknown> | null;
  };
  assert.equal('drawEnabled' in (body.playai ?? {}), false, '读数里不该再有这一格');
  // 但读数该有的还在
  assert.equal('autoTaskIds' in (body.playai ?? {}), true, '「插件会做哪几件」还得给');
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

test('窗口要够宽：3 个号 × 多次触发之后，某族"上次跑过"仍读得出来', async () => {
  const store = memStore();
  store.ensureSchema();
  // 3 个号 × 6 次触发 = 18 条记录；只有**最早**那一条里有「红包派对」
  for (let i = 0; i < 6; i++) {
    for (const acct of ['a', 'b', 'c']) {
      const at = `2026-11-2${6 - i}T0${i}:00:00.000Z`;
      appendRun(store, {
        task: 'daily',
        acct,
        who: acct,
        at,
        ms: 100,
        ok: true,
        note: 'ok',
        steps:
          i === 5 && acct === 'a'
            ? [{ name: '红包派对', ok: false, note: '那次没成', idle: false }]
            : [{ name: '签到', ok: true, note: '签了', idle: false }],
      });
    }
  }
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const route = routes.find((x) => x.path === '/plugins/mcloud/api/debug/last' && x.method === 'GET')!;
  const body = JSON.parse((await route.handler({ query: '' })).body) as {
    tasks: Record<string, { note: string } | null>;
  };
  assert.equal(body.tasks['redpack']?.note, '那次没成', '18 条之前的记录也要看得到');
});

test('⚠ `STEP_NAMES` 里写的步骤名，必须真的在 `dailyRun` 里 push 过（写错 = 那一格永远「还没跑过」）', async () => {
  // 2026-11-26：这张表是"族 id → 运行记录里的步骤名"的**唯一出处**，但它和
  // `dailyRun.ts` 里的 `push({name})` / `once('…')` 是两处手写的，没有任何东西钉住它们对齐。
  // 名字写错不会报错，只会让调试页那一格永远显示「还没跑过」—— 看起来像"没跑"。
  const { readFileSync } = await import('node:fs');
  const daily = readFileSync('src/mcloud/dailyRun.ts', 'utf8');
  const meta = readFileSync('src/app/routes/groups/meta.ts', 'utf8');
  // 真跑出来的步骤名（`once('X'` 与 `push({ name: 'X'`）
  const real = new Set<string>();
  for (const m of daily.matchAll(/once\('([^']+)'/g)) real.add(m[1]!);
  for (const m of daily.matchAll(/name: '([^']+)'/g)) real.add(m[1]!);
  assert.ok(real.size > 5, `只从 dailyRun 里抽到 ${real.size} 个步骤名，抽取规则可能失效了`);
  // STEP_NAMES 里的名字（只取 `族id: ['…', '…']` 那种形状的值，注释里的 `…` 不算）
  const start = meta.indexOf('const STEP_NAMES');
  const block = meta.slice(start, meta.indexOf('};', start));
  const claimed = [...block.matchAll(/^\s*[a-zA-Z]+:\s*\[([^\]]*)\]/gm)]
    .flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  const missing = claimed.filter((n) => !real.has(n));
  assert.deepEqual(missing, [], `这些步骤名在 dailyRun 里不存在：${missing.join(', ')}`);
});

test('⚠ 调试页那六格必须是**四态**：只按 `ok` 画会把「这次不跑」显示成「成了」', async () => {
  // 现场（2026-11-26 用户截图）：点「只跑趣玩AI」，调试页告诉他六族全成了 ——
  // 其中五行写的是「这次不跑（调试只点了别的）」。用户拿这一页测单族，而它给不出结论。
  //
  // 根因三条：① 跳过那一步的 `ok` 也是 true；② `meta.ts` 用 `hits.every(ok)` 判；
  // ③ 界面只认 `ok` 两态，`idle` / `skipped` 根本没用。
  const { mcloudRoutes } = await import('../src/mcloud/routes.ts');
  const { memStore } = await import('../src/store/memory.ts');
  const { appendRun } = await import('../src/mcloud/runLog.ts');
  const store = memStore();
  store.ensureSchema();
  const now = '2026-11-26T15:13:00.000Z';
  // 一条"调试只跑趣玩AI"的真实形状记录：其余五族 skipped，趣玩AI 是 idle（读到了数）
  appendRun(store, {
    task: 'daily',
    at: now,
    ms: 900,
    ok: true,
    note: '',
    acct: 'acct',
    steps: [
        { name: '签到', ok: true, idle: true, skipped: true, note: '这次不跑（调试只点了别的）' },
        { name: '任务拓展', ok: true, idle: true, skipped: true, note: '这次不跑（调试只点了别的）' },
        { name: 'App 任务', ok: true, idle: true, skipped: true, note: '这次不跑（调试只点了别的）' },
        { name: '红包派对', ok: true, idle: true, skipped: true, note: '这次不跑（调试只点了别的）' },
        { name: '算力大作战', ok: true, idle: true, skipped: true, note: '这次不跑（调试只点了别的）' },
        { name: '趣玩AI', ok: true, idle: true, note: '4 个模块 · 24 件任务 · 22 件可做' },
    ],
  });
  const routes = mcloudRoutes({
    store,
    now: () => now,
    log: () => {},
    baseUrl: '',
    transport: (() => {
      throw new Error('不该发请求');
    }) as never,
    pushDeps: {} as never,
  });
  const route = routes.find((r) => r.path.endsWith('/debug/last'))!;
  const res = await route.handler({ method: 'GET', path: route.path, query: new URLSearchParams(), headers: {} } as never);
  const body = JSON.parse(String((res as { body: string }).body));
  assert.equal(body.tasks.signin.state, 'skipped', '签到这次没跑 ⇒ skipped，不能是 done');
  assert.equal(body.tasks.expansion.state, 'skipped');
  assert.equal(body.tasks.playAI.state, 'idle', '趣玩AI 读到了数但没做成任何事 ⇒ idle');
  assert.equal(body.tasks.playAI.note, '4 个模块 · 24 件任务 · 22 件可做');
});
