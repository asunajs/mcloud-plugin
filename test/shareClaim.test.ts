// 434「领20豆」主动领取 —— 依据 2026-11-14 抓包
// `mcloud-capture/mcloud/capture/app-share-434-claim-samples.txt`。
//
// 钉住四件事：
//   ① 判据来自服务端（currstep=22 / 按钮「领N豆」），不自己算 7 天
//   ② 只发一发 `GET task/click?key=task&id=434`，只有 `code=0 && result.num>0` 算到账
//   ③ 按月幂等（不可回滚的东西绝不重发）
//   ④ 领奖档不进 appTask 那台「传文件→建外链→删外链」状态机

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isShareClaim, SPECIAL_CLICK_STEP, SHARE_TASK_ID } from '../src/mcloud/appTaskRules.ts';
import {
  STATE_SHARE_CLAIM_DONE,
  claimedBeans,
  runShareClaim,
} from '../src/mcloud/tasks/shareClaim.ts';
import { MATRIX_MARKETS, matrixKey, parseMatrixItem } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { pendingItems } from '../src/mcloud/tasks/appTask.ts';
import { parseSignInEnvelope } from '../src/mcloud/envelope.ts';
import { memStore } from '../src/store/memory.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-11-14T04:00:00.000Z';
const MONTH = '2026-11';
const CLICK_URL = 'https://m.mcloud.139.com/ycloud/signin/task/click?key=task&id=434';
const OK_20 = JSON.stringify({ code: 0, msg: 'success', result: { taskId: 434, num: 20 } });

/** 抓包 §2 里 7/7 档那一行的原文形状（关键几格）。 */
const RAW_CLAIM_ROW = {
  id: 434,
  marketname: 'sign_in_3',
  groupid: 'month',
  enable: 1,
  name: "分享文件领好礼<span id='share_title'>7/7</span>",
  description: '5豆*7+20豆',
  button: { app: { text: '领20豆', action: 'receiveCloud' } },
  state: 'WAIT',
  currstep: 22,
  process: 0,
  limitType: 'MONTH',
};

/** 造一份**已经解析过**的矩阵读数（跟 runAppTaskMatrix 落盘的形状一致）。 */
function storeWith(items: unknown[]): ReturnType<typeof memStore> {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: 'c=1', jwt: 'J', savedAt: NOW }), NOW);
  store.setState(
    matrixKey(MATRIX_MARKETS[0]!),
    JSON.stringify({ group: MATRIX_MARKETS[0], at: NOW, done: 0, todo: items.length, skip: 0, todoNames: [], items }),
    NOW,
  );
  return store;
}

function mkDeps(store: ReturnType<typeof memStore>, reply: (req: BuiltRequest) => { status: number; body: string }) {
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const r = reply(req);
    return { headers: {}, ...r };
  }) as never;
  const deps = {
    store,
    transport,
    nowIso: NOW,
    nowMs: () => Date.parse(NOW),
    settleMs: 0,
    gapMs: [0, 0],
  } as TaskDeps;
  return { deps, sent };
}

// ── ① 判据（纯函数，零 IO） ────────────────────────────────────────────

test('判据：currstep=22 与「领20豆」都认，攒份数那档不认', () => {
  const parsed = parseMatrixItem(RAW_CLAIM_ROW)!;
  assert.equal(parsed.taskId, 434);
  assert.equal(parsed.currStep, SPECIAL_CLICK_STEP);
  assert.equal(parsed.buttonOutText, '领20豆');
  assert.equal(isShareClaim(parsed), true, '抓包那一档要认出来');

  assert.equal(isShareClaim({ taskId: 434, currStep: 22 }), true, '结构常量兜底');
  assert.equal(isShareClaim({ taskId: 434, buttonOutText: '领20豆' }), true, '文案兜底');
  assert.equal(isShareClaim({ taskId: 434, buttonOutText: '领 5 豆' }), true);
  assert.equal(
    isShareClaim({ taskId: 434, currStep: 3, buttonOutText: '已完成' }),
    false,
    '还在攒份数（1/7~6/7）时不认',
  );
  assert.equal(isShareClaim({ taskId: 106, currStep: 22 }), false, '只对 434 生效');
  assert.equal(isShareClaim({}), false, '字段不全不猜');
  assert.equal(SHARE_TASK_ID, 434);
});

// ── ② 到账豆数只认 result.num ──────────────────────────────────────────

test('claimedBeans 只认 result.num（数字串也认，缺了/0 不算）', () => {
  assert.equal(claimedBeans(parseSignInEnvelope(OK_20)), 20);
  assert.equal(claimedBeans(parseSignInEnvelope('{"code":0,"result":{"num":"7"}}')), 7);
  assert.equal(claimedBeans(parseSignInEnvelope('{"code":0,"result":{}}')), undefined);
  assert.equal(claimedBeans(parseSignInEnvelope('{"code":0,"result":{"num":0}}')), 0);
  assert.equal(claimedBeans(parseSignInEnvelope('{"code":0,"result":null}')), undefined);
});

// ── ③ 没有领奖档 / 幂等 ────────────────────────────────────────────────

