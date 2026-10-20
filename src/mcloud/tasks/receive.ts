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

/**
 * AI豆账目的三种类型 —— 抄自 `mcloud` 的 `app_signin::cloud_type`。
 *
 * ⚠ **这不是装饰**。`2`（下月可领取）在 H5 里只弹一句提示，**一个请求都不发**。
 * 把它当"现在可领"去发 `receiveV3`，服务端会回 `{code:0, result:{receive:0}}`：
 * 看着是成功、实际一分没进账 —— 而旧代码还把队列里那条的 `cloudNum` 当成
 * "领到了"，于是每天日志都写「领取到 78 个云朵」，流水却一条没有
 * （用户 2026-10-19 报的就是这个）。
 */
export const CLOUD_TYPE = {
  /** 当前可领取 ⇒ `receiveV3` */
  NOW: 0,
  /** 已到期、现在能领 ⇒ `receiveTaskExpansion`（GET，另一口端点） */
  EXPANSION: 1,
  /** 下月可领取 ⇒ **什么都不发** */
  NEXT_MONTH: 2,
} as const;

/** 领到几个 —— **只认响应里的 `result.receive`**，不从队列那一条猜。
 *
 *  参考实现（`mcloud` 的 `parse_receive_v3`）读的就是这个字段，
 *  缺了它算"解析失败"，而不是拿别的数顶上去。 */
export function receiveAmountOf(env: unknown): number | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const r = (env as { result?: unknown }).result;
  if (typeof r !== 'object' || r === null) return undefined;
  const n = (r as { receive?: unknown }).receive;
  return typeof n === 'number' ? n : undefined;
}

/** 队列项里的云朵数（没有就是 undefined）。
 *
 *  ⚠ 它只是**清单上标着多少**，不是"这一枪领到了多少" —— 两者别混用。 */
