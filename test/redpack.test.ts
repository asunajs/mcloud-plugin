// 红包派对的**编排层**：整趟怎么走过每一段，以及用户因此看到哪几句。
//
// 这一族零抓包（协议层的线格式没有实拍），所以这里钉的是**行为**：
//   ① 逐行文案 = 参照实现那一次真跑成功的读数（`mcloud-sign` 的 history.json，
//      2026-09-16 账号1，3760ms 判成功）。**那一趟就是规格**。
//   ② 一次调用只走一段、状态落盘 ⇒ 断在哪一段都能接上（面板的执行预算很短）。
//   ③ 三条刻意的不同（陌生状态码不发写 / 同一条一天只写一次 / 票跑完就抹）
//      都有测试守着，否则"顺手统一"就会把它们抹平。
//
// ⚠ 时钟是假的（`nowMs` + `spin`）：浏览那 15 秒与装机轮询在这里都不真等。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REDPACK_BUDGET, redpackGate, redpackOn, redpackStep } from '../src/mcloud/tasks/redpack.ts';
import {
  STATE_REDPACK,
  STATE_REDPACK_ENABLED,
  loadRedpackState,
  redpackDay,
  redpackSummary,
  setRedpackEnabled,
  takeRedpackLines,
} from '../src/mcloud/tasks/redpackState.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import { memStore } from '../src/store/memory.ts';
import type { Store } from '../src/store/types.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { TaskDeps, TaskOutcome } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-23T02:00:00.000Z'; // 东八区 10:00
const AUTH = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';

/** 任务表里的一条（`cents` 是上游的奖品金额，单位分）。 */
interface Spec {
  code: string;
  name: string;
  id: number;
  cents?: number;
  status?: number;
}

/** 参照实现那一次运行读到的那张表（新手组是空的 ⇒ 那一行不打）。 */
const DAILY: Spec[] = [{ code: 'DAILY_1', name: '每日使用云机', id: 21, cents: 20, status: 0 }];
const MONTHLY: Spec[] = [
  { code: 'MONTHLY_4', name: '打开云手机消息通知', id: 31, cents: 30, status: 0 },
  { code: 'MONTHLY_2', name: '在云手机里安装应用', id: 32, cents: 30, status: 0 },
  { code: 'OTHER_9', name: '体验任意一款云应用', id: 33, cents: 10, status: 0 },
  { code: 'MONTHLY_5', name: '去体验AI灵犀', id: 34, cents: 30, status: 1 },
];

interface SiteOpts {
  novice?: Spec[];
  daily?: Spec[];
  monthly?: Spec[];
  /** 签到那一格；`null` = 今天没有这一格 */
  sign?: { status?: number; amount?: number; isToday?: number } | null;
  /** 云机列表（`thirdQueryUserRelationshipV2` 的 `data`） */
  phones?: unknown[];
  apps?: unknown[];
  hwToken?: string;
  /** `instanceApkInstallStatus`：2 = 这台云机上早装好了（其余包走这一格） */
  installStatus?: number;
  /** 这些包名回报"已经装好了"（`installStatus: 2`）⇒ 只上报、不再装 */
  installed?: string[];
  /** `apkInstall` 那一发回失败 ⇒ 换下一个应用 */
  installStartFails?: boolean;
  /** `appInstallTaskStatus`：2 成功 / 3 失败 / 其余继续等 */
  installTaskStatus?: number;
  topic?: { id: number; topicContent: string; topicOption: string } | null;
  /** `userToastInfo` 的奖（缺省 = 上游没给 ⇒ 不打那一行） */
  reward?: { prizeName?: string; prizeAmount?: number } | null;
  /** 登记之后活动站就把这几条置 1（其余条保持 0，那是真机读数里的「已登记」） */
  flipOnComplete?: string[];
  /** 这些路径回业务失败（`header.status: 500`） */
  fail?: string[];
  /** 换 SSO 票那一枪回失败 */
  ssoFails?: boolean;
  /** 活动站不认这张票 */
  tokenFails?: boolean;
}

interface Sent {
  url: string;
  path: string;
  body: Record<string, unknown>;
  at: number;
}

