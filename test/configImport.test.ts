// 旧 `asign.json` → 统一配置文件（`config:import`）。
//
// 用户口径：旧配置「可以使用命令/导出的函数调用，迁移到新的文件」。所以这里既测
// 导出的函数（`importLegacyConfig`），也测命令行那条路（`runConfigImport` 从 argv 取参）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacyConfig, argvValue, runConfigImport } from '../src/standalone/configImport.ts';
import { loadConfig } from '../src/standalone/config.ts';
import { SCHEMA_VERSION } from '../src/store/userConfigKeys.ts';

const AUTH = 'Basic ' + Buffer.from('pc:13800138000:' + 'x'.repeat(201)).toString('base64');

function legacyAsign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcloud-import-'));
  const p = join(dir, 'asign.json');
  writeFileSync(p, JSON.stringify({
    caiyun: [{ auth: AUTH, label: '小号' }],
    standalone: {
      http: { timeoutMs: 25_000, insecure: true, followRedirects: true },
      ws: { timeoutMs: 18_000 },
    },
  }));
  return p;
}

test('argvValue：`--k v` 与 `--k=v` 都认', async () => {
  assert.equal(argvValue(['--config', 'a.json'], '--config'), 'a.json');
  assert.equal(argvValue(['--config=x.json'], '--config'), 'x.json');
  assert.equal(argvValue([], '--config'), undefined);
});

test('导入：账号进 shared.json，CLI 旋钮进 config.json', async () => {
  const from = legacyAsign();
  const storeDir = mkdtempSync(join(tmpdir(), 'mcloud-import-store-'));
  const r = await importLegacyConfig({ from, storeDir });
  assert.equal(r.ok, true);
  assert.equal(r.accounts, 1);
  assert.match(r.written, /config\.json$/);
  const doc = JSON.parse(readFileSync(join(storeDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual((doc['cli'] as Record<string, Record<string, unknown>>)['http'], {
    timeout_ms: 25_000,
    insecure: true,
    follow_redirects: true,
  });
  assert.equal((doc['cli'] as Record<string, Record<string, unknown>>)['ws']!['timeout_ms'], 18_000);
  assert.equal(doc['schema_version'], SCHEMA_VERSION);
  // 账号在 state 里（契约位置不变）
  const shared = JSON.parse(readFileSync(join(storeDir, 'shared.json'), 'utf8')) as Record<string, string>;
  const accounts = JSON.parse(shared['mcloud.accounts']!) as { id: string }[];
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.id, '13800138000');
});

test('导入：幂等（第二次不重复建号、不重复写）', async () => {
  const from = legacyAsign();
  const storeDir = mkdtempSync(join(tmpdir(), 'mcloud-import-idem-'));
  await importLegacyConfig({ from, storeDir });
  const first = readFileSync(join(storeDir, 'shared.json'), 'utf8');
  const r2 = await importLegacyConfig({ from, storeDir });
  assert.equal(r2.accounts, 1, '还是 1 个号');
  const shared = JSON.parse(readFileSync(join(storeDir, 'shared.json'), 'utf8')) as Record<string, string>;
  assert.equal((JSON.parse(shared['mcloud.accounts']!) as unknown[]).length, 1);
  assert.ok(first.length > 0);
});

test('导入：--dry-run 什么都不写', async () => {
  const from = legacyAsign();
  const storeDir = mkdtempSync(join(tmpdir(), 'mcloud-import-dry-'));
  const r = await importLegacyConfig({ from, storeDir, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.accounts, 1, '会写入几个号要能看见');
  assert.equal(r.backupDir, '');
  assert.throws(() => readFileSync(join(storeDir, 'config.json')), 'dry-run 不该写配置文件');
});

test('导入：迁移源要备份一份原文', async () => {
  const from = legacyAsign();
  const storeDir = mkdtempSync(join(tmpdir(), 'mcloud-import-bak-'));
  const r = await importLegacyConfig({ from, storeDir });
  assert.notEqual(r.backupDir, '');
  assert.equal(readFileSync(join(r.backupDir, 'asign.json'), 'utf8'), readFileSync(from, 'utf8'));
});

test('统一配置文件能被 --config 直接读（不用再写 asign.json）', async () => {
  const from = legacyAsign();
  const storeDir = mkdtempSync(join(tmpdir(), 'mcloud-import-read-'));
  await importLegacyConfig({ from, storeDir });
  const cfg = await loadConfig(join(storeDir, 'config.json'));
  assert.equal(cfg.unified, true);
  assert.equal(cfg.http.timeoutMs, 25_000, 'CLI 旋钮从 cli.* 读');
  assert.equal(cfg.ws.timeoutMs, 18_000);
  assert.equal(cfg.accounts.length, 0, '统一配置里没有账号（账号在 shared.json）');
});

test('命令：缺参数要报清楚', async () => {
  await assert.rejects(() => runConfigImport([]), /--config/);
  const from = legacyAsign();
  await assert.rejects(() => runConfigImport(['--config', from]), /--data-dir|MCLOUD_DATA_DIR/);
});
