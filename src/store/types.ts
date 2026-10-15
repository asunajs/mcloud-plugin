// 插件要用的持久化接口 —— **不 import host-api**。
//
// 为什么要把接口单独拿出来：Node 里没有 `host-api` 这个模块，任何 import 它的文件
// 在 Node 测试里都加载不了。所以整条纯逻辑（签名、信封、任务步骤机）都必须只依赖
// **接口**，宿主实现（SQLite）只在 main.ts 那一层注入。
//
// 这条约束的收益很直接：任务逻辑可以在 Node 里用内存实现跑全套测试，
// 而真 SQL 由「真面板 E2E」覆盖 —— 两边各测自己擅长的部分。

export type SqlParam = null | boolean | number | string;

export interface RunRecord {
  task: string;
  runs: number;
  scheduledAt: string;
  firedAt: string;
  lateMs: number;
  ok: boolean;
  note?: string | undefined;
}

export interface RunStat {
  task: string;
  /** 参与统计的样本数（只含 late_ms >= 0 的） */
  n: number;
  lateP50: number;
  lateP99: number;
  lateMax: number;
  /** 被排除的负延迟样本数（见 docs/findings.md F-001） */
  excluded: number;
}

export interface Store {
  /** 建表（幂等）。每次插件加载都会调一次。 */
  ensureSchema(): void;
  getState(key: string): string | null;
  setState(key: string, value: string, nowIso: string): void;
  recordRun(r: RunRecord): number;
  lateStats(task: string, lastN?: number): RunStat;
  recentRuns(limit?: number): Record<string, SqlParam>[];
}

/** 会话（云盘账号的凭据）。存在 state 表里，序列化成 JSON。 */
export interface Session {
  /** cookie 串（`k=v; k2=v2`）。⚠ 换过票之后**可以为空** —— 见 [`loadSession`]。 */
  cookie: string;
  /** H5 的 `jwttoken` */
  jwt?: string | undefined;
  /** 设备号（`deviceid` 头） */
  deviceId?: string | undefined;
  /** `user-agent` */
  userAgent?: string | undefined;
  /** 本地记录的取得时间（ISO）—— 用来判断要不要续期 */
  savedAt: string;
}

export const SESSION_KEY = 'mcloud.session';

// ═════════════════ 会话按账号分（F-049）═════════════════
//
// # 为什么必须分
//
// 原来会话是**一个全局槽位**。多账号下的实际行为：
//
//     账号 A 换票  →  saveSession({jwt: A 的票})
//     账号 B 换票  →  saveSession({jwt: B 的票})   ← **A 那张被覆盖**
//     账号 A 的任务 →  读会话 ⇒ 带的是 **B 的票**
//
// 也就是 A 的请求以 B 的身份发出去 —— 而 `jwttoken` 恰恰是**身份**。
//
// # 为什么症状比 F-048 难查
//
// F-048（票那一层）的表现是"B 根本不换票"—— 少一次换票，看得出来。
// 这一层的表现是"**两个账号都换了、票都对、但请求以对方的身份发出去**"，
// 而且**只在"一趟跑两个账号"时才出现** —— 单账号测不出来。
//
// # 为什么在这里解析账号，而不是让 16 个调用点各传一个
//
// 任务读会话时"现在是哪个账号"本来就是**当时的作用域**（`currentAccount`）。
// 让每个调用点自己传，就给了"某处传错/忘传"的机会，而那种错的表现是
// **静默读到别人的会话** —— 看不出来。在这里解析只有一个地方会错，
// 而且错的时候是"读到空会话"（看得出来），不是"读到别人的"。

/** 把一个状态键按**当前账号**分。
 *
 *  # 什么时候该用
 *
 *  这个键装的东西**属于某一个账号**时就用它。判据是问一句：
 *
 *  > 账号 A 写进去之后，账号 B 读到它会不会做出**错的**决定？
 *
 *  · `mcloud.session`（票）—— 会（B 以 A 的身份发请求）⇒ 要分
 *  · `mcloud.daily.done_date`（今天跑完了吗）—— 会（B 被**跳过**）⇒ 要分
 *  · `mcloud.exchange.target_hour`（几点抢兑）—— 不会（是**配置**，跟账号无关）⇒ 不分
 *
 *  # 为什么做成一个函数而不是各处自己拼
 *
 *  各拼各的就会有三种写法（`.id` / `:<id>` / `_<id>`），而**键不一致**的表现是
 *  "读不到"（看起来像没数据），不是报错 —— 很难查。一处拼，形状只有一个。
 *
 *  ⚠ 没有当前账号（单账号那套）⇒ 返回**裸键**，老数据照常读得到、不用迁移。 */
export function accountScopedKey(store: Pick<Store, 'getState'>, base: string): string {
  const cur = currentAccount(store);
  return cur === undefined ? base : `${base}.${cur.id}`;
}

/** 会话的**实际**存储键。 */
export function sessionKey(store: Pick<Store, 'getState'>): string {
  return accountScopedKey(store, SESSION_KEY);
}

export function loadSession(store: Store): Session | null {
  const raw = store.getState(sessionKey(store));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Session>;
    const cookie = typeof v.cookie === 'string' ? v.cookie : '';
    const jwt = typeof v.jwt === 'string' ? v.jwt : '';
    // ⚠️ 判据是「**有 cookie 或 有票**」，不是「必须有 cookie」。
    //
    // 改动理由：H5 那一族（`h5_headers`）走的是 `jwttoken`，**根本不发 cookie**
    // —— 所以"只有票、没有 cookie"是一份**合法且够用**的会话。
    // 而插件现在能自己换票了（见 mcloud/sessionExchange.ts）：
    // 用户只给一份原生凭据、没贴 cookie 时，换出来的票就是这么一份会话。
    // 旧判据会把它判成"未登录" —— 那不是保守，是把能用的情况说成不能用。
    //
    // 反过来仍然成立：两样都没有 ⇒ 没有会话（这一步没放松）。
    if (cookie === '' && jwt === '') return null;
    return {
      cookie,
      jwt: jwt === '' ? undefined : jwt,
      deviceId: typeof v.deviceId === 'string' ? v.deviceId : undefined,
      userAgent: typeof v.userAgent === 'string' ? v.userAgent : undefined,
      savedAt: typeof v.savedAt === 'string' ? v.savedAt : '',
    };
  } catch {
    // 存坏了就当作没有会话 —— 让上层报「未登录」，而不是拿半截数据去发请求
    return null;
  }
}

export function saveSession(store: Store, s: Session, nowIso: string): void {
  store.setState(sessionKey(store), JSON.stringify({ ...s, savedAt: nowIso }), nowIso);
}

import { currentAccount } from '../mcloud/accounts.ts';
