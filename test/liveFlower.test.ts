// 小红花协议层（`liveFlower.ts`）—— 逐条对着 `live_flower.rs` 的实拍表核。
//
// 这里守的是**最容易写歪**的三件事：
//   · 四个请求的"请求体形态"**各不相同**（`draw`/`give` 是**无 body、无 content-type**）
//   · 口令走 **query**，且是中文 ⇒ 必须百分号编码
//   · 业务码**只判等**，而且 `200118`（本场已结束）**不是**"口令无效"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_KOULING_ALREADY_DRAWN,
  CODE_KOULING_EXPIRED,
  CODE_KOULING_INVALID,
  JOURNALING_EVENTS,
  LIVE_ROOM_USER_AGENT,
  classifyDraw,
  drawLine,
  drawRequest,
  firstParticipateGiveRequest,
  isAlreadyDrawn,
  isKoulingExpired,
  journalingRequest,
  parseBalance,
  queryRevivalFlowersRequest,
  rejectedKouling,
  userInfoRequest,
} from '../src/mcloud/liveFlower.ts';
import type { SignInEnvelope } from '../src/mcloud/envelope.ts';

const env = (code: number | undefined, result?: unknown, message = ''): SignInEnvelope =>
  ({ code, message, result, ok: code === 0 }) as SignInEnvelope;

test('请求体形态：四个端点**各不相同**（"POST 就该有 JSON body"是错的）', () => {
  const ui = userInfoRequest();
  assert.equal(ui.method, 'POST');
  assert.equal(ui.body, '{}');
  // ⚠ 真实现**没有** content-type（模块文档写着 application/json，但代码里没设）。
  // 2026-10-13 用真实现自己的请求对象对拍出来的。
  assert.equal(ui.headers['content-type'], undefined, 'user/info 不该带 content-type');

  const j = journalingRequest(JOURNALING_EVENTS[0]!);
  assert.equal(j.method, 'POST');
  assert.equal(
    j.headers['content-type'],
    'application/x-www-form-urlencoded;charset=UTF-8',
    '埋点是表单，不是 JSON',
  );
  assert.equal(j.body, `module=uservisit&optkeyword=National_LiveRoomFeedback_pv&sourceid=1007&marketName=National_LiveRoomFeedback`);

  // ⚠ 这两个是**无 body**（实拍 content-length: 0、无 content-type）。
  // 带上 `{}` 会多出两个字节和一个 content-type —— 而"照抄原实现"恰好是对的。
  for (const [name, r] of [
    ['firstParticipate/give', firstParticipateGiveRequest()],
    ['redFlower/draw', drawRequest('X')],
  ] as const) {
    assert.equal(r.body, undefined, `${name} 必须无 body`);
    assert.equal(r.headers['content-type'], undefined, `${name} 不该有 content-type`);
    assert.equal(r.method, 'POST');
  }
});

test('draw：口令走 **query**，中文必须百分号编码', () => {
  const r = drawRequest('中秋口令');
  assert.equal(
    r.url,
    'https://m.mcloud.139.com/ycloud/liveRoomFeedback/redFlower/draw?code=%E4%B8%AD%E7%A7%8B%E5%8F%A3%E4%BB%A4',
  );
  assert.ok(!r.url.includes('中秋'), '中文必须编码，不能原样进 URL');
  // 口令不在 body 里
  assert.equal(r.body, undefined);
});

test('这一族共用的头：activityid 是**签到族那个**、UA 是小红花那个 iPad UA', () => {
  const r = drawRequest('X');
  assert.equal(r.headers.activityid, 'sign_in_3', '实拍如此，不是直播专属 id');
  assert.equal(r.headers.appversion, '12.6.0.0');
  assert.equal(r.headers.Origin, 'https://m.mcloud.139.com');
  assert.equal(r.headers['User-Agent'], LIVE_ROOM_USER_AGENT);
  assert.ok(LIVE_ROOM_USER_AGENT.includes('18_7'), '小红花侧是 18_7（直播侧 18_5）');
  // Referer 是**小红花活动页**，带 targetSourceId=001005
  assert.ok(r.headers.Referer!.startsWith('https://m.mcloud.139.com/portal/yunClound/index.html?path=National_LiveRoomFeedback'));
  assert.ok(r.headers.Referer!.includes('targetSourceId=001005'), '直播侧那个是 017027，别混');
  // ⚠ 这一族**不带**签到族那套签名头（见 liveDraw.ts 文件头）
  assert.equal(r.headers['x-signature'], undefined);
  assert.equal(r.headers.cookie, undefined);
});

test('复活花那一口是这条链上**唯一的 GET**', () => {
  const r = queryRevivalFlowersRequest();
  assert.equal(r.method, 'GET');
  assert.ok(r.url.endsWith('/redFlower/queryRevivalFlowers'));
});

test('埋点是固定 5 条，顺序即常量表', () => {
  assert.equal(JOURNALING_EVENTS.length, 5);
  assert.equal(JOURNALING_EVENTS[4], 'National_LiveRoomFeedback_flowerBtn', '只有这条是实拍证实的');
});

