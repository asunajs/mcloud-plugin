// 基线 JPEG → RGBA 像素。滑块底图（`picture` 字段，680×400）是 JPEG，
// 而 `png.ts` 只吃 PNG —— 这一半单独补上，让滑块匹配拿到的是同一套 `DecodedImage`。
//
// # 为什么自己写而不是拉个库
//
// 面板的插件沙箱里没有 Node（没有 `Buffer` / `process` / `require`），本仓 `check-build`
// 会扫产物，`jpeg-js`、`sharp` 这一类要么直接碰 `Buffer`，要么带 wasm/原生依赖，
// 都过不去。基线解码本身没有玄学：marker → Huffman → 反量化 → IDCT，
// 每一步都能从字节和已知图片对上（`test/jpeg.test.ts` 拿 Pillow 生成的夹具对拍）。
//
// # 色度上采样：2:1 用线性，其它倍率用最近邻
//
// 4:2:0 / 4:2:2 的 Cb/Cr 是 2:1，最近邻会在色块边缘产生整格宽的阶梯；滑块匹配吃的是
// 边缘，阶梯会让同一条边在亮度平面和色度平面错开半格。这里按"输出像素中心 → 分量像素中心"
// 做线性插值（也就是 libjpeg fancy upsampling 的 1/4、3/4 权重），代价是每像素 4 次乘法。
// 4:1:1 这类 4:1 扩展则用最近邻：libjpeg 自己也是 `int_upsample`（复制），线性插值反而
// 会把相邻色块"拖"过边界，产生一像素宽的串色。测试里的 4:1:1 夹具按这个行为对拍。
//
// # IDCT 为什么用整数（IJG 的 13-bit 版本）
//
// QuickJS 里浮点也能跑，但这个解码器每次领取奖品都要跑一张 680×400，IDCT 是热点。
// 整数版只有加法和移位（系数乘法在 32 位内），没有 `Math.round`、没有每块的对象/数组分配；
// IDCT 本身的误差在 ±1 灰阶内，远小于 JPEG 量化本身的误差（整图与 Pillow 对拍最大差 2）。
// 工作区 `block`/`ws` 在整个解码里复用，热循环里不新建数组。
//
// # 重启间隔（DRI）
//
// 有 DRI 的文件每隔 N 个 MCU 插一个 RSTn。解码端必须在边界处**丢弃 bit 缓冲里的填充位、
// 读掉 RSTn、把 DC 预测器清零**；漏一步，后面每个块的 DC 都带着前面的漂移，
// 整张图会逐渐变成色块（而且不抛错）。所以这一段的错误会明确报"重启标记缺失"。
//
// # 支持的子集（其余明确拒绝，不猜）
//
// · SOF0（baseline）/ SOF1（extended sequential），8-bit
// · 1 分量（灰度）或 3 分量（YCbCr），h/v 采样因子 1..4
// · DHT 标准/自定义 Huffman 表、DRI + RSTn、APPn/COM 跳过
// · 拒绝：progressive（SOF2）、算术编码（SOF9-11/13-15）、12-bit、4 分量、无损/差分

import type { DecodedImage } from './png.ts';

/** JPEG 的 zigzag 顺序：下标是 zigzag 序号，值是 8×8 块里的自然下标。 */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63,
]);

/** IJG `jidctint.c` 的定点常数（CONST_BITS = 13）。 */
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

const CONST_BITS = 13;
const PASS1_BITS = 2;

function descale(x: number, n: number): number {
  return (x + (1 << (n - 1))) >> n;
}

/** 反量化后的系数可能超出 16-bit（坏的量化表会放大），IDCT 的 32 位中间量按 int16
 *  输入设计，这里夹一下，避免溢出把整块算成噪声。 */
function clampCoeff(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32767) return -32767;
  return v;
}

/** 一个 8×8 块的整数 IDCT，结果直接写进分量平面。
 *
 *  `block` 是反量化后的自然顺序系数，`ws` 是本解码器复用的 64 元素工作区；
 *  函数内不分配任何对象 —— 680×400 有 8500 个块，每块一个数组就是 8500 次 GC 压力。 */
