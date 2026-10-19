// 插件 `mcloud-live` —— 用户可见任务「直播」。
//
// # 一句话：**口令只收一次，领取按账号各领一次**
//
// 口令是**共享资源**：一个账号从弹幕里听到，所有账号都能拿去领小红花。
// 所以「听」不能按账号分（分着听 = 3 倍请求、3 倍时间，还重复撞同一批弹幕），
// 而「领」必须按账号分（"这个号领过哪条"要分开记，不然会白跑一枪 `200112`）。
//
// 于是这一趟是两段：
//
// ```text
//   ① 收口令（整趟一次，用第一个账号的凭据）
//       开门（房间列表）
//         ├─ 没开播 / 开播的不是「中国移动云盘」 ⇒ 到此为止（零请求）
//         └─ 开播 ⇒ 看小红书 → 听弹幕
//   ② 领（每个账号各一次，用共享池里的口令）
// ```
//
// 日志也照这个结构分两段：`------【口令】------` 一段（不属于任何账号），
// 然后每个账号一段。业务口径（为什么这么切、四条共享池规则、领取结果怎么分类）
// 在 [`docs/live-spec.md`](../../docs/live-spec.md)。
//
// # 两种模式
//
//   ① **手动**：用户在开播期间把口令贴进来（一条或多条）⇒ **直接领**：
//      不开门、不看小红书、不听弹幕（口令已经在手里了，那些都是白跑；
//      而且门偶发失败会把一趟本来能跑完的领取拖黄）。
//   ② **自动**：开播**时间**固定、**日期**不固定 ⇒ 每天两次碰运气
//      （`30 10,15 * * *` = 10:30 / 15:30）。碰上了才去小红书和弹幕里捡。
//
// 两种模式共用同一个 `runLiveDraw`。旧版本那五条 cron（口令/日程/听/定时/领）
// 已经并成这一条 —— 那五行的名字看不出"它们是同一件事的零件"。
//
// # 为什么预算要到分钟级
//
// 弹幕是**实时**的，而"听"要在**连续时间**里反复读帧。一次触发连听 5 分钟，
// 比"每 10 秒看一眼"稳：两帧之间漏掉的东西只能靠宿主的无界队列补，
// 补不补得上取决于队列有多深。门关着时第一次调用就 `idle` 停下 —— 零请求。
//
// ⚠ 面板对 `budget_ms` 的上限是 10 分钟（`rust-plugin-panel/src/hostapi.rs`
//   的 `MAX_DECLARED_BUDGET_MS`），5 分钟留足了余量。

