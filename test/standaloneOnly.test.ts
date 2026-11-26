// CLI 那一半的 `--only` / `--force`（R3：两端同一套行为）。
//
// 面板侧由 `e2e-mock.sh` 第 ⑭ 节真跑；这一篇钉 CLI 侧**同一个函数**
// （`runDailyAll`）在 `only` 下的行为 —— 不发真请求，用一个记账的 transport。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDailyAll } from '../src/standalone/daily.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import { jwtKey } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import type { Runtime } from '../src/standalone/runtime.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const NOW = '2026-11-26T09:00:00.000Z';

function pageModule(): string {
  return JSON.stringify({
    code: 0,
    msg: 'success',
    result: {
      moduleId: '1-250730',
      subtitle: '趣玩AI赢好礼',
      drawTimes: 0,
      drawsUsed: 0,
      todayGetLotteryCount: 0,
      taskIds: [
        // 只有"我们不会做"的，避免动作链去打真主机
        { id: '003', taskName: '智能抠图，一键抠图超轻松', taskSign: 0, isComplete: 0, innerLink: '' },
        { id: 'invite', taskName: '邀请好友', taskSign: 1, isComplete: 0, innerLink: '' },
      ],
    },
  });
}

function makeRuntime(): { rt: Runtime; sent: BuiltRequest[] } {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  const made = upsertAccount(store, 'Basic cGM6dG9rZW4=', NOW, '移动');
  // ⚠ 票是**按账号**存的（`scoped`），写在裸 store 上这一族的 `session()` 读不到 ——
  //   第一次就这么红的（表现为"还没有可用的 H5 票"，一个 funai 请求都不发）。
  // `memStore()` 本身已经是 scoped 的 ⇒ 先取裸 store 再按账号包一层
  const bag = scoped(rawStoreOf(store), made.account.id);
  // ⚠ 票的键是**带账号 id** 的（`jwtKey()` 拼出来，`mcloud.h5.jwt.<id>`），
  //   不是裸 `STATE_JWT` —— 写裸键这一族读不到（表现同样是"还没有可用的 H5 票"）。
  bag.setState(jwtKey(bag), JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  bag.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('/funai/api/page/getmodule')) return { status: 200, headers: {}, body: pageModule() };
    if (url.includes('/funai/api/timed/getmodule')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: 'success', result: [] }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 90001, msg: '未登录' }) };
  }) as never;
  const rt = {
    config: { accounts: [], common: {}, http: {}, path: '/tmp/x.json', stateFile: '/tmp/x.state.json' },
    rawStore: store,
    store,
    transport,
    nowIso: NOW,
    depsFor: () => {
      throw new Error('这一篇不用它');
    },
    listenDepsFor: () => {
      throw new Error('这一篇不用它');
    },
    close: () => {},
  } as unknown as Runtime;
  return { rt, sent };
}

test('CLI `--only playAI --force` ⇒ 只打趣玩AI 的请求，其它族一个都不发', async () => {
  const { rt, sent } = makeRuntime();
  const out = await runDailyAll(rt, { only: ['playAI'], force: true });
  assert.equal(out.length, 1, '一个账号跑出一条结果');
  // 只该有 funai 的两发
  const urls = sent.map((x) => String(x.url));
  assert.ok(urls.some((u) => u.includes('/funai/api/page/getmodule')), '要读门户页模块');
  assert.ok(urls.some((u) => u.includes('/funai/api/timed/getmodule')), '要读主题模块');
  assert.equal(
    urls.some((u) => u.includes('/signin/') || u.includes('/tokenpk/')),
    false,
    `别的族不该发请求：${urls.join(' | ')}`,
  );
  // 步骤名里要有趣玩AI，且其它族是"这次不跑"
  const names = out[0]!.steps.map((s) => `${s.name}=${s.note}`);
  assert.ok(names.some((x) => x.startsWith('趣玩AI=')), names.join(' | '));
  assert.ok(
    names.some((x) => /这次不跑/.test(x)),
    `没被点到的族要留一行「这次不跑」：${names.join(' | ')}`,
  );
});
