// 状态键作用域：**结构性**测试。
//
// # 为什么这一层要结构性测试，而不只是功能测试
//
// 多账号串号那一串 bug（F-048/049/050）的共同点是：**单账号下完全正常**。
// 所以"改完之后能跑"这种测试**一条都抓不到它们** —— 全局键在单账号下也是对的。
//
// # 机制在哪
//
// `memStore()` / `makeStore()` 都会被 `scoped()` 包一层，之后
// `store.getState(键)` 对**按账号的键**自动落到当前账号的袋里。
// 调用点不用知道账号的存在 —— 这是有意的：「记得分账号」是纪律，
// 「分不了账号」才是结构（参考实现的 `account_state(id)` 就是后者）。
//
// 所以这个文件测的是：
//   ① 漏登记：源码里出现的键没在 `KEY_SCOPE` 里 ⇒ 静态扫出来
//   ② 路由真的生效：两账号各写各的、各读各的
//   ③ 删账号要清干净：袋是一个键，删一个就是删全部
//   ④ 老数据能搬进袋（`ordered_hour` 丢了会**重复下单**）
//   ⑤ 不许包两次（包两次会静默错，所以必须炸）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACCT_PREFIX,
  DEFAULT_ACCT,
  PLUGIN_NS,
  KEY_PREFIX_SCOPE,
  KEY_SCOPE,
  UnregisteredKeyError,
  acctBagKey,
  acctIdOf,
  clearBag,
  migrateFlatKeys,
  readBag,
  routeGet,
  routeUpdate,
  scopeOf,
} from '../src/store/keys.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { memStore } from '../src/store/memory.ts';
import { idOf, removeAccount, selectAccount, upsertAccount } from '../src/mcloud/accounts.ts';

const NOW = '2026-10-15T08:00:00.000Z';
const A = 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2VuQQ==';
const B = 'Basic bW9iaWxlOjEzOTAwMDAwMDAwOnRva2VuQg==';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 扫一遍源码里出现的所有状态键字面量。 */
function scannedKeys(): Set<string> {
  const files = [...walk('src'), ...walk('test'), ...walk('scripts')].filter(
    (f) => !f.endsWith('keys.test.ts'),
  );
  const found = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf-8').matchAll(/'(mcloud\.[a-zA-Z0-9_.]*)'/g)) {
      const k = m[1]!;
      if (k.endsWith('.com') || k.endsWith('.cn')) continue; // 域名不是状态键
      // 文件名也不是状态键（`mcloud.panel.json` 这种在测试里当路径用）
      if (/\.(json|md|js|ts|txt)$/.test(k)) continue;
      if (k === ACCT_PREFIX) continue; // 袋的物理键前缀不是逻辑键
      if (k === PLUGIN_NS) continue; // 命名空间本身不是键
      found.add(k);
    }
  }
  return found;
}

test('⚠ 源码里出现的每一个 `mcloud.*` 键都**登记过**（漏登记 = 下次多账号串号）', async () => {
  // 这条是这一层的**守门人**：新加一个键却忘了分类 ⇒ 这里红。
  //
  // 不这么钉的话，漏登记的表现是"某个任务在多账号下串号"，而且**单账号测不出来**
  // —— 也就是同一类 bug 会一次又一次地回来。
  const unregistered = [...scannedKeys()].filter((k) => scopeOf(k) === undefined).sort();
  assert.deepEqual(
    unregistered,
    [],
    `这些键没登记作用域（去 store/keys.ts 的 KEY_SCOPE / KEY_PREFIX_SCOPE 里加）：\n  ${unregistered.join('\n  ')}`,
  );
});

test('登记表里的键都**真的存在**于源码（改名留下的尸体要清掉）', async () => {
  const all = scannedKeys();
  const stale = Object.keys(KEY_SCOPE).filter((k) => !all.has(k)).sort();
  assert.deepEqual(stale, [], `这些键在源码里已经不存在了：\n  ${stale.join('\n  ')}`);
});

test('没登记的键**抛**，不许静默当全局', async () => {
  const raw = { getState: () => null };
  assert.throws(() => routeGet(raw, 'mcloud.没登记过'), UnregisteredKeyError);
  // 报错消息里要带键名 —— 否则只能靠猜是哪一个
  assert.throws(() => routeGet(raw, 'mcloud.没登记过'), /mcloud\.没登记过/);
});

