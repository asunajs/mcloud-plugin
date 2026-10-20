// 独立版的直播编排：自动听直播 → 收口令 → 逐账号领小红花。
//
// 这里的“听”走 wsBridge（同步），HTTP 走 curl；“领”复用 runLiveDraw。

import { drain } from '../drain.ts';
import { hostNativeTls, capNote } from '../mcloud/hostCap.ts';
import { KOULING_ANCHOR } from '../mcloud/koulingPool.ts';
import { loadPoolFrom, stopScraping, validCount } from '../mcloud/koulingPool.ts';
import {
  needExchange,
  loadExchange,
  runExchangeStep,
  startExchange,
  loadAuthRaw,
} from '../mcloud/sessionExchange.ts';
import { loadAccounts } from '../mcloud/accounts.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { runLiveGate, readGateReading } from '../mcloud/tasks/liveGateTask.ts';
import { runLiveRoom, STATE_CODES } from '../mcloud/tasks/liveRoom.ts';
import { runLiveListen, type ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { runLiveDraw, STATE_DRAW } from '../mcloud/tasks/liveDraw.ts';
import { userLine } from '../mcloud/tasks/stepLog.ts';
import type { TaskDeps, TaskOutcome } from '../mcloud/tasks/base.ts';
import type { Runtime } from './runtime.ts';

const LISTEN_BUDGET_MS = 300_000;

interface RunStep {
  name: string;
  ok: boolean;
  note: string;
  idle?: boolean | undefined;
}

/** 直播领花要先有 H5 会话；gate 只换直播 JWT，不写 mcloud.session。 */
function ensureSignInSession(deps: TaskDeps, label: string): boolean {
  if (!needExchange(deps.store, Date.now(), 'sign-in')) return true;
  const st = loadExchange(deps.store, 'sign-in');
  if (st === null || st.step === 'done') {
    const started = startExchange(deps.store, loadAuthRaw(deps.store), deps.nowIso, 'sign-in');
    if (!started.ok) {
      console.log(`[${label}] 换票：${started.error ?? '未知失败'}`);
      return false;
    }
  }
  const r = drain(
    (d) => {
      const x = runExchangeStep(d, 'sign-in');
      return { ok: x.ok, note: x.note, idle: x.done };
    },
    deps,
    { label: `${label} 换票`, maxSteps: 4, deadlineMs: 30_000, startedAt: Date.now() },
  );
  return r.ok;
}

function collectOnce(
  deps: ListenDeps,
  runStartMs: number,
  listenMs: number,
): { steps: RunStep[]; detail: string[]; ok: boolean; note: string; stopped: boolean } {
  const steps: RunStep[] = [];
  const step = (name: string, fn: () => TaskOutcome): TaskOutcome => {
    try {
      const r = fn();
      steps.push({ name, ok: r.ok, note: r.note, idle: r.idle === true });
      return r;
    } catch (e) {
      const note = `抛异常 ${e instanceof Error ? e.message : String(e)}`;
      steps.push({ name, ok: false, note, idle: false });
      return { ok: false, note };
    }
  };
  const done = (ok: boolean, note: string, stopped = false) => ({
    steps,
    detail: steps.map((s) => userLine(s)).filter((x): x is string => x !== null),
    ok,
    note,
    stopped,
  });

  const cap = hostNativeTls(deps.store, deps.nowIso, deps.transport);
  if (cap.verdict === 'no') {
    steps.push({ name: '这个环境能不能直播', ok: false, note: capNote(cap.verdict), idle: false });
    return done(false, capNote(cap.verdict), true);
  }

  const gateOut = drain(runLiveGate, deps, {
    label: '有没有开播',
    maxSteps: 3,
    deadlineMs: 40_000,
    startedAt: runStartMs,
  });
  const gate = readGateReading(deps.store);
  const liveCount = gate === null ? 0 : gate.liveCount;
  if (!gateOut.ok) {
    steps.push({ name: '有没有开播', ok: false, note: `${gateOut.note}（继续试一次）`, idle: false });
  } else if (gate === null || gate.active !== true) {
    steps.push({
      name: '有没有开播',
      ok: true,
      idle: true,
      note:
        liveCount === 0
          ? '今天没有直播（谁都没在播）'
          : `有 ${liveCount} 间在播，但没有一间是「${KOULING_ANCHOR}」的`,
    });
    return done(true, '没在播 —— 不听，也不看小红书', true);
  } else {
    steps.push({
      name: '有没有开播',
      ok: true,
      idle: false,
      note: `「${KOULING_ANCHOR}」开播了（${liveCount} 间在播）`,
    });
  }

  step('主播发口令没有', () => runLiveRoom(deps));
  const poolNow = loadPoolFrom(deps.store).pool;
  if (stopScraping(poolNow)) {
    steps.push({
      name: '听弹幕',
      ok: true,
      idle: true,
      note: `手里已经有 ${validCount(poolNow)} 条能用的口令，不用再听`,
    });
    return done(true, '口令够了，没再听');
  }

  let frames = 0;
  let listenNote = '';
  const deadline = runStartMs + listenMs;
  while (Date.now() < deadline) {
    const r = step('听弹幕', () => runLiveListen(deps));
    listenNote = r.note;
    if (!r.ok || r.idle) break;
    frames += 1;
    if (frames > 60) break;
  }
  if (frames > 0) {
    steps.push({ name: '听弹幕', ok: true, note: listenNote || `听了 ${frames} 轮`, idle: false });
  }
  const after = loadPoolFrom(deps.store).pool;
  return done(true, `池里现在有 ${validCount(after)} 条能用的口令`);
}

function drawFor(
  deps: TaskDeps,
  opts: { force: boolean; label: string },
): { ok: boolean; note: string; steps: RunStep[] } {
  const r = drain(runLiveDraw, deps, {
    label: opts.label,
    maxSteps: 12,
    deadlineMs: 60_000,
    startedAt: Date.now(),
  });
  return {
    ok: r.ok,
    note: r.note,
    steps: [{ name: '领小红花', ok: r.ok, note: r.note, idle: r.idle }],
  };
}

function accounts(rt: Runtime, only?: string): { id: string; label: string }[] {
  return loadAccounts(rt.rawStore)
    .filter((a) => a.disabled !== true)
    .filter((a) => only === undefined || a.id === only || a.label === only)
    .map((a) => ({ id: a.id, label: a.label }));
}

/** 自动听直播 + 领花。没开播时只判断一次，不逐账号刷屏。 */
export function autoDrawRedFlower(rt: Runtime): void {
  const all = accounts(rt);
  if (all.length === 0) {
    console.log('[直播] 没有启用账号');
    return;
  }
  const first = all[0]!;
  const collectDeps = rt.listenDepsFor(first.id);
  if (!ensureSignInSession(collectDeps, first.label)) return;
  const collected = collectOnce(collectDeps, Date.now(), LISTEN_BUDGET_MS);
  for (const line of collected.detail) console.log(`[${first.label}] ${line}`);
  if (collected.stopped) return;
  for (const acct of all) {
    const deps = rt.depsFor(acct.id);
    if (!ensureSignInSession(deps, acct.label)) continue;
    const r = drawFor(deps, { force: true, label: `${acct.label} 领小红花` });
    console.log(`[${acct.label}] ${r.note}`);
  }
}

/** 手工口令：不监听，只把给出的口令逐账号领一遍。 */
export function drawRedFlower(rt: Runtime, codes: string[]): void {
  if (codes.length === 0) {
    console.log('[小红花] 没有口令');
    return;
  }
  const now = new Date().toISOString();
  for (const acct of accounts(rt)) {
    const deps = rt.depsFor(acct.id);
    if (!ensureSignInSession(deps, acct.label)) continue;
    deps.store.setState(
      STATE_CODES,
      JSON.stringify({ at: now, codes, raw: codes.join(' '), how: '手工传入' }),
      now,
    );
    deps.store.setState(STATE_DRAW, '', now);
    const r = drawFor(deps, { force: true, label: `${acct.label} 领小红花` });
    console.log(`[${acct.label}] ${r.note}`);
  }
}

export { accounts as liveAccounts, labelOf };
