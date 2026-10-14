// 打包：TS 源码 → **四个**可以被面板加载的单文件插件。
//
// # 为什么是四个
//
// 面板的分配单位是**插件**，不是任务（见 rust-plugin-panel 的 `src/workers.rs`）：
// 一个插件里的所有任务跑在同一条线程上。所以「日常」那种一次跑几分钟的链
// 和「直播」那种要连续占几十秒的听窗口放在同一个插件里会互相拖。
//
// 拆开之后每个任务插件独占一条线程（`worker_hint('exclusive')`）。
// 详表见 `src/entries/shared.ts` 的文件头。
//
// # 四个产物共用一份源码
//
// 协议层（`crypto/*`、`client`/`sign`/`envelope`/…）只写一遍，四个 entry 各自把
// 自己用到的那部分打进去。代价是总体积大一点，换来的是「改一处协议层，
// 四个插件一起更新」—— 不会有版本漂移。
//
// # 三个必须守住的点（写错了在面板里会以「莫名其妙」的方式失败）
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
const OUTDIR = join(ROOT, 'plugins/js');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 四个入口。键是**插件名**（= 文件名去扩展名，面板据此认插件）。 */
export const ENTRIES = {
  mcloud: 'src/entries/mcloud.ts',
  'mcloud-daily': 'src/entries/daily.ts',
  'mcloud-exchange': 'src/entries/exchange.ts',
  'mcloud-live': 'src/entries/live.ts',
};

/**
 * 打包全部四个插件。
 * @returns {Promise<Record<string, string>>} 插件名 → 产物文本（不写盘）
 */
export async function bundleAll() {
  const out = {};
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const r = await build({
      entryPoints: [join(ROOT, entry)],
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
          `// 由 ${entry} 打包生成 —— **不要手改这个文件**。`,
          '//',
          '//   改代码：编辑 src/，然后 `npm run build`',
          '//   只在构建产物上改动的东西，下一次构建就没了',
          `//   mcloud-plugin ${pkg.version} · 插件 \`${name}\``,
        ].join('\n'),
      },
    });
    if (r.outputFiles.length !== 1) {
      throw new Error(`${name}：期望产出 1 个文件，实际 ${r.outputFiles.length} 个`);
    }
    out[name] = r.outputFiles[0].text;
  }
  return out;
}

/** 兼容旧调用：打包单个入口（默认 mcloud）。 */
export async function bundle() {
  return (await bundleAll()).mcloud;
}

/** 产物里不该出现的东西。抽出来给 build 和 check-build 共用。 */
export function forbidden(text) {
  return ['process.env', 'Buffer.', 'require('].filter((bad) => text.includes(bad));
}

// 直接运行时（`node scripts/build.mjs`）才写盘；被 check-build.mjs import 时不写
if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await bundleAll();
  mkdirSync(OUTDIR, { recursive: true });
  let total = 0;
  for (const [name, text] of Object.entries(all)) {
    writeFileSync(join(OUTDIR, `${name}.js`), text);
    const kb = Buffer.byteLength(text) / 1024;
    total += kb;
    console.log(`  ✅ plugins/js/${name}.js（${kb.toFixed(1)} KB）`);
    // 顺手自检两条「打包出来才发现」的错
    const bad = forbidden(text);
    if (bad.length > 0) {
      console.error(`❌ ${name} 的产物里出现了沙箱没有的东西：${bad.join('、')}`);
      process.exit(1);
    }
  }
  console.log(`✅ 打包完成：4 个插件，合计 ${total.toFixed(1)} KB`);
}
