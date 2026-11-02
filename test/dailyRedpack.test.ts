// 红包派对必须真的接进**日常那一趟**，而且用户看得见那几张行。
//
// CLI 只打 `runDaily` 返回的 `detail`（`standalone/mcloudSign.ts`），面板也用它组日志流
// 与推送正文 ⇒ 这一族的逐行只要没进 `detail`，用户在两边就只剩一句「红包派对：好了」。
// 这条测试钉的是**接线**（步骤在不在、行到没到 detail、开关关掉时一枪都不发），
// 逐行文案本身在 `redpack.test.ts`。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/mcloud/dailyRun.ts';
import { STATE_AUTH } from '../src/mcloud/sessionExchange.ts';
import { setRedpackEnabled } from '../src/mcloud/tasks/redpackState.ts';
import { memStore } from '../src/store/memory.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-23T02:00:00.000Z';
const AUTH = 'Basic bW9iaWxlOjE5OTAwMDAwMDAwOnRva2Vu';

/** 红包那一族回真读数（一条任务的表），其余每一族都回「未登录」——
 *  不是要它们跑成，而是让整趟快速走到尾部，别把这条测试变成全链路测试。 */
function transportFor(redpack: boolean): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport = ((req: { url: string; body?: string }) => {
    const path = req.url.slice(req.url.indexOf('/', 8));
    sent.push(path);
    if (!redpack || !path.includes('/cloudphone-market')) {
      // 换 SSO 票那一枪两族共用同一条路径 ⇒ 给它成功，红包才走得下去；
      // 其余每一族照旧回「未登录」（快速走到尾部，不把这条测试变成全链路测试）。
      if (path.includes('/user/querySpecTokenV2')) {
        return { status: 200, headers: {}, body: JSON.stringify({ success: true, code: '0000', data: { token: 'SSO-1' } }) };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
    }
    const ok = (data: unknown) => ({ status: 200, headers: {}, body: JSON.stringify({ header: { status: 200 }, data }) });
    if (path.includes('/tokenValidate')) return ok({ token: 'RP-1' });
    if (path.includes('/configTaskLoginList')) {
      return ok({
        configTaskSignList: [],
        configTaskNoviceList: [],
        configTaskDailyList: [
          { id: 21, taskCode: 'OTHER_9', taskName: '体验任意一款云应用', userStatus: 0, prizeAmount: 10 },
        ],
        configTaskMonthlyList: [],
      });
    }
    if (path.includes('/userAccountInfo')) return ok({ info: { canAmount: 300, totalAmount: 460 } });
    return ok({ status: 1 });
  }) as unknown as Transport;
  return { transport, sent };
}

function depsFor(redpack: boolean): { deps: TaskDeps; sent: string[] } {
  const store = memStore();
  store.ensureSchema();
  store.setState(STATE_AUTH, AUTH, NOW);
  if (!redpack) setRedpackEnabled(store, false, NOW);
  const { transport, sent } = transportFor(redpack);
  return { deps: { store, transport, nowIso: NOW, nowMs: () => Date.parse(NOW), settleMs: 0, gapMs: [0, 0] }, sent };
}

test('开着 ⇒ 红包那一族的逐行进 `detail`，步骤名与小结也在', () => {
  const { deps, sent } = depsFor(true);
  const r = runDaily(deps);
  const step = r.steps.find((s) => s.name === '红包派对');
  assert.notEqual(step, undefined, '日常里必须有这一步（参照实现的默认入口就是每日任务）');
  assert.ok(r.detail.some((l) => l.startsWith('余额: 可用')), r.detail.join('\n'));
  assert.ok(r.detail.some((l) => l === '每日任务'), r.detail.join('\n'));
  assert.ok(
    r.detail.some((l) => l === '需手动完成: 体验任意一款云应用 (0.10元) (未知任务)'),
    r.detail.join('\n'),
  );
  // 小结用的是台账那句（`drain` 会把长原话折成「红包派对：好了」，那是另一种口径）
  assert.match(step?.note ?? '', /未完成 \d+、已完成 \d+/);
  // 逐行**排在**那一步的小结前面（先看到过程，再看到结论）
  const firstLine = r.detail.findIndex((l) => l.startsWith('余额: 可用'));
  const tally = r.detail.findIndex((l) => l.startsWith('红包派对：'));
  assert.ok(firstLine >= 0 && tally > firstLine, `firstLine=${String(firstLine)} tally=${String(tally)}`);
  assert.ok(sent.some((p) => p.includes('/cloudphone-market/redpacket/configTaskLoginList')));
});

test('关掉 ⇒ 这一族一步都不做，也不往活动站发任何东西', () => {
  const { deps, sent } = depsFor(false);
  const r = runDaily(deps);
  const step = r.steps.find((s) => s.name === '红包派对');
  assert.equal(step?.idle, true);
  assert.ok(!r.detail.some((l) => l.startsWith('余额: 可用')), r.detail.join('\n'));
  assert.equal(sent.filter((p) => p.includes('/cloudphone-market')).length, 0);
  // 关掉 ≠ 没跑：界面要说清是"没开"，而不是"今天没事"
  assert.match(step?.note ?? '', /没开/);
});
