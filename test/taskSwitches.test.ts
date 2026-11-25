// 日常子任务开关：三层取值（账号 > 公共 > 缺省）、迁移、以及"关掉就不发请求"。
//
// 这一层最容易错的两件事：
//   ① 把"空串"当成"关" —— 那会让升级那一刻静默关掉一半任务；
//   ② 旧键与新键长期双读 —— 一份设置两个家，迟早对不上。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import {
  TASK_SWITCHES,
  accountKeyOf,
  commonKeyOf,
  migrateTaskSwitches,
  resetTaskOn,
  setTaskOn,
  taskGate,
  taskOn,
  taskSource,
} from '../src/mcloud/tasks/taskSwitches.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';

const NOW = '2026-11-25T01:00:00.000Z';

/** `memStore()` 本身已经是 `scoped()` 过的；要按 id 指到某个号就再包一层（用裸 store）。 */
function storeWithAccount(): { raw: ReturnType<typeof memStore>; store: ReturnType<typeof memStore>; id: string } {
  const store = memStore();
  store.ensureSchema();
  const { account } = upsertAccount(store, 'Basic bW9iaWxlOjEzOTAwMTM5MDAwOnRva2Vu', NOW, '测试号');
  return { raw: rawStoreOf(store), store, id: account.id };
}

const oneOf = (raw: ReturnType<typeof memStore>, id: string) => scoped(raw, id);

test('五个开关的形状一致：账号键都是 `mcloud.task.<id>.on`，没有 enabled', () => {
  assert.deepEqual(
    TASK_SWITCHES.map((s) => s.id),
    ['signin', 'expansion', 'appTask', 'redpack', 'tokenpk'],
  );
  for (const s of TASK_SWITCHES) {
    assert.equal(accountKeyOf(s.id), `mcloud.task.${s.id}.on`);
    assert.equal(commonKeyOf(s.id), `mcloud.task.${s.id}.common`);
  }
  // 云手机缺省关（会往用户的云机里装应用），其余开
  assert.deepEqual(
    TASK_SWITCHES.filter((s) => s.defaultOn === false).map((s) => s.id),
    ['redpack'],
  );
});

test('缺省：没写过就是 defaultOn（云手机是关，其余是开）', () => {
  const { store: one } = storeWithAccount();
  assert.equal(taskOn(one, 'signin'), true);
  assert.equal(taskOn(one, 'redpack'), false, '云手机缺省关');
  assert.equal(taskSource(one, 'redpack'), 'default');
});

test('账号层压过公共层；清掉账号层就回到公共层', () => {
  const { store: one } = storeWithAccount();
  // 公共层：签到关
  one.setState(commonKeyOf('signin'), '0', NOW);
  assert.equal(taskOn(one, 'signin'), false);
  assert.equal(taskSource(one, 'signin'), 'common');

  // 账号层：这个号单独开回来
  setTaskOn(one, 'signin', true, NOW);
  assert.equal(taskOn(one, 'signin'), true);
  assert.equal(taskSource(one, 'signin'), 'account');

  // 「跟随公共」= 清掉账号层（不是设成开）
  resetTaskOn(one, 'signin', NOW);
  assert.equal(taskOn(one, 'signin'), false, '回到公共层的关');
  assert.equal(taskSource(one, 'signin'), 'common');
});

test('空串不是关：`\'\'` 当没设过（这是升级那一刻最要紧的一条）', () => {
  const { store: one } = storeWithAccount();
  one.setState(accountKeyOf('signin'), '', NOW);
  assert.equal(taskOn(one, 'signin'), true, '空串 ⇒ 缺省（开）');
  assert.equal(taskSource(one, 'signin'), 'default');
});

test('两种历史编码都认（`1/0` 与 `true/false`）', () => {
  const { store: one } = storeWithAccount();
  for (const [rawVal, want] of [
    ['1', true],
    ['0', false],
    ['true', true],
    ['false', false],
  ] as const) {
    one.setState(accountKeyOf('tokenpk'), rawVal, NOW);
    assert.equal(taskOn(one, 'tokenpk'), want, `账号层 ${rawVal}`);
  }
});

test('两个号互不影响：A 关、B 开', () => {
  const { raw, store: one, id: a } = storeWithAccount();
  const { account: b } = upsertAccount(raw, 'Basic bW9iaWxlOjEzOTAwMTM5MDAxOnRva2Vu', NOW, '另一个号');
  setTaskOn(scoped(raw, a), 'tokenpk', false, NOW);
  setTaskOn(scoped(raw, b.id), 'tokenpk', true, NOW);
  assert.equal(taskOn(scoped(raw, a), 'tokenpk'), false);
  assert.equal(taskOn(scoped(raw, b.id), 'tokenpk'), true);
});

test('taskGate：关了就 skipped + idle，一个请求都不发', () => {
  const { store: one } = storeWithAccount();
  const deps = { store: one, transport: async () => ({ ok: false, error: '不该发请求' }) } as never;
  setTaskOn(one, 'redpack', false, NOW);
  const out = taskGate(deps, 'redpack');
  assert.equal(out.ok, true);
  assert.equal(out.idle, true);
  assert.equal(out.skipped, true);
  assert.match(out.note, /已关闭/);

  setTaskOn(one, 'redpack', true, NOW);
  const on = taskGate(deps, 'redpack');
  assert.equal(on.idle, false, '开着的时候闸不该拦');
  assert.equal(on.note, '');
});

test('迁移：旧键搬到新键、值归一、旧键置空；第二遍空转', () => {
  const { raw, id } = storeWithAccount();
  // 造出老形状：`redpack.enabled='1'`、`tokenpk.enabled='false'`（两种编码）
  raw.setState(`mcloud.acct.${id}`, JSON.stringify({
    'mcloud.redpack.enabled': '1',
    'mcloud.tokenpk.enabled': 'false',
  }), NOW);

  const first = migrateTaskSwitches(raw, NOW);
  assert.equal(first.length, 2, '两个开关都要搬');
  assert.equal(taskOn(scoped(raw, id), 'redpack'), true, '显式开过的号迁移后仍然开');
  assert.equal(taskOn(scoped(raw, id), 'tokenpk'), false, '`false` 要归一成 `0` 再落');
  // 旧键置空（不留两份值）
  const bag = JSON.parse(raw.getState(`mcloud.acct.${id}`) ?? '{}') as Record<string, string>;
  assert.equal(bag['mcloud.redpack.enabled'], '');
  assert.equal(bag['mcloud.tokenpk.enabled'], '');
  assert.equal(bag['mcloud.task.redpack.on'], '1');

  // 第二遍：什么都不做（幂等）
  assert.deepEqual(migrateTaskSwitches(raw, NOW), []);
});

test('迁移不覆盖已经设过的新键', () => {
  const { raw, id } = storeWithAccount();
  raw.setState(`mcloud.acct.${id}`, JSON.stringify({
    'mcloud.redpack.enabled': '1',
    'mcloud.task.redpack.on': '0',
  }), NOW);
  migrateTaskSwitches(raw, NOW);
  assert.equal(taskOn(scoped(raw, id), 'redpack'), false, '新键已经有人设过 ⇒ 以它为准');
});