test('⚠ 两账号各写同一个键 ⇒ 各读各的（这一类 bug 的核心）', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, A, NOW, 'A');
  upsertAccount(store, B, NOW, 'B');

  selectAccount(store, idOf(A), NOW);
  store.setState('mcloud.daily.done_date', '2026-10-15', NOW);
  store.setState('mcloud.session', '{"jwt":"JWT-A"}', NOW);

  selectAccount(store, idOf(B), NOW);
  assert.equal(store.getState('mcloud.daily.done_date'), null, '⚠ B 读到了 A 的标记');
  assert.equal(store.getState('mcloud.session'), null, '⚠ B 读到了 A 的会话');
  store.setState('mcloud.daily.done_date', '2026-10-16', NOW);

  selectAccount(store, idOf(A), NOW);
  assert.equal(store.getState('mcloud.daily.done_date'), '2026-10-15', 'A 的还在');
  assert.equal(store.getState('mcloud.session'), '{"jwt":"JWT-A"}', 'A 的会话还在');
  selectAccount(store, idOf(B), NOW);
  assert.equal(store.getState('mcloud.daily.done_date'), '2026-10-16', 'B 的是自己的');
});

test('⚠ 写一个字段**不会抹掉袋里别的任务的键**', async () => {
  // 袋里躺着这个账号**所有任务**的键。只写一个字段却整体覆盖的话，
  // 表现是"跑完 A 任务之后 B 任务的进度没了" —— 而那是**随机的**，
  // 取决于哪个任务后跑，极难查。参考实现 `save_share_done_day` 注释里点明了这个坑。
  const store = memStore();
  store.ensureSchema();
  selectAccount(store, '', NOW);
  store.setState('mcloud.smid.deviceId', 'DEV-1', NOW);
  store.setState('mcloud.daily.done_date', '2026-10-15', NOW);
  store.setState('mcloud.session', '{"jwt":"X"}', NOW);
  assert.equal(store.getState('mcloud.smid.deviceId'), 'DEV-1', '⚠ 被后来那次写抹掉了');
  assert.equal(store.getState('mcloud.daily.done_date'), '2026-10-15');
  assert.equal(store.getState('mcloud.session'), '{"jwt":"X"}');
});

test('⚠ 没有账号时也走袋（**不许**有"没有作用域"的路径）', async () => {
  // 留一条裸键路径，就等于留一条回到全局键的路 —— 而全局键就是那些 bug。
  const store = memStore();
  store.ensureSchema();
  assert.equal(acctIdOf(store), DEFAULT_ACCT);
  store.setState('mcloud.session', '{"jwt":"单账号"}', NOW);
  assert.equal(store.getState('mcloud.session'), '{"jwt":"单账号"}');
  // ⚠ 裸键里**必须**没有东西，东西在 default 那个袋里
  const bare = rawStoreOf(store).getState('mcloud.session');
  assert.ok(bare === null || bare === '', `裸键不许有东西，实际：${bare}`);
  assert.ok((rawStoreOf(store).getState(acctBagKey(DEFAULT_ACCT)) ?? '').includes('单账号'));
});

test('配置类不跟账号走，而且**不在 state 里**（落唯一配置文件）', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, A, NOW, 'A');
  selectAccount(store, idOf(A), NOW);
  store.setState('mcloud.exchange.target_hour', '10', NOW);
  selectAccount(store, '', NOW);
  assert.equal(store.getState('mcloud.exchange.target_hour'), '10', '切账号后配置仍然生效');
  // 2026-11-19「配置统一」：它**不在** shared.json 里，只在唯一配置文件里。
  const raw = rawStoreOf(store);
  assert.equal(raw.getState('mcloud.exchange.target_hour'), null, 'state 里不许有同名字段');
  const doc = raw.userConfig?.snapshot() ?? {};
  assert.equal((doc['exchange'] as Record<string, unknown>)['target_hour'], '10');
});

test('⚠ 裸 store 上写配置键要报错（否则又造出第二个家）', async () => {
  const store = memStore();
  store.ensureSchema();
  assert.throws(
    () => rawStoreOf(store).setState('mcloud.daily.budget_s', '300', NOW),
    /属于 config.json/,
  );
});

