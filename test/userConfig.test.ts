// 唯一配置文件（config.json）：路由、编码、边界。
//
// 这一层要守的是「同一格设置只有一个家」—— 所以断言分三类：
//   · 写进去的**只在** config.json 里（state 里没有）
//   · 三种 kind 的往返不改变语义（尤其 bool 的 `1`/`0` 与空串）
//   · 边界：坏 JSON 不崩、裸 store 写要报错、改文件后下一次读拿到新值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memStore } from '../src/store/memory.ts';
import { openFileStore } from '../src/host/fs/fileStore.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { setPath, getPath, CONFIG_BINDINGS } from '../src/store/userConfigKeys.ts';

const NOW = '2026-11-19T02:00:00.000Z';

test('内存 store：配置键落 config，不落 state', async () => {
  const s = memStore();
  s.ensureSchema();
  s.setState('mcloud.daily.budget_s', '300', NOW);
  assert.equal(s.getState('mcloud.daily.budget_s'), '300', '经 scoped 读得回来');
  const doc = rawStoreOf(s).userConfig?.snapshot() ?? {};
  assert.equal(doc['daily_budget_s'], 300, '写进文件的是**数字**，不是字符串');
  assert.equal(rawStoreOf(s).getState('mcloud.daily.budget_s'), null, 'state 里不许有同名字段');
});

test('bool 的 `1`/`0` 与空串的语义', async () => {
  const s = memStore();
  s.ensureSchema();
  s.setState('mcloud.exchange.schedule.enabled', '1', NOW);
  assert.equal(rawStoreOf(s).userConfig?.snapshot()['exchange_enabled'], true);
  assert.equal(s.getState('mcloud.exchange.schedule.enabled'), '1');
  s.setState('mcloud.exchange.schedule.enabled', '0', NOW);
  assert.equal(rawStoreOf(s).userConfig?.snapshot()['exchange_enabled'], false);
  assert.equal(s.getState('mcloud.exchange.schedule.enabled'), '0');
  // 空串 = 老库「没设过」⇒ 从文件里删掉（不是写成 false，否则关不掉的语义就变了）
  s.setState('mcloud.exchange.schedule.enabled', '', NOW);
  assert.equal('exchange_enabled' in (rawStoreOf(s).userConfig?.snapshot() ?? {}), false);
  assert.equal(s.getState('mcloud.exchange.schedule.enabled'), null);
});

test('json 类（计划表 / 推送规则）原样往返', async () => {
  const s = memStore();
  s.ensureSchema();
  const plans = [{ id: 'p1', accountId: 'a', prizeName: 'x', cron: '0 10 * * *', leadSec: 60, until: '', maxRuns: 0, enabled: true }];
  s.setState('mcloud.exchange.plans', JSON.stringify(plans), NOW);
  assert.deepEqual(s.getState('mcloud.exchange.plans'), JSON.stringify(plans));
  const doc = rawStoreOf(s).userConfig?.snapshot() ?? {};
  assert.deepEqual((doc['exchange'] as Record<string, unknown>)['plans'], plans);
});

test('账号级配置进 accounts.<id>，不串号', async () => {
  const s = memStore();
  s.ensureSchema();
  scoped(rawStoreOf(s), 'a').setState('mcloud.live.listen_seconds', '120', NOW);
  scoped(rawStoreOf(s), 'b').setState('mcloud.live.listen_seconds', '300', NOW);
  assert.equal(scoped(rawStoreOf(s), 'a').getState('mcloud.live.listen_seconds'), '120');
  assert.equal(scoped(rawStoreOf(s), 'b').getState('mcloud.live.listen_seconds'), '300');
  const doc = rawStoreOf(s).userConfig?.snapshot() ?? {};
  const accts = doc['accounts'] as Record<string, Record<string, unknown>>;
  assert.equal(accts['a']!['listen_seconds'], 120);
  assert.equal(accts['b']!['listen_seconds'], 300);
  // 删干净之后不留空对象
  scoped(rawStoreOf(s), 'a').setState('mcloud.live.listen_seconds', '', NOW);
  const left = (rawStoreOf(s).userConfig?.snapshot()['accounts'] ?? {}) as Record<string, unknown>;
  assert.equal('a' in left, false);
});

test('裸 store 写配置键要报错（防止又造一个家）', async () => {
  const s = memStore();
  s.ensureSchema();
  assert.throws(() => rawStoreOf(s).setState('mcloud.push.rules', '[]', NOW), /属于 config.json/);
});

test('文件 store：改文件之后**下一次读**就是新值（不靠重载插件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-cfg-'));
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  raw.ensureSchema();
  const s = scoped(raw, '');
  s.setState('mcloud.daily.budget_s', '300', NOW);
  assert.equal(s.getState('mcloud.daily.budget_s'), '300');
  const p = join(dir, 'config.json');
  assert.equal(statSync(p).mode & 0o077, 0, '配置文件只给本用户读（0600）');
  // 模拟「面板表单保存」：直接改文件（size 与 mtime 都变）
  const doc = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  doc['daily_budget_s'] = 480;
  writeFileSync(p, JSON.stringify(doc, null, 2));
  assert.equal(s.getState('mcloud.daily.budget_s'), '480', '下一次读必须拿到新值');
});

test('文件 store：坏 JSON 不崩（按空继续）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-cfg-bad-'));
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  raw.ensureSchema();
  writeFileSync(join(dir, 'config.json'), '{ 不是 json');
  const s = scoped(raw, '');
  assert.equal(s.getState('mcloud.daily.budget_s'), null, '读不出来 = 没有，不是抛错');
  // 写的时候不把坏文件吃掉：会先改名留证
  s.setState('mcloud.daily.budget_s', '120', NOW);
  assert.equal(s.getState('mcloud.daily.budget_s'), '120');
});

test('绑定表自身：路径不重复、kind 合法', async () => {
  const keys = CONFIG_BINDINGS.map((b) => b.key);
  assert.equal(new Set(keys).size, keys.length, '同一格不许登记两次');
  const paths = CONFIG_BINDINGS.filter((b) => !b.path.includes('{acct}')).map((b) => b.path);
  assert.equal(new Set(paths).size, paths.length, '全局绑定路径不许重复');
  for (const b of CONFIG_BINDINGS) {
    assert.ok(['text', 'number', 'bool', 'json'].includes(b.kind), b.key + ' 的 kind 不合法');
  }
  // setPath/getPath 是最底层的那对，顺手钉一下
  const doc: Record<string, unknown> = {};
  setPath(doc, 'a.b.c', 1);
  assert.equal(getPath(doc, 'a.b.c'), 1);
  setPath(doc, 'a.b.c', undefined);
  assert.equal(getPath(doc, 'a.b.c'), undefined);
  assert.equal('a' in doc, false, '空中间对象要清掉');
});
