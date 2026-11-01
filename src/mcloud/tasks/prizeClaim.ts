// 「待领取奖品」的**领取链**（云朵中心 → 待领取，`National_Getprize`）。
//
// 端点与字段来自 2026-10-31 的实拍（`../mcloud-capture`）：
//   · 成文：`mcloud/upstream/h5-getprize-claim.md`（四段状态机、错误码、滑块几何）
//   · 原始：`mcloud/capture/app-getprize-samples.txt`（三笔 `code:0`，`flag` 由 1 翻 2）
//
// ```text
// getUserPrizeLogPageV2 (flag=1 待领取，**旧口**、不传市场)
//   └─► receivePrizeDetailsV2 (详情：prizetype / verifycode / sms / exchangeCode …)
//        └─► getSlidePuzzle (POST {}：picture=JPEG 680×400、puzzle=PNG 96×400 竖切片)
//             └─► sendPrizeSms {oid, puzzleOffset, app:0}      ← 触发验证码短信
//                  └─► acceptPrizeV2 {oid, smsCode, deviceId, …} ← 真正领取
// ```
//
// # 四个"照实拍、不顺手改"的决定
//
// ① **列表只用旧口**（`prizeApi/checkPrize/getUserPrizeLogPageV2`，不传市场）。
//    2026-10-24 真机实测：官方「奖品（待领取）」页用的就是它，110 条 / 13 个活动；
//    而云朵中心那个 H5 自己的新口（`signin/public/record`）**只覆盖 `sign_in_3_ex` 一个市场**
//    —— 算力大作战那笔在新口里根本不存在。领取页要"把能领的都列出来"，所以用旧口。
//    ⚠ 两个口的字段名不一样：旧口是 `oId`，新口是 `oid`（同一份数据的两种拼法）。
//
// ② **不预先调 `queryAcceptExt`**。实拍里页面**没发**这一条（静态调用点被 `T.value` 短路），
//    三笔领取都是"详情 → 取滑块 → 发短信"。我们照**跑通的那条路**走；
//    `queryAcceptExt` 的 `smsFlag` 语义（`1` ⇒ 要滑块）没被实拍证实，不拿它做闸。
//
// ③ **滑块必须本地算出来**。`getSlidePuzzle.puzzleLeft` 恒为 `null`，服务端不给答案；
//    而 `sendPrizeSms` 的 `puzzleOffset` 是必填。算法值与人工值差 9px 仍被接受（实拍），
//    第三笔用算法值 `526` 直接通过 —— 所以"算出来就发、算不出来就不发"。
//    ⚠ 底图 `picture` 是 **JPEG**（不是 PNG）⇒ 这里要 `jpeg` 解码器。
//
// ④ **短信验证码是 `MD5(用户输入的码)`（32 位小写 hex）**，只有 `prizetype` 为
//    `1028` / `1029` 时发明文。这条是静态分支 + 三笔实拍一致，别"统一明文"。
//
// # 没做的事（都写清楚，不假装做了）
//
// · `sendSpaceGiftPrize`（空间礼包那一发）实拍**没触发**，不作为领取成功的一部分。
// · `deviceId`：实拍三笔都是同一个 **84 字符 base64**，来自 App 客户端档案；
//   生成规则未核。我们用会话里那个 H5 `deviceId`（`B…`，与 `receiveV3` / `exchangeV3`
//   同源）。两者格式不同 —— 第一次真跑的读数才算数；若被服务端拒，读数会指出是哪一档。
// · 领奖成功后的"已领取"状态只来自**本页的缓存摘除** + 服务端 `flag` 复查（下一趟列表）。

import { md5Hex } from '../../crypto/index.ts';
import { callOnce, mergeCookieJar } from '../client.ts';
import type { CallResult, Transport } from '../client.ts';
import { resultObject } from '../envelope.ts';
import { MCLOUD_HOST, SHOW_LOADING, buildH5Request } from '../h5.ts';
import { calcPuzzleOffset, usable } from '../slide.ts';
import { loadSession, saveSession } from '../../store/types.ts';
import type { Store } from '../../store/types.ts';
import { LoginExpiredError, exchangeOnce, withTokenGate } from '../tokenGate.ts';
import { jwtFresh, loadAuthRaw } from '../sessionExchange.ts';
import { FALLBACK_RECIPE } from '../h5session.ts';
import { depsNowMs, hostBase, sessionHeaders } from './base.ts';

