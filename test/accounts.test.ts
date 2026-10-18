// 多账号那一层：列表 / 当前账号 / 回落单账号。
//
// ⚠ 这一层最要紧的性质**不是**"列表能存能取"，而是**"旧的单凭据照原样工作"** ——
//   全仓库十几处读凭据的地方都收进了 `loadAuthRaw`，只要回落那条路断了，
//   所有任务会一起"没凭据"（而现象是"任务都在跑但什么都不做"，最难查）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { jwtUserDomainId } from '../src/mcloud/authRefresh.ts';
import { backfillDomainFromJwt, exchangeKey } from '../src/mcloud/sessionExchange.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import {
  STATE_ACCOUNTS,
  STATE_CURRENT_ACCOUNT,
  currentAccount,
  idOf,
  loadAccounts,
  maskAuth,
  phoneOf,
  removeAccount,
  currentAccountDomain,
  normalizeAuth,
  selectAccount,
  setAccountDomain,
  upsertAccount,
} from '../src/mcloud/accounts.ts';
import { STATE_AUTH, loadAuthRaw } from '../src/mcloud/sessionExchange.ts';

const NOW = '2026-10-14T10:00:00.000Z';
const A1 = 'Basic xxxx19142492716xxxx';
const A2 = 'Basic yyyy15909397542yyyy';

/** 造一串"能被 `parseAuth` 认出来"的凭据：`Basic base64(pc:手机号:token)`。 */
function cred(platform: string, phone: string): string {
  return `Basic ${Buffer.from(`${platform}:${phone}:TOKEN`, 'utf8').toString('base64')}`;
}

test('列表：加两个账号、同一个再加一次是**更新**而不是新增', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  upsertAccount(store, A2, NOW);
  assert.equal(loadAccounts(store).length, 2);
  const again = upsertAccount(store, A1 + 'more', NOW);
  assert.equal(again.created, false, '同一个人 ⇒ 更新');
  assert.equal(loadAccounts(store).length, 2);
  assert.equal(loadAccounts(store).find((a) => a.id === '19142492716')?.auth, A1 + 'more');
});

test('id 用手机号（人能对上）；认不出手机号就用短哈希', () => {
  assert.equal(idOf(A1), '19142492716');
  assert.equal(phoneOf(A1), '19142492716');
  assert.equal(phoneOf('no-phone-here'), undefined);
  assert.match(idOf('no-phone-here'), /^anon-[0-9a-z]+$/);
});

test('界面看到的只有**掩码**：不许把凭据本身递出去', () => {
  const m = maskAuth(A1);
  assert.match(m, /^1\*{4}2716 · \d+ 字符$/);
  assert.ok(!m.includes('xxxx'), `掩码里不许出现凭据片段：${m}`);
  assert.ok(!m.includes('19142492716'), '手机号也不整条给');
});

test('删掉的正好是"当前"那一格 ⇒ 当前也要清掉（不留指向空气的 id）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  assert.equal(selectAccount(store, '19142492716', NOW), true);
  assert.equal(currentAccount(store)?.id, '19142492716');
  removeAccount(store, '19142492716', NOW);
  assert.equal(currentAccount(store), undefined);
  assert.equal(store.getState(STATE_CURRENT_ACCOUNT), '');
});

test('选一个不在列表里的 id ⇒ 拒绝（不改状态）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  selectAccount(store, '19142492716', NOW);
  assert.equal(selectAccount(store, '不存在', NOW), false);
  assert.equal(currentAccount(store)?.id, '19142492716');
});

test('⭐ 回落：列表为空 / 没设当前 ⇒ 旧的单凭据照原样工作', () => {
  const store = memStore();
  store.setState(STATE_AUTH, A1, NOW);
  assert.equal(loadAuthRaw(store), A1, '没有列表时就走单账号那格');
  upsertAccount(store, A2, NOW);
  assert.equal(loadAuthRaw(store), A1, '有列表但没选当前 ⇒ 仍然是单账号那格');
  selectAccount(store, '15909397542', NOW);
  assert.equal(loadAuthRaw(store), A2, '选了当前 ⇒ 用它');
  selectAccount(store, '', NOW);
  assert.equal(loadAuthRaw(store), A1, '清掉当前 ⇒ 回落到单账号那格');
});

test('坏数据不许把任务弄挂：JSON 烂掉 / 不是数组 / 条目缺字段 ⇒ 当成"没有列表"', () => {
  const store = memStore();
  store.setState(STATE_AUTH, A1, NOW);
  for (const bad of ['{不是 json', '"字符串"', '{"a":1}', '[{"id":"x"},{"auth":"y"}]', '[]']) {
    store.setState(STATE_ACCOUNTS, bad, NOW);
    assert.deepEqual(loadAccounts(store), [], `坏数据要当成空列表：${bad}`);
    assert.equal(loadAuthRaw(store), A1, `坏数据之后仍要能回落到单凭据：${bad}`);
  }
});

