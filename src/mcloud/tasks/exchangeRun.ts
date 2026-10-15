// 「一趟兑换」的驱动：多账号两阶段 + 时间闸 + 干跑。
//
// # 为什么它不在入口里
//
// 它原来住在 `src/entries/exchange.ts`。但入口的顶层会 `register_cron` ——
// 于是 `routes.ts` **不能** import 它（会把任务再注册一遍，面板报
// "已经注册过名为「兑换」的任务"）。而「现在试一次」这条路由需要它。
//
// 所以驱动搬到这里（普通模块），入口只留"注册任务"那一小段。


import { loadAccounts, maskAuth, selectAccount } from '../accounts.ts';
import { loadAuthRaw } from '../sessionExchange.ts';
import { type RunStep } from '../runLog.ts';
import { drain } from '../../drain.ts';
import {
  MAX_SPIN_MS,
  STATE_ORDERED_HOUR,
  clearOrder,
  currentStep,
  restoreOrder,
  runOrderStep,
  snapshotOrder,
  startOrder,
  type OrderSnapshot,
} from './exchangeOrder.ts';
import { depsNowMs } from './base.ts';
import type { TaskDeps } from './base.ts';
import { runExchangeList } from './exchangeList.ts';
import { hourKey, planTargetWait, targetHourOf } from '../exchangeTiming.ts';

/** 整趟预算。一条链 6 大步、含两次 500ms 等待与一次滑块求解 ⇒ 90 秒很宽。 */
export const BUDGET_MS = 90_000;
const DEADLINE_MS = BUDGET_MS - 10_000;

const PLAN_KEY = 'mcloud.exchange.plan';

/** 一趟兑换。
 *
 *  @param opts.dryRun **干跑**：做完清单 / 余额 / 预热 / 取题解滑块，
 *         到"只差下单"就停 —— **一枪都不发**。给「现在试一次」用。
 *
 *  # 为什么"试一次"必须是干跑
 *
 *  下单是**不可逆消耗**（没有幂等键，发出去就扣真 AI豆）。用户点「试一次」
 *  想知道的其实是「**现在能不能兑**」—— 判据过不过、余额够不够、滑块算不算得出来。
 *  这些**不需要发那一枪**就能答。
 *
 *  真发的话：不在窗口里发出去多半被上游拒（白打一枪），而在窗口里发出去
 *  就是**真下单** —— 一个"试一试"的按钮不该有这种后果。
 *
 *  真正下单只走**定时那一场**（`@every 10s` + 时间闸 + 压整点）。 */
