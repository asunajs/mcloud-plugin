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

export { exchange, printExchangeList };

export async function run(configPath?: string): Promise<void> {
  const rt = await createRuntime({ configPath });
  try {
    if (rt.config.accounts.length === 0) {
      console.error('未找到配置文件或无账号');
      process.exitCode = 1;
      return;
    }
    console.log(`配置文件: ${rt.config.path}`);
    console.log(`共 ${rt.config.accounts.length} 个账号`);
    const results = runDailyAll(rt);
    if (results.length === 0) {
      console.error('没有启用账号');
      process.exitCode = 1;
      return;
    }
    let bad = 0;
    for (const r of results) {
      console.log(`------ ${r.label} ------`);
      for (const line of r.detail) console.log(`[${r.label}] ${line}`);
      console.log(`[${r.label}] ${r.note}`);
      if (!r.ok) bad += 1;
    }
    console.log('全部执行完成');
    if (bad > 0) process.exitCode = 1;
  } finally {
    rt.close();
  }
}

/** 兼容旧名。 */
export { run as 运行 };

export async function autoDrawRedFlower(configPath?: string): Promise<void> {
  const rt = await createRuntime({ configPath });
  try {
    autoDraw(rt);
  } finally {
    rt.close();
  }
}

export async function drawRedFlower(codes: string[], configPath?: string): Promise<void> {
  const rt = await createRuntime({ configPath });
  try {
    draw(rt, codes);
  } finally {
    rt.close();
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
  try {
    await run(configFromArgv(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
