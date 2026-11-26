// 趣玩AI 的**做任务**那三段：`register` → `act` → `verify`。
//
// 这一篇只钉判据，不钉"能不能真做成"：
//   · 判据**只有一条** —— 回读 `isComplete` 翻位。`register` 回 `{code:0,result:0}` 什么也不说明；
//   · 没翻位 ⇒ `pending`（不是失败，也不是成功）；
//   · 今天点过的、已完成的、`taskSign≠0` 的、我们不会做的 —— **一个字节都不发**。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAYAI_TASKS_PER_RUN, playAiStep } from '../src/mcloud/tasks/playAi.ts';
import { loadPlayAi } from '../src/mcloud/playAiState.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-11-26T07:00:00.000Z';

function pageModule(complete: Record<string, number>, drawTimes = 0): Record<string, unknown> {
  const task = (id: string, name: string, sign: number) => ({
    id,
    taskName: name,
    taskSign: sign,
    isComplete: complete[id] ?? 0,
    innerLink: '',
  });
  return {
    code: 0,
    msg: 'success',
    result: {
      moduleId: '1-250730',
      subtitle: '趣玩AI赢好礼',
      drawTimes,
      drawsUsed: 0,
      todayGetLotteryCount: 0,
      taskIds: [
        task('003', '智能抠图，一键抠图超轻松', 0), // 我们不会做 ⇒ 不点
        task('aizhushou', 'AI助手，打工人必备神器', 0), // ← 唯一会做的那件
        task('invite', '邀请好友，一起趣玩AI', 1), // taskSign 1 ⇒ 不点
        task('ailuyinzhuanxie', 'AI录音转写', 2), // taskSign 2 ⇒ 不点
      ],
    },
  };
}

/** 造一个"上游"：按 URL 分派，记录所有请求。`flip` = 回读时 aizhushou 是否已完成。 */
function harness(
  opts: { flip?: boolean; registerCode?: number; drawTimes?: number; draw?: boolean; isWin?: number | null } = {},
) {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const sent: BuiltRequest[] = [];
  let registered = false;
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register')) {
      registered = true;
      const code = opts.registerCode ?? 0;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(code === 0 ? { code: 0, msg: 'success', result: 0 } : { code, msg: '不行' }),
      };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      const done = registered && opts.flip === true ? 1 : 0;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(pageModule({ aizhushou: done }, opts.drawTimes ?? 0)),
      };
    }
    if (url.includes('/funai/api/page/lottery')) {
      const win = opts.isWin === undefined ? 1 : opts.isWin;
      const result =
        win === null
          ? { id: 1, prizeType: 1 } // 没有 isWin 键
          : { id: 1, isWin: win, prizeName: win === 1 ? '30云盘专属AI豆' : null, prizeType: 1 };
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result }) };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    // 动作链（灵犀）：一律给"没成"，这样链会很快收尾 —— 这一篇不管它成不成
    return { status: 200, headers: {}, body: JSON.stringify({ code: 500, msg: '动作链不在本篇范围' }) };
  }) as never;
  const deps = { store, transport, nowIso: NOW, now: () => NOW, baseUrl: undefined } as unknown as TaskDeps;
  return { deps, sent, store };
}

/** 一直推，直到 idle（`drain` 的语义）。 */
async function drainAll(deps: TaskDeps): Promise<{ notes: string[]; idle: boolean }> {
  const notes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await playAiStep(deps);
    notes.push(r.note);
    if (r.idle === true) return { notes, idle: true };
  }
  return { notes, idle: false };
}

test('挑中的是「AI 助手」那件：`taskSign≠0` / 我们不会做的 / 已完成的都不点', async () => {
  const { deps, sent } = harness({ flip: true });
  await drainAll(deps);
  const regs = sent.filter((x) => String(x.url).includes('/page/register'));
  assert.equal(regs.length, 1, '只点一件');
  assert.deepEqual(JSON.parse(String(regs[0]!.body)), { moduleId: '1-250730', taskId: 'aizhushou' });
});

test('回读翻位了 ⇒ 判"做完了"（唯一判据是回读，不是 register 的回执）', async () => {
  const { deps } = harness({ flip: true });
  const { notes, idle } = await drainAll(deps);
  assert.equal(idle, true, '要走到 idle');
  assert.ok(
    notes.some((n) => /做完了/.test(n)),
    `要有一句"做完了"：${notes.join(' | ')}`,
  );
});

