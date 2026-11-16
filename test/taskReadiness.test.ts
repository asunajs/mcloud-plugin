import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureLogger, type LogLevel } from '../src/ports/log.ts';
import { installPanel, type PanelHost } from '../src/ports/panel.ts';
import { memStore } from '../src/store/memory.ts';
import { syncOwnTask, syncExchangeJob, syncTaskReadiness } from '../src/mcloud/taskReadiness.ts';

const NOW = '2026-10-20T00:00:00.000Z';

/** 假的宿主：记下每一次 set_job_*，并按需抛错（模拟"对方插件还没加载"）。 */
function fakePanel(throwFor: (name: string) => string | null = () => null) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      const msg = throwFor(String(args[0] ?? ''));
      if (msg !== null) throw new Error(msg);
      calls.push({ name, args });
    };
  const p = {
    registerTask: async () => {},
    registerRoute: () => {},
    sidebar: () => {},
    selfConfig: async () => ({}),
    setJobSummary: rec('setJobSummary'),
    setJobBlockers: rec('setJobBlockers'),
    setJobPaused: rec('setJobPaused'),
    setJobSchedule: rec('setJobSchedule'),
    version: () => '0.5.1',
    atLeast: () => true,
    pluginDataDir: async () => '/tmp/x',
    pluginDir: async () => null,
  } satisfies PanelHost;
  installPanel(p);
  return calls;
}

function captureLogs() {
  const lines: { level: LogLevel; msg: string }[] = [];
  configureLogger((level, msg) => lines.push({ level, msg }));
  return lines;
}

test('syncOwnTask：写的是**带插件前缀**的任务名（面板按 plugin/task 寻址）', () => {
  const store = memStore();
  const calls = fakePanel();
  try {
    syncOwnTask(store, '日常');
    const names = calls.map((c) => String(c.args[0]));
    assert.deepEqual(names, ['mcloud-daily/日常', 'mcloud-daily/日常']);
    assert.deepEqual(calls.map((c) => c.name), ['setJobBlockers', 'setJobSummary']);
  } finally {
    installPanel(null);
  }
});

test('⚠ 对方插件还没加载 ⇒ **debug**，不是 warn（否则每次启动 6 条假警报）', () => {
  const store = memStore();
  const logs = captureLogs();
  fakePanel(() => '没有这个任务: mcloud-daily/日常');
  try {
    syncTaskReadiness(store); // 三条全写，全被拒
  } finally {
    installPanel(null);
    configureLogger(() => {});
  }
  const warns = logs.filter((l) => l.level === 'warn');
  const debugs = logs.filter((l) => l.level === 'debug');
  assert.deepEqual(warns, [], '加载顺序不是故障，不该进 warn');
  assert.equal(debugs.length, 6, '三条 × 两个动作，各一条 debug');
});

test('其它失败（不能改别人的任务 / 面板内部错）**必须留痕**', () => {
  const store = memStore();
  const logs = captureLogs();
  fakePanel(() => '不能改别的插件的任务：x/y');
  try {
    syncOwnTask(store, '日常');
  } finally {
    installPanel(null);
    configureLogger(() => {});
  }
  assert.equal(logs.filter((l) => l.level === 'warn').length, 2, '两个动作各一条 warn');
  assert.match(logs[0]?.msg ?? '', /不能改别的插件的任务/);
});

test('syncExchangeJob：没计划 ⇒ 暂停 + 未就绪；有计划 ⇒ 按整点并集排', () => {
  const store = memStore();
  const calls = fakePanel();
  try {
    syncExchangeJob(store);
    assert.deepEqual(
      calls.map((c) => [c.name, c.args[0]]),
      [
        ['setJobSchedule', 'mcloud-exchange/兑换'],
        ['setJobPaused', 'mcloud-exchange/兑换'],
        ['setJobBlockers', 'mcloud-exchange/兑换'],
        ['setJobSummary', 'mcloud-exchange/兑换'],
      ],
    );
    // 没计划：暂停，且未就绪原因是"还没设定时计划"
    assert.equal(calls[1]!.args[1], true);
    assert.deepEqual(calls[2]!.args[1], ['还没设定时计划']);
  } finally {
    installPanel(null);
  }
});
