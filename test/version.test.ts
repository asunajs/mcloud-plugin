// 版本号只有一个真相：`package.json`。界面显示的那份必须跟着它走。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PLUGIN_VERSION } from '../src/version.ts';

test('界面显示的版本 == package.json 的 version', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string };
  assert.equal(
    PLUGIN_VERSION,
    pkg.version,
    `src/version.ts 里是 ${PLUGIN_VERSION}，package.json 是 ${String(pkg.version)} —— 发版时两个一起改`,
  );
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/, '用 x.y.z');
});
