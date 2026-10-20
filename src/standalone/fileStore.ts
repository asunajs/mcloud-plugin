// 独立版的 Store：JSON 文件 + 进程锁。
//
// 不碰面板 SQLite：两者状态互不相通，独立版第一次跑会重新换票。
// 每次 setState 都原子落盘 —— 一次日常有几十次写，但对本地 SSD 不算什么，
// 换来的是进程被杀时状态不会只写一半。

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, RunStat, SqlParam, Store } from '../store/types.ts';

interface StateFile {
  version: 1;
  state: Record<string, string>;
  runs: Array<RunRecord & { id: number }>;
}

const MAX_RUNS = 1000;

export class StateLockedError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`状态文件被占用：${lockPath}`);
    this.name = 'StateLockedError';
    this.lockPath = lockPath;
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 只用于极短的锁重试，不在这里做业务等待
  }
}

export class FileStore implements Store {
  private data: StateFile;
  private lockFd: number | undefined;
  private readonly lockPath: string;
  private readonly file: string;
  private readonly nowIso: string;

  constructor(file: string, nowIso: string) {
    this.file = file;
    this.nowIso = nowIso;
    mkdirSync(dirname(file), { recursive: true });
    this.lockPath = `${file}.lock`;
    this.acquireLock();
    this.data = this.read();
  }

  private acquireLock(): void {
    for (let i = 0; i < 2; i += 1) {
      try {
        this.lockFd = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(this.lockFd, String(process.pid));
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== 'EEXIST') throw e;
        let pid = 0;
        try {
          pid = Number(readFileSync(this.lockPath, 'utf8').trim());
        } catch {
          /* 锁文件刚消失 */
        }
        let alive = false;
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        }
        if (alive) throw new StateLockedError(this.lockPath);
        try {
          unlinkSync(this.lockPath);
        } catch {
          /* 别人先删了 */
        }
        sleepSync(20);
      }
    }
    throw new StateLockedError(this.lockPath);
  }

  private read(): StateFile {
    if (!existsSync(this.file)) return { version: 1, state: {}, runs: [] };
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>;
      return {
        version: 1,
        state: typeof v.state === 'object' && v.state !== null ? v.state : {},
        runs: Array.isArray(v.runs) ? v.runs : [],
      };
    } catch {
      // 坏文件不静默清空：改名留档，再起一份空状态。用户至少能找回上一份。
      const bad = `${this.file}.bad-${Date.now()}`;
      try {
        renameSync(this.file, bad);
      } catch {
        /* ignore */
      }
      return { version: 1, state: {}, runs: [] };
    }
  }

  private flush(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  ensureSchema(): void {
    // 没有 SQL 表；构造时已经建目录/锁
  }

  getState(key: string): string | null {
    return this.data.state[key] ?? null;
  }

  setState(key: string, value: string, _nowIso: string): void {
    this.data.state[key] = value;
    this.flush();
  }

  recordRun(r: RunRecord): number {
    const id = (this.data.runs.at(-1)?.id ?? 0) + 1;
    this.data.runs.push({ ...r, lateMs: Math.round(r.lateMs), id });
    if (this.data.runs.length > MAX_RUNS) this.data.runs.splice(0, this.data.runs.length - MAX_RUNS);
    this.flush();
    return id;
  }

  lateStats(task: string, lastN = 500): RunStat {
    const all = this.data.runs.filter((r) => r.task === task).slice(-lastN);
    const valid = all.filter((r) => r.lateMs >= 0).map((r) => r.lateMs).sort((a, b) => a - b);
    const pick = (q: number): number => {
      if (valid.length === 0) return 0;
      const i = Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * q) - 1));
      return valid[i] ?? 0;
    };
    return {
      task,
      n: valid.length,
      lateP50: pick(0.5),
      lateP99: pick(0.99),
      lateMax: valid.length === 0 ? 0 : (valid[valid.length - 1] ?? 0),
      excluded: all.filter((r) => r.lateMs < 0).length,
    };
  }

  recentRuns(limit = 20): Record<string, SqlParam>[] {
    return this.data.runs
      .slice(-Math.min(limit, 1000))
      .reverse()
      .map((r) => ({
        task: r.task,
        runs: r.runs,
        fired_at: r.firedAt,
        late_ms: r.lateMs,
        ok: r.ok ? 1 : 0,
        note: r.note ?? null,
      }));
  }

  close(): void {
    if (this.lockFd !== undefined) {
      try {
        closeSync(this.lockFd);
      } catch {
        /* ignore */
      }
      this.lockFd = undefined;
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* ignore */
      }
    }
  }
}
