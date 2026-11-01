import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/standalone/runtime.ts';
import { loadAccounts } from '../src/mcloud/accounts.ts';
import { redpackEnabled, setRedpackEnabled } from '../src/mcloud/tasks/redpackState.ts';
import { scoped } from '../src/store/scoped.ts';

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

test('独立运行时：配置里写了「红包派对.开启」才落到账号那一格（三层合并：账号 > common > 缺省开）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  // ① common 写关 ⇒ 这个号关掉
  const p = cfg(d, { common: { 红包派对: { 开启: false } } });
  const a = await createRuntime({ configPath: p });
  const idA = loadAccounts(a.rawStore)[0]!.id;
  assert.equal(redpackEnabled(scoped(a.rawStore, idA)), false);
  a.close();
  // 重启还是关的（读的是状态里那一格，不是每次现算）
  const b = await createRuntime({ configPath: p });
  assert.equal(redpackEnabled(scoped(b.rawStore, loadAccounts(b.rawStore)[0]!.id)), false);
  b.close();
  // ② 账号那层赢过 common
  const p2 = cfg(d, {
    common: { 红包派对: { 开启: false } },
    caiyun: [{ auth: 'Basic dGVzdDoxMjM=', nickname: '小号', 红包派对: { 开启: true } }],
  });
  const c = await createRuntime({ configPath: p2 });
  assert.equal(redpackEnabled(scoped(c.rawStore, loadAccounts(c.rawStore)[0]!.id)), true);
  c.close();
});

test('独立运行时：配置没写这一格 ⇒ 不碰面板设过的值（缺省才是开）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  const p = cfg(d);
  const a = await createRuntime({ configPath: p });
  const id = loadAccounts(a.rawStore)[0]!.id;
  assert.equal(redpackEnabled(scoped(a.rawStore, id)), true, '没写过 = 开着（照参照实现的默认值）');
  // 用户在面板上关掉它
  setRedpackEnabled(scoped(a.rawStore, id), false, '2026-10-23T02:00:00.000Z');
  a.close();
  // 重启：配置里没这句话 ⇒ 关掉的那个决定还在
  const b = await createRuntime({ configPath: p });
  assert.equal(redpackEnabled(scoped(b.rawStore, loadAccounts(b.rawStore)[0]!.id)), false);
  b.close();
});
