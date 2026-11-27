// 趣玩AI 的**做任务**那三段：`register` → `act` → `verify`。
//
// 这一篇只钉判据，不钉"能不能真做成"：
//   · 判据**只有一条** —— 回读 `isComplete` 翻位。`register` 回 `{code:0,result:0}` 什么也不说明；
//   · 没翻位 ⇒ `pending`（不是失败，也不是成功）；
//   · 今天点过的、已完成的、`taskSign≠0` 的、我们不会做的 —— **一个字节都不发**。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYAI_MAX_STEPS,
  PLAYAI_TASKS_PER_RUN,
  playAiStep,
} from '../src/mcloud/tasks/playAi.ts';
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
        task('ailuyinzhuanxie', 'AI录音转写', 2), // taskSign 2 ⇒ 走完成口（2026-11-26 已跑通）
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
  // ⚠ 按**任务**记翻位，不是一个全局布尔（2026-11-26 改）。
  //   原来一个开关管所有任务 ⇒ 一趟连做几件时，第二件刚 `register`、回读就把**所有**
  //   任务都报成"已完成"，`lines` 里于是全是"做完了"、一条"没成"都没有。
  //   夹具的假设过时了（那时一趟只做 1 件），不是代码错。
  const registered = new Set<string>();
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register') || url.includes('/funai/api/timed/transcriptioncompleted')) {
      // ⚠ 转写的完成口也要认（`taskSign=2`）：不认的话它会落到"动作链 500"那条默认分支，
      //   整条链当场断掉 —— 一趟连做几件时第二件就废了（2026-11-26 踩到）。
      try {
        const b = JSON.parse(String(req.body ?? '{}')) as { taskId?: string };
        registered.add(String(b.taskId ?? ''));
      } catch {
        /* body 不是 JSON 就算了 */
      }
      const code = opts.registerCode ?? 0;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(code === 0 ? { code: 0, msg: 'success', result: 0 } : { code, msg: '不行' }),
      };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      // 只有**点过**才会翻位（真实行为就是这样：点过 ≠ 全做完）
      const done = registered.size > 0 && opts.flip === true ? 1 : 0;
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
  // ⚠ `waitMs` 是**忙等**：给一个每轮 +1000ms 的假时钟，等待就不花真秒数
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;
  return { deps, sent, store };
}

