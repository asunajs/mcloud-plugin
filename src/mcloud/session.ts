// 会话：云盘账号凭据的存取、校验、脱敏。
//
// 为什么先做这一层而不是先做整套登录（扫码 / 短信 / 密码 / 设备号轮换）：
// 那一套是大工程（mcloud 里对应 `mcloud-app` 的一大块），而**只要有一份能用的会话**，
// 签到族 8 条任务就都能跑。所以这里先给一条最短路径：
// 使用者从浏览器里把会话导出来（见 docs/howto-session.md），塞进来，
// 插件负责存、验、脱敏显示、过期提醒。整套登录流程排在后面。
//
// ⚠️ 安全纪律：cookie / jwttoken 是**账号凭据**，等价于密码。
//   - 一律不进日志（本模块提供 `redact`，只出长度和前缀）
//   - 一律不回显给接口调用方
//   - 只在 state 表里存，键名固定 `mcloud.session`
// 这三条都有测试钉着（test/session.test.ts 的「不回显 / 不进日志」那两条）。


import { SESSION_KEY, loadSession, saveSession } from '../store/types.ts';
import type { Session, Store } from '../store/types.ts';
import { fromBase64, fromUtf8 } from '../crypto/index.ts';
import { callOnce } from './client.ts';
import type { Transport } from './client.ts';
import { CLIENT_QUERY, EP_METHOD, REFERER_SIGN_IN, SHOW_LOADING, buildH5Request, resolveUrl } from './h5.ts';
import { sessionHeaders } from './tasks/base.ts';

export interface ParseOk {
  ok: true;
  session: Session;
}
export interface ParseErr {
  ok: false;
  reason: string;
}
export type ParseResult = ParseOk | ParseErr;

/** 解析使用者贴进来的会话。
 *
 *  三种形状都收（人给的输入不会整整齐齐）：
 *    ① 纯 cookie 串：`k=v; k2=v2`
 *    ② JSON 对象：`{"cookie":"…","jwt":"…","deviceId":"…","userAgent":"…"}`
 *    ③ 上面两种被包一层：`{"session": …}`（方便脚本传）
 */
export function parseSessionInput(raw: string, nowIso: string): ParseResult {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: '内容是空的' };

  // ① 纯 cookie 串
  if (!text.startsWith('{')) {
    if (!text.includes('=')) return { ok: false, reason: '既不是 JSON，也不像 cookie 串' };
    return { ok: true, session: { cookie: normalizeCookie(text), savedAt: nowIso } };
  }

  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, reason: 'JSON 顶层要是对象' };
  }

  const o = v as Record<string, unknown>;
  // ③ 包一层
  const inner =
    typeof o.session === 'string'
      ? (() => {
          try {
            return JSON.parse(o.session) as unknown;
          } catch {
            return o.session;
          }
        })()
      : (o.session ?? o);
  if (typeof inner === 'string') return parseSessionInput(inner, nowIso);
  if (typeof inner !== 'object' || inner === null) {
    return { ok: false, reason: 'session 字段既不是对象也不是字符串' };
  }

  const s = inner as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const x = s[k];
    if (typeof x !== 'string' || x.trim() === '') return undefined;
    return x.trim();
  };

  // cookie 可能被拆成数组（浏览器 devtools 里复制出来常见这种形状）
  let cookie = pick('cookie') ?? pick('cookies') ?? '';
  if (!cookie && Array.isArray(s.cookies)) {
    cookie = s.cookies
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim())
      .filter((c) => c.includes('='))
      .join('; ');
  }
  if (!cookie && Array.isArray(s.cookie)) {
    cookie = s.cookie.filter((c): c is string => typeof c === 'string').join('; ');
  }
  if (!cookie) {
    return { ok: false, reason: '没有 cookie —— 云盘账号的凭据就在 cookie 和 jwt 里，这两样至少要有 cookie' };
  }

  return {
    ok: true,
    session: {
      cookie: normalizeCookie(cookie),
      jwt: pick('jwt') ?? pick('jwttoken') ?? pick('JWT_TOKEN'),
      deviceId: pick('deviceId') ?? pick('deviceid'),
      userAgent: pick('userAgent') ?? pick('user-agent'),
      savedAt: nowIso,
    },
  };
}

