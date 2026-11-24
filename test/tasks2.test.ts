// 最后四条任务：sign（三段式）/ receive（逐条队列）/ multiple（门槛）/ revival（不可逆 + 已领取）。
//
// 这里最有价值的断言都是**负向**的：
//   · multiple 门槛不成立时**一个请求都不发**（每月一次的机会，发错就是白白消耗）
//   · revival 晚太久时**一个请求都不发**（不可逆）
//   · sign 在"提交了但状态没变"时必须**如实报失败**（不能自己安慰自己说成功了）
//   · sign 的成功判据是**回查** infoV3，不是 startSignIn 的响应

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SIGN_MAX_SUBMITS, STATE_SIGN_DONE, STATE_STAGE, runSign } from '../src/mcloud/tasks/sign.ts';
import { STATE_QUEUE, readAcceptDate, receiveV3Body, runReceive } from '../src/mcloud/tasks/receive.ts';
import { STATE_MULTIPLE_DONE, runMultiple } from '../src/mcloud/tasks/multiple.ts';
import {
  REVIVAL_SKIP_AFTER_MS,
  STATE_REVIVAL_DONE,
  revivalMessageAlreadyClaimed,
  runRevival,
} from '../src/mcloud/tasks/revival.ts';
import { parseInfoV3 } from '../src/mcloud/tasks/info.ts';
import { localDay } from '../src/mcloud/tasks/base.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T08:05:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'J', deviceId: 'dev-1', savedAt: NOW };

function seeded() {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  return store;
}

/** 今天的**本地**日号（`NOW` 是 UTC 串，按本地时区取日号 —— 与 `localDay` 同口径） */
const TODAY_DOM = new Date(NOW).getDate();

interface InfoOpts {
  /** 顶层 `todaySignIn` */
  signed?: boolean;
  /** 日历当天格（**真凭据**）。缺省跟 `signed` 一致；给 `'missing'` = 日历里没有今天那一格 */
  calSigned?: boolean | 'missing';
  receiveList?: unknown[];
  backup?: boolean;
  used?: boolean;
}
function infoOk(o: InfoOpts = {}): string {
  const top = o.signed ?? false;
  const calToday = o.calSigned === 'missing' ? undefined : (o.calSigned ?? top);
  const cal: unknown[] = [];
  if (calToday !== undefined) cal.push({ d: TODAY_DOM, s: calToday, n: 3, p: 0, t: true, currentMonth: 1 });
  // 干扰项一：**下个月的同一天**（`currentMonth:0`）而且说"签了" —— 只按 `d` 认就会认错
  cal.push({ d: TODAY_DOM, s: true, n: 3, p: 0, t: false, currentMonth: 0 });
  // 干扰项二：本月别的日子
  cal.push({ d: 19, s: false, n: 0, p: 0, t: false, currentMonth: 1 });
  return JSON.stringify({
    code: 0,
    msg: 'success',
    result: {
      todaySignIn: top,
      cal,
      receiveList: o.receiveList ?? [],
      curMonthBackup: o.backup ?? false,
      curMonthBackupSignAccept: o.used ?? false,
    },
  });
}

/** 按「请求路径 → 响应」分发的桩，并记录发出去的请求。 */
function router(table: Array<[RegExp, () => string]>): {
  transport: Transport;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    transport: async (req) => {
      sent.push(req.url);
      for (const [re, body] of table) {
        if (re.test(req.url)) return { status: 200, headers: {}, body: body() };
      }
      return { status: 404, headers: {}, body: 'mock 没这个路径' };
    },
  };
}

test('parseInfoV3：形状来自夹具，认不出来时给保守值', async () => {
  const i = parseInfoV3({
    todaySignIn: true,
    receiveList: [{ recordId: 'r1', cloudType: 2 }, { cloudType: 1 }],
    curMonthBackup: true,
    curMonthBackupSignAccept: false,
  });
  assert.equal(i.todaySigned, true);
  assert.equal(i.receiveList.length, 2);
  assert.equal(i.receiveList[0]!.recordId, 'r1');
  // 夹具注释里记着「那条账号的 receiveList 只有 {cloudType:2}」—— recordId 可能没有
  assert.equal(i.receiveList[1]!.recordId, '');
  assert.equal(i.receiveList[1]!.cloudType, 1);

  // 认不出来 → 保守：没签、没机会（宁可不做动作，也不要抢跑）
  const empty = parseInfoV3(undefined);
  assert.equal(empty.todaySigned, false);
  assert.equal(empty.curMonthBackup, false);
  assert.deepEqual(empty.receiveList, []);

  // 下划线写法也认
  const snake = parseInfoV3({ today_sign_in: true, receive_list: [], cur_month_backup: true });
  assert.equal(snake.todaySigned, true);
  assert.equal(snake.curMonthBackup, true);
});

