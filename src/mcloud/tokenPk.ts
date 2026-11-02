// 算力大作战（`National_TokenPK`）的**协议层**：端点、请求构造、回执解析。纯函数，不发请求。
//
// 形状来源（判据顺序就是用户 2026-11-01 的口径：**抓包有的以抓包为准，没有的以参照实现为准**）：
//
//   ① 实拍：`mcloud-capture/mcloud/capture/app-tokenpk-playai-samples.txt` §2 / §8
//      （2026-10-24 与 2026-11-01 两轮，iOS App WebView；原始 HAR 在 `mcloud-capture/har/`，不入库）
//   ② 页面自身的 JS（`National_TokenPK.8b4a93ba.js`）—— 只用来**补判据与分支**，
//      与 ① 冲突时以 ① 为准
//   ③ 参照实现 `3238614968/caiyun` 的 `api/caiyun_tokenpk.go`、`tasks/tokenpk.go`
//
// # 三处**照抓包、不照参照实现**的地方（别"统一"）
//
// ① 活动页的 `sourceid=1016`（参照实现写 `1073`）；
// ② `task/step/click` 在**动作之前**发（页面在点「去完成」那一刻就发；参照实现是先做动作再点）；
// ③ `autoReceiveLotteryChance` 的体是**字面 `null`**，不是 `{}`、不是空体。
//
// # 回执
//
// 统一 `{code,msg,result}`，`code` 数字或数字串都见过；写口（click/reserve/receivePrize）：
//   · click      → `{code:0,msg:"success"}`（**没有 result**）
//   · reserve    → `{code:0,result:{allSuccess,task,prizes}}`
//   · receivePrize → `{code:0,result:{allSuccess,task,prizes}}`，`prizes[].success/errorMsg` 才是"奖品到没到"
//
// ⚠ `receivePrize` 的 `code=0` **不等于**奖品到手：要看 `result.allSuccess` 与
//   `result.prizes[].success`（页面自己也是这么判的：`pe()` 只收 `success===true` 的项）。

import { H5_APP_VERSION, rootOrDefault } from './h5.ts';
import type { BuiltRequest } from './h5.ts';
import { parseSignInEnvelope } from './envelope.ts';

/** 活动市场名（`activityid` 头与所有写口的 `marketName` 都用它）。 */
export const TOKENPK_MARKET = 'National_TokenPK';
/** 活动页路径（`Referer` 与深链解析用）。`sourceid=1016` 是 2026-10-24 实拍值。 */
export const TOKENPK_PAGE_PATH = 'portal/yunClound/index.html';
/** 实拍里的 `sourceid`。⚠ 参照实现写 `1073`，与线上不一致 —— 以抓包为准。 */
export const TOKENPK_SOURCE_ID = '1016';
/** 活动页 URL（不含 `token=`；抓包里带的是 SSO 票，我们不复用）。 */
export const TOKENPK_REFERER =
  `https://m.mcloud.139.com/${TOKENPK_PAGE_PATH}?path=${TOKENPK_MARKET}` +
  `&sourceid=${TOKENPK_SOURCE_ID}&enableShare=1`;
/** 列表请求的 `platform`。抓包是 iOS ⇒ 按钮也先读 `button.ios`（见 `tokenPkRules.stepKeyOf`）。 */
export const TOKENPK_PLATFORM = 'ios';

/** 端点（都在 `m.mcloud.139.com/ycloud` 下 —— 抓包与参照实现一致）。 */
export const TOKENPK_EP = {
  list: '/ycloud/tokenpk/task/list',
  click: '/ycloud/tokenpk/task/step/click',
  reserve: '/ycloud/tokenpk/task/step/reserve',
  receive: '/ycloud/tokenpk/task/step/receivePrize',
  progress: '/ycloud/tokenpk/toplist/progress/queryHome',
  chance: '/ycloud/tokenpk/toplist/progress/autoReceiveLotteryChance',
  lottery: '/ycloud/tokenpk/toplist/progress/lottery',
  remainChance: '/ycloud/tokenpk/toplist/progress/queryRemainChance',
  smartAlbum: '/ycloud/tokenpk/task/smartAlbum/open',
} as const;

/** 会话里与请求头有关的那几格（与签到族同一个 `Session` 形状，只取用得到的）。 */
export interface PkSession {
  jwt: string;
  cookie?: string | undefined;
  userAgent?: string | undefined;
  deviceId?: string | undefined;
}

