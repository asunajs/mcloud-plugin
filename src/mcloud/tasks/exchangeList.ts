// 任务：兑换清单（`exchange-list`）—— `exchange` 的**只读那一半**。
//
// 写的那半（下单）要过**滑块**，而滑块接口**计失败次数**（白花额度），
// 而且下单是**真扣 AI豆、不可回滚**。所以先做这一半：把清单读回来，
// 逐件判"现在能不能兑"。**不碰余额、不碰滑块、不下单。**
//
// # 三个必须照实说的地方（都来自原项目源码）
//
// ① **group 键不连续**。实拍九个键是 `0,1,2,5,7,8,9,11,15` —— 按 `0..n` 遍历
//    会**静默漏掉一半**且不报错。所以只能按响应里**真实的键**遍历。
// ② **`limit` 缺了就是判不了**，不是"多半能兑"。原项目写得明白：
//    "当成'多半可兑'会白发一笔真扣豆的请求"。所以缺 `limit` 时我们**不说可兑**。
// ③ **没有余额读数** ⇒ 判不出"豆不够"。这是**刻意的取舍**：余额要打 `infoV3`
//    （账号级请求），多打一枪就多一分风控噪声，而"看一眼清单"不值这一枪。
//    代价是：我们标"可兑"的，用户真去兑时仍可能被链挡下 ——
//    但**那一次挡下有错误码**，不会静默不发。界面必须把这句话写出来。
//
// 还有一条：`onLine` 非 1 是下架，但**非 1 的取值零样本** ⇒ 只认"明确给了且不是 1"，
// 缺字段不算下架。
//
// # ⚠ 2026-10-14 真机实测改掉的两处（都是 mock 藏不住的）
//
// ① **名字的字段名是 `prizeName`，不是 `name`**。原先读 `o.name` ⇒ 51 件**全都读不到名字**，
//    界面只能显示 `#260630012` 这种 id。而 mock 那边是按 `name` 造的 ⇒ 测试全绿、真机全瞎。
// 现在是 `prizeName ?? name`（两个都认，取值顺序有据：真机 51/51 都是 `prizeName`）。
//
// ② **月度限领次数在 `probability2` 里，而它是个 JSON 字符串**：
//    `{"multi":true,"limitMonthQuantity":3}`；配合 `receiveQuantity`（本月已领几次）。
//    原先完全不读 ⇒ 额度用完后仍然报"可兑"—— 而这**正是本文件头 ② 最反对的那类假结论**
//    （"当成'多半可兑'会白发一笔真扣豆的请求"）。
//    现在读它，并给出一个**不说"可兑"**的档位 `month-limit`。
//
//    ⚠ 语义边界照实说：`receiveQuantity` 到底是"本月已领"还是"累计已领"**没有样本**
//    （真机上它恒为 0）。所以文案写的是"**可能**已达本月额度"，而不是"已达"——
//    宁可少报一次可兑，也不要报出一个会被上游挡下的"可兑"。


import { resultObject } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import type { Store } from '../../store/types.ts';

export const STATE_LIST = 'mcloud.exchangelist.last';
/** `runTask` 会把"这次响应的快照"写进 `stateKey` —— 所以**必须用另一个键**，
 *  否则它会把我算出来的读数覆盖掉（实测踩过：读数里 okCount 变 undefined）。 */
export const STATE_RAW = 'mcloud.exchangelist.raw';

/** `limit` 的档位（原项目常量，逐字抄）。`0` 可兑、`1` 明日再来、`2` 本件已兑、`4` 本组已兑。 */
export const LIMIT_AVAILABLE = 0;
export const LIMIT_TOMORROW = 1;
export const LIMIT_EXCHANGED = 2;
export const LIMIT_GROUP_EXCHANGED = 4;

export interface ExchangePrize {
  prizeId?: number;
  name?: string;
  /** 本月限领次数（来自 `probability2.limitMonthQuantity`）。缺 = 这一件没设月度额度。 */
  monthLimit?: number;
  /** 本月已领几次（`receiveQuantity`）。语义有边界，见文件头。 */
  received?: number;
  groupId?: number;
  price?: number;
  /** 本账号对**这一件**的可兑状态 */
  limit?: number;
  count?: number;
  totalCount?: number;
  dailyRemainderCount?: number;
  dailyCount?: number;
  /** H5 判「奖品被抢光啦」的那一格：`== 0` 就是这一档/今天的份额没了。
   *  ⚠ 它和 `count`（池子现量）是两件事：池子里可能还有货，但今天抢不到了。 */
  minRemainderCount?: number;
  onLine?: number;
  startTime?: string;
  endTime?: string;
}

