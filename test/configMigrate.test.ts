// 一次性迁移：四份旧 config.json + 旧 state 键 → 唯一 config.json。
//
// 迁移是**有信息损失**的一步（旧键要删掉），所以这组测试盯四件事：
//   ① 合对了（旧来源优先级、bool 归一）
//   ② 幂等（跑第二次什么都不做）
//   ③ 有备份（旧文件原文 + 被搬走的键）
//   ④ 旧 state 键真的被删（否则「state 里不再出现同名字段」不成立）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileStore } from '../src/host/fs/fileStore.ts';
import { migrateUserConfig } from '../src/host/fs/configMigrate.ts';
import { SCHEMA_VERSION } from '../src/store/userConfigKeys.ts';

const NOW = '2026-11-19T02:00:00.000Z';
const AUTH = 'Basic ' + Buffer.from('pc:13800138000:' + 'x'.repeat(201)).toString('base64');

/** 造一份「重构前」的目录：四份插件 config.json + shared.json 里的旧 state 键。 */
function legacyDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcloud-migrate-'));
  const data = join(root, 'plugin-data');
  const store = join(data, 'mcloud');
  for (const name of ['mcloud-daily', 'mcloud-exchange', 'mcloud-live', 'mcloud']) {
    mkdirSync(join(data, name), { recursive: true });
  }
  writeFileSync(join(data, 'mcloud-daily', 'config.json'), JSON.stringify({ daily_budget_s: 480 }));
  writeFileSync(join(data, 'mcloud-exchange', 'config.json'), JSON.stringify({ exchange_enabled: false }));
  writeFileSync(
    join(store, 'shared.json'),
    JSON.stringify({
      'mcloud.accounts': JSON.stringify([{ id: '13800138000', label: '小号', auth: AUTH, disabled: false }]),
      'mcloud.live.listen_seconds.task': '90',
      'mcloud.push.bindings': JSON.stringify({ daily: 'r1' }),
      'mcloud.session': '{"jwt":"留着"}',
    }),
  );
  mkdirSync(join(store, 'state'), { recursive: true });
  writeFileSync(join(store, 'state', '13800138000.json'), JSON.stringify({ 'mcloud.live.listen_room': '147606' }));
  writeFileSync(join(store, 'meta.json'), JSON.stringify({ schema: 1, plugin: 'mcloud', createdAt: NOW }));
  return store;
}

test('迁移：四份旧配置 + 旧 state 键合成一份', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  const out = migrateUserConfig(raw, NOW);
  assert.equal(out.migrated, true);
  const doc = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(doc['schema_version'], SCHEMA_VERSION);
  assert.equal(doc['daily_budget_s'], 480, '旧 config.json 的值要搬过来');
  assert.equal(doc['exchange_enabled'], false, 'bool 要真的是布尔（不是字符串 0）');
  assert.equal((doc['live'] as Record<string, unknown>)['listen_seconds'], 90, '旧 state 键覆盖默认值');
  assert.deepEqual((doc['push'] as Record<string, unknown>)['bindings'], { daily: 'r1' }, 'json 类原样');
  const accts = doc['accounts'] as Record<string, Record<string, unknown>>;
  assert.equal(accts['13800138000']!['listen_room'], '147606', '账号级旧设置进 accounts.<id>');
});

test('迁移：旧 state 键被删干净（state 里不许再有同名字段）', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  migrateUserConfig(raw, NOW);
  const shared = JSON.parse(readFileSync(join(dir, 'shared.json'), 'utf8')) as Record<string, string>;
  assert.equal(shared['mcloud.live.listen_seconds.task'], undefined);
  assert.equal(shared['mcloud.push.bindings'], undefined);
  assert.equal(shared['mcloud.session'], '{"jwt":"留着"}', '运行期状态一个字节不动');
  assert.ok(shared['mcloud.accounts'] !== undefined, '账号表（跨仓契约）必须还在 shared.json');
  const bag = JSON.parse(readFileSync(join(dir, 'state', '13800138000.json'), 'utf8')) as Record<string, string>;
  assert.equal(bag['mcloud.live.listen_room'], undefined, '账号袋里的旧设置也要删');
});

