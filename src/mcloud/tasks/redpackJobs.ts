// 红包派对的**单条任务链**：一条任务从"该做"到"回查确认"之间那几枪。
//
// 上层（`tasks/redpack.ts`）管整趟的进度（换票 / 读表 / 签到 / 逐条派发 / 收尾余额），
// 这里只管**一条**。分成两个文件是因为一条任务的链最长（装机那一支要七八枪），
// 而它跟整趟的台账没有关系 —— 混在一起就是一条"一锅状态机"，出错时说不清是哪一层。
//
// # 一次调用只走一段
//
// 每个 `stage` 最多发两枪（`phones` 那一段是 ACTIVE + PENDING 两发**只读**，
// 因为它们必须成对才有意义）。等待（浏览那 15 秒、装机轮询那 1 秒）切成小口，
// 一口一步 —— 这样 `drain` 的时间上限能发生在**等待期间**，
// 而不是等我们睡满 15 秒才发现早就超时了。
//
// # 文案就是参照实现让用户看到的那几句
//
// `去完成: X (0.10元)` / `已登记: X (未完成)` / `需手动完成: X (无云手机)` /
// `奖励: X +0.50元` —— 句子逐字照 `mcloud-sign` 那一份。**不加**步骤名前缀
// （行首的「红包派对」由日志层补，见 `tasks/stepLog.ts::userLine`）。
//
// 同一句"没做成"在不同任务里说法**不一样**，这不是啰嗦，是上游给的事实不一样：
//   · 普通任务登记过、表里还是 0 ⇒ `已登记: X (未完成)`；
//   · 「每日使用云机」⇒ `需手动完成: X (需云机内实际使用)`（哪怕一台云机都没有 ——
//     参照实现与真机读数都是这一句，「无云手机」那句只属于装机那一条）；
//   · 装机装上了、表里还是 0 ⇒ `已安装应用: <apk>`（做成了什么，不是没做成）；
//   · 装机把列表问完也没成 ⇒ `未找到可安装应用: X`。
//
// ⚠ 两处**刻意**的不同：
//   · 读到没见过的状态码时这里不发写请求，只按「暂不可做」说一句，
//     判据在 `redpackRules.classify`，理由写在那儿；
//   · 每行的**着色**由 `stepLog.lineLevel` 按整仓库统一的规矩判，
//     跟参照实现逐行写的 `debug/success/info` 可能有出入 —— 句子与句子的**有无**
//     照它，颜色不照它（那边的 debug 与 info 在我们这边都出线，只是标签不同）。

import {
  accountInfoRequest,
  appListRequest,
  apkInstallRequest,
  browseRequest,
  callRedpack,
  cloudPhonesRequest,
  completeTaskRequest,
  hwTokenRequest,
  installStatusRequest,
  installTaskStatusRequest,
  makeRedpackCall,
  rcsTokenRequest,
  reportInstallRequest,
  rpStr,
  taskListRequest,
  toastInfoRequest,
  topicAnswerRequest,
  topicListRequest,
} from '../redpackApi.ts';
import {
  INSTALL_STATUS_EXISTS,
  INSTALL_TASK_DONE,
  INSTALL_TASK_FAILED,
  amountSuffix,
  answerLetter,
  classify,
  manualReason,
  parseApps,
  parsePhones,
  parseTaskList,
  parseTopic,
  pickPhone,
  phoneUsable,
  readBalance,
  readInstallProgress,
  readInstallStart,
  readInstallStatus,
  readReward,
  readWriteStatus,
  sendableId,
  statusLabel,
  yuan2,
  yuanRaw,
} from '../redpackRules.ts';
import { depsNowMs, waitMs } from './base.ts';
import type { TaskDeps } from './base.ts';
import { alreadyWritten, markWritten, rpLine, saveRedpackState } from './redpackState.ts';
import type { RedpackJob, RedpackQueueApp, RedpackStage, RedpackState } from './redpackState.ts';

/** 这一族三处等待的时长（参照实现里是三个写死的 `sleep`）。
 *
 *  ⚠ `browseSliceMs` 是**我们自己切的**：参照实现一口气睡 15 秒（那边是异步的），
 *  我们这边没有可用的计时器（沙箱里不算），只能像 `appTask` 那样忙等 ——
 *  忙等一整个 15 秒会让"到点收手"在等待期间完全不生效。 */
export const REDPACK_PLAN = {
  browseWaitMs: 15_000,
  browseSliceMs: 3_000,
  topicTries: 15,
  topicGapMs: 150,
  pollTries: 60,
  pollGapMs: 1_000,
};

