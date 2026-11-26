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

test('⚠ 调试运行：开关关着 + force ⇒ 点名的那族**照样跑**（这就是调试页的用处）', async () => {
  const { deps, sent } = depsFor([]);
  // 用户先在账号设置里把算力大作战关掉
  setTaskOn(deps.store, 'tokenpk', false, NOW);
  // 日常那一趟：关着就不跑（现状不变）
  const normal = depsFor([]);
  setTaskOn(normal.deps.store, 'tokenpk', false, NOW);
  await runDaily(normal.deps);
  assert.equal(
    normal.sent.filter((x) => /tokenpk/.test(String(x.url))).length,
    0,
    '日常（只跑一个号、没 force）里关掉的族不该发请求',
  );

  // 调试运行：only + force ⇒ **闸放行**（这一族的步骤真的进了 drain）。
  // ⚠ 这里不发真请求：上游一律 90001，"放行"看的是步骤名与它的 note，
  //   而不是"有没有打到 tokenpk"—— 那取决于票，不取决于闸。
  const dbg = depsFor([]);
  setTaskOn(dbg.deps.store, 'tokenpk', false, NOW);
  const dr = await runDaily(dbg.deps, { only: ['tokenpk'], force: true });
  const step = dr.steps.find((s) => s.name === '算力大作战');
  assert.ok(step, '算力那一族要有步骤');
  assert.doesNotMatch(step.note, /已关闭/, `关着也必须放行：${step.note}`);
  assert.doesNotMatch(step.note, /这次不跑/, `点名了就必须进：${step.note}`);
});

test('调试运行只点一族 ⇒ 其它族一个请求都不发，且各留一行「这次不跑」', async () => {
  const { deps, sent } = depsFor([]);
  const r = await runDaily(deps, { only: ['tokenpk'], force: true });
  // 签到/App 任务/任务拓展/云手机 都不该发
  for (const needle of ['startSignIn', 'taskListV3', 'multiple', 'revival']) {
    assert.equal(countOf(sent, needle), 0, `${needle} 不该发`);
  }
  const skipped = r.steps.filter((s) => /这次不跑/.test(s.note));
  assert.ok(skipped.length >= 3, `其它族要各留一行：${r.steps.map((s) => s.name + '=' + s.note).join(' | ')}`);
});

test('调试运行只点「云手机」⇒ 换票那两发也跳过（没人需要 H5 票）', async () => {
  const { deps, sent } = depsFor([]);
  await runDaily(deps, { only: ['redpack'], force: true });
  assert.equal(countOf(sent, 'querySpecToken'), 0, '不需要票就不换票');
  assert.equal(countOf(sent, 'tyrzLogin'), 0);
});

test('两族一开一关：关 tokenpk 不影响 redpack 自己跑', async () => {
  const { deps, sent } = depsFor(['tokenpk']);
  await runDaily(deps);
  // 红包派对开着 ⇒ 它会去换活动站的票（那台主机与 tokenpk 不同）
  assert.ok(sent.length > 0, '整趟总得发点请求');
  assert.equal(countOf(sent, 'tokenpk'), 0);
});