/** 这一族的页面常量：`activityid` 跟它走（实拍里服务端不拿它做鉴权/路由，但没理由不发）。 */
export const PRIZE_ACTIVITY = 'National_Getprize';
/** 取详情/滑块/发码/领取都从这一页发起。 */
export const PRIZE_REFERER = 'https://m.mcloud.139.com/portal/cloudItem/index.html?path=getPrize&sourceid=1000';
/** `acceptPrizeV2` 的 `source`：实拍恒 `"1000"`（与页面 URL 的 `sourceid` 同值）。 */
export const PRIZE_SOURCE = '1000';
/** 列表一页要多少条。官方页面用 4；参考实现用 100 实测能拿到 110 条 ⇒ 取 100 少跑几趟。 */
export const PRIZE_LIST_PAGE_SIZE = 100;
/** 最多翻 3 页（待领取本来就少；翻不到底就如实标 `hasMore`，不静默截断）。 */
export const PRIZE_LIST_MAX_PAGES = 3;
/** 列表缓存多久。点开页面/切账号不重复打上游；「刷新」带 `refresh=1` 强取。 */
export const PRIZE_CACHE_TTL_MS = 60_000;
/** 同一件两次发码的最小间隔。上游有"获取验证码频繁"（1001），本地先生效一层。 */
export const CLAIM_SMS_COOLDOWN_MS = 60_000;
/** 验证码有效期（我们自己的窗口）。超过就不再拿旧单去确认 —— 让用户重新发。 */
export const CLAIM_STATE_TTL_MS = 15 * 60_000;

/** 账本键：列表缓存（按账号）。 */
export const STATE_PRIZE_CACHE = 'mcloud.prizes.cache';
/** 账本键：进行中的那一单（按账号）。 */
export const STATE_PRIZE_CLAIM = 'mcloud.prizes.claim';

/** 端点（路径，主机走 `baseUrl` 覆盖）。 */
export const EP_PRIZE = {
  list: '/ycloud/prizeApi/checkPrize/getUserPrizeLogPageV2',
  detail: '/ycloud/prizeApi/checkPrize/receivePrizeDetailsV2',
  slide: '/ycloud/auth-service/auth/getSlidePuzzle',
  sms: '/ycloud/prize/api/sendPrizeSms',
  accept: '/ycloud/prize/api/acceptPrizeV2',
} as const;

export interface PrizeDeps {
  store: Store;
  transport: Transport;
  nowIso: string;
  baseUrl?: string | undefined;
  /** 注入"现在几点"（缓存/冷却判断）。测试用假时钟。 */
  nowMs?: (() => number) | undefined;
}

/** 列表里的一件（只留领取要用的字段；**凭据一律不进来**）。 */
export interface PrizeItem {
  /** 单号（旧口 `oId`）。没有它就没法领。 */
  oid: string;
  prizeId: number;
  name: string;
  /** 中文市场名（给人看），例如「全网算力大作战」。 */
  market: string;
  /** 市场 id（请求参数用），例如 `National_TokenPK`。 */
  marketId: string;
  expireAt?: string | undefined;
  insertedAt?: string | undefined;
  /** 脱敏手机号（旧口 `servNumber`，可能没有）。 */
  phone?: string | undefined;
  /** 下单能不能领（有 `oId` 才行）。 */
  claimable: boolean;
}

export interface PrizeListResult {
  /** `flag === 1` 的那些（已领取/未知档不进来）。 */
  items: PrizeItem[];
  /** 翻到的记录总数（含已领取的），用于说清"扫了多少条"。 */
  scanned: number;
  /** 上游给的总条数（没给就没有）。 */
  totalCount?: number | undefined;
  /** 翻到上限还没到底 ⇒ `true`（界面上要写"可能还有"，不静默）。 */
  hasMore: boolean;
  /** 读失败/某页没读成的原因；有它时 `items` 仍可能是前面几页的。 */
  failed?: string | undefined;
}

export interface PrizeCache {
  atMs: number;
  list: PrizeListResult;
}

