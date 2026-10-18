// AI豆账本（`cloudRecordV2`）的**只读**读数：今日汇总 + 流水明细。
//
// 照 `mcloud/crates/mcloud-tasks/src/beans.rs` 移植，**口径逐条对齐**（那一份文件头
// 已经把每条口径讲清了；这里只补"插件这边怎么做"的差集）。
//
// # 三条硬口径（都来自参考实现，插件这边不改）
//
// 1. **按账号记账、绝不跨账号合计** —— 豆是每个账号各一本账，加出来的总数
//    哪个账号都花不了。本模块的产物是「每个账号一行」，形状上就摆不下 total/net。
// 2. **"今天"按东八区算** —— 日界取自 `BEIJING_OFFSET_MS`，不是运行机器时区。
//    这条与 `liveAuto.ts::parseLocalMs` 的东八区口径同源。
// 3. **失败按账号隔离** —— 某账号读不到（无会话 / 网络 / 上游码 / 翻页翻不到底 /
//    解不出 `insertTime`）只让它那一行进 `failed`，其余账号照常出数。
//
// # 翻页：**不照搬"只取首页"那个缺口**
//
// `cloudRecordV2` 是分页接口。原实现里那条 `cloud-snapshot` 只取首页（怕一次调用
// 拖成多个请求撞执行预算）。这层不一样：**路由是"点了才取"的按需读数**，不在
// 5 分钟调度循环里 —— 所以它可以翻到短页为止，就像参考实现那样。
// 一装满（`== PAGE_SIZE`）就要下一页；拿满 `MAX_PAGES` 还没到底 ⇒ **如实标不全**
// （明细给 `hasMore`，今日汇总把该账号挪进 `failed`），绝不静默少算。
//
// # 排序不假设
//
// 每一笔都按 `insertTime` 判"是不是今天"，不做"见一条更早的就停"那种提前退出
// —— 那需要"倒序"这个前提，而本仓没有它的实拍依据。

// ══════════════════════════ 常量（与参考实现同源）══════════════════════════

/** 账本：`aiDou=1` = 改名后的 **AI豆**（`0` 是改名前的云朵，不是同一个东西）。 */
export const LEDGER_AI_DOU = 1;

/** 不过滤方向（`type=0`）：进与出都在同一条流水里。 */
export const TYPE_ALL = 0;

/** 一页要多少条。 */
export const PAGE_SIZE = 100;

/** 最多翻几页。这是**兜底**不是配额：正常账号一两页到底，撞上它说明流水规模
 *  远超预期 —— 那就如实报错/如实标不全，而不是给一个可能少算的数。 */
export const MAX_PAGES = 20;

/** 明细一次最多回多少笔（撞上它不静默截断：`hasMore` 置真）。 */
export const MAX_DETAIL_RECORDS = 500;

const DAY_MS = 86_400_000;

/** 东八区的秒偏移（+8 小时）。
 *
 *  ⚠ 与 `liveAuto.ts` 里那份 `-480`（`smid.ts` 的 timezone）/ `BEIJING_OFFSET_MS`
 *  是同一个事实的三种写法。这里独立写一次是刻意的：本模块不 import `liveAuto`
 *  （那是"下一次醒"的调度层，与账本无关），而把时区常量再抽一层公共模块的收益
 *  抵不上"为一个数绕一圈"的成本。**要改东八区口径时这两处一起改。** */
export const BEIJING_OFFSET_SECS = 8 * 3_600;

