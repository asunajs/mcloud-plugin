// 一趟兑换的**编排**：哪些计划该跑 → 逐计划发单 → 日志 → 运行记录 → 推送。
//
// "怎么发单"在 `mcloud/tasks/exchangeRun.ts`（runExchange，含整点时间闸）；
// 这里只管**整趟**：算目标整点、挑出这一拍该跑的计划、把每个计划的结果写成人话。
// 抢兑是唯一"慢一秒就输"的链路 —— 这里的顺序（预热 → 卡点 → 发单）别随手改。



import { loadAccounts } from '../../mcloud/accounts.ts';
import { depsForAccount } from '../../mcloud/accountRuntime.ts';
import { runAuthRefresh } from '../../mcloud/authRefresh.ts';
import { bumpPlanRuns, duePlans, loadPlans, planRuns, planTarget } from '../../mcloud/exchangePlans.ts';
import { hourKey } from '../../mcloud/exchangeTiming.ts';
import { logBoth } from '../../mcloud/log.ts';
import { appendRun } from '../../mcloud/runLog.ts';
import { labelOf, shortLabel } from '../../mcloud/taskAccounts.ts';
import { STATE_ORDERED_HOUR } from '../../mcloud/tasks/exchangeOrder.ts';
import { BUDGET_MS, runExchange, scheduleUntilAllowed } from '../../mcloud/tasks/exchangeRun.ts';
import { lineLevel, lineText, stepTally } from '../../mcloud/tasks/stepLog.ts';
import type { TaskPayload } from '../../ports/panel.ts';
import type { ExchangeCtx } from './ctx.ts';

export async function runExchangeTask(ctx: ExchangeCtx, p: TaskPayload): Promise<void> {
  const store = ctx.store;
  const transport = ctx.transport;
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    // ⚠ 面板**不发** scheduledAt（由 defineTask 合成）。解析不出来就按"现在"算 ——
    //   以前这里 `return`，而适配层给的是空串 ⇒ 这条任务在新面板上一次都没跑过。
    const parsedTarget = Date.parse(p.scheduledAt);
    const targetMs = Number.isFinite(parsedTarget) ? parsedTarget : startedMs;

    // 这一拍的目标整点，哪些计划该跑（cron 的日/月/周匹配也在这里判）。
    const plans = duePlans(loadPlans(store), targetMs);
    if (plans.length === 0) {
      // ⚠ 一行不留的话，「这一趟为什么什么都没发生」就无从回答：迟到/补跑的那一拍
      //   scheduledAt 会飘过整点，cron 按**分钟**匹配不中 ⇒ 全部计划都不 due；
      //   手动「跑一次」落在整点之外也是这一支。如实说，别静默。
      //   （要不要改成按小时匹配 = 语义改动，见 findings F-145 的待办。）
      logBoth(store, 'debug', `兑换：这一趟没有到点的计划（按 scheduledAt=${p.scheduledAt} 匹配）`, at);
      return;
    }
    const targetHour = new Date(targetMs).getHours();
    const thisHour = hourKey(targetMs);
    const accounts = loadAccounts(store);
    let acted = 0;
    let skipped = 0;
    // 推送正文按计划一条一行地攒（见循环里的 `tail`）。
    const pushLines: string[] = [];
    let pushFailed = 0;

    for (const plan of plans) {
      const acct = accounts.find((a) => a.id === plan.accountId);
      if (!acct || acct.disabled === true) {
        skipped += 1;
        logBoth(store, 'debug', '计划「' + plan.prizeName + '」：账号已删除或停用，这一趟跳过', at);
        continue;
      }
      const untilGate = scheduleUntilAllowed(store, targetMs, plan.until);
      if (!untilGate.ok) {
        skipped += 1;
        continue;
      }
      const done = planRuns(store, plan.id);
      if (plan.maxRuns > 0 && done >= plan.maxRuns) {
        skipped += 1;
        continue;
      }

      // 每个账号一个 store：按账号的票、进度、小时闸都落到自己的袋里。
      const deps = depsForAccount(store, plan.accountId, p, transport);
      // 小时闸：这一小时已经发过单了 ⇒ 零请求秒返回。
      if (deps.store.getState(STATE_ORDERED_HOUR) === thisHour) {
        skipped += 1;
        continue;
      }

      // 原生 token 到期就自动续（离到期还远时零请求）—— 兑换和签到共用同一份凭据。
      const auth = await runAuthRefresh(deps);
      if (!auth.skipped) {
        logBoth(store, auth.ok ? 'debug' : 'warn', `凭据续期：${auth.note}`, at);
      }

      const r = await runExchange(deps, {
        maxWaitMs: BUDGET_MS - 10_000,
        targetHour,
        target: planTarget(plan),
      });
      // 真正发起了一次（不是离窗口还远）⇒ 计数；失败也算，按计划各算。
      if (r && !r.idle) bumpPlanRuns(store, plan.id, deps.nowIso);

      if (!r || r.idle) {
        // 离窗口还远 ⇒ 不写日志（这一趟一个请求都没发），但读数照样更新。
        store.recordRun({
          task: p.name,
          runs: p.runs,
          scheduledAt: p.scheduledAt,
          firedAt: p.firedAt,
          lateMs: p.lateMs,
          ok: true,
          note: r ? r.note : '这一趟没动手',
        });
        continue;
      }

      acted += 1;
      const who = acct.label || labelOf(store, plan.accountId);
      const note = who + ' · ' + plan.prizeName + '：' + r.note;
      appendRun(store, {
        task: 'exchange',
        acct: plan.accountId,
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
      logBoth(store, 'start', `${tag} 兑换 · ${plan.prizeName}`, at);
      let prev = '';
      // 级联的“没有网页会话”不逐行刷：一个根因会拖垮十步。
      const skippedSteps: string[] = [];
      for (const line of r.detail) {
        const shown = lineText(line);
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
      const tail =
        bad === 0
          ? `${plan.prizeName}：都成了`
          : hard === 0
            ? `${plan.prizeName}：${bad} 项跳过（没有网页会话）`
            : `${plan.prizeName}：${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', `${tag} ${tail}`, at);
      // 推送正文：这条计划的结果一行（成败都算" acted"，都该让绑了规则的用户看到）。
      pushLines.push(`${who} · ${tail}`);
      if (hard > 0) pushFailed += 1;
    }

    if (acted === 0) {
      logBoth(
        store,
        'debug',
        '这一趟没动手 —— ' +
          plans.length +
          ' 条计划都还没到该抢的时候（或这一场已经试过了）' +
          (skipped > 0 ? '，其中 ' + skipped + ' 条被跳过' : ''),
        at,
      );
    }
    // ── 推送：挂在**一次运行结束**上（与日常同一条口径）。
    // ⚠ 全仓库此前只有日常调它 —— 绑了「兑换」规则的用户一次都收不到（F-145）。
    //   一条都没动手的趟不发（纯"还没到点"的趟不值得推）。
    if (pushLines.length > 0) {
      await ctx.notify(
        'exchange',
        `兑换：${pushFailed > 0 ? '有失败' : '跑完了'}`,
        [
          ...pushLines,
          ...(skipped > 0 ? ['', `${skipped} 条计划这趟被跳过（未到点 / 已发过 / 次数用完）`] : []),
        ].join('\n'),
        pushFailed > 0,
      );
    }
}
