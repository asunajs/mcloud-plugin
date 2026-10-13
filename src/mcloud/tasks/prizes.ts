// 任务：待领取奖品（`prizes`）—— 纯只读。
//
// 端点：`GET /ycloud/signin/public/record?marketname=…&type=…&pageNumber=…&pageSize=…`
// 参数逐字抄自 `mcloud-tasks/src/signin.rs:723`：`prize_record_request(MARKET_NAME, 1, 1, 10)`
// —— 也就是 **type=1、第 1 页、每页 10 条**。
// （我一开始按「待领取」猜 `type=0` / 每页 100 ✗，查了调用点才发现是 1 / 10。）
//
// 只读、无需设备号、`isdeviceid` 不发（原实现是 `h5(false, …)`）。

import { resultArray } from '../envelope.ts';
import type { SignInEnvelope } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 落盘键：最近一次查到的奖品列表。 */
export const STATE_PRIZES = 'mcloud.prizes.last';

/** 查询用的参数（原实现的调用点就是这么传的）。 */
export const PRIZE_QUERY = {
  status: 1,
  pageNumber: 1,
  pageSize: 10,
} as const;

export function prizeQuery(market: string): string {
  return (
    `marketname=${encodeURIComponent(market)}` +
    `&type=${PRIZE_QUERY.status}` +
    `&pageNumber=${PRIZE_QUERY.pageNumber}` +
    `&pageSize=${PRIZE_QUERY.pageSize}`
  );
}

export function runPrizes(deps: TaskDeps, market = 'sign_in_3'): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'prizes',
      endpoint: 'prizeRecord',
      method: 'GET',
      query: prizeQuery(market),
      isDeviceId: false,
      stateKey: STATE_PRIZES,
    },
    (env: SignInEnvelope) => {
      // 这一口的 `result` 是数组（形状不同的端点各写各的解析，不做兼容）
      const list = resultArray(env);
      const items = list.map((x) => {
        const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
        return {
          id: typeof o.id === 'number' ? o.id : undefined,
          name: typeof o.name === 'string' ? o.name : undefined,
          state: typeof o.state === 'string' ? o.state : undefined,
        };
      });
      const unreceived = items.filter((i) => (i.state ?? '').toUpperCase().includes('UNRECEIVED'));
      return {
        ok: true,
        note: `奖品 ${items.length} 条（未领取 ${unreceived.length} 条）`,
        snapshot: items,
      };
    },
  );
}
