// 任务：红包派对（移动云手机的活动站）—— **整趟**的编排。
//
// # 这一族分成五个文件，各管一段
//
// ```text
//   redpackApi.ts             只造请求、只解信封（不认识"该不该发"）
//   redpackRules.ts           纯判定（状态码 → 四档、题面 → 答案、金额 → 文案）
//   tasks/redpackState.ts     状态键、形状、"给用户看的行"的账
//   tasks/redpackJobs.ts      **一条**任务的那条链（登记 → 等待 → 确认 → 回查）
//   tasks/redpack.ts（本文件） **整趟**：换票 → 读表 → 余额 → 签到 → 逐条派发 → 收尾余额
// ```
//
// 为什么这么切：整趟的进度与单条任务的进度是两套状态（一条任务走到第 4 段时，
// 整趟还停在「逐条派发」那一段）。混在一起就是一条三百行的 if 链，出错时
// 说不清是"这条任务的第 4 段"还是"整趟的第 6 步"。
//
// # 用户看到的那几句**逐字**照参照实现
//
// 判据是"用户看到的与参照实现一致"，不是"实现一致"。参照实现那一次成功运行的
// 逐行产出留了档（`mcloud-sign/packages/api/data/history.json`，2026-09-16 两个账号
// 各 3.7s / 3.9s 判成功），那十行就是这里的规格：
//
// ```text
//   余额: 可用3元，累计4.6元
//   去完成: 每日签到 (0.10元)
//   已完成: 每日签到
//   每日任务
//   需手动完成: 每日使用云机 (需云机内实际使用)
//   每月任务
//   已登记: 打开云手机消息通知 (未完成)
//   需手动完成: 在云手机里安装应用 (无云手机)
//   需手动完成: 体验任意一款云应用 (0.10元) (未知任务)
//   已完成: 去体验AI灵犀 (0.30元)
//   余额: 可用3元，累计4.6元
// ```
//
// 两处**刻意**的写法，别"顺手统一"：
//   · 余额那句 `3` / `4.6` **不补零**，任务与奖励那句 `0.10元` **补两位** ——
//     上游给的都是分，但这两种读法都是用户看到的（统一成一种就是改动可见输出）；
//   · 头和尾各打一次余额，**两句完全一样时也照打**（所以 `rpLine` 不去重）。
//
// # 与参照实现**不同**的地方只有三处，都是刻意留的
//
//   ① 读到没见过的状态码 ⇒ **不发写**，只说一句「暂不可做 …（没见过的状态 N）」。
//      参照实现会把陌生码当"未完成"照打写请求（判据与理由在 `redpackRules.classify`）。
//   ② 同一条任务**一天只写一次**（`written` 按天存）。面板的日常一天两趟，
//      第二趟是兜底 —— 而"登记过但表里还是 0"的那几条（真机读数里的
//      `已登记: 打开云手机消息通知 (未完成)`）要是第二趟再登记一遍，
//      就是在往活动站重复报同一条。
//   ③ 活动站票与华为侧的票**跑完就抹**（`finishRedpack`），不跨趟复用 ——
//      这张票的有效期**一条样本都没有**，留着等于留一份不知道什么时候烂的凭据。
//      ⇒ 代价是每趟多两发只读（换 SSO + 换票），参照实现自己也是每趟换。
//
// # 换票那一格**没有实拍**，说清是怎么定的
//
// 参照实现打的是旧的 `querySpecToken`（GET）。本仓库在用的那一支是
// `querySpecTokenV2`（POST）—— 签到族与直播族都靠它换到过 SSO 票，有真跑读数。
// 这里复用仓库里那套**已跑通**的构造器，只把 `toSourceId` 换成这一族的 `001216`。
// 判据是"当前客户端在用哪一支"，不是"旧实现用了哪一支"。
// ⚠ `toSourceId=001216` 本身**照的是参照实现**，未实拍 —— 真跑第一次的读数才算数。
// 换不到票时那一步会如实说「红包派对登录失败: …」，不会静当成"今天没任务"。

