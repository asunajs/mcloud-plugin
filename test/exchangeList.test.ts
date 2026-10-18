// 兑换清单（`exchange-list`）—— `exchange` 的只读半边。
//
// 重点在三个"照实说"的地方：
//   · group 键**不连续**（实拍 0,1,2,5,7,8,9,11,15）⇒ 按 0..n 遍历会静默漏一半
//   · `limit` 缺了 ⇒ **判不了**，不是"多半能兑"（否则会白发一笔真扣豆的请求）
//   · 没有余额读数 ⇒ 判不出"豆不够"；标"可兑"的仍可能被挡下（但有错误码，不静默）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_LIST,
  STATE_PICK,
  STATE_SUBS,
  parseExchangeList,
  readExchangeList,
  readPickCache,
  readSubscriptions,
  runExchangeList,
  savePickCache,
  toggleSubscription,
  summarizeList,
  toPickItems,
  verdictOf,
  parseMonthLimit,
  parsePrize,
} from '../src/mcloud/tasks/exchangeList.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-10-13T08:05:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'J', deviceId: 'dev-1', savedAt: NOW };

function seeded() {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  return store;
}

// 夹具就摆成"键不连续"的样子
const FIXTURE = {
  0: [
    { prizeId: 251230053, name: '云朵1个', groupId: 0, price: 100, limit: 0, onLine: 1 },
    { prizeId: 251230054, name: '会员1天', groupId: 0, price: 500, limit: 2, onLine: 1 },
  ],
  2: [{ prizeId: 251230061, name: '明日再来款', groupId: 2, price: 300, limit: 1, onLine: 1 }],
  15: [
    { prizeId: 251230099, name: '已下架款', groupId: 15, price: 999, limit: 0, onLine: 0 },
    { prizeId: 251230100, name: '缺 limit 款', groupId: 15, price: 200, onLine: 1 },
  ],
};

test('解析：按真实的 group 键遍历（0/2/15 都要读到），且按数值升序', () => {
  const { groups, prizes } = parseExchangeList(FIXTURE);
  assert.deepEqual(
    groups.map((g) => g.group),
    ['0', '2', '15'],
    '数值升序：15 排在最后（字典序会把它排到 2 前面）',
  );
  assert.equal(prizes.length, 5, '三组一共 5 件，一件都不能漏');
  assert.equal(groups[2]!.prizes.length, 2);
});

test('判据：五档 + 缺字段 ⇒ 判不了（**不是**可兑）', () => {
  assert.equal(verdictOf({ limit: 0, onLine: 1 }), 'ok');
  assert.equal(verdictOf({ limit: 1 }), 'tomorrow');
  assert.equal(verdictOf({ limit: 2 }), 'exchanged');
  assert.equal(verdictOf({ limit: 4 }), 'group-exchanged');
  // 没见过的档位 ⇒ 判不了
  assert.equal(verdictOf({ limit: 9 }), 'unknown');
  // ⚠ 缺 limit ⇒ 判不了。当成"多半可兑"会白发一笔真扣豆的请求
  assert.equal(verdictOf({ onLine: 1 }), 'limit-missing');
  assert.notEqual(verdictOf({ name: 'x' }), 'ok');
  // 月度额度：`limit` 说可兑、月度额度说满了 ⇒ **必须**落在保守的那一边
  assert.equal(
    verdictOf({ limit: 0, monthLimit: 3, received: 3 }),
    'month-limit',
    '额度用完后仍报"可兑"＝白发一笔真扣豆的请求',
  );
  assert.equal(verdictOf({ limit: 0, monthLimit: 3, received: 2 }), 'ok', '没满就该照常说可兑');
  // 缺任一边 ⇒ **不算**用完（宁可放过，不可误报）
  assert.equal(verdictOf({ limit: 0, monthLimit: 3 }), 'ok');
  assert.equal(verdictOf({ limit: 0, received: 3 }), 'ok');
  // 余量三档（对齐 Rust mcloud 的 plan_exchange）：只有 limit 放行后才继续判。
  assert.equal(verdictOf({ limit: 0, minRemainderCount: 0 }), 'min-remainder-zero', 'H5 的「已抢光」');
  assert.equal(verdictOf({ limit: 0, count: 0 }), 'sold-out', '池子现量 0');
  assert.equal(verdictOf({ limit: 0, dailyRemainderCount: 0 }), 'daily-empty', '今日余量 0');
  assert.equal(
    verdictOf({ limit: 0, minRemainderCount: 1, count: 1, dailyRemainderCount: 1 }),
    'ok',
    '余量都还有 ⇒ 可兑',
  );
  assert.equal(verdictOf({ limit: 1, minRemainderCount: 0 }), 'tomorrow', 'limit 先说话：明天再来');
  // 下架优先于额度：两者都命中时说"已下架"（更明确的那一个）
  assert.equal(verdictOf({ onLine: 0, limit: 0, monthLimit: 3, received: 3 }), 'offline');
  // 下架只认"明确给了且不是 1"；缺 onLine 不算下架
  assert.equal(verdictOf({ limit: 0, onLine: 0 }), 'offline');
  assert.equal(verdictOf({ limit: 0 }), 'ok', '缺 onLine 不等于下架');
});

