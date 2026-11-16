// 一趟日常的**编排**：逐账号跑 → 日志 → 运行记录 → 卡片摘要。
//
// 这条链里"每一步做什么"在 mcloud/dailyRun.ts（runDaily）；这里只管**整趟**：
// 用哪些账号、怎么串行、日志怎么分三段（凭据/账号头/段尾）、记哪一次运行。
// 业务口径见 docs/task-state.md；顺序与文案是用户验收过的，别随手改。

import { forEachTaskAccount } from '../../mcloud/accountRuntime.ts';
import { DAILY_DONE_KEY, DAILY_LAST_KEY } from '../../mcloud/dailyState.ts';
import { runDaily } from '../../mcloud/dailyRun.ts';
import { logBoth } from '../../mcloud/log.ts';
import { appendRun } from '../../mcloud/runLog.ts';
import { labelOf, shortLabel } from '../../mcloud/taskAccounts.ts';
import { blockersFor, setTaskBlockers, setTaskSummary } from '../../mcloud/taskReadiness.ts';
import { lineLevel, lineText, onceHint, stepTally } from '../../mcloud/tasks/stepLog.ts';
import { rawStoreOf, scoped } from '../../store/scoped.ts';
import type { TaskPayload } from '../../ports/panel.ts';
import type { DailyCtx } from './ctx.ts';

/** 今天跑过没 / 上一次的读数 —— 键名只在 mcloud/dailyState.ts 落一次，这里只是别名。 */
const DONE_KEY = DAILY_DONE_KEY;
const LAST_KEY = DAILY_LAST_KEY;