test('sign：一趟走完 ①读 ②提交 ③回查（判据是**日历当天格**）', async () => {
  let signed = false;
  const store = seeded();
  const r = router([
    [/infoV3/, () => infoOk({ signed, calSigned: signed })],
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: false } })],
  ]);
  // 让 startSignIn 真正"入账"（响应里**不给**判据），模拟上游延迟后生效
  const transport: Transport = async (req) => {
    const out = r.transport(req);
    if (/startSignIn/.test(req.url)) signed = true;
    return out;
  };

  // 一趟里就走完：读（没签）→ 提交 → 回查（日历说签了）
  const s1 = await runSign({ store, transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(s1.ok, true);
  assert.match(s1.note, /签到成功/);
  assert.equal(store.getState(STATE_STAGE) ?? '', '', '确认之后不该留待回查');
  assert.match(store.getState(STATE_SIGN_DONE) ?? '', /"by":"cal"/, '只认日历确认过的记录');

  // 第二趟：今天已签（日历确认过）⇒ 一个请求都不发
  r.sent.length = 0;
  const s2 = await runSign({ store, transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(s2.idle, true);
  assert.match(s2.note, /网盘今日已签到/);
  assert.equal(r.sent.length, 0, '今天已签就不该再问一次');
});

test('sign：一次执行里提交多次都没确认 ⇒ 报 pending；下次执行是全新的，不被旧记录挡住', async () => {
  const store = seeded();
  const r = router([
    [/infoV3/, () => infoOk({ signed: false })], // 一直说没签
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
  ]);
  const s1 = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(s1.ok, true, '动作做过了，不是失败');
  assert.equal(s1.pending, true, '要标「服务端还没认」');
  assert.match(s1.note, /再试/);
  assert.equal(
    r.sent.filter((u) => /startSignIn/.test(u)).length,
    SIGN_MAX_SUBMITS,
    `同一趟里最多提交 ${SIGN_MAX_SUBMITS} 次`,
  );
  assert.match(store.getState(STATE_STAGE) ?? '', /"last":"pending"/, '诊断记录：提交了几次');

  // 第二趟（不管是定时的还是手动）：从头再来一次，不被上一趟的记录挡住
  r.sent.length = 0;
  const s2 = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(s2.pending, true);
  assert.ok(r.sent.some((u) => /infoV3/.test(u)), '要重新读状态，不接着上一趟的进度走');
  assert.equal(
    r.sent.filter((u) => /startSignIn/.test(u)).length,
    SIGN_MAX_SUBMITS,
    '旧记录不该限制这次的提交次数',
  );
});

test('⚠ 回归 2026-11-24：提交之后必须回查，不许"发出去就算成功"', async () => {
  const store = seeded();
  const seen: string[] = [];
  const r = router([
    [/infoV3/, () => infoOk({ signed: false })],
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
  ]);
  const transport: Transport = async (req) => {
    seen.push(req.url);
    return r.transport(req);
  };
  const out = await runSign({ store, transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  const reads = seen.filter((u) => /infoV3/.test(u)).length;
  const writes = seen.filter((u) => /startSignIn/.test(u)).length;
  assert.equal(writes, SIGN_MAX_SUBMITS, `提交了 ${SIGN_MAX_SUBMITS} 次`);
  assert.equal(reads, writes + 1, '每提交一次都要再确认一次（读状态那一次另算）');
  assert.equal(out.pending, true, '没确认就不许报"好了"');
  assert.equal(store.getState(STATE_SIGN_DONE) ?? '', '', '没确认不写"今天已签"');
});

test('本地"今天已签"是缓存：旧形状 / 隔天 / 非日历确认的，一律不当数', async () => {
  const localToday = localDay(NOW);
  const cases: Array<[string, string, boolean]> = [
    ['旧形状（裸日期串）', localToday, false],
    ['隔天的记录', JSON.stringify({ day: '2000-01-01', at: '2000-01-01T03:00:00.000Z', by: 'cal' }), false],
    ['今天、但不是日历确认的', JSON.stringify({ day: localToday, at: NOW, by: 'response' }), false],
    ['今天 + 日历确认', JSON.stringify({ day: localToday, at: NOW, by: 'cal' }), true],
  ];
  for (const [label, raw, shouldIdle] of cases) {
    const store = seeded();
    store.setState(STATE_SIGN_DONE, raw, NOW);
    const r = router([
      [/infoV3/, () => infoOk({ signed: false })],
      [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
    ]);
    const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
    assert.equal(out.idle === true, shouldIdle, `${label}：idle 应当是 ${shouldIdle}`);
    assert.equal(r.sent.length > 0, !shouldIdle, `${label}：不该跳过的时候要真去问/提交`);
  }
});

test('⚠ 确认那一步没回话 ⇒ 不许说成功、也不许报云朵（只报「等服务端确认」）', async () => {
  const store = seeded();
  let reads = 0;
  const { transport } = router([
    [/infoV3/, () => { reads += 1; return reads === 1 ? infoOk({ signed: false }) : 'boom'; }],
    [
      /startSignIn/,
      () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: true, signInPoints: 3 } }),
    ],
  ]);
  const out = await runSign({ store, transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, true, '动作做过了，不是失败');
  assert.equal(out.pending, true, '要标「等服务端确认」');
  assert.doesNotMatch(out.note, /成功/, '没回话就不许说成功');
  assert.doesNotMatch(out.note, /云朵/, '也不许把提交响应里的云朵数报出去');
  assert.equal(store.getState(STATE_SIGN_DONE) ?? '', '', '更不许写「今天已签」');
});

test('⚠ 顶层字段说签了、日历说没签 ⇒ 仍去提交（优先成功，别拦）', async () => {
  const store = seeded();
  const r = router([
    [/infoV3/, () => infoOk({ signed: true, calSigned: false })],
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: false } })],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(
    r.sent.filter((u) => /startSignIn/.test(u)).length,
    SIGN_MAX_SUBMITS,
    '必须真去提交（日历一直说没签，两次都该发出去）',
  );
  assert.notEqual(out.idle, true, '不许拿残留的顶层字段当"今天已签"');
});

test('✅ 上次留下的 stage 记录（新旧形状）都不参与判断：这次照样读、照样打', async () => {
  for (const legacy of ['need-verify', JSON.stringify({ stage: 'need-verify', day: '2000-01-01', at: '2000-01-01T00:00:00.000Z', tries: 2 })]) {
    const store = seeded();
    store.setState(STATE_STAGE, legacy, NOW);
    const r = router([
      [/infoV3/, () => infoOk({ signed: false })],
      [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
    ]);
    await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
    assert.equal(
      r.sent.filter((u) => /startSignIn/.test(u)).length,
      SIGN_MAX_SUBMITS,
      `${legacy.slice(0, 24)}…：那是诊断记录，不该挡住这次的提交`,
    );
  }
});

test('parseInfoV3：日历当天格优先，跨月同名日号不算今天，读不到时不冒充"没签"', () => {
  const cal = [
    { d: 13, s: true, currentMonth: 1 },
    { d: 13, s: true, currentMonth: 0 }, // 同一个日号，别的月
    { d: 14, s: false, currentMonth: 1 },
  ];
  const a = parseInfoV3({ todaySignIn: false, cal }, 13);
  assert.equal(a.calTodaySigned, true);
  assert.equal(a.todaySigned, true);
  const b = parseInfoV3({ todaySignIn: true, cal }, 14);
  assert.equal(b.calTodaySigned, false);
  assert.equal(b.todaySigned, false, '日历有今天格时，顶层字段压不过它');
  const c = parseInfoV3({ todaySignIn: true, cal: [] }, 13);
  assert.equal(c.calTodaySigned, undefined, '读不到就是 undefined，不能冒充"没签"');
  assert.equal(c.todaySigned, true, '没有今天格才退回顶层');
});
test('multiple：门槛不成立时一个请求都不发', async () => {
  // 本月没有机会
  const a = seeded();
  const ra = router([[/infoV3/, () => infoOk({ backup: false, used: false })]]);
  const oa = await runMultiple({ store: a, transport: ra.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(oa.ok, true);
  assert.equal(oa.skipped, true);
  assert.equal(ra.sent.length, 1, '只该有一次只读检查，绝不该打 multiple');
  assert.doesNotMatch(ra.sent[0]!, /page\/multiple/);

  // 机会用过了
  const b = seeded();
  const rb = router([[/infoV3/, () => infoOk({ backup: true, used: true })]]);
  const ob = await runMultiple({ store: b, transport: rb.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(ob.skipped, true);
  assert.equal(rb.sent.filter((u) => /page\/multiple/.test(u)).length, 0, '已用过就不该再发');
  assert.equal(b.getState(STATE_MULTIPLE_DONE), NOW.slice(0, 7), '记下这个月已翻倍');
  // 记下之后，同一月后面几趟连 infoV3 都不该再问
  const rbBefore = rb.sent.length;
  const ob2 = await runMultiple({ store: b, transport: rb.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(ob2.skipped, true);
  assert.equal(rb.sent.length, rbBefore, '整月不再发请求');

  // 有机会且没用过 → 发
  const c = seeded();
  const rc = router([
    [/infoV3/, () => infoOk({ backup: true, used: false })],
    [/page\/multiple/, () => JSON.stringify({ code: 0, msg: 'success', result: { multiple: 2 } })],
  ]);
  const oc = await runMultiple({ store: c, transport: rc.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(oc.ok, true);
  assert.match(oc.note, /已领取翻倍/);
  assert.equal(rc.sent.filter((u) => /page\/multiple/.test(u)).length, 1);
});

test('revival：不可逆 —— 晚太久不发；「已领取」算完成不算失败', async () => {
  // 文案判定（逐字复刻原实现的两个条件）
  assert.equal(revivalMessageAlreadyClaimed('复活卡已领取'), true);
  assert.equal(revivalMessageAlreadyClaimed('已领过回馈卡'), true);
  assert.equal(revivalMessageAlreadyClaimed('奖励已领取'), true);
  assert.equal(revivalMessageAlreadyClaimed('已领取'), false, '光有「已领取」不够');
  assert.equal(revivalMessageAlreadyClaimed('复活卡明天可领'), false);

  // 晚太久 → 跳过，且**一个请求都不发**（不可逆动作的安全边界）
  const late = seeded();
  let n = 0;
  const outLate = await runRevival({
    store: late,
    transport: async () => {
      n += 1;
      return { status: 200, headers: {}, body: '{}' };
    },
    nowIso: NOW,
    lateMs: REVIVAL_SKIP_AFTER_MS + 1,
  });
  assert.equal(outLate.ok, true);
  assert.equal(outLate.skipped, true);
  assert.equal(n, 0, '跳过了就不该发请求');

  // 上游回「已领取复活卡」→ 算完成
  const done = seeded();
  let doneCalls = 0;
  const doneTransport: Transport = async () => {
    doneCalls += 1;
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 4001, msg: '复活卡已领取' }),
    };
  };
  const outDone = await runRevival({ store: done, transport: doneTransport, nowIso: NOW, lateMs: 0 });
  assert.equal(outDone.ok, true, '「已领取」是完成，不是失败');
  // 文案换了：不写 `okWhenError` 这种代码里的名字，也不糊 `code=… msg=…`
  assert.match(outDone.note, /已经做过了/);
  assert.ok(!/okWhenError/.test(outDone.note), '不许把代码里的名字给用户看');
  assert.equal(done.getState('mcloud.last_error.revival'), '', '不该留下失败记录');
  assert.equal(done.getState(STATE_REVIVAL_DONE), NOW.slice(0, 7), '记下这个月已领过');

  // 记下之后，同一月后面几趟一个请求都不发
  const outDone2 = await runRevival({ store: done, transport: doneTransport, nowIso: NOW, lateMs: 0 });
  assert.equal(outDone2.skipped, true);
  assert.equal(doneCalls, 1, '整月不再发请求');

  // 「上一年无云朵记录」= 没得领，不是失败；但本月记下，别再每趟问
  const noRecord = seeded();
  let noRecordCalls = 0;
  const noRecordTransport: Transport = async () => {
    noRecordCalls += 1;
    return { status: 200, headers: {}, body: JSON.stringify({ code: 500, msg: '2025年无云朵记录' }) };
  };
  const outNoRecord = await runRevival({ store: noRecord, transport: noRecordTransport, nowIso: NOW, lateMs: 0 });
  assert.equal(outNoRecord.ok, true, '没记录不是失败');
  assert.equal(outNoRecord.skipped, true);
  assert.match(outNoRecord.note, /没有可复活的记录/);
  assert.doesNotMatch(outNoRecord.note, /没成/);
  assert.equal(noRecord.getState('mcloud.last_error.revival'), '', '不该留下失败标记');
  assert.equal(noRecord.getState(STATE_REVIVAL_DONE), NOW.slice(0, 7), '本月记下，不再问');
  const outNoRecord2 = await runRevival({ store: noRecord, transport: noRecordTransport, nowIso: NOW, lateMs: 0 });
  assert.equal(outNoRecord2.skipped, true);
  assert.equal(noRecordCalls, 1, '当前月不再发请求');

  // 其它错误仍算失败
  const bad = seeded();
  const outBad = await runRevival({
    store: bad,
    transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ code: 500, msg: '系统繁忙' }) }),
    nowIso: NOW,
    lateMs: 0,
  });
  assert.equal(outBad.ok, false);
});

test('receive：清单入队 → 逐条领（一次一条，两种 cloudType 各走对端点）', async () => {
  // ⚠ 第一条必须是 `cloudType: 0`（当前可领）。这里原来写的是 `2`，而 `2` 是
  //   **下月可领** —— H5 对它一个请求都不发（参考实现 `mcloud` 的 `signin.rs`）。
  //   旧代码把 `2` 也送去 `receiveV3`，于是每天发一枪注定 `receive: 0` 的请求，
  //   再把清单上的 `cloudNum` 说成"领到了"（用户 2026-10-19 报的 bug）。
  let list: unknown[] = [{ recordId: 'r1', cloudType: 0 }, { recordId: 'r2', cloudType: 1 }];
  const received: string[] = [];
  const expansionCalled: string[] = [];
  const store = seeded();
  const transport: Transport = async (req) => {
    if (/infoV3/.test(req.url)) return { status: 200, headers: {}, body: infoOk({ receiveList: list }) };
    if (/receiveTaskExpansion/.test(req.url)) {
      expansionCalled.push(req.url);
      list = list.filter((x) => (x as { cloudType?: number }).cloudType !== 1);
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: {} }) };
    }
    if (/receiveV3/.test(req.url)) {
      const b = JSON.parse(req.body ?? '{}') as { cloudId?: string };
      received.push(b.cloudId ?? '');
      list = list.filter((x) => (x as { recordId?: string }).recordId !== b.cloudId);
      // 数量**只在响应里**（`result.receive`）—— 不再从清单那一条猜
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, msg: 'success', result: { receive: 7, total: 9000 } }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };

  // ① 队列空 → 只是去问清单，入队（不领）
  const r1 = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r1.ok, true);
  assert.match(r1.note, /待领取 2 个/);
  assert.equal(received.length, 0, '入队这一步不该领任何东西');
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 2);

  // ② 领第一条
  const r2 = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r2.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0], 'r1');
  assert.match(r2.note, /领到 7 个云朵/, '数量必须是响应里的 7，不是清单里编的');

  // ③ 第二条是延期领取 → 走另一口端点（不是跳过）
  const r3 = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r3.ok, true);
  assert.match(r3.note, /延期领取已完成/);
  assert.equal(received.length, 1, '延期那条不该走 receiveV3');
  assert.equal(expansionCalled.length, 1, '延期那条应当走 receiveTaskExpansion');
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 0, '队列要清空');

  // ④ 队列空 + 上游清单也空 → 收工
  list = [];
  const r4 = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r4.ok, true);
  assert.match(r4.note, /无待领取的云朵/);
});

