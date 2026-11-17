// 领奖清单：读失败但有旧清单时**退回旧清单**，不许把整页变成「读不到」。
//
// 2026-11-17 现场：链路抖了一下（RTT 1.3 秒、建连 4.5~6 秒），1500ms 预算下
// 读必然超时，界面就整页写「读不到」—— 而 10 分钟前刚读过 18 件。
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

const NOW = '2026-11-17T07:45:00.000Z';
const LATER = '2026-11-17T07:52:00.000Z';

const RECORD = {
  oid: 'O1',
  prizeId: 7,
  prizeName: '移动云盘10万tokens叠加包',
  flag: 1,
  expireTime: '2026-12-31 23:59:59',
};

function listBody(): string {
  return JSON.stringify({ code: 0, result: { result: [RECORD], totalCount: 1, totalPages: 1 } });
}

test('领奖清单：刷新失败时退回上一次的清单，并说清是哪一次的', async () => {
  const store = memStore();
  store.ensureSchema();
  const auth = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';
  const { account } = upsertAccount(store, auth, NOW, 'A');
  const one = scoped(rawStoreOf(store), account.id);
  saveSession(one, { cookie: 'c=1', jwt: 'JWT', savedAt: NOW }, NOW);
  one.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);

  let mode: 'ok' | 'boom' = 'ok';
  const transport = ((req: { url: string }) => {
    if (!req.url.includes('getUserPrizeLogPageV2')) throw new Error('意外请求：' + req.url);
    if (mode === 'boom') throw new Error('请求超时（1500ms）：已探测：m.mcloud.139.com:443 连得上（1368ms）');
    return { status: 200, headers: {}, body: listBody() };
  }) as unknown as Transport;

  const route = mcloudRoutes(testDeps(store, { transport, now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET',
  )!;

  // ① 第一次读成功 → 清单进缓存
  const first = JSON.parse((await route.handler({ query: '' })).body) as {
    items: { oid: string }[];
    pending: number;
    stale?: boolean;
  };
  assert.equal(first.pending, 1, JSON.stringify(first));
  assert.equal(first.items[0]!.oid, 'O1');
  assert.equal(first.stale, undefined, '读成功就不是 stale');

  // ② 链路坏了 + 用户点「刷新」（refresh=1 会绕开缓存）→ 必须退回刚才那份
  mode = 'boom';
  const deps = testDeps(store, { transport, now: LATER });
  const route2 = mcloudRoutes(deps).find(
    (x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET',
  )!;
  const second = JSON.parse((await route2.handler({ query: 'refresh=1' })).body) as {
    items: { oid: string }[];
    pending: number;
    stale?: boolean;
    staleReason?: string;
    cachedAtMs?: number;
    failed?: string;
  };
  assert.equal(second.stale, true, '读失败要标记 stale，界面才说得出「这是几点的」');
  assert.equal(second.pending, 1, '有旧清单就不许清空（原来这里会变成 0 件 + 读不到）');
  assert.equal(second.items[0]!.oid, 'O1');
  assert.match(String(second.staleReason), /请求超时/, '原因要如实带回界面');
  assert.equal(second.cachedAtMs, Date.parse(NOW), '退回的是第一次那份（时间要对得上）');
  assert.equal(second.failed, undefined, 'stale 时不要把整页标成「读不到」');
});

test('领奖清单：没有旧清单时，读失败还是老实说读不到', async () => {
  const store = memStore();
  store.ensureSchema();
  const auth = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';
  const { account } = upsertAccount(store, auth, NOW, 'A');
  const one = scoped(rawStoreOf(store), account.id);
  saveSession(one, { cookie: 'c=1', jwt: 'JWT', savedAt: NOW }, NOW);
  one.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);

  const transport = (() => {
    throw new Error('请求超时（1500ms）');
  }) as unknown as Transport;
  const route = mcloudRoutes(testDeps(store, { transport, now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET',
  )!;
  const out = JSON.parse((await route.handler({ query: '' })).body) as {
    pending: number;
    items: unknown[];
    stale?: boolean;
    failed?: string;
  };
  assert.equal(out.pending, 0);
  assert.equal(out.items.length, 0);
  assert.equal(out.stale, undefined, '没有旧清单就别假装有');
  assert.match(String(out.failed), /请求超时/);
});