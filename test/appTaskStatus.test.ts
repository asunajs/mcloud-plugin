// 「App 任务状态」那一步 —— 判据全部取自 2026-11-01 三个号两种市场的**真机字段**。
//
// 这一层的价值是"别编"：
//   · 上游没写 `buttonOutText` ⇒ 这一条不出现（"没说" ≠ "没做"）
//   · 有进度就带进度（`开启中 29/31`、`已完成 1/7`）
//   · 认不出来的按钮文案**照抄**，不自己造一个状态词

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_TASKS,
  appTaskStatusLines,
  describeStatus,
} from '../src/mcloud/tasks/appTaskStatus.ts';
import { matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import type { MatrixItem } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { memStore } from '../src/store/memory.ts';

const NOW = '2026-11-01T07:00:00.000Z';

/** 真机那几条（字段名与取值逐字照抄）。 */
function real549(): MatrixItem {
  return { taskId: 549, name: '备份文件领好礼', description: '月月备份成功月月领', groupId: 'time', state: 'WAIT', limitType: 'MONTH', enable: 1, currStep: 0, buttonOutText: '下月再来' };
}
function real551(): MatrixItem {
  return { taskId: 551, name: '连续31天开启云盘APP通知', description: '+200豆', groupId: 'time', state: 'WAIT', limitType: 'MONTH', enable: 1, currStep: 0, buttonOutText: '开启中', buttonOutDay: '29', buttonOutTotal: '31' };
}
function real1021(): MatrixItem {
  return { taskId: 1021, name: '连续31天开启邮箱APP通知', description: '+100豆', groupId: 'month', state: 'WAIT', limitType: 'EVER', enable: 1, currStep: 0, buttonOutText: '去开启', buttonOutDay: '0' };
}
function real522(): MatrixItem {
  // 真机实拍（2026-11-02）：`buttonOutText` 永远是「去完成」，进度只在 `process` 里
  return { taskId: 522, name: '当月上传文件满100个', description: '+80云朵', groupId: 'time', state: 'WAIT', limitType: 'MONTH', enable: 1, currStep: 0, buttonOutText: '去完成', process: 67 };
}
function real434(): MatrixItem {
  return { taskId: 434, name: "分享文件领好礼<span id='share_title'>1/7</span>", description: '5豆*7+20豆', groupId: 'month', state: 'WAIT', limitType: 'MONTH', enable: 1, currStep: 4, buttonOutText: '已完成' };
}

test('四条真机读数 → 四句人话', () => {
  assert.equal(describeStatus(real549()), '备份文件领好礼：本月已完成，下月再来');
  assert.equal(describeStatus(real551()), '连续31天开启云盘APP通知：已开启 29/31 天');
  assert.equal(describeStatus(real1021()), '连续31天开启邮箱APP通知：还没开启（去 App 打开）');
  assert.equal(describeStatus(real434()), '分享文件领好礼：已完成 1/7');
  // 攒进度那条：按钮话是「去完成」，真进度在 `process`
  assert.equal(describeStatus(real522()), '当月上传文件满100个：已累计 67/100');
  assert.equal(describeStatus({ ...real522(), process: 100 }), '当月上传文件满100个：已累计 100/100（已满）');
});

test('⚠ `process` 每条都有（其它任务是 0）⇒ 不许画成「已累计 0」', () => {
  // 现场：2026-11-02 自测，五条播报全变成「已累计 0」——因为 `process` 这一格每条都带
  assert.equal(
    describeStatus({ ...real551(), process: 0 }),
    '连续31天开启云盘APP通知：已开启 29/31 天',
    'process=0 的普通任务要回到它自己的按钮话',
  );
  assert.equal(describeStatus({ ...real549(), process: 0 }), '备份文件领好礼：本月已完成，下月再来');
  // 而"满 N 个"那类即便 0 也要显示（0/100 本身就是有意义的读数）
  assert.equal(describeStatus({ ...real522(), process: 0 }), '当月上传文件满100个：已累计 0/100');
  // 真攒了也要显示（哪怕名字里没有"满 N"）
  assert.equal(describeStatus({ ...real549(), process: 3 }), '备份文件领好礼：已累计 3');
});

test('⚠ 上游没写按钮文案 ⇒ 不出现（不猜"待办"）', () => {
  const bare: MatrixItem = { taskId: 549, name: '备份文件领好礼', state: 'WAIT' };
  assert.equal(describeStatus(bare), undefined);
  const store = memStore();
  store.ensureSchema();
  store.setState(matrixKey('sign_in_3'), JSON.stringify({ group: 'sign_in_3', at: NOW, done: 0, todo: 1, skip: 0, todoNames: [], items: [bare] }), NOW);
  assert.deepEqual(appTaskStatusLines(store), [], '一条都读不出来 ⇒ 整个状态步不出现');
});

test('认不出来的按钮文案**照抄**（别自己造状态词）', () => {
  assert.equal(describeStatus({ taskId: 607, name: '下月签到领惊喜福利', buttonOutText: '立即预定' }), '下月签到领惊喜福利：下月再来（现在还不能做）');
  assert.equal(describeStatus({ taskId: 999, name: '某某任务', buttonOutText: '去瞅瞅' }), '某某任务：去瞅瞅');
});

test('两个市场同一条：去重，优先"有进度"的那份', () => {
  const store = memStore();
  store.ensureSchema();
  const mk = (g: string, items: MatrixItem[]) =>
    store.setState(matrixKey(g), JSON.stringify({ group: g, at: NOW, done: 0, todo: items.length, skip: 0, todoNames: [], items }), NOW);
  // sign_in_3 那份只有光秃秃一句；newsign 那份带 29/31
  mk('sign_in_3', [{ taskId: 551, name: '连续31天开启云盘APP通知', buttonOutText: '开启中' }]);
  mk('newsign_139mail', [real551()]);
  const lines = appTaskStatusLines(store);
  assert.deepEqual(lines, ['连续31天开启云盘APP通知：已开启 29/31 天']);
});

test('备份开关没开时，549 那行补一句', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(matrixKey('sign_in_3'), JSON.stringify({ group: 'sign_in_3', at: NOW, done: 0, todo: 1, skip: 0, todoNames: [], items: [real549()] }), NOW);
  const lines = appTaskStatusLines(store, { backupOn: false });
  assert.deepEqual(lines, ['备份文件领好礼：本月已完成，下月再来（备份开关没开，开了才会有）']);
  assert.deepEqual(appTaskStatusLines(store, { backupOn: true }), ['备份文件领好礼：本月已完成，下月再来']);
});