export function runExchange(deps: TaskDeps, opts: { dryRun?: boolean } = {}): {
  ok: boolean;
  note: string;
  /** 这一趟**一个请求都没发**（离窗口还远 / 没账号）⇒ 入口据此不写日志。 */
  idle?: boolean;
  detail: string[];
  steps: RunStep[];
} {
  const started = Date.now();
  const steps: RunStep[] = [];

  // 记一步（`detail` 最后从 `steps` 推出来 —— 两份会走岔）
  const add = (name: string, ok: boolean, note: string, idle = false): void => {
    steps.push({ name, ok, note, idle });
  };

  // ⚠ 收尾**只有一个出口**。干跑那条说明必须挂在**每一个**出口上 ——
  //   第一版加在函数末尾，而"没设兑换目标"是**提前返回**的，
  //   于是干跑路由返回的结果里**看不出它一枪都没发**（最该说清的那句话丢了）。
  const finish = (
    ok: boolean,
    note: string,
    // ⚠ `idle` 要传到**顶层**，不能只挂在 step 上：入口是靠 `r.idle` 决定
    //   "这一趟要不要写日志 / 记一笔 run" 的。只挂 step 的话，离窗口还远的那
    //   23 次触发照样会各写一行「还没到抢兑时间」—— 那正是用户说的"太特么频繁"。
    idle = false,
  ): {
    ok: boolean;
    note: string;
    idle?: boolean;
    detail: string[];
    steps: RunStep[];
  } => {
    if (opts.dryRun) {
      add('干跑', true, '只看了能不能兑，**一枪都没发**（真下单走定时那一场）', true);
    }
    return {
      ok,
      ...(idle ? { idle: true } : {}),
      note,
      detail: steps.map((x) => `${x.name}：${x.ok ? '' : '失败 '}${x.note}`),
      steps,
    };
  };

  // ⓪ **时间闸：任何请求之前** ────────────────────────────────────
  //
  // ⚠ 顺序是**性能**也是**礼貌**：任务挂的是 `@every 10s`，而原来清单请求
  //   排在时间判断**之前** ⇒ 一天 8,640 次白打（不在窗口里的时候也一样）。
  //   现在不在窗口里就**零请求**秒返回。
  //
  // ⚠ 而且这条闸必须在 `runExchangeList` **之前**：那是唯一能"什么都没干
  //   却打了上游"的地方。
  const targetHour = targetHourOf(deps.store);
  const gate = planTargetWait(depsNowMs(deps), targetHour);
  // ⚠ **干跑绕过时间闸**：用户点「试一次」就是想现在看看，不该被告知"还没到点"。
  //   而它绕过是**安全**的 —— 干跑一枪都不发（见上面的说明）。
  if (!opts.dryRun && gate.needed && gate.ms > MAX_SPIN_MS) {
    add(
      '时间闸',
      true,
      targetHour === null
        ? `还没到窗口（还差 ${Math.round(gate.ms / 1000)}s）—— 本次零请求`
        : `不是 ${targetHour} 点那一场（还差 ${Math.round(gate.ms / 1000)}s）—— 本次零请求`,
      true,
    );
    // ⚠ 标 `idle`：这一趟**一个请求都没发**，不该在日志里留一行。
    //   留了就是每小时的 23 条噪声（老版本 `@every 10s` 是每天 8639 条）。
    //   真正到点那一趟仍然会正常写日志 —— 那才是用户要看的。
    return finish(
      true,
      `还没到抢兑时间（还差 ${Math.round(gate.ms / 1000)}s），本次零请求`,
      true,
    );
  }

  // ① 清单（只读）：顺带让用户在「数据」页看得到价格与余量
  try {
    const l = runExchangeList(deps);
    add('清单', l.ok, l.note);
  } catch (e) {
    add('清单', false, `抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 没有在排队的就起一单（起单只写字、不发请求）。
  //    奖品名从设置里读 —— 阶段 ③ 会把它换成界面上的「兑换目标」。
  // ⚠ `getState` 返回字符串本身（不是 `{value}`）—— 见 deps.store/types.ts
  const plan = deps.store.getState(PLAN_KEY) ?? '';
  if (plan === '') {
    add('下单', true, '没有设兑换目标（设置里填「兑换目标」之后才会下单）', true);
    return finish(true, '没有设兑换目标（设置里填「兑换目标」之后才会下单）');
  }
  if (!deps.store.getState('mcloud.exchange.order.step')) {
    const s = startOrder(deps, plan);
    add('起单', s.ok, s.note);
    if (!s.ok) {
      return finish(false, s.note);
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
  const accounts = loadAccounts(deps.store);
  const multi = accounts.length > 1;
  const snaps = new Map<string, OrderSnapshot>();
  const offsets: string[] = [];
  let r: ReturnType<typeof drain>;

  if (multi) {
    // ── 阶段 A：每个账号各自推到"只差下单" ──
    for (const acc of accounts) {
      selectAccount(deps.store, acc.id, deps.nowIso);
      clearOrder(deps);
      startOrder(deps, plan);
      const a = drain(runOrderStep, deps, {
        label: '兑换',
        maxSteps: 8,
        deadlineMs: Math.min(DEADLINE_MS, started + 30_000),
        startedAt: started,
        // 停在 `order` 之前 —— 下单那一枪留给阶段 B（那时才压整点）
        more: () => currentStep(deps.store) !== 'order' && currentStep(deps.store) !== null,
      });
      snaps.set(acc.id, snapshotOrder(deps.store));
      add(
        `准备 ${maskAuth(loadAuthRaw(deps.store) ?? '')}`,
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
      selectAccount(deps.store, acc.id, deps.nowIso);
      restoreOrder(deps.store, snap, deps.nowIso);
    }
    const one = drain(runOrderStep, deps, {
      label: '兑换',
      maxSteps: 10,
      deadlineMs: DEADLINE_MS,
      startedAt: started,
      // ⚠ 干跑：停在 `order` **之前** —— 一枪都不发
      ...(opts.dryRun
        ? { more: () => currentStep(deps.store) !== 'order' && currentStep(deps.store) !== null }
        : {}),
    });
    if (multi) {
      // ⚠ 每个账号**离整点差了多少**都要报出来。串行意味着越靠后的账号越晚，
      //   而"晚多少"是用户判断"这一枪还有没有意义"的唯一依据 ——
      //   不说的话，用户只会看到一个"失败"，而不知道是**排在后面**导致的。
      offsets.push(`${maskAuth(loadAuthRaw(deps.store) ?? '')} +${Date.now() - fireStart}ms`);
      add(
        `下单 ${maskAuth(loadAuthRaw(deps.store) ?? '')}`,
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

  return finish(r.ok, `${r.note}（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
}
