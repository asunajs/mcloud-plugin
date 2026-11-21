// 手机号泄露门禁（2026-11-22）。
//
// # 为什么要有这条
//
// 之前几个仓里出现过「把真实号码零化成 `1XX0000YYYY`」的做法 —— 中间四位清零，
// **尾号还留着**。于是文档示例、测试夹具、更新日志里到处都是 `13800138000` / `1****2716`
// 这种，谁都能看出是哪个号；面板的 Release 说明里甚至直接带上了掩码后的 `138****8000`。
// 用户的原话：「真实账号的尾号也不行」。
//
// # 规则（强硬、白名单制）
//
// 任何 11 位手机号形状的字符串，**必须**是下面 ALLOW 里那几个"教科书假号"之一；
// 掩码形状（`138****8000`）的尾四位也必须在 ALLOW 的尾号集合里。
// 不在白名单就是**错误**（退出码 1），不是警告 —— 这类东西一旦进 git，就只能靠改历史收回。
//
// 另外：已知的真实尾号（DENTY_TAILS）**单独禁**，即使它出现在别的上下文里（比如
// 「尾号8000」这种散文）也算错 —— 尾号本身就是可识别信息。
//
// 用法（各仓 `npm run check` / 面板 `gate.sh` 里都会调）：
//
//     node scripts/check-phone-leak.mjs            # 扫 git 跟踪的文本文件
//     node scripts/check-phone-leak.mjs --all      # 连未跟踪的一起扫（提交前自查用）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：从脚本所在目录往上找 `.git`。
 *  ⚠ 不能写死 `..`：这份脚本在面板仓是 `tools/plugin-shared/`（根在上两级），
 *  在插件仓是 `scripts/`（根在上一级）—— 写死一个就有一边扫错目录（静默"全过"）。 */
function findRoot(start) {
  let d = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return start;
}

const ROOT = findRoot(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

/** 唯一允许出现的手机号（教科书假号，尾号互不相同、与任何真实账号无关）。 */
const ALLOW = [
  // 教科书假号
  '13800138000',
  '13700137001',
  '13600136002',
  '13900139003',
  '13500135004',
  // 各仓已用、形态一眼假的合成号（全 0 中段 / 顺号 / 重复号）——
  // 逐个列出来是**故意的**：白名单要能一眼审，别搞模式匹配，模式一松就漏。
  '13800000000', '13800000001', '13800000002', '13800000003',
  '13800000004', '13800000005', '13800000011', '13800000012',
  '13800000021', '13800000022', '13800001234',
  '13900000000', '13911112222', '13900139000',
  '19900000000', '19900000001', '19900000002', '19900199001',
  '19100000000', '15900000000',
  '13500135000', '13600136001',
];
const ALLOW_TAILS = new Set(ALLOW.map((n) => n.slice(-4)));

/** 已知的真实尾号：出现在任何地方都算泄露（连散文里的「尾号8000」也不行）。 */
const DENY_TAILS = ['7542', '2716', '4979'];

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.ts', '.tsx', '.json', '.txt', '.yml', '.yaml', '.sh', '.css', '.html',
]);
/** 这些目录是构建产物/依赖，不扫（它们要么来自源码，要么不是我们的文本）。 */
const SKIP_DIR = /(^|\/)(node_modules|dist|release|target|\.git|data|\.tmp)\//;

function listFiles() {
  const all = process.argv.includes('--all');
  if (all) {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT, encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  }
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const files = listFiles().filter((f) => TEXT_EXT.has(extname(f)) && !SKIP_DIR.test(`${f}/`));
const bad = [];

for (const f of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // ① 完整 11 位号码：必须在白名单
    for (const m of line.matchAll(/(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g)) {
      const n = m[0];
      if (!ALLOW.includes(n)) bad.push([f, i + 1, `完整号码 ${n}`, '不在白名单里']);
    }
    // ② 掩码形状：尾四位必须在白名单尾号里
    for (const m of line.matchAll(/(?<![0-9])(1[0-9]{2})\*{2,8}([0-9]{4})(?![0-9])/g)) {
      const tail = m[2];
      if (!ALLOW_TAILS.has(tail)) bad.push([f, i + 1, `掩码 ${m[0]}`, `尾号 ${tail} 不在白名单里`]);
    }
    // ③ 已知真实尾号：任何位置都算
    for (const t of DENY_TAILS) {
      const re = new RegExp(`(?<![0-9])${t}(?![0-9])`);
      if (re.test(line)) bad.push([f, i + 1, `真实尾号 ${t}`, '尾号本身就可识别，不能出现在仓里']);
    }
  }
}

if (bad.length === 0) {
  console.log(`ok: 没有手机号泄露（扫了 ${files.length} 个文本文件；白名单 ${ALLOW.length} 个假号）`);
  process.exit(0);
}

console.error(`✗ 发现 ${bad.length} 处手机号泄露：\n`);
for (const [f, ln, what, why] of bad.slice(0, 40)) {
  console.error(`  ${relative(ROOT, join(ROOT, f))}:${ln}  ${what} —— ${why}`);
}
if (bad.length > 40) console.error(`  …还有 ${bad.length - 40} 处`);
console.error(`
改法：一律换成白名单里的教科书假号（${ALLOW.slice(0, 3).join(' / ')} …），
**不要**用「真号中间清零、留尾号」那种写法 —— 尾号就是可识别信息。
真号只允许留在本机 data/（已被 gitignore），仓里一个字都不能有。
`);
process.exit(1);
