// 任务之间的**间隔**（2026-11-02 用户口径：每条之间至少 500ms、最多 2000ms 随机）。
//
// 这一层测的是三件事，缺一件就会退化成"看着有间隔、其实没有"：
//   ① appTask 换条时真的等了，而且等的是**随机**区间（不是写死）
//   ② 同一条任务内部的步骤**不**等（否则 60 秒预算会被白白吃掉）
//   ③ `waitMs` 在**注入的假钟不走**时不能死循环（真机上 Date.now() 一定动，
//      但测试和沙箱里不一定 —— 这里就是"防御"，不是"假设不会发生"）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drain } from '../src/drain.ts';
import { waitMs, gapDelayMs, waitGap, DEFAULT_GAP_MS } from '../src/mcloud/tasks/base.ts';
import { matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { runAppTaskStep, startAppTask } from '../src/mcloud/tasks/appTask.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-11-02T02:00:00.000Z';

/** 假钟：只有 `spin` 会把时间往前推（这样 `waitMs` 走的是真逻辑，但快得飞起）。 */
function clock(stepMs = 100) {
  const t = { ms: Date.parse(NOW) };
  return { t, nowMs: () => t.ms, spin: () => void (t.ms += stepMs) };
}

function depsWith(gapMs: [number, number] | undefined, c = clock()): { deps: TaskDeps; sent: BuiltRequest[]; t: { ms: number } } {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  store.setState('mcloud.h5.auth', 'Basic cGM6MTM4MDAxMzgwMDA6dG9r', NOW);
  const items = [
    { taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' },
    { taskId: 1009, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '小云互动礼' },
  ];
  store.setState(
    matrixKey('sign_in_3'),
    JSON.stringify({ group: 'sign_in_3', at: NOW, done: 0, todo: items.length, skip: 0, todoNames: [], items }),
    NOW,
  );
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    if (req.url.includes('task/click')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
  }) as never;
  const deps = {
    store,
    transport,
    nowIso: NOW,
    baseUrl: undefined,
    settleMs: 0,
    nowMs: c.nowMs,
    spin: c.spin,
    ...(gapMs === undefined ? {} : { gapMs }),
  } as TaskDeps;
  return { deps, sent, t: c.t };
}

test('appTask：换条时随机等 500–2000ms（并且真的动了时钟）', () => {
  const { deps, t } = depsWith([500, 2000]);
  startAppTask(deps);
  const before = t.ms;
  let note = '';
  for (let i = 0; i < 20; i += 1) {
    const out = runAppTaskStep(deps);
    if (/下一条 #/.test(out.note)) {
      note = out.note;
      break;
    }
    if (out.idle) break;
  }
  assert.match(note, /下一条 #\d+/, `没走到换条：${note}`);
  const m = /隔了 (\d+)ms/.exec(note);
  assert.ok(m !== null, `换条的日志里要写清隔了多久：${note}`);
  const waited = Number(m[1]);
  assert.ok(waited >= 500 && waited <= 2000, `间隔要在 500–2000ms，实际 ${waited}`);
  assert.equal(t.ms - before >= waited, true, '说等了多少就要真的走过去多少');
});

test('appTask：`gapMs: [0,0]` 时不等（测试/手动场景）', () => {
  const { deps, t } = depsWith([0, 0]);
  startAppTask(deps);
  const before = t.ms;
  let note = '';
  for (let i = 0; i < 20; i += 1) {
    const out = runAppTaskStep(deps);
    if (/下一条 #/.test(out.note)) {
      note = out.note;
      break;
    }
    if (out.idle) break;
  }
  assert.match(note, /下一条 #/);
  assert.equal(/隔了/.test(note), false, `关掉间隔就不该写「隔了」：${note}`);
  assert.equal(t.ms, before, '一点都没等');
});

test('缺省（不传 `gapMs`）= **默认就隔**，不是"不等"', () => {
  const { deps } = depsWith(undefined);
  // 不传 gapMs ⇒ 走 DEFAULT_GAP_MS
  const ms = gapDelayMs(deps);
  assert.ok(ms >= DEFAULT_GAP_MS[0] && ms <= DEFAULT_GAP_MS[1], `默认区间 500–2000，实际 ${ms}`);
});

test('drain：`gap: true` 时步与步之间等，`gap` 不开就一步不等', () => {
  const rows: Array<{ gap: boolean | undefined; waited: number }> = [];
  for (const gap of [true, false, undefined]) {
    const c = clock();
    const { deps } = depsWith([500, 2000], c);
    const start = c.t.ms;
    let n = 0;
    drain(
      () => {
        n += 1;
        return { ok: true, note: `第 ${n} 步`, idle: n >= 3 };
      },
      deps,
      { label: 'x', maxSteps: 5, deadlineMs: 10_000, ...(gap === undefined ? {} : { gap }) },
    );
    rows.push({ gap, waited: c.t.ms - start });
  }
  const [on, off, unset] = rows;
  assert.ok(on!.waited >= 1000, `gap:true 三步该等约 1000ms+，实际 ${on!.waited}`);
  assert.equal(off!.waited, 0, 'gap:false 一点不等');
  assert.equal(unset!.waited, 0, '不写 gap 就按老行为（不等）');
});

test('⚠ `waitMs` 遇到**不走的钟**不能死循环', () => {
  const deps = { nowIso: NOW, nowMs: () => 1000 } as TaskDeps; // 永远 1000
  const t0 = Date.now();
  waitMs(deps, 5000);
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `假钟不走时要立刻撤（实际卡了 ${cost}ms）`);
});

test('`waitGap` 走假钟时等满再返回，返回的就是等掉的时长', () => {
  const c = clock(50);
  const { deps } = depsWith([500, 2000], c);
  const before = c.t.ms;
  const waited = waitGap(deps);
  assert.ok(waited >= 500 && waited <= 2000);
  assert.ok(c.t.ms - before >= waited - 50, `时钟要走够（差 ${c.t.ms - before - waited}ms）`);
});

test('同一条任务内部的连发也要隔（1005 固定入口：三枪）', () => {
  const c = clock(100);
  const { deps } = depsWith([500, 2000], c);
  // 换成 1005（`entry` 那一族：doTaskPost → page/doTask → 补打卡）
  deps.store.setState(
    matrixKey('sign_in_3'),
    JSON.stringify({
      group: 'sign_in_3',
      at: NOW,
      done: 0,
      todo: 1,
      skip: 0,
      todoNames: [],
      items: [{ taskId: 1005, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '从固定入口进入云朵中心' }],
    }),
    NOW,
  );
  const hits: Array<{ at: number; url: string }> = [];
  const inner = deps.transport as unknown as (r: BuiltRequest) => unknown;
  (deps as { transport: unknown }).transport = (r: BuiltRequest) => {
    hits.push({ at: c.t.ms, url: r.url });
    return inner(r);
  };
  startAppTask(deps);
  for (let i = 0; i < 20; i += 1) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  // 只看 `entry` 阶段自己的那两枪（`doTask` 系列）——前面 `click` 阶段的打卡+访问日志
  // 是另一段（那一段本来就连着打，属于"一条任务的第一步"）。
  const entryHits = hits.filter((h) => h.url.includes('doTask'));
  assert.ok(entryHits.length >= 2, `entry 阶段至少要打两枪：${hits.map((h) => h.url).join(' ')}`);
  const gap = entryHits[1]!.at - entryHits[0]!.at;
  assert.ok(gap >= 500, `同一阶段的两枪只隔了 ${gap}ms（要 ≥500）`);
});
