// 移动云盘「全网许愿赢好礼」（`National_MakeWish`）—— **领抽奖码**。
//
// # 它与 `cloudActs.ts` 的分工
//
// `cloudActs.ts` 是**只读**的（5 个 GET，一次读完拼一行）。这一份是**写**的：
// 它调 `task/auto-advance` 把「能自动推进」的任务推成完成，从而拿抽奖码。
// 两者分开是因为口径不同 —— 只读那族失败不染红，而写口失败要说清是哪一条。
//
// # 怎么找到的（2026-11-27）
//
// 1. `page/home` 里有个 `raffleCodes` 数组，每张码带 `source`
//    （`TASK_AI_LINGXI` / `TASK_DAILY_CHECKIN` / `TASK_CREATE_NOTE` …）；
// 2. `task/list` 每条任务带 **`autoAdvanceable`** 与 **`clickAdvance`** 两个布尔 ——
//    那就是上游自己标的「这条能不能替你推进」；
// 3. 把它们推成 `FINISH` 的接口是 `POST /ycloud/makewish/task/auto-advance`
//    （body 与 `task/list` 同参数：`{platform, appVersion, channel}`）。
//
// 实测（2026-11-27 00:2x，真号）：
// - `auto-advance` 回 `{"code":0,"result":{"advancedTasks":[{taskCode:"DAILY_CHECKIN",taskState:"FINISH"}]}}`
// - 抽奖码从 **8 张涨到 9 张**，来源里 `TASK_DAILY_CHECKIN` 从 2 变 3。
//
// # 两条路都做（`auto-advance` + `page/click`）
//
// 页面 JS 里 `registerTask` 的调用条件是：
// `taskState === 'WAIT' && clickAdvance === true && action !== 'popAdvanceJump'`，
// body 是 `{platform, appVersion, channel, taskId}` —— **四个键都要**。
//
// ⚠ 我第一版只发了 `{taskId}`，回 **404**（nginx 那种），于是误判成"路径不对"。
//   补上那三个参数之后 `code:0`，`CLOUD_SIGN_IN` 当场变 `FINISH`、码 +1（实测 9 → 10 张）。
//   ⇒ 这类 404 要怀疑**参数不全**，别急着说接口不存在。

import { callRawText } from '../client.ts';
import { rootOrDefault, SHOW_LOADING } from '../h5.ts';
import { BASE_MCLOUD, H5_SALT_KEY } from '../h5session.ts';
import { loadSession } from '../../store/types.ts';
import { loadJwt } from '../sessionExchange.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import type { Store } from '../../store/types.ts';

/** 「用 AI豆换许愿码」的开关：`'1'` / `'0'`。**没写过 = 关**。
 *
 *  ⚠ 缺省关的理由和代抽一样：**花的是用户自己的豆**（300 豆换 1 张码）。
 *  这种"花资源"的事必须用户显式点头，不能默认替他花。 */
export const STATE_WISH_EXCHANGE = 'mcloud.wish.exchange';

export function wishExchangeEnabled(store: Pick<Store, 'getState'>): boolean {
  return (store.getState(STATE_WISH_EXCHANGE) ?? '') === '1';
}

export function setWishExchangeEnabled(store: Store, on: boolean, nowIso: string): void {
  store.setState(STATE_WISH_EXCHANGE, on ? '1' : '0', nowIso);
}

/** 上一趟的结论（界面读它，**不在这里发请求**）。 */
export const STATE_WISH_SNAPSHOT = 'mcloud.wish.reading';

export interface WishSnapshot {
  at: string;
  ok: boolean;
  line: string;
}

export function loadWishSnapshot(store: Pick<Store, 'getState'>): WishSnapshot | null {
  const raw = store.getState(STATE_WISH_SNAPSHOT) ?? '';
  if (raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<WishSnapshot>;
    return {
      at: typeof v.at === 'string' ? v.at : '',
      ok: v.ok === true,
      line: typeof v.line === 'string' ? v.line : '',
    };
  } catch {
    return null;
  }
}

export function saveWishSnapshot(store: Store, snap: WishSnapshot, nowIso: string): void {
  store.setState(STATE_WISH_SNAPSHOT, JSON.stringify(snap), nowIso);
}

/** 活动页（`task/list` 与 `auto-advance` 都要求带它当 referer）。 */
export const WISH_REFERER =
  'https://m.mcloud.139.com/portal/hcyview/index.html?path=National_AnnualRewarding';

