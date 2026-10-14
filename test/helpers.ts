// 测试共用的小工具。
//
// # 为什么要有 `testDeps`
//
// `RouteDeps` 会随着插件长出新能力而变多（`ws` / `pushDeps` …），
// 而每个测试都自己写一遍字面量 ⇒ **每加一个字段就要改十几个测试文件**。
// 抽成一个函数之后，只有这一处要改。
//
// ⚠ 这些字段在类型上是**必填**的（有意的）：真入口忘了注入的话，
// 对应的功能会当场崩，而不是静默失效。测试里给的是桩。

import type { RouteDeps } from '../src/mcloud/routes.ts';
import type { Transport } from '../src/mcloud/client.ts';
import type { Store } from '../src/store/types.ts';

/** 一个什么都不发的 transport（路由层的测试用不到真请求时用这个）。 */
export const noopTransport: Transport = () => ({ status: 200, headers: {}, body: '' });

/** 造一份 `RouteDeps`。只传你用得到的，其余给桩。 */
export function testDeps(
  store: Store,
  opts: {
    transport?: Transport | undefined;
    now?: string | undefined;
    log?: ((m: string) => void) | undefined;
    ws?: RouteDeps['ws'];
    pushDeps?: RouteDeps['pushDeps'] | undefined;
  } = {},
): RouteDeps {
  const now = opts.now ?? '2026-10-15T00:00:00.000Z';
  const log = opts.log ?? ((): void => {});
  return {
    store,
    transport: opts.transport ?? noopTransport,
    now: () => now,
    log,
    ...(opts.ws !== undefined ? { ws: opts.ws } : {}),
    pushDeps: opts.pushDeps ?? {
      http: () => ({ ok: true, status: 200, body: '{}', error: undefined }),
      smtp: () => ({ ok: true, response: '250 ok' }),
      nowMs: () => Date.parse(now),
      log,
    },
  };
}
