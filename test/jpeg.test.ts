// 基线 JPEG 解码器的测试。
//
// # 夹具怎么来的
//
// 全部在 `test/fixtures/jpeg-*.b64`，是 **base64 文本**；测试只读文件，运行时不依赖
// Pillow / macOS 的 sips。重新生成（需要 Pillow 12）：
//
//     python3 test/fixtures/gen_jpeg_fixtures.py
//
// 其中 680×400 主图、4:4:4 / 4:2:2、灰度是用 Pillow 直接存的；**4:1:1 和 DRI/RSTn
// 两张是 Pillow 出不来的**（它的 `subsampling` 只有 0/1/2，也没暴露重启间隔），
// 由生成脚本里一个最小基线编码器按标准位流写出来，并且先用 Pillow 解过一遍确认合法。
//
// 期望像素不取"设计色"（那还要假设量化/上采样滤波），而是取 **Pillow 解码同一位流
// 得到的 RGB**，断言容差 3：JPEG 本身有量化误差，不同 IDCT/上采样实现差 1~2 灰阶是
// 正常的；超过 3 就不是舍入，而是解错了。
//
// # 覆盖到的东西
//
// · 680×400 4:2:0（滑块底图的真实规格）+ 横/竖/斜边缘
// · 4:4:4、4:2:2、4:1:1（67×45 的奇数尺寸，顺便测 MCU 补齐）
// · 灰度（67×45）
// · DRI=3 + RSTn 重启（64×48）
// · SOF1、progressive/算术/12-bit/4 分量的拒绝、截断/垃圾数据
//
// 不做"解码耗时 < 300ms"的硬断言：那是 QuickJS 沙箱里的目标，Node 里没有参考意义。
// 这里只留一个宽松上限抓病态复杂度，并把实测值打到 diagnostic 里。

import { readFileSync } from 'node:fs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeJpeg, isJpeg } from '../src/crypto/jpeg.ts';
import type { DecodedImage } from '../src/crypto/png.ts';

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);

const FIXTURES = {
  /** 680×400，4:2:0，大色块 + 圆 + 斜线（滑块底图用的就是这张）。 */
  bg: 'jpeg-bg-680x400.b64',
  /** 64×48，4:4:4。 */
  small444: 'jpeg-small-444-64x48.b64',
  /** 64×48，4:2:2（水平 2:1、垂直 1:1）。 */
  small422: 'jpeg-small-422-64x48.b64',
  /** 67×45，4:1:1（水平 4:1）—— Pillow 出不了，生成脚本自编。 */
  small411: 'jpeg-small-411-67x45.b64',
  /** 67×45 灰度。 */
  gray: 'jpeg-gray-67x45.b64',
  /** 64×48，4:2:0，DRI=3（每 3 个 MCU 一个 RSTn）—— 生成脚本自编。 */
  restart: 'jpeg-restart-420-64x48.b64',
} as const;

function fixture(name: string): Uint8Array {
  const text = readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
  return new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'base64'));
}

/** 取 RGBA 像素。越界直接报错，避免测试里手滑把 (x,y) 写反还"通过"。 */
function pixel(img: DecodedImage, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new Error(`测试点越界：(${x}, ${y}) 不在 ${img.width}x${img.height} 里`);
  }
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
}

/** 三个通道分别与期望值比较（JPEG 有量化误差，容差默认 3）。 */
function assertRgb(img: DecodedImage, x: number, y: number, expected: readonly [number, number, number], tol = 3): void {
  const got = pixel(img, x, y);
  for (let c = 0; c < 3; c += 1) {
    const d = Math.abs(got[c]! - expected[c]!);
    assert.ok(
      d <= tol,
      `像素 (${x}, ${y}) 的 ${['R', 'G', 'B'][c]} = ${got[c]}，期望 ${expected[c]}，差 ${d} > ${tol}`,
    );
  }
  assert.equal(got[3], 255, `像素 (${x}, ${y}) 的 alpha 应为 255`);
}

