import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import {
  DEFAULT_LISTEN_SECONDS,
  STATE_LISTEN_SECONDS,
  loadListenSeconds,
  saveTaskListenSeconds,
} from '../src/mcloud/tasks/liveListen.ts';

const NOW = '2026-10-22T01:00:00.000Z';

test('听弹幕时长：默认值、账号旧设置、任务级覆盖', () => {
  const s = memStore();
  assert.equal(loadListenSeconds(s), DEFAULT_LISTEN_SECONDS);

  const a = scoped(rawStoreOf(s), 'a');
  a.setState(STATE_LISTEN_SECONDS, '120', NOW);
  assert.equal(loadListenSeconds(a), 120, '没设任务级时用账号设置');

  saveTaskListenSeconds(rawStoreOf(s), 90, NOW);
  assert.equal(loadListenSeconds(a), 90, '直播页的任务级设置优先');
});

test('听弹幕时长：夹在 5–1800 秒（照 Rust 的 ParamSpec）', () => {
  const s = memStore();
  assert.equal(saveTaskListenSeconds(s, 2, NOW), 5);
  assert.equal(loadListenSeconds(s), 5);
  assert.equal(saveTaskListenSeconds(s, 9999, NOW), 1800);
  assert.equal(loadListenSeconds(s), 1800);
});
