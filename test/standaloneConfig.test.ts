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

test('「红包派对.开启」只在**明确写了**时才读成值：没写 / 形状不对都是 `undefined`', async () => {
  const d = dir();
  const p = join(d, 'asign.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 2,
      caiyun: [
        { auth: 'Basic dGVzdDoxMjM=', nickname: '写了关', 红包派对: { 开启: false } },
        { auth: 'Basic dGVzdDoxMjQ=', nickname: '没写' },
      ],
      common: { 红包派对: { 开启: false } },
    }),
  );
  const c = await loadConfig(p);
  assert.equal(c.accounts[0]!.redpackEnabled, false);
  // ⚠ 第二账号是 `undefined` 而不是 `false`：那一层留给 runtime 去合 common，
  //   在这里就折成 false 的话，「没写过」与「写过关掉」再也分不开 —— 重启会把
  //   用户在面板上开的号偷偷关掉。
  assert.equal(c.accounts[1]!.redpackEnabled, undefined);
  assert.equal(c.commonRedpackEnabled, false);

  // 形状不对（写成布尔 / 字符串）⇒ 也当没写，不猜一个 false 出来
  writeFileSync(p, JSON.stringify({ version: 2, caiyun: [{ auth: 'Basic dGVzdDoxMjM=' }], common: { 红包派对: false } }));
  const bad = await loadConfig(p);
  assert.equal(bad.commonRedpackEnabled, undefined);
  assert.equal(bad.accounts[0]!.redpackEnabled, undefined);
});

test('「算力大作战.代抽」：true / {开启,每日上限} / 形状不对 ⇒ 当没写', async () => {
  const d = dir();
  const p = join(d, 'asign.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 2,
      caiyun: [
        { auth: 'Basic dGVzdDoxMjM=', 算力大作战: { 开启: true, 代抽: true } },
        { auth: 'Basic dGVzdDoxMjQ=', 算力大作战: { 代抽: { 开启: true, 每日上限: 3 } } },
        { auth: 'Basic dGVzdDoxMjU=', 算力大作战: { 代抽: { 开启: false } } },
        { auth: 'Basic dGVzdDoxMjY=', 算力大作战: { 代抽: '是' } },
        { auth: 'Basic dGVzdDoxMjc=' },
      ],
      common: { 算力大作战: { 代抽: { 开启: true, 每日上限: 0 } } },
    }),
  );
  const c = await loadConfig(p);
  assert.deepEqual(c.accounts[0]!.tokenPkDraw, { enabled: true, max: 10 }, 'true = 开、上限取默认 10');
  assert.deepEqual(c.accounts[1]!.tokenPkDraw, { enabled: true, max: 3 });
  assert.deepEqual(c.accounts[2]!.tokenPkDraw, { enabled: false, max: 10 }, '关掉是合法形状（显式关）');
  assert.equal(c.accounts[3]!.tokenPkDraw, undefined, '形状不对 ⇒ 当没写');
  assert.equal(c.accounts[4]!.tokenPkDraw, undefined, '没写 ⇒ undefined（留给 common）');
  assert.deepEqual(c.commonTokenPkDraw, { enabled: true, max: 0 }, '0 = 不抽，但要读出来');
});
