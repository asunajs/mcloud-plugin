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
  parseExchangeList,
  readExchangeList,
  runExchangeList,
  summarizeList,
  verdictOf,
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
  assert.equal(verdictOf({ onLine: 1 }), 'unknown');
  assert.notEqual(verdictOf({ name: 'x' }), 'ok');
  // 下架只认"明确给了且不是 1"；缺 onLine 不算下架
  assert.equal(verdictOf({ limit: 0, onLine: 0 }), 'offline');
  assert.equal(verdictOf({ limit: 0 }), 'ok', '缺 onLine 不等于下架');
});

test('汇总：各档计数 + 可兑清单（缺 limit 的不进可兑）', () => {
  const { prizes } = parseExchangeList(FIXTURE);
  const s = summarizeList(prizes);
  assert.equal(s.total, 5);
  assert.equal(s.okCount, 1, '只有一件 limit=0 且在架');
  assert.equal(s.byVerdict.unknown, 1, '缺 limit 那件算判不了');
  assert.equal(s.byVerdict.offline, 1);
  assert.deepEqual(s.ok.map((x) => x.name), ['云朵1个']);
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
