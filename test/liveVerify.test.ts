// 验口令：拿它去领一次 —— 领就是验。
//
// 守两条：① 必须**推完整条链**（`runLiveDraw` 是一次一步的状态机，单调用只发第一枪）；
//        ② 结论和「谁验的」要落进池子（用户口径：已使用也算有效 + 记录操作者账号）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { emptyPool, loadPoolFrom, note, savePoolTo } from '../src/mcloud/koulingPool.ts';
import { verifyCode } from '../src/mcloud/tasks/liveVerify.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-11-17T02:00:00.000Z';
const SESSION = { cookie: 'c=1', jwt: 'JWT-1', deviceId: 'dev-1', savedAt: NOW };

/** 记账的假上游：余额 100 → 110，口令按 `drawCode` 回。 */
function fakeUpstream(drawCode = 0) {
  const sent: BuiltRequest[] = [];
  let balance = 100;
  const transport = (async (req: BuiltRequest) => {
    sent.push(req);
    const u = req.url;
    if (u.includes('/user/info')) {
      const body = JSON.stringify({ code: 0, msg: 'success', result: { flowerCnt: balance } });
      balance += 10;
      return { status: 200, headers: {}, body };
    }
    if (u.includes('/redFlower/draw')) {
      const r = drawCode === 0
        ? { code: 0, result: { prizeId: 1, flowerNum: 10, prizeName: '小红花' } }
        : { code: drawCode, msg: '已兑换过' };
      return { status: 200, headers: {}, body: JSON.stringify({ msg: 'x', ...r }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: 3 }) };
  }) as Transport;
  return { transport, sent };
}

function seeded(code: string) {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), NOW);
  const pool = emptyPool();
  note(pool, [code], 'xiaohongshu', Date.parse(NOW));
  savePoolTo(store, pool, NOW);
  return store;
}

test('验一条口令：推完整条链、结论与「谁验的」都落池', async () => {
  const store = seeded('甲');
  const { transport, sent } = fakeUpstream();
  const out = await verifyCode({ store, transport, nowIso: NOW }, [], '甲');
  assert.equal(out.state, 'valid');
  assert.ok(sent.length >= 10, `要推完整条链（实际 ${sent.length} 个请求）—— 单调用只发第一枪`);
  const c = loadPoolFrom(store).pool.codes.find((x) => x.value === '甲');
  assert.equal(c?.state, 'valid');
  assert.ok(c?.validatedBy !== undefined && c.validatedBy !== '', '要记下谁验的');
  // 这一趟真领到几朵要交出去：收尾那句「进账 N 朵」靠它。
  // ⚠ 以前只给状态和 note，收尾就只能拿最后一次的 note 拼 —— 2026-11-19 现场：
  //   小号验证时领了两次共 10 朵，收尾只报 5 朵，还算成「2/3 个账号好了」。
  assert.equal(out.gained, 10, '余额 100 → 110 ⇒ 这次验证进账 10 朵');
});

test('已领过（200112）也算有效', async () => {
  const store = seeded('乙');
  const { transport } = fakeUpstream(200112);
  const out = await verifyCode({ store, transport, nowIso: NOW }, [], '乙');
  assert.equal(out.state, 'valid', '口令本身是对的，只是这个号领过');
  const c = loadPoolFrom(store).pool.codes.find((x) => x.value === '乙');
  assert.equal(c?.state, 'valid');
  assert.match(String(c?.reason), /领过/);
});

test('口令不对（200108）⇒ 无效', async () => {
  const store = seeded('丙');
  const { transport } = fakeUpstream(200108);
  const out = await verifyCode({ store, transport, nowIso: NOW }, [], '丙');
  assert.equal(out.state, 'invalid');
});