function idctBlock(block: Int32Array, ws: Int32Array, plane: Uint8Array, stride: number, off: number): void {
  // ── 列变换：输入 block，输出 ws ──
  for (let c = 0; c < 8; c += 1) {
    if (
      block[c + 8] === 0 &&
      block[c + 16] === 0 &&
      block[c + 24] === 0 &&
      block[c + 32] === 0 &&
      block[c + 40] === 0 &&
      block[c + 48] === 0 &&
      block[c + 56] === 0
    ) {
      const dc = block[c]! << PASS1_BITS;
      ws[c] = dc;
      ws[c + 8] = dc;
      ws[c + 16] = dc;
      ws[c + 24] = dc;
      ws[c + 32] = dc;
      ws[c + 40] = dc;
      ws[c + 48] = dc;
      ws[c + 56] = dc;
      continue;
    }

    const z2 = block[c + 16]!;
    const z3 = block[c + 48]!;
    const z1 = (z2 + z3) * FIX_0_541196100;
    const t2 = z1 - z3 * FIX_1_847759065;
    const t3 = z1 + z2 * FIX_0_765366865;

    const d0 = block[c]!;
    const d4 = block[c + 32]!;
    const t0 = (d0 + d4) << CONST_BITS;
    const t1 = (d0 - d4) << CONST_BITS;

    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;

    const p0 = block[c + 56]!;
    const p1 = block[c + 40]!;
    const p2 = block[c + 24]!;
    const p3 = block[c + 8]!;

    const w1 = p0 + p3;
    const w2 = p1 + p2;
    const w3 = p0 + p2;
    const w4 = p1 + p3;
    const w5 = (w3 + w4) * FIX_1_175875602;

    let q0 = p0 * FIX_0_298631336;
    let q1 = p1 * FIX_2_053119869;
    let q2 = p2 * FIX_3_072711026;
    let q3 = p3 * FIX_1_501321110;
    const s1 = w1 * -FIX_0_899976223;
    const s2 = w2 * -FIX_2_562915447;
    const s3 = w3 * -FIX_1_961570560 + w5;
    const s4 = w4 * -FIX_0_390180644 + w5;

    q0 += s1 + s3;
    q1 += s2 + s4;
    q2 += s2 + s3;
    q3 += s1 + s4;

    ws[c] = descale(t10 + q3, CONST_BITS - PASS1_BITS);
    ws[c + 56] = descale(t10 - q3, CONST_BITS - PASS1_BITS);
    ws[c + 8] = descale(t11 + q2, CONST_BITS - PASS1_BITS);
    ws[c + 48] = descale(t11 - q2, CONST_BITS - PASS1_BITS);
    ws[c + 16] = descale(t12 + q1, CONST_BITS - PASS1_BITS);
    ws[c + 40] = descale(t12 - q1, CONST_BITS - PASS1_BITS);
    ws[c + 24] = descale(t13 + q0, CONST_BITS - PASS1_BITS);
    ws[c + 32] = descale(t13 - q0, CONST_BITS - PASS1_BITS);
  }

  // ── 行变换：输入 ws，结果 +128 后写进平面 ──
  for (let r = 0; r < 8; r += 1) {
    const o = r * 8;
    const base = off + r * stride;

    if (
      ws[o + 1] === 0 &&
      ws[o + 2] === 0 &&
      ws[o + 3] === 0 &&
      ws[o + 4] === 0 &&
      ws[o + 5] === 0 &&
      ws[o + 6] === 0 &&
      ws[o + 7] === 0
    ) {
      // 行方向的 DC-only 快捷路径也要除 8（最终的 `+3` 就是 1/8）；
      // 漏掉它会让整块亮度翻 8 倍 —— 这是我第一版踩过的坑。
      let v = descale(ws[o]!, PASS1_BITS + 3) + 128;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      plane[base] = v;
      plane[base + 1] = v;
      plane[base + 2] = v;
      plane[base + 3] = v;
      plane[base + 4] = v;
      plane[base + 5] = v;
      plane[base + 6] = v;
      plane[base + 7] = v;
      continue;
    }

    const z2 = ws[o + 2]!;
    const z3 = ws[o + 6]!;
    const z1 = (z2 + z3) * FIX_0_541196100;
    const t2 = z1 - z3 * FIX_1_847759065;
    const t3 = z1 + z2 * FIX_0_765366865;

    const d0 = ws[o]!;
    const d4 = ws[o + 4]!;
    const t0 = (d0 + d4) << CONST_BITS;
    const t1 = (d0 - d4) << CONST_BITS;

    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;

    const p0 = ws[o + 7]!;
    const p1 = ws[o + 5]!;
    const p2 = ws[o + 3]!;
    const p3 = ws[o + 1]!;

    const w1 = p0 + p3;
    const w2 = p1 + p2;
    const w3 = p0 + p2;
    const w4 = p1 + p3;
    const w5 = (w3 + w4) * FIX_1_175875602;

    let q0 = p0 * FIX_0_298631336;
    let q1 = p1 * FIX_2_053119869;
    let q2 = p2 * FIX_3_072711026;
    let q3 = p3 * FIX_1_501321110;
    const s1 = w1 * -FIX_0_899976223;
    const s2 = w2 * -FIX_2_562915447;
    const s3 = w3 * -FIX_1_961570560 + w5;
    const s4 = w4 * -FIX_0_390180644 + w5;

    q0 += s1 + s3;
    q1 += s2 + s4;
    q2 += s2 + s3;
    q3 += s1 + s4;

    plane[base] = clampByte(descale(t10 + q3, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 7] = clampByte(descale(t10 - q3, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 1] = clampByte(descale(t11 + q2, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 6] = clampByte(descale(t11 - q2, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 2] = clampByte(descale(t12 + q1, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 5] = clampByte(descale(t12 - q1, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 3] = clampByte(descale(t13 + q0, CONST_BITS + PASS1_BITS + 3) + 128);
    plane[base + 4] = clampByte(descale(t13 - q0, CONST_BITS + PASS1_BITS + 3) + 128);
  }
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Huffman 表：9-bit 快表 + 规范表的慢路径。
 *
 *  基线 JPEG 的码长最多 16；绝大多数符号落在 9 位内，所以一个 512 项的快表
 *  就能让热循环只做"取 9 位、查表、扣位数"三步，长的码再退回逐位。
 *  快表项 = `(码长 << 8) | 符号`，0 表示未命中。 */
interface HuffTable {
  readonly lookup: Uint16Array;
  /** 每个码长的最大码字（没有该长度的码时为 -1）。 */
  readonly maxcode: Int32Array;
  readonly mincode: Int32Array;
  /** 每个码长在 values 里的起始下标。 */
  readonly valptr: Int32Array;
  readonly values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): HuffTable {
  const lookup = new Uint16Array(512);
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);

  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    const n = counts[len]!;
    valptr[len] = k;
    mincode[len] = code;
    if (n > 0) {
      maxcode[len] = code + n - 1;
      if (len <= 9) {
        const shift = 9 - len;
        for (let i = 0; i < n; i += 1) {
          const start = (code + i) << shift;
          const packed = (len << 8) | values[k + i]!;
          for (let j = 0; j < 1 << shift; j += 1) lookup[start + j] = packed;
        }
      }
    }
    k += n;
    code = (code + n) << 1;
  }
  if (k !== values.length) throw new Error('JPEG 的 Huffman 表长度不一致（DHT 损坏）');
  return { lookup, maxcode, mincode, valptr, values };
}

interface Component {
  readonly id: number;
  /** 水平/垂直采样因子（1..4）。 */
  readonly h: number;
  readonly v: number;
  readonly tq: number;
  /** 这个分量实际的采样宽高（`ceil(图像宽 × h / hMax)`）。 */
  readonly width: number;
  readonly height: number;
  /** 平面按 MCU 补齐后的宽度：块的写入位置只会落在补齐范围内。 */
  readonly planeW: number;
  readonly plane: Uint8Array;
}

interface ScanComponent {
  readonly comp: Component;
  readonly index: number;
  readonly dc: HuffTable;
  readonly ac: HuffTable;
  readonly qt: Uint16Array;
}

/** 采样表的一维映射：输出第 `d` 个像素对应源平面的 `i0`/`i1`（权重 `frac/256`）。 */
interface AxisMap {
  readonly i0: Int32Array;
  readonly i1: Int32Array;
  readonly frac: Int32Array;
}

/** 按"像素中心对齐"生成一维映射。
 *
 *  2:1 用线性插值，权重就是 libjpeg fancy upsampling 的 3/4、1/4；
 *  其它倍率（4:1:1 的 4:1、8:1 之类）用最近邻 —— libjpeg 对非 2× 的扩展也是
 *  `int_upsample`（复制），线性插值反而会把色度从相邻块"拖"过边界，造成一像素宽的串色。
 *  4:1:1 的色度本来就只有 1/4 宽，再线性插值没有收益，不如与主流解码器保持一致。 */
function buildAxis(comp: number, max: number, srcLen: number, dstLen: number): AxisMap {
  const i0 = new Int32Array(dstLen);
  const i1 = new Int32Array(dstLen);
  const frac = new Int32Array(dstLen);
  const last = srcLen - 1;

  if (comp !== max && max === comp * 2) {
    for (let d = 0; d < dstLen; d += 1) {
      // 源坐标（以源像素中心为整数）：u = (d + 0.5) * comp / max - 0.5，放大 256 倍取整
      let u = Math.floor(((d * 2 + 1) * comp * 128) / max) - 128;
      if (u < 0) u = 0;
      const maxU = last * 256;
      if (u > maxU) u = maxU;
      const a = u >> 8;
      i0[d] = a;
      i1[d] = a < last ? a + 1 : a;
      frac[d] = u & 255;
    }
    return { i0, i1, frac };
  }

  for (let d = 0; d < dstLen; d += 1) {
    const a = Math.min(Math.floor((d * comp) / max), last);
    i0[d] = a;
    i1[d] = a;
    frac[d] = 0;
  }
  return { i0, i1, frac };
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** 解一张基线 JPEG 成 RGBA。失败**抛**（调用方要能区分"图坏了"和"图里没匹配到"）。 */
export function decodeJpeg(bytes: Uint8Array): DecodedImage {
  if (!isJpeg(bytes)) throw new Error('不是 JPEG（缺少 SOI 标记 FF D8）');

  const dcTables: (HuffTable | undefined)[] = [];
  const acTables: (HuffTable | undefined)[] = [];
  const qtables: (Uint16Array | undefined)[] = [];

  let pos = 2;
  let width = 0;
  let height = 0;
  let hMax = 1;
  let vMax = 1;
  let restartInterval = 0;
  let components: Component[] = [];
  const scannedComps: boolean[] = [];
  let sawSof = false;
  let sawScan = false;

  let dcPred = new Int32Array(0);
  let block = new Int32Array(64);
  let ws = new Int32Array(64);

  // ── 熵编码段的位读取器（闭包变量：整个解码只有一份，避免每块建状态对象） ──
  let entropyPos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  /** 0 = 还在熵数据里；非 0 = 撞到了标记（-1 表示文件提前结束）。 */
  let marker = 0;
  let markerPos = -1;

  function fillOne(): void {
    if (entropyPos >= bytes.length) {
      marker = -1;
      markerPos = entropyPos;
      return;
    }
    const b = bytes[entropyPos]!;
    if (b !== 0xff) {
      bitBuf = ((bitBuf << 8) | b) >>> 0;
      bitCnt += 8;
      entropyPos += 1;
      return;
    }
    const n = entropyPos + 1 < bytes.length ? bytes[entropyPos + 1]! : -1;
    if (n === 0x00) {
      // 字节填充：FF 00 表示数据里的 0xFF
      bitBuf = ((bitBuf << 8) | 0xff) >>> 0;
      bitCnt += 8;
      entropyPos += 2;
      return;
    }
    // 真标记（RSTn / EOI / 下一个段）：不消费，留到边界处理
    marker = n;
    markerPos = entropyPos;
  }

  function ensure(n: number): void {
    while (bitCnt < n && marker === 0) fillOne();
  }

  function readBits(n: number): number {
    if (n === 0) return 0;
    ensure(n);
    if (bitCnt < n) throw new Error('JPEG 扫描数据提前结束（文件被截断？）');
    const v = (bitBuf >>> (bitCnt - n)) & ((1 << n) - 1);
    bitCnt -= n;
    return v;
  }

  function decodeHuff(t: HuffTable): number {
    ensure(9);
    if (bitCnt >= 9) {
      const entry = t.lookup[(bitBuf >>> (bitCnt - 9)) & 511]!;
      if (entry !== 0) {
        bitCnt -= entry >>> 8;
        return entry & 0xff;
      }
    }
    let code = 0;
    for (let len = 1; len <= 16; len += 1) {
      code = (code << 1) | readBits(1);
      const mx = t.maxcode[len]!;
      if (mx >= 0 && code <= mx) {
        return t.values[t.valptr[len]! + code - t.mincode[len]!]!;
      }
    }
    throw new Error('JPEG 的 Huffman 码不合法（扫描数据损坏）');
  }

  function receiveExtend(s: number): number {
    const v = readBits(s);
    return v < 1 << (s - 1) ? v - ((1 << s) - 1) : v;
  }

  /** 重启边界：丢填充位、吃掉 RSTn、清 DC 预测器。 */
  function restartScan(mcuIndex: number): void {
    bitBuf = 0;
    bitCnt = 0;
    let q = marker !== 0 && markerPos >= 0 ? markerPos : entropyPos;
    // 跳过标记前的 FF 填充字节
    while (q + 1 < bytes.length && bytes[q] === 0xff && bytes[q + 1] === 0xff) q += 1;
    if (q + 1 >= bytes.length || bytes[q] !== 0xff) {
      throw new Error(`JPEG 在第 ${mcuIndex} 个 MCU 后缺少重启标记 RSTn（DRI 与实际数据不一致）`);
    }
    const m = bytes[q + 1]!;
    if (m < 0xd0 || m > 0xd7) {
      throw new Error(`JPEG 在第 ${mcuIndex} 个 MCU 后缺少重启标记 RSTn（遇到 FF ${m.toString(16)}）`);
    }
    entropyPos = q + 2;
    marker = 0;
    markerPos = -1;
    dcPred.fill(0);
  }

  /** 一个扫描段解完后，从熵数据里找回下一个标记的位置（跳过字节填充和多余的 RST）。 */
  function resyncToMarker(): number {
    bitBuf = 0;
    bitCnt = 0;
    let q = marker !== 0 && markerPos >= 0 ? markerPos : entropyPos;
    for (;;) {
      while (q + 1 < bytes.length) {
        if (bytes[q] !== 0xff) {
          q += 1;
          continue;
        }
        const m = bytes[q + 1]!;
        if (m === 0x00) {
          q += 2;
          continue;
        }
        if (m === 0xff) {
          q += 1;
          continue;
        }
        break;
      }
      if (q + 1 >= bytes.length) throw new Error('JPEG 扫描段之后找不到下一个标记（文件被截断）');
      const m = bytes[q + 1]!;
      if (m >= 0xd0 && m <= 0xd7) {
        q += 2;
        continue;
      }
      marker = 0;
      markerPos = -1;
      entropyPos = q;
      return q;
    }
  }

  function decodeBlock(sc: ScanComponent): void {
    block.fill(0);
    const dcLen = decodeHuff(sc.dc);
    let diff = 0;
    if (dcLen > 0) diff = receiveExtend(dcLen);
    const pred = (dcPred[sc.index]! + diff) | 0;
    dcPred[sc.index] = pred;
    block[0] = clampCoeff(pred * sc.qt[0]!);

    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(sc.ac);
      const run = rs >>> 4;
      const size = rs & 15;
      if (size === 0) {
        if (run !== 15) break; // EOB
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) throw new Error('JPEG 扫描数据损坏（AC 系数游程越界）');
      const nat = ZIGZAG[k]!;
      block[nat] = clampCoeff(receiveExtend(size) * sc.qt[nat]!);
      k += 1;
    }
  }

  function decodeScan(scanComponents: ScanComponent[], start: number): number {
    entropyPos = start;
    bitBuf = 0;
    bitCnt = 0;
    marker = 0;
    markerPos = -1;
    dcPred.fill(0);

    if (scanComponents.length === 1) {
      // 非交织扫描：一个分量一个块，块数按该分量自己的尺寸算（不是补齐后的 MCU 网格）
      const sc = scanComponents[0]!;
      const comp = sc.comp;
      const bw = Math.ceil(comp.width / 8);
      const bh = Math.ceil(comp.height / 8);
      const total = bw * bh;
      let mcu = 0;
      for (let by = 0; by < bh; by += 1) {
        for (let bx = 0; bx < bw; bx += 1) {
          decodeBlock(sc);
          idctBlock(block, ws, comp.plane, comp.planeW, by * 8 * comp.planeW + bx * 8);
          mcu += 1;
          if (restartInterval > 0 && mcu % restartInterval === 0 && mcu < total) restartScan(mcu);
        }
      }
    } else {
      const mcusX = Math.ceil(width / (8 * hMax));
      const mcusY = Math.ceil(height / (8 * vMax));
      const total = mcusX * mcusY;
      let mcu = 0;
      for (let my = 0; my < mcusY; my += 1) {
        for (let mx = 0; mx < mcusX; mx += 1) {
          for (const sc of scanComponents) {
            const comp = sc.comp;
            for (let vy = 0; vy < comp.v; vy += 1) {
              for (let hx = 0; hx < comp.h; hx += 1) {
                decodeBlock(sc);
                const px = (mx * comp.h + hx) * 8;
                const py = (my * comp.v + vy) * 8;
                idctBlock(block, ws, comp.plane, comp.planeW, py * comp.planeW + px);
              }
            }
          }
          mcu += 1;
          if (restartInterval > 0 && mcu % restartInterval === 0 && mcu < total) restartScan(mcu);
        }
      }
    }
    return resyncToMarker();
  }

  // ── marker 主循环 ──
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const m = pos + 1 < bytes.length ? bytes[pos + 1]! : -1;
    if (m === -1) break;
    if (m === 0xff) {
      pos += 1;
      continue;
    }
    pos += 2;

    if (m === 0xd9) break; // EOI
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // 独立标记

    if (pos + 2 > bytes.length) throw new Error('JPEG 段头被截断');
    const segLen = (bytes[pos]! << 8) | bytes[pos + 1]!;
    if (segLen < 2 || pos + segLen > bytes.length) {
      throw new Error('JPEG 段长度越界（文件被截断或损坏）');
    }
    const seg = pos + 2;
    const end = pos + segLen;

    switch (m) {
      case 0xc0:
      case 0xc1: {
        if (sawSof) throw new Error('JPEG 出现了多个 SOF（不支持分层/多帧）');
        if (end - seg < 6) throw new Error('JPEG 的 SOF 段太短');
        const precision = bytes[seg]!;
        if (precision !== 8) {
          if (precision === 12) throw new Error('JPEG 是 12-bit 的，不支持：本解码器只解 8-bit');
          throw new Error(`JPEG 精度是 ${precision}-bit，不支持：本解码器只解 8-bit`);
        }
        height = (bytes[seg + 1]! << 8) | bytes[seg + 2]!;
        width = (bytes[seg + 3]! << 8) | bytes[seg + 4]!;
        const n = bytes[seg + 5]!;
        if (width <= 0 || height <= 0) throw new Error(`JPEG 尺寸不合法：${width}x${height}`);
        if (n === 4) {
          throw new Error('JPEG 有 4 个分量（CMYK/YCCK），不支持：只支持灰度或 YCbCr');
        }
        if (n !== 1 && n !== 3) throw new Error(`JPEG 有 ${n} 个分量，不支持：只支持 1（灰度）或 3（YCbCr）`);
        if (end - seg !== 6 + n * 3) throw new Error('JPEG 的 SOF 段长度与分量数不一致');

        const specs: { id: number; h: number; v: number; tq: number }[] = [];
        hMax = 1;
        vMax = 1;
        for (let i = 0; i < n; i += 1) {
          const o = seg + 6 + i * 3;
          const id = bytes[o]!;
          const hv = bytes[o + 1]!;
          const h = hv >> 4;
          const v = hv & 15;
          const tq = bytes[o + 2]!;
          if (h < 1 || h > 4 || v < 1 || v > 4) {
            throw new Error(`JPEG 采样因子超出范围（分量 ${id}：${h}x${v}，只支持 1..4）`);
          }
          if (tq > 3) throw new Error(`JPEG 量化表编号 ${tq} 超出范围（0..3）`);
          specs.push({ id, h, v, tq });
          if (h > hMax) hMax = h;
          if (v > vMax) vMax = v;
        }

        const mcusX = Math.ceil(width / (8 * hMax));
        const mcusY = Math.ceil(height / (8 * vMax));
        components = specs.map((s) => {
          const cw = Math.ceil((width * s.h) / hMax);
          const ch = Math.ceil((height * s.v) / vMax);
          const planeW = mcusX * s.h * 8;
          const planeH = mcusY * s.v * 8;
          return {
            id: s.id,
            h: s.h,
            v: s.v,
            tq: s.tq,
            width: cw,
            height: ch,
            planeW,
            plane: new Uint8Array(planeW * planeH),
          };
        });
        dcPred = new Int32Array(components.length);
        scannedComps.length = 0;
        for (let i = 0; i < components.length; i += 1) scannedComps.push(false);
        block = new Int32Array(64);
        ws = new Int32Array(64);
        sawSof = true;
        break;
      }
      case 0xc2:
        throw new Error('这是 progressive（渐进式）JPEG，不支持：本解码器只解 baseline 顺序编码');
      case 0xc3:
        throw new Error('JPEG 用了无损（lossless）编码（SOF3），不支持');
      case 0xc5:
      case 0xc6:
      case 0xc7:
        throw new Error('JPEG 是差分/分层编码（SOF5-7），不支持');
      case 0xc9:
      case 0xca:
      case 0xcb:
        throw new Error('JPEG 用了算术编码（SOF9-11），不支持：只支持 Huffman 编码');
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new Error('JPEG 用了算术编码（SOF13-15），不支持：只支持 Huffman 编码');
      case 0xcc:
        throw new Error('JPEG 用了算术编码（DAC 段），不支持：只支持 Huffman 编码');
      case 0xc4: {
        // DHT：一个段里可以塞多张表
        let q = seg;
        while (q < end) {
          const tcth = bytes[q]!;
          q += 1;
          const tc = tcth >> 4;
          const th = tcth & 15;
          if (tc > 1 || th > 3) throw new Error(`JPEG 的 Huffman 表标识不合法（Tc=${tc}, Th=${th}）`);
          if (q + 16 > end) throw new Error('JPEG 的 DHT 段被截断');
          const counts = new Uint8Array(17);
          let total = 0;
          for (let i = 1; i <= 16; i += 1) {
            const c = bytes[q]!;
            q += 1;
            counts[i] = c;
            total += c;
          }
          if (q + total > end) throw new Error('JPEG 的 DHT 段被截断');
          const values = bytes.slice(q, q + total);
          q += total;
          const table = buildHuffman(counts, values);
          if (tc === 0) dcTables[th] = table;
          else acTables[th] = table;
        }
        break;
      }
      case 0xdb: {
        // DQT：一个段里可以塞多张表；量化值按 zigzag 顺序存，这里换回自然顺序
        let q = seg;
        while (q < end) {
          const pqtq = bytes[q]!;
          q += 1;
          const pq = pqtq >> 4;
          const tq = pqtq & 15;
          if (pq > 1 || tq > 3) throw new Error(`JPEG 的量化表标识不合法（Pq=${pq}, Tq=${tq}）`);
          if (q + 64 * (pq + 1) > end) throw new Error('JPEG 的 DQT 段被截断');
          const qt = new Uint16Array(64);
          for (let i = 0; i < 64; i += 1) {
            const nat = ZIGZAG[i]!;
            if (pq === 0) {
              qt[nat] = bytes[q]!;
              q += 1;
            } else {
              qt[nat] = (bytes[q]! << 8) | bytes[q + 1]!;
              q += 2;
            }
          }
          qtables[tq] = qt;
        }
        break;
      }
      case 0xdd: {
        if (end - seg < 2) throw new Error('JPEG 的 DRI 段太短');
        restartInterval = (bytes[seg]! << 8) | bytes[seg + 1]!;
        break;
      }
      case 0xda: {
        if (!sawSof) throw new Error('JPEG 在 SOF 之前出现了 SOS');
        if (end - seg < 4) throw new Error('JPEG 的 SOS 段太短');
        const ns = bytes[seg]!;
        if (ns !== 1 && ns !== 3) {
          throw new Error(`JPEG 扫描里有 ${ns} 个分量，不支持：只支持 1 或 3`);
        }
        if (end - seg !== 1 + ns * 2 + 3) throw new Error('JPEG 的 SOS 段长度与分量数不一致');
        const scanComponents: ScanComponent[] = [];
        for (let i = 0; i < ns; i += 1) {
          const cs = bytes[seg + 1 + i * 2]!;
          const tdta = bytes[seg + 2 + i * 2]!;
          const index = components.findIndex((c) => c.id === cs);
          if (index < 0) throw new Error(`JPEG 的扫描引用了不存在的分量 ${cs}`);
          const comp = components[index]!;
          const td = tdta >> 4;
          const ta = tdta & 15;
          const dc = dcTables[td];
          const ac = acTables[ta];
          if (!dc || !ac) throw new Error(`JPEG 缺少 Huffman 表（DC ${td} / AC ${ta}）`);
          const qt = qtables[comp.tq];
          if (!qt) throw new Error(`JPEG 缺少分量 ${cs} 的量化表 ${comp.tq}`);
          scanComponents.push({ comp, index, dc, ac, qt });
        }
        const o = seg + 1 + ns * 2;
        const ss = bytes[o]!;
        const se = bytes[o + 1]!;
        const ahal = bytes[o + 2]!;
        if (ss !== 0 || se !== 63 || ahal !== 0) {
          if (ss !== 0) throw new Error('这不是 baseline 扫描（谱选择 Ss≠0）：progressive/渐进式 JPEG 不支持');
          throw new Error(`JPEG 扫描参数不是 baseline（Ss=${ss}, Se=${se}, Ah/Al=${ahal}），不支持`);
        }
        for (const sc of scanComponents) scannedComps[sc.index] = true;
        sawScan = true;
        pos = decodeScan(scanComponents, end);
        continue;
      }
      case 0xe0:
      case 0xe1:
      case 0xe2:
      case 0xe3:
      case 0xe4:
      case 0xe5:
      case 0xe6:
      case 0xe7:
      case 0xe8:
      case 0xe9:
      case 0xea:
      case 0xeb:
      case 0xec:
      case 0xed:
      case 0xee:
      case 0xef:
      case 0xfe:
        break; // APPn / COM：跳过
      default:
        break; // 不认识的带长度段：按长度跳过（真实文件里常见厂商私有段）
    }
    pos += segLen;
  }

  if (!sawSof) throw new Error('JPEG 里没找到 SOF（可能不是完整的基线 JPEG）');
  if (!sawScan) throw new Error('JPEG 里没找到扫描数据（SOS）');

  // 多扫描文件：确认每个分量都真的被扫过。缺分量时平面是 0，会静默变成黑块，
  // 那种"看着像图但缺一半"的结果比抛错更难查。
  for (let i = 0; i < components.length; i += 1) {
    if (!scannedComps[i]) throw new Error(`JPEG 缺少分量 ${components[i]!.id} 的扫描数据（文件不完整）`);
  }

  return toRgba(components, width, height);
}

/** 分量平面 → RGBA。灰度直接复制；3 分量做 YCbCr→RGB（2:1 的色度走线性上采样）。 */
function toRgba(components: Component[], width: number, height: number): DecodedImage {
  const out = new Uint8ClampedArray(width * height * 4);

  if (components.length === 1) {
    const c = components[0]!;
    const plan = c.plane;
    const pw = c.planeW;
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * pw;
      const dstRow = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const v = plan[srcRow + x]!;
        const o = dstRow + x * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return { data: out, width, height };
  }

  const yC = components[0]!;
  const cbC = components[1]!;
  const crC = components[2]!;

  const hMax = hMaxOf(components);
  const vMax = vMaxOf(components);
  const yx = buildAxis(yC.h, hMax, yC.width, width);
  const yy = buildAxis(yC.v, vMax, yC.height, height);
  const cbx = buildAxis(cbC.h, hMax, cbC.width, width);
  const cby = buildAxis(cbC.v, vMax, cbC.height, height);
  const crx = buildAxis(crC.h, hMax, crC.width, width);
  const cry = buildAxis(crC.v, vMax, crC.height, height);

  // YCbCr→RGB 的定点系数表（libjpeg 同款）：每像素只剩查表和加法
  const crR = new Int32Array(256);
  const cbG = new Int32Array(256);
  const crG = new Int32Array(256);
  const cbB = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const v = i - 128;
    crR[i] = (91881 * v + 32768) >> 16;
    cbG[i] = (-22554 * v + 32768) >> 16;
    crG[i] = (-46802 * v + 32768) >> 16;
    cbB[i] = (116130 * v + 32768) >> 16;
  }

  for (let y = 0; y < height; y += 1) {
    const y0 = yy.i0[y]!;
    const y1 = yy.i1[y]!;
    const yf = yy.frac[y]!;
    const cb0 = cby.i0[y]!;
    const cb1 = cby.i1[y]!;
    const cbf = cby.frac[y]!;
    const cr0 = cry.i0[y]!;
    const cr1 = cry.i1[y]!;
    const crf = cry.frac[y]!;

    const yRow0 = y0 * yC.planeW;
    const yRow1 = y1 * yC.planeW;
    const cbRow0 = cb0 * cbC.planeW;
    const cbRow1 = cb1 * cbC.planeW;
    const crRow0 = cr0 * crC.planeW;
    const crRow1 = cr1 * crC.planeW;

    for (let x = 0; x < width; x += 1) {
      const yx0 = yx.i0[x]!;
      const yx1 = yx.i1[x]!;
      const yxf = yx.frac[x]!;
      const yTop = yC.plane[yRow0 + yx0]! * (256 - yxf) + yC.plane[yRow0 + yx1]! * yxf;
      const yBot = yC.plane[yRow1 + yx0]! * (256 - yxf) + yC.plane[yRow1 + yx1]! * yxf;
      const yv = ((256 - yf) * yTop + yf * yBot + 32768) >> 16;

      const cbx0 = cbx.i0[x]!;
      const cbx1 = cbx.i1[x]!;
      const cbfx = cbx.frac[x]!;
      const cbTop = cbC.plane[cbRow0 + cbx0]! * (256 - cbfx) + cbC.plane[cbRow0 + cbx1]! * cbfx;
      const cbBot = cbC.plane[cbRow1 + cbx0]! * (256 - cbfx) + cbC.plane[cbRow1 + cbx1]! * cbfx;
      const cbv = ((256 - cbf) * cbTop + cbf * cbBot + 32768) >> 16;

      const crx0 = crx.i0[x]!;
      const crx1 = crx.i1[x]!;
      const crfx = crx.frac[x]!;
      const crTop = crC.plane[crRow0 + crx0]! * (256 - crfx) + crC.plane[crRow0 + crx1]! * crfx;
      const crBot = crC.plane[crRow1 + crx0]! * (256 - crfx) + crC.plane[crRow1 + crx1]! * crfx;
      const crv = ((256 - crf) * crTop + crf * crBot + 32768) >> 16;

      const o = (y * width + x) * 4;
      out[o] = clampByte(yv + crR[crv]!);
      out[o + 1] = clampByte(yv + cbG[cbv]! + crG[crv]!);
      out[o + 2] = clampByte(yv + cbB[cbv]!);
      out[o + 3] = 255;
    }
  }

  return { data: out, width, height };
}

function hMaxOf(components: Component[]): number {
  let h = 1;
  for (const c of components) if (c.h > h) h = c.h;
  return h;
}

function vMaxOf(components: Component[]): number {
  let v = 1;
  for (const c of components) if (c.v > v) v = c.v;
  return v;
}