/** 这一族的头画像。**全是小写**（实拍如此），`activityid` 跟着市场名走。 */
export function pkHeaders(
  s: PkSession,
  opts: { json?: boolean; showLoading?: boolean } = {},
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: '*/*',
    activityid: TOKENPK_MARKET,
    appversion: H5_APP_VERSION,
    showloading: opts.showLoading === false ? 'false' : 'true',
    Referer: TOKENPK_REFERER,
    jwttoken: s.jwt,
  };
  if (s.userAgent !== undefined && s.userAgent !== '') h['user-agent'] = s.userAgent;
  if (s.cookie !== undefined && s.cookie !== '') h.cookie = s.cookie;
  if (opts.json === true) {
    h['content-type'] = 'application/json;charset=UTF-8';
    h.origin = 'https://m.mcloud.139.com';
  }
  return h;
}

/** 主机基址（`baseUrl` 空 = 真主机；测试/CI 指到 mock）。 */
function pkUrl(path: string, base: string | undefined, query = ''): string {
  const root = rootOrDefault(base, 'https://m.mcloud.139.com').replace(/\/+$/, '');
  return `${root}${path}${query === '' ? '' : `?${query}`}`;
}

/** `task/list`：`marketName` 是**驼峰**（签到族是 `marketname`），三个参数一个都不能省。 */
export function listRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  const q = `marketName=${TOKENPK_MARKET}&platform=${TOKENPK_PLATFORM}&sortState=true`;
  return {
    url: pkUrl(TOKENPK_EP.list, base, q),
    method: 'GET',
    headers: { ...pkHeaders(s), 'cache-control': 'no-cache' },
    body: undefined,
  };
}

/** 登记「去完成」：`{marketName,taskId,key,source:"app"}`，回执无 `result`。 */
export function clickRequest(
  s: PkSession,
  taskId: number,
  key: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.click, base),
    method: 'POST',
    headers: pkHeaders(s, { json: true }),
    body: JSON.stringify({ marketName: TOKENPK_MARKET, taskId, key, source: 'app' }),
  };
}

/** 预约（`taskType=RESERVE` 的那条）：与 click 同形，走另一个口。 */
export function reserveRequest(
  s: PkSession,
  taskId: number,
  key: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.reserve, base),
    method: 'POST',
    headers: pkHeaders(s, { json: true }),
    body: JSON.stringify({ marketName: TOKENPK_MARKET, taskId, key, source: 'app' }),
  };
}

/** 领奖：`{marketName,taskId,source:"app"}`（**没有 key**）。 */
export function receiveRequest(
  s: PkSession,
  taskId: number,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.receive, base),
    method: 'POST',
    headers: pkHeaders(s, { json: true }),
    body: JSON.stringify({ marketName: TOKENPK_MARKET, taskId, source: 'app' }),
  };
}

/** 开启智能相册（`ext=openAlbum` 的动作；无入参）。 */
export function smartAlbumRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.smartAlbum, base),
    method: 'GET',
    headers: pkHeaders(s),
    body: undefined,
  };
}

/** 算力进度。 */
export function progressRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.progress, base),
    method: 'GET',
    headers: pkHeaders(s),
    body: undefined,
  };
}

/** 抽一次奖：体也是**字面 `null`**（实拍，与 `chance` 同一个口径）。
 *
 *  ⚠ 这一发**花掉**用户 1 次机会（不可逆、结果随机）—— 只在用户显式开了「代抽」时才发，
 *  一次调用抽一次（状态机循环，次数上限由调用方把）。 */
export function lotteryRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.lottery, base),
    method: 'POST',
    headers: pkHeaders(s, { json: true }),
    body: 'null',
  };
}

/** 剩余抽奖次数（只读；我们不显示，留给页面的地方）。 */
export function remainChanceRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.remainChance, base),
    method: 'GET',
    headers: pkHeaders(s),
    body: undefined,
  };
}

/** 领抽奖次数：体是**字面 `null`**（实拍；别改成 `{}`）。 */
export function chanceRequest(s: PkSession, base?: string | undefined): BuiltRequest {
  return {
    url: pkUrl(TOKENPK_EP.chance, base),
    method: 'POST',
    headers: pkHeaders(s, { json: true }),
    body: 'null',
  };
}

// ── 回执解析（纯）────────────────────────────────────────────────────

export interface PkEnvelope {
  /** 归一化成数字；解析不出来给 -1（不是 0 —— 0 是成功） */
  code: number;
  message: string;
  result: unknown;
  ok: boolean;
}

