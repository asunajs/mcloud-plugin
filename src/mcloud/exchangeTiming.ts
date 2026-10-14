// 兑换的**时间**：两段等待 + 压着整点发单。
//
// 权威源：`mcloud/crates/mcloud-tasks/src/exchange.rs` 的
// `plan_exchange_wait_with` / `plan_exchange_window_wait`（逐条照抄它的边界）。
//
// # 为什么单独一个文件、而且全是纯函数
//
// 这条链是**抢兑**：整点那一瞬间所有人在发同一枪。所以要压着整点**提前 10ms**
// 发出，让请求**正好在整点抵达云端**（那 10ms 是本地到云端的传输耗时补偿，
// 不是抢跑）。
//
// 而"还要等多久"这件事**没法在真实时钟上测** —— 你不可能等一小时看它对不对。
// 所以时间计算全部是纯函数：给一个 `nowMs`，返回"等不等、等多久"。
// 边界用例（正好在 59:40 / 正好在整点 / 整点后 5 秒 / 59:59:59）都能穷举。
//
// # 两段等待是**两件不同的事**
//
// ```text
//   ① 等到 hh:59:40（窗口打开）  ← 在那里做预热 + 取题解滑块
//   ② 等到 整点 − 10ms          ← 发单那一枪
// ```
//
// 参考实现里也是两个函数。合成一个的话，"什么时候做预热"就没有落点了 ——
// 而预热**必须**在整点前完成（它是"让服务端先认识这台设备"）。

/** 兑换窗口打开的**秒**：hh:59:40。 */
export const WINDOW_SECOND = 40;

/** 整点后**这么久之内**仍算"在窗口里"（上一场的尾巴）。 */
export const WINDOW_TAIL_MS = 15_000;

/** 压着整点**提前多少毫秒**发单。默认 10 —— 传输耗时补偿。 */
export const FIRE_LEAD_MS = 10;

/** 进整点前**这么久**就不再等窗口（窗口本来就是 20 秒宽）。 */
export const WINDOW_LEAD_MS = 60_000 - WINDOW_SECOND * 1000;

/** 一小时。 */
const HOUR_MS = 3_600_000;

/** 取模，**结果恒为非负**。
 *
 *  ⚠ JS 的 `%` 对负数给**负余数**（`-1 % 3600000 === -1`），
 *  于是"本小时的整点"会被算到**未来一小时**上，等待量多出一小时。
 *  参考实现为此专门用了 `rem_euclid` 并写了注释。真实时钟恒为正，
 *  但这个写法对负输入才错 —— 判定层不该留这种。 */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** 本小时整点的毫秒时刻（UTC 截断）。 */
export function hourStartMs(nowMs: number): number {
  return nowMs - mod(nowMs, HOUR_MS);
}

/** 这一趟属于**哪一小时**（用来做"这一小时已经发过了"的标记）。 */
export function hourKey(nowMs: number): string {
  return String(hourStartMs(nowMs));
}

/** 一次等待的结论。 */
export interface Wait {
  /** 要不要等。`false` ⇒ 立刻往下走。 */
  needed: boolean;
  /** 要等到哪个时刻（毫秒）。`needed` 为 `false` 时无意义。 */
  untilMs: number;
  /** 还要等多久（毫秒），`needed` 为 `false` 时是 0。 */
  ms: number;
}

const NO_WAIT: Wait = { needed: false, untilMs: 0, ms: 0 };

/** ① 还要等多久才进**窗口**（hh:59:40）。**已经在窗口里 ⇒ 不等。**
 *
 *  # 两条"不等"的边界（照抄 `plan_exchange_window_wait`）
 *
 *  1. `into_hour >= 59:40` ⇒ 窗口已经开了，立刻做预热
 *  2. `into_hour < 整点后 15 秒` ⇒ **上一场的尾巴**：整点刚过那一小会儿仍算在
 *     窗口里（服务端那一场还没散），所以也不等
 *
 *  ⚠ 第 2 条很容易被"顺手优化掉"：它看着像"整点刚过，等下一个小时吧"，
 *  而那样会让**整点后 0~15 秒内触发的每一次都白等 59 分钟**。
 */
