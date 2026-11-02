// 「算力大作战」整趟的编排 —— 日常第 ④.6 步（`dailyRun.ts` 里一段 `drain` 把它跑完）。
//
// # 这一族长什么样
//
// ```text
//   task/list ──► 计划（SUCCESS→领 / WAIT→做 / RESERVE→预约 / 其余→需手动）
//        │
//        ├─ 每条任务：click 记账 → 原生动作（上传/备份/笔记/分享/灵犀/PC 上传）
//        │                       └─ 动作做完 = 本层结束，**不代表服务端认了**
//        ├─ 复查：重新拉 task/list —— SUCCESS 的进领奖队列，WAIT 的算「待服务端确认」
//        ├─ 领奖：receivePrize（`result.prizes[].success` 才是到没到）
//        └─ 收尾：autoReceiveLotteryChance → queryHome（汇总句里的「抽奖次数+N」「累计算力X」）
// ```
//
// # 判据从哪来（用户 2026-11-01 的口径：抓包优先，没抓到的照参照实现）
//
// · 抓包：`mcloud-capture/.../app-tokenpk-playai-samples.txt` §8（2026-11-01，iOS App WebView）
//   —— `click` 在**动作之前**发、`click` 回执无 `result`、`receivePrize`/`reserve` 回
//   `{allSuccess,task,prizes}`、`openUrl` 只认 click、`RESERVE` 成功后**不再领**；
// · 参照实现：`caiyun/tasks/tokenpk.go` —— 计划分类（月上限 / inviteFriend / 未知 key 需手动）、
//   汇总句、`autoReceiveLotteryChance` + `queryHome` 的收尾两发。
//
// # 一次调用一发请求
//
// 每条任务的每个子步骤（click / create / PUT / complete / 笔记三枪 / AI 五枪）都是一步。
// `drain` 在**一次触发**里连跑，日志仍然是一条任务一行（逐行进 `DailyStep.lines`）。
//
// # ⚠ 一条没成不许拖垮整趟
//
// 动作失败、领奖没到：记 `failed` + 一行，**继续下一条**，返回 `ok:true`。
// 只有「连任务表都读不到 / 没有票」这种"这一族一步都做不了"才 `ok:false`
// （App 任务 2026-11-01 那次「一条没成整趟停」的教训，见 `docs/app-task-ids.md`）。

