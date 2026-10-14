// 凭据续期：`POST https://user-njs.yun.139.com/user/auth/refreshToken`。
//
// # 它解决什么
//
// 原生凭据（`Authorization`）有有效期（约 30 天）。过期之后所有任务一起失效，
// 而症状是 `05050009 非法的token！` —— 一个看着像"凭据坏了"、其实只是"到期了"的提示。
// 续期能把这件事变成自动化。
//
// # ⚠ **一个字段都不用用户给**
//
// 这一点我一开始判断错了 —— 我以为要让用户再贴**手机号**和**用户域**。
// 其实两者都已经在手上的东西里：
//
// ```text
// Authorization: Basic base64("端别:手机号:token")
//                               ↑     ↑
//                     解一次 base64 就有（真机：mobile / 191****2716 / 201 字符）
//
// jwttoken 的 payload.sub（一个 JSON 串）→ userDomainId
//                    （真机：1125330776486986478，与账号里登录时记的那个**同值**）
// ```
//
// 于是续期只需要**用户已经给过的东西**：那条凭据 + 换票换到的 jwttoken。
//
// # 三个容易做错的地方
//
// 1. **判成功要看两处**：`success === true` **且** `code ∈ {"0000","0"}`。
//    只看一个的话，另一种失败形态会被读成成功 —— 而"以为续上了、其实没有"
//    比"明确报失败"糟得多。
// 2. **新的 token 不是新的整串**：它是解码后的**第三段**，所以必须整体重拼
//    （`Basic base64(端别:手机号:新token)`），而不是替换整串。
// 3. **键序**：体里 `userDomainId` 在 `clientType` 前（照实拍原串）。
//    这个接口不签名，所以顺序今天不影响结果 —— 但一旦上游改成按体签名，
//    "顺序对不上"会表现成一个含义模糊的鉴权错，而没人会想到是键序。

import { fromBase64, fromUtf8, toBase64, utf8 } from '../crypto/bytes.ts';
import { callRawText } from './client.ts';
import { STATE_AUTH, loadJwt, startExchange } from './sessionExchange.ts';
import type { TaskDeps, TaskOutcome } from './tasks/base.ts';
import type { BuiltRequest } from './h5.ts';

export const REFRESH_BASE = 'https://user-njs.yun.139.com';
export const REFRESH_PATH = '/user/auth/refreshToken';

/** App 端的 `clientType`。 */
export const APP_CLIENT_TYPE = '412';
/** PC 端的 `clientType`（来自 PC 客户端源码，未实测 —— 改这里一处）。 */
export const PC_CLIENT_TYPE = '414';

/** ⚠ 每次续期成功都会**换出一枚新 token**（它与旧的不同，有自己的 30 天）。
 *  所以这是**续期**不是"延长原来的那个" —— 文案里别写成"延保"。 */
export interface RefreshResult {
  token: string;
  expireSeconds?: number | undefined;
}

/** 从 `Basic base64(端别:手机号:token)` 里解出三段。
 *
 *  ⚠ 用**第一个和第二个**冒号切，剩下全归 token —— token 本身可能含 `:`，
 *  用 `split(':')` 取 `[2]` 会在那种时候悄悄截断。 */
export function parseAuthorization(raw: string): { platform: string; phone: string; token: string } | null {
  const b64 = raw.replace(/^Basic\s+/i, '').trim();
  if (!b64) return null;
  let plain: string;
  try {
    plain = fromUtf8(fromBase64(b64));
  } catch {
    return null;
  }
  const i = plain.indexOf(':');
  if (i < 0) return null;
  const j = plain.indexOf(':', i + 1);
  if (j < 0) {
    // 两段（`端别:token`）也能用 —— 只是拿不到手机号，续期时就拼不回整串
    return { platform: plain.slice(0, i), phone: '', token: plain.slice(i + 1) };
  }
  return { platform: plain.slice(0, i), phone: plain.slice(i + 1, j), token: plain.slice(j + 1) };
}

