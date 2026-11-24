// `infoV3` 的解析与获取 —— 三条任务（sign / receive / multiple）都要它。
//
// # 为什么它值得单独一个文件
//
// 原实现里有一条很硬的教训（`signin.rs:167-170`）：
//
//   > ⚠ 判据是 `infoV3`，不是 `startSignIn` 的响应 …… 它说没签，但紧接着 `infoV3`
//   > 已经是 `s:true` 了。**判成败一律回查 `infoV3`。**
//
// 也就是说：动作类的响应**不能作为成败依据**，得回头问一次状态。而 `multiple`
// 的门槛（每月一次翻倍机会）也在这里，`receive` 的待领清单也在这里 ——
// 三条任务都建立在同一口只读数据上。
//
// # 形状来自测试夹具（不是猜的）
//
// 来自 `crates/mcloud-tasks/src/signin/tests.rs` 的真实夹具：
//
//   result = {
//     todaySignIn: bool,                       // 今天签没签
//     cal: [{d, s, n, p, t, currentMonth}],     // 日历（s = 那天签了）
//     receiveList: [{recordId, cloudType}],     // 待领取（可能只有 cloudType）
//     curMonthBackup: bool,                     // 本月有没有翻倍机会
//     curMonthBackupSignAccept: bool,           // 本月翻倍机会用没用
//   }
//
// ⚠️ `receiveList` 的项**可能没有 `recordId`** —— 夹具注释里明确记着
// 「抓包证据：那条账号的 `receiveList` 只有 `{cloudType:2}`」。所以这里的
// `recordId` 是可选的，缺省给空串（原实现是 `unwrap_or_default()`）。
//
// ⚠️ 字段名可能是下划线写法（有些部署/中间层会转），所以两种都认。

import { resultObject } from '../envelope.ts';
import type { SignInEnvelope } from '../envelope.ts';
import { callOnce } from '../client.ts';
import { CLIENT_QUERY, EP_METHOD, REFERER_SIGN_IN, SHOW_LOADING, buildH5Request, resolveUrl } from '../h5.ts';
import { loadSession } from '../../store/types.ts';
import type { Session, Store } from '../../store/types.ts';
import type { CallResult, Transport } from '../client.ts';
import { sessionHeaders } from './base.ts';

export interface ReceiveItem {
  /** 可能有也可能没有（见文件头） */
  recordId: string;
  /** `0` = 现在可领（`receiveV3`）、`1` = 已到期延期（另一口端点）、
   *  `2` = **下月可领**（一个请求都不发）。见 `receive.ts` 的 `CLOUD_TYPE`。 */
  cloudType: number | undefined;
  raw: unknown;
}

/** 日历里「今天」那一格。 */
export interface CalToday {
  /** 日号 */
  d: number;
  /** 这天签没签 */
  s: boolean;
  /** 这天拿到的云朵（`n + p`） */
  clouds: number;
}

export interface InfoV3 {
  /** 兼容口径：日历今天那格优先，缺了才用顶层字段。 */
  todaySigned: boolean;
  /** 日历里今天那一格；读不到就是 `undefined`。 */
  calToday?: CalToday | undefined;
  /** 顶层 `todaySignIn` 原话。 */
  topLevelSigned: boolean;
  /** 待领取清单 */
  receiveList: ReceiveItem[];
  /** 本月有没有「自动备份」翻倍机会 */
  curMonthBackup: boolean;
  /** 本月翻倍机会用没用 */
  curMonthBackupSignAccept: boolean;
  /** 当前 AI豆余额。`infoV3.result.total`（真机实测字段）；读不出就是 `undefined`。 */
  total?: number | undefined;
  raw: unknown;
}

const bool = (v: unknown, dflt = false): boolean => (typeof v === 'boolean' ? v : dflt);

/** 挑出 `cal` 里今天那一格：上游用 `currentMonth` 标本月、`t` 标今天
 *  （判据照参考实现 `mcloud-sign` 的 `packages/core/src/tasks/sign/task.ts`）。 */
function calTodayOf(calRaw: unknown): CalToday | undefined {
  if (!Array.isArray(calRaw)) return undefined;
  for (const x of calRaw) {
    if (typeof x !== 'object' || x === null) continue;
    const it = x as Record<string, unknown>;
    const cur = it.currentMonth ?? it.current_month;
    const isThisMonth = cur === 1 || cur === true || cur === '1';
    const isToday = it.t === true || it.t === 1 || it.t === 'true';
    if (!isThisMonth || !isToday) continue;
    const n = Number(it.n) || 0;
    const p = Number(it.p) || 0;
    return { d: Number(it.d) || 0, s: it.s === true || it.s === 1 || it.s === 'true', clouds: n + p };
  }
  return undefined;
}

/** 解析 `infoV3` 的 `result`。 */
export function parseInfoV3(result: unknown): InfoV3 {
  const o = resultObject({ code: 0, message: '', result, ok: true });
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (o[k] !== undefined) return o[k];
    return undefined;
  };

  const listRaw = pick('receiveList', 'receive_list');
  const receiveList: ReceiveItem[] = Array.isArray(listRaw)
    ? listRaw.map((x) => {
        const it = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
        const rid = it.recordId ?? it.record_id ?? it.cloudId ?? it.cloud_id;
        const ct = it.cloudType ?? it.cloud_type;
        return {
          recordId: typeof rid === 'string' ? rid : rid === undefined || rid === null ? '' : String(rid),
          cloudType: typeof ct === 'number' ? ct : undefined,
          raw: x,
        };
      })
    : [];

  const totalRaw = pick('total', 'point', 'balance');
  const total =
    typeof totalRaw === 'number'
      ? totalRaw
      : typeof totalRaw === 'string' && /^\d+$/.test(totalRaw)
        ? Number(totalRaw)
        : undefined;

  const topLevelSigned = bool(pick('todaySignIn', 'today_sign_in'));
  const calToday = calTodayOf(pick('cal'));

  return {
    todaySigned: calToday?.s ?? topLevelSigned,
    calToday,
    topLevelSigned,
    receiveList,
    curMonthBackup: bool(pick('curMonthBackup', 'cur_month_backup')),
    curMonthBackupSignAccept: bool(pick('curMonthBackupSignAccept', 'cur_month_backup_sign_accept')),
    total,
    raw: result ?? null,
  };
}

/** 发一次 `infoV3`（GET + `?client=app`），并解析。
 *
 *  这是**唯一的取状态入口**：动作类任务都先调它，再决定要不要动手。 */
export async function fetchInfoV3(deps: {
  store: Store;
  transport: Transport;
  baseUrl?: string | undefined;
}): Promise<{ ok: true; info: InfoV3; tookMs: number } | { ok: false; error: string }> {
  const session: Session | null = loadSession(deps.store);
  if (!session) return { ok: false, error: '还没有网页会话 —— 上面「换票」那一步说了原因' };

  const req = buildH5Request({
    url: `${resolveUrl('infoV3', deps.baseUrl)}?${CLIENT_QUERY}`,
    method: EP_METHOD.infoV3 === 'GET' ? 'GET' : 'POST',
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: !!session.deviceId,
    saltKey: 1,
    session: sessionHeaders(session),
  });

  const res: CallResult = await callOnce(deps.transport, req);
  if (!res.ok) return { ok: false, error: res.error ?? '未知失败' };
  const env = res.env as SignInEnvelope;
  return { ok: true, info: parseInfoV3(env.result), tookMs: res.tookMs };
}
