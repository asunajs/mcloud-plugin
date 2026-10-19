// 「领取AI豆」的**真实结果**从哪来 —— 守的是 2026-10-19 用户报的那个 bug。
//
// 现场（真机日志）：
//
//   领取AI豆：领取到 78 个云朵        ← 每天都这么说
//   AI豆快照：流水 0 条               ← 账上什么都没有
//
// 两句话同时成立只有一种解释：**"领到了 78"是编出来的**。翻 state 里落的那条
// 原始响应，`result` 是 `{"receive":0,"total":9224,...}` —— 服务端明说这一枪
// 领到 **0** 个。数量当时是从**队列那一条**的 `cloudNum` 抄的（清单上标着多少），
// 而不是响应里的 `receive`。
//
// 还有一层：那条的 `cloudType` 是 **2（下月可领取）**，H5 对这种项**一个请求都不发**
// （参考实现 `mcloud` 的 `signin.rs` 就是这么分支的）。旧代码把 `2` 归到了
// "其余 ⇒ receiveV3"，于是每天发一枪注定 `receive: 0` 的请求，再报成成功。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import { saveSession } from '../src/store/types.ts';
import type { Store } from '../src/store/types.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import {
  CLOUD_TYPE,
  STATE_QUEUE,
  receiveAmountOf,
  runReceive,
} from '../src/mcloud/tasks/receive.ts';

const NOW = '2026-10-19T01:00:00.000Z';

function storeWithQueue(items: unknown[]): Store {
  const store = memStore();
  saveSession(store, { cookie: 'a=b', deviceId: 'B'.padEnd(89, 'x'), savedAt: NOW }, NOW);
  store.setState(STATE_QUEUE, JSON.stringify(items), NOW);
  return store;
}

/** 假上游：把响应体记下来，并把 `calls` 当"发了几枪"的计数器。 */
function deps(store: Store, calls: unknown[], body: unknown): TaskDeps {
  return {
    store,
    transport: (req: unknown) => {
      calls.push(req);
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    },
    nowIso: NOW,
  } as unknown as TaskDeps;
}

// ── 数量只认响应 ──────────────────────────────────────────────────────

test('`receiveAmountOf` 只读 `result.receive`（缺了就是 undefined，不猜）', () => {
  assert.equal(receiveAmountOf({ code: 0, result: { receive: 12, total: 9000 } }), 12);
  assert.equal(receiveAmountOf({ code: 0, result: { receive: 0 } }), 0);
  assert.equal(receiveAmountOf({ code: 0, result: { total: 9000 } }), undefined);
  assert.equal(receiveAmountOf({ code: 0, result: 100 }), undefined, '延期领取的 result 是裸数字');
  assert.equal(receiveAmountOf(null), undefined);
});

test('⚠ 报的数量必须是响应里的，不是队列那一条的 `cloudNum`', () => {
  const calls: unknown[] = [];
  // 清单上标着 78，服务端说这次只进 12 —— 只能说 12
  const store = storeWithQueue([
    { recordId: 'r1', cloudType: CLOUD_TYPE.NOW, raw: { cloudNum: 78, cloudType: 0 } },
  ]);
  const out = runReceive(deps(store, calls, { code: 0, msg: 'success', result: { receive: 12 } }));
  assert.equal(calls.length, 1, '这一类是要发请求的');
  assert.equal(out.ok, true);
  assert.match(out.note, /12/);
  assert.ok(!/78/.test(out.note), `不该出现队列里那个数字：${out.note}`);
});

test('⚠ 服务端回「领到 0 个」⇒ 如实说没进账，**不能报成功**', () => {
  const calls: unknown[] = [];
  const store = storeWithQueue([
    { recordId: 'r1', cloudType: CLOUD_TYPE.NOW, raw: { cloudNum: 78, cloudType: 0 } },
  ]);
  const out = runReceive(deps(store, calls, { code: 0, msg: 'success', result: { receive: 0 } }));
  assert.equal(out.ok, false, '领到 0 个不是成功');
  assert.match(out.note, /0 个/);
  assert.match(out.note, /没进账|已经领过/);
  assert.ok(!/78/.test(out.note));
});

test('响应里没有 `receive` ⇒ 不猜、不当成功', () => {
  const calls: unknown[] = [];
  const store = storeWithQueue([
    { recordId: 'r1', cloudType: CLOUD_TYPE.NOW, raw: { cloudNum: 5 } },
  ]);
  const out = runReceive(deps(store, calls, { code: 0, msg: 'success', result: {} }));
  assert.equal(out.ok, false);
  assert.match(out.note, /result\.receive/);
});

// ── cloudType 2（下月可领）一枪都不发 ─────────────────────────────────

test('⚠ cloudType=2（下月可领）⇒ **一个请求都不发**，也不能报"领到 N 个"', () => {
  const calls: unknown[] = [];
  const store = storeWithQueue([
    { recordId: 'r1', cloudType: CLOUD_TYPE.NEXT_MONTH, raw: { cloudNum: 78, cloudType: 2 } },
  ]);
  const out = runReceive(deps(store, calls, { code: 0, msg: 'success', result: { receive: 0 } }));
  assert.equal(calls.length, 0, '这一类 H5 只弹提示，不发请求');
  assert.equal(out.ok, true, '跳过不是失败');
  assert.equal(out.skipped, true);
  assert.match(out.note, /下月/);
  assert.ok(!/领到/.test(out.note), `不能说"领到"：${out.note}`);
  // 这一条要从队列里划掉，否则下一趟又跳一次（永远跳不完）
  assert.equal(store.getState(STATE_QUEUE), '[]');
});

test('延期领取（cloudType=1）仍然走另一口端点', () => {
  const calls: unknown[] = [];
  const store = storeWithQueue([
    { recordId: 'r1', cloudType: CLOUD_TYPE.EXPANSION, raw: { cloudNum: 100, cloudType: 1 } },
  ]);
  const out = runReceive(deps(store, calls, { code: 0, msg: 'success', result: 100 }));
  assert.equal(calls.length, 1);
  assert.equal(out.ok, true);
  assert.match(out.note, /延期/);
});
