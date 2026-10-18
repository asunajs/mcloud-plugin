// 直播口令 → 小红花：**编排层的判据**（照 mcloud 的 `mcloud-tasks/src/live_room.rs`）。
//
// 这里守的是四件事：
//
// ```text
//   ① 门那两种"没有"必须分得开  —— liveCount 就是为这件事存在的
//   ② 分隔符含**空白**（全角也要）—— mcloud 漏过这一条："我明明填了两条，怎么只领了一条"
//   ③ 协议结论 → 池状态的**映射表**只有一份（未分类的码不许当有效性判据）
//   ④ 投哪些口令：人给的在前 + 池的判据（判过无效的、领过的不再投）
// ```

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KOULING_ANCHOR,
  accountOf,
  checkParams,
  claimVerdictOf,
  describeFault,
  gateLine,
  judgeKoulingGate,
  mergeKouling,
  planDrawCodes,
  splitKouling,
} from '../src/mcloud/tasks/liveRoomRules.ts';
import type { GateRoom } from '../src/mcloud/tasks/liveRoomRules.ts';
import { emptyPool, note, noteClaim, pickFor } from '../src/mcloud/koulingPool.ts';
import { toBase64, utf8 } from '../src/crypto/bytes.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import { memStore } from '../src/store/memory.ts';

const T0 = 1_790_000_000_000;

function gateRoom(over: Partial<GateRoom> = {}): GateRoom {
  return { id: 1, status: 1, anchorNickname: KOULING_ANCHOR, ...over };
}

// ══════════════════════════ 判定门 ══════════════════════════

test('门：`status == 1` **且** 昵称精确相等 —— 只看状态会误判', () => {
  // 实拍：房间 147490「福建移动」也是 status == 1，和真正要听的那间在同一个页签里
  const g = judgeKoulingGate([
    gateRoom({ id: 147490, anchorNickname: '福建移动' }),
    gateRoom({ id: 100, anchorNickname: KOULING_ANCHOR }),
  ]);
  assert.equal(g.active, true);
  assert.deepEqual(g.rooms.map((r) => r.id), [100]);
  assert.equal(g.liveCount, 2, '在播的有两间（含别人的）');
});

test('⚠ 门那两种"没有"必须分得开（它们的下一步完全不同：一个等，一个别等）', () => {
  const nobody = judgeKoulingGate([gateRoom({ status: 2 }), gateRoom({ status: 0 })]);
  assert.equal(nobody.active, false);
  assert.equal(nobody.liveCount, 0);
  assert.match(gateLine(nobody), /谁都没开播/);

  const others = judgeKoulingGate([gateRoom({ id: 147490, anchorNickname: '福建移动' })]);
  assert.equal(others.active, false);
  assert.equal(others.liveCount, 1);
  assert.match(gateLine(others), /不是「中国移动云盘」的/);
  assert.ok(!/谁都没开播/.test(gateLine(others)), '别把"别人在播"说成"没有直播"');
});

test('门里的房间按 id 去重（同一间房可能因分页/多频道出现两次）', () => {
  const g = judgeKoulingGate([gateRoom({ id: 7 }), gateRoom({ id: 7 }), gateRoom({ id: 8 })]);
  assert.deepEqual(g.rooms.map((r) => r.id), [7, 8]);
  assert.equal(g.liveCount, 3, 'liveCount 是**筛状态之后**的房间数（去重前，mcloud 同口径）');
});

test('昵称是**精确相等**：`福建移动`/`移动心选`/`移动臻选` 都不算', () => {
  for (const name of ['福建移动', '移动心选', '移动臻选', '中国移动云盘 ', '']) {
    const g = judgeKoulingGate([gateRoom({ anchorNickname: name })]);
    assert.equal(g.active, false, `${name} 不该算目标主播`);
  }
});

// ══════════════════════════ 参数判据 ══════════════════════════

test('参数判据：关掉自动抓取又没给口令 ⇒ 一个来源都没有', () => {
  assert.equal(checkParams({ codes: [], autoScrape: false }), 'noSource');
  assert.match(describeFault('noSource'), /没有给手工口令/);
  // 给了口令 ⇒ 成立（人给的那份就是来源）
  assert.equal(checkParams({ codes: ['甲'], autoScrape: false }), null);
  // 开着自动抓取 ⇒ 成立
  assert.equal(checkParams({ codes: [], autoScrape: true }), null);
});

// ══════════════════════════ 合并与分隔 ══════════════════════════

test('合并：保序、去重、逐条 trim、丢空串', () => {
  assert.deepEqual(mergeKouling([' 甲 ', '乙', '甲', '', '  ']), ['甲', '乙']);
  assert.deepEqual(mergeKouling([]), []);
});

