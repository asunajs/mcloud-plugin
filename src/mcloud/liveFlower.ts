// 小红花（`liveRoomFeedback`）—— 口令抽小红花的**协议层**。**纯函数：一个请求都不发。**
//
// 权威源：`crates/mcloud-upstream/src/live_flower.rs` 与 `live_consts.rs`
// （上游是原项目 `packages/core/src/apis/live-room.ts`）。发请求那层在 `tasks/liveDraw.ts`。
//
// ═══════════════════════════════════════════════════════════════════════
// 六步链（顺序固定）
// ═══════════════════════════════════════════════════════════════════════
//
// ```text
// ① POST /ycloud/liveRoomFeedback/user/info              ← 余额；**终值核对也是它**
// ② POST /ycloud/visitlog/journaling                × 5  ← 埋点
// ③ POST /ycloud/liveRoomFeedback/firstParticipate/give  ← 首次参与惊喜奖
// ④ POST /ycloud/liveRoomFeedback/redFlower/draw?code=   ← 逐个口令（**唯一写请求**）
// ⑤ GET  /ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers
// ⑥ POST /ycloud/liveRoomFeedback/user/info              ← 再取一次，前后对比
// ```
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠⚠ 四个请求的"请求体形态"**各不相同**，别统一成 JSON
// ═══════════════════════════════════════════════════════════════════════
//
// | 端点 | body | content-type |
// |---|---|---|
// | `user/info` | `{}` | **无** ⚠ |
// | `visitlog/journaling` | `module=uservisit&…` | `application/x-www-form-urlencoded;charset=UTF-8` |
// | `firstParticipate/give` | 空（`content-length: 0`） | **无** |
// | `redFlower/draw` | 空（`content-length: 0`） | **无** |
//
// ⇒ `give` 与 `draw` **不能**带上 `{}`：那会让 body 变成两个字节。
// 这里"照抄原实现"恰好是对的（原项目传的是 `undefined`），
// 而**照抄直觉**（"POST 就该有 JSON body"）是错的。
//
// ⚠⚠ `user/info` 的 content-type 一栏是**踩过的**：Rust 侧的模块文档写着
// `application/json`，但**代码里根本没设**（`json_body` 只塞 body）。
// 第一版我照文档写了，**多带了一枚 content-type**。
// 2026-10-13 把真实现构造出来的请求逐字打出来对拍，才发现文档与代码不一致 ——
// **代码才是实际发出去的**，所以这一栏是"无"。
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠⚠⚠ 业务码必须**对上它自己的接口** —— 不许张冠李戴
// ═══════════════════════════════════════════════════════════════════════
//
// | 码 | 出自 | 语义 |
// |---|---|---|
// | `200108` | `redFlower/draw` | 口令无效（需当场直播获取） |
// | `200110` | `firstParticipate/give` | 已参与过，无首次惊喜奖 |
// | `200112` | `redFlower/draw` | 已兑换 |
// | `200118` | `redFlower/draw` | 口令已失效（**本场已结束**） |
//
// ⚠ 只判等、**不判形状**：别按"都是 `2001xx`"去推。`200103`（红花数不够）出自
// **别的**接口；`609` / `200101` / `200111` 在 H5 自己的映射表里都是**独立的**码。

import { rootOrDefault } from './h5.ts';
import type { BuiltRequest } from './h5.ts';
import type { SignInEnvelope } from './envelope.ts';

// ── 常量（逐字抄自 `live_consts.rs`；这里不重新发明数值）────────────────

/** 小红花族与签到**同域**（`m.mcloud.139.com`），不是直播侧那个 `v.cmcc-cs.cn`。 */
export const LIVE_ROOM_ORIGIN = 'https://m.mcloud.139.com';

