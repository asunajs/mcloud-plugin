import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { saveAccounts } from '../src/mcloud/accounts.ts';
import {
  legacyTaskAccountsKey,
  loadManualTaskAccounts,
  loadTaskAccounts,
  resolveTaskAccounts,
  saveTaskAccounts,
  taskAccountsKey,
} from '../src/mcloud/taskAccounts.ts';

const NOW = '2026-10-21T01:00:00.000Z';
function store() {
  const s = memStore();
  s.ensureSchema();
  saveAccounts(
    s,
    [
      { id: 'a', label: 'A', auth: 'Basic YQ==', disabled: false },
      { id: 'b', label: 'B', auth: 'Basic Yg==', disabled: false },
    ] as never,
    NOW,
  );
  return s;
}

test('日常默认自动全部；兑换默认自动为空', () => {
  const s = store();
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'auto'), ['a', 'b']);
  assert.deepEqual(resolveTaskAccounts(s, '兑换', 'auto'), []);
});

test('手动选小号不改自动；自动仍按 auto 跑', () => {
  const s = store();
  saveTaskAccounts(s, '日常', { all: false, ids: ['a'] }, NOW, 'auto');
  saveTaskAccounts(s, '日常', { follow: false, all: false, ids: ['b'] }, NOW, 'manual');
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'auto'), ['a']);
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'manual'), ['b']);
  assert.deepEqual(loadTaskAccounts(s, '日常'), { all: false, ids: ['a'] });
});

test('manual 缺省/跟随自动 ⇒ 回落到 auto', () => {
  const s = store();
  saveTaskAccounts(s, '日常', { all: false, ids: ['a'] }, NOW, 'auto');
  assert.equal(loadManualTaskAccounts(s, '日常').follow, true);
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'manual'), ['a']);
  saveTaskAccounts(s, '日常', { follow: true, all: false, ids: [] }, NOW, 'manual');
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'manual'), ['a']);
});

test('每个任务独立：日常的手动不影响直播/兑换', () => {
  const s = store();
  saveTaskAccounts(s, '日常', { follow: false, all: false, ids: ['b'] }, NOW, 'manual');
  assert.deepEqual(resolveTaskAccounts(s, '直播', 'manual'), ['a', 'b']);
  assert.deepEqual(resolveTaskAccounts(s, '兑换', 'manual'), []);
  assert.deepEqual(resolveTaskAccounts(s, '日常', 'manual'), ['b']);
});

test('旧键读成 auto，新键优先；手动键单独', () => {
  const s = store();
  s.setState(legacyTaskAccountsKey('直播'), JSON.stringify({ all: false, ids: ['b'] }), NOW);
  assert.deepEqual(resolveTaskAccounts(s, '直播', 'auto'), ['b']);
  saveTaskAccounts(s, '直播', { all: false, ids: ['a'] }, NOW, 'auto');
  assert.deepEqual(resolveTaskAccounts(s, '直播', 'auto'), ['a']);
  assert.ok(s.getState(taskAccountsKey('直播', 'manual')) === null);
});
