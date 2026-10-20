// AI豆读数的**按账号接线层** —— 把 `beans.ts` 的纯函数拼到"发一次 `cloudRecordV2`"这件事上。
//
// # 为什么单独一层
//
// `beans.ts` 是纯函数（东八区日界 / `insertTime` 归一 / 聚合 / 翻页规则），它**不 import
// 传输层也不 import store** —— 于是 Node 里可以随便测（照 `routes.ts` 那条"逻辑不
// import host-api"的同一份纪律）。但两条路由要打上游：得**给每个账号**建一份会话、
// 组请求头、发一次、并 cookie 回去。这一层就干这件事，薄。
//
// # 按账号，不是"当前账号"
//
// 「今日AI豆」那张卡是**多账号一列**（每个账号一本账）。所以这里必须显式收一个
// 已经 `scoped(raw, id)` 过的 store —— 而不是在函数里再回去读"当前是谁"（那会
// 让每个账号读到的都是当前那一条的会话；F-048/049/050 那串 bug 的原样）。
//
// # 只读
//
// 只有一枪：`GET cloudRecordV2`。不取滑块、不下单、没有一个会改用户账上东西的请求。

import { loadSession, saveSession } from '../store/types.ts';
import type { Store } from '../store/types.ts';
import { callOnce, mergeCookieJar } from './client.ts';
import type { Transport } from './client.ts';
import { buildH5Request, REFERER_SIGN_IN, resolveUrl, SHOW_LOADING } from './h5.ts';
import { parseSignInEnvelope } from './envelope.ts';
import { resultObject } from './envelope.ts';
import { hostBase, sessionHeaders } from './tasks/base.ts';
import { LoginExpiredError, withTokenGate } from './tokenGate.ts';

import {
  beanQuery,
  MAX_DETAIL_RECORDS,
  parseCloudRecords,
  rangeSinceMs,
  readDay as beansReadDay,
  readRecords as beansReadRecords,
  type BeanDay,
  type BeanRecords,
} from './beans.ts';

/** 今日汇总 / 当前余额的缓存时长。用户口径：2 小时。 */
export const BEANS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** 缓存落在**账号自己的袋**里（余额和流水都是这个账号的）。 */
export const STATE_BEANS_CACHE = 'mcloud.beans.cache';

export interface BeansCache {
  day?: { atMs: number; dayStart: number; day: BeanDay };
  balance?: { atMs: number; value: number | null; reason?: string };
}

export function loadBeansCache(store: Pick<Store, 'getState'>): BeansCache {
  const raw = store.getState(STATE_BEANS_CACHE);
  if (raw === null || raw === '') return {};
  try {
    const x = JSON.parse(raw) as unknown;
    return typeof x === 'object' && x !== null ? (x as BeansCache) : {};
  } catch {
    return {};
  }
}

export function saveBeansCache(
  store: Pick<Store, 'setState'>,
  cache: BeansCache,
  nowIso: string,
): void {
  store.setState(STATE_BEANS_CACHE, JSON.stringify(cache), nowIso);
}

/** 这一层要用的东西：一个已经作用到某账号的 store，加传输与基址。 */
export interface BeanAccountDeps {
  /** ⚠ **必须是 `scoped(rawStoreOf(base), acctId)` 出来的那一份** ——
   *  `loadSession` 读的是"这一袋里的会话"，用错了袋就串号。 */
  store: Store;
  transport: Transport;
  /** 覆盖上游基址（指到 mock 用）；空 = 用真地址。 */
  baseUrl?: string | undefined;
  /** 落盘 cookie 续期时用的时间戳（不注入就 `new Date().toISOString()`）。 */
  nowIso?: string | undefined;
}

/** 给这个账号造一个 `FetchPage`：`page → CloudRecord[]`。
 *
 *  # 会话**每一枪重读**（无感刷新的前提）
 *
 *  ⚠ 不能在闭包里 `loadSession` 一次、之后每一页复用那一份。换票换到的新票是
 *  写进会话那一格的（`runExchangeStep` 末尾 `saveSession`），而 `withTokenGate`
 *  撞 `90001` 后要拿**新票**重读 —— 外层缓存的旧票重试永远撞 `90001`。
 *  所以 `loadSession` 必须落在返回的那个函数**里面**，每页现读。
 *
 *  # `90001` / 无会话 ⇒ 抛 `LoginExpiredError`（可自愈那一类）
 *
 *  这两个是"票的问题"，不是"账号被踢"，也不是网络坏了 —— 交给 `withTokenGate`
 *  换票重试。其余失败（网络 / HTTP 非 2xx / 别的码 / 解不出 `records`）照**普通失败**抛，
 *  由调用方（路由）按账号挪进 `failed`，**不进重试循环**（重试一个断掉的网没有意义）。
 *
 *  # cookie 续期（照 `tasks/base.ts::runTask` 那一段）
 *
 *  上游顺手回的 `set-cookie` 要并回会话那一格。翻页时每一枪都可能带回新的
 *  cookie —— 不并回去，下一枪就用旧 cookie 撞上游，看着像"上游坏了"其实是我们自己没续。 */