/** 假的活动站：按路径分派，并记下每一发（顺序 + 时刻）。 */
function makeSite(opts: SiteOpts, clock: () => number): { transport: Transport; sent: Sent[] } {
  const sent: Sent[] = [];
  const daily = opts.daily ?? DAILY;
  const monthly = opts.monthly ?? MONTHLY;
  const novice = opts.novice ?? [];
  const sign = opts.sign === undefined ? { status: 0, amount: 10, isToday: 1 } : opts.sign;
  const status = new Map<string, number>();
  for (const t of [...novice, ...daily, ...monthly]) status.set(t.code, t.status ?? 0);
  const idToCode = new Map<number, string>();
  for (const t of [...novice, ...daily, ...monthly]) idToCode.set(t.id, t.code);

  const row = (t: Spec): Record<string, unknown> => ({
    id: t.id,
    taskCode: t.code,
    taskName: t.name,
    userStatus: status.get(t.code) ?? 0,
    prizeAmount: t.cents,
  });
  const table = (): unknown => ({
    // 签到那一格也跟着 `userSign` 变（第二趟读到的就该是"已经签过了"）
    configTaskSignList:
      sign === null
        ? []
        : [
            {
              isToday: sign.isToday ?? 1,
              status: status.get('SIGN') ?? sign.status ?? 0,
              signAmount: sign.amount ?? 10,
            },
          ],
    configTaskNoviceList: novice.map(row),
    configTaskDailyList: daily.map(row),
    configTaskMonthlyList: monthly.map(row),
  });

  const ok = (data: unknown): { status: number; headers: {}; body: string } => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ header: { status: 200, respMsg: '成功' }, data }),
  });

  const transport = ((req: { url: string; body?: string }) => {
    const path = req.url.slice(req.url.indexOf('/', 8));
    const body = req.body === undefined ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    sent.push({ url: req.url, path, body, at: clock() });
    if (sent.length > 4_000) throw new Error('假上游被打爆了（步数上限没拦住）');
    if ((opts.fail ?? []).some((f) => path.includes(f))) {
      return { status: 200, headers: {}, body: JSON.stringify({ header: { status: 500, errMsg: '活动站说不通' }, data: null }) };
    }
    if (path.includes('/user/querySpecTokenV2')) {
      return opts.ssoFails
        ? { status: 200, headers: {}, body: JSON.stringify({ success: false, code: '9999', message: '凭据不认了' }) }
        : { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { token: 'SSO-1' } }) };
    }
    if (path.includes('/user/tokenValidate')) return ok(opts.tokenFails ? {} : { token: 'RP-TOKEN-1' });
    if (path.includes('/configTaskLoginList')) return ok(table());
    if (path.includes('/userAccountInfo')) return ok({ info: { canAmount: 300, totalAmount: 460 } });
    if (path.includes('/userSign')) {
      if (sign !== null) status.set('SIGN', 1);
      return ok({ status: 1 });
    }
    if (path.includes('/userCompleteTask')) {
      const code = idToCode.get(Number(body.taskId));
      if (code !== undefined && (opts.flipOnComplete ?? []).includes(code)) status.set(code, 1);
      return ok({ status: 1 });
    }
    if (path.includes('/userBrowse')) return ok({ status: 1 });
    if (path.includes('/userToastInfo')) {
      // 上游把奖放在 `data.lastUserPrize` 里；没给这一格 ⇒ 不打那一行
      return ok(opts.reward === undefined || opts.reward === null ? {} : { lastUserPrize: opts.reward });
    }
    if (path.includes('/configTopicList')) return ok(opts.topic === undefined || opts.topic === null ? {} : { list: [opts.topic] });
    if (path.includes('/userTopicAnswer')) return ok({ status: 1 });
    if (path.includes('/thirdQueryUserRelationshipV2')) {
      return ok({ data: { subscribeDetails: opts.phones ?? [] } });
    }
    if (path.includes('/gethwToken')) return ok({ hwToken: opts.hwToken ?? 'HW-1' });
    if (path.includes('/getRcsToken')) return ok({ status: 1 });
    if (path.includes('/configAppList')) return ok({ list: opts.apps ?? [] });
    if (path.includes('/instanceApkInstallStatus')) {
      const pkgs = (body.apkList ?? []) as string[];
      const pkg = pkgs[0] ?? '';
      const s = (opts.installed ?? []).includes(pkg) ? 2 : (opts.installStatus ?? 0);
      return ok([{ instanceList: [{ installStatus: s }] }]);
    }
    if (path.includes('/apkInstall')) {
      return ok(opts.installStartFails === true ? { success: false } : { success: true, taskId: 'TASK-9' });
    }
    if (path.includes('/appInstallTaskStatus')) return ok({ taskStatus: opts.installTaskStatus ?? 2 });
    if (path.includes('/userInstallApp')) return ok({ status: 1 });
    throw new Error(`假上游不认识这一发：${path}`);
  }) as unknown as Transport;

  return { transport, sent };
}