/** 找第一个 `FF xx` 标记，返回 FF 的下标；找不到返回 -1。 */
function markerOffset(bytes: Uint8Array, code: number): number {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === code) return i;
  }
  return -1;
}

function hasRestartMarker(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1]! >= 0xd0 && bytes[i + 1]! <= 0xd7) return true;
  }
  return false;
}

/** SOF 段里第 `comp` 个分量的 (h, v)。SOF 布局：FF C0 | len(2) | 精度 | 高(2) | 宽(2) | 分量数 | … */
function samplingOf(bytes: Uint8Array, comp: number): [number, number] {
  const sof = markerOffset(bytes, 0xc0);
  assert.ok(sof >= 0, '夹具里找不到 SOF0');
  const hv = bytes[sof + 11 + comp * 3]!;
  return [hv >> 4, hv & 15];
}

// ══════════════════════════════ 识别 ══════════════════════════════

test('isJpeg 认得出 JPEG，认不出 PNG / 垃圾', () => {
  for (const name of Object.values(FIXTURES)) {
    assert.equal(isJpeg(fixture(name)), true, `${name} 应该被认成 JPEG`);
  }

  const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(isJpeg(pngSignature), false);
  assert.equal(isJpeg(new Uint8Array(0)), false);
  assert.equal(isJpeg(Uint8Array.from([0xff, 0xd8])), false);
  assert.equal(isJpeg(Uint8Array.from([0x00, 0x01, 0x02, 0x03])), false);

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  assert.equal(isJpeg(new Uint8Array(pngBytes)), false, '1×1 PNG 不能被当成 JPEG');
});

// ══════════════════════════════ 主夹具：680×400 4:2:0 ══════════════════════════════

test('680×400 4:2:0 底图：尺寸、像素、边缘、性能', (t) => {
  const bytes = fixture(FIXTURES.bg);
  assert.deepEqual(samplingOf(bytes, 0), [2, 2], '主夹具应该是 4:2:0');

  const img = decodeJpeg(bytes);
  assert.equal(img.width, 680);
  assert.equal(img.height, 400);
  assert.ok(img.data instanceof Uint8ClampedArray);
  assert.equal(img.data.length, 680 * 400 * 4);

  // 四个色块内部 + 白底：离边界至少 20 像素，量化/上采样都不该把它挪出容差
  assertRgb(img, 100, 100, [30, 81, 199]); // 蓝
  assertRgb(img, 400, 120, [221, 60, 50]); // 红
  assertRgb(img, 300, 330, [41, 170, 90]); // 绿
  assertRgb(img, 540, 300, [250, 200, 41]); // 黄
  assertRgb(img, 650, 60, [244, 245, 239]); // 白底
  assertRgb(img, 20, 30, [244, 245, 239]);

  // 斜线是真的画上了：线中心很暗，线下方是白底。这一条同时检查"图不是一整块灰"
  const dark = pixel(img, 340, 200);
  const light = pixel(img, 340, 230);
  assert.ok(dark[0] < 60 && dark[1] < 60 && dark[2] < 60, `斜线处应接近黑，实际 ${dark}`);
  assert.ok(light[0] > 220 && light[1] > 220, `斜线下方应是白底，实际 ${light}`);

  // 宽松的性能上限（抓 O(n²) / 每块建数组那种病态实现）。QuickJS 的真实目标见任务说明。
  const t0 = performance.now();
  decodeJpeg(bytes);
  const ms = performance.now() - t0;
  t.diagnostic(`680×400 解码 ${ms.toFixed(1)}ms（Node；目标 QuickJS <300ms）`);
  assert.ok(ms < 1000, `680×400 解码耗时 ${ms.toFixed(1)}ms，超出宽松上限`);
});

// ══════════════════════════════ 各种采样因子 ══════════════════════════════

