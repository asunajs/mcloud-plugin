// 最后四条任务：sign（三段式）/ receive（逐条队列）/ multiple（门槛）/ revival（不可逆 + 已领取）。
//
// 这里最有价值的断言都是**负向**的：
//   · multiple 门槛不成立时**一个请求都不发**（每月一次的机会，发错就是白白消耗）
//   · revival 晚太久时**一个请求都不发**（不可逆）
//   · sign 在"提交了但状态没变"时必须**如实报失败**（不能自己安慰自己说成功了）
//   · sign 的成功判据是**回查** infoV3，不是 startSignIn 的响应

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATE_STAGE, runSign } from '../src/mcloud/tasks/sign.ts';
import { STATE_QUEUE, receiveV3Body, runReceive } from '../src/mcloud/tasks/receive.ts';
import { runMultiple } from '../src/mcloud/tasks/multiple.ts';
import {
  REVIVAL_SKIP_AFTER_MS,
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
  signed?: boolean;
  receiveList?: unknown[];
  backup?: boolean;
  used?: boolean;
}
function infoOk(o: InfoOpts = {}): string {
  return JSON.stringify({
    code: 0,
    msg: 'success',
    result: {
      todaySignIn: o.signed ?? false,
      cal: [{ d: 19, s: o.signed ?? false, n: 3, p: 0, t: true, currentMonth: 1 }],
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
    transport: (req) => {
      sent.push(req.url);
      for (const [re, body] of table) {
        if (re.test(req.url)) return { status: 200, headers: {}, body: body() };
      }
      return { status: 404, headers: {}, body: 'mock 没这个路径' };
    },
  };
}

test('parseInfoV3：形状来自夹具，认不出来时给保守值', () => {
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

test('sign：三段式（问 → 提交 → 回查），判据是 infoV3 不是动作响应', () => {
  let signed = false;
  const store = seeded();
  const r = router([
    [/infoV3/, () => infoOk({ signed })],
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: { bean: 10 } })],
  ]);
  // 让 startSignIn 真正"入账"，模拟上游延迟后生效
  const transport: Transport = (req) => {
    const out = r.transport(req);
    if (/startSignIn/.test(req.url)) signed = true;
    return out;
  };

  // ① 问：还没签
  const s1 = runSign({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(s1.ok, true);
  assert.match(s1.note, /签到已提交/);
  assert.doesNotMatch(s1.note, /签到成功/, '动作响应不是判据，别急着说成功');
  assert.equal(store.getState(STATE_STAGE), 'need-verify');

  // ② 回查：这次已签 → 完成
  const s2 = runSign({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(s2.ok, true);
  assert.match(s2.note, /回查.*确认今日已签/);
  assert.equal(store.getState(STATE_STAGE), '', '完成了要把阶段清掉');

  // ③ 已经签过了 → 只问一次状态，不发动作
  r.sent.length = 0;
  const s3 = runSign({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(s3.ok, true);
  assert.match(s3.note, /今日已签到/);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /infoV3/);
});

test('sign：提交了但状态没变 → 如实报失败（不能自我安慰）', () => {
  const store = seeded();
  const r = router([
    [/infoV3/, () => infoOk({ signed: false })],   // 一直说没签
    [/startSignIn/, () => JSON.stringify({ code: 0, msg: 'success', result: {} })],
  ]);
  runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });          // 提交
  const back = runSign({ store, transport: r.transport, nowIso: NOW, lateMs: 0 }); // 回查
  assert.equal(back.ok, false);
  assert.match(back.note, /仍未签/);
});

test('multiple：门槛不成立时一个请求都不发', () => {
  // 本月没有机会
  const a = seeded();
  const ra = router([[/infoV3/, () => infoOk({ backup: false, used: false })]]);
  const oa = runMultiple({ store: a, transport: ra.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(oa.ok, true);
  assert.equal(oa.skipped, true);
  assert.equal(ra.sent.length, 1, '只该有一次只读检查，绝不该打 multiple');
  assert.doesNotMatch(ra.sent[0]!, /page\/multiple/);

  // 机会用过了
  const b = seeded();
  const rb = router([[/infoV3/, () => infoOk({ backup: true, used: true })]]);
  const ob = runMultiple({ store: b, transport: rb.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(ob.skipped, true);
  assert.equal(rb.sent.filter((u) => /page\/multiple/.test(u)).length, 0, '已用过就不该再发');

  // 有机会且没用过 → 发
  const c = seeded();
  const rc = router([
    [/infoV3/, () => infoOk({ backup: true, used: false })],
    [/page\/multiple/, () => JSON.stringify({ code: 0, msg: 'success', result: { multiple: 2 } })],
  ]);
  const oc = runMultiple({ store: c, transport: rc.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(oc.ok, true);
  assert.match(oc.note, /已领取翻倍/);
  assert.equal(rc.sent.filter((u) => /page\/multiple/.test(u)).length, 1);
});

test('revival：不可逆 —— 晚太久不发；「已领取」算完成不算失败', () => {
  // 文案判定（逐字复刻原实现的两个条件）
  assert.equal(revivalMessageAlreadyClaimed('复活卡已领取'), true);
  assert.equal(revivalMessageAlreadyClaimed('已领过回馈卡'), true);
  assert.equal(revivalMessageAlreadyClaimed('奖励已领取'), true);
  assert.equal(revivalMessageAlreadyClaimed('已领取'), false, '光有「已领取」不够');
  assert.equal(revivalMessageAlreadyClaimed('复活卡明天可领'), false);

  // 晚太久 → 跳过，且**一个请求都不发**（不可逆动作的安全边界）
  const late = seeded();
  let n = 0;
  const outLate = runRevival({
    store: late,
    transport: () => {
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
  const outDone = runRevival({
    store: done,
    transport: () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 4001, msg: '复活卡已领取' }),
    }),
    nowIso: NOW,
    lateMs: 0,
  });
  assert.equal(outDone.ok, true, '「已领取」是完成，不是失败');
  assert.match(outDone.note, /已经完成/);
  assert.equal(done.getState('mcloud.last_error.revival'), '', '不该留下失败记录');

  // 其它错误仍算失败
  const bad = seeded();
  const outBad = runRevival({
    store: bad,
    transport: () => ({ status: 200, headers: {}, body: JSON.stringify({ code: 500, msg: '系统繁忙' }) }),
    nowIso: NOW,
    lateMs: 0,
  });
  assert.equal(outBad.ok, false);
});

test('receive：清单入队 → 逐条领（一次一条）→ cloudType=1 跳过', () => {
  let list: unknown[] = [{ recordId: 'r1', cloudType: 2 }, { recordId: 'r2', cloudType: 1 }];
  const received: string[] = [];
  const store = seeded();
  const transport: Transport = (req) => {
    if (/infoV3/.test(req.url)) return { status: 200, headers: {}, body: infoOk({ receiveList: list }) };
    if (/receiveV3/.test(req.url)) {
      const b = JSON.parse(req.body ?? '{}') as { cloudId?: string };
      received.push(b.cloudId ?? '');
      list = list.filter((x) => (x as { recordId?: string }).recordId !== b.cloudId);
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: {} }) };
    }
    return { status: 404, headers: {}, body: '{}' };
  };

  // ① 队列空 → 只是去问清单，入队（不领）
  const r1 = runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r1.ok, true);
  assert.match(r1.note, /已入队/);
  assert.equal(received.length, 0, '入队这一步不该领任何东西');
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 2);

  // ② 领第一条
  const r2 = runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r2.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0], 'r1');
  assert.match(r2.note, /还剩 1 条/);

  // ③ 第二条是延期领取 → 跳过（并说明），不卡在队列里
  const r3 = runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r3.ok, true);
  assert.equal(r3.skipped, true);
  assert.match(r3.note, /延期领取/);
  assert.equal(received.length, 1, '延期那条不该走 receiveV3');
  assert.equal(JSON.parse(store.getState(STATE_QUEUE)!).length, 0, '队列要清空');

  // ④ 队列空 + 上游清单也空 → 收工
  list = [];
  const r4 = runReceive({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(r4.ok, true);
  assert.match(r4.note, /没有待领取/);
});

test('receiveV3 的请求体：cloudType 缺省是**空串**而不是 0', () => {
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