import { debug, register_cron, warn } from 'host-api';
import { blockersFor, setTaskBlockers, setTaskSummary, summaryFor } from '../mcloud/taskReadiness.ts';
import { appendRun, type RunStep } from '../mcloud/runLog.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { logBoth } from '../mcloud/log.ts';
import { lineLevel, lineText, onceHint, stepTally, userLine } from '../mcloud/tasks/stepLog.ts';
import { collectCodes, runLiveDraw } from '../mcloud/tasks/liveDraw.ts';
import { readGateReading, runLiveGate } from '../mcloud/tasks/liveGateTask.ts';
import { KOULING_ANCHOR, loadPoolFrom, stopScraping, validCount } from '../mcloud/koulingPool.ts';
import { runLiveListen } from '../mcloud/tasks/liveListen.ts';
import type { ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { runLiveRoom } from '../mcloud/tasks/liveRoom.ts';
import type { TaskDeps, TaskOutcome } from '../mcloud/tasks/base.ts';
import { capNote, hostNativeTls } from '../mcloud/hostCap.ts';
import {
  forEachTaskAccount,
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  makeHost,
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

// 共享粗粒度 lane：听窗口是连续几十秒的占用，但不需要毫秒级；
// 和日常排队即可。只有 exchange 和路由插件需要独占（见 shared.ts 文件头）。

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
const host = makeHost();

/** 听窗口预算。一天只来两次（10:30 / 15:30），所以每次听久一点：
 *  5 分钟。面板对预算的上限是 10 分钟（`MAX_DECLARED_BUDGET_MS`）。 */
const BUDGET_MS = 300_000;

function listenDeps(deps: TaskDeps): ListenDeps {
  return { ...deps, host };
}

/** 一趟直播。 */
/** 整趟**只跑一次**：收口令（门 → 小红书 → 听弹幕）。
 *
 *  ⚠⚠ **口令是共享的**：一个账号听到，所有账号都能拿去领（用户口径 2026-10-17：
 *  「一个听到其他人就能用了」）。所以这一支**不按账号分**，也不该把听窗口的
 *  预算按账号摊 —— 那样 3 个账号就是 3 倍请求、3 倍时间，还会重复撞同一批弹幕。
 *
 *  用**第一个账号**的凭据（换票/门/WS 都要一张票，随便哪张都行）。
 */
function collectOnce(
  deps: TaskDeps,
  runStartMs: number,
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

  // ⓪ 先问一次**这个面板构建支不支持直播**。
  //
  //   为什么放在最前面：不支持的时候，后面每一条（门、小红书、弹幕）都会
  //   以同一条 TLS 报错收场，而那条报错用户改不了、也看不懂。
  //   问一次、记住、然后**什么都不做** —— 一天两次的机会不该花在注定失败的路上。
  const cap = hostNativeTls(deps.store, deps.nowIso, deps.transport);
  if (cap.verdict === 'no') {
    // ⚠ 这里不再单独 `error()` 一次：这一段会由下面的段尾统一印成**一行** error
    //   （同一句话说三遍比说一遍糟 —— 见 F-097 的同一条口径）。
    steps.push({ name: '这个面板能不能直播', ok: false, note: capNote(cap.verdict), idle: false });
    return done(false, capNote(cap.verdict), true);
  }

  // ① 先验开播 —— 没开播时抓到的口令一定是无效的，所以"先验开播"是判据，不是限制。
  const gateOut = drain(runLiveGate, deps, {
    label: '有没有开播',
    maxSteps: 3,
    deadlineMs: 40_000,
    startedAt: runStartMs,
  });
  const gate = readGateReading(store);
  const liveCount = gate === null ? 0 : gate.liveCount;

  // ⚠ **门自己失败 ≠ 今天没直播**（"我们凭据坏了"与"今天没开播"是两件事）。
  //   参考实现这一支的做法是"警告一句、继续试"（`hasActiveLiveRoom`：验证失败返回 true，
  //   避免因临时故障漏掉口令）。一天只有两次机会，为一次偶发失败丢掉整场不值。
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

  // ② 小红书（公开 GET，封控要求 ≥30 分钟一次）
  step('主播发口令没有', () => runLiveRoom(deps));

  // ③ 听弹幕 —— 池里够 2 条有效就不听了（再听只是重复撞同一批）
  const poolNow = loadPoolFrom(store).pool;
  const enough = stopScraping(poolNow);
  if (enough) {
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
  const ld = listenDeps(deps);
  const listenDeadline = runStartMs + BUDGET_MS - 20_000;
  while (Date.now() < listenDeadline) {
    const r = step('听弹幕', () => runLiveListen(ld));
    listenNote = r.note;
    if (!r.ok || r.idle) break;
    frames++;
    if (frames > 60) break;
  }
  if (frames > 0) {
    steps.push({ name: '听弹幕', ok: true, note: listenNote || `听了 ${frames} 轮`, idle: false });
  }
  const after = loadPoolFrom(store).pool;
  return done(true, `池里现在有 ${validCount(after)} 条能用的口令`);
}

/** 每个账号：拿**共享池**里的口令去领。
 *
 *  ⚠ 这一支才是"按账号"的 —— 因为"哪个账号领过哪条"必须分开记（`claims`）。
 *  口令本身不按账号分：同一张口令，每个账号都能领一次。 */
function drawOnce(
  deps: TaskDeps,
  runStartMs: number,
): { steps: RunStep[]; detail: string[]; ok: boolean; note: string } {
  const r = drain(runLiveDraw, deps, {
    label: '领小红花',
    maxSteps: 12,
    deadlineMs: Math.max(15_000, runStartMs + BUDGET_MS - Date.now() - 3_000),
    startedAt: runStartMs,
  });
  const steps: RunStep[] = [{ name: '领小红花', ok: r.ok, note: r.note, idle: false }];
  return {
    steps,
    detail: steps.map((s) => userLine(s)).filter((x): x is string => x !== null),
    ok: r.ok,
    note: r.note,
  };
}

register_cron(
  '直播',
  // 用户口径（2026-10-17）：「太频繁了，每天上午 10:30 / 下午 15:30 两次」。
  // 每 5 分钟一跳太密 —— 而开播时刻是整点粒度，两次足够；没在播时第一次
  // 调用就早退（零请求），见下面的「先验开播再决定要不要听」。
  '30 10,15 * * *',
  (p: TaskPayload) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    // ── ① 先收口令：**整趟只跑一次**，用第一个账号的凭据 ──────────────
    //
    // ⚠ 口令是**共享**的（一个账号听到，所有账号都能用），所以"听"这件事
    //   不能按账号分：分着跑就是 3 倍请求、3 倍时间，还会重复撞同一批弹幕。
    // ⚠ **手里有口令（人贴的）就不收** —— 省两个请求，且避免门偶发失败把一趟
    //   本来能跑完的领取拖黄（参考实现 `task-inventory.md:354`）。
    const manual = collectCodes(store, startedMs).length > 0;
    let collected: { steps: RunStep[]; detail: string[]; ok: boolean; note: string; stopped: boolean } | null =
      null;
    // 第一段（收口令）说“别领”时，后面的账号**一个请求都不发**：
    // 否则没开播也会每个号打一次「领小红花没开」，再给每个号印一句「都成了」。
    let stopAll = false;
    const runs = forEachTaskAccount(store, '直播', p, transport, (deps, _acct, index) => {
      if (index === 0 && !manual) {
        const one = collectOnce(deps, startedMs);
        collected = one;
        if (one.stopped) stopAll = true;
      }
      if (stopAll) return { steps: [] as RunStep[], detail: [] as string[], ok: true, note: '没在播，跳过' };
      return drawOnce(deps, startedMs);
    });
    // 没选到账号 ⇒ 静默返回（那不是失败，是"这条任务没配账号"）
    if (runs.length === 0) return;

    // 收口令那一段：**一次**，标成「口令」而不是某个账号 —— 它不属于任何账号
    const c = collected as null | { steps: RunStep[]; detail: string[]; ok: boolean; note: string; stopped: boolean };
    const capOnly =
      c !== null && c.steps.length === 1 && !c.ok && c.steps[0]?.name === '这个面板能不能直播';

    // 没开播（或面板根本不支持直播）⇒ **整趟到此为止**。
    // 用户的原话：「实际上是因为直播未开始，所以跳过就好了，结果她每个账号都输出」。
    if (c !== null && c.stopped) {
      const reason = c.steps[0]?.note ?? c.note;
      if (capOnly) {
        logBoth(store, 'error', c.detail[0] ?? c.note, at);
      } else {
        logBoth(store, 'info', `这一趟不领 —— ${reason}；跳过 ${runs.length} 个账号`, at);
      }
      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: !capOnly,
        note: capOnly ? c.note : `直播没开始，跳过 ${runs.length} 个账号`,
      });
      setTaskBlockers('直播', blockersFor(store, '直播'));
      setTaskSummary('直播', summaryFor(store, '直播'));
      return;
    }

    // 这一趟里"已经解释过的后缀"（跨账号共用，见 stepLog.ts 的 onceHint）
    const onceHints = new Set<string>();

    if (c !== null && c.detail.length > 0) {
      if (capOnly) {
        logBoth(store, 'error', c.detail[0] ?? c.note, at);
      } else {
        logBoth(store, 'start', '口令', at);
        let prev = '';
        for (const line of c.detail) {
          const shown = lineText(onceHint(line, onceHints));
          if (shown === prev) continue;
          prev = shown;
          logBoth(store, lineLevel(shown), shown, at);
        }
        const cBad = c.steps.filter((x) => !x.ok).length;
        logBoth(store, cBad > 0 ? 'warn' : 'success', `口令：${c.note}`, at);
      }
    }

    // ── ② 每个账号：拿共享池里的口令去领 ─────────────────────────────
    logBoth(store, 'start', `直播 · ${runs.length} 个账号`, at);
    for (const one of runs) {
      const r = one.result;
      const who = labelOf(store, one.acctId);
      const note = runs.length > 1 ? `${who}：${r.note}` : r.note;

      appendRun(store, {
        task: 'live',
        acct: one.acctId,
        who,
        at,
        ms: Date.now() - startedMs,
        ok: r.ok,
        note,
        steps: r.steps,
      });

      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: r.ok,
        note,
      });
      logBoth(store, 'start', `账号 ${who}`, at);
      let prev = '';
      // 级联的“没有网页会话”不逐行刷：一个根因会拖垮十步，逐行写就是十行同样的字。
      const skippedSteps: string[] = [];
      for (const line of r.detail) {
        // 同一行连着出现（同一账号里的重复步骤）不必重画；
        // `onceHint` 管的是**跨账号**的同一句解释（见 stepLog.ts 那段）
        const shown = lineText(onceHint(line, onceHints));
        if (shown === prev) continue;
        prev = shown;
        if (shown.includes('跳过（没有网页会话）')) {
          skippedSteps.push(shown.split('：')[0] ?? shown);
          continue;
        }
        logBoth(store, lineLevel(shown), shown, at);
      }
      if (skippedSteps.length > 0) {
        const head = skippedSteps.slice(0, 3).join('、');
        logBoth(
          store,
          'debug',
          `跳过 ${skippedSteps.length} 项（没有网页会话）：${head}${skippedSteps.length > 3 ? ' 等' : ''}`,
          at,
        );
      }
      const { bad, hard } = stepTally(r.steps);
      const tail =
        bad === 0
          ? `账号 ${who}：都成了`
          : hard === 0
            ? `账号 ${who}：${bad} 项跳过（没有网页会话）`
            : `账号 ${who}：${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', tail, at);
    }

    const okCount = runs.filter((x) => x.result.ok).length;
    logBoth(
      store,
      okCount === runs.length ? 'success' : 'warn',
      `直播完成：${okCount}/${runs.length} 个账号好了`,
      at,
    );

    // 账号可能在运行期间被删/停用：卡片摘要和未就绪状态跟着重算。
    setTaskBlockers('直播', blockersFor(store, '直播'));
    setTaskSummary('直播', summaryFor(store, '直播'));
  },
  {
    budget_ms: BUDGET_MS,
    // 直播也是环境型任务：面板任务列表里显示；没账号时“未就绪”。
    surface: 'panel',
    summary: summaryFor(store, '直播'),
    blockers: blockersFor(store, '直播'),
  },
);

debug(`mcloud-live：任务「直播」（预算 ${BUDGET_MS / 1000}s，共享粗粒度 lane）`);
