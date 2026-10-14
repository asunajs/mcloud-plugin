// 任务拓展 —— 三件事：读状态 → （严格读到 false 才）传文件触发备份 → **裸 GET** 领云朵。
//
// 三条边界是这一族真正的重点：
//   ① 严格判据：`curMonthBackup === false` 才传（`undefined` 不算 —— 否则上游一改字段
//      就会**白发一堆上传**）
//   ② 领那一枪是**裸 GET**（抓包 §3.6.6：不许写 `?acceptDate=`）
//   ③ 领的 `result` 是**裸数字**，认不出来就回显原文、**不编"领到 N 个"**

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_EXPAND,
  parseExpand,
  runExpansionStep,
  shouldUpload,
  startExpansion,
} from '../src/mcloud/tasks/taskExpansion.ts';
import { STATE_UPLOAD } from '../src/mcloud/tasks/upload.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-14T01:00:00.000Z';

function mkDeps(routes: Record<string, unknown>) {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    for (const [frag, body] of Object.entries(routes)) {
      if (req.url.includes(frag)) return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: {} }) };
  }) as never;
  return { deps: { store, transport, nowIso: NOW, baseUrl: undefined } as TaskDeps, sent, store };
}

test('⚠ 严格判据：只有**读到 false** 才去传（`undefined` 不算）', () => {
  assert.equal(shouldUpload({ curMonthBackup: false }), true);
  assert.equal(shouldUpload({ curMonthBackup: true }), false);
  assert.equal(shouldUpload({ curMonthBackup: undefined }), false, '没读到 ≠ 未开启备份');
  assert.equal(shouldUpload({}), false);
});

test('解析：字段缺就是 undefined（**不猜**）', () => {
  const r = parseExpand({ curMonthBackup: true, curMonthTaskRecordCount: 2, nextMonthTaskRecordCount: 5 });
  assert.equal(r.curMonthBackup, true);
  assert.equal(r.curMonthTaskRecordCount, 2);
  assert.equal(r.nextMonthTaskRecordCount, 5);
  assert.equal(r.acceptDate, undefined, '实拍里没有 acceptDate —— 别编一个');
  assert.deepEqual(parseExpand({}), parseExpand({}), '空对象两边一样（用 deepEqual，不是引用比较）');
  assert.equal(parseExpand(null).curMonthBackup, undefined);
});

test('起一趟**一个请求都不发**', () => {
  const { deps, sent } = mkDeps({});
  assert.equal(startExpansion(deps).ok, true);
  assert.equal(sent.length, 0);
});

test('⚠ 备份已开（`true`）⇒ **不传文件**，直接去领', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 1 } },
    receiveTaskExpansion: { code: 0, result: 100 },
  });
  startExpansion(deps);
  const r1 = runExpansionStep(deps);
  assert.equal(r1.ok, true, r1.note);
  assert.doesNotMatch(r1.note, /传一个文件/);
  assert.equal(sent.length, 1);
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'claim');
  // 第二步：领（裸 GET）
  const r2 = runExpansionStep(deps);
  assert.equal(r2.ok, true, r2.note);
  assert.match(r2.note, /100/);
  // ⚠ **必须带这个参数**：真机实测裸 GET 回 404、带 `?acceptDate=` 才 200。
  //   抓包 §3.6.6 那条"别写成 ?acceptDate="被真机推翻了（见 F-021）。
  assert.match(sent[1]!.url, /\?acceptDate=/, '参数必须在（空值也行）—— 裸 GET 会 404');
});

test('⚠ 未开启备份（`false`）⇒ 起上传；上传三枪走完后再复查', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: false, curMonthTaskRecordCount: 0 } },
    'hcy/file/create': { code: 0, data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s.example/k', rapidUpload: false } },
    'hcy/file/complete': { code: 0 },
    receiveTaskExpansion: { code: 0, result: 100 },
  });
  startExpansion(deps);
  const r1 = runExpansionStep(deps); // ① 读 → 起上传
  assert.match(r1.note, /未开启备份/);
  assert.ok(deps.store.getState(STATE_UPLOAD), '上传那台状态机被起了');
  // ② 上传三枪（一次一枪）
  const r2 = runExpansionStep(deps); // create
  assert.equal(r2.ok, true, r2.note);
  const r3 = runExpansionStep(deps); // put
  assert.equal(r3.ok, true, r3.note);
  const r4 = runExpansionStep(deps); // complete
  assert.equal(r4.ok, true, r4.note);
  // ②b 复查
  const r5 = runExpansionStep(deps);
  assert.equal(r5.ok, true, r5.note);
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'claim');
  // ③ 领
  const r6 = runExpansionStep(deps);
  assert.equal(r6.ok, true, r6.note);
  assert.equal(sent.length, 6, '读 / 建 / 传 / 确认 / 复查 / 领 —— 正好六枪，一枪不多');
});

test('⚠ **不判**：可领次数是 0 也照样发那一枪（发出去有可能成功）', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 0 } },
    receiveTaskExpansion: { code: 0, result: 100 },
  });
  startExpansion(deps);
  runExpansionStep(deps);
  const r = runExpansionStep(deps);
  assert.equal(r.ok, true, r.note);
  assert.equal(sent.filter((x) => x.url.includes('receiveTaskExpansion')).length, 1, '照发');
});

test('⚠ 领的 `result` 是**裸数字**；认不出来就回显原文，**不编份数**', () => {
  const { deps } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true } },
    receiveTaskExpansion: { code: 0, result: 100 },
  });
  startExpansion(deps);
  runExpansionStep(deps);
  const r = runExpansionStep(deps);
  assert.match(r.note, /100/);
  assert.match(r.note, /裸数字/);
  // 形状不认识时
  const { deps: d2 } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true } },
    receiveTaskExpansion: { code: 0, message: 'ok' },
  });
  startExpansion(d2);
  runExpansionStep(d2);
  const r2 = runExpansionStep(d2);
  assert.match(r2.note, /缺成功样本/, '拿不到成功样本就说明白，别假装验过');
  assert.doesNotMatch(r2.note, /领到 \d+ 个/);
});

test('失败**不推进游标**（读那一步失败就停在那）', () => {
  const { deps } = mkDeps({ taskExpansion: { code: 500 } });
  startExpansion(deps);
  const r = runExpansionStep(deps);
  assert.equal(r.ok, true, '这一族的信封里 code 不看就往下走 —— 但游标该停');
  void r;
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'claim');
});
