// 日志着色：不是"这一趟做成了什么"的行，不许涂成 success。
// 参考 mcloud-sign：info 是普通信息、debug 是过程、success 只给真正的成功。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineLevel } from '../src/mcloud/tasks/stepLog.ts';

test('lineLevel：做了事 + 明确拿到奖励才 success', () => {
  assert.equal(lineLevel('签到：领到 3 云朵'), 'success');
  assert.equal(lineLevel('兑换：兑换成功！【10 元话费】'), 'success');
  assert.equal(lineLevel('领取AI豆：获得 1 个'), 'success');
  assert.equal(lineLevel('领取AI豆：领取到 146 个云朵'), 'success');
  // 只有“成功”两个字不算：动作发出去了，但没拿到东西
  assert.equal(lineLevel('签到：网盘签到成功'), 'info');
  assert.equal(lineLevel('分享文件成功'), 'info');
  assert.equal(lineLevel('领取AI豆：未获得奖励'), 'info');
});

test('lineLevel：普通读数/状态是 info，不是 success', () => {
  assert.equal(lineLevel('AI豆快照：流水 0 条'), 'info');
  assert.equal(lineLevel('消息推送奖励（问状态）：暂无，已开启 10 天'), 'info');
  assert.equal(lineLevel('App 任务矩阵（只看）：已完成 11 条，另有 3 条没做完'), 'info');
  assert.equal(lineLevel('待领取奖品：无待领取奖品'), 'debug');
  assert.equal(lineLevel('AI豆快照：流水 0 条'), 'info');
  assert.equal(lineLevel('App 任务：这一趟做完了'), 'debug');
  assert.equal(lineLevel('任务拓展：这一趟已经走完'), 'debug');
  assert.equal(
    lineLevel('消息推送奖励（问状态）：通知已被关闭，需要你在 App 里手动打开（这一步我们做不了）'),
    'warn',
  );
});

test('lineLevel：跳过/今天已经做过是 debug', () => {
  assert.equal(lineLevel('签到：今天已经签过了'), 'debug');
  assert.equal(lineLevel('领取AI豆：今天没有可领的'), 'debug');
  assert.equal(lineLevel('备份好礼：跳过（今天领过了）'), 'debug');
});

test('lineLevel：没成是 fail，要用户动手是 warn', () => {
  assert.equal(lineLevel('复活卡：没成 —— 服务端说：2025年无云朵记录'), 'fail');
  assert.equal(lineLevel('App 任务：没成 —— 请前往移动云盘手动完成'), 'fail');
  assert.equal(lineLevel('请前往移动云盘手动完成：447'), 'warn');
  assert.equal(lineLevel('签到：没成 —— 还没有网页会话'), 'debug');
});
