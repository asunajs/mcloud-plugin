// 对外契约：**别的插件**（咪咕音乐 mgmusic 0.6.0 起）直接读这份账号表。
//
// 消费方读的是文件：`<data>/plugin-data/mcloud/shared.json` 里的 `mcloud.accounts`
// （见 docs/architecture.md §3 的约定，以及 mgmusic 的 `readMcloudAccounts()`）。
// 所以下面每一条都是**跨仓契约**，改了就是那边静默读空：
//
//   · 键名 `mcloud.accounts`
//   · 落在**全局**键（shared.json），不在账号袋里
//   · 值是 JSON 数组，元素含 id / label / auth（还有 disabled）
//   · `auth` 是 `Basic base64(<pc|mobile>:<手机号>:<token>)`
//
// 这不是「多写一个测试」，是那条约定**唯一的执行点** —— 消费方在我们仓库外面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { STATE_ACCOUNTS, scopeOf } from '../src/store/keys.ts';
import { saveAccounts, loadAccounts, upsertAccount } from '../src/mcloud/accounts.ts';

const NOW = '2026-11-17T02:00:00.000Z';
const AUTH = 'Basic ' + Buffer.from('pc:13800138000:' + 'x'.repeat(201)).toString('base64');

test('契约：账号表键名与作用域（跨插件只读）', async () => {
  assert.equal(STATE_ACCOUNTS, 'mcloud.accounts', '改了键名，咪咕那边就读空了');
  assert.equal(scopeOf(STATE_ACCOUNTS), 'global', '必须在全局键里 —— 账号袋是按账号分文件的');
});

test('契约：账号表是数组，元素字段够消费方用', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, AUTH, NOW, '小号');
  const raw = store.getState(STATE_ACCOUNTS);
  assert.ok(raw !== null && raw !== undefined, '账号表要真的写进 state');
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parsed));
  const one = parsed[0]!;
  for (const key of ['id', 'label', 'auth']) {
    assert.equal(typeof one[key], 'string', '缺字段：' + key);
    assert.notEqual(one[key], '', '空字段：' + key);
  }
  assert.equal(one['auth'], AUTH, 'auth 要原样保存（消费方拿它去换票）');
  assert.equal(one['disabled'], false, 'disabled 必须是布尔：消费方据此跳过停用号');
});

test('契约：auth 是 Basic base64(端别:手机号:token)', async () => {
  const store = memStore();
  store.ensureSchema();
  saveAccounts(store, [{ id: '13800138000', label: '小号', auth: AUTH, disabled: false }] as never, NOW);
  const [one] = loadAccounts(store);
  assert.ok(one);
  assert.match(one.auth, /^Basic /, '消费方按 Basic 前缀解');
  const decoded = Buffer.from(one.auth.replace(/^Basic /, ''), 'base64').toString('utf8');
  const [platform, phone, token] = decoded.split(':');
  assert.equal(platform, 'pc');
  assert.match(String(phone), /^1\d{10}$/, '手机号在第二段 —— 咪咕用它当 msisdn');
  assert.ok(String(token).length > 20, 'token 在第三段');
});
