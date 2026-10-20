// AI豆读数缓存路由：第二次命中缓存，refresh=1 强取。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import { saveSession } from '../src/store/types.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { testDeps } from './helpers.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-20T12:00:00.000Z';

test('路由：两次请求第二次命中缓存；refresh=1 强取', () => {
  const store = memStore();
  store.ensureSchema();
  const auth = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';
  const { account } = upsertAccount(store, auth, NOW, 'A');
  const one = scoped(rawStoreOf(store), account.id);
  saveSession(one, { cookie: 'c=1', jwt: 'JWT', savedAt: NOW }, NOW);
  // 票新鲜：别让 `withTokenGate` 真去换票（这里测的是缓存，不是换票链）
  one.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  let cloud = 0;
  let info = 0;
  const transport = ((req: { url: string }) => {
    if (req.url.includes('cloudRecordV2')) {
      cloud += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          result: { records: [{ num: 12, summary: 's', mark: 'm', insertTime: '2026-10-20T12:00:00.000+08:00' }] },
        }),
      };
    }
    if (req.url.includes('infoV3')) {
      info += 1;
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { total: 88 } }) };
    }
    throw new Error('意外请求：' + req.url);
  }) as unknown as Transport;
  const route = mcloudRoutes(testDeps(store, { transport, now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/beans/today' && x.method === 'GET',
  )!;
  const first = JSON.parse(route.handler({ query: '' }).body) as {
    accounts: { id: string; balance?: number; gained: number; cached: boolean }[];
    cached: boolean;
  };
  assert.ok(first.accounts[0], JSON.stringify(first));
  assert.equal(first.accounts[0]!.id, account.id);
  assert.equal(first.accounts[0]!.gained, 12);
  assert.equal(first.accounts[0]!.balance, 88);
  assert.equal(first.cached, false);
  assert.equal(cloud, 1);
  assert.equal(info, 1);

  const second = JSON.parse(route.handler({ query: '' }).body) as typeof first;
  assert.equal(second.cached, true);
  assert.equal(cloud, 1, '第二次不能再打 cloudRecordV2');
  assert.equal(info, 1, '第二次不能再打 infoV3');

  route.handler({ query: 'refresh=1' });
  assert.equal(cloud, 2, 'refresh=1 必须强取');
  assert.equal(info, 2, 'refresh=1 必须强取余额');
});