/** 进行中的那一单（`sendPrizeSms` 之后才有）。 */
export interface PrizeClaimState {
  oid: string;
  prizeId: number;
  marketId: string;
  name: string;
  phone?: string | undefined;
  /** 上游详情里的 `prizetype`（决定验证码是否要 MD5）。 */
  prizetype?: string | undefined;
  sentAtMs: number;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** 手机号**自己再脱敏一层**。
 *
 *  ⚠ 上游的 `servNumber` 实拍是掩码（`159****7542`），但"上游会脱敏"不是我们的
 *  安全边界：哪天它改成明文，界面就会把一个完整手机号显示出来。所以这里再判一次：
 *  整串是 11 位手机号（或只带分隔符）就换成 `1****xxxx`；已经带 `*` 的原样留。 */
export function maskPhoneLike(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return undefined;
  if (/^1\d{10}$/.test(v)) return `${v.slice(0, 1)}****${v.slice(-4)}`;
  const digits = v.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `${digits.slice(0, 1)}****${digits.slice(-4)}`;
  // 带国家码的写法（`+86 159…` / `86-159…`）也不能漏
  if (digits.length === 13 && digits.startsWith('86')) return `1****${digits.slice(-4)}`;
  return v;
}

/** 去掉可能的 `data:image/...;base64,` 前缀（实拍是裸 base64，但别假设）。 */
const bareBase64 = (v: string): string => {
  const at = v.indexOf('base64,');
  return at >= 0 ? v.slice(at + 'base64,'.length) : v;
};

/** 一次请求：带签名/会话头、并把响应顺手给的 cookie 并回会话。 */
function sendOnce(
  deps: PrizeDeps,
  spec: {
    path: string;
    method: 'GET' | 'POST';
    query?: string | undefined;
    body?: string | undefined;
    contentType?: string | undefined;
    isDeviceId?: boolean | undefined;
  },
): CallResult {
  const session = loadSession(deps.store);
  const url =
    hostBase(deps, MCLOUD_HOST) + spec.path + (spec.query ? `?${spec.query}` : '');
  const req = buildH5Request({
    url,
    method: spec.method,
    body: spec.body,
    contentType: spec.contentType,
    referer: PRIZE_REFERER,
    showLoading: SHOW_LOADING,
    // ⚠ 逐接口：只有 `acceptPrizeV2` 实拍带 `isdeviceid: true`
    isDeviceId: spec.isDeviceId ?? false,
    saltKey: 1,
    marketName: PRIZE_ACTIVITY,
    session: session ? sessionHeaders(session) : {},
  });
  const res = callOnce(deps.transport, req);
  if (res.setCookies.length > 0 && session !== null) {
    saveSession(
      deps.store,
      { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
      deps.nowIso,
    );
  }
  // `90001` 是"票没被认"（可自愈），交给 `withTokenGate` 换票重试 —— 见文件头 ④。
  if (res.env?.code === 90001) throw new LoginExpiredError();
  return res;
}

/** 上游的业务码 → 人话。
 *
 *  ⚠ 表里大部分是**静态码表**（页面 bundle 里抄的），三笔实拍只撞到 `0`。
 *  所以这里的作用是"撞到时别只甩数字"，不是"已经证实过的判据"。
 *  出处：`../mcloud-capture/mcloud/upstream/h5-getprize-claim.md` §6。 */
export function prizeCodeText(code: number, msg?: string | undefined): string {
  const raw = (msg ?? '').trim();
  switch (code) {
    case 0:
      return '成功';
    case 514:
      return '滑块这道题没过 —— 再点一次「领取」，会换一道新题';
    case -6:
    case -7:
      return '验证码不对，重新输一次';
    case -8:
      return '点太快了，等一会儿再试';
    case 1001:
      return '刚发过验证码 —— 等一分钟再发';
    case 1002:
      return '今天短信发到上限了，明天再领';
    case 511:
      return '移动云盘那边正忙，稍后再试';
    case 1000:
      return '这件要去移动云盘页面里领';
    case 10010013:
      return '这件没中奖（未中奖）';
    case 10010004:
      return '这件已经过期了';
    case 10010018:
      return '这件已经被抢光了';
    default:
      return `移动云盘没领成（code ${code}${raw ? `：${raw}` : ''}）`;
  }
}

/** 读一页列表。解析失败要如实说（不拿空数组冒充"没有待领取"）。 */
function readListPage(deps: PrizeDeps, page: number): {
  ok: boolean;
  note?: string;
  records: unknown[];
  totalCount?: number;
  totalPages?: number;
} {
  const res = sendOnce(deps, {
    path: EP_PRIZE.list,
    method: 'GET',
    query: `currPage=${page}&pageSize=${PRIZE_LIST_PAGE_SIZE}`,
  });
  if (res.env === undefined) {
    return { ok: false, note: res.error ?? '移动云盘没回应', records: [] };
  }
  if (res.env.code !== 0) {
    return {
      ok: false,
      note: prizeCodeText(res.env.code, res.env.message),
      records: [],
    };
  }
  const root = resultObject(res.env);
  const records = root['result'];
  if (!Array.isArray(records)) {
    return {
      ok: false,
      note: `第 ${page} 页的响应里没有 result.result（形状变了？）`,
      records: [],
    };
  }
  return {
    ok: true,
    records,
    totalCount: num(root['totalCount']),
    totalPages: num(root['totalPages']),
  };
}

/** 把一条上游记录转成界面用的形状。`flag` 不是 1 的**不进来**（调用方过滤）。 */
function toItem(raw: unknown): { item: PrizeItem; flag: number } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // ⚠ 旧口是 `oId`、新口是 `oid` —— 两个都认（同一份数据的两种拼法）
  const oidRaw = o['oId'] ?? o['oid'];
  const oid =
    typeof oidRaw === 'number' && Number.isFinite(oidRaw)
      ? String(oidRaw)
      : typeof oidRaw === 'string'
        ? oidRaw.trim()
        : '';
  const prizeId = num(o['prizeId']) ?? 0;
  const name = str(o['prizeName']) ?? str(o['name']) ?? `奖品 ${prizeId}`;
  const market = str(o['marketname']) ?? str(o['market']) ?? '';
  const marketId = str(o['marketid']) ?? str(o['marketName']) ?? market;
  const flag = num(o['flag']) ?? 0;
  const item: PrizeItem = {
    oid,
    prizeId,
    name,
    market,
    marketId,
    expireAt: str(o['expireTime']),
    insertedAt: str(o['insertTime']),
    phone: maskPhoneLike(str(o['servNumber'])),
    claimable: oid !== '' && prizeId > 0,
  };
  return { item, flag };
}

/** 到期时间排序：快到期的在前；没有到期时间的排最后（不假装它"最快"）。 */
function expireRank(item: PrizeItem): number {
  const ms = item.expireAt === undefined ? NaN : Date.parse(item.expireAt);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

/** 读**全部待领取**（旧口翻页）。
 *
 *  `failed` 与 `items` 可以同时有：第 2 页挂了，第 1 页的结果照样给，并说清"少读了哪一页"。
 *  完全不吞失败 —— 混成一句"没有待领取"会让一次网络/鉴权失败看起来像"这个号没奖品"，
 *  而奖品是会过期的（参考实现 `prize-records.ts` 的同一句话）。 */
export function readPendingPrizes(deps: PrizeDeps): PrizeListResult {
  const map = new Map<string, PrizeItem>();
  let scanned = 0;
  let totalCount: number | undefined;
  let hasMore = false;
  let failed: string | undefined;

  for (let page = 1; page <= PRIZE_LIST_MAX_PAGES; page += 1) {
    const one = readListPage(deps, page);
    if (!one.ok) {
      const why = one.note ?? '未知原因';
      failed = page === 1 ? why : `第 ${page} 页没读成：${why}`;
      break;
    }
    scanned += one.records.length;
    if (one.totalCount !== undefined) totalCount = one.totalCount;
    for (const raw of one.records) {
      const got = toItem(raw);
      if (got === null || got.flag !== 1) continue;
      const { item } = got;
      // 去重键：有单号用单号；没有就用「奖品 + 中奖时间」——同一件奖品可能中多次，
      // 单号不同就是两笔（不能按 prizeId 去重，那会把第二笔吃掉）。
      const key = item.oid !== '' ? `o:${item.oid}` : `p:${item.prizeId}|${item.insertedAt ?? ''}`;
      if (!map.has(key)) map.set(key, item);
    }
    const pages = one.totalPages;
    const shortPage = one.records.length < PRIZE_LIST_PAGE_SIZE;
    const lastPage = pages !== undefined && page >= pages;
    if (shortPage || lastPage) break;
    if (page === PRIZE_LIST_MAX_PAGES) {
      // 撞到上限：能算出"还有"就说"还有"，算不出就标可能还有
      hasMore = totalCount !== undefined ? scanned < totalCount : true;
    }
  }

  const items = [...map.values()].sort((a, b) => {
    const d = expireRank(a) - expireRank(b);
    return d !== 0 ? d : a.prizeId - b.prizeId;
  });
  return {
    items,
    scanned,
    ...(totalCount !== undefined ? { totalCount } : {}),
    hasMore,
    ...(failed !== undefined ? { failed } : {}),
  };
}

// ── 缓存（按账号）────────────────────────────────────────────────────────

export function loadPrizeCache(store: Pick<Store, 'getState'>): PrizeCache | null {
  const raw = store.getState(STATE_PRIZE_CACHE);
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const list = o['list'];
    if (typeof o['atMs'] !== 'number' || typeof list !== 'object' || list === null) return null;
    const l = list as Record<string, unknown>;
    // 缓存坏了就当没有（重读一次，别让界面拿到一个没有 items 的对象）
    if (!Array.isArray(l['items']) || typeof l['scanned'] !== 'number') return null;
    return { atMs: o['atMs'] as number, list: list as PrizeListResult };
  } catch {
    return null;
  }
}

export function savePrizeCache(
  store: Pick<Store, 'setState'>,
  list: PrizeListResult,
  nowMs: number,
  nowIso: string,
): void {
  store.setState(STATE_PRIZE_CACHE, JSON.stringify({ atMs: nowMs, list }), nowIso);
}

/** 领取成功后把这一件从缓存里摘掉（不重打上游；下一趟列表会以服务端为准）。 */
export function dropCachedPrize(
  store: Pick<Store, 'getState' | 'setState'>,
  oid: string,
  nowIso: string,
): void {
  const cache = loadPrizeCache(store);
  if (cache === null) return;
  const items = cache.list.items.filter((x) => x.oid !== oid);
  if (items.length === cache.list.items.length) return;
  savePrizeCache(store, { ...cache.list, items }, cache.atMs, nowIso);
}

// ── 进行中的那一单 ───────────────────────────────────────────────────────

export function loadClaimState(store: Pick<Store, 'getState'>): PrizeClaimState | null {
  const raw = store.getState(STATE_PRIZE_CLAIM);
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o['oid'] !== 'string' || typeof o['sentAtMs'] !== 'number') return null;
    return {
      oid: o['oid'],
      prizeId: typeof o['prizeId'] === 'number' ? o['prizeId'] : 0,
      marketId: typeof o['marketId'] === 'string' ? o['marketId'] : '',
      name: typeof o['name'] === 'string' ? o['name'] : '',
      phone: typeof o['phone'] === 'string' ? o['phone'] : undefined,
      prizetype: typeof o['prizetype'] === 'string' ? o['prizetype'] : undefined,
      sentAtMs: o['sentAtMs'],
    };
  } catch {
    return null;
  }
}