test('汇总：各档计数 + 可兑清单（缺 limit 的不进可兑）', () => {
  const { prizes } = parseExchangeList(FIXTURE);
  const s = summarizeList(prizes);
  assert.equal(s.total, 5);
  assert.equal(s.okCount, 1, '只有一件 limit=0 且在架');
  assert.equal(s.byVerdict['limit-missing'], 1, '缺 limit 那件算判不了');
  assert.equal(s.byVerdict.offline, 1);
  assert.deepEqual(s.ok.map((x) => x.name), ['云朵1个']);
  // ⚠ 名字的字段名是 `prizeName`（2026-10-14 真机 51/51），`name` 只是回退
  assert.equal(parsePrize({ prizeId: 1, prizeName: '真机形状' })!.name, '真机形状');
  assert.equal(parsePrize({ prizeId: 1, name: '旧形状' })!.name, '旧形状');
  assert.equal(parsePrize({ prizeId: 1, prizeName: '真机形状', name: '旧形状' })!.name, '真机形状');
});

test('只读：整轮只发一个 GET exchangeList，落库可读回', () => {
  const store = seeded();
  const sent: { url: string; method: string }[] = [];
  const transport = ((req: any) => {
    sent.push({ url: req.url, method: req.method ?? 'GET' });
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: FIXTURE }) };
  }) as Transport;

  const out = runExchangeList({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1, '只该发一个请求');
  assert.equal(sent[0]!.method, 'GET');
  assert.ok(/exchangeList/.test(sent[0]!.url), sent[0]!.url);
  assert.ok(!/deviceId/.test(sent[0]!.url), '这一口不带 deviceId（实拍就是这样）');
  assert.ok(String(out.note).includes('可兑 1 件'), out.note);

  const r = readExchangeList(store);
  assert.equal(r!.okCount, 1);
  assert.equal(r!.groups, 3);
  assert.ok(store.getState(STATE_LIST)!.includes('"okCount":1'));
});

test('上游报错时如实失败，且不写读数', () => {
  const store = seeded();
  const transport = ((_req: any) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 40001, msg: '活动已结束' }),
  })) as Transport;
  const out = runExchangeList({ store, transport, nowIso: NOW, lateMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(readExchangeList(store), null, '失败了不该留一份读数');
});


