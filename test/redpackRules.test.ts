// 红包派对的**判定层**：纯函数，一个请求都不发。
//
// 这一族我们**零抓包**（`cpactiv.buy.139.com` 在 `har/` 全量里搜不到样本），
// 所以能把判据钉死的只有这一层：状态码 → 该不该做事、题面 → 答案、分 → 用户看到的那句话。
// 真账号第一次跑要验的是"上游给的形状我认不认识"，不是"分支逻辑对不对" ——
// 后者在这里就已经锁住了。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANSWER_LETTERS,
  BROWSE_TASKS,
  CLOUD_USE_CODE,
  DIRECT_TASKS,
  INSTALL_STATUS_EXISTS,
  KNOWN_ANSWERS,
  amountSuffix,
  answerLetter,
  classify,
  dispatchKind,
  findTask,
  manualReason,
  parseApps,
  parsePhones,
  parseTaskList,
  parseTopic,
  parseTopicOptions,
  phoneUsable,
  pickPhone,
  readBalance,
  readHwToken,
  readInstallProgress,
  readInstallStart,
  readInstallStatus,
  readRedpackToken,
  readReward,
  sendableId,
  statusLabel,
  statusText,
  yuan2,
  yuanRaw,
} from '../src/mcloud/redpackRules.ts';

/** 这些 reader 吃的是信封里 **`data` 那一格**（外层由 `callRedpack` 剥掉），
 *  所以测试里给的就是那一格。`dataOf(…)` 只是把这层意思**写出来**，本身是恒等函数 ——
 *  真包一层 `{header,data}` 会让每个形状都读成空，而"读成空"在测试里
 *  长得跟"上游真没给"一模一样。 */
const dataOf = (v: unknown): unknown => v;

test('四档归类：缺格算未完成，陌生码算"不认识"（⇒ 不发写）', () => {
  assert.equal(classify(0), 'todo');
  assert.equal(classify(undefined), 'todo', '缺 `userStatus` 是新条目的正常形状，照参照实现的 `?? 0`');
  assert.equal(classify(1), 'done');
  assert.equal(classify(3), 'blocked', '奖品已兑完');
  assert.equal(classify(4), 'blocked', '明天再来');
  // ⚠ 这一条是**刻意**与参照实现不同的地方：陌生码它当"未完成"照打写请求，我们不打
  for (const odd of [2, 5, 99, -1]) assert.equal(classify(odd), 'unknown', `状态 ${odd}`);
});

test('状态码的人话：不认识的**如实说不认识**，不折进"未完成"', () => {
  assert.equal(statusText(0), '未完成');
  assert.equal(statusText(1), '已完成');
  assert.equal(statusText(3), '奖品已兑完');
  assert.equal(statusText(4), '明天再来');
  assert.equal(statusText(7), undefined);
  assert.equal(statusLabel(7), '没见过的状态 7');
  assert.equal(statusLabel(undefined), '未完成', '缺格与陌生码是两件事');
});

test('钱的两种读法**都留着**：余额不补零，任务与奖励补两位', () => {
  // 真机读数：`余额: 可用3元，累计4.6元` / `去完成: 每日签到 (0.10元)`
  assert.equal(yuanRaw(300), '3');
  assert.equal(yuanRaw(460), '4.6');
  assert.equal(yuanRaw(undefined), '0');
  assert.equal(yuan2(10), '0.10元');
  assert.equal(yuan2(300), '3.00元');
  assert.equal(amountSuffix({ amount: undefined }), '', '没有金额 ⇒ 括注整个不写');
  assert.equal(amountSuffix({ amount: 30 }), ' (0.30元)');
});

const TABLE = {
  configTaskSignList: [
    { isToday: 0, status: 1, signAmount: 10 },
    { isToday: 1, status: 0, signAmount: 100 },
  ],
  configTaskNoviceList: [{ id: 11, taskCode: 'NOVICE_1', taskName: '领取定向流量', userStatus: 0, taskAmount: 50 }],
  configTaskDailyList: [
    { id: 21, taskCode: CLOUD_USE_CODE, taskName: '每日使用云机', userStatus: 0, prizeAmount: 20, taskAmount: 999 },
    { id: 22, taskCode: 'NOVICE_2', taskName: '浏览', userStatus: 1 },
  ],
  configTaskMonthlyList: [{ id: 31, taskCode: 'MONTHLY_2', taskName: '在云手机里安装应用', userStatus: 3 }],
};

