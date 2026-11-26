// 「调试运行」的参数解析（`parseTaskRunParams`）—— 面板 `POST …/run` 的 `{params}`。
//
// 这一层的判据只有三条，但每条都容易写坏：
//   · 空数组**不等于**全跑（那是静默反直觉）；
//   · 账号**只接受一个**（调试一次跑一个号；多个号请用「日常」页）；
//   · `force` 只放宽"子任务开关 / 账号停用"这两层门 —— 它不是"随便跑"。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskRunParams } from '../src/mcloud/tasks/taskSwitches.ts';

test('没写 params ⇒ 全跑、不强制、账号按任务自己的选择', () => {
  for (const raw of [null, undefined]) {
    const r = parseTaskRunParams(raw);
    assert.ok(!('error' in r), String(r));
    assert.deepEqual(r, { include: null, account: null, force: false });
  }
});

test('只点名一族 ⇒ include 就是那一族，account 为空 = 按日常页那套', () => {
  const r = parseTaskRunParams({ include: ['tokenpk'] });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { include: ['tokenpk'], account: null, force: false });
});

test('重复的族 id 去重；顺序按调用方给的', () => {
  const r = parseTaskRunParams({ include: ['redpack', 'tokenpk', 'redpack'] });
  assert.ok(!('error' in r));
  assert.deepEqual(r.include, ['redpack', 'tokenpk']);
});

test('空数组 ⇒ 错误（不许静默当"全跑"）', () => {
  const r = parseTaskRunParams({ include: [] });
  assert.ok('error' in r);
  assert.match(r.error, /至少选一族/);
});

test('不认识的族 id ⇒ 错误并列出合法 id', () => {
  const r = parseTaskRunParams({ include: ['nope'] });
  assert.ok('error' in r);
  assert.match(r.error, /没有这个任务：nope/);
  assert.match(r.error, /signin/);
  assert.match(r.error, /tokenpk/);
});

test('账号：只接受一个；两个就是错误（调试一次跑一个号）', () => {
  const ok = parseTaskRunParams({ accounts: ['13800138000'] });
  assert.ok(!('error' in ok));
  assert.equal(ok.account, '13800138000');

  const two = parseTaskRunParams({ accounts: ['a', 'b'] });
  assert.ok('error' in two);
  assert.match(two.error, /只跑一个号/);

  const none = parseTaskRunParams({ accounts: [] });
  assert.ok('error' in none);
});

test('账号：不是数组 / 空串 ⇒ 错误', () => {
  assert.ok('error' in parseTaskRunParams({ accounts: 'x' }));
  assert.ok('error' in parseTaskRunParams({ accounts: ['  '] }));
});

test('force：只有字面 true 才算（其它值当没写）', () => {
  assert.equal((parseTaskRunParams({ force: true }) as { force: boolean }).force, true);
  assert.equal((parseTaskRunParams({ force: 'true' }) as { force: boolean }).force, false);
  assert.equal((parseTaskRunParams({ force: 1 }) as { force: boolean }).force, false);
});

test('params 不是对象 ⇒ 错误', () => {
  assert.ok('error' in parseTaskRunParams('x'));
  assert.ok('error' in parseTaskRunParams([1, 2]));
});