// ⚠ 路径**自带 `/ycloud` 前缀** —— 与 `h5.ts` 的 `EP` 表同一套约定。
// 为什么重要：`base` 替换的是**整个源**（见 `liveRoomUrl`），所以"指到 mock"时
// 路径必须自带它该有的前缀，否则会打出一个不存在的 `/liveRoomFeedback/...`。
// （第一版就是漏了这个，E2E 当场 404。）
export const USER_INFO_PATH = '/ycloud/liveRoomFeedback/user/info';
export const JOURNALING_PATH = '/ycloud/visitlog/journaling';
export const FIRST_PARTICIPATE_GIVE_PATH = '/ycloud/liveRoomFeedback/firstParticipate/give';
export const DRAW_PATH = '/ycloud/liveRoomFeedback/redFlower/draw';
export const QUERY_REVIVAL_FLOWERS_PATH = '/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers';

export const LIVE_ROOM_MARKET_NAME = 'National_LiveRoomFeedback';
export const LIVE_ROOM_JOURNALING_SOURCE_ID = '1007';
/** ⚠ 小红花族的 `activityid` 是**签到族那个**（实拍如此），不是直播专属值。 */
export const LIVE_ROOM_ACTIVITY_ID = 'sign_in_3';
export const LIVE_ROOM_APP_VERSION = '12.6.0.0';
/** 活动页 `Referer` 里的 `targetSourceId`。⚠ 直播侧用的是 `017027`，别混。 */
export const TO_SOURCE_ID = '001005';
/** ⚠ 与直播侧那个 UA **不是一个值**（系统版本 `18_7` vs `18_5`）。
 *  它不是端常量，是**抓包时刻的取值** —— 照抄最近一次实拍，别去"统一"成一份。 */
export const LIVE_ROOM_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) MCloudApp/12.6.0 iPad AppLanguage/zh-CN';

export const CODE_KOULING_INVALID = 200108;
export const CODE_FIRST_PARTICIPATE_ALREADY = 200110;
export const CODE_KOULING_ALREADY_DRAWN = 200112;
export const CODE_KOULING_EXPIRED = 200118;

/** 埋点发的是**固定 5 条**，顺序即此。
 *
 *  ⚠ 其中**只有 `_flowerBtn` 是实拍证实的**（点按钮那一刻发的），其余 4 条照抄原项目
 *  （真实客户端里属于页面加载期）。为什么照抄：这 4 条是服务端活动系统的"到场"证据，
 *  而"它们到底是不是必发"**没有证据**。两边的代价不对称 ——
 *  多发 4 个埋点请求 = 一点点噪声；少发 = 可能整条抽奖链被静默拒掉，
 *  而那时的表现是 `200108`，看起来像"口令抄错了"，把人引到完全错误的方向。 */
export const JOURNALING_EVENTS: readonly string[] = [
  'National_LiveRoomFeedback_pv',
  'National_LiveRoomFeedback_client',
  'National_LiveRoomFeedback_client_isApp',
  'National_LiveRoomFeedback_login',
  'National_LiveRoomFeedback_flowerBtn',
];

/** 小红花活动页的 `Referer`。 */
export function liveRoomPageReferer(): string {
  return (
    `${LIVE_ROOM_ORIGIN}/portal/yunClound/index.html?path=${LIVE_ROOM_MARKET_NAME}` +
    `&sourceid=${LIVE_ROOM_JOURNALING_SOURCE_ID}&targetSourceId=${TO_SOURCE_ID}`
  );
}

/** 这一族共用的头。**不含凭据** —— 凭据由调用方（任务的底座）按会话补上。 */
export function liveRoomHeaders(): Record<string, string> {
  return {
    Accept: '*/*',
    activityid: LIVE_ROOM_ACTIVITY_ID,
    appversion: LIVE_ROOM_APP_VERSION,
    Origin: LIVE_ROOM_ORIGIN,
    Referer: liveRoomPageReferer(),
    'User-Agent': LIVE_ROOM_USER_AGENT,
  };
}

// ── 请求构造 ────────────────────────────────────────────────────────────

/** 拼这一族的 URL。
 *
 *  ⚠ `base` 非空时**替换整个源**（把上游指到 mock）—— 与 `h5.ts::resolveUrl` 同一套语义。
 *
 *  这一条是踩出来的：写那半第一版把 `BASE_LIVE_ROOM_FEEDBACK` **写死在构造器里**，
 *  于是"把 baseUrl 指到 mock"对它完全无效 —— 本地 E2E 里那几步**真的打到了
 *  `m.mcloud.139.com`**（拿的是假 jwt，被 `90001` 挡下、没碰到账号，但这是纪律问题：
 *  仓库的规矩是"CI 全程只打 mock"）。真机上出这种错就是"测试污染真环境"。 */
