// 面板「插件配置」→ state 的三方合并：**文件改过要生效，界面上改过不许被盖回去**。
//
// 这三条（a/b/c）就是这一层的全部行为约定 —— 顺序是用户真实的用法：
//   a) 在面板的插件配置页把预算填成 180 ⇒ 加载后 state 里是 180；
//   b) 之后在插件自己的界面上把预算改成 300 ⇒ 重载时**不许**被文件里那个 180 盖回去；
//   c) 用户又去配件页把文件改成 600 ⇒ 重载后 state 跟着变 600。
//
// 参考 mgmusic 的"缺失才播种"在这里不成立：这几格首次加载就有默认值，
// 所以必须有"上次应用进去的是什么值"这份指纹（见 `STATE_APPLIED`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  CONFIG_RULES,
  MAX_BUDGET_S,
  MIN_BUDGET_S,
  STATE_APPLIED,
  applyConfigOverlay,
} from '../src/mcloud/configOverlay.ts';
import { memStore } from '../src/store/memory.ts';

const NOW = '2026-11-15T00:00:00.000Z';
const BUDGET = 'mcloud.daily.budget_s';
const EXCH = 'mcloud.exchange.schedule.enabled';

function boot() {
  const store = memStore();
  store.ensureSchema();
  return store;
}

test('a) 文件里预算 180 ⇒ 写进 state，指纹记 180', () => {
  const store = boot();
  const r = applyConfigOverlay(store, { daily_budget_s: 180 }, NOW);
  assert.deepEqual(r.applied, ['daily_budget_s=180']);
  assert.deepEqual(r.kept, []);
  assert.equal(store.getState(BUDGET), '180');
  assert.deepEqual(JSON.parse(store.getState(STATE_APPLIED) ?? '{}'), { daily_budget_s: '180' });
});

test('b) 之后在插件界面上改成 300 ⇒ 同一份文件再加载，**不动**（不许盖回去）', () => {
  const store = boot();
  applyConfigOverlay(store, { daily_budget_s: 180 }, NOW);
  // 插件自己的界面写的是 state（routes.ts 的 /daily-budget）
  store.setState(BUDGET, '300', NOW);
  const r = applyConfigOverlay(store, { daily_budget_s: 180 }, NOW);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.kept, ['daily_budget_s']);
  assert.equal(store.getState(BUDGET), '300', '界面上改的值被文件盖回去了');
});

test('c) 文件改成 600 ⇒ 重载后 state 跟着变成 600', () => {
  const store = boot();
  applyConfigOverlay(store, { daily_budget_s: 180 }, NOW);
  store.setState(BUDGET, '300', NOW);
  const r = applyConfigOverlay(store, { daily_budget_s: 600 }, NOW);
  assert.deepEqual(r.applied, ['daily_budget_s=600']);
  assert.equal(store.getState(BUDGET), '600');
});

test('同一份文件连着重载多少次都是同一个结果（幂等）', () => {
  const store = boot();
  applyConfigOverlay(store, { daily_budget_s: 240 }, NOW);
  const r2 = applyConfigOverlay(store, { daily_budget_s: 240 }, NOW);
  const r3 = applyConfigOverlay(store, { daily_budget_s: 240 }, NOW);
  assert.deepEqual(r2.applied, []);
  assert.deepEqual(r3.applied, []);
  assert.equal(store.getState(BUDGET), '240');
});

test(`预算夹在 ${MIN_BUDGET_S}–${MAX_BUDGET_S} 秒（超了不是抛错，是夹住）`, () => {
  const store = boot();
  applyConfigOverlay(store, { daily_budget_s: 9999 }, NOW);
  assert.equal(store.getState(BUDGET), String(MAX_BUDGET_S));
  applyConfigOverlay(store, { daily_budget_s: 5 }, NOW);
  assert.equal(store.getState(BUDGET), String(MIN_BUDGET_S));
  // 字符串数字（按 JSON 编辑的人会写成字符串）
  applyConfigOverlay(store, { daily_budget_s: ' 150 ' }, NOW);
  assert.equal(store.getState(BUDGET), '150');
});

test('开关：true/1/on 写成 "1"，false/0/off 写成 "0"（空串的含义是"没设过"，关不掉）', () => {
  const store = boot();
  applyConfigOverlay(store, { exchange_enabled: false }, NOW);
  assert.equal(store.getState(EXCH), '0');
  applyConfigOverlay(store, { exchange_enabled: true }, NOW);
  assert.equal(store.getState(EXCH), '1');
  applyConfigOverlay(store, { exchange_enabled: 'off' }, NOW);
  assert.equal(store.getState(EXCH), '0');
});

test('认不出来的值：跳过 + 报出来，state 不动（静默跳过等于"填了没反应"）', () => {
  const store = boot();
  store.setState(BUDGET, '420', NOW);
  const r = applyConfigOverlay(store, { daily_budget_s: 'abc' }, NOW);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.ignored, ['daily_budget_s']);
  assert.equal(store.getState(BUDGET), '420');
});

test('没给这一格（空配置 / null）⇒ 一格都不动', () => {
  const store = boot();
  store.setState(BUDGET, '111', NOW);
  for (const cfg of [{}, null, undefined, [], 'x']) {
    const r = applyConfigOverlay(store, cfg, NOW);
    assert.deepEqual(r.applied, []);
    assert.equal(store.getState(BUDGET), '111');
  }
});

test('指纹坏了（人手改坏这份 JSON）不抛，按"没应用过"重来', () => {
  const store = boot();
  store.setState(STATE_APPLIED, '{坏的', NOW);
  const r = applyConfigOverlay(store, { daily_budget_s: 120 }, NOW);
  assert.deepEqual(r.applied, ['daily_budget_s=120']);
  assert.equal(store.getState(BUDGET), '120');
});

test('清单里声明的字段**每一格都真的被读**（防"假字段"）', () => {
  // 面板上的字段能填能存，但如果合并表里没有它，就等于填了没反应 —— 那比裸 JSON 更糟
  // （用户以为生效了）。所以：清单里的每个 name 都必须在 CONFIG_RULES 里。
  const dir = new URL('../plugins/panelllrt/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.panel.json'));
  assert.ok(files.length === 4, `清单应该 4 份，实际 ${files.length}`);
  const known = new Set(CONFIG_RULES.map((r) => r.name));
  const seen: string[] = [];
  for (const f of files) {
    const m = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as {
      config?: { fields?: { name?: string }[] };
    };
    for (const field of m.config?.fields ?? []) {
      const name = String(field.name ?? '');
      seen.push(name);
      assert.ok(known.has(name), `${f} 声明了 ${name}，但 configOverlay 里没人读它`);
    }
  }
  assert.ok(seen.includes('daily_budget_s'), '预算这一格必须出现在清单里（日常真的读它）');
  assert.ok(seen.includes('exchange_enabled'), '定时抢兑这一格必须出现在清单里（兑换任务真的读它）');
});
