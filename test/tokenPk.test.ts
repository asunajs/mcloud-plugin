// 算力大作战：整趟状态机（假 transport，不碰上游）。
//
// 钉的是**接线与顺序**，不是上游读数：
//   · 计划：SUCCESS→领 / WAIT→click+动作 / RESERVE→reserve / inviteFriend→需手动；
//   · `click` 在动作**之前**（2026-11-01 抓包）；
//   · 动作做完不算完 —— 复查 `task/list` 翻成 SUCCESS 才领；
//   · 一条失败不拖垮整趟（后面的任务照做）；
//   · 关掉开关 ⇒ 一发请求都不发。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenPkGate, tokenPkStep, tokenPkSummary, TOKENPK_BUDGET } from '../src/mcloud/tasks/tokenPk.ts';
import { setTokenPkDraw, setTokenPkEnabled } from '../src/mcloud/tokenPkState.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const JSON_HDR = { 'content-type': 'application/json' };

interface FakeTask {
  id: number;
  name: string;
  state: string;
  taskType: string;
  currstep: number;
  monthlyCompleted: number;
  monthlyLimit: number;
  ext: string;
  action: string;
  prizes: { prizeName: string; prizeType: string; amount: number; available: boolean }[];
}

function baseTasks(): FakeTask[] {
  const one = (over: Partial<FakeTask> & { id: number; name: string; ext: string }): FakeTask => ({
    state: 'WAIT',
    taskType: 'NORMAL',
    currstep: 0,
    monthlyCompleted: 0,
    monthlyLimit: 0,
    action: 'jump',
    prizes: [{ prizeName: 'Token+100万', prizeType: 'token', amount: 1000000, available: true }],
    ...over,
  });
  return [
    one({ id: 5, name: '登录PC客户端传文件', state: 'SUCCESS', currstep: 2, ext: 'loginPc', action: 'toPcClient' }),
    one({ id: 1, name: '成功备份一次文件', ext: 'backup' }),
    one({ id: 6, name: '了解PC同步盘', ext: 'openUrl' }),
    one({ id: 7, name: '分享活动给好友', ext: 'inviteFriend', action: 'invite' }),
    one({ id: 8, name: '下月登录活动领Token', taskType: 'RESERVE', ext: 'reserveLogin' }),
  ];
}

function listBody(tasks: FakeTask[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'success',
    result: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      state: t.state,
      taskType: t.taskType,
      limitType: 'MONTH',
      currstep: t.currstep,
      claimable: false,
      monthlyCompleted: t.monthlyCompleted,
      monthlyLimit: t.monthlyLimit,
      prizes: t.prizes,
      button: { ios: { ext: t.ext, action: t.action, text: t.state === 'SUCCESS' ? '领取奖励' : '去完成' } },
    })),
  });
}