test('当前账号的凭据就是 loadAuthRaw 的返回值（听弹幕/领花都靠这一条）', () => {
  const store = memStore();
  upsertAccount(store, A1, NOW);
  upsertAccount(store, A2, NOW);
  selectAccount(store, '19142492716', NOW);
  assert.equal(loadAuthRaw(store), A1);
  selectAccount(store, '15909397542', NOW);
  assert.equal(loadAuthRaw(store), A2, '换账号之后立刻生效 —— 不需要重建任何东西');
});

// ────────────────── 用户域：**每个账号一格**（F-076） ──────────────────
//
// 它回答的是"**这个账号**属于哪个用户域"，是**每个账号**的事实。原来存在全局一格
// `mcloud.login.userDomainId` 里，换账号登录一次就把上一号的域盖掉 ——
// 而它决定业务请求里的 `x-yun-uni`。参考实现就是账号级（`Account::user_domain_id`）。

test('⚠ 用户域跟着**账号**走：换账号不会串味', () => {
  const store = memStore();
  store.ensureSchema();
  const a = upsertAccount(store, cred('pc', '13800000001'), NOW, undefined, 'win', '111');
  const b = upsertAccount(store, cred('pc', '13800000002'), NOW, undefined, 'win', '222');
  assert.equal(a.account.userDomainId, '111');
  assert.equal(b.account.userDomainId, '222');

  selectAccount(store, a.account.id, NOW);
  assert.equal(currentAccountDomain(store), '111');
  selectAccount(store, b.account.id, NOW);
  assert.equal(currentAccountDomain(store), '222', '切账号之后读到的必须是**这个**账号的域');
  // 两个账号各自那份都还在（不是"最后一次登录覆盖全部"）
  const list = loadAccounts(store);
  assert.deepEqual(
    list.map((x) => [x.id, x.userDomainId]).sort(),
    [
      [a.account.id, '111'],
      [b.account.id, '222'],
    ].sort(),
  );
});

test('⚠ 贴凭据那条路拿不到域 ⇒ **保留**原来那份，不许抹掉', () => {
  const store = memStore();
  store.ensureSchema();
  const first = upsertAccount(store, cred('pc', '13800000003'), NOW, undefined, 'win', '333');
  assert.equal(first.account.userDomainId, '333');
  // 同一个号再"贴一次凭据"（没有域参数）
  const again = upsertAccount(store, cred('pc', '13800000003'), NOW, undefined, 'win');
  assert.equal(again.created, false);
  assert.equal(again.account.userDomainId, '333', '没有新域时不能把已有的域抹掉');
  // 明确给了新域 ⇒ 换成新的
  const third = upsertAccount(store, cred('pc', '13800000003'), NOW, undefined, 'win', '444');
  assert.equal(third.account.userDomainId, '444');
});

test('⚠ 没有当前账号 / 账号没有域 ⇒ `null`（不是空串、不是编一个）', () => {
  const store = memStore();
  store.ensureSchema();
  assert.equal(currentAccountDomain(store), null, '一个账号都没有');
  const a = upsertAccount(store, cred('pc', '13800000004'), NOW, undefined, 'win');
  selectAccount(store, a.account.id, NOW);
  assert.equal(currentAccountDomain(store), null, '账号上没有域');
  assert.equal(setAccountDomain(store, a.account.id, '555', NOW)?.userDomainId, '555');
  assert.equal(currentAccountDomain(store), '555');
  // 空串 = "不知道"，不许写进去
  assert.equal(setAccountDomain(store, a.account.id, '', NOW), undefined);
  assert.equal(currentAccountDomain(store), '555');
});

