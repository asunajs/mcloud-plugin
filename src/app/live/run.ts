// 一趟直播的**编排**（日志 / 运行记录 / 卡片摘要都在这）。
//
// 两段：① 收口令（整趟一次，见 ./collect.ts）② 每个账号领（见 ./draw.ts）。
// 业务口径见 docs/live-spec.md；这里的顺序与文案是用户验收过的，别随手改。

import { forEachTaskAccount } from '../../mcloud/accountRuntime.ts';
import { traceBegin, traceStep } from '../../mcloud/liveTrace.ts';
import { logBoth } from '../../mcloud/log.ts';
import { logTo } from '../../ports/log.ts';
import { appendRun } from '../../mcloud/runLog.ts';
import type { RunStep } from '../../mcloud/runLog.ts';
import { labelOf, shortLabel } from '../../mcloud/taskAccounts.ts';
import { blockersFor, setTaskBlockers, setTaskSummary, summaryFor } from '../../mcloud/taskReadiness.ts';
import { runLiveAuto } from '../../mcloud/tasks/liveAutoTask.ts';
import { collectCodes } from '../../mcloud/tasks/liveDraw.ts';
import { loadListenSeconds } from '../../mcloud/tasks/liveListen.ts';
import { clearLiveCodes, loadLiveCodes } from '../../mcloud/tasks/liveRoom.ts';
import { lineLevel, lineText, onceHint, stepTally } from '../../mcloud/tasks/stepLog.ts';
import type { TaskPayload } from '../../ports/panel.ts';
import type { LiveCtx } from './ctx.ts';
import { collectOnce } from './collect.ts';
import { drawOnce } from './draw.ts';

