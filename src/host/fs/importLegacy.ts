// 旧数据一次性导入：把"面板 SQLite 里的状态"或"CLI 老的 state.json"搬成文件。
//
// 只做一次：调用方在 `meta.json` 不存在时调它，成功之后写 meta，下次不会再跑。
// 失败就抛，**不写 meta** —— 下次启动会再试（幂等：写同一个键就是覆盖）。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFile } from './jsonFile.ts';
import type { RunRecord } from '../../store/types.ts';

const ACCT_PREFIX = 'mcloud.acct.';

/** 任务名 → 写者插件（运行记录按写者分文件）。 */
const TASK_PLUGIN: Record<string, string> = {
  日常: 'mcloud-daily',
  兑换: 'mcloud-exchange',
  直播: 'mcloud-live',
};

function safeName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

export interface LegacyRows {
  /** `state` 表的 key/value（值都是字符串） */
  keys: { key: string; value: string }[];
  /** 运行记录（旧表 `mcloud_runs` 或 CLI 的 runs 数组） */
  runs: (RunRecord & { id?: number })[];
}

/** CLI 的老状态文件（`~/.mcloud/state.json`：`{version, state:{…}, runs:[…]}`）。
 *
 *  只在 store 目录里还没有 meta.json 时调；找不到文件就是"没有旧数据"（返回 null）。 */
export function importLegacyStateFile(dir: string, stateFile: string): { keys: number; runs: number } | null {
  let text: string;
  try {
    text = readFileSync(stateFile, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as { state?: Record<string, string>; runs?: (RunRecord & { id?: number })[] };
    const keys = Object.entries(v.state ?? {}).map(([key, value]) => ({ key, value: String(value) }));
    return importLegacyRows(dir, { keys, runs: v.runs ?? [] });
  } catch {
    return null;
  }
}

/** 把 rows 写进 <dir>/ 下的文件。返回搬了多少（给人看）。 */
export function importLegacyRows(dir: string, rows: LegacyRows): { keys: number; runs: number } {
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });

  const sharedFile = new JsonFile<Record<string, string>>(join(dir, 'shared.json'), () => ({}));
  const shared = sharedFile.read();
  const bags = new Map<string, JsonFile<Record<string, string>>>();
  let keys = 0;

  for (const { key, value } of rows.keys) {
    if (typeof key !== 'string' || key === '') continue;
    if (key.startsWith(ACCT_PREFIX)) {
      const id = safeName(key.slice(ACCT_PREFIX.length));
      let bag: Record<string, string>;
      try {
        bag = JSON.parse(value) as Record<string, string>;
      } catch {
        continue; // 坏袋跳过：搬一个解析不了的值没有意义
      }
      let f = bags.get(id);
      if (f === undefined) {
        f = new JsonFile<Record<string, string>>(join(dir, 'state', `${id}.json`), () => ({}));
        bags.set(id, f);
      }
      // 多行指向同一个袋（理论上不会有，但合并比覆盖安全）
      f.write({ ...f.read(), ...bag });
      keys += 1;
      continue;
    }
    shared[key] = value;
    keys += 1;
  }
  if (keys > 0) sharedFile.write(shared);

  // 运行记录按任务归属分文件（写者唯一，之后互不覆盖）
  const byPlugin = new Map<string, (RunRecord & { id: number })[]>();
  for (const r of rows.runs) {
    const plugin = TASK_PLUGIN[r.task] ?? 'mcloud';
    const list = byPlugin.get(plugin) ?? [];
    list.push({ ...r, id: list.length + 1 });
    byPlugin.set(plugin, list);
  }
  let runs = 0;
  for (const [plugin, list] of byPlugin) {
    const f = new JsonFile<{ seq: number; rows: (RunRecord & { id: number })[] }>(
      join(dir, 'runs', `${plugin}.json`),
      () => ({ seq: 0, rows: [] }),
    );
    const cur = f.read();
    const merged = cur.rows.concat(list.map((r) => ({ ...r, id: (cur.seq += 1) })));
    f.write({ seq: cur.seq, rows: merged });
    runs += list.length;
  }

  return { keys, runs };
}
