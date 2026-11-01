// 红包派对的**判定层**：纯函数，一个请求都不发。
//
// # 为什么要单独一层
//
// 这一族的"该不该打一枪写请求"只看一个数：任务表里那条的 `userStatus`。
// 把它写成纯函数，才能在零抓包的情况下把判据**钉死**（`test/redpackRules.test.ts`），
// 而真账号第一次跑只需要验"上游给的码我认不认识"，不需要再验一次分支逻辑。
//
// # 四档，其中一档是**刻意**的
//
// `userStatus` → 未完成(0) / 已完成(1) / 奖品已兑完(3) / 明天再来(4)。**其余的码**
// （2、5、99 …）落第四档 `unknown`：
//
// * 参照实现会把陌生码当成"未完成"照样去打写请求（`Number(task.userStatus ?? 0)`
//   之后直接走"去完成"）；
// * 这里**不发**。理由不是"更严谨"这种姿态，而是一条具体的钱：陌生码完全可能是
//   "已经领过了"的另一句说法，对它再打一枪就是对一条可能已经到账的任务重复领。
//   少做一条的代价是少挣几分钱，多做一条的代价是**上游账目对不上**而我们说不清。
// * ⚠ **缺** `userStatus` 那一格与"读到陌生码"是两回事：缺格按 0（未完成）走，
//   这是参照实现自己定下的（`?? 0`），也是任务表里"没发过的新条目"的正常形状。
//
// # 钱数怎么念
//
// 上游给的是**分**。余额那一句参照实现是 `Number(x)/100` 原样（`3`、`4.6`，不补零），
// 任务与奖励那一句是 `.toFixed(2)`（`0.10元`）。**两种都留**——用户看到的就是这两种，
// 统一成一种就是改动可见输出。

import { rpArr, rpNum, rpStr, redpackIsRecord } from './redpackApi.ts';

/** 四档归类。 */
export type RedpackState = 'todo' | 'done' | 'blocked' | 'unknown';

/** `userStatus` → 档位。**缺格 = `todo`**（见文件头）。 */
export function classify(status: number | undefined): RedpackState {
  if (status === undefined || status === 0) return 'todo';
  if (status === 1) return 'done';
  if (status === 3 || status === 4) return 'blocked';
  return 'unknown';
}

/** 状态码的人话；**不认识的码给 `undefined`**（判据层要能把"不认识"单独说出来）。 */
export function statusText(status: number): string | undefined {
  if (status === 0) return '未完成';
  if (status === 1) return '已完成';
  if (status === 3) return '奖品已兑完';
  if (status === 4) return '明天再来';
  return undefined;
}

/** 给日志用的一句：认识的码说人话，不认识的**如实说不认识**（不折进"未完成"）。 */
export function statusLabel(status: number | undefined): string {
  if (status === undefined) return '未完成';
  return statusText(status) ?? `没见过的状态 ${status}`;
}

/** 余额那一句的写法：`Number(分)/100` 原样（参照实现这里**不**补零）。 */
export function yuanRaw(cents: number | undefined): string {
  return String((Number(cents) || 0) / 100);
}

/** 任务与奖励那一句：`0.10元` 两位小数。 */
export function yuan2(cents: number | undefined): string {
  return `${((Number(cents) || 0) / 100).toFixed(2)}元`;
}

/** 一条任务。`id` 原样留着（发 `userCompleteTask` 时照上游给的形式发回去）。 */
export interface RedpackTask {
  id: unknown;
  taskCode: string;
  taskName: string;
  status: number | undefined;
  /** `prizeAmount ?? taskAmount`（参照实现 `taskAmount()` 的取值顺序） */
  amount: number | undefined;
  raw: Record<string, unknown>;
}

/** 任务表（三个分组 + 签到那一格）。 */
export interface RedpackTaskList {
  sign: { isToday: number | undefined; status: number | undefined; amount: number | undefined } | undefined;
  tasks: RedpackTask[];
  /** 各组的原始条数（写日志里的组名行时要按组走） */
  groups: { title: string; tasks: RedpackTask[] }[];
}

/** 分组与它的中文组名（参照实现 `cloudPhoneRedpackTask` 里那一张表）。 */
export const REDPACK_GROUPS: readonly { key: string; title: string }[] = [
  { key: 'configTaskNoviceList', title: '新手任务' },
  { key: 'configTaskDailyList', title: '每日任务' },
  { key: 'configTaskMonthlyList', title: '每月任务' },
];

