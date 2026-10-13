// H5 会话：**三步换票** —— 把原生凭据换成 H5 的 `jwttoken`。**纯函数：不发请求。**
//
// 权威源：`crates/mcloud-upstream/src/session.rs`（纯协议）+ `session_source.rs`（网络编排）。
// 发请求那一层在 `sessionExchange.ts`。
//
// ═══════════════════════════════════════════════════════════════════════
// 这三条是**一条链**，不是三个接口
// ═══════════════════════════════════════════════════════════════════════
//
// ```text
// ① POST https://user-njs.yun.139.com/user/querySpecTokenV2   ← 换 SSO token
// ② GET  https://m.mcloud.139.com/ycloud/api/timestamp        ← 服务端时间戳（无鉴权）
// ③ POST https://m.mcloud.139.com/ycloud/auth-service/auth/tyrzLogin ← 换 jwttoken（带签名）
// ```
//
// 没有第 ③ 步的 `jwttoken`，后面所有 H5 业务请求一律回 `90001 未登录`。
// 拆成"想到谁调谁"的函数，漏掉中间一步的表现是**每个业务接口都报未登录** ——
// 看上去像鉴权坏了，实际是会话没建。
//
// ═══════════════════════════════════════════════════════════════════════
// 为什么这件事在插件里到现在才有
// ═══════════════════════════════════════════════════════════════════════
//
// `groups.ts` 里长期记着一句"换出该页 jwttoken 的那一步**在实拍归档里没有** ⇒ 现在做不了"。
// 那句话说的是**实拍**没有；而**实现**有（就是本文件复刻的这三百来行 Rust）。
// 结果就是插件只能靠人手从浏览器抄一份 `jwttoken` 贴进来 —— 而它 2 小时即废。
//
// ⇒ 现在把这条链补上：插件能直接吃**原生凭据**（`Basic base64("mobile:号:token")`），
// 自己换票、自己续，不用再手工贴。
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠ 四个必须照抄、照直觉会写错的地方
// ═══════════════════════════════════════════════════════════════════════
//
// ① **`toSourceId` 不是端常量，是调用方参数**：同一个 App 进程里出现过三个值
//    （`001005` 签到 / `001003` 权益 / `010001` 权益）。跨端、跨发起方的常量一律不许互搬。
// ② **时间戳必须用服务端的**：签名里的 `x-timestamp` 要与之逐字相同，
//    本地时钟偏一点就是 `401`。
// ③ **两套信封**：① 是 `{success:true, code:"0000", data:{token}}`（`code` 是**字符串**），
//    ③ 是 `{code:0, result:{token}}`（`code` 是**数字**）。判据不能只写一套。
// ④ **`auth.raw` 自带 `Basic ` 前缀，一个字都不能再加**。再加一次得到
//    `Basic Basic bW9iaW…`，而上游的回话是 `{"code":"05050009","message":"非法的token！"}`
//    —— 那句话**听起来像"凭据过期了"**，于是会有人去查有效期（一切正常），
//    而真相是头值拼错了。一次排查就这么被带到隔壁。
//
// ⚠ ⑤ **SSO token 不缓存**（实测"换到 4 分钟后重放已被拒"），换完立刻用；
//    `jwttoken` 也要短存 —— 它 2 小时即废。

import { signHeadersWith } from './sign.ts';
import type { SignHeaders } from './sign.ts';
import { nonce as newNonce, uuidV4 } from './rand.ts';

/** 原生接口的主机（`Authorization` + 设备头那一族，**无签名**）。 */
export const BASE_USER_YUN = 'https://user-njs.yun.139.com';
/** H5 接口的主机。 */
export const BASE_MCLOUD = 'https://m.mcloud.139.com';

/** H5 建会话用的签名盐位。**与 App 业务签名同一个盐表，只是取第 2 个。** */
export const H5_SALT_KEY = 2;
/** H5 请求的 content-type。带 `charset` 是抓包实样。 */
export const H5_CONTENT_TYPE = 'application/json;charset=UTF-8';
/** H5 的 `appversion` 头。 */
export const H5_APP_VERSION = '12.6.0.0';