test('⚠ 价格字段是 `pOrder`/`POrder`，**不是** `price`（真机实测，bug 防回归）', () => {
  // 真机上同一份响应里两种拼法并存 —— 只读一个键会把一部分商品的价格判成"没给"，
  // 于是"余额够不够"那道判断对那几件**恒假**（看着像没配价格，其实是不检查就下单）
  assert.equal(parsePrize({ prizeId: 1, prizeName: 'a', pOrder: 50 })!.price, 50);
  assert.equal(parsePrize({ prizeId: 2, prizeName: 'b', POrder: 400 })!.price, 400);
  assert.equal(parsePrize({ prizeId: 3, prizeName: 'c', pOrder: '50' })!.price, 50, '字符串也认');
  assert.equal(parsePrize({ prizeId: 4, prizeName: 'd' })!.price, undefined, '没给就是没给，**不编**');
  // `price` 这个键真机上不存在 —— 拿它当字段名会一直读到 undefined
  assert.equal(parsePrize({ prizeId: 5, prizeName: 'e', price: 999 })!.price, undefined);
});

// ══════════ 「选一件」那份缓存（用户 2026-10-17：名字不该自己写） ══════════
//
// 界面原来要用户手打奖品名字，而发回上游的查询串要么**一字不差**是那句名字
// 要么是个编号 —— 手打的错法界面自己都写在提示里了（「月卡」命中不了「季卡」）。
// 现在插件每天缓存一份清单，界面从里面**选**；选出来那句就是发回去那句。

test('缓存内容：只留下拉用得上那几格；**没名字的跳过**（没法标、也没法发）', () => {
  const { prizes } = parseExchangeList(FIXTURE);
  // 塞两件缺名字的进去：一件整个没有，一件只有空白
  prizes.push(parsePrize({ prizeId: 900 })!, parsePrize({ prizeId: 901, prizeName: '   ' })!);
  const items = toPickItems(prizes);
  assert.equal(items.length, prizes.length - 2, '没名字的必须跳过');
  assert.deepEqual(
    items.map((i) => i.name),
    ['云朵1个', '会员1天', '明日再来款', '已下架款', '缺 limit 款'],
    '名字**原样**存（发回上游靠它一字不差）',
  );
  const first = items[0]!;
  assert.equal(first.id, 251230053, '编号要带上：名字撞车时（会员1天/会员3天）搜编号快');
  assert.equal(first.verdict, 'ok');
  assert.equal(items[1]!.verdict, 'exchanged');
  assert.equal(items[2]!.verdict, 'tomorrow');
  assert.equal(items[3]!.verdict, 'offline');
  assert.equal(items[4]!.verdict, 'limit-missing');
  // ⚠ 夹具里那些 `price: 100` 是**错字段**（真价在 `pOrder`）⇒ 缓存里就是没有价格
  assert.equal(first.price, undefined, '没给价格就**不写这一格**，不补 0');
  assert.ok(!JSON.stringify(first).includes('"price"'), '缺的键连键名都不该出现');
  // 给了的字段才写：价格（正确拼法）+ 今日剩余
  const [one] = toPickItems([
    parsePrize({ prizeId: 1, prizeName: '有价格款', pOrder: 50, dailyRemainderCount: 3, limit: 0, onLine: 1 })!,
  ]);
  assert.equal(one!.price, 50);
  assert.equal(one!.remain, 3);
});

test('缓存按天建、**过期即清**：日界不是今天 ⇒ 回 null 并把那一格写空', () => {
  const store = seeded();
  const { prizes } = parseExchangeList(FIXTURE);
  savePickCache(store, prizes, NOW);
  const c = readPickCache(store, NOW)!;
  assert.equal(c.date, '2026-10-13');
  assert.equal(c.items.length, 5);

  // 第二天点开这一屏：旧的那份**作废**（不是"还能用"）—— 用户要的就是"每天清一次"
  const nextDay = '2026-10-14T01:00:00.000Z';
  assert.equal(readPickCache(store, nextDay), null, '昨天的那份不能说还有');
  assert.equal(store.getState(STATE_PICK), '', '过期要**就地清掉**，不是留着读一次判一次');
  // 清完再读还是 null（别把空串当成一份缓存）
  assert.equal(readPickCache(store, nextDay), null);
});

