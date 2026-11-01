// CLI 日志形状 —— 照 mcloud-sign 的 consoleTransport：
//   `[info] 11:04:05 msg`
// 面板的 WebUI 日志不走这里；这里只是把格式钉住，别在改 CLI 时顺手把面板也带歪。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { colorizeFrom, formatLogLine } from '../src/standalone/logger.ts';

const AT = new Date(2026, 9, 23, 11, 4, 5);

test('无色：`[级别] HH:MM:SS 正文`（与 mcloud-sign 同一行形状）', () => {
  assert.equal(formatLogLine('info', 'hello', AT, false), '[info] 11:04:05 hello');
  assert.equal(formatLogLine('success', '成功', AT, false), '[success] 11:04:05 成功');
});

test('有色：颜色只包住级别标签，时间与正文不着色', () => {
  assert.equal(formatLogLine('info', 'hello', AT, true), '\x1b[36m[info]\x1b[0m 11:04:05 hello');
  assert.equal(formatLogLine('fail', 'x', AT, true), '\x1b[31m[fail]\x1b[0m 11:04:05 x');
});

test('错误对象取 stack/message，不打印成 [object Object]', () => {
  const line = formatLogLine('error', new Error('boom'), AT, false);
  assert.match(line, /^\[error\] 11:04:05 Error: boom/);
});

test('`common.colorize` 显式值优先于环境判断', () => {
  assert.equal(colorizeFrom({ colorize: false }), false);
  assert.equal(colorizeFrom({ colorize: true }), true);
});