interface Harness {
  store: Store;
  deps: TaskDeps;
  sent: Sent[];
  t: { ms: number };
}

/** 一套假时钟 + 假上游 + 空 store（默认有原生凭据，因为整趟第一段就要用它换票）。 */
function harness(opts: SiteOpts = {}): Harness {
  const t = { ms: Date.parse(NOW) };
  const { transport, sent } = makeSite(opts, () => t.ms);
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  const deps: TaskDeps = {
    store,
    transport,
    nowIso: NOW,
    nowMs: () => t.ms,
    spin: () => {
      t.ms += 500;
    },
    settleMs: 0,
  };
  return { store, deps, sent, t };
}

/** 走到这一趟收尾（`drain` 干的事，这里手动做一遍，好数步数）。 */
function runLeg(deps: TaskDeps, maxSteps = 300): { outcomes: TaskOutcome[]; lines: string[] } {
  const outcomes: TaskOutcome[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const o = redpackStep(deps);
    outcomes.push(o);
    if (!o.ok || o.idle === true || o.skipped === true) {
      return { outcomes, lines: takeRedpackLines(deps.store, deps.nowIso) };
    }
  }
  throw new Error(`这一趟走了超过 ${String(maxSteps)} 步还没收尾`);
}

const nPath = (sent: Sent[], needle: string): number => sent.filter((s) => s.path.includes(needle)).length;

test('这一族没开 ⇒ 一个请求都不发；没写过开关 ⇒ 默认开（照参照实现的默认值）', () => {
  const on = harness();
  assert.equal(redpackOn(on.deps), true, '缺省必须是开着 —— 自造一道默认关的闸等于偷偷停掉这一族');
  assert.equal(redpackGate(on.deps).idle, false);

  const off = harness();
  setRedpackEnabled(off.store, false, NOW);
  const gate = redpackGate(off.deps);
  assert.equal(gate.idle, true);
  assert.equal(gate.skipped, true);
  assert.equal(off.sent.length, 0, '关着就不该碰上游');
  // 关着的时候 `runDaily` 走的是这条出口，所以逐行也该是空的
  assert.deepEqual(takeRedpackLines(off.store, NOW), []);
});

test('整趟逐行 = 参照实现那一次真跑成功的 15 行（逐字）', () => {
  const { deps, sent, store } = harness();
  const { outcomes, lines } = runLeg(deps);
  assert.deepEqual(
    lines,
    [
      '余额: 可用3元，累计4.6元',
      '去完成: 每日签到 (0.10元)',
      '已完成: 每日签到',
      '每日任务',
      '去完成: 每日使用云机 (0.20元)',
      '需手动完成: 每日使用云机 (需云机内实际使用)',
      '每月任务',
      '去完成: 打开云手机消息通知 (0.30元)',
      '已登记: 打开云手机消息通知 (未完成)',
      '去完成: 在云手机里安装应用 (0.30元)',
      '需手动完成: 在云手机里安装应用 (无云手机)',
      '去完成: 体验任意一款云应用 (0.10元)',
      '需手动完成: 体验任意一款云应用 (0.10元) (未知任务)',
      '已完成: 去体验AI灵犀 (0.30元)',
      '余额: 可用3元，累计4.6元',
    ],
    '少一行、多一行、措辞变了都是改动用户看到的输出',
  );
  // 空的新手组不打那一行（参照实现是 `if (!tasks.length) continue`）
  assert.equal(lines.includes('新手任务'), false);
  // 收尾那句用的是台账，不是 `drain` 折过的 `note`
  assert.match(redpackSummary(store, redpackDay(NOW)) ?? '', /未完成 \d+、已完成 \d+/);
  assert.equal(outcomes[outcomes.length - 1]?.idle, true);
  // 头尾各一次余额 ⇒ 两句一样时也照打（去重就会少掉用户看得到的一行）
  assert.equal(nPath(sent, '/userAccountInfo'), 2);
  // 换票两发在**同一次调用**里（SSO 票只活几分钟）
  assert.equal(sent[0]?.path.endsWith('/user/querySpecTokenV2'), true, sent[0]?.path);
  assert.equal(sent[1]?.path.endsWith('/tokenValidate'), true, sent[1]?.path);
  assert.equal(sent[0]?.body.toSourceId, '001216', '这一族用的是它自己的 toSourceId');
  assert.equal(sent[1]?.body.token, 'SSO-1', '换到的 SSO 票拿去换活动站的票');
});

