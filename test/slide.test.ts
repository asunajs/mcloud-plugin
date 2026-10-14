// 滑块求解 —— 用**合成题面**验（offset 是我们自己摆的，所以标准答案确定）。
//
// 为什么不用真题面当夹具：真题面是服务端随机生成的，写进测试就得连着答案一起钉死，
// 而那个答案只在"某个版本的服务端"下成立。合成题面的标准答案是**构造出来的**。
// "算法在真题面上能不能用"由真机那一枪回答。
//
// ⚠ 夹具的形状很关键，我在这里错过两次，两次都是**夹具错**而不是算法错：
//   ① 第一版把整张 `PZ×PZ` 都填成拼图 ⇒ 没有透明边 ⇒ 轮廓为空、匹配退化；
//   ② 第二版改成"透明边 + 纯噪声底图抠一块" ⇒ 拼图的**边界环**落到纯噪声里
//      没有任何对应边缘 ⇒ 峰值不成立、解出错的位置。
//   真实题面是"底图上挖了一个**有描边**的洞"，匹配咬住的正是
//   "拼图边界环 ↔ 洞的描边"这条对应。夹具必须照这个形状造。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as encodePng } from 'fast-png';

import { decodeImage } from '../src/crypto/png.ts';
import { ALPHA_OPAQUE_THRESHOLD, calcPuzzleOffset, matchSlide, usable } from '../src/mcloud/slide.ts';
import { toBase64 } from '../src/crypto/bytes.ts';

const BG_W = 320;
const BG_H = 160;
const PZ = 60;
/** 透明边宽度（真实题面里拼图四周是透明的）。 */
const PAD = 10;
const PIECE = PZ - PAD * 2;

/** 确定性伪随机 —— 测试要能重复。 */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeBg(seed = 7): Uint8ClampedArray {
  const r = rnd(seed);
  const d = new Uint8ClampedArray(BG_W * BG_H * 4);
  for (let i = 0; i < BG_W * BG_H; i += 1) {
    d[i * 4] = Math.floor(r() * 256);
    d[i * 4 + 1] = Math.floor(r() * 256);
    d[i * 4 + 2] = Math.floor(r() * 256);
    d[i * 4 + 3] = 255;
  }
  return d;
}

const asImage = (data: Uint8ClampedArray, w: number, h: number) => ({ data, width: w, height: h });

/** 造一题：底图上挖一个**有描边**的洞；那块拼图就是洞里原来的内容。
 *
 *  ⚠ `oy` 必须**等于 `PAD`**：匹配器只在 **x** 方向平移（滑块本来就只横向），
 *  y 是对齐的 —— 也就是说拼图画布的 y 坐标要直接就是底图的 y。
 *  第一版把洞挖在 `oy = 30` 而画布从 `PAD` 起算 ⇒ y 少对齐一截，
 *  结果是"差 1 像素"（凑巧与 mcloud 注释里记的实拍分歧同一个量级，更容易看错方向）。
 *
 *  摆的位置是 `at`；拼图局部坐标 `x` 对应底图 `at + (x - PAD)`
 *  ⇒ 匹配器算的 `offset + contourX = 底图 x` ⇒ **正确答案 `at - PAD`**。 */
function makeCase(
  seed: number,
  at: number,
  oy: number,
): { bg: Uint8ClampedArray; piece: Uint8ClampedArray } {
  const bg = makeBg(seed);
  const piece = new Uint8ClampedArray(PZ * PZ * 4); // 初始全透明
  for (let y = 0; y < PIECE; y += 1) {
    for (let x = 0; x < PIECE; x += 1) {
      const si = ((oy + y) * BG_W + (at + x)) * 4;
      const di = ((y + PAD) * PZ + (x + PAD)) * 4;
      piece[di] = bg[si]!;
      piece[di + 1] = bg[si + 1]!;
      piece[di + 2] = bg[si + 2]!;
      piece[di + 3] = 255;
    }
  }
  // 挖洞：浅底 + 深描边（**描边就是匹配要咬住的信号**）
  for (let y = 0; y < PIECE; y += 1) {
    for (let x = 0; x < PIECE; x += 1) {
      const border = y < 2 || x < 2 || y >= PIECE - 2 || x >= PIECE - 2;
      const si = ((oy + y) * BG_W + (at + x)) * 4;
      const v = border ? 20 : 235;
      bg[si] = v;
      bg[si + 1] = v;
      bg[si + 2] = v;
    }
  }
  return { bg, piece };
}

