// 目录式插件打包：**四个插件共用一份核心**（P7）。
//
//     dist/panel-llrt/
//       mcloud/
//         index.js                  ← 两行：import './lib/entries/mcloud.js'
//         lib/…                     ← 整份核心（编译后的 ESM，模块边界保留）
//       mcloud-daily/index.js       ← import '../mcloud/lib/entries/daily.js'
//       mcloud-exchange/index.js
//       mcloud-live/index.js
//       mcloud.webui/  + 4 份 *.panel.json
//
// 为什么这么做：单文件产物是"四个包各自内联一份核心"（合计 1.3 MB，改一处协议层要验四份）。
// 目录式插件让四个入口**import 同一份文件**，栈里也是真实文件名/行号。
//
// ⚠ 前置：面板要支持 `plugins/<name>/index.js` + 相对 import（panel-llrt 的"多文件插件"）。
//   装机那份二进制比这个能力早 22 秒（见 docs/architecture.md），要重装。
//   没这个能力时用 `npm run build`（单文件），功能一致。

import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, forbidden } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = process.env.PANEL_LLRT_PLUGINS ?? join(ROOT, 'dist', 'panel-llrt');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 要编进 lib/ 的源码：整份核心，但**排除**只属于 Node CLI 的部分。 */
const LIB_BASE = 'src';

/** 相对 import 的说明符里带 `.ts`（源码为了 `node --test` 的类型剥离必须这么写），
 *  产物必须是 `.js`。面板的 Resolver 两种都认（没写扩展名会补 .js），
 *  这里显式改成 .js：产物自己就是自解释的，不依赖宿主的补全规则。 */
function rewriteSpecifiers(text) {
  return (
    text
      .replace(/(from\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
      .replace(/(import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
      // 副作用形式的 `import "../x.ts";` —— 这是"绑定的值一个都没用到"（只用在类型位置）
      // 时 esbuild 留在产物里的形状。它照样要改成 .js：留着 .ts 面板就报
      // 「import 的文件不存在：../mcloud/accounts.ts」（2026-11-16 真撞到过）。
      .replace(/(\n\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
  );
}

function must(cond, msg) {
  if (!cond) {
    console.error('❌ ' + msg);
    process.exit(1);
  }
}

/** 要编的源文件：整份核心，但排除只属于 Node CLI 的部分与 .d.ts。 */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'standalone' || name === 'cli') continue; // CLI 专属，不进插件
      out.push(...sources(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

console.log('→ 编译核心（自己的模块保持文件边界，npm 包就地内联）');
const res = await build({
  entryPoints: sources(join(ROOT, LIB_BASE)),
  outdir: join(OUTDIR, 'mcloud', 'lib'),
  outbase: LIB_BASE,
  // ⚠ 这里必须是 **bundle:true + 把相对 import 全部标成 external**：
  //   面板不解析 npm 包（`import { unzlibSync } from 'fflate'` 会以
  //   "Error resolving module 'fflate'" 挂在加载期 —— 2026-11-16 真撞到过），
  //   而我们的**自己人**要留成一个个文件（四个插件才共用得上、栈里才有真实文件名）。
  //   bundle:false 做不到这一点：它连 npm 包也不解析。
  bundle: true,
  plugins: [
    {
      name: 'keep-own-modules',
      setup(b) {
        // 相对路径 = 我们自己人：原样留着（后面再把 .ts 改写成 .js）
        b.onResolve({ filter: /^\.{1,2}\// }, (a) => ({ path: a.path, external: true }));
      },
    },
  ],
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  external: ['panel:host', 'node:*'],
  write: false,
  minify: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  // 只编面板要跑的那部分（CLI 的 src/standalone 与 src/cli 不进插件）
  entryNames: '[dir]/[name]',
});

let written = 0;
let bytes = 0;
for (const f of res.outputFiles) {
  const rel = relative(join(OUTDIR, 'mcloud', 'lib'), f.path);
  if (rel.split(/[\\/]/).includes('standalone') || rel.startsWith('cli/')) continue;
  if (rel.endsWith('.d.ts')) continue;
  const text = rewriteSpecifiers(f.text);
  const bad = forbidden(text);
  must(bad.length === 0, `${rel} 里出现了面板没有的东西：${bad.join('、')}`);
  const dst = join(OUTDIR, 'mcloud', 'lib', rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  written += 1;
  bytes += Buffer.byteLength(text);
}
console.log(`  ✅ mcloud/lib/：${written} 个模块（${(bytes / 1024).toFixed(1)} KB）`);

// 四个入口：mcloud 自己就是核心所在目录，另三个 import 过去。
for (const [name, entry] of Object.entries(ENTRIES)) {
  const target = entry.replace(/^src\//, '').replace(/\.ts$/, '.js');
  const lines = [
    `// 由 ${entry} 打包生成 —— **不要手改这个文件**。`,
    '//',
    '//   改代码：编辑 src/，然后 `npm run build:dir`',
    '//   mcloud-plugin ' + pkg.version + ' · 插件 `' + name + '`',
    '',
    name === 'mcloud' ? `import './lib/${target}';` : `import '../mcloud/lib/${target}';`,
    '',
  ];
  const dir = join(OUTDIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), lines.join('\n'));
}

// 清掉另一种形状（单文件）的旧产物 —— 面板先看 <name>.js，留着就会读错那份
for (const name of Object.keys(ENTRIES)) {
  rmSync(join(OUTDIR, `${name}.js`), { force: true });
}

// 界面 + 清单（与单文件产物同一份源）
const uiDst = join(OUTDIR, 'mcloud.webui');
rmSync(uiDst, { recursive: true, force: true });
cpSync(join(ROOT, 'plugins/mcloud'), uiDst, { recursive: true });
for (const name of Object.keys(ENTRIES)) {
  cpSync(join(ROOT, 'plugins', 'panelllrt', `${name}.panel.json`), join(OUTDIR, `${name}.panel.json`));
}
console.log('  ✅ mcloud.webui/ + 4 份清单');
console.log('✅ 目录式产物完成（四个插件 import 同一份 lib/）');
