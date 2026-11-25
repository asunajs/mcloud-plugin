// 「导入旧配置」（老版 mcloud-sign 的 `asign.json`）：映射对不对、幂等、dry-run 不写。
//
// 这条是**首次使用**那条路：用户手里只有一份旧的 asign.json，装完插件就得能把它搬进来。
// 最容易错的是「云手机缺省已改为关」之后还按老语义搬（把 `开启:true` 搬丢）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { applyLegacyImport, parseLegacyAsign } from '../src/mcloud/legacyImport.ts';
import { taskOn } from '../src/mcloud/tasks/taskSwitches.ts';
import { loadAccounts } from '../src/mcloud/accounts.ts';

const NOW = '2026-11-25T02:00:00.000Z';

/** 一份典型的旧 `asign.json`（合成号，照 mcloud-sign 的形状）。 */
const LEGACY = {
  version: 2,
  caiyun: [
    {
      auth: 'Basic bW9iaWxlOjEzOTAwMTM5MDAwOnRva2Vu',
      nickname: '账号一',
      红包派对: { 开启: true },
      算力大作战: { 开启: false, 代抽: { 开启: true, 每日上限: 3 } },
    },
    { auth: 'Basic bW9iaWxlOjEzOTAwMTM5MDAxOnRva2Vu', nickname: '账号二' },
  ],
  common: { 红包派对: { 开启: false } },
  standalone: { http: { timeoutMs: 30000, insecure: true }, ws: { insecure: true } },
  AI新头像: { 开启: true },
  message: { type: 'pushplus' },
};

/** `memStore()` 已经是 `scoped()` 过的（业务代码拿到的就是它）。 */
function freshStore() {
  const store = memStore();
  store.ensureSchema();
  return store;
}

test('解析：账号、两个开关、公共层、cli 旋钮都抽出来了，不认识的键进 skipped', () => {
  const plan = parseLegacyAsign(LEGACY);
  assert.equal(plan.common.accounts.length, 2);
  assert.equal(plan.common.accounts[0]!.label, '账号一');
  assert.equal(plan.common.accounts[0]!.redpackEnabled, true);
  assert.equal(plan.common.accounts[0]!.tokenPkEnabled, false);
  assert.deepEqual(plan.common.accounts[0]!.tokenPkDraw, { enabled: true, max: 3 });
  assert.equal(plan.common.accounts[1]!.redpackEnabled, undefined, '没写就不该编一个值');
  assert.equal(plan.common.commonRedpackEnabled, false);
  const paths = plan.settings.map((s) => s.path);
  assert.ok(paths.includes('cli.http.timeout_ms'));
  assert.ok(paths.includes('cli.http.insecure'));
  assert.ok(paths.includes('task_redpack'), '公共层的红包开关也要进统一配置');
  assert.ok(
    plan.skipped.some((k) => k.includes('AI新头像')),
    `不认识的键要列出来：${plan.skipped.join(',')}`,
  );
});

test('落地：账号进表、开关写账号层、公共层进 config.json', () => {
  const store = freshStore();
  const plan = parseLegacyAsign(LEGACY);
  const report = applyLegacyImport(store, plan, NOW);

  const accounts = loadAccounts(store);
  assert.equal(accounts.length, 2);
  assert.equal(report.accounts, 2);

  const raw = rawStoreOf(store);
  const first = accounts.find((a) => a.label === '账号一')!;
  const second = accounts.find((a) => a.label === '账号二')!;
  // ① 显式开过的号：迁移后仍然开（云手机缺省已改为关，这一条是关键）
  assert.equal(taskOn(scoped(raw, first.id), 'redpack'), true);
  // ② 显式关的号：关
  assert.equal(taskOn(scoped(raw, first.id), 'tokenpk'), false);
  // ③ 没写这一格的号：走缺省（云手机 = 关）
  assert.equal(taskOn(scoped(raw, second.id), 'redpack'), false);

  // 公共层进了统一配置文件：直接问端口（`read(path)` 是"读某一格"）
  assert.ok(report.settings.includes('task_redpack'));
  // ⚠ 端口读到的是**配置文件里的原值**（布尔），不是 state 那层 `'1'/'0'`
  assert.equal(store.userConfig?.read('task_redpack'), false, 'common 里写的是关 ⇒ 公共层关');
});

test('幂等：同一份配置导两遍，账号不翻倍、开关不来回跳', () => {
  const store = freshStore();
  const plan = parseLegacyAsign(LEGACY);
  applyLegacyImport(store, plan, NOW);
  const before = loadAccounts(store).map((a) => `${a.id}:${a.label}`).sort();
  const r2 = applyLegacyImport(store, parseLegacyAsign(LEGACY), NOW);
  const after = loadAccounts(store).map((a) => `${a.id}:${a.label}`).sort();
  assert.deepEqual(after, before, '第二遍不该新增账号');
  assert.equal(r2.accounts, 2);
  const raw = rawStoreOf(store);
  const first = loadAccounts(store).find((a) => a.label === '账号一')!;
  assert.equal(taskOn(scoped(raw, first.id), 'redpack'), true, '第二遍之后开关还是那个值');
});

test('旧配置里没有 caiyun ⇒ 不删账号（空配置不动账号表）', () => {
  const store = freshStore();
  applyLegacyImport(store, parseLegacyAsign(LEGACY), NOW);
  const n = loadAccounts(store).length;
  applyLegacyImport(store, parseLegacyAsign({ version: 2 }), NOW);
  assert.equal(loadAccounts(store).length, n, '空配置等于什么都没说，不该把号删了');
});

test('不是对象 / 缺 auth ⇒ 报清楚', () => {
  assert.throws(() => parseLegacyAsign('nope'), /JSON 对象/);
  assert.throws(() => parseLegacyAsign({ caiyun: [{}] }), /caiyun\[0\] 缺少 auth/);
});