test('票跑完就抹：状态里没有活动站票，也没有进行中的任务', () => {
  const { deps, store } = harness();
  runLeg(deps);
  const raw = store.getState(STATE_REDPACK) ?? '';
  assert.ok(!raw.includes('RP-TOKEN-1'), `台账里不该留着票：${raw.slice(0, 80)}`);
  const st = loadRedpackState(store, redpackDay(NOW));
  assert.equal(st?.phase, 'done');
  assert.equal(st?.job, undefined);
});

test('没见过的状态码 ⇒ 不发写，只说一句（这是与参照实现**刻意**不同的一格）', () => {
  const { deps, sent } = harness({
    daily: [{ code: 'DAILY_9', name: '看不懂的一条', id: 51, cents: 20, status: 2 }],
    monthly: [],
    sign: null,
  });
  const { lines } = runLeg(deps);
  assert.ok(lines.some((l) => l === '暂不可做: 看不懂的一条 (没见过的状态 2)'), lines.join('\n'));
  assert.equal(nPath(sent, '/userCompleteTask'), 0, '状态不认识就打写请求，是在替活动站编造完成记录');
  // 小结里这一格单独数着，不折进"已完成"
  assert.match(redpackSummary(deps.store, redpackDay(NOW)) ?? '', /状态不认识 1/);
});

test('今天没有签到那一格 ⇒ 一行都不打、那一枪也不发（别拿"缺格"当"没签过"）', () => {
  const { deps, sent } = harness({ sign: null, daily: [], monthly: [] });
  const { lines } = runLeg(deps);
  assert.ok(!lines.some((l) => l.includes('签到')), lines.join('\n'));
  assert.equal(nPath(sent, '/userSign'), 0, '没有今天那一格还去签，是替活动站编一条记录');
  // 只有"昨天那格"也不算今天（`isToday===1` 是唯一的入口）
  const yesterday = harness({ sign: { status: 0, amount: 10, isToday: 0 }, daily: [], monthly: [] });
  const y = runLeg(yesterday.deps);
  assert.ok(!y.lines.some((l) => l.includes('签到')), y.lines.join('\n'));
});

test('同一条任务一天只写一次：第二趟不再登记，但照样把话说完', () => {
  const { deps, sent } = harness();
  const first = runLeg(deps);
  const writes = nPath(sent, '/userCompleteTask');
  assert.equal(writes, 3, '使用云机、消息通知、装机这三条各登记一次');
  assert.deepEqual(first.lines.filter((l) => l.startsWith('已登记')), ['已登记: 打开云手机消息通知 (未完成)']);

  const before = sent.length;
  const second = runLeg(deps);
  assert.equal(nPath(sent.slice(before), '/userCompleteTask'), 0, '今天写过的那几条不能再报一遍');
  // 表现不变：还是那一句「已登记」，用户看不出这是第二趟
  assert.ok(second.lines.includes('已登记: 打开云手机消息通知 (未完成)'), second.lines.join('\n'));
  // 「每日使用云机」第二趟仍说它自己那句（不因为换了一趟就改口）
  assert.ok(second.lines.includes('需手动完成: 每日使用云机 (需云机内实际使用)'), second.lines.join('\n'));
  // 装机那条今天写过了 ⇒ 不再往用户的云机里伸手
  assert.ok(second.lines.includes('已登记: 在云手机里安装应用 (未完成)'), second.lines.join('\n'));
  assert.equal(nPath(sent.slice(before), '/apkInstall'), 0, '第二趟不该再去装机');
  // 签到在第二趟是「已经签过了」—— 活动站那边状态确实变了
  assert.ok(second.lines.includes('已完成: 每日签到 (0.10元)'), second.lines.join('\n'));
});

test('浏览那一类：等满 15 秒才发确认，等待切成小口（每口一步）', () => {
  const { deps, sent, t } = harness({
    daily: [{ code: 'MONTHLY_1', name: '看一条广告', id: 61, cents: 5, status: 0 }],
    monthly: [],
    sign: null,
    flipOnComplete: ['MONTHLY_1'],
  });
  const start = t.ms;
  const { lines } = runLeg(deps);
  const browse = sent.find((s) => s.path.includes('/userBrowse'));
  assert.notEqual(browse, undefined, '浏览确认没发出去 ⇒ 这一条永远不会被活动站认');
  assert.ok((browse?.at ?? 0) - start >= 15_000, `只等了 ${String((browse?.at ?? 0) - start)}ms，参照实现是 15 秒`);
  assert.ok(lines.includes('已完成: 看一条广告'), lines.join('\n'));
});

