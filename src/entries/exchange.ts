// 插件 `mcloud-exchange` —— 用户可见任务「兑换」。
//
// # 一个函数从头跑到尾
//
// 老版本这里是两条 cron（`exchange-list` 只看 / `exchange-order` 一次一步），
// 而「下单」那条链有 6 大步、每步还夹一次 500ms 等待 —— 在 2 秒的全局预算下
// 只能一次走一步，于是一次兑换在面板上表现为「一条任务反复触发十几分钟」。
//
// 现在有了长预算，整条链在**一次触发**里跑完：起单 → 读清单 → 读基准余额 →
// 预热两枪 → 取滑块 → 下单 → 复查余额差。
//
// # ⚠ 这一版还是「串行单账号」，毫秒级窗口与多账号并行在阶段 ③
//
// 阶段 ③ 要补的两件事（现在**没有**，写在这是为了不让它悄悄漏掉）：
//
//   ① **毫秒级窗口**：固定时刻的 hh:59:40 进窗 → 预热 → 整点前解好滑块 →
//      整点前 ≤10ms 发单。现在是「触发了就跑」，靠 cron 的分钟粒度，
//      所以大概率抢不到热门奖品。
//   ② **多账号并行**：兑换要求所有账号**同时**发单（串行会错过窗口），
//      那需要「一个账号一条任务」—— 也就是**任务参数**（`opts.params`）。
//
// 所以这里的 cron 表达式是个占位（`@every 1h`），阶段 ③ 会把它换成
// 「按用户设的时刻起窗」+ 每个账号一条带 `params` 的任务。


import { log, register_cron, warn, worker_hint } from 'host-api';
import { hourKey } from '../mcloud/exchangeTiming.ts';
import { loadAccounts, maskAuth, selectAccount } from '../mcloud/accounts.ts';
import { loadAuthRaw } from '../mcloud/sessionExchange.ts';
import { appendRun, type RunStep } from '../mcloud/runLog.ts';
import {
  STATE_ORDERED_HOUR,
  clearOrder,
  currentStep,
  restoreOrder,
  snapshotOrder,
  startOrder,
  type OrderSnapshot,
} from '../mcloud/tasks/exchangeOrder.ts';
import { runExchangeList } from '../mcloud/tasks/exchangeList.ts';
import { runOrderStep } from '../mcloud/tasks/exchangeOrder.ts';
import { MAX_SPIN_MS } from '../mcloud/tasks/exchangeOrder.ts';
import { depsNowMs } from '../mcloud/tasks/base.ts';
import type { TaskDeps } from '../mcloud/tasks/base.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  forEachTaskAccount,
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import { labelOf } from '../mcloud/taskAccounts.ts';
import { logBoth } from '../mcloud/log.ts';
import type { TaskPayload } from './shared.ts';
import {
  BUDGET_MS,
  DEFAULT_SCHEDULE_CRON,
  bumpScheduleRuns,
  runExchange,
  scheduleLeadReady,
  scheduleLeadSec,
  scheduleUntilAllowed,
  STATE_SCHEDULE_CRON,
  scheduleMaxRuns,
  scheduleRuns,
} from '../mcloud/tasks/exchangeRun.ts';

// 独占线程：开抢那一下不能被别的任务拖住（见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