/** cookie 串归一化：去掉多余空白、丢掉属性段（`Path=/` 那些不该带进请求头）。 */
export function normalizeCookie(raw: string): string {
  const parts: string[] = [];
  for (const seg of raw.split(';')) {
    const p = seg.trim();
    if (!p || !p.includes('=')) continue;
    const name = p.slice(0, p.indexOf('=')).trim();
    // 常见属性名不该出现在 cookie 头里
    if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) continue;
    parts.push(p);
  }
  return parts.join('; ');
}

/** 脱敏显示：只说「有没有、多长、前 4 位」。**永远不要原样返回凭据**。 */
export function redact(secret: string | undefined): string {
  if (!secret) return '（无）';
  if (secret.length <= 8) return `（${secret.length} 字符，太短不显示）`;
  return `${secret.slice(0, 4)}…（共 ${secret.length} 字符）`;
}

export interface SessionStatus {
  present: boolean;
  savedAt: string;
  ageHours: number | null;
  /** 脱敏后的凭据摘要，可以安全地回显给接口调用方 */
  cookie: string;
  jwt: string;
  deviceId: string;
  userAgent: string;
  lastCheck: string;
  lastCheckOk: boolean | null;
  lastCheckNote: string;
  /** 手机端凭据的到期时刻（JWT 的 `exp`）。`null` = 解不出来（不是"不会过期"）。 */
  jwtExpiry: { atIso: string; expired: boolean } | null;
}

export const STATE_LAST_CHECK = 'mcloud.session.last_check';

/** 手机端凭据（JWT）**会不会过期**。
 *
 *  为什么值得单独算：JWT 的 `exp` 就在 payload 里，解一下就知道 —— 而"过期了"
 *  与"被上游踢了"对用户是两件事（前者重新导入就行，后者要看别的）。
 *  没有它的时候，凭据过期在任务里只表现为一串「未登录」，等于什么都没说。
 *
 *  ⚠ 只解 payload，**不验签**（我们不是签发方；这里只想知道时间）。
 *  解不出来就回 `null` —— 猜一个时间比不猜更糟。 */
