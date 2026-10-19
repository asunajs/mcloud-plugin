// `app-task` 的判据层 —— **纯函数，零 IO**，所以这一层能完全钉住。
//
// 为什么值得单独测：mcloud 把「这一条要不要传、传几个」做成纯函数，理由就是
// "能在没有网络的情况下被钉住"。判据一旦混进 IO，就只能靠真机试 —— 而真机上
// `task/click` **不可回滚**，试错的代价是用户的任务状态。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLICK_ONLY_TASK_IDS,
  GATE_UPLOAD_TASK_ID,
  MONTH_GATE_GROUP,
  MONTH_GATE_MARKET,
  PC_UPLOAD_TASK_ID,
  PORTAL_ENTRY_TASK_IDS,
  ROUNDS_PER_RUN,
  SHARE_TASK_ID,
  SKIP_TASK_LIST,
  SPECIAL_CLICK_STEP,
  STOP_AT_PROCESS,
  UPLOAD_ONE,
  UPLOAD_ONE_PC,
  UPLOAD_TEN,
  UPLOAD_TASK_ID,
  beiyong1ButtonGate,
  beiyong1NameGate,
  isClickOnly,
  isShare,
  isUnimplemented,
  monthGateSkips,
  needsPortalEntry,
  shouldSkip,
  stepFor,
  uploadShapeFor,
} from '../src/mcloud/appTaskRules.ts';

test('名字门：要**同时**有"上传"和（"图"或"照"）', () => {
  assert.equal(beiyong1NameGate('上传图片'), true);
  assert.equal(beiyong1NameGate('上传照片'), true);
  assert.equal(beiyong1NameGate('上传一个文件'), false, '只有"上传"不够');
  assert.equal(beiyong1NameGate('看看图片'), false, '只有"图"不够');
  assert.equal(beiyong1NameGate('记录国庆节欢乐瞬间'), false, '615 的名字两个都没有');
  assert.equal(beiyong1NameGate(''), false);
});

test('按钮门：链接里要有 `uploadView`', () => {
  assert.equal(beiyong1ButtonGate('https://x/y?action=uploadView&a=1'), true);
  assert.equal(beiyong1ButtonGate('https://x/y'), false);
  assert.equal(beiyong1ButtonGate(undefined), false, '没有链接 ⇒ 不传（不是"传一个"）');
  assert.equal(beiyong1ButtonGate(null), false);
});

test('三档形状的**具体值**（这几个数错了就是白传或传少）', () => {
  assert.deepEqual(UPLOAD_ONE, {
    rounds: 1,
    stopAtProcess: 0,
    topUpFromProcess: false,
    perRoundMs: 0,
    fileExt: '.bin',
    channel: 'android',
  });
  assert.deepEqual(UPLOAD_TEN, {
    rounds: 10,
    stopAtProcess: 10,
    topUpFromProcess: true,
    perRoundMs: 300,
    fileExt: '.jpg',
    channel: 'android',
  });
  // ⚠ 113 与 106 形状**同档**，差别只在渠道
  assert.deepEqual(UPLOAD_ONE_PC, { ...UPLOAD_ONE, channel: 'pc' });
  assert.equal(UPLOAD_ONE_PC.channel, 'pc');
  assert.equal(UPLOAD_ONE.channel, 'android');
});

test('`upload_shape_for`：113 / 106 / 522 三档', () => {
  assert.equal(uploadShapeFor({ taskId: PC_UPLOAD_TASK_ID })!.channel, 'pc', '113 ⇒ PC 渠道');
  assert.equal(uploadShapeFor({ taskId: UPLOAD_TASK_ID })!.rounds, 1);
  const gate = uploadShapeFor({ taskId: GATE_UPLOAD_TASK_ID })!;
  assert.equal(gate.rounds, ROUNDS_PER_RUN);
  assert.equal(gate.rounds, 5);
  assert.equal(gate.stopAtProcess, STOP_AT_PROCESS);
  assert.equal(gate.stopAtProcess, 100);
  assert.equal(gate.topUpFromProcess, false, '⚠ 522 是"闸"不是"剩余量"');
  assert.equal(gate.perRoundMs, 500);
});

test('⚠ `beiyong1` 的**顺序是判据的一部分**：先名字门，没中才看按钮门', () => {
  // 名字门中 ⇒ 传一个（哪怕按钮门也中）
  const byName = uploadShapeFor({ groupId: 'beiyong1', name: '上传图片', buttonAppLink: 'x?uploadView' })!;
  assert.equal(byName.rounds, 1, '名字门优先');
  assert.equal(byName.fileExt, '.bin');
  // 名字门没中、按钮门中 ⇒ 传十发
  const byButton = uploadShapeFor({
    groupId: 'beiyong1',
    name: '记录国庆节欢乐瞬间',
    buttonAppLink: 'x?action=uploadView',
  })!;
  assert.equal(byButton.rounds, 10, '⚠ 615 全靠按钮门 —— 名字里两个词都没有');
  assert.equal(byButton.fileExt, '.jpg');
  // 两个门都没中 ⇒ 不传
  assert.equal(uploadShapeFor({ groupId: 'beiyong1', name: '签到', buttonAppLink: 'x' }), undefined);
  // 别的组不受名字/按钮门影响
  assert.equal(uploadShapeFor({ groupId: 'other', name: '上传图片' }), undefined);
});

