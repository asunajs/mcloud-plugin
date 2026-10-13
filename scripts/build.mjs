// 打包：TS 源码 → 一个可以被面板加载的单文件插件。
//
// 为什么打包成单文件：面板现在**一个插件就是一个文件**（`plugins/js/<name>.js`）。
// 这是刻意的约束（插件的能力只能来自插件代码），所以不为了好看去动它 ——
// 源码这边保持多模块，产出一个文件。
//
// 三个必须守住的点（写错了在面板里会以「莫名其妙」的方式失败）：
//
//   1. **`host-api` 是外部依赖** —— 它由面板的 Resolver 提供，不是 npm 包。
//      忘了 external 的话 esbuild 会试图解析它并直接报错（这也是好事，早失败）。
//   2. **不许有 Node 内建依赖** —— 沙箱里没有 process/Buffer/fs/crypto/timers。
//      platform:'neutral' + tsconfig 里空 types 两头堵。
//   3. **不 minify** —— 面板的「插件源码」页面会把产物显示给用户看（还能编辑）。
//      压缩过的产物在那儿是一堵墙。体积对这个小东西不重要。

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'plugins/js/mcloud.js');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** @returns {Promise<string>} 打包结果（不写盘） */
export async function bundle() {
  const r = await build({
    entryPoints: [join(ROOT, 'src/main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    external: ['host-api'],
    write: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    banner: {
      js: [
        '// 由 src/**/*.ts 打包生成 —— **不要手改这个文件**。',
        '//',
        '//   改代码：编辑 src/，然后 `npm run build`',
        '//   只在构建产物上改动的东西，下一次构建就没了',
        `//   mcloud-plugin ${pkg.version}`,
      ].join('\n'),
    },
  });
  if (r.outputFiles.length !== 1) {
    throw new Error(`期望产出 1 个文件，实际 ${r.outputFiles.length} 个`);
  }
  return r.outputFiles[0].text;
}

// 直接运行时（`node scripts/build.mjs`）才写盘；被 check-build.mjs import 时不写
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await bundle();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
  console.log(`✅ 打包完成：plugins/js/mcloud.js（${kb} KB）`);
  // 顺手自检两条「打包出来才发现」的错
  for (const bad of ['process.env', 'Buffer.', 'require(']) {
    if (text.includes(bad)) {
      console.error(`❌ 产物里出现了沙箱没有的东西：${bad}`);
      process.exit(1);
    }
  }
}
