// 「产物是最新的吗」—— CI 里的那条闸门。
//
// 为什么要有这个：面板加载的是**产物**，不是源码（`dist/` 是 gitignore 的，不进仓库，
// 所以这里比的是"刚打出来的"与"工作区里那份"——防的是"忘了重新构建就部署/打包"）。
// 只跑 typecheck/test 的话，完全可以出现「源码改了、忘了重新构建」——
// 测试全绿、CI 全绿，而面板加载的还是旧逻辑。这类错最贵的版本是
// 「修了 bug 但没生效」，然后在真机上排查半天。
//
// 做法：重新打包一次，跟 dist/panel-llrt 里那四份逐字节比。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, bundleAll, forbidden } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, 'dist', 'panel-llrt');

const fresh = await bundleAll();
let bad = 0;

for (const name of Object.keys(ENTRIES)) {
  const out = join(OUTDIR, `${name}.js`);
  if (!existsSync(out)) {
    console.error(`❌ dist/panel-llrt/${name}.js 不存在 —— 先跑 \`npm run build\` 并提交产物`);
    bad++;
    continue;
  }
  const committed = readFileSync(out, 'utf8');

  // 面板里没有的东西 —— 单查这一条，因为它比「产物过期」更隐蔽
  const no = forbidden(committed);
  if (no.length > 0) {
    console.error(`❌ ${name}：产物里出现了面板里没有的东西：${no.join('、')}`);
    bad++;
    continue;
  }

  if (committed === fresh[name]) {
    console.log(`  ✅ ${name}：产物与源码一致`);
    continue;
  }

  // 指出第一处差异在哪一行，别让人自己 diff 一万行
  const a = committed.split('\n');
  const b = fresh[name].split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
  console.error(`❌ ${name}：提交的产物与源码不一致 —— 源码改了但没重新构建。`);
  console.error(`   第一个不同的位置：第 ${line + 1} 行`);
  console.error(`   提交的: ${(a[line] ?? '<无这一行>').slice(0, 100)}`);
  console.error(`   新构建: ${(b[line] ?? '<无这一行>').slice(0, 100)}`);
  bad++;
}

if (bad > 0) {
  console.error(`\n❌ ${bad} 个插件有问题。修：\`npm run build\` 然后把 dist/panel-llrt/*.js 一起提交。`);
  process.exit(1);
}
console.log('✅ 四个产物都与源码一致（没忘了重新构建）');