/** 一直推，直到 idle（`drain` 的语义）。 */
async function drainAll(deps: TaskDeps): Promise<{ notes: string[]; idle: boolean }> {
  const notes: string[] = [];
  // ⚠ 上限要跟着 `PLAYAI_MAX_STEPS`（一趟现在会连做几件，12 步走不完）——
  //   走不完时 `lines` 停在半路，测试会看到"做完了"消失这种假失败。
  for (let i = 0; i < PLAYAI_MAX_STEPS + 4; i++) {
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
  assert.ok(regs.length >= 1, '要真的点');
  // ⚠ 钉**行为**不钉数量：一趟能做几件是 `PLAYAI_TASKS_PER_RUN` 的事，另有一条测试管；
  //   这里管的是"第一件挑中的是谁"（偏好顺序 = 不落盘的先做）。
  assert.deepEqual(JSON.parse(String(regs[0]!.body)), { moduleId: '1-250730', taskId: 'aizhushou' });
  // 且**不许**点那几件我们明确不会做的（taskSign=1 邀请 / 已撤掉的 zhishiku / 上游未开发的）
  const pointed = regs.map((x) => String((JSON.parse(String(x.body)) as { taskId?: string }).taskId ?? ''));
  for (const bad of ['invite', 'zhishiku', '008', '009']) {
    assert.equal(pointed.includes(bad), false, `不该点「${bad}」`);
  }
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

test('今天点过就不再点：同一天再跑一趟，同一件不点第二次', async () => {
  const { deps, sent } = harness({ flip: false });
  await drainAll(deps);
  const regsOf = (): string[] =>
    sent
      .filter((x) => String(x.url).includes('/page/register'))
      .map((x) => String((JSON.parse(String(x.body)) as { taskId?: string }).taskId ?? ''));
  const firstRound = regsOf();
  assert.ok(firstRound.length >= 1, '第一趟要真的点');
  assert.ok(firstRound.includes('aizhushou'), `第一趟该点 AI 助手：${firstRound.join(',')}`);
  // 同一天再跑一趟（状态还在）
  await drainAll(deps);
  // ⚠ 钉「同一件不再点」，不是「第二趟什么都不做」—— 第二趟会做别的（甚至别的族）
  const secondRound = regsOf().slice(firstRound.length);
  assert.equal(secondRound.includes('aizhushou'), false, `aizhushou 不该再点一次（第二趟点了 ${secondRound.join(',')}）`);
  const st = loadPlayAi(deps.store);
  assert.ok(Object.keys(st?.tried ?? {}).length >= 1, '点过的要记下来');
});

test('点完之后**真的进动作链**：第一发是灵犀的换票（`toSourceId=001003`）', async () => {
  // ⚠ 这一条钉的是"接线"，不是"能不能聊成"：动作链的第一步是 m.mcloud 上的
  //   `querySpecTokenV2`（`mailSpecTokenRequest` → `specTokenRequest`），
  //   它发出来了就说明 `stepAction` 拿到了正确的 `PkAttempt`（key=aiAssistant / step=ai-mail-sso）。
  const { deps, sent } = harness({ flip: true });
  await drainAll(deps);
  // ⚠ `toSourceId` 在 **body** 里（不是 query），别按 URL 找
  const sso = sent.filter(
    (x) => /querySpecToken/i.test(String(x.url)) && String(x.body ?? '').includes('001003'),
  );
  assert.equal(sso.length, 1, `要有一发灵犀换票（实际 ${sso.length}）`);
});

test('一趟做几件是**有上限**的（不是"全做"，也不是 1）', () => {
  // 2026-11-26 从 1 改成 3：一件一趟等于要手动点二十来次，而用户一趟只想跑一次。
  // ⚠ 这条钉的是**有上限且与步数预算配套**，不是钉某个具体数字 ——
  //   数字以后可能再调，但"不能是 1、不能是无穷、步数够走完"这三条要一直成立。
  assert.ok(PLAYAI_TASKS_PER_RUN >= 2, '别退回"一件一趟"');
  assert.ok(PLAYAI_TASKS_PER_RUN <= 10, '一趟做太多会把执行预算吃光');
  // 一件的链 8~9 步 ⇒ 步数预算至少够做满
  assert.ok(
    PLAYAI_MAX_STEPS >= PLAYAI_TASKS_PER_RUN * 8,
    `步数预算 ${PLAYAI_MAX_STEPS} 不够做满 ${PLAYAI_TASKS_PER_RUN} 件（每件约 8 步）`,
  );
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
    assert.equal(draws.length, 1, `抽一发；实际 notes=${notes.join(' | ')}`);
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

test('`drain` 的步数上限够走完一整趟（给紧了会报假失败）', () => {
  // 最长那条：list 1 + register 1 + 相机链 5 + verify 1 + 再读 1 + verify 1 + draw 1 = 11
  assert.ok(PLAYAI_MAX_STEPS >= 11, `上限 ${PLAYAI_MAX_STEPS} 太小`);
  // 还要留重试余量：撞上限时 `drain` 报「走到第 N 步就停了」，那是假失败
  assert.ok(PLAYAI_MAX_STEPS >= 13, `上限 ${PLAYAI_MAX_STEPS} 没留重试余量`);
});

test('动作那一步没成，也**照样回读**（判据只有回读，失败那一句进 lines）', async () => {
  // 夹具里动作链一律回 500 ⇒ 第一步就 fail；但回读仍要发生，且结论按 isComplete 走
  const { deps, sent } = harness({ flip: true });
  const { notes } = await drainAll(deps);
  // 回读至少两次：list 一次 + verify 一次
  const reads = sent.filter((x) => String(x.url).includes('/funai/api/page/getmodule')).length;
  assert.ok(reads >= 2, `list + verify 都要读（实际 ${reads} 次）`);
  assert.ok(
    notes.some((n) => /做完了/.test(n)),
    `动作失败不影响"回读已翻位"这个判据：${notes.join(' | ')}`,
  );
  const { loadPlayAi } = await import('../src/mcloud/playAiState.ts');
  const st = loadPlayAi(deps.store);
  assert.ok(
    (st?.lines ?? []).some((l) => /没成/.test(l)) || (st?.lines ?? []).some((l) => /做完了/.test(l)),
    `动作失败那一句要留在 lines 里（或被完成那句覆盖）；实际 lines=${JSON.stringify(st?.lines)} phase=${st?.phase} done=${st?.doneCount} notes=${notes.join(' | ')}`,
  );
});

// ── 同一天的第二趟（用户设几趟就该跑几趟）──────────────────────────

test('⚠ 同一天第二趟照样干活：上一趟 `done` 不能把这一族当天封死', async () => {
  const { deps, sent } = harness({ flip: true });
  await drainAll(deps);
  const reads1 = sent.filter((x) => String(x.url).includes('/page/getmodule')).length;
  // 第二趟（同一天、状态还在 phase='done'）
  await drainAll(deps);
  const reads2 = sent.filter((x) => String(x.url).includes('/page/getmodule')).length;
  assert.ok(reads2 > reads1, `第二趟也要读一遍（${reads1} → ${reads2}）`);
});

test('有几次就能抽几次：两个号各跑一趟 ⇒ 两发 lottery（不是一天只准一发）', async () => {
  const { deps, sent, store } = harness({ flip: true, drawTimes: 3, draw: true, isWin: 1 });
  const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
  setPlayAiDrawEnabled(store, true, NOW);
  await drainAll(deps);
  await drainAll(deps); // 同一天第二趟
  const draws = sent.filter((x) => String(x.url).includes('/page/lottery')).length;
  assert.equal(draws, 2, `两趟该抽两发（实际 ${draws}）`);
});

test('一趟最多抽一发：一次 drain 里不会连抽', async () => {
  const { deps, sent, store } = harness({ flip: true, drawTimes: 9, draw: true, isWin: 1 });
  const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
  setPlayAiDrawEnabled(store, true, NOW);
  await drainAll(deps);
  const draws = sent.filter((x) => String(x.url).includes('/page/lottery')).length;
  assert.equal(draws, 1, `一趟只准一发（实际 ${draws}）`);
});

test('入口步骤问动作层，不硬编（动作层换入口时这一族跟着走）', async () => {
  const { firstActionStep } = await import('../src/mcloud/tasks/tokenPkActions.ts');
  // 这一族现在只接 AI 助手；它的入口是动作层说了算
  assert.equal(firstActionStep('aiAssistant'), 'ai-mail-sso');
  // 钉住"我们用的是动作层那个函数"而不是字面量
  const src = (await import('node:fs')).readFileSync('src/mcloud/tasks/playAi.ts', 'utf8');
  assert.match(src, /step: firstActionStep\(t\.actionKey\)/, '入口步骤要问动作层');
  assert.equal(/step: 'ai-mail-sso'/.test(src), false, '不许硬编入口步骤');
});

test('读失败时**保留上一份好读数**（别把可做清单一起擦掉）', async () => {
  const { deps, store } = harness({ flip: true });
  await drainAll(deps); // 先成功读一次
  const { loadPlayAiSnapshot } = await import('../src/mcloud/playAiState.ts');
  const good = loadPlayAiSnapshot(store);
  assert.ok(good?.ok === true && good.reading !== null, '先要有一份好读数');

  // 把票拿掉，模拟"这一趟换票没成"
  store.setState(STATE_JWT, '', NOW);
  await playAiStep(deps);
  const after = loadPlayAiSnapshot(store);
  assert.equal(after?.ok, false, '这次是失败');
  assert.match(String(after?.error), /网页会话/);
  assert.equal(after?.line, good!.line, '读数那一行要保留上一份');
  assert.deepEqual(after?.reading, good!.reading, '可做清单也要保留');
});

// ── 调试运行的收尾（与 `only` 有关）────────────────────────────────

test('调试运行只点一族时，收尾那几步（领取AI豆 / 待领取奖品 / 清理 / 今日云朵）一个请求都不发', async () => {
  const { deps, sent } = harness({ flip: true });
  await drainAll(deps);
  // 收尾几发各自的特征端点
  const tails = ['/signin/page/infoV3', '/signin/public/record', '/signin/public/cloudRecordV2'];
  for (const t of tails) {
    assert.equal(
      sent.filter((x) => String(x.url).includes(t)).length,
      0,
      `${t} 是收尾读数，调试只跑一族时不该发`,
    );
  }
});

// ── 整条动作链（灵犀）走通一遍：这是唯一一处"真做那件事"的接线 ──────
//
// ⚠ 这一条**不碰真主机**：transport 是注入的假函数，按 URL 分派。
//   之所以现在能这么测，是因为 `desEncryptBase64` 也在本仓 —— `deriveAiAuth` 要
//   一份能解出 11 位手机号的 `account`，以前只能靠真号，现在可以自己造。

test('整条动作链：换票 → 邮箱登录 → 拿 AI 鉴权 → 聊一句 ⇒ 回读翻位算做完', async () => {
  const { desEncryptBase64 } = await import('../src/crypto/des.ts');
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
  let chatted = false;
  const phone = '13800138000';
  const account = desEncryptBase64(phone, '139_mail');
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register')) {
      registered = true;
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 0 }) };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(pageModule({ aizhushou: chatted ? 1 : 0 })),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    // ① 换邮箱 SSO
    if (url.includes('querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { token: 'SSO' } }) };
    }
    // ② 邮箱登录
    if (url.includes('inlogin.action')) {
      return { status: 200, headers: {}, body: JSON.stringify({ var: { sid: 'SID', rmkey: 'RMKEY' } }) };
    }
    // ③ queryUserToken（`account` 是 DES 密文，解出来才是手机号）
    if (url.includes('queryUserToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ var: { data: { data: { account, token: 'TOK', userDomainId: 'DOM' } } } }),
      };
    }
    // ④ 灵犀对话（SSE）
    if (url.includes('/assistant/chat/v2/add')) {
      chatted = true;
      const sse = [
        'data: {"code":"0000","message":"请求成功"}',
        'data: {"data":{"flowResult":{"outContent":"你好"}}}',
        'data: {"data":{"flowResult":{"outContent":"，我是灵犀。"}}}',
        'data: [DONE]',
      ].join('\n');
      return { status: 200, headers: {}, body: sse };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  // ⚠ `waitMs` 是**忙等**：给一个每轮 +1000ms 的假时钟，等待就不花真秒数
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  const notes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await playAiStep(deps);
    notes.push(r.note);
    if (r.ok === false && r.pending !== true) break;
    if (r.idle === true) break;
  }
  assert.equal(registered, true, '要点那件任务');
  assert.equal(chatted, true, '要真的聊一句');
  // 四段动作都发了，且顺序固定
  const order = sent.map((x) => String(x.url));
  const iSso = order.findIndex((u) => u.includes('querySpecTokenV2'));
  const iLogin = order.findIndex((u) => u.includes('inlogin.action'));
  const iToken = order.findIndex((u) => u.includes('queryUserToken'));
  const iChat = order.findIndex((u) => u.includes('/assistant/chat/v2/add'));
  assert.ok(iSso >= 0 && iLogin > iSso && iToken > iLogin && iChat > iToken, `顺序不对：${order.join('\n')}`);
  assert.ok(notes.some((n) => /做完了/.test(n)), `回读翻位要判做完：${notes.join(' | ')}`);
});

test('`PLAYAI_ACTION_KEYS` 里的钥匙必须是动作层真认识的（写错就是静默什么都不做）', async () => {
  const { firstActionStep } = await import('../src/mcloud/tasks/tokenPkActions.ts');
  const { PLAYAI_ACTION_KEYS } = await import('../src/mcloud/tasks/playAi.ts');
  for (const [taskId, key] of Object.entries(PLAYAI_ACTION_KEYS)) {
    assert.notEqual(
      firstActionStep(key),
      'done',
      `任务 ${taskId} 映射到动作 ${key}，但动作层说它一步就完（等于什么都不做）`,
    );
  }
});

// ── 三件会做的任务：偏好"不写云盘"的先做 ─────────────────────────────

test('会做的有三件（AI助手 / AI相机 / 扫描文档）；一趟先挑**不落盘**的 AI 助手', async () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 0 }) };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      // 相机那两件排在 AI 助手**前面**（照 11-26 的真实顺序）
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: {
            moduleId: '1-250730',
            drawTimes: 0,
            drawsUsed: 0,
            todayGetLotteryCount: 0,
            taskIds: [
              { id: 'aixiangji', taskName: 'AI相机，学习、翻译、问答全都有', taskSign: 0, isComplete: 0 },
              { id: '204', taskName: '扫描文档，纸质文件秒变电子档', taskSign: 0, isComplete: 0 },
              { id: 'aizhushou', taskName: 'AI助手，打工人必备神器', taskSign: 0, isComplete: 0 },
            ],
          },
        }),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 500, msg: 'no' }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  await playAiStep(deps); // list
  const r = await playAiStep(deps); // register
  assert.ok(r.ok, r.note);
  const reg = sent.find((x) => String(x.url).includes('/page/register'))!;
  assert.deepEqual(JSON.parse(String(reg.body)), { moduleId: '1-250730', taskId: 'aizhushou' },
    '先挑不写云盘的那件');
});