/** 从一串 JWT 直接算到期（给"按账号逐个看"的地方用 —— 那时手里只有那一格的串）。 */
export function jwtExpiryOf(raw: string, nowIso: string): { atIso: string; expired: boolean } | null {
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  let payload: string;
  try {
    // base64url → base64，再解成 UTF-8 字符串（`fromBase64` 是仓库里那份，不依赖 atob）
    payload = fromUtf8(fromBase64(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  let exp: unknown;
  try {
    exp = (JSON.parse(payload) as { exp?: unknown }).exp;
  } catch {
    return null;
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  const atMs = exp * 1000;
  const now = Date.parse(nowIso);
  return {
    atIso: new Date(atMs).toISOString(),
    // `now` 坏了就当没过期（宁可不吓人）
    expired: Number.isNaN(now) ? false : now >= atMs,
  };
}

/** 当前账号（作用域内那格）的凭据到期。 */
export function jwtExpiry(store: Store, nowIso: string): { atIso: string; expired: boolean } | null {
  return jwtExpiryOf(loadSession(store)?.jwt ?? '', nowIso);
}

export function sessionStatus(store: Store, nowIso: string): SessionStatus {
  const s = loadSession(store);
  const checkRaw = store.getState(STATE_LAST_CHECK);
  let lastCheck = '';
  let lastCheckOk: boolean | null = null;
  let lastCheckNote = '';
  if (checkRaw) {
    try {
      const c = JSON.parse(checkRaw) as { at?: string; ok?: boolean; note?: string };
      lastCheck = c.at ?? '';
      lastCheckOk = typeof c.ok === 'boolean' ? c.ok : null;
      lastCheckNote = c.note ?? '';
    } catch {
      lastCheckNote = '（检查记录坏了）';
    }
  }

  let ageHours: number | null = null;
  if (s?.savedAt) {
    const t = Date.parse(s.savedAt);
    const n = Date.parse(nowIso);
    if (!Number.isNaN(t) && !Number.isNaN(n)) {
      ageHours = Math.round(((n - t) / 3600000) * 10) / 10;
    }
  }

  return {
    present: !!s,
    savedAt: s?.savedAt ?? '',
    ageHours,
    cookie: redact(s?.cookie),
    jwt: redact(s?.jwt),
    deviceId: s?.deviceId ?? '',
    userAgent: s?.userAgent ?? '',
    lastCheck,
    lastCheckOk,
    lastCheckNote,
    jwtExpiry: jwtExpiry(store, nowIso),
  };
}

/** 真验一次：发一个最便宜的只读请求。
 *
 *  为什么用「真发一次」而不是看 cookie 的过期字段：我们拿到的 cookie 串是**手工粘贴**的，
 *  属性段（`Expires`）在归一化时已经被丢掉了 —— 也就是说本地无从判断它是否过期。
 *  「上游还认不认」是唯一可靠、也唯一有意义的判据。 */
export function verifySession(deps: {
  store: Store;
  transport: Transport;
  nowIso: string;
  baseUrl?: string | undefined;
}): { ok: boolean; note: string } {
  const s = loadSession(deps.store);
  if (!s) {
    const note = '没有会话';
    deps.store.setState(STATE_LAST_CHECK, JSON.stringify({ at: deps.nowIso, ok: false, note }), deps.nowIso);
    return { ok: false, note };
  }

  // `infoV3` 是 **GET** + `?client=app`（差点写成 POST —— 真面板回了我一个 405，
  // 见 h5.ts 的 EP_METHOD 表）
  const req = buildH5Request({
    url: `${resolveUrl('infoV3', deps.baseUrl)}?${CLIENT_QUERY}`,
    method: EP_METHOD.infoV3 === 'GET' ? 'GET' : 'POST',
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: !!s.deviceId,
    saltKey: 1,
    session: sessionHeaders(s),
  });

  const res = callOnce(deps.transport, req);
  const ok = res.ok;
  const note = ok
    ? `会话有效（${res.tookMs}ms）`
    : `会话可能已失效：${res.error ?? '未知失败'}`;

  deps.store.setState(STATE_LAST_CHECK, JSON.stringify({ at: deps.nowIso, ok, note }), deps.nowIso);
  return { ok, note };
}

/** 存一份新会话（导入时用）。 */
export function importSession(store: Store, s: Session, nowIso: string): void {
  saveSession(store, s, nowIso);
  // 换了凭据就把上一次的检查结果作废 —— 否则状态会显示「上次检查通过」，
  // 而那说的是**旧**凭据
  store.setState(STATE_LAST_CHECK, JSON.stringify({ at: nowIso, ok: null, note: '刚导入，还没验' }), nowIso);
}

export { SESSION_KEY };

/** 上游基址可配置 —— 默认空（= 用 h5.ts 里写死的真地址）。
 *
 *  为什么需要它：`http_fetch` 能把请求发到任何地方，但插件的端点常量是写死的。
 *  「指向 mock」这件事在 CI 里是必须的：CI **绝不能碰真账号**，可又要验证整条链
 *  （会话 → 构造 → 签名 → 发送 → 解析 → 落盘）真的能跑通。
 *
 *  为什么走 state 而不是环境变量：插件沙箱里没有 `process.env`（这是设计，
 *  不是缺陷）—— 插件拿不到宿主环境。所以配置从 state 表读，由接口写。 */
export const STATE_BASE_URL = 'mcloud.base_url';

export function loadBaseUrl(store: Store): string {
  const v = store.getState(STATE_BASE_URL);
  if (!v) return '';
  const t = v.trim();
  // 只接受 http(s):// 开头，且去掉结尾斜杠 —— 免得拼出 `…//ycloud/…` 这种地址
  if (!/^https?:\/\//.test(t)) return '';
  return t.replace(/\/+$/, '');
}
