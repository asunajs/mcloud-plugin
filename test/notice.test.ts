// 通知任务（`notice`）—— 两个槽的读数、判据的"缺字段"语义、以及两步推进。
//
// 这里最值钱的断言是**负向**的，而且都是照 mcloud 源码的教训写的：
//   · 判据字段缺任何一个 ⇒ **不参与判断**（不是"不满足"）—— 把"上游没说"当成
//     "说了没完成"会让这条链**静默漏领**，所以要断言"缺字段时报告 unjudged"
//   · 上次说不能领 ⇒ **一个写请求都不发**（`reward` 会真入账）
//   · "通知未开启"那一档判不出来 ⇒ `noticeNeedsManual` 恒 false，
//     把它钉住，免得日后有人以为它"能用"了

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_CAN,
  noticeNeedsManual,
  noticePlan,
  parseNoticeInfo,
  parseNoticeSlot,
  runNotice,
  slotClaimable,
  slotJudged,
} from '../src/mcloud/tasks/notice.ts';
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

/** 按路径分发的桩，并记录发出去的请求。 */
function router(table: Array<[RegExp, () => string]>): { transport: Transport; sent: string[] } {
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

const INFO_RE = /openEmailsms\/getTaskInfo/;
const REWARD_RE = /openEmailsms\/reward/;

function infoBody(one: unknown, two: unknown): string {
  return JSON.stringify({ code: 0, msg: 'success', result: { taskOneInfo: one, taskTwoInfo: two } });
}

const claimableSlot = { cloudStatus: 1, sum: 10, progress: 16, taskStatus: 3 };
const claimedSlot = { cloudStatus: 2, sum: 10, progress: 16, taskStatus: 3 };

test('解析：四个字段名来自实拍，缺字段就是缺（不填默认值）', () => {
  const info = parseNoticeInfo({ taskOneInfo: claimableSlot, taskTwoInfo: claimedSlot });
  assert.equal(info.one!.cloudStatus, 1);
  assert.equal(info.one!.taskStatus, 3);
  assert.equal(info.one!.progress, 16);
  assert.equal(info.two!.cloudStatus, 2);

  // 上游没给某个字段 → 那个字段就是 undefined（不替它填 0）
  const partial = parseNoticeSlot({ cloudStatus: 1 });
  assert.equal(partial!.cloudStatus, 1);
  assert.equal(partial!.taskStatus, undefined);

  // 完全不是对象 → 这个槽没有
  assert.equal(parseNoticeSlot(undefined), undefined);
  assert.equal(parseNoticeSlot({}), undefined);
  assert.equal(parseNoticeInfo(undefined).one, undefined);
});

test('判据：两个字段缺任何一个都**不参与判断**（不是"不满足"）', () => {
  // 齐了才判
  assert.equal(slotJudged(claimableSlot), true);
  assert.equal(slotClaimable(claimableSlot), true);
  assert.equal(slotClaimable(claimedSlot), false);

  // 缺 taskStatus：**判不了**，而不是"不该领" —— 这一条是静默漏领的来源
  const missingStatus = { cloudStatus: 1, sum: 10, progress: 16 };
  assert.equal(slotJudged(missingStatus), false, '缺字段 ⇒ 判不了');
  assert.equal(slotClaimable(missingStatus), false, '判不了 ⇒ 不发写请求');
  const plan = noticePlan({ one: missingStatus, two: claimedSlot });
  assert.equal(plan.unjudged, true, '必须把"上游没给全"报出来，不能静默当成 no');
  assert.ok(plan.detail.includes('判据字段不全'), plan.detail);
  assert.equal(plan.claimable, false);

  // 槽整个没有：也要说出来
  const p2 = noticePlan({});
  assert.ok(p2.detail.includes('上游没给'), p2.detail);
});

test('"通知未开启"那一档判不出来 —— 钉住这个声明，别让它悄悄变成"能用"', () => {
  assert.equal(noticeNeedsManual({ one: claimableSlot, two: claimedSlot }), false);
  assert.equal(noticeNeedsManual({}), false);
});

test('两步推进：先查、能领才领；领完下一轮**回查**（reward 不报到账数）', () => {
  const store = seeded();
  let claimable = true;
  const r = router([
    [INFO_RE, () => infoBody(claimable ? claimableSlot : claimedSlot, claimable ? claimableSlot : claimedSlot)],
    [REWARD_RE, () => JSON.stringify({ code: 0, msg: 'success' })],
  ]);
  const deps = { store, transport: r.transport, nowIso: NOW, lateMs: 0 };

  // 第一步：只查，**不发写请求**
  const s1 = runNotice(deps);
  assert.equal(s1.ok, true);
  assert.equal(r.sent.length, 1, `第一步只该发一个请求，实际发了 ${r.sent.length}`);
  assert.ok(INFO_RE.test(r.sent[0]!), r.sent[0]);
  assert.ok(s1.note.includes('可领'), s1.note);
  assert.equal(store.getState(STATE_CAN), 'yes');

  // 第二步：领。上游**不报到账数** —— 文案必须说清楚，否则下一个人以为这里有读数
  claimable = false;
  const s2 = runNotice(deps);
  assert.equal(s2.ok, true);
  assert.equal(r.sent.length, 2);
  assert.ok(REWARD_RE.test(r.sent[1]!), r.sent[1]);
  assert.ok(s2.note.includes('不报到账数'), s2.note);
  assert.ok(s2.note.includes('回查'), s2.note);

  // 第三步：回查（这一步才是"到底领上没"的判据）
  const s3 = runNotice(deps);
  assert.equal(r.sent.length, 3);
  assert.ok(INFO_RE.test(r.sent[2]!), r.sent[2]);
  assert.ok(s3.note.includes('已入账') || s3.note.includes('无可领'), s3.note);
});

test('上次说不能领 ⇒ 一个写请求都不发（reward 会真入账）', () => {
  const store = seeded();
  store.setState(STATE_CAN, 'no:两槽都已入账或无可领', NOW);
  const r = router([
    [INFO_RE, () => infoBody(claimedSlot, claimedSlot)],
    [REWARD_RE, () => JSON.stringify({ code: 0, msg: 'success' })],
  ]);
  const out = runNotice({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(r.sent.length, 1, '只该发查状态那一个请求');
  assert.ok(INFO_RE.test(r.sent[0]!), r.sent[0]);
});

test('上游报错时如实失败，且不改判据状态', () => {
  const store = seeded();
  store.setState(STATE_CAN, 'yes', NOW);
  const r = router([[REWARD_RE, () => JSON.stringify({ code: 40001, msg: '活动已结束' })]]);
  const out = runNotice({ store, transport: r.transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, false);
  assert.ok(String(out.note).includes('40001') || String(out.note).includes('活动已结束'), out.note);
  assert.equal(store.getState(STATE_CAN), 'yes', '失败了不能清账 —— 下一轮还要能重试');
});