test('回读没翻位 ⇒ `pending`（不是失败，也不是成功）', async () => {
  const { deps } = harness({ flip: false });
  let last: { ok: boolean; pending?: boolean; note: string } | null = null;
  for (let i = 0; i < 12; i++) {
    const r = await playAiStep(deps);
    last = r;
    if (r.idle === true) break;
  }
  assert.ok(last, '要走到收尾');
  assert.equal(last!.ok, true, '该做的都做了 ⇒ 不是失败');
  assert.equal(last!.pending, true, '要标 pending —— 等服务端认');
  assert.match(last!.note, /还没认/);
});

test('`register` 被拒 ⇒ 判失败，且**不再**往下做动作', async () => {
  const { deps, sent } = harness({ flip: true, registerCode: 40000 });
  let last: { ok: boolean; pending?: boolean; note: string } | null = null;
  for (let i = 0; i < 12; i++) {
    const r = await playAiStep(deps);
    last = r;
    // `drain` 的语义：`ok:false` 且不是 pending ⇒ **当场停**（不再推下一步）
    if (r.ok === false && r.pending !== true) break;
    if (r.idle === true) break;
  }
  assert.equal(last!.ok, false);
  assert.match(last!.note, /上报被拒/);
  // 动作链一发都不该发（那些是 ai.yun.139.com 的请求）
  assert.equal(sent.filter((x) => String(x.url).includes('ai.yun.139.com')).length, 0);
});

test('今天点过就不再点：同一天再跑一趟，`register` 一发都不发', async () => {
  const { deps, sent } = harness({ flip: false });
  await drainAll(deps);
  const first = sent.filter((x) => String(x.url).includes('/page/register')).length;
  assert.equal(first, 1);
  // 同一天再跑一趟（状态还在）
  await drainAll(deps);
  const second = sent.filter((x) => String(x.url).includes('/page/register')).length;
  assert.equal(second, 1, `同一天不该再点一次（实际 ${second} 发）`);
  const st = loadPlayAi(deps.store);
  assert.equal(Object.keys(st?.tried ?? {}).length, 1);
});

test('预算常量是 1（写口，别放开成"全做"）', () => {
  assert.equal(PLAYAI_TASKS_PER_RUN, 1);
});

// ── 抽奖（step ③）──────────────────────────────────────────────────

test('代抽**缺省关**：开关没开时，一次都不抽（哪怕有次数）', async () => {
  const { deps, sent } = harness({ flip: true, drawTimes: 3 });
  await drainAll(deps);
  assert.equal(sent.filter((x) => String(x.url).includes('/page/lottery')).length, 0, '缺省关就别抽');
});

test('开了代抽 + 有次数 ⇒ 抽一发；`isWin:1` 判中、`isWin:0` 判没中', async () => {
  for (const [isWin, expect] of [[1, /抽中了/], [0, /没中/]] as const) {
    const { deps, sent, store } = harness({ flip: true, drawTimes: 2, draw: true, isWin });
    const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
    setPlayAiDrawEnabled(store, true, NOW);
    const { notes } = await drainAll(deps);
    const draws = sent.filter((x) => String(x.url).includes('/page/lottery'));
    assert.equal(draws.length, 1, '抽一发');
    assert.deepEqual(JSON.parse(String(draws[0]!.body)), { moduleId: '1-250730' });
    assert.ok(notes.some((n) => expect.test(n)), `要有结论：${notes.join(' | ')}`);
  }
});

test('次数是 0 ⇒ 不抽（`drawTimes` 本身已是余额，不再减 `drawsUsed`）', async () => {
  const { deps, sent, store } = harness({ flip: true, drawTimes: 0, draw: true, isWin: 1 });
  const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
  setPlayAiDrawEnabled(store, true, NOW);
  await drainAll(deps);
  assert.equal(sent.filter((x) => String(x.url).includes('/page/lottery')).length, 0);
});

test('回执没有 `isWin` ⇒ 既不写"中了"也不写"没中"', async () => {
  const { deps, store } = harness({ flip: true, drawTimes: 1, draw: true, isWin: null });
  const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
  setPlayAiDrawEnabled(store, true, NOW);
  const { notes } = await drainAll(deps);
  assert.ok(notes.some((n) => /判不出/.test(n)), `要如实说：${notes.join(' | ')}`);
  // ⚠ 别写成 `/没中$/`：那句「判不出中没中」正好以「没中」结尾，会误伤
  assert.equal(notes.some((n) => /抽中了/.test(n) || /^抽了一次，没中$/.test(n)), false);
});
