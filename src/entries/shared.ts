// 四个入口共用的引导层。
//
// # 为什么要拆成 4 个插件
//
// 面板的**分配单位是插件，不是任务**（见 rust-plugin-panel 的 `src/workers.rs`）：
// 一个插件里的所有任务跑在**同一条线程**上。所以「日常」那种一次跑几分钟的链
// 和「直播」那种 10 秒一拍的监听放在同一个插件里，前者会把后者拖住。
//
// 拆开之后每个插件独占一条线程（`worker_hint('exclusive')`），互不干扰。
//
// | 插件 | 线程 | 有 cron 吗 | 干什么 |
// |---|---|---|---|
// | `mcloud` | 共享 | 否 | 路由 / 登录 / 设置 / 读数 / 侧边栏入口 |
// | `mcloud-daily` | 独占 | 是 | 「日常」—— 一个函数从头跑到尾 |
// | `mcloud-exchange` | 独占 | 是 | 「兑换」—— 毫秒级开抢 |
// | `mcloud-live` | 独占 | 是 | 「直播」—— 听口令 + 领小红花 |
//
// `mcloud` **故意不声明 cron**：它只提供 HTTP 路由（登录、读数、设置）。
// 这样面板上的任务列表就只有 3 条用户看得懂的任务，而不是 25 条。
//
// # 为什么拆成 4 个**文件**而不是 4 个 npm 包
//
// 面板一个插件就是一个 `.js` 文件。4 个入口 = 4 个 esbuild entry，
// 共用同一份 `src/` 源码 —— 协议层（`crypto/*`、`client/sign/envelope/…`）
// 只写一遍，四个产物各自把自己用到的那部分打进去。
// 体积换来的东西是：改一处协议层，四个插件一起更新，不会有版本漂移。

import {
  http_fetch,
  ws_close,
  ws_open,
  ws_recv,
  ws_send,
} from 'host-api';
import type { HostWs, TaskDeps, TaskOutcome } from '../mcloud/tasks/base.ts';
import type { Transport } from '../mcloud/client.ts';
import { applyDefaultContentType, hostFetchOptions } from '../mcloud/client.ts';
import type { Store } from '../store/types.ts';
import { hostStore } from '../store/host.ts';
import { loadBaseUrl } from '../mcloud/session.ts';

/** 插件用的 transport：宿主 API 的**同步**请求（沙箱里唯一的选择）。
 *
 *  ⚠️ 超时刻意取得比面板的**默认**执行预算（`EXEC_BUDGET_MS=2000`）短。
 *
 *  原因是预算的行为不是「到点掐断」：QuickJS 的 interrupt handler 只在 JS 字节码
 *  边界被检查，所以一个阻塞中的请求会**跑完**，然后任务在那之后才被判超时 ——
 *  结果是「上游动作已经发生、任务却报失败」（同族的坑见 docs/findings.md F-001）。
 *  把超时设在预算里面，就是让它**在预算之前**干净地失败。
 *
 *  ⚠ 这个理由在**声明了长预算**的任务上不成立：那些任务（日常/兑换/直播）
 *  自己的预算就是几十秒，一次上游调用慢一点是正常的。所以它们要传
 *  `REQUEST_TIMEOUT_MS` 之外的值 —— 见 `makeTransport(timeoutMs)`。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 1500;

/** 长预算任务用的单次请求超时。取 20 秒：比上游的 99 分位宽，比任务预算窄。 */
export const LONG_REQUEST_TIMEOUT_MS = 20_000;

