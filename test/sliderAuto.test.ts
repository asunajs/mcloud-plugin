// 自动过滑块：**一次点击**发码，滑块由后端自己过（F-073）。
//
// 用户的原话：「手机号登录需要滑块，你这是让我肉眼看像素吗，看看 mcloud 怎么实现的，
// pc/mobile 都是」。
//
// 参考实现（`mcloud-capture/docs/upstream/app-sms-login.md` §7.2）是**协议优先**：
// `200059554` 之后自动取图 → 解坐标 → 带答案重发，人只负责等短信。
// 而坐标**本来就是解出来的**（`puzzleLeft` 是 AES 密文，见 `sliderAnswer`）——
// 界面上摆一张图，等于让用户去干一件机器已经干完的事。
//
// 这一组测试钉住四件事：
//   ① PC 一条：首次被拦 ⇒ 自动取题 ⇒ 带答案重发 ⇒ `sent`（**一次**接口调用）
//   ② 手机端一条：同上（答案走 `puzzleVerfycodeEncrypt`）
//   ③ 上限：一直拦 ⇒ 两轮后放弃，说人话，不假装成功
//   ④ 旧题作废（`200059553`）⇒ 换**新**题（取两次题）后成功

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import { memStore } from '../src/store/memory.ts';
import { decryptWithDynamicIv } from '../src/crypto/aes.ts';
import { utf8 } from '../src/crypto/bytes.ts';
import {
  APP_SLIDER_PUZZLE_PATH,
  appSendSmsCodeRequest,
} from '../src/mcloud/appLogin.ts';
import {
  PUZZLE_AES_IV,
  PUZZLE_AES_KEY,
  SLIDER_PUZZLE_PATH,
  puzzleVerfycodeEncrypt,
} from '../src/mcloud/login.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { Store } from '../src/store/types.ts';

const BASE = '/plugins/mcloud/api';
const NOW = '2026-10-16T01:00:00.000Z';
const ANSWER = '466';

/** 一道题的响应体（形状照实测：`picWidth` 是字符串、`puzzleLeft` 是密文）。 */
function puzzleBody(answer = ANSWER): string {
  return JSON.stringify({
    success: true,
    code: '0000',
    data: {
      picture: 'JPEG',
      puzzle: 'PIECE',
      picWidth: '640',
      puzzleWidth: '44',
      puzzleLeft: puzzleVerfycodeEncrypt(answer),
    },
  });
}

/** 把 `puzzleVerfycode` 解回坐标（判据不是"字段非空"，而是"解出来对不对"）。 */
function answerOf(field: string): string {
  return decryptWithDynamicIv(utf8(PUZZLE_AES_KEY), field).trim();
}

type Entry = ReturnType<typeof mcloudRoutes>[number];

function entryOf(rs: Entry[], path: string, method = 'POST'): Entry {
  const r = rs.find((x) => x.path === `${BASE}${path}` && x.method === method);
  assert.ok(r, `没有路由 ${method} ${path}`);
  return r;
}

function post(rs: Entry[], path: string, body?: unknown): any {
  const r = entryOf(rs, path);
  const res = r.handler({ method: 'POST', path: r.path, body: body === undefined ? '' : JSON.stringify(body) });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

/** 一个"风控挡着"的上游：前 `blocked` 次发码回 200059554，之后放行。 */
function gatedTransport(opts: {
  seen: BuiltRequest[];
  blocked: number;
  /** 第几次发码回"旧题作废"（1 基；0 = 从不） */
  exhaustedAt?: number;
  /** 每题解出来的坐标（按取题顺序） */
  answers?: string[];
  /** 连"带答案"的那一发也拦（模拟"这道题怎么过都不过"） */
  alwaysBlock?: boolean;
}): Transport {
  let sends = 0;
  let puzzles = 0;
  return (req) => {
    opts.seen.push(req);
    if (req.url.endsWith(SLIDER_PUZZLE_PATH) || req.url.endsWith(APP_SLIDER_PUZZLE_PATH)) {
      const a = opts.answers?.[puzzles] ?? ANSWER;
      puzzles += 1;
      return { status: 200, headers: {}, body: puzzleBody(a) };
    }
    sends += 1;
    // 带答案的那一发：解一下对不对（判据要"有牙"）
    const raw = req.body ?? '';
    const m = /"puzzleVerfycode":"([^"]*)"/.exec(raw);
    const field = m?.[1] ?? '';
    if (opts.alwaysBlock) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: false, code: '200059554', message: '请先获取滑块拼图验证码' }) };
    }
    if (field !== '') {
      // App 那条体是密文，PC 那条是明文 JSON —— 两种都解不出来的话就是"答案没带上"
      const ok = field !== '';
      if (opts.exhaustedAt !== undefined && sends === opts.exhaustedAt) {
        return { status: 200, headers: {}, body: JSON.stringify({ success: false, code: '200059553', message: '滑块已失效' }) };
      }
      if (!ok) return { status: 200, headers: {}, body: JSON.stringify({ success: false, code: '200059554', message: '请先获取滑块拼图验证码' }) };
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { remainGetTimes: 8 } }) };
    }
    if (sends <= opts.blocked) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: false, code: '200059554', message: '请先获取滑块拼图验证码' }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { remainGetTimes: 8 } }) };
  };
}

