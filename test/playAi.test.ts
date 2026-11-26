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
  parseModules,
  readingLine,
  registerRequest,
  shortTaskName,
  summarize,
  timedModuleRequest,
} from '../src/mcloud/playAi.ts';
import { lineLevel } from '../src/mcloud/tasks/stepLog.ts';

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
  assert.equal(line, '2 个模块 · 5 件任务 · 1 件已完成 · 2 件可做 · 2 件要手动 · 今日已得 0 次');
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