test('⚠ 换票拿到票之后，把用户域**补到当前账号**上（老账号自愈）', () => {
  // 账号上那一格只有"登录那一刻"才会写。老账号（登录域还是全局一格那版）永远缺它，
  // 而换票**每天都会跑** —— 跑一次自愈一次，不写的话 `x-yun-uni` 那类请求永远缺一格。
  const store = memStore();
  store.ensureSchema();
  const a = upsertAccount(store, cred('pc', '13800000005'), NOW, undefined, 'win');
  selectAccount(store, a.account.id, NOW);
  assert.equal(currentAccountDomain(store), null, '先确认它是缺的');

  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ iss: 'x', sub: JSON.stringify({ userDomainId: '777' }) })}.sig`;
  // 走**生产那份**函数（不是测试里再抄一遍规则）
  assert.equal(backfillDomainFromJwt(store, jwt, NOW), '777');
  assert.equal(currentAccountDomain(store), '777');
  // 已经有域 ⇒ 不覆盖（票可能是别的号换来的，覆盖就是串味）
  const jwt2 = `${b64({ alg: 'none' })}.${b64({ sub: JSON.stringify({ userDomainId: '888' }) })}.sig`;
  assert.equal(backfillDomainFromJwt(store, jwt2, NOW), null);
  assert.equal(currentAccountDomain(store), '777');
  // 没有当前账号 ⇒ 也不写（不猜"给谁"）
  selectAccount(store, '', NOW);
  assert.equal(backfillDomainFromJwt(store, jwt2, NOW), null);
});

// ─────────── 贴进来的凭据**可能没有 `Basic ` 前缀**（F-078） ───────────
//
// 用户从 mcloud 里复制过来：「我从 mcloud 那里拿的，怎么会是失效的」。
// 实测那两串差 6 个字符 —— 就是 `Basic ` 本身。`parseAuth` 容忍缺前缀（所以账号
// 看着"正常"），可这一格是**原样当 `Authorization` 头**发出去的 ⇒ 上游回
// `05050009 非法的token！`，一句指向"凭据过期"的假线索。

test('⚠ 缺 `Basic ` 前缀的凭据要**归一**（否则请求头是坏的）', () => {
  const b64 = Buffer.from('pc:17823734979:C6l6qV71|1|RCS|1793754829497|x', 'utf8').toString('base64');
  assert.equal(normalizeAuth(b64), `Basic ${b64}`, '缺前缀要补上');
  assert.equal(normalizeAuth(`Basic ${b64}`), `Basic ${b64}`, '有了就别重复加');
  assert.equal(normalizeAuth(`  basic   ${b64}  `), `Basic ${b64}`, '大小写/空白都要归一');
  assert.equal(normalizeAuth(`\nBasic\n${b64}\n`), `Basic ${b64}`, '贴进来带换行也要能认');
  // 解不开的串原样留着（不猜）
  assert.equal(normalizeAuth('不是凭据'), '不是凭据');
});

test('⚠ 缺前缀的凭据落库之后：id 认得出手机号、不会再存成 anon-xxxx', () => {
  const store = memStore();
  store.ensureSchema();
  const b64 = Buffer.from('pc:17823734979:C6l6qV71|1|RCS|1793754829497|x', 'utf8').toString('base64');
  const up = upsertAccount(store, b64, NOW, undefined, 'win');
  assert.equal(up.account.id, '17823734979', `id 应该是手机号，实际 ${up.account.id}`);
  assert.ok(up.account.auth.startsWith('Basic '), '落库的那串必须带前缀');
  // 再贴一次"不带前缀"的同一串：**不许**变成两条
  const again = upsertAccount(store, b64, NOW, undefined, 'win');
  assert.equal(again.created, false);
  assert.equal(loadAccounts(store).length, 1, '同一个号不该出现两条');
});

test('⚠ 老库里"没有前缀"的行，读出来就要是好的（不迁移也不影响发请求）', () => {
  const store = memStore();
  store.ensureSchema();
  const b64 = Buffer.from('pc:17823734979:C6l6qV71|1|RCS|1793754829497|x', 'utf8').toString('base64');
  // 直接塞一条"上一版存进去的坏形状"
  store.setState(
    STATE_ACCOUNTS,
    JSON.stringify([
      { id: 'anon-aohk08', label: '移动', auth: b64, platform: 'pc', pcPlatform: 'win', addedAt: NOW },
    ]),
    NOW,
  );
  const list = loadAccounts(store);
  assert.equal(list[0]!.id, 'anon-aohk08', 'id 不许变（动了会连累账号袋与"当前账号"）');
  assert.ok(list[0]!.auth.startsWith('Basic '), '读出来那串必须带前缀');
});

// ─────────── 按账号的代码路径**不许**读"全局的当前账号"（F-081） ───────────

test('⚠ `loadAuthRaw(scoped(id))` 必须给**那个账号**的凭据，不是当前账号的', () => {
  const store = memStore();
  store.ensureSchema();
  const a = upsertAccount(store, cred('pc', '13800000011'), NOW, '甲', 'win');
  const b = upsertAccount(store, cred('pc', '13800000012'), NOW, '乙', 'win');
  selectAccount(store, a.account.id, NOW); // 当前是「甲」
  const oneB = scoped(rawStoreOf(store), b.account.id);
  // 只读"全局当前"的话这里会拿到「甲」的凭据 —— 于是 B 的换票用 A 的身份
  assert.equal(loadAuthRaw(oneB), b.account.auth, 'scoped 之后必须读到「乙」自己那串');
  assert.equal(loadAuthRaw(store), a.account.auth, '裸 store 仍然按"当前账号"');
});

test('⚠ 换票的状态键要带**这个账号**的 id，不是当前账号的', () => {
  const store = memStore();
  store.ensureSchema();
  const a = upsertAccount(store, cred('pc', '13800000021'), NOW, '甲', 'win');
  const b = upsertAccount(store, cred('pc', '13800000022'), NOW, '乙', 'win');
  selectAccount(store, a.account.id, NOW);
  const oneB = scoped(rawStoreOf(store), b.account.id);
  // 键里嵌的 id 必须是「乙」——现场踩到的坏形状是「乙的袋里躺着 h5.exchange.<甲的 id>.sign-in」
  const k = exchangeKey(oneB, 'sign-in');
  assert.ok(k.includes(b.account.id), `键里没有乙的 id：${k}`);
  assert.ok(!k.includes(a.account.id), `键里混进了甲的 id：${k}`);
});
