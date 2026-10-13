// 「产物是最新的吗」—— CI 里的那条闸门。
//
// 为什么要有这个：产物是**提交进仓库**的（面板加载的是它，不是源码）。
// 只跑 typecheck/test 的话，完全可以出现「源码改了、忘了重新构建」——
// 测试全绿、CI 全绿，而面板加载的还是旧逻辑。这类错最贵的版本是
// 「修了 bug 但没生效」，然后在真机上排查半天。
//
// 做法：重新打包一次，跟工作区里那份逐字节比。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'plugins/js/mcloud.js');

if (!existsSync(OUT)) {
  console.error('❌ plugins/js/mcloud.js 不存在 —— 先跑 `npm run build` 并提交产物');
  process.exit(1);
}

const committed = readFileSync(OUT, 'utf8');
const fresh = await bundle();

if (committed === fresh) {
  console.log('✅ 产物与源码一致（没忘了重新构建）');
  process.exit(0);
}

// 指出第一处差异在哪一行，别让人自己 diff 一万行
const a = committed.split('\n');
const b = fresh.split('\n');
let line = 0;
while (line < a.length && line < b.length && a[line] === b[line]) line += 1;

console.error('❌ 提交的产物与源码不一致 —— 源码改了但没重新构建。');
console.error(`   第一个不同的位置：第 ${line + 1} 行`);
console.error(`   提交的: ${(a[line] ?? '<无这一行>').slice(0, 100)}`);
console.error(`   新构建: ${(b[line] ?? '<无这一行>').slice(0, 100)}`);
console.error('   修：`npm run build` 然后把 plugins/js/mcloud.js 一起提交。');
process.exit(1);
