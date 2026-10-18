// `drain` 的测试 —— 「一次一步」→「一个函数从头跑到尾」的那个核心原语。
//
// # 为什么它值得单独一组测试
//
// 它是整个重写的支点：25 条任务能合成 3 条，全靠「一次触发里把状态机跑到走完」。
// 而它最容易错的地方**不是**循环本身，是**「什么时候算走完」**——
// 老的状态机不统一地表达这件事（有的用 `idle`、有的用 `skipped`、有的什么都不给），
// 判错的表现是「任务看着成功、其实只做了一半」。
//
// 最要命的那一条是**签到**：三段式「问状态 → 提交 → 回查」，
// 而**回查那一句才是成败判据**（动作响应会撒谎，见 sign.ts 文件头）。
// 如果只调一次：签到被提交出去、回查永远不跑，而 `runSign` 提交完返回 `ok: true`
// ⇒ 整趟被判成功 ⇒ 落「今天已完成」标记 ⇒ 回查**再也**不发生。
//
// 这个 bug 是重写时差点漏掉的（老的「一次一步 + 每 15 分钟」结构恰好绕开了它），
// 所以这里有一条测试专门钉住它。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drain } from '../src/drain.ts';
import { memStore } from '../src/store/memory.ts';
import type { Store } from '../src/store/types.ts';
import type { TaskDeps, TaskOutcome } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-15T01:00:00.000Z';

function deps(store: Store = memStore()): TaskDeps {
  return { store, transport: () => ({ status: 200, headers: {}, body: '{}' }), nowIso: NOW };
}

const OPTS = { label: '测试', maxSteps: 10, deadlineMs: 60_000 };

// ── 三个出口 ──────────────────────────────────────────────────────────

test('出口 ①：`idle` ⇒ 停下，步数记对', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    { ...OPTS, maxSteps: 10 },
  );
  // 没有 idle / skipped ⇒ 一直跑到步数上限
  assert.equal(r.steps, 10);
  assert.equal(r.ok, true);
  assert.equal(r.idle, false, '碰到步数上限不该报 idle —— 那是「还没走完」');
  // 到上限不说「没做完」（那是假话：刚好做完也长这样）；步数照样记对
  assert.ok(r.note.length > 0, '停下时也要有一句结论');
});

test('出口 ①：`idle` 立刻停下（App 任务做完一条就报 idle）', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return n >= 3 ? { ok: true, note: '走完了', idle: true } : { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    OPTS,
  );
  assert.equal(r.steps, 3);
  assert.equal(r.idle, true);
  assert.match(r.note, /走完/);
});

test('出口 ②：`skipped` 也停下（receive / notice / backupGift 用它说「条件不成立」）', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return n >= 2
        ? { ok: true, note: '没有待领取的东西', skipped: true }
        : { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    OPTS,
  );
  assert.equal(r.steps, 2, 'skipped 之后不该再调');
  assert.equal(r.idle, true, 'skipped 对 drain 来说也是「不用继续」');
});

// ── 那条差点漏掉的：签到三段式 ─────────────────────────────────────────

test('⚠ 签到三段式：只调一次 ⇒ 提交了但回查不跑（这就是那个 bug）', () => {
  const store = memStore();
  const STAGE = 'mcloud.sign.stage';
  let calls = 0;

  // 照 sign.ts 的真实行为写：① 问状态（未签）→ ② 提交并落 stage；③ 回查并清 stage
  const runSign = (_d: TaskDeps): TaskOutcome => {
    calls++;
    if (store.getState(STAGE) === 'need-verify') {
      store.setState(STAGE, '', NOW);
      return { ok: true, note: '签到完成（回查 infoV3 确认今日已签）' };
    }
    store.setState(STAGE, 'need-verify', NOW);
    // ⚠ 提交完返回的是 ok —— 这就是「看着成功、其实只做了一半」的来源
    return { ok: true, note: '签到已提交（下次触发回查状态）' };
  };

  // 只调一次：提交了，回查没跑，而返回值是 ok
  const one = runSign(deps(store));
  assert.equal(one.ok, true);
  assert.equal(calls, 1);
  assert.equal(store.getState(STAGE), 'need-verify', '状态还停在「待回查」');

  // drain + more：跑到状态里没有未完成的段为止
  const store2 = memStore();
  let calls2 = 0;
  const runSign2 = (_d: TaskDeps): TaskOutcome => {
    calls2++;
    if (store2.getState(STAGE) === 'need-verify') {
      store2.setState(STAGE, '', NOW);
      return { ok: true, note: '签到完成（回查确认）' };
    }
    store2.setState(STAGE, 'need-verify', NOW);
    return { ok: true, note: '签到已提交' };
  };
  const r = drain(runSign2, deps(store2), {
    ...OPTS,
    label: '签到',
    more: () => (store2.getState(STAGE) ?? '') === 'need-verify',
  });
  assert.equal(calls2, 2, '必须跑两趟：提交 + 回查');
  assert.equal(store2.getState(STAGE), '', '状态清干净了');
  assert.match(r.note, /回查/);
});

