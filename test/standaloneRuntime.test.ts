import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/standalone/runtime.ts';
import { loadAccounts } from '../src/mcloud/accounts.ts';
import { redpackEnabled, setRedpackEnabled } from '../src/mcloud/tasks/redpackState.ts';
import { tokenPkDraw } from '../src/mcloud/tokenPkState.ts';
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

test('独立运行时：配置没写这一格 ⇒ 不碰面板设过的值（缺省是关）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  const p = cfg(d);
  const a = await createRuntime({ configPath: p });
  const id = loadAccounts(a.rawStore)[0]!.id;
  assert.equal(redpackEnabled(scoped(a.rawStore, id)), false, '没写过 = 缺省关（2026-11-25 口径）');
  // 用户在面板上关掉它
  setRedpackEnabled(scoped(a.rawStore, id), false, '2026-10-23T02:00:00.000Z');
  a.close();
  // 重启：配置里没这句话 ⇒ 关掉的那个决定还在
  const b = await createRuntime({ configPath: p });
  assert.equal(redpackEnabled(scoped(b.rawStore, loadAccounts(b.rawStore)[0]!.id)), false);
  b.close();
});

test('独立运行时：代抽只在配置写了才落状态（账号 > common），缺省不抽', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-rt-'));
  // ① common 写开 ⇒ 这个号跟着开
  const p = cfg(d, { common: { 算力大作战: { 代抽: { 开启: true, 每日上限: 2 } } } });
  const a = await createRuntime({ configPath: p });
  const idA = loadAccounts(a.rawStore)[0]!.id;
  assert.deepEqual(tokenPkDraw(scoped(a.rawStore, idA)), { enabled: true, max: 2 });
  a.close();
  // ② 账号那层赢过 common（显式关）
  const p2 = cfg(d, {
    common: { 算力大作战: { 代抽: { 开启: true, 每日上限: 2 } } },
    caiyun: [{ auth: 'Basic dGVzdDoxMjM=', nickname: '小号', 算力大作战: { 代抽: { 开启: false } } }],
  });
  const b = await createRuntime({ configPath: p2 });
  assert.deepEqual(tokenPkDraw(scoped(b.rawStore, loadAccounts(b.rawStore)[0]!.id)), { enabled: false, max: 10 });
  b.close();
  // ③ 都没写 ⇒ 不抽（这是唯一"缺省关"的格）
  const p3 = cfg(d);
  const c = await createRuntime({ configPath: p3 });
  assert.deepEqual(tokenPkDraw(scoped(c.rawStore, loadAccounts(c.rawStore)[0]!.id)), { enabled: false, max: 10 });
  c.close();
});

test('⚠ CLI 契约：`--version` 只打版本号（脚本要读它），`--help` 要列全六族', async () => {
  // 契约（`panel-plugins/AGENTS.md` §2）：CLI 至少支持 `--help` / `--version` / `--config`。
  // 2026-11-26 实测：`--version` **没实现** —— 落进了正常执行那条路，报
  // 「找不到配置文件，请确保当前目录有 asign.json」，退出码还是 2。
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { PLUGIN_VERSION } = await import('../src/version.ts');
  const { cliAction } = await import('../src/standalone/mcloudSign.ts');
  const cli = 'dist/standalone/mcloud-sign.mjs';

  // ① 判定是纯函数：CI 里 `dist/` 是 gitignore 的（`npm test` 跑在 build 之前），
  //    所以**契约本身**用这一半钉住，不依赖产物。
  assert.equal(cliAction(['--version']), 'version');
  assert.equal(cliAction(['-v']), 'version');
  assert.equal(cliAction(['--help']), 'help');
  assert.equal(cliAction(['-h']), 'help');
  assert.equal(cliAction(['config:import', '--config', 'x.json']), 'config-import');
  assert.equal(cliAction(['--config', 'x.json', '--only', 'tokenpk']), 'run');

  // ② 端到端：产物在就跑（本机 / build 之后），不在就跳过（CI 的 check job）
  if (!existsSync(cli)) {
    assert.ok(true, '没有 dist/standalone（CI 里正常），只跑了判定那一半');
    return;
  }
  const out = execFileSync('node', [cli, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(out, PLUGIN_VERSION, `--version 要只打版本号，实际：${JSON.stringify(out)}`);

  const help = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
  for (const id of ['signin', 'expansion', 'appTask', 'redpack', 'tokenpk', 'playAI']) {
    assert.match(help, new RegExp(`\\b${id}\\b`), `--help 里没列 ${id}`);
  }
});
