// 趣玩AI：`taskSign=2`（AI录音转写）走独立完成口 —— 2026-11-26 从 cmcc-plugin 迁来。
//
// 迁的依据：cmcc-plugin 侧真跑通了（报「完成：AI录音转写」，随后该任务从待办消失）。
// 隔壁原先标「走法零样本 ⇒ 需手动」，这条把空白补上。

import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAYAI_EP, transcriptionCompletedRequest } from '../src/mcloud/playAi.ts';

const SESSION = { jwt: 'jwt-x', cookie: 'ck=1', userAgent: 'UA/1' };

test('完成口端点是 timed/transcriptioncompleted（不是 page/register）', () => {
  assert.equal(PLAYAI_EP.transcriptionCompleted, '/ycloud/funai/api/timed/transcriptioncompleted');
});

test('完成口是 POST，body 与 register 同形 {moduleId,taskId}', () => {
  const req = transcriptionCompletedRequest(SESSION, '1-250730', 'ailuyinzhuanxie');
  assert.equal(req.method, 'POST');
  assert.match(req.url, /transcriptioncompleted$/);
  assert.deepEqual(JSON.parse(String(req.body)), {
    moduleId: '1-250730',
    taskId: 'ailuyinzhuanxie',
  });
});

test('完成口带 jwttoken 与 cookie（funai 族**不带** x-signature）', () => {
  const req = transcriptionCompletedRequest(SESSION, 'm', 't');
  assert.equal(req.headers['jwttoken'], 'jwt-x');
  assert.equal(req.headers['cookie'], 'ck=1');
  assert.equal(req.headers['content-type'], 'application/json;charset=UTF-8');
  // ⚠ funai 这一族实拍里**没有**签名头（与 signin 族不同），实测 code:0 能通。
  //   别「补全」它 —— 多带一枚上游不认的头是没意义的改动。
  assert.equal(req.headers['x-signature'], undefined, 'funai 族不该带签名头');
});