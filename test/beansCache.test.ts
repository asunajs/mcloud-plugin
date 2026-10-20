// AI豆读数缓存（余额 + 当日汇总）的边界。
//
// 用户口径：数据页当前余额和「今日获取」都缓存 **2 小时**；手动刷新要能强取。
// 缓存按账号存在各自的袋里 —— 豆本来就不跨账号。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import {
  BEANS_CACHE_TTL_MS,
  STATE_BEANS_CACHE,
  loadBeansCache,
  saveBeansCache,
} from '../src/mcloud/beansRead.ts';
import { parseInfoV3 } from '../src/mcloud/tasks/info.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const DAY = {
  net: 12,
  gained: 30,
  spent: 18,
  count: 4,
};

test('缓存时长就是用户说的 2 小时', () => {
  assert.equal(BEANS_CACHE_TTL_MS, 2 * 60 * 60 * 1000);
});

test('余额和当日汇总一起往返；坏 JSON 当没有缓存', () => {
  const store = memStore();
  const cache = { day: { atMs: 1, dayStart: 2, day: DAY }, balance: { atMs: 3, value: 456 } };
  saveBeansCache(store, cache, NOW);
  assert.deepEqual(loadBeansCache(store), cache);
  store.setState(STATE_BEANS_CACHE, '{坏', NOW);
  assert.deepEqual(loadBeansCache(store), {});
});

test('缓存按账号隔离（不能拿 A 的余额显示在 B 上）', () => {
  const raw = memStore();
  const base = rawStoreOf(raw);
  const a = scoped(base, 'a');
  const b = scoped(base, 'b');
  saveBeansCache(a, { balance: { atMs: 1, value: 100 } }, NOW);
  saveBeansCache(b, { balance: { atMs: 1, value: 200 } }, NOW);
  assert.equal(loadBeansCache(a).balance?.value, 100);
  assert.equal(loadBeansCache(b).balance?.value, 200);
});

test('infoV3 的余额字段是 total，字符串数字也认', () => {
  assert.equal(parseInfoV3({ total: 321 }).total, 321);
  assert.equal(parseInfoV3({ total: '321' }).total, 321);
  assert.equal(parseInfoV3({ point: 7 }).total, 7);
  assert.equal(parseInfoV3({}).total, undefined);
});
