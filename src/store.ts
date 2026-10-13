// 插件自己的 SQLite 层。
//
// 面板只给两个原语（`sqlite_query` / `sqlite_exec`），没有 ORM、没有迁移框架。
// 表结构用 `CREATE TABLE IF NOT EXISTS` 在启动时建 —— 简单到这个规模不需要迁移框架，
// 但**必须幂等**：插件热更新时这段代码会再跑一遍。
//
// 这里只放两样东西：
//   runs   —— 每次任务触发一行（含 lateMs，这是「调度精度」那条测量的原始数据）
//   state  —— 键值对，放跨触发要保留的东西（cookie、今天签到过没、上一步结果）
//
// state 那张表是可恢复步骤机的地基：执行预算只有 2000ms，一次调用做不完一个流程，
// 所以「做到哪一步了」必须落在磁盘上而不是解释器的内存里。

import { sqlite_exec, sqlite_query } from 'host-api';
import type { SqlParam } from 'host-api';

let schemaReady = false;

/** 建表（幂等）。每次插件加载都会调一次。 */
export function ensureSchema(): void {
  if (schemaReady) return;
  sqlite_exec(
    `CREATE TABLE IF NOT EXISTS runs (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       task         TEXT    NOT NULL,
       runs         INTEGER NOT NULL,
       scheduled_at TEXT    NOT NULL,
       fired_at     TEXT    NOT NULL,
       late_ms      INTEGER NOT NULL,
       ok           INTEGER NOT NULL,
       note         TEXT
     )`,
  );
  sqlite_exec(`CREATE INDEX IF NOT EXISTS idx_runs_task_fired ON runs (task, fired_at)`);
  sqlite_exec(
    `CREATE TABLE IF NOT EXISTS state (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  schemaReady = true;
}

export function getState(key: string): string | null {
  const rows = sqlite_query(`SELECT value FROM state WHERE key = ?1`, [key]);
  const row = rows[0];
  return row ? String(row.value) : null;
}

export function setState(key: string, value: string, nowIso: string): void {
  sqlite_exec(
    `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
    [key, value, nowIso],
  );
}

/** 记一次触发。返回这行的 id。 */
export function recordRun(r: {
  task: string;
  runs: number;
  scheduledAt: string;
  firedAt: string;
  lateMs: number;
  ok: boolean;
  note?: string;
}): number {
  const res = sqlite_exec(
    `INSERT INTO runs (task, runs, scheduled_at, fired_at, late_ms, ok, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [r.task, r.runs, r.scheduledAt, r.firedAt, Math.round(r.lateMs), r.ok ? 1 : 0, r.note ?? null],
  );
  return res.lastInsertRowid;
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

/** 某个任务最近的 lateMs 分布。
 *
 *  为什么在 SQL 里算而不是把行拉回来算：面板的 `sqlite_query` 一次最多返回 1000 行，
 *  跑到几万次触发之后「拉回来再算」会静默丢数据 —— 那种错很难发现（数字看着还挺合理）。
 *  SQLite 里用 ORDER BY + LIMIT 取分位数，一次只回几行。
 *
 *  **负延迟样本会被排除并单独计数**：面板手动触发时算出来的 `lateMs` 是负数
 *  （根因见 docs/findings.md F-001 的 F-001），拿它当「迟到多少」会把分布拉偏。
 *  这里排除但不静默 —— `excluded` 会一起报出来。 */
export function lateStats(task: string, lastN = 500): RunStat {
  const agg = sqlite_query(
    `SELECT COUNT(*) AS n, MAX(late_ms) AS mx FROM (
       SELECT late_ms FROM runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
     )`,
    [task, lastN],
  );
  const n = Number(agg[0]?.n ?? 0);

  const neg = sqlite_query(
    `SELECT COUNT(*) AS c FROM (
       SELECT late_ms FROM runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2
     ) WHERE late_ms < 0`,
    [task, lastN],
  );

  // 分位数要按**值**排序取，不是按 id —— 按 id 取等于取「最近第 k 新的一次」，
  // 那是顺序不是分布。这里把窗口内的值升序排好再取第 k 个。
  const pick = (q: number): number => {
    if (n === 0) return 0;
    const offset = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
    const rows = sqlite_query(
      `SELECT late_ms AS v FROM (
         SELECT late_ms FROM runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
       ) ORDER BY late_ms ASC LIMIT 1 OFFSET ?3`,
      [task, lastN, offset],
    );
    const v = rows[0]?.v;
    return v === undefined || v === null ? 0 : Number(v);
  };
  return {
    task,
    n,
    lateP50: pick(0.5),
    lateP99: pick(0.99),
    lateMax: Number(agg[0]?.mx ?? 0),
    excluded: Number(neg[0]?.c ?? 0),
  };
}

export function recentRuns(limit = 20): Record<string, SqlParam>[] {
  return sqlite_query(
    `SELECT task, runs, fired_at, late_ms, ok, note FROM runs ORDER BY id DESC LIMIT ?1`,
    [Math.min(limit, 1000)],
  );
}
