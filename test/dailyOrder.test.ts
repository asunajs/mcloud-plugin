// 领取类必须在所有“会产生奖励”的动作之后 —— 先领就会漏掉这一趟刚挣到的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src =
  readFileSync(new URL('../src/entries/daily.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/mcloud/dailyRun.ts', import.meta.url), 'utf8');

test('日常顺序：任务拓展 / App 任务 / 消息推送 都在「领取AI豆」之前', () => {
  const claim = src.indexOf('// ⑥ 领取类');
  assert.ok(claim > 0, '没找到领取类那一段');
  for (const marker of ['// ③ 任务拓展', '// ④ App 任务', '// ⑤ 消息推送奖励']) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `没找到 ${marker}`);
    assert.ok(at < claim, `${marker} 必须在领取类之前`);
  }
});