export function planWindowWait(nowMs: number): Wait {
  const into = mod(nowMs, HOUR_MS);
  const startMs = (59 * 60 + WINDOW_SECOND) * 1000;
  if (into >= startMs || into < WINDOW_TAIL_MS) return NO_WAIT;
  const untilMs = hourStartMs(nowMs) + startMs;
  return { needed: true, untilMs, ms: untilMs - nowMs };
}

/** ② 还要等多久才到**发单时刻**（整点 − `leadMs`）。**已经过了 ⇒ 不等。**
 *
 *  @param leadMs 提前量（传输耗时补偿），默认 {@link FIRE_LEAD_MS}。
 *                 界面/任务参数可以调 —— 网络慢的人该调大。
 *
 *  # 一条容易漏的边界
 *
 *  `until <= now` ⇒ **不等**。算出来的目标时刻已经在过去时（比如离整点只剩
 *  5ms 而提前量是 10ms），硬等会等成负数（死循环或白跑）。参考实现靠
 *  TS 那边一个 `if (hourMs > 0)` 兜住同一件事，并在注释里标了。
 */
export function planFireWait(nowMs: number, leadMs: number = FIRE_LEAD_MS): Wait {
  const into = mod(nowMs, HOUR_MS);
  // 整点后 20 秒内 ⇒ 上一场尾巴，直接发
  if (into < WINDOW_LEAD_MS) return NO_WAIT;
  const untilMs = hourStartMs(nowMs) + HOUR_MS - leadMs;
  if (untilMs <= nowMs) return NO_WAIT;
  return { needed: true, untilMs, ms: untilMs - nowMs };
}

/** 一次运行的时刻读数（给界面看"现在离窗口/整点还有多久"）。
 *
 *  # 为什么界面需要它
 *
 *  「抢兑」这条链大部分时间在**等**。用户点一下"现在试一次"然后看到界面
 *  十几秒不动，第一反应是"卡住了" —— 而实际上它在等窗口。
 *  这个读数就是回答那个问题的。 */
export interface TimingReading {
  /** 本小时整点（ISO） */
  hourAt: string;
  /** 现在离整点还有多少毫秒（**负数 = 已经过了整点**） */
  msToHour: number;
  /** 现在在不在窗口里（hh:59:40 ～ 整点后 15 秒） */
  inWindow: boolean;
  /** 还要等多久才进窗口（0 = 已经进了） */
  msToWindow: number;
  /** 还要等多久才发单（0 = 现在就该发） */
  msToFire: number;
  /** 窗口打开的秒数（界面上说"每小时的 59:40 开窗"） */
  windowSecond: number;
  /** 提前量（毫秒） */
  leadMs: number;
}

export function timingReading(
  nowMs: number,
  leadMs: number = FIRE_LEAD_MS,
): TimingReading {
  const w = planWindowWait(nowMs);
  const f = planFireWait(nowMs, leadMs);
  const hourAt = hourStartMs(nowMs) + HOUR_MS;
  return {
    hourAt: new Date(hourAt).toISOString(),
    msToHour: hourAt - nowMs,
    inWindow: !w.needed,
    msToWindow: w.ms,
    msToFire: f.ms,
    windowSecond: WINDOW_SECOND,
    leadMs,
  };
}

/** 等一段。**自旋**。
 *
 *  # 为什么只能自旋
 *
 *  沙箱里**没有计时器**（没有 `setTimeout`/`setInterval` —— 见面板
 *  `docs/host-api.md` 的"沙箱里没有什么"）。而这条链的最后一枪要压到
 *  **10ms** 精度，调度器的粒度是秒级 ⇒ 只能自己盯着时钟。
 *
 *  # 为什么这是可接受的
 *
 *  · `mcloud-exchange` 是**独占 worker** 的（`worker_hint('exclusive')`），
 *    所以自旋只占住它自己那条线程，不拖别的插件
 *  · 面板的看门狗按 `start + budget_ms` 判定（`engine.rs` 的 interrupt
 *    handler），所以**预算内的自旋不会被杀**
 *  · 一小时一次（窗口 20 秒），不是常态占用
 *
 *  @param nowFn 取当前时刻。注入是为了**能在测试里用假时钟** ——
 *               真自旋 20 秒的测试没人会跑。
 *  @param spin 让出一小会儿（真实现里是一个忙等的小循环）。
 *  @returns **真的等了多久**（`nowFn()` 在首尾的差）。
 *
 *  ⚠ 返回的是"实际等了多久"，不是"最后一次算出来的剩余量" ——
 *  第一版返回后者，于是 1000→1500 的自旋返回 100 而不是 500，
 *  而调用方拿它写进运行记录 ⇒ 界面上显示"等了 0.1 秒"（实际等了半秒）。
 *  自旋这类代码里，"算了多久"与"等了多久"很容易混，所以返回值要说清。 */
