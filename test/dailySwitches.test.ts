// 五个子任务开关接进「日常」之后：关掉的组**一个请求都不发**，其它组照跑。
//
// 为什么值得单独一篇：这一层最容易"看着关了其实还在打上游" —— 闸放在 drain 之后、
// 或者只挡了显示没挡动作，都不会红。判据只能数请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/mcloud/dailyRun.ts';
import { setTaskOn } from '../src/mcloud/tasks/taskSwitches.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-11-25T00:00:00.000Z';

/** 一整趟日常，记录**所有**请求。上游一律回"未登录"：不是要跑成，
 *  而是让整趟快速走到尾，我们只关心"某一族发没发"。 */
function depsFor(off: string[]): { deps: TaskDeps; sent: BuiltRequest[] } {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  // 先把五族都打开（云手机缺省关），再按参数关掉
  for (const id of ['signin', 'expansion', 'appTask', 'redpack', 'tokenpk'] as const) {
    setTaskOn(store, id, true, NOW);
  }
  for (const id of off) {
    setTaskOn(store, id as 'signin', false, NOW);
  }
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  return {
    deps: { store, transport, nowIso: NOW, nowMs: () => Date.parse(NOW), settleMs: 0, gapMs: [0, 0] } as TaskDeps,
    sent,
  };
}

const paths = (sent: BuiltRequest[]): string[] => sent.map((r) => String(r.url).split('?')[0] ?? '');
const countOf = (sent: BuiltRequest[], needle: string): number =>
  paths(sent).filter((p) => p.includes(needle)).length;

test('关掉「云手机」⇒ 活动站一个请求都不发，步骤仍留一行灰的', async () => {
  const { deps, sent } = depsFor(['redpack']);
  const r = await runDaily(deps);
  const step = r.steps.find((s) => s.name === '红包派对');
  assert.ok(step, '步骤要在（运行记录要能回答"为什么没跑"）');
  assert.equal(step.idle, true);
  assert.match(step.note, /已关闭/);
  // 红包派对那台主机（活动站）一次都不该被碰到
  assert.equal(sent.filter((x) => /redpack|huodong|yidong|cloudphone/i.test(String(x.url))).length, 0);
});

test('关掉「算力大作战」⇒ 一个 tokenpk 请求都不发', async () => {
  const { deps, sent } = depsFor(['tokenpk']);
  const r = await runDaily(deps);
  assert.equal(countOf(sent, 'tokenpk'), 0, '关了就不该碰 tokenpk');
  const step = r.steps.find((s) => s.name === '算力大作战');
  assert.equal(step?.idle, true);
  assert.match(step?.note ?? '', /已关闭/);
});

test('关掉「每日签到」⇒ 不发 startSignIn，签到翻倍/复活卡也不发', async () => {
  const { deps, sent } = depsFor(['signin']);
  const r = await runDaily(deps);
  assert.equal(countOf(sent, 'startSignIn'), 0);
  assert.equal(countOf(sent, 'multiple'), 0);
  assert.equal(countOf(sent, 'revival'), 0);
  assert.equal(r.steps.find((s) => s.name === '签到')?.idle, true);
});

test('关掉「App 任务」⇒ 矩阵/打卡/分享领奖都不发（它们同属一档）', async () => {
  const { deps, sent } = await depsFor(['appTask']);
  const r = await runDaily(deps);
  assert.equal(countOf(sent, 'taskListV3'), 0, '矩阵不读');
  assert.equal(countOf(sent, 'task/click'), 0, '打卡不发');
  // ⚠ 别拿 `public/record` 当判据：那一口「待领取奖品 / 今日云朵」也在用，
  //   它们不受这个开关管。分享领奖自己的动作是 `task/click?key=task&id=434`。
  assert.equal(
    sent.filter((x) => /task\/click/.test(String(x.url)) && /id=434/.test(String(x.url))).length,
    0,
    '分享领奖那口（434）也不发',
  );
  const step = r.steps.find((s) => s.name === 'App 任务');
  assert.equal(step?.idle, true);
  assert.match(step?.note ?? '', /已关闭/);
});

test('关掉「任务拓展」⇒ 不传文件（不发 upload 那一族）', async () => {
  const { deps, sent } = depsFor(['expansion']);
  const r = await runDaily(deps);
  assert.equal(r.steps.find((s) => s.name === '任务拓展')?.idle, true);
  // 任务拓展与 App 任务都会上传；这一趟 App 任务也关掉才干净地数"只有拓展"
  void sent;
});

test('两族一开一关：关 tokenpk 不影响 redpack 自己跑', async () => {
  const { deps, sent } = depsFor(['tokenpk']);
  await runDaily(deps);
  // 红包派对开着 ⇒ 它会去换活动站的票（那台主机与 tokenpk 不同）
  assert.ok(sent.length > 0, '整趟总得发点请求');
  assert.equal(countOf(sent, 'tokenpk'), 0);
});