test('434：今天这一趟已经分享过 ⇒ 明说"每天只算一次"（不然看着像没动）', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(matrixKey('sign_in_3'), JSON.stringify({ group: 'sign_in_3', at: NOW, done: 0, todo: 1, skip: 0, todoNames: [], items: [real434()] }), NOW);
  // 今天动过 434
  store.setState('mcloud.apptask.state', JSON.stringify({ day: NOW.slice(0, 10), clicked: [434] }), NOW);
  assert.deepEqual(appTaskStatusLines(store, { nowIso: NOW }), [
    '分享文件领好礼：已完成 1/7（今天这一趟已记过，每天只算一次）',
  ]);
  // 昨天的记录不算
  store.setState('mcloud.apptask.state', JSON.stringify({ day: '2026-10-31', clicked: [434] }), NOW);
  assert.deepEqual(appTaskStatusLines(store, { nowIso: NOW }), ['分享文件领好礼：已完成 1/7']);
});

test('按 STATUS_TASKS 的顺序输出，且只播报表里的 id', () => {
  const store = memStore();
  store.ensureSchema();
  const items = [real434(), real1021(), real551(), real549(), real522(), { taskId: 607, name: '别的', buttonOutText: '立即预定' }];
  store.setState(matrixKey('newsign_139mail'), JSON.stringify({ group: 'newsign_139mail', at: NOW, done: 0, todo: items.length, skip: 0, todoNames: [], items }), NOW);
  const lines = appTaskStatusLines(store);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((l) => l.split('：')[0]), STATUS_TASKS.map((s) => s.title));
});
