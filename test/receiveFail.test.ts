// `receive` 的失败解释 —— 守的是"**别把上游那句骗人的文案当结论**"。
//
// 抓包实证（`mcloud-capture/docs/capture/app-signin-samples.txt` §4.2，2026-09-19
// 账号 B，同一条请求只换 `deviceId` 一项）：
//
//   deviceId                     code   上游 msg（**骗人的**）
//   不带                          615   活动太火爆啦，兑换失败，试试其他奖品吧
//   长度对、只错一个字符            614   活动太火爆啦，锁定失败，试试其他奖品吧
//   真实值（B + 88 字符 base64）    0     正常
//
// ⇒ 615/614 是**参数问题**。照原话归类会把它当成"过一会儿再试"，
// 于是无限重试，而每一次都注定失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainReceiveFail } from '../src/mcloud/tasks/receive.ts';

test('615：说"没带 deviceId"，**不**重复"活动太火爆"', () => {
  const n = explainReceiveFail({ code: 615 }, 'code=615 msg=活动太火爆啦，兑换失败，试试其他奖品吧')!;
  assert.ok(n, '615 必须被翻出来 —— 否则会被当成限流');
  assert.match(n, /没带/);
  assert.match(n, /deviceId/);
  // 关键：不能只把上游原话抄一遍（那正是要避免的事）
  assert.ok(!/太火爆啦，兑换失败，试试其他奖品吧/.test(n), '别把骗人的原话当结论');
  assert.match(n, /smid|H5/, '要说清"有效值得从哪来"');
});

test('614：说"格式不对"，并点明**登录那份不是这一份**', () => {
  const n = explainReceiveFail({ code: 614 }, 'code=614 msg=活动太火爆啦，锁定失败')!;
  assert.match(n, /格式不对|内容无效/);
  assert.match(n, /登录/, '最容易踩的坑：拿 account.device_id 顶替 —— 实测就是回 614');
  assert.match(n, /B\b|base64/);
});

test('别的码**不翻**（返回 undefined，照原话报 —— 不猜）', () => {
  assert.equal(explainReceiveFail({ code: 0 }, ''), undefined);
  assert.equal(explainReceiveFail({ code: 90001 }, 'code=90001 msg=未登录'), undefined);
  assert.equal(explainReceiveFail(undefined, '网络断了'), undefined);
});

test('两个码的说明**不共用**（共用文案就没法定位了）', () => {
  const a = explainReceiveFail({ code: 615 }, '')!;
  const b = explainReceiveFail({ code: 614 }, '')!;
  assert.notEqual(a, b);
});
