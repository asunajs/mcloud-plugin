// 「明确点名一个号」与「按任务自己的选择」是两套语义，别混。
//
// 这一篇钉的是**调试运行**那一档（`forEachTaskAccount` 的第 6 参）：
//   · 不给名单 ⇒ 按 auto/manual 展开，**停用的号不跑**（正常语义）；
//   · 给了名单 ⇒ 只跑名单里的，**停用也跑**（用户原话：「总开关都关了我还调个屁」）；
//   · 名单里不存在的 id ⇒ 跳过（调用方自己去报「这个号不在列表里」）。
//
// ⚠ 为什么值得单独钉：这三条都在界面文案里承诺过（调试页那句"停用的号，这里选中也照样跑"），
//   而"停用"这个过滤藏在 `expand()` 里，改别处时很容易被顺手带掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forEachTaskAccount } from '../src/mcloud/accountRuntime.ts';
import { saveAccounts } from '../src/mcloud/accounts.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-11-26T00:00:00.000Z';

function store() {
  const s = memStore();
  s.ensureSchema();
  saveAccounts(s, [
    { id: 'a', label: 'A', auth: 'Basic YQ==', disabled: false },
    { id: 'b', label: 'B（停用）', auth: 'Basic Yg==', disabled: true },
    { id: 'c', label: 'C', auth: 'Basic Yw==', disabled: false },
  ]);
  return s;
}

const transport = (() => ({ status: 200, headers: {}, body: '{}' })) as never;
const collect = async (s: ReturnType<typeof store>, accounts: string[] | null): Promise<string[]> => {
  const out = await forEachTaskAccount<string>(
    s,
    '日常',
    { lateMs: 0 },
    transport as (r: BuiltRequest) => never,
    (_deps, acctId) => acctId,
    accounts,
  );
  return out.map((x) => x.acctId);
};

test('不给名单 ⇒ 按 auto 展开，停用的号**不跑**', async () => {
  assert.deepEqual(await collect(store(), null), ['a', 'c']);
});

test('明确点名停用的号 ⇒ **照跑**（调试就是这么用的）', async () => {
  assert.deepEqual(await collect(store(), ['b']), ['b']);
});

test('点名不存在的 id ⇒ 跳过（调用方自己报错，别静默换成别的号）', async () => {
  assert.deepEqual(await collect(store(), ['zzz']), []);
});

test('点名多个 ⇒ 按给定顺序跑，且不过滤停用', async () => {
  assert.deepEqual(await collect(store(), ['c', 'b']), ['c', 'b']);
});

test('点名的号仍然各自拿到**自己的** store（不是共用同一个）', async () => {
  const s = store();
  const seen: string[] = [];
  await forEachTaskAccount<string>(
    s,
    '日常',
    { lateMs: 0 },
    transport as (r: BuiltRequest) => never,
    (deps, acctId) => {
      // 在各自 store 上写一笔**已登记**的账号键，再读回来 —— 串号的话这里会读到别人的
      // （`mcloud.task.signin.on` 是 'account' 作用域，写它会落到这个号的袋里）
      deps.store.setState('mcloud.task.signin.on', `written-by-${acctId}`, NOW);
      seen.push(`${acctId}:${deps.store.getState('mcloud.task.signin.on')}`);
      return acctId;
    },
    ['a', 'c'],
  );
  assert.deepEqual(seen, ['a:written-by-a', 'c:written-by-c']);
});
