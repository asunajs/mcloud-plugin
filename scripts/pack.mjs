#!/usr/bin/env node
/**
 * 打一个**面板能直接吃**的 zip。
 *
 * 面板的「插件管理 → 上传」接受 zip（`rust-plugin-panel/src/upload.rs`），
 * 解压规则是：
 *   · 相对 `PLUGINS_DIR` 展开（所以 zip 里就是 `js/…`、`mcloud/…`）；
 *   · 会剥掉**统一的外层目录**（`mcloud-plugin-0.1.0/js/…` 也行）；
 *   · 拒绝符号链接、拒绝任何以 `.` 开头的路径段（`.env` / `.git/…`）；
 *   · `.DS_Store` / `__MACOSX` / `._*` 会**跳过**（不算失败）；
 *   · 上限：总解压 64 MiB、单文件 32 MiB、2000 条目。
 *
 * 所以这个脚本只做一件事：把**运行时要的那几个文件**按那个形状装进 zip，
 * 然后**自己按同一套规则验一遍**（不是"打出来就完事"——上传被拒时才查就晚了）。
 *
 * 用法：
 *   node scripts/pack.mjs            # 写到 dist/
 *   node scripts/pack.mjs --out /tmp # 换个目录
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 运行时要的文件 —— **就这些**，多一个都别塞。
 *
 *  ⚠ 为什么刻意不带 `docs/`、`src/`、测试：zip 会被**解压到用户的插件目录里**，
 *    多带的东西不是"备着以后用"，而是躺在人家 PLUGINS_DIR 里的垃圾 ——
 *    面板还会去扫它（`plugins/js/*.js` 才算插件，但扫描是目录级的）。 */
const FILES = [
  'plugins/js/mcloud.js',
  'plugins/js/mcloud-daily.js',
  'plugins/js/mcloud-exchange.js',
  'plugins/js/mcloud-live.js',
  // 插件自带的前端：面板在 `/plugins/mcloud/` 下按名字找 `index.html`
  'plugins/mcloud/index.html',
  'plugins/mcloud/app.js',
  'plugins/mcloud/style.css',
];

/** zip 里的路径：去掉 `plugins/` 前缀（那就是 PLUGINS_DIR 本身）。 */
const entryName = (p) => p.replace(/^plugins\//, '');

/* ---------------- 最小 zip 写出器（不引依赖，产物可复现） ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name: string, data: Buffer}[]} entries */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // ⚠ 固定 DOS 时间戳（1980-01-01 00:00）：同一份输入打出**同一个字节流**，
  //   这样 release 里的 sha256 才可复现、可对比（默认用当前时间就做不到）。
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 9 });
    // 压不动就别压（STORE），否则小文件反而变大
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要的版本
    local.writeUInt16LE(0x0800, 6); // 名字是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // 内部属性
    cen.writeUInt32LE(0, 38); // 外部属性（不是符号链接：0）
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + body.length;
  }

  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

/* ---------------- 打之前先自检 ---------------- */

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outDir = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(ROOT, 'dist');
const zipPath = join(outDir, `mcloud-plugin-${version}.zip`);

// ① 文件都在、且是**刚构建**的（产物与源码一致由 `npm run check-build` 负责，
//    这里只防"忘了 build 就打包"这种更蠢的错）
for (const f of FILES) {
  if (!existsSync(join(ROOT, f))) die(`缺文件：${f}（先 npm run build）`);
}

const entries = FILES.map((rel) => ({ name: entryName(rel), data: readFileSync(join(ROOT, rel)) }));

// ② 名字要能在面板那边落地：没有 `.` 开头、没有 `..`、没有空段
for (const e of entries) {
  if (e.name.startsWith('/') || e.name.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    die(`zip 里有面板会拒绝的路径：${e.name}`);
  }
  if (e.name.split('/').some((s) => s.startsWith('.'))) {
    die(`zip 里不允许隐藏路径段（面板会拒）：${e.name}`);
  }
}

const zip = makeZip(entries);
const sum = createHash('sha256').update(zip).digest('hex');

mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });
writeFileSync(zipPath, zip);
writeFileSync(`${zipPath}.sha256`, `${sum}  ${`mcloud-plugin-${version}.zip`}\n`);
// 面板上传时按 `SHA256SUMS` 那个习惯贴一份总的，方便发布时一起传
writeFileSync(join(outDir, 'SHA256SUMS'), `${sum}  mcloud-plugin-${version}.zip\n`);

const total = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`✅ ${zipPath}`);
console.log(`   ${entries.length} 个文件，解压后 ${(total / 1024).toFixed(1)} KB，zip ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`   sha256 ${sum}`);
for (const e of entries) console.log(`   · ${e.name}  ${(e.data.length / 1024).toFixed(1)} KB`);