import { callRawText } from '../client.ts';
import { jwtFresh, loadJwt } from '../sessionExchange.ts';
import { loadSession } from '../../store/types.ts';
import type { Store } from '../../store/types.ts';
import { depsNowMs, waitMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import {
  beginLeg,
  clearAttempt,
  loadDrawDay,
  loadTokenPk,
  pkLine,
  saveDrawDay,
  saveTokenPk,
  tokenPkDraw,
  tokenPkEnabled,
} from '../tokenPkState.ts';
import type { PkQueued, PkState } from '../tokenPkState.ts';
import { claimAction, stepAction } from './tokenPkActions.ts';
import {
  chanceRequest,
  listRequest,
  lotteryRequest,
  parseChance,
  parseLottery,
  parsePk,
  parseProgress,
  parseRemainChance,
  progressRequest,
  remainChanceRequest,
} from '../tokenPk.ts';
import type { PkSession } from '../tokenPk.ts';
import { planTasks, summaryOf, tasksFrom } from '../tokenPkRules.ts';
import type { PkDrawDay } from '../tokenPkState.ts';
import type { PkAction } from '../tokenPkRules.ts';

/** 整趟的调度上限（`dailyRun` 那边用）。
 *
 *  ⚠ `deadlineMs` 比 App 任务那一档（60 秒）**还低**：它后面还有消息推送、领取、
 *  清理、今日云朵。参照实现整趟 3~8 秒，45 秒是宽松值。
 *  走到上限不是失败 —— 状态留库，下一趟接着走（日常一天两趟）。 */
export const TOKENPK_BUDGET = { maxSteps: 80, deadlineMs: 45_000 };

/** 开没开（**默认开**：参照实现 `DefaultEnabled: true`）。 */
/** 这一趟的汇总句（**给用户的结论**）。
 *
 *  ⚠ 不能直接用 `drain` 返回的 `note`：它在 40 字处截断（那是 runs 表一行摘要的口径），
 *  而这一族的结论就是那几张计数 —— 被截掉就什么都没说（与红包同一处理）。 */
function summaryFromState(st: PkState, draw: PkDrawDay): string {
  return summaryOf({
    claimed: st.claimedCount,
    executed: st.executed,
    chanceReward: st.chanceReward,
    drawn: draw.drawn,
    wins: draw.wins.length,
    usedToken: st.usedToken,
    manual: st.manual,
    failed: st.failed.length,
    pending: st.pending.length,
  });
}

export function tokenPkSummary(store: Pick<Store, 'getState'>): string | undefined {
  const st = loadTokenPk(store);
  return st === null ? undefined : summaryFromState(st, loadDrawDay(store, st.day));
}

export function tokenPkGate(deps: TaskDeps): TaskOutcome {
  if (tokenPkEnabled(deps.store)) return { ok: true, idle: false, note: '' };
  return { ok: true, idle: true, skipped: true, note: '这一族没开（账号设置里可以开）' };
}

/** 会话：H5 票（`jwttoken`）+ cookie + UA。抓包证明这一族**只认这张票**，不用另换活动站票。 */
function pkSession(deps: TaskDeps): PkSession | undefined {
  const sess = loadSession(deps.store);
  if (sess === null) return undefined;
  const rec = loadJwt(deps.store);
  if (rec === null || rec.jwt === '') return undefined;
  return {
    jwt: rec.jwt,
    cookie: sess.cookie,
    userAgent: sess.userAgent,
    deviceId: sess.deviceId,
  };
}

function save(deps: TaskDeps, st: PkState): void {
  saveTokenPk(deps.store, st, deps.nowIso);
}

function queued(a: PkAction): PkQueued {
  return {
    taskId: a.task.id,
    name: a.task.name,
    key: a.key,
    kind: a.kind,
    skipClick: a.task.currstep >= 1,
  };
}

/** 推进一步。**一次调用最多一发上游请求**（动作层保证）。 */
export function tokenPkStep(deps: TaskDeps): TaskOutcome {
  const st = beginLeg(deps.store, deps.nowIso);
  const s = pkSession(deps);

  switch (st.phase) {
    // ① 读任务表 → 排计划
    case 'list': {
      if (s === undefined) {
        return {
          ok: false,
          note: '还没有可用的 H5 票（日常第①步换票没成）—— 这一族这一趟没做',
        };
      }
      const res = callRawText(deps.transport, listRequest(s, deps.baseUrl));
      if (!res.ok) return { ok: false, note: `任务列表没读到：${res.error ?? '未知失败'}` };
      const env = parsePk(res.text);
      if (!env.ok) {
        return { ok: false, note: `任务列表没成：服务端说 ${env.message || `code=${env.code}`}` };
      }
      const tasks = tasksFrom(env.result);
      const plan = planTasks(tasks);
      st.queue = plan.actions.filter((a) => a.kind !== 'claim').map(queued);
      st.toClaim = plan.actions.filter((a) => a.kind === 'claim').map((a) => a.task.id);
      st.names = Object.fromEntries(tasks.map((t) => [String(t.id), t.name]));
      st.manual = plan.manual;
      st.phase = 'act';
      st.verified = false;
      save(deps, st);
      const bits = [`任务表 ${tasks.length} 条`];
      if (st.queue.length > 0) bits.push(`${st.queue.length} 条要做`);
      if (st.toClaim.length > 0) bits.push(`${st.toClaim.length} 条可领`);
      if (st.manual.length > 0) bits.push(`${st.manual.length} 条需手动`);
      return { ok: true, note: bits.join('，') };
    }

    // ② 逐条：登记 → 动作
    case 'act': {
      if (st.attempt === undefined) {
        const next = st.queue.shift();
        if (next === undefined) {
          st.phase = st.touched.length > 0 && st.verified !== true ? 'verify' : 'claim';
          save(deps, st);
          return { ok: true, note: '动作都做完了 —— 下一步复查服务端认不认' };
        }
        st.attempt = {
          taskId: next.taskId,
          name: next.name,
          key: next.key,
          step: next.kind === 'reserve' ? 'reserve' : 'click',
          skipClick: next.skipClick,
        };
        save(deps, st);
      }
      if (s === undefined) {
        return { ok: false, note: 'H5 票没了 —— 这一族这一趟没做完' };
      }
      const out = stepAction(deps, s, st.attempt);
      if (!out.finished) {
        save(deps, st);
        return { ok: true, note: out.note };
      }
      const name = st.attempt.name;
      const id = st.attempt.taskId;
      clearAttempt(st);
      if (out.failed === true) {
        st.failed.push({ id, name, why: out.note });
        pkLine(st, `「${name}」没成 —— ${out.note}`);
      } else {
        st.executed += 1;
        if (!st.touched.includes(id)) st.touched.push(id);
        pkLine(st, out.note);
      }
      save(deps, st);
      return { ok: true, note: out.note };
    }

    // ③ 复查：动作 ≠ 服务端认了
    case 'verify': {
      if (s === undefined) return { ok: false, note: 'H5 票没了 —— 没法复查' };
      // 动作做完服务端要一点时间才记上（参照实现睡 3 秒再复查）。抓包只看到"页面重开时
      // 已经是 SUCCESS"，看不出这个延迟 —— 按参照实现取 3 秒；测试里 `settleMs:0` 跳过。
      waitMs(deps, deps.settleMs ?? 3000);
      const res = callRawText(deps.transport, listRequest(s, deps.baseUrl));
      if (!res.ok) return { ok: false, note: `复查没读到任务表：${res.error ?? '未知失败'}` };
      const env = parsePk(res.text);
      if (!env.ok) return { ok: false, note: `复查没成：服务端说 ${env.message || `code=${env.code}`}` };
      const tasks = tasksFrom(env.result);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      let success = 0;
      let still = 0;
      for (const id of st.touched) {
        const t = byId.get(id);
        if (t === undefined) continue;
        if (t.state === 'FINISH') continue;
        // 预约成功（`RESERVE`+`SUCCESS`）既不是"可领"，也不是"在等"—— 它就是终局
        if (t.taskType === 'RESERVE') continue;
        if (t.state === 'SUCCESS' && t.taskType !== 'RESERVE') {
          if (!st.toClaim.includes(id)) st.toClaim.push(id);
          success += 1;
          continue;
        }
        if (!st.pending.includes(id)) st.pending.push(id);
        still += 1;
      }
      // 顺手收下"本来就是 SUCCESS、上一趟没领成"的（页面也是每次刷新都列出来）
      for (const t of tasks) {
        if (t.state === 'SUCCESS' && t.taskType !== 'RESERVE' && !st.claimedIds.includes(t.id)) {
          if (!st.toClaim.includes(t.id)) st.toClaim.push(t.id);
        }
      }
      st.verified = true;
      st.phase = 'claim';
      save(deps, st);
      return { ok: true, note: `复查：${success} 条翻成可领、${still} 条还在等（共 ${tasks.length} 条）` };
    }

    // ④ 领奖（一条一发）
    case 'claim': {
      if (s === undefined) return { ok: false, note: 'H5 票没了 —— 没法领奖' };
      const id = st.toClaim.find((x) => !st.claimedIds.includes(x));
      if (id === undefined) {
        st.phase = 'chance';
        save(deps, st);
        return { ok: true, note: '该领的领完了 —— 下一步收尾读数' };
      }
      const name = st.names[String(id)] ?? `#${id}`;
      const r = claimAction(deps, s, id, name);
      st.claimedIds.push(id);
      if (r.ok) {
        st.claimedCount += 1;
        // 领到的这条已经 FINISH：从 pending 里摘掉
        st.pending = st.pending.filter((x) => x !== id);
        pkLine(st, r.note);
      } else {
        st.failed.push({ id, name, why: r.note });
        pkLine(st, r.note);
      }
      save(deps, st);
      return { ok: true, note: r.note };
    }

    // ⑤ 领抽奖次数（参照实现的收尾第一发；**是写**，但幂等：没有可换的就是 0/0）
    case 'chance': {
      if (s === undefined) return { ok: false, note: 'H5 票没了 —— 没法读抽奖次数' };
      const res = callRawText(deps.transport, chanceRequest(s, deps.baseUrl));
      if (!res.ok) {
        // 收尾失败不染红整趟：汇总句里只是少一格
        st.phase = 'progress';
        save(deps, st);
        return { ok: true, note: `领抽奖次数没成（${res.error ?? '未知失败'}）—— 继续读进度` };
      }
      const env = parsePk(res.text);
      if (env.ok) st.chanceReward = parseChance(env.result);
      st.phase = 'draw';
      save(deps, st);
      return { ok: true, note: `抽奖次数 +${st.chanceReward}` };
    }

    // ⑤.5 代抽（可选，缺省关）：一次调用抽一次，上限按天算
    case 'draw': {
      const cfg = tokenPkDraw(deps.store);
      const ledger = loadDrawDay(deps.store, st.day);
      if (!cfg.enabled || cfg.max <= 0 || ledger.drawn >= cfg.max) {
        st.phase = 'progress';
        save(deps, st);
        return {
          ok: true,
          note:
            cfg.enabled && cfg.max > 0
              ? `代抽到上限（${ledger.drawn}/${cfg.max}）—— 下一步读进度`
              : '代抽没开 —— 下一步读进度',
        };
      }
      if (s === undefined) return { ok: false, note: 'H5 票没了 —— 没法抽奖' };
      // 先读一次"还剩几次"：上限是**我们**的约束，真实次数是**服务端**的约束 ——
      // 拿上限去撞 0 次机会只会白挨一发业务错误（抓包 §1 表 ④ 就是这个口）。
      if (ledger.remaining === undefined) {
        const rr = callRawText(deps.transport, remainChanceRequest(s, deps.baseUrl));
        if (rr.ok) {
          const renv = parsePk(rr.text);
          if (renv.ok) {
            const n = parseRemainChance(renv.result);
            if (n !== undefined) {
              ledger.remaining = n;
              saveDrawDay(deps.store, ledger, deps.nowIso);
            }
          }
        }
        if (ledger.remaining !== undefined && ledger.remaining <= 0) {
          st.phase = 'progress';
          save(deps, st);
          pkLine(st, '代抽：今天没有抽奖次数');
          return { ok: true, note: '没有抽奖次数 —— 跳过代抽，继续读进度' };
        }
        save(deps, st);
        return {
          ok: true,
          note:
            ledger.remaining === undefined
              ? '读剩余抽奖次数没成 —— 按上限试抽'
              : `还剩 ${ledger.remaining} 次抽奖机会 —— 下一步抽`,
        };
      }
      const res = callRawText(deps.transport, lotteryRequest(s, deps.baseUrl));
      if (!res.ok) {
        // 抽奖是"花次数"的写口：一失败就停手（别连抽把次数全烧在错误上），记一行
        st.failed.push({ id: 0, name: '抽奖', why: `抽奖没成：${res.error ?? '未知失败'}` });
        pkLine(st, `抽奖没成：${res.error ?? '未知失败'}`);
        st.phase = 'progress';
        save(deps, st);
        return { ok: true, note: `抽奖没成（${res.error ?? '未知失败'}）—— 停手，继续读进度` };
      }
      const env = parsePk(res.text);
      if (!env.ok) {
        const why = `抽奖没成：服务端说 ${env.message || `code=${env.code}`}`;
        st.failed.push({ id: 0, name: '抽奖', why });
        pkLine(st, why);
        st.phase = 'progress';
        save(deps, st);
        return { ok: true, note: `${why} —— 停手，继续读进度` };
      }
      const one = parseLottery(env.result);
      ledger.drawn += 1;
      // 回执优先；没有就按"抽了一次少一次"往下推（不拿它当失败）
      ledger.remaining =
        one.remainChance !== undefined
          ? one.remainChance
          : ledger.remaining === undefined
            ? undefined
            : Math.max(0, ledger.remaining - 1);
      if (one.win) ledger.wins.push(one.prizeName ?? '奖品');
      saveDrawDay(deps.store, ledger, deps.nowIso);
      pkLine(st, one.win ? `代抽中奖：${one.prizeName ?? '奖品'}（第 ${ledger.drawn} 次）` : `代抽第 ${ledger.drawn} 次：没中`);
      if (ledger.remaining !== undefined && ledger.remaining <= 0) st.phase = 'progress';
      save(deps, st);
      return {
        ok: true,
        note: one.win ? `代抽中了 ${one.prizeName ?? '奖品'}` : `代抽第 ${ledger.drawn} 次没中`,
      };
    }

    // ⑥ 算力进度（只读）
    case 'progress': {
      if (s === undefined) return { ok: false, note: 'H5 票没了 —— 没法读进度' };
      const res = callRawText(deps.transport, progressRequest(s, deps.baseUrl));
      if (res.ok) {
        const env = parsePk(res.text);
        if (env.ok) st.usedToken = parseProgress(env.result).usedToken;
      }
      // ⚠ 这里**必须**直接返回 idle：`beginLeg` 看到 `phase==='done'` 会另起一趟，
      //   而"另起"的判据是**下一次触发**。若这里只把 phase 设成 done 就返回非 idle，
      //   `drain` 会在同一次触发里再调一次 → 当场重跑一整趟（测试抓到的死循环）。
      st.phase = 'done';
      save(deps, st);
      return {
        ok: st.failed.length === 0,
        idle: true,
        pending: st.pending.length > 0,
        note: summaryFromState(st, loadDrawDay(deps.store, st.day)),
      };
    }

    // ⑦ 收尾
    case 'done':
      return {
        ok: st.failed.length === 0,
        idle: true,
        pending: st.pending.length > 0,
        note: summaryFromState(st, loadDrawDay(deps.store, st.day)),
      };
  }
  return { ok: true, idle: true, note: '没有可推进的阶段' };
}