test('装机：先问装过没有 —— 装过只上报并换下一个；真装了就说「已安装应用: X」', () => {
  const apps = [
    { id: 71, packageId: 88, packageName: 'a.first', apkName: '第一个' },
    { id: 72, packageId: 99, packageName: 'a.second', apkName: '第二个' },
  ];
  // 第一台云机里 `a.first` 已经装好（`installStatus: 2`）⇒ 上报 `existed=1` 后**换下一个**；
  // 第二个真装了，活动站回查还是 0 ⇒ 那句说的是"我们做成了什么"。
  const { deps, sent } = harness({
    monthly: [{ code: 'MONTHLY_2', name: '在云手机里安装应用', id: 32, cents: 30, status: 0 }],
    daily: [],
    sign: null,
    phones: [{ instanceId: 'I1', subsProdInstances: [{ lockStatus: 'N' }] }],
    apps,
    installed: ['a.first'],
  });
  const { lines } = runLeg(deps);
  assert.equal(sent.filter((s) => s.path.includes('/userInstallApp') && s.body.existed === 1).length, 1, '装过的那条只上报');
  assert.equal(sent.filter((s) => s.path.includes('/userInstallApp') && s.body.existed === undefined).length, 1, '真装的那条上报时不带 existed');
  assert.deepEqual(
    sent.filter((s) => s.path.includes('/apkInstall')).map((s) => s.body.appId),
    ['99'],
    '第一个既然装过了就不该再装一遍',
  );
  assert.ok(lines.includes('已安装应用: 第一个') === false, lines.join('\n'));
  assert.ok(lines.includes('已安装应用: 第二个'), lines.join('\n'));
});

test('装机：云机锁屏 ⇒ 不动用户的机器；应用问完 ⇒ 「未找到可安装应用」', () => {
  const locked = harness({
    monthly: [{ code: 'MONTHLY_2', name: '在云手机里安装应用', id: 32, cents: 30, status: 0 }],
    daily: [],
    sign: null,
    phones: [{ instanceId: 'I1', subsProdInstances: [{ lockStatus: 'Y' }] }],
  });
  const a = runLeg(locked.deps);
  assert.ok(a.lines.includes('需手动完成: 在云手机里安装应用 (云机锁屏)'), a.lines.join('\n'));
  assert.equal(nPath(locked.sent, '/apkInstall'), 0, '锁屏的机器装不进去，一发都不该发');

  // 每个包都装不上 ⇒ 那句是「未找到可安装应用」，不是「需手动完成」
  const none = harness({
    monthly: [{ code: 'MONTHLY_2', name: '在云手机里安装应用', id: 32, cents: 30, status: 0 }],
    daily: [],
    sign: null,
    phones: [{ instanceId: 'I1' }],
    apps: [
      { id: 71, packageId: 88, packageName: 'a.one', apkName: '第一个' },
      { id: 72, packageId: 99, packageName: 'a.two', apkName: '第二个' },
    ],
    installStartFails: true,
  });
  const b = runLeg(none.deps);
  assert.ok(b.lines.includes('未找到可安装应用: 在云手机里安装应用'), b.lines.join('\n'));
  assert.equal(nPath(none.sent, '/apkInstall'), 2, '两个包各试一次就问完了');

  // 列表里没有带包名的项 ⇒ 参照实现那句「应用列表为空」（与"装不上"是两件事）
  const empty = harness({
    monthly: [{ code: 'MONTHLY_2', name: '在云手机里安装应用', id: 32, cents: 30, status: 0 }],
    daily: [],
    sign: null,
    phones: [{ instanceId: 'I1' }],
    apps: [{ id: 71, packageId: 88, packageName: '', apkName: '没包名的项' }],
  });
  const c = runLeg(empty.deps);
  assert.ok(c.lines.includes('应用列表为空: 在云手机里安装应用'), c.lines.join('\n'));
  assert.equal(nPath(empty.sent, '/apkInstall'), 0);
});