function toTask(v: unknown): RedpackTask | undefined {
  if (!redpackIsRecord(v)) return undefined;
  const code = rpStr(v, 'taskCode') ?? '';
  return {
    id: v.id,
    taskCode: code,
    taskName: rpStr(v, 'taskName') ?? '',
    status: rpNum(v, 'userStatus'),
    amount: rpNum(v, 'prizeAmount') ?? rpNum(v, 'taskAmount'),
    raw: v,
  };
}

/** 解任务表。`data` 形状不对时给空表（调用方按"读不到"处理，不猜）。 */
export function parseTaskList(data: unknown): RedpackTaskList {
  const groups = REDPACK_GROUPS.map(({ key, title }) => ({
    title,
    tasks: rpArr(data, key)
      .map(toTask)
      .filter((t): t is RedpackTask => t !== undefined),
  }));
  // ⚠ **只认 `isToday === 1` 那一格**，没有今天那一格就是"今天没有签到"。
  //   参照实现也是 `find(item => item.isToday === 1)` 之后 `if (!today) return`，
  //   不拿第一条兜底 —— 第一条完全可能是**昨天**那格，拿它的状态说今天的事，
  //   日志里那句「已完成: 每日签到」就是假结论。
  const today = rpArr(data, 'configTaskSignList').find((x) => rpNum(x, 'isToday') === 1);
  return {
    sign: redpackIsRecord(today)
      ? {
          isToday: rpNum(today, 'isToday'),
          status: rpNum(today, 'status'),
          amount: rpNum(today, 'signAmount'),
        }
      : undefined,
    tasks: groups.flatMap((g) => g.tasks),
    groups,
  };
}

/** 在表里按 `taskCode` 找一条（回查那一发要用新表找同码的那条）。 */
export function findTask(list: RedpackTaskList, taskCode: string): RedpackTask | undefined {
  return list.tasks.find((t) => t.taskCode === taskCode);
}

/** 编号能不能原样发出去。活动站的 `id` 有时是数字、有时是数字串 —— 照它给的形式发回，
 *  但**别的形状一律不收**（`null` / 对象 / 空串发出去只会得到一个含糊的错误码，
 *  而那句错误码在日志里看起来像"活动站坏了"）。 */
export function sendableId(id: unknown): string | number | undefined {
  if (typeof id === 'number') return Number.isFinite(id) ? id : undefined;
  if (typeof id === 'string' && id.trim() !== '') return id;
  return undefined;
}

/** 任务名后面的金额括注：` (0.30元)`；没有金额就空串。 */
export function amountSuffix(task: Pick<RedpackTask, 'amount'>): string {
  const t = yuan2(task.amount);
  return task.amount === undefined ? '' : ` (${t})`;
}

// ───────────────────────── 三张码表 ─────────────────────────

/** 先登记、等一会儿、再报"浏览过了"（参照实现 `BROWSE_TASKS`）。 */
export const BROWSE_TASKS: readonly string[] = ['NOVICE_2', 'NOVICE_3', 'MONTHLY_1'];
/** 只登记、没有浏览确认（参照实现 `DIRECT_TASKS`）。 */
export const DIRECT_TASKS: readonly string[] = ['MONTHLY_4', 'MONTHLY_5'];
/** 规则上只能人工做的那几条与它的原因。 */
export const MANUAL_TASKS: Readonly<Record<string, string>> = { NOVICE_1: '需跳转领取定向流量' };

/** 每日使用云机（要真的进云机用过才算，我们只能把登记那一枪发出去）。 */
export const CLOUD_USE_CODE = 'DAILY_1';
/** 在云手机里安装应用（会**往用户的云机里装包**）。 */
export const INSTALL_CODE = 'MONTHLY_2';
/** 答题（题面与答案靠下面那张写死的对照表）。 */
export const TOPIC_CODE = 'MONTHLY_3';

/** 一条任务该怎么处置。 */
export type RedpackKind = 'browse' | 'direct' | 'cloudUse' | 'install' | 'topic' | 'manual';

/** 按 `taskCode` 派发到六种处置之一（认不出来的 ⇒ `manual`，原因写「未知任务」）。 */
export function dispatchKind(taskCode: string): RedpackKind {
  if (BROWSE_TASKS.includes(taskCode)) return 'browse';
  if (DIRECT_TASKS.includes(taskCode)) return 'direct';
  if (taskCode === CLOUD_USE_CODE) return 'cloudUse';
  if (taskCode === INSTALL_CODE) return 'install';
  if (taskCode === TOPIC_CODE) return 'topic';
  return 'manual';
}

