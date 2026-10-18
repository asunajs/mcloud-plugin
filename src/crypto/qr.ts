// 二维码编码器（字节模式，版本 1–10，纠错级 L）。
//
// # 为什么要自己写一个
//
// 扫码登录的载荷是一条 ~110 字符的 URL，用户要用**手机上的移动云盘 App** 扫它。
// 所以"码对不对"直接等于"这个功能能不能用"。
//
// 参考实现（Rust 那边）用的是 `qrcode` crate，**在服务端编码、前端只负责显示**。
// 那个分工的理由在这里同样成立，而且更强：前端里没有任何二维码库，
// 在浏览器里现写一个编码器等于把"码对不对"交给前端；而**插件这一侧本来就是
// 那个"服务端"** —— 路由返回矩阵，`app.js` 只画格子。
//
// # 支持到哪、为什么
//
// 载荷最长的是扫码那条（`https://yun.139.com/w/#/qrcLogin?dID=<32hex>-ENDIN&
// sID=<32hex>&cType=11&ver=8.8.6.20260829`），约 110 字节。
// 纠错级 L 下版本 6 能装 134 字节 —— 所以支持 1–10 有足够余量。
//
// 纠错级取 **L**（最低）：二维码是给同一间屋子里的手机扫的，不是印在纸上
// 风吹日晒。取高纠错级只会让码变大、格子变密，反而更难扫。
//
// # 没有做的（如实写出来，不假装）
//
// - 数字 / 字母数字 / 汉字模式（只做字节模式；URL 用字节模式是对的）
// - 版本 11+（需要更大的 RS 块表，而我们用不到）
// - 结构化追加
//
// 这些都不是"以后再补"，而是**按需**：载荷变了再补，现在补等于写没有测试的代码。

import { utf8 } from './bytes.ts';

// ══════════════════════════════ GF(256) 与 Reed-Solomon ══════════════════════════════

/** GF(2^8) 的乘法（本原多项式 0x11d —— **不是** AES 的 0x11b）。 */
function gfMul(a: number, b: number): number {
  let r = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  while (y > 0) {
    if (y & 1) r ^= x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
    y >>= 1;
  }
  return r & 0xff;
}

/** `α^i`（GF(2^8)，本原多项式 0x11d）。
 *
 *  ⚠ 这里**不能**图省事写 `Math.pow(2, i) & 0xff`：`i ≥ 8` 时 `2^i` 已经超出
 *  8 位，与 `0xff` 相与得 **0**，于是 `α^8 … α^(n-1)` 全变成 0 ——
 *  生成多项式退化成"多带一个 x 因子"，算出来的纠错码字整段是错的。
 *
 *  它的表现不是报错、也不是"看着不像二维码"，而是**手机扫不出来**：
 *  只影响纠错码字个数 > 8 的版本（v1 是 7 个，所以 v1 恰好是对的 ——
 *  这也是它能骗过"肉眼看着像"和"自己往返自洽"的原因，见 `docs/findings.md` F-068）。 */
function gfExp(i: number): number {
  let r = 1;
  for (let k = 0; k < i; k += 1) r = gfMul(r, 2);
  return r;
}

/** 生成多项式 `(x-α^0)(x-α^1)…(x-α^(n-1))`，系数从最高次到常数项。
 *
 *  导出是给测试用的：它的 α 指数要逐项对上规范 Annex A 公布的那张表。 */
export function rsGenerator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      const coef = poly[j]!;
      next[j] = next[j]! ^ coef;
      next[j + 1] = next[j + 1]! ^ gfMul(coef, gfExp(i));
    }
    poly = next;
  }
  return poly;
}

