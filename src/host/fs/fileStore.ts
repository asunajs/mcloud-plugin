// 生产用的 Store：**本地 JSON 文件**（面板与 CLI 共用同一份实现）。
//
// # 为什么不是面板的 SQLite
//
// 面板的 `sqlite_*_sync` 每调一次就新起一个线程 + 一个新 runtime（`sync_bridge::run`），
// 而业务侧有 305 处读写 —— 一趟日常就是几百次线程创建，抖动还查不出来。
// 换成文件之后，一次运行只有"装载 / 落盘"这点 I/O，而且 CLI 与面板**天然同一份数据**。
//
// # 布局（一个目录，四个插件 + CLI 共用）
//
//     <dir>/meta.json            schema 版本 / 插件版本 / 创建时间
//     <dir>/shared.json          全局键（账号表、配置镜像、环形日志…）
//     <dir>/state/<acct>.json    账号袋（一个号一个文件）
//     <dir>/runs/<plugin>.json   运行记录（写者唯一）
//
// 为什么账号袋**不按插件拆文件**：拆了要先有一张"每个键归谁"的 owner 表，
// 而收益只是少几次短锁。P4 先不拆 —— 先把"别再每次一个线程"这件事做成。
//
// # 并发
//
// 写一律走目录锁（`withLock`），读**不加锁**：原子 rename 保证读到的永远是完整文件。
// 面板四个插件 + CLI 同时写也只有"短锁"这一档代价。

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunRecord, RunStat, SqlParam, Store } from '../../store/types.ts';
import { JsonFile, withLock } from './jsonFile.ts';

/** 账号袋的物理键前缀（与 store/keys.ts 的 ACCT_PREFIX 一致）。 */
const ACCT_PREFIX = 'mcloud.acct.';

export interface FileStoreOptions {
  /** 状态目录（四个插件共用；CLI 用 MCLOUD_DATA_DIR） */
  dir: string;
  /** 写者身份：mcloud / mcloud-daily / mcloud-exchange / mcloud-live / cli */
  plugin: string;
  nowIso: string;
  /** 一次性迁移：只在 meta.json 不存在时调用。返回搬了多少，给人看。 */
  legacy?: (() => { keys: number; runs: number } | null) | undefined;
}

interface RunsFile {
  seq: number;
  rows: (RunRecord & { id: number })[];
}

const RUNS_CAP = 1000;

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 账号 id → 文件名。id 是我们自己生成的（手机号/序号），但要挡住路径分隔符。 */
function safeName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

