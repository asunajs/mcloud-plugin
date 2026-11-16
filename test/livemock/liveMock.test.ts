// livemock 驱动的直播链路测试 —— 用**可编排的报文**跑完整一轮，几秒出结论。
//
// 这里钉住的都是 2026-11-16 现场出过事的形状：
//   · 完整一轮：6 步齐全、进账 = ⑥ − ①（不是把各口令的 num 加起来）
//   · 口令没变且都是这个号领过的 ⇒ **一个请求都不发**，而且不许把上一轮的结果
//     当成这一轮的成绩播出来（12 毫秒里"三个号各领到 X 朵"就是这么来的）
//   · `drain` 只剩步数护栏：`maxSteps` 走满且还有活没干完 ⇒ **不算成功**

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveMock } from './liveMock.ts';
import { drain } from '../../src/drain.ts';
import { runLiveDraw, loadDrawState, STATE_DRAW } from '../../src/mcloud/tasks/liveDraw.ts';
import { STATE_CODES } from '../../src/mcloud/tasks/liveRoom.ts';
import { SESSION_KEY } from '../../src/store/types.ts';
import { memStore } from '../../src/store/memory.ts';
import type { TaskDeps } from '../../src/mcloud/tasks/base.ts';

const NOW = '2026-11-16T03:59:13.000Z';
const LATER = '2026-11-16T03:59:48.000Z';
const SESSION = { cookie: 'c=1', jwt: 'JWT-1', deviceId: 'dev-1', savedAt: NOW };

function seeded(codes: string[]): ReturnType<typeof memStore> {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  store.setState(
    STATE_CODES,
    JSON.stringify({ at: NOW, codes, raw: codes.join('\n'), how: 'livemock' }),
    NOW,
  );
  return store;
}

function depsOf(
  store: ReturnType<typeof memStore>,
  transport: unknown,
  nowIso = NOW,
): TaskDeps {
  return {
    store,
    transport,
    nowIso,
    nowMs: () => Date.parse(nowIso),
    settleMs: 0,
    gapMs: [0, 0],
  } as TaskDeps;
}

/** 把一轮跑到 `draw` 步骤全走完（drain 到 idle）。 */
async function runRound(deps: TaskDeps, maxSteps = 40) {
  return drain((d) => runLiveDraw(d), deps, { label: '领小红花', maxSteps });
}

test('完整一轮：6 步齐全，进账 = ⑥ − ①', async () => {
  const store = seeded(['百万福利宠会员']);
  const mock = createLiveMock({ flowerStart: 65, draws: [{ kind: 'ok', flowerNum: 10 }] });
  const r = await runRound(depsOf(store, mock.transport));

  assert.equal(r.ok, true, r.note);
  assert.equal(mock.drawCodes().join(','), '百万福利宠会员', '这条口令只领一次');
  assert.equal(mock.balance(), 75, '余额 65 → 75');

  const st = loadDrawState(store)!;
  assert.equal(st.step, 'done');
  assert.equal(st.balanceBefore, 65);
  assert.equal(st.balanceAfter, 75);
  assert.match(st.summary ?? '', /进账 10 朵（65 → 75）/);

  // 六步都发到了：① 余额 ② 埋点×5 ③ 惊喜奖 ④ 领取 ⑤ 复活花 ⑥ 余额
  const kinds = mock.calls.map((c) => c.path.split('?')[0]!);
  assert.equal(kinds.filter((k) => k.endsWith('/user/info')).length, 2, '①⑥ 各一发');
  assert.equal(kinds.filter((k) => k.endsWith('/visitlog/journaling')).length, 5, '② 五发埋点');
  assert.equal(kinds.filter((k) => k.includes('firstParticipate/give')).length, 1, '③ 一发');
  assert.equal(kinds.filter((k) => k.includes('/redFlower/draw')).length, 1, '④ 一发');
  assert.equal(kinds.filter((k) => k.includes('queryRevivalFlowers')).length, 1, '⑤ 一发');
});

test('口令没变且都领过 ⇒ 一个请求都不发（重复触发不许重复领）', async () => {
  const store = seeded(['百万福利宠会员']);
  const mock = createLiveMock({ flowerStart: 65, draws: [{ kind: 'ok', flowerNum: 10 }] });
  await runRound(depsOf(store, mock.transport));
  const firstCalls = mock.calls.length;

  // 12 秒后又触发一次（现场是 cron 又跳了一次）
  const again = await runRound(depsOf(store, mock.transport, LATER));
  assert.equal(again.ok, true);
  assert.equal(mock.calls.length, firstCalls, '第二轮一个请求都不许再发');
  assert.match(again.note, /没再发请求|已跑完|没有口令/, `第二轮的原话：${again.note}`);
});

test('已兑换过（200112）⇒ 如实说"已领过"，不写成领到', async () => {
  const store = seeded(['旧口令']);
  const mock = createLiveMock({ flowerStart: 65, draws: [{ kind: 'already' }] });
  const r = await runRound(depsOf(store, mock.transport));
  assert.equal(r.ok, true, r.note);
  assert.match(r.note, /已领|已兑换|领过/, `原话：${r.note}`);
  assert.equal(mock.balance(), 65, '没进账');
});

test('http 500 ⇒ 这一轮判失败，不许报成功', async () => {
  const store = seeded(['百万福利宠会员']);
  const mock = createLiveMock({ flowerStart: 65, draws: [{ kind: 'http-error', httpStatus: 500 }] });
  const r = await runRound(depsOf(store, mock.transport));
  assert.equal(r.ok, false, `原话：${r.note}`);
});

test('drain：步数没走满就按 idle 收尾；不存在"时间上限"这一档', async () => {
  const store = seeded([]);
  const mock = createLiveMock({ flowerStart: 10 });
  const r = await drain(() => ({ ok: true, idle: false, note: '一步' }), depsOf(store, mock.transport), {
    label: '测试',
    maxSteps: 3,
  });
  assert.equal(r.steps, 3);
  assert.equal(r.ok, true, '没有时间闸：走满步数就停，不冒充"走到时间上限"');
  assert.doesNotMatch(r.note, /时间上限/);
});

test('drain：走满 maxSteps 且 more() 仍说还有 ⇒ 不算成功', async () => {
  const store = seeded([]);
  const mock = createLiveMock({ flowerStart: 10 });
  const r = await drain(() => ({ ok: true, idle: false, note: '一步' }), depsOf(store, mock.transport), {
    label: '测试',
    maxSteps: 2,
    more: () => true,
  });
  assert.equal(r.steps, 2);
  assert.equal(r.ok, false, '没走完就是没走完，不许绿灯');
  assert.match(r.note, /还没完|没走完/);
});

test('状态里没有"上一轮 results"被当成这一轮：第二轮 notes 不含"领到"', async () => {
  const store = seeded(['百万福利宠会员']);
  const mock = createLiveMock({ flowerStart: 65, draws: [{ kind: 'ok', flowerNum: 10 }] });
  await runRound(depsOf(store, mock.transport));
  const second = await runRound(depsOf(store, mock.transport, LATER));
  const st = loadDrawState(store)!;
  // 第二轮结束时，状态里仍是**第一轮**的结果（这是缓存，不是新一轮的战果）——
  // 所以判"本轮到底有没有做事"必须看有没有真发请求，不能看 results。
  assert.equal(st.results.length, 1);
  assert.ok(second.notes.every((n) => !/领到 \d+ 朵/.test(n)), `第二轮的每句原话：${second.notes.join(' | ')}`);
  assert.notEqual(store.getState(STATE_DRAW), null);
});