/** 「需手动完成」括号里那句原因。 */
export function manualReason(taskCode: string): string {
  return MANUAL_TASKS[taskCode] ?? '未知任务';
}

// ───────────────────────── 题库 ─────────────────────────

/** 参照实现写死的题面 → 答案对照表（15 条，逐条照抄）。
 *
 *  ⚠ 这是上游题面与答案的对照，**不是**我们推出来的。题面哪天改字，这里就查不到
 *  ⇒ 走「未知题目 ⇒ 需手动完成」，而不是瞎猜一个字母。 */
export const KNOWN_ANSWERS: Readonly<Record<string, string>> = {
  '如何查看并更新移动云手机客户端最新版本？': "进入'我的'-点击'关于云手机'-点击'检查新版本'",
  '移动云手机可领取定向流量，每月赠送的定向流量是（  ）。': '30GB',
  '移动云手机端内订购的专业版分辨率已升级到1080P，该说法是否正确？': '正确',
  '移动云手机支持视频录制，该说法是否正确？': '正确',
  '云手机支持通过手机、平板、电脑等多种终端设备登录使用，该说法是否正确？': '正确',
  '使用中国移动号码登录移动云手机，是否支持手机号一键登录？': '支持',
  '只有中国移动运营商号码能使用移动云手机？': '不正确',
  '移动云手机是否需要充电使用？': '不需要',
  '移动云手机支持截图，该说法是否正确？': '正确',
  '移动云手机AI灵犀助手已接入DeepSeek，是否正确？': '正确',
  '移动云手机内支持画面清晰度切换，该说法是否正确？': '正确',
  '移动云手机支持连接蓝牙使用吗？': '不支持',
  '在云手机内安装游戏应用是否占本地手机存储空间？': '否，不占本地空间',
  '如何更换云机内的桌面主题或壁纸？': '云机内-【设置】-壁纸/个性主题',
  '如何将云手机里的应用添加至本地手机桌面？': '云手机桌面-长按应用-发送图标到本地',
};

/** 选项下标 → 字母（`ABCD[index]`）。 */
export const ANSWER_LETTERS = 'ABCD';

/** 一道题。`options` 解不出来给空数组（**不猜**）。 */
export interface RedpackTopic {
  id: unknown;
  question: string;
  options: string[];
}

