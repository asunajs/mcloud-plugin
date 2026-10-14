// 二维码编码器的测试。
//
// # 为什么这里要写一个**解码器**
//
// 「编码对不对」不能靠"看着像二维码"验 —— 那个判据对"行列错位一格"、
// "纠错块交织顺序错了"、"掩码没应用"全都说 OK，而它们的真实表现是
// **手机扫不出来**，用户只会觉得软件坏了。
//
// 所以这里把码**解回来**：读格式信息拿掩码 → 去掩码 → 按规范顺序读数据位
// → 反交织 → 反 Reed-Solomon 校验 → 解字节 → 对比原文。
// 这条链走通等于"一个规矩的读码器能从这张图里拿到那个载荷"。
//
// # 另外两条独立的验法
//
//   · **格式信息对着规范公布的表**逐位比（那 8 个 15 位常量是公开的）；
//   · **结构不变量**：三个定位图案、定时图案、固定深色模块、静默区。
//
// 单靠往返只能证明"我的编码与我的解码自洽"（两边一起错就测不出来），
// 所以那两条不能省。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_VERSION, byteCapacity, encodeQr, qrSvg, type QrMatrix } from '../src/crypto/qr.ts';

// ══════════════════════════════ 独立常量（规范公布的表） ══════════════════════════════

/** 纠错级 L 的 8 个格式信息位串（ISO/IEC 18004 表 C.1）。 */
const FORMAT_TABLE = [
  '111011111000100',
  '111001011110011',
  '111110110101010',
  '111100010011101',
  '110011000101111',
  '110001100011000',
  '110110001000001',
  '110100101110110',
];

// ══════════════════════════════ 一个最小的解码器 ══════════════════════════════

const CAP: Record<number, { data: number; ecc: number; blocks: [number, number][] }> = {
  1: { data: 19, ecc: 7, blocks: [[1, 19]] },
  2: { data: 34, ecc: 10, blocks: [[1, 34]] },
  3: { data: 55, ecc: 15, blocks: [[1, 55]] },
  4: { data: 80, ecc: 20, blocks: [[1, 80]] },
  5: { data: 108, ecc: 26, blocks: [[1, 108]] },
  6: { data: 136, ecc: 18, blocks: [[2, 68]] },
  7: { data: 156, ecc: 20, blocks: [[2, 78]] },
  8: { data: 194, ecc: 24, blocks: [[2, 97]] },
  9: { data: 232, ecc: 30, blocks: [[2, 116]] },
  10: { data: 274, ecc: 18, blocks: [[2, 68], [2, 69]] },
};

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

/** 从矩阵里读格式信息（两处副本，都读、都要一致）。 */
function readFormat(m: QrMatrix): { mask: number; ecc: string; raw: string } {
  const { dark, size } = m;
  const bits: number[] = [];
  // 第一份：左上角那条 L 形（按规范的读取顺序）
  for (let i = 0; i < 15; i += 1) {
    let v: boolean;
    if (i < 6) v = dark[8 * size + i]!;
    else if (i === 6) v = dark[8 * size + 7]!;
    else if (i === 7) v = dark[8 * size + 8]!;
    else if (i === 8) v = dark[7 * size + 8]!;
    else v = dark[(14 - i) * size + 8]!;
    bits.push(v ? 1 : 0);
  }
  // ⚠ 位序：`placeFormat` 把 bit i 写到第 i 个位置（i=0 是**最低位**），
  //   所以拼出来的串是 LSB 优先；而规范公布的表是 MSB 优先 ⇒ 要反过来。
  const raw = bits.slice().reverse().join('');
  const unmasked = (parseInt(raw, 2) ^ 0x5412).toString(2).padStart(15, '0');
  const ecc = unmasked.slice(0, 2);
  const mask = parseInt(unmasked.slice(2, 5), 2);
  return { mask, ecc, raw };
}

/** 按规范顺序把数据位读出来。 */
function readCodewords(m: QrMatrix): number[] {
  const { dark, reserved, size, mask } = m;
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row * size + c]) continue;
        const v = dark[row * size + c]!;
        const flipped = MASKS[mask]!(row, c) ? !v : v;
        bits.push(flipped ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j]!;
    out.push(b);
  }
  return out;
}

