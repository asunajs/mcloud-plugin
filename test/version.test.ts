// 版本号只有一个真相：`package.json`。界面显示的那份、面板清单里的那份都必须跟着它走。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PLUGIN_VERSION } from '../src/version.ts';

const NAMES = ['mcloud', 'mcloud-daily', 'mcloud-exchange', 'mcloud-live'];

test('界面显示的版本 == package.json 的 version', async () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string };
  assert.equal(
    PLUGIN_VERSION,
    pkg.version,
    `src/version.ts 里是 ${PLUGIN_VERSION}，package.json 是 ${String(pkg.version)} —— 发版时两个一起改`,
  );
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/, '用 x.y.z');
});

// 面板「插件」列表读的是清单里的 version —— 它和界面上那行 `v…` 是两个来源，
// 漂了就是「列表说 0.4.4、页面说 0.5.0」，用户没法判断到底装的是哪一版。
test('四份面板清单的 version 也 == package.json', async () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string };
  for (const name of NAMES) {
    const m = JSON.parse(fs.readFileSync(`plugins/panelllrt/${name}.panel.json`, 'utf8')) as {
      version?: string;
    };
    assert.equal(m.version, pkg.version, `${name}.panel.json 里是 ${String(m.version)}，package.json 是 ${String(pkg.version)}`);
  }
});
