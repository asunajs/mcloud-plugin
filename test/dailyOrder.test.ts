// 领取类必须在所有“会产生奖励”的动作之后 —— 先领就会漏掉这一趟刚挣到的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src =
  readFileSync(new URL('../src/entries/daily.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/mcloud/dailyRun.ts', import.meta.url), 'utf8');

test('日常顺序：任务拓展 / App 任务 / App 任务状态 都在「领取AI豆」之前', () => {
  // 2026-11-01：旧的「消息推送奖励」那一步删了（服务端自己记账），顺序断言改成
  // 盯住新的那一步「App 任务状态」—— 它读的就是刚刷新的矩阵，必须排在领取之前。
  const claim = src.indexOf('// ⑤ 领取类');
  assert.ok(claim > 0, '没找到领取类那一段');
  for (const marker of ['// ③ 任务拓展', '// ④ App 任务', '// ④b App 任务状态']) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `没找到 ${marker}`);
    assert.ok(at < claim, `${marker} 必须在领取类之前`);
  }
  // 旧的三条任务**不许**再出现（删就要删干净）
  for (const gone of ['runBackupGift', 'runNotice', 'runMsgPushStatus', 'runMsgPushObtain']) {
    assert.equal(src.includes(gone), false, `旧任务 ${gone} 还在日常链里`);
  }
});

test('日常尾部：清理临时文件、今日云朵都走 push（⇒ 面板日志 + 推送正文）', () => {
  const cleanup = src.indexOf("once('清理临时文件'");
  const cloud = src.indexOf("once('今日云朵'");
  assert.ok(cleanup > 0, '没找到链尾清理');
  assert.ok(cloud > cleanup, '今日云朵要排在清理之后（参考实现 afterTask 的顺序）');
  // 走 `push` 才会进 `detail`，面板入口再用 detail 组推送正文。
  assert.ok(src.includes('push(once(\'清理临时文件\''), '清理必须走 push');
  assert.ok(src.includes('push(once(\'今日云朵\''), '今日云朵必须走 push');
});
