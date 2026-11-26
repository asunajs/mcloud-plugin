// **用户设置 ↔ 唯一配置文件**的映射表（唯一事实来源）。
//
// # 这里放什么、不放什么
//
// 放：**用户能改**的东西 —— 面板表单 / 插件设置页 / CLI 能配的。
// 不放：账号凭据（`mcloud.accounts`）、session、进度、运行记录、日志、口令池、
//       追踪环 —— 那些是**运行时状态**，继续留在 `shared.json` / 账号袋里
//       （边界见 docs/architecture.md §3）。
//
// # 为什么用「state 键 ↔ 点路径」两张皮
//
// 调用点（路由 / 任务 / 测试）说的是 state 键（`mcloud.daily.budget_s`），
// 而配置文件里给人看的是 `daily_budget_s`。中间这层映射让
//   · 业务代码**一行都不用改**（照旧 getState/setState），
//   · 配置文件**对人友好**（面板表单的字段名就是它）。
//
// # 值的编码
//
// state 里存的是**字符串**，配置文件里是 JSON 值。`kind` 决定怎么编：
//   text   —— 原样
//   number —— 数字（读时夹在 [min,max]）
//   bool   —— `true`/`false`（state 的 `'1'`/`'0'`）
//   json   —— 对象/数组
// ⚠ `''`（空串 = 老库没设过）**不写进文件**，读时也没有 ⇒ 语义与今天一致
//   （比如 `exchange_enabled` 的空串含义是「有定时目标就算开」，写成 `false` 就关不掉了）。

export type ConfigKind = 'text' | 'number' | 'bool' | 'json';

export interface ConfigBinding {
  /** state 键（调用点看到的） */
  key: string;
  /** 配置文件里的点路径；账号级用 `{acct}` 占位 */
  path: string;
  kind: ConfigKind;
  /** `kind: 'number'` 的夹取范围 */
  min?: number;
  max?: number;
  /** 写进新文件时的默认值（迁移用）。缺省 = 不写这一格 */
  seed?: unknown;
}

/** 配置文件的版本。**只在「加了新的绑定 / 改了编码」时才 +1** ——
 *  升级时会跑一次「只补空缺」的合并（已有值一律不动），见 `configMigrate.ts`。 */
export const SCHEMA_VERSION = 3;
/** 配置文件的根键：版本号。**它存在 = 已迁移过**（幂等判据）。 */
export const SCHEMA_KEY = 'schema_version';

