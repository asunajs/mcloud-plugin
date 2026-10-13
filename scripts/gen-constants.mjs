// 生成 src/crypto/tables.ts —— SHA-2 的常量表。
//
// 为什么不直接在源码里用「浮点技巧」现算（那 64 个 K 常量是前 64 个素数立方根的小数部分）：
//
//   Math.cbrt(p) 的双精度相对误差约 1e-16，乘上 2^32 之后绝对误差约 5e-7 ——
//   只要真实值离某个整数在 5e-7 之内，Math.floor 就会差 1，哈希全盘错。
//   MD5 那张表（sin 生成）在工程上被验证过是安全的，SHA-2 的 K 我不想赌。
//
// 所以用 **BigInt 精确算**（整数开方用牛顿迭代），生成 TS 源码提交进仓库。
// CI 里 `npm run gen` 之后 diff 必须为空 —— 常量可复现，不是手抄的魔数。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 精确的整数 n 次方根向下取整：返回 floor(n ** (1/k))，用牛顿法迭代到收敛 */
function iroot(n, k) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(Number(n.toString(2).length) / k) + 1);
  for (;;) {
    // x' = ((k-1)*x + n / x^(k-1)) / k
    const xk1 = x ** BigInt(k - 1);
    const next = (BigInt(k - 1) * x + n / xk1) / BigInt(k);
    if (next >= x) break;
    x = next;
  }
  // 收敛后再夹一次，防止边界差 1
  while (x ** BigInt(k) > n) x -= 1n;
  while ((x + 1n) ** BigInt(k) <= n) x += 1n;
  return x;
}

function firstPrimes(count) {
  const out = [];
  for (let n = 2; out.length < count; n += 1) {
    let prime = true;
    for (let d = 2; d * d <= n; d += 1) {
      if (n % d === 0) { prime = false; break; }
    }
    if (prime) out.push(n);
  }
  return out.map((p) => BigInt(p));
}

const M32 = 1n << 32n;
const primes = firstPrimes(64);

// K[i] = floor(frac(cbrt(prime_i)) * 2^32) —— 立方根小数部分的高 32 位
const K = primes.map((p) => Number((iroot(p * M32 ** 3n, 3) % M32)));
// H = floor(frac(sqrt(prime_i)) * 2^32)
const H = primes.slice(0, 8).map((p) => Number(iroot(p * M32 ** 2n, 2) % M32));

const hex = (n) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

function chunk(name, arr, perLine) {
  const lines = [];
  for (let i = 0; i < arr.length; i += perLine) {
    lines.push('  ' + arr.slice(i, i + perLine).map(hex).join(', ') + ',');
  }
  return `export const ${name}: readonly number[] = [\n${lines.join('\n')}\n];\n`;
}

// SHA-224 的初值用的是第 9..16 个素数（这里一并生成，将来要用就有）
const H224 = primes.slice(8, 16).map((p) => Number(iroot(p * M32 ** 2n, 2) % M32));

const out = `// 由 scripts/gen-constants.mjs 生成 —— 不要手改。
// 复现：npm run gen（CI 会检查生成结果与提交的一致）
//
// K[i]  = floor(frac(cbrt(prime_i)) * 2^32)   —— SHA-224/256 的轮常量
// H[i]  = floor(frac(sqrt(prime_i)) * 2^32)   —— SHA-256 的初值
// H224  = 同上，取第 9..16 个素数                —— SHA-224 的初值

${chunk('SHA256_K', K, 4)}
${chunk('SHA256_H', H, 8)}
${chunk('SHA224_H', H224, 8)}`;

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/crypto/tables.ts');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`✅ 生成 src/crypto/tables.ts（K[0]=${hex(K[0])}, H[0]=${hex(H[0])}）`);

// 自检：前几个值必须等于公开标准里的那几个（写错的话这里先炸，不用等哈希测试）
const KNOWN = { k0: 0x428a2f98, k1: 0x71374491, h0: 0x6a09e667, h7: 0x5be0cd19 };
const ok =
  (K[0] >>> 0) === KNOWN.k0 && (K[1] >>> 0) === KNOWN.k1 &&
  (H[0] >>> 0) === KNOWN.h0 && (H[7] >>> 0) === KNOWN.h7;
if (!ok) {
  console.error('❌ 生成结果与公开标准不符 —— 生成逻辑有问题，别提交');
  process.exit(1);
}
console.log('✅ 与公开标准的前几个值一致');