test('⚠ PC：一次点击就把滑块过了（自动取题 → 解坐标 → 带答案重发）', () => {
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  const rs = mcloudRoutes(testDeps(store, { transport: gatedTransport({ seen, blocked: 1 }), now: NOW }));
  post(rs, '/login/sms/start', { phone: '13800000000', pcPlatform: 'win' });

  const r = post(rs, '/login/sms/send');
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, true, `一次点击就该发出去：${JSON.stringify(r.json)}`);
  assert.ok(!('needSlider' in r.json), '不该再把"要滑块"抛给界面');

  // 上游看到的三枪：发码(空) → 取题 → 发码(带答案)
  const kinds = seen.map((x) => (x.url.endsWith(SLIDER_PUZZLE_PATH) ? '题' : '码'));
  assert.deepEqual(kinds, ['码', '题', '码'], `上游请求顺序不对：${JSON.stringify(kinds)}`);
  // 第二枪的答案必须**真的解得回来**（判据不是"字段非空"）
  const body2 = JSON.parse(seen[2]!.body ?? '{}') as Record<string, string>;
  assert.equal(answerOf(body2['puzzleVerfycode'] ?? ''), ANSWER, '带上去的坐标不对');
});

test('⚠ 手机端：同样一次点击过完（答案走 `puzzleVerfycodeEncrypt`）', () => {
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  const rs = mcloudRoutes(testDeps(store, { transport: gatedTransport({ seen, blocked: 1 }), now: NOW }));
  post(rs, '/login/app/start', { phone: '13800000000' });

  const r = post(rs, '/login/app/send');
  assert.equal(r.json.sent, true, `手机端一次点击就该发出去：${JSON.stringify(r.json)}`);
  const kinds = seen.map((x) => (x.url.endsWith(APP_SLIDER_PUZZLE_PATH) ? '题' : '码'));
  assert.deepEqual(kinds, ['码', '题', '码'], `上游请求顺序不对：${JSON.stringify(kinds)}`);
  const body2 = JSON.parse(seen[2]!.body ?? '{}') as Record<string, string>;
  assert.equal(answerOf(body2['puzzleVerfycode'] ?? ''), ANSWER, '带上去的坐标不对');
  // ⚠ `getSmsCode` 的体是**明文**（抓包 §4.1 就是这个形状）；加密的只有 `thirdlogin`
  assert.equal(body2['phoneNumber'], '13800000000', 'App 发码体里要有手机号');
});

test('⚠ 一直拦：两轮之后**放弃并说人话**（不许假装成功、也不许无限重试）', () => {
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  // 全部拦下（blocked 设很大）
  const rs = mcloudRoutes(
    testDeps(store, { transport: gatedTransport({ seen, blocked: 99, alwaysBlock: true }), now: NOW }),
  );
  post(rs, '/login/sms/start', { phone: '13800000000', pcPlatform: 'win' });
  const r = post(rs, '/login/sms/send');
  assert.equal(r.json.sent, undefined, `没发出去就不能报 sent：${JSON.stringify(r.json)}`);
  assert.match(r.json.note, /两轮/, `要说清放弃了：${r.json.note}`);
  // 上限 2 轮 ⇒ 最多 2 次取题（滑块**计失败次数**，无限重试会把配额烧光）
  const puzzleCalls = seen.filter((x) => x.url.endsWith(SLIDER_PUZZLE_PATH)).length;
  assert.equal(puzzleCalls, 2, `取题次数：${puzzleCalls}（应为 2）`);
});

test('⚠ 旧题作废（200059553）⇒ 换**新**题，不是拿旧答案再试', () => {
  const store: Store = memStore();
  const seen: BuiltRequest[] = [];
  // 第一次带答案的那发回 200059553（旧挑战作废）
  const rs = mcloudRoutes(
    testDeps(store, { transport: gatedTransport({ seen, blocked: 1, exhaustedAt: 2 }), now: NOW }),
  );
  post(rs, '/login/sms/start', { phone: '13800000000', pcPlatform: 'win' });
  const r = post(rs, '/login/sms/send');
  assert.equal(r.json.sent, true, `换新题之后要能发出去：${JSON.stringify(r.json)}`);
  const puzzleCalls = seen.filter((x) => x.url.endsWith(SLIDER_PUZZLE_PATH)).length;
  assert.equal(puzzleCalls, 2, `作废之后必须**重新取题**（取了 ${puzzleCalls} 次）`);
});