/** `querySpecTokenV2` 那条路径（在 [`BASE_USER_YUN`] 上）。 */
export const SPEC_TOKEN_PATH = '/user/querySpecTokenV2';
/** 服务端时间戳（在 [`BASE_MCLOUD`] 上，**无鉴权**）。 */
export const TIMESTAMP_PATH = '/ycloud/api/timestamp';
/** 换 `jwttoken`（在 [`BASE_MCLOUD`] 上，带签名）。 */
export const TYRZ_LOGIN_PATH = '/ycloud/auth-service/auth/tyrzLogin';

/** 一条会话的"配方"：这一页按什么参数换票。
 *
 *  ⚠ 它是**配方，不是页面名**：真正决定一条会话长什么样的是换票那几枪用的参数。
 *  mcloud 的实测结论是**每个页面用自己的参数换自己的票，票与票之间逐字节不等**。 */
export interface RecipeParams {
  /** `querySpecTokenV2` 的 body 与页面 URL 的 `targetSourceId`。 */
  toSourceId: string;
  marketName: string;
  sourceId: string;
  /** 页面 URL 的 `appID`。`undefined` = **实拍里这一页的入口没有这个参数**。
   *  ⚠ 做成可选而不是给空串：空串会拼出 `&appID=`，那是**多一枚空参数**，
   *  与"没有这一枚"是两件事。 */
  h5AppId?: string | undefined;
  pagePath: string;
  /** `portal/<这一段>/index.html` 的那一段。⚠ **逐页不同**。 */
  portalPage: string;
  /** 入口 URL 要不要 `&targetSourceId=`。⚠ 两页**不同**（都是实拍）。 */
  targetSourceId?: string | undefined;
}

/** 签到页配方 —— 唯一有完整实拍的配方。
 *
 *  ⚠ `targetSourceId` 必须带、且排在 `token` **之后**（见 [`pageUrl`] 那段说明）。 */
export const SIGN_IN_RECIPE: RecipeParams = {
  toSourceId: '001005',
  marketName: 'sign_in_3',
  sourceId: '1002',
  h5AppId: 'cy62d5a5e8373a272aeca467accad61722c51cfd48',
  pagePath: 'newsignin',
  portalPage: 'mobilecloud',
  targetSourceId: '001005',
};

/** 这一页的 H5 落地页地址（纯协议实现里只用来当 `referer`）。
 *
 *  真实客户端把 SSO token 直接拼在查询串里交给 WebView，H5 自己拿它去 `tyrzLogin` 建会话。
 *
 *  # ⚠ 为什么是"逐页"拼而不是一套模板套参数
 *
 *  两页的入口 URL **形状不同**，不是同一套模板换几个值：
 *
 *  ```text
 *  签到页  /portal/mobilecloud/index.html?path=newsignin&sourceid=1002
 *          &enableShare=1&appID=<40 字符>&token=<SSO>&targetSourceId=001005
 *  通知页  /portal/hcyview/index.html?path=openNoticeGift&sourceid=1062
 *          &token=<42 字符>&enableShare=1
 *  ```
 *
 *  差别有三处：**路径段**、通知页**没有** `appID`、通知页**没有** `targetSourceId`，
 *  而且参数次序也不同。⚠ 签到页那条 `&targetSourceId=…` 必须带、且排在 `token` 之后 ——
 *  参考实现踩过一次坑：初版漏了它，因为当时是**照着实现**写的这一行，而不是照着抓包，
 *  于是实现与文档一起漏。 */
export function pageUrl(p: RecipeParams, ssoToken: string): string {
  let url =
    `${BASE_MCLOUD}/portal/${p.portalPage}/index.html` +
    `?path=${p.pagePath}&sourceid=${p.sourceId}`;
  if (p.h5AppId !== undefined) url += `&enableShare=1&appID=${p.h5AppId}`;
  url += `&token=${ssoToken}`;
  if (p.targetSourceId !== undefined) url += `&targetSourceId=${p.targetSourceId}`;
  // ⚠ 有 `appID` 的那一页（签到）实拍里 `enableShare=1` 在 `appID` **之前**，
  // 而没有 `appID` 的那一页它在 `token` **之后**。两处次序都是照抄，
  // 所以它跟着 `appID` 一起分支 —— 不在这里"统一一下顺序"。
  if (p.h5AppId === undefined) url += '&enableShare=1';
  return url;
}

/** 给 H5 请求补上那套自有头。
 *
 *  与 App 原生头是**两套**：原生走 `Authorization` + 设备头（**无签名**），
 *  H5 走 `activityid` / `appversion` / `jwttoken`。
 *  `jwt` 为空时不加 `jwttoken` 头（建会话这三步就是这种情况）。 */
