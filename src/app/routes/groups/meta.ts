// meta 那一组路由（5 条）：/caps · /runs · /log/tail · /groups · /tasks
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { STATE_LAST_TASKLIST, TASK_NAMES } from '../../../mcloud/tasks/taskList.ts';
import { groupView } from '../../../mcloud/groups.ts';
import { hasBigInt, sandboxCaps } from '../../../mcloud/caps.ts';
import { parseQuery } from '../../../mcloud/query.ts';
import { readRun, recentRuns } from '../../../mcloud/runLog.ts';
import { readRing } from '../../../mcloud/logRing.ts';
import { json } from '../support.ts';
import type { RouteDeps, RouteEntry, RouteRequest } from '../support.ts';

/** meta 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function metaRoutes(deps: RouteDeps, base: string, verify: () => { ok: boolean; note: string }): RouteEntry[] {
  void verify;
  return [
{
      // 沙箱能力（**随时可问**，不用等 5 分钟一跳的自检）
      path: `${base}/caps`,
      method: 'GET',
      handler: () => json(200, { caps: sandboxCaps(), hasBigInt: hasBigInt() }),
    },

{
      // 某一次运行的**步骤**。列表只给摘要，点开才取这个 ——
      // 理由见 `runLog.ts` 的 `RunSummary`。
      // ⚠ 走**查询串**而不是 `/runs/:id`：宿主给的是 `req.query`，
      //   没有路径参数（见 `host-api.d.ts` 的 `RouteRequest`）。
      path: `${base}/runs`,
      method: 'GET',
      handler: (req) => {
        // ⚠ `req.query` 是**原始字符串** —— 要 `parseQuery` 才能按名取
        //   （见 host-api.d.ts 里那段实测记录）
        const id = parseQuery(req.query)['id'] ?? '';
        if (id === '') return json(400, { error: '要带一个 id' });
        const r = readRun(deps.store, id);
        // 找不到就 404，**不返回空对象** —— 界面据此显示"这次记录已经过期了"
        // （运行记录只留最近 N 次，用户手上那个 id 可能已经被挤掉了）
        if (r === null) return json(404, { error: `没有这次运行（可能已经被新记录挤掉了）：${id}` });
        return json(200, r);
      },
    },

{
      // 运行日志的**历史**（最近 N 行）。
      //
      // 终端面板平时靠面板的日志流（SSE），可那条流的底子是内存环 ——
      // **面板一重启就空**。所以插件自己留了一份副本（`logRing.ts`），
      // 界面首屏先读这一份，再接流看新的。
      //
      // ⚠ 这是"上一次跑到哪"的答案，不是日志系统本身：没有级别过滤、没有续传，
      //   只留最近 400 行。别拿它当审计。
      path: `${base}/log/tail`,
      method: 'GET',
      handler: (req) => {
        const q = parseQuery(req.query);
        const want = Number(q.limit ?? '200');
        const limit = Number.isFinite(want) ? Math.min(Math.max(Math.trunc(want), 1), 400) : 200;
        const all = readRing(deps.store);
        return json(200, {
          lines: all.slice(Math.max(0, all.length - limit)),
          total: all.length,
        });
      },
    },

{
      // 分组视图：把 20 条云盘任务按**风险与依赖**分组，附每条的实际状态。
      // 界面（M4）直接吃这个; 现在也能 curl 看。
      path: `${base}/groups`,
      method: 'GET',
      handler: () => json(200, groupView(deps.store)),
    },

{
      path: `${base}/tasks`,
      method: 'GET',
      handler: () => {
        let last: unknown = null;
        const raw = deps.store.getState(STATE_LAST_TASKLIST);
        try {
          last = raw ? JSON.parse(raw) : null;
        } catch {
          last = { broken: true };
        }
        // 每条任务各自的最近失败原因（base.ts 写的 `mcloud.last_error.<任务名>`）。
        // 给界面用，也让 CI 能断言「这一批任务都没报错」——如果没有这个字段，
        // 那种断言会因为拿不到数据而**永远通过**（我第一版就是这么写的，等于没测）。
        const lastErrorByTask: Record<string, string> = {};
        for (const t of TASK_NAMES) {
          const v = deps.store.getState(`mcloud.last_error.${t}`);
          if (v) lastErrorByTask[t] = v;
        }
        return json(200, {
          lastTaskList: last,
          lastErrorByTask,
          recent: deps.store.recentRuns(20),
        });
      },
    }
  ];
}
