import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/standalone/runtime.ts';
import { loadAccounts } from '../src/mcloud/accounts.ts';

function cfg(d: string, extra: Record<string, unknown> = {}): string {
  const p = join(d, 'asign.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 2,
      caiyun: [{ auth: 'Basic dGVzdDoxMjM=', nickname: '小号' }],
      standalone: { stateFile: join(d, 'state.json') },
      ...extra,
    }),
  );
  return p;
}

test('独立运行时：配置账号落进状态表，重启不丢', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  const p = cfg(d);
  const a = await createRuntime({ configPath: p });
  assert.equal(loadAccounts(a.rawStore).length, 1);
  assert.equal(loadAccounts(a.rawStore)[0]!.label, '小号');
  a.close();
  const b = await createRuntime({ configPath: p });
  assert.equal(loadAccounts(b.rawStore).length, 1);
  b.close();
});

test('独立运行时：config 不覆盖运行期换过的 auth，replaceAuth 才覆盖', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  const p = cfg(d);
  const a = await createRuntime({ configPath: p });
  const raw = a.rawStore;
  const list = loadAccounts(raw);
  raw.setState('mcloud.accounts', JSON.stringify([{ ...list[0]!, auth: 'Basic bmV3OnRva2Vu' }]), '2026-10-20T00:00:00Z');
  a.close();

  const b = await createRuntime({ configPath: p });
  assert.equal(loadAccounts(b.rawStore)[0]!.auth, 'Basic bmV3OnRva2Vu');
  b.close();

  const p2 = cfg(d, { caiyun: [{ auth: 'Basic dGVzdDoxMjM=', nickname: '小号', replaceAuth: true }] });
  const c = await createRuntime({ configPath: p2 });
  assert.equal(loadAccounts(c.rawStore)[0]!.auth, 'Basic dGVzdDoxMjM=');
  c.close();
});

test('run 无账号时明确退出码 1', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  const p = join(d, 'asign.json');
  writeFileSync(p, JSON.stringify({ version: 2, caiyun: [], standalone: { stateFile: join(d, 'state.json') } }));
  const { run } = await import('../src/standalone/mcloudSign.ts');
  const old = process.exitCode;
  process.exitCode = 0;
  await run(p);
  assert.equal(process.exitCode, 1);
  process.exitCode = old;
});
