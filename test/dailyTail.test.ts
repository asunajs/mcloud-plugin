// 日常尾部两步（清理临时文件 / 今日云朵）必须真的进 `detail`。
//
// 面板入口拿 `result.detail` 组两样东西：日志流（`onLine`）和运行结束推送正文。
// 所以这两行只要进了 detail，面板日志与推送就都带上了 —— 这条测试钉的是接线，
// 不是上游读数（读数在 `todayCloud.test.ts` / `ownedFiles.test.ts`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/mcloud/dailyRun.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

test('runDaily.detail 带「清理临时文件」和「今日云朵」', () => {
  const store = memStore();
  store.ensureSchema();
  const sent: BuiltRequest[] = [];
  // 所有请求都回“未登录”：这不是要跑成，而是让整趟快速走到尾部。
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  // 「今日云朵」现在走 `cloudRecordV2`（jwttoken 鉴权、要翻页）。
  // 没有会话时那一层连请求都不发（先换票、换不了就直接判"读不到"），
  // 所以这里必须种一份会话 + 新鲜的票，才钉得住"这一枪真的打出去了"。
  const nowIso = '2026-10-23T04:00:00.000Z';
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: nowIso }),
    nowIso,
  );
  store.setState(
    STATE_JWT,
    JSON.stringify({ at: new Date().toISOString(), jwt: 'JWT', referer: '', fingerprint: 'f' }),
    new Date().toISOString(),
  );
  const deps = {
    store,
    transport,
    nowIso,
    nowMs: () => Date.parse(nowIso),
    settleMs: 0,
  } as TaskDeps;

  const r = runDaily(deps);
  // 原生 token 的续期必须**排在所有任务之前**：到期那天先续，当前这一趟才用得上新 token。
  assert.equal(r.steps[0]?.name, '凭据续期', r.steps.map((s) => s.name).join(' → '));
  assert.ok(r.detail.some((l) => l.startsWith('清理临时文件：')), r.detail.join('\n'));
  assert.ok(r.detail.some((l) => l.startsWith('今日云朵：')), r.detail.join('\n'));
  assert.ok(r.steps.some((s) => s.name === '清理临时文件'));
  assert.ok(r.steps.some((s) => s.name === '今日云朵'));
  // 今日云朵是读数：当前端点（cloudRecordV2）一定要被真的打一枪
  assert.ok(sent.some((q) => q.url.includes('/ycloud/signin/public/cloudRecordV2?')));
  // 旧的 mrp 端点已经不用了，不许再出现在日常链里
  assert.ok(!sent.some((q) => q.url.includes('/market/signin/public/cloudRecord?')));
});
