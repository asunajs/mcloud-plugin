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
// * `cloudType == 1` 是「延期领取」，走的是**另一口端点**：`receiveTaskExpansion`。
//   它是 **GET**，而且 `h5(false, …)` → 不发 `isdeviceid`。
//   ⚠️ 这一口最要紧的细节是 `acceptDate`：原实现查过原始响应，
//   **两条真实账号的 `receiveList` 里都没有 `acceptDate` 这个字段**
//   （只有 `cloudNum` / `cloudType`）⇒ 真实客户端发出去的是**裸 GET，一个参数都没有**。
//   所以这里：没有 `acceptDate` 就什么都不带；**绝不能写成 `?acceptDate=`** ——
//   原实现专门警告过「那是另一个请求」。
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

/** 从清单项里取 `acceptDate`（**有才带**，没有就返回 undefined）。
 *
 *  实测的真实清单里没有这个字段 —— 所以缺省路径是"裸 GET"。
 *  写成空串会发出 `?acceptDate=`，那是**另一个请求**（原实现专门警告过）。 */
export function readAcceptDate(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const v = (raw as Record<string, unknown>).acceptDate ?? (raw as Record<string, unknown>).accept_date;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
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
    // 延期领取：另一口端点，GET。`acceptDate` **有才带**（真实清单里没有这个字段，
    // 所以缺省路径是"裸 GET"；写成空串会变成另一个请求）
    const acceptDate = readAcceptDate(item.raw);
    const out = runTask(
      deps,
      {
        task: 'receive',
        endpoint: 'receiveTaskExpansion',
        method: 'GET',
        query: acceptDate ? `acceptDate=${encodeURIComponent(acceptDate)}` : undefined,
        // 原实现是 h5(false, …)：这一口不发 isdeviceid
        isDeviceId: false,
        stateKey: STATE_RECEIVE,
      },
      (env) => ({
        ok: true,
        note: `延期领取已完成（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
        snapshot: { item: item.raw, result: env.result ?? null },
      }),
    );
    saveQueue(deps.store, rest, deps.nowIso);
    const left1 = rest.length;
    return { ...out, note: `${out.note}${left1 > 0 ? `（队列还剩 ${left1} 条）` : '（队列已清空）'}` };
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