/** 拼回完整的 `Authorization` 头值（**带 `Basic ` 前缀**）。
 *
 *  ⚠ 曾经有一版返回**裸** base64，理由是"与 `AuthInfo::raw` 同形" —— 那个前提是错的：
 *  实拍落盘的凭据带前缀，抓包里也是整串。两种形状混着落库的后果是
 *  **"刷过的账号"与"刚登录的账号"发出不同的头**，而错的那一半只会回
 *  `05050009 非法的token！` —— 一个指向"凭据过期"的**假线索**。 */
export function rebuildAuthorization(platform: string, phone: string, token: string): string {
  return `Basic ${toBase64(utf8(`${platform}:${phone}:${token}`))}`;
}

/** 解 JWT 的 payload（`base64url`，可能不带 padding）。 */
export function jwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const seg = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
  try {
    const v = JSON.parse(fromUtf8(fromBase64(padded))) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从 jwttoken 里取 `userDomainId`。
 *
 *  ⚠ **真机上它不在顶层**：payload 的键只有 `iss/iat/sub/exp`，
 *  而 `userDomainId` 藏在 `sub` —— 那个键的值**本身是一段 JSON 文本**。
 *  只查顶层会得到 `undefined`，然后表现成"账号缺用户域"（看着像账号的问题）。 */
export function jwtUserDomainId(jwt: string): string | null {
  const p = jwtPayload(jwt);
  if (!p) return null;
  const top = p.userDomainId;
  if (typeof top === 'string' && top !== '') return top;
  const sub = p.sub;
  if (typeof sub === 'string' && sub.trim().startsWith('{')) {
    try {
      const inner = JSON.parse(sub) as Record<string, unknown>;
      const v = inner.userDomainId;
      if (typeof v === 'string' && v !== '') return v;
    } catch {
      /* sub 不是 JSON 就算了 */
    }
  }
  return null;
}

/** `clientType`：AC 端（H5/App）是 412，PC 是 414。 */
export function clientTypeFor(platform: string): string {
  return platform === 'pc' ? PC_CLIENT_TYPE : APP_CLIENT_TYPE;
}

/** JSON 字符串转义（只做必要集）。
 *
 *  `userDomainId` 是 19 位数字、`clientType` 是 3 位数字，实际上永远不需要转义 ——
 *  但**不因此省掉**：将来有人把别的字段塞进来时，省掉的那一步就是注入点。 */
export function escapeJsonString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

/** 构造续期请求。`raw` 是**当前**那串 —— 续期要证明"我是这个 token 的持有者"。 */
export function refreshRequest(raw: string, userDomainId: string, platform: string): BuiltRequest {
  // ⚠ 手拼而不是 `JSON.stringify({userDomainId, clientType})`：
  // 顺序要照实拍（`userDomainId` 在前），而对象字面量的顺序**依赖调用方**写对，
  // 手拼把这件事钉在**一处**、并且显式做了转义
  const body = `{"userDomainId":"${escapeJsonString(userDomainId)}","clientType":"${escapeJsonString(clientTypeFor(platform))}"}`;
  return {
    url: `${REFRESH_BASE}${REFRESH_PATH}`,
    method: 'POST',
    headers: {
      Authorization: raw,
      // content-type 由传输层补（`application/json;charset=UTF-8`）—— 见 client.ts
    },
    body,
  };
}

/** 解析续期响应。**两处都要看**：`success === true` 且 `code ∈ {"0000","0"}`。 */
export function parseRefresh(body: string): { ok: boolean; result?: RefreshResult; error?: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `refreshToken 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v.code;
  const codeOk =
    (typeof code === 'string' && (code === '0000' || code === '0')) ||
    (typeof code === 'number' && code === 0);
  // ⚠ `success` 缺了就以 `code` 为准（两种形态都见过）；但**给了且为假**就一定算失败
  const success = typeof v.success === 'boolean' ? v.success : codeOk;
  if (!success || !codeOk) {
    const msg = String(v.message ?? v.msg ?? '(无消息)');
    return { ok: false, error: `refreshToken 失败：code=${String(code ?? '?')} ${msg}` };
  }
  const data = v.data;
  if (!data || typeof data !== 'object') return { ok: false, error: 'refreshToken 响应没有 data' };
  const token = (data as Record<string, unknown>).token;
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'refreshToken 响应没有 data.token' };
  }
  const exp = (data as Record<string, unknown>).expireTime;
  const expireSeconds =
    typeof exp === 'number' ? Math.trunc(exp) : typeof exp === 'string' && /^\d+$/.test(exp) ? Number(exp) : undefined;
  return { ok: true, result: { token, expireSeconds } };
}

/** 把一次续期的结果拼成新的凭据串。 */
export function applyRefreshResult(
  raw: string,
  res: RefreshResult,
): { ok: true; raw: string } | { ok: false; error: string } {
  const seg = parseAuthorization(raw);
  if (!seg) return { ok: false, error: '当前凭据解不开（不是 `Basic base64(端别:手机号:token)`），无法重拼' };
  if (seg.phone === '') return { ok: false, error: '当前凭据里没有手机号段，无法重拼' };
  return { ok: true, raw: rebuildAuthorization(seg.platform, seg.phone, res.token) };
}

// ───────────────────────── 该不该刷：照抄 mcloud 的 `decide` ─────────────────────────

/** 提前量默认值。mcloud 取的是**账号配置** `refresh_token_days`（默认 10 天），
 *  CLI 的 `--lead-days` 是显式覆盖。这里两者都留：参数给了就用参数。 */
export const DEFAULT_LEAD_DAYS = 10;

/** 判据的三种结果。
 *
 *  ⚠ 是**三档**而不是"刷/不刷"两档 —— `ManualOnly` 与 `NotYet` 都**不打上游**，
 *  但处置完全不同：前者要重新登录，后者什么都不用做。
 *  合成一档，用户看到的就是"没刷"而不知道要不要管。 */
export type RefreshDecision = 'needed' | 'not-yet' | 'manual-only';

/** 从 token 里取过期时刻（**毫秒**）。
 *
 *  ⚠ 原实现是 `Number(token?.split("|")[3]) || 0` —— 按 **f64** 解析再截断：
 *  token 是**竖线分段**的，第 4 段才是毫秒数；解不出来就是 `0`（不是 `undefined`，
 *  因为 `0` 在判据里有确定含义：见 `decide`）。 */
export function tokenExpireMs(token: string): number {
  const f = token.split('|')[3]?.trim() ?? '';
  if (!/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(f)) return 0;
  const v = Number(f);
  return Number.isFinite(v) && v !== 0 ? Math.trunc(v) : 0;
}

/** 当前凭据的过期时刻（毫秒）。解不开 ⇒ `-1`（对应 `manual-only`）。 */
export function credentialExpireMs(raw: string): number {
  const seg = parseAuthorization(raw);
  if (!seg) return -1;
  return tokenExpireMs(seg.token);
}

/** 判据本体。逐行照抄 mcloud 的 `decide`（`mcloud-app/src/auth_refresh.rs:80`）。
 *
 *  ⚠ `<=` 而不是 `<`：剩余**正好**等于提前量时也算"该刷"（边界归属是刻意的）。 */
export function decide(expireMs: number, nowMs: number, leadDays = DEFAULT_LEAD_DAYS): RefreshDecision {
  if (expireMs < 0) return 'manual-only';
  if (expireMs === 0) return 'needed';
  const leadMs = Math.trunc(leadDays * 86_400_000);
  return expireMs - nowMs <= leadMs ? 'needed' : 'not-yet';
}

/** 剩余天数（只给文案用，不参与判定）。 */
export function daysLeft(expireMs: number, nowMs: number): number | undefined {
  if (expireMs <= 0) return undefined;
  return Math.floor((expireMs - nowMs) / 86_400_000);
}

/** 落库前兜底：**新串必须能解析回来**。
 *
 *  mcloud 单独写了这一条（`assert_usable`），理由是
 *  "拼错了但看起来有值"是最难查的一类 —— 它在库里、在界面上都正常显示，
 *  只是每次请求都鉴权失败。 */
export function assertUsable(raw: string): { ok: true } | { ok: false; error: string } {
  const seg = parseAuthorization(raw);
  if (!seg) return { ok: false, error: '新凭据解不开（不是 `Basic base64(端别:手机号:token)`）' };
  if (seg.platform === '' || seg.phone === '' || seg.token === '') {
    return { ok: false, error: '新凭据有段是空的，拒绝落库' };
  }
  return { ok: true };
}

// ───────────────────────── 执行体 ─────────────────────────

export const STATE_LAST = 'mcloud.auth.refresh.last';

/** 续期一次。`force` 跳过判据（对应 mcloud CLI 的 `--force`）。 */
export function runAuthRefresh(deps: TaskDeps, force = false, leadDays = DEFAULT_LEAD_DAYS): TaskOutcome {
  const raw = deps.store.getState(STATE_AUTH) ?? '';
  if (raw === '') {
    return { ok: true, skipped: true, note: '没有原生凭据，谈不上续期（先贴一份）' };
  }
  const nowMs = Date.parse(deps.nowIso);
  const expireMs = credentialExpireMs(raw);
  const decision = force ? 'needed' : decide(expireMs, nowMs, leadDays);

  if (decision === 'manual-only') {
    // ⚠ 这一档**不打上游**：凭据解不开（不是 `Basic base64(端别:手机号:token)`），
    // 续期请求连"我是谁"都证明不了 ⇒ 只能重新登录。报成失败会每天多一条红，
    // 而用户需要知道的是"要重新登录"这件**不同**的事。
    return {
      ok: true,
      skipped: true,
      note: '凭据解不开（过期段也没有）—— 这一档只能重新贴一份，续期接口帮不上',
    };
  }
  if (decision === 'not-yet') {
    const d = daysLeft(expireMs, nowMs);
    return {
      ok: true,
      skipped: true,
      note: `凭据还有 ${d ?? '?'} 天，离提前量（${leadDays} 天）还远，不打上游`,
    };
  }

  // `userDomainId` 从**手里已有的** jwttoken 里取（⚠ 它在 `payload.sub` 那个 JSON 串里，
  // 不在顶层 —— 见 `jwtUserDomainId`）。拿不到就是真的刷不了。
  const jwt = loadJwt(deps.store);
  const domain = jwt ? jwtUserDomainId(jwt.jwt) : null;
  if (!domain) {
    return {
      ok: false,
      note: '该续期，但手里没有可用的 jwttoken ⇒ 取不到 userDomainId（它的唯一本地来源）。先跑一次换票',
    };
  }

  const seg = parseAuthorization(raw)!;
  const req = refreshRequest(raw, domain, seg.platform);
  const res = callRawText(deps.transport, req);
  if (!res.ok) return { ok: false, note: `续期失败：${res.error ?? '未知失败'}` };
  const parsed = parseRefresh(res.text);
  if (!parsed.ok || !parsed.result) return { ok: false, note: parsed.error ?? '续期失败' };

  const applied = applyRefreshResult(raw, parsed.result);
  if (!applied.ok) return { ok: false, note: applied.error };
  const usable = assertUsable(applied.raw);
  if (!usable.ok) return { ok: false, note: `拒绝落库：${usable.error}` };

  deps.store.setState(STATE_AUTH, applied.raw, deps.nowIso);
  deps.store.setState(
    STATE_LAST,
    JSON.stringify({
      at: deps.nowIso,
      expireSeconds: parsed.result.expireSeconds ?? null,
      oldFingerprint: seg.token.slice(-6),
      newFingerprint: parsed.result.token.slice(-6),
    }),
    deps.nowIso,
  );
  // ⚠ 凭据换了 ⇒ 手里的票是**旧凭据换来的**，重跑一次换票（下一次触发时逐条推进）。
  startExchange(deps.store, applied.raw, deps.nowIso);

  const newExpire = tokenExpireMs(parsed.result.token);
  const d = daysLeft(newExpire, nowMs);
  return {
    ok: true,
    note:
      `凭据已续期（旧尾 ${seg.token.slice(-6)} → 新尾 ${parsed.result.token.slice(-6)}；` +
      `上游说还能用 ${parsed.result.expireSeconds ?? '?'} 秒` +
      (d === undefined ? '' : `，新过期还剩 ${d} 天`) +
      '）—— 已重起一轮换票，让票也来自新凭据',
  };
}