function numOf(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const n = (raw as { cloudNum?: unknown }).cloudNum;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

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

/** ⚠ 614 / 615 **不是在限流**，是 `deviceId` 的问题 —— 别照着上游文案归类。
 *
 *  抓包实证（`mcloud-capture/docs/capture/app-signin-samples.txt` §4.2，2026-09-19
 *  账号 B，同一条请求只换 `deviceId` 一项）：
 *
 *  | `deviceId` | code | 上游 msg（**骗人的**） |
 *  |---|---|---|
 *  | 不带 | `615` | 活动太火爆啦，**兑换失败**，试试其他奖品吧 |
 *  | 长度对、只错一个字符 | `614` | 活动太火爆啦，**锁定失败**，试试其他奖品吧 |
 *  | 真实值（`B` + 88 字符 base64 ⇒ 64 字节） | `0` | 正常 |
 *
 *  而且那份**有效值不是登录时那个** `device_id`：mcloud 实测拿它去领回来的是 `614`
 *  （`signin.rs::h5_device_id` 的文档记了这次复现）—— 有效的那个要靠 **smid 指纹链**
 *  换回来，而本插件**没有实现那条链**。
 *
 *  ⇒ 这一族在"只有原生凭据 / 手工贴的会话"下**大概率就是领不了**，
 *  而界面看到的那句话（"活动太火爆"）会让人以为过会儿就好。
 *  翻出来，是为了让**参数问题**不再伪装成**稍后再试**。
 *
 *  2026-10-14 真机复现：换票建出来的会话没有 `deviceId` ⇒ 这一枪回的就是 `615`。 */
export function explainReceiveFail(
  env: { code?: number | undefined } | undefined,
  raw: string,
): string | undefined {
  // ⚠ 优先用信封里的数字码；**退路是从原话里抠** ——
  // 真机上跑到这一枪时 `env` 往往是空的（`callOnce` 的失败形状只保证有字符串），
  // 只认 `env.code` 的话这个钩子在真机上**一次都不会生效**（实测踩过）。
  let code = env?.code;
  if (typeof code !== 'number') {
    const m = /\bcode=(-?\d+)/.exec(raw);
    if (m) code = Number(m[1]);
  }
  if (code === 615) {
    return '领取失败：这一枪**没带 `deviceId`**（服务端文案说"活动太火爆啦"，但它不是在限流）。' +
      '领取类接口要一份 **H5 的 deviceId**，那份得靠 smid 指纹链换回来 —— 本插件还没实现那条链；' +
      '在会话 JSON 里手工带上 `deviceId`（`B` + 88 字符 base64）即可用。';
  }
  if (code === 614) {
    return '领取失败：`deviceId` **内容无效**（服务端文案说"锁定失败"，同样不是在限流）。' +
      '⚠ 登录时那个 `device_id`（32 hex + `-ENDIN`）**不是** H5 要的那一份 —— ' +
      'mcloud 实测拿它去领回的就是这个 614。H5 要的是 `B` + 88 字符 base64。';
  }
  return undefined;
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
    return { ok: false, note: '还没有网页会话 —— 上面「换票」那一步说了原因' };
  }

  let queue = loadQueue(deps.store);
  const hadQueue = queue.length > 0;

  // ①a 先把队头的「下月可领」摘掉，**不能让它把后面今天可领的挡住**。
  //   现场（2026-10-20）：移动的队列是 `[下月 164, 今天可领 6]`，旧代码处理队头
  //   直接返回 `skipped`，`drain` 见 `skipped` 就停 —— 后面那 6 个一个请求都没发，
  //   日志却只说「下月可领取」。
  const nextMonth: ReceiveItem[] = [];
  while (queue.length > 0 && queue[0]!.cloudType === CLOUD_TYPE.NEXT_MONTH) {
    nextMonth.push(queue[0]!);
    queue = queue.slice(1);
  }
  if (nextMonth.length > 0) saveQueue(deps.store, queue, deps.nowIso);
  // 队列本来就是空的 ⇒ 还要去问上游清单（下面 ①）；只有"本来有、摘完没了"才收工。
  if (hadQueue && queue.length === 0) {
    const nums = nextMonth
      .map((x) => numOf(x.raw))
      .filter((n): n is number => n !== undefined);
    return {
      ok: true,
      skipped: true,
      note:
        nums.length > 0
          ? `下月可领取（${nums.join('、')} 个）—— 今天不发请求`
          : '无待领取的云朵',
    };
  }

  // ① 队列空 → 去问一下清单（这一步**只读**，不领东西）
  if (queue.length === 0) {
    const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
    if (!info.ok) return { ok: false, note: `查询待领清单失败：${info.error}` };
    if (info.info.receiveList.length === 0) {
      return { ok: true, skipped: true, note: '无待领取的云朵' };
    }
    // ② 抄进队列（含延期领取那条 —— 下一轮会跳过它并说明原因）
    saveQueue(deps.store, info.info.receiveList, deps.nowIso);
    const nextMonth = info.info.receiveList.filter(
      (x) => x.cloudType === CLOUD_TYPE.NEXT_MONTH,
    ).length;
    const now = info.info.receiveList.length - nextMonth;
    return {
      ok: true,
      // 清单里混着「下月可领」时要说清 —— 否则"待领取 2 个"会让人以为今天能领两个，
      // 而实际上今天一个请求都不会为它们发（见 CLOUD_TYPE 的说明）。
      note:
        nextMonth === 0
          ? `待领取 ${now} 个`
          : `待领取 ${now + nextMonth} 个（${nextMonth} 个是「下月可领」，今天不发请求）`,
    };
  }

  // ③ 领一条
  const item = queue[0]!;
  const rest = queue.slice(1);

  if (item.cloudType === CLOUD_TYPE.EXPANSION) {
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
        note: `延期领取已完成（服务端回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
        snapshot: { item: item.raw, result: env.result ?? null },
      }),
    );
    saveQueue(deps.store, rest, deps.nowIso);
    const left1 = rest.length;
    // 队列还剩几条是内部的事，不进日志（用户只看领到几个）
    void left1;
    return out;
  }

  const out = runTask(
    deps,
    {
      task: 'receive',
      endpoint: 'receiveV3',
      method: 'POST',
      body: receiveV3Body(item.recordId, item.cloudType, session.deviceId ?? ''),
      stateKey: STATE_RECEIVE,
      // 615/614 的原话是"活动太火爆啦"，而真相是 deviceId 的事 —— 翻成人话
      explainFail: explainReceiveFail,
    },
    (env) => {
      const got = receiveAmountOf(env);
      const snapshot = { item: item.raw, result: env.result ?? null };
      // ⚠ 数量**只认响应**。旧代码拿队列那一条的 `cloudNum` 顶上，于是
      //   "清单上标着 78"被说成了"领到了 78"—— 而响应里其实是 `receive: 0`。
      if (got === undefined) {
        return {
          ok: false,
          note: '响应里没有 `result.receive` —— 不能确认领到了什么（不猜）',
          snapshot,
        };
      }
      if (got <= 0) {
        return {
          ok: false,
          note: '服务端回「领到 0 个」—— 这一笔没进账（多半是已经领过，或者类型不对）',
          snapshot,
        };
      }
      return { ok: true, note: `领到 ${got} 个云朵`, snapshot };
    },
  );

  // 不管成没成，这条都从队列里划掉：失败了留在队列里会陷入重试死循环，
  // 而"逐条独立"的语义本来就允许某一条失败（下一天会重新入队再来）
  saveQueue(deps.store, rest, deps.nowIso);
  const left = rest.length;
  // 队列还剩几条是内部的事，不进日志
  void left;
  return out;
}
