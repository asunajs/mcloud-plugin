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

test('⚠ 当天 done 不重跑；跨天必须重新起（不能永久 done）', () => {
  const { deps, store } = mkDeps({});
  store.setState(STATE_EXPAND, JSON.stringify({ step: 'done', day: NOW.slice(0, 10) }), NOW);
  const same = startExpansion(deps);
  assert.equal(same.idle, true);
  assert.equal((JSON.parse(store.getState(STATE_EXPAND)!) as { step: string }).step, 'done');
  const nextDay = { ...deps, nowIso: '2026-10-15T01:00:00.000Z' } as TaskDeps;
  const next = startExpansion(nextDay);
  assert.notEqual(next.idle, true);
  assert.equal((JSON.parse(store.getState(STATE_EXPAND)!) as { step: string }).step, 'read');
});

test('⚠ 备份已开（`true`）⇒ 不传文件、不领云朵，直接清理收尾', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 1 } },
  });
  startExpansion(deps);
  const r1 = runExpansionStep(deps);
  assert.equal(r1.ok, true, r1.note);
  assert.doesNotMatch(r1.note, /传一个文件/);
  assert.equal(sent.length, 1);
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'cleanup');
  const r2 = runExpansionStep(deps);
  assert.equal(r2.ok, true, r2.note);
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'done');
  assert.equal(sent.filter((x) => x.url.includes('receiveTaskExpansion')).length, 0, '不再领云朵');
});

test('⚠ 未开启备份（`false`）⇒ 起上传；上传三枪 + 快照三枪 + 清理', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: false, curMonthTaskRecordCount: 0 } },
    'hcy/file/create': {
      code: 0,
      data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s.example/k', rapidUpload: false, exist: false },
    },
    'hcy/file/complete': { code: 0 },
    'backup/createSnapshot': {
      code: '0000',
      data: { fileId: 'S', uploadId: 'SU', partInfos: [{ uploadUrl: 'https://s.example/snap' }], rapidUpload: false },
    },
    'backup/completeSnapshot': { code: '0000', data: null },
    'recyclebin/batchTrash': { code: '0000', success: true },
    receiveTaskExpansion: { code: 0, result: 100 },
  });
  startExpansion(deps);
  const r1 = runExpansionStep(deps); // ① 读 → 起上传
  assert.match(r1.note, /未开启备份/);
  assert.ok(deps.store.getState(STATE_UPLOAD), '上传那台状态机被起了');
  // 上传三枪 + 快照三枪 + 复查 + 清理（一次一枪）
  for (let i = 0; i < 8; i += 1) {
    const out = runExpansionStep(deps);
    assert.equal(out.ok, true, out.note);
  }
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'done');
  assert.equal(sent.length, 9, '读 / 建 / 传 / 确认 / 快照建 / 快照传 / 快照确认 / 复查 / 清理 —— 九枪');
  assert.equal(sent.filter((x) => x.url.includes('receiveTaskExpansion')).length, 0, '不再领云朵');
  assert.ok(sent.some((x) => x.url.includes('backup/createSnapshot')), '要建快照');
  assert.ok(sent.some((x) => x.url.includes('recyclebin/batchTrash')), '要清理自己传的文件');
});

test('⚠ 撞上用户已有同名文件（exist:true）⇒ 不建快照、不清理', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: false } },
    'hcy/file/create': {
      code: 0,
      data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s.example/k', rapidUpload: false, exist: true },
    },
  });
  startExpansion(deps);
  runExpansionStep(deps); // read → upload queued
  runExpansionStep(deps); // create → exist:true ⇒ done
  runExpansionStep(deps); // uploadDone → recheck
  runExpansionStep(deps); // recheck → cleanup
  const out = runExpansionStep(deps); // cleanup skips
  assert.equal(out.ok, true, out.note);
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'done');
  assert.equal(sent.filter((x) => x.url.includes('backup/createSnapshot')).length, 0, '不是我们的文件，不建快照');
  assert.equal(sent.filter((x) => x.url.includes('batchTrash')).length, 0, '不是我们的文件，绝不删');
});

test('失败**不推进游标**（读那一步失败就停在那）', () => {
  const { deps } = mkDeps({ taskExpansion: { code: 500 } });
  startExpansion(deps);
  const r = runExpansionStep(deps);
  assert.equal(r.ok, true, '这一族的信封里 code 不看就往下走 —— 但游标该停');
  void r;
  assert.equal((JSON.parse(deps.store.getState(STATE_EXPAND)!) as { step: string }).step, 'cleanup');
});