export async function runLive(ctx: LiveCtx, p: TaskPayload): Promise<void> {
  const store = ctx.store;
  const transport = ctx.transport;
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    // 追踪环：这一趟从空开始（环里永远是"上一趟到最近一趟"的现场，见 liveTrace.ts）
    traceBegin(store, at);
    // ── ① 先收口令：**整趟只跑一次**，用第一个账号的凭据 ──────────────
    //
    // ⚠ 口令是**共享**的（一个账号听到，所有账号都能用），所以"听"这件事
    //   不能按账号分：分着跑就是 3 倍请求、3 倍时间，还会重复撞同一批弹幕。
    // ⚠ **手里有口令（人贴的）就不收** —— 省两个请求，且避免门偶发失败把一趟
    //   本来能跑完的领取拖黄（参考实现 `task-inventory.md:354`）。
    // ⚠ 只看**人贴的** `mcloud.live.codes`，不能看 `collectCodes()`：后者会把池里
    //   上一轮听到的候选也算进来，于是自动任务永远走“手动领取”，跳过开播检查
    //   和听弹幕 —— 2026-10-22 现场：池里一条未验证的「AI模拟练面试」让直播正在
    //   进行时都没去听。
    // 人贴的口令是**一次性**的：读出来立刻清掉，后面的账号都用这份快照。
    // 不清的话，上一次贴过的口令会永远留着；下一次哪怕用户没输入，任务也会
    // 误判成“手动领取”，直接跳过开播检查和听弹幕（2026-11-03 现场：
    // 没去获取，却突然冒出一条「AI助力冲offer」的“上次”结果）。
    const manualCodes = (loadLiveCodes(store)?.codes ?? []).map((c) => c.trim()).filter(Boolean);
    const manual = manualCodes.length > 0;
    if (manual) clearLiveCodes(store, at);
    let collected: { steps: RunStep[]; detail: string[]; ok: boolean; note: string; stopped: boolean } | null =
      null;
    // 第一段（收口令）说“别领”时，后面的账号**一个请求都不发**：
    // 否则没开播也会每个号打一次「领小红花没开」，再给每个号印一句「都成了」。
    let stopAll = false;
    const runs = await forEachTaskAccount(store, '直播', p, transport, async (deps, _acct, index) => {
      // ⓪ 每趟先算一次「下一场几点醒」（**零上游请求**，只读池里那份日程）。
      //
      //   ⚠ 手动、自动两条路**都要**算：它决定的是「下次什么时候自己去看」，
      //     跟这一趟怎么拿到口令无关。只写在 collectOnce 里就会漏掉手动那趟。
      //   ⚠ 用**第一个账号**的 deps：`mcloud.live.wake_plan` 是 account 袋。
      if (index === 0) {
        const auto = runLiveAuto(deps, { windowMs: loadListenSeconds(deps.store) * 1000 });
        logTo('debug', `自动定时：${auto.note}`);
      }
      if (index === 0 && !manual) {
        const one = await collectOnce(ctx, deps, startedMs);
        collected = one;
        if (one.stopped) stopAll = true;
      }
      if (stopAll) return { steps: [] as RunStep[], detail: [] as string[], ok: true, note: '没在播，跳过' };
      // 人贴了口令就**只领他贴的那一条**，别把池里的旧候选混进来。
      return await drawOnce(ctx, deps, startedMs, manual ? manualCodes : null);
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
      const reason = c.note;
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
        ok: c.ok && !capOnly,
        note: c.note,
      });
      setTaskBlockers('直播', blockersFor(store, '直播'));
      setTaskSummary('直播', summaryFor(store, '直播'));
      traceStep(store, at, 'done', `不领：${reason}`, { ok: false });
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
        logBoth(store, !c.ok || cBad > 0 ? 'warn' : 'success', `口令：${c.note}`, at);
      traceStep(store, at, 'collect/codes', c.note, { ok: c.ok && cBad === 0 });
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
      const tag = `[${shortLabel(who)}]`;
      logBoth(store, 'start', tag, at);
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
        logBoth(store, lineLevel(shown), `${tag} ${shown}`, at);
      }
      if (skippedSteps.length > 0) {
        const head = skippedSteps.slice(0, 3).join('、');
        logBoth(
          store,
          'debug',
          `${tag} 跳过 ${skippedSteps.length} 项（没有网页会话）：${head}${skippedSteps.length > 3 ? ' 等' : ''}`,
          at,
        );
      }
      const { bad, hard } = stepTally(r.steps);
      const allIdle = r.steps.length > 0 && r.steps.every((s) => s.idle === true);
      const tail =
        bad === 0
          ? allIdle
            ? `跳过：${r.steps[0]?.note ?? '这一步没做'}`
            : '都成了'
          : hard === 0
            ? `${bad} 项跳过（没有网页会话）`
            : `${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', `${tag} ${tail}`, at);
      // 追踪环：一个账号一条（谁、成没成、一句话）
      traceStep(store, at, 'account', `${who}：${tail}`, { ok: r.ok && hard === 0 });
    }

    // ⚠ 只算**真发了请求**的账号：什么都没做（口令没变/没有口令）不算"好了"。
    //   2026-11-16 现场就是三个号一步没做、日志写「3/3 个账号好了」。
    const okCount = runs.filter((x) => x.result.ok && (x.result as { didWork?: boolean }).didWork !== false).length;
    const idleAll =
      runs.length > 0 &&
      runs.every(
        (x) => x.result.ok && x.result.steps.length > 0 && x.result.steps.every((s) => s.idle === true),
      );
    logBoth(
      store,
      okCount === runs.length && !idleAll ? 'success' : 'warn',
      idleAll
        ? `直播：${runs.length} 个账号都没领 —— ${runs[0]?.result.note ?? ''}`
        : `直播完成：${okCount}/${runs.length} 个账号好了`,
      at,
    );

    traceStep(
      store,
      at,
      'done',
      idleAll ? `${runs.length} 个账号都没领` : `${okCount}/${runs.length} 个账号好了`,
      { ok: okCount === runs.length, ms: Date.now() - startedMs },
    );

    // 账号可能在运行期间被删/停用：卡片摘要和未就绪状态跟着重算。
    setTaskBlockers('直播', blockersFor(store, '直播'));
    setTaskSummary('直播', summaryFor(store, '直播'));
}