import { callRawText } from '../client.ts';
import { parseSsoToken, specTokenRequest } from '../h5session.ts';
import { loadAuthRaw, STATE_DEVICE_ID } from '../sessionExchange.ts';
import {
  REDPACK_SSO_SOURCE_ID,
  makeRedpackCall,
  taskListRequest,
  tokenValidateRequest,
  userSignRequest,
  callRedpack,
} from '../redpackApi.ts';
import {
  amountSuffix,
  classify,
  dispatchKind,
  parseTaskList,
  readRedpackToken,
  readWriteStatus,
  statusLabel,
} from '../redpackRules.ts';
import type { RedpackTaskList } from '../redpackRules.ts';
import { depsNowMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { readBalanceLine, readRewardLine, runRedpackJob } from './redpackJobs.ts';
import type { JobStep, RedpackCtx } from './redpackJobs.ts';
import {
  finishRedpack,
  loadRedpackBase,
  loadRedpackState,
  newRedpackState,
  redpackDay,
  redpackEnabled,
  rpLine,
  saveRedpackState,
  summarize,
} from './redpackState.ts';
import type { RedpackQueueItem, RedpackState } from './redpackState.ts';

/** 整趟的调度上限（`dailyRun` 那边用）。
 *
 *  ⚠ `deadlineMs` **不能超过 App 任务那一档（60 秒）**：日常整趟的预算是 120 秒，
 *  红包之后还有领取、清理、今日云朵。给这一族 90 秒的
 *  表现是"红包跑爽了，后面每一步都说走到时间上限"。
 *  参照实现整趟实测 3.7 秒，所以 60 秒不是将就，是宽松。 */
export const REDPACK_BUDGET = { maxSteps: 90, deadlineMs: 60_000 };

/** 开没开（**默认开**）。
 *
 *  参照实现的账号默认值就是 `红包派对.开启 = true` ⇒ "没写过这一格"必须是开着。
 *  自造一道默认关的闸，等于偷偷把这一族停掉，而日志里一句都不说。 */
export function redpackOn(deps: TaskDeps): boolean {
  return redpackEnabled(deps.store);
}

/** 这一族**根本没开**时给 `idle` —— 一个请求都不发。
 *
 *  ⚠ 这里**不**判"今天已经跑过"：日常一天两趟是用户定的口径（第二趟是容错，
 *  见 `entries/daily.ts` 那段原话），而"重复发写"这件事由按天的 `written` 挡
 *  （见 `redpackState.ts` 文件头），不由这道闸挡。 */
export function redpackGate(deps: TaskDeps): TaskOutcome {
  if (redpackOn(deps)) return { ok: true, idle: false, note: '' };
  return { ok: true, idle: true, skipped: true, note: '这一族没开（账号设置里可以开）' };
}

function save(deps: TaskDeps, st: RedpackState): void {
  saveRedpackState(deps.store, st, deps.nowIso);
}

/** 此刻现算一次调用（时间戳与 `requestId` 都跟着此刻走）。 */
function callOf(deps: TaskDeps, st: RedpackState): ReturnType<typeof makeRedpackCall> {
  return makeRedpackCall(st.token ?? '', depsNowMs(deps));
}

/** 推进一步。**一次调用最多两发上游请求**（只有换票那一步成对）。
 *
 *  为什么不一次从头跑到尾：面板一次调用只有一个执行预算，而这一族最长的一条
 *  要等 15 秒（浏览确认）。`dailyRun` 那边用 `drain` 把"一次一步"包成
 *  "一次跑完"，所以日志上仍然是一步一行。 */
export function redpackStep(deps: TaskDeps): TaskOutcome {
  const day = redpackDay(deps.nowIso);
  const base = loadRedpackBase(deps.store);
  const st = beginLeg(deps, day);

  switch (st.phase) {
    case 'login':
      return login(deps, st, base);

    case 'list':
      return readList(deps, st, base);

    case 'balanceBefore': {
      const line = readBalanceLine(deps, st, base);
      if (line !== undefined) rpLine(st, line);
      st.phase = 'sign';
      save(deps, st);
      return { ok: true, note: '读了进来的余额' };
    }

    case 'sign':
      return dailySign(deps, st, base);

    case 'signReward':
      return signReward(deps, st, base);

    case 'walk':
      return walk(deps, st, base);

    case 'balanceAfter': {
      const line = readBalanceLine(deps, st, base);
      if (line !== undefined) rpLine(st, line);
      finishRedpack(st);
      save(deps, st);
      return { ok: true, idle: true, note: summarize(st) };
    }

    case 'done':
      // 上一趟已经收尾了 ⇒ 直接起新的一趟（`beginLeg` 干的），走到这里就是没有进度
      return { ok: true, idle: true, note: summarize(st) };
  }
}

/** 起这一趟：接着今天那一份走；今天那份已经收尾 ⇒ 另起一份，**但把按天的账带过去**。
 *
 *  ⚠ 第二趟不能把 `written` 清空 —— 那是"今天已经为哪几条发过写请求"的账。 */
function beginLeg(deps: TaskDeps, day: string): RedpackState {
  const prev = loadRedpackState(deps.store, day);
  if (prev === null) {
    const fresh = newRedpackState(day, deps.nowIso);
    save(deps, fresh);
    return fresh;
  }
  if (prev.phase === 'done') {
    const fresh = newRedpackState(day, deps.nowIso, prev.written);
    save(deps, fresh);
    return fresh;
  }
  return prev;
}

// ───────────────────────── ① 换票（两发，同一次调用）─────────────────────────

/** 原生凭据 → SSO 票 → 这一族自己的活动站票。
 *
 *  两发**必须在一次调用里**：SSO 票只活几分钟（本仓库直播族实测「换到 4 分钟后
 *  重放已被拒」）⇒ 拆成两步等下一趟，拿到的就是一张过期的票，
 *  而表现是"红包派对一直登录失败"。 */
function login(deps: TaskDeps, st: RedpackState, base: string | undefined): TaskOutcome {
  const auth = loadAuthRaw(deps.store);
  if (auth === '') return badLogin(deps, st, '这个号还没有原生凭据，先在账号页把它加上');

  const ssoRes = callRawText(
    deps.transport,
    specTokenRequest({ toSourceId: REDPACK_SSO_SOURCE_ID }, auth),
  );
  if (!ssoRes.ok) return badLogin(deps, st, `换 SSO 票没回来（${ssoRes.error ?? '未知失败'}）`);
  const sso = parseSsoToken(ssoRes.text);
  if (!sso.ok || sso.value === undefined) {
    return badLogin(deps, st, `换 SSO 票没成（${sso.error ?? '响应里没有 token'}）`);
  }

  const deviceId = deps.store.getState(STATE_DEVICE_ID) ?? '';
  const env = callRedpack(
    deps.transport,
    tokenValidateRequest(callOf(deps, st), sso.value, deviceId, base),
  );
  const token = env.ok ? readRedpackToken(env.data) : undefined;
  if (token === undefined) {
    return badLogin(deps, st, `活动站不认这张票（${env.error ?? '响应里没有 token'}）`);
  }
  st.token = token;
  st.phase = 'list';
  save(deps, st);
  return { ok: true, note: '活动站的票拿到了' };
}

/** 登录没成 ⇒ 整趟收尾，**下一趟再来**（不留在 `login` 上反复撞）。
 *
 *  参照实现也是直接 return（这一族一条都不做）。区别只在它会**整天**卡在登录失败，
 *  而我们把这一趟收尾了：日常后面还有八步，红包登录失败不该让后面的步骤也跟着没结果。 */
function badLogin(deps: TaskDeps, st: RedpackState, why: string): TaskOutcome {
  rpLine(st, `红包派对登录失败: ${why}`);
  finishRedpack(st);
  save(deps, st);
  return { ok: false, note: why };
}

// ───────────────────────── ② 读任务表 ─────────────────────────

/** 读表、摊平队列、把计数与签到那一格记进台账。
 *
 *  读不到表 ⇒ 这一趟**什么都做不了**（后面每一条的判据都从这张表来），
 *  收尾并如实说没读到 —— 不能走到"逐条派发"那一段然后报"一条都没有"。 */
function readList(deps: TaskDeps, st: RedpackState, base: string | undefined): TaskOutcome {
  const env = callRedpack(deps.transport, taskListRequest(callOf(deps, st), base));
  if (!env.ok) {
    finishRedpack(st);
    save(deps, st);
    return { ok: false, note: `没读到任务表（${env.error ?? '活动站没回来'}）` };
  }
  const list = parseTaskList(env.data);
  st.queue = toQueue(list);
  for (const t of list.tasks) st.board.counts[classify(t.status)] += 1;
  // ⚠ **只有表里真有"今天"那一格才立这个账**。把它建成 `{status: undefined}` 的空壳，
  //  后面 `classify(undefined)` 会算成"未完成"⇒ 既打「去完成: 每日签到」又发那一枪写请求
  //  ——而参照实现是 `if (!today) return`：今天没有签到这一说，一行都不该打。
  st.board.sign =
    list.sign === undefined
      ? undefined
      : { status: list.sign.status, amount: list.sign.amount, wrote: false, done: false };
  if (st.queue.length === 0) rpLine(st, '任务表里一条都没有');
  st.phase = 'balanceBefore';
  save(deps, st);
  return { ok: true, note: `读到 ${st.queue.length} 条任务` };
}

/** 三个分组摊平成一条队。空组**不进队**（参照实现也是 `if (!tasks.length) continue`，
 *  于是空组那一行**不打** —— 用户看到的就没有「新手任务」那行）。 */
function toQueue(list: RedpackTaskList): RedpackQueueItem[] {
  const out: RedpackQueueItem[] = [];
  for (const g of list.groups) {
    if (g.tasks.length === 0) continue;
    for (const t of g.tasks) {
      out.push({
        taskCode: t.taskCode,
        taskName: t.taskName,
        id: t.id,
        status: t.status,
        amount: t.amount,
        group: g.title,
      });
    }
  }
  return out;
}

// ───────────────────────── ③ 每日签到 ─────────────────────────

/** 每日签到那一格（它不在三个分组里，任务表里单独一张 `configTaskSignList`）。
 *
 *  ⚠ 只认**今天**那一格（`isToday === 1`）—— 解表那种"没有今天的就把第一条当今天"
 *  的兜底不能要：那会拿**昨天**那格的状态说**今天**的事（该不该签、签到奖多少钱）。
 *  没有今天那一格 ⇒ 整段跳过，一行都不打（照参照实现）。 */
function dailySign(deps: TaskDeps, st: RedpackState, base: string | undefined): TaskOutcome {
  const sign = st.board.sign;
  if (sign === undefined) {
    st.phase = 'walk';
    save(deps, st);
    return { ok: true, note: '今天没有签到那一格' };
  }
  const state = classify(sign.status);
  if (state === 'done') {
    rpLine(st, `已完成: 每日签到${suffixOf(sign.amount)}`);
    sign.done = true;
    st.phase = 'walk';
    save(deps, st);
    return { ok: true, note: '今天已经签过了' };
  }
  if (state !== 'todo') {
    rpLine(st, `暂不可做: 每日签到 (${statusLabel(sign.status)})`);
    st.phase = 'walk';
    save(deps, st);
    return { ok: true, note: '今天这条签到先不做' };
  }
  rpLine(st, `去完成: 每日签到${suffixOf(sign.amount)}`);
  const env = callRedpack(deps.transport, userSignRequest(callOf(deps, st), base));
  const status = env.ok ? readWriteStatus(env.data) : undefined;
  if (!env.ok || status !== 1) {
    // ⚠ 签到是**严格**判据（照参照实现 `isOk && status === 1`）。它与"登记任务"
    //   那一枪不同：那一枪回执缺状态也算登记过了，这一枪没回 1 就是没签到。
    rpLine(st, `签到失败: ${env.error ?? '活动站说没成'}`);
    st.phase = 'walk';
    save(deps, st);
    return { ok: true, note: '签到没成，继续后面的任务' };
  }
  sign.wrote = true;
  sign.done = true;
  st.board.writes += 1;
  rpLine(st, '已完成: 每日签到');
  st.phase = 'signReward';
  save(deps, st);
  return { ok: true, note: '签到成了' };
}

/** 签到刚拿到的那条奖（只读）。参照实现用的码是 `SIGN_1`。 */
function signReward(deps: TaskDeps, st: RedpackState, base: string | undefined): TaskOutcome {
  const line = readRewardLine({ deps, st, base }, 'SIGN_1', '每日签到');
  if (line !== undefined) rpLine(st, line);
  st.phase = 'walk';
  save(deps, st);
  return { ok: true, note: '读了签到那条奖' };
}

/** 任务名后面的金额括注：` (0.10元)`；没有金额就空串（照参照实现）。 */
function suffixOf(amount: number | undefined): string {
  return amountSuffix({ amount });
}

// ───────────────────────── ④ 逐条派发 ─────────────────────────

/** 队列一次走一段：没有进行中的任务就取下一条，有就推进它。
 *
 *  一条任务**明确失败**时不中断整趟（参照实现也是逐条继续）—— 已经发出去的
 *  写请求收不回来，但后面每一条的判据来自刚读的那张表，与上一条成没成无关。
 *  失败那一行由 `redpackJobs` 写进台账，用户在日志里看得见。 */
function walk(deps: TaskDeps, st: RedpackState, base: string | undefined): TaskOutcome {
  const job = st.job;
  if (job === undefined) {
    if (st.cursor >= st.queue.length) {
      st.phase = 'balanceAfter';
      save(deps, st);
      return { ok: true, note: `${st.queue.length} 条都过了一遍` };
    }
    const item = st.queue[st.cursor] as RedpackQueueItem;
    if (!st.groupsShown.includes(item.group)) {
      st.groupsShown.push(item.group);
      rpLine(st, item.group);
    }
    st.job = {
      taskCode: item.taskCode,
      taskName: item.taskName,
      id: item.id,
      amount: item.amount,
      status: item.status,
      kind: dispatchKind(item.taskCode),
      stage: 'begin',
    };
    save(deps, st);
    return { ok: true, note: `开始: ${item.taskName}` };
  }

  const ctx: RedpackCtx = { deps, st, base };
  const step: JobStep = runRedpackJob(ctx);
  if (step.kind === 'again') {
    save(deps, st);
    return { ok: true, note: `进行中: ${job.taskName}` };
  }
  st.job = undefined;
  st.cursor += 1;
  save(deps, st);
  return { ok: true, note: step.kind === 'failed' ? `${job.taskName}：这一条没成` : `${job.taskName}：过了` };
}