test('**主线**：合成题面（答案自己摆的）能解对', () => {
  for (const at of [PAD, PAD + 1, 47, 147, 210, BG_W - PAD - PIECE]) {
    const want = at - PAD;
    const { bg, piece } = makeCase(7, at, PAD);
    const r = matchSlide(asImage(bg, BG_W, BG_H), asImage(piece, PZ, PZ), BG_W, BG_H, PZ, PZ);
    // ⚠ 容差 **1 像素**，理由是具体的，不是"差不多就行"：
    //   · 我造的洞是 **2px 描边** ⇒ 相邻两个 offset 上落点都是描边、分数打平，
    //     谁赢取决于遍历顺序 ⇒ 边界处必然有 1 像素的不确定；
    //   · mcloud 自己的注释里也记着这件事：两份口径在实拍上"分歧恰好是 1"；
    //   · 滑块的容差本来就大于 1（否则真人拖也过不去）。
    // 所以这条测的是"是否解在正确位置附近"，而**精度**那一层由真机那一枪回答。
    assert.ok(
      Math.abs(r.offsetX - want) <= 1,
      `摆的 ${at}（答案 ${want}），解出来 ${r.offsetX}（置信度 ${r.confidence.toFixed(2)}）`,
    );
    assert.ok(r.confidence > 1.5, `正确答案的置信度该突出：${r.confidence}`);
    assert.equal(usable(r), true);
  }
});

test('⚠ 退化情形：拼图整块透明 ⇒ offset 是 0 **且置信度是 0**', () => {
  const bg = makeBg(7);
  const blank = new Uint8ClampedArray(PZ * PZ * 4); // 全透明
  const r = matchSlide(asImage(bg, BG_W, BG_H), asImage(blank, PZ, PZ), BG_W, BG_H, PZ, PZ);
  assert.equal(r.offsetX, 0);
  assert.equal(r.confidence, 0, '这条是关键：`0` 不能与"真的不用滑"混为一谈');
  assert.equal(usable(r), false, '算不出来 ⇒ 不该发那一枪');
});

test('边界：拼图与底图同宽 ⇒ 不越界；拼图比底图还宽 ⇒ 也不崩', () => {
  const { bg, piece } = makeCase(3, PAD, PAD);
  const r = matchSlide(asImage(bg, BG_W, BG_H), asImage(piece, BG_W, BG_H), BG_W, BG_H, BG_W, BG_H);
  assert.equal(r.offsetX, 0, '同宽时只有 offset 0 可试');
  // 拼图比底图还宽 ⇒ 不该崩，也不该给出一个负数 offset
  const r2 = matchSlide(
    asImage(bg, BG_W, BG_H),
    asImage(piece, BG_W, BG_H),
    BG_W,
    BG_H,
    BG_W + 10,
    BG_H,
  );
  assert.equal(r2.offsetX, 0);
});

test('`alpha === 128` 算**透明**（照抄原实现的边界归属）', () => {
  assert.equal(ALPHA_OPAQUE_THRESHOLD, 128);
  const bg = makeBg(7);
  const pz = new Uint8ClampedArray(PZ * PZ * 4);
  for (let i = 0; i < PZ * PZ; i += 1) pz[i * 4 + 3] = 128;
  pz[(30 * PZ + 30) * 4 + 3] = 129; // 唯一一个不透明 ⇒ 它自己构成轮廓、置信度不突出
  const r = matchSlide(asImage(bg, BG_W, BG_H), asImage(pz, PZ, PZ), BG_W, BG_H, PZ, PZ);
  assert.ok(r.offsetX >= 0, '不该崩');
});

test('解码那一层：PNG 往返一次，像素逐字节不变（RGBA 与 RGB 都要）', () => {
  const bg = makeBg(11);
  const back4 = decodeImage(
    new Uint8Array(encodePng({ width: BG_W, height: BG_H, data: bg, channels: 4 })),
  );
  assert.equal(back4.width, BG_W);
  assert.equal(back4.height, BG_H);
  assert.deepEqual(Array.from(back4.data.subarray(0, 40)), Array.from(bg.subarray(0, 40)));

  // RGB（3 通道）要补成不透明
  const rgb = new Uint8Array(BG_W * BG_H * 3);
  for (let i = 0; i < BG_W * BG_H; i += 1) {
    rgb[i * 3] = i % 256;
    rgb[i * 3 + 1] = (i * 3) % 256;
    rgb[i * 3 + 2] = (i * 7) % 256;
  }
  const back3 = decodeImage(
    new Uint8Array(encodePng({ width: BG_W, height: BG_H, data: rgb, channels: 3 })),
  );
  assert.equal(back3.data[3], 255, '补出来的 alpha 该是 255');
  assert.equal(back3.data[0], 0);
});

test('`calcPuzzleOffset` 收 base64（题面就是这个形状）', () => {
  const at = 137 + PAD;
  const { bg, piece } = makeCase(7, at, PAD);
  const got = calcPuzzleOffset(
    toBase64(new Uint8Array(encodePng({ width: PZ, height: PZ, data: piece, channels: 4 }))),
    toBase64(new Uint8Array(encodePng({ width: BG_W, height: BG_H, data: bg, channels: 4 }))),
  );
  assert.ok(Math.abs(got.offsetX - (at - PAD)) <= 1, `解出来 ${got.offsetX}，目标 ${at - PAD}`);
  assert.equal(usable(got), true);
});

test('坏图要**抛**，不能悄悄给一张"看着像图"的', () => {
  assert.throws(() => decodeImage(new Uint8Array([1, 2, 3, 4])));
});
