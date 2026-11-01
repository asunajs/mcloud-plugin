// 我们自己传的云端文件登记表 + 链尾兜底清理。
//
// 守的是“漏收尾”的三种现场：
//   · 上传后链路被打断 ⇒ 名单还在，链尾那一枪补删
//   · 跨天状态重置 ⇒ 名单比状态活得久
//   · 被拒/HTTP 失败 ⇒ **不清名单**，下一趟再试（不能把文件丢在云盘里当已清）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import {
  ownedFileIds,
  registerOwnedFile,
  runOwnedCleanup,
  unregisterOwnedFile,
} from '../src/mcloud/tasks/ownedFiles.ts';

const NOW = '2026-10-23T04:00:00.000Z';

function mkDeps(body = JSON.stringify({ code: '0000', success: true }), status = 200) {
  const store = memStore();
  store.ensureSchema();
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status, headers: {}, body };
  }) as never;
  return { deps: { store, transport, nowIso: NOW } as TaskDeps, sent };
}

test('登记幂等；注销只删指定那一枚', () => {
  const { deps } = mkDeps();
  registerOwnedFile(deps, 'F1');
  registerOwnedFile(deps, 'F1');
  registerOwnedFile(deps, 'F2');
  registerOwnedFile(deps, undefined);
  registerOwnedFile(deps, '');
  assert.deepEqual(ownedFileIds(deps), ['F1', 'F2']);
  unregisterOwnedFile(deps, 'F1');
  unregisterOwnedFile(deps, '不存在');
  assert.deepEqual(ownedFileIds(deps), ['F2']);
});

test('名单为空：一个请求都不发', () => {
  const { deps, sent } = mkDeps();
  const out = runOwnedCleanup(deps);
  assert.equal(out.ok, true);
  assert.equal(out.idle, true);
  assert.match(out.note, /没有要清理/);
  assert.equal(sent.length, 0);
});

test('一次 batchTrash 清掉全部；成功才清空名单', () => {
  const { deps, sent } = mkDeps();
  registerOwnedFile(deps, 'F1');
  registerOwnedFile(deps, 'F2');
  const out = runOwnedCleanup(deps);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /已把 2 个/);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.url.includes('batchTrash'));
  assert.deepEqual(JSON.parse(sent[0]!.body!), { fileIds: ['F1', 'F2'] });
  assert.deepEqual(ownedFileIds(deps), []);
});

test('HTTP 200 但 success:false ⇒ 不清名单，下一趟再试', () => {
  const { deps } = mkDeps(JSON.stringify({ code: '1001', success: false, msg: '拒绝' }));
  registerOwnedFile(deps, 'F1');
  const out = runOwnedCleanup(deps);
  assert.equal(out.ok, false);
  assert.match(out.note, /被拒/);
  assert.deepEqual(ownedFileIds(deps), ['F1']);
});

test('HTTP 500 / 非 JSON ⇒ 不清名单', () => {
  const http = mkDeps('boom', 500);
  registerOwnedFile(http.deps, 'F1');
  assert.equal(runOwnedCleanup(http.deps).ok, false);
  assert.deepEqual(ownedFileIds(http.deps), ['F1']);

  const bad = mkDeps('<html>not json</html>');
  registerOwnedFile(bad.deps, 'F1');
  assert.equal(runOwnedCleanup(bad.deps).ok, false);
  assert.deepEqual(ownedFileIds(bad.deps), ['F1']);
});

test('今天还在任务里用的文件跳过：只清其余，名单里留着它', () => {
  const { deps, sent } = mkDeps();
  registerOwnedFile(deps, 'F-在用');
  registerOwnedFile(deps, 'F-遗留');
  const out = runOwnedCleanup(deps, { skip: ['F-在用'] });
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /已把 1 个/);
  assert.match(out.note, /还在任务里用/);
  assert.deepEqual(JSON.parse(sent[0]!.body!), { fileIds: ['F-遗留'] });
  assert.deepEqual(ownedFileIds(deps), ['F-在用']);
});

test('全部都在用：不发那一枪', () => {
  const { deps, sent } = mkDeps();
  registerOwnedFile(deps, 'F1');
  const out = runOwnedCleanup(deps, { skip: ['F1'] });
  assert.equal(out.ok, true);
  assert.equal(out.idle, true);
  assert.match(out.note, /还在任务里用/);
  assert.equal(sent.length, 0);
  assert.deepEqual(ownedFileIds(deps), ['F1']);
});
