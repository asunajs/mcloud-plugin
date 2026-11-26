// 「许愿活动」领抽奖码（`src/mcloud/tasks/wishCodes.ts`）。
//
// 判据都来自真号实测（2026-11-27）：
// - `task/list` 是 **GET**，且**必须**带 `platform/appVersion/channel`（少了回 404，不是 401）；
// - 每条任务带 `autoAdvanceable` / `clickAdvance` 两个上游自己标的布尔；
// - `task/auto-advance` 回 `{code:0,result:{advancedTasks:[{taskCode,…}]}}`。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoAdvanceRequest,
  parseAdvanced,
  parseWishTasks,
  runWishCodes,
  taskListRequest,
  WISH_QUERY,
} from '../src/mcloud/tasks/wishCodes.ts';
import { memStore } from '../src/store/memory.ts';
import { STATE_JWT } from '../src/mcloud/sessionExchange.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-11-27T00:30:00.000Z';
const SESSION_KEY = 'mcloud.session';

function harness(handler: (url: string) => unknown) {
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
    const r = handler(String(req.url));
    return { status: 200, headers: {}, body: JSON.stringify(r) };
  }) as never;
  const deps = { store, transport, nowIso: NOW, now: () => NOW, nowMs: () => Date.parse(NOW), baseUrl: undefined } as unknown as TaskDeps;
  return { deps, sent, store };
}

test('`task/list` 是 GET，且**必须**带 platform/appVersion/channel（少了回 404）', () => {
  const s = { jwt: 'J', cookie: '', userAgent: undefined };
  const req = taskListRequest(s);
  assert.equal(req.method, 'GET');
  const qs = new URL(String(req.url)).searchParams;
  assert.equal(qs.get('platform'), WISH_QUERY.platform);
  assert.equal(qs.get('appVersion'), WISH_QUERY.appVersion);
  assert.equal(qs.get('channel'), WISH_QUERY.channel);
  // 少了任何一个都不行 —— 这条钉住"别把它们当可选"
  for (const k of ['platform', 'appVersion', 'channel']) {
    assert.ok(qs.has(k), `缺了 ${k}`);
  }
});

test('`auto-advance` 是 POST，body 与 task/list 同参数', () => {
  const req = autoAdvanceRequest({ jwt: 'J', cookie: '', userAgent: undefined });
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(String(req.body)), { ...WISH_QUERY });
});

test('解析任务表：只取判据那几格，`autoAdvanceable` / `clickAdvance` 认布尔真值', () => {
  const got = parseWishTasks({
    tasks: [
      { taskId: 1016, taskCode: 'DAILY_CHECKIN', taskName: '每日打卡', taskState: 'WAIT', autoAdvanceable: true, clickAdvance: false },
      { taskId: 1011, taskCode: 'PC_UPLOAD', taskName: 'PC上传', taskState: 'WAIT', autoAdvanceable: false, clickAdvance: true },
      { taskId: 1004, taskCode: 'AI_LINGXI', taskName: '灵犀', taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false },
      // 没有 taskId 的丢掉
      { taskCode: 'BROKEN' },
    ],
  });
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], {
    taskId: 1016,
    taskCode: 'DAILY_CHECKIN',
    taskName: '每日打卡',
    taskState: 'WAIT',
    autoAdvanceable: true,
    clickAdvance: false,
    buttonAction: '',
  });
  assert.equal(got[1]!.clickAdvance, true);
  assert.equal(got[2]!.taskState, 'FINISH');
});

test('解析 auto-advance 回执：只取 taskCode', () => {
  assert.deepEqual(parseAdvanced({ advancedTasks: [{ taskCode: 'DAILY_CHECKIN' }, { taskCode: 'X' }] }), [
    'DAILY_CHECKIN',
    'X',
  ]);
  assert.deepEqual(parseAdvanced({}), []);
  assert.deepEqual(parseAdvanced(null), []);
});

test('既没有 auto 也没有 click ⇒ 一发写请求都不发（省流量）', async () => {
  const { deps, sent } = harness(() => ({
    code: 0,
    result: {
      tasks: [
        { taskId: 1004, taskCode: 'AI_LINGXI', taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false },
        { taskId: 1015, taskCode: 'AI_ERASE', taskState: 'WAIT', autoAdvanceable: false, clickAdvance: false, button: { action: 'popjump' } },
      ],
    },
  }));
  const r = await runWishCodes(deps);
  assert.equal(r.ok, true);
  assert.equal(r.idle, true);
  assert.match(r.note, /没有能自动领/);
  assert.equal(sent.filter((x) => /auto-advance|page\/click/.test(String(x.url))).length, 0, '不该发写请求');
});

test('`clickAdvance` 的逐条点（body 四个键都要：platform/appVersion/channel/taskId）', async () => {
  const { deps, sent } = harness((url) => {
    if (url.includes('task/list')) {
      return {
        code: 0,
        result: {
          tasks: [
            { taskId: 1017, taskCode: 'CLOUD_SIGN_IN', taskState: 'WAIT', autoAdvanceable: false, clickAdvance: true, button: { action: 'popjump' } },
            { taskId: 1011, taskCode: 'PC_UPLOAD', taskState: 'WAIT', autoAdvanceable: false, clickAdvance: true, button: { action: 'popjump' } },
          ],
        },
      };
    }
    return { code: 0, result: { task: { taskState: 'FINISH' } } };
  });
  const r = await runWishCodes(deps);
  assert.equal(r.ok, true);
  assert.match(r.note, /领到 2 张许愿码/);
  const clicks = sent.filter((x) => String(x.url).includes('page/click'));
  assert.equal(clicks.length, 2, '两条 clickAdvance 各一发');
  const body = JSON.parse(String(clicks[0]!.body));
  assert.deepEqual(body, { ...WISH_QUERY, taskId: 1017 });
});