test('⚠ 删账号要能**一键清干净**（扁平键散落时根本清不掉）', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, A, NOW, 'A');
  selectAccount(store, idOf(A), NOW);
  for (const k of ['mcloud.session', 'mcloud.daily.done_date', 'mcloud.live.draw']) {
    store.setState(k, 'x', NOW);
  }
  const raw = rawStoreOf(store);
  assert.equal(Object.keys(readBag(raw, idOf(A))).length, 3);
  clearBag(raw, idOf(A), NOW);
  assert.equal(store.getState('mcloud.session'), null, '删完读不到');
  assert.deepEqual(readBag(raw, idOf(A)), {}, '袋是空的');
});

test('⚠ 删账号会**连袋一起清**（否则同号重加会继承旧状态）', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, A, NOW, 'A');
  selectAccount(store, idOf(A), NOW);
  store.setState('mcloud.exchange.order.ordered_hour', '2026-10-15T08', NOW);

  removeAccount(store, idOf(A), NOW);
  assert.deepEqual(
    readBag(rawStoreOf(store), idOf(A)),
    {},
    '⚠ 袋没跟着删 ⇒ 同一手机号重加会继承 `ordered_hour`',
  );

  // 同一个号再加回来：状态必须是**空的**
  upsertAccount(store, A, NOW, 'A');
  selectAccount(store, idOf(A), NOW);
  assert.equal(
    store.getState('mcloud.exchange.order.ordered_hour'),
    null,
    '新账号不该继承旧状态（否则会以为"这一小时已经下过单了"）',
  );
});

test('⚠ 迁移：老扁平键要搬进袋（`ordered_hour` 丢了会**重复下单**）', async () => {
  const store = memStore();
  store.ensureSchema();
  upsertAccount(store, A, NOW, 'A');
  selectAccount(store, idOf(A), NOW);
  // 模拟升级前的扁平数据：**绕过**路由，直接往裸键写
  const raw = rawStoreOf(store);
  raw.setState('mcloud.session', '{"jwt":"老会话"}', NOW);
  raw.setState('mcloud.exchange.order.ordered_hour', '2026-10-15T08', NOW);
  // ⚠ 以前这里还塞了一条 `mcloud.exchange.target_hour` 来证明「配置不该被搬」。
  //   2026-11-19 起配置键**不在 KEY_SCOPE 里**（它们属于 config.json），
  //   `migrateFlatKeys` 连看都看不到它们 —— 这层保证由 userConfig 的测试覆盖。

  const r = migrateFlatKeys(raw, NOW);
  assert.deepEqual(r.moved.sort(), ['mcloud.exchange.order.ordered_hour', 'mcloud.session']);
  assert.equal(store.getState('mcloud.session'), '{"jwt":"老会话"}');
  assert.equal(store.getState('mcloud.exchange.order.ordered_hour'), '2026-10-15T08');
  assert.equal(raw.getState('mcloud.session'), '', '扁平键要清掉');

  // 幂等：再搬一次什么都不动
  assert.deepEqual(migrateFlatKeys(raw, NOW).moved, []);
});

test('迁移**不覆盖**袋里已有的值（袋比扁平键新）', async () => {
  const store = memStore();
  store.ensureSchema();
  selectAccount(store, '', NOW);
  store.setState('mcloud.session', '{"jwt":"袋里的"}', NOW);
  const raw = rawStoreOf(store);
  raw.setState('mcloud.session', '{"jwt":"扁平的旧的"}', NOW);
  migrateFlatKeys(raw, NOW);
  assert.equal(store.getState('mcloud.session'), '{"jwt":"袋里的"}', '袋里的优先');
});

test('坏袋当空袋（不让插件在加载时炸掉）', async () => {
  const store = memStore();
  store.ensureSchema();
  const raw = rawStoreOf(store);
  raw.setState(acctBagKey(DEFAULT_ACCT), '{不是 JSON', NOW);
  assert.deepEqual(readBag(raw, DEFAULT_ACCT), {});
  assert.equal(store.getState('mcloud.session'), null);
});

