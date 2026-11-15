// 慢只读端点的超时策略 —— 2026-11-15 10:05 现场：三个账号的 AI豆余额全报
// 「请求超时（1500ms）」。本机实测 infoV3 单发 0.83~1.05 秒（每次重做 TLS 握手约 0.65 秒），
// 1500ms 只有 1.5 倍余量，抖一下就超。
//
// 钉住两件事：
//   ① 只读慢端点（infoV3 / cloudRecordV2）放宽到 12 秒
//   ② **写操作保持 1500ms**（打卡/上报一旦超时放宽，就会出现"上游动作已发生、
//      任务却报失败"，见 docs/findings.md F-001）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  SLOW_READ_TIMEOUT_MS,
  timeoutForUrl,
} from '../src/mcloud/timeoutPolicy.ts';

test('timeoutForUrl：只读慢端点 12s，写操作仍 1500ms', () => {
  const slow = [
    // ⚠ 用**真实**路径（第一版正则写死前缀，一条都没匹配上）
    'https://m.mcloud.139.com/ycloud/signin/public/cloudRecordV2?pageNumber=1&pageSize=20',
    'https://m.mcloud.139.com/ycloud/signin/page/infoV3?client=app',
  ];
  for (const u of slow) {
    assert.deepEqual(timeoutForUrl(u), { ms: SLOW_READ_TIMEOUT_MS, why: 'slow-read' }, u);
  }
  const write = [
    'https://m.mcloud.139.com/ycloud/signin/task/click?key=task&id=434',
    'https://m.mcloud.139.com/ycloud/signin/page/doTaskPost',
    'https://m.mcloud.139.com/ycloud/signin/task/click?key=task2&id=619',
  ];
  for (const u of write) {
    assert.deepEqual(timeoutForUrl(u), { ms: DEFAULT_REQUEST_TIMEOUT_MS, why: 'default' }, u);
  }
  assert.equal(SLOW_READ_TIMEOUT_MS, 12_000);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 1500);
});
