// 读一条要 `jwttoken` 的链时**当场把票弄新鲜**：到期主动换、`90001` 换完重试。
//
// # 为什么单独一层（而不是塞进某个任务）
//
// H5 的 `jwttoken` 约 2 小时即废。任务那条链上有人每天主动续它 ——
// `entries/daily.ts` 步骤①在跑任何任务**之前**先把这一页的票换到新鲜。
// 可「今日AI豆」那条是**点了才取**的按需读（见 `beansRead.ts`），
// 不在那个每日循环里：于是没人给它续票，票一过期就把 `code=90001 msg=未登录`
// 直接抛到界面上（用户报的现场：两个账号那行红字）。
//
// # 这一层补的三段（口径来自用户）
//
//   · **到期主动换**：`jwtFresh` 说这一页的票不新鲜 ⇒ 先换一轮再读（常见路径票是新的，
//     一次换票都不发）。
//   · **90001 被动换并重试**：读的时候上游回 `90001`（票没被认）⇒ 换一轮 ⇒
//     拿**新票**重读。要做到"请求发出出错、刷新后要得到正确结果"，重试这一枪必须
//     **重新读会话**（旧票缓存着重试永远撞 90001 —— 见 `beansRead.ts::makeFetchPage`）。
//   · **最多重置 2 次**：连着两次换票都没让下一次读成功 ⇒ 判定"账号问题"，不再重试。
//     （凭据本身坏了，换一万次也不会成 —— 而那正是 `daily.ts` 里
//     `RETRY_AFTER_MS` 想避免的"每 2 分钟一条红"。）
//
// # 为什么换票逻辑要能注入
//
// 真换票是四步 × 上游请求（spec-token / timestamp / tyrz-login / smid）。
// 测"重试 / 次数上限"这段**控制流**不该把那一整条也 stub 出来 —— 所以 `refreshToken`
// 是个口子：默认真换，测试里注入桩，只管"这次换成功了吗"。

import { drain } from '../drain.ts';
import type { Store } from '../store/types.ts';
import type { Transport } from './client.ts';
import type { TaskDeps } from './tasks/base.ts';
import { jwtFresh, loadAuthRaw, runExchangeStep, startExchange } from './sessionExchange.ts';
import { FALLBACK_RECIPE, type SessionRecipe } from './h5session.ts';

/** `90001`（票没被认）与"真失败"要**分开**：前者这一层能自愈，后者不能。
 *
 *  合成一类会出两种错：网络断了也被重试到 2 次算"账号问题"（其实是临时的）；
 *  或者票坏了当普通失败直接抛到界面（就是用户现在看到的红字）。 */
export class LoginExpiredError extends Error {
  constructor(message = '这一环要的票没被认（90001）') {
    super(message);
    this.name = 'LoginExpiredError';
  }
}

/** 被动重试的上限（用户口径：「重置 2 次，连续两次失败就判定为账号问题」）。 */
export const MAX_RESETS = 2;

/** 一次读数要用的东西：一个**已作用到某账号**的 store，加传输与基址。
 *
 *  与 `BeanAccountDeps` 同形状 —— 这一层不认识"账本"，只认识"发一枪之前把票弄新"。 */
export interface TokenGateDeps {
  store: Store;
  transport: Transport;
  nowIso: string;
  baseUrl?: string | undefined;
  /** 换一轮票的动作。**默认真换**（`exchangeOnce`）。测试注入桩，好把"重试/上限"
   *  这段控制流与真换票的四步分开测。 */
  refreshToken?: ((recipe: SessionRecipe) => { ok: boolean; note: string }) | undefined;
}

/** 换一轮票（一次触发内 `drain` 到走完）。**一次都不留**：从头起新一轮、四步走完。
 *
 *  ⚠ 总是**开新的一轮**而不是接着走半截：这里要的是"作废手里那张烂票、换一张新的"。
 *  `startExchange` 正是"起一轮"，`runExchangeStep` 只"接着走已有那一轮"，
 *  少了 `startExchange` 那一枪，票过期的账号会一直回"没有待换票的任务"（同 `daily.ts` 那段）。
 *
 *  成功判据不是 `drain` 的 `ok`，是**换完之后这一页的票真的新鲜了**（`jwtFresh`）——
 *  "这一轮走完了"和"票能用了"是两件事，只有后者算成。 */
export function exchangeOnce(deps: TokenGateDeps, recipe: SessionRecipe): { ok: boolean; note: string } {
  const auth = loadAuthRaw(deps.store);
  if (auth === '') return { ok: false, note: '没有可换票的原生凭据 —— 先加一个账号' };
  const started = startExchange(deps.store, auth, deps.nowIso, recipe);
  if (!started.ok) return { ok: false, note: started.error ?? '这串登录信息用不了' };
  const taskDeps: TaskDeps = {
    store: deps.store,
    transport: deps.transport,
    nowIso: deps.nowIso,
    baseUrl: deps.baseUrl,
  };
  const r = drain(
    (d) => {
      const x = runExchangeStep(d, recipe);
      // `runExchangeStep` 用 `done` 而不是 `idle` 表示"这一趟走完"，包一层对上 drain 的契约
      return { ok: x.ok, note: x.note, idle: x.done };
    },
    taskDeps,
    { label: `换票（${recipe}）`, maxSteps: 4, deadlineMs: 30_000, startedAt: Date.now() },
  );
  return { ok: r.ok && jwtFresh(deps.store, Date.now(), recipe), note: r.note };
}

/** 包一层读数：到期先换、`90001` 换后重试、连着 `MAX_RESETS` 次没救回来 ⇒ 账号问题。
 *
 *  ⚠ `read` 每一枪都要**重新读会话**（不能在外层闭包缓存票）—— 否则换完票重试还拿旧票，
 *  永远撞 90001。这个前提由 `beansRead.ts::makeFetchPage` 满足（它每次调用里 `loadSession`）。 */
export function withTokenGate<T>(
  deps: TokenGateDeps,
  read: () => T,
  recipe: SessionRecipe = FALLBACK_RECIPE,
): T {
  const doRefresh = deps.refreshToken ?? ((rp): { ok: boolean; note: string } => exchangeOnce(deps, rp));

  // ① 到期主动续一轮（票新鲜就不动 —— 常见路径一次换票都不发）。
  if (!jwtFresh(deps.store, Date.now(), recipe)) doRefresh(recipe);

  // ② 读；`90001` 就换票重试，最多 `MAX_RESETS` 次。
  let resets = 0;
  for (;;) {
    try {
      return read();
    } catch (e) {
      if (!(e instanceof LoginExpiredError)) throw e;
      if (resets >= MAX_RESETS) {
        // 连着两次换票都没让下一次读成功 ⇒ 不是"票过期"，是号本身坏了。
        throw new Error('这个号读不到：换了两次票还是不认 —— 多半是登录信息坏了，去「账号」页重新登录一次');
      }
      resets++;
      // 换完（成没成都）回去重读：换成了新票大概率读得过；没换成还是 90001，`resets` 累加到上限。
      doRefresh(recipe);
    }
  }
}