test('前缀式键也认（`mcloud.last_error.<任务>` / `mcloud.h5.jwt.<配方>`）', async () => {
  assert.equal(scopeOf('mcloud.last_error.sign'), 'account');
  assert.equal(scopeOf('mcloud.h5.jwt.sign-in'), 'account', '票按**配方**分，前缀要登记');
  assert.equal(scopeOf('mcloud.h5.jwt.msg-push-on'), 'account');
  assert.ok(KEY_PREFIX_SCOPE.length > 0);
  const store = memStore();
  store.ensureSchema();
  store.setState('mcloud.last_error.sign', '失败了', NOW);
  assert.equal(store.getState('mcloud.last_error.sign'), '失败了');
});

test('⚠ 票按配方分：一页一张，互不覆盖', async () => {
  const store = memStore();
  store.ensureSchema();
  store.setState('mcloud.h5.jwt.sign-in', '{"jwt":"签到那张"}', NOW);
  store.setState('mcloud.h5.jwt.msg-push-on', '{"jwt":"推送那张"}', NOW);
  assert.equal(store.getState('mcloud.h5.jwt.sign-in'), '{"jwt":"签到那张"}');
  assert.equal(store.getState('mcloud.h5.jwt.msg-push-on'), '{"jwt":"推送那张"}');
});

test('⚠ 空串要**照原样往返**（迁移必须行为不变）', async () => {
  // "写空串 = 删字段"看着更干净，但它**改了行为**：老的扁平键写空串之后读回来是
  // 空串，删字段之后读回来是 `null` —— 而两者的判断在调用点截然不同
  // （`x === ''` 与 `x === null` 不通用）。迁移的第一要求是**行为不变**，不是"顺便更干净"。
  const store = memStore();
  store.ensureSchema();
  store.setState('mcloud.session', 'x', NOW);
  assert.equal(store.getState('mcloud.session'), 'x');
  store.setState('mcloud.session', '', NOW);
  assert.equal(store.getState('mcloud.session'), '', '读回来还要是空串，不是 null');
});

test('⚠ 不许包两次（包两次会让 `mcloud.acct.*` 也去查登记表然后抛错）', async () => {
  const store = memStore();
  assert.throws(() => scoped(store), /已经.*包过一次/);
});

test('袋的物理键形状固定（换实现时老数据要能读）', async () => {
  assert.equal(acctBagKey('abc'), `${ACCT_PREFIX}abc`);
  assert.equal(ACCT_PREFIX, 'mcloud.acct.');
});

test('⚠ 锁内读改写：update 只动一个字段，袋里**别的字段不丢**（丢更新 = 假绿/重复下单的根）', async () => {
  // 四个插件 + CLI 共用一份存储时，"读出来 → 改一点 → 整份写回"会让后写的
  // 整袋覆盖把先写的字段无声抹掉（daily 写 done_date 与路由刷会话同时发生；
  // 兑换的 ordered_hour 被回退 = 重复下单形状的风险，findings F-145）。
  // 所以"在现有值上改一点"必须走 `routeUpdate`（宿主在同一把锁里读改写）。
  const store = memStore();
  store.ensureSchema();
  store.setState('mcloud.session', JSON.stringify({ cookie: 'c=1', jwt: 'j', savedAt: NOW }), NOW);
  store.setState('mcloud.live.gate', 'G', NOW);

  routeUpdate(store, 'mcloud.live.gate', () => 'G2');
  assert.equal(store.getState('mcloud.live.gate'), 'G2');
  assert.equal(
    store.getState('mcloud.session'),
    JSON.stringify({ cookie: 'c=1', jwt: 'j', savedAt: NOW }),
    '同一个袋里的 session 不许被抹掉',
  );

  // 返回 null = 删掉这个字段（读回来是 null，不是空串）
  routeUpdate(store, 'mcloud.live.gate', () => null);
  assert.equal(store.getState('mcloud.live.gate'), null);
  assert.ok(store.getState('mcloud.session') !== null, '删一个字段不许把整袋清掉');

  // 全局键同样走锁内读改写（runLog / 计划计数就是这一类）
  store.setState('mcloud.run.log', '[{"id":"a"}]', NOW);
  routeUpdate(store, 'mcloud.run.log', (prev) => JSON.stringify([...JSON.parse(prev!), { id: 'b' }]));
  assert.deepEqual(JSON.parse(store.getState('mcloud.run.log')!), [{ id: 'a' }, { id: 'b' }]);
});
