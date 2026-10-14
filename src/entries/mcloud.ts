// 插件 `mcloud` —— 路由 / 登录 / 设置 / 读数 / 侧边栏入口。
//
// # 这个插件故意**没有 cron 任务**
//
// 它是四个插件里唯一的一个「服务型」插件：只提供 HTTP 路由给界面用。
// 三条用户可见的任务在 `mcloud-daily` / `mcloud-exchange` / `mcloud-live` 里 ——
// 分开的理由见 `shared.ts` 的文件头（面板的分配单位是插件，一个插件的任务共用线程）。
//
// 好处直接体现在面板上：任务列表只有 3 条用户看得懂的任务，而不是 25 条。
//
// # 为什么它声明侧边栏入口
//
// 面板从插件名推不出人话（`mcloud` 该显示成什么？）。所以标签、图标由插件自己给。
// 页面路径沿用面板已有的约定（`plugins/<name>/index.html`），不给就默认那个。

import {
  error,
  log,
  register_nav,
  register_route,
} from 'host-api';
import { mcloudRoutes } from '../mcloud/routes.ts';
import type { RouteEntry } from '../mcloud/routes.ts';
import { makeHost, makeStore, makeTransport } from './shared.ts';
import { selftest } from '../selftest.ts';

const store = makeStore();
// 路由是「用户点一下」触发的，不是长链 —— 用默认的短超时（预算 2 秒那一档）
const transport = makeTransport();
const host = makeHost();

// ── 侧边栏入口 ──
register_nav({
  label: '云盘',
  icon: '☁',
  // 不写 path：面板默认 `plugins/mcloud/index.html`，正是我们放页面的地方
});

// ── 路由 ──
let registered = 0;
try {
  for (const r of mcloudRoutes({
    store,
    transport,
    now: () => new Date().toISOString(),
    log: (msg) => log(msg),
    ws: host,
  })) {
    register_route(r.path, r.method, r.handler);
    registered++;
  }
} catch (e) {
  // 路由注册失败 = 整个界面点不动。必须让它可见，而不是留一个空白页面。
  error(`路由注册失败（第 ${registered + 1} 条）：${e instanceof Error ? e.message : String(e)}`);
  throw e;
}

// ── 自检也做成一条路由 ──
//
// 为什么是路由而不是 cron：老的写法是一条每 5 分钟跑一次的 `selftest` 任务，
// 那是「面板上 25 条任务」里的两条之一 —— 用户看不懂「自检」是什么，
// 也不该为它操心。改成路由之后，界面在「设置」页里点一下就能看到，
// 而且**随时可问**（不用等下一次触发）。
//
// 它验的是沙箱这一层（QuickJS + 无 TextEncoder/Buffer/crypto + SQLite），
// 因为「Node 里绿」和「沙箱里绿」是两件事 —— 不对的话表现是
// 「上游回一个签名错误」，在真机上排查很贵。
const selftestRoute: RouteEntry = {
  path: '/plugins/mcloud/api/selftest',
  method: 'GET',
  handler: () => {
    const r = selftest(store);
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(r),
    };
  },
};
register_route(selftestRoute.path, selftestRoute.method, selftestRoute.handler);

store.setState('plugin.loaded_at', new Date().toISOString(), new Date().toISOString());
log(`mcloud（服务型）：${registered + 1} 条路由 + 侧边栏入口，**没有 cron 任务**`);