/** 一件商品"现在能不能兑"的结论。 */
export type Verdict =
  | 'ok' // 可以下单（但仍可能被余额挡下 —— 见文件头 ③）
  | 'tomorrow' // 明日再来
  | 'exchanged' // 这一件本月已兑
  | 'group-exchanged' // 这一组本月已兑
  | 'limit-missing' // 上游没给 `limit` —— 判不了，不是"多半能兑"
  | 'min-remainder-zero' // H5 的「奖品被抢光啦」：份额阈值是 0
  | 'sold-out' // 池子现量 ≤ 0
  | 'daily-empty' // 今日余量 ≤ 0
  | 'offline' // 明确下架
  | 'month-limit' // 本月额度**可能**已用完 —— 不说可兑
  | 'unknown'; // 判不了（字段缺 / 没见过的档位）—— **不说可兑**

export function verdictOf(p: ExchangePrize): Verdict {
  if (p.onLine !== undefined && p.onLine !== 1) return 'offline';
  // 月度额度先于 `limit` 判：`limit=0`（可兑）说的是这一件的**当天/当期**状态，
  // 而月度额度用完后上游仍会挡下 —— 两边冲突时以更保守的那个为准
  if (p.monthLimit !== undefined && p.received !== undefined && p.received >= p.monthLimit) {
    return 'month-limit';
  }
  if (p.limit === undefined) return 'limit-missing';
  // 以下三条与 Rust mcloud 的 `plan_exchange` 同序：余量阈值 → 总余量 → 今日余量。
  // ⚠ 它们排在 `limit` 之后（`limit` 先告诉用户"明天再来/本月已兑"），
  //   但在"可兑"这一档里必须继续判 —— 否则会报一个注定被上游挡下的"可兑"。
  if (p.limit === LIMIT_AVAILABLE) {
    if (p.minRemainderCount === 0) return 'min-remainder-zero';
    if (p.count !== undefined && p.count <= 0) return 'sold-out';
    if (p.dailyRemainderCount !== undefined && p.dailyRemainderCount <= 0) return 'daily-empty';
  }
  switch (p.limit) {
    case LIMIT_AVAILABLE:
      return 'ok';
    case LIMIT_TOMORROW:
      return 'tomorrow';
    case LIMIT_EXCHANGED:
      return 'exchanged';
    case LIMIT_GROUP_EXCHANGED:
      return 'group-exchanged';
    default:
      return 'unknown';
  }
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  ok: '可兑',
  tomorrow: '明日再来',
  exchanged: '本件本月已兑',
  'group-exchanged': '这一组本月兑过了',
  'limit-missing': '移动云盘没给可兑状态',
  'min-remainder-zero': '已抢光',
  'sold-out': '池子已兑完',
  'daily-empty': '今日已抢完',
  offline: '已下架',
  'month-limit': '本月额度可能已用完',
  unknown: '移动云盘没给可兑状态',
};

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 解 `probability2` 里的月度限领次数。
 *
 *  ⚠ 它是个 **JSON 字符串**（不是对象）：`{"multi":true,"limitMonthQuantity":3}`。
 *  解不出来就返回 `undefined` —— 缺字段**不算**额度用完（宁可放过，不可误报）。 */
