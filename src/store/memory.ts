// 纯逻辑层用的内存 Store —— **不 import host-api**，所以能在 Node 里跑。
//
// 有了它，签到族的步骤机可以在 Node 里做全套测试（推进、幂等、重入、错误路径），
// 真 SQL 由「真面板 E2E」覆盖。两边各测自己擅长的部分，不用互相将就。
//
// 这里刻意**不做** SQL：接口语义（尤其是 `lateStats` 的分位数口径）要和宿主实现一致，
// 所以两边都按同一份接口文档实现，并由同一批测试断言同样的行为。

import { scoped } from './scoped.ts';
import type { RunRecord, RunStat, SqlParam, Store } from './types.ts';

interface Row extends RunRecord {
  id: number;
}

export function memStore(): Store {
  // ⚠ 与生产**同一条路由**（见 scoped.ts 文件头）——不然"测试里对、真机里错"。
  const state = new Map<string, string>();
  const runs: Row[] = [];
  let seq = 0;

  return scoped({
    ensureSchema: () => {},

    getState: (key) => state.get(key) ?? null,

    setState: (key, value) => {
      state.set(key, value);
    },

    recordRun: (r) => {
      seq += 1;
      runs.push({ ...r, id: seq });
      return seq;
    },

    lateStats: (task, lastN = 500) => {
      // 与宿主实现同口径：按 id 取最近 lastN 条，**排除负延迟**，
      // 分位数按**值**排序取（不是按 id）
      const window = runs.filter((r) => r.task === task).slice(-lastN);
      const vals = window
        .filter((r) => r.lateMs >= 0)
        .map((r) => r.lateMs)
        .sort((a, b) => a - b);
      const pick = (q: number): number => {
        if (vals.length === 0) return 0;
        const i = Math.min(vals.length - 1, Math.max(0, Math.ceil(vals.length * q) - 1));
        return vals[i]!;
      };
      return {
        task,
        n: vals.length,
        lateP50: pick(0.5),
        lateP99: pick(0.99),
        lateMax: vals.length ? vals[vals.length - 1]! : 0,
        excluded: window.filter((r) => r.lateMs < 0).length,
      } satisfies RunStat;
    },

    recentRuns: (limit = 20) =>
      runs
        .slice(-limit)
        .reverse()
        .map((r) => ({
          task: r.task,
          runs: r.runs,
          fired_at: r.firedAt,
          late_ms: r.lateMs,
          ok: r.ok ? 1 : 0,
          note: (r.note ?? null) as SqlParam,
        })),
  });
}