/** 一段走完之后的去向。 */
export type JobStep =
  /** 同一条任务还有下一段（`drain` 会立刻再来一步） */
  | { kind: 'again' }
  /** 这一条处置完了（人话已经进台账） */
  | { kind: 'done' }
  /** 这一条**明确失败**（已经发出去的写请求退不回来，但整趟要如实报出来） */
  | { kind: 'failed'; note: string };

/** 一条链要的四样东西：怎么发、什么时候、给谁记账、指到哪。 */
export interface RedpackCtx {
  deps: TaskDeps;
  st: RedpackState;
  base: string | undefined;
}

/** 现算一次调用（时间戳与 requestId 跟着此刻走）。 */
function callOf(ctx: RedpackCtx): ReturnType<typeof makeRedpackCall> {
  return makeRedpackCall(ctx.st.token ?? '', depsNowMs(ctx.deps));
}

/** 发一枪。失败时**只**回信封（那句人话由调用方决定怎么说，别在这里替它加行）。 */
function send(ctx: RedpackCtx, req: Parameters<typeof callRedpack>[1]) {
  return callRedpack(ctx.deps.transport, req);
}

const suffixOf = (job: RedpackJob): string => amountSuffix({ amount: job.amount });

/** 走一条任务的下一段。 */
export function runRedpackJob(ctx: RedpackCtx): JobStep {
  const job = ctx.st.job;
  if (job === undefined) return { kind: 'done' };
  switch (job.stage) {
    case 'begin':
      return begin(ctx, job);

    case 'complete': {
      const id = sendableId(job.id);
      if (id === undefined) {
        // 活动站没给可用的编号 ⇒ 这一枪根本发不出去（`taskId` 空着发只会得到一个含糊的码）
        return fail(ctx, `任务失败: ${job.taskName} 活动站没给编号`);
      }
      if (alreadyWritten(ctx.st, job.taskCode)) {
        // 今天已经为它发过写请求 ⇒ 不再发，但**照样回查一次**，句子按这一条的种类说。
        // ⚠ 这里直接印「已登记」就收工的话，「每日使用云机」那一会在第二趟变成
        //   「已登记: … (未完成)」—— 而它的人话口径是「需云机内实际使用」（见 `confirmUse`），
        //   一天两趟的用户会看到同一件事换了一种说法。
        const recheck = readOnlyConfirm(job.kind);
        if (recheck === undefined) {
          // 装机那一支**没有**只读的出路：它的回查链要问应用列表、要装包 ⇒ 只能说登记过了
          rpLine(ctx.st, `已登记: ${job.taskName} (${statusLabel(job.status ?? 0)})`);
          return { kind: 'done' };
        }
        return go(ctx, job, recheck);
      }
      const env = send(ctx, completeTaskRequest(callOf(ctx), id, ctx.base));
      if (!env.ok) return fail(ctx, `任务失败: ${job.taskName} ${env.error ?? '接口没回来'}`);
      const status = readWriteStatus(env.data);
      // ⚠ 这一枪**宽松**：缺 `status` 不当失败（参照实现也是 `!isNil(status) && status!==1`）。
      //   事实是"我们已经把这条报上去了"，回执不给状态不等于没做成。
      if (status !== undefined && status !== 1) {
        return fail(ctx, `任务失败: ${job.taskName} ${env.error ?? '活动站说没成'}`);
      }
      markWritten(ctx.st, job.taskCode);
      ctx.st.board.writes += 1;
      return go(ctx, job, nextAfterComplete(job.kind));
    }

    case 'waitBrowse': {
      const slept = job.sleptMs ?? 0;
      if (slept >= REDPACK_PLAN.browseWaitMs) return go(ctx, job, 'browse');
      waitMs(ctx.deps, REDPACK_PLAN.browseSliceMs);
      ctx.st.job = { ...job, sleptMs: slept + REDPACK_PLAN.browseSliceMs };
      return { kind: 'again' };
    }

    case 'browse': {
      const env = send(ctx, browseRequest(callOf(ctx), job.taskCode, ctx.base));
      if (!env.ok) return fail(ctx, `浏览确认失败: ${job.taskName}`);
      ctx.st.board.writes += 1;
      return go(ctx, job, 'confirm');
    }

    case 'phones':
      return phones(ctx, job);

    case 'rcs': {
      // 有副作用的一发（它算"进过一次云机"）；回执参照实现**不看**
      send(ctx, rcsTokenRequest(callOf(ctx), '0', ctx.base));
      return go(ctx, job, 'confirmUse');
    }

    case 'apps': {
      const env = send(ctx, appListRequest(callOf(ctx), ctx.base));
      const apps = env.ok ? parseApps(env.data) : [];
      if (apps.length === 0) return fail(ctx, `应用列表为空: ${job.taskName}`);
      ctx.st.job = { ...job, apps, appIndex: 0, stage: 'hw' };
      return { kind: 'again' };
    }

    case 'hw': {
      const env = send(ctx, hwTokenRequest(callOf(ctx), ctx.base));
      const hwToken = env.ok ? rpStr(env.data, 'hwToken') : undefined;
      if (hwToken === undefined) return fail(ctx, `hwToken获取失败: ${job.taskName}`);
      ctx.st.job = { ...job, hwToken, stage: 'status' };
      return { kind: 'again' };
    }

    case 'status':
      return installStatus(ctx, job);

    case 'installStart':
      return installStart(ctx, job);

    case 'installPoll':
      return installPoll(ctx, job);

    case 'report': {
      const app = (job.apps ?? [])[job.appIndex ?? 0];
      if (app === undefined) return notFoundApp(ctx, job);
      const taskId = sendableId(job.id);
      const appId = sendableId(app.id);
      if (taskId === undefined || appId === undefined) {
        // 编号不认识 ⇒ 这一枪没法上报（装机的动作已经发生了，只说上报没成）
        return fail(ctx, `上报装机结果没成: ${job.taskName} 活动站没给编号`);
      }
      const env = send(
        ctx,
        reportInstallRequest(callOf(ctx), taskId, appId, job.reportedExists === true ? 1 : undefined, ctx.base),
      );
      if (env.ok) ctx.st.board.writes += 1;
      // ⚠ `reportedExists` **留着**：下一段要靠它区分「已经装好、只上报」与「这次真装了」
      //   —— 前者没成要换下一个应用，后者没成要说「已安装应用: X」
      return go(ctx, job, 'confirmInstall');
    }

    case 'topicList':
      return topicList(ctx, job);

    case 'topicAnswer':
      return topicAnswer(ctx, job);

    case 'confirm':
      return confirm(ctx, job);

    case 'confirmUse':
      return confirmUse(ctx, job);

    case 'confirmInstall':
      return confirmInstall(ctx, job);

    case 'reward':
      return reward(ctx, job);

    default:
      return fail(ctx, `任务失败: ${job.taskName} 走到了不认识的一段`);
  }
}

