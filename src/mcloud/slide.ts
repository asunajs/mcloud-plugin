// 滑块：解出拼图该滑到哪（`offsetX`）。
//
// # 为什么必须本地解
//
// 下单是**不可逆消耗**（这一族没有幂等键，`oid` 由服务端生成）。
// mcloud 的原话：「拿 `0` 或上一次的答案去凑，是拿真豆去赌」——
// 所以算不出来时的处置是**不发那一枪**，而不是猜一个。
//
// # 算法
//
// 逐条搬 `mcloud-sign/packages/shared/src/slide/match.ts`（115 行，纯整数运算，无依赖）：
//
// ```text
// ① 底图：Sobel 边缘图（用 |gx|+|gy| 近似模长，省一次 sqrt）
// ② 拼图：取**轮廓**像素（不透明且四邻域里有透明 ⇒ 是那块拼图的边）
// ③ 把轮廓按 x 平移，与底图边缘图求重合度，取峰值 ⇒ 那个平移量就是 offsetX
// ```
//
// 判据只有"哪个平移量让轮廓落在边缘最多"，没有拟合、没有阈值 ——
// 所以**底图边缘稀疏时它会退化**（峰值不突出）。`confidence` 就是为此留的：
// 峰均值比。真机上要拿它判断"这次算的数能不能用"。
//
// # 与 Rust 那份的关系
//
// mcloud 的 `mcloud_crypto/src/slide.rs`（582 行）是**另一套口径**（双口径交叉验证、
// 不平滑判定、拟合 R²），比这份重得多。这里先用 `mcloud-sign` 这份：它是能跑的 TS，
// 且与抓包同源。⚠ 两份的答案可能差 1-2 像素（Rust 的注释里记了"实拍分歧恰好是 1"），
// 而那个量级在滑块的容差里。

import { decodeImage } from '../crypto/png.ts';
import { fromBase64 } from '../crypto/bytes.ts';
import type { DecodedImage } from '../crypto/png.ts';

/** ⚠ 不透明阈值：`alpha > 128` 才算不透明（**`128` 本身算透明**）。
 *  边界归属照抄 —— 改一个像素就会让轮廓多/少一圈点。 */
export const ALPHA_OPAQUE_THRESHOLD = 128;

export interface SlideMatchResult {
  offsetX: number;
  /** 峰均值比。**不是**概率 —— 只用来判断"这个峰突不突出"。 */
  confidence: number;
}

/** 快速灰度（整数运算）：`(r*77 + g*150 + b*29) >> 8`。 */
function toGrayFast(data: Uint8ClampedArray, i: number): number {
  return (data[i]! * 77 + data[i + 1]! * 150 + data[i + 2]! * 29) >> 8;
}

/** 在底图边缘上滑拼图轮廓，取重合度最高的那个平移量。 */
export function matchSlide(
  bgData: DecodedImage,
  puzzleData: DecodedImage,
  bgW: number,
  bgH: number,
  pzW: number,
  pzH: number,
): SlideMatchResult {
  const bgPixels = bgData.data;
  const pzPixels = puzzleData.data;

  // ① 底图 Sobel 边缘图
  const contourX: number[] = [];
  const contourY: number[] = [];
  const bgEdge = new Uint8Array(bgW * bgH);

  for (let y = 1; y < bgH - 1; y += 1) {
    for (let x = 1; x < bgW - 1; x += 1) {
      const tl = toGrayFast(bgPixels, ((y - 1) * bgW + (x - 1)) << 2);
      const tc = toGrayFast(bgPixels, ((y - 1) * bgW + x) << 2);
      const tr = toGrayFast(bgPixels, ((y - 1) * bgW + (x + 1)) << 2);
      const ml = toGrayFast(bgPixels, (y * bgW + (x - 1)) << 2);
      const mr = toGrayFast(bgPixels, (y * bgW + (x + 1)) << 2);
      const bl = toGrayFast(bgPixels, ((y + 1) * bgW + (x - 1)) << 2);
      const bc = toGrayFast(bgPixels, ((y + 1) * bgW + x) << 2);
      const br = toGrayFast(bgPixels, ((y + 1) * bgW + (x + 1)) << 2);
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      bgEdge[y * bgW + x] = Math.min(255, (Math.abs(gx) + Math.abs(gy)) >> 2);
    }
  }

  // ② 拼图轮廓：不透明、且四邻域里至少有一个是透明的
  for (let y = 1; y < pzH - 1; y += 1) {
    for (let x = 1; x < pzW - 1; x += 1) {
      const pi = (y * pzW + x) << 2;
      if (pzPixels[pi + 3]! <= ALPHA_OPAQUE_THRESHOLD) continue;
      const above = pzPixels[((y - 1) * pzW + x) * 4 + 3]! <= ALPHA_OPAQUE_THRESHOLD;
      const below = pzPixels[((y + 1) * pzW + x) * 4 + 3]! <= ALPHA_OPAQUE_THRESHOLD;
      const left = pzPixels[(y * pzW + (x - 1)) * 4 + 3]! <= ALPHA_OPAQUE_THRESHOLD;
      const right = pzPixels[(y * pzW + (x + 1)) * 4 + 3]! <= ALPHA_OPAQUE_THRESHOLD;
      if (above || below || left || right) {
        contourX.push(x);
        contourY.push(y);
      }
    }
  }

  // ③ 模板匹配
  const numContours = contourX.length;
  // ⚠ 一个轮廓点都没有 ⇒ 返回 0 并**带 0 置信度**。调用方必须靠 confidence 判断，
  // 不能只看 offsetX（`0` 在这里既可能是"真的不用滑"，也可能是"没算出来"）
  if (numContours === 0) return { offsetX: 0, confidence: 0 };

  const maxOffset = bgW - pzW;
  if (maxOffset < 0) return { offsetX: 0, confidence: 0 };
  let bestOffset = 0;
  let bestScore = 0;
  let totalScore = 0;

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    let sum = 0;
    for (let c = 0; c < numContours; c += 1) {
      const bx = offset + contourX[c]!;
      if (bx < bgW) sum += bgEdge[contourY[c]! * bgW + bx]!;
    }
    totalScore += sum;
    if (sum > bestScore) {
      bestScore = sum;
      bestOffset = offset;
    }
  }

  const avgScore = totalScore / (maxOffset + 1);
  return { offsetX: bestOffset, confidence: avgScore > 0 ? bestScore / avgScore : 0 };
}

/** 题面两张图（base64）⇒ offset。`picture` 是底图，`puzzle` 是那块拼图。 */
export function calcPuzzleOffset(puzzleBase64: string, pictureBase64: string): SlideMatchResult {
  const puzzle = decodeImage(fromBase64(puzzleBase64));
  const picture = decodeImage(fromBase64(pictureBase64));
  return matchSlide(picture, puzzle, picture.width, picture.height, puzzle.width, puzzle.height);
}

/** 置信度下限。⚠ **这个值是待实测的** —— 真机上要用几张实际题面标定。
 *  在那之前它只用于"别把 0 当答案"：静默返回 0 的那条路径一定带 0 置信度。 */
export const MIN_CONFIDENCE = 1.5;

/** 这次算出来的能不能用。 */
export function usable(r: SlideMatchResult): boolean {
  return r.offsetX > 0 && r.confidence >= MIN_CONFIDENCE;
}
