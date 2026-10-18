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
import { jwtFresh, loadAuthRaw } from '../sessionExchange.ts';
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
import { nextCronTargetMs } from '../scheduleCron.ts';
import { FALLBACK_RECIPE } from '../h5session.ts';
import { exchangeOnce } from '../tokenGate.ts';

/** 整趟预算。包含最长 300 秒的提前等待 + 6 大步（两次 500ms 等待与一次滑块求解）。 */
export const BUDGET_MS = 480_000;
const DEADLINE_MS = BUDGET_MS - 10_000;

/** 手动目标：只给「立即兑换 / 手动试一次」用，不参与定时。 */
const PLAN_KEY = 'mcloud.exchange.plan';
/** 定时目标：弹窗「定时抢兑」写它。与手动目标分开，免得改一个把另一个带跑。 */
export const STATE_SCHEDULE_PLAN = 'mcloud.exchange.schedule.plan';
/** 定时 cron（5 段，分钟必须 0）。 */
export const STATE_SCHEDULE_CRON = 'mcloud.exchange.schedule.cron';

/** 插件默认的兑换时间：每天 10:00。用户可在面板任务里改。 */
export const DEFAULT_SCHEDULE_CRON = '0 10 * * *';
/** 旧版重复方式；保留读取兼容，新界面不再写。 */
export const STATE_SCHEDULE_MODE = 'mcloud.exchange.schedule.mode';
/** 定时截止时间（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm；空 = 不限）。 */
export const STATE_SCHEDULE_UNTIL = 'mcloud.exchange.schedule.until';
/** 只跑一次的那一天（YYYY-MM-DD）。 */
export const STATE_SCHEDULE_ONCE_DATE = 'mcloud.exchange.schedule.once_date';
/** 每个账号最多真正发起几次（0 = 不限）。 */
export const STATE_SCHEDULE_MAX_RUNS = 'mcloud.exchange.schedule.max_runs';
/** 当前账号已经真正发起过几次（按账号）。 */
export const STATE_SCHEDULE_RUNS = 'mcloud.exchange.schedule.runs';
/** 当前账号那几次属于哪一版定时（改一次定时 = 新版本，计数从头算）。 */
export const STATE_SCHEDULE_RUNS_GEN = 'mcloud.exchange.schedule.runs_gen';
/** 定时版本；保存定时时换一个值。 */
export const STATE_SCHEDULE_GEN = 'mcloud.exchange.schedule.gen';
/** 提前触发秒数（任务在目标时刻前多少秒启动）。 */
export const STATE_LEAD_SEC = 'mcloud.exchange.lead_sec';

const DEFAULT_LEAD_SEC = 120;

/** 把截止时间写成毫秒；`YYYY-MM-DD` 按当天 23:59:59 算。 */
function untilMs(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(t);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? '23'),
    Number(m[5] ?? '59'),
    59,
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 下一场的目标整点；cron 没配时按旧 targetHour 退化。 */
export function scheduleNextTargetMs(
  store: { getState(k: string): string | null | undefined },
  nowMs: number,
): number | null {
  const raw = (store.getState(STATE_SCHEDULE_CRON) ?? '').trim();
  if (raw !== '') {
    try {
      return nextCronTargetMs(raw, nowMs);
    } catch {
      return null;
    }
  }
  const targetHour = targetHourOf(store);
  const d = new Date(nowMs);
  const t = new Date(d);
  if (targetHour === null) t.setHours(d.getHours() + 1, 0, 0, 0);
  else {
    t.setHours(targetHour, 0, 0, 0);
    if (t.getTime() < nowMs) t.setDate(t.getDate() + 1);
  }
  return t.getTime();
}

/** 指定这一场是否还在截止时间之前（任务自己的 cron 是权威）。 */
export function scheduleUntilAllowed(
  store: { getState(k: string): string | null | undefined },
  targetMs: number,
): { ok: boolean; note: string } {
  const until = untilMs((store.getState(STATE_SCHEDULE_UNTIL) ?? '').trim());
  if (until !== null && targetMs > until) return { ok: false, note: '已过截止时间' };
  return { ok: true, note: '' };
}

/** 定时是否还允许跑：下一场必须在截止时间之前。 */
export function scheduleDateAllowed(
  store: { getState(k: string): string | null | undefined },
  nowMs: number,
): { ok: boolean; nextMs: number | null; note: string } {
  const nextMs = scheduleNextTargetMs(store, nowMs);
  if (nextMs === null) return { ok: false, nextMs: null, note: 'cron 找不到下一场' };
  const until = untilMs((store.getState(STATE_SCHEDULE_UNTIL) ?? '').trim());
  if (until !== null && nextMs > until) {
    return { ok: false, nextMs, note: '已过截止时间' };
  }
  return { ok: true, nextMs, note: '' };
}

