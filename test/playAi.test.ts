// 趣玩AI 的**读数层**：解析、汇总、那两行文案。
//
// 这一篇的重点不是"能不能解析"，而是**给用户看的那两行**：
//   · 级别必须是 info（读数），不能因为「要手动」被涂成黄；
//   · 不许出现 `moduleId`（`1-250730` 这种是我们对号用的，用户不认）；
//   · 任务名要短名（上游给的是整句营销词「智能抠图，一键抠图超轻松」）。
//
// 样本取自 `mcloud-capture/mcloud/capture/app-playai-2026-11-26-samples.txt`（真实响应裁剪）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYAI_DAILY_CHANCE_CAP,
  pageModuleRequest,
  parseDraw,
  pageModule,
  parseModules,
  readingLine,
  registerRequest,
  shortTaskName,
  summarize,
  timedModuleRequest,
} from '../src/mcloud/playAi.ts';
import { lineLevel } from '../src/mcloud/tasks/stepLog.ts';
import { PLAYAI_ACTION_KEYS } from '../src/mcloud/tasks/playAi.ts';

/** 2026-11-26 实拍：页面模块（15 件）+ 主题模块（3 × 3 件）。这里只留判据字段。 */
const PAGE = {
  moduleId: '1-250730',
  subtitle: '趣玩AI赢好礼',
  startTime: '2025-05-28T00:00:00',
  endTime: '2026-12-31T23:59:59',
  drawTimes: 0,
  drawsUsed: 0,
  todayGetLotteryCount: 0,
  isDraw: null,
  taskIds: [
    { id: '003', taskName: '智能抠图，一键抠图超轻松', taskSign: 0, isComplete: 0, innerLink: 'https://yun.139.com/aiTools/#/faceMattin' },
    { id: '204', taskName: '扫描文档，纸质文件秒变电子档', taskSign: 0, isComplete: 0, innerLink: 'mcloud://main/aiCamera' },
    { id: 'invite', taskName: '邀请好友，一起趣玩AI', taskSign: 1, isComplete: 0, innerLink: '' },
    { id: 'aizhushou', taskName: 'AI助手，打工人必备神器', taskSign: 0, isComplete: 1, innerLink: 'mcloud://main/aiAssistantGlobal' },
  ],
};

const TIMED = [
  {
    moduleId: '2-261104-3',
    subtitle: '职场达人养成',
    taskIds: [
      { id: 'ailuyinzhuanxie', taskName: 'AI录音转写', taskSign: 2, isComplete: 0, innerLink: 'mcloud://main/featureServices' },
    ],
  },
];

test('解析：两口同形，单对象与数组都吃得下；主题模块的计数是 null 不是 0', () => {
  const page = parseModules(PAGE);
  assert.equal(page.length, 1);
  assert.equal(page[0]!.moduleId, '1-250730');
  assert.equal(page[0]!.tasks.length, 4);
  assert.equal(page[0]!.drawTimes, 0, '页面模块的 0 是真的 0');

  const timed = parseModules(TIMED);
  assert.equal(timed.length, 1);
  assert.equal(timed[0]!.drawTimes, null, '主题模块没有这几个计数 —— 是 null，别当 0');

  assert.deepEqual(parseModules(null), []);
  assert.deepEqual(parseModules({}), [], '没有 moduleId 的对象不算一个模块');
});

test('`taskSign` 缺省给 9（未知档），不许退化成 0 —— 0 意味着"可以 register"', () => {
  const m = parseModules({ moduleId: 'x', taskIds: [{ id: 'a', taskName: 'A' }] });
  assert.equal(m[0]!.tasks[0]!.taskSign, 9);
});

