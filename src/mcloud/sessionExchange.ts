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
import type { Store } from '../store/types.ts';
import { sha256Hex } from '../crypto/index.ts';
import {
  ensureFingerprint,
  parseDeviceId,
  smidUploadRequest,
} from './smid.ts';
import {
  SIGN_IN_RECIPE,
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

export function loadExchange(store: Pick<Store, 'getState'>): ExchangeState | null {
  return parse<ExchangeState>(store.getState(STATE_EXCHANGE));
}

export function loadJwt(store: Pick<Store, 'getState'>): JwtRecord | null {
  return parse<JwtRecord>(store.getState(STATE_JWT));
}

/** 票还新吗。`nowMs` 显式传入 —— 时间在这条链上是判据，不能藏在 `Date.now()` 里。 */
export function jwtFresh(store: Pick<Store, 'getState'>, nowMs: number): boolean {
  const r = loadJwt(store);
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
): { ok: boolean; error?: string; fingerprint?: string } {
  const norm = normalizeAuthorization(raw);
  if (!norm.ok || norm.value === undefined) return { ok: false, error: norm.error };

  const fingerprint = authFingerprint(sha256Hex(norm.value));
  store.setState(STATE_AUTH, norm.value, nowIso);
  store.setState(
    STATE_EXCHANGE,
    JSON.stringify({ step: 'spec-token', fingerprint, startedAt: nowIso } satisfies ExchangeState),
    nowIso,
  );
  return { ok: true, fingerprint };
}

export function clearAuth(store: Store, nowIso: string): void {
  store.setState(STATE_AUTH, '', nowIso);
  store.setState(STATE_EXCHANGE, '', nowIso);
  store.setState(STATE_JWT, '', nowIso);
}

/** 推进一步（**一次调用最多发一个请求**）。
 *
 *  返回 `done=true` 表示这一轮结束（成功或失败都算结束，好让界面的循环停下来）。 */
export function runExchangeStep(deps: TaskDeps): { ok: boolean; note: string; done: boolean } {
  const st = loadExchange(deps.store);
  const auth = deps.store.getState(STATE_AUTH);

  if (!st || st.step === 'done' || !auth) {
    return { ok: true, note: '没有待换票的任务（先去界面上贴一份原生凭据）', done: true };
  }

  const finish = (s: ExchangeState, ok: boolean, note: string): { ok: boolean; note: string; done: boolean } => {
    s.step = 'done';
    s.finishedAt = deps.nowIso;
    s.ok = ok;
    s.note = note;
    // ⚠ SSO token **不留在盘上**：它是一次性的（实测"换到 4 分钟后重放已被拒"），
    // 留着只会让"下次也许还能用"变成一个错觉
    delete s.ssoToken;
    delete (s as ExchangeState & { ts?: string }).ts;
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(s), deps.nowIso);
    return { ok, note, done: true };
  };

  // ④ 换 `deviceId`（smid 风控上报）—— 只发一枪，结果写进会话
  if (st.step === 'smid') {
    const fp = ensureFingerprint(deps.store, deps.nowIso);
    const req = smidUploadRequest(fp, deps.store.getState(STATE_DEVICE_ID) ?? '', new Date(deps.nowIso));
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
    const res = callRawText(deps.transport, specTokenRequest(SIGN_IN_RECIPE, auth, deps.baseUrl));
    if (!res.ok) return failStep(deps, st, `① 换 SSO token 失败：${res.error ?? '未知失败'}`);
    const p = parseSsoToken(res.text);
    if (!p.ok || p.value === undefined) return failStep(deps, st, `① ${p.error}`);
    st.ssoToken = p.value;
    st.referer = pageUrl(SIGN_IN_RECIPE, p.value);
    st.step = 'timestamp';
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
    return { ok: true, note: '① 换到 SSO token（**不缓存**，下一步立刻用）', done: false };
  }

  // ② 取服务端时间戳
  if (st.step === 'timestamp') {
    const res = callRawText(deps.transport, timestampRequest(SIGN_IN_RECIPE, st.referer ?? '', deps.baseUrl));
    if (!res.ok) return failStep(deps, st, `② 取时间戳失败：${res.error ?? '未知失败'}`);
    const p = parseServerTimestamp(res.text);
    if (!p.ok || p.value === undefined) return failStep(deps, st, `② ${p.error}`);
    // 存进 ssoToken 旁边的临时位：下一步的签名要用它
    st.ssoToken = st.ssoToken ?? '';
    (st as ExchangeState & { ts?: string }).ts = p.value;
    st.step = 'tyrz-login';
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
    return { ok: true, note: `② 服务端时间戳 ${p.value}（**必须用它**，本地时钟偏一点就是 401）`, done: false };
  }

  // ③ 换 jwttoken
  const ts = (st as ExchangeState & { ts?: string }).ts;
  if (ts === undefined || !st.ssoToken) {
    return finish(st, false, '③ 前置状态丢了（SSO token 或时间戳）—— SSO token 不缓存，得从头再来');
  }
  const res = callRawText(
    deps.transport,
    tyrzLoginRequest(SIGN_IN_RECIPE, st.ssoToken, makeSign(ts), st.referer ?? '', deps.baseUrl),
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
  deps.store.setState(STATE_JWT, JSON.stringify(rec), deps.nowIso);

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
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
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
  deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
  return { ok: false, note, done: true };
}

/** 一轮失败之后**隔多久才再试**。
 *
 *  为什么要有这个数：续票 cron 是每 2 分钟一跳，而"凭据本身就是错的"那种失败
 *  重试一万次也不会成功 —— 每 2 分钟往面板上写一条红，真信息就被淹了。 */
export const RETRY_AFTER_MS = 30 * 60 * 1000;

/** 该不该起一轮换票（给续票 cron 用）。**纯判据，不发请求。** */
export function needExchange(store: Pick<Store, 'getState'>, nowMs: number): boolean {
  if (!store.getState(STATE_AUTH)) return false; // 没凭据 —— 换不了，也别报错
  if (jwtFresh(store, nowMs)) return false; // 票还新
  const st = loadExchange(store);
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