function saveClaimState(
  store: Pick<Store, 'setState'>,
  state: PrizeClaimState,
  nowIso: string,
): void {
  store.setState(STATE_PRIZE_CLAIM, JSON.stringify(state), nowIso);
}

function clearClaimState(store: Pick<Store, 'setState'>, nowIso: string): void {
  store.setState(STATE_PRIZE_CLAIM, '', nowIso);
}

// ── 领取：第一段（详情 → 滑块 → 发短信）──────────────────────────────────

export interface ClaimStartResult {
  ok: boolean;
  note: string;
  /** `true` = **没拿到回应**（网络超时/断了），不知道上游做没做。
   *  界面不能说"没发出去"，也不能当成功 —— 见 `startPrizeClaim` 里那一支。 */
  unknown?: boolean | undefined;
  phone?: string | undefined;
  name?: string | undefined;
  prizetype?: string | undefined;
  oid?: string | undefined;
  at?: number | undefined;
  /** 滑块解出来的偏移与置信度（**只给诊断看**，界面不显示像素）。 */
  offset?: number | undefined;
  confidence?: number | undefined;
}

/** 开始领取一件：读详情 → 取滑块题面并本地解 → 发短信。
 *
 *  ⚠ 这一枪**会发短信**（移动云盘发到这个号上）。所以：
 *   · 只在用户点「领取」时调用（不是页面打开就发）；
 *   · 同一件 60 秒内不重发（本地闸，别让上游回 1001）；
 *   · 失败时**不发**下一枪（滑块算不出来就不发 —— 和兑换那条同一个口径）。 */