export function openFileStore(o: FileStoreOptions): Store {
  const dir = o.dir;
  const sharedFile = new JsonFile<Record<string, string>>(join(dir, 'shared.json'), () => ({}));
  const runsFile = new JsonFile<RunsFile>(join(dir, 'runs', `${o.plugin}.json`), () => ({ seq: 0, rows: [] }));
  const bags = new Map<string, JsonFile<Record<string, string>>>();
  const metaFile = new JsonFile<{ schema: number; plugin: string; createdAt: string }>(join(dir, 'meta.json'), () => ({
    schema: 0,
    plugin: '',
    createdAt: '',
  }));

  const bagFor = (acctId: string): JsonFile<Record<string, string>> => {
    const name = safeName(acctId);
    let f = bags.get(name);
    if (f === undefined) {
      f = new JsonFile<Record<string, string>>(join(dir, 'state', `${name}.json`), () => ({}));
      bags.set(name, f);
    }
    return f;
  };

  let schemaReady = false;
  const ensure = (): void => {
    if (schemaReady) return;
    mkdirSync(join(dir, 'state'), { recursive: true });
    mkdirSync(join(dir, 'runs'), { recursive: true });
    // ⚠ 四件插件可能**同时**第一次启动：meta 的检查与写入必须在锁里，
    //   否则两个插件会各导入一遍（运行记录就重复了）。
    withLock(dir, () => {
      if (exists(join(dir, 'meta.json'))) return;
      // 迁移放在 meta 之前：抛了就不写 meta，下次启动会再试一次（幂等）。
      // "搬了多少"由 host 层在 legacy() 里自己打日志 —— 这一层不 import 日志端口。
      o.legacy?.();
      metaFile.write({ schema: 1, plugin: o.plugin, createdAt: o.nowIso });
    });
    schemaReady = true;
  };

  return {
    ensureSchema: ensure,

    getState: (key) => {
      ensure();
      if (key.startsWith(ACCT_PREFIX)) {
        const bag = bagFor(key.slice(ACCT_PREFIX.length)).read();
        // 空袋 = 这一段没有值。与 SQLite 那版一致：空对象也当"没有"。
        return Object.keys(bag).length === 0 ? null : JSON.stringify(bag);
      }
      const v = sharedFile.read()[key];
      return v === undefined ? null : v;
    },

    setState: (key, value, nowIso) => {
      ensure();
      void nowIso; // 时间戳不再落盘（面板/CLI 各自按真实时刻记日志；这里只存值）
      withLock(dir, () => {
        if (key.startsWith(ACCT_PREFIX)) {
          const f = bagFor(key.slice(ACCT_PREFIX.length));
          let bag: Record<string, string>;
          try {
            bag = JSON.parse(value) as Record<string, string>;
          } catch {
            bag = {};
          }
          f.write(bag);
          return;
        }
        const all = sharedFile.read();
        all[key] = value;
        sharedFile.write(all);
      });
    },

    // ⚠ **锁内读改写**：`fn` 拿到当前值（没有 ⇒ null），返回新值（null = 删）。
    //   `setState` 只把"写"关进锁，"读"在外面 —— 调用方自己读再改再写的那段
    //   （routeSet 的账号袋、runLog 的追加、计划计数）在四个插件 + CLI 共用一份
    //   目录时就是**丢更新**：mcloud-daily 写袋与 mcloud 路由刷会话同时发生，
    //   后写的整袋覆盖会把先写的字段无声抹掉（兑换的 ordered_hour 被回退 =
    //   重复下单形状的风险，findings F-145）。整段 RMW 必须在一把锁里。
    update: (key, fn) => {
      ensure();
      withLock(dir, () => {
        if (key.startsWith(ACCT_PREFIX)) {
          const f = bagFor(key.slice(ACCT_PREFIX.length));
          const cur = f.read();
          const prev = Object.keys(cur).length === 0 ? null : JSON.stringify(cur);
          const next = fn(prev);
          if (next === null) {
            f.write({});
            return;
          }
          let bag: Record<string, string>;
          try {
            bag = JSON.parse(next) as Record<string, string>;
          } catch {
            bag = {};
          }
          f.write(bag);
          return;
        }
        const all = sharedFile.read();
        const next = fn(all[key] ?? null);
        if (next === null) delete all[key];
        else all[key] = next;
        sharedFile.write(all);
      });
    },

    recordRun: (r) => {
      ensure();
      return withLock(dir, () => {
        const f = runsFile.read();
        f.seq += 1;
        f.rows.push({ ...r, id: f.seq });
        if (f.rows.length > RUNS_CAP) f.rows.splice(0, f.rows.length - RUNS_CAP);
        runsFile.write(f);
        return f.seq;
      });
    },

    lateStats: (task, lastN = 500) => {
      ensure();
      const rows = runsFile.read().rows.filter((x) => x.task === task).slice(-lastN);
      const vals = rows
        .filter((x) => x.lateMs >= 0)
        .map((x) => x.lateMs)
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
        lateMax: vals.length > 0 ? vals[vals.length - 1]! : 0,
        excluded: rows.filter((x) => x.lateMs < 0).length,
      } satisfies RunStat;
    },

    recentRuns: (limit = 20) => {
      ensure();
      return runsFile
        .read()
        .rows.slice(-limit)
        .reverse()
        .map((r) => ({
          task: r.task,
          runs: r.runs,
          fired_at: r.firedAt,
          late_ms: r.lateMs,
          ok: r.ok ? 1 : 0,
          note: (r.note ?? null) as SqlParam,
        }));
    },
  };
}

export const STORE_DIR_NAME = 'mcloud';

/** 面板里的状态目录：`<data>/plugin-data/mcloud`。
 *
 * 面板的约定是 `plugin-data/<插件名>`（`hostapi.rs::op_plugin_data_dir`），
 * 四个插件必须指到**同一个**目录 —— 账号与凭据是共享的。 */
export function panelStoreDir(pluginDataDir: string): string {
  return dirname(pluginDataDir) === '' ? pluginDataDir : join(dirname(pluginDataDir), STORE_DIR_NAME);
}