/** 这一条要不要做（四档判据在这里落地）。 */
function begin(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const state = classify(job.status);
  const name = job.taskName;
  if (state === 'done') {
    rpLine(ctx.st, `已完成: ${name}${suffixOf(job)}`);
    return { kind: 'done' };
  }
  if (state === 'blocked' || state === 'unknown') {
    // `unknown`（没见过的码）与 `blocked` 说一句同样的话，但括号里**如实**写
    // 「没见过的状态 2」—— 不发写请求的理由就在这句里（见 `redpackRules` 文件头）。
    rpLine(ctx.st, `暂不可做: ${name} (${statusLabel(job.status)})`);
    return { kind: 'done' };
  }
  rpLine(ctx.st, `去完成: ${name}${suffixOf(job)}`);
  if (job.kind === 'manual') {
    rpLine(ctx.st, `需手动完成: ${name}${suffixOf(job)} (${manualReason(job.taskCode)})`);
    ctx.st.board.manual += 1;
    return { kind: 'done' };
  }
  return go(ctx, job, 'complete');
}

function nextAfterComplete(kind: RedpackJob['kind']): RedpackJob['stage'] {
  if (kind === 'browse') return 'waitBrowse';
  if (kind === 'direct') return 'confirm';
  if (kind === 'topic') return 'topicList';
  // 云机使用与装机都要先问"有没有能用的云机"
  return 'phones';
}

/** 「这条今天已经写过了」之后还能走的**只读**回查段。
 *
 *  ⚠ 装机那一支给 `undefined`：它的回查链（问云机 → 问应用列表 → 装包 → 上报）
 *  整条都是往用户的云机里做事，不能因为"再确认一下"就走一遍。 */
function readOnlyConfirm(kind: RedpackJob['kind']): RedpackStage | undefined {
  if (kind === 'install') return undefined;
  if (kind === 'cloudUse') return 'confirmUse';
  return 'confirm';
}

