// 多账号那一层：列表 / 当前账号 / 回落单账号。
//
// ⚠ 这一层最要紧的性质**不是**"列表能存能取"，而是**"旧的单凭据照原样工作"** ——
//   全仓库十几处读凭据的地方都收进了 `loadAuthRaw`，只要回落那条路断了，
//   所有任务会一起"没凭据"（而现象是"任务都在跑但什么都不做"，最难查）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import {
  STATE_ACCOUNTS,
  STATE_CURRENT_ACCOUNT,
  currentAccount,
  idOf,
  loadAccounts,
  maskAuth,
  phoneOf,
  removeAccount,
  selectAccount,
  upsertAccount,
} from '../src/mcloud/accounts.ts';
import { STATE_AUTH, loadAuthRaw } from '../src/mcloud/sessionExchange.ts';

const NOW = '2026-10-14T10:00:00.000Z';
const A1 = 'Basic xxxx19142492716xxxx';
const A2 = 'Basic yyyy15909397542yyyy';

test('列表：加两个账号、同一个再加一次是**更新**而不是新增', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  upsertAccount(store, A2, NOW);
  assert.equal(loadAccounts(store).length, 2);
  const again = upsertAccount(store, A1 + 'more', NOW);
  assert.equal(again.created, false, '同一个人 ⇒ 更新');
  assert.equal(loadAccounts(store).length, 2);
  assert.equal(loadAccounts(store).find((a) => a.id === '19142492716')?.auth, A1 + 'more');
});

test('id 用手机号（人能对上）；认不出手机号就用短哈希', () => {
  assert.equal(idOf(A1), '19142492716');
  assert.equal(phoneOf(A1), '19142492716');
  assert.equal(phoneOf('no-phone-here'), undefined);
  assert.match(idOf('no-phone-here'), /^anon-[0-9a-z]+$/);
});

test('界面看到的只有**掩码**：不许把凭据本身递出去', () => {
  const m = maskAuth(A1);
  assert.match(m, /^1\*{4}2716 · \d+ 字符$/);
  assert.ok(!m.includes('xxxx'), `掩码里不许出现凭据片段：${m}`);
  assert.ok(!m.includes('19142492716'), '手机号也不整条给');
});

test('删掉的正好是"当前"那一格 ⇒ 当前也要清掉（不留指向空气的 id）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  assert.equal(selectAccount(store, '19142492716', NOW), true);
  assert.equal(currentAccount(store)?.id, '19142492716');
  removeAccount(store, '19142492716', NOW);
  assert.equal(currentAccount(store), undefined);
  assert.equal(store.getState(STATE_CURRENT_ACCOUNT), '');
});

test('选一个不在列表里的 id ⇒ 拒绝（不改状态）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  selectAccount(store, '19142492716', NOW);
  assert.equal(selectAccount(store, '不存在', NOW), false);
  assert.equal(currentAccount(store)?.id, '19142492716');
});

test('⭐ 回落：列表为空 / 没设当前 ⇒ 旧的单凭据照原样工作', () => {
  const store = memStore();
  store.setState(STATE_AUTH, A1, NOW);
  assert.equal(loadAuthRaw(store), A1, '没有列表时就走单账号那格');
  upsertAccount(store, A2, NOW);
  assert.equal(loadAuthRaw(store), A1, '有列表但没选当前 ⇒ 仍然是单账号那格');
  selectAccount(store, '15909397542', NOW);
  assert.equal(loadAuthRaw(store), A2, '选了当前 ⇒ 用它');
  selectAccount(store, '', NOW);
  assert.equal(loadAuthRaw(store), A1, '清掉当前 ⇒ 回落到单账号那格');
});

test('坏数据不许把任务弄挂：JSON 烂掉 / 不是数组 / 条目缺字段 ⇒ 当成"没有列表"', () => {
  const store = memStore();
  store.setState(STATE_AUTH, A1, NOW);
  for (const bad of ['{不是 json', '"字符串"', '{"a":1}', '[{"id":"x"},{"auth":"y"}]', '[]']) {
    store.setState(STATE_ACCOUNTS, bad, NOW);
    assert.deepEqual(loadAccounts(store), [], `坏数据要当成空列表：${bad}`);
    assert.equal(loadAuthRaw(store), A1, `坏数据之后仍要能回落到单凭据：${bad}`);
  }
});

test('当前账号的凭据就是 loadAuthRaw 的返回值（听弹幕/领花都靠这一条）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  upsertAccount(store, A2, NOW);
  selectAccount(store, '19142492716', NOW);
  assert.equal(loadAuthRaw(store), A1);
  selectAccount(store, '15909397542', NOW);
  assert.equal(loadAuthRaw(store), A2, '换账号之后立刻生效 —— 不需要重建任何东西');
});