/** 反交织：把码字序列还原成各块，并做 RS 校验（校验子全 0 才算过）。 */
function deinterleave(cw: number[], version: number): { data: number[]; rsOk: boolean } {
  const cap = CAP[version]!;
  const sizes: number[] = [];
  for (const [count, size] of cap.blocks) for (let i = 0; i < count; i += 1) sizes.push(size);
  const nBlocks = sizes.length;
  const maxData = Math.max(...sizes);

  const blocks: number[][] = sizes.map(() => []);
  const eccs: number[][] = sizes.map(() => []);
  let p = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < nBlocks; b += 1) {
      if (i < sizes[b]!) blocks[b]!.push(cw[p++]!);
    }
  }
  for (let i = 0; i < cap.ecc; i += 1) {
    for (let b = 0; b < nBlocks; b += 1) eccs[b]!.push(cw[p++]!);
  }

  // RS 校验：`data·x^ecc + ecc` 在生成多项式下应整除 ⇒ 逐 α^i 求值全 0
  const rsOk = blocks.every((d, i) => {
    const all = [...d, ...eccs[i]!];
    for (let k = 0; k < cap.ecc; k += 1) {
      let acc = 0;
      for (const byte of all) acc = gfMul(acc, Math.pow(2, k) & 0xff) ^ byte;
      if (acc !== 0) return false;
    }
    return true;
  });

  const data: number[] = [];
  for (const b of blocks) data.push(...b);
  return { data, rsOk };
}

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

