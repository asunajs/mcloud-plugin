// 宿主（SQLite）实现 —— 只有这一层 import `host-api`。
//
// 表结构用 `CREATE TABLE IF NOT EXISTS` 在启动时建：简单到这个规模不需要迁移框架，
// 但**必须幂等** —— 插件热更新时这段代码会再跑一遍。
//
//   runs   每次任务触发一行（含 lateMs，调度精度那条测量的原始数据）
//   state  键值对，放跨触发要保留的东西（会话 cookie、今天签到过没、上一步结果）
//
// state 是可恢复步骤机的地基：执行预算只有 2000ms、而且打断不了阻塞中的宿主调用，
// 一次调用做不完一个流程，所以「做到哪一步了」必须落盘。

import { sqlite_exec, sqlite_query } from 'host-api';
import type { RunRecord, RunStat, SqlParam, Store } from './types.ts';

/** 宿主的 `sqlite_*` 在出错时**返回** `{error}` 而不是抛（`jshost.rs` 的
 *  `json_error`）⇒ 插件读到 `undefined`，失败看起来只是"没写进去"。
 *
 *  F-064 就是这么被拖了一整轮的：表名撞了面板自己那张 `runs`，
 *  每一枪 INSERT 都失败，而自检只报"没拿到自增主键"。
 *  所以这一层**把错误抛出去** —— 抛了才有栈，才有话说。 */
function sqlQ(sql: string, params: SqlParam[]): Record<string, SqlParam>[] {
  const rows = sqlite_query(sql, params) as unknown as Record<string, SqlParam>[] | { error?: string };
  if (!Array.isArray(rows)) {
    throw new Error(`sqlite_query 失败：${(rows as { error?: string }).error ?? '未知错误'}`);
  }
  return rows;
}

function sqlX(sql: string, params: SqlParam[]): { changes: number; lastInsertRowid: number } {
  const r = sqlite_exec(sql, params) as unknown as { changes?: number; lastInsertRowid?: number; error?: string };
  if (typeof r?.error === 'string' && r.error !== '') {
    throw new Error(`sqlite_exec 失败：${r.error}`);
  }
  return { changes: Number(r?.changes ?? 0), lastInsertRowid: Number(r?.lastInsertRowid ?? 0) };
}

export function hostStore(): Store {
  let schemaReady = false;

  return {
    ensureSchema: () => {
      if (schemaReady) return;
      // ⚠ 表名**必须带前缀**：插件和面板**共用同一个 SQLite 文件**，
      //   而面板自己就有一张 `runs`（`id TEXT, plugin, task, kind, …`）。
      //   `CREATE TABLE IF NOT EXISTS runs` 在那里是**空操作**，于是插件的
      //   INSERT 打在一张结构完全不同的表上 ⇒ 每次都是 SQL 错误。
      //   这正是 F-064 拖了一整轮的真身：错误被宿主的 `sqlite_exec` 吞成
      //   `{error}`（不抛），插件读到 `undefined`，看起来只是"没写进去"。
      sqlX(
        `CREATE TABLE IF NOT EXISTS mcloud_runs (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           task         TEXT    NOT NULL,
           runs         INTEGER NOT NULL,
           scheduled_at TEXT    NOT NULL,
           fired_at     TEXT    NOT NULL,
           late_ms      INTEGER NOT NULL,
           ok           INTEGER NOT NULL,
           note         TEXT
         )`,
        [],
      );
      sqlX(
        `CREATE INDEX IF NOT EXISTS idx_mcloud_runs_task_fired ON mcloud_runs (task, fired_at)`,
        [],
      );
      sqlX(
        `CREATE TABLE IF NOT EXISTS state (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`,
        [],
      );
      schemaReady = true;
    },

    getState: (key) => {
      const rows = sqlQ(`SELECT value FROM state WHERE key = ?1`, [key]);
      const row = rows[0];
      return row ? String(row.value) : null;
    },

    setState: (key, value, nowIso) => {
      sqlX(
        `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
        [key, value, nowIso],
      );
    },

    recordRun: (r: RunRecord) => {
      const res = sqlX(
        `INSERT INTO mcloud_runs (task, runs, scheduled_at, fired_at, late_ms, ok, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [r.task, r.runs, r.scheduledAt, r.firedAt, Math.round(r.lateMs), r.ok ? 1 : 0, r.note ?? null],
      );
      return res.lastInsertRowid;
    },

    // 分位数在 SQL 里算，不把行拉回来算：`sqlite_query` 一次最多返回 1000 行，
    // 跑到几万次触发之后「拉回来再算」会静默丢数据 —— 那种错很难发现（数字看着还合理）。
    // 另外两点和内存实现必须同口径：**排除负延迟**（F-001）、**按值排序取分位**（不是按 id）。
    lateStats: (task, lastN = 500) => {
      const agg = sqlQ(
        `SELECT COUNT(*) AS n, MAX(late_ms) AS mx FROM (
           SELECT late_ms FROM mcloud_runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
         )`,
        [task, lastN],
      );
      const n = Number(agg[0]?.n ?? 0);

      const neg = sqlQ(
        `SELECT COUNT(*) AS c FROM (
           SELECT late_ms FROM mcloud_runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2
         ) WHERE late_ms < 0`,
        [task, lastN],
      );

      const pick = (q: number): number => {
        if (n === 0) return 0;
        const offset = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
        const rows = sqlQ(
          `SELECT late_ms AS v FROM (
             SELECT late_ms FROM mcloud_runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
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
      } satisfies RunStat;
    },

    recentRuns: (limit = 20) =>
      sqlQ(
        `SELECT task, runs, fired_at, late_ms, ok, note FROM mcloud_runs ORDER BY id DESC LIMIT ?1`,
        [Math.min(limit, 1000)],
      ) as Record<string, SqlParam>[],
  };
}
