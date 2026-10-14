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
  if (p.limit === undefined) return 'unknown';
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
  'group-exchanged': '本组本月已兑',
  offline: '已下架',
  'month-limit': '本月额度可能已用完',
  unknown: '判不了',
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
    price: asInt(o.price),
    limit: asInt(o.limit),
    count: asInt(o.count),
    totalCount: asInt(o.totalCount ?? o.total_count),
    dailyRemainderCount: asInt(o.dailyRemainderCount ?? o.daily_remainder_count),
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
