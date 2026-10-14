// 「直播自动定时」（mcloud 的 `live_auto`）—— **算什么时刻醒**，以及与面板定时的落差。
//
// # mcloud 的口径（逐条照抄，见 `crates/mcloud-core/src/live_auto.rs`）
//
// ```text
// ① 每个用户**一条**定时（不是每个账号一条）—— 上游那份日程是**按主播**的（平台级），
//    每个账号现取到的"下一场"是同一个值 ⇒ 按账号各建一条只会得到 N 条时刻相同的定时，
//    到点那一刻 N 个账号一起扑上游（正是口令池那层要消灭的事）。
// ② 触发时刻 = **最早的「下一场」+ 1 小时**（用户口径就是"+1 小时"；这一小时留给主播
//    把口令发出来 —— 刚开播时弹幕里还没有口令，那一刻去跑等于空手而归）。
// ③ 每次直播任务跑完**重算并 upsert**；没有下一场 ⇒ 停用。
// ④ 比较只比**字符串**：`YYYY-MM-DD HH:MM:SS` 是定长的 ⇒ 字典序等于时间序。
// ```
//
// # ⚠⚠ 与面板定时的落差（必须说清，否则会静默错）
//
// mcloud 用的是它自己的**一次性 cron**（`one_shot_expr`）。面板这边
// `register_cron(name, expr, handler)` **没有运行时改调度的口子**（见面板的
// `docs/host-api.md`：注册了就只是可暂停/触发，不能改表达式）。
//
// ⇒ 落地方案是"**粗粒度 cron + 到点才动**"：
//
// ```text
// 一个 @every 5m 的 `live-auto` 任务只做两件事：
//   ① 从池里的日程算出「醒来的时刻」，写进状态（**零上游请求**）；
//   ② 听弹幕那条链在被判"没开播/没聊天室"时，把冷却设成"到那个时刻再醒"
//      （原来固定 5 分钟 ⇒ 一天白问 288 次门）。
// ```
//
// 代价如实记：醒来时刻的精度是那两条 cron 的粒度（最坏晚 1 分钟）；
// 而换来的是"没开播时**一个请求都不发**"。mcloud 那条一次性 cron 的精度是秒级，
// 但它的宿主能改调度 —— 这是宿主能力的差，不是算法的差。
//
// # 时区：**只认东八区**，不许用机器本地时区
//
// 上游那份 `expectStartTime` 是东八区墙钟串（`beijing_stamp` 是项目里东八区的**唯一**定义）。
// 机器设在别处时，用 `Date` 的本地时区会整体错几小时 ⇒ 这里自己做定点换算
// （`Date.UTC(...)` 带 `-8` 的小时偏移），**测试因此不依赖运行机器的时区**。

/** 上游与 mcloud 共用的墙钟格式（定长 ⇒ 字典序 = 时间序）。 */
export const LOCAL_FMT = 'YYYY-MM-DD HH:mm:ss';

/** 一小时的毫秒数。 */
export const ONE_HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * ONE_HOUR_MS;
const BEIJING_OFFSET_MS = 8 * ONE_HOUR_MS;

/** 东八区墙钟串 ⇒ epoch 毫秒。解不出来给 `undefined`（**不许瞎猜**）。 */
export function parseLocalMs(local: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  // ⚠ 先按 UTC 建，再减掉 8 小时 —— 这一句就是"东八区"的全部实现。
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
  // 回读一遍挡住 `2026-02-30` 这种（`Date.UTC` 会静默进位）：
  if (formatLocalMs(ms) !== `${y}-${mo}-${d} ${h}:${mi}:${String(second).padStart(2, '0')}`) {
    return undefined;
  }
  return ms;
}

/** epoch 毫秒 ⇒ 东八区墙钟串（与 [`parseLocalMs`] 互为逆）。 */
export function formatLocalMs(ms: number): string {
  const t = new Date(ms + BEIJING_OFFSET_MS);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
  );
}

/** 从一串「下一场」（上游原样的墙钟串）里取**最早**那一场，再往后推 1 小时。
 *
 *  * 空串、解不出来的**一律跳过**（宁可少算一场，也不凭空造一个时刻）；
 *  * 比较**只比字符串**（定长 ⇒ 字典序 = 时间序）—— 先解析再比会平白多一个失败点。 */