test('没攒到领奖档 ⇒ 不发请求', () => {
  const row = parseMatrixItem({ ...RAW_CLAIM_ROW, currstep: 3, button: { app: { text: '已完成' } } });
  const store = storeWith([row]);
  const { deps, sent } = mkDeps(store, () => ({ status: 200, body: OK_20 }));
  const r = runShareClaim(deps);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(sent.length, 0, '一枪都不该发');
});

test('领奖档 ⇒ 只发一发 task/click?key=task&id=434，回 num=20 才算到账', () => {
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const { deps, sent } = mkDeps(store, () => ({ status: 200, body: OK_20 }));
  const r = runShareClaim(deps);
  assert.equal(r.ok, true, r.note);
  assert.match(r.note, /领到 20 豆/);
  assert.equal(sent.length, 1, '只有那一发');
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[0]!.url, CLICK_URL);
  assert.equal(store.getState(STATE_SHARE_CLAIM_DONE), MONTH, '本月记下');
});

test('同一个月领过 ⇒ 整月不再发（task/click 不可回滚）', () => {
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const { deps, sent } = mkDeps(store, () => ({ status: 200, body: OK_20 }));
  runShareClaim(deps);
  const again = runShareClaim(deps);
  assert.equal(again.ok, true);
  assert.equal(again.skipped, true);
  assert.match(again.note, /已经领过/);
  assert.equal(sent.length, 1, '第二趟一枪都不发');
});

test('换了月份 ⇒ 可以再领', () => {
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const { deps, sent } = mkDeps(store, () => ({ status: 200, body: OK_20 }));
  runShareClaim(deps);
  const later = { ...deps, nowIso: '2026-12-01T04:00:00.000Z' } as TaskDeps;
  const r = runShareClaim(later);
  assert.equal(r.ok, true, r.note);
  assert.equal(sent.length, 2);
});

// ── ④ 服务端没认 ⇒ 不伪造成功、不记幂等（下一趟能重试） ────────────────

for (const [name, body] of [
  ['code 非 0', '{"code":11029,"msg":"活动太火爆了","result":{"num":20}}'],
  ['缺 num', '{"code":0,"msg":"success","result":{"taskId":434}}'],
  ['num=0', '{"code":0,"msg":"success","result":{"num":0}}'],
  ['回包不是 JSON', '<html>网关</html>'],
] as const) {
  test(`服务端没认（${name}）⇒ 不记幂等`, () => {
    const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
    const { deps } = mkDeps(store, () => ({ status: 200, body }));
    const r = runShareClaim(deps);
    assert.equal(r.ok, false, r.note);
    assert.match(r.note, /没认|认不出来/);
    assert.notEqual(store.getState(STATE_SHARE_CLAIM_DONE), MONTH, '绝不写幂等');
  });
}

test('请求都没发出去 ⇒ 不记幂等', () => {
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { error: '网络断了' };
  }) as never;
  const deps = { store, transport, nowIso: NOW, nowMs: () => Date.parse(NOW), settleMs: 0, gapMs: [0, 0] } as TaskDeps;
  const r = runShareClaim(deps);
  assert.equal(r.ok, false);
  assert.match(r.note, /没发出去/);
  assert.notEqual(store.getState(STATE_SHARE_CLAIM_DONE), MONTH);
});

// ── ⑤ 领奖档不许进 appTask 的分享状态机 ────────────────────────────────

test('领奖档被 pendingItems 排除（不再传文件/建外链）', () => {
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const deps = { store, transport: (() => ({ status: 200, headers: {}, body: '{}' })) as never, nowIso: NOW, settleMs: 0, gapMs: [0, 0] } as TaskDeps;
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [], '434 领奖档不该被挑成分享待办');
});

test('还在攒份数的 434 照样是分享待办（别把正常那一档也挡掉）', () => {
  const row = parseMatrixItem({ ...RAW_CLAIM_ROW, currstep: 3, button: { app: { text: '去完成' } } });
  const store = storeWith([row]);
  const deps = { store, transport: (() => ({ status: 200, headers: {}, body: '{}' })) as never, nowIso: NOW, settleMs: 0, gapMs: [0, 0] } as TaskDeps;
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [434]);
});

// ── ⑥ 日常链真的接上了（runDaily 全链） ────────────────────────────────

test('runDaily 有「分享领奖」这一步，且领奖档真发出那一发', async () => {
  const { runDaily } = await import('../src/mcloud/dailyRun.ts');
  const store = storeWith([parseMatrixItem(RAW_CLAIM_ROW)]);
  const sent: BuiltRequest[] = [];
  // 对「领20豆」那一发给 num=20；其余一律回「未登录」让整趟快速走完。
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return {
      headers: {},
      status: 200,
      body: req.url === CLICK_URL ? OK_20 : JSON.stringify({ code: 90001, msg: '未登录' }),
    };
  }) as never;
  const deps = {
    store,
    transport,
    nowIso: NOW,
    nowMs: () => Date.parse(NOW),
    settleMs: 0,
    gapMs: [0, 0],
  } as TaskDeps;

  const r = runDaily(deps);
  assert.ok(r.steps.some((s) => s.name === '分享领奖'), r.steps.map((s) => s.name).join(' → '));
  const claimHits = sent.filter((q) => q.url === CLICK_URL);
  assert.equal(claimHits.length, 1, `领奖那一发恰好一次，实际 ${claimHits.length}`);
  assert.ok(r.detail.some((l) => l.includes('领到 20 豆')), r.detail.join('\n'));
});