test('判定：成功要 `code===0` **且** result 在（只有 code 不算成功）', () => {
  const ok = classifyDraw(env(0, { prizeId: 7, flowerNum: 10, prizeName: '小红花', prizeType: 1 }));
  assert.equal(ok.kind, 'succeeded');
  assert.equal(ok.result!.flowerNum, 10);
  assert.equal(ok.result!.prizeName, '小红花');

  // ⚠ 只有 code 没有 result ⇒ 拿不到"换到几朵" ⇒ 不能记成一次成功
  assert.equal(classifyDraw(env(0, undefined)).kind, 'unparsable');
  assert.equal(classifyDraw(undefined).kind, 'unparsable');
});

test('判定：四个业务码各归各位，其余是"未分类"', () => {
  assert.equal(classifyDraw(env(CODE_KOULING_ALREADY_DRAWN)).kind, 'already-drawn');
  assert.equal(classifyDraw(env(CODE_KOULING_INVALID)).kind, 'invalid-kouling');
  assert.equal(classifyDraw(env(CODE_KOULING_EXPIRED)).kind, 'kouling-expired');
  assert.equal(classifyDraw(env(609)).kind, 'other', '609 是别的接口的码，不许张冠李戴');
  assert.equal(classifyDraw(env(200103)).kind, 'other', '红花数不够出自别的接口');
});

test('⚠ 刻意分叉：只有 200108 算"口令认错了"，200118 **不是**', () => {
  const invalid = classifyDraw(env(CODE_KOULING_INVALID));
  const expired = classifyDraw(env(CODE_KOULING_EXPIRED));

  assert.equal(rejectedKouling(invalid), true, '200108 才是口令错');
  assert.equal(
    rejectedKouling(expired),
    false,
    '把 200118 当口令错 ⇒ 白重听 60 秒 + 把"直播结束了"误报成"口令抄错了"',
  );
  assert.equal(isKoulingExpired(expired), true);
  assert.equal(isKoulingExpired(invalid), false);
  assert.equal(isAlreadyDrawn(classifyDraw(env(CODE_KOULING_ALREADY_DRAWN))), true);

  // 未分类的码也**不许**算口令错（否则又是一个白重听）
  assert.equal(rejectedKouling(classifyDraw(env(609))), false);
});

test('人话：没领到的一律带原因，不许只写"失败"', () => {
  assert.equal(drawLine('X', classifyDraw(env(0, { flowerNum: 15 }))), '口令「X」领到 15 朵');
  assert.match(drawLine('X', classifyDraw(env(CODE_KOULING_ALREADY_DRAWN))), /已兑换过/);
  assert.match(drawLine('X', classifyDraw(env(CODE_KOULING_INVALID))), /口令无效/);
  const exp = drawLine('X', classifyDraw(env(CODE_KOULING_EXPIRED)));
  assert.match(exp, /本场已结束/);
  assert.match(exp, /口令是对的/, '最常见的成因是"直播结束了"，不能把人往"抄错了"引');
  assert.match(drawLine('X', classifyDraw(env(609))), /609/);
});

test('余额：`flowerCnt` **必须**在 —— 缺了是 undefined，不是 0', () => {
  assert.equal(parseBalance(env(0, { flowerCnt: 235 })), 235);
  assert.equal(parseBalance(env(0, { flowerCnt: '235' })), 235, '字符串数字也认');
  // ⚠ 静默成 0 会让"余额从 235 变成 0"看起来像一次正常读数
  assert.equal(parseBalance(env(0, {})), undefined);
  assert.equal(parseBalance(env(0, 0)), undefined);
  assert.equal(parseBalance(undefined), undefined);
});

test('⚠ baseUrl 必须能把这族的源**整个换掉**（否则"指到 mock"对它无效）', () => {
  // 这条是踩出来的：第一版把真上游写死在构造器里，于是本地 E2E 里那几步
  // **真的打到了 m.mcloud.139.com**（拿假 jwt 被 90001 挡下，没碰到账号，
  // 但"CI 全程只打 mock"这条纪律已经破了）。真机上出这种错就是污染真环境。
  const base = 'http://127.0.0.1:19040';
  assert.equal(userInfoRequest(base).url, `${base}/ycloud/liveRoomFeedback/user/info`);
  assert.equal(drawRequest('X', base).url, `${base}/ycloud/liveRoomFeedback/redFlower/draw?code=X`);
  assert.equal(journalingRequest('E', base).url, `${base}/ycloud/visitlog/journaling`);
  assert.equal(firstParticipateGiveRequest(base).url, `${base}/ycloud/liveRoomFeedback/firstParticipate/give`);
  assert.equal(queryRevivalFlowersRequest(base).url, `${base}/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers`);
  // 尾部斜杠不该叠成两条
  assert.equal(userInfoRequest(`${base}/`).url, `${base}/ycloud/liveRoomFeedback/user/info`);
  // 不给 base ⇒ 真上游（生产路径）
  assert.ok(userInfoRequest().url.startsWith('https://m.mcloud.139.com/'));
});
