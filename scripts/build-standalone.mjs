// 独立运行版构建：Node ESM，不产出面板插件，也不打 WebUI。
//
// 公开入口只有一个 mcloud-sign；daily/exchange/redflower 是给库调用者的
// 独立 bundle（用户想只拿一块功能时可以 import 那个文件）。

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist/standalone');

export const ENTRIES = {
  'mcloud-sign': 'src/standalone/mcloudSign.ts',
  daily: 'src/standalone/entries/daily.ts',
  exchange: 'src/standalone/entries/exchange.ts',
  redflower: 'src/standalone/entries/redflower.ts',
};

export async function bundleStandalone() {
  const out = {};
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const r = await build({
      entryPoints: [join(ROOT, entry)],
      bundle: true,
      format: 'esm',
      target: 'node20',
      platform: 'node',
      external: ['node:*'],
      alias: { 'host-api': join(ROOT, 'src/standalone/hostApi.ts') },
      write: false,
      minify: false,
      legalComments: 'none',
      charset: 'utf8',
      banner: name === 'mcloud-sign' ? { js: '#!/usr/bin/env node' } : undefined,
    });
    if (r.outputFiles.length !== 1) throw new Error(`${name}：期望 1 个产物，实际 ${r.outputFiles.length}`);
    out[name] = r.outputFiles[0].text;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await bundleStandalone();
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(all)) {
    const p = join(OUT, `${name}.mjs`);
    writeFileSync(p, text);
    if (name === 'mcloud-sign') chmodSync(p, 0o755);
    console.log(`  ✅ dist/standalone/${name}.mjs（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）`);
  }
  // 同步 WS worker：main 里按 ./wsWorker.mjs 找它。
  // ⚠ 要把 ws 一起打进去，否则用户只拷 dist/standalone 时 worker 找不到依赖。
  const wr = await build({
    entryPoints: [join(ROOT, 'src/standalone/wsWorker.mjs')],
    bundle: true,
    format: 'esm',
    target: 'node20',
    platform: 'node',
    external: ['node:*'],
    write: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
  });
  writeFileSync(join(OUT, 'wsWorker.mjs'), wr.outputFiles[0].text);
  console.log(`  ✅ dist/standalone/wsWorker.mjs（${(Buffer.byteLength(wr.outputFiles[0].text) / 1024).toFixed(1)} KB）`);
  copyFileSync(join(ROOT, 'src/standalone/httpWorker.mjs'), join(OUT, 'httpWorker.mjs'));
  console.log('  ✅ dist/standalone/httpWorker.mjs');
}