test('挑到 AI 相机那件时：整条链走完、文件登记、回读翻位才算做完', async () => {
  const { desEncryptBase64 } = await import('../src/crypto/des.ts');
  const { ownedFileIds } = await import('../src/mcloud/tasks/ownedFiles.ts');
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const account = desEncryptBase64('13800138000', '139_mail');
  const sent: BuiltRequest[] = [];
  let chatted = false;
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 0 }) };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: {
            moduleId: '1-250730',
            drawTimes: 0,
            drawsUsed: 0,
            todayGetLotteryCount: 0,
            taskIds: [
              { id: 'aixiangji', taskName: 'AI相机', taskSign: 0, isComplete: chatted ? 1 : 0 },
            ],
          },
        }),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    if (url.includes('querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { token: 'SSO' } }) };
    }
    if (url.includes('inlogin.action')) {
      return { status: 200, headers: {}, body: JSON.stringify({ var: { sid: 'S', rmkey: 'R' } }) };
    }
    if (url.includes('queryUserToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ var: { data: { data: { account, token: 'T', userDomainId: 'D' } } } }),
      };
    }
    if (url.includes('aiRecognize')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { fileId: 'IMG1', taskId: '9' } }) };
    }
    if (url.includes('assistant/chat/v2/add')) {
      chatted = true;
      return { status: 200, headers: {}, body: 'data: {"data":{"flowResult":{"outContent":"hi"}}}\n' };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  const notes: string[] = [];
  for (let i = 0; i < 14; i++) {
    const r = await playAiStep(deps);
    notes.push(r.note);
    if (r.ok === false && r.pending !== true) break;
    if (r.idle === true) break;
  }
  assert.ok(sent.some((x) => String(x.url).includes('aiRecognize')), '要识图');
  assert.deepEqual(ownedFileIds(deps), ['IMG1'], '落的那张图要登记（否则永远不删）');
  assert.ok(notes.some((n) => /做完了/.test(n)), `回读翻位要判做完：${notes.join(' | ')}`);
});

