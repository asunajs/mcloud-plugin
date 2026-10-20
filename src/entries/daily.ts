// 插件 `mcloud-daily` —— 用户可见任务「日常」。
//
// # 一个函数从头跑到尾
//
// 老版本这里是 14 条 cron（`sign` / `receive` / `multiple` / `revival` /
// `backup-gift` / `task-expansion` / `auth-refresh` / `msg-push` /
// `msg-push-obtain` / `notice` / `app-task-matrix` / `app-task` /
// `exchange-list` / `session-refresh`），每条一次只推进一步 —— 因为全局执行
// 预算是 2 秒，一次触发发不了几个请求。
//
// 那套结构在面板上的样子是：14 行任务，名字分别是「签到」「领取AI豆」
// 「签到翻倍」「复活卡」「备份好礼」「任务拓展」…… 用户要自己拼出
// 「它们其实是一件事」。这就是「界面完全搞不懂」的来源之一。
//
// 现在任务可以声明长预算（`{ budget_ms }`），所以这里就是**一个函数**：
// 按固定顺序把每一步跑完，一次触发出一个结果。
//
// # 顺序为什么是这样
//
//   ① 换票      —— 票过期的话后面每一步都会回 `90001 未登录`，
//                  而那个现象看起来像「账号被踢了」
//   ② 签到族    —— 先签到再领（`receive` 依赖签到状态）
//   ③ 任务拓展  —— 状态机，drain 到走完
//   ④ App 任务  —— 先读矩阵（`app-task-matrix`），再做（`app-task`）
//   ⑤ 消息推送奖励 / 开启通知 —— 各自自带判据，没事就秒返回
//   ⑥ 凭据续期  —— 离过期还远时一个请求都不发
//   ⑦ 收尾读数  —— 待领取奖品（AI豆快照已按 mcloud 摘掉任务注册，数据页按需取）
//
// # 「一天只跑一次」怎么做的
//
// 面板**不补跑**：一个任务落后太多时只重新对齐到当前时刻，错过的触发一律丢掉
// （见 `rust-plugin-panel` 的 `scheduler.rs`）。所以「每天 8:00 打一枪」这种写法
// 在低配盒子（不常在线）上会**整天不跑**。
//
// ⚠ **一天两次**，不是"白天每 30 分钟一跳"。
//
// 老版本是 `*/30 7-22` —— 一天 30 次，而每一次做的是**同一件事**（签到 + 领豆 +
// 领小红花）。用户看到任务列表里那个表达式就说了：「太特么频繁了」「日常每天两次？」。
//
// 触发频率该由"**这件事一天发生几次**"决定，不是由"多久看一眼"决定。
//
// 上面那条"面板不补跑"的顾虑仍然成立，所以选的是 `0 8,20`（**两次**）而不是
// "每天 8:00 一次"：两次里漏掉一次还有另一次，而且这个族本身有
// 「今天已经整趟成功」的标记兜底（它挡的是**重跑**，不是频率）。
// 哪一步失败了就不落标记，下一跳重试 —— 这才是「一次运行 = 一个结果」该有的样子。
//
// ⚠ 标记用的是 **UTC 日期**。UTC+8 的用户在本地 08:00 之前拿到的是前一天的 UTC 日期，
// 所以 7 点那一跳和 8 点那一跳会各跑一次整趟；第二次上游已经签过了，各步自己会
// 秒返回。这是**刻意接受**的：宁可多一次便宜的整趟，也不要漏掉一整天。


import { debug, register_cron, warn } from 'host-api';
import { runDaily } from '../mcloud/dailyRun.ts';
import { blockersFor, setTaskBlockers, setTaskSummary, summaryFor } from '../mcloud/taskReadiness.ts';
import { runAuthRefresh } from '../mcloud/authRefresh.ts';
import { appendRun } from '../mcloud/runLog.ts';
import {
  loadAuthRaw,
  loadExchange,
  needExchange,
  runExchangeStep,
  startExchange,
} from '../mcloud/sessionExchange.ts';
import type { SessionRecipe } from '../mcloud/h5session.ts';
import { labelOf, shortLabel } from '../mcloud/taskAccounts.ts';
import { logBoth } from '../mcloud/log.ts';
import { lineLevel, lineText, onceHint, stepTally } from '../mcloud/tasks/stepLog.ts';
import { loadQueue } from '../mcloud/tasks/receive.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';
import { DAILY_DONE_KEY, DAILY_LAST_KEY } from '../mcloud/dailyState.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  forEachTaskAccount,
  makeStore,
  makeTransport,
  notify,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
const BUDGET_MS = 120_000;
const DONE_KEY = DAILY_DONE_KEY;
const LAST_KEY = DAILY_LAST_KEY;

// ── 注册 ──

register_cron(
  '日常',
  // 白天每 30 分钟一跳：低配盒子不常在线时，上线之后的下一跳就能补上
  // （面板不补跑，见文件头）。整趟成功后剩下的跳是零请求的秒返回。
  '0 8,20 * * *',
  (p: TaskPayload) => {
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
    const runs = forEachTaskAccount(store, '日常', p, transport, (deps, acctId) => {
      const who = labelOf(store, acctId);
      const tag = `[${shortLabel(who)}]`;
      // 账号头在**开跑前**打：多账号时一眼看出现在轮到谁。
      logBoth(store, 'start', tag, nowIso);
      const skippedSteps: string[] = [];
      let prev = '';
      const r = runDaily(deps, {
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

      if (r.ok) {
        // ⚠ 标记落在**这一条自己的袋里**（`deps.store` 已经按账号路由过了）
        // ⚠ 标记必须落在**这一条自己的袋里** —— `deps.store` 已经按账号路由过了，
        //   但它在闭包里，所以这里现取一个"作用在指定账号上"的 store。
        scoped(rawStoreOf(store), one.acctId).setState(DONE_KEY, today, nowIso);
      }
      // 日志照 `mcloud-sign`：账号头/步骤已经在 `runDaily` 里边跑边打，
      // 这里只补段尾结论。
      const tag = `[${shortLabel(who)}]`;
      const { bad, hard } = stepTally(r.steps);
      // 段尾只说"几项没成"（用户要的是结论）；都成了就一句"都成了"。
      // 级联失败单独说"跳过"，否则 1 个根因会被写成 11 项没成。
      const tail =
        bad === 0
          ? '都成了'
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
    notify(
      store,
      transport,
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
  },
  {
    budget_ms: BUDGET_MS,
    // 日常是“随时跑都安全”的环境型任务：面板任务列表里显示，默认 cron 保留。
    // 没账号时是“未就绪”（灰），不是“失败”（红）。
    surface: 'panel',
    summary: summaryFor(store, '日常'),
    blockers: blockersFor(store, '日常'),
  },
);

debug(`mcloud-daily：任务「日常」（预算 ${BUDGET_MS / 1000}s，共享粗粒度 lane）`);
