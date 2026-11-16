#!/usr/bin/env node
// 分层与污染门禁（R1–R4）。
//
// 这些规则写进文档只是"一张纸"，而**每一轮重构都会有人随手 import 一下**：
// 业务层 import 宿主、路由 import 面板、某个文件又去摸 globalThis……
// 每一次都不报错，直到某天"在面板里对、在 CLI 里错"或反过来。
// 所以它们是**可执行的**：npm run all 与 CI 都会跑这一条。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const problems = [];
const rel = (p) => relative(ROOT, p);

/** 只看**代码**：注释里提到这些名字是解释，不算违规。 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

for (const file of files) {
  const r = rel(file);
  const raw = readFileSync(file, 'utf8');
  const src = code(raw);

  // R1：只有 host/panel 能 import 'panel:host'
  if (/from\s+'panel:host'/.test(src) && !r.startsWith('src/host/panel/')) {
    problems.push(`R1 ${r}：只有 src/host/panel/* 能 import 'panel:host'`);
  }

  // R2：只有 host/panel/task.ts 能写 __handlers（impl.ts 提供那个表，也算宿主层）
  if (/__handlers/.test(src) && !r.startsWith('src/host/panel/')) {
    problems.push(`R2 ${r}：只有 src/host/panel/* 能碰 __handlers`);
  }

  // R4：旧契约不许再出现
  if (/from\s+'host-api'/.test(src)) {
    problems.push(`R4 ${r}：还在 import 'host-api'（旧面板契约，已删）`);
  }

  // R3：领域层（src/mcloud）与编排层（src/app）不许反向依赖宿主/入口，
  //     也不许用 Node/引擎专有物。
  //
  //     src/app/routes/ 是路由（P5 从 3400 行的 mcloud/routes.ts 拆出来的）：
  //     它跟领域层一样**不知道宿主存在** —— 依赖由 `RouteDeps` 注进来。
  if (r.startsWith('src/mcloud/') || r.startsWith('src/app/')) {
    for (const forbidden of ["'../host/", "'../../host/", "'../../../host/", "'../entries/", "'../../entries/", "'../../../entries/", "'panel:host'"]) {
      if (src.includes(`from ${forbidden}`)) {
        problems.push(`R3 ${r}：领域层不许 import ${forbidden.replace("'", '')}`);
      }
    }
    if (/\bfrom\s+'node:/.test(src)) {
      problems.push(`R3 ${r}：领域层不许 import node:*（面板引擎里没有）`);
    }
    // 领域层也不许用 Node/引擎专有的全局（面板引擎里没有，写了在真机才炸）
    for (const bad of ['Buffer', 'process.', 'setTimeout', 'setInterval', 'require(']) {
      if (src.includes(bad)) {
        problems.push(`R3 ${r}：领域层不许用 ${bad}（面板引擎里没有）`);
      }
    }
  }

  // R6：FileStore 只能用 LLRT 也有的 fs 子集（面板与 Node 都能跑）
  if (r.startsWith('src/host/fs/')) {
    for (const bad of ['existsSync', 'openSync', 'closeSync', 'unlinkSync', 'copyFileSync', 'createReadStream']) {
      if (new RegExp(`\\b${bad}\\b`).test(src)) {
        problems.push(`R6 ${r}：用了 LLRT 没有的 fs.${bad}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('❌ 分层门禁没过：');
  for (const p of problems) console.error('   · ' + p);
  console.error('\n规则见 docs/architecture.md §2（R1–R6）。');
  process.exit(1);
}
console.log(`✅ 分层门禁通过（${files.length} 个文件）`);