/** 解析活动族信封。非 JSON 不抛，回 `code=-1` 并把原因放进 `message`。 */
export function parsePk(body: string): PkEnvelope {
  try {
    const env = parseSignInEnvelope(body);
    return { code: env.code, message: env.message, result: env.result, ok: env.ok };
  } catch (e) {
    return {
      code: -1,
      message: `响应不是 JSON：${e instanceof Error ? e.message : String(e)}`,
      result: undefined,
      ok: false,
    };
  }
}

/** 领奖/预约回执里"奖品到底到没到"。 */
export interface PkClaimOutcome {
  allSuccess: boolean;
  /** 到手的奖品名（只收 `success===true` 的） */
  prizes: string[];
  /** 没到手的那些的原话（`errorMsg`） */
  failures: string[];
  /** 回执里那条任务的新状态（有就回） */
  state?: string | undefined;
}

export function parseClaim(result: unknown): PkClaimOutcome {
  const out: PkClaimOutcome = { allSuccess: false, prizes: [], failures: [] };
  if (typeof result !== 'object' || result === null) return out;
  const r = result as Record<string, unknown>;
  out.allSuccess = r.allSuccess === true;
  const task = r.task;
  if (typeof task === 'object' && task !== null) {
    const st = (task as Record<string, unknown>).state;
    if (typeof st === 'string') out.state = st;
  }
  const prizes = Array.isArray(r.prizes) ? r.prizes : [];
  for (const one of prizes) {
    if (typeof one !== 'object' || one === null) continue;
    const p = one as Record<string, unknown>;
    const name = typeof p.prizeName === 'string' && p.prizeName.trim() !== '' ? p.prizeName : '';
    if (p.success === true) {
      if (name !== '') out.prizes.push(name);
    } else {
      const why = typeof p.errorMsg === 'string' && p.errorMsg !== '' ? p.errorMsg : '没给原因';
      out.failures.push(name === '' ? why : `${name}（${why}）`);
    }
  }
  return out;
}

/** `queryHome` 的读数（`usedToken` 是汇总句里「累计算力 X」那一格）。 */
export function parseProgress(result: unknown): { usedToken?: number | undefined } {
  if (typeof result !== 'object' || result === null) return {};
  const used = (result as Record<string, unknown>).usedToken;
  if (typeof used === 'number' && Number.isFinite(used)) return { usedToken: used };
  if (typeof used === 'string' && used.trim() !== '' && !Number.isNaN(Number(used))) {
    return { usedToken: Number(used) };
  }
  return {};
}

/** `queryRemainChance` 的读数：`result` 直接是个数字（实拍 §1 表 ④）。 */
export function parseRemainChance(result: unknown): number | undefined {
  if (typeof result === 'number' && Number.isFinite(result) && result >= 0) return Math.floor(result);
  if (typeof result === 'string' && result.trim() !== '' && !Number.isNaN(Number(result))) {
    return Math.max(0, Math.floor(Number(result)));
  }
  return undefined;
}

/** 一次抽奖的读数（实拍 §8.3：`{win, prizeId, prizeName, prizeImage, prizeDesc, remainChance}`）。
 *
 *  `win:false` 也会带 `remainChance`（次数照扣）—— 所以"没中"是一次正常结果，不是失败。 */
export interface PkDrawOutcome {
  win: boolean;
  prizeName?: string | undefined;
  remainChance?: number | undefined;
}

export function parseLottery(result: unknown): PkDrawOutcome {
  if (typeof result !== 'object' || result === null) return { win: false };
  const r = result as Record<string, unknown>;
  const out: PkDrawOutcome = { win: r.win === true };
  if (typeof r.prizeName === 'string' && r.prizeName.trim() !== '') out.prizeName = r.prizeName.trim();
  const n = r.remainChance;
  if (typeof n === 'number' && Number.isFinite(n)) out.remainChance = n;
  else if (typeof n === 'string' && n.trim() !== '' && !Number.isNaN(Number(n))) out.remainChance = Number(n);
  return out;
}

/** `autoReceiveLotteryChance` 的读数（`rewardCount` 才是「抽奖次数+N」）。 */
export function parseChance(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const n = (result as Record<string, unknown>).rewardCount;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
  if (typeof n === 'string' && n.trim() !== '' && !Number.isNaN(Number(n))) {
    return Math.max(0, Math.floor(Number(n)));
  }
  return 0;
}
