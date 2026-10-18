// 直播侧的「门」—— **只读**地取直播日程（`/cmlive` 那一族）。
//
// 权威源：mcloud 的 `mcloud-upstream/src/live_room.rs` + `live_consts.rs`（协议层）
// 与 `mcloud-tasks/src/live_room.rs::gate_jwt` / `gate_rooms`（编排层，那三步）。
// 四层权威（用户口径 2026-10-14）里本文件属于 ① **业务逻辑照 mcloud** ——
// 这一族的证据等级在 mcloud 那边标得很细，原样带过来：
//
// ```text
//   ✅ 实证：/cmlive 信封、tabContentList、三档 status、两个页签都要查、
//           「昵称精确相等」这条判据（实拍 §5.3 那张表里有「福建移动」）
//   ⏸ 未接：WS / 弹幕（沙箱里没有 WebSocket）—— 本文件只做**门**，不碰弹幕
// ```
//
// # ⚠⚠ 这一族用的是**第三套响应约定**（三套在同一条链路上）
//
// | 侧 | 基址 | 响应约定 |
// |---|---|---|
// | 小红花（`/ycloud`） | `m.mcloud.139.com/ycloud` | `{code: 0, msg, result}` 数字码 |
// | **直播（`/cmlive`）** | `v.cmcc-cs.cn/cmlive` | `{rtnCode: "0", rtnMsg, object}` **字符串**码 |
// | IM（`videoim`） | `videoim.cmcc-cs.cn:20103` | `{code: 0, msg, data, timestamp}` 数字码 |
//
// **不能共用解析**。最要命的是把 `/cmlive` 的响应喂给签到族那个信封：
// 它取 `result` 键 ⇒ 静默取到 `undefined` 而**不报错** ⇒ 表现成
// 「登录成功却取不到 token」（实拍坑表 #108）。所以这里单独一个 [`parseCmlive`]。
//
// # `rtnCode` 刻意**只认字符串**
//
// mcloud 的原话：数字 `0` 会**解析失败**，而且失败信息里明说"这一族用字符串码"。
// 这不是苛刻，是**刻意留出来的报警灯** —— 抹平类型差异之后，「上游把这一族改成数字码」
// 这个信号就再也不会浮出来，而那正是最该立刻看见的一类协议变化。
//
// # 纯逻辑：不 import host-api、不发请求、不读时钟

import { KOULING_ANCHOR } from './koulingPool.ts';
import type { ProbeRoom } from './koulingPool.ts';
import { BASE_USER_YUN, H5_CONTENT_TYPE, specTokenRequest } from './h5session.ts';
import type { Parsed } from './h5session.ts';
import { rootOrDefault } from './h5.ts';
import type { BuiltRequest } from './h5.ts';

// 门的判据就是它（「昵称精确相等」比的正是这个值）—— 从这里再导出一份：
// 调用方不必知道它住在池里，而**值的来源仍然只有一处**。
export { KOULING_ANCHOR };

// ══════════════════════════ 常量（照 mcloud 的 live_consts.rs）══════════════════════════

/** 直播侧 `/cmlive/api/...` 的根。 */
export const BASE_CMLIVE = 'https://v.cmcc-cs.cn/cmlive';

/** `Origin` 头（不带 `/cmlive`）。 */
export const LIVE_ORIGIN = 'https://v.cmcc-cs.cn';

/** 直播侧的 UA。
 *
 *  ⚠ 与小红花那个（`18_7`）**不是一个值**：这里的系统版本是 `18_5`（2026-09-17 夹具）。
 *  同一台设备在两个时间点抓到的 UA 会随系统升级而变 ⇒ 它**不是端常量，是抓包时刻的取值**
 *  —— 照抄最近一次实拍，别去"统一"成一份。 */
export const LIVE_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'MCloudApp/12.6.0 iPad AppLanguage/zh-CN';

