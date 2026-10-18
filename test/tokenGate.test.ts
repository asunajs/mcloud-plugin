// 「无感刷新」这一层（`tokenGate.ts`）—— 用户报的现场：两个账号在「今日AI豆」那行
// 显示 `code=90001 msg=未登录`。这一层要做到"请求发出出错、刷新后拿到正确结果"，
// 而不是把红字抛到界面上。
//
// 守的四条：
//   · **到期主动换**（`jwtFresh` 假 ⇒ 先换一轮），票新鲜 ⇒ 一次换票都不发
//   · **90001 被动换并重试**（换完拿**新会话**重读，成功结果返回给调用方）
//   · **最多重置 2 次**：连着两次没救回来 ⇒ 判"账号问题"，不再无限重试
//   · **非 90001 的失败不重试**（网络断了重试没意义）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LoginExpiredError,
  MAX_RESETS,
  exchangeOnce,
  withTokenGate,
} from '../src/mcloud/tokenGate.ts';
import { STATE_AUTH, STATE_JWT, jwtFresh } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { Store } from '../src/store/types.ts';

const REAL_NOW_ISO = new Date().toISOString();
// 一条**绝不该被走到**的传输（控制流测试里都注入了 `refreshToken` 桩，真换票不发生）。
const exploding: Transport = () => {
  throw new Error('这条测试不该发上游请求');
};

/** 往票那一格塞一份记录。`at` 用真实当下 ⇒ `jwtFresh(Date.now())` 为真（跳过主动换）。 */
function seedJwt(store: Store, atIso: string): void {
  store.setState(STATE_JWT, JSON.stringify({ at: atIso, jwt: 'X', referer: '', fingerprint: 'f' }), atIso);
}

// ══════════════ 控制流（注入 `refreshToken` 桩，不碰真四步）══════════════

test('被动：90001 ⇒ 换票 ⇒ 拿新票重读 ⇒ **返回正确结果**（不是把错误抛出去）', () => {
  const store = memStore();
  store.ensureSchema();
  seedJwt(store, REAL_NOW_ISO);
  let readCalls = 0;
  let refreshCalls = 0;
  const out = withTokenGate(
    {
      store,
      transport: exploding,
      nowIso: REAL_NOW_ISO,
      refreshToken: () => {
        refreshCalls += 1;
        return { ok: true, note: 'stub' };
      },
    },
    () => {
      readCalls += 1;
      if (readCalls === 1) throw new LoginExpiredError();
      return 'OK';
    },
  );
  assert.equal(out, 'OK');
  assert.equal(refreshCalls, 1);
  assert.equal(readCalls, 2);
});

test('主动：票过期 ⇒ 读之前先换一轮；票新鲜 ⇒ 一次都不换', () => {
  // 过期
  {
    const store = memStore();
    store.ensureSchema();
    seedJwt(store, '2000-01-01T00:00:00.000Z');
    let refreshCalls = 0;
    const out = withTokenGate(
      {
        store,
        transport: exploding,
        nowIso: REAL_NOW_ISO,
        refreshToken: () => {
          refreshCalls += 1;
          return { ok: true, note: '' };
        },
      },
      () => 'OK', // 读数一次成就功
    );
    assert.equal(out, 'OK');
    assert.equal(refreshCalls, 1, '到期主动换一轮');
  }
  // 新鲜
  {
    const store = memStore();
    store.ensureSchema();
    seedJwt(store, REAL_NOW_ISO);
    let refreshCalls = 0;
    withTokenGate(
      {
        store,
        transport: exploding,
        nowIso: REAL_NOW_ISO,
        refreshToken: () => {
          refreshCalls += 1;
          return { ok: true, note: '' };
        },
      },
      () => 'OK',
    );
    assert.equal(refreshCalls, 0, '票新鲜 ⇒ 一个换票请求都不发');
  }
});

test('连续两次都没救回来 ⇒ 判「账号问题」，且**只重置 2 次**（不无限重试）', () => {
  const store = memStore();
  store.ensureSchema();
  seedJwt(store, REAL_NOW_ISO);
  let readCalls = 0;
  let refreshCalls = 0;
  // 换票"成功"了，但读数每次都还是 90001 ⇒ 说明票不是唯一问题，号本身坏了
  assert.throws(
    () =>
      withTokenGate(
        {
          store,
          transport: exploding,
          nowIso: REAL_NOW_ISO,
          refreshToken: () => {
            refreshCalls += 1;
            return { ok: true, note: '' };
          },
        },
        () => {
          readCalls += 1;
          throw new LoginExpiredError();
        },
      ),
    /重新登录|账号/,
  );
  assert.equal(refreshCalls, MAX_RESETS, '只重置 2 次');
  assert.equal(readCalls, MAX_RESETS + 1, '初始一次 + 每次重置各一次重读');
});

