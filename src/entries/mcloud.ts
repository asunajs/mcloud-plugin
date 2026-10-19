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
  worker_hint,
} from 'host-api';
import { mcloudRoutes } from '../mcloud/routes.ts';
import type { RouteEntry } from '../mcloud/routes.ts';
import { makeHost, makePushDeps, makeStore, makeTransport } from './shared.ts';
import { selftest } from '../selftest.ts';
import { migrateLegacyExchange, syncTaskReadiness } from '../mcloud/taskReadiness.ts';

// `mcloud` 是服务型插件，但 /beans/today 与 /beans/records 是逐账号 × 翻页的
// 长只读链，声明了 >2s 的预算；没有独占线程会把同线程上其它插件一起拖住。
worker_hint('exclusive');

const store = makeStore();
// 老库一次性迁移：上一版兑换默认“全部账号”，定时默认启用。
// 先迁移再同步，否则第一条注册算出来的 blockers 会停在“还没有选账号”。
const bootIso = new Date().toISOString();
if (migrateLegacyExchange(store, bootIso)) {
  log('老库迁移：兑换的账号选择沿用“全部账号”（这一版改成显式选择）');
}
syncTaskReadiness(store);

// transport 的 `timeoutMs` 是**每一发请求**的超时（1500ms），与路由的**执行预算**
// 是两件事：预算是"这一条 handler 从头跑到尾能占多久"，面板默认 2 秒。
// 大多数路由（点一下读一格）用默认档就够；像「今日AI豆」那样逐账号 × 翻页的
// 只读链，2 秒撑不到读完 —— 它在 `routes.ts` 里自己声明 `budget_ms`，
// 下面注册时透给 `register_route`。
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
    pushDeps: makePushDeps(transport),
  })) {
    register_route(r.path, r.method, r.handler, r.budget_ms === undefined ? undefined : { budget_ms: r.budget_ms });
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