/** 移动云盘频道 id。
 *
 *  ⚠ 它**只是查询参数，不是过滤条件**：实拍里 `?channelId=134` 拉回来的房间
 *  `channelId` 有 `29 / 51 / 243 / 134` 四种 —— 那是**房间的归属**，不是"我拉的是哪个频道"。
 *  拿它当过滤条件会一间都筛不出来。 */
export const LIVE_CHANNEL_ID = '134';

/** 直播侧换 SSO 用的 `toSourceId`。
 *
 *  ⚠ 与签到的 `001005` **不同值**。混用的表现是"一条房间都筛不出来"，
 *  而那看起来像"今天没有直播" —— 一个**假结论**（参考实现坑表 #106）。 */
export const LIVE_SOURCE_ID = '017027';

/** 页签：盘盘福利 / 精彩回放。**两个都要查**。
 *
 *  ⚠ 只查 127 会在"房间还没进福利页签"时判成**没开播**，而那正是
 *  "漏掉整场口令"这一侧的错误 —— 代价远大于多打一个 GET（实拍：147606 两个都在，
 *  147608 只在 129）。 */
export const LIVE_TAB_ID_BENEFITS = 127;
export const LIVE_TAB_ID_REPLAY = 129;

/** 房间三档状态。`6` 是**已结束（回放）** —— 不是 2。 */
export const STATUS_NOT_STARTED = 0;
export const STATUS_LIVE = 1;
export const STATUS_ENDED = 6;

/** 门要查的页签（顺序与 mcloud 的 `gate_rooms` 一致）。 */
export const GATE_TAB_IDS: readonly number[] = [LIVE_TAB_ID_BENEFITS, LIVE_TAB_ID_REPLAY];

// ══════════════════════════ `/cmlive` 的信封 ══════════════════════════

/** `/cmlive/api/...` 的统一响应：`{rtnCode, rtnMsg, object}`。
 *
 *  ⚠ 与签到族的信封**不能互换**：业务码键是 `rtnCode`（**字符串**）、数据键是 `object`。
 *  混用的表现是"响应没有 result"，而真因是**用错了信封**。 */
export interface CmliveEnvelope {
  rtnCode: string;
  rtnMsg?: string;
  object: unknown;
}