/** 翻页查询串（抄自 `tasks/cloudSnapshot.ts::snapshotQuery`，参数同一套）。 */
export function beanQuery(pageNumber: number): string {
  return `aiDou=${LEDGER_AI_DOU}&type=${TYPE_ALL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
}

// ══════════════════════════ 日界（东八区）══════════════════════════════════

/** `nowMs` 所在**东八区**那一天的起点（epoch 毫秒）。
 *
 *  用整除而不是 `/`：负数时间戳下 JS 的 `/` 向 0 取整，会把日界算到后一天上。
 *  本仓 `nowMs` 恒为正，但判定层不留这种错法（照参考实现的 `div_euclid`）。 */
export function dayStartMs(nowMs: number): number {
  const offsetMs = BEIJING_OFFSET_SECS * 1_000;
  const local = Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS;
  return local - offsetMs;
}

/** `tsMs` 是不是 `nowMs` 所在的**东八区**自然日（左闭右开）。 */
export function isToday(tsMs: number, nowMs: number): boolean {
  const start = dayStartMs(nowMs);
  return tsMs >= start && tsMs < start + DAY_MS;
}

/** 明细窗口下界（epoch 毫秒）：**含今天在内的最近 `days` 个自然日**。
 *
 *  * `days <= 0` ⇒ `undefined` = 不限（"全部"那一档）；
 *  * `days == 1` ⇒ 今天 00:00（东八区）起；
 *  * `days == 7` ⇒ 今天往前数 6 天的 00:00 起（含今天共 7 天）。
 *
 *  ⚠ 用**自然日**而不是"最近 7×24 小时"：界面上那一档写的是「近 7 天」，用户理解
 *  是"从上周同日 0 点到现在"。按 168 小时算会看不见 7 天前上午那几笔 —— 界面看不出
 *  差别，只会让人以为上游漏记了。 */
export function rangeSinceMs(days: number, nowMs: number): number | undefined {
  if (!(days > 0)) return undefined;
  return dayStartMs(nowMs) - (days - 1) * DAY_MS;
}

// ══════════════════════════ insertTime 归一 ════════════════════════════════

/** 把流水的 `insertTime` 串归一成 epoch 毫秒。**解不出给 `undefined`，绝不猜时区。**
 *
 *  # 认得的形状
 *
 *  `YYYY-MM-DDTHH:MM:SS[.SSS]` + **显式偏移**（`Z` / `±HH:MM`），例如
 *  `2026-09-30T13:00:00.000+00:00`。这一形状有同族证据：同主机同族的 `record`
 *  实拍里 `insertTime` / `expireTime` 都是它（`app-signin-vectors.json` 的
 *  `prizeRecords`）。
 *
 *  # 认不出就 `undefined`，由调用方如实报错
 *
 *  ⚠ 尤其**不猜时区**：没有偏移的串（`2026-09-30 21:00:00`）这里判不了 ⇒ `undefined`。
 *  猜错的表现是"这一笔被算进（或漏出）今天"，界面上看不出来 —— 比一句
 *  "这个格式我解不出"糟得多。 */
export function parseInsertTimeMs(raw: string): number | undefined {
  const s = raw.trim();
  const tAt = s.indexOf('T');
  if (tAt < 0) return undefined;
  const date = s.slice(0, tAt);
  const rest = s.slice(tAt + 1);

  // 先切出时区偏移。时刻部分里没有 `+`/`-`，所以从右找到的那个符号就是偏移符号位
  // （`-05:00` 这种负偏移也找得到）。
  let time: string;
  let offsetSecs: number;
  if (rest.endsWith('Z') || rest.endsWith('z')) {
    time = rest.slice(0, -1);
    offsetSecs = 0;
  } else {
    const signAt = Math.max(rest.lastIndexOf('+'), rest.lastIndexOf('-'));
    if (signAt <= 0) return undefined;
    time = rest.slice(0, signAt);
    const off = rest.slice(signAt);
    const sign = off.startsWith('-') ? -1 : 1;
    const [hhRaw, mmRaw] = off.slice(1).split(':');
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return undefined;
    offsetSecs = sign * (hh * 3_600 + mm * 60);
  }

  // 小数秒只取前 3 位（毫秒）；日界判定用不着更细。
  const dotAt = time.indexOf('.');
  const hms = dotAt < 0 ? time : time.slice(0, dotAt);
  const frac = dotAt < 0 ? '' : time.slice(dotAt + 1);
  if (frac !== '' && !/^\d+$/.test(frac)) return undefined;
  const millis = frac === '' ? 0 : Number((frac + '000').slice(0, 3));

  const tp = hms.split(':');
  if (tp.length !== 3) return undefined;
  const hour = Number(tp[0]);
  const minute = Number(tp[1]);
  const second = Number(tp[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  const dp = date.split('-');
  if (dp.length !== 3) return undefined;
  const year = Number(dp[0]);
  const month = Number(dp[1]);
  const day = Number(dp[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;

  // 日期算术用 Howard Hinnant 的 `daysFromCivil`（照参考实现 `exchange.rs` 那一份）。
  // 不手写闰年循环 —— 闰年/世纪规则在这一段里已经收口成算术，"我自己写的闰年判断"
  // 正是这类代码最常见的错处。
  const days = daysFromCivil(year, month, day);
  const utcSecs = days * 86_400 + hour * 3_600 + minute * 60 + second - offsetSecs;
  return utcSecs * 1_000 + millis;
}

/** `(year, month, day)` → 1970-01-01 起的天数（Howard Hinnant 逐字实现）。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = y >= 0 ? Math.floor(y / 400) : Math.floor((y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (month + 9) % 12; // 3 月 → 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146_097 + doe - 719_468;
}

/** 这个月有多少天（含闰年规则）。 */
function daysInMonth(year: number, month: number): number {
  if (month === 1 || month === 3 || month === 5 || month === 7 || month === 8 || month === 10 || month === 12) {
    return 31;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

// ══════════════════════════ 流水的形状 ═════════════════════════════════════

/** 流水里的一笔（`parseCloudRecords` 的产物）。 */
export interface CloudRecord {
  /** 正负号就是进出。 */
  num: number;
  summary: string;
  mark: string;
  /** `inserttime` / `insertTime`（两种键名都收，照参考实现）。 */
  insertTime: string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 把 `unknown` 收成数字（数字字符串也认，照参考实现 `int_at`）。 */
function numAt(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

function strAt(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

/** 从信封的 `result.records` 解出一页流水。
 *
 *  ⚠ **没有 `result.records` 数组就抛错**（不"两种形状都吃"）：这是原实现明确写过的
 *  坑——一个"什么都能解"的兼容解析器，等上游改形状时这条链不会响。 */
export function parseCloudRecords(result: unknown): CloudRecord[] {
  if (!isRecord(result)) {
    throw new Error('cloudRecordV2 响应缺少 result 对象');
  }
  const records = result.records;
  if (!Array.isArray(records)) {
    throw new Error('cloudRecordV2 响应缺少 result.records 数组');
  }
  return records.map((x) => {
    const o = isRecord(x) ? x : {};
    const it = o.inserttime ?? o.insertTime;
    return {
      num: numAt(o, 'num'),
      summary: strAt(o, 'summary'),
      mark: strAt(o, 'mark'),
      insertTime: typeof it === 'string' ? it : undefined,
    };
  });
}

// ══════════════════════════ 今日汇总（纯函数）══════════════════════════════

/** 一个账号**今天**的读数。
 *
 *  刻意**不含账号主键**：聚合是纯函数，账号由调用方配；也就没有"把两个账号加一起"
 *  这种写法 —— 形状上摆不下。 */
export interface BeanDay {
  /** 今日净增（进 − 出）。可负 —— 兑换扣豆也在这条流水里。 */
  net: number;
  /** 今日收入合计（正数）。 */
  gained: number;
  /** 今日支出合计（取正数）。 */
  spent: number;
  /** 今日读到几笔流水。 */
  count: number;
}

/** 把一段流水按"今天"过滤并汇总。**纯函数**，不碰网络。
 *
 *  # 解不出 `insertTime` 的流水 ⇒ 抛错（而不是丢掉）
 *
 *  丢掉它是**静默少算**：界面上"今天 +30"与"今天 +30（还有一笔不知道算不算）"长得
 *  一模一样。所以这里如实抛，由上层把那个账号挪进 `failed` —— "没读到"与
 *  "今天没进出"是两件事，不能混。 */
export function aggregateToday(records: readonly CloudRecord[], nowMs: number): BeanDay {
  let gained = 0;
  let spent = 0;
  let count = 0;
  for (const r of records) {
    if (r.insertTime === undefined) {
      throw new Error(`流水里有一笔没有 insertTime（${r.summary || '（无摘要）'}），读不出它是不是今天`);
    }
    const ts = parseInsertTimeMs(r.insertTime);
    if (ts === undefined) {
      throw new Error(`流水的 insertTime 解不出（${r.insertTime}）—— 不猜它属于哪一天`);
    }
    if (!isToday(ts, nowMs)) continue;
    count += 1;
    // `num` 的正负号就是进出。`0` 归进收入一侧（+0），两种写法等价。
    if (r.num >= 0) gained += r.num;
    else spent += -r.num;
  }
  return { net: gained - spent, gained, spent, count };
}

// ══════════════════════════ 明细（不限今日，纯函数部分）════════════════════

/** 明细里的一笔（**上游原话**，只做了时间归一）。 */
export interface BeanRecord {
  /** `insertTime` 归一的 epoch 毫秒。**解不出就是 `undefined`**（不猜时区）。 */
  atMs: number | undefined;
  /** 原样的 `insertTime`。`atMs` 为 `undefined` 时这是唯一能显示的东西。 */
  rawTime: string | undefined;
  num: number;
  summary: string;
  mark: string;
}

/** 一个账号的流水明细（**不限于今日**）。 */
export interface BeanRecords {
  /** 按时间**倒序**（新在前）。解不出时间的那几笔排在最后。 */
  records: BeanRecord[];
  /** 时间解不出的笔数。⚠ 这些笔**已经在 `records` 里**，这里只是如实数出来 ——
   *  "不知道它属于哪天"不等于"它不是一笔"。 */
  undated: number;
  /** 还有没读到的（撞页数上限或 `MAX_DETAIL_RECORDS`）⇒ 这一份可能不全。 */
  hasMore: boolean;
}

/** 把已拉全的流水做成明细：按窗口过滤、倒序、截到 `limit`。**纯函数**。
 *
 *  `sinceMs` 为 `undefined` = 不限。**时间解不出的笔照样列出来**（`atMs=undefined`）：
 *  按窗口丢掉它们就是静默少算，而它们恰恰最需要人看一眼（上游换时间格式时全落这里）。
 *
 *  # `truncated`（翻到 `MAX_PAGES` 还是满页）
 *
 *  看明细的人点的是"全部"，500 条 + 一句"还有更多"比一个红框有用 ⇒ 这里把"可能不全"
 *  做成如实回传的标志，而不是抛错。（今日汇总那条走 [`aggregateToday`]，那里会抛。） */
export function buildRecords(
  all: readonly CloudRecord[],
  sinceMs: number | undefined,
  limit: number,
  truncated: boolean,
): BeanRecords {
  let recs: BeanRecord[] = all.map((r) => ({
    atMs: r.insertTime === undefined ? undefined : parseInsertTimeMs(r.insertTime),
    rawTime: r.insertTime,
    num: r.num,
    summary: r.summary,
    mark: r.mark,
  }));
  // 窗口之外（时间认得出来且早于下界）才丢；不限窗口或时间解不出 ⇒ 留着。
  if (sinceMs !== undefined) {
    recs = recs.filter((r) => r.atMs === undefined || r.atMs >= sinceMs);
  }
  // 倒序：`undefined` 排最后。
  recs.sort((a, b) => {
    const x = a.atMs;
    const y = b.atMs;
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return y - x;
  });
  let hasMore = truncated;
  if (recs.length > limit) {
    recs = recs.slice(0, limit);
    hasMore = true;
  }
  const undated = recs.filter((r) => r.atMs === undefined).length;
  return { records: recs, undated, hasMore };
}

// ══════════════════════════ 取数（注入 fetch，不碰传输层）══════════════════

/** 拉一页流水（返回 `result.records` 那一段）。
 *
 *  ⚠ 由**调用方**注入：路由里传"按账号的 `callOnce` + 会话"，测试里传桩。
 *  本模块不认识 store / transport / host-api —— 与 `routes.ts` 那条"逻辑不 import
 *  host-api"的纪律同一套。翻页失败（网络 / 码非 0 / 形状不对）**原样抛**，
 *  由上层按账号隔离。 */
export type FetchPage = (pageNumber: number) => CloudRecord[];

/** 翻到短页为止，返回全部流水 + 是否"撞满页还没到底"（`truncated`）。 */
function fetchAll(fetch: FetchPage): { all: CloudRecord[]; truncated: boolean } {
  const all: CloudRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = fetch(page);
    const full = batch.length === PAGE_SIZE;
    all.push(...batch);
    if (!full) return { all, truncated: false };
    if (page === MAX_PAGES) return { all, truncated: true };
  }
  // 循环里已经 return 了；到不了这里。
  return { all, truncated: true };
}

/** 只读：拉一个账号的**全部**流水（翻到短页为止），再按今天汇总。
 *
 *  翻满 `MAX_PAGES` 还是满页 ⇒ 抛错（"没拿到全部，不报一个可能少算的数"）——
 *  调用方据此把该账号挪进 `failed`，不影响别的账号。 */
export function readDay(fetch: FetchPage, nowMs: number): BeanDay {
  const { all, truncated } = fetchAll(fetch);
  if (truncated) {
    throw new Error(`AI豆流水翻满 ${MAX_PAGES} 页仍是满页，读不到底 —— 不报一个可能少算的数`);
  }
  return aggregateToday(all, nowMs);
}

/** 只读：拉一个账号的**全部**流水，按窗口过滤、倒序、截到 `limit`。
 *
 *  与 [`readDay`] 共用翻页口径，区别只在"可能不全"做成 `hasMore` 标志而不是抛错。 */
export function readRecords(
  fetch: FetchPage,
  sinceMs: number | undefined,
  limit: number,
): BeanRecords {
  const { all, truncated } = fetchAll(fetch);
  return buildRecords(all, sinceMs, limit, truncated);
}
