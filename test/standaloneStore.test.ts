import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore, StateLockedError } from '../src/standalone/fileStore.ts';

const ISO = '2026-10-20T00:00:00.000Z';

test('FileStore：setState 原子落盘、重启可恢复', () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const f = join(d, 'state.json');
  const a = new FileStore(f, ISO);
  a.setState("mcloud.acct.x", '{"v":1}', ISO);
  a.close();
  const b = new FileStore(f, ISO);
  assert.equal(b.getState("mcloud.acct.x"), '{"v":1}');
  b.close();
  const raw = JSON.parse(readFileSync(f, 'utf8')) as { state: Record<string, string> };
  assert.equal(raw.state["mcloud.acct.x"], '{"v":1}');
});

test('FileStore：同一文件第二个实例被锁挡住；close 后可重开', () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const f = join(d, 'state.json');
  const a = new FileStore(f, ISO);
  assert.throws(() => new FileStore(f, ISO), StateLockedError);
  a.close();
  const b = new FileStore(f, ISO);
  b.close();
});

test('FileStore：run 统计排除负延迟，分位数按值取', () => {
  const d = mkdtempSync(join(tmpdir(), 'mcloud-store-'));
  const s = new FileStore(join(d, 'state.json'), ISO);
  for (const lateMs of [-100, 10, 20, 30]) {
    s.recordRun({ task: '日常', runs: 1, scheduledAt: ISO, firedAt: ISO, lateMs, ok: true });
  }
  const st = s.lateStats('日常');
  assert.equal(st.n, 3);
  assert.equal(st.excluded, 1);
  assert.equal(st.lateP50, 20);
  assert.equal(st.lateMax, 30);
  assert.equal(s.recentRuns(1).length, 1);
  s.close();
});