/** ACTIVE + PENDING 两发只读（只问一档会把待激活那台漏掉）。
 *
 * ⚠ 两条链对"没有云机"的反应**不一样**，而且这是用户看得到的一行：
 *   · 装机（`MONTHLY_2`）没云机就没法装 ⇒ 「需手动完成: X (无云手机)」，这一条到此为止；
 *   · 使用云机（`DAILY_1`）**照样走到底**：登记那一枪已经发出去了，之后只是回查，
 *     表里还是 0 就说「需手动完成: X (需云机内实际使用)」——真机读数里那一次没有云机，
 *     打的正是这一句（不是「无云手机」）。 */
function phones(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const found: ReturnType<typeof parsePhones> = [];
  for (const status of ['ACTIVE', 'PENDING'] as const) {
    const env = send(ctx, cloudPhonesRequest(callOf(ctx), status, ctx.base));
    if (env.ok) found.push(...parsePhones(env.data));
  }
  if (job.kind === 'cloudUse') {
    // 参照实现这里只看"有没有云机"（锁不锁都算有），有才发那一发"进过一次云机"
    return go(ctx, job, found.length > 0 ? 'rcs' : 'confirmUse');
  }
  if (found.length === 0) {
    rpLine(ctx.st, `需手动完成: ${job.taskName} (无云手机)`);
    ctx.st.board.manual += 1;
    return { kind: 'done' };
  }
  const one = pickPhone(found);
  if (one === undefined || !phoneUsable(one)) {
    rpLine(ctx.st, `需手动完成: ${job.taskName} (云机锁屏)`);
    ctx.st.board.manual += 1;
    return { kind: 'done' };
  }
  return go(ctx, { ...job, instanceId: one.instanceId }, 'apps');
}

/** 装机前先问"这台云机上装过没有"：已经装过 ⇒ 只上报，不再装。 */
function installStatus(ctx: RedpackCtx, job: RedpackJob): JobStep {
  // 换票那一趟被打断之后回来时票可能没了 ⇒ 先补一次华为侧的票
  if ((job.hwToken ?? '') === '' && (job.apps?.length ?? 0) > 0) return go(ctx, job, 'hw');
  const app = (job.apps ?? [])[job.appIndex ?? 0];
  if (app === undefined || (job.hwToken ?? '') === '') return notFoundApp(ctx, job);
  const env = send(
    ctx,
    installStatusRequest(callOf(ctx), job.hwToken ?? '', job.instanceId ?? '', app.packageName, ctx.base),
  );
  const status = env.ok ? readInstallStatus(env.data) : undefined;
  // 读不到状态也照样去装：参照实现只看 `installStatus === 2` 那一格
  return status === INSTALL_STATUS_EXISTS
    ? go(ctx, { ...job, reportedExists: true }, 'report')
    : go(ctx, job, 'installStart');
}

function installStart(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const app = (job.apps ?? [])[job.appIndex ?? 0];
  if (app === undefined) return notFoundApp(ctx, job);
  const env = send(
    ctx,
    apkInstallRequest(callOf(ctx), job.instanceId ?? '', String(app.packageId), job.hwToken ?? '', ctx.base),
  );
  const started = env.ok ? readInstallStart(env.data) : { started: false, taskId: '' };
  if (!started.started) {
    // 这一发没成 ⇒ 换下一个应用（参照实现的 `continue`）
    return go(ctx, { ...job, appIndex: (job.appIndex ?? 0) + 1 }, 'status');
  }
  ctx.st.board.writes += 1;
  return go(ctx, { ...job, installTaskId: started.taskId, pollTries: 0 }, 'installPoll');
}

/** 装机进度：2 成功、3 失败、其余继续等（最多 60 轮，每轮 1 秒）。 */
function installPoll(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const env = send(ctx, installTaskStatusRequest(callOf(ctx), job.hwToken ?? '', job.installTaskId ?? '', ctx.base));
  const progress = env.ok ? readInstallProgress(env.data) : undefined;
  if (progress === INSTALL_TASK_DONE) return go(ctx, { ...job, reportedExists: undefined }, 'report');
  if (progress === INSTALL_TASK_FAILED) {
    return go(ctx, { ...job, appIndex: (job.appIndex ?? 0) + 1, installTaskId: undefined }, 'status');
  }
  const tries = (job.pollTries ?? 0) + 1;
  if (tries >= REDPACK_PLAN.pollTries) {
    return go(ctx, { ...job, appIndex: (job.appIndex ?? 0) + 1, pollTries: 0, installTaskId: undefined }, 'status');
  }
  waitMs(ctx.deps, REDPACK_PLAN.pollGapMs);
  ctx.st.job = { ...job, pollTries: tries };
  return { kind: 'again' };
}