test('相机链被打断时，那张图要算"还在用"—— 清理不能把它删了（否则下一趟没得用）', async () => {
  const { activePlayAiFileId } = await import('../src/mcloud/tasks/playAi.ts');
  const { savePlayAi } = await import('../src/mcloud/playAiState.ts');
  const store = memStore();
  store.ensureSchema();
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport: (() => ({ status: 200, headers: {}, body: '{}' })) as never,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  // ① 识图完、还没对话 ⇒ 这张图"还在用"
  savePlayAi(
    store,
    {
      day: NOW.slice(0, 10),
      phase: 'act',
      modules: [],
      lines: [],
      at: NOW,
      target: { moduleId: '1-250730', taskId: 'aixiangji', name: 'AI相机', actionKey: 'aiCamera' },
      attempt: { taskId: 0, name: 'AI相机', key: 'aiCamera', step: 'ai-camera-chat', data: { fileId: 'IMG1' } },
    },
    NOW,
  );
  assert.equal(activePlayAiFileId(deps), 'IMG1');

  // ② 已经收尾 ⇒ 不算在用（该清就清）
  savePlayAi(
    store,
    {
      day: NOW.slice(0, 10),
      phase: 'done',
      modules: [],
      lines: [],
      at: NOW,
      attempt: { taskId: 0, name: 'AI相机', key: 'aiCamera', step: 'ai-camera-chat', data: { fileId: 'IMG1' } },
    },
    NOW,
  );
  assert.equal(activePlayAiFileId(deps), undefined);

  // ③ 不是相机那条链（AI 助手不落文件）⇒ 也不算
  savePlayAi(
    store,
    {
      day: NOW.slice(0, 10),
      phase: 'act',
      modules: [],
      lines: [],
      at: NOW,
      attempt: { taskId: 0, name: 'AI助手', key: 'aiAssistant', step: 'ai-chat', data: {} },
    },
    NOW,
  );
  assert.equal(activePlayAiFileId(deps), undefined);
});

