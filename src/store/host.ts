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

export function hostStore(): Store {
  let schemaReady = false;

  return {
    ensureSchema: () => {
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
    },

    getState: (key) => {
      const rows = sqlite_query(`SELECT value FROM state WHERE key = ?1`, [key]);
      const row = rows[0];
      return row ? String(row.value) : null;
    },

    setState: (key, value, nowIso) => {
      sqlite_exec(
        `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
        [key, value, nowIso],
      );
    },

    recordRun: (r: RunRecord) => {
      const res = sqlite_exec(
        `INSERT INTO runs (task, runs, scheduled_at, fired_at, late_ms, ok, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [r.task, r.runs, r.scheduledAt, r.firedAt, Math.round(r.lateMs), r.ok ? 1 : 0, r.note ?? null],
      );
      return res.lastInsertRowid;
    },

    // 分位数在 SQL 里算，不把行拉回来算：`sqlite_query` 一次最多返回 1000 行，
    // 跑到几万次触发之后「拉回来再算」会静默丢数据 —— 那种错很难发现（数字看着还合理）。
    // 另外两点和内存实现必须同口径：**排除负延迟**（F-001）、**按值排序取分位**（不是按 id）。
    lateStats: (task, lastN = 500) => {
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
      } satisfies RunStat;
    },

    recentRuns: (limit = 20) =>
      sqlite_query(
        `SELECT task, runs, fired_at, late_ms, ok, note FROM runs ORDER BY id DESC LIMIT ?1`,
        [Math.min(limit, 1000)],
      ) as Record<string, SqlParam>[],
  };
}