export function h5Headers(
  params: RecipeParams,
  referer: string,
  jwt: string | undefined,
  showLoading: string,
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: '*/*',
    activityid: params.marketName,
    appversion: H5_APP_VERSION,
    Referer: referer,
    showloading: showLoading,
  };
  // 头名是**小写** `jwttoken`（不是 `jwtToken`）—— H5 拦截器原样如此
  if (jwt !== undefined) h.jwttoken = jwt;
  return h;
}

// ── 三个请求构造器 ──────────────────────────────────────────────────────

/** ① `POST /user/querySpecTokenV2` —— 原生族，靠 `Authorization` 鉴权、**无签名**。 */
export function specTokenRequest(
  params: RecipeParams,
  authorization: string,
  base?: string | undefined,
): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
  return {
    url: `${(base ?? BASE_USER_YUN).replace(/\/+$/, '')}${SPEC_TOKEN_PATH}`,
    method: 'POST',
    headers: { 'Content-Type': H5_CONTENT_TYPE, Authorization: authorization },
    body: JSON.stringify({ toSourceId: params.toSourceId }),
  };
}

/** ② `GET /ycloud/api/timestamp`（无鉴权）。 */
export function timestampRequest(
  params: RecipeParams,
  referer: string,
  base?: string | undefined,
): { url: string; method: 'GET'; headers: Record<string, string>; body: undefined } {
  return {
    url: `${(base ?? BASE_MCLOUD).replace(/\/+$/, '')}${TIMESTAMP_PATH}`,
    method: 'GET',
    headers: h5Headers(params, referer, undefined, 'true'),
    body: undefined,
  };
}

/** ③ `POST /ycloud/auth-service/auth/tyrzLogin`（带签名）。
 *
 *  body 的键按**字典序**（`marketName` → `openAccount` → `sourceId` → `token`）——
 *  签名能不能用取决于这个，而不是插入序。
 *  ⚠ 用 `JSON.stringify` 一个**已按序**构造的对象（JS 的对象键序：字符串键按插入序），
 *  所以这里的字面量顺序就是发出去的顺序。别改成"先建空对象再逐个赋值"。 */
export function tyrzLoginRequest(
  params: RecipeParams,
  ssoToken: string,
  sign: SignHeaders,
  referer: string,
  base?: string | undefined,
): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    marketName: params.marketName,
    openAccount: 0,
    sourceId: params.sourceId,
    token: ssoToken,
  });
  return {
    url: `${(base ?? BASE_MCLOUD).replace(/\/+$/, '')}${TYRZ_LOGIN_PATH}`,
    method: 'POST',
    headers: {
      ...h5Headers(params, referer, undefined, 'true'),
      Origin: BASE_MCLOUD,
      'x-request-id': sign['x-request-id'],
      'x-timestamp': sign['x-timestamp'],
      'x-nonce': sign['x-nonce'],
      'x-signature': sign['x-signature'],
    },
    body,
  };
}

/** 造第 ③ 步的签名头。算式：`md5(盐 + id + timestamp + nonce + "" + 盐)`，
 *  最后那个空串是 H5 留的预留位（实测恒为空）。
 *
 *  `timestamp` 用**服务端**给的那个（见文件头 ②）。 */
export function makeSign(serverTimestamp: string): SignHeaders {
  return signHeadersWith(uuidV4(), newNonce(), serverTimestamp, H5_SALT_KEY, '');
}

// ── 三个解析器（形状各不相同，见文件头 ③）────────────────────────────────

export interface Parsed<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** ① `querySpecTokenV2` → SSO token。
 *
 *  ⚠ 双层信封：`{"success":true,"code":"0000","message":"…","data":{…}}`。
 *  `code` 是**字符串** `"0000"`，不是数字 —— 按数字解会失败。 */