test('`popAdvanceJump` 那条**不能**走 page/click（页面 JS 明确排除它）', async () => {
  const { deps, sent } = harness((url) => {
    if (url.includes('task/list')) {
      return {
        code: 0,
        result: {
          tasks: [
            { taskId: 1099, taskCode: 'WEIRD', taskState: 'WAIT', autoAdvanceable: false, clickAdvance: true, button: { action: 'popAdvanceJump' } },
          ],
        },
      };
    }
    return { code: 0, result: {} };
  });
  const r = await runWishCodes(deps);
  assert.match(r.note, /没有能自动领/);
  assert.equal(sent.filter((x) => String(x.url).includes('page/click')).length, 0);
});

test('有可自动推进的 ⇒ 推一次，并把推进了哪几条说出来', async () => {
  const { deps, sent } = harness((url) => {
    if (url.includes('task/list')) {
      return {
        code: 0,
        result: {
          tasks: [
            { taskId: 1016, taskCode: 'DAILY_CHECKIN', taskState: 'WAIT', autoAdvanceable: true, clickAdvance: false },
            { taskId: 1004, taskCode: 'AI_LINGXI', taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false },
          ],
        },
      };
    }
    return { code: 0, result: { advancedTasks: [{ taskCode: 'DAILY_CHECKIN' }] } };
  });
  const r = await runWishCodes(deps);
  assert.equal(r.ok, true);
  assert.match(r.note, /领到 1 张许愿码：DAILY_CHECKIN/);
  assert.equal(sent.filter((x) => String(x.url).includes('auto-advance')).length, 1);
});

test('上游拒绝时如实说（不假装领到）', async () => {
  const { deps } = harness((url) => {
    if (url.includes('task/list')) return { code: 0, result: { tasks: [{ taskId: 1016, autoAdvanceable: true, taskState: 'WAIT' }] } };
    return { code: 90001, msg: '未登录' };
  });
  const r = await runWishCodes(deps);
  assert.equal(r.ok, false);
  assert.match(r.note, /被拒/);
  assert.match(r.note, /未登录/);
});

test('没有会话 ⇒ 明说"票没换成"，不发请求', async () => {
  const store = memStore();
  store.ensureSchema();
  const sent: BuiltRequest[] = [];
  const deps = {
    store,
    transport: ((req: BuiltRequest) => {
      sent.push(req);
      return { status: 200, headers: {}, body: '{}' };
    }) as never,
    nowIso: NOW,
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
    baseUrl: undefined,
  } as unknown as TaskDeps;
  const r = await runWishCodes(deps);
  assert.equal(r.ok, false);
  assert.match(r.note, /还没有网页会话/);
  assert.equal(sent.length, 0);
});

// ── 豆换码（缺省关：花的是用户的豆）──────────────────────────────────

test('豆换码**缺省关**：开关没开时，一发都不发（哪怕余额够）', async () => {
  const { deps, sent } = harness((url) => {
    if (url.includes('task/list')) {
      return { code: 0, result: { tasks: [{ taskId: 1004, taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false }] } };
    }
    return { code: 0, result: {} };
  });
  await runWishCodes(deps);
  assert.equal(sent.filter((x) => /cloud-exchange/.test(String(x.url))).length, 0, '缺省关就别碰豆');
});

test('开了豆换码 + 余额够 ⇒ 换一张，并说清扣了多少豆', async () => {
  const { deps, sent, store } = harness((url) => {
    if (url.includes('task/list')) {
      return { code: 0, result: { tasks: [{ taskId: 1004, taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false }] } };
    }
    if (url.includes('cloud-exchange/info')) {
      return { code: 0, result: { cost: 300, remaining: 9, balance: 10843, canExchange: true } };
    }
    if (url.includes('cloud-exchange')) return { code: 0, result: {} };
    return { code: 0, result: {} };
  });
  const { setWishExchangeEnabled } = await import('../src/mcloud/tasks/wishCodes.ts');
  setWishExchangeEnabled(store, true, NOW);
  const r = await runWishCodes(deps);
  assert.equal(r.ok, true);
  assert.match(r.note, /豆换码\(-300豆\)/, r.note);
  assert.equal(sent.filter((x) => String(x.url).endsWith('/cloud-exchange')).length, 1, '只换一张');
});

test('余额不够 / 不能换 ⇒ 如实说，不发写请求', async () => {
  for (const [info, want] of [
    [{ cost: 300, remaining: 9, balance: 100, canExchange: true }, /豆不够换码/],
    [{ cost: 300, remaining: 0, balance: 10843, canExchange: false }, /换不了/],
  ] as const) {
    const { deps, sent, store } = harness((url) => {
      if (url.includes('task/list')) {
        return { code: 0, result: { tasks: [{ taskId: 1004, taskState: 'FINISH', autoAdvanceable: false, clickAdvance: false }] } };
      }
      if (url.includes('cloud-exchange/info')) return { code: 0, result: info };
      return { code: 0, result: {} };
    });
    const { setWishExchangeEnabled } = await import('../src/mcloud/tasks/wishCodes.ts');
    setWishExchangeEnabled(store, true, NOW);
    const r = await runWishCodes(deps);
    assert.match(r.note, want, r.note);
    assert.equal(sent.filter((x) => String(x.url).endsWith('/cloud-exchange')).length, 0, '不该发写请求');
  }
});