export function waitUntil(
  targetMs: number,
  nowFn: () => number,
  spin: () => void = () => {},
): number {
  const started = nowFn();
  // 每轮先问一次时刻，再 spin —— 顺序反了会多睡一轮
  while (true) {
    if (nowFn() >= targetMs) return Math.max(0, nowFn() - started);
    spin();
  }
}

// ══════════════════ 目标时刻可配（③-3）══════════════════

/** 默认在**几点**抢（本地时区）。参考实现是 `0 10 * * *`（一天一次，10 点）。 */
export const DEFAULT_TARGET_HOUR = 10;

/** 目标时刻的取值：`'10'` = 只在本地 10 点抢；`''` = **每小时**都抢（测试用）。 */
export const STATE_TARGET_HOUR = 'mcloud.exchange.target_hour';

/** 读目标时刻。**坏的/越界的值回落默认**，而不是让链跑到一个不存在的时刻上。 */
export function targetHourOf(store: { getState(k: string): string | null | undefined }): number | null {
  const raw = store.getState(STATE_TARGET_HOUR);
  if (raw === undefined || raw === null) return DEFAULT_TARGET_HOUR;
  const t = raw.trim();
  // 空串 = 每小时（显式的选择，不是"没配"）
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_TARGET_HOUR;
}

/** 目标时刻**那一小时的窗口**：`[H-1]:59:40 → H:00:15`（本地时区）。
 *
 *  @returns `needed` = 现在不在这个窗口里（且要等到什么时候）。
 *
 *  # 为什么需要它
 *
 *  任务挂的是 `@every 10s`（粗粒度等待交给调度器）。没有这道闸的话，
 *  **每一次触发都会先发一个清单请求** —— 一天 8,640 次白打。
 *  有了它，不在窗口里的触发**零请求**秒返回。
 *
 *  ⚠ 用**本地**时区算目标小时（`Date.getHours()`）—— 用户说"10 点"指的是他的 10 点。
 *  而窗口那一小段（59:40 → 00:15）跨了整点，所以判据不能只看小时数：
 *  09:59:40 的本地小时是 9，但它已经在 10 点那一场的窗口里了。
 */
export function planTargetWait(
  nowMs: number,
  targetHour: number | null,
  tailMs: number = WINDOW_TAIL_MS,
): Wait {
  // 没设目标（空串）⇒ 每小时都抢，退化成原来那条逻辑
  if (targetHour === null) return planWindowWait(nowMs);

  const d = new Date(nowMs);
  const localHour = d.getHours();
  const minutesIntoHour = d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds();

  // ① 已经在**目标小时**里（H:00:00 ～ H:00:15）⇒ 上一场的尾巴，立刻跑
  if (localHour === targetHour && minutesIntoHour < tailMs) return NO_WAIT;
  // ② 已经在**目标小时前一个小时**的尾巴上（(H-1):59:40 ～ H-1:59:59）⇒ 窗口刚开
  if (localHour === mod(targetHour - 1, 24) && minutesIntoHour >= (59 * 60 + WINDOW_SECOND) * 1000) {
    return NO_WAIT;
  }

  // ③ 不在 ⇒ 算到窗口打开还有多久
  //    窗口打开的时刻 = 今天/明天的 (H-1):59:40
  const openAt = (base: Date): number => {
    const t = new Date(base.getTime());
    t.setHours(mod(targetHour - 1, 24), 59, WINDOW_SECOND, 0);
    return t.getTime();
  };
  let target = openAt(d);
  if (target <= nowMs) {
    // 已经过了今天的窗口 ⇒ 明天
    const t = new Date(nowMs + 24 * 3_600_000);
    target = openAt(t);
  }
  return { needed: true, untilMs: target, ms: target - nowMs };
}
