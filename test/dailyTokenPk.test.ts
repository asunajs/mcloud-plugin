// 「算力大作战」必须真的接进**日常那一趟**，而且关掉开关时一发请求都不发。
//
// 钉的是接线：步骤在不在、位置对不对、逐行有没有交给 `DailyStep.lines`、
// 以及"关了就是零请求"。读数的形状在 `tokenPk.test.ts` / `tokenPkRules.test.ts`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runDaily } from '../src/mcloud/dailyRun.ts';
import { setTokenPkEnabled } from '../src/mcloud/tokenPkState.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-11-01T12:00:00.000Z';

const src =
  readFileSync(new URL('../src/mcloud/dailyRun.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/entries/daily.ts', import.meta.url), 'utf8');

test('日常顺序：算力大作战在红包派对之后、领取类之前', () => {
  const pk = src.indexOf('// ④.6 算力大作战');
  const rp = src.indexOf('// ④.5 红包派对');
  const claim = src.indexOf('// ⑤ 领取类');
  assert.ok(pk > 0, '没找到 ④.6 算力大作战');
  assert.ok(rp > 0, '没找到 ④.5 红包派对');
  assert.ok(claim > 0, '没找到领取类那一段');
  assert.ok(rp < pk && pk < claim, `顺序不对：红包 ${rp} / 算力 ${pk} / 领取 ${claim}`);
  // 逐行与小结都要接线（否则用户在面板/CLI 只剩一句汇总）
  assert.ok(src.includes("name: '算力大作战'"), '步骤名丢了');
  assert.ok(src.includes('takeTokenPkLines(deps.store, deps.nowIso)'), '逐行没接');
  assert.ok(src.includes('tokenPkSummary(deps.store)'), '汇总句没接（drain 的 note 会截断）');
});

function depsFor(tokenPkOn: boolean): { deps: TaskDeps; sent: BuiltRequest[] } {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  setTokenPkEnabled(store, tokenPkOn, NOW);
  const sent: BuiltRequest[] = [];
  // 全回「未登录」：不是要跑成，而是让整趟快速走到尾部；只关心 tokenpk 发没发
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  return {
    deps: { store, transport, nowIso: NOW, nowMs: () => Date.parse(NOW), settleMs: 0 } as TaskDeps,
    sent,
  };
}

test('关掉开关：日常里这一步是灰的，且一个 tokenpk 请求都不发', () => {
  const { deps, sent } = depsFor(false);
  const r = runDaily(deps);
  const step = r.steps.find((s) => s.name === '算力大作战');
  assert.ok(step !== undefined, r.steps.map((s) => s.name).join(' → '));
  assert.equal(step.idle, true);
  assert.equal(
    sent.some((q) => q.url.includes('/ycloud/tokenpk/')),
    false,
    '关着还发了 tokenpk 请求',
  );
});

test('开着：日常真的会去拉 task/list（其余步骤照旧失败也不影响它被调用）', () => {
  const { deps, sent } = depsFor(true);
  runDaily(deps);
  assert.ok(
    sent.some((q) => q.url.includes('/ycloud/tokenpk/task/list?marketName=National_TokenPK')),
    '没有发 task/list',
  );
  // 抓包的口径：platform=ios、sortState=true、activityid 跟着市场名走
  const list = sent.find((q) => q.url.includes('/ycloud/tokenpk/task/list'));
  assert.ok(list !== undefined);
  assert.equal(list.headers.activityid, 'National_TokenPK');
  assert.match(String(list.headers.jwttoken ?? ''), /JWT/);
});