test('答题：题面认识且选项里有那句才交；交成了说「已完成」并读那条奖', () => {
  const { deps, sent } = harness({
    monthly: [{ code: 'MONTHLY_3', name: '答一道题', id: 35, cents: 10, status: 0 }],
    daily: [],
    sign: null,
    topic: { id: 5, topicContent: '移动云手机是否需要充电使用？', topicOption: '["需要","不需要"]' },
    reward: { prizeName: '云朵', prizeAmount: 50 },
    flipOnComplete: ['MONTHLY_3'],
  });
  const { lines } = runLeg(deps);
  const answer = sent.find((s) => s.path.includes('/userTopicAnswer'));
  assert.deepEqual(
    { taskId: answer?.body.taskId, topicId: answer?.body.topicId, answer: answer?.body.answer },
    { taskId: 35, topicId: 5, answer: 'B' },
    '答案字母由"那句在选项里的下标"决定',
  );
  assert.ok(lines.includes('已完成: 答一道题'), lines.join('\n'));
  assert.ok(lines.includes('奖励: 云朵 +0.50元'), lines.join('\n'));

  // 题面不在知识表里 ⇒ 15 轮问完就**不猜**，说「需手动完成（未知题目: …）」
  const odd = harness({
    monthly: [{ code: 'MONTHLY_3', name: '答一道题', id: 35, cents: 10, status: 0 }],
    daily: [],
    sign: null,
    topic: { id: 5, topicContent: '一道没见过的新题？', topicOption: '["甲","乙","丙","丁"]' },
  });
  const r = runLeg(odd.deps, 400);
  assert.ok(r.lines.some((l) => l.startsWith('需手动完成: 答一道题 (未知题目: 一道没见过的新题？')), r.lines.join('\n'));
  assert.equal(nPath(odd.sent, '/userTopicAnswer'), 0, '不认识题就不该把猜的字母发过去');
  assert.equal(nPath(odd.sent, '/configTopicList'), 15, '参照实现那个循环问满 15 轮');
});

test('换不到票 ⇒ 如实说登录失败、整趟收尾，后面一条都不撞', () => {
  const { deps, sent } = harness({ ssoFails: true });
  const { outcomes, lines } = runLeg(deps);
  assert.equal(outcomes.length, 1, '登录那一步就收尾了');
  assert.equal(outcomes[0]?.ok, false);
  assert.ok(lines.includes('红包派对登录失败: 换 SSO 票没成（querySpecTokenV2 失败：code=9999 message=凭据不认了）'), lines.join('\n'));
  assert.equal(nPath(sent, '/configTaskLoginList'), 0);

  // 没有原生凭据 ⇒ 连换票那一枪都不发（别拿空 Authorization 去撞上游）
  const bare = harness();
  bare.store.setState(STATE_AUTH, '', NOW);
  const out = runLeg(bare.deps);
  assert.ok(out.lines.some((l) => l.startsWith('红包派对登录失败: 这个号还没有原生凭据')), out.lines.join('\n'));
  assert.equal(bare.sent.length, 0, '空凭据不该拿去撞上游');
});

test('读不到任务表 ⇒ 这一趟什么都做不了，且不谎报"今天没任务"', () => {
  const { deps } = harness({ fail: ['/configTaskLoginList'] });
  const { outcomes, lines } = runLeg(deps);
  assert.equal(outcomes[outcomes.length - 1]?.ok, false);
  assert.match(outcomes[outcomes.length - 1]?.note ?? '', /没读到任务表/);
  assert.equal(lines.length, 0, '余额那句都不该打');
});

test('一次调用只走一段：中途停住的状态，下一趟接着走完（不重发写）', () => {
  const { deps, sent, store } = harness({ flipOnComplete: ['MONTHLY_4'] });
  // 走五步就"没预算了"（面板一次调用只有这么点时间，`drain` 之外也会被打断）
  for (let i = 0; i < 5; i += 1) redpackStep(deps);
  const mid = loadRedpackState(store, redpackDay(NOW));
  assert.notEqual(mid?.phase, 'done', '五步之内不该已经收尾');
  assert.equal(mid?.token, 'RP-TOKEN-1', '这一趟还没收尾 ⇒ 票要留着');

  const rest = runLeg(deps);
  assert.ok(rest.lines.some((l) => l === '已完成: 打开云手机消息通知'), rest.lines.join('\n'));
  assert.equal(nPath(sent, '/userCompleteTask'), 3, '被打断的趟里每条也只登记一次');
});

test('时间/步数上限由上层给：这一族的预算不能超过 App 任务那一档', () => {
  assert.deepEqual(REDPACK_BUDGET, { maxSteps: 90, deadlineMs: 60_000 });
});