/** 这两个参数是 `task/list` / `auto-advance` **必须**带的 —— 少了回 404（不是 401）。
 *
 *  ⚠ `platform` 取 `android` 是照页面 JS 的默认（它按 UA 判 ios/android/harmony）；
 *  上游只看"是不是这三个值之一"，实测 `android` 与真机 iOS 的结果一致。 */
export const WISH_QUERY = { platform: 'android', appVersion: '12.6.0', channel: 'app' } as const;

interface WishSession {
  jwt: string;
  cookie: string;
  userAgent: string | undefined;
}

function session(deps: TaskDeps): WishSession | undefined {
  const sess = loadSession(deps.store);
  if (sess === null) return undefined;
  const rec = loadJwt(deps.store);
  if (rec === null || rec.jwt === '') return undefined;
  return { jwt: rec.jwt, cookie: sess.cookie, userAgent: sess.userAgent };
}

function wishUrl(path: string, base: string | undefined): string {
  // ⚠ 用 `rootOrDefault`，不要写 `base ?? BASE_MCLOUD`：CLI 传的是**空串**不是 undefined，
  //   `??` 认不出空串 ⇒ 拼出 `/ycloud/makewish/...` 这种相对 URL，
  //   到 fetch 那里报 `Failed to parse URL`（2026-11-27 真号现场）。
  return `${rootOrDefault(base, BASE_MCLOUD)}${path}`;
}

/** 上游信封（`{code, msg, result}`）。 */
interface WishEnvelope {
  code?: unknown;
  msg?: unknown;
  result?: unknown;
}

/** 任务列表里我们要的那几格（只取判据用的，别把整份 result 塞进状态）。 */
export interface WishTask {
  taskId: number;
  taskCode: string;
  taskName: string;
  taskState: string;
  /** 上游标的「这条能自动推进」。 */
  autoAdvanceable: boolean;
  /** 上游标的「点一下就行」。 */
  clickAdvance: boolean;
  /** 按钮动作词（`jump` / `popjump` / `share` / `aiCloudExchange` / `popAdvanceJump`…）。
   *
   *  ⚠ `popAdvanceJump` 那条**不能**走 `page/click`（页面 JS 里明确排除它）。 */
  buttonAction: string;
}

/** 从 `task/list` 的 result 里抽任务表。**纯函数**，好单测。 */
export function parseWishTasks(result: unknown): WishTask[] {
  if (typeof result !== 'object' || result === null) return [];
  const tasks = (result as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  const out: WishTask[] = [];
  for (const raw of tasks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as Record<string, unknown>;
    const taskId = typeof t['taskId'] === 'number' ? t['taskId'] : Number(t['taskId']);
    if (!Number.isFinite(taskId)) continue;
    out.push({
      taskId,
      taskCode: typeof t['taskCode'] === 'string' ? t['taskCode'] : '',
      taskName: typeof t['taskName'] === 'string' ? t['taskName'] : '',
      taskState: typeof t['taskState'] === 'string' ? t['taskState'] : '',
      autoAdvanceable: t['autoAdvanceable'] === true,
      clickAdvance: t['clickAdvance'] === true,
      buttonAction:
        typeof (t['button'] as Record<string, unknown> | undefined)?.['action'] === 'string'
          ? String((t['button'] as Record<string, unknown>)['action'])
          : '',
    });
  }
  return out;
}

/** `auto-advance` 的回执里"这一趟推进了哪几条"。 */
export function parseAdvanced(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const list = (result as { advancedTasks?: unknown }).advancedTasks;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as Record<string, unknown>;
    const code = typeof t['taskCode'] === 'string' ? t['taskCode'] : '';
    if (code !== '') out.push(code);
  }
  return out;
}

function wishHeaders(s: WishSession): Record<string, string> {
  return {
    Accept: '*/*',
    appversion: WISH_QUERY.appVersion,
    Referer: WISH_REFERER,
    jwttoken: s.jwt,
    showloading: SHOW_LOADING ? 'true' : 'false',
    'cache-control': 'no-cache',
    'content-type': 'application/json;charset=UTF-8',
    ...(s.userAgent !== undefined && s.userAgent !== '' ? { 'user-agent': s.userAgent } : {}),
    ...(s.cookie !== undefined && s.cookie !== '' ? { cookie: s.cookie } : {}),
  };
}

/** 读任务表（**GET**；POST 会 401）。 */
export function taskListRequest(s: WishSession, base?: string | undefined) {
  const qs = new URLSearchParams(WISH_QUERY).toString();
  return {
    url: `${wishUrl('/ycloud/makewish/task/list', base)}?${qs}`,
    method: 'GET' as const,
    headers: wishHeaders(s),
    body: undefined,
  };
}

