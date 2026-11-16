import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFileStore } from '../src/host/fs/fileStore.ts';
import { importLegacyRows } from '../src/host/fs/importLegacy.ts';

const ISO = '2026-10-20T00:00:00.000Z';
/** 袋的物理键前缀（与 store/keys.ts 的 ACCT_PREFIX 同一个值）。
 *  ⚠ 拼出来而不是写字面量：keys 那条门禁会扫源码里的 `'mcloud.…'` 字面量，
 *    而 `mcloud.acct.<账号 id>` 里的 id 是数据，不是登记表里的键。 */
const BAG = 'mcloud.acct.';
const bag = (id: string): string => BAG + id;

test('FileStore：账号袋落到 state/<id>.json、重启可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const a = openFileStore({ dir, plugin: 'mcloud', nowIso: ISO });
  a.setState(bag('x'), JSON.stringify({ 'mcloud.session': '{"cookie":"c=1"}' }), ISO);
  a.setState('mcloud.accounts', '[]', ISO);

  // 换一个实例（模拟重启）读回来
  const b = openFileStore({ dir, plugin: 'mcloud-daily', nowIso: ISO });
  assert.equal(b.getState(bag('x')), '{"mcloud.session":"{\\"cookie\\":\\"c=1\\"}"}');
  assert.equal(b.getState('mcloud.accounts'), '[]');

  // 落盘形状：袋一个号一个文件，全局键进 shared.json
  const onDisk = JSON.parse(readFileSync(join(dir, 'state', 'x.json'), 'utf8')) as Record<string, string>;
  assert.equal(onDisk['mcloud.session'], '{"cookie":"c=1"}');
  const shared = JSON.parse(readFileSync(join(dir, 'shared.json'), 'utf8')) as Record<string, string>;
  assert.equal(shared['mcloud.accounts'], '[]');

  // 凭据就在这几个文件里 ⇒ 只给本用户读
  assert.equal(statSync(join(dir, 'state', 'x.json')).mode & 0o077, 0, '状态文件不许组/其他人可读');
});

test('FileStore：两个写者（两个插件）同时写不互相覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const daily = openFileStore({ dir, plugin: 'mcloud-daily', nowIso: ISO });
  const live = openFileStore({ dir, plugin: 'mcloud-live', nowIso: ISO });
  daily.setState(bag('x'), JSON.stringify({ 'mcloud.daily.done_date': '2026-10-20' }), ISO);
  live.setState(bag('y'), JSON.stringify({ 'mcloud.log.ring': '[]' }), ISO);
  daily.setState('mcloud.daily.budget_s', '600', ISO);
  live.setState('mcloud.log.ring', '[]', ISO);

  assert.ok(daily.getState(bag('x'))?.includes('done_date'));
  assert.ok(live.getState(bag('y'))?.includes('ring'));
  const shared = JSON.parse(readFileSync(join(dir, 'shared.json'), 'utf8')) as Record<string, string>;
  assert.equal(shared['mcloud.daily.budget_s'], '600');
  assert.equal(shared['mcloud.log.ring'], '[]');
});

test('FileStore：run 统计排除负延迟，分位数按值取（与内存实现同口径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const s = openFileStore({ dir, plugin: 'mcloud-daily', nowIso: ISO });
  for (const lateMs of [-100, 10, 20, 30]) {
    s.recordRun({ task: '日常', runs: 1, scheduledAt: ISO, firedAt: ISO, lateMs, ok: true });
  }
  const st = s.lateStats('日常');
  assert.equal(st.n, 3);
  assert.equal(st.excluded, 1);
  assert.equal(st.lateP50, 20);
  assert.equal(st.lateMax, 30);
  assert.equal(s.recentRuns(1).length, 1);
  // 写者唯一：另一个插件看不到这条
  const other = openFileStore({ dir, plugin: 'mcloud-live', nowIso: ISO });
  assert.equal(other.lateStats('日常').n, 0);
});

test('旧数据一次性导入：state 表 + mcloud_runs → 文件（袋按号拆、运行记录按任务归属）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const moved = importLegacyRows(dir, {
    keys: [
      { key: bag('a'), value: JSON.stringify({ 'mcloud.session': '{"cookie":"x=1"}' }) },
      { key: 'mcloud.accounts', value: '[]' },
    ],
    runs: [
      { task: '日常', runs: 1, scheduledAt: ISO, firedAt: ISO, lateMs: 5, ok: true },
      { task: '直播', runs: 1, scheduledAt: ISO, firedAt: ISO, lateMs: 6, ok: true },
    ],
  });
  assert.deepEqual(moved, { keys: 2, runs: 2 });

  const daily = openFileStore({ dir, plugin: 'mcloud-daily', nowIso: ISO });
  assert.equal(daily.getState('mcloud.accounts'), '[]');
  assert.equal(daily.lateStats('日常').n, 1);
  assert.equal(daily.lateStats('直播').n, 0, '直播那条不该在 daily 的文件里');
  const live = openFileStore({ dir, plugin: 'mcloud-live', nowIso: ISO });
  assert.equal(live.lateStats('直播').n, 1);
});
