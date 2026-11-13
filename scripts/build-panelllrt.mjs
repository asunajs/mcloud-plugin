// 打包给 **panel-llrt** 的版本。
//
// 和 build.mjs 的区别只有一处：`host-api` 不再 external，而是用
// `src/panelllrt/hostApi.ts` 顶替（esbuild 的 alias）。那个文件把旧面板的同步契约
// 实现到新面板的能力上（同步 op + register_web + __handlers）。
// `panel:host` 保持 external —— 它由新面板的引擎注入。
//
// 产物直接写到 panel-llrt/plugins/：<name>.js + mcloud.webui/（界面）。

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = join(ROOT, 'src/panelllrt/hostApi.ts');
const OUTDIR = process.env.PANEL_LLRT_PLUGINS ?? join(ROOT, '..', 'panel-llrt', 'plugins');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

async function bundleOne(name, entry) {
  const r = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    // panel:host 由新面板注入；host-api 换成适配层
    external: ['panel:host'],
    alias: { 'host-api': ADAPTER },
    write: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    banner: {
      js: [
        `// 由 ${entry} 打包生成（panel-llrt 版）—— **不要手改这个文件**。`,
        '//',
        '//   改代码：编辑 src/，然后 `npm run build:panelllrt`',
        `//   mcloud-plugin ${pkg.version} · 插件 \`${name}\``,
      ].join('\n'),
    },
  });
  if (r.outputFiles.length !== 1) {
    throw new Error(`${name}：期望 1 个产物，实际 ${r.outputFiles.length}`);
  }
  return r.outputFiles[0].text;
}

mkdirSync(OUTDIR, { recursive: true });
let total = 0;
for (const [name, entry] of Object.entries(ENTRIES)) {
  const text = await bundleOne(name, entry);
  writeFileSync(join(OUTDIR, `${name}.js`), text);
  const kb = Buffer.byteLength(text) / 1024;
  total += kb;
  console.log(`  ✅ ${OUTDIR}/${name}.js（${kb.toFixed(1)} KB）`);
  for (const bad of ['process.env', 'Buffer.', 'require(']) {
    if (text.includes(bad)) {
      console.error(`❌ ${name} 的产物里出现了沙箱没有的东西：${bad}`);
      process.exit(1);
    }
  }
}

// 界面：plugins/mcloud/ → <插件目录>/mcloud.webui/
//
// ⚠ **只有一份界面源**（不再维护 0.3.x 兼容版，2026-11-13 用户口径「不需要老面板兼容」）。
//   这份源已经是 panel-llrt（0.4.x）的形状：`<head>` 引面板的 `/app.css`（token + 组件的
//   唯一来源）、token 映射是「旧名 → 0.4.0」（`--text: var(--fg)`，写反就整页塌）、
//   `boot.js` 自己挂 `data-theme`、`?diag=1` 自检 + `--style-ver`。
//   准则见技能 `panel-plugin-ui` 与面板仓 `scripts/check-plugin-style.mjs`。
const uiSrc = join(ROOT, 'plugins/mcloud');
const uiDst = join(OUTDIR, 'mcloud.webui');
rmSync(uiDst, { recursive: true, force: true });
cpSync(uiSrc, uiDst, { recursive: true });
console.log(`  ✅ ${uiDst}/（界面）`);

console.log(`✅ panel-llrt 版打包完成：4 个插件，合计 ${total.toFixed(1)} KB`);