/** 算 n 个 RS 纠错码字。 */
function rsEncode(data: number[], n: number): number[] {
  const gen = rsGenerator(n);
  const out = new Array<number>(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.shift();
    out.push(0);
    for (let i = 0; i < n; i += 1) out[i] = out[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return out;
}

// ══════════════════════════════ 容量表 ══════════════════════════════

/** 版本 1–10 在纠错级 L 下的块结构。
 *
 *  `blocks` 是 `[块数, 每块数据码字数]` 的列表 —— 分组是因为版本 10 是
 *  "2 组 68 + 2 组 69"这种形态，用一个"每块数据数"表示不了。 */
const CAPACITY: Record<number, { data: number; ecc: number; blocks: [number, number][]; align: number[] }> = {
  1: { data: 19, ecc: 7, blocks: [[1, 19]], align: [] },
  2: { data: 34, ecc: 10, blocks: [[1, 34]], align: [6, 18] },
  3: { data: 55, ecc: 15, blocks: [[1, 55]], align: [6, 22] },
  4: { data: 80, ecc: 20, blocks: [[1, 80]], align: [6, 26] },
  5: { data: 108, ecc: 26, blocks: [[1, 108]], align: [6, 30] },
  6: { data: 136, ecc: 18, blocks: [[2, 68]], align: [6, 34] },
  7: { data: 156, ecc: 20, blocks: [[2, 78]], align: [6, 22, 38] },
  8: { data: 194, ecc: 24, blocks: [[2, 97]], align: [6, 24, 42] },
  9: { data: 232, ecc: 30, blocks: [[2, 116]], align: [6, 26, 46] },
  10: { data: 274, ecc: 18, blocks: [[2, 68], [2, 69]], align: [6, 28, 50] },
};

export const MAX_VERSION = 10;

/** 这个版本能装多少**字节**（字节模式，纠错级 L）。 */
export function byteCapacity(version: number): number {
  const cap = CAPACITY[version];
  if (cap === undefined) throw new Error(`二维码：不支持版本 ${version}`);
  // 4 bit 模式指示 + 字符计数（v1-9 是 8 bit，v10+ 是 16 bit）
  const overhead = 4 + (version <= 9 ? 8 : 16);
  return cap.data - Math.ceil(overhead / 8);
}

// ══════════════════════════════ 数据编码 ══════════════════════════════

/** 一个按 bit 追加的缓冲。 */
class BitBuffer {
  bits: number[] = [];
  push(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

function chooseVersion(byteLen: number): number {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    if (byteLen <= byteCapacity(v)) return v;
  }
  throw new Error(`二维码：载荷 ${byteLen} 字节太长（最大支持 ${byteCapacity(MAX_VERSION)}）`);
}

/** 把字节流编成最终的数据码字序列（含纠错）。 */
function encodeData(bytes: number[], version: number): number[] {
  const cap = CAPACITY[version]!;
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // 字节模式
  buf.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.push(b, 8);

  // 结束符（最多 4 个 0）
  const totalBits = cap.data * 8;
  buf.push(0, Math.min(4, totalBits - buf.length));
  // 补到字节边界
  while (buf.length % 8 !== 0) buf.push(0, 1);
  // 补位字节：交替 0xEC / 0x11
  const dataCw: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | buf.bits[i + j]!;
    dataCw.push(b);
  }
  for (let i = 0; dataCw.length < cap.data; i += 1) dataCw.push(i % 2 === 0 ? 0xec : 0x11);

  // 分块 + 算纠错
  const blocks: number[][] = [];
  const eccs: number[][] = [];
  let off = 0;
  for (const [count, size] of cap.blocks) {
    for (let b = 0; b < count; b += 1) {
      const chunk = dataCw.slice(off, off + size);
      off += size;
      blocks.push(chunk);
      eccs.push(rsEncode(chunk, cap.ecc));
    }
  }
  // 交织：先按列取数据，再按列取纠错
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of blocks) if (i < b.length) out.push(b[i]!);
  }
  for (let i = 0; i < cap.ecc; i += 1) {
    for (const e of eccs) out.push(e[i]!);
  }
  return out;
}

// ══════════════════════════════ 矩阵 ══════════════════════════════

/** 一个布尔矩阵：`true` = 深色。 */
export interface QrMatrix {
  version: number;
  size: number;
  /** 行主序，长度 `size * size`。 */
  dark: boolean[];
  /** 功能图案占的格（定位/校正/定时/格式/版本）—— 这些格**不承载数据**。
   *
   *  导出它有两个用处：渲染时可以跳过（我们不用），以及**测试里能把码解回来**
   *  （见 `test/qr.test.ts`）—— "编码对不对"最有力的验法是"解回来是不是原文"，
   *  而那需要知道哪些格是数据。 */
  reserved: boolean[];
  /** 选中的掩码编号（0–7）。 */
  mask: number;
}

