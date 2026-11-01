// 领奖链（`National_Getprize`）—— 对着 2026-10-31 的实拍核。
//
// 守的是那些"照直觉会写错"的地方：
//   · 列表用**旧口**（`prizeApi/checkPrize/getUserPrizeLogPageV2`），`oId` 是大写 I；
//   · 只有 `flag === 1` 才进列表；`flag=2/10` 不进（含义未解的那档不猜）；
//   · 同一件奖品中两次 = 两条记录（**按 oId 去重，不能按 prizeId**）；
//   · 滑块算不出来**不发** `sendPrizeSms`（发出去只会白耗一次题面）；
//   · 验证码除 `1028/1029` 外一律 `MD5`；`deviceId` 必填、`isdeviceid: true` 只在这一枪；
//   · 领成功要把缓存里那一件摘掉（界面不重打上游就能看到少一件）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode as encodePng } from 'fast-png';

import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { saveSession } from '../src/store/types.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import { jwtKey } from '../src/mcloud/sessionExchange.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { testDeps } from './helpers.ts';
import { toBase64 } from '../src/crypto/bytes.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { Store } from '../src/store/types.ts';
import {
  CLAIM_STATE_TTL_MS,
  PRIZE_CACHE_TTL_MS,
  STATE_PRIZE_CACHE,
  STATE_PRIZE_CLAIM,
  confirmPrizeClaim,
  loadClaimState,
  loadPrizeCache,
  maskPhoneLike,
  prizeCodeText,
  readPendingPrizes,
  ensurePrizeToken,
  savePrizeCache,
  startPrizeClaim,
} from '../src/mcloud/tasks/prizeClaim.ts';
import type { PrizeDeps, PrizeItem, PrizeListResult } from '../src/mcloud/tasks/prizeClaim.ts';

const NOW = '2026-10-31T13:00:00.000Z';
const DEVICE = `B${'x'.repeat(88)}`;
const JWT = 'JWT-SECRET';

/** mock 里那张可解的滑块题面（与 `mock/fixtures/README.md` 同一份）。 */
const PUZZLE_B64 = readFileSync(
  new URL('../mock/fixtures/prize-puzzle.png.b64', import.meta.url),
  'utf8',
).trim();
const PICTURE_B64 = readFileSync(
  new URL('../mock/fixtures/prize-picture.jpg.b64', import.meta.url),
  'utf8',
).trim();

function setup(label = '159****7542'): { store: Store; one: Store; acctId: string } {
  const store = memStore();
  store.ensureSchema();
  const { account } = upsertAccount(
    store,
    'Basic bW9iaWxlOjE1OTAwMDAwMDAwOnRva2Vu',
    NOW,
    label,
  );
  const one = scoped(rawStoreOf(store), account.id);
  saveSession(one, { cookie: 'c=1', jwt: JWT, deviceId: DEVICE, savedAt: NOW }, NOW);
  // 票设成"刚换的"：别让 `withTokenGate` 真去走四步换票（这里测的不是那条链）
  one.setState(
    jwtKey(one),
    JSON.stringify({ at: new Date().toISOString(), jwt: JWT, referer: '', fingerprint: 'f' }),
    NOW,
  );
  return { store, one, acctId: account.id };
}

interface Resp {
  status?: number;
  body: unknown;
  raw?: string;
}

/** 按路径分派的 transport；`seen` 里留着我们发出去的请求，给断言用。 */
function makeTransport(
  route: (req: BuiltRequest, path: string) => Resp | undefined,
  seen: BuiltRequest[] = [],
): Transport {
  return ((req: BuiltRequest) => {
    seen.push(req);
    const path = new URL(req.url).pathname;
    const r = route(req, path);
    if (r === undefined) throw new Error(`意外请求：${req.method} ${path}`);
    return {
      status: r.status ?? 200,
      headers: {},
      body: r.raw ?? JSON.stringify(r.body),
    };
  }) as unknown as Transport;
}

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  oId: 1280973030,
  prizeId: 260907019,
  prizeName: '0.41元支付宝话费红包',
  flag: 1,
  insertTime: '2026.10.24',
  marketname: '全网算力大作战',
  marketid: 'National_TokenPK',
  expireTime: '2026-10-31T23:59:59.000+08:00',
  servNumber: '159****7542',
  ...over,
});

