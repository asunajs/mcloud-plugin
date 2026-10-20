// 任务状态按账号读：切账号只读那个号的本地矩阵缓存，且默认只读当前账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { selectAccount, upsertAccount } from '../src/mcloud/accounts.ts';
import { matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const auth = (phone: string): string => `Basic ${Buffer.from(`mobile:${phone}:token`).toString('base64')}`;
const exploding: Transport = () => {
  throw new Error('读任务状态不该发上游请求');
};

function seeded() {
  const store = memStore();
  store.ensureSchema();
  const a = upsertAccount(store, auth('19900000001'), NOW, 'A').account;
  const b = upsertAccount(store, auth('19900000002'), NOW, 'B').account;
  selectAccount(store, b.id, NOW);
  const reading = (name: string): string =>
    JSON.stringify({
      group: 'sign_in_3',
      at: NOW,
      done: 0,
      todo: 1,
      skip: 0,
      todoNames: [name],
      items: [{ taskId: 1021, name, state: 'WAIT', enable: 1, currStep: 1 }],
    });
  const oneA = scoped(rawStoreOf(store), a.id);
  const oneB = scoped(rawStoreOf(store), b.id);
  oneA.setState(matrixKey('sign_in_3'), reading('A 的通知任务'), NOW);
  oneB.setState(matrixKey('sign_in_3'), reading('B 的通知任务'), NOW);
  oneB.setState(
    'mcloud.taskexpansion.state',
    JSON.stringify({ step: 'done', day: '2026-10-20', curMonthBackup: true }),
    NOW,
  );
  oneB.setState('mcloud.month.backup', JSON.stringify({ month: '2026-10', backup: true }), NOW);
  oneB.setState('mcloud.apptask.state', JSON.stringify({ clicked: [106], day: '2026-10-20' }), NOW);
  oneB.setState(
    'mcloud.upload.state',
    JSON.stringify({ step: 'done', name: '手动上传一个文件.bin' }),
    NOW,
  );
  return { store, a, b };
}

test('/matrix?account=：切到 A 读的是 A 的缓存，切到 B 是 B 的', () => {
  const { store, a, b } = seeded();
  const route = mcloudRoutes(testDeps(store, { transport: exploding, now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/matrix' && x.method === 'GET',
  )!;
  const one = JSON.parse(route.handler({ query: `account=${a.id}` }).body);
  assert.equal(one.account, a.id);
  assert.equal(one.groups[0].reading.todoNames[0], 'A 的通知任务');
  assert.equal(one.groups[0].reading.items[0].taskId, 1021);
  assert.equal(one.groups[0].reading.items[0].currStep, 1);

  const two = JSON.parse(route.handler({ query: `account=${b.id}` }).body);
  assert.equal(two.account, b.id);
  // 默认必须只读本地：上面用的是"一调就抛"的 transport，没有炸就证明没发请求。
  assert.equal(two.refreshed, false);
  assert.equal(two.groups[0].reading.todoNames[0], 'B 的通知任务');
  assert.equal(two.backup.enabled, true, '备份开关要一起给出来');
  assert.equal(two.backup.step, 'done', '任务拓展走到哪一步也要给');
  assert.deepEqual(two.local.clicked, [106]);
  assert.equal(two.local.uploadDone, true);
  assert.equal(two.local.uploadName, '手动上传一个文件.bin');

  // refresh=1 真去请求：这里 transport 一调就抛 ⇒ 必须把失败如实放进 refreshErrors，
  // 而不是继续假装"本地刷新成功"。
  const forced = JSON.parse(route.handler({ query: `account=${b.id}&refresh=1` }).body);
  assert.equal(forced.refreshed, true);
  assert.ok(forced.refreshErrors.length > 0, 'refresh=1 必须真的尝试请求');
});

test('/readings 的矩阵默认跟着当前账号（不能再读默认袋）', () => {
  const { store, b } = seeded();
  const route = mcloudRoutes(testDeps(store, { transport: exploding, now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/readings' && x.method === 'GET',
  )!;
  const d = JSON.parse(route.handler({}).body);
  assert.equal(d.data.matrix.groups[0].reading.todoNames[0], 'B 的通知任务');
  assert.equal(d.data.matrix.backup.enabled, true);
  assert.equal(d.account.current, b.id);
});
