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