/** 假上游：只认这一族与上传/快照那几口；其余一律 500（跑出别的请求就说"不该发"）。 */
function fakeUpstream(opts: { failBackupCreate?: boolean; remainChance?: number } = {}): {
  transport: Transport;
  sent: string[];
  tasks: FakeTask[];
} {
  const tasks = baseTasks();
  const sent: string[] = [];
  let draws = 0;
  const by = (id: number): FakeTask | undefined => tasks.find((t) => t.id === id);
  const json = (body: unknown): { status: number; headers: Record<string, string>; body: string } => ({
    status: 200,
    headers: JSON_HDR,
    body: JSON.stringify(body),
  });

  const transport = ((req: BuiltRequest) => {
    const u = req.url;
    const path = u.includes('://') ? u.slice(u.indexOf('/', u.indexOf('://') + 3)) : u;
    sent.push(`${req.method} ${path.split('?')[0]}`);
    const body = req.body ?? '';

    if (path.startsWith('/ycloud/tokenpk/task/list')) return json({ code: 0, msg: 'success', result: JSON.parse(listBody(tasks)).result });
    if (path === '/ycloud/tokenpk/task/step/click') {
      const p = JSON.parse(body) as { taskId: number; key: string };
      const t = by(p.taskId);
      if (t !== undefined) {
        t.currstep = 1;
        // openUrl 只认 click：服务端点完就是 SUCCESS
        if (p.key === 'openUrl') {
          t.state = 'SUCCESS';
          t.currstep = 2;
        }
      }
      return json({ code: 0, msg: 'success' });
    }
    if (path === '/ycloud/tokenpk/task/step/reserve') {
      const p = JSON.parse(body) as { taskId: number };
      const t = by(p.taskId);
      if (t !== undefined) {
        t.state = 'SUCCESS';
        t.currstep = 1;
      }
      return json({ code: 0, msg: 'success', result: { allSuccess: true, task: { state: 'SUCCESS' }, prizes: [] } });
    }
    if (path === '/ycloud/tokenpk/task/step/receivePrize') {
      const p = JSON.parse(body) as { taskId: number };
      const t = by(p.taskId);
      if (t !== undefined) t.state = 'FINISH';
      return json({
        code: 0,
        msg: 'success',
        result: {
          allSuccess: true,
          task: { id: p.taskId, state: 'FINISH', currstep: 3 },
          prizes: [{ prizeName: '移动云盘100万tokens叠加包', success: true, errorMsg: 'success' }],
        },
      });
    }
    if (path === '/ycloud/tokenpk/toplist/progress/autoReceiveLotteryChance') {
      return json({ code: 0, msg: 'success', result: { totalChance: 1, rewardCount: 1 } });
    }
    if (path === '/ycloud/tokenpk/toplist/progress/queryHome') {
      return json({ code: 0, msg: 'success', result: { usedToken: 1260000, rewardStages: [] } });
    }
    if (path === '/ycloud/tokenpk/toplist/progress/queryRemainChance') {
      return json({ code: 0, msg: 'success', result: opts.remainChance ?? 5 });
    }
    if (path === '/ycloud/tokenpk/toplist/progress/lottery') {
      draws += 1;
      const win = draws % 2 === 1;
      return json({
        code: 0,
        msg: 'success',
        result: {
          win,
          prizeId: win ? 9001 : null,
          prizeName: win ? 'Token+1000' : null,
          prizeImage: null,
          prizeDesc: null,
          remainChance: Math.max(0, 2 - draws),
        },
      });
    }

    // 上传三枪 + 快照三枪
    if (path === '/hcy/file/create') {
      if (opts.failBackupCreate === true) return json({ code: 500, msg: 'mock 故意失败' });
      return json({
        success: true,
        code: '0000',
        data: { fileId: 'F1', uploadId: 'U1', rapidUpload: false, partInfos: [{ uploadUrl: 'https://hcyykj-eos.example.com/put/1' }] },
      });
    }
    if (u.startsWith('https://hcyykj-eos.example.com/put/')) return { status: 200, headers: {}, body: '' };
    if (path === '/hcy/file/complete') return json({ code: '0000', msg: 'success' });
    if (path === '/hcy/backup/createSnapshot') {
      return json({
        success: true,
        code: '0000',
        data: { fileId: 'S1', uploadId: 'SU1', rapidUpload: false, partInfos: [{ uploadUrl: 'https://hcyykj-eos.example.com/put/2' }] },
      });
    }
    if (path === '/hcy/backup/completeSnapshot') {
      // 快照确认 = "成功备份一次文件"的信号到了
      const t = by(1);
      if (t !== undefined) {
        t.state = 'SUCCESS';
        t.currstep = 2;
      }
      return json({ success: true, code: '0000', data: null });
    }
    return { status: 500, headers: {}, body: `不该发这个请求：${req.method} ${u}` };
  }) as unknown as Transport;

  return { transport, sent, tasks };
}

function depsFor(transport: Transport, nowIso = NOW): TaskDeps {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'mockcookie=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: nowIso }),
    nowIso,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: nowIso, jwt: 'JWT', referer: '', fingerprint: 'f' }), nowIso);
  return { store, transport, nowIso, nowMs: () => Date.parse(nowIso), settleMs: 0 };
}