test('解任务表：组序、金额取值顺序、签到只认今天那一格', () => {
  const list = parseTaskList(TABLE);
  assert.deepEqual(
    list.groups.map((g) => g.title),
    ['新手任务', '每日任务', '每月任务'],
  );
  // 摊平后的队按组序走，空组不占位
  assert.deepEqual(
    list.tasks.map((t) => t.taskCode),
    ['NOVICE_1', CLOUD_USE_CODE, 'NOVICE_2', 'MONTHLY_2'],
  );
  // `prizeAmount ?? taskAmount` —— 先看奖品金额
  assert.equal(list.tasks.find((t) => t.taskCode === CLOUD_USE_CODE)?.amount, 20);
  assert.equal(list.sign?.status, 0, '取的是 `isToday===1` 那一格，不是第一条');
  assert.equal(list.sign?.amount, 100);
  assert.equal(findTask(list, 'NOVICE_2')?.status, 1);
  assert.equal(findTask(list, '不存在'), undefined);
});

test('签到那一格：**没有今天那一格就不做签到**（不拿第一条当今天）', () => {
  const noToday = parseTaskList({
    ...TABLE,
    configTaskSignList: [{ isToday: 0, status: 1, signAmount: 10 }],
  });
  assert.equal(noToday.sign, undefined, '把昨天那格当今天 ⇒ 日志里的「已完成: 每日签到」是假结论');
  assert.equal(parseTaskList({}).sign, undefined);
  // 形状完全不对 ⇒ 空表，不猜
  assert.deepEqual(parseTaskList('不是对象').tasks, []);
});

test('编号：只收数字与非空字符串，其余一律不发', () => {
  assert.equal(sendableId(7), 7);
  assert.equal(sendableId('7'), '7', '上游给字符串就照字符串发回去');
  for (const bad of [undefined, null, NaN, '', '   ', {}, [], true]) {
    assert.equal(sendableId(bad), undefined, String(bad));
  }
});

test('派发：三张码表 + 认不出来的一律走"需手动完成（未知任务）"', () => {
  assert.deepEqual([...BROWSE_TASKS], ['NOVICE_2', 'NOVICE_3', 'MONTHLY_1']);
  assert.deepEqual([...DIRECT_TASKS], ['MONTHLY_4', 'MONTHLY_5']);
  assert.equal(dispatchKind('NOVICE_2'), 'browse');
  assert.equal(dispatchKind('MONTHLY_4'), 'direct');
  assert.equal(dispatchKind(CLOUD_USE_CODE), 'cloudUse');
  assert.equal(dispatchKind('MONTHLY_2'), 'install');
  assert.equal(dispatchKind('MONTHLY_3'), 'topic');
  assert.equal(dispatchKind('什么新码'), 'manual');
  assert.equal(manualReason('NOVICE_1'), '需跳转领取定向流量');
  assert.equal(manualReason('什么新码'), '未知任务');
});

test('题库：题面认识且**选项里有那句**才给字母；否则不硬猜', () => {
  assert.equal(Object.keys(KNOWN_ANSWERS).length, 15);
  assert.equal(ANSWER_LETTERS, 'ABCD');
  const q = '移动云手机是否需要充电使用？';
  const topic = { id: 1, question: q, options: ['需要', '不需要', '看情况', '偶尔'] };
  assert.equal(answerLetter(topic), 'B', '答案文本在选项里的下标决定字母');
  // 题面改了字 ⇒ 查不到 ⇒ 走「未知题目」，而不是挑一个
  assert.equal(answerLetter({ id: 1, question: '移动云手机是否需要充电吗？', options: topic.options }), undefined);
  // 题面认识、选项里没有那句（上游换了顺序/换了措辞）⇒ 也不给
  assert.equal(answerLetter({ id: 1, question: q, options: ['需要', '也许'] }), undefined);
});

test('题库响应：`topicOption` 是字符串套 JSON，解不出来给空数组', () => {
  const t = parseTopic({ list: [{ id: 5, topicContent: '移动云手机是否需要充电使用？', topicOption: '["需要","不需要"]' }] });
  assert.deepEqual(t, { id: 5, question: '移动云手机是否需要充电使用？', options: ['需要', '不需要'] });
  assert.deepEqual(parseTopic({ list: [{ id: 5, topicContent: 'x', topicOption: '坏 JSON' }] })?.options, []);
  assert.deepEqual(parseTopicOptions(['a', 1, 'b']), ['a', 'b'], '非字符串项丢掉');
  assert.equal(parseTopic({ list: [] }), undefined);
});