const listBody = (records: unknown[], totalPages = 1, totalCount = records.length): unknown => ({
  code: 0,
  msg: 'success',
  result: {
    pageNum: 1,
    pageSize: 100,
    totalCount,
    totalPages,
    result: records,
  },
});

function depsOf(one: Store, transport: Transport, clock = { now: Date.parse(NOW) }): PrizeDeps {
  return {
    store: one,
    transport,
    nowIso: NOW,
    baseUrl: 'http://mock',
    nowMs: () => clock.now,
  };
}

function itemOf(over: Partial<PrizeItem> = {}): PrizeItem {
  return {
    oid: '1280973030',
    prizeId: 260907019,
    name: '0.41元支付宝话费红包',
    market: '全网算力大作战',
    marketId: 'National_TokenPK',
    expireAt: '2026-10-31T23:59:59.000+08:00',
    insertedAt: '2026.10.24',
    phone: '159****7542',
    claimable: true,
    ...over,
  };
}

// ══════════════════════════ 列表 ══════════════════════════

test('列表：只收 flag=1，oId 大写/oid 小写都认，按到期时间排', () => {
  const { one } = setup();
  const seen: BuiltRequest[] = [];
  const transport = makeTransport((_req, path) => {
    if (!path.endsWith('/getUserPrizeLogPageV2')) return undefined;
    return {
      body: listBody([
        rec({ oId: 2, prizeName: '后到期的', expireTime: '2026-12-01T23:59:59.000+08:00' }),
        rec({ oId: 1, prizeName: '先到期的', expireTime: '2026-11-01T23:59:59.000+08:00' }),
        rec({ oId: 3, prizeName: '已领的', flag: 2 }),
        rec({ oId: 4, prizeName: '含义未解的', flag: 10 }),
        // 新口那种小写 `oid` 也要认（同一份数据的两种拼法）
        { oid: 5, prizeId: 9, prizeName: '小写 oid', flag: 1, marketname: 'M', marketid: 'M' },
      ]),
    };
  }, seen);
  const r = readPendingPrizes(depsOf(one, transport));
  assert.equal(r.failed, undefined);
  assert.equal(r.scanned, 5);
  assert.deepEqual(
    r.items.map((x) => x.oid),
    ['1', '2', '5'],
    JSON.stringify(r.items),
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.url, /currPage=1&pageSize=100$/);
  assert.equal(seen[0]!.headers['jwttoken'], JWT);
  // ⚠ `isdeviceid` 只有 accept 那一枪带（实拍逐接口如此）—— 列表也不许带
  assert.equal(seen[0]!.headers['isdeviceid'], undefined);
  assert.equal(seen[0]!.headers['activityid'], 'National_Getprize');
  assert.match(String(seen[0]!.headers['Referer']), /path=getPrize/);
});

test('列表：同一件奖品中两次 = 两条（按 oId 去重，不按 prizeId）', () => {
  const { one } = setup();
  const transport = makeTransport(() => ({
    body: listBody([rec({ oId: 11 }), rec({ oId: 12 })]),
  }));
  const r = readPendingPrizes(depsOf(one, transport));
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((x) => x.oid).sort(), ['11', '12']);
});

test('列表：读失败要如实说（不拿空数组冒充"没有待领取"）', () => {
  const { one } = setup();
  const transport = makeTransport(() => ({ status: 500, body: {} }));
  const r = readPendingPrizes(depsOf(one, transport));
  assert.deepEqual(r.items, []);
  assert.ok(r.failed !== undefined && r.failed.length > 0, JSON.stringify(r));
});

test('列表：第 2 页挂了 —— 第 1 页的结果照给，并说清少读了哪一页', () => {
  const { one } = setup();
  let page = 0;
  const transport = makeTransport((_req, path) => {
    if (!path.endsWith('/getUserPrizeLogPageV2')) return undefined;
    page += 1;
    if (page === 1) {
      const full = Array.from({ length: 100 }, (_, i) =>
        rec({ oId: 1000 + i, flag: i === 0 ? 1 : 2 }),
      );
      return { body: listBody(full, 2) };
    }
    return { status: 500, body: {} };
  });
  const r = readPendingPrizes(depsOf(one, transport));
  assert.equal(r.items.length, 1);
  assert.equal(r.scanned, 100);
  assert.match(String(r.failed), /第 2 页/);
});

