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
import { runExchangeList } from '../mcloud/tasks/exchangeList.ts';
import {
  runOrderStep,
  startOrder,
} from '../mcloud/tasks/exchangeOrder.ts';
import type { TaskDeps } from '../mcloud/tasks/base.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

// 独占线程：开抢那一下不能被别的任务拖住（见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

/** 整趟预算。一条链 6 大步、含两次 500ms 等待与一次滑块求解 ⇒ 90 秒很宽。 */
const BUDGET_MS = 90_000;
const DEADLINE_MS = BUDGET_MS - 10_000;

const PLAN_KEY = 'mcloud.exchange.plan';

/** 一趟兑换。 */
function runExchange(deps: TaskDeps): { ok: boolean; note: string; detail: string[] } {
  const started = Date.now();
  const detail: string[] = [];

  // ① 清单（只读）：顺带让用户在「数据」页看得到价格与余量
  try {
    const l = runExchangeList(deps);
    detail.push(`清单：${l.ok ? '' : '失败 '}${l.note}`);
  } catch (e) {
    detail.push(`清单：抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 没有在排队的就起一单（起单只写字、不发请求）。
  //    奖品名从设置里读 —— 阶段 ③ 会把它换成界面上的「兑换目标」。
  // ⚠ `getState` 返回字符串本身（不是 `{value}`）—— 见 store/types.ts
  const plan = store.getState(PLAN_KEY) ?? '';
  if (plan === '') {
    return {
      ok: true,
      note: '没有设兑换目标（设置里填「兑换目标」之后才会下单）',
      detail,
    };
  }
  if (!store.getState('mcloud.exchange.order.step')) {
    const s = startOrder(deps, plan);
    detail.push(`起单：${s.note}`);
    if (!s.ok) return { ok: false, note: s.note, detail };
  }

  // ③ 把六步链在**一次触发**里跑到走完
  const r = drain(runOrderStep, deps, {
    label: '兑换',
    maxSteps: 10,
    deadlineMs: DEADLINE_MS,
    startedAt: started,
  });
  detail.push(...r.notes);

  return {
    ok: r.ok,
    note: `${r.note}（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`,
    detail,
  };
}

register_cron(
  '兑换',
  // ⚠ 占位表达式 —— 阶段 ③ 换成「按用户设的时刻起窗」。
  //    现在的语义是「每小时看一眼有没有要兑换的」，不会真的去抢。
  '@every 1h',
  (p: TaskPayload) => {
    const deps = taskDeps(store, transport, p);
    const r = runExchange(deps);

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

log(`mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1000}s，独占线程）—— 毫秒窗口与多账号并行在阶段 ③`);