export function scheduleMaxRuns(store: { getState(k: string): string | null | undefined }): number {
  const raw = Number((store.getState(STATE_SCHEDULE_MAX_RUNS) ?? '0').trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 当前账号在这一版定时里已经跑了几次。版本变了就当 0。 */
export function scheduleRuns(store: {
  getState(k: string): string | null | undefined;
}): number {
  const gen = (store.getState(STATE_SCHEDULE_GEN) ?? '').trim();
  const runsGen = (store.getState(STATE_SCHEDULE_RUNS_GEN) ?? '').trim();
  if (gen !== '' && runsGen !== gen) return 0;
  const raw = Number((store.getState(STATE_SCHEDULE_RUNS) ?? '0').trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function bumpScheduleRuns(store: {
  getState(k: string): string | null | undefined;
  setState(k: string, v: string, at: string): void;
}, nowIso: string): void {
  const gen = (store.getState(STATE_SCHEDULE_GEN) ?? '').trim();
  const n = scheduleRuns(store);
  store.setState(STATE_SCHEDULE_RUNS, String(n + 1), nowIso);
  if (gen !== '') store.setState(STATE_SCHEDULE_RUNS_GEN, gen, nowIso);
}

export function scheduleLeadSec(store: { getState(k: string): string | null | undefined }): number {
  const raw = Number((store.getState(STATE_LEAD_SEC) ?? String(DEFAULT_LEAD_SEC)).trim());
  return Number.isFinite(raw) ? Math.min(300, Math.max(60, Math.floor(raw))) : DEFAULT_LEAD_SEC;
}

/** 当前时刻是否已经进入「提前触发」窗口（目标时刻前 leadSec 秒）。 */
export function scheduleLeadReady(nowMs: number, targetMs: number, leadSec: number): boolean {
  return nowMs >= targetMs - leadSec * 1000;
}

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
 *  真正下单走界面上的「立即兑换」（会二次确认）或**定时那一场**（时间闸 + 压整点）。 */
export function runExchange(
  deps: TaskDeps,
  opts: { dryRun?: boolean; maxWaitMs?: number; targetHour?: number | null } = {},
): {
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

  /** 参考 mcloud 的 H5Client：票过期由任务自己无感续，不让用户看到"未登录"。
   *  只有**原生凭据**（auth）过期才会换不出来 —— 那时如实报"去重新登录"。 */
  const ensureToken = (): boolean => {
    if (jwtFresh(deps.store, Date.now(), FALLBACK_RECIPE)) return true;
    const x = exchangeOnce(
      {
        store: deps.store,
        transport: deps.transport,
        nowIso: deps.nowIso,
        baseUrl: deps.baseUrl,
      },
      FALLBACK_RECIPE,
    );
    add('换票', x.ok, x.note);
    return x.ok && jwtFresh(deps.store, Date.now(), FALLBACK_RECIPE);
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
      add('干跑', true, '只看了能不能兑，**一枪都没发**（真下单走「立即兑换」或定时那一场）', true);
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
  const targetHour = opts.targetHour !== undefined ? opts.targetHour : targetHourOf(deps.store);
  const gate = planTargetWait(depsNowMs(deps), targetHour);
  // ⚠ **干跑绕过时间闸**：用户点「试一次」就是想现在看看，不该被告知"还没到点"。
  //   而它绕过是**安全**的 —— 干跑一枪都不发（见上面的说明）。
  if (!opts.dryRun && gate.needed && gate.ms > (opts.maxWaitMs ?? MAX_SPIN_MS)) {
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
  //    ⚠ 票过期时先无感换票 —— 不换的话清单会读回来但 `limit` 整片缺失，
  //    界面会变成"50 件全判不了"（用户截图里的那个现场）。
  if (!ensureToken()) {
    return finish(false, '网页会话续期失败 —— 登录凭据可能已过期，去「账号」页重新登录一次');
  }
  try {
    const l = runExchangeList(deps);
    add('清单', l.ok, l.note);
  } catch (e) {
    add('清单', false, `抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 没有在排队的就起一单（起单只写字、不发请求）。
  //    奖品名从设置里读 —— 阶段 ③ 会把它换成界面上的「兑换目标」。
  // ⚠ `getState` 返回字符串本身（不是 `{value}`）—— 见 deps.store/types.ts
  // 定时目标优先；没设过定时目标才回退到手动目标 —— 兼容旧版本只存一格的行为。
  const plan = deps.store.getState(STATE_SCHEDULE_PLAN) ?? deps.store.getState(PLAN_KEY) ?? '';
  if (plan === '') {
    add('下单', true, '没有设定时兑换目标（在「定时抢兑」里选一件之后才会下单）', true);
    return finish(true, '没有设定时兑换目标（在「定时抢兑」里选一件之后才会下单）');
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
      if (!ensureToken()) {
        add(`准备 ${maskAuth(loadAuthRaw(deps.store) ?? '')}`, false, '网页会话续期失败');
        continue;
      }
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