test('迁移：幂等（第二次什么都不做，也不读旧来源）', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  assert.equal(migrateUserConfig(raw, NOW).migrated, true);
  const snapshot = readFileSync(join(dir, 'config.json'), 'utf8');
  const again = migrateUserConfig(raw, NOW);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.sources, []);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), snapshot, '文件连字节都不该变');
});

test('迁移：备份目录里有旧文件快照与被搬走的键', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  const out = migrateUserConfig(raw, NOW);
  assert.notEqual(out.backupDir, '');
  const dumped = readFileSync(join(out.backupDir, 'state-keys.json'), 'utf8');
  assert.match(dumped, /mcloud\.live\.listen_seconds\.task/);
  assert.equal(out.sources.length, 2, '存在的那两份旧 config.json 要被读到');
  const { readdirSync } = await import('node:fs');
  const backed = readdirSync(out.backupDir).filter((f) => f.endsWith('.json') && f !== 'state-keys.json');
  assert.equal(backed.length, 2, '两份旧文件原文都要有快照');
});

test('迁移：config.json 落盘是 0600', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  migrateUserConfig(raw, NOW);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o077, 0);
});

test('迁移：全新目录 ⇒ 写默认值 + schema_version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-migrate-fresh-'));
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  raw.ensureSchema();
  assert.equal(migrateUserConfig(raw, NOW).migrated, true);
  const doc = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(doc['schema_version'], SCHEMA_VERSION);
  assert.equal(doc['daily_budget_s'], 600, '种子值');
  assert.equal(doc['exchange_enabled'], true);
});

test('升版（schema_version 变大）：只补空缺，不覆盖用户改过的值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-migrate-up-'));
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  raw.ensureSchema();
  // 模拟「旧版本写过一份」：用户把预算改成 180，版本号是老的那一个
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ schema_version: 1, daily_budget_s: 180, exchange_enabled: false }),
  );
  // 旧 state 里还有一格（这一版才加进绑定的那种）
  writeFileSync(
    join(dir, 'shared.json'),
    JSON.stringify({ 'mcloud.exchange.schedule.plan': '12345' }),
  );
  const out = migrateUserConfig(raw, NOW);
  assert.equal(out.migrated, true, '版本号小 ⇒ 要跑一次');
  const doc = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(doc['daily_budget_s'], 180, '用户改过的值不许被种子冲掉');
  assert.equal(doc['exchange_enabled'], false);
  assert.equal(doc['schema_version'], SCHEMA_VERSION);
  // `schedule.plan` 是**退役的绑定**（老单计划兼容面）：不进文件，值要留在 state
  const shared = JSON.parse(readFileSync(join(dir, 'shared.json'), 'utf8')) as Record<string, string>;
  assert.equal(shared['mcloud.exchange.schedule.plan'], '12345', '退役的键要留在 state');
  const ex = (doc['exchange'] ?? {}) as Record<string, unknown>;
  assert.equal('schedule' in ex, false, '退役的键不许留在配置文件里');
});

test('升级默认迁移：同一目录再打开（新进程视角）⇒ 不重迁、读到同一份值', async () => {
  const dir = legacyDir();
  const first = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  assert.equal(migrateUserConfig(first, NOW).migrated, true);
  // 「面板重启 / 另一个插件首启」= 同一目录再 open 一次，**不需要任何人点东西**
  const second = openFileStore({ dir, plugin: 'mcloud-daily', nowIso: NOW });
  const out = migrateUserConfig(second, NOW);
  assert.equal(out.migrated, false, '第二次必须空转');
  const doc = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(doc['daily_budget_s'], 480);
  assert.equal(second.userConfig?.read('daily_budget_s'), 480, '新实例直接读到文件里的值');
});

test('迁移锁用完就删（不残留 .lock-migrate）', async () => {
  const dir = legacyDir();
  const raw = openFileStore({ dir, plugin: 'mcloud', nowIso: NOW });
  migrateUserConfig(raw, NOW);
  assert.throws(() => statSync(join(dir, '.lock-migrate')), '锁目录必须清掉');
});
