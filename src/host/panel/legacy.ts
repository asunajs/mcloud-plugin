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
  // ⚠ 面板的 `sqlite_query_sync` 回的是 **`{ rows, truncated }`**，不是裸数组
  //   （见 panel 的 `db_query`）。2026-11-16 就是按裸数组写的 ⇒ 搬了 0 条、
  //   而且因为它"看起来像没旧数据"，一声不响。
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v !== null && typeof v === 'object' && Array.isArray((v as { rows?: unknown }).rows)) {
    return (v as { rows: Record<string, unknown>[] }).rows;
  }
  // 宿主失败时是 `{error}`（不是抛）。⚠ 表不存在也是这一档，但**库被锁 / IO 错**
  // 也是这一档 —— 静默当"没有旧数据"的话，失败会被 meta.json **永久化**（再也不
  // 会重试）。至少把原话报出来，别"搬了 0 条、一声不响"（F-142 的教训差一个形状）。
  // 待办（F-145）：只有认得出"no such table"这类才算真没旧数据；其余不该写 meta，
  // 留到下次启动重试。要认那种形状得先知道面板回的确切错误串。
  if (v !== null && typeof v === 'object' && 'error' in v) {
    logTo('warn', '旧状态导入：面板数据库返回错误（按"没有旧数据"继续）：' + JSON.stringify((v as { error: unknown }).error).slice(0, 200));
    return null;
  }
  // 其它形状：**别静默** —— 报出来，否则下次还是"搬了 0 条，谁也不知道"
  logTo('warn', '旧状态导入：面板返回的形状不认识（既不是 rows 也不是 error）：' + JSON.stringify(v).slice(0, 200));
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
