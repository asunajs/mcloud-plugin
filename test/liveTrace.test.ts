import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import {
  TRACE_KEY,
  TRACE_MAX,
  maskCode,
  readTrace,
  traceBegin,
  traceStep,
} from '../src/mcloud/liveTrace.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';

const NOW = '2026-11-16T10:30:00.000Z';

test('追踪环：一趟开始时清空，之后一条条按顺序读回来', async () => {
  const store = memStore();
  traceStep(store, NOW, 'collect/查开播', '开播了', { ok: true, ms: 120 });
  traceStep(store, NOW, 'account', '小号：都成了', { ok: true });

  traceBegin(store, NOW);
  assert.deepEqual(readTrace(store), [], '开新的一趟必须清空（环里只留最近那一趟）');

  traceStep(store, NOW, 'collect/查开播', '没开播', { ok: false });
  const [one] = readTrace(store);
  assert.equal(one?.step, 'collect/查开播');
  assert.equal(one?.note, '没开播');
  assert.equal(one?.ok, false);
});

test('追踪环：有上限（不能把 state 撑大），旧的先丢', async () => {
  const store = memStore();
  traceBegin(store, NOW);
  for (let i = 0; i < TRACE_MAX + 30; i++) traceStep(store, NOW, 'step' + String(i));
  const all = readTrace(store);
  assert.equal(all.length, TRACE_MAX);
  assert.equal(all[0]?.step, 'step30', '前面 30 条该被挤掉');
  assert.equal(all[all.length - 1]?.step, 'step' + String(TRACE_MAX + 29));
});

test('追踪环：坏值当空（别让一个坏 JSON 把任务带崩）', async () => {
  const store = memStore();
  store.setState(TRACE_KEY, '{不是数组', NOW);
  assert.deepEqual(readTrace(store), []);
});

test('⚠ 口令进环要脱敏（原文留在池里就够，环是快照）', async () => {
  const masked = maskCode('云盘AI高效复盘');
  assert.ok(masked.startsWith('云盘'), masked);
  assert.ok(!masked.includes('高效复盘'), '不能把口令原文写进追踪环：' + masked);
  assert.ok(masked.includes(String('云盘AI高效复盘'.length)), '要能看出长度：' + masked);
});

test('GET /api/live/trace：把环交出去（界面/curl 直接看）', async () => {
  const store = memStore();
  const routes = mcloudRoutes(testDeps(store));
  const r = routes.find((x) => x.path.endsWith('/api/live/trace'));
  assert.ok(r !== undefined, '缺 /live/trace 这条路由');
  assert.equal(r.method, 'GET');
  traceBegin(store, NOW);
  traceStep(store, NOW, 'collect/查开播', '开播了', { ok: true });
  const out = await r.handler({ method: 'GET', path: '/plugins/mcloud/api/live/trace', query: '' }) as {
    status: number;
    body: string;
  };
  assert.equal(out.status, 200);
  const body = JSON.parse(out.body) as { at: string; entries: { step: string; ok?: boolean }[] };
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0]?.step, 'collect/查开播');
  assert.equal(body.entries[0]?.ok, true);
});
