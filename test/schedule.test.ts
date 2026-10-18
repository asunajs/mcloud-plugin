import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STATE_LEAD_SEC,
  STATE_SCHEDULE_CRON,
  STATE_SCHEDULE_GEN,
  STATE_SCHEDULE_MAX_RUNS,
  STATE_SCHEDULE_RUNS,
  STATE_SCHEDULE_RUNS_GEN,
  STATE_SCHEDULE_UNTIL,
  bumpScheduleRuns,
  scheduleDateAllowed,
  scheduleLeadReady,
  scheduleLeadSec,
  scheduleMaxRuns,
  scheduleNextTargetMs,
  scheduleRuns,
} from '../src/mcloud/tasks/exchangeRun.ts';
import { nextCronTargetMs, parseCron } from '../src/mcloud/scheduleCron.ts';

function fakeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getState: (k: string) => m.get(k),
    setState: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('提前触发：到「目标时刻 − 提前秒数」才算 ready', () => {
  const t = at(2026, 10, 18, 10);
  assert.equal(scheduleLeadReady(t - 121_000, t, 120), false);
  assert.equal(scheduleLeadReady(t - 120_000, t, 120), true);
  assert.equal(scheduleLeadReady(t - 60_000, t, 120), true);
});

test('cron：一天多个整点，下一场按顺序取', () => {
  const t = at(2026, 10, 18, 9, 30);
  assert.equal(nextCronTargetMs('0 10,20 * * *', t), at(2026, 10, 18, 10));
  const after = at(2026, 10, 18, 10, 1);
  assert.equal(nextCronTargetMs('0 10,20 * * *', after), at(2026, 10, 18, 20));
  // 分钟必须是 0
  assert.throws(() => parseCron('30 10 * * *'), /分钟只能是 0/);
  // 每小时都试 / 日/月收窄
  assert.equal(nextCronTargetMs('0 * * * *', t), at(2026, 10, 18, 10));
  assert.equal(nextCronTargetMs('0 10 19 10 *', t), at(2026, 10, 19, 10));
});

test('日期：下一场必须在截止时间之前；截止日含当天', () => {
  const now = at(2026, 10, 18, 9, 30);
  let s = fakeStore({ [STATE_SCHEDULE_CRON]: '0 10 * * *', [STATE_SCHEDULE_UNTIL]: '2026-10-18' });
  assert.equal(scheduleDateAllowed(s, now).ok, true);
  s = fakeStore({ [STATE_SCHEDULE_CRON]: '0 10 * * *', [STATE_SCHEDULE_UNTIL]: '2026-10-17' });
  assert.equal(scheduleDateAllowed(s, now).ok, false);
  s = fakeStore({ [STATE_SCHEDULE_CRON]: '0 10 * * *', [STATE_SCHEDULE_UNTIL]: '2026-10-18T09:59' });
  assert.equal(scheduleDateAllowed(s, now).ok, false);
});

test('下一场：cron 配了就用 cron，没配回退旧 targetHour', () => {
  const now = at(2026, 10, 18, 9, 30);
  let s = fakeStore({ [STATE_SCHEDULE_CRON]: '0 10,20 * * *' });
  assert.equal(scheduleNextTargetMs(s, now), at(2026, 10, 18, 10));
  s = fakeStore({});
  assert.equal(scheduleNextTargetMs(s, now), at(2026, 10, 18, 10));
});

test('次数：每账号各算；换一版定时从头算', () => {
  const s = fakeStore({
    [STATE_SCHEDULE_GEN]: 'g1',
    [STATE_SCHEDULE_RUNS_GEN]: 'g1',
    [STATE_SCHEDULE_RUNS]: '2',
  });
  assert.equal(scheduleRuns(s), 2);
  s.setState(STATE_SCHEDULE_GEN, 'g2');
  assert.equal(scheduleRuns(s), 0, '换版之后旧次数不算');
  bumpScheduleRuns(s, '2026-10-18T00:00:00.000Z');
  assert.equal(scheduleRuns(s), 1);
  assert.equal(s.dump()[STATE_SCHEDULE_RUNS_GEN], 'g2');
});

test('次数上限 / 提前秒数钳制', () => {
  const s = fakeStore({ [STATE_SCHEDULE_MAX_RUNS]: '3', [STATE_LEAD_SEC]: '999' });
  assert.equal(scheduleMaxRuns(s), 3);
  assert.equal(scheduleLeadSec(s), 300);
  s.setState(STATE_LEAD_SEC, '1');
  assert.equal(scheduleLeadSec(s), 60);
});
