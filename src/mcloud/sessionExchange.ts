// 三步换票的**编排层**：把 `h5session.ts` 那三个纯构造器串起来，一次调用一个请求。
//
// 为什么也得是步骤机：三步 = 三个请求，而面板单次执行预算只有 2000ms。
// （界面上那个按钮是**浏览器循环调一步**，与领小红花同一条路 —— 见 liveDraw.ts 文件头。）
//
// ═══════════════════════════════════════════════════════════════════════
// 这一步解决的是插件的**根本可用性问题**
// ═══════════════════════════════════════════════════════════════════════
//
// 之前插件要一份 H5 会话，只能靠人手从浏览器抄 `cookie` + `jwttoken` 贴进来。
// 问题有两个：
//   ① 门槛高（要开 F12、要认得出哪两枚头）；
//   ② **`jwttoken` 2 小时即废** —— 手工贴的东西，睡一觉就没了，
//      而表现是所有任务一起回 `90001`，看起来像"账号被踢了"。
//
// 现在插件能自己换票：给一份**原生凭据**（`Basic base64("mobile:号:token")`，
// 也就是 mcloud 的 `auth.raw` 那个形状），它自己走三步、自己续。
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠ 凭据怎么存、怎么显示
// ═══════════════════════════════════════════════════════════════════════
//
// · 存 `state` 表的 `mcloud.h5.auth`（本机 SQLite，**不进日志、不进接口响应**）；
// · 接口只回**指纹**（sha256 前 16 hex）与长度 —— 与既有的会话处理同一套纪律。
// · ⚠ 它与会话里的 `cookie` **不是一回事**：那份是 H5 的，这份是**原生**的。
//   合成一份存，就会出现"以为清空了会话，原生凭据还留着"。


import { callRawText } from './client.ts';
import type { TaskDeps } from './tasks/base.ts';
import { loadSession, saveSession } from '../store/types.ts';
import { currentAccount, loadAccounts, setAccountDomain } from './accounts.ts';
import { scopedAccountOf } from '../store/scoped.ts';
import type { Store } from '../store/types.ts';
import { sha256Hex } from '../crypto/index.ts';
import { fromBase64, fromUtf8 } from '../crypto/bytes.ts';
import {
  ensureFingerprint,
  parseDeviceId,
  smidUploadRequest,
} from './smid.ts';
import {
  FALLBACK_RECIPE,
  SIGN_IN_RECIPE,
  recipeParams,
  type SessionRecipe,
  authFingerprint,
  makeSign,
  normalizeAuthorization,
  pageUrl,
  parseJwtToken,
  parseServerTimestamp,
  parseSsoToken,
  specTokenRequest,
  timestampRequest,
  tyrzLoginRequest,
} from './h5session.ts';

/** 原生凭据（`Authorization` 的值）。⚠ 别与 `mcloud.session` 合成一份。 */
export const STATE_AUTH = 'mcloud.h5.auth';

/** **所有任务读凭据都走这里**（多账号那一层的唯一入口）。
 *
 *  优先取账号列表里的**当前账号**；列表为空 / 没设当前 ⇒ 回落到 `STATE_AUTH` 那一格
 *  （也就是单账号那套照原样工作）。见 `accounts.ts` 模块头。
 *
 *  ⚠ 为什么要有这个间接层：全仓库有十几处 `getState(STATE_AUTH)`，直接改会造成
 *  "有的地方多账号、有的地方单账号"这种最难查的状态。收成一个函数之后，
 *  "现在是几账号"这件事只有这一个地方知道。 */
export function loadAuthRaw(store: Pick<Store, 'getState'>): string {
  // ⚠ 先用"这个 store 作用在哪个账号上"（`scoped()` 知道）——
  //   只读"全局的当前账号"的话，遍历多账号时每个号都会拿到**同一个**凭据，
  //   于是 B 的换票用的是 A 的身份（F-081 现场：给「移动」点连接，
  //   它回"没有待换票的任务"，因为拿到的其实是「测试」那串）。
  const scopedId = scopedAccountOf(store);
  if (scopedId !== undefined) {
    const one = loadAccounts(store).find((a) => a.id === scopedId);
    if (one !== undefined) return one.auth;
  }
  const cur = currentAccount(store);
  if (cur !== undefined) return cur.auth;
  // ⚠ 这一行**不许**写成 `loadAuthRaw(store)`（我的批量替换就把这里递归了：
  //   `RangeError: Maximum call stack size exceeded`，14 条测试当场红）。
  //   它是整个函数的地板：单账号那套就靠它。
  return store.getState(STATE_AUTH) ?? '';
}
/** 换票进度。 */
export const STATE_EXCHANGE = 'mcloud.h5.exchange';
/** 换到的票。 */
export const STATE_JWT = 'mcloud.h5.jwt';
/** 最近一次换到的 `deviceId`（`B…`）。留一份单独的键，好在换票之前就能拿它当 `box` 用。 */
export const STATE_DEVICE_ID = 'mcloud.smid.deviceId';