function runAll(deps: TaskDeps): { notes: string[]; idle: boolean; ok: boolean } {
  const notes: string[] = [];
  for (let i = 0; i < 60; i++) {
    const r = tokenPkStep(deps);
    notes.push(r.note);
    if (r.idle === true || r.skipped === true) return { notes, idle: true, ok: r.ok };
    if (!r.ok && r.pending !== true) return { notes, idle: false, ok: false };
  }
  return { notes, idle: false, ok: false };
}

test('整趟：click 在动作之前、复查后才领、RESERVE 不领、汇总句是台账那句', () => {
  const { transport, sent } = fakeUpstream();
  const deps = depsFor(transport);
  const r = runAll(deps);
  assert.equal(r.idle, true, r.notes.join(' → '));

  // 顺序：列表 → 备份的 click → 上传三枪 → 快照三枪 → openUrl 的 click → reserve → 复查 → 领奖 ×3 → 收尾
  const click1 = sent.indexOf('POST /ycloud/tokenpk/task/step/click');
  const create = sent.indexOf('POST /hcy/file/create');
  const snapDone = sent.indexOf('POST /hcy/backup/completeSnapshot');
  assert.ok(click1 > 0 && click1 < create, `click 必须先于上传：${sent.join(', ')}`);
  assert.ok(snapDone > create, '快照要在上传之后');

  const claims = sent.filter((x) => x === 'POST /ycloud/tokenpk/task/step/receivePrize');
  assert.equal(claims.length, 3, `#5/#1/#6 三条该领：${sent.join(', ')}`);
  assert.equal(sent.filter((x) => x === 'POST /ycloud/tokenpk/task/step/reserve').length, 1);
  assert.equal(
    sent.filter((x) => x === 'POST /ycloud/tokenpk/toplist/progress/lottery').length,
    0,
    '代抽默认关：一发 lottery 都不该有',
  );
  // inviteFriend 是需手动：不许为它发任何 click
  assert.equal(sent.filter((x) => x === 'POST /ycloud/tokenpk/task/step/click').length, 2, '只有 backup 与 openUrl 两条 run');
  // 重新拉列表（复查）至少两次：计划一次 + 复查一次
  assert.ok(sent.filter((x) => x === 'GET /ycloud/tokenpk/task/list').length >= 2);

  const summary = tokenPkSummary(deps.store);
  assert.ok(summary !== undefined);
  assert.match(summary, /领取奖励3项/, summary);
  assert.match(summary, /执行任务3项/, summary);
  assert.match(summary, /抽奖次数\+1/, summary);
  assert.match(summary, /累计算力126万/, summary);
  assert.match(summary, /需手动: 分享活动给好友\(inviteFriend\)/, summary);
  // 逐行：三条动作 + 三条领取（`dailyRun` 之后由 `takeTokenPkLines` 取走）
  const lines = (JSON.parse(deps.store.getState('mcloud.tokenpk.state') ?? '{}') as { lines?: string[] }).lines ?? [];
  assert.equal(lines.length, 6, lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('领取「登录PC客户端传文件」')), lines.join(' | '));
});

test('一条失败不拖垮整趟：备份上传失败，openUrl / 预约 / 领奖照做', () => {
  const { transport, sent } = fakeUpstream({ failBackupCreate: true });
  const deps = depsFor(transport);
  const r = runAll(deps);
  assert.equal(r.idle, true, r.notes.join(' → '));
  assert.ok(sent.includes('POST /ycloud/tokenpk/task/step/reserve'), '预约照做');
  assert.ok(sent.includes('POST /ycloud/tokenpk/task/step/receivePrize'), '至少 #5 该领');
  const summary = tokenPkSummary(deps.store);
  assert.match(summary ?? '', /1项步骤失败/, summary ?? '');
});