/** 版本信息位串（v7+ 才有）。 */
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

/** 格式信息（纠错级 L + 掩码 m）：`(0b01 << 3 | m)` 过 BCH(15,5) 再异或 0x5412。
 *
 *  纠错级的两位：L=01，M=00，Q=11，H=10。 */
const FORMAT_INFO: number[] = (() => {
  const out: number[] = [];
  for (let mask = 0; mask < 8; mask += 1) {
    const data = (0b01 << 3) | mask; // 纠错级 L
    let rem = data << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    }
    out.push(((data << 10) | rem) ^ 0x5412);
  }
  return out;
})();

/** 放一个 7×7 定位图案（左上角在 `(r,c)`）。 */
function placeFinder(m: boolean[], size: number, r0: number, c0: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      // 外框（第 0/6 行或列）与中心 3×3 是深色；中间那圈是浅色；-1 那圈是分隔符（浅色）
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      m[rr * size + cc] = dark;
    }
  }
}

/** 放一个 5×5 校正图案（中心在 `(r,c)`）。 */
function placeAlign(m: boolean[], size: number, r0: number, c0: number): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      // 外框深、内圈浅、正中心深
      m[rr * size + cc] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
}

function buildMatrix(codewords: number[], version: number): { dark: boolean[]; reserved: boolean[] } {
  const size = version * 4 + 17;
  const dark = new Array<boolean>(size * size).fill(false);
  const reserved = new Array<boolean>(size * size).fill(false);

  const mark = (r: number, c: number, v: boolean): void => {
    dark[r * size + c] = v;
    reserved[r * size + c] = true;
  };

  // 定位图案（三个角）+ 分隔符
  // 定位图案（7×7）+ 它外面那一圈**分隔符**（浅色）。
  // `placeFinder` 顺带画了 r/c = -1 那圈（就是分隔符），这里补上 reserved 标记。
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as [number, number][]) {
    placeFinder(dark, size, r0, c0);
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        reserved[rr * size + cc] = true;
      }
    }
  }

  // 校正图案（避开三个定位图案所在的角）
  const centers = CAPACITY[version]!.align;
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      placeAlign(dark, size, r, c);
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) reserved[(r + dr) * size + (c + dc)] = true;
      }
    }
  }

  // 定时图案（第 6 行 / 第 6 列，从 8 到 size-9 交替）
  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i, i % 2 === 0);
    mark(i, 6, i % 2 === 0);
  }

  // 固定深色模块（(4*version+9, 8)）
  mark(size - 8, 8, true);

  // 格式信息占位（先标 reserved，稍后写）
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8 * size + i]) mark(8, i, false);
    if (!reserved[i * size + 8]) mark(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8 * size + (size - 1 - i)]) mark(8, size - 1 - i, false);
    if (!reserved[(size - 1 - i) * size + 8]) mark(size - 1 - i, 8, false);
  }

  // 版本信息（v7+）
  if (version >= 7) {
    const bits = VERSION_INFO[version]!;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      mark(r, size - 11 + c, bit);
      mark(size - 11 + c, r, bit);
    }
  }

  // 数据：从右下角开始，两列一组、蛇形向上
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i: number): boolean => {
    if (i >= totalBits) return false; // 余数位补 0
    return ((codewords[i >> 3]! >> (7 - (i & 7))) & 1) === 1;
  };
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // 第 6 列是定时图案，跳过
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row * size + c]) continue;
        dark[row * size + c] = bitAt(bitIdx);
        bitIdx += 1;
      }
    }
    upward = !upward;
  }

  return { dark, reserved };
}