export function parseMonthLimit(v: unknown): number | undefined {
  let o: unknown = v;
  if (typeof v === 'string') {
    try { o = JSON.parse(v); } catch { return undefined; }
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  return asInt(r.limitMonthQuantity ?? r.limit_month_quantity);
}

export function parsePrize(raw: unknown): ExchangePrize | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const p: ExchangePrize = {
    // ⚠ 实拍是**数字**，不是字符串（原项目特意标了这一点）
    prizeId: asInt(o.prizeId ?? o.prize_id),
    // ⚠ 真机 51/51 是 `prizeName`；`name` 保留是为兼容 mock 与将来可能的另一种形状
    name: asStr(o.prizeName ?? o.name),
    monthLimit: parseMonthLimit(o.probability2),
    received: asInt(o.receiveQuantity ?? o.receive_quantity),
    groupId: asInt(o.groupId ?? o.group_id),
    // ⚠⚠ 价格是 **`pOrder`**（不是 `price`）—— 而且同一份响应里 `POrder` 与 `pOrder`
    // **两种拼法并存**，只读一个键的写法会把一部分商品的价格判成"没给"，
    // 于是"余额够不够"那道判断对那几件**恒假**（看着像"没配置价格"，其实是不检查就下单）。
    // 逐字照 mcloud 的 `parse_price`：小写先试，大写兜底。
    price: asInt(o.pOrder) ?? asInt(o.POrder),
    limit: asInt(o.limit),
    count: asInt(o.count),
    totalCount: asInt(o.totalCount ?? o.total_count),
    dailyRemainderCount: asInt(o.dailyRemainderCount ?? o.daily_remainder_count),
    dailyCount: asInt(o.dailyCount ?? o.daily_count),
    minRemainderCount: asInt(o.minRemainderCount ?? o.min_remainder_count),
    onLine: asInt(o.onLine ?? o.on_line),
    startTime: asStr(o.startTime ?? o.start_time),
    endTime: asStr(o.endTime ?? o.end_time),
  };
  return p.prizeId !== undefined || p.name !== undefined ? p : undefined;
}

/** 解清单。**按响应里真实的 group 键遍历**（见文件头 ①）。 */
export function parseExchangeList(result: unknown): { groups: { group: string; prizes: ExchangePrize[] }[]; prizes: ExchangePrize[] } {
  const o = resultObject({ code: 0, message: '', result, ok: true });
  // 顶层可能是 { groups: {...} }，也可能直接就是键表
  const src = (o.groups ?? o) as Record<string, unknown>;
  const groups: { group: string; prizes: ExchangePrize[] }[] = [];
  const all: ExchangePrize[] = [];
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const key of Object.keys(src)) {
      const v = (src as Record<string, unknown>)[key];
      if (!Array.isArray(v)) continue;
      const prizes = v.map(parsePrize).filter((x): x is ExchangePrize => !!x);
      groups.push({ group: key, prizes });
      all.push(...prizes);
    }
  }
  // 数值升序（"10" 要排在 "2" 后面，不是字典序）
  groups.sort((a, b) => (Number(a.group) || 0) - (Number(b.group) || 0));
  all.sort((a, b) => (a.groupId ?? 0) - (b.groupId ?? 0) || (a.prizeId ?? 0) - (b.prizeId ?? 0));
  return { groups, prizes: all };
}

export interface ExchangeReading {
  at: string;
  total: number;
  okCount: number;
  byVerdict: Record<string, number>;
  /** 可兑的那几件（界面直接列，最多 20 件） */
  ok: { prizeId?: number; name?: string; price?: number; groupId?: number }[];
  groups: number;
}

export function summarizeList(prizes: ExchangePrize[]): Omit<ExchangeReading, 'at' | 'groups'> {
  const byVerdict: Record<string, number> = {};
  const ok: ExchangeReading['ok'] = [];
  for (const p of prizes) {
    const v = verdictOf(p);
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    if (v === 'ok' && ok.length < 20) {
      ok.push({ prizeId: p.prizeId, name: p.name, price: p.price, groupId: p.groupId });
    }
  }
  return { total: prizes.length, okCount: byVerdict.ok ?? 0, byVerdict, ok };
}

