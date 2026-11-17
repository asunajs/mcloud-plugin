// 一个 JSON 文件 + 原子写 + 缓存。
//
// 只用 LLRT 也提供的 fs 子集（readFileSync / writeFileSync / renameSync /
// mkdirSync / rmSync / statSync）。**不要**在这里用 existsSync / openSync /
// unlinkSync —— 面板引擎里没有它们（check-layers 的 R6 盯着）。
//
// 原子写的做法是**写临时文件再 rename**：rename 在同一个文件系统上是原子的，
// 所以读方要么看到旧的完整文件，要么看到新的完整文件，不会看到写了一半的 JSON。

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Cached<T> {
  mtimeMs: number;
  size: number;
  data: T;
}

export class JsonFile<T> {
  private readonly path: string;
  private readonly fallback: () => T;
  private cache: Cached<T> | null = null;

  constructor(path: string, fallback: () => T) {
    this.path = path;
    this.fallback = fallback;
  }

  /** 读。文件不存在 = fallback（不是错误：第一次跑就是这样）。 */
  read(): T {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      this.cache = null;
      return this.fallback();
    }
    if (this.cache !== null && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) {
      return this.cache.data;
    }
    try {
      const text = readFileSync(this.path, 'utf8');
      const data = JSON.parse(text) as T;
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch {
      // 坏文件：**不静默清空**。挪到一边留证据，然后按空继续（用户能看出发生了什么）。
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* 挪不动也不该把任务拦下来 */
      }
      this.cache = null;
      return this.fallback();
    }
  }

  write(data: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const text = JSON.stringify(data);
    writeFileSync(tmp, text);
    try {
      // ⚠ chmod 要在 **rename 之前**对 tmp 做：rename 之后那几百毫秒窗口里
      //   文件里已经是凭据（会话 cookie / jwttoken），而 0644 的 tmp 谁都能读；
      //   要是进程崩在 write 与 chmod 之间，tmp 会**永久**以 0644 留在目录里
      //   （findings F-145）。
      chmodSync(tmp, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod：不该因此写不进去 */
    }
    renameSync(tmp, this.path);
    try {
      // 状态文件里有凭据（会话 cookie / jwttoken）⇒ 只给本用户读
      chmodSync(this.path, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod：不该因此写不进去 */
    }
    try {
      const st = statSync(this.path);
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, data };
    } catch {
      this.cache = null;
    }
  }

  reset(): void {
    this.cache = null;
  }
}

/** 目录锁：mkdir 是原子的（存在就失败），比"读文件再写 pid"可靠。
 *
 * 为什么不用文件锁：LLRT 没有 openSync(…, 'wx')，也就没有 O_EXCL。
 * 为什么要有超时：面板崩了/被 kill 之后锁目录会留下 —— 不设超时就是永久锁死。 */
export function withLock<T>(dir: string, fn: () => T, opts: { staleMs?: number; waitMs?: number } = {}): T {
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + (opts.waitMs ?? 2_000);
  const lock = `${dir}/.lock`;
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // 陈旧锁：超过 staleMs 没释放，就当持有者已经死了
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // 刚好被别人释放了：重试一次就能拿到
      }
      if (Date.now() > deadline) {
        throw new Error(`状态目录被占用（${lock}）—— 等不到锁，先看有没有卡住的进程`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* 释放失败不影响结果 */
    }
  }
}

/** 极短的同步等待（锁重试用）。**不是业务等待** —— 业务等待不许忙等。 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin ≤20ms */
  }
}