test('64×48 4:4:4：像素与 Pillow 一致', () => {
  const bytes = fixture(FIXTURES.small444);
  assert.deepEqual(samplingOf(bytes, 0), [1, 1]);
  const img = decodeJpeg(bytes);
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);
  assertRgb(img, 18, 12, [211, 50, 40]);
  assertRgb(img, 56, 17, [34, 119, 183]);
  assertRgb(img, 12, 29, [25, 159, 90]);
  assertRgb(img, 40, 38, [235, 190, 49]);
});

test('64×48 4:2:2：水平 2:1 上采样', () => {
  const bytes = fixture(FIXTURES.small422);
  assert.deepEqual(samplingOf(bytes, 0), [2, 1]);
  const img = decodeJpeg(bytes);
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);
  assertRgb(img, 18, 12, [212, 50, 39]);
  assertRgb(img, 56, 17, [34, 117, 193]);
  assertRgb(img, 12, 29, [32, 156, 84]);
  assertRgb(img, 40, 38, [235, 190, 49]);
});

test('67×45 4:1:1：水平 4:1 + 奇数尺寸的 MCU 补齐', () => {
  const bytes = fixture(FIXTURES.small411);
  assert.deepEqual(samplingOf(bytes, 0), [4, 1], '夹具必须真的是 4:1:1');
  const img = decodeJpeg(bytes);
  assert.equal(img.width, 67);
  assert.equal(img.height, 45);
  // 67 不是 32 的倍数，最后那个 MCU 的 Y 平面要补齐；下面这些点覆盖左/中/右
  assertRgb(img, 18, 12, [212, 51, 33]);
  assertRgb(img, 56, 17, [41, 120, 186]);
  assertRgb(img, 12, 29, [32, 158, 85]);
  assertRgb(img, 40, 38, [237, 188, 47]);
  assertRgb(img, 58, 38, [233, 190, 51]); // 黄色块最右一带（x=60 是右边界）
  assertRgb(img, 66, 44, [244, 245, 239]); // 最右列 / 最下行：补齐区不能把图撑错
});

test('灰度 67×45：单分量、奇数尺寸', () => {
  const bytes = fixture(FIXTURES.gray);
  const graySof = markerOffset(bytes, 0xc0);
  assert.ok(graySof >= 0);
  assert.equal(bytes[graySof + 9], 1, '灰度夹具应该只有 1 个分量');
  const img = decodeJpeg(bytes);
  assert.equal(img.width, 67);
  assert.equal(img.height, 45);

  assertRgb(img, 1, 1, [202, 202, 202]);
  assertRgb(img, 10, 10, [40, 40, 40]);
  assertRgb(img, 45, 10, [140, 140, 140]);
  assertRgb(img, 10, 35, [100, 100, 100]);

  // 渐变条：最左 8、中间 128、最右 247，并且单调递增（行方向错位会立刻破坏单调性）
  assertRgb(img, 35, 35, [8, 8, 8]);
  assertRgb(img, 50, 35, [128, 128, 128]);
  assertRgb(img, 65, 35, [247, 247, 247]);
  const g = [pixel(img, 36, 35)[0], pixel(img, 45, 35)[0], pixel(img, 55, 35)[0], pixel(img, 64, 35)[0]];
  for (let i = 1; i < g.length; i += 1) assert.ok(g[i]! > g[i - 1]!, `渐变应递增，实际 ${g}`);
});

// ══════════════════════════════ DRI / RSTn ══════════════════════════════

test('DRI=3 的重启文件：RSTn 边界处不漂移', () => {
  const bytes = fixture(FIXTURES.restart);
  const dri = markerOffset(bytes, 0xdd);
  assert.ok(dri >= 0, '夹具里应该有 DRI 段');
  assert.equal((bytes[dri + 4]! << 8) | bytes[dri + 5]!, 3, '夹具的 DRI 应为 3');
  assert.ok(hasRestartMarker(bytes), '夹具里应该有 RSTn 标记');

  const img = decodeJpeg(bytes);
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);
  // 这些点分布在 12 个 MCU 的多个重启区间里；DC 预测器没清零的话靠后的区域会整块偏色
  assertRgb(img, 18, 12, [213, 48, 42]);
  assertRgb(img, 56, 17, [42, 116, 201]);
  assertRgb(img, 12, 29, [25, 161, 89]);
  assertRgb(img, 40, 38, [236, 189, 49]);
});