test('列表：翻到上限还没到底 ⇒ hasMore（不静默截断）', () => {
  const { one } = setup();
  const transport = makeTransport(() => ({
    body: listBody(
      Array.from({ length: 100 }, (_, i) => rec({ oId: 2000 + i, flag: 2 })),
      5,
      500,
    ),
  }));
  const r = readPendingPrizes(depsOf(one, transport));
  assert.equal(r.scanned, 300, '最多翻 3 页');
  assert.equal(r.hasMore, true);
  assert.equal(r.totalCount, 500);
});

// ══════════════════════════ 第一段：详情 → 滑块 → 发码 ══════════════════════════

/** 一条能跑通"发码"的 transport。`smsCode` 可覆盖成 514 之类。 */
function okClaimTransport(opts: {
  detail?: Record<string, unknown>;
  smsCode?: number;
  slidePicture?: string;
  slidePuzzle?: string;
  seen?: BuiltRequest[];
}): Transport {
  return makeTransport((_req, path) => {
    if (path.endsWith('/receivePrizeDetailsV2')) {
      return {
        body: {
          code: 0,
          msg: 'success',
          result: { prizetype: 1035, prizename: '0.41元支付宝话费红包', exchangeCode: 0, ...opts.detail },
        },
      };
    }
    if (path.endsWith('/getSlidePuzzle')) {
      return {
        body: {
          code: 0,
          msg: 'success',
          result: {
            puzzle: opts.slidePuzzle ?? PUZZLE_B64,
            puzzleWidth: 96,
            picture: opts.slidePicture ?? PICTURE_B64,
            picWidth: 680,
            picHeight: 400,
            puzzleLeft: null,
          },
        },
      };
    }
    if (path.endsWith('/sendPrizeSms')) {
      return { body: { code: opts.smsCode ?? 0, msg: opts.smsCode === 0 ? 'success' : '验证失败' } };
    }
    return undefined;
  }, opts.seen);
}

test('发码：详情/滑块/发短信三枪的形状与顺序；offset 是本地算的 282', () => {
  const { one } = setup();
  const seen: BuiltRequest[] = [];
  const clock = { now: Date.parse(NOW) };
  const r = startPrizeClaim(
    depsOf(one, okClaimTransport({ seen }), clock),
    itemOf(),
    '159****7542',
  );
  assert.equal(r.ok, true, r.note);
  assert.equal(r.offset, 282);
  assert.equal(r.prizetype, '1035');
  assert.match(r.note, /验证码已发到 159\*{4}7542/);

  assert.equal(seen.length, 3);
  assert.match(
    seen[0]!.url,
    /receivePrizeDetailsV2\?marketId=National_TokenPK&prizeId=260907019&drawRecode=1280973030$/,
  );
  assert.equal(seen[2]!.url.endsWith('/sendPrizeSms'), true);
  assert.deepEqual(JSON.parse(String(seen[2]!.body)), {
    oid: 1280973030,
    puzzleOffset: 282,
    app: 0,
  });
  assert.equal(seen[2]!.headers['content-type'], 'application/json');
  // ⚠ `isdeviceid` 只有 accept 那一枪带（实拍逐接口如此）—— 这三枪都不许带
  for (const r of seen) assert.equal(r.headers['isdeviceid'], undefined, `不该带 isdeviceid：${r.url}`);

  const st = loadClaimState(one);
  assert.ok(st !== null);
  assert.equal(st.oid, '1280973030');
  assert.equal(st.prizetype, '1035');
});