test('`more()` 为 false 时**仍然先跑一次**（总得先跑一次才知道要干嘛）', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return { ok: true, note: '今日已签到' };
    },
    deps(),
    { ...OPTS, more: () => false },
  );
  assert.equal(n, 1, '一次都不跑的话，「今天要不要签到」永远判不出来');
  assert.equal(r.steps, 1);
  assert.equal(r.idle, true);
});

test('`more()` 一直在 true 时由 `maxSteps` 兜住（上游可能一直冒新待办）', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    { ...OPTS, maxSteps: 4, more: () => true },
  );
  assert.equal(n, 4);
  assert.equal(r.idle, false);
  // 到上限不说「没做完」（那是假话：刚好做完也长这样）；步数照样记对
  assert.ok(r.note.length > 0, '停下时也要有一句结论');
});

// ── 失败与上限 ────────────────────────────────────────────────────────

test('某一步报错 ⇒ **立刻停**，说清是第几步', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      return n === 3 ? { ok: false, note: '上游 500' } : { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    OPTS,
  );
  assert.equal(r.ok, false);
  assert.equal(r.steps, 3, '失败那一步也算跑过了');
  assert.equal(n, 3, '失败之后不该再调');
  assert.match(r.note, /第 3 步失败/);
  assert.match(r.note, /上游 500/);
});

test('某一步抛异常 ⇒ 也停，而且异常信息带得上步骤', () => {
  let n = 0;
  const r = drain(
    () => {
      n++;
      if (n === 2) throw new Error('boom');
      return { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    OPTS,
  );
  assert.equal(r.ok, false);
  assert.equal(n, 2);
  assert.match(r.note, /第 2 步抛异常/);
  assert.ok(
    r.notes.some((x) => x.includes('boom')),
    `异常原文要留在 notes 里：${JSON.stringify(r.notes)}`,
  );
});

test('时间上限 ⇒ **主动收手**（不是被看门狗掐断），并且说得出「还差多少」', () => {
  const t0 = Date.now();
  let n = 0;
  const r = drain(
    () => {
      n++;
      // 每步假装花 30ms，deadline 设 50ms ⇒ 第二步之后就该收手
      while (Date.now() - t0 < n * 30) {
        /* 空转 */
      }
      return { ok: true, note: `第 ${n} 步` };
    },
    deps(),
    { ...OPTS, maxSteps: 100, deadlineMs: 50, startedAt: t0 },
  );
  assert.equal(r.ok, true, '主动收手是**成功**，不是失败 —— 下一次触发接着走');
  assert.equal(r.idle, false);
  assert.ok(n < 100, `该在时间上限收手，实际跑了 ${n} 步`);
  assert.match(r.note, /时间上限/);
  assert.match(r.note, /下一次接着走/);
});

test('`startedAt` 能接着上一段的计时（一条链里多个 drain 共享预算）', () => {
  const t0 = Date.now() - 10_000; // 假装这一段之前已经花了 10 秒
  const r = drain(() => ({ ok: true, note: 'x' }), deps(), {
    ...OPTS,
    maxSteps: 100,
    deadlineMs: 5_000, // 5 秒 < 已花的 10 秒 ⇒ 一轮都不该跑
    startedAt: t0,
  });
  assert.equal(r.steps, 0);
  assert.match(r.note, /时间上限/);
});

// ── 摘要的形状 ────────────────────────────────────────────────────────

test('`notes` 收齐每一步的原话（出问题时「走到哪一步」最要紧）', () => {
  const r = drain(
    (_d, ) => ({ ok: true, note: 'a' }),
    deps(),
    { ...OPTS, maxSteps: 3, more: () => true },
  );
  assert.equal(r.notes.length, 3);
  assert.deepEqual(r.notes, ['a', 'a', 'a']);
});

test('`note` 是一行摘要 —— 进 runs 表，不该是一大段', () => {
  const r = drain(() => ({ ok: true, note: '很长的原话'.repeat(50) }), deps(), {
    ...OPTS,
    maxSteps: 1,
    more: () => false,
  });
  assert.ok(r.note.length < 120, `摘要太长了（${r.note.length} 字）：${r.note}`);
  // 允许留**最后一步**那句话（它是具体的结论），但不许把每一步的原话都拼进来
  assert.ok(!r.note.includes('很长的原话'.repeat(3)), '摘要不该把每步原话拼进去');
});
