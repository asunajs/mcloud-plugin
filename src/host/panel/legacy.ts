// 面板侧的一次性导入：读**面板 SQLite** 里那张 `state` 表与 `mcloud_runs`。
//
// 这是全仓**唯一**还在用 sqlite 的地方：只在 `meta.json` 不存在时跑一次，
// 之后所有读写都走文件（见 host/fs/fileStore.ts 文件头）。
//
// 为什么不能不做：老用户的账号、凭据、口令池、打卡记录都在那张表里；
// 不做导入 = 让他们重新登录一遍。

import { logTo } from '../../ports/log.ts';
import { io } from '../../ports/io.ts';
import type { RunRecord } from '../../store/types.ts';
import { importLegacyRows } from '../fs/importLegacy.ts';

function rowsOf(v: unknown): Record<string, unknown>[] | null {
  // 宿主失败时返回 {error}（不是抛）；空库时表都不存在，也是这一档
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  return null;
}

export function importFromPanelSqlite(dir: string): { keys: number; runs: number } | null {
  let stateRows: Record<string, unknown>[] | null = null;
  let runRows: Record<string, unknown>[] | null = null;
  try {
    stateRows = rowsOf(io().sql('SELECT key, value FROM state', []));
    runRows = rowsOf(io().sql('SELECT task, runs, scheduled_at, fired_at, late_ms, ok, note FROM mcloud_runs', []));
  } catch (e) {
    logTo('warn', '旧状态导入：读面板数据库失败（按"没有旧数据"继续）：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
  if (stateRows === null && runRows === null) return null;

  const keys = (stateRows ?? [])
    .filter((r) => typeof r.key === 'string')
    .map((r) => ({ key: String(r.key), value: String(r.value ?? '') }));
  const runs = (runRows ?? []).map(
    (r): RunRecord => ({
      task: String(r.task ?? ''),
      runs: Number(r.runs ?? 0),
      scheduledAt: String(r.scheduled_at ?? ''),
      firedAt: String(r.fired_at ?? ''),
      lateMs: Number(r.late_ms ?? 0),
      ok: Number(r.ok ?? 0) === 1,
      note: r.note === null || r.note === undefined ? undefined : String(r.note),
    }),
  );
  const moved = importLegacyRows(dir, { keys, runs });
  if (moved.keys > 0 || moved.runs > 0) {
    logTo('info', `旧状态已搬成本地文件：${moved.keys} 个键、${moved.runs} 条运行记录（之后不再读写面板数据库）`);
  }
  return moved;
}