test('发码：60 秒内同一件不重发（本地闸，别让上游回 1001）', () => {
  const { one } = setup();
  const clock = { now: Date.parse(NOW) };
  const deps = depsOf(one, okClaimTransport({}), clock);
  assert.equal(startPrizeClaim(deps, itemOf()).ok, true);
  const second = startPrizeClaim(deps, itemOf());
  assert.equal(second.ok, false);
  assert.match(second.note, /刚发过验证码/);
  clock.now += 61_000;
  assert.equal(startPrizeClaim(deps, itemOf()).ok, true, '过了一分钟可以再发');
});

test('发码：滑块算不出来 ⇒ 不发 sendPrizeSms（只白打了详情+题面两枪）', () => {
  const { one } = setup();
  const seen: BuiltRequest[] = [];
  // 底图是一张 96×400 的透明 PNG ⇒ 匹配器算不出可用偏移
  const blank = encodePng({
    width: 96,
    height: 400,
    data: new Uint8Array(96 * 400 * 4),
  });
  const r = startPrizeClaim(
    depsOf(one, okClaimTransport({ seen, slidePicture: toBase64(blank) })),
    itemOf(),
  );
  assert.equal(r.ok, false);
  assert.match(r.note, /滑块没算准|解不开/);
  assert.equal(seen.length, 2, '第三枪（发短信）不许发');
  assert.equal(loadClaimState(one), null);
});

test('发码：上游回 514 时如实说"换一道题"，不落单', () => {
  const { one } = setup();
  const r = startPrizeClaim(depsOf(one, okClaimTransport({ smsCode: 514 })), itemOf());
  assert.equal(r.ok, false);
  assert.match(r.note, /滑块/);
  assert.equal(loadClaimState(one), null);
});

test('发码：详情说已兑换（exchangeCode=2031）⇒ 不领，并从列表缓存里摘掉', () => {
  const { one } = setup();
  savePrizeCache(
    one,
    { items: [itemOf()], scanned: 1, hasMore: false },
    Date.parse(NOW),
    NOW,
  );
  const r = startPrizeClaim(
    depsOf(one, okClaimTransport({ detail: { exchangeCode: 2031 } })),
    itemOf(),
  );
  assert.equal(r.ok, false);
  assert.match(r.note, /已经领过/);
  assert.deepEqual(loadPrizeCache(one)!.list.items, []);
});

test('发码：会话缺 deviceId 时也能发码（确认那一步才需要它），但确认会说清缺什么', () => {
  const { one } = setup();
  saveSession(one, { cookie: 'c=1', jwt: JWT, savedAt: NOW }, NOW);
  const deps = depsOf(one, okClaimTransport({}));
  assert.equal(startPrizeClaim(deps, itemOf()).ok, true);
  // 直接造一单（`startPrizeClaim` 已落），确认时应该拦下
  const r = confirmPrizeClaim(deps, '1280973030', '123456');
  assert.equal(r.ok, false);
  assert.match(r.note, /deviceId|设备指纹/);
});

// ══════════════════════════ 第二段：确认领取 ══════════════════════════

function withPendingClaim(one: Store, over: Record<string, unknown> = {}): void {
  one.setState(
    STATE_PRIZE_CLAIM,
    JSON.stringify({
      oid: '1280973030',
      prizeId: 260907019,
      marketId: 'National_TokenPK',
      name: '0.41元支付宝话费红包',
      phone: '159****7542',
      prizetype: '1035',
      sentAtMs: Date.parse(NOW),
      ...over,
    }),
    NOW,
  );
}

test('确认：smsCode = MD5(验证码)，deviceId/source/isdeviceid 逐字照实拍', () => {
  const { one } = setup();
  withPendingClaim(one);
  savePrizeCache(one, { items: [itemOf()], scanned: 1, hasMore: false }, Date.parse(NOW), NOW);
  const seen: BuiltRequest[] = [];
  const transport = makeTransport(
    (_req, path) => {
      if (path.endsWith('/acceptPrizeV2')) {
        return { body: { code: 0, msg: 'success', result: '订购成功' } };
      }
      return undefined;
    },
    seen,
  );
  const r = confirmPrizeClaim(depsOf(one, transport), '1280973030', '123456');
  assert.equal(r.ok, true, r.note);
  assert.match(r.note, /已领取/);
  assert.equal(r.result, '订购成功');

  assert.equal(seen.length, 1);
  const body = JSON.parse(String(seen[0]!.body)) as Record<string, unknown>;
  assert.equal(body['oid'], 1280973030);
  assert.equal(body['app'], 0);
  assert.equal(body['sendDefaultSms'], true);
  assert.equal(body['source'], '1000');
  assert.equal(body['deviceId'], DEVICE);
  // md5('123456') = e10adc3949ba59abbe56e057f20f883e
  assert.equal(body['smsCode'], 'e10adc3949ba59abbe56e057f20f883e');
  assert.equal(seen[0]!.headers['isdeviceid'], 'true');
  assert.equal(loadClaimState(one), null, '领成功要清掉这一单');
  assert.deepEqual(loadPrizeCache(one)!.list.items, [], '缓存里也要摘掉');
});

