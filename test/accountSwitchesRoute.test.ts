// 路由层：账号「设置」里的子任务开关，以及「导入旧配置」。
//
// 这一层要钉住的是**写哪一格**和**拒绝什么**：
//   · `tasks` 写账号层、`taskReset` 清账号层（不是设成开）；
//   · 不认识的开关 id 要 400 并列出合法 id（静默丢弃会让用户以为改了）；
//   · 导入只收粘贴文本、dry-run 不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { upsertAccount, loadAccounts } from '../src/mcloud/accounts.ts';
import { taskOn, taskSource } from '../src/mcloud/tasks/taskSwitches.ts';
import { testDeps } from './helpers.ts';
import type { RouteEntry } from '../src/app/routes/support.ts';

const NOW = '2026-11-25T03:00:00.000Z';
const AUTH = 'Basic bW9iaWxlOjEzOTAwMTM5MDAwOnRva2Vu';

function setup() {
  const store = memStore();
  store.ensureSchema();
  const { account } = upsertAccount(store, AUTH, NOW, '测试号');
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const settings = routes.find(
    (x) => x.path === '/plugins/mcloud/api/accounts' && x.method === 'POST',
  )!;
  const importRoute = routes.find(
    (x) => x.path === '/plugins/mcloud/api/config/import' && x.method === 'POST',
  )!;
  return { store, id: account.id, settings, importRoute };
}

/** 调一条路由并解出 JSON。`handler` 可能是同步返回（`RouteResponse | Promise<…>`）。 */
async function post(
  route: RouteEntry,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await route.handler({ body: JSON.stringify(body), query: '' });
  return { status: r.status, json: JSON.parse(r.body) as Record<string, unknown> };
}

test('set-settings：`tasks` 写账号层，读数里的 source 跟着变', async () => {
  const { store, id, settings } = setup();
  const r = await post(settings, { op: 'set-settings', id, tasks: { tokenpk: false } });
  assert.equal(r.status, 200);
  const one = scoped(rawStoreOf(store), id);
  assert.equal(taskOn(one, 'tokenpk'), false);
  assert.equal(taskSource(one, 'tokenpk'), 'account');
  // 返回的读数里要能看出"这个号单独设过"
  const accounts = (r.json['accounts'] ?? []) as { id: string; tasks: { id: string; on: boolean; source: string }[] }[];
  const me = accounts.find((a) => a.id === id)!;
  const t = me.tasks.find((x) => x.id === 'tokenpk')!;
  assert.equal(t.on, false);
  assert.equal(t.source, 'account');
});

test('set-settings：`taskReset` 清账号层 ⇒ 回到公共默认（不是设成开）', async () => {
  const { store, id, settings } = setup();
  const one = scoped(rawStoreOf(store), id);
  await post(settings, { op: 'set-settings', id, tasks: { redpack: true } });
  assert.equal(taskOn(one, 'redpack'), true);

  await post(settings, { op: 'set-settings', id, taskReset: ['redpack'] });
  assert.equal(taskSource(one, 'redpack'), 'default');
  assert.equal(taskOn(one, 'redpack'), false, '清掉之后回到缺省（云手机缺省关）');
});

test('set-settings：不认识的开关 id ⇒ 400 并列出合法 id（不静默丢）', async () => {
  const { id, settings } = setup();
  const bad = await post(settings, { op: 'set-settings', id, tasks: { nope: true } });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray(bad.json['valid']), '要把合法 id 列出来');
  assert.equal((bad.json['valid'] as string[]).includes('tokenpk'), true);
});

test('set-settings：值不是布尔 ⇒ 400（别把 "false" 字符串当关）', async () => {
  const { store, id, settings } = setup();
  const r = await post(settings, { op: 'set-settings', id, tasks: { tokenpk: 'false' } });
  assert.equal(r.status, 400);
  assert.equal(taskOn(scoped(rawStoreOf(store), id), 'tokenpk'), true, '被拒的写不能生效');
});

test('set-common-tasks：写公共层（config.json），没单独设过的号跟着变', async () => {
  const { store, id, settings } = setup();
  const r = await post(settings, { op: 'set-common-tasks', tasks: { redpack: true, tokenpk: false } });
  assert.equal(r.status, 200);
  assert.equal(store.userConfig?.read('task_redpack'), true, '公共层要写进 config.json');
  assert.equal(store.userConfig?.read('task_tokenpk'), false);
  // 这个号没单独设过 ⇒ 跟着公共层走
  const one = scoped(rawStoreOf(store), id);
  assert.equal(taskOn(one, 'redpack'), true);
  assert.equal(taskSource(one, 'redpack'), 'common');
  // 账号层设过之后，公共层再改也压不过它
  await post(settings, { op: 'set-settings', id, tasks: { redpack: false } });
  await post(settings, { op: 'set-common-tasks', tasks: { redpack: true } });
  assert.equal(taskOn(one, 'redpack'), false, '账号层优先');
});

test('set-common-tasks：不认识的 id / 非布尔 ⇒ 400', async () => {
  const { settings } = setup();
  const bad = await post(settings, { op: 'set-common-tasks', tasks: { nope: true } });
  assert.equal(bad.status, 400);
  const badType = await post(settings, { op: 'set-common-tasks', tasks: { tokenpk: 'off' } });
  assert.equal(badType.status, 400);
});

test('读数里要带上公共默认（界面「公共默认」弹窗只认这一个口）', async () => {
  const { store, settings } = setup();
  await post(settings, { op: 'set-common-tasks', tasks: { redpack: true } });
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const readings = routes.find((x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET')!;
  const r = await readings.handler({ query: '' });
  const body = JSON.parse(r.body) as { account: { taskCommon?: { id: string; on: boolean }[] } };
  const list = body.account.taskCommon ?? [];
  assert.equal(list.length, 6, '六格都要在（少了界面就是空弹窗）');
  assert.equal(list.find((x) => x.id === 'redpack')?.on, true);
});

test('导入旧配置：dry-run 不写盘，真导入才落账号与开关', async () => {
  const { store, importRoute } = setup();
  const doc = {
    caiyun: [{ auth: 'Basic bW9iaWxlOjEzOTAwMTM5MDAxOnRva2Vu', nickname: '旧配置里的号', 红包派对: { 开启: true } }],
  };
  const dry = await post(importRoute, { text: JSON.stringify(doc), dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json['dryRun'], true);
  assert.equal(loadAccounts(store).length, 1, 'dry-run 不许新增账号');

  const real = await post(importRoute, { text: JSON.stringify(doc) });
  assert.equal(real.status, 200);
  assert.equal(loadAccounts(store).length, 2, '真导入要多出那个号');
  const imported = loadAccounts(store).find((a) => a.label === '旧配置里的号')!;
  assert.equal(taskOn(scoped(rawStoreOf(store), imported.id), 'redpack'), true, '`开启:true` 要搬过来');
});

test('导入旧配置：不是 JSON / 缺 auth ⇒ 400 说清楚', async () => {
  const { importRoute } = setup();
  const notJson = await post(importRoute, { text: 'not json' });
  assert.equal(notJson.status, 400);
  assert.match(String(notJson.json['error']), /JSON/);

  const noAuth = await post(importRoute, { text: JSON.stringify({ caiyun: [{}] }) });
  assert.equal(noAuth.status, 400);
  assert.match(String(noAuth.json['error']), /auth/);

  const empty = await post(importRoute, { text: '   ' });
  assert.equal(empty.status, 400);
});
