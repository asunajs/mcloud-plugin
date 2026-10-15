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
import {
  hourKey,
  planTargetWait,
  targetHourOf,
} from '../mcloud/exchangeTiming.ts';
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
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';
import { BUDGET_MS, runExchange } from '../mcloud/tasks/exchangeRun.ts';

// 独占线程：开抢那一下不能被别的任务拖住（见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

register_cron(
  '兑换',
  // # 为什么是「每小时 59 分」而不是 `@every 10s`
  //
  // 第一版写的是 `@every 10s`：一天 **8640** 次触发，其中 8639 次是零请求秒返回。
  // 逻辑上没错（每一次都便宜），但用户看到任务列表里那个表达式就说了
  // 「太特么频繁了」—— 而用户是对的：**抢兑一天只发生一次**。
  //
  // 触发频率该由"这件事一天发生几次"决定，不是由"多久看一眼"决定。
  //
  // 现在的分工：`59 * * * *` 每小时醒一次（一天 **24** 次），正好落在
  // **目标小时的前一分钟**；那一刻这一趟有 60 秒可用 —— 足够预热
  //（两次 visitlog + 500ms）再自旋到整点 −10ms 发单。
  // 剩下 23 次是**静默零请求**（离窗口远 ⇒ 标 `idle`，连日志都不写）。
  //
  // ⚠ 为什么"59 分那一跳"够准：调度器抖动实测是**毫秒级**（日志里那条
  //   「调度延迟 2ms」），所以它确实落在 59:00.00x，60 秒自旋预算不会被吃掉。
  '59 * * * *',
  (p: TaskPayload) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    const deps = taskDeps(store, transport, p);

    // ⚠ **小时闸**：这一小时已经发过单了 ⇒ 零请求秒返回。
    //   链里那段自旋会让排在后面的触发积压，跑完之后它们立刻依次执行 ——
    //   而那时已经过了整点，链会判"现在就发" ⇒ **每一枪都真花豆**。
    //   下单不可逆、无幂等键，所以这道闸是必需品（见 STATE_ORDERED_HOUR）。
    const thisHour = hourKey(startedMs);
    if (store.getState(STATE_ORDERED_HOUR) === thisHour) {
      return;
    }

    const r = runExchange(deps);

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
      return;
    }

    appendRun(store, {
      task: 'exchange',
      at,
      ms: Date.now() - startedMs,
      ok: r.ok,
      note: r.note,
      steps: r.steps,
    });

    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.note,
    });
    if (r.ok) log(`兑换：${r.note}`);
    else warn(`兑换：${r.note}`);
    for (const line of r.detail) {
      if (line.includes('失败')) warn(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS },
);

log(
  `mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1000}s，独占线程）—— 每小时 59 分醒一次，只有下一小时是目标那一场才动手`,
);