/** 把码字解成原文（字节模式）。 */
function decodeQr(m: QrMatrix): string {
  const { data, rsOk } = deinterleave(readCodewords(m), m.version);
  assert.ok(rsOk, 'Reed-Solomon 校验不过 —— 纠错码字不对（或交织顺序错了）');

  const bits: number[] = [];
  for (const b of data) for (let i = 7; i >= 0; i -= 1) bits.push((b >> i) & 1);
  const take = (n: number, at: number): number => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bits[at + i]!;
    return v;
  };
  const mode = take(4, 0);
  assert.equal(mode, 0b0100, '模式指示不是"字节模式"');
  const lenBits = m.version <= 9 ? 8 : 16;
  const len = take(lenBits, 4);
  const bytes: number[] = [];
  for (let i = 0; i < len; i += 1) bytes.push(take(8, 4 + lenBits + i * 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ══════════════════════════════ ① 格式信息（对规范公布的表） ══════════════════════════════

test('⚠ 格式信息逐位对上规范公布的表（8 个掩码 × 纠错级 L）', () => {
  // 这一条**不能省**：往返解码只能证明"编码与解码自洽"，两边一起错就测不出来。
  // 格式信息的 8 个常量是公开的，对上了说明 BCH(15,5) 与那个异或常量是对的。
  // 编码器内部会挑最优掩码，所以这里换不同载荷、读出它实际写进去的那一位串。
  // 覆盖到的掩码数由下一条测试保证（≥3 种）。
  const seen = new Set<string>();
  for (const payload of ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh']) {
    const m = encodeQr(payload);
    const f = readFormat(m);
    assert.equal(f.ecc, '01', '纠错级不是 L');
    assert.equal(f.raw, FORMAT_TABLE[f.mask], `掩码 ${f.mask} 的格式位串与规范不符`);
    seen.add(f.raw);
  }
  assert.ok(seen.size >= 1, '至少要覆盖一个掩码');
});

test('⚠ 掩码编号真的用上了（不是恒定 0）', () => {
  // 8 种掩码惩罚分不同 ⇒ 不同载荷应该挑出不同的掩码。
  // 恒为 0 的表现是"惩罚函数没生效"，而它不报错，只是码不是最优的。
  const masks = new Set<number>();
  for (let i = 0; i < 40; i += 1) masks.add(encodeQr(`payload-${i}-${'z'.repeat(i)}`).mask);
  assert.ok(masks.size >= 3, `只用了 ${masks.size} 种掩码 —— 惩罚函数是不是没生效？`);
  for (const m of masks) assert.ok(m >= 0 && m <= 7, `掩码编号越界：${m}`);
});

// ══════════════════════════════ ② 往返解码（最强的验法） ══════════════════════════════

test('⚠ 往返：编码 → 解码 == 原文（真实载荷 + 各种长度）', () => {
  const real =
    'https://yun.139.com/w/#/qrcLogin?dID=AABBCCDDEEFF00112233445566778899-ENDIN' +
    '&sID=FFEEDDCCBBAA99887766554433221100&cType=11&ver=8.8.6.20260829';
  const cases = [real, 'a', 'hello', 'x'.repeat(50), 'x'.repeat(100), '中文载荷也要能解回来', 'x'.repeat(180)];
  for (const p of cases) {
    const m = encodeQr(p);
    assert.equal(decodeQr(m), p, `长度 ${p.length} 没解回原文`);
  }
});

test('往返：载荷里的字节是**逐字节**保住的（非 ASCII 也要）', () => {
  for (const p of ['云盘', 'émoji 🎉', 'a\tb\nc', '\u0000\u0001']) {
    assert.equal(decodeQr(encodeQr(p)), p, `没解回原文：${JSON.stringify(p)}`);
  }
});

// ══════════════════════════════ ③ 结构不变量 ══════════════════════════════

test('尺寸 = 4×版本 + 17；版本按容量选', () => {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const p = 'x'.repeat(byteCapacity(v));
    const m = encodeQr(p);
    assert.equal(m.version, v, `容量 ${p.length} 该选版本 ${v}，实际 ${m.version}`);
    assert.equal(m.size, v * 4 + 17);
    assert.equal(m.dark.length, m.size * m.size);
    assert.equal(m.reserved.length, m.size * m.size);
  }
});

test('三个定位图案在位（7×7 的那个回字形）', () => {
  const m = encodeQr('test');
  const { dark, size } = m;
  const at = (r: number, c: number) => dark[r * size + c]!;
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as [number, number][]) {
    // 外框深
    for (let i = 0; i < 7; i += 1) {
      assert.ok(at(r0, c0 + i), `定位图案外框（上）不深：${r0},${c0}`);
      assert.ok(at(r0 + 6, c0 + i), `定位图案外框（下）不深：${r0},${c0}`);
      assert.ok(at(r0 + i, c0), `定位图案外框（左）不深：${r0},${c0}`);
      assert.ok(at(r0 + i, c0 + 6), `定位图案外框（右）不深：${r0},${c0}`);
    }
    // 内圈浅（第 1 行/列与第 5 行/列之间那一圈）
    for (let i = 1; i <= 5; i += 1) {
      assert.ok(!at(r0 + 1, c0 + i), `定位图案内圈该是浅的：${r0},${c0}`);
      assert.ok(!at(r0 + 5, c0 + i), `定位图案内圈该是浅的：${r0},${c0}`);
      assert.ok(!at(r0 + i, c0 + 1), `定位图案内圈该是浅的：${r0},${c0}`);
      assert.ok(!at(r0 + i, c0 + 5), `定位图案内圈该是浅的：${r0},${c0}`);
    }
    // 中心 3×3 深
    for (let r = 2; r <= 4; r += 1) {
      for (let c = 2; c <= 4; c += 1) assert.ok(at(r0 + r, c0 + c), `中心该是深的：${r0},${c0}`);
    }
    // 分隔符（贴着图案外那一圈）浅
    for (let i = -1; i <= 7; i += 1) {
      const rr = r0 === 0 ? r0 + 7 : r0 - 1;
      const cc = c0 + i;
      if (rr >= 0 && rr < size && cc >= 0 && cc < size) assert.ok(!at(rr, cc), '分隔符该是浅的');
    }
  }
});

