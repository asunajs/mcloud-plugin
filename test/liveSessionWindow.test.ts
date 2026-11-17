// 直播：按时间窗清池子 + 「谁验的」 + 界面读对袋（2026-11-17 复核的三条）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { saveAccounts } from '../src/mcloud/accounts.ts';
import { saveTaskAccounts } from '../src/mcloud/taskAccounts.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import {
  emptyPool,
  note,
  noteClaim,
  normalize,
  parsePool,
  serializePool,
  sessionKeyOf,
  stopScraping,
  validCount,
} from '../src/mcloud/koulingPool.ts';
import { STATE_DRAW } from '../src/mcloud/tasks/liveDraw.ts';

const NOW = '2026-11-17T02:00:00.000Z'; // 北京 10:00
/** 北京时间的某个时刻（毫秒）。窗口是按**本地**时刻判的。 */
const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m, 0, 0).getTime();

test('场次键：上午 / 下午 / 窗口外，两头各留 15 分钟余量', async () => {
  assert.equal(sessionKeyOf(at(10)), '2026-11-17#0');
  assert.equal(sessionKeyOf(at(11, 55)), '2026-11-17#0');
  assert.equal(sessionKeyOf(at(12, 10)), '2026-11-17#0', '窗口后 15 分钟内仍算上午场（跑动跨过 12:00 不能清池）');
  assert.equal(sessionKeyOf(at(12, 30)), '2026-11-17#off');
  assert.equal(sessionKeyOf(at(14, 40)), '2026-11-17#1');
  assert.equal(sessionKeyOf(at(17, 10)), '2026-11-17#1');
  assert.equal(sessionKeyOf(at(17, 40)), '2026-11-17#off');
  assert.equal(sessionKeyOf(at(9, 20)), '2026-11-17#0', '窗口前 15 分钟内就算这一场');
  assert.equal(sessionKeyOf(at(8, 0)), '2026-11-17#off');
});

test('换场次就把口令与领取记录清掉（口令池不许长期保留）', async () => {
  const pool = emptyPool();
  note(pool, ['云盘AI高效复盘', 'AI模拟练面试'], 'xiaohongshu', at(10));
  noteClaim(pool, 'a', '云盘AI高效复盘', 'claimed', at(10, 5));
  assert.equal(validCount(pool), 1);
  assert.equal(stopScraping(pool), false);
  noteClaim(pool, 'a', 'AI模拟练面试', 'alreadyClaimed', at(10, 6));
  assert.equal(stopScraping(pool), true, '同一场里 2 条有效就够了');

  // 上午 → 下午：两条「有效」一条都不许留
  normalize(pool, at(14, 40));
  assert.equal(pool.codes.length, 0, '下午场不许留着上午的口令');
  assert.deepEqual(pool.claims, {}, '领取记录跟着清（否则新口令会被当成已领过）');
  assert.equal(stopScraping(pool), false, '清完就不该再说「够了，不用听」');
  assert.equal(pool.sessionKey, '2026-11-17#1');
});

test('同一场次里不清（10:00 与 11:00 两趟是同一场）', async () => {
  const pool = emptyPool();
  note(pool, ['云盘AI高效复盘'], 'xiaohongshu', at(10));
  normalize(pool, at(11));
  assert.equal(pool.codes.length, 1, '同一场次的口令要留着（够 2 条就不再听）');
});

test('「谁验的」落进池子、能存能读', async () => {
  const pool = emptyPool();
  note(pool, ['云盘AI高效复盘'], 'xiaohongshu', at(10));
  noteClaim(pool, 'acct-a', '云盘AI高效复盘', 'alreadyClaimed', at(10, 5));
  const back = parsePool(serializePool(pool)).pool;
  const one = back.codes.find((c) => c.value === '云盘AI高效复盘');
  assert.equal(one?.state, 'valid', '已使用也算有效');
  assert.equal(one?.validatedBy, 'acct-a', '要记下是谁验的（用户口径：记录操作者账号）');
});

test('界面读「上一轮领取」要读第一个任务账号的袋（不是当前查看的号）', async () => {
  const store = memStore();
  store.ensureSchema();
  saveAccounts(
    store,
    [
      { id: 'a', label: '小号', auth: 'Basic YQ==', disabled: false },
      { id: 'b', label: '移动', auth: 'Basic Yg==', disabled: false },
    ] as never,
    NOW,
  );
  // 任务只勾了 a ⇒ 任务是往 a 的袋里写
  saveTaskAccounts(store, '直播', { all: false, ids: ['a'] }, NOW, 'auto');
  scoped(rawStoreOf(store), 'a').setState(
    STATE_DRAW,
    JSON.stringify({
      step: 'done',
      journalingSent: 1,
      drawIndex: 1,
      codes: ['云盘AI高效复盘'],
      results: [{ code: '云盘AI高效复盘', kind: 'succeeded' }],
      balanceBefore: 120,
      balanceAfter: 130,
      startedAt: '2026-11-17T02:00:00.000Z',
      finishedAt: '2026-11-17T02:01:00.000Z',
    }),
    NOW,
  );
  const route = mcloudRoutes(testDeps(store, { now: NOW })).find(
    (x) => x.method === 'GET' && x.path === '/plugins/mcloud/api/readings',
  );
  assert.ok(route, '缺 /api/readings');
  const r = await route.handler({ method: 'GET', path: '/plugins/mcloud/api/readings', query: '', headers: {}, body: '' });
  const body = JSON.parse(r.body) as { live: { draw: { at?: string | null; line: string } } };
  assert.equal(body.live.draw.at, '2026-11-17T02:01:00.000Z', '读错袋就会是 null（当前查看的号不是 a）');
  assert.match(body.live.draw.line, /1 条口令领到 1 条/);
});