test('⚠ 分隔符含**空白**（含全角空格）—— mcloud 漏过这一条', () => {
  // 原话：「`"口令甲 口令乙"` 会被当成**一条**口令发上去 —— 服务端必然回 200108，
  // 而用户看到的是"我明明填了两条，怎么只领了一条还说口令错"」
  assert.deepEqual(splitKouling('口令甲 口令乙'), ['口令甲', '口令乙']);
  assert.deepEqual(splitKouling('甲\u3000乙'), ['甲', '乙'], '全角空格（手机输入法默认就是这个）');
  assert.deepEqual(splitKouling('甲、乙，丙,丁'), ['甲', '乙', '丙', '丁'], '顿号/中文逗号/英文逗号');
  assert.deepEqual(splitKouling('甲\n乙\r\n丙'), ['甲', '乙', '丙']);
  assert.deepEqual(splitKouling('  甲  '), ['甲']);
  assert.deepEqual(splitKouling(''), []);
});

// ══════════════════════════ 协议结论 → 池 ══════════════════════════

test('映射表逐条：领到/已兑换 ⇒ 有效；口令错/过期 ⇒ 无效；其余 ⇒ 未分类', () => {
  assert.equal(claimVerdictOf('succeeded'), 'claimed');
  assert.equal(claimVerdictOf('already-drawn'), 'alreadyClaimed');
  assert.equal(claimVerdictOf('invalid-kouling'), 'invalid');
  assert.equal(claimVerdictOf('kouling-expired'), 'expired');
  assert.equal(claimVerdictOf('other'), 'other');
  assert.equal(claimVerdictOf('unparsable'), 'other', '连码都没有 ⇒ 同样是"没分类"');
});

// ══════════════════════════ 投哪些口令 ══════════════════════════

test('投哪些：人给的在前、池里该投的在后，去重', () => {
  const pool = emptyPool();
  note(pool, ['乙'], 'xiaohongshu', T0);
  assert.deepEqual(planDrawCodes(pool, 'acc', ['甲']), ['甲', '乙']);
  assert.deepEqual(planDrawCodes(pool, 'acc', ['乙']), ['乙'], '人给的与池里的重复只投一次');
});

test('投哪些：判过**无效**的不投、这个账号**领过**的不投；别的账号照样投', () => {
  const pool = emptyPool();
  note(pool, ['甲', '乙', '丙'], 'xiaohongshu', T0);
  noteClaim(pool, 'acc', '甲', 'invalid', T0);
  noteClaim(pool, 'acc', '乙', 'claimed', T0);

  assert.deepEqual(planDrawCodes(pool, 'acc', []), ['丙']);
  // ⚠ 两个"不投"的作用域**不一样**，别混：
  //   · 判过无效 ⇒ **全局**（对谁都不投：那条口令就是坏的）
  //   · 领过     ⇒ **按账号**（别的账号照样投：口令是全实例共享的）
  assert.deepEqual(pickFor(pool, '另一个'), ['乙', '丙'], '无效的不给任何人；领过的只对那个账号不给');
});

test('投哪些：**未知**的也要投（验证的唯一途径就是拿去领）', () => {
  const pool = emptyPool();
  note(pool, ['甲'], 'xiaohongshu', T0);
  assert.deepEqual(planDrawCodes(pool, 'acc', []), ['甲']);
});

test('投哪些：人给的那份**也过同一道筛**（插件里它可能还没进池）', () => {
  const pool = emptyPool();
  note(pool, ['甲', '乙'], 'xiaohongshu', T0);
  noteClaim(pool, 'acc', '甲', 'invalid', T0);
  noteClaim(pool, 'acc', '乙', 'alreadyClaimed', T0);
  // 人手上还留着那两条（输入框没清）⇒ 不该再投它们
  assert.deepEqual(planDrawCodes(pool, 'acc', ['甲', '乙']), []);
});

// ══════════════════════════ 账号键 ══════════════════════════

test('账号键：从原生凭据里取手机号段（token 会被换掉，手机号不会）', () => {
  const store = memStore();
  store.ensureSchema();
  assert.equal(accountOf(store), 'default', '还没贴凭据 ⇒ 退化成常量键');

  const auth = `Basic ${toBase64(utf8('mobile:13800000000:TOKEN-A'))}`;
  store.setState(STATE_AUTH, auth, '2026-10-14T00:00:00.000Z');
  const a = accountOf(store);

  // 换票之后（token 变了、手机号没变）⇒ **同一个键**
  store.setState(STATE_AUTH, `Basic ${toBase64(utf8('mobile:13800000000:TOKEN-B'))}`, '2026-10-14T01:00:00.000Z');
  assert.equal(accountOf(store), a, '换票不能让池把同一个账号当成两个人');

  // 换个号 ⇒ 另一个键
  store.setState(STATE_AUTH, `Basic ${toBase64(utf8('mobile:13900000001:TOKEN-B'))}`, '2026-10-14T01:00:00.000Z');
  assert.notEqual(accountOf(store), a);

  // 两段式凭据（没有手机号）⇒ 也退化成常量键（拿不到就是拿不到，不编）
  store.setState(STATE_AUTH, `Basic ${toBase64(utf8('pc:TOKEN-C'))}`, '2026-10-14T01:00:00.000Z');
  assert.equal(accountOf(store), 'default');
});