/** `jwttoken` 的有效期按 **100 分钟**算（上游 2 小时即废，留足余量）。
 *
 *  为什么要一个数：手工贴的票过期是所有任务**一起**回 `90001`，
 *  而那个现象看起来像"账号被踢了"。有个明确的"该换票了"判据，
 *  就能在它变成一片红之前自己续上。 */
export const JWT_TTL_MS = 100 * 60 * 1000;

export type ExchangeStep = 'spec-token' | 'timestamp' | 'tyrz-login' | 'smid' | 'done';

export interface ExchangeState {
  step: ExchangeStep;
  /** 这一轮换的是**哪一页**的票。
   *
   *  ⚠ 存进状态而不是靠调用方一直传：步骤是**跨多次调用**走的
   *  （面板预算 2000ms，三步要跳三次），中间任何一次调用方都可能换了一页。
   *  不带的话表现是"第一枪按 A 页打、第三枪按 B 页打"，而票是 A 的。 */
  recipe: SessionRecipe;
  /** 凭据指纹（只用于"是不是同一份凭据"，不是凭据本身） */
  fingerprint: string;
  /** ⚠ SSO token **不缓存**（实测"换到 4 分钟后重放已被拒"）——它只活在这一轮里 */
  ssoToken?: string | undefined;
  referer?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  /** 这一轮成没成（跑完才有）。给"失败了别每 2 分钟重试一次"用。 */
  ok?: boolean | undefined;
  note?: string | undefined;
}

