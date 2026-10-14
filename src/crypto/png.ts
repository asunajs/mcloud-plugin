// PNG → RGBA 像素。滑块题面是 PNG（base64），而匹配算法要的是像素。
//
// # 为什么用 `fast-png` 而不是自己写解码器
//
// 自己写要 inflate + 五种滤波 + 位深 + 调色板 + 隔行，几百行，而且**错了看不出来**——
// 它不会抛，只会给出一张"看着像图但像素错了几处"的图，然后滑块算出一个错的 offset。
// 那个错误最终表现成"兑奖失败"，离真正的原因隔着好几层。
//
// `fast-png` 是 `mcloud-sign` 用的同一个（它那边的 `slide/image.ts` 就是 `await import("fast-png")`），
// 纯 JS、无原生依赖 ⇒ 能被 esbuild 打进插件。
//
// ⚠ 两处与插件沙箱有关的调整（**不是**算法差异）：
//   · `mcloud-sign` 用 `await import(...)`（动态）。**沙箱里没有动态 `import()`** ⇒
//     改成静态 import，由打包器收进产物。
//   · 那边是 async（因为动态 import），这边**同步** —— 沙箱的 `http_fetch` 本来就是同步的。

import { decode as decodePng } from 'fast-png';

/** 解码后的像素。`data` 是 RGBA 交错的 `Uint8ClampedArray`（`fast-png` 的 3/1 通道会补齐成 4）。 */
export interface DecodedImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** 解一张 PNG。失败**抛**（调用方要能区分"图坏了"与"图里没找到轮廓"）。 */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  const png = decodePng(bytes);
  const { width, height, channels, data } = png;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG 尺寸不合法：${width}x${height}`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  if (channels === 1) {
    for (let i = 0; i < n; i += 1) {
      const v = data[i]!;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else if (channels === 3) {
    for (let i = 0; i < n; i += 1) {
      rgba[i * 4] = data[i * 3]!;
      rgba[i * 4 + 1] = data[i * 3 + 1]!;
      rgba[i * 4 + 2] = data[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  } else if (channels === 4) {
    rgba.set(data.subarray(0, n * 4));
  } else {
    throw new Error(`PNG 通道数不认识：${channels}`);
  }
  return { data: rgba, width, height };
}