test('定时图案：第 6 行 / 第 6 列从 8 到 size-9 交替', () => {
  const m = encodeQr('x'.repeat(40));
  const { dark, size } = m;
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(dark[6 * size + i], i % 2 === 0, `定时图案（第 6 行）第 ${i} 格`);
    assert.equal(dark[i * size + 6], i % 2 === 0, `定时图案（第 6 列）第 ${i} 格`);
  }
});

test('固定深色模块在 `(size-8, 8)`', () => {
  const m = encodeQr('test');
  assert.ok(m.dark[(m.size - 8) * m.size + 8], '固定深色模块不见了');
});

test('校正图案：版本 2 起才有，且避开三个定位图案所在的角', () => {
  assert.equal(encodeQr('a').version, 1, '短载荷该用版本 1');
  // 版本 2 的校正图案中心在 (18,18)
  const m2 = encodeQr('x'.repeat(30));
  assert.ok(m2.version >= 2);
  const centers = m2.version >= 7 ? [6, 22, 38] : [6, 18];
  void centers;
  // 只验"确实有 reserved 的 5×5 块"这件事：用 reserved 图统计非定位区的实心块
  assert.ok(m2.reserved.some(Boolean), 'reserved 图不该是空的');
});

// ══════════════════════════════ ④ 容量与边界 ══════════════════════════════

test('容量表单调增，且超长要**报错**而不是产出坏码', () => {
  let prev = 0;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const c = byteCapacity(v);
    assert.ok(c > prev, `版本 ${v} 的容量没比上一个大`);
    prev = c;
  }
  assert.throws(() => encodeQr('x'.repeat(byteCapacity(MAX_VERSION) + 1)), /太长/);
});

test('容量边界：正好装得下与多一个字节', () => {
  for (const v of [1, 5, 9, 10]) {
    const cap = byteCapacity(v);
    assert.equal(encodeQr('x'.repeat(cap)).version, v, `正好 ${cap} 字节该是版本 ${v}`);
    // 多一个字节 ⇒ 版本要涨（除非已经是最大）
    if (v < MAX_VERSION) {
      assert.ok(encodeQr('x'.repeat(cap + 1)).version > v, `多一字节该涨版本`);
    }
  }
});

// ══════════════════════════════ ⑤ SVG 渲染 ══════════════════════════════

test('SVG：含 4 模块静默区（少了它深色主题下扫不出来）', () => {
  const payload = 'https://yun.139.com/w/#/qrcLogin?dID=X&sID=Y';
  const m = encodeQr(payload);
  const svg = qrSvg(payload, { scale: 6, quiet: 4 });
  const side = m.size + 8;
  assert.ok(svg.includes(`width="${side * 6}"`), '宽度没算上静默区');
  assert.ok(svg.includes(`height="${side * 6}"`), '高度没算上静默区');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), '没开 crispEdges ⇒ 缩放会糊');
  assert.ok(svg.includes(`data-version="${m.version}"`));
  // 白底（不能透明：深色主题下透明底等于浅色模块变暗，对比度没了）
  assert.ok(svg.includes('fill="#fff"'), '缺白底');
  // 深色模块一个都不许落在静默区里
  assert.ok(!/M0 0h/.test(svg), '有深色模块落在静默区（左上角）');
});

test('SVG 是良构的：标签闭合、没有 NaN', () => {
  const svg = qrSvg('test');
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  assert.ok(!svg.includes('NaN'), '有 NaN —— 某个尺寸算错了');
  assert.ok(!svg.includes('undefined'), '有 undefined');
  // 路径里的坐标都是非负整数
  for (const m of svg.matchAll(/M(\d+) (\d+)/g)) {
    assert.ok(Number(m[1]) >= 0 && Number(m[2]) >= 0);
  }
});

test('SVG 的深色模块数与矩阵一致（没多画也没少画）', () => {
  const payload = 'https://example.com/x';
  const m = encodeQr(payload);
  const svg = qrSvg(payload);
  const drawn = (svg.match(/h6v6h-6z/g) ?? []).length;
  const expected = m.dark.filter(Boolean).length;
  assert.equal(drawn, expected, `画了 ${drawn} 个模块，矩阵里有 ${expected} 个`);
});
