// 任务：领取 AI豆（`receive`）—— 动作类，**逐条独立**，且清单来自 `infoV3`。
//
// # 三步（一次调用只走一步，状态落盘）
//
//   ① 问状态：`infoV3` → `receiveList`（待领清单）。空 → 收工（今天没得领）
//   ② 清单有货、但本地队列是空的 → 把清单**抄进队列**（不取任何奖品）
//   ③ 队列有货 → 取一条领（`receiveV3`），领完从队列里划掉
//
// 为什么"逐条独立"：原实现的注释写得清楚 —— `receiveList` 里每一条彼此无关，
// 一条失败不该影响另一条（`tests.rs:1207` 附近还专门有个用例盯着这件事）。
// 所以这里一次只处理一条，成败只记在那一条头上。
//
// # 两个必须照抄的细节
//
// * `cloudType` 缺省是**空串**（不是 0）：H5 写的是 `e.cloudType ?? ""`。
//   0 是合法取值（当前可领取），缺省给 0 会被上游当成"要的是第 0 类"。
// * `cloudType == 1` 是「延期领取」，走的是**另一口端点**（`receiveTaskExpansion`）。
//   这条**没实现**（不在本批范围）：碰到它就跳过并如实写在 note 里，
//   免得队列卡死在那儿反复重试。
//   ⚠️ 顺带一个必须知道的后果：跳过 ≠ 上游那边消失 —— 下一次问清单，它**还会回来**。
//   所以这件事每 15 分钟会重复一次（每次一个只读请求 + 一次跳过），直到
//   `receiveTaskExpansion` 被实现。这是可接受的成本，但要知道它在发生。
//
// 请求体逐字（`receive_v3_request`）：`{client:"app", cloudId, cloudType, deviceId}`，
// 而且这一口是 `h5(true, …)` → **发 `isdeviceid`**。

import { fetchInfoV3 } from './info.ts';
import type { ReceiveItem } from './info.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';

export const STATE_QUEUE = 'mcloud.receive.queue';
export const STATE_RECEIVE = 'mcloud.receive.last';

/** 队列的存取（就是一段 JSON，放在 state 里）。 */
export function loadQueue(store: { getState(k: string): string | null }): ReceiveItem[] {
  const raw = store.getState(STATE_QUEUE);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((o) => ({
        recordId: typeof o.recordId === 'string' ? o.recordId : '',
        cloudType: typeof o.cloudType === 'number' ? o.cloudType : undefined,
        raw: o.raw,
      }));
  } catch {
    return [];
  }
}

function saveQueue(
  store: { setState(k: string, v: string, at: string): void },
  q: ReceiveItem[],
  nowIso: string,
): void {
  store.setState(STATE_QUEUE, JSON.stringify(q), nowIso);
}

/** `receiveV3` 的请求体（逐字照抄，`cloudType` 缺省空串）。 */
export function receiveV3Body(cloudId: string, cloudType: number | undefined, deviceId: string): string {
  return JSON.stringify({
    client: 'app',
    cloudId,
    cloudType: cloudType === undefined ? '' : cloudType,
    deviceId,
  });
}

export function runReceive(deps: TaskDeps): TaskOutcome {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: '未登录：state 里没有会话（见 docs/howto-session.md）' };
  }

  let queue = loadQueue(deps.store);

  // ① 队列空 → 去问一下清单（这一步**只读**，不领东西）
  if (queue.length === 0) {
    const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
    if (!info.ok) return { ok: false, note: `查询待领清单失败：${info.error}` };
    if (info.info.receiveList.length === 0) {
      return { ok: true, skipped: true, note: '没有待领取的东西（infoV3.receiveList 为空）' };
    }
    // ② 抄进队列（含延期领取那条 —— 下一轮会跳过它并说明原因）
    saveQueue(deps.store, info.info.receiveList, deps.nowIso);
    return {
      ok: true,
      note: `发现 ${info.info.receiveList.length} 条待领取，已入队（下面几次触发逐条领）`,
    };
  }

  // ③ 领一条
  const item = queue[0]!;
  const rest = queue.slice(1);

  if (item.cloudType === 1) {
    // 延期领取走另一口端点，这条没实现 —— 跳过并说明，别让队列卡死
    saveQueue(deps.store, rest, deps.nowIso);
    return {
      ok: true,
      skipped: true,
      note: '这一条是延期领取（cloudType=1，走 receiveTaskExpansion）—— 本批未实现，已跳过',
    };
  }

  const out = runTask(
    deps,
    {
      task: 'receive',
      endpoint: 'receiveV3',
      method: 'POST',
      body: receiveV3Body(item.recordId, item.cloudType, session.deviceId ?? ''),
      stateKey: STATE_RECEIVE,
    },
    (env) => ({
      ok: true,
      note: `已领取（cloudId=${item.recordId || '空'}；上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
      snapshot: { item: item.raw, result: env.result ?? null },
    }),
  );

  // 不管成没成，这条都从队列里划掉：失败了留在队列里会陷入重试死循环，
  // 而"逐条独立"的语义本来就允许某一条失败（下一天会重新入队再来）
  saveQueue(deps.store, rest, deps.nowIso);
  const left = rest.length;
  return { ...out, note: `${out.note}${left > 0 ? `（队列还剩 ${left} 条）` : '（队列已清空）'}` };
}
