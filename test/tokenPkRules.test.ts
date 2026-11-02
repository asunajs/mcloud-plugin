// 算力大作战的**判定层**：分类、平台优先序、月上限、汇总句、任务表解析。纯函数，零 IO。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTokenCount,
  planTasks,
  stepKeyOf,
  summaryOf,
  tasksFrom,
} from '../src/mcloud/tokenPkRules.ts';
import type { PkTask } from '../src/mcloud/tokenPkRules.ts';

function task(over: Partial<PkTask> & { id: number }): PkTask {
  return {
    id: over.id,
    name: over.name ?? `任务${over.id}`,
    description: '',
    state: over.state ?? 'WAIT',
    taskType: over.taskType ?? 'NORMAL',
    limitType: over.limitType ?? 'MONTH',
    currstep: over.currstep ?? 0,
    claimable: over.claimable ?? false,
    monthlyCompleted: over.monthlyCompleted ?? 0,
    monthlyLimit: over.monthlyLimit ?? 0,
    prizes: over.prizes ?? [],
    button: over.button ?? { ios: { ext: 'backup', action: 'jump', text: '去完成' } },
  };
}

test('平台优先序：先 ios（抓包那端），再 android/other/harmony', () => {
  const t = task({
    id: 1,
    button: {
      other: { ext: 'otherKey', action: 'jump', text: '' },
      android: { ext: 'androidKey', action: 'jump', text: '' },
      ios: { ext: 'iosKey', action: 'jump', text: '' },
    },
  });
  assert.equal(stepKeyOf(t), 'iosKey');
  const noIos = task({ id: 2, button: { other: { ext: 'otherKey', action: 'jump', text: '' } } });
  assert.equal(stepKeyOf(noIos), 'otherKey');
  assert.equal(stepKeyOf(task({ id: 3, button: {} })), '');
});

test('分类：SUCCESS→领、FINISH→跳过、RESERVE→预约、未知→需手动', () => {
  const plan = planTasks([
    task({ id: 1, state: 'SUCCESS', button: { ios: { ext: 'loginPc', action: 'toPcClient', text: '' } } }),
    task({ id: 2, state: 'FINISH' }),
    task({ id: 3, state: 'WAIT', button: { ios: { ext: 'backup', action: 'jump', text: '' } } }),
    task({ id: 4, state: 'WAIT', taskType: 'RESERVE', button: { ios: { ext: 'reserveLogin', action: 'jump', text: '' } } }),
    task({ id: 5, state: 'WAIT', button: { ios: { ext: 'inviteFriend', action: 'invite', text: '' } } }),
    task({ id: 6, state: 'WAIT', button: {} }),
  ]);
  const byId = new Map(plan.actions.map((a) => [a.task.id, a.kind]));
  assert.equal(byId.get(1), 'claim');
  assert.equal(byId.has(2), false, 'FINISH 不进计划');
  assert.equal(byId.get(3), 'run');
  assert.equal(byId.get(4), 'reserve');
  assert.equal(byId.has(5), false, 'inviteFriend 要人真的邀好友 ⇒ 需手动');
  assert.equal(plan.manual.length, 2, plan.manual.join('、'));
  assert.equal(plan.skipped, 1);
});

test('月上限：SUCCESS 仍可领；WAIT 到了上限就不做', () => {
  const plan = planTasks([
    task({ id: 1, state: 'SUCCESS', monthlyCompleted: 7, monthlyLimit: 7 }),
    task({ id: 2, state: 'WAIT', monthlyCompleted: 7, monthlyLimit: 7 }),
    task({ id: 3, state: 'WAIT', monthlyCompleted: 0, monthlyLimit: 0 }),
  ]);
  const byId = new Map(plan.actions.map((a) => [a.task.id, a.kind]));
  assert.equal(byId.get(1), 'claim', '完成了的奖励即使到月上限也能领');
  assert.equal(byId.has(2), false);
  assert.equal(byId.get(3), 'run', 'monthlyLimit=0 = 没有上限');
});

test('RESERVE + SUCCESS ⇒ 什么都不做（预约成功不是奖品）', () => {
  const plan = planTasks([task({ id: 8, state: 'SUCCESS', taskType: 'RESERVE' })]);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.skipped, 1);
});

test('同一 id 出现两次只做第一格（页面也会重影）', () => {
  const plan = planTasks([
    task({ id: 2, state: 'WAIT' }),
    task({ id: 2, state: 'WAIT', name: '重影' }),
  ]);
  assert.equal(plan.actions.length, 1);
});

test('formatTokenCount：亿 / 万 / 原数（逐字照参照实现）', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(500000), '50万');
  assert.equal(formatTokenCount(2_200_648_000), '22.0亿');
  assert.equal(formatTokenCount(0), '0');
});

test('summaryOf：逐字照参照实现；全空给那句兜底', () => {
  assert.equal(
    summaryOf({
      claimed: 2,
      executed: 3,
      chanceReward: 1,
      usedToken: 1_260_000,
      manual: ['分享活动给好友(inviteFriend)'],
      failed: 0,
      pending: 1,
    }),
    '领取奖励2项；执行任务3项；抽奖次数+1；累计算力126万；需手动: 分享活动给好友(inviteFriend)；1项待服务端确认或跨月完成',
  );
  assert.equal(
    summaryOf({ claimed: 0, executed: 0, chanceReward: 0, manual: [], failed: 0, pending: 0 }),
    '本轮无可执行步骤（已完成、达到月上限或待好友互助）',
  );
  // 代抽是这一族自己的扩展（参照实现不抽），句式单独钉
  assert.equal(
    summaryOf({ claimed: 0, executed: 0, chanceReward: 1, drawn: 2, wins: 1, manual: [], failed: 0, pending: 0 }),
    '抽奖次数+1；代抽2次（中1次）',
  );
  assert.equal(
    summaryOf({ claimed: 0, executed: 0, chanceReward: 1, drawn: 1, wins: 0, manual: [], failed: 0, pending: 0 }),
    '抽奖次数+1；代抽1次（都没中）',
  );
});

test('tasksFrom：null 的月上限按 0 收；available=false 的奖品不收', () => {
  const tasks = tasksFrom([
    {
      id: 2,
      name: '上传照片存云盘',
      state: 'wait',
      taskType: 'NORMAL',
      limitType: 'DAY',
      currstep: 1,
      monthlyCompleted: null,
      monthlyLimit: null,
      button: { ios: { ext: 'uploadPhoto', action: 'jump', text: '去完成' } },
      prizes: [
        { prizeName: 'Token+50万', prizeType: 'token', amount: 500000, available: true },
        { prizeName: '过期奖', prizeType: 'token', amount: 1, available: false },
      ],
    },
  ]);
  assert.equal(tasks.length, 1);
  const t = tasks[0]!;
  assert.equal(t.state, 'WAIT');
  assert.equal(t.monthlyLimit, 0);
  assert.equal(t.currstep, 1);
  assert.deepEqual(t.prizes.map((p) => p.prizeName), ['Token+50万']);
});