// ══════════════════════════════ SOF1 / 拒绝的子集 ══════════════════════════════

test('SOF1（extended sequential）能解', () => {
  const bytes = fixture(FIXTURES.small444).slice();
  const sof = markerOffset(bytes, 0xc0);
  assert.ok(sof >= 0);
  bytes[sof + 1] = 0xc1; // SOF0 → SOF1：8-bit 顺序编码，位流结构相同
  const img = decodeJpeg(bytes);
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);
  assertRgb(img, 40, 38, [235, 190, 49]);
});

test('progressive（SOF2）给中文错误，并带 progressive/渐进', () => {
  const bytes = fixture(FIXTURES.small444).slice();
  const sof = markerOffset(bytes, 0xc0);
  assert.ok(sof >= 0);
  bytes[sof + 1] = 0xc2;
  assert.throws(
    () => decodeJpeg(bytes),
    (err: unknown) => err instanceof Error && /progressive|渐进/.test(err.message),
  );
});

test('算术编码（SOF9）被拒绝', () => {
  const bytes = fixture(FIXTURES.small444).slice();
  const sof = markerOffset(bytes, 0xc0);
  assert.ok(sof >= 0);
  bytes[sof + 1] = 0xc9;
  assert.throws(
    () => decodeJpeg(bytes),
    (err: unknown) => err instanceof Error && /算术/.test(err.message),
  );
});

test('12-bit 精度被拒绝', () => {
  const bytes = fixture(FIXTURES.small444).slice();
  const sof = markerOffset(bytes, 0xc0);
  assert.ok(sof >= 0);
  bytes[sof + 4] = 12; // 精度字节
  assert.throws(
    () => decodeJpeg(bytes),
    (err: unknown) => err instanceof Error && /12-bit/.test(err.message),
  );
});

test('4 分量（CMYK/YCCK）被拒绝，2 分量也不硬解', () => {
  const makeSof = (ncomp: number): Uint8Array => {
    const body: number[] = [8, 0, 16, 0, 16, ncomp]; // 精度 8、16×16
    for (let i = 0; i < ncomp; i += 1) body.push(i + 1, 0x11, 0);
    const len = body.length + 2;
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, len >> 8, len & 0xff, ...body, 0xff, 0xd9]);
  };
  assert.throws(
    () => decodeJpeg(makeSof(4)),
    (err: unknown) => err instanceof Error && /4 个分量/.test(err.message),
  );
  assert.throws(
    () => decodeJpeg(makeSof(2)),
    (err: unknown) => err instanceof Error && /2 个分量/.test(err.message),
  );
});

// ══════════════════════════════ 坏数据 ══════════════════════════════

test('截断的 JPEG 抛错（不返回半张图）', () => {
  const main = fixture(FIXTURES.bg);
  for (const frac of [0.2, 0.6, 0.95]) {
    const cut = main.subarray(0, Math.floor(main.length * frac));
    assert.throws(
      () => decodeJpeg(cut),
      (err: unknown) => err instanceof Error && /截断|提前结束|找不到下一个标记/.test(err.message),
      `截到 ${frac * 100}% 应该抛错`,
    );
  }
});

test('垃圾数据 / 空数据抛错', () => {
  assert.throws(() => decodeJpeg(new Uint8Array(0)), /不是 JPEG/);
  assert.throws(() => decodeJpeg(Uint8Array.from([1, 2, 3, 4])), /不是 JPEG/);
  assert.throws(() => decodeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), /SOF|SOS/);
  // 指到 PNG 上也不能硬解
  const png = fixture(FIXTURES.small444); // 只是拿一段非 JPEG 字节
  const notJpeg = new Uint8Array([0x89, 0x50, ...png.subarray(0, 32)]);
  assert.throws(() => decodeJpeg(notJpeg), /不是 JPEG/);
});