// 插件给一个**默认时间**（每天 10:00），并把它注册成面板任务。
// 用户可以在任务列表里把 cron 改成 `0 10,20 * * *` 之类的，面板会覆盖默认值；
// `lead_ms` 让调度器提前醒，任务列表显示的仍是用户设的整点。
const defaultCron = (store.getState(STATE_SCHEDULE_CRON) ?? '').trim() || DEFAULT_SCHEDULE_CRON;
const defaultLeadMs = scheduleLeadSec(store) * 1000;
register_cron(
  '兑换',
  defaultCron,
  (p: TaskPayload) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    // 任务自己的 cron 是权威：`scheduledAt` 是**目标整点**（不是提前后的触发时刻），
    // 所以用户在任务列表里把 `0 10` 改成 `0 20` 后，这里直接跟着走。
    const targetMs = Date.parse(p.scheduledAt);
    if (!Number.isFinite(targetMs)) return;
    const untilGate = scheduleUntilAllowed(store, targetMs);
    if (!untilGate.ok) return;
    const targetHour = new Date(targetMs).getHours();
    // 小时闸按**目标那一场**算：9:58 那一跳如果跑到 10:00 才下单，
    // 9:59 的排队触发不能又发一枪。
    const thisHour = hourKey(targetMs);
    // 提前量也以任务为准；老面板没有 leadMs 时退回插件设置。
    const leadSec = p.leadMs !== undefined ? p.leadMs / 1000 : scheduleLeadSec(store);
    if (!p.manual && !scheduleLeadReady(startedMs, targetMs, leadSec)) return;
    const maxRuns = scheduleMaxRuns(store);

    // ── 这一趟跑**这条任务选的账号**，**串行**（见 `forEachTaskAccount`）──
    const runs = forEachTaskAccount(store, '兑换', p, transport, (deps) => {
      // ⚠ **小时闸**：这一小时已经发过单了 ⇒ 零请求秒返回。
      //   链里那段自旋会让排在后面的触发积压，跑完之后它们立刻依次执行 ——
      //   而那时已经过了整点，链会判"现在就发" ⇒ **每一枪都真花豆**。
      //   下单不可逆、无幂等键，所以这道闸是必需品（见 STATE_ORDERED_HOUR）。
      //   ⚠ 闸是**按账号**的（键在账号袋里）—— 所以它在循环**里面**判。
      //     放外面的话 A 发过单之后 B 就不发了（而 B 那一小时还没发过）。
      if (deps.store.getState(STATE_ORDERED_HOUR) === thisHour) return null;
      const done = scheduleRuns(deps.store);
      const cap = maxRuns;
      if (cap > 0 && done >= cap) return null;
      const r = runExchange(deps, { maxWaitMs: BUDGET_MS - 10_000, targetHour });
      // 真正发起了一次（不是离窗口还远）⇒ 计数；失败也算，按账号各算。
      if (r && !r.idle) bumpScheduleRuns(deps.store, deps.nowIso);
      return r;
    });

    // 没选到账号 ⇒ 不是失败，但**必须说一句**：不然终端里一片安静，
    // 用户只会觉得"这条任务坏了"（选账号在界面上那个「全部账号」下拉里）。
    if (runs.length === 0) {
      log('这一趟没跑 —— 「兑换」还没选账号（界面上那个「全部账号」下拉）');
      return;
    }

    let acted = 0;
    for (const one of runs) {
      const r = one.result;
      if (r === null) continue; // 这一条这一小时已经发过单

      // ⚠ **离窗口还远 ⇒ 一条日志都不写**。
      //   这一趟一个请求都没发（`idle`），写出来只是噪声 —— 用户的原话「太特么频繁了」。
      //   老版本 `@every 10s` 一天要写 8639 行这种东西。
      //   ⚠ 读数照样更新：界面上「下次几点」还得看得见。
      if (r.idle) {
        store.recordRun({
          task: p.name,
          runs: p.runs,
          scheduledAt: p.scheduledAt,
          firedAt: p.firedAt,
          lateMs: p.lateMs,
          ok: true,
          note: r.note,
        });
        continue;
      }

      acted += 1;
      const who = labelOf(store, one.acctId);
      const note = runs.length > 1 ? `${who}：${r.note}` : r.note;

      appendRun(store, {
        task: 'exchange',
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
      // 日志形状照参考实现（`mcloud` / `mcloud-sign`）：一个账号一段，
      // 段头一行、**每一步一行**、段尾一行。失败的行走 warn，其余走 info。
      logBoth(store, 'info', `------【${who}】------`, at);
      for (const line of r.detail) {
        logBoth(store, line.includes('没成') ? 'warn' : 'info', line, at);
      }
      const bad = r.steps.filter((x) => !x.ok).length;
      const tail = bad === 0 ? `------【${who}】都成了------` : `------【${who}】${bad} 项没成------`;
      logBoth(store, bad > 0 ? 'warn' : 'info', tail, at);
    }
    // 全都"这一小时已发过单 / 离窗口还远" ⇒ 没动手。**也要说一句** ——
    // 否则终端里一片安静，用户分不清"它没动手"和"它没跑"（参考实现每趟都有行）。
    if (!acted) {
      log(
        runs.length === 1
          ? '这一趟没动手 —— 还没到该抢的时候（或这一场已经试过了）'
          : `这一趟没动手 —— ${runs.length} 个号都还没到该抢的时候（或这一场已经试过了）`,
      );
    }
  },
  { budget_ms: BUDGET_MS, lead_ms: defaultLeadMs },
);

log(
  `mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1000}s，独占线程）—— 默认 ${defaultCron}，提前 ${defaultLeadMs / 1000}s 醒`,
);