export interface JwtRecord {
  at: string;
  jwt: string;
  referer: string;
  mobile?: string | undefined;
  fingerprint: string;
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 只读的凭据状态 —— **不含凭据本身**，界面与接口都吃这个。 */
export function authStatus(store: Pick<Store, 'getState'>): {
  present: boolean;
  fingerprint?: string | undefined;
  length?: number | undefined;
} {
  const v = store.getState(STATE_AUTH);
  if (!v) return { present: false };
  return { present: true, fingerprint: authFingerprint(sha256Hex(v)), length: v.length };
}

// ══════════════ 票与换票进度：**按账号分开存** ══════════════
//
// # 为什么必须分开
//
// 原来这两样各占**一个全局槽位**。多账号下它是错的，而且是**串票**：
//
//     账号 A 换票  → 全局票 = A 的票
//     账号 B 要跑  → `jwtFresh` 看到"票还新" ⇒ **B 根本不换**
//     账号 B 发请求 → 带的是 **A 的票**
//
// 也就是说 B 的请求会以 A 的身份发出去 —— 而 `jwttoken` 恰恰是**身份**。
//
// 参考实现是按账号建会话的（`mcloud-tasks/src/beans.rs`：
// 「会话是按账号建的（`H5Client` 按主机注入 `jwttoken`）」）。
//
// ⚠ 换票进度也必须一起分：只分票的话，账号 B 会**接着账号 A 的半截进度**走
//   （`spec-token` → … 的中间态被 B 读到），表现是 B 拿 A 的指纹去换票。
//
// 没有当前账号（单账号那套）⇒ 用原来的**裸键**，老数据照常读得到、不用迁移。

/** 票与换票进度的存储键：**按（账号 × 配方）分**。
 *
 *  # 两个维度都必要
 *
 *  · **账号**：不分的表现是**串票** —— 账号 B 的请求带账号 A 的票
 *    （`jwttoken` 恰恰是身份）。见 F-048。
 *  · **配方**：不分的表现是**用错页面的票**。参考实现的实测结论是
 *    「每个页面用自己的参数换自己的票，**票与票之间逐字节不等**」——
 *    所以拿签到页那张去打开启通知页的接口，是不是也能过**没有样本**。
 *    分开放之后，"哪一页该用哪张"就是确定的；而**兜底**（见
 *    `h5session.ts` 的 `recipeFor`）仍然让不知道配方的页面有票可用。
 *
 *  ⚠ 键的形状：`mcloud.h5.jwt.<配方>`。
 *  账号那一维**不在这里** —— 由 `store/scoped.ts` 的 `scoped()` 统一加
 *  （`store.getState` 会自动落到当前账号的袋里）。
 *  没有当前账号（单账号那套）且是兜底配方 ⇒ 用**裸键**，老数据照常读得到。 */
function scopedKey(
  base: string,
  store: Pick<Store, 'getState'>,
  recipe: SessionRecipe,
): string {
  // ⚠ 账号 id 必须取**这个 store 作用在哪个账号上**（`scoped()` 包装器知道），
  //   不能取"全局的当前账号"—— 遍历多账号时后者恒是同一个（通常是最后选中的那个），
  //   于是 B 的键里嵌着 A 的 id、值却落在 B 的袋里，键与值对不上（F-081）。
  const acct = scopedAccountOf(store) ?? currentAccount(store)?.id;
  // 兜底 + 单账号 ⇒ 裸键（不用迁移）
  if (acct === undefined && recipe === FALLBACK_RECIPE) return base;
  // ⚠ 形状与 `accountScopedKey` 保持一致（`<base>.<账号 id>`），
  //   只是这里多一段配方。两处不一致的表现是"读不到"（像没数据），不报错。
  return `${base}.${acct ?? 'default'}.${recipe}`;
}

/** 从 jwttoken 里取 `userDomainId`（**唯一一份实现**）。
 *
 *  ⚠ **真机上它不在顶层**：payload 的键只有 `iss/iat/sub/exp`，
 *  而 `userDomainId` 藏在 `sub` —— 那个键的值**本身是一段 JSON 文本**。
 *  只查顶层会得到 `undefined`，然后表现成"账号缺用户域"（看着像账号的问题）。
 *
 *  ⚠ 放在本文件而不是 `authRefresh.ts`：换票这条链也要用它（补账号上的域），
 *  而 `authRefresh` 已经 import 本文件 —— 反向 import 会成环。`authRefresh`
 *  那边只是**再导出**这个名字。 */
export function jwtUserDomainId(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  let payload: Record<string, unknown>;
  try {
    // base64url → base64（`fromBase64` 只认标准表；票里用的是 url 安全那套）
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    payload = JSON.parse(fromUtf8(fromBase64(padded))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const top = payload['userDomainId'];
  if (typeof top === 'string' && top !== '') return top;
  const sub = payload['sub'];
  if (typeof sub === 'string' && sub.trim().startsWith('{')) {
    try {
      const inner = JSON.parse(sub) as Record<string, unknown>;
      const v = inner['userDomainId'];
      if (typeof v === 'string' && v !== '') return v;
    } catch {
      /* sub 不是 JSON 就算了 */
    }
  }
  return null;
}

/** 把票里的用户域**补到当前账号**上（拿不到 / 已经有了 ⇒ 什么也不做）。
 *
 *  ⚠ 账号上那一格只有"登录那一刻"才会写。老账号（域还存全局一格那版）永远缺它，
 *  而换票**每天都会跑** —— 跑一次自愈一次（见 F-076）。 */
export function backfillDomainFromJwt(
  store: Store,
  jwt: string,
  nowIso: string,
): string | null {
  const cur = currentAccount(store);
  if (cur === undefined || (cur.userDomainId ?? '') !== '') return null;
  const dom = jwtUserDomainId(jwt);
  if (dom === null) return null;
  setAccountDomain(store, cur.id, dom, nowIso);
  return dom;
}

/** 票的键（导出是为了让"清掉某一个账号/某一页的票"这类操作能对准）。 */
export function jwtKey(
  store: Pick<Store, 'getState'>,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): string {
  return scopedKey(STATE_JWT, store, recipe);
}

/** 换票进度的键。 */
export function exchangeKey(
  store: Pick<Store, 'getState'>,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): string {
  return scopedKey(STATE_EXCHANGE, store, recipe);
}

export function loadExchange(
  store: Pick<Store, 'getState'>,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): ExchangeState | null {
  return parse<ExchangeState>(store.getState(exchangeKey(store, recipe)));
}

export function loadJwt(
  store: Pick<Store, 'getState'>,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): JwtRecord | null {
  return parse<JwtRecord>(store.getState(jwtKey(store, recipe)));
}

/** 票还新吗。`nowMs` 显式传入 —— 时间在这条链上是判据，不能藏在 `Date.now()` 里。 */
export function jwtFresh(
  store: Pick<Store, 'getState'>,
  nowMs: number,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): boolean {
  const r = loadJwt(store, recipe);
  if (!r) return false;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && nowMs - at < JWT_TTL_MS;
}

/** 收下一份原生凭据并**起一轮换票**。
 *
 *  ⚠ 只做"收下 + 起一轮"，**不发请求** —— 发请求那一步交给 [`runExchangeStep`]，
 *  这样"贴凭据"这个动作在任何调用预算下都是常数时间。 */
export function startExchange(
  store: Store,
  raw: string,
  nowIso: string,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): { ok: boolean; error?: string; fingerprint?: string } {
  const norm = normalizeAuthorization(raw);
  if (!norm.ok || norm.value === undefined) return { ok: false, error: norm.error };

  const fingerprint = authFingerprint(sha256Hex(norm.value));
  store.setState(STATE_AUTH, norm.value, nowIso);
  store.setState(exchangeKey(store, recipe), JSON.stringify({
      step: 'spec-token',
      recipe,
      fingerprint,
      startedAt: nowIso,
    } satisfies ExchangeState), nowIso);
  return { ok: true, fingerprint };
}

export function clearAuth(store: Store, nowIso: string): void {
  store.setState(STATE_AUTH, '', nowIso);
  // ⚠ 只清**当前账号**那两格 —— 全清的话会顺手把别的账号的票也删了，
  //   表现是"清了一个账号，其余账号全部要重换一遍"。
  store.setState(exchangeKey(store), '', nowIso);
  store.setState(jwtKey(store), '', nowIso);
}

/** 推进一步（**一次调用最多发一个请求**）。
 *
 *  返回 `done=true` 表示这一轮结束（成功或失败都算结束，好让界面的循环停下来）。 */
export function runExchangeStep(
  deps: TaskDeps,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): { ok: boolean; note: string; done: boolean } {
  const st = loadExchange(deps.store, recipe);
  // ⚠ 走 `loadAuthRaw`：多账号下"当前账号"才是这一轮要换票的那个
  const auth = loadAuthRaw(deps.store) || null;

  if (!st || st.step === 'done' || !auth) {
    return { ok: true, note: '今天不用换票', done: true };
  }
  // ⚠ 用**状态里记的**那一页，不是入参默认值 —— 步骤跨多次调用，
  //   调用方可能已经换了页，而这一轮的三枪必须打同一页。
  const rp = recipeParams(st.recipe ?? recipe);

  const finish = (s: ExchangeState, ok: boolean, note: string): { ok: boolean; note: string; done: boolean } => {
    s.step = 'done';
    s.finishedAt = deps.nowIso;
    s.ok = ok;
    s.note = note;
    // ⚠ SSO token **不留在盘上**：它是一次性的（实测"换到 4 分钟后重放已被拒"），
    // 留着只会让"下次也许还能用"变成一个错觉
    delete s.ssoToken;
    delete (s as ExchangeState & { ts?: string }).ts;
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(s), deps.nowIso);
    return { ok, note, done: true };
  };

  // ④ 换 `deviceId`（smid 风控上报）—— 只发一枪，结果写进会话
  if (st.step === 'smid') {
    const fp = ensureFingerprint(deps.store, deps.nowIso);
    const req = smidUploadRequest(
      fp,
      deps.store.getState(STATE_DEVICE_ID) ?? '',
      new Date(deps.nowIso),
      Math.random,
      deps.baseUrl,
    );
    const res = callRawText(deps.transport, req);
    if (!res.ok) return failStep(deps, st, `④ 换 deviceId 失败：${res.error ?? '未知失败'}`);
    const got = parseDeviceId(res.text);
    if (!got.ok || got.deviceId === undefined) return failStep(deps, st, `④ ${got.error}`);
    deps.store.setState(STATE_DEVICE_ID, got.deviceId, deps.nowIso);
    const cur = loadSession(deps.store);
    saveSession(
      deps.store,
      {
        cookie: cur?.cookie ?? '',
        jwt: cur?.jwt ?? '',
        deviceId: got.deviceId,
        userAgent: cur?.userAgent,
        savedAt: '',
      },
      deps.nowIso,
    );
    return finish(st, true, `④ 换到 deviceId（${got.deviceId.length} 字符，B 开头）—— 领取类接口现在能用了`);
  }

  // ① 换 SSO token
  if (st.step === 'spec-token') {
    const res = callRawText(deps.transport, specTokenRequest(rp, auth, deps.baseUrl));
    if (!res.ok) return failStep(deps, st, `① 换 SSO token 失败：${res.error ?? '未知失败'}`);
    const p = parseSsoToken(res.text);
    if (!p.ok || p.value === undefined) return failStep(deps, st, `① ${p.error}`);
    st.ssoToken = p.value;
    st.referer = pageUrl(rp, p.value);
    st.step = 'timestamp';
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
    return { ok: true, note: '① 换到 SSO token（**不缓存**，下一步立刻用）', done: false };
  }

  // ② 取服务端时间戳
  if (st.step === 'timestamp') {
    const res = callRawText(deps.transport, timestampRequest(rp, st.referer ?? '', deps.baseUrl));
    if (!res.ok) return failStep(deps, st, `② 取时间戳失败：${res.error ?? '未知失败'}`);
    const p = parseServerTimestamp(res.text);
    if (!p.ok || p.value === undefined) return failStep(deps, st, `② ${p.error}`);
    // 存进 ssoToken 旁边的临时位：下一步的签名要用它
    st.ssoToken = st.ssoToken ?? '';
    (st as ExchangeState & { ts?: string }).ts = p.value;
    st.step = 'tyrz-login';
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
    return { ok: true, note: `② 服务端时间戳 ${p.value}（**必须用它**，本地时钟偏一点就是 401）`, done: false };
  }

  // ③ 换 jwttoken
  const ts = (st as ExchangeState & { ts?: string }).ts;
  if (ts === undefined || !st.ssoToken) {
    return finish(st, false, '③ 前置状态丢了（SSO token 或时间戳）—— SSO token 不缓存，得从头再来');
  }
  const res = callRawText(
    deps.transport,
    tyrzLoginRequest(rp, st.ssoToken, makeSign(ts), st.referer ?? '', deps.baseUrl),
  );
  if (!res.ok) return failStep(deps, st, `③ 换 jwttoken 失败：${res.error ?? '未知失败'}`);
  const p = parseJwtToken(res.text);
  if (!p.ok || p.value === undefined) return failStep(deps, st, `③ ${p.error}`);

  const rec: JwtRecord = {
    at: deps.nowIso,
    jwt: p.value.jwt,
    referer: st.referer ?? '',
    mobile: p.value.mobile,
    fingerprint: st.fingerprint,
  };
  deps.store.setState(jwtKey(deps.store, recipe), JSON.stringify(rec), deps.nowIso);

  // ⚠ 顺手把用户域**补到当前账号上**（拿不到就什么也不做）。
  //
  //   票的 `payload.sub` 里带着它，而账号上那一格只有"登录那一刻"才会写。
  //   于是老账号（登录域还是全局一格那版）永远缺这一格 —— 而换票**每天都会跑**，
  //   跑一次就自愈一次。不写的话，`x-yun-uni` 那类业务请求永远缺一格，
  //   且缺得毫无线索（见 F-076）。
  backfillDomainFromJwt(deps.store, p.value.jwt, deps.nowIso);

  // ⚠⚠ 拿到票之后**再走一步**：把 `deviceId` 也换回来。
  //
  // 为什么必须在这一条链里：领取类接口（`receiveV3`）不带 `deviceId` 回 `615`、
  // 带错回 `614`，而这两句的文案都是「活动太火爆啦」—— 看起来像限流，
  // 其实是参数（findings F-018）。换票换到的只是一张**浏览器会话**，
  // 而 `deviceId` 是另一条链（smid 风控上报）发的。
  //
  // ⚠ 已经有 deviceId 的会话**跳过这一步**（手工贴过的人不该被多打一枪）。
  const sess = loadSession(deps.store);
  const needDevice = (sess?.deviceId ?? '') === '';
  if (needDevice) {
    saveSession(
      deps.store,
      {
        cookie: sess?.cookie ?? '',
        jwt: p.value.jwt,
        deviceId: sess?.deviceId,
        userAgent: sess?.userAgent,
        savedAt: '',
      },
      deps.nowIso,
    );
    st.step = 'smid';
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
    return {
      ok: true,
      note:
        `③ 换到 jwttoken（${p.value.jwt.length} 字符）—— 再走一步换 \`deviceId\`（领取类接口要它）`,
      done: false,
    };
  }

  // 写进**会话** —— 这是任务读票的唯一入口（`loadSession`）。
  //
  // ⚠ 没有会话时**要新建一个**，不能只写 STAT_JWT 那格。
  // 这一条差点漏掉：原先只在"已有会话"时合并，于是"只贴了原生凭据、没贴 cookie"
  // 的人换票成功、却依然被判未登录 —— 而这**正是这个功能的目标场景**
  // （不用手抄 cookie/jwt，只给一份原生凭据）。
  // `cookie` 留空是合法的：H5 那一族本来就不发 cookie（见 store/types.ts 的 loadSession）。
  saveSession(
    deps.store,
    {
      cookie: sess?.cookie ?? '',
      jwt: p.value.jwt,
      deviceId: sess?.deviceId,
      userAgent: sess?.userAgent,
      savedAt: '',
    },
    deps.nowIso,
  );

  return finish(
    st,
    true,
    `③ 换到 jwttoken（${p.value.jwt.length} 字符${p.value.mobile ? `，回显 ${maskMobile(p.value.mobile)}` : ''}）` +
      `—— 约 ${Math.round(JWT_TTL_MS / 60000)} 分钟后该续` +
      // ⚠ 主动说出"缺 deviceId"：不说的话，用户第一次用 `receive` 会看到
      // 「活动太火爆啦」，然后以为过会儿就好 —— 而它其实永远不会好（是参数问题）。
      (((sess?.deviceId ?? '') === '' && (loadSession(deps.store)?.deviceId ?? '') === '')
        ? '。⚠ 这份会话**没有 `deviceId`**：领取类接口（receive）会回 615，' +
          '而它的文案是「活动太火爆啦」—— 那不是在限流，是缺参数。' +
          '要修：在会话 JSON 里带上 `deviceId`（H5 那一份是 `B` + 88 字符 base64）'
        : ''),
  );
}

/** 失败：把这一步的原因写进状态并**结束这一轮**。
 *
 *  ⚠ 为什么失败也 `done`：不结束的话界面的循环会一直转；
 *  而"要不要重试"是人的决定（贴的凭据可能本来就是错的）。 */
function failStep(
  deps: TaskDeps,
  st: ExchangeState,
  note: string,
): { ok: boolean; note: string; done: boolean } {
  st.step = 'done';
  st.finishedAt = deps.nowIso;
  st.ok = false;
  st.note = note;
  delete st.ssoToken;
  delete (st as ExchangeState & { ts?: string }).ts;
  // 用**状态里记的**那一页 —— 这个辅助函数没有 recipe 参数，
  // 而这一轮是哪一页本来就是状态的属性
  deps.store.setState(exchangeKey(deps.store, st.recipe ?? FALLBACK_RECIPE), JSON.stringify(st), deps.nowIso);
  return { ok: false, note, done: true };
}

/** 一轮失败之后**隔多久才再试**。
 *
 *  为什么要有这个数：续票 cron 是每 2 分钟一跳，而"凭据本身就是错的"那种失败
 *  重试一万次也不会成功 —— 每 2 分钟往面板上写一条红，真信息就被淹了。 */
export const RETRY_AFTER_MS = 30 * 60 * 1000;

/** 该不该起一轮换票（给续票 cron 用）。**纯判据，不发请求。** */
export function needExchange(
  store: Pick<Store, 'getState'>,
  nowMs: number,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): boolean {
  if (loadAuthRaw(store) === '') return false; // 没凭据 —— 换不了，也别报错（多账号下也照这条）
  if (jwtFresh(store, nowMs, recipe)) return false; // **这一页**的票还新
  const st = loadExchange(store, recipe);
  if (!st) return true; // 从来没换过
  if (st.step !== 'done') return true; // 中途断了 ⇒ 接着走
  if (st.ok === true) return true; // 上一轮成了、票却不新鲜（过期/时钟跳）⇒ 该续
  // 上一轮失败了：隔 RETRY_AFTER_MS 再试
  const at = Date.parse(st.finishedAt ?? st.startedAt);
  return !Number.isFinite(at) || nowMs - at > RETRY_AFTER_MS;
}

/** 回显只留前 3 后 4 —— 它不是凭据，但也没必要整串进界面与日志。
 *
 *  ⚠⚠ 名字里的 `mobile` 是**上游字段名**（`result.mobile`），不代表它一定是手机号。
 *  2026-10-14 真机实测：换出来的那个值是 `bpH…7ws=` 这个形状（24 字符、base64 味），
 *  **不是号码**。所以界面上的文案写的是"回显"，不是"手机号"——
 *  写"手机号"会让人拿它去核对账号，然后发现对不上。
 *  字段里到底装什么**没有样本**（只见过这一种值），所以这里只做"截断展示"，
 *  不对它的语义做任何假设。 */
export function maskMobile(m: string): string {
  return m.length >= 7 ? `${m.slice(0, 3)}****${m.slice(-4)}` : '***';
}
