// 「今日云朵」—— 每个账号收尾时的一行读数。
//
// # 端点用**当前**那一支：`cloudRecordV2`，不是参考实现里的旧 `cloudRecord`
//
// 参考实现 `mcloud-sign` 的 `afterTask::printTodayCloud` 打的是
//   `GET https://mrp.mcloud.139.com/market/signin/public/cloudRecord?type=1&…`
// 2026-10-23 第一次补这一行时照抄了它，真跑也能出数（「2 次 / 9 朵」）。
// **但那是过时的端点**：现在的 H5 签到页只定义 `getAIBeanRecordData`
//   `GET https://m.mcloud.139.com/ycloud/signin/public/cloudRecordV2`
// （`har/h5-signin/newsignin.336f18c3.js`，两个 API 对象里都是这一条），
// 参数是 `{aiDou, type, pageNumber, pageSize}`。
//
// 所以这里改走 V2，与面板「今日AI豆」**同一条数据源、同一套翻页口径**
// （`beansRead.ts::readDayForAccount`），不再维护第二套解析。
//
// # 为什么是 `aiDou=1`，不是 `aiDou=0`
//
// H5 云朵明细页自己的公告写着：2026-07-31 云朵按 1:1 转成「云盘专属 AI豆」，
// `aiDou=0` 那本账**只展示 2016-01-01 ~ 2026-07-30 的历史**；之后获得的都进
// `aiDou=1`。今天的进账只可能在后者 —— 拿 `aiDou=0` 只会得到 0。
//
// # 判据是用户看到的那一行，不是"照抄参考实现的端点"
//
// 2026-10-23 只读探针（真账号，两个端点各打一次）：
//   · 旧 `cloudRecord`：2 次 / 9；
//   · V2 `aiDou=1`：2 笔 / 9（`count=2, gained=9`）。
// 换成 V2 后用户可见读数不变，而用的是当前客户端在用的接口。
// 这条更正记在 `docs/auth-families.md` §2。
//
// # 只数今天、只数进账
//
// 日界与时间归一都在 `beans.ts`（东八区自然日；V2 的 `inserttime` 带显式偏移）。
// 文案里的「N 次」数的是 `num > 0` 的笔数（`gainedCount`），不是今天的全部流水
// （`count` 含支出；今天兑过一次奖就会差一笔）。
//
// # 读失败不改整趟的成败
//
// 这是一行读数，不是动作。读失败只打一句 info 继续跑；返回 `ok: true, idle: true`，
// 但说的必须是实话（「没读到云朵记录（原因）」）。用「没读到」而不是「失败」，
// 避免被日常推送里的 `includes('失败')` 误列进失败项。

import { readDayForAccount } from '../beansRead.ts';
import { depsNowMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export function runTodayCloud(deps: TaskDeps): TaskOutcome {
  let gained: number;
  let gainedCount: number;
  try {
    const day = readDayForAccount(
      {
        store: deps.store,
        transport: deps.transport,
        nowIso: deps.nowIso,
        baseUrl: deps.baseUrl,
      },
      depsNowMs(deps),
    );
    gained = day.gained;
    gainedCount = day.gainedCount;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: true, idle: true, note: `没读到云朵记录（${why}）` };
  }
  // 文案照参考实现的那一句；行首的任务名由日志层补。
  return { ok: true, idle: true, note: `今日获得${gainedCount}次云朵数量共：${gained}` };
}
