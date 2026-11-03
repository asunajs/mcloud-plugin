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
import { runAuthRefresh } from '../mcloud/authRefresh.ts';
import { runLiveGate, readGateReading } from '../mcloud/tasks/liveGateTask.ts';
import { runLiveRoom, STATE_CODES } from '../mcloud/tasks/liveRoom.ts';
import { runLiveListen, type ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { loadDrawState, runLiveDraw, STATE_DRAW, type DrawState } from '../mcloud/tasks/liveDraw.ts';
import { drawLogLines } from './liveLog.ts';
import { createCliLogger, colorizeFrom, type CliLogger } from './logger.ts';
import { lineLevel, userLine } from '../mcloud/tasks/stepLog.ts';
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
function ensureSignInSession(deps: TaskDeps, label: string, log: CliLogger): boolean {
  if (!needExchange(deps.store, Date.now(), 'sign-in')) return true;
  const st = loadExchange(deps.store, 'sign-in');
  if (st === null || st.step === 'done') {
    const started = startExchange(deps.store, loadAuthRaw(deps.store), deps.nowIso, 'sign-in');
    if (!started.ok) {
      log.error(`换票：${started.error ?? '未知失败'}`);
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
  if (!r.ok) {
    log.error(`换票：${r.note}`);
    return false;
  }
  return true;
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

  step('小红书主页口令', () => runLiveRoom(deps));
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
  opts: { force: boolean; label: string; codes?: readonly string[] },
): { ok: boolean; note: string; steps: RunStep[] } {
  const r = drain(
    // 手动那一路必须把**人给的那几条**显式传进去：只写 `STATE_CODES` 不够 ——
    // `runLiveDraw` 不传 `codes` 时会从共享池里再挑（人给的在前，池里的跟在后面），
    // 于是「我输入一条、结果把上一场听来的也领了」。mcloud-sign 的
    // `drawRedFlower(codes)` 只打调用方给的那几条，CLI 要照这个。
    (d) => runLiveDraw(d, opts.codes === undefined ? {} : { codes: opts.codes }),
    deps,
    {
      label: opts.label,
      maxSteps: 12,
      deadlineMs: 60_000,
      startedAt: Date.now(),
    },
  );
  return {
    ok: r.ok,
    note: r.note,
    steps: [{ name: '领小红花', ok: r.ok, note: r.note, idle: r.idle }],
  };
}

/** 把这一轮落盘的结果照 mcloud-sign 的句子打出来。返回有没有真的打印。 */
function printDraw(deps: TaskDeps, before: DrawState | null, log: CliLogger): boolean {
  const st = loadDrawState(deps.store);
  if (st === null) return false;
  // 口令没变、这一轮早就跑完 ⇒ 不把上次的结果再打一遍（面板那边同样标「上次」）。
  if (before?.step === 'done' && st.step === 'done' && st.startedAt === before.startedAt) return false;
  for (const line of drawLogLines(st)) log[line.level](line.text);
  return true;
}

function accounts(rt: Runtime, only?: string): { id: string; label: string }[] {
  return loadAccounts(rt.rawStore)
    .filter((a) => a.disabled !== true)
    .filter((a) => only === undefined || a.id === only || a.label === only)
    .map((a) => ({ id: a.id, label: a.label }));
}

/** 自动听直播 + 领花。没开播时只判断一次，不逐账号刷屏。 */
export function autoDrawRedFlower(rt: Runtime): void {
  const log = createCliLogger({ colorize: colorizeFrom(rt.config.common) });
  const all = accounts(rt);
  if (all.length === 0) {
    log.error('未找到账号配置');
    return;
  }
  log.info('------【直播弹幕口令】------');
  const first = all[0]!;
  const collectDeps: ListenDeps = {
    ...rt.listenDepsFor(first.id),
    // 照 mcloud-sign 的 `[WS] 弹幕: ...`；runtime 里那条默认走 host-api 的
    // `[ISO] [debug]` 格式，这里覆盖成 CLI 的 `[debug] HH:MM:SS`。
    onDanmaku: (text) => log.debug(`[WS] 弹幕: ${text}`),
  };
  const auth = runAuthRefresh(collectDeps);
  if (!auth.ok) log.warn(`凭据续期：${auth.note}`);
  if (!ensureSignInSession(collectDeps, first.label, log)) return;
  const collected = collectOnce(collectDeps, Date.now(), LISTEN_BUDGET_MS);
  for (const line of collected.detail) log[lineLevel(line)](line);
  if (collected.stopped) return;

  // 照 mcloud-sign：把这一趟**所有**口令都列出来（不只是计数）。
  const pool = loadPoolFrom(rt.rawStore).pool;
  const codes = pool.codes.filter((c) => c.state !== 'invalid').map((c) => c.value);
  if (codes.length > 0) log.info(`共提取 ${codes.length} 个口令: ${codes.join(', ')}`);

  for (const [i, acct] of all.entries()) {
    log.info(`====== 账号 ${i + 1}【${acct.label}】 ======`);
    const deps = rt.depsFor(acct.id);
    const auth = runAuthRefresh(deps);
    if (!auth.ok) log.warn(`凭据续期（${acct.label}）：${auth.note}`);
    if (!ensureSignInSession(deps, acct.label, log)) {
      log.error('初始化失败，跳过');
      continue;
    }
    const before = loadDrawState(deps.store);
    const r = drawFor(deps, { force: true, label: `${acct.label} 领小红花` });
    const printed = printDraw(deps, before, log);
    // 口令没变、上一轮已跑完 ⇒ 没有新结果可打，就把状态机那句「已跑完」说出来。
    if (!printed) log.info(r.note);
    if (!r.ok) log.error(`领取失败：${r.note}`);
  }
}

/** 手工口令：不监听，只把给出的口令逐账号领一遍。 */
export function drawRedFlower(rt: Runtime, codes: string[]): void {
  const log = createCliLogger({ colorize: colorizeFrom(rt.config.common) });
  if (codes.length === 0) {
    log.error('请提供至少一个口令');
    return;
  }
  const all = accounts(rt);
  if (all.length === 0) {
    log.error('未找到账号配置');
    return;
  }
  const now = new Date().toISOString();
  for (const acct of all) {
    log.info('==============');
    log.info(`登录账号【${acct.label}】`);
    const deps = rt.depsFor(acct.id);
    const auth = runAuthRefresh(deps);
    if (!auth.ok) log.warn(`凭据续期（${acct.label}）：${auth.note}`);
    if (!ensureSignInSession(deps, acct.label, log)) continue;
    deps.store.setState(
      STATE_CODES,
      JSON.stringify({ at: now, codes, raw: codes.join(' '), how: '手工传入' }),
      now,
    );
    deps.store.setState(STATE_DRAW, '', now);
    const r = drawFor(deps, { force: true, label: `${acct.label} 领小红花`, codes });
    printDraw(deps, null, log);
    // 照 mcloud-sign：读余额失败就是「获取用户信息失败」，别拿内部步骤名糊上去。
    if (!r.ok) {
      const st = loadDrawState(deps.store);
      log.error(st?.balanceBefore === undefined ? '获取用户信息失败' : `领取失败：${r.note}`);
    }
  }
}

export { accounts as liveAccounts, labelOf };