test('非 90001 的失败**不重试**（原样抛，一次换票都不发）', () => {
  const store = memStore();
  store.ensureSchema();
  seedJwt(store, REAL_NOW_ISO);
  let readCalls = 0;
  let refreshCalls = 0;
  assert.throws(
    () =>
      withTokenGate(
        {
          store,
          transport: exploding,
          nowIso: REAL_NOW_ISO,
          refreshToken: () => {
            refreshCalls += 1;
            return { ok: true, note: '' };
          },
        },
        () => {
          readCalls += 1;
          throw new Error('HTTP 502');
        },
      ),
    /502/,
  );
  assert.equal(readCalls, 1, '真失败不重读');
  assert.equal(refreshCalls, 0, '真失败不换票');
});

// ══════════════════════ 真换票那一支（默认 `exchangeOnce`）══════════════════

test('`exchangeOnce`：没有原生凭据 ⇒ 直接说不成（不硬打一枪）', () => {
  const store = memStore();
  store.ensureSchema();
  const r = exchangeOnce({ store, transport: exploding, nowIso: REAL_NOW_ISO }, 'sign-in');
  assert.equal(r.ok, false);
  assert.match(r.note, /凭据/);
});

// ══════════════════ 端到端：90001 → 真换票 → 新票重读拿到数 ══════════════════

test('⚠ 端到端（真 `exchangeOnce`）：第一枪 90001、换完票第二枪拿到正确读数', async () => {
  // 这一条钉"无感刷新"的**整条**链：不是只测控制流，而是让真的四步换票跑一遍，
  // 验证"请求发出出错、刷新后要得到正确结果而不是显示错误"。
  const { readDayForAccount } = await import('../src/mcloud/beansRead.ts');

  const store = memStore();
  store.ensureSchema();
  const AUTH = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';
  // 会话里是一张**坏票**（`STALE`）；票那一格却"看着新鲜" ⇒ 跳过主动换，走被动重试
  store.setState(SESSION_KEY, JSON.stringify({ cookie: 'c=1', jwt: 'STALE', savedAt: REAL_NOW_ISO }), REAL_NOW_ISO);
  seedJwt(store, REAL_NOW_ISO);
  store.setState(STATE_AUTH, AUTH, REAL_NOW_ISO);

  let cloudCalls = 0;
  const transport = ((req: { url: string }) => {
    if (req.url.includes('cloudRecordV2')) {
      cloudCalls += 1;
      // 第一枪：坏票 ⇒ 90001。换完票之后的枪 ⇒ 回今天的流水（短页，一页到底）。
      if (cloudCalls === 1) {
        return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, message: '未登录' }) };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          result: { records: [{ num: 10, summary: '签到', mark: 'm', insertTime: '2026-10-17T12:00:00.000+08:00' }] },
        }),
      };
    }
    // 四步换票的桩（逐条对照 `sessionExchange.test.ts` 的 `fakeUpstream`）
    if (req.url.includes('querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { token: 'SSO' } }) };
    }
    if (req.url.includes('/api/timestamp')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: 1700000000000 }) };
    }
    if (req.url.includes('/deviceprofile/v4')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 1100, detail: { deviceId: 'MOCKDEV' } }) };
    }
    // tyrzLogin：换到一张**新票**
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'ok', result: { token: 'JWT-NEW', mobile: '19900000000' } }) };
  }) as unknown as Transport;

  const nowMs = Date.UTC(2026, 9, 17, 4, 0, 0); // 东八区 2026-10-17 12:00
  const day = readDayForAccount({ store, transport, nowIso: REAL_NOW_ISO }, nowMs);

  assert.equal(cloudCalls, 2, '第一枪 90001、换完票第二枪读到 —— 共两枪 `cloudRecordV2`');
  // 拿到的是**正确结果**，不是错误
  assert.equal(day.gained, 10);
  assert.equal(day.net, 10);
  assert.equal(day.count, 1);
  // 换完票之后这一页的票确实新鲜了（新写回了）
  assert.equal(jwtFresh(store, Date.now(), 'sign-in'), true);
});
