// PNG → RGBA 像素。滑块题面是 PNG（base64），而匹配算法要的是像素。
//
// # 为什么不直接用 `fast-png`（我第一版就是那么写的）
//
// 它能用，而且 `mcloud-sign` 用的就是它 —— 但它的依赖 `iobuffer` 会碰 **`Buffer`**，
// 而**插件沙箱里没有 `Buffer`**。这不是"可能有问题"：本仓的 `check-build` 是扫产物的，
// 它当场就报 `❌ 产物里出现了沙箱没有的东西：Buffer.`
//
// 于是改成：**inflate 用 `fflate`**（纯 JS、不碰 `Buffer`），外面那层 PNG 壳自己解。
// 壳的部分不大（chunk 解析 + 反滤波 + 色彩类型），而且这几步都是**可以从字节验证**的
// —— 不像 inflate 那样"错了会给出看着像图的东西"。
//
// # 支持的子集（够用且**明确拒绝**其余）
//
// · 位深 **8**（题面就是 8 位；别的位深直接抛，不含糊过去）
// · 非隔行（隔行是另一套滤波语义，硬解会得到一张错位的图）
// · 色彩类型 0（灰）/ 2（RGB）/ 3（调色板）/ 4（灰+透明）/ 6（RGBA）

import { unzlibSync } from 'fflate';

export interface DecodedImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** 每像素字节数（**位深 8** 下就是通道数）。反滤波要用它。 */
function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // 灰度
    case 2:
      return 3; // RGB
    case 3:
      return 1; // 调色板索引
    case 4:
      return 2; // 灰度 + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`PNG 色彩类型不认识：${colorType}`);
  }
}

/** PNG 的**反滤波**（in-place，逐扫描行，`bpp` = 每像素字节数）。
 *
 *  五种滤波是 PNG 规范里最容易写错的一段 —— 而且错了**不会抛**，
 *  只会给出一张"看着有内容但像素偏了几格"的图，然后滑块算出一个错的 offset。
 *  所以这一层单独有测试（`test/png.test.ts` 里逐滤波对拍）。 */
function unfilter(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[pos]!;
    pos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[pos + x]!;
      const a = x >= bpp ? out[rowStart + x - bpp]! : 0; // 左
      const b = y > 0 ? out[prevStart + x]! : 0; // 上
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp]! : 0; // 左上
      let v: number;
      switch (ft) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth：选 a/b/c 里与 p 最接近的那个
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`PNG 滤波类型不认识：${ft}（第 ${y} 行）`);
      }
      out[rowStart + x] = v & 0xff;
    }
    pos += stride;
  }
  return out;
}

/** 解一张 PNG 成 RGBA。失败**抛**（调用方要能区分"图坏了"与"图里没找到轮廓"）。 */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('不是 PNG（签名不对）');
  }
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = u32(body, 0);
      h = u32(body, 4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') {
      palette = body.slice();
    } else if (type === 'tRNS') {
      transparency = body.slice();
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len; // 长度(4) + 类型(4) + 数据 + CRC(4)
  }

  if (w <= 0 || h <= 0) throw new Error(`PNG 尺寸不合法：${w}x${h}`);
  if (bitDepth !== 8) throw new Error(`PNG 位深只支持 8（这张是 ${bitDepth}）`);
  if (interlace !== 0) throw new Error('PNG 是隔行的，不支持（硬解会得到错位的图）');
  if (idat.length === 0) throw new Error('PNG 没有 IDAT');

  const ch = channelsOf(colorType);
  let total = 0;
  for (const d of idat) total += d.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const d of idat) {
    merged.set(d, off);
    off += d.length;
  }
  const raw = unfilter(unzlibSync(merged), w, h, ch);
  const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);

  if (colorType === 0) {
    for (let i = 0; i < n; i += 1) {
      const v = raw[i]!;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 2) {
    for (let i = 0; i < n; i += 1) {
      rgba[i * 4] = raw[i * 3]!;
      rgba[i * 4 + 1] = raw[i * 3 + 1]!;
      rgba[i * 4 + 2] = raw[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error('PNG 是调色板图但没有 PLTE');
    for (let i = 0; i < n; i += 1) {
      const idx = raw[i]!;
      rgba[i * 4] = palette[idx * 3] ?? 0;
      rgba[i * 4 + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = palette[idx * 3 + 2] ?? 0;
      // 调色板的透明表是按**索引**给的（不是按像素）
      rgba[i * 4 + 3] = transparency?.[idx] ?? 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < n; i += 1) {
      const v = raw[i * 2]!;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = raw[i * 2 + 1]!;
    }
  } else {
    rgba.set(raw.subarray(0, n * 4));
  }

  return { data: rgba, width: w, height: h };
}
