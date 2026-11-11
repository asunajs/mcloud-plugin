// 独立运行版构建：Node ESM，不产出面板插件，也不打 WebUI。
//
// 公开入口只有一个 mcloud-sign；daily/exchange/redflower 是给库调用者的
// 独立 bundle（用户想只拿一块功能时可以 import 那个文件）。

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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

/** `ws` 是 CJS，esbuild 的 ESM 产物里会留下 `__require("events")`。
 *  给 worker 加一行 `createRequire`，那几处动态 require 才解得开。
 *  ⚠ 用 `process.cwd()` 当基准（不是 `import.meta.url`）—— 单文件版把 worker 内嵌成
 *  `data:` URL，`import.meta.url` 是 `data:`，`createRequire` 不认。 */
const WORKER_BANNER = {
  js: "import { createRequire as __mcloudCreateRequire } from 'node:module';\nconst require = __mcloudCreateRequire(process.cwd() + '/');",
};

/** 两个 worker 的源码：一份写盘（多文件版），一份内嵌进每个入口（单文件版）。 */
async function workerSources() {
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
    banner: WORKER_BANNER,
  });
  return {
    http: readFileSync(join(ROOT, 'src/standalone/httpWorker.mjs'), 'utf8'),
    ws: wr.outputFiles[0].text,
  };
}

export async function bundleStandalone() {
  const workers = await workerSources();
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
      // 单文件版：worker 源码直接内嵌，运行时用 data: URL 起线程
      define: {
        __MCLOUD_HTTP_WORKER__: JSON.stringify(workers.http),
        __MCLOUD_WS_WORKER__: JSON.stringify(workers.ws),
      },
    });
    if (r.outputFiles.length !== 1) throw new Error(`${name}：期望 1 个产物，实际 ${r.outputFiles.length}`);
    out[name] = r.outputFiles[0].text;
  }
  out['httpWorker'] = workers.http;
  out['wsWorker'] = workers.ws;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await bundleStandalone();
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(all)) {
    if (name === 'httpWorker' || name === 'wsWorker') continue;
    const p = join(OUT, `${name}.mjs`);
    writeFileSync(p, text);
    if (name === 'mcloud-sign') chmodSync(p, 0o755);
    console.log(`  ✅ dist/standalone/${name}.mjs（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）`);
  }
  // 同步 WS / HTTP worker：**单文件版已经内嵌**；这里仍然写盘，给多文件分发/调试用。
  writeFileSync(join(OUT, 'wsWorker.mjs'), all.wsWorker);
  console.log(`  ✅ dist/standalone/wsWorker.mjs（${(Buffer.byteLength(all.wsWorker) / 1024).toFixed(1)} KB）`);
  writeFileSync(join(OUT, 'httpWorker.mjs'), all.httpWorker);
  console.log('  ✅ dist/standalone/httpWorker.mjs');
}