/** 解析 `/cmlive` 的信封。**数字码一律算解析失败**（见文件头那段"报警灯"）。 */
export function parseCmlive(body: string): Parsed<CmliveEnvelope> {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `直播侧响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v['rtnCode'];
  if (typeof code !== 'string') {
    return {
      ok: false,
      error:
        `直播侧的 rtnCode 应当是**字符串**，实际是 ${code === undefined ? '缺字段' : typeof code}` +
        '（这一族用字符串码；服务端若真改成了数字码，这里必须报出来而不是兼容掉）',
    };
  }
  const msg = typeof v['rtnMsg'] === 'string' ? v['rtnMsg'] : undefined;
  const env: CmliveEnvelope = { rtnCode: code, object: v['object'] };
  if (msg !== undefined) env.rtnMsg = msg;
  return { ok: true, value: env };
}

/** 信封是不是成功（`rtnCode === "0"`）。 */
export function cmliveOk(env: CmliveEnvelope): boolean {
  return env.rtnCode === '0';
}

/** 信封里的人话（错误信息用）。 */
export function cmliveLine(env: CmliveEnvelope): string {
  return `rtnCode=${env.rtnCode}${env.rtnMsg ? `（${env.rtnMsg}）` : ''}`;
}

/** 取 `object`（必须是对象，否则如实报错）。 */
function objectOf(env: CmliveEnvelope, what: string): Parsed<Record<string, unknown>> {
  if (!cmliveOk(env)) {
    return { ok: false, error: `${what}失败：${cmliveLine(env)}` };
  }
  const o = env.object;
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, error: `${what}：object 不是对象（实际 ${o === null ? 'null' : typeof o}）` };
  }
  return { ok: true, value: o as Record<string, unknown> };
}

// ══════════════════════════ 公共头 ══════════════════════════

/** 给 `/cmlive` 的请求补上头（逐个对应实拍的头集合）。
 *
 *  # ⚠ 不含 `Cookie` / `Sec-Fetch-*` / `Connection` / `X-Tingyun`
 *
 *  前三个是**浏览器/WebView 自己产生的**（纯协议实现里既没有 cookie jar
 *  也不受 fetch 元数据约束）；`X-Tingyun` 是听云 APM 的**采样串**，由浏览器端 SDK
 *  现场生成、含本机标识 —— 造不出真值，伪造一个既没有实测依据、又会多写一处设备标识。
 *
 *  # ⚠ 鉴权是标准 `Authorization` 头，**不是**签到族的 `jwttoken`
 *
 *  直播侧的凭据是**独立一套 JWT**（payload 含 `phone`/`userId`，≈30 天），
 *  与签到/兑换那串 `pc:`/`mobile:` 凭据不是同一个东西 —— 别互搬。 */
export function cmliveHeaders(jwt?: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    'accept-language': 'zh-CN,zh-Hans;q=0.9',
    origin: LIVE_ORIGIN,
    'user-agent': LIVE_USER_AGENT,
  };
  if (jwt !== undefined && jwt !== '') h['authorization'] = jwt;
  return h;
}

// ══════════════════════════ 门的三步 ══════════════════════════

/** ① 换 SSO token（**直播侧的 `toSourceId`**）。
 *
 *  ⚠ 与签到那一步**同一个端点、同一个构造器**，只差 `toSourceId`
 *  —— 所以这里复用 `specTokenRequest`（判据只有一份），只是把配方换成直播侧那个值。
 *  实证（mcloud）：`querySpecTokenV2(017027)` 能换到 SSO ⇒ 库里那份 `authorization`
 *  在直播族上也认。 */
export function gateSpecTokenRequest(
  authorization: string,
  base?: string | undefined,
): BuiltRequest {
  // 口子的归一在 `specTokenRequest` 里做（空串 = 用默认主机）
  const req = specTokenRequest({ toSourceId: LIVE_SOURCE_ID }, authorization, base);
  // ① 这一枪是 `user-njs`（现代套件），本来不需要 `tls` —— **不给**，
  //    让"哪一枪真的需要平台 TLS"这件事在代码里看得见（只有 cmlive 那几个要）。
  return req;
}

/** ② 用 SSO 换**直播侧 JWT**。 */
export function cmpassLoginRequest(ssoToken: string, base?: string | undefined): BuiltRequest {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/user/auth/cmpassLoginByCmToken`,
    method: 'POST',
    headers: { ...cmliveHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ cmpassToken: ssoToken }),
    // ⚠ `v.cmcc-cs.cn` **只给 CBC 套件**（2026-10-14 实测：`ECDHE-RSA-AES128-SHA`）——
    //    rustls 不实现 CBC ⇒ 必须走平台 TLS。见 [`BuiltRequest::tls`] 与 F-030/F-031。
    tls: 'native',
  };
}

/** 取 `cmpassLoginByCmToken` 响应里的 JWT。
 *
 *  ⚠ `object` **就是那串 JWT 本身**（实拍 180 字符），不是包着它的对象 ——
 *  这是 mcloud 那轮实证专门记下来的一处细节。
 *
 *  ⚠ 这里**不能**用 [`objectOf`]（那个要求 `object` 是对象）：这一口的 `object`
 *  就是**字符串**。判据不同就分开写，别为了复用把两种形状揉成一个"都吃"的解析器
 *  —— 上游改形状时那种解析器不会响。 */
export function parseCmpassLogin(env: CmliveEnvelope): Parsed<string> {
  if (!cmliveOk(env)) return { ok: false, error: `直播侧登录失败：${cmliveLine(env)}` };
  const raw = env.object;
  if (typeof raw !== 'string' || raw === '') {
    return {
      ok: false,
      error: `cmpassLoginByCmToken 的 object 不是非空字符串（应当就是那串 JWT 本身），实际 ${typeof raw}`,
    };
  }
  return { ok: true, value: raw };
}