/** 点一下「已经能点」的那条（**写**）。
 *
 *  调用条件照页面 JS：`taskState==='WAIT' && clickAdvance===true && action!=='popAdvanceJump'`。
 *  body **四个键都要**（`platform/appVersion/channel/taskId`）—— 少一个回 404。 */
export function pageClickRequest(s: WishSession, taskId: number, base?: string | undefined) {
  return {
    url: wishUrl('/ycloud/makewish/task/page/click', base),
    method: 'POST' as const,
    headers: wishHeaders(s),
    body: JSON.stringify({ ...WISH_QUERY, taskId }),
  };
}

/** 读「豆换码」的余额与剩余次数（**只读**）。 */
export function exchangeInfoRequest(s: WishSession, base?: string | undefined) {
  const qs = new URLSearchParams(WISH_QUERY).toString();
  return {
    url: `${wishUrl('/ycloud/makewish/task/cloud-exchange/info', base)}?${qs}`,
    method: 'GET' as const,
    headers: wishHeaders(s),
    body: undefined,
  };
}

/** 用 AI豆换一张许愿码（**写、花豆**）。 */
export function exchangeRequest(s: WishSession, base?: string | undefined) {
  return {
    url: wishUrl('/ycloud/makewish/task/cloud-exchange', base),
    method: 'POST' as const,
    headers: wishHeaders(s),
    body: JSON.stringify(WISH_QUERY),
  };
}

/** 「豆换码」的读数（纯函数，好单测）。 */
export interface ExchangeInfo {
  cost: number;
  remaining: number;
  balance: number;
  canExchange: boolean;
}

export function parseExchangeInfo(result: unknown): ExchangeInfo | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  const num = (k: string): number => {
    const v = r[k];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    cost: num('cost'),
    remaining: num('remaining'),
    balance: num('balance'),
    canExchange: r['canExchange'] === true,
  };
}

/** 让上游把 `autoAdvanceable` 的那几条推成完成（**写**）。 */
export function autoAdvanceRequest(s: WishSession, base?: string | undefined) {
  return {
    url: wishUrl('/ycloud/makewish/task/auto-advance', base),
    method: 'POST' as const,
    headers: wishHeaders(s),
    body: JSON.stringify(WISH_QUERY),
  };
}

/** 跑一次：读任务表 → 有可自动推进的就推一次 → 说清推进了哪几条。
 *
 *  ⚠ 只做 `autoAdvanceable` 那几条（上游自己标的）。`clickAdvance` 的**不碰**：
 *  它们要"真的先做那件事"（登录 PC 传文件、去云朵中心签到），点一下不算。
 */
export async function runWishCodes(deps: TaskDeps): Promise<TaskOutcome> {
  const out = await runWishCodesInner(deps);
  // 落一份"上次结论"给界面读（⚠ 每个出口都要落 —— 少一个界面就显示上一次的旧话）
  saveWishSnapshot(deps.store, { at: deps.nowIso, ok: out.ok, line: out.note }, deps.nowIso);
  return out;
}