/** 8 种掩码。 */
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 掩码惩罚分（规范里的四条规则）。分越低越好。 */
function penalty(m: boolean[], size: number): number {
  let score = 0;
  const at = (r: number, c: number): boolean => m[r * size + c]!;

  // 规则 1：同色连续 5 个以上
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (at(r, c) === at(r, c - 1)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (at(r, c) === at(r - 1, c)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // 规则 3：`10111010000` / `00001011101` 形态
  // ⚠ 两条图案**各自**逐位比较。写成"一条 break 掉再试另一条"是错的：
  //   `break` 会跳出去，于是第二条永远只比较第 0 位 —— 那等于把这条规则废掉，
  //   而它废掉的表现是"掩码选得不是最优"，不是报错（很难发现）。
  const patA = [true, false, true, true, true, false, true, false, false, false, false];
  const patB = [false, false, false, false, true, false, true, true, true, false, true];
  const match = (get: (i: number) => boolean, start: number): boolean => {
    const at = (pat: boolean[]): boolean => {
      for (let i = 0; i < 11; i += 1) if (get(start + i) !== pat[i]) return false;
      return true;
    };
    return at(patA) || at(patB);
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 11 <= size; c += 1) {
      if (match((i) => at(r, i), c)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r + 11 <= size; r += 1) {
      if (match((i) => at(i, c), r)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let darkCount = 0;
  for (const d of m) if (d) darkCount += 1;
  const pct = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** 格式信息**第一份**（左上角那条 L 形）的坐标，`[列, 行]`，第 i 项放第 i 位
 *  （位序 LSB 优先）。
 *
 *  ⚠ 这张表不能"按对称自己推"：位 0–5 在**第 8 列向下**（行 0→5），位 9–14 在
 *  **第 8 行向左**（列 5→0）。写反（把行 8 当列 8 用）得到的是**转置**过的格式信息：
 *  编码器自己读自己永远是对的（测试里那个解码器要是照抄同一套坐标也一样过），
 *  但任何真实读码器读到的掩码号与纠错级都是错的 ⇒ 整张码解不出来。
 *  坐标取自规范（同 ZXing `MatrixUtil.TYPE_INFO_COORDS`）。 */
const FORMAT_COORDS: readonly [number, number][] = [
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
  [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
];

/** 把格式信息写进矩阵（在掩码之后 —— 格式信息**不参与掩码**）。 */
function placeFormat(dark: boolean[], size: number, mask: number): void {
  const bits = FORMAT_INFO[mask]!;
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 15; i += 1) {
    const v = bit(i);
    const [c, r] = FORMAT_COORDS[i]!;
    dark[r * size + c] = v;
    // 第二份：右上那 8 格在第 8 行从右往左，左下那 7 格在第 8 列从下往上
    if (i < 8) dark[8 * size + (size - 1 - i)] = v;
    else dark[(size - 15 + i) * size + 8] = v;
  }
  dark[(size - 8) * size + 8] = true; // 固定深色模块
}

/** 编码：载荷 → 矩阵。 */
export function encodeQr(payload: string): QrMatrix {
  // ⚠ 用本仓的 `utf8`，**不是** `TextEncoder` —— 插件沙箱里没有后者
  //   （用它的表现是运行时 `TextEncoder is not defined`）
  const bytes = Array.from(utf8(payload));
  const version = chooseVersion(bytes.length);
  const codewords = encodeData(bytes, version);
  const size = version * 4 + 17;
  const base = buildMatrix(codewords, version);

  // 试 8 种掩码，取惩罚分最低的（规范就是这么定的）
  let best: { dark: boolean[]; score: number; mask: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = base.dark.slice();
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (base.reserved[r * size + c]) continue;
        if (MASKS[mask]!(r, c)) m[r * size + c] = !m[r * size + c];
      }
    }
    // ⚠ 格式信息**不参与掩码**，所以要在掩码之后再写
    placeFormat(m, size, mask);
    const score = penalty(m, size);
    if (best === null || score < best.score) best = { dark: m, score, mask };
  }

  return { version, size, dark: best!.dark, reserved: base.reserved, mask: best!.mask };
}

/** 渲染成 SVG（含 4 模块静默区）。
 *
 *  ⚠ 静默区**不能省**：少了它，深色主题下码的边缘会和背景糊在一起，
 *  扫码成功率明显下降。 */
export function qrSvg(payload: string, opts: { quiet?: number; scale?: number } = {}): string {
  const quiet = opts.quiet ?? 4;
  const scale = opts.scale ?? 6;
  const { size, dark, version } = encodeQr(payload);
  const side = size + quiet * 2;
  const px = side * scale;

  const rects: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!dark[r * size + c]) continue;
      rects.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges" data-version="${version}">` +
    `<rect width="${px}" height="${px}" fill="#fff"/>` +
    `<path d="${rects.join('')}" fill="#000"/>` +
    `</svg>`
  );
}