/** ③ `tabContentList` —— 某个页签下的房间。
 *
 *  查询参数的**顺序与实拍逐字一致**（`tabId` → `contentType` → `pageNo` → `channelId`）。 */
export function tabContentListRequest(
  tabId: number,
  jwt: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url:
      `${rootOrDefault(base, BASE_CMLIVE)}/api/channel/channel/tabContentList` +
      `?tabId=${tabId}&contentType=0&pageNo=1&channelId=${LIVE_CHANNEL_ID}`,
    method: 'GET',
    headers: cmliveHeaders(jwt),
    body: undefined,
    // 同一个主机（`v.cmcc-cs.cn`）⇒ 同一条理由：只给 CBC，必须平台 TLS。
    tls: 'native',
  };
}

/** ③ 取 **WS 凭据**（`userToken`）—— ⚠ 它**不是**门换来的那个 JWT。
 *
 *  # 这一步是我先前漏掉的第一处（2026-10-14 实机）
 *
 *  门换来的 JWT 只用来**发 HTTP**；而 WS 的 PROVISION 里那个 `auth` 是
 *  `$t$<access_token>`，`access_token` 来自这一口（`object.access_token`）。
 *  用错的表现是"连得上、心跳也通、**就是没有弹幕**"。
 *
 *  ⚠ 它同时是 `member/apply` 的 `Authorization: Bearer <access_token>`（同一枚）。 */
export function userTokenRequest(jwt: string, base?: string | undefined): BuiltRequest {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/user/customer/userToken`,
    method: 'POST',
    headers: { ...cmliveHeaders(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({}),
    tls: 'native',
  };
}

/** 解析 `userToken`：要的是 `object.access_token`（空串也当没有）。 */
export function parseUserToken(body: string): Parsed<{ accessToken: string; expiresIn: number }> {
  const env = parseCmlive(body);
  if (!env.ok) return { ok: false, error: env.error ?? '直播侧响应解不出来' };
  if (env.value === undefined) return { ok: false, error: '直播侧响应是空的' };
  const object = env.value.object;
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    return { ok: false, error: 'userToken 的 object 不是对象' };
  }
  const o = object as Record<string, unknown>;
  const token = o['access_token'];
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'userToken 响应缺少 object.access_token' };
  }
  return {
    ok: true,
    value: {
      accessToken: token,
      expiresIn: typeof o['expires_in'] === 'number' ? o['expires_in'] : 0,
    },
  };
}

/** ④ 进直播间（`roomBeat`）—— 它是「这间房**有没有聊天室**」的唯一判据。
 *
 *  ⚠ `roomBeat` **不是 GET**：路径是 `/api/room/front/roomBeat`，房间号在 **body** 里
 *  （照 mcloud 的 `room_beat_request` 逐字）。我第一版把它当成
 *  `GET /api/room/beat?roomId=`，上游回的是**一页 HTML**（而 HTML 与"路径写错了"
 *  在解析层分不开 —— 这正是 `parseCmlive` 那条"数字码算失败"的报警灯要管的事）。
 *
 *  ⚠ `roomId` 传**字符串**：它是 31 位大整数，过一遍 JS 的 Number 有精度风险。 */
export function roomBeatRequest(
  roomId: number | string,
  jwt: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/room/front/roomBeat`,
    method: 'POST',
    headers: { ...cmliveHeaders(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: String(roomId), channelId: LIVE_CHANNEL_ID, sourceApp: 0 }),
    // 同一个主机（`v.cmcc-cs.cn`）⇒ 见 [`BuiltRequest.tls`]：只给 CBC，必须平台 TLS。
    tls: 'native',
  };
}

