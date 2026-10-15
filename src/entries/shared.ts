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
  log,
  smtp_send,
  warn,
  ws_close,
  ws_open,
  ws_recv,
  ws_send,
} from 'host-api';
import type { HostWs, TaskDeps } from '../mcloud/tasks/base.ts';
import { drain } from '../drain.ts';
export { drain } from '../drain.ts';
export type { DrainResult } from '../drain.ts';
import type { Transport } from '../mcloud/client.ts';
import { applyDefaultContentType, hostFetchOptions, isFetchError } from '../mcloud/client.ts';
import type { Store } from '../store/types.ts';
import { hostStore } from '../store/host.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';
import { resolveTaskAccounts } from '../mcloud/taskAccounts.ts';
import { migrateFlatKeys } from '../store/keys.ts';
import { loadBaseUrl } from '../mcloud/session.ts';
import {
  configuredChannels,
  sendPush,
  type PushChannel,
  type PushConfig,
  type PushDeps,
  type PushResult,
} from '../mcloud/push.ts';
import {
  TASK_LABELS,
  loadPushBindings,
  loadPushConfig,
  loadPushRules,
  type TaskKey,
} from '../mcloud/pushConfig.ts';

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
  // ⚠ 包一层之后 `store.getState/setState` 对**按账号的键**会自动落到当前账号的袋里
  //   （见 `store/scoped.ts`）。调用点不用知道账号的存在 —— 这是有意的：
  //   "记得分账号"是纪律，"分不了账号"才是结构。
  // 老扁平键 → 账号袋（一次性、幂等）。⚠ 传**裸 store**：
  //   `migrateFlatKeys` 读写的是扁平键，传路由后的那个会把袋键当普通键读。
  const { moved } = migrateFlatKeys(store, new Date().toISOString());
  const s = scoped(store);
  if (moved.length > 0) {
    log(`状态迁移：${moved.length} 个键搬进账号袋（${moved.join(', ')}）`);
  }
  return s;
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
/** 按**这条任务选的账号**串行跑一趟。
 *
 * # 为什么要这个东西
 *
 * 用户口径（照参考实现 `account-picker.tsx` 记的）：「任何（包括直播小红花）应该
 * 允许配置**多账号/全部**，点击运行后后端保证**串行执行**」。
 *
 * 所以"这一趟用哪些号"是**任务**的属性（挂在任务界面上），不是账号管理的属性
 *（账号页上那个「切到这个」是错的）。而"串行"这件事必须由**这一侧**保证：
 * 一个插件的工作线程只有一条，并行跑等于把上游的限流踩满。
 *
 * # 返回什么
 *
 * 每个账号一条结果。调用方拿它决定怎么记 run / 怎么拼 note。
 * ⚠ 没选到账号时返回**空数组**（调用方据此**静默返回**，不记 run）——
 * 那不是失败，是"这条任务没配账号"。
 */
export function forEachTaskAccount<T>(
  base: Store,
  task: string,
  payload: { lateMs: number },
  transport: Transport,
  fn: (deps: TaskDeps, acctId: string, index: number, total: number) => T,
): { acctId: string; result: T }[] {
  // ⚠ `all` 在**这里**展开（不是存的时候）—— 以后新登录的账号也进得来。
  const targets = resolveTaskAccounts(rawStoreOf(base), task);
  const out: { acctId: string; result: T }[] = [];
  for (const [i, acctId] of targets.entries()) {
    // ⚠ **每个账号一个 store**：`scoped(base, acctId)` 让这一趟里所有按账号的
    //   读写都落到那一条的袋里。不这么做的话，循环里第二次跑的还是第一个号的
    //   状态（"拿 A 的票发 B 的请求"），而那正是 F-048/F-049 那一类。
    const one = scoped(rawStoreOf(base), acctId);
    const deps = taskDeps(one, transport, payload);
    out.push({ acctId, result: fn(deps, acctId, i, targets.length) });
  }
  return out;
}

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
  /** 这一拍相对**理论**时刻抖了多少毫秒（没写抖动规则时恒为 0）。
   *
   *  ⚠ 它在 `docs/redesign-plan.md` 里是 ①-4 那个能力的一部分，但**类型里
   *  一直没声明** —— 用的时候只能 `as` 或者干脆不读。补上。
   *
   *  关系式：`firedAt - scheduledAt == lateMs + jitterMs`。 */
  jitterMs: number;
  /** 这一拍是**落后重对齐**（或熔断重试、首次装载）来的，不是按理论线走到的。
   *
   *  ⚠ 为什么要单独一格：那几种情况**故意不加抖动** ⇒ `jitterMs` 是 `0`，
   *  而对称抖动的**中点也是 `0`**（合法取值）。只看 `jitterMs == 0` 分不出
   *  「这一拍没抖」和「这一拍是重对齐」。
   *
   *  对抢兑这条链的意义：重对齐那一拍**已经错过了窗口**（它是"我落后了，
   *  从下一拍重新对齐"），所以链上那道时间闸会照常把它挡掉 —— 不会因为
   *  重对齐而误发一枪。 */
  realigned: boolean;
  /** `register_cron(…, { params })` 给的那份参数（没给就是 undefined）。 */
  params?: unknown;
}