export const CONFIG_BINDINGS: readonly ConfigBinding[] = [
  // ── 面板表单那两格（manifest 的 config.fields 就是这两个名字）──────
  { key: 'mcloud.daily.budget_s', path: 'daily_budget_s', kind: 'number', min: 60, max: 600, seed: 600 },
  { key: 'mcloud.exchange.schedule.enabled', path: 'exchange_enabled', kind: 'bool', seed: true },
  // ── 兑换 ──────────────────────────────────────────────────────
  { key: 'mcloud.exchange.plans', path: 'exchange.plans', kind: 'json' },
  { key: 'mcloud.exchange.target_hour', path: 'exchange.target_hour', kind: 'text' },

  { key: 'mcloud.exchange.order.lead_ms', path: 'exchange.lead_ms', kind: 'number', min: 0, max: 600_000 },
  // ── 日常子任务开关的**公共默认**（`mcloud/tasks/taskSwitches.ts`）──
  // 账号级那一格在账号袋里（`mcloud.task.<id>.on`），这里只放"所有号共用的缺省"。
  // ⚠ **不给 seed**：缺席就是缺省值，不往用户的文件里塞六行噪音，也不用升 schema。
  { key: 'mcloud.task.signin.common', path: 'task_signin', kind: 'bool' },
  { key: 'mcloud.task.expansion.common', path: 'task_expansion', kind: 'bool' },
  { key: 'mcloud.task.appTask.common', path: 'task_app_task', kind: 'bool' },
  { key: 'mcloud.task.redpack.common', path: 'task_redpack', kind: 'bool' },
  { key: 'mcloud.task.tokenpk.common', path: 'task_tokenpk', kind: 'bool' },
  { key: 'mcloud.task.playAI.common', path: 'task_play_ai', kind: 'bool' },

  // ── 直播 ──────────────────────────────────────────────────────
  { key: 'mcloud.live.listen_seconds.task', path: 'live.listen_seconds', kind: 'number', min: 5, max: 1800, seed: 600 },

  // ── 推送 ──────────────────────────────────────────────────────
  { key: 'mcloud.push.config', path: 'push.config', kind: 'json' },
  { key: 'mcloud.push.rules', path: 'push.rules', kind: 'json' },
  { key: 'mcloud.push.bindings', path: 'push.bindings', kind: 'json' },
  // ── 高级 / 登录偏好（设置页里的那几格）─────────────────────────
  { key: 'mcloud.base_url', path: 'base_url', kind: 'text' },
  { key: 'mcloud.login.pref', path: 'login.pref', kind: 'text' },
  { key: 'mcloud.login.base', path: 'login.base', kind: 'text' },
  // ── CLI 宿主旋钮（面板不展示；`config:import` 会把旧 asign.json 的 standalone.* 搬进来）
  { key: 'cli.http.timeout_ms', path: 'cli.http.timeout_ms', kind: 'number', min: 1000, max: 120_000 },
  { key: 'cli.http.insecure', path: 'cli.http.insecure', kind: 'bool' },
  { key: 'cli.http.follow_redirects', path: 'cli.http.follow_redirects', kind: 'bool' },
  { key: 'cli.http.proxy', path: 'cli.http.proxy', kind: 'text' },
  { key: 'cli.ws.timeout_ms', path: 'cli.ws.timeout_ms', kind: 'number', min: 1000, max: 120_000 },
  { key: 'cli.ws.insecure', path: 'cli.ws.insecure', kind: 'bool' },
  // ── 按账号的设置（进 `accounts.<id>.*`，与「账号袋」无关）────────
  { key: 'mcloud.live.listen_seconds', path: 'accounts.{acct}.listen_seconds', kind: 'number', min: 10, max: 3600 },
  { key: 'mcloud.live.listen_room', path: 'accounts.{acct}.listen_room', kind: 'text' },
  { key: 'mcloud.live.ws_heartbeat_reply', path: 'accounts.{acct}.ws_heartbeat_reply', kind: 'text' },
  { key: 'mcloud.live.gate_base', path: 'accounts.{acct}.live.gate_base', kind: 'text' },
  { key: 'mcloud.live.ws_base', path: 'accounts.{acct}.live.ws_base', kind: 'text' },
  { key: 'mcloud.live.im_base', path: 'accounts.{acct}.live.im_base', kind: 'text' },
  { key: 'mcloud.live.url', path: 'accounts.{acct}.live.url', kind: 'text' },
];

/** **退役的绑定**：曾经进过配置文件，但按「配置 = 用户手设 / 可手设的」这条判据不该在里面。
 *
 *  这些值是**老单计划模型的兼容面**（只有 `action:'plan'` 那个老客户端入口会写）和**死开关**
 *  （`claim_enabled` 连写入口都没有）。它们回到 state；`configMigrate` 在升版时把已经写进
 *  文件的那些值**搬回** state，然后从文件里删掉 —— 值不丢，只是回到它该待的地方。 */
export const RETIRED_BINDINGS: readonly ConfigBinding[] = [
  { key: 'mcloud.exchange.schedule.plan', path: 'exchange.schedule.plan', kind: 'text' },
  { key: 'mcloud.exchange.schedule.plan_name', path: 'exchange.schedule.plan_name', kind: 'text' },
  { key: 'mcloud.exchange.schedule.cron', path: 'exchange.schedule.cron', kind: 'text' },
  { key: 'mcloud.exchange.schedule.until', path: 'exchange.schedule.until', kind: 'text' },
  { key: 'mcloud.exchange.schedule.once_date', path: 'exchange.schedule.once_date', kind: 'text' },
  { key: 'mcloud.exchange.schedule.mode', path: 'exchange.schedule.mode', kind: 'text' },
  { key: 'mcloud.exchange.schedule.max_runs', path: 'exchange.schedule.max_runs', kind: 'number', min: 0, max: 999 },
  { key: 'mcloud.exchange.lead_sec', path: 'exchange.lead_sec', kind: 'number', min: 0, max: 600 },
  { key: 'mcloud.live.claim_enabled', path: 'live.claim_enabled', kind: 'bool' },
];

/** key → 绑定。`scopeOf` 先查它 ⇒ 这些键**不会**在 `KEY_SCOPE` 里重复登记。 */
export const CONFIG_BINDING_BY_KEY: ReadonlyMap<string, ConfigBinding> = new Map(
  CONFIG_BINDINGS.map((b) => [b.key, b]),
);

