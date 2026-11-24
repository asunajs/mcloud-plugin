// 最后四条任务：sign（三段式）/ receive（逐条队列）/ multiple（门槛）/ revival（不可逆 + 已领取）。
//
// 这里最有价值的断言都是**负向**的：
//   · multiple 门槛不成立时**一个请求都不发**（每月一次的机会，发错就是白白消耗）
//   · revival 晚太久时**一个请求都不发**（不可逆）
//   · sign 在"提交了但状态没变"时必须**如实报失败**（不能自己安慰自己说成功了）
//   · sign 的成功判据是**回查** infoV3，不是 startSignIn 的响应

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSign } from '../src/mcloud/tasks/sign.ts';
import { STATE_QUEUE, readAcceptDate, receiveV3Body, runReceive } from '../src/mcloud/tasks/receive.ts';
import { STATE_MULTIPLE_DONE, runMultiple } from '../src/mcloud/tasks/multiple.ts';
import {
  REVIVAL_SKIP_AFTER_MS,
  STATE_REVIVAL_DONE,
  revivalMessageAlreadyClaimed,
  runRevival,
} from '../src/mcloud/tasks/revival.ts';
import { parseInfoV3 } from '../src/mcloud/tasks/info.ts';
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

interface InfoOpts {
  /** 顶层 `todaySignIn` */
  signed?: boolean;
  /** 日历今天那格签没签；`'missing'` = 日历里没有今天那一格 */
  calSigned?: boolean | 'missing';
  /** 今天那格的云朵数（`n`） */
  clouds?: number;
  receiveList?: unknown[];
  backup?: boolean;
  used?: boolean;
}
function infoOk(o: InfoOpts = {}): string {
  const top = o.signed ?? false;
  const calToday = o.calSigned === 'missing' ? undefined : (o.calSigned ?? top);
  const cal: unknown[] = [];
  // 今天那一格：上游用 `currentMonth` 标本月、`t` 标今天
  if (calToday !== undefined) cal.push({ d: 13, s: calToday, n: o.clouds ?? 3, p: 0, t: true, currentMonth: 1 });
  // 干扰一：别的月里的"今天"（`currentMonth:0` + `t:true`）—— 不认 currentMonth 就会认错
  cal.push({ d: 13, s: true, n: 3, p: 0, t: true, currentMonth: 0 });
  // 干扰二：本月别的日子（`t:false`）
  cal.push({ d: 14, s: false, n: 0, p: 0, t: false, currentMonth: 1 });
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

test('sign：每次执行都提交，判据是日历「今天」那一格（currentMonth + t）', async () => {
  const store = seeded();
  const r = router([
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: false } })],
    [/infoV3/, () => infoOk({ signed: false, calSigned: true, clouds: 3 })],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, true);
  assert.match(out.note, /网盘签到成功，\+3 云朵/);
  assert.equal(r.sent.filter((u) => /startSignIn/.test(u)).length, 1, '一次执行提交一次');

  // 第二次执行：**照样提交**（没有"今天已签就跳过"的本地记录）
  r.sent.length = 0;
  const again = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(again.ok, true);
  assert.equal(r.sent.filter((u) => /startSignIn/.test(u)).length, 1, '签到幂等，每次都提交');
});

test('sign：提交响应说已签 ⇒ 直接成功，不再等状态', async () => {
  const store = seeded();
  const r = router([
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: true, signInPoints: 5 } })],
    [/infoV3/, () => infoOk({ signed: false })],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, true);
  assert.match(out.note, /网盘签到成功，\+5 云朵/);
  assert.equal(r.sent.filter((u) => /infoV3/.test(u)).length, 0, '响应已经说了，不用再问一次');
});

test('sign：日历今天那格没签 ⇒ 报失败（不粉饰、不报云朵）', async () => {
  const store = seeded();
  const r = router([
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
    [/infoV3/, () => infoOk({ signed: false, calSigned: false })],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, false);
  assert.match(out.note, /网盘签到失败/);
  assert.doesNotMatch(out.note, /云朵/);
});

test('sign：日历里没有今天那一格 ⇒ 也算没成（原因说清）', async () => {
  const store = seeded();
  const r = router([
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
    [/infoV3/, () => infoOk({ calSigned: 'missing' })],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, false);
  assert.match(out.note, /没有今天那一格/);
});

test('sign：看状态没回话 ⇒ 报「没确认上」，不说成功', async () => {
  const store = seeded();
  const r = router([
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { todaySignIn: false } })],
    [/infoV3/, () => 'boom'],
  ]);
  const out = await runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0, settleMs: 0 });
  assert.equal(out.ok, false);
  assert.match(out.note, /没确认上/);
  assert.doesNotMatch(out.note, /成功/);
});

test('parseInfoV3：今天那一格靠 `currentMonth` + `t` 认，读不到就是 undefined', () => {
  const cal = [
    { d: 13, s: true, n: 3, p: 2, t: true, currentMonth: 1 }, // 今天
    { d: 13, s: true, n: 3, p: 0, t: true, currentMonth: 0 }, // 别的月里的同一天
    { d: 14, s: false, n: 0, p: 0, t: false, currentMonth: 1 },
  ];
  const a = parseInfoV3({ todaySignIn: false, cal });
  assert.deepEqual(a.calToday, { d: 13, s: true, clouds: 5 });
  assert.equal(a.todaySigned, true);

  const b = parseInfoV3({ todaySignIn: true, cal: [{ d: 14, s: false, t: false, currentMonth: 1 }] });
  assert.equal(b.calToday, undefined, '没有今天那一格就是 undefined');
  assert.equal(b.todaySigned, true, '读不到才退回顶层字段');
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