test('receive：队头的「下月可领」不许挡住后面今天可领的', async () => {
  const store = seeded();
  store.setState(
    STATE_QUEUE,
    JSON.stringify([
      { recordId: 'next', cloudType: 2, raw: { cloudType: 2, cloudNum: 164 } },
      { recordId: 'now', cloudType: 0, raw: { cloudType: 0, cloudNum: 6 } },
    ]),
    NOW,
  );
  const received: string[] = [];
  const transport: Transport = async (req) => {
    if (/receiveV3/.test(req.url)) {
      const b = JSON.parse(req.body ?? '{}') as { cloudId?: string };
      received.push(b.cloudId ?? '');
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, msg: 'success', result: { receive: 6, total: 9000 } }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const out = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, undefined, '不能因为队头是下月就停掉');
  assert.deepEqual(received, ['now'], '要跨过下月那条，领到今天可领的');
  assert.match(out.note, /领到 6 个云朵/);
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 0);
});

test('延期领取：裸 GET（绝不发出 ?acceptDate=），且 dig 掉队列里那一条', async () => {
  // `acceptDate` 有才带 —— 真实清单里没有这个字段，所以缺省路径是"裸 GET"。
  // 写成空串会发出 `?acceptDate=`，那是另一个请求（原实现专门警告过）。
  assert.equal(readAcceptDate({ cloudType: 1 }), undefined);
  assert.equal(readAcceptDate({ acceptDate: '   ' }), undefined);
  assert.equal(readAcceptDate({ acceptDate: '2026-10-13' }), '2026-10-13');
  assert.equal(readAcceptDate({ accept_date: '2026-10-13' }), '2026-10-13');
  assert.equal(readAcceptDate(null), undefined);

  let list: unknown[] = [{ recordId: 'r2', cloudType: 1 }];
  const store = seeded();
  const sent: string[] = [];
  const transport: Transport = async (req) => {
    sent.push(req.url);
    if (/infoV3/.test(req.url)) return { status: 200, headers: {}, body: infoOk({ receiveList: list }) };
    if (/receiveTaskExpansion/.test(req.url)) {
      list = [];
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: {} }) };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });      // 入队
  const out = await runReceive({ store, transport, nowIso: NOW, lateMs: 0 });  // 领（延期那一口）
  assert.equal(out.ok, true);
  assert.match(out.note, /延期领取已完成/);
  const call = sent.find((u) => /receiveTaskExpansion/.test(u))!;
  assert.ok(call, '应当调用 receiveTaskExpansion');
  assert.equal(
    call,
    'https://m.mcloud.139.com/ycloud/signin/page/receiveTaskExpansion',
    '必须是没有查询串的裸 GET',
  );
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 0, '队列要清掉');
});

