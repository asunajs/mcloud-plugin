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
function runExchange(deps: TaskDeps): {
  ok: boolean;
  note: string;
  detail: string[];
  steps: RunStep[];
} {
  const started = Date.now();
  const steps: RunStep[] = [];

  // 记一步（`detail` 最后从 `steps` 推出来 —— 两份会走岔）
  const add = (name: string, ok: boolean, note: string, idle = false): void => {
    steps.push({ name, ok, note, idle });
  };

  // ① 清单（只读）：顺带让用户在「数据」页看得到价格与余量
  try {
    const l = runExchangeList(deps);
    add('清单', l.ok, l.note);
  } catch (e) {
    add('清单', false, `抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 没有在排队的就起一单（起单只写字、不发请求）。
  //    奖品名从设置里读 —— 阶段 ③ 会把它换成界面上的「兑换目标」。
  // ⚠ `getState` 返回字符串本身（不是 `{value}`）—— 见 store/types.ts
  const plan = store.getState(PLAN_KEY) ?? '';
  if (plan === '') {
    add('下单', true, '没有设兑换目标（设置里填「兑换目标」之后才会下单）', true);
    return {
      ok: true,
      note: '没有设兑换目标（设置里填「兑换目标」之后才会下单）',
      detail: steps.map((x) => `${x.name}：${x.ok ? '' : '失败 '}${x.note}`),
      steps,
    };
  }
  if (!store.getState('mcloud.exchange.order.step')) {
    const s = startOrder(deps, plan);
    add('起单', s.ok, s.note);
    if (!s.ok) {
      return {
        ok: false,
        note: s.note,
        detail: steps.map((x) => `${x.name}：${x.ok ? '' : '失败 '}${x.note}`),
        steps,
      };
    }
  }

  // ③ 把六步链在**一次触发**里跑到走完。
  //
  // # 多账号：**两阶段**，不是"一个账号一条任务"
  //
  // 计划里原写的是「全账号并行（一个账号一条任务）」。核实之后改了 ——
  // 两条证据：
  //
  // ① **这个架构给不了插件内并行**：面板的 worker 分配单位是**插件**
  //    （`engine.rs` 的 `route_map().get(plugin)`），而 `mcloud-exchange`
  //    又声明了 `worker_hint('exclusive')`（整个插件一条专属线程）。
  //    所以它名下的 N 条任务**必然串行**。"一个账号一条任务"拿不到并行，
  //    只会让面板的任务列表多出 N 行。
  // ② **参考实现自己也没做**：`mcloud-engine/src/pipeline.rs` 的
  //    `ensure_supported_account_mode` 对 `Parallel` **明确报错**，
  //    理由是「上游常有限流，并发打过去容易触发风控」，而且专门写了一句
  //    「静默接受等于在界面上留一个后端做不到的开关，用户以为并发了、
  //    实际没有，只会觉得『怎么这么慢』」。参考实现自己用的是 `Sequential`。
  //
  // 所以按**串行**做，但把它做到位 —— 关键洞察是：**整点前那些活不是时间敏感的**。
  // 预热两枪、取题解滑块，这些在 59:40 就能做完；只有**下单那一枪**要压整点。
  //
  //   · 阶段 A（整点前）：**每个账号**都推到"取完题、只差下单"
  //   · 阶段 B（整点−10ms）：每个账号**依次发单 + 复查**，中间不等
  //
  // 这样整点那一刻每个账号的代价从"整条链"（约 1.5 秒）降到"一枪"（约 0.15 秒）。
  // 8 个账号的最后一枪约晚 1.2 秒 —— 比串行走完整条链的 12 秒好一个数量级，
  // 而且**如实告诉用户每个账号差了多少**（见下面的 `offsets`）。
  const accounts = loadAccounts(store);
  const multi = accounts.length > 1;
  const snaps = new Map<string, OrderSnapshot>();
  const offsets: string[] = [];
  let r: ReturnType<typeof drain>;

  if (multi) {
    // ── 阶段 A：每个账号各自推到"只差下单" ──
    for (const acc of accounts) {
      selectAccount(store, acc.id, deps.nowIso);
      clearOrder(deps);
      startOrder(deps, plan);
      const a = drain(runOrderStep, deps, {
        label: '兑换',
        maxSteps: 8,
        deadlineMs: Math.min(DEADLINE_MS, started + 30_000),
        startedAt: started,
        // 停在 `order` 之前 —— 下单那一枪留给阶段 B（那时才压整点）
        more: () => currentStep(store) !== 'order' && currentStep(store) !== null,
      });
      snaps.set(acc.id, snapshotOrder(store));
      add(
        `准备 ${maskAuth(loadAuthRaw(store) ?? '')}`,
        a.ok,
        `${a.note}（已推到只差下单）`,
      );
    }
  }

  // ── 阶段 B：依次发单 ──
  const fireStart = Date.now();
  for (const acc of accounts) {
    if (multi) {
      const snap = snaps.get(acc.id);
      if (snap === undefined) continue;
      selectAccount(store, acc.id, deps.nowIso);
      restoreOrder(store, snap, deps.nowIso);
    }
    const one = drain(runOrderStep, deps, {
      label: '兑换',
      maxSteps: 10,
      deadlineMs: DEADLINE_MS,
      startedAt: started,
    });
    if (multi) {
      // ⚠ 每个账号**离整点差了多少**都要报出来。串行意味着越靠后的账号越晚，
      //   而"晚多少"是用户判断"这一枪还有没有意义"的唯一依据 ——
      //   不说的话，用户只会看到一个"失败"，而不知道是**排在后面**导致的。
      offsets.push(`${maskAuth(loadAuthRaw(store) ?? '')} +${Date.now() - fireStart}ms`);
      add(
        `下单 ${maskAuth(loadAuthRaw(store) ?? '')}`,
        one.ok,
        `${one.note} · 离第一枪 ${Date.now() - fireStart}ms`,
      );
    }
    if (!multi) {
      r = one;
      break;
    }
  }
  r ??= { ok: true, idle: true, steps: 0, note: '没有账号（先登录一个）', notes: [] };
  if (multi) {
    add(
      '整点这一批',
      offsets.length > 0,
      offsets.length > 0
        ? `串行发出，各账号离第一枪：${offsets.join('、')}`
        : '没有账号可发',
    );
  }
  // `drain` 给的是 `name：note` 字符串（它要给日志用）。这里拆成步骤 ——
  // 名字里不会出现全角冒号，所以按**第一个**冒号切是确定的。
  for (const line of r.notes) {
    const i = line.indexOf('：');
    if (i < 0) add('兑换', true, line);
    else add(line.slice(0, i), true, line.slice(i + 1));
  }

  return {
    ok: r.ok,
    note: `${r.note}（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`,
    detail: steps.map((x) => `${x.name}：${x.ok ? '' : '失败 '}${x.note}`),
    steps,
  };
}

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