/** 读一次清单（只读）。 */
export function runExchangeList(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'exchange-list',
      endpoint: 'exchangeList',
      method: 'GET',
      marketName: 'sign_in_3',
      isDeviceId: false,
      stateKey: STATE_RAW,
    },
    (env) => {
      const { groups, prizes } = parseExchangeList(env.result);
      const s = summarizeList(prizes);
      const reading: ExchangeReading = { at: deps.nowIso, groups: groups.length, ...s };
      deps.store.setState(STATE_LIST, JSON.stringify(reading), deps.nowIso);
      // 界面上「选一件」的下拉读这一份（全量，摘要里只有可兑的前 20 件）
      savePickCache(deps.store, prizes, deps.nowIso);
      // ⚠ 价格**只在有值时才写**。2026-10-14 真机实测：这个端点**一件都不带价格字段**
      // （51/51 都没有），所以原先那版会输出 `移动云盘100G云空间月卡(?豆)` ——
      // 那个 `?` 会被读成"这里有个数没解析出来"，而真相是"这个端根本不报价格"。
      // 价格要在**下单那一步**才知道（那也是它真扣豆的地方）。
      const names = s.ok.slice(0, 3).map((x) =>
        x.price === undefined ? (x.name ?? '#' + x.prizeId) : `${x.name ?? '#' + x.prizeId}(${x.price}豆)`,
      );
      return {
        ok: true,
        note:
          `兑换清单：${groups.length} 组 / ${s.total} 件，可兑 ${s.okCount} 件` +
          (names.length ? `（${names.join('、')}）` : '') +
          (s.byVerdict.unknown ? `；判不了 ${s.byVerdict.unknown} 件` : ''),
        snapshot: reading,
      };
    },
  );
}

/** 界面读这个（从库里拿最近一次读数）。 */
export function readExchangeList(store: { getState(k: string): string | null | undefined }): ExchangeReading | null {
  const raw = store.getState(STATE_LIST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExchangeReading;
  } catch {
    return null;
  }
}

// ══════════════════════ 「选一件」那份缓存 ══════════════════════
//
// # 为什么要单独一份，不复用上面那个读数
//
// {@link ExchangeReading} 是**摘要**：`ok` 只留可兑的前 20 件，界面上要搜的
// 那件（"明日再来"的、已经兑过的、下架的）根本不在里面。
// 而下拉要能搜到**每一件** —— 所以存的是全量，但只留下拉用得上的四格。
//
// # 为什么"缓存"而不是"每次开界面去打一枪"
//
// 用户要的（2026-10-17）：名字**不该自己写**，从下拉里选。
// 那就得有一份清单随时拿得出来；而这一屏打开的频率远高于清单变化的频率。
// 代价是**可能读到昨天的名字** ⇒ 每天作废一次（见 {@link readPickCache}）。

/** 缓存键（**按账号**：清单与判据都是账号级的）。 */
export const STATE_PICK = 'mcloud.exchangelist.pick';

export interface PickItem {
  /** 上游的 `prizeId`（界面上当"编号"用，也是搜数字时的命中项） */
  id?: number;
  /** 分组。界面上按它分组（组名上游没给，就显示「第 N 组」）。 */
  groupId?: number;
  /** **上游那句名字，一字不改** —— 保存目标时发回去的就是这一串。
   *  ⇒ "名字要写完整（「月卡」不会命中「季卡」）"那个坑从源头上没了。 */
  name: string;
  /** 要多少豆。⚠ 这个端点**经常一件都不带价格**（见文件头），缺就是缺，不补 0。 */
  price?: number;
  verdict: Verdict;
  /** 今天还剩几件（`dailyRemainderCount`；没给就 `undefined`，**不当 0**）。 */
  remain?: number;
  /** 池子现量 / 总量。界面把「池子」与「今天份额」分开说。 */
  count?: number;
  totalCount?: number;
  /** 今日已发 / 今日总量（上游字段名就是 daily*）。 */
  dailyRemainderCount?: number;
  dailyCount?: number;
  minRemainderCount?: number;
  /** 活动窗口（同组通常相同；界面只在组头显示）。 */
  startTime?: string;
  endTime?: string;
  /** 本月限领次数 / 已领次数（用于显示"本月额度"）。 */
  monthLimit?: number;
  received?: number;
}

export interface PickCache {
  /** 这份缓存是**哪天**建的（与 `nowIso.slice(0,10)` 同一种日界）。 */
  date: string;
  items: PickItem[];
}

/** 挑出下拉用得上的那几格。**没有名字的跳过** —— 界面上没法标它，
 *  而发回上游的查询串要么靠名字、要么靠编号，两者都没有就没法选。 */