test('确认：prizetype 1028/1029 发明文验证码（那张静态分支）', () => {
  const { one } = setup();
  withPendingClaim(one, { prizetype: '1028' });
  const seen: BuiltRequest[] = [];
  const transport = makeTransport((_req, path) => {
    if (path.endsWith('/acceptPrizeV2')) return { body: { code: 0, msg: 'success' } };
    return undefined;
  }, seen);
  const r = confirmPrizeClaim(depsOf(one, transport), '1280973030', '123456');
  assert.equal(r.ok, true, r.note);
  assert.equal(JSON.parse(String(seen[0]!.body))['smsCode'], '123456');
});

test('确认：验证码错误 ⇒ 留在原地重输（这一单不清）', () => {
  const { one } = setup();
  withPendingClaim(one);
  const transport = makeTransport((_req, path) => {
    if (path.endsWith('/acceptPrizeV2')) return { body: { code: -7, msg: '验证码错误' } };
    return undefined;
  });
  const r = confirmPrizeClaim(depsOf(one, transport), '1280973030', '000000');
  assert.equal(r.ok, false);
  assert.match(r.note, /验证码不对/);
  assert.equal(r.code, -7);
  assert.ok(loadClaimState(one) !== null, '错码不该丢掉这一单');
});

test('确认：没发过码 / 验证码过期 / 单号对不上，都拦下', () => {
  const { one } = setup();
  const clock = { now: Date.parse(NOW) };
  const transport = makeTransport(() => ({ body: { code: 0, msg: 'success' } }));
  const deps = depsOf(one, transport, clock);

  const none = confirmPrizeClaim(deps, '1280973030', '123456');
  assert.equal(none.ok, false);
  assert.match(none.note, /先点/);

  withPendingClaim(one, { sentAtMs: Date.parse(NOW) - CLAIM_STATE_TTL_MS - 1 });
  const expired = confirmPrizeClaim(deps, '1280973030', '123456');
  assert.equal(expired.ok, false);
  assert.match(expired.note, /过期/);

  withPendingClaim(one);
  const other = confirmPrizeClaim(deps, '999', '123456');
  assert.equal(other.ok, false);
  assert.match(other.note, /先点/);
});

test('确认：514 / 10010004 等失败码的处置', () => {
  const { one } = setup();
  const run = (code: number): ReturnType<typeof confirmPrizeClaim> => {
    withPendingClaim(one);
    const transport = makeTransport((_req, path) => {
      if (path.endsWith('/acceptPrizeV2')) return { body: { code, msg: 'x' } };
      return undefined;
    });
    return confirmPrizeClaim(depsOf(one, transport), '1280973030', '123456');
  };
  const slider = run(514);
  assert.equal(slider.ok, false);
  assert.match(slider.note, /滑块/);
  assert.equal(loadClaimState(one), null, '514 要重新发码，这一单清掉');

  const expired = run(10010004);
  assert.equal(expired.ok, false);
  assert.match(expired.note, /过期/);
  assert.equal(loadClaimState(one), null);
});