/** `roomBeat` 的读数。 */
export interface RoomBeatReading {
  status: number;
  title: string;
  expectStartTime: string;
  anchorNickname: string;
  /** 聊天室 id。**`undefined` = 上游给的是 null 或空串** ⇒ WS 与 `member/apply`
   *  都**不该发** —— 用 `undefined` 而不是空串，是为了让"没有"与"有但是空"
   *  在类型上就分得开（它们后面的动作完全相反）。 */
  chatRoomId: string | undefined;
}

/** 解析 `roomBeat`。信封判据与其它 `/cmlive` 口一致（数字码算失败）。 */
export function parseRoomBeat(body: string): Parsed<RoomBeatReading> {
  const env = parseCmlive(body);
  // ⚠ 这里**不能** `return env`：`Parsed` 的两个分支带的是**不同的 value 类型**，
  //    直接返回会让"信封解不出来"与"房间解不出来"在类型上混成一种。
  if (!env.ok) return { ok: false, error: env.error ?? '直播侧响应解不出来' };
  if (env.value === undefined) return { ok: false, error: '直播侧响应是空的' };
  const object = env.value.object;
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    return { ok: false, error: 'roomBeat 的 object 不是对象' };
  }
  const o = object as Record<string, unknown>;
  const anchor = o['anchor'];
  const nick =
    typeof anchor === 'object' && anchor !== null
      ? ((anchor as Record<string, unknown>)['nickname'] ?? '')
      : '';
  const rawChat = o['chatRoomId'];
  return {
    ok: true,
    value: {
      status: typeof o['status'] === 'number' ? o['status'] : -1,
      title: typeof o['title'] === 'string' ? o['title'] : '',
      expectStartTime: typeof o['expectStartTime'] === 'string' ? o['expectStartTime'] : '',
      anchorNickname: typeof nick === 'string' ? nick : '',
      // ⚠ **空串也当"没有"**：空串进不了 WS（会拼出一个空的 `cmlive_…`）。
      chatRoomId: typeof rawChat === 'string' && rawChat !== '' ? rawChat : undefined,
    },
  };
}

/** `tabContentList` 里的一间房。
 *
 *  只留**判据用得到**的字段：上游给的还有 `coverUrl` / `pullUrl` / `uv` 等十几个，
 *  全搬进来只会让"哪些字段在参与判断"变得看不出来。 */
export interface LiveRoom {
  id: number;
  title: string;
  /** 三档之一：`0` 预告 / `1` 直播中 / `6` 回放。 */
  status: number;
  /** **房间的归属频道** —— 不是"我拉的是哪个频道"（见 [`LIVE_CHANNEL_ID`]）。 */
  channelId: number;
  /** 预告开播时间（`2026-09-23 14:30:00` 形态的**本地**字符串，不是时间戳）。 */
  expectStartTime: string;
  /** 主播昵称 —— 门的**真正判据**。 */
  anchorNickname: string;
}

/** 解析 `tabContentList`。
 *
 *  ⚠ 房间嵌在 `dataList[].room` 里：别按 `dataList[].id` 找 —— 那一层是
 *  `type`/`activity`/`video` 的包装对象，`dataList[].id` 不是房间 id。
 *
 *  ⚠ `dataList: null` 是**合法**的「这个页签没有房间」，不是解析错误 ⇒ 回空表。 */
export function parseTabContentList(env: CmliveEnvelope): Parsed<LiveRoom[]> {
  const o = objectOf(env, '查房间列表');
  if (!o.ok || o.value === undefined) return { ok: false, error: o.error ?? '查房间列表失败' };
  const list = o.value['dataList'];
  if (list === null || list === undefined) return { ok: true, value: [] };
  if (!Array.isArray(list)) {
    return { ok: false, error: `dataList 不是数组（实际 ${typeof list}）` };
  }
  const rooms: LiveRoom[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const room = (entry as Record<string, unknown>)['room'];
    if (room === null || typeof room !== 'object' || Array.isArray(room)) continue;
    const r = room as Record<string, unknown>;
    rooms.push({
      id: intAt(r, 'id') ?? 0,
      title: strAt(r, 'title'),
      status: intAt(r, 'status') ?? -1,
      channelId: intAt(r, 'channelId') ?? 0,
      expectStartTime: strAt(r, 'expectStartTime'),
      anchorNickname:
        r['anchor'] !== null && typeof r['anchor'] === 'object'
          ? strAt(r['anchor'] as Record<string, unknown>, 'nickname')
          : '',
    });
  }
  return { ok: true, value: rooms };
}

