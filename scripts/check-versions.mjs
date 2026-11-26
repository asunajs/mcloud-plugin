// 「版本号三处一致吗」—— AGENTS.md 里一直写着"构建期校验"，但**其实没有这道检查**。
//
// 要一致的四类：
//   · `package.json` 的 `version`（打 zip 的名字、`npm version` 改的是它）
//   · `src/version.ts` 的 `PLUGIN_VERSION`（插件在 `/readings` 里报给界面的那个）
//   · `mcloud.panel.json` 的 `version`（面板插件列表/货架卡片显示的那个）
//   · `plugins/mcloud-{daily,exchange,live}.panel.json` 的 `version`
//
// 不一致的后果不是"报错"，是**三个地方各说一个版本**：货架写 0.7.5、插件页印 0.7.6、
// zip 叫 0.7.6 —— 排查时第一句就会问"我到底装的是哪版"，而谁也答不上来。
//
// 用法：`node scripts/check-versions.mjs`（`npm run all` 与 CI 都跑）

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const want = String(pkg.version ?? '');
if (!/^\d+\.\d+\.\d+$/.test(want)) {
  console.error(`❌ package.json 的 version 不是 x.y.z：${JSON.stringify(pkg.version)}`);
  process.exit(1);
}

/** 收集 `{ 来源: 版本 }`，逐条与 package.json 比。 */
const found = [];
const add = (from, got) => found.push({ from, got: String(got ?? '') });

const verTs = readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8');
const m = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(verTs);
add('src/version.ts', m ? m[1] : '<没找到 PLUGIN_VERSION>');

add('mcloud.panel.json', JSON.parse(readFileSync(join(ROOT, 'mcloud.panel.json'), 'utf8')).version);
for (const f of readdirSync(join(ROOT, 'plugins'))) {
  if (!f.endsWith('.panel.json')) continue;
  add(`plugins/${f}`, JSON.parse(readFileSync(join(ROOT, 'plugins', f), 'utf8')).version);
}

const bad = found.filter((x) => x.got !== want);
if (bad.length > 0) {
  console.error(`❌ 版本号不一致（以 package.json 的 ${want} 为准）：`);
  for (const x of bad) console.error(`   ${x.from}: ${JSON.stringify(x.got)}`);
  console.error('\n修：把上面这些改成同一个版本号（发版时四处一起改）。');
  process.exit(1);
}
console.log(`✅ 版本号四处一致：${want}（package.json / src/version.ts / ${found.length - 1} 份清单）`);