export async function runDailyTask(ctx: DailyCtx, p: TaskPayload): Promise<void> {
  const store = ctx.store;
  const transport = ctx.transport;
    const nowIso = new Date().toISOString();
    const startedMs = Date.parse(nowIso);
    const today = nowIso.slice(0, 10);

    // ── 这一趟跑**这条任务选的账号**（多选 / 全部），**串行** ──
    //
    // ⚠ 串行不是性能取舍，是**必须**：一个插件只有一条工作线程，而且上游有限流。
    //   参考实现的口径：「点击运行后**后端保证串行执行**」。
    //
    // ⚠ 每一条的 `DONE_KEY`（今天跑过没）**在它自己的袋里** —— 所以"今天已经
    //   成功过"要**逐条**判。放在循环外面判一次的话，A 跑完之后 B 就被跳过了
    //   （那正是 F-050 那个"B 的整趟被跳过"的老毛病）。
    // ⚠⚠ **不再有"今天跑过了就跳过"那道闸**（2026-10-17 用户口径）。
    //
    // 原来 08:00 跑成之后，20:00 那一趟会被这道闸直接跳过。用户否了这个设计：
    //
    //   「定时不能第二次就不做，因为目前插件没能力确定小任务是否全部已经
    //     达到预期，第二次跑是容错」
    //
    // 说得对：一趟"成功"只代表**我们以为**都做到了 —— 而"以为"和"上游的实际状态"
    // 是两件事（上游可能把某一步判成"已经做过了"其实没做、领取可能静默失败、
    // 某个步骤可能被判成 idle 提前停下）。插件没有能力证明所有小任务都到了预期状态，
    // 那么一天两趟就该**都跑**：第二趟是兜底，不是重复。
    //
    // 反复跑安全的理由在每一**步**里，不在这道闸上：签到、领取家族都是
    // "先问状态、已经做过就不再发请求"（`skipped` / `idle` 出口）。
    // 所以这里放开闸不会重复领奖，只是又核对一遍。
    //
    // `DONE_KEY` 仍然要写（下面 writeDone 那段）：它现在是**读数**
    // （"今天跑过几趟 / 今天有没有跑过"），不再是闸。

    // 这一趟里"已经解释过的后缀"（跨账号共用，见 onceHint）
    const onceHints = new Set<string>();
    // 先打一行，别让用户只看到插件加载的三行
    logBoth(store, 'start', '日常 · 开始', nowIso);
    // ⚠ 这里**没有**整趟硬截止：插件不再自己叠时间限制（用户口径 2026-11-16
    //   「不需要任何内部时间限制，这个没搞懂有什么作用除了制造麻烦」）。
    //   运行时长由面板的执行预算管（`budget_ms`），超了是面板的事，日志也看得见。
    const runs = await forEachTaskAccount(store, '日常', p, transport, async (deps, acctId) => {
      const who = labelOf(store, acctId);
      const tag = `[${shortLabel(who)}]`;
      // 账号头在**开跑前**打：多账号时一眼看出现在轮到谁。
      logBoth(store, 'start', tag, nowIso);
      const skippedSteps: string[] = [];
      let prev = '';
      const r = await runDaily(deps, {
        onPhase: (phase) => logBoth(store, 'info', `${tag} ${phase}…`, nowIso),
        // 上传 / 访问日志 / 打卡这些是**排查细节**，走 debug；
        // info 只留用户能看懂的任务结论。
        onNote: (note) => logBoth(store, 'debug', `${tag} ${note}`, nowIso),
        onLine: (line) => {
          // `onceHint`：跨账号的同一句解释只说一遍（见 stepLog.ts 那段）
          const shown = lineText(onceHint(line, onceHints));
          if (shown === prev) return;
          prev = shown;
          // 级联的"没有网页会话"不逐行刷：一个根因会拖垮十步，逐行写就是十行同样的字。
          if (shown.includes('跳过（没有网页会话）')) {
            skippedSteps.push(shown.split('：')[0] ?? shown);
            return;
          }
          logBoth(store, lineLevel(shown), `${tag} ${shown}`, nowIso);
        },
      });
      if (skippedSteps.length > 0) {
        const head = skippedSteps.slice(0, 3).join('、');
        logBoth(
          store,
          'debug',
          `${tag} 跳过 ${skippedSteps.length} 项（没有网页会话）：${head}${skippedSteps.length > 3 ? ' 等' : ''}`,
          nowIso,
        );
      }
      return r;
    });

    // 没选到账号 ⇒ **静默返回**。那不是失败，是"这条任务没配账号"。
    if (runs.length === 0) return;

    const results: typeof runs = [];
    for (const [i, one] of runs.entries()) {
      const r = one.result;
      if (r === null) continue; // 这一条今天已经跑过
      results.push(one);

      const who = labelOf(store, one.acctId);
      const note = runs.length > 1 ? `${who}：${r.note}` : r.note;

      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: r.ok,
        note,
      });

      // 同时进**运行记录**（留最近 N 次）。`LAST_KEY` 只有最后一次，
      // 覆盖掉之后"上次明明好的"这类问题就查不了了。
      const runId = appendRun(store, {
        task: 'daily',
        acct: one.acctId,
        who,
        at: nowIso,
        ms: Date.now() - startedMs,
        ok: r.ok,
        note,
        steps: r.steps,
      });

      if (r.ok && !r.steps.some((s) => s.pending === true)) {
        // ⚠ 标记落在**这一条自己的袋里**（`deps.store` 已经按账号路由过了）
        // ⚠ 标记必须落在**这一条自己的袋里** —— `deps.store` 已经按账号路由过了，
        //   但它在闭包里，所以这里现取一个"作用在指定账号上"的 store。
        scoped(rawStoreOf(store), one.acctId).setState(DONE_KEY, today, nowIso);
      }
      // 日志照 `mcloud-sign`：账号头/步骤已经在 `runDaily` 里边跑边打，
      // 这里只补段尾结论。
      const tag = `[${shortLabel(who)}]`;
      const { bad, hard } = stepTally(r.steps);
      const pending = r.steps.filter((s) => s.pending === true).length;
      // 段尾只说"几项没成"（用户要的是结论）；都成了就一句"都成了"。
      // 级联失败单独说"跳过"，否则 1 个根因会被写成 11 项没成。
      const tail =
        bad === 0
          ? pending > 0
            ? `${pending} 项等服务端确认`
            : '都成了'
          : hard === 0
            ? `${bad} 项跳过（没有网页会话）`
            : `${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', `${tag} ${tail}`, nowIso);
    }

    // 全都"今天已经跑过" ⇒ 静默返回（不推、不记）
    if (results.length === 0) return;

    // 「一次运行」的完整结果落一条读数 —— 界面读它，不用去翻环形日志
    const okAll = results.every((x) => x.result!.ok);
    const okCount = results.filter((x) => x.result!.ok).length;
    logBoth(
      store,
      okAll ? 'success' : 'warn',
      `日常完成：${okCount}/${results.length} 个账号好了`,
      nowIso,
    );
    const summary =
      results.length === 1
        ? results[0]!.result!.note
        : `${results.length} 个账号：${results.filter((x) => x.result!.ok).length} 成功 / ${results.filter((x) => !x.result!.ok).length} 失败`;
    store.setState(LAST_KEY, JSON.stringify({
        at: nowIso,
        ok: okAll,
        note: summary,
        steps: results.flatMap((x) => x.result!.steps),
      }), nowIso);

    // 面板卡片上的“这次跑成什么样”。账号可能在运行期间被删/停用，
    // 所以 blockers 也顺手重算一次（不然卡片会一直停在旧的就绪状态）。
    setTaskBlockers('日常', blockersFor(store, '日常'));
    setTaskSummary('日常', summary);

    // 下面那段推送用这两个名字（原来它们指"那一次"的结果）
    const r = {
      ok: okAll,
      note: summary,
      detail: results.flatMap((x) =>
        results.length > 1
          ? x.result!.detail.map((l) => `${labelOf(store, x.acctId)} ${l}`)
          : x.result!.detail,
      ),
      steps: results.flatMap((x) => x.result!.steps),
    };

    // ── 推送：挂在**一次运行结束**上（不是每条日志推一次）──
    // 正文 = 这次的结果 + **失败的那几步**。带上失败的那几步是必须的：
    // 否则用户收到「有失败」还得回界面翻是哪一步。
    const bad = r.detail.filter((l) => l.includes('失败'));
    ctx.notify(
      'daily',
      `日常：${r.ok ? '跑完了' : '有失败'}`,
      [
        r.note,
        '',
        ...r.detail.map((l) => `· ${l}`),
        ...(bad.length > 0 ? ['', '失败的那几步在上面（带 · 的行）'] : []),
      ].join('\n'),
      !r.ok,
    );
}