/** `topicOption` 是**字符串套 JSON 数组**那种形状；解不出 ⇒ `[]`。 */
export function parseTopicOptions(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 解题库列表的第一条（参照实现只看 `list[0]`）。没有 ⇒ `undefined`。 */
export function parseTopic(data: unknown): RedpackTopic | undefined {
  const first = rpArr(data, 'list')[0];
  if (!redpackIsRecord(first)) return undefined;
  return {
    id: first.id,
    question: String(first.topicContent ?? ''),
    options: parseTopicOptions(first.topicOption),
  };
}

/** 这道题的答案文本；查不到 ⇒ `''`（⇒ 需手动完成）。 */
export function knownAnswer(question: string): string {
  return KNOWN_ANSWERS[question] ?? '';
}

/** 答案文本 → 选项字母。题面认识、但**选项里没有那句**时给 `undefined`（不硬猜下标）。 */
export function answerLetter(topic: RedpackTopic): string | undefined {
  const text = knownAnswer(topic.question);
  if (text === '') return undefined;
  const at = topic.options.indexOf(text);
  if (at < 0) return undefined;
  return ANSWER_LETTERS[at];
}

// ───────────────────────── 云手机 ─────────────────────────

export interface RedpackPhone {
  instanceId: string;
  /** 第一台实例锁没锁屏（`lockStatus === 'Y'`） */
  locked: boolean;
}

function toPhone(v: unknown): RedpackPhone | undefined {
  if (!redpackIsRecord(v)) return undefined;
  const instances = Array.isArray(v.subsProdInstances) ? v.subsProdInstances : [{}];
  const first = redpackIsRecord(instances[0]) ? (instances[0] as Record<string, unknown>) : {};
  return {
    instanceId: rpStr(v, 'instanceId') ?? '',
    locked: first.lockStatus === 'Y',
  };
}

/** 两档（ACTIVE / PENDING）读回来的云机合成一条列表。
 *  形状照参照实现：`data.data` 是对象时取它，否则取 `data`，再取 `subscribeDetails`。 */
export function parsePhones(data: unknown): RedpackPhone[] {
  const nested = redpackIsRecord(data) && redpackIsRecord(data.data) ? data.data : data;
  return rpArr(nested, 'subscribeDetails')
    .map(toPhone)
    .filter((p): p is RedpackPhone => p !== undefined);
}

/** 挑一台能用的：第一台**没锁屏**的；全锁了就退回第一台（照参照实现的 `?? phones[0]`）。 */
export function pickPhone(phones: RedpackPhone[]): RedpackPhone | undefined {
  return phones.find((p) => !p.locked) ?? phones[0];
}

/** 锁屏那台不能装 ⇒ 「需手动完成 …（云机锁屏）」。 */
export function phoneUsable(phone: RedpackPhone | undefined): boolean {
  return phone !== undefined && phone.instanceId !== '' && !phone.locked;
}

// ───────────────────────── 应用列表 / 装机进度 ─────────────────────────

export interface RedpackApp {
  /** 上报装机结果用这个 */
  id: unknown;
  /** 发装机那一枪用的是 `packageId` 的**字符串**形式 */
  packageId: string;
  packageName: string;
  apkName: string;
}

export function parseApps(data: unknown): RedpackApp[] {
  return rpArr(data, 'list')
    .filter(redpackIsRecord)
    .map((v) => ({
      id: v.id,
      packageId: String(v.packageId ?? ''),
      packageName: rpStr(v, 'packageName') ?? '',
      apkName: rpStr(v, 'apkName') ?? '',
    }))
    .filter((a) => a.packageName !== '');
}

/** 从 `instanceApkInstallStatus` 的响应里读装机状态。
 *  参照实现：`data` 是数组就用它，否则取 `data.list`，再取 `[0].instanceList[0].installStatus`。 */
export function readInstallStatus(data: unknown): number | undefined {
  const list = Array.isArray(data) ? data : redpackIsRecord(data) && Array.isArray(data.list) ? data.list : [];
  const first = list[0];
  if (!redpackIsRecord(first)) return undefined;
  const instances = Array.isArray(first.instanceList) ? first.instanceList : [];
  const one = instances[0];
  if (!redpackIsRecord(one)) return undefined;
  return rpNum(one, 'installStatus');
}

/** `installStatus === 2` 的意思是"这台云机上已经装好了" ⇒ 只上报、不再装。 */
export const INSTALL_STATUS_EXISTS = 2;

/** 装机任务的两个终局码：2 成功、3 失败。 */
export const INSTALL_TASK_DONE = 2;
export const INSTALL_TASK_FAILED = 3;

/** `apkInstall` 的回执：`data.success` 真假 + `data.taskId`。 */
export function readInstallStart(data: unknown): { started: boolean; taskId: string } {
  if (!redpackIsRecord(data)) return { started: false, taskId: '' };
  return {
    started: data.success === true,
    taskId: data.taskId === undefined ? '' : String(data.taskId),
  };
}

/** `appInstallTaskStatus` 的进度码。 */
export function readInstallProgress(data: unknown): number | undefined {
  return rpNum(data, 'taskStatus');
}

// ───────────────────────── 余额 / 奖励 ─────────────────────────

export function readBalance(data: unknown): { can: number | undefined; total: number | undefined } {
  const info = redpackIsRecord(data) && redpackIsRecord(data.info) ? data.info : {};
  return { can: rpNum(info, 'canAmount'), total: rpNum(info, 'totalAmount') };
}

/** `userToastInfo` 里"刚拿到的那条奖"。没给金额 ⇒ `undefined`（参照实现这时**不打行**）。 */
export function readReward(
  data: unknown,
): { name: string; cents: number } | undefined {
  const prize = redpackIsRecord(data) && redpackIsRecord(data.lastUserPrize) ? data.lastUserPrize : undefined;
  if (prize === undefined) return undefined;
  const cents = rpNum(prize, 'prizeAmount');
  if (cents === undefined || cents === 0) return undefined;
  return { name: rpStr(prize, 'prizeName') ?? '', cents };
}

/** 换票那一枪的 `data.token`。 */
export function readRedpackToken(data: unknown): string | undefined {
  return rpStr(data, 'token');
}

/** `gethwToken` 的 `data.hwToken`。 */
export function readHwToken(data: unknown): string | undefined {
  return rpStr(data, 'hwToken');
}

/** 写请求那一族的回执：`data.status`。**缺格不当失败**（见任务层 `completeTask` 的注释）。 */
export function readWriteStatus(data: unknown): number | undefined {
  return rpNum(data, 'status');
}