test('判不了就不传（`undefined` 不是"传一个"）', () => {
  assert.equal(uploadShapeFor({}), undefined);
  assert.equal(uploadShapeFor({ taskId: 999 }), undefined);
  assert.equal(uploadShapeFor({ taskId: undefined, groupId: 'beiyong1' }), undefined);
});

test('"不做"名单 / 只点一下 / 入口页 / 分享 —— 四个集合不重叠且判得住', () => {
  assert.equal(SKIP_TASK_LIST.length, 11);
  assert.equal(shouldSkip(117), true);
  assert.equal(shouldSkip(120), true);
  assert.equal(shouldSkip(106), false);
  assert.equal(shouldSkip(undefined), false);
  assert.equal(CLICK_ONLY_TASK_IDS.length, 9);
  assert.equal(isClickOnly(115), true);
  assert.equal(isClickOnly(547), true);
  assert.equal(isClickOnly(117), false);
  assert.equal(PORTAL_ENTRY_TASK_IDS.length, 2);
  assert.equal(needsPortalEntry(1017), true);
  assert.equal(needsPortalEntry(604), true);
  assert.equal(stepFor({ taskId: 409 })?.kind, 'entry');
  assert.equal(stepFor({ taskId: 1005 })?.kind, 'entry');
  assert.equal(stepFor({ taskId: 1017 })?.kind, 'portal');
  assert.equal(stepFor({ taskId: 604 })?.kind, 'portal');
  assert.equal(stepFor({ taskId: 434 })?.kind, 'share');
  assert.equal(stepFor({ taskId: 1020 })?.kind, 'runner');
  assert.equal(stepFor({ taskId: 609 })?.kind, 'runner');
  assert.equal(needsPortalEntry(604), true);
  assert.equal(needsPortalEntry(605), false);
  assert.equal(isShare(SHARE_TASK_ID), true);
  assert.equal(isShare(434), true);
  assert.equal(isShare(433), false);
  assert.equal(SPECIAL_CLICK_STEP, 22);
  // 不重叠（一条同时进两个集合会让动作顺序变得没定义）
  const skip = new Set(SKIP_TASK_LIST);
  for (const id of [...CLICK_ONLY_TASK_IDS, ...PORTAL_ENTRY_TASK_IDS, SHARE_TASK_ID]) {
    assert.equal(skip.has(id), false, `${id} 同时在"不做"与别的集合里`);
  }
});

test('“没实现”要认上传族，也要把“刻意不做”排除在外', () => {
  assert.equal(isUnimplemented(106), false, '106 是上传，别误报');
  assert.equal(isUnimplemented(409), false, '409 固定入口');
  assert.equal(isUnimplemented(434), false, '434 分享');
  assert.equal(isUnimplemented(1017), false, '1017 入口页');
  assert.equal(isUnimplemented(1020), false, '1020 邮件转存');
  assert.equal(isUnimplemented(609), false, '609 AI 助手');
  assert.equal(isUnimplemented(113), false, '113 是 PC 上传');
  assert.equal(isUnimplemented(522), false, '522 是上传闸');
  assert.equal(isUnimplemented(115), false, '115 是只点一下');
  assert.equal(isUnimplemented(117), false, '117 是刻意不做，不是没实现');
  assert.equal(isUnimplemented(107), false, '107 建笔记已接');
  assert.equal(isUnimplemented(1028), false, '1028 AI 工作台已接');
  assert.equal(isUnimplemented(1014), false, '1014 PDF 已接');
  assert.equal(isUnimplemented(1029), false, '1029 账单已接');
  assert.equal(isUnimplemented(999), true, '999 不在表里');
  assert.equal(isUnimplemented(undefined), true);
});

test('月度闸门的 marketName / groupId 是钉死的', () => {
  assert.equal(MONTH_GATE_MARKET, 'sign_in_3');
  assert.equal(MONTH_GATE_GROUP, 'month');
  assert.equal(monthGateSkips({ groupId: 'month', marketName: 'sign_in_3' }, false, 14), true);
  assert.equal(monthGateSkips({ groupId: 'month', marketName: 'sign_in_3' }, false, 20), false);
  assert.equal(monthGateSkips({ groupId: 'month', marketName: 'sign_in_3' }, true, 14), false);
  assert.equal(monthGateSkips({ groupId: 'month', marketName: 'sign_in_3' }, undefined, 14), false);
  assert.equal(monthGateSkips({ groupId: 'day', marketName: 'sign_in_3' }, false, 14), false);
});
