// 薄壳：真正的路由在 `src/app/routes/`（每组一个文件，见那里的 index.ts 头注）。
//
// 保留这个文件是因为 `entries/mcloud.ts` 与既有文档都按 `mcloud/routes` 找它；
// 里面**不再有实现** —— 改路由请去 `src/app/routes/groups/<组>.ts`。

export { PLUGIN, mcloudRoutes } from '../app/routes/index.ts';
export type { RouteDeps, RouteEntry, RouteRequest, RouteResponse } from '../app/routes/support.ts';
