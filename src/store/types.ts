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

export function loadSession(store: Store): Session | null {
  const raw = store.getState(SESSION_KEY);
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
  store.setState(SESSION_KEY, JSON.stringify({ ...s, savedAt: nowIso }), nowIso);
}