test('开关缺省是开：新号没有那一格 ⇒ 照跑（`getState` 回 null 的那条坑）', () => {
  const { transport, sent } = fakeUpstream();
  const deps = depsFor(transport);
  const gate = tokenPkGate(deps);
  assert.equal(gate.idle, false);
  assert.equal(gate.ok, true);
  assert.equal(sent.length, 0);
});

test('关掉开关：tokenPkGate 直接 idle，一个请求都不发', () => {
  const { transport, sent } = fakeUpstream();
  const deps = depsFor(transport);
  setTokenPkEnabled(deps.store, false, NOW);
  const gate = tokenPkGate(deps);
  assert.equal(gate.idle, true);
  assert.equal(gate.skipped, true);
  assert.equal(sent.length, 0);
});

test('代抽开了：按上限一趟抽完，体是字面 null，汇总句带「代抽N次（中M次）」', () => {
  const { transport, sent } = fakeUpstream();
  const deps = depsFor(transport);
  setTokenPkDraw(deps.store, { enabled: true, max: 2 }, NOW);
  const r = runAll(deps);
  assert.equal(r.idle, true, r.notes.join(' → '));
  assert.equal(
    sent.filter((x) => x === 'GET /ycloud/tokenpk/toplist/progress/queryRemainChance').length,
    1,
    '抽之前先读一次剩余次数',
  );
  const draws = sent.filter((x) => x === 'POST /ycloud/tokenpk/toplist/progress/lottery');
  assert.equal(draws.length, 2, sent.join(', '));
  const summary = tokenPkSummary(deps.store) ?? '';
  assert.match(summary, /代抽2次（中1次）/, summary);
  const lines = (JSON.parse(deps.store.getState('mcloud.tokenpk.state') ?? '{}') as { lines?: string[] }).lines ?? [];
  assert.ok(lines.some((l) => l.includes('代抽中奖：Token+1000')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('代抽第 2 次：没中')), lines.join(' | '));
});

test('剩余次数是 0 ⇒ 一发 lottery 都不发（别拿上限撞服务端）', () => {
  const { transport, sent } = fakeUpstream({ remainChance: 0 });
  const deps = depsFor(transport);
  setTokenPkDraw(deps.store, { enabled: true, max: 3 }, NOW);
  runAll(deps);
  assert.equal(
    sent.filter((x) => x === 'POST /ycloud/tokenpk/toplist/progress/lottery').length,
    0,
    sent.join(', '),
  );
  const summary = tokenPkSummary(deps.store) ?? '';
  assert.doesNotMatch(summary, /代抽\d+次/, summary);
});

test('代抽上限按天算：同一天第二趟不再抽', () => {
  const { transport, sent } = fakeUpstream();
  const deps = depsFor(transport);
  setTokenPkDraw(deps.store, { enabled: true, max: 1 }, NOW);
  runAll(deps);
  const first = sent.filter((x) => x === 'POST /ycloud/tokenpk/toplist/progress/lottery').length;
  assert.equal(first, 1);
  runAll(deps);
  const total = sent.filter((x) => x === 'POST /ycloud/tokenpk/toplist/progress/lottery').length;
  assert.equal(total, 1, '第二趟不该再抽（上限 1/天）');
});

test('月上限到了的那条不做（连 click 都不发）', () => {
  const { transport, sent, tasks } = fakeUpstream();
  const capped = tasks.find((t) => t.id === 6);
  assert.ok(capped !== undefined);
  capped.monthlyCompleted = 3;
  capped.monthlyLimit = 3;
  const deps = depsFor(transport);
  runAll(deps);
  // openUrl 那条被上限挡掉 ⇒ 只剩 backup 一发 click
  assert.equal(sent.filter((x) => x === 'POST /ycloud/tokenpk/task/step/click').length, 1, sent.join(', '));
});

test('预算常量：步数与时间都比 App 任务那一档低（后面还有 5 步要跑）', () => {
  assert.equal(TOKENPK_BUDGET.maxSteps, 80);
  assert.ok(TOKENPK_BUDGET.deadlineMs <= 60_000);
});