/** 按房间 id 去重合并多个页签的结果（**先出现的赢**）。
 *
 *  两个页签会返回**同一间房**（实拍：147606 同时在 127 与 129 里）——
 *  不去重就会对同一间房做两次后续动作。 */
export function mergeRooms(groups: readonly (readonly LiveRoom[])[]): LiveRoom[] {
  const seen = new Set<number>();
  const out: LiveRoom[] = [];
  for (const group of groups) {
    for (const room of group) {
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      out.push(room);
    }
  }
  return out;
}

/** 从房间列表里挑出**会发口令**的那些（门的判据）。
 *
 *  # 两个条件**都要**
 *
 *  ```text
 *    status == 1（直播中）**且** anchorNickname === "中国移动云盘"
 *  ```
 *
 *  - 只看 `status == 1` **不够**：同一页（`tabId=127`）里就有一间 `status=1` 的
 *    「福建移动」（实拍 147490）；
 *  - 昵称是**精确相等**，不是包含：实拍那张表里还有「移动心选」「移动臻选」，
 *    用包含关系一个都拦不住。
 *
 *  预告（`0`）与回放（`6`）都**不算** —— 那时没有聊天室，去了必然空手而归。 */
export function koulingRooms(rooms: readonly LiveRoom[]): LiveRoom[] {
  return rooms.filter((r) => r.status === STATUS_LIVE && r.anchorNickname === KOULING_ANCHOR);
}

/** 「那个主播」名下的那些房间，**不限状态**。
 *
 *  ⚠ 它与 [`koulingRooms`] 只差状态那一档，而用途完全不同：门要"现在值不值得去听"
 *  ⇒ 只算 `status == 1`；界面那行要"下一场几点、上一场结束没" ⇒ 预告与回放都得留着
 *  （`expectStartTime` 只在预告那一档有意义）。**别拿它当门用**。 */
export function anchorRooms(rooms: readonly LiveRoom[]): LiveRoom[] {
  return rooms.filter((r) => r.anchorNickname === KOULING_ANCHOR);
}

/** 把上游的房间转成**池要的形状**（`ProbeRoom`）。
 *
 *  ⚠ 这一步是**有意的单向桥**：`ProbeRoom` 比 `LiveRoom` 少一半字段
 *  （`channelId` 不参与任何判据 —— 见 [`LIVE_CHANNEL_ID`]），
 *  合并成一个类型会让"哪些字段真的在参与判断"看不出来。 */
export function toProbeRooms(rooms: readonly LiveRoom[]): ProbeRoom[] {
  return rooms.map((r) => ({
    roomId: r.id,
    title: r.title,
    status: r.status,
    expectStartTime: r.expectStartTime,
    anchorNickname: r.anchorNickname,
  }));
}

/** 一行人话（界面/日志用）—— **不许只写"失败"两个字**。 */
export function gateReadingLine(rooms: readonly LiveRoom[]): string {
  const live = rooms.filter((r) => r.status === STATUS_LIVE);
  const hit = koulingRooms(rooms);
  if (hit.length > 0) {
    return `正在听：${KOULING_ANCHOR} 开播了（${hit.map((r) => r.title || `#${r.id}`).join('、')}）`;
  }
  if (live.length === 0) return `现在没在听：谁都没开播（看到 ${rooms.length} 间房，全是预告/回放）`;
  return (
    `现在没在听：有 ${live.length} 间在播，但不是「${KOULING_ANCHOR}」的` +
    `（${live.map((r) => r.anchorNickname || '无名').join('、')}）`
  );
}

function intAt(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function strAt(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === 'string' ? v : '';
}