export function parseSsoToken(body: string): Parsed<string> {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `querySpecTokenV2 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.success !== true) {
    return {
      ok: false,
      error: `querySpecTokenV2 失败：code=${String(v.code ?? '?')} message=${String(v.message ?? '')}`,
    };
  }
  const data = v.data;
  const token = data && typeof data === 'object' ? (data as Record<string, unknown>).token : undefined;
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'querySpecTokenV2 响应没有 data.token' };
  }
  return { ok: true, value: token };
}

/** ② `api/timestamp` → **字符串形式**的 13 位毫秒。
 *
 *  保持字符串：它下一步要原样进 `x-timestamp` 头与签名，中途过一遍数字类型
 *  只会多一次"格式化可能不一致"的机会。 */
export function parseServerTimestamp(body: string): Parsed<string> {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `api/timestamp 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const r = v.result;
  if (typeof r === 'number' && Number.isFinite(r)) return { ok: true, value: String(r) };
  if (typeof r === 'string' && r !== '') return { ok: true, value: r };
  if (r === undefined) return { ok: false, error: 'api/timestamp 响应没有 result' };
  return { ok: false, error: `api/timestamp 的 result 不是整数：${JSON.stringify(r)}` };
}

/** ③ `tyrzLogin` → `jwttoken`（`result.token`）。
 *
 *  ⚠ 失败样本 `{"code":200050409,"msg":"token 已失效"}` **没有 `success` 字段**，
 *  所以判据不能只看 `success`；`code` 可能是数字 `0`、也可能是字符串 `"0000"`。 */
export function parseJwtToken(body: string): Parsed<{ jwt: string; mobile?: string | undefined }> {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `tyrzLogin 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }

  const code = v.code;
  let codeOk: boolean;
  if (typeof code === 'number') codeOk = code === 0;
  else if (typeof code === 'string') codeOk = code === '0' || code === '0000';
  else if (code === null || code === undefined) codeOk = v.success === true;
  else return { ok: false, error: `tyrzLogin 的 code 类型意外：${JSON.stringify(code)}` };

  if (!codeOk) {
    const msg = typeof v.msg === 'string' ? v.msg : typeof v.message === 'string' ? v.message : '(无消息)';
    return { ok: false, error: `tyrzLogin 失败：code=${JSON.stringify(code ?? null)} msg=${msg}` };
  }
  const result = v.result;
  if (!result || typeof result !== 'object') return { ok: false, error: 'tyrzLogin 响应没有 result' };
  const r = result as Record<string, unknown>;
  if (typeof r.token !== 'string' || r.token === '') {
    return { ok: false, error: 'tyrzLogin 响应没有 result.token' };
  }
  return {
    ok: true,
    // `mobile` 可能缺失 —— 它是"确认签的是哪个账号"的回显，不是凭据的一部分，
    // 缺了不该让整次登录失败
    value: { jwt: r.token, mobile: typeof r.mobile === 'string' ? r.mobile : undefined },
  };
}

// ── 原生凭据 ────────────────────────────────────────────────────────────

/** 收下用户给的 `Authorization` 值。
 *
 *  ⚠⚠ **已经有 `Basic `/`Bearer ` 前缀的一个字都不加**（见文件头 ④）。
 *  只在**完全没有 scheme** 时才补 `Basic ` —— 那时用户贴的是
 *  `base64("mobile:号:token")` 那一段裸值，补一次是对的。
 *
 *  为什么敢在这里"猜"一次：两种输入的形态**互斥**（带前缀 / 不带前缀），
 *  而且补错的后果很明确（上游回 `05050009 非法的token！`）。
 *  比"一律原样发"更好的一点是：裸值也能用，少一步手工拼。 */
export function normalizeAuthorization(raw: string): Parsed<string> {
  const v = raw.trim();
  if (v === '') return { ok: false, error: '凭据是空的' };
  if (/^(basic|bearer)\s/i.test(v)) return { ok: true, value: v };
  // 裸值：补一次 `Basic `
  if (/\s/.test(v)) {
    return {
      ok: false,
      error: '这个值里有空格但又不是 Basic/Bearer 开头 —— 像是抄断了。' +
        '正确形状是 `Basic base64("mobile:手机号:token")`（整串一个空格）',
    };
  }
  return { ok: true, value: `Basic ${v}` };
}

/** 凭据指纹：SHA-256 hex 的前 16 个字符。只用于**分组/判断"换了没换"**，不当凭据用。
 *
 *  ⚠ 别拿它当"脱敏摘要"给界面看 —— 前 16 个 hex 仍然是凭据的确定函数，
 *  但这个规模下不构成风险（与上游 `auth_fingerprint` 同口径）。 */
export function authFingerprint(sha256hex: string): string {
  return sha256hex.slice(0, 16);
}