test('receiveV3 的请求体：cloudType 缺省是**空串**而不是 0', async () => {
  // 上游 H5 写的是 `e.cloudType ?? ""` —— 0 是合法取值（当前可领取），
  // 缺省给 0 会被当成"要的是第 0 类"
  assert.equal(
    receiveV3Body('cid', undefined, 'dev'),
    '{"client":"app","cloudId":"cid","cloudType":"","deviceId":"dev"}',
  );
  assert.equal(
    receiveV3Body('cid', 0, 'dev'),
    '{"client":"app","cloudId":"cid","cloudType":0,"deviceId":"dev"}',
  );
});

test('⚠ 提交响应说已签、日历还没跟上：报「服务端还没认」，不报失败、也不写「今天已签」', async () => {
  // 2026-10-17：响应说已签、infoV3 还 false —— 只认 infoV3 会每趟报失败。
  const store = seeded();
  const { transport } = router([
    [/infoV3/, () => infoOk({ signed: false })],
    [
      /startSignIn/,
      () =>
        JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: true, signInPoints: 3, signCount: 17 } }),
    ],
  ]);
  const out = await runSign({ store, transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, true, '响应说签上了就别报失败（2026-10-17 的教训：每趟报失败）');
  assert.equal(out.pending, true, '但日历没认 ⇒ 标「服务端还没认」');
  assert.match(out.note, /服务端都没确认/);
  assert.equal(store.getState(STATE_SIGN_DONE) ?? '', '', '弱证据不写「今天已签」');
});
