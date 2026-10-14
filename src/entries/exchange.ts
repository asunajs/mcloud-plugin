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
  // # 为什么是 `@every 10s` 而不是"整点前 20 秒起一次"
  //
  // 抢兑要压到**整点前 10ms**，而 cron 的粒度是秒、调度器还有抖动。
  // 所以分工是：**粗粒度等待交给调度器，细粒度交给链自己**。
  //
  //   · `@every 10s` 的每一次触发几乎都是**零请求秒返回**
  //     （离窗口还远 ⇒ 如实返回 idle，见 `MAX_SPIN_MS`）
  //   · 一旦落进"离窗口 30 秒内"，这一趟就自己自旋到 59:40、
  //     预热、取题解滑块、再自旋到整点−10ms 发单
  //
  // 20 秒宽的窗口配 10 秒的节拍 ⇒ 窗口里至少有一次触发，通常两次。
  '@every 10s',
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

log(`mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1000}s，独占线程）—— 每 10 秒看一眼，窗口内自己压到整点`);