/** 题库最多重取 15 轮（参照实现那个循环是给"上游刚发题时要等一下"的）。 */
function topicList(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const env = send(ctx, topicListRequest(callOf(ctx), ctx.base));
  const topic = env.ok ? parseTopic(env.data) : undefined;
  if (topic === undefined) return fail(ctx, `题库为空: ${job.taskName}`);
  const letter = answerLetter(topic);
  if (letter !== undefined) {
    return go(ctx, { ...job, topicId: topic.id, topicQuestion: topic.question, topicAnswer: letter }, 'topicAnswer');
  }
  const tries = (job.topicTries ?? 0) + 1;
  if (tries >= REDPACK_PLAN.topicTries) return unknownTopic(ctx, job, topic.question);
  waitMs(ctx.deps, REDPACK_PLAN.topicGapMs);
  ctx.st.job = { ...job, topicTries: tries };
  return { kind: 'again' };
}

function topicAnswer(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const letter = job.topicAnswer ?? '';
  if (letter === '') return unknownTopic(ctx, job, job.topicQuestion ?? '');
  const taskId = Number(job.id);
  const topicId = Number(job.topicId);
  if (!Number.isFinite(taskId) || !Number.isFinite(topicId)) {
    return fail(ctx, `答题失败: ${job.taskName} 活动站给的编号不是数字`);
  }
  // ⚠ 答题是**严格**判据：只有 `status === 1` 才算做成（参照实现也这样）
  const env = send(ctx, topicAnswerRequest(callOf(ctx), taskId, topicId, letter, ctx.base));
  const status = env.ok ? readWriteStatus(env.data) : undefined;
  if (!env.ok || status !== 1) return fail(ctx, `答题失败: ${job.taskName} ${env.error ?? '活动站说没成'}`);
  markWritten(ctx.st, job.taskCode);
  ctx.st.board.writes += 1;
  rpLine(ctx.st, `已完成: ${job.taskName}`);
  return go(ctx, job, 'reward');
}

/** 回查：写完再读一次表，**用表里的状态说话**。
 *
 *  ⚠ 这是"这一条到底做成没有"的唯一判据 —— 写请求的回执只说明请求被接受了
 *  （App 任务那边踩过同一课：三枪全回 200 而状态一条没变）。
 *  回查本身失败**不判失败**：照登记过的事实说一句（参照实现 `?? task` 同一个选择）。 */
function confirm(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const status = reRead(ctx, job);
  if (status === 1) {
    rpLine(ctx.st, `已完成: ${job.taskName}`);
    return go(ctx, { ...job, status }, 'reward');
  }
  rpLine(ctx.st, `已登记: ${job.taskName} (${statusLabel(status)})`);
  return { kind: 'done' };
}

/** 「每日使用云机」那一条的回查。
 *
 *  ⚠ 它**不说**「已登记」：这一条的实情是"要人在云机里真用过"，所以我们发完登记、
 *  发完"进过一次云机"那一枪之后，表里还是 0 就是**还没被用过** ——
 *  参照实现说的正是「需手动完成: X (需云机内实际使用)」，真机读数也是这一句。 */
function confirmUse(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const status = reRead(ctx, job);
  if (status === 1) {
    rpLine(ctx.st, `已完成: ${job.taskName}`);
    return go(ctx, { ...job, status }, 'reward');
  }
  rpLine(ctx.st, `需手动完成: ${job.taskName} (需云机内实际使用)`);
  ctx.st.board.manual += 1;
  return { kind: 'done' };
}

/** 装机那一条的回查：三条出路，都照参照实现让用户看到不同的句子。
 *
 *   · 表里 1 ⇒ 「已完成: X」+ 那条奖；
 *   · **这次真装了**但表里还是 0 ⇒ 「已安装应用: <包名>」（装是装上了，
 *     活动站那边还没认 —— 这一句说的是我们做成了什么，不是"没做成"）；
 *   · 只上报过"这台云机上早装好了"而表里还是 0 ⇒ **换下一个应用**（参照实现的
 *     `continue`）；应用问完了还没成 ⇒ 「未找到可安装应用: X」。 */