test('动作没成 ⇒ 不等那 3 秒、也不多读一次（服务端不会因为等一会儿就翻位）', async () => {
  // 夹具里动作链一律回 500 ⇒ actOk=false
  // ⚠ 2026-11-26 起：一件没翻位**不再收工**，会接着挑下一件（夹具里会一直挑到做满或没得做）。
  //   所以这里不能钉"总共只读 2 次"——那个数会跟着做几件变。要钉的是**每一件**：
  //   动作没成时那件**只读一次**（list 一次 + verify 一次），不该出现"再读一次"。
  const { deps, sent } = harness({ flip: false });
  const notes: string[] = [];
  for (let i = 0; i < PLAYAI_MAX_STEPS + 4; i++) {
    const r = await playAiStep(deps);
    notes.push(r.note);
    if (r.idle === true) break;
  }
  // ⚠ 转写（`taskSign=2`）**会**等一次：它是"提交完成口、服务端事后翻位"，
  //   与动作链"动作没成就不用等"不是一回事。所以这里只钉"动作链那几件不等"。
  const transcriptionPending = notes.some((n) => /AI录音转写/.test(n));
  if (!transcriptionPending) {
    assert.equal(notes.some((n) => /再读一次/.test(n)), false, '动作没成时不该出现"再读一次"');
  }
  // ⚠ 不钉"总共读几次"：一趟会连做几件、每件回 `list` 都要重读一次模块，
  //   总数是个会变的账（改件数就得改测试，而那时该守的判据没变）。
  //   真正要守的是**那句行为**：动作没成 ⇒ 那件不"再读一次"。
  //   上面已经断言过 `再读一次` 不出现（转写那件除外），这里只补一句"确实做过"，
  //   免得这条测试在"一件都没做"时也绿。
  assert.ok(
    sent.some((x) => String(x.url).includes('/funai/api/page/getmodule')),
    '至少读过一次模块表',
  );
});