export function liveRoomUrl(path: string, base?: string | undefined): string {
  // ⚠ 口子给**空串**时必须落到默认主机 —— 见 `h5.ts::rootOrDefault`（2026-10-14 实机：
  //   `??` 只挡 `undefined`，空串会拼出相对 URL，宿主报 `missing scheme`）。
  return `${rootOrDefault(base, LIVE_ROOM_ORIGIN)}${path}`;
}

/** ① / ⑥ 余额（`result.flowerCnt` 是余额的**唯一**判据）。 */
export function userInfoRequest(base?: string | undefined): BuiltRequest {
  return {
    url: liveRoomUrl(USER_INFO_PATH, base),
    method: 'POST',
    // ⚠ 不带 content-type：真实现（`live_flower::user_info_request`）就没设它。
    // 模块文档那张表写着 application/json，但**代码才是实际发出去的**。
    headers: liveRoomHeaders(),
    body: '{}',
  };
}

/** ② 埋点（form-urlencoded）。 */
export function journalingRequest(optkeyword: string, base?: string | undefined): BuiltRequest {
  return {
    url: liveRoomUrl(JOURNALING_PATH, base),
    method: 'POST',
    headers: {
      ...liveRoomHeaders(),
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body:
      `module=uservisit&optkeyword=${encodeURIComponent(optkeyword)}` +
      `&sourceid=${LIVE_ROOM_JOURNALING_SOURCE_ID}&marketName=${LIVE_ROOM_MARKET_NAME}`,
  };
}

/** ③ 首次参与惊喜奖。**无 body**（见文件头那张表）。 */
export function firstParticipateGiveRequest(base?: string | undefined): BuiltRequest {
  return {
    url: liveRoomUrl(FIRST_PARTICIPATE_GIVE_PATH, base),
    method: 'POST',
    headers: liveRoomHeaders(),
    body: undefined,
  };
}

/** ④ 抽小红花 —— **这条链上唯一的写请求**。
 *
 *  口令走 **query string**，不在 body 里；body **空**、**无 content-type**
 *  （实拍：`POST …/redFlower/draw?code=%E4%B8%AD%E7%A7%8B…`）。
 *  口令是**中文**，必须百分号编码。 */
export function drawRequest(code: string, base?: string | undefined): BuiltRequest {
  return {
    url: `${liveRoomUrl(DRAW_PATH, base)}?code=${encodeURIComponent(code)}`,
    method: 'POST',
    headers: liveRoomHeaders(),
    body: undefined,
  };
}

/** ⑤ 复活花。它是这条链上**唯一的 GET**，回的**不是**小红花余额。 */
export function queryRevivalFlowersRequest(base?: string | undefined): BuiltRequest {
  return {
    url: liveRoomUrl(QUERY_REVIVAL_FLOWERS_PATH, base),
    method: 'GET',
    headers: liveRoomHeaders(),
    body: undefined,
  };
}

// ── 判定 ────────────────────────────────────────────────────────────────

export type DrawKind =
  | 'succeeded'
  | 'already-drawn'
  | 'invalid-kouling'
  | 'kouling-expired'
  | 'other'
  | 'unparsable';

export interface DrawResult {
  prizeId: number;
  flowerNum: number;
  prizeName?: string | undefined;
  prizeType: number;
}

export interface DrawOutcome {
  kind: DrawKind;
  /** 上游的原始码（解不出来时 undefined） */
  code: number | undefined;
  message: string;
  result?: DrawResult | undefined;
}

function intAt(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}
function strAt(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 判定一次 `draw` 的结果。**不抛异常** —— 这一层只回答"上游说了什么"。
 *
 *  ⚠ 成功的判据是 `code === 0` **且** `result` 在（原项目就是 `code === 0 && result`）。
 *  只有 code 而没有 result，说明拿不到"换到几朵" ⇒ 不能记成一次成功，
 *  否则余额对不上却没有任何线索。 */
export function classifyDraw(env: SignInEnvelope | undefined): DrawOutcome {
  if (!env || env.code === undefined) {
    return { kind: 'unparsable', code: env?.code, message: env?.message ?? '响应解不出来' };
  }
  const base = { code: env.code, message: env.message ?? '' };
  switch (env.code) {
    case 0: {
      const r = env.result;
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        return { ...base, kind: 'unparsable' };
      }
      const o = r as Record<string, unknown>;
      return {
        ...base,
        kind: 'succeeded',
        result: {
          prizeId: intAt(o, 'prizeId') ?? 0,
          flowerNum: intAt(o, 'flowerNum') ?? 0,
          prizeName: strAt(o, 'prizeName'),
          prizeType: intAt(o, 'prizeType') ?? 0,
        },
      };
    }
    case CODE_KOULING_ALREADY_DRAWN:
      return { ...base, kind: 'already-drawn' };
    case CODE_KOULING_INVALID:
      return { ...base, kind: 'invalid-kouling' };
    case CODE_KOULING_EXPIRED:
      return { ...base, kind: 'kouling-expired' };
    default:
      return { ...base, kind: 'other' };
  }
}

/** 这次是不是"**口令认错了**"（唯一会触发重听的那一种）。
 *
 *  # ⚠⚠ 只有 `200108` 算 —— 这一条是**刻意**的，改动前读完
 *
 *  原 TS 的判据是 `typeof code === "number"` ⇒ **任何数字码**都算"无效口令"。
 *  那是它**没记过 `200108`** 时的兜底写法。实拍补上 `200108` 之后，
 *  "其他数字码"是一个**尚未分类**的集合（里面可能有"活动没开始""账号被限"……），
 *  把它们都当成"口令错"会触发一次**毫无意义的 60 秒重听**。
 *
 *  判错方向的代价**不对称**：
 *    · 漏掉一个将来新增的"口令无效"码 ⇒ 少重听一次（还有 `200108` 覆盖实测那个）
 *    · 把 `200118` 当无效口令 ⇒ 白重听 60 秒 **+** 把"直播结束了"误报成"口令抄错了"，
 *      把人引到完全错误的方向
 *
 *  ⇒ 只有 `200108` 返回 true。 */
export function rejectedKouling(out: DrawOutcome): boolean {
  return out.kind === 'invalid-kouling';
}

/** 口令是**对的**，但本场直播已经结束（`200118`）。
 *
 *  ⚠ 它**不是**无效口令 —— 所以既不进"口令错"那一栏、也**不触发**重听
 *  （重听也只会再拿一次 `200118`）。 */
export function isKoulingExpired(out: DrawOutcome): boolean {
  return out.kind === 'kouling-expired';
}

/** 口令对、但已经兑换过（`200112`）—— **不算失败**。 */
export function isAlreadyDrawn(out: DrawOutcome): boolean {
  return out.kind === 'already-drawn';
}

/** 一行人话（界面上逐条显示，**不许只写"失败"两个字**）。 */
export function drawLine(code: string, out: DrawOutcome): string {
  switch (out.kind) {
    case 'succeeded':
      return `口令「${code}」领到 ${out.result?.flowerNum ?? 0} 朵`;
    case 'already-drawn':
      return `口令「${code}」没领到：已兑换过`;
    case 'invalid-kouling':
      return `口令「${code}」没领到：口令无效`;
    case 'kouling-expired':
      return `口令「${code}」没领到：本场已结束（口令是对的）`;
    case 'other':
      return `口令「${code}」没领到：服务端回了没见过的码 ${out.code ?? '?'}${out.message ? `（${out.message}）` : ''}`;
    default:
      return `口令「${code}」没领到：响应解不出来`;
  }
}

/** ① / ⑥ 的余额读数（`result.flowerCnt`）。 */
export function parseBalance(env: SignInEnvelope | undefined): number | undefined {
  const r = env?.result;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return undefined;
  // ⚠ `flowerCnt` **必须**硬要求：把"字段没了"静默成 0 会让
  // "余额从 235 变成 0"看起来像一次正常的读数
  return intAt(r as Record<string, unknown>, 'flowerCnt');
}