test('发码：没拿到回应（超时/断连）⇒ unknown + 落一单（短信可能真发了）', () => {
  const { one } = setup();
  const seen: BuiltRequest[] = [];
  const transport: Transport = ((req: BuiltRequest) => {
    seen.push(req);
    const path = new URL(req.url).pathname;
    if (path.endsWith('/receivePrizeDetailsV2')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: { prizetype: 1035, prizename: '红包', exchangeCode: 0 },
        }),
      };
    }
    if (path.endsWith('/getSlidePuzzle')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          result: { puzzle: PUZZLE_B64, picture: PICTURE_B64, puzzleWidth: 96, picWidth: 680, picHeight: 400 },
        }),
      };
    }
    if (path.endsWith('/sendPrizeSms')) {
      // 宿主层失败（`isFetchError` 的形状）
      return { error: '请求失败：connection reset' };
    }
    throw new Error('意外请求：' + path);
  }) as unknown as Transport;

  const clock = { now: Date.parse(NOW) };
  const r = startPrizeClaim(depsOf(one, transport, clock), itemOf());
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true, '这不是"确定没发"，是"不知道发没发"');
  assert.match(r.note, /可能已经发出/);
  // 落一单：真收到码还能填（confirm 不该说"先点领取"）
  assert.ok(loadClaimState(one) !== null);
  // 而且 60 秒内不许再发（别连点）
  const again = startPrizeClaim(depsOf(one, transport, clock), itemOf());
  assert.equal(again.ok, false);
  assert.match(again.note, /刚发过验证码/);
});

test('确认：没拿到回应 ⇒ unknown + 清掉这一单（不许拿同一个码再撞）', () => {
  const { one } = setup();
  withPendingClaim(one);
  const transport: Transport = ((req: BuiltRequest) => {
    if (new URL(req.url).pathname.endsWith('/acceptPrizeV2')) {
      return { error: '请求失败：timeout' };
    }
    throw new Error('意外请求');
  }) as unknown as Transport;
  const r = confirmPrizeClaim(depsOf(one, transport), '1280973030', '123456');
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.match(r.note, /可能已经领到/);
  assert.equal(loadClaimState(one), null, '结果未知时不许保留这一单');
});

test('详情阶段撞到过期/抢光 ⇒ 从列表缓存里摘掉（别每次点都重复失败）', () => {
  const { one } = setup();
  for (const code of [10010004, 10010018, 10010013]) {
    savePrizeCache(one, { items: [itemOf()], scanned: 1, hasMore: false }, Date.parse(NOW), NOW);
    const transport = makeTransport((_req, path) =>
      path.endsWith('/receivePrizeDetailsV2')
        ? { body: { code, msg: 'x' } }
        : undefined,
    );
    const r = startPrizeClaim(depsOf(one, transport), itemOf());
    assert.equal(r.ok, false);
    assert.deepEqual(loadPrizeCache(one)!.list.items, [], `code=${code} 要摘掉这一件`);
  }
});

test('手机号自己再脱敏：上游哪天改成明文也不会把完整号显示出来', () => {
  assert.equal(maskPhoneLike('15912345678'), '1****5678');
  assert.equal(maskPhoneLike('159-1234-5678'), '1****5678');
  assert.equal(maskPhoneLike('+86 15912345678'), '1****5678');
  assert.equal(maskPhoneLike('159****7542'), '159****7542');
  assert.equal(maskPhoneLike(''), undefined);
  assert.equal(maskPhoneLike(undefined), undefined);
});

test('码表：未实拍的那些只做查表，不要静默当成功', () => {
  assert.match(prizeCodeText(0), /成功/);
  assert.match(prizeCodeText(-6), /验证码不对/);
  assert.match(prizeCodeText(1002), /上限/);
  assert.match(prizeCodeText(123456, '自定义'), /123456/);
});

// ══════════════════════════ 路由：整条链 ══════════════════════════