test('同一件任务出现在两个模块里：任一模块完成/点过，就整件跳过（规则：相同任务只算 1 次）', async () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/register')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 0 }) };
    }
    if (url.includes('/funai/api/page/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: {
            moduleId: '1-250730',
            drawTimes: 0,
            drawsUsed: 0,
            todayGetLotteryCount: 0,
            // 页面模块里 `aizhushou` **已完成**
            taskIds: [{ id: 'aizhushou', taskName: 'AI助手', taskSign: 0, isComplete: 1 }],
          },
        }),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: [
            {
              moduleId: '2-261104-1',
              subtitle: '假日出行助手',
              drawTimes: null,
              drawsUsed: null,
              todayGetLotteryCount: null,
              // 主题模块里同一件还是"未完成" —— 不许因为换了 moduleId 再点一次
              taskIds: [{ id: 'aizhushou', taskName: 'AI助手', taskSign: 0, isComplete: 0 }],
            },
          ],
        }),
      };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;
  await playAiStep(deps); // list
  await playAiStep(deps);
  assert.equal(
    sent.filter((x) => String(x.url).includes('/page/register')).length,
    0,
    '任一模块里已完成 ⇒ 整件跳过，不该再点',
  );
});

test('活动已结束 ⇒ 不点、不抽，只留一句「已结束」', async () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: {
            moduleId: '1-250730',
            // 结束时间已经过了
            endTime: '2026-11-01T23:59:59',
            flag: 1,
            drawTimes: 3,
            drawsUsed: 0,
            todayGetLotteryCount: 3,
            taskIds: [{ id: 'aizhushou', taskName: 'AI助手', taskSign: 0, isComplete: 0 }],
          },
        }),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;
  // 代抽开着也不该抽
  const { setPlayAiDrawEnabled } = await import('../src/mcloud/playAiState.ts');
  setPlayAiDrawEnabled(store, true, NOW);

  const notes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await playAiStep(deps);
    notes.push(r.note);
    if (r.idle === true) break;
  }
  assert.equal(sent.filter((x) => String(x.url).includes('/page/register')).length, 0, '不该点任务');
  assert.equal(sent.filter((x) => String(x.url).includes('/page/lottery')).length, 0, '不该抽奖');
  assert.ok(notes.some((n) => /已结束/.test(n)), notes.join(' | '));
});