async function runWishCodesInner(deps: TaskDeps): Promise<TaskOutcome> {
  const s = session(deps);
  if (s === undefined) return { ok: false, note: '还没有网页会话（票没换成）—— 许愿码这次没领' };

  const listRes = await callRawText(deps.transport, taskListRequest(s, deps.baseUrl));
  if (!listRes.ok) return { ok: false, note: `读许愿任务表没成：${listRes.error ?? '未知失败'}` };
  let listed: WishEnvelope;
  try {
    listed = JSON.parse(listRes.text) as WishEnvelope;
  } catch {
    return { ok: false, note: '读许愿任务表：响应不是 JSON' };
  }
  if (String(listed?.code ?? '') !== '0') {
    return { ok: false, note: `读许愿任务表被拒：${String(listed?.msg ?? listed?.code ?? '?')}` };
  }
  const tasks = parseWishTasks(listed?.result);
  const waiting = tasks.filter((t) => t.taskState !== 'FINISH');
  const auto = waiting.filter((t) => t.autoAdvanceable);
  // `page/click` 的条件照页面 JS：`WAIT` + `clickAdvance` + **不是** `popAdvanceJump`
  const clickable = waiting.filter((t) => t.clickAdvance && t.buttonAction !== 'popAdvanceJump');
  const got: string[] = [];
  const bad: string[] = [];

  // ① 自动推进（一次把 `autoAdvanceable` 的全推完）
  if (auto.length > 0) {
    const advRes = await callRawText(deps.transport, autoAdvanceRequest(s, deps.baseUrl));
    if (!advRes.ok) {
      bad.push(`自动推进没发出去（${advRes.error ?? '未知失败'}）`);
    } else {
      try {
        const adv = JSON.parse(advRes.text) as WishEnvelope;
        if (String(adv?.code ?? '') === '0') got.push(...parseAdvanced(adv?.result));
        else bad.push(`自动推进被拒（${String(adv?.msg ?? adv?.code ?? '?')}）`);
      } catch {
        bad.push('自动推进：响应不是 JSON');
      }
    }
  }

  // ② 逐条点「已经能点」的（每条一发；条数不多，而且它们互不影响）
  for (const t of clickable) {
    const r = await callRawText(deps.transport, pageClickRequest(s, t.taskId, deps.baseUrl));
    if (!r.ok) {
      bad.push(`${t.taskCode} 没发出去（${r.error ?? '未知失败'}）`);
      continue;
    }
    try {
      const env = JSON.parse(r.text) as WishEnvelope;
      if (String(env?.code ?? '') === '0') got.push(t.taskCode);
      else bad.push(`${t.taskCode} 被拒（${String(env?.msg ?? env?.code ?? '?')}）`);
    } catch {
      bad.push(`${t.taskCode}：响应不是 JSON`);
    }
  }

  // ③ 用 AI豆换码（**缺省关**，花的是用户的豆；开了也只换一张）
  let exchangeNote = '';
  if (wishExchangeEnabled(deps.store)) {
    const infoRes = await callRawText(deps.transport, exchangeInfoRequest(s, deps.baseUrl));
    let info: ExchangeInfo | null = null;
    if (infoRes.ok) {
      try {
        info = parseExchangeInfo((JSON.parse(infoRes.text) as WishEnvelope)?.result);
      } catch {
        info = null;
      }
    }
    if (info === null) {
      bad.push('读豆余额没成');
    } else if (!info.canExchange || info.remaining <= 0) {
      // 不能换就如实说，不算失败
      exchangeNote = `；豆换码这次换不了（剩 ${String(info.remaining)} 次 / 余额 ${String(info.balance)}）`;
    } else if (info.balance < info.cost) {
      exchangeNote = `；豆不够换码（要 ${String(info.cost)}，有 ${String(info.balance)}）`;
    } else {
      const exRes = await callRawText(deps.transport, exchangeRequest(s, deps.baseUrl));
      if (!exRes.ok) {
        bad.push(`豆换码没发出去（${exRes.error ?? '未知失败'}）`);
      } else {
        try {
          const env = JSON.parse(exRes.text) as WishEnvelope;
          if (String(env?.code ?? '') === '0') {
            got.push(`豆换码(-${String(info.cost)}豆)`);
          } else {
            bad.push(`豆换码被拒（${String(env?.msg ?? env?.code ?? '?')}）`);
          }
        } catch {
          bad.push('豆换码：响应不是 JSON');
        }
      }
    }
  }

  // ⚠ 「心愿记录不存在，请先许愿」不是失败 —— 那是**用户还没参加活动**。
  //   标成失败会让人以为插件坏了（真号现场 2026-11-27：`19****16` 没许愿，
  //   两条 page/click 都回这句，整趟被染成 `[fail]`）。
  const notJoined = bad.length > 0 && bad.every((x) => /心愿记录不存在|请先许愿/.test(x));
  if (notJoined) {
    return {
      ok: true,
      idle: true,
      note: `这个号还没参加许愿活动（先去 App 里许一次愿，之后就能自动领码）${exchangeNote}`,
    };
  }
  if (got.length === 0) {
    // ⚠ 「没有可自动的」这句要放在**兑换之后**判：豆换码是独立的一条路，
    //   前面两条都没得做时它照样能换（2026-11-27 踩过：提前 return 把兑换跳过了）。
    const why =
      bad.length > 0
        ? `；${bad.join('，')}`
        : auto.length === 0 && clickable.length === 0
          ? `（${String(tasks.length - waiting.length)}/${String(tasks.length)} 条已完成，没有能自动领的）`
          : '（可自动的都没被推进）';
    return { ok: bad.length === 0, idle: true, note: `这次没有新领到许愿码${why}${exchangeNote}` };
  }
  const tail = bad.length > 0 ? `；另有 ${String(bad.length)} 条没成（${bad.join('，')}）` : '';
  return { ok: true, note: `领到 ${String(got.length)} 张许愿码：${got.join(' / ')}${tail}${exchangeNote}` };
}