// ══════════════════════════════ 推送：挂在「一次运行结束」上 ══════════════════════════════
//
// # 为什么在 shared.ts（而不是 push.ts）
//
// `push.ts` 是纯的（能在 Node 里测），发出去要 `http_fetch` 与 `smtp_send` ——
// 这两个只有引了 `host-api` 的文件才有。`shared.ts` 就是那个文件。
//
// # 「一次运行结束」是**唯一**的挂点
//
// 不是"每条日志推一次"，也不是"每个步骤推一次"：一次运行 = 一条推送。
// 理由：
//   · 一条链有十几个请求，逐步推就是刷屏（用户的原话是"文字一大堆"）
//   · 用户要的是**结果**："今天跑完了，3 个账号都成了"
//   · 失败时那条推送里要**带上失败的那一步**，否则用户还得去翻界面
//
// ⚠ 推送**不抛错**：它自己失败不该让任务判失败（任务已经干完活了）。
//   推送的结果**写进这次运行的读数**（界面上看得到），日志里也留一行。

/** 推送用的宿主能力。
 *
 *  ⚠ 复用传进来的 `Transport`（就是任务在用的那一条），**不另造一个** ——
 *  它已经处理了「补默认 content-type」「认失败形状」「tls 只对 https 生效」
 *  这三件事（见 `client.ts`）。另造一个就是把这些再踩一遍。 */
export function makePushDeps(transport: Transport): PushDeps {
  return {
    http: (r) => {
      // 返回值可能是 `{status,headers,body}` 也可能是失败形状 `{"error":…}`
      const res = transport(r);
      if (isFetchError(res)) {
        return { ok: false, status: 0, body: '', error: res.error };
      }
      return { ok: true, status: res.status, body: res.body ?? '', error: undefined };
    },
    smtp: (opts) => {
      // ⚠ 失败是**抛错**，错误文本是服务器那句原话（`535 bad credentials`）——
      //   `sendPush` 那边接住了并原样写进读数。
      const res = smtp_send(opts);
      return { ok: res.ok === true, response: String(res.response ?? '') };
    },
    nowMs: () => Date.now(),
    log: (msg) => log(msg),
  };
}

/** 跑完一次之后要不要推、推什么。
 *
 *  @param taskKey 日常 / 兑换 / 直播
 *  @param title   标题（默认用任务的显示名）
 *  @param text    正文（**这次运行的结果**，多行）
 *  @param hadFailure 这次有没有失败的一步（`minLevel: 'error'` 的规则只在 true 时发）
 */
export function notify(
  store: Store,
  transport: Transport,
  taskKey: TaskKey,
  title: string,
  text: string,
  hadFailure: boolean,
): PushResult | null {
  const bindings = loadPushBindings(store);
  const ruleId = bindings[taskKey];
  if (ruleId === '') return null; // 没绑规则 ⇒ 不发（不是失败）

  const rule = loadPushRules(store).find((r) => r.id === ruleId);
  if (rule === undefined) {
    // 规则被删了而绑定还在 ⇒ 说清，然后不发。**不静默** ——
    // 用户会以为"配了就该收到"，而收到的是沉默。
    warn(`推送规则「${ruleId}」不存在了（${TASK_LABELS[taskKey]} 还绑着它）—— 这次没发`);
    return null;
  }
  if (rule.minLevel === 'error' && !hadFailure) return null;

  const cfg = loadPushConfig(store);
  // 规则选了渠道就用它选的；一条都没选 = 全部配了的渠道
  const picked: PushConfig =
    rule.channels.length === 0 ? cfg : pickChannels(cfg, rule.channels);
  if (configuredChannels(picked).length === 0) {
    warn(`推送规则「${rule.name}」一个渠道都没配上 —— 这次没发`);
    return null;
  }

  const result = sendPush(makePushDeps(transport), picked, title, text);
  log(`推送（${rule.name}）：${result.line}`);
  return result;
}

/** 从整份配置里挑出指定的几个渠道。 */
export function pickChannels(cfg: PushConfig, channels: PushChannel[]): PushConfig {
  const out: PushConfig = { title: cfg.title };
  for (const c of channels) {
    if (c === 'customPost') {
      if (cfg.customPost && cfg.customPost.length > 0) out.customPost = cfg.customPost;
      continue;
    }
    const v = cfg[c];
    if (v !== undefined && v !== null) {
      // 逐渠道搬（键名与 PushConfig 一致）
      (out as Record<string, unknown>)[c] = v;
    }
  }
  return out;
}