test('⚠ 失败时那一步的 note 必须是**失败原因**，不能是读数那一句', async () => {
  // 现场（2026-11-26，用 scripts/check-playai.sh 翻实例日志）：
  //   「趣玩AI：没成 —— 4 个模块 · 24 件任务 · 22 件可做 …」
  // 读数是**成功**读到的，可它被当成了失败原因写出来 —— 真正的失败（上报被拒 / 动作链断在哪）
  // 被 `snap.line` 盖掉了。
  const { runDaily } = await import('../src/mcloud/dailyRun.ts');
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState(STATE_JWT, JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  const transport = ((req: BuiltRequest) => {
    const url = String(req.url);
    if (url.includes('/funai/api/page/getmodule')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(pageModule({ aizhushou: 0 })),
      };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    if (url.includes('/funai/api/page/register')) {
      // 写口被拒
      return { status: 200, headers: {}, body: JSON.stringify({ code: 40000, msg: '不行' }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  const r = await runDaily(deps, { only: ['playAI'], force: true });
  const step = r.steps.find((s) => s.name === '趣玩AI')!;
  assert.equal(step.ok, false, '写口被拒 ⇒ 这一步是失败');
  assert.match(step.note, /上报被拒|没成/, `note 要是失败原因：${step.note}`);
  assert.equal(/个模块 · .*件任务/.test(step.note), false, `note 不该是读数：${step.note}`);
});

test('⚠ 调试只跑趣玩AI 时，**必须**去换票（它读模块与点任务用的就是 sign-in 那张）', async () => {
  // 现场（2026-11-26 22:42，真号）：日志是「读数 ok=True（24 件任务）」+「上报被拒：服务端说 未登录」。
  // 真因：`needTicket` 的名单里**漏了 playAI** ⇒ 调试只跑这一族时整段换票被跳过，
  // 用的是残留的过期票；读口拿过期票也回数据，写口直接 `90001 未登录`。
  // 表现极容易带偏：看着像"写口要另一套鉴权"或"灵犀对话不算"。
  const { runDaily } = await import('../src/mcloud/dailyRun.ts');
  const store = memStore();
  store.ensureSchema();
  // 只给会话与**原生凭据**、不给 H5 票 —— 换票该自己去换一张回来。
  // ⚠ 原生凭据不能少：`needExchange()` 第一条就是"没凭据 ⇒ 换不了，也别报错"。
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: '', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  store.setState('mcloud.h5.auth', 'Basic ZmFrZS1hdXRo', NOW);
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify(pageModule({ aizhushou: 0 })) };
    }
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  let fake = Date.parse(NOW);
  const deps = {
    store,
    transport,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => (fake += 1000),
    baseUrl: undefined,
  } as unknown as TaskDeps;

  const r = await runDaily(deps, { only: ['playAI'], force: true });
  // 换票那一步**不能**是「这次只跑了不需要它的族」
  const swap = r.steps.find((s) => s.name.startsWith('换票'));
  assert.ok(swap !== undefined, '要有换票那一步');
  assert.equal(
    /不需要它/.test(swap!.note),
    false,
    `只跑趣玩AI 时换票被跳过了：${swap!.note}`,
  );
  // 并且真的为它发过换票请求（`tyrzLogin` / `querySpecToken` 那一族）
  assert.ok(
    sent.some((x) => /tyrzLogin|querySpecToken/.test(String(x.url))),
    '没有为趣玩AI 发过换票请求',
  );
});

test('⚠ 每一步都要进 debug 日志（`onStep` 没给的话只看得到最后那句结论）', async () => {
  // 2026-11-27 用户问「为啥没有 debug 日志」：别的族（任务拓展 / App 任务 / 红包派对 /
  // 算力）都给了 `onStep`，只有趣玩AI 漏了 —— 日志里只有「4 个模块 · 24 件任务 …」
  // 这一句结论，中间「准备做 / 已上报 / 回读还没翻位 / 接着做下一件」全没了。
  const { playAiStepLine } = await import('../src/mcloud/dailyRun.ts');
  // 尾巴是读数 ⇒ 截掉
  assert.equal(
    playAiStepLine('准备做「AI助手」（4 个模块 · 24 件任务 · 22 件可做）'),
    '准备做「AI助手」',
  );
  assert.equal(
    playAiStepLine('「AI助手」已上报，服务端还没认 —— 4 个模块 · 24 件任务 · 22 件可做'),
    '「AI助手」已上报，服务端还没认',
  );
  // 尾巴是**真原因**（不是读数）⇒ 留着
  assert.equal(
    playAiStepLine('做「AI助手」那一步没成：灵犀：querySpecTokenV2 失败'),
    '做「AI助手」那一步没成：灵犀：querySpecTokenV2 失败',
  );
  // 没有 ` —— ` 的原样返回
  assert.equal(playAiStepLine('「AI相机」做完了（回读已翻位）'), '「AI相机」做完了（回读已翻位）');
});

test('⚠ 趣玩AI 的 `drain` 必须给 `onStep`（不给就只看得到最后那句结论）', async () => {
  // 2026-11-27 用户问「为啥没有 debug 日志」：`drain(playAiStep, …)` 没传 `onStep`，
  // 而任务拓展 / App 任务 / 红包派对 / 算力**都传了**。于是这一族的日志里只有
  // 「4 个模块 · 24 件任务 …」，中间「准备做 / 已上报 / 回读还没翻位」全没了。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/mcloud/dailyRun.ts', 'utf8');
  const at = src.indexOf('drain(playAiStep');
  assert.ok(at > 0, '找不到趣玩AI 的 drain 调用');
  const block = src.slice(at, at + 400);
  assert.match(block, /onStep:/, '趣玩AI 的 drain 要给 onStep —— 否则过程行不进日志');
  // 尾巴那串读数要截掉（结论行已经报过）—— 见 `playAiStepLine`
  assert.match(block, /playAiStepLine\(/, 'onStep 里要用 playAiStepLine 截掉读数尾巴');
});

test('⚠ CLI 也要把过程行打出来（面板一直有，两端该一致）', async () => {
  const { readFileSync } = await import('node:fs');
  const cli = readFileSync('src/standalone/mcloudSign.ts', 'utf8');
  assert.match(cli, /runDailyAll\(rt, \{[\s\S]{0,300}onNote:/, 'CLI 要把 onNote 接上');
  const daily = readFileSync('src/standalone/daily.ts', 'utf8');
  assert.match(daily, /onNote\?:/, '`runDailyAll` 要收 onNote');
  assert.match(daily, /opts\.onNote === undefined \? \{\} : \{ onNote: opts\.onNote \}/, '要把它传进 runOpts');
});