test('汇总：可做 / 要手动 / 已完成分开数（`taskSign≠0` 一件都不算可做）', () => {
  const r = summarize([...parseModules(PAGE), ...parseModules(TIMED)]);
  assert.equal(r.total, 5);
  assert.equal(r.done, 1, 'aizhushou 已完成');
  assert.equal(r.runnable, 2, '003 / 204 可做');
  assert.equal(r.manual, 2, 'invite（sign 1）+ ailuyinzhuanxie（sign 2）');
  assert.equal(r.canDraw, 0);
  assert.equal(r.todayGot, 0);
});

test('读数那一行：级别是 **info**，不是黄（"要手动"不是"要你现在去做"）', () => {
  const line = readingLine(summarize([...parseModules(PAGE), ...parseModules(TIMED)]));
  assert.equal(line, '2 个模块 · 5 件任务 · 1 件已完成 · 2 件可做 · 2 件要手动 · 今日已得 0 次（上限 5）');
  assert.equal(lineLevel(`趣玩AI：${line}`), 'info', `读数不该被涂黄：${lineLevel(`趣玩AI：${line}`)}`);
});

test('读数那一行**不含** moduleId（`1-250730` 是我们对号用的，用户不认）', () => {
  const line = readingLine(summarize([...parseModules(PAGE), ...parseModules(TIMED)]));
  assert.equal(/\d-\d{6}/.test(line), false, line);
});

test('任务名取短名：上游给的是整句营销词', () => {
  assert.equal(shortTaskName('智能抠图，一键抠图超轻松'), '智能抠图');
  assert.equal(shortTaskName('扫描文档,纸质文件秒变电子档'), '扫描文档');
  assert.equal(shortTaskName('AI录音转写'), 'AI录音转写');
  assert.equal(shortTaskName(''), '');
});

test('请求形状：两口的 `showloading` 不一样（实拍 page=true / timed=false）', () => {
  const s = { jwt: 'JWT' };
  assert.equal(pageModuleRequest(s, 'https://m.example.com').headers['showloading'], 'true');
  assert.equal(timedModuleRequest(s, 'https://m.example.com').headers['showloading'], 'false');
  // ⚠ `activityid` **不发**：两轮实拍撞出两个不同的值（`sign_in_3` / `National_TokenPK`），
  //   同一批端点都 `code:0` ⇒ 上游不看它。编一个值就是猜（第一版硬编过 `sign_in_3`）。
  assert.equal(pageModuleRequest(s).headers['activityid'], undefined);
  // 写口：两键 body + JSON 头 + origin（实拍逐字）
  const reg = registerRequest(s, '1-250730', '204', 'https://m.example.com');
  assert.equal(reg.method, 'POST');
  assert.deepEqual(JSON.parse(String(reg.body)), { moduleId: '1-250730', taskId: '204' });
  assert.equal(reg.headers['content-type'], 'application/json;charset=UTF-8');
  assert.equal(reg.headers['origin'], 'https://m.mcloud.139.com');
  assert.equal(reg.headers['showloading'], 'true');
});

test('规则里的日上限是个常量，写在模块里（别散在调用点）', () => {
  assert.equal(PLAYAI_DAILY_CHANCE_CAP, 5);
});

// ── 抽奖回执：四份**真样本**（2026-09-25 的 HAR，号码已按仓库口径换成合成掩码）──

/** 中奖（云盘专属AI豆） */
const WIN_AI_DOU = {
  code: 0,
  msg: 'success',
  result: {
    id: 4226417,
    phone: '138****0000',
    type: '1',
    moduleId: '1-250730',
    lotteryDate: '20260925',
    isWin: 1,
    prizeId: 250624008,
    prizeName: '20云盘专属AI豆',
    prizeUrl: 'https://img.mcloud.139.com//uop_prod/20260730/x.png',
    prizeType: 2,
    lotteryTime: '2026-09-25T20:21:39.009960926',
    marketName: 'National_playAI',
    source: '0',
  },
};