/** 裸 store 上写「配置键」要报错（`memory.ts` / `fileStore.ts` 的 setState 都调它）。
 *
 *  # 为什么是**抛错**而不是静默重定向
 *
 *  配置键的唯一入口是 `scoped()` → `routeSet` → `userConfig`。裸 store 上没有路由，
 *  写下去就是 `shared.json` 里多一份副本 —— 正是这次重构要消灭的形状。
 *  抛在写入点，比「以后某个读数对不上」好查得多。
 *
 *  ⚠ 迁移（`host/fs/configMigrate.ts`）删旧键走的是 `store.update(…, () => null)`，
 *  那是宿主自己的整段读改写，不经这里。 */
export function assertNotConfigKey(key: string): void {
  if (CONFIG_BINDING_BY_KEY.has(key)) {
    throw new Error(
      '用户配置键 ' + key + ' 不能直接写 store：它属于 config.json，请经 scoped() 的 '
      + 'getState/setState（见 store/userConfigKeys.ts）',
    );
  }
}

/** 这条绑定是不是按账号的（路径里有 `{acct}`）。 */
export function isAccountBinding(b: ConfigBinding): boolean {
  return b.path.includes('{acct}');
}

/** 绑定的实际点路径。账号级的绑定的 `acctId` 必须给（调用方保证）。 */
export function bindingPath(b: ConfigBinding, acctId?: string): string {
  if (!isAccountBinding(b)) return b.path;
  return b.path.replace('{acct}', String(acctId ?? ''));
}

/** state 字符串 → 配置里的 JSON 值。`undefined` = 这格不该写进文件（删）。 */
export function encodeValue(b: ConfigBinding, text: string | null): unknown {
  if (text === null || text === '') return undefined;
  switch (b.kind) {
    case 'bool': {
      const t = text.trim().toLowerCase();
      if (t === '1' || t === 'true' || t === 'on' || t === 'yes') return true;
      if (t === '0' || t === 'false' || t === 'off' || t === 'no') return false;
      return undefined;
    }
    case 'number': {
      const n = Number(text.trim());
      if (!Number.isFinite(n)) return undefined;
      return clampNum(n, b);
    }
    case 'json': {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }
    default:
      return text;
  }
}

/** 配置里的 JSON 值 → state 字符串（调用点看到的那份）。`null` = 没有/认不出。 */
export function decodeValue(b: ConfigBinding, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  switch (b.kind) {
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 ? '1' : '0';
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return null;
      return String(clampNum(n, b));
    }
    case 'json':
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

function clampNum(n: number, b: ConfigBinding): number {
  const r = Math.round(n);
  const lo = b.min ?? Number.NEGATIVE_INFINITY;
  const hi = b.max ?? Number.POSITIVE_INFINITY;
  return Math.min(hi, Math.max(lo, r));
}

// ══════════════════════════ 点路径读写（纯函数）══════════════════════════

export type ConfigDoc = Record<string, unknown>;

export function isPlainObject(v: unknown): v is ConfigDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 读点路径。中间任何一层不是对象 ⇒ `undefined`（不抛）。 */
export function getPath(doc: ConfigDoc, path: string): unknown {
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 写点路径（就地改）。`value === undefined` ⇒ 删掉这一格，并顺手清空的中间对象。
 *
 *  ⚠ 空对象要清掉：`accounts.<id>` 在最后一个字段被删之后不该留一个 `{}` ——
 *  它会让「这个账号还有设置吗」出现第三种答案。 */
export function setPath(doc: ConfigDoc, path: string, value: unknown): void {
  const segs = path.split('.');
  const stack: ConfigDoc[] = [doc];
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i]!;
    let next = doc;
    let cur: unknown = doc;
    for (let k = 0; k <= i; k += 1) {
      cur = isPlainObject(cur) ? (cur as ConfigDoc)[segs[k]!] : undefined;
    }
    if (!isPlainObject(cur)) {
      next = {};
      let parent: ConfigDoc = doc;
      for (let k = 0; k < i; k += 1) parent = parent[segs[k]!] as ConfigDoc;
      parent[seg] = next;
      stack.push(next);
    } else {
      stack.push(cur);
    }
  }
  const last = segs[segs.length - 1]!;
  const owner = stack[stack.length - 1]!;
  if (value === undefined) delete owner[last];
  else owner[last] = value;
  // 自底向上清空对象
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    let parent: ConfigDoc = doc;
    for (let k = 0; k < i; k += 1) {
      const hop = parent[segs[k]!];
      if (!isPlainObject(hop)) return;
      parent = hop;
    }
    const child = parent[segs[i]!];
    if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[segs[i]!];
  }
}
