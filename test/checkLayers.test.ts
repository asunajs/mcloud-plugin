// 分层门禁自己的判据：`importsOf` 要认得**三种 import 形状**。
//
// 2026-11-26 实测的坑：原来只查 `from 'node:`，我往 `src/mcloud/rand.ts` 加一行
// `import 'node:fs';`（副作用形式）—— **门禁照样通过**。只认一种写法的门禁等于没有。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importsOf } from '../scripts/check-layers.mjs';

test('三种 import 形状都要认（副作用 / 动态 / from）', () => {
  for (const src of [
    `import { readFileSync } from 'node:fs';`,
    `import 'node:fs';`,
    `void import('node:fs');`,
    `import * as fs from "node:fs";`, // 双引号也认
  ]) {
    assert.equal(importsOf(src, 'node:'), true, `没认出：${src}`);
  }
});

test('相对路径与 panel:host 同样三种形状都认', () => {
  assert.equal(importsOf(`import x from '../host/panel/impl.ts';`, '../host/'), true);
  assert.equal(importsOf(`import '../host/panel/impl.ts';`, '../host/'), true);
  assert.equal(importsOf(`void import('../host/panel/impl.ts');`, '../host/'), true);
  assert.equal(importsOf(`import 'panel:host';`, 'panel:host'), true);
});

test('注释里提到不算（仓库里到处写着"不许 from \'node:fs\'"这种说明）', () => {
  assert.equal(importsOf(`// from 'node:fs' 是禁止的`, 'node:'), false);
  assert.equal(importsOf(`/* import 'node:fs'; */`, 'node:'), false);
  // 别的包名不该被 `node:` 命中
  assert.equal(importsOf(`import x from 'node-fetch';`, 'node:'), false);
});

test('⚠ 已知取舍：字符串里写成 import 形状**仍会算上**（宁可误伤，不漏）', () => {
  // 剥注释是安全的（注释本来就不是代码）；剥字符串则可能把真 import 一起吃掉，
  // 所以这里**故意不剥**。真遇到了，把那句字符串改个写法即可。
  assert.equal(importsOf(`const s = "from 'node:fs'";`, 'node:'), true);
});
