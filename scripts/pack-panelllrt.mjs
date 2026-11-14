// 打一个 **panel-llrt（0.4）形状** 的发布包。
//
// 和 `pack.mjs` 的区别是**形状不同**，不是版本不同：
//   · 0.3 老面板：`js/mcloud.js` + `mcloud/index.html`（插件在 `js/` 子目录，界面按插件名找）
//   · 0.4 面板：  `mcloud.js` + `mcloud.panel.json` + `mcloud.webui/`（全部平铺在 PLUGINS_DIR 顶层）
//
// 为什么必须平铺：0.4 的加载器只扫 `plugins/*.js`，清单读 `plugins/<name>.panel.json`，
// 界面读 `plugins/<name>.webui/`。塞进 `js/` 子目录就等于「装了但面板看不见」。
//
// 产物：dist/mcloud-plugin-<version>-panel04.zip（+ .sha256、SHA256SUMS）
// 这是发布给商店的资产；本地装实例还是走 `npm run deploy:panel`（不经过 zip）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeZip } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'panel-llrt');

/** 0.4 形状要的文件：全部平铺在 zip 根。 */
const PLUGINS = ['mcloud', 'mcloud-daily', 'mcloud-exchange', 'mcloud-live'];
/** 界面只有一份（mcloud 的服务界面；另外三个是纯任务插件，共用这一份）。 */
const WEBUI_FILES = ['index.html', 'style.css', 'app.js', 'boot.js'];

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const zipName = `mcloud-plugin-${version}-panel04.zip`;
const outDir = join(ROOT, 'dist');
const zipPath = join(outDir, zipName);

// ① 产物得是**刚构建**的：先 npm run build:panelllrt
const files = [];
for (const n of PLUGINS) {
  for (const f of [`${n}.js`, `${n}.panel.json`]) {
    const p = join(DIST, f);
    if (!existsSync(p)) die(`缺 ${f}（先 npm run build:panelllrt）`);
    files.push({ name: f, path: p });
  }
}
for (const f of WEBUI_FILES) {
  const p = join(DIST, 'mcloud.webui', f);
  if (!existsSync(p)) die(`缺 mcloud.webui/${f}（先 npm run build:panelllrt）`);
  files.push({ name: `mcloud.webui/${f}`, path: p });
}

// ② 形状自检：不许有子目录前缀（除了 webui），不许隐藏段
for (const f of files) {
  if (f.name.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    die(`zip 里有面板会拒绝的路径：${f.name}`);
  }
  if (f.name.split('/').some((s) => s.startsWith('.'))) {
    die(`zip 里不允许隐藏路径段（面板会拒）：${f.name}`);
  }
}
for (const n of PLUGINS) {
  if (!files.some((f) => f.name === `${n}.js`)) die(`${n}.js 不在包根目录（0.4 要求平铺）`);
}

const entries = files.map((f) => ({ name: f.name, data: readFileSync(f.path) }));
const zip = makeZip(entries);
const sum = createHash('sha256').update(zip).digest('hex');

mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });
writeFileSync(zipPath, zip);
writeFileSync(`${zipPath}.sha256`, `${sum}  ${zipName}\n`);
writeFileSync(join(outDir, 'SHA256SUMS'), `${sum}  ${zipName}\n`);

const total = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`✅ ${zipPath}`);
console.log(
  `   ${entries.length} 个文件，解压后 ${(total / 1024).toFixed(1)} KB，zip ${(zip.length / 1024).toFixed(1)} KB`,
);
console.log(`   sha256 ${sum}`);
for (const e of entries) console.log(`   · ${e.name}  ${(e.data.length / 1024).toFixed(1)} KB`);