/** 中奖（支付宝话费红包）—— 注意它的 `prizeType` 是 **1** */
const WIN_REDPACK = {
  code: 0,
  msg: 'success',
  result: {
    id: 4226316,
    isWin: 1,
    prizeId: 260907027,
    prizeName: '0.41元支付宝话费红包',
    prizeUrl: 'https://img.mcloud.139.com//uop_prod/20260907/y.png',
    prizeType: 1,
    lotteryTime: '2026-09-25T19:50:09.408316866',
    marketName: 'National_playAI',
  },
};

/** 没中：三键全 `null`，而 `prizeType` **仍然是 1** */
const LOSE = {
  code: 0,
  msg: 'success',
  result: {
    id: 10657867,
    isWin: 0,
    prizeId: null,
    prizeName: null,
    prizeUrl: null,
    prizeType: 1,
    lotteryTime: '2026-09-25T20:21:43.238687928',
    marketName: 'National_playAI',
  },
};

test('抽奖回执（真样本）：中没中只看 `isWin`', () => {
  assert.deepEqual(parseDraw(WIN_AI_DOU.result), { win: true, prizeName: '20云盘专属AI豆', prizeType: 2 });
  assert.deepEqual(parseDraw(WIN_REDPACK.result), {
    win: true,
    prizeName: '0.41元支付宝话费红包',
    prizeType: 1,
  });
  assert.deepEqual(parseDraw(LOSE.result), { win: false, prizeName: '', prizeType: 1 });
});

test('⚠ `prizeType` 不是"有没有奖"的信号：中奖那份和没中那份都是 `1`', () => {
  // 这两份真样本把这条钉死 —— 拿 prizeType 判会把这个红包判成"没中"
  assert.equal(parseDraw(WIN_REDPACK.result).prizeType, 1);
  assert.equal(parseDraw(LOSE.result).prizeType, 1);
  assert.equal(parseDraw(WIN_REDPACK.result).win, true);
  assert.equal(parseDraw(LOSE.result).win, false);
});

test('抽奖回执：缺 `isWin` / 别的值 ⇒ `null`（判不出来就别当成功）', () => {
  assert.equal(parseDraw({ prizeType: 1 }).win, null);
  assert.equal(parseDraw({ isWin: 'yes' }).win, null);
  assert.equal(parseDraw(null).win, null);
  // 数字串也认（上游两种都见过）
  assert.equal(parseDraw({ isWin: '1' }).win, true);
  assert.equal(parseDraw({ isWin: '0' }).win, false);
});

test('认"门户页那个模块"看的是计数有没有值，**不看 `moduleId` 前缀**', () => {
  // 故意造一个 id 以 `2-` 开头的**页面**模块：按前缀猜会挑错，按 `drawTimes` 就不会
  const odd = parseModules({
    moduleId: '2-weird-page',
    drawTimes: 3,
    drawsUsed: 1,
    todayGetLotteryCount: 4,
    taskIds: [],
  });
  const timed = parseModules([{ moduleId: '1-weird-timed', taskIds: [] }]);
  const all = [...odd, ...timed];
  assert.equal(pageModule(all)?.moduleId, '2-weird-page', '有计数的那一个才是页面模块');
  // 抽奖要用的就是它
  assert.equal(summarize(all).canDraw, 3);
  assert.equal(summarize(all).todayGot, 4);
});

test('没有票那一条要能被"级联折叠"识别（否则会话坏了会刷一屏"没成"）', async () => {
  const { lineText, lineLevel } = await import('../src/mcloud/tasks/stepLog.ts');
  // 会话坏了的时候：换票已经单独一行 fail，下面每一族都只是"没跑"，不是"失败"
  const raw = '趣玩AI：没成 —— 还没有网页会话（票没换成）—— 这一族这次没做';
  assert.equal(lineText(raw), '趣玩AI：跳过（没有网页会话）');
  // 折叠之后不再是失败色
  assert.notEqual(lineLevel(lineText(raw)), 'fail');
});

