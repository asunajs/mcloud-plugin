// 独立版 CLI：命令名、配置查找、导出名都对齐 mcloud-sign。
//
// 直接运行：mcloud-sign（无参数）→ 读 asign.json → 日常。
// import：不自动执行，只拿导出函数。

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runDailyAll } from './daily.ts';
import { autoDrawRedFlower as autoDraw, drawRedFlower as draw } from './liveRun.ts';
import { exchange, printExchangeList } from './exchange.ts';
import { createRuntime } from './runtime.ts';
import { createCliLogger, colorizeFrom } from './logger.ts';
import { lineLevel } from '../mcloud/tasks/stepLog.ts';

export { exchange, printExchangeList };

export async function run(configPath?: string): Promise<void> {
  const rt = await await createRuntime({ configPath });
  const log = createCliLogger({ colorize: colorizeFrom(rt.config.common) });
  try {
    if (rt.config.accounts.length === 0) {
      log.error('未找到配置文件或无账号');
      process.exitCode = 1;
      return;
    }
    log.info(`配置文件: ${rt.config.path}`);
    log.info(`共 ${rt.config.accounts.length} 个账号`);
    const results = await runDailyAll(rt);
    if (results.length === 0) {
      log.error('没有启用账号');
      process.exitCode = 1;
      return;
    }
    let bad = 0;
    for (const [i, r] of results.entries()) {
      // 账号段头照 mcloud-sign：`------ 账号 1 (账号1) ------`
      log.info(`------ 账号 ${i + 1} (${r.label}) ------`);
      // 任务行去掉 `[账号]` 前缀 —— 段头已经说明了是谁；
      // 类型沿用面板那套判据（success/fail/warn/info/debug），只是这里由 CLI 着色。
      for (const line of r.detail) log[lineLevel(line)](line);
      // mcloud-sign 没有「15 步全部完成…」这行；账号完成句就是这一趟的收尾。
      log.info(`账号 ${i + 1} 执行完成`);
      if (!r.ok) bad += 1;
    }
    log.info('全部执行完成');
    if (bad > 0) process.exitCode = 1;
  } finally {
    rt.close();
  }
}

/** 兼容旧名。 */
export { run as 运行 };

export async function autoDrawRedFlower(configPath?: string): Promise<void> {
  const rt = await await createRuntime({ configPath });
  try {
    await autoDraw(rt);
  } finally {
    rt.close();
  }
}

export async function drawRedFlower(codes: string[], configPath?: string): Promise<void> {
  const rt = await await createRuntime({ configPath });
  try {
    await draw(rt, codes);
  } finally {
    rt.close();
  }
}

/** `config:import` —— 把旧 `asign.json` 搬进统一配置文件（见 `configImport.ts`）。
 *
 *  ⚠ 它是**子命令**，所以要在 `run()` 之前分派：`run()` 的第一件事是建 runtime，
 *    而迁移恰恰要在「旧格式 → 新格式」之间做，不能先按旧格式建 runtime。 */
export async function configImport(argv: string[]): Promise<void> {
  const { runConfigImport } = await import('./configImport.ts');
  const log = createCliLogger();
  try {
    const r = await runConfigImport(argv);
    log.info(`${r.dryRun ? '[dry-run] ' : ''}迁移源: ${r.from}`);
    log.info(`统一配置文件: ${r.written}`);
    log.info(`账号表: ${r.accounts} 个${r.dryRun ? '（会写入）' : ''}`);
    log.info(`搬进配置的旋钮: ${r.settings.length > 0 ? r.settings.join('，') : '（无）'}`);
    if (r.backupDir !== '') log.info(`备份: ${r.backupDir}`);
    if (r.dryRun) log.info('这是 dry-run：什么都没写。去掉 --dry-run 再跑一次。');
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}

function configFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((x) => x.startsWith('--config='));
  return eq === undefined ? undefined : eq.slice('--config='.length);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    // 子命令先分派（只有一条）：`config:import`
    if (argv[0] === 'config:import') {
      await configImport(argv.slice(1));
    } else {
      await run(configFromArgv(argv));
    }
  } catch (e) {
    // 配置都还没读出来时没有 `common.colorize`；用默认（TTY 判断）。
    createCliLogger().error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
