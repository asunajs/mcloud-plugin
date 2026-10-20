// 独立产物自检：存在、CLI 可执行、没有把 WebUI/面板路由打进去。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist/standalone');
const files = ['mcloud-sign.mjs', 'daily.mjs', 'exchange.mjs', 'redflower.mjs', 'wsWorker.mjs', 'httpWorker.mjs'];
let bad = 0;
for (const f of files) {
  const p = join(OUT, f);
  if (!existsSync(p)) {
    console.error(`❌ 缺少 ${f}`);
    bad++;
  }
}
const cli = join(OUT, 'mcloud-sign.mjs');
if (existsSync(cli)) {
  const text = readFileSync(cli, 'utf8');
  if (!text.startsWith('#!/usr/bin/env node')) {
    console.error('❌ mcloud-sign.mjs 缺 shebang');
    bad++;
  }
  for (const marker of ['plugins/mcloud', 'register_nav({']) {
    if (text.includes(marker)) {
      console.error(`❌ 独立产物里不该有 ${marker}`);
      bad++;
    }
  }
  if (!text.includes('mcloud-sign') && !text.includes('日常')) {
    console.error('❌ 产物看起来不是 mcloud-sign');
    bad++;
  }
}
if (existsSync(cli) && process.platform !== 'win32') {
  const mode = statSync(cli).mode & 0o777;
  if ((mode & 0o100) === 0) {
    console.error('❌ mcloud-sign.mjs 没有可执行位');
    bad++;
  }
}
if (bad > 0) process.exit(1);
console.log('✅ 独立产物检查通过（mcloud-sign + daily/exchange/redflower + http/ws worker）');