export function startPrizeClaim(
  deps: PrizeDeps,
  item: PrizeItem,
  accountLabel = '',
): ClaimStartResult {
  if (!item.claimable || item.oid === '') {
    return { ok: false, note: '这一条没有单号（oId），领不了 —— 刷新列表再试' };
  }
  const session = loadSession(deps.store);
  if (session === null || (session.jwt ?? '') === '') {
    return { ok: false, note: '这个账号还没有网页会话 —— 去「账号」页重新登录一次' };
  }
  const nowMs = depsNowMs(deps);
  const prev = loadClaimState(deps.store);
  if (prev !== null && prev.oid === item.oid) {
    const left = CLAIM_SMS_COOLDOWN_MS - (nowMs - prev.sentAtMs);
    if (left > 0) {
      return {
        ok: false,
        note: `刚发过验证码（${Math.round((nowMs - prev.sentAtMs) / 1000)} 秒前），再等 ${Math.ceil(left / 1000)} 秒`,
      };
    }
  }

  // ① 详情：拿到 `prizetype`（验证码要不要 MD5）与"是不是已经领过"
  const detail = sendOnce(deps, {
    path: EP_PRIZE.detail,
    method: 'GET',
    query:
      `marketId=${encodeURIComponent(item.marketId)}` +
      `&prizeId=${encodeURIComponent(String(item.prizeId))}` +
      `&drawRecode=${encodeURIComponent(item.oid)}`,
  });
  if (detail.env === undefined) {
    return { ok: false, note: detail.error ?? '移动云盘没回应（取奖品详情那一步）' };
  }
  if (detail.env.code !== 0) {
    // 过期 / 抢光 / 未中奖：这一件已经没救了，从列表缓存里摘掉（否则每次点都重复失败）
    if (
      detail.env.code === 10010004 ||
      detail.env.code === 10010018 ||
      detail.env.code === 10010013
    ) {
      dropCachedPrize(deps.store, item.oid, deps.nowIso);
    }
    return { ok: false, note: prizeCodeText(detail.env.code, detail.env.message) };
  }
  const info = resultObject(detail.env);
  // `exchangeCode === 2031` = 已经兑过（参考实现 `PrizeDetail` 的同一句话）
  if (num(info['exchangeCode']) === 2031) {
    dropCachedPrize(deps.store, item.oid, deps.nowIso);
    return { ok: false, note: '这件已经领过了（移动云盘说已兑换）—— 刷新一下列表' };
  }
  // ⚠ `prizetype` 实拍是**数字**（1035 / 1057），不是字符串 —— 别只认 string
  const ptRaw = info['prizetype'] ?? info['prizeType'];
  const prizetype =
    typeof ptRaw === 'number' && Number.isFinite(ptRaw) ? String(ptRaw) : str(ptRaw);
  const name = str(info['prizename']) ?? item.name;
  const phone = item.phone ?? (accountLabel !== '' ? accountLabel : undefined);

  // ② 滑块题面：`picture` 是 JPEG、`puzzle` 是 PNG 竖切片（见文件头 ③）
  const slide = sendOnce(deps, {
    path: EP_PRIZE.slide,
    method: 'POST',
    body: '{}',
    contentType: 'application/json',
  });
  if (slide.env === undefined) {
    return { ok: false, note: slide.error ?? '移动云盘没回应（取滑块那一步）' };
  }
  if (slide.env.code !== 0) {
    return { ok: false, note: prizeCodeText(slide.env.code, slide.env.message) };
  }
  const images = resultObject(slide.env);
  const puzzle = str(images['puzzle']) ?? str(images['puzzleImg']);
  const picture = str(images['picture']) ?? str(images['pictureImg']);
  if (puzzle === undefined || picture === undefined) {
    return { ok: false, note: '滑块题面里没有两张图（形状变了？）—— 再点一次试试' };
  }
  const picWidth = num(images['picWidth']);
  const puzzleWidth = num(images['puzzleWidth']);
  let solution: { offsetX: number; confidence: number };
  try {
    solution = calcPuzzleOffset(bareBase64(puzzle), bareBase64(picture));
  } catch (e) {
    return {
      ok: false,
      note: `滑块底图解不开（${e instanceof Error ? e.message : String(e)}）—— 再点一次会换一道题`,
    };
  }
  if (!usable(solution)) {
    return {
      ok: false,
      note:
        `滑块没算准（偏移 ${solution.offsetX}，置信度 ${solution.confidence.toFixed(2)}）` +
        '—— 再点一次会换一道题；算不准就不发，别拿一次确定的失败去白耗',
    };
  }
  if (
    picWidth !== undefined &&
    puzzleWidth !== undefined &&
    (solution.offsetX < 0 || solution.offsetX > picWidth - puzzleWidth)
  ) {
    return {
      ok: false,
      note: `滑块算出来的位置（${solution.offsetX}）超出可滑范围 —— 再点一次换一道题`,
    };
  }

  // ③ 提交滑块偏移 ⇒ 触发验证码短信（`oid` 实拍是数字）
  const oidNum = num(item.oid);
  const body = JSON.stringify({
    oid: oidNum ?? item.oid,
    puzzleOffset: solution.offsetX,
    app: 0,
  });
  const sms = sendOnce(deps, {
    path: EP_PRIZE.sms,
    method: 'POST',
    body,
    contentType: 'application/json',
  });
  if (sms.env === undefined) {
    // ⚠ **没拿到回应 ≠ 没做**：这一枪可能已经在服务端生效（短信真发出去了）。
    //   所以：① 落一单（带 `sentAtMs`）—— 用户若真收到码，还能直接填；
    //        ② 返回 `unknown`，界面要把这句话说清，而不是报"没发出去"；
    //        ③ 60 秒冷却同时生效，别连点重发。
    saveClaimState(
      deps.store,
      { oid: item.oid, prizeId: item.prizeId, marketId: item.marketId, name, phone, prizetype, sentAtMs: nowMs },
      deps.nowIso,
    );
    return {
      ok: false,
      unknown: true,
      note:
        `没拿到回应（${sms.error ?? '网络'}）—— 短信可能已经发出去了：收到就直接填下面的验证码；` +
        '没收到就等一分钟再点「重新发送」',
      phone,
      name,
      prizetype,
      oid: item.oid,
      at: nowMs,
    };
  }
  if (sms.env.code !== 0) {
    return { ok: false, note: prizeCodeText(sms.env.code, sms.env.message) };
  }

  saveClaimState(
    deps.store,
    {
      oid: item.oid,
      prizeId: item.prizeId,
      marketId: item.marketId,
      name,
      phone,
      prizetype,
      sentAtMs: nowMs,
    },
    deps.nowIso,
  );
  return {
    ok: true,
    note:
      `验证码已发到 ${phone ?? '这个账号绑定的手机'} —— 收到后填在里面` +
      (prizetype === '1028' || prizetype === '1029' ? '（这一件按原样提交，不做摘要）' : ''),
    phone,
    name,
    prizetype,
    oid: item.oid,
    at: nowMs,
    offset: solution.offsetX,
    confidence: solution.confidence,
  };
}

