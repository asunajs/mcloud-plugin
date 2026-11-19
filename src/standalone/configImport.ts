// 旧 `asign.json` / `asign.config.js|mjs` → 统一配置文件（一次性迁移，命令 + 可导出函数）。
//
// # 为什么要有它
//
// 用户口径（2026-11-19）：旧配置「可以使用命令/导出的函数调用，迁移到新的文件」。
// 也就是说 CLI 不该长期同时认两种格式 —— 旧格式是**迁移源**，不是第二份真值。
//
// 搬什么、搬到哪：
//
// ```text
//   caiyun[].auth / nickname / label / disabled   → shared.json 的 mcloud.accounts（账号表，契约不变）
//   红包派对.开启 / 算力大作战                      → 账号状态（老语义，一行不改）
//   standalone.http.{timeoutMs,insecure,followRedirects,proxy} → config.json 的 cli.http.*
//   standalone.ws.{timeoutMs,insecure}                         → config.json 的 cli.ws.*
// ```
//
// # 幂等
//
// 账号按手机号合并（`seedAccounts` 本来就这么做），设置同值不写。所以第二次跑是空转。
// 迁移完 `asign.json` **原样留在磁盘**（只读）—— 它可能还被别人用着（比如另一台机器）。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openFileStore } from '../host/fs/fileStore.ts';
import { migrateUserConfig } from '../host/fs/configMigrate.ts';
import { loadConfig } from './config.ts';
import { seedAccounts } from './runtime.ts';

export interface ImportResult {
  ok: boolean;
  /** 迁移源（`asign.json` 的绝对路径） */
  from: string;
  /** 统一配置文件路径 */
  written: string;
  /** 这次落地/更新的账号数 */
  accounts: number;
  /** 搬进配置的 CLI 旋钮（`cli.http.timeout_ms` …） */
  settings: string[];
  backupDir: string;
  /** `--dry-run` 时为 true：什么都没写 */
  dryRun: boolean;
}

export interface ImportOptions {
  /** 旧的 `asign.json` / `asign.config.js|mjs` */
  from: string;
  /** 数据目录（面板 `plugin-data/mcloud` 或 CLI 自己的目录） */
  storeDir: string;
  /** 只算不写：先把「会搬什么」给人看 */
  dryRun?: boolean;
}

/** 把旧配置搬进统一配置文件。**不改旧文件**、幂等、可 dry-run。 */
export async function importLegacyConfig(opts: ImportOptions): Promise<ImportResult> {
  const cfg = await loadConfig(opts.from);
  const storeDir = opts.storeDir;
  const raw = openFileStore({
    dir: storeDir,
    plugin: 'cli',
    nowIso: new Date().toISOString(),
  });
  raw.ensureSchema();
  // ① 先把用户配置统一一遍（空目录 ⇒ 写默认值；已有统一文件 ⇒ 空转）。
  //    `--dry-run` **不写**：那一步本身就是一次落盘。
  const uni = opts.dryRun === true
    ? { backupDir: '' }
    : migrateUserConfig(raw, new Date().toISOString());
  const port = raw.userConfig;
  if (port === undefined) throw new Error('这个 store 没有 userConfig 端口');

  const settings: string[] = [];
  const put = (path: string, value: unknown): void => {
    if (value === undefined) return;
    settings.push(path);
    if (opts.dryRun !== true) port.write(path, value);
  };
  put('cli.http.timeout_ms', cfg.http.timeoutMs);
  put('cli.http.insecure', cfg.http.insecure);
  put('cli.http.follow_redirects', cfg.http.followRedirects);
  put('cli.http.proxy', cfg.http.proxy);
  put('cli.ws.timeout_ms', cfg.ws.timeoutMs);
  put('cli.ws.insecure', cfg.ws.insecure);

  // ② 账号（走与面板同一套 upsert；空配置不动账号表 —— 否则等于把号全删了）
  if (opts.dryRun !== true && cfg.accounts.length > 0) seedAccounts(raw, cfg);
  let accounts = 0;
  try {
    const list = JSON.parse(raw.getState('mcloud.accounts') ?? '[]') as unknown;
    accounts = Array.isArray(list) ? list.length : 0;
  } catch {
    accounts = 0;
  }

  // ③ 备份迁移源（原文拷一份）+ 记录这次搬了什么
  let backupDir = uni.backupDir;
  if (opts.dryRun !== true) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = join(storeDir, 'backup', 'config-import-' + stamp);
    try {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, basename(opts.from)), readFileSync(opts.from));
    } catch {
      backupDir = '';
    }
  }
  if (opts.dryRun !== true) {
    try {
      statSync(port.path);
    } catch {
      throw new Error('统一配置文件没写出来：' + port.path);
    }
  }
  return {
    ok: true,
    from: cfg.path,
    written: port.path,
    accounts: opts.dryRun === true ? cfg.accounts.length : accounts,
    settings: settings.filter((v, i, a) => a.indexOf(v) === i),
    backupDir: opts.dryRun === true ? '' : backupDir,
    dryRun: opts.dryRun === true,
  };
}

/** 从 argv 里取一段：`--k v` 或 `--k=v`。 */
export function argvValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const hit = argv.find((x) => x.startsWith(name + '='));
  return hit === undefined ? undefined : hit.slice(name.length + 1);
}

/** `mcloud-sign config:import --config asign.json --data-dir <dir> [--dry-run]` */
export async function runConfigImport(argv: readonly string[]): Promise<ImportResult> {
  const from = argvValue(argv, '--config');
  const storeDir = argvValue(argv, '--data-dir') ?? process.env['MCLOUD_DATA_DIR'] ?? '';
  const dryRun = argv.includes('--dry-run');
  if (from === undefined) throw new Error('要给 --config <asign.json 的路径>');
  if (storeDir === '') {
    throw new Error('要给 --data-dir <面板的 plugin-data/mcloud 或 CLI 数据目录>（或设 MCLOUD_DATA_DIR）');
  }
  return await importLegacyConfig({ from, storeDir, dryRun });
}