function confirmInstall(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const status = reRead(ctx, job);
  if (status === 1) {
    rpLine(ctx.st, `已完成: ${job.taskName}`);
    return go(ctx, { ...job, status }, 'reward');
  }
  if (job.reportedExists === true) {
    return go(
      ctx,
      { ...job, reportedExists: undefined, appIndex: (job.appIndex ?? 0) + 1, installTaskId: undefined },
      'status',
    );
  }
  const app = (job.apps ?? [])[job.appIndex ?? 0];
  rpLine(ctx.st, `已安装应用: ${appName(app)}`);
  return { kind: 'done' };
}

/** 应用显示名：`apkName` 缺格时用包名（照参照实现的 `|| packageName`）。 */
function appName(app: RedpackQueueApp | undefined): string {
  if (app === undefined) return '';
  return app.apkName !== '' ? app.apkName : app.packageName;
}

/** 重新读一次表，把这一条的状态更新回队列，**只回状态**（怎么说由调用方定）。
 *
 *  读不到 ⇒ 0（参照实现的 `refreshed?.userStatus === 1`：回查失败就不是"做成了"）。 */
function reRead(ctx: RedpackCtx, job: RedpackJob): number {
  const env = send(ctx, taskListRequest(callOf(ctx), ctx.base));
  if (!env.ok) return job.status ?? 0;
  const found = parseTaskList(env.data).tasks.find((t) => t.taskCode === job.taskCode);
  const status = found?.status ?? 0;
  const item = ctx.st.queue.find((q) => q.taskCode === job.taskCode);
  if (item !== undefined) item.status = status;
  return status;
}

/** 这一条刚拿到的奖（只读）。上游没给金额时**不打行**（参照实现也吞）。 */
function reward(ctx: RedpackCtx, job: RedpackJob): JobStep {
  const line = readRewardLine(ctx, job.taskCode, job.taskName);
  if (line !== undefined) rpLine(ctx.st, line);
  return { kind: 'done' };
}

/** 「奖励: <名> +0.50元」那一行（只读一发 `userToastInfo`）。
 *
 *  上游没给金额 ⇒ `undefined`（参照实现这时**不打行** —— 少打一行也是改动可见输出，
 *  所以这里跟着不打）。`defaultName` 是奖品名缺格时的兜底（参照实现传任务名）。 */
export function readRewardLine(
  ctx: RedpackCtx,
  taskCode: string,
  defaultName: string,
): string | undefined {
  const env = send(ctx, toastInfoRequest(callOf(ctx), taskCode, ctx.base));
  if (!env.ok) return undefined;
  const prize = readReward(env.data);
  if (prize === undefined) return undefined;
  return `奖励: ${prize.name === '' ? defaultName : prize.name} +${yuan2(prize.cents)}`;
}

/** 应用列表问完了还没成 ⇒ 「未找到可安装应用: X」。
 *
 *  ⚠ 参照实现这里**不**说「需手动完成」（那是给"人还能动"的出口留的措辞），
 *  也不折进上一句：装机这一条到此明确没成，后面整趟照旧往下走。 */
function notFoundApp(ctx: RedpackCtx, job: RedpackJob): JobStep {
  return fail(ctx, `未找到可安装应用: ${job.taskName}`);
}

function unknownTopic(ctx: RedpackCtx, job: RedpackJob, question: string): JobStep {
  rpLine(ctx.st, `需手动完成: ${job.taskName} (未知题目: ${question})`);
  ctx.st.board.manual += 1;
  return { kind: 'done' };
}

function fail(ctx: RedpackCtx, note: string): JobStep {
  rpLine(ctx.st, note);
  return { kind: 'failed', note };
}

/** 换段：把下一段写进台账并告诉上层"这条还没走完"。 */
function go(ctx: RedpackCtx, job: RedpackJob, stage: RedpackJob['stage']): JobStep {
  ctx.st.job = { ...job, stage };
  return { kind: 'again' };
}

/** 余额那一行（**头尾各一次**：照参照实现，两句一样时也照打）。 */
export function readBalanceLine(
  deps: TaskDeps,
  st: RedpackState,
  base: string | undefined,
): string | undefined {
  const env = callRedpack(deps.transport, accountInfoRequest(makeRedpackCall(st.token ?? '', depsNowMs(deps)), base));
  if (!env.ok) return undefined;
  const { can, total } = readBalance(env.data);
  return `余额: 可用${yuanRaw(can)}元，累计${yuanRaw(total)}元`;
}

/** 存盘（每一段都落一次：被打断时下一次接着走）。 */
export function persistRedpack(store: RedpackCtx['deps']['store'], st: RedpackState, nowIso: string): void {
  saveRedpackState(store, st, nowIso);
}