function makeFetchPage(deps: BeanAccountDeps): (pageNumber: number) => ReturnType<typeof parseCloudRecords> {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const base = hostBase({ baseUrl: deps.baseUrl }, '');
  return (pageNumber: number): ReturnType<typeof parseCloudRecords> => {
    // ⚠ 每一枪现读会话（见上面"会话每一枪重读"）
    const session = loadSession(deps.store);
    if (session === null) throw new LoginExpiredError('这个账号还没有网页会话');
    const url = resolveUrl('cloudRecordV2', base === '' ? undefined : base) + `?${beanQuery(pageNumber)}`;
    const req = buildH5Request({
      url,
      method: 'GET',
      referer: REFERER_SIGN_IN,
      showLoading: SHOW_LOADING,
      isDeviceId: false,
      saltKey: 1,
      session: sessionHeaders(session),
    });
    const res = callOnce(deps.transport, req);
    if (res.setCookies.length > 0) {
      saveSession(
        deps.store,
        { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
        nowIso,
      );
    }
    // `90001` 单独认（它藏在"HTTP 200 + 信封码非 0"里，`!res.ok` 那一支会一并抓到，
    // 但那是"账号被踢 / 网络坏"那一类的 catch-all —— 这一类要分出来给无感刷新）。
    if (res.env?.code === 90001) throw new LoginExpiredError();
    if (!res.ok) {
      // 其余失败：上游原话照抄（`res.error` 已经是「code=… msg=…」那种），不猜、不美化。
      throw new Error(res.error ?? 'cloudRecordV2 请求失败');
    }
    const env = res.env ?? parseSignInEnvelope(res.body);
    return parseCloudRecords(resultObject(env));
  };
}

/** `BeanAccountDeps` → `withTokenGate` 要的 deps（`nowIso` 那里是必填，这里补默认）。 */
function gateDeps(deps: BeanAccountDeps): Parameters<typeof withTokenGate>[0] {
  return {
    store: deps.store,
    transport: deps.transport,
    nowIso: deps.nowIso ?? new Date().toISOString(),
    baseUrl: deps.baseUrl,
  };
}

/** 只读：一个账号**今天**的 AI豆读数。
 *
 *  外面套 `withTokenGate`：票到期/被拒就当场换票重试（用户要的"无感刷新"）。
 *  抛错的语义都归"这个账号读不到"（无会话且换不出票 / 网络 / 上游码 / 翻不到底 /
 *  解不出 `insertTime`）—— 调用方按账号挪进 `failed[]`，**不影响别的账号**。 */
export function readDayForAccount(deps: BeanAccountDeps, nowMs: number): BeanDay {
  return withTokenGate(gateDeps(deps), () => beansReadDay(makeFetchPage(deps), nowMs));
}

/** 明细窗口 → `days` 数字（`1/7/30/0`，`0` = 全部）。**不在名单里的值一律当"全部"。**
 *
 *  为什么不 400：界面上那一档只有这四个值。传进来别的（手敲 URL / 老版界面）
 *  最合理的解读是"那就都给我看"，而不是让一次读数请求 400 掉。
 *  路由里会把这一条**如实回**在响应里（`days` 字段），不让人以为"窗口真的没生效"。 */
export function normalizeDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n === 1 || n === 7 || n === 30 ? n : 0;
}

/** 只读：一个账号的流水明细（按窗口过滤、倒序、截 `MAX_DETAIL_RECORDS`）。
 *
 *  与 [`readDayForAccount`] 同一层无感刷新（`withTokenGate`）：两条路由共用一条
 *  `cloudRecordV2`，票坏了都得当场换，不能只修其中一条。 */
export function readRecordsForAccount(
  deps: BeanAccountDeps,
  nowMs: number,
  days: number,
): BeanRecords {
  return withTokenGate(
    gateDeps(deps),
    () => beansReadRecords(makeFetchPage(deps), rangeSinceMs(days, nowMs), MAX_DETAIL_RECORDS),
  );
}