export function earliestPlusOneHour(nexts: readonly string[], nowMs: number): string | undefined {
  const candidates = nexts.map((s) => s.trim()).filter((s) => s !== '');
  if (candidates.length === 0) return undefined;
  const earliest = candidates.reduce((a, b) => (a <= b ? a : b));
  const ms = parseLocalMs(earliest);
  if (ms === undefined) return undefined;
  void nowMs;
  return formatLocalMs(ms + ONE_HOUR_MS);
}

/** 把"某一刻"写成一条**只在这一刻触发**的 cron（6 段：秒 分 时 日 月 周）。
 *
 *  ⚠⚠ cron **没有年字段** ⇒ 这是一条"每年今天"的表达式：只要不再重算，
 *  同一个「月-日 时:分」明年会再触发一次。兜底正是"跑完就重算"那条链。
 *
 *  ⚠ 周几必须留 `*`：cron 里"日"与"周"是 **OR** 语义，写死一个周几会让另一半每天成立。
 *
 *  这里**只用它做读数展示**（面板的定时改不了表达式，见模块头），
 *  所以它不会真的被注册 —— 但把"等价于哪条 cron"显示出来，
 *  排查时人就能一眼对上 mcloud 那边的行为。 */
export function oneShotExpr(local: string): string | undefined {
  const ms = parseLocalMs(local);
  if (ms === undefined) return undefined;
  const t = new Date(ms + BEIJING_OFFSET_MS);
  return `${t.getUTCSeconds()} ${t.getUTCMinutes()} ${t.getUTCHours()} ${t.getUTCDate()} ${t.getUTCMonth() + 1} *`;
}

/** 「下一次醒」这个状态的全部内容。 */
export interface WakePlan {
  /** 算出来的醒来时刻（东八区墙钟串）。 */
  wakeAt: string;
  /** 上面那个时刻的 epoch 毫秒（比较用，避免每次都重解析）。 */
  wakeAtMs: number;
  /** 它是**从哪一场**算出来的（`expectStartTime`，只写不读，排查用）。 */
  fromStart: string;
  /** 什么时候算的（东八区墙钟串）。 */
  computedAt: string;
  /** 等价的 cron 表达式（读数展示，见 [`oneShotExpr`]）。 */
  expr?: string | undefined;
  /** 醒来之后这一段算"在窗口里"（毫秒）—— 就是听弹幕那个窗口的长度。 */
  windowMs: number;
}

/** 这个计划是不是该醒了（`now >= wakeAt`）—— 提前醒**不算**（那会又变回轮询）。 */
export function planDue(plan: WakePlan | null, nowMs: number): boolean {
  return plan !== null && nowMs >= plan.wakeAtMs;
}

/** 这次醒来是不是还在窗口里（窗口长度 = 听弹幕那个窗口）。
 *
 *  ⚠ 上限存在的意义：计划里那个时刻是**几个小时前**算的（比如面板睡了一晚），
 *  醒来时窗口早就过完了 ⇒ 那一次不该再跑，直接等下一次重算。
 *  没有这个上限的话，"过期的计划"会被当成"到期"而反复触发。 */
export function planInWindow(plan: WakePlan | null, nowMs: number): boolean {
  return plan !== null && nowMs >= plan.wakeAtMs && nowMs < plan.wakeAtMs + plan.windowMs;
}

/** 凌晨 3 点之前不与上游打交道（每天一次，避免整夜刷门）。
 *
 *  ⚠ 这不是 mcloud 的口径，是本仓对"没开播时也该闭嘴"的加强：
 *  直播口令只在直播期间有效（产品事实），凌晨那几小时问门**没有任何收益**。
 *  它只影响"没有日程时多久再看一次"，不影响有日程那条路。 */
export const QUIET_HOUR_START = 3;

/** 没有日程时的下一次检查（东八区凌晨 3 点前 ⇒ 推到 3 点；否则 `fallbackMs` 之后）。 */
export function nextIdleCheckMs(nowMs: number, fallbackMs: number): number {
  const now = new Date(nowMs + BEIJING_OFFSET_MS);
  const hour = now.getUTCHours();
  if (hour < QUIET_HOUR_START) {
    const today3 = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      QUIET_HOUR_START,
    ) - BEIJING_OFFSET_MS;
    return Math.max(fallbackMs, today3 - nowMs + DAY_MS * 0);
  }
  return fallbackMs;
}