test('云机：两档合成一条列表，锁屏那台不能用', () => {
  const nested = parsePhones(dataOf({ data: { subscribeDetails: [{ instanceId: 'I1', subsProdInstances: [{ lockStatus: 'Y' }] }] } }));
  assert.deepEqual(nested, [{ instanceId: 'I1', locked: true }], '`data.data` 是对象时要往里取一层');
  const flat = parsePhones(dataOf({ subscribeDetails: [{ instanceId: 'I2' }, { instanceId: '', subsProdInstances: [] }] }));
  assert.deepEqual(flat.map((p) => [p.instanceId, p.locked]), [['I2', false], ['', false]]);
  assert.equal(pickPhone(flat)?.instanceId, 'I2', '挑第一台没锁的');
  assert.equal(phoneUsable(flat[0]), true);
  assert.equal(phoneUsable(flat[1]), false, '没有 instanceId 的不能装');
  assert.equal(phoneUsable(pickPhone(nested)), false, '锁屏 ⇒ 装机不做');
  // 全锁屏时回退第一台（照参照实现的 `?? phones[0]`），然后由锁屏那一判说清楚
  assert.equal(pickPhone(nested)?.instanceId, 'I1');
  // 形状不对 ⇒ 空列表（"读不到云机"与"没有云机"在这条链上走同一个出口，但日志不说谎）
  assert.deepEqual(parsePhones(dataOf({})), []);
});

test('应用列表：没有包名的项丢掉（参照实现是 `continue`）', () => {
  const apps = parseApps(dataOf({ list: [{ id: 1, packageId: 9, packageName: 'a.b', apkName: 'A' }, { id: 2, packageName: '' }] }));
  assert.deepEqual(apps, [{ id: 1, packageId: '9', packageName: 'a.b', apkName: 'A' }]);
});

test('装机状态：`data` 是数组或 `{list:[…]}` 两种形状都认，只看第一个实例', () => {
  assert.equal(readInstallStatus(dataOf([{ instanceList: [{ installStatus: 2 }] }])), INSTALL_STATUS_EXISTS);
  assert.equal(readInstallStatus(dataOf({ list: [{ instanceList: [{ installStatus: 0 }] }] })), 0);
  assert.equal(readInstallStatus(dataOf({ list: [] })), undefined);
  assert.equal(readInstallStatus(dataOf([{ instanceList: [] }])), undefined);
  // 读不到 ⇒ `undefined`，调用方照样去装（参照实现只认 `=== 2` 那一格）
  assert.deepEqual(readInstallStart(dataOf({ success: true, taskId: 77 })), { started: true, taskId: '77' });
  assert.deepEqual(readInstallStart(dataOf({ success: 'true' })), { started: false, taskId: '' }, '字符串 "true" 不算成功');
  assert.deepEqual(readInstallStart('不是对象'), { started: false, taskId: '' });
  assert.equal(readInstallProgress(dataOf({ taskStatus: '2' })), 2, '数字字符串也收');
});

test('余额 / 奖励 / 票：缺格就当没有，不补一个数出来', () => {
  assert.deepEqual(readBalance(dataOf({ info: { canAmount: 300, totalAmount: 460 } })), { can: 300, total: 460 });
  assert.deepEqual(readBalance(dataOf({})), { can: undefined, total: undefined });
  assert.deepEqual(readReward(dataOf({ lastUserPrize: { prizeName: '云朵', prizeAmount: 50 } })), { name: '云朵', cents: 50 });
  assert.deepEqual(readReward(dataOf({ lastUserPrize: { prizeAmount: 50 } })), { name: '', cents: 50 }, '没奖品名 ⇒ 空串，调用方兜底任务名');
  assert.equal(readReward(dataOf({ lastUserPrize: { prizeName: '云朵' } })), undefined, '没金额 ⇒ **不打那一行**');
  assert.equal(readReward(dataOf({ lastUserPrize: { prizeName: '云朵', prizeAmount: 0 } })), undefined);
  assert.equal(readRedpackToken(dataOf({ token: 'T' })), 'T');
  assert.equal(readRedpackToken(dataOf({ token: '' })), undefined);
  assert.equal(readHwToken(dataOf({ hwToken: 'H' })), 'H');
});