// ── 领取：第二段（提交验证码）──────────────────────────────────────────────

export interface ClaimConfirmResult {
  ok: boolean;
  note: string;
  /** `true` = **没拿到回应**：这一单可能已经领到了。不许原地重试，先刷新列表看。 */
  unknown?: boolean | undefined;
  code?: number | undefined;
  /** 上游 `result` 若是字符串（例如「订购成功」）。 */
  result?: string | undefined;
  /** `code:1000` 时给的跳转地址（要在移动云盘页面里领）。 */
  link?: string | undefined;
}

/** 用验证码确认领取。
 *
 *  ⚠ 状态来自 `startPrizeClaim` 落的那一单：**没发过短信就不许确认**（否则拿旧单
 *  或别人的单去撞，只会换回一个看不懂的错误码）。 */
export function confirmPrizeClaim(
  deps: PrizeDeps,
  oid: string,
  code: string,
): ClaimConfirmResult {
  const st = loadClaimState(deps.store);
  if (st === null || st.oid !== oid) {
    return { ok: false, note: '先点「领取」发验证码，再来填这一条' };
  }
  const nowMs = depsNowMs(deps);
  if (nowMs - st.sentAtMs > CLAIM_STATE_TTL_MS) {
    clearClaimState(deps.store, deps.nowIso);
    return { ok: false, note: '这一单的验证码已经过期了 —— 重新点「领取」再发一次' };
  }
  const clean = code.trim();
  if (clean === '') return { ok: false, note: '验证码没填' };
  if (clean.length < 4 || clean.length > 8) {
    return { ok: false, note: '验证码看起来不是 4–8 位，再核对一下' };
  }
  const session = loadSession(deps.store);
  const deviceId = session?.deviceId ?? '';
  if (deviceId === '') {
    return {
      ok: false,
      note: '这份会话没有设备指纹（deviceId），领不了 —— 去「账号」页重新换一次票',
    };
  }

  // 验证码：非 1028/1029 发 MD5（32 位小写 hex）。见文件头 ④。
  const plain = st.prizetype === '1028' || st.prizetype === '1029';
  const smsCode = plain ? clean : md5Hex(clean);
  const oidNum = num(st.oid);
  const body = JSON.stringify({
    oid: oidNum ?? st.oid,
    app: 0,
    sendDefaultSms: true,
    source: PRIZE_SOURCE,
    smsCode,
    deviceId,
  });
  const res = sendOnce(deps, {
    path: EP_PRIZE.accept,
    method: 'POST',
    body,
    contentType: 'application/json',
    isDeviceId: true,
  });
  if (res.env === undefined) {
    // ⚠ 写请求没有幂等键：超时/断连时**这一单可能已经成功**。
    //   所以清掉手里的 code 状态（不许拿同一个码再撞），让用户去刷新列表看结果。
    clearClaimState(deps.store, deps.nowIso);
    return {
      ok: false,
      unknown: true,
      note:
        `没拿到回应（${res.error ?? '网络'}）—— 这一单可能已经领到了：` +
        '先点「刷新」看它还在不在，别急着再确认一次',
    };
  }
  const env = res.env;
  if (env.code === 0) {
    clearClaimState(deps.store, deps.nowIso);
    dropCachedPrize(deps.store, st.oid, deps.nowIso);
    const result = str(env.result);
    return {
      ok: true,
      note: `已领取：${st.name}${result !== undefined ? `（${result}）` : ''}`,
      code: 0,
      ...(result !== undefined ? { result } : {}),
    };
  }

  // 失败：哪些码要清掉这一单、哪些允许原地重输
  const code0 = env.code;
  if (code0 === 514) {
    // 滑块在 accept 这一枪被拒 ⇒ 得重新取题、重发短信
    clearClaimState(deps.store, deps.nowIso);
  }
  if (code0 === 10010004 || code0 === 10010018 || code0 === 10010013) {
    // 过期 / 抢光 / 未中奖：这一件已经没救了，从列表里摘掉
    clearClaimState(deps.store, deps.nowIso);
    dropCachedPrize(deps.store, st.oid, deps.nowIso);
  }
  if (code0 === 1000) {
    // 静态码表说 `result` 是跳转 URL；实拍没撞到，所以两种形状都认（字符串 / `{url}`）
    const link =
      str(env.result) ??
      (typeof env.result === 'object' && env.result !== null
        ? str((env.result as Record<string, unknown>)['url'])
        : undefined);
    return {
      ok: false,
      note: '这件要去移动云盘页面里领（不在这个号上直接发）',
      code: code0,
      ...(link !== undefined ? { link } : {}),
    };
  }
  return { ok: false, note: prizeCodeText(code0, env.message), code: code0 };
}

