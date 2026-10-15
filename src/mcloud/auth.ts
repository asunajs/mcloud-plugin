// 凭据（`Authorization` 那一串）的解析。
//
// 权威源：`mcloud/crates/mcloud-upstream/src/auth.rs` 的 `parse_auth` 与
// `node_like_b64_decode`，逐条照抄。
//
// # 格式
//
// ```text
// Basic base64("<平台>:<手机号>:<token>")
// ```
//
// `Basic ` 前缀**可有可无**（也能出现在中间 —— 服务端只替换**第一处**）。
//
// # 平台只有两种，而 `pc` **分不出 win/mac**
//
// ```text
// pc      ← Windows 与 macOS 都是它（客户端源码里是字面量，不是平台号）
// mobile  ← 手机端（App 自己的身份）
// ```
//
// ⇒ 「是 win 还是 mac」必须**单独落盘**（`Account.pcPlatform`），
//   因为它决定后续每一次请求的 UA 与设备头，而凭据本身区分不出来。
//   这正是参考实现里 `Account::pc_platform` 单独存在的理由。
//
// # 为什么解析要"宽容"
//
// 参考实现刻意**不用**严格 base64（见 `node_like_b64_decode` 的注释）：
// Node 的 `Buffer.from(s, "base64")` 会**忽略字母表以外的字符**，而严格模式报错。
// 差异只出现在畸形输入上 —— 但那正是这一层要处理的东西：
// 用严格模式，"上游塞了个空白字符"会变成"凭据整条不可用"。

import { fromBase64, fromUtf8 } from '../crypto/bytes.ts';

/** PC 端载荷的第一段。**不区分** Windows 与 macOS。 */
export const PC_AUTH_PREFIX = 'pc';

/** 手机端（App）载荷的第一段。 */
export const APP_AUTH_PREFIX = 'mobile';

/** PC 客户端形态。凭据里没有它 ⇒ 要单独存。 */
export type PcPlatform = 'win' | 'mac';

export type AuthInfo = {
  /** 规整过的原串：`Basic <clean>`（`Basic ` 前缀恒有，便于落盘与回显） */
  raw: string;
  /** 第一段。**可能为空**（上游有缺段的样本）。 */
  platform: string;
  /** 第二段。**可能为空**。 */
  phone: string;
  /** 第三段。**可能为空**。 */
  token: string;
  /** token 的第 4 段（`|` 分隔）当毫秒时间戳；缺/非法 ⇒ 0。 */
  expire: number;
};

/** 复刻 Node `Buffer.from(s, "base64")` 的**宽容**解码。
 *
 *  规则（逐条对齐参考实现，那边有向量钉住）：
 *
 *  1. 只取 `=` **之前**的内容（填充自己补）
 *  2. 丢掉字母表以外的字符（空白、`!`、`-` …）
 *  3. 过滤后为空、或长度模 4 余 1 ⇒ **不可解**（余 1 构不成任何字节）
 *  4. 解出来是空字节串也算不可解 —— 避免"解出了空凭据"这种假成功
 */
function lenientB64(s: string): string | undefined {
  let payload = '';
  for (const c of s) {
    if (c === '=') break; // 规则 1：`=` 之后全丢
    if (/[A-Za-z0-9+/]/.test(c)) payload += c;
  }
  if (payload.length === 0 || payload.length % 4 === 1) return undefined;

  // 补填充：长度模 4 余 2 补 `==`，余 3 补 `=`
  const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
  let text: string;
  try {
    text = fromUtf8(fromBase64(payload + pad));
  } catch {
    return undefined;
  }
  // 规则 4
  return text.length === 0 ? undefined : text;
}

/** 是否是"朴素的十进制数"。
 *
 *  比 `Number()` 更严：`Number('1e5')` 是 100000、`Number('Infinity')` 是 Infinity，
 *  而原实现是逐字符判断。`NaN` ⇒ 归 0（见下面的 `expire`）。 */
function isPlainDecimal(s: string): boolean {
  if (s.length === 0) return false;
  let i = 0;
  if (s[0] === '+' || s[0] === '-') i = 1;
  if (i >= s.length) return false;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** 解析一段凭据。**解不开就 `undefined`**（不抛）。
 *
 *  ⚠ `platform` / `phone` / `token` **允许为空**：上游实测有缺段的样本，
 *  报错会让一条"能用但信息不全"的凭据变成不可用，代价不对等。
 *  调用方判"是不是 PC 端"时要**显式比对前缀**，不能靠"非空"。
 */
export function parseAuth(auth: string): AuthInfo | undefined {
  if (auth.trim() === '') return undefined;

  // 只替换**第一处** `Basic `，且它出现在中间时也要替换
  // （JS 的 `replace` 不认位置，只认"第一处"）
  const i = auth.indexOf('Basic ');
  const clean = i < 0 ? auth : auth.slice(0, i) + auth.slice(i + 'Basic '.length);

  const decoded = lenientB64(clean);
  if (decoded === undefined) return undefined;

  // 只取前 3 段：第 4 段起丢弃（token 含 `:` 会被截断）
  const parts = decoded.split(':', 4);
  const platform = parts[0] ?? '';
  const phone = parts[1] ?? '';
  const token = parts[2] ?? '';

  // token 的第 4 段（`|` 分隔）是到期毫秒。按 f64 解析再截断（原实现是浮点）
  const seg = token.split('|')[3]?.trim();
  const expire =
    seg !== undefined && isPlainDecimal(seg) ? Math.trunc(Number(seg)) || 0 : 0;

  return { raw: `Basic ${clean}`, platform, phone, token, expire };
}

/** 是不是 PC 端的凭据。**显式比对前缀**（空串不算）。 */
export function isPcAuth(info: AuthInfo): boolean {
  return info.platform === PC_AUTH_PREFIX;
}

/** 是不是手机端的凭据。 */
export function isAppAuth(info: AuthInfo): boolean {
  return info.platform === APP_AUTH_PREFIX;
}
