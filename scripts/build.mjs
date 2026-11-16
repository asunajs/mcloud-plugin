// 打包：TS 源码 → **四个**可以被面板（panel-llrt）加载的单文件插件。
//
// # 唯一目标
//
// 老面板（rust-plugin-panel / 0.3.x）的产物**不再构建**（README 与清单里的 min_panel
// 早就写着"只面向 0.4"）。历史上那四份产物在 plugins/js/，已随 P1 删除；
// 要取回看 tag `legacy-0.4.2-sync`。
//
// # 为什么是四个插件
//
// 面板的分配单位是**插件**，不是任务：一个插件只有一条 JS 执行通道（`scheduler.rs` 的
// `Loaded.busy`）。所以「日常」那种一次跑几分钟的链和「直播」那种要连续占几分钟的听窗口
// 放在同一个插件里会互相拖。拆开之后四个插件各自独立调度。
//
// # 四个产物共用一份源码
//
// 协议层（`crypto/*`、`client`/`sign`/`envelope`/…）只写一遍，四个 entry 各自把
// 自己用到的那部分打进去。代价是总体积大一点，换来的是「改一处协议层，四个插件一起更新」。
//
// # 三个必须守住的点（写错了在面板里会以「莫名其妙」的方式失败）
//
//   1. **`panel:host` 是外部依赖** —— 它由面板的引擎注入，不是 npm 包。
//   2. **不许有 Node 内建依赖** —— 核心层在推理上要能跑在面板引擎里。
//      `platform:'neutral'` + tsconfig 的 `types: []` 两头堵。
//   3. **不 minify** —— 面板的「插件源码」页面会把产物显示给用户看（还能编辑）。

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 产物写本仓的 dist/panel-llrt/，由 `npm run deploy:panel` 装进实例。
// 要直连某个实例：PANEL_LLRT_PLUGINS=/path/to/plugins npm run build
const OUTDIR = process.env.PANEL_LLRT_PLUGINS ?? join(ROOT, 'dist', 'panel-llrt');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 四个入口。键是**插件名**（= 文件名去扩展名，面板据此认插件）。 */
export const ENTRIES = {
  mcloud: 'src/entries/mcloud.ts',
  'mcloud-daily': 'src/entries/daily.ts',
  'mcloud-exchange': 'src/entries/exchange.ts',
  'mcloud-live': 'src/entries/live.ts',
};

/** 产物里不该出现的东西。抽出来给 build 与 check-build 共用。 */
export function forbidden(text) {
  return ['process.env', 'Buffer.', 'require('].filter((bad) => text.includes(bad));
}

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
      // es2022（不是 es2020）：入口在加载期有顶层 await（配置同步）。
      target: 'es2022',
      platform: 'neutral',
      // panel:host 由面板注入（不是 npm 包）；
      // node:* 是**引擎内置**（LLRT 提供 node:fs / node:path 等），不打进产物。
      external: ['panel:host', 'node:*'],
      write: false,
      minify: false,
      legalComments: 'none',
      charset: 'utf8',
      banner: {
        js: [
          `// 由 ${entry} 打包生成 —— **不要手改这个文件**。`,
          '//',
          '//   改代码：编辑 src/，然后 `npm run build`',
          `//   mcloud-plugin ${pkg.version} · 插件 \`${name}\``,
        ].join('\n'),
      },
    });
    if (r.outputFiles.length !== 1) {
      throw new Error(`${name}：期望 1 个产物，实际 ${r.outputFiles.length}`);
    }
    out[name] = r.outputFiles[0].text;
  }
  return out;
}

/** 界面：plugins/mcloud/ → <产物目录>/mcloud.webui/ */
function copyWebui() {
  const uiSrc = join(ROOT, 'plugins/mcloud');
  const uiDst = join(OUTDIR, 'mcloud.webui');
  rmSync(uiDst, { recursive: true, force: true });
  cpSync(uiSrc, uiDst, { recursive: true });
  console.log(`  ✅ ${uiDst}/（界面）`);
}

/** 清单：面板读 plugins/<name>.panel.json 出配置表单、核对 min_panel。 */
function copyManifests() {
  for (const name of Object.keys(ENTRIES)) {
    const src = join(ROOT, 'plugins', 'panelllrt', `${name}.panel.json`);
    const dst = join(OUTDIR, `${name}.panel.json`);
    cpSync(src, dst);
    console.log(`  ✅ ${dst}`);
  }
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
    console.log(`  ✅ ${OUTDIR}/${name}.js（${kb.toFixed(1)} KB）`);
    const bad = forbidden(text);
    if (bad.length > 0) {
      console.error(`❌ ${name} 的产物里出现了面板里没有的东西：${bad.join('、')}`);
      process.exit(1);
    }
  }
  // 清掉另一种形状（目录式）的旧产物：面板发现插件时**先看 <name>.js**，
  // 两个都在不会报错，但"改了一份、面板读的是另一份"会非常难查。
  for (const name of Object.keys(ENTRIES)) {
    rmSync(join(OUTDIR, name), { recursive: true, force: true });
  }
  copyWebui();
  copyManifests();
  console.log(`✅ 打包完成：4 个插件，合计 ${total.toFixed(1)} KB`);
}

/** 兼容旧调用点（e2e/其它脚本里曾用 bundle() 拿单份产物）。 */
export async function bundle() {
  return (await bundleAll()).mcloud;
}