/** **写路由专用**：只在动手之前把票弄新鲜，**不包自动重跑**。
 *
 *  `withTokenGate` 那层会在 `90001` 之后把 `read()` 重跑一遍 —— 对只读读数是自愈，
 *  但对 `sendPrizeSms` / `acceptPrizeV2` 这种**没有幂等键的写**是"可能重复发/重复领"。
 *  所以写这一族只做"到期先换一轮票"，写出去之后就不再自动重试；
 *  票真过期了就回一句人话，让用户自己再点（他点了才算重试）。
 *
 *  先换票这个动作本身是安全的：换票链不碰奖品。 */
export function ensurePrizeToken(deps: PrizeDeps): { ok: boolean; note?: string | undefined } {
  // ⚠ 用真时钟：`jwtFresh` 比的是会话里那条 `at`（真实 ISO 时间），不是注入的假时钟
  if (jwtFresh(deps.store, Date.now(), FALLBACK_RECIPE)) return { ok: true };
  // 没有可换票的原生凭据 ⇒ **不拦**：手工贴进来的会话本来就是"只有 jwttoken"，
  // 那一张票可能还能用。让上游自己判（90001 会由调用方翻成"去账号页重新登录"）。
  if (loadAuthRaw(deps.store) === '') return { ok: true };
  const r = exchangeOnce(
    {
      store: deps.store,
      transport: deps.transport,
      nowIso: deps.nowIso,
      baseUrl: deps.baseUrl,
    },
    FALLBACK_RECIPE,
  );
  return r.ok ? { ok: true } : { ok: false, note: r.note };
}

/** 路由用：把一次**只读**调用包进"票到期/90001 自动换票"的那一层。
 *
 *  `withTokenGate` 的约定是**成功就返回、票问题就抛 `LoginExpiredError`**；
 *  业务失败（`ok:false`）不算票问题，原样返回。 */
export function withPrizeTokenGate<T>(deps: PrizeDeps, run: () => T): T {
  return withTokenGate(
    {
      store: deps.store,
      transport: deps.transport,
      nowIso: deps.nowIso,
      baseUrl: deps.baseUrl,
    },
    run,
  );
}
