import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfigPath, loadConfig } from '../src/standalone/config.ts';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'mcloud-cfg-'));
}

test('配置查找顺序照 mcloud-sign：cwd/asign.json 优先', () => {
  const d = dir();
  writeFileSync(join(d, 'asign.config.mjs'), 'export default { version: 2, caiyun: [] };');
  assert.equal(findConfigPath(d, join(d, 'bin/mcloud-sign')), join(d, 'asign.config.mjs'));
  writeFileSync(join(d, 'asign.json'), JSON.stringify({ version: 2, caiyun: [] }));
  assert.equal(findConfigPath(d, join(d, 'bin/mcloud-sign')), join(d, 'asign.json'));
  const d2 = dir();
  mkdirSync(join(d2, 'config'));
  writeFileSync(join(d2, 'config', 'asign.json'), JSON.stringify({ version: 2, caiyun: [] }));
  assert.equal(findConfigPath(d2, join(d2, 'bin/mcloud-sign')), join(d2, 'config/asign.json'));
});

test('旧版 caiyun 配置可直接读，账号昵称进 label', async () => {
  const d = dir();
  const p = join(d, 'asign.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 2,
      caiyun: [{ auth: 'Basic dGVzdDoxMjM=', nickname: '小号' }],
      common: { colorize: false },
      standalone: { http: { timeoutMs: 1234, insecure: true } },
    }),
  );
  const c = await loadConfig(p);
  assert.equal(c.accounts.length, 1);
  assert.equal(c.accounts[0]!.label, '小号');
  assert.equal(c.http.timeoutMs, 1234);
  assert.equal(c.http.insecure, true);
  assert.equal(c.stateFile, join(d, '.mcloud/state.json'));
});

test('asign.config.mjs 可直接读，不需要改写文件', async () => {
  const d = dir();
  const p = join(d, 'asign.config.mjs');
  writeFileSync(p, 'export default { version: 2, caiyun: [{ auth: "Basic dGVzdDoxMjM=", nickname: "JS号" }] };');
  const c = await loadConfig(p);
  assert.equal(c.accounts[0]!.label, 'JS号');
});

test('没有配置 / 没有 caiyun 时给出明确错误', async () => {
  const d = dir();
  await assert.rejects(() => loadConfig(join(d, 'missing.json')), /不存在/);
  const p = join(d, 'asign.json');
  writeFileSync(p, JSON.stringify({ version: 2 }));
  await assert.rejects(() => loadConfig(p), /caiyun/);
});