export function toPickItems(prizes: readonly ExchangePrize[]): PickItem[] {
  const out: PickItem[] = [];
  for (const p of prizes) {
    const name = p.name?.trim();
    if (name === undefined || name === '') continue;
    const item: PickItem = { name, verdict: verdictOf(p) };
    if (p.prizeId !== undefined) item.id = p.prizeId;
    if (p.groupId !== undefined) item.groupId = p.groupId;
    if (p.price !== undefined) item.price = p.price;
    if (p.dailyRemainderCount !== undefined) item.remain = p.dailyRemainderCount;
    if (p.count !== undefined) item.count = p.count;
    if (p.totalCount !== undefined) item.totalCount = p.totalCount;
    if (p.dailyRemainderCount !== undefined) item.dailyRemainderCount = p.dailyRemainderCount;
    if (p.dailyCount !== undefined) item.dailyCount = p.dailyCount;
    if (p.minRemainderCount !== undefined) item.minRemainderCount = p.minRemainderCount;
    if (p.startTime !== undefined) item.startTime = p.startTime;
    if (p.endTime !== undefined) item.endTime = p.endTime;
    if (p.monthLimit !== undefined) item.monthLimit = p.monthLimit;
    if (p.received !== undefined) item.received = p.received;
    out.push(item);
  }
  return out;
}

/** 建/覆盖缓存。**只在清单读成功时调用** —— 读失败不许顺手把上一次的清掉，
 *  否则"上游抖一下"就把这一屏的下拉清空了（而下拉里昨天的名字也比没有强）。 */
export function savePickCache(
  store: Pick<Store, 'setState'>,
  prizes: readonly ExchangePrize[],
  nowIso: string,
): void {
  const cache: PickCache = { date: nowIso.slice(0, 10), items: toPickItems(prizes) };
  store.setState(STATE_PICK, JSON.stringify(cache), nowIso);
}

/** 读缓存。⚠ **过期即清**：日界不是今天 ⇒ 写空、回 `null`。
 *
 *  清理点在**用户点开那一屏**的时候（`/exchange` 视图与 `/exchange/picks` 都走这里），
 *  所以不用挂定时器 —— 没人看的时候这份数据无所谓新不新。 */
export function readPickCache(
  store: Pick<Store, 'getState' | 'setState'>,
  nowIso: string,
): PickCache | null {
  const raw = store.getState(STATE_PICK);
  if (raw === null || raw === undefined || raw === '') return null;
  const today = nowIso.slice(0, 10);
  let c: PickCache | null = null;
  try {
    const v = JSON.parse(raw) as Partial<PickCache>;
    if (Array.isArray(v.items)) {
      c = { date: typeof v.date === 'string' ? v.date : '', items: v.items as PickItem[] };
    }
  } catch {
    c = null;
  }
  if (c === null || c.date !== today) {
    // 过期/坏数据：就地清掉（回 `null` 让界面知道"该去读一次"）
    store.setState(STATE_PICK, '', nowIso);
    return null;
  }
  return c;
}


// ══════════════════════ 订阅（「我关注的奖品」） ══════════════════════
//
// 原 Rust mcloud 的订阅是服务端列表；这里按账号存在插件自己的库里。
// 目的不是"同步到所有设备"，而是让用户把常抢的几件固定到兑换页顶部 ——
// 清单每天变，关注的 id/名字不变。

export const STATE_SUBS = 'mcloud.exchange.subs';

export interface ExchangeSub {
  id?: number;
  name: string;
}

export function readSubscriptions(store: {
  getState(k: string): string | null | undefined;
}): ExchangeSub[] {
  const raw = store.getState(STATE_SUBS);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: ExchangeSub[] = [];
    for (const x of v) {
      if (x === null || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (name === '') continue;
      const id = typeof o.id === 'number' && Number.isFinite(o.id) ? Math.trunc(o.id) : undefined;
      out.push(id === undefined ? { name } : { id, name });
    }
    return out;
  } catch {
    return [];
  }
}

/** 开/关关注。`on=false` 时按 id（有）或名字（没有）移除。 */
export function toggleSubscription(
  store: { getState(k: string): string | null | undefined; setState(k: string, v: string, at: string): void },
  sub: ExchangeSub,
  on: boolean,
  nowIso: string,
): ExchangeSub[] {
  const name = sub.name.trim();
  if (name === '') return readSubscriptions(store);
  const same = (x: ExchangeSub): boolean =>
    sub.id !== undefined ? x.id === sub.id : x.name === name;
  const cur = readSubscriptions(store).filter((x) => !same(x));
  if (on) {
    cur.push(sub.id === undefined ? { name } : { id: sub.id, name });
  }
  store.setState(STATE_SUBS, JSON.stringify(cur), nowIso);
  return cur;
}