test('路由：列表 → 发码 → 确认 → 列表（缓存已摘掉那一件）', () => {
  const { store, one, acctId } = setup();
  const seen: BuiltRequest[] = [];
  const transport = makeTransport((req, path) => {
    if (path.endsWith('/getUserPrizeLogPageV2')) {
      return {
        body: listBody([
          rec({ oId: 1280973030 }),
          rec({ oId: 1283824132, prizeId: 251230053, prizeName: 'tokens 包' }),
        ]),
      };
    }
    if (path.endsWith('/receivePrizeDetailsV2')) {
      return { body: { code: 0, msg: 'success', result: { prizetype: 1035, prizename: '红包', exchangeCode: 0 } } };
    }
    if (path.endsWith('/getSlidePuzzle')) {
      return {
        body: {
          code: 0,
          msg: 'success',
          result: {
            puzzle: PUZZLE_B64,
            puzzleWidth: 96,
            picture: PICTURE_B64,
            picWidth: 680,
            picHeight: 400,
          },
        },
      };
    }
    if (path.endsWith('/sendPrizeSms')) return { body: { code: 0, msg: 'success' } };
    if (path.endsWith('/acceptPrizeV2')) {
      return { body: { code: 0, msg: 'success', result: '订购成功' } };
    }
    return undefined;
  }, seen);

  const routes = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const listRoute = routes.find((x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET')!;
  const claimRoute = routes.find((x) => x.path === '/plugins/mcloud/api/prizes/claim' && x.method === 'POST')!;
  const confirmRoute = routes.find(
    (x) => x.path === '/plugins/mcloud/api/prizes/confirm' && x.method === 'POST',
  )!;

  const first = JSON.parse(listRoute.handler({ query: '' }).body) as {
    ok: boolean;
    pending: number;
    items: { oid: string; phone?: string }[];
    cached: boolean;
    account: { id: string } | null;
  };
  assert.equal(first.ok, true);
  assert.equal(first.pending, 2);
  assert.equal(first.cached, false);
  assert.equal(first.account?.id, acctId);
  assert.equal(first.items[0]!.phone, '159****7542');
  // 凭据不回显
  const text = JSON.stringify(first);
  assert.equal(text.includes(JWT), false, '列表不许回显 jwttoken');
  assert.equal(text.includes(DEVICE), false, '列表不许回显 deviceId');

  const claim = JSON.parse(
    claimRoute.handler({ body: JSON.stringify({ account: acctId, oid: '1280973030' }) }).body,
  ) as { ok: boolean; note: string; offset?: number };
  assert.equal(claim.ok, true, claim.note);
  assert.equal(claim.offset, 282);

  const confirm = JSON.parse(
    confirmRoute.handler({
      body: JSON.stringify({ account: acctId, oid: '1280973030', code: '123456' }),
    }).body,
  ) as { ok: boolean; note: string };
  assert.equal(confirm.ok, true, confirm.note);

  // 第二次读：命中缓存（不再打列表那一口），并且那一件已经被摘掉
  const listCallsBefore = seen.filter((x) => x.url.includes('getUserPrizeLogPageV2')).length;
  const second = JSON.parse(listRoute.handler({ query: '' }).body) as {
    pending: number;
    cached: boolean;
  };
  assert.equal(second.cached, true);
  assert.equal(second.pending, 1);
  assert.equal(
    seen.filter((x) => x.url.includes('getUserPrizeLogPageV2')).length,
    listCallsBefore,
    '缓存命中不该再打列表',
  );

  // `refresh=1` 强取
  listRoute.handler({ query: 'refresh=1' });
  assert.equal(
    seen.filter((x) => x.url.includes('getUserPrizeLogPageV2')).length,
    listCallsBefore + 1,
  );

  // 账号都在，且当前账号就是这一个
  assert.equal(loadPrizeCache(one) !== null, true);
});

test('路由：账号不存在 → 400；一件都没有 → noAccount', () => {
  const store = memStore();
  store.ensureSchema();
  const routes = mcloudRoutes(testDeps(store, { now: NOW }));
  const list = routes.find((x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET')!;
  const empty = JSON.parse(list.handler({ query: '' }).body) as {
    noAccount?: boolean;
    account: unknown;
    items: unknown[];
  };
  assert.equal(empty.noAccount, true);
  assert.equal(empty.account, null);
  assert.deepEqual(empty.items, []);

  const { store: s2, acctId } = setup();
  const r2 = mcloudRoutes(testDeps(s2, { now: NOW })).find(
    (x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET',
  )!;
  const bad = r2.handler({ query: 'account=nope' });
  assert.equal(bad.status, 400);
  assert.match(String(JSON.parse(bad.body).error), new RegExp('nope'));
  assert.ok(acctId.length > 0);
});

test('路由：claim/confirm 缺参数 → 400；缓存里没有这一件 → 400 且不发请求', () => {
  const { store, acctId } = setup();
  let calls = 0;
  const transport = ((req: BuiltRequest) => {
    calls += 1;
    throw new Error(`不该发请求：${req.url}`);
  }) as unknown as Transport;
  const routes = mcloudRoutes(testDeps(store, { transport, now: NOW }));
  const claim = routes.find(
    (x) => x.path === '/plugins/mcloud/api/prizes/claim' && x.method === 'POST',
  )!;
  const confirm = routes.find(
    (x) => x.path === '/plugins/mcloud/api/prizes/confirm' && x.method === 'POST',
  )!;

  const noOid = claim.handler({ body: JSON.stringify({ account: acctId }) });
  assert.equal(noOid.status, 400);
  const notInCache = claim.handler({
    body: JSON.stringify({ account: acctId, oid: '404' }),
  });
  assert.equal(notInCache.status, 400);
  assert.match(String(JSON.parse(notInCache.body).error), /列表里没有这一件/);
  const noCode = confirm.handler({
    body: JSON.stringify({ account: acctId, oid: '404' }),
  });
  assert.equal(noCode.status, 400, '缺 code 也当参数错');
  assert.equal(calls, 0, '参数错不该发任何上游请求');
});


test('路由：账号标签是完整手机号时，领奖响应与日志都脱敏', () => {
  const { store, acctId } = setup('15900000000');
  const logs: string[] = [];
  const transport = makeTransport((_req, path) => {
    if (path.endsWith('/getUserPrizeLogPageV2')) return { body: listBody([rec()]) };
    if (path.endsWith('/receivePrizeDetailsV2')) {
      return { body: { code: 0, msg: 'success', result: { prizetype: 1035, prizename: '红包', exchangeCode: 0 } } };
    }
    if (path.endsWith('/getSlidePuzzle')) {
      return {
        body: {
          code: 0,
          msg: 'success',
          result: { puzzle: PUZZLE_B64, picture: PICTURE_B64, puzzleWidth: 96, picWidth: 680, picHeight: 400 },
        },
      };
    }
    if (path.endsWith('/sendPrizeSms')) return { body: { code: 0, msg: 'success' } };
    return undefined;
  });
  const routes = mcloudRoutes(testDeps(store, { transport, now: NOW, log: (m) => logs.push(m) }));
  const list = routes.find((x) => x.path === '/plugins/mcloud/api/prizes' && x.method === 'GET')!;
  const view = JSON.parse(list.handler({ query: '' }).body) as {
    account: { label: string };
    accounts: { label: string }[];
  };
  assert.equal(view.account.label, '1****0000', '响应里的账号标签要脱敏');
  assert.equal(view.accounts[0]!.label, '1****0000', '下拉里的账号标签也要脱敏');

  const claim = routes.find(
    (x) => x.path === '/plugins/mcloud/api/prizes/claim' && x.method === 'POST',
  )!;
  const r = JSON.parse(
    claim.handler({ body: JSON.stringify({ account: acctId, oid: '1280973030' }) }).body,
  ) as { ok: boolean };
  assert.equal(r.ok, true, 'claim 应当成功');
  assert.ok(!logs.join('\n').includes('15900000000'), `日志里不许出现完整手机号：${logs.join(' | ')}`);
});


test('ensurePrizeToken：没有可换票的原生凭据时不拦（手工贴的会话只有 jwttoken）', () => {
  const store = memStore();
  store.ensureSchema();
  // ⚠ 故意不建账号：`loadAuthRaw` 为空 —— 但会话里有一张 jwttoken，可能还能用
  saveSession(store, { cookie: 'c=1', jwt: JWT, deviceId: DEVICE, savedAt: NOW }, NOW);
  const r = ensurePrizeToken({
    store,
    transport: (() => {
      throw new Error('不该发请求');
    }) as unknown as Transport,
    nowIso: NOW,
  });
  assert.equal(r.ok, true, '没有换票凭据时不该在本地点拦下');
});