test('坏 JSON 也一样清掉 —— 不能让界面拿到半截数据去画下拉', () => {
  const store = seeded();
  store.setState(STATE_PICK, '{"date":"2026-10-13","items":', NOW);
  assert.equal(readPickCache(store, NOW), null);
  assert.equal(store.getState(STATE_PICK), '');
  // 缺 `items` 的那份不算缓存
  store.setState(STATE_PICK, '{"date":"2026-10-13"}', NOW);
  assert.equal(readPickCache(store, NOW), null);
});

test('⚠ 清单读**成功**才建缓存；读**失败**不许把今天那份清掉', () => {
  // 上游抖一下就把下拉清空 ⇒ 用户看到的是"没有可选"，而他昨天明明选过 ——
  // 这份缓存的价值恰恰在"这一屏永远有东西可选"。
  const store = seeded();
  const ok = ((_req: any) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, msg: 'success', result: FIXTURE }),
  })) as Transport;
  assert.equal(runExchangeList({ store, transport: ok, nowIso: NOW, lateMs: 0 }).ok, true);
  assert.equal(readPickCache(store, NOW)!.items.length, 5, '成功读取要顺手建缓存（不用界面另打）');

  const bad = ((_req: any) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 40001, msg: '活动已结束' }),
  })) as Transport;
  assert.equal(runExchangeList({ store, transport: bad, nowIso: NOW, lateMs: 0 }).ok, false);
  assert.equal(readPickCache(store, NOW)!.items.length, 5, '同一天里读失败不该清空这份');
});



test('关注：按 id/名字去重；取消按同一判据移除；坏数据当空', () => {
  const store = memStore();
  store.ensureSchema();
  assert.deepEqual(readSubscriptions(store), [], '没存过就是空');
  toggleSubscription(store, { id: 1, name: 'A' }, true, NOW);
  toggleSubscription(store, { id: 1, name: 'A' }, true, NOW);
  assert.deepEqual(readSubscriptions(store), [{ id: 1, name: 'A' }], '同一件关注两次只留一条');
  toggleSubscription(store, { name: 'B' }, true, NOW);
  assert.equal(readSubscriptions(store).length, 2, '没有 id 的按名字存');
  toggleSubscription(store, { id: 1, name: 'A' }, false, NOW);
  assert.deepEqual(readSubscriptions(store), [{ name: 'B' }], '取消关注按 id 命中');
  toggleSubscription(store, { name: 'B' }, false, NOW);
  assert.deepEqual(readSubscriptions(store), [], '没有 id 的按名字取消');
  store.setState(STATE_SUBS, 'not json', NOW);
  assert.deepEqual(readSubscriptions(store), [], '坏数据不抛，当空');
});

test('清单缓存带上分组/池子/今日/月度额度（界面要分组和库存）', () => {
  const [one] = toPickItems([
    parsePrize({
      prizeId: 7,
      prizeName: '分组款',
      groupId: 3,
      pOrder: 50,
      count: 12,
      totalCount: 99,
      dailyRemainderCount: 4,
      dailyCount: 10,
      startTime: '2026-07-01 09:30:00',
      endTime: '2026-12-31 23:59:59',
      probability2: '{"multi":true,"limitMonthQuantity":2}',
      receiveQuantity: 1,
      limit: 0,
      onLine: 1,
    })!,
  ]);
  assert.equal(one!.groupId, 3);
  assert.equal(one!.count, 12);
  assert.equal(one!.totalCount, 99);
  assert.equal(one!.dailyRemainderCount, 4);
  assert.equal(one!.dailyCount, 10);
  assert.equal(one!.monthLimit, 2);
  assert.equal(one!.received, 1);
  assert.equal(one!.startTime, '2026-07-01 09:30:00');
});
