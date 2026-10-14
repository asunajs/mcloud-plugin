// 上传状态机（三枪）—— 这一层的测试重点不是"能不能传上去"，而是三条**不该发**的边界：
//   ① 秒传命中 ⇒ **不发 PUT**（真机上 `uploadId: null` 那一支就是它）
//   ② 这次调用没带字节 ⇒ **不发**（拿空体去 PUT 会真传一个 0 字节文件上去）
//   ③ 预签名地址落在应带凭据的域里 ⇒ **不发**（凭据泄漏比这次失败严重得多）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_UPLOAD,
  clearUpload,
  loadUpload,
  runUploadStep,
  startUpload,
  uploadDone,
} from '../src/mcloud/tasks/upload.ts';
import { deterministicFile } from '../src/mcloud/cloudUpload.ts';
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
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
  }) as never;
  const deps = { store, transport, nowIso: NOW, baseUrl: undefined } as TaskDeps;
  return { deps, sent };
}

const CREATED = { code: 0, data: { fileId: 'F1', uploadId: 'U1', uploadUrl: 'https://s.example/k?sig=x', rapidUpload: false } };
const RAPID = { code: 0, data: { fileId: 'F1', rapidUpload: true } };

test('起一次上传：**一个请求都不发**，摘要已经算好并落库', () => {
  const { deps, sent } = mkDeps({});
  const bytes = deterministicFile('seed', 1024);
  const out = startUpload(deps, { name: 'a.txt', bytes });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 0, '排队只是写字');
  const st = loadUpload(deps)!;
  assert.equal(st.step, 'create');
  assert.equal(st.size, 1024);
  assert.equal(st.contentHash.length, 64, 'sha256 hex');
  assert.equal(st.locateKey, 'parentFileId', '默认按 id 定位');
  assert.equal(uploadDone(deps), false);
});

test('空文件名 / 空内容 ⇒ 拒绝（不发）', () => {
  const { deps, sent } = mkDeps({});
  assert.equal(startUpload(deps, { name: '  ', bytes: deterministicFile('s', 8) }).ok, false);
  assert.equal(startUpload(deps, { name: 'a', bytes: new Uint8Array(0) }).ok, false);
  assert.equal(sent.length, 0);
});

test('**主线**：create → put → complete，一步一枪', () => {
  const { deps, sent } = mkDeps({ 'file/create': CREATED, 'file/complete': { code: 0 } });
  const bytes = deterministicFile('seed', 256);
  startUpload(deps, { name: 'a.txt', bytes });
  const r1 = runUploadStep(deps); // ①
  assert.equal(r1.ok, true, r1.note);
  assert.match(r1.note, /预签名地址/);
  assert.doesNotMatch(r1.note, /s\.example/, '⚠ uploadUrl 按凭据对待，不许出现在文案里');
  assert.equal(loadUpload(deps)!.step, 'put');
  const r2 = runUploadStep(deps, bytes); // ②
  assert.equal(r2.ok, true, r2.note);
  assert.equal(sent[1]!.method, 'PUT');
  assert.equal(loadUpload(deps)!.step, 'complete');
  const r3 = runUploadStep(deps); // ③
  assert.equal(r3.ok, true, r3.note);
  assert.equal(uploadDone(deps), true);
  assert.equal(sent.length, 3);
  assert.ok(sent[0]!.url.includes('hcy/file/create'));
  assert.ok(sent[2]!.url.includes('hcy/file/complete'));
  // 走完之后再触发 ⇒ idle
  assert.equal(runUploadStep(deps).idle, true);
});

test('⚠ 秒传命中 ⇒ **不发 PUT**，直接完成', () => {
  const { deps, sent } = mkDeps({ 'file/create': RAPID });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 64) });
  const out = runUploadStep(deps);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /秒传/);
  assert.equal(sent.length, 1, '只发了 create');
  assert.equal(sent[0]!.method, 'POST');
  assert.equal(uploadDone(deps), true);
});

test('⚠ `put` 那一步没带字节 ⇒ **不发**（空体会真传一个 0 字节文件上去）', () => {
  const { deps, sent } = mkDeps({ 'file/create': CREATED });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 32) });
  runUploadStep(deps); // ① → put
  const before = sent.length;
  const out = runUploadStep(deps); // ② 不给字节
  assert.equal(out.ok, false);
  assert.match(out.note, /没带字节/);
  assert.equal(sent.length, before, '一个字节都不许发');
  assert.equal(loadUpload(deps)!.step, 'put', '停在这一步，下次带字节再来');
});

test('⚠ 预签名地址落在应带凭据的域里 ⇒ **不发**（凭据泄漏比失败严重）', () => {
  // 造一个"create 回了自家域"的响应 —— 那不是预签名直传该有的形状
  const { deps, sent } = mkDeps({
    'file/create': { code: 0, data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://yun.139.com/k', rapidUpload: false } },
  });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 8) });
  runUploadStep(deps);
  const before = sent.length;
  const out = runUploadStep(deps, deterministicFile('seed', 8));
  assert.equal(out.ok, false);
  assert.match(out.note, /不发|凭据/);
  assert.equal(sent.length, before, '不许把凭据送到那个域');
});

test('① 失败 ⇒ 停在这一步（不跳步）', () => {
  const { deps } = mkDeps({ 'file/create': { code: 500 } });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 8) });
  const out = runUploadStep(deps);
  assert.equal(out.ok, false);
  assert.equal(loadUpload(deps)!.step, 'create', '失败不推进游标，下次还能重试同一个');
});

test('③ 失败 ⇒ 也停在这一步', () => {
  const { deps } = mkDeps({ 'file/create': CREATED, 'file/complete': { code: 9 } });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 8) });
  runUploadStep(deps);
  runUploadStep(deps, deterministicFile('seed', 8));
  const out = runUploadStep(deps);
  assert.equal(out.ok, false);
  assert.match(out.note, /complete/);
  assert.equal(loadUpload(deps)!.step, 'complete');
});

test('状态缺 uploadUrl（比如库被清过）⇒ 如实作废，不发', () => {
  const { deps, sent } = mkDeps({});
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('seed', 8) });
  deps.store.setState(STATE_UPLOAD, JSON.stringify({ ...loadUpload(deps), step: 'put' }), NOW);
  const out = runUploadStep(deps, deterministicFile('seed', 8));
  assert.equal(out.ok, false);
  assert.match(out.note, /作废/);
  assert.equal(sent.length, 0);
});

test('`clearUpload` 清干净；没有排队时是 idle', () => {
  const { deps } = mkDeps({});
  assert.equal(runUploadStep(deps).idle, true);
  startUpload(deps, { name: 'a', bytes: deterministicFile('s', 8) });
  clearUpload(deps);
  assert.equal(loadUpload(deps), null);
  assert.equal(runUploadStep(deps).idle, true);
});

test('定位可以按路径（两支不同）', () => {
  const { deps, sent } = mkDeps({ 'file/create': CREATED });
  startUpload(deps, { name: 'a.txt', bytes: deterministicFile('s', 8), locateKey: 'parentPath', locateValue: '/x' });
  runUploadStep(deps);
  const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
  assert.equal(body.parentPath, '/x');
  assert.equal(body.parentFileId, undefined);
});