/** 造一个 transport。`timeoutMs` 要跟任务的预算匹配 —— 见上面那段。 */
export function makeTransport(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Transport {
  return (req) => {
    // ⚠ 补默认 content-type **在这一层**，不是各个构造器里 —— 与真实现同构
    // （`client.rs::default_content_type`）。散在构造器里就会漏，而漏的表现是
    // 一个**看起来像"路径不存在"**的 404（线上网关按 content-type 路由）。
    // 这一条是踩出来的，见 client.ts 的 applyDefaultContentType 与 findings F-015。
    const r = applyDefaultContentType(req);
    // 返回值可能是 {status,headers,body}，也可能是失败形状 {"error":…} ——
    // client.ts 的 callOnce 负责认形状（实测踩过，见 docs/findings.md F-006）
    return http_fetch(r.url, hostFetchOptions(r, timeoutMs));
  };
}

/** 造 store 并建表。四个插件各建一份（`hostStore()` 背后是同一张 SQLite）。 */
export function makeStore(): Store {
  const store = hostStore();
  store.ensureSchema();
  return store;
}

/** 长连接那一族（`ws_*`）。
 *
 *  ⚠ 这一族**只有嵌入式 JS 宿主有**；Node 适配器与 Python 侧都是「函数存在、
 *  调用时抛」（见面板 docs/host-api.md）。所以任何用到它的任务都必须能在测试里换桩。 */
export function makeHost(): HostWs {
  return {
    wsOpen: (url, opts) => ws_open(url, opts),
    wsSend: (id, text) => ws_send(id, text),
    wsRecv: (id, timeoutMs) => ws_recv(id, timeoutMs),
    wsClose: (id) => ws_close(id),
  };
}

/** 任务 handler 里拼 `TaskDeps` 的公共部分。 */
export function taskDeps(
  store: Store,
  transport: Transport,
  payload: { lateMs: number },
): TaskDeps {
  return {
    store,
    transport,
    nowIso: new Date().toISOString(),
    // 基址**每次触发时从 state 读**，不用启动时的快照 ——
    // 否则「刚把基址指到 mock，任务却还在打真上游」
    baseUrl: loadBaseUrl(store),
    lateMs: payload.lateMs,
  };
}

/** 面板给任务 handler 的 payload（见 docs/host-api.md）。 */
export interface TaskPayload {
  name: string;
  plugin: string;
  expr: string;
  runs: number;
  scheduledAt: string;
  firedAt: string;
  lateMs: number;
  /** `register_cron(…, { params })` 给的那份参数（没给就是 undefined）。 */
  params?: unknown;
}

/** 把一条「一次一步」的状态机在**一次触发里**跑到走完。
 *
 *  # 这是整个重写的核心原语
 *
 *  老的 25 条任务里有一半是状态机（任务拓展、App 任务、领小红花、换票），
 *  每次触发只推进一步 —— 因为全局执行预算是 2 秒，一次触发发不了几个请求。
 *  于是「任务拓展」在面板上表现为一条**永远在跑**的任务，用户看不出它到底做完没有。
 *
 *  现在任务可以声明长预算（`{ budget_ms }`），就可以在一次触发里连跑多步，
 *  直到状态机自己说「没得做了」（`idle`）或者碰到上限。面板上就变成
 *  「一次运行 = 一条任务 = 一个结果」。
 *
 *  # 两道上限都要有
 *
 *  - `maxSteps`：状态机可能因为上游一直给新待办而**永不** idle
 *    （App 任务是真实例子：做完一条，读数刷新后又冒一条）。
 *  - `deadlineMs`：比任务的 `budget_ms` 略小 —— 到点主动收手，
 *    留下「还差多少」的信息，而不是被看门狗当成死循环掐断。
 *    **主动收手和被掐断在日志里长得完全不一样**，前者能继续，后者只会留下
 *    「疑似死循环」这句误导人的话。
 */
export function drain(
  step: (d: TaskDeps) => TaskOutcome,
  deps: TaskDeps,
  opts: { label: string; maxSteps: number; deadlineMs: number; startedAt?: number },
): DrainResult {
  const startedAt = opts.startedAt ?? Date.now();
  const notes: string[] = [];
  let steps = 0;

  for (let i = 0; i < opts.maxSteps; i++) {
    if (Date.now() - startedAt > opts.deadlineMs) {
      return {
        ok: true,
        idle: false,
        steps,
        note: `${opts.label}：走到时间上限（${opts.deadlineMs}ms / ${steps} 步），下一次接着走`,
        notes,
      };
    }
    let r: TaskOutcome;
    try {
      r = step(deps);
    } catch (e) {
      // 状态机设计上不抛；真抛了就是插件自己的 bug，要说出来而不是吞掉
      notes.push(`抛异常：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps + 1} 步抛异常`, notes };
    }
    steps++;
    notes.push(r.note);
    if (!r.ok) {
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps} 步失败 —— ${r.note}`, notes };
    }
    if (r.idle) {
      // `idle` 有两种意思（「没得做」和「已经走完」），但对 drain 来说都是「停下」
      return { ok: true, idle: true, steps, note: `${opts.label}：${steps} 步走完 —— ${r.note}`, notes };
    }
  }

  return {
    ok: true,
    idle: false,
    steps,
    note: `${opts.label}：走到步数上限（${opts.maxSteps} 步），下一次接着走`,
    notes,
  };
}

export interface DrainResult {
  ok: boolean;
  /** 状态机说「没得做了 / 已经走完」 */
  idle: boolean;
  steps: number;
  /** 一行摘要（进 runs 表的 note） */
  note: string;
  /** 每一步的原话（进日志，方便出问题时看清走到哪一步） */
  notes: string[];
}