// ── 真实响应（2026-11-26 实拍裁出来的判据字段）──────────────────────
//
// 上面那些 fixture 是我手写的"最小形状"；这一份是**真实报文**裁出来的：
// 页面模块 15 件任务、主题模块 3 个各 3 件，`drawTimes/drawsUsed/todayGetLotteryCount`
// 在主题模块里是 `null`。手写的 fixture 永远可能"刚好合我的解析器"，真实报文不会。

test('真实报文（2026-11-26 实拍）：15 件 + 3 个主题模块，数字对得上', async () => {
  const fs = await import('node:fs');
  const raw = JSON.parse(
    fs.readFileSync('test/fixtures/playai-getmodule-20261126.json', 'utf8'),
  ) as { page: unknown; timed: unknown[] };

  const page = parseModules(raw.page);
  assert.equal(page.length, 1);
  assert.equal(page[0]!.moduleId, '1-250730');
  assert.equal(page[0]!.tasks.length, 15, '页面模块 15 件任务');
  assert.equal(page[0]!.drawTimes, 0);
  assert.equal(page[0]!.todayGetLotteryCount, 0);

  const timed = parseModules(raw.timed);
  assert.equal(timed.length, 3, '主题模块 3 个');
  for (const m of timed) {
    assert.equal(m.tasks.length, 3, `${m.moduleId} 应有 3 件任务`);
    assert.equal(m.drawTimes, null, '主题模块的计数是 null，不是 0');
    assert.equal(m.todayGetLotteryCount, null);
  }

  const all = summarize([...page, ...timed]);
  assert.equal(all.total, 24, '15 + 9');
  assert.equal(all.done, 0, '这一期实拍里一件都没完成');
  // 真实报文里 `invite` 是 taskSign 1、`ailuyinzhuanxie` 是 taskSign 2 ⇒ 都算"要手动"
  assert.equal(all.manual, 2);
  assert.equal(all.runnable, 22);
  assert.equal(all.canDraw, 0);
});

test('真实报文里"我们会做"的那三件都在（AI助手 / AI相机 / 扫描文档）', async () => {
  const fs = await import('node:fs');
  const raw = JSON.parse(
    fs.readFileSync('test/fixtures/playai-getmodule-20261126.json', 'utf8'),
  ) as { page: unknown };
  const ids = parseModules(raw.page)[0]!.tasks.map((t) => t.id);
  for (const id of Object.keys(PLAYAI_ACTION_KEYS)) {
    assert.ok(ids.includes(id), `真实报文里应该有 ${id}（否则映射白写）`);
  }
});

// ── 活动结束之后别再假装在干活（R9 同一条口径）──────────────────────

test('活动还没结束 ⇒ 活着；结束时间过了 / flag=0 / 没读到模块 ⇒ 停', async () => {
  const { activityState } = await import('../src/mcloud/playAi.ts');
  const NOW = Date.parse('2026-11-26T00:00:00Z');
  const mod = (extra: Record<string, unknown> = {}) =>
    parseModules({
      moduleId: '1-250730',
      drawTimes: 0,
      drawsUsed: 0,
      todayGetLotteryCount: 0,
      endTime: '2026-12-31T23:59:59',
      flag: 1,
      taskIds: [],
      ...extra,
    });

  assert.equal(activityState(mod(), NOW).live, true);
  const ended = activityState(mod({ endTime: '2026-11-01T00:00:00' }), NOW);
  assert.equal(ended.live, false);
  assert.match(ended.why, /已结束/);
  assert.equal(activityState(mod({ flag: 0 }), NOW).live, false);
  assert.match(activityState(mod({ flag: 0 }), NOW).why, /下线/);
  // 没读到模块 ⇒ 也不能算"活着"
  assert.equal(activityState([], NOW).live, false);
  // 结束时间解析不出来 ⇒ 当它还在（宁可多跑一趟，也别把好活动停掉）
  assert.equal(activityState(mod({ endTime: '不是时间' }), NOW).live, true);
});
