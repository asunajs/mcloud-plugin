// 路由表的**组合点**：每组一个文件，这里只负责拼起来。
//
// 拆的理由见 support.ts 的头注：原来是 3400 行一坨。现在「找哪条路由」= 看路径前缀。
// 每个组的签名统一是 `(deps, base, verify)`：
//   · deps   —— 路由依赖（store / transport / now / log / ws / pushDeps）
//   · base   —— `/plugins/mcloud/api`
//   · verify —— 「拿当前会话去上游验一次」，登录那组要用（会话可能刚换）
//
// ⚠ 顺序只影响「同一路径多条路由」时的匹配（目前没有重复），但**别**改成
//   组内重排 —— 那会让 diff 变噪音。

import { PLUGIN } from './support.ts';
import type { RouteDeps, RouteEntry } from './support.ts';
import { loadBaseUrl, verifySession } from '../../mcloud/session.ts';
import { accountsRoutes } from './groups/accounts.ts';
import { beansRoutes } from './groups/beans.ts';
import { exchangeRoutes } from './groups/exchange.ts';
import { liveRoutes } from './groups/live.ts';
import { loginRoutes } from './groups/login.ts';
import { metaRoutes } from './groups/meta.ts';
import { pushRoutes } from './groups/push.ts';
import { settingsRoutes } from './groups/settings.ts';

/** 路由表。四个入口遍历它去调用真的 `register_route`。 */
export function mcloudRoutes(deps: RouteDeps): RouteEntry[] {
  const base = `/plugins/${PLUGIN}/api`;
  // 基址**每次调用时从 state 读**，而不是用注入的那份快照 ——
  // 否则「刚把基址指到 mock，导入会话却去打了真上游」：配置改了要立刻生效
  const verify = (): { ok: boolean; note: string } =>
    verifySession({
      store: deps.store,
      transport: deps.transport,
      nowIso: deps.now(),
      baseUrl: loadBaseUrl(deps.store),
    });

  return [
    ...metaRoutes(deps, base, verify),
    ...settingsRoutes(deps, base, verify),
    ...pushRoutes(deps, base, verify),
    ...loginRoutes(deps, base, verify),
    ...accountsRoutes(deps, base, verify),
    ...exchangeRoutes(deps, base, verify),
    ...liveRoutes(deps, base, verify),
    ...beansRoutes(deps, base, verify),
  ];
}

export { PLUGIN };
export type { RouteDeps, RouteEntry, RouteRequest, RouteResponse } from './support.ts';
