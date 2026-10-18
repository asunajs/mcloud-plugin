// 任务：领小红花（`live-room` 的**写那半**）。
//
// 拿口令去 `POST /ycloud/liveRoomFeedback/redFlower/draw?code=` ——
// 这是整条链上**唯一会记账的请求**，也是这个插件里唯一会往上游写的直播动作。
//
// ═══════════════════════════════════════════════════════════════════════
// 为什么它必须是「可恢复步骤机」而不是一个函数
// ═══════════════════════════════════════════════════════════════════════
//
// 六步链一共 9+N 个请求（N = 口令数），而面板的单次执行预算默认 2000ms、
// 且**打断不了正在阻塞的宿主调用**（见 docs/findings.md F-001 那一族）。
// 一个"从头跑到尾"的函数会在第 2、3 个请求处被判超时 ——
// 而那时**上游的账已经记了**，任务却报失败。所以：
//
//   **一次 handler 调用只推进一步，状态落 SQLite。**
//
// 这与 `sign` 的三段式、`receive` 的逐条领是同一条纪律。
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠ 默认**关**，且界面上要二次确认
// ═══════════════════════════════════════════════════════════════════════
//
// 它虽然记账、也**基本幂等**（同一条口令再领一次回 `200112`「已兑换过」，
// 不会重复发奖），但它确实会往账号里写、且会留下活动足迹。
// 所以：cron 只在开关打开时才推；手动那一枪由界面的按钮触发（那里有 confirm）。
//
// ═══════════════════════════════════════════════════════════════════════
// ⚠⚠ 请求头是**照 Rust 侧实际发出去的形状**复刻的，与签到族**不一样**
// ═══════════════════════════════════════════════════════════════════════
//
// 签到族走 `app_signin::h5()`（自带签名头 + cookie + deviceid），
// 而小红花族的请求只经过 H5 客户端的**公共头**那一层（`session::h5_headers`）：
//
//   Accept / activityid / appversion / Referer / showloading / jwttoken
//
// 再叠加请求自己带的 `Origin` 与 `User-Agent`（= 小红花那个 iPad UA）。
// ⇒ **没有签名头、没有 cookie、没有 deviceid、没有 isdeviceid**。
//
// 所以这里**不复用** `buildH5Request`（那会多带签到族那套头）。这是刻意的：
// 多带几个头通常无害，但"照抄实际形状"在这一族是有依据的，而"顺手统一"没有。
//
// ⚠ 诚实标注：**这一族没有在真账号上验过**（CI 全程只打 mock，而 mock 验的是
// "我发出去的形状"不是"上游接受它"）。所以首次真机跑要盯着看：
// 如果服务端回 `90001`（凭据都在却过不去），第一个要怀疑的就是这里少了什么头。


import { callOnce } from '../client.ts';
import type { CallResult } from '../client.ts';
import { clearError, recordError } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import { loadSession } from '../../store/types.ts';
import type { Store } from '../../store/types.ts';
import {
  JOURNALING_EVENTS,
  drawLine,
  drawRequest,
  firstParticipateGiveRequest,
  journalingRequest,
  liveRoomHeaders,
  parseBalance,
  queryRevivalFlowersRequest,
  userInfoRequest,
  classifyDraw,
  type DrawOutcome,
} from '../liveFlower.ts';
import { loadLiveCodes } from './liveRoom.ts';
import { accountOf, claimVerdictOf, planDrawCodes } from './liveRoomRules.ts';
import { accountClaimed, loadFreshPool, noteClaim, savePoolTo } from '../koulingPool.ts';
import type { DrawKind } from '../liveFlower.ts';

/** 步骤机状态。 */
export const STATE_DRAW = 'mcloud.live.draw';
/** 开关：cron 只在它为 `'1'` 时才推进一步。**默认关**。 */
export const STATE_CLAIM_ENABLED = 'mcloud.live.claim_enabled';

export type DrawStep =
  | 'balance-before'
  | 'journaling'
  | 'first-participate'
  | 'draw'
  | 'revival'
  | 'balance-after'
  | 'done';

export interface DrawRow {
  code: string;
  /** 协议层的判定（`DrawKind`）。⚠ 是**联合类型**不是 string：
   *  它要被映射进池（`claimVerdictOf`），而拼错的字符串在那里会静默落进 `other`
   *  ⇒ 池就永远不会知道这条口令是坏的。 */
  kind: DrawKind;
  note: string;
  flowerNum: number;
}

export interface DrawState {
  step: DrawStep;
  journalingSent: number;
  drawIndex: number;
  /** 这一轮要试的口令（**快照**：中途改了输入框不该影响正在跑的这一轮） */
  codes: string[];
  results: DrawRow[];
  balanceBefore?: number | undefined;
  balanceAfter?: number | undefined;
  firstParticipate?: string | undefined;
  revival?: number | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  /** 这一轮最终那句话（跑完才有） */
  summary?: string | undefined;
  /** 这一轮是**哪个账号**跑的。
   *
   *  ⚠⚠ 2026-10-14 踩出来的：口令是**共享资源**（谁拿到都能用），而余额是**每个账号
   *  自己的**。所以"同一批口令 + 已跑完"这个判据**必须**把账号算进去 ——
   *  否则换个账号再跑，会被那句"口令没变，不重复领"直接跳过（第二、第三个账号
   *  一条都领不到，而界面看起来一切正常）。 */
  account?: string | undefined;
}

/** 一轮要试哪些口令。
 *
 *  # ⚠ 2026-10-14：来源从"读数"换成**池**，并加了两道筛
 *
 *  ```text
 *    人给的（他确认过的，排前面）+ 池里该投的（pickFor）
 *      再滤掉：池里已判**无效**的、这个账号**领过**的
 *  ```
 *
 *  为什么权威来源是池而不是"最近一次读数"：
 *
 *  ```text
 *    读数 = 最近一次抓主页**解出来什么**（界面快照，解错也会原样进）
 *    池   = 这一场攒下来的口令 + **每一条的状态**（验过没 / 有效没 / 谁领过）
 *  ```
 *
 *  拿读数当来源，就等于每轮把"已判无效的口令"再投一遍（每轮白跑一枪 `200108`）、
 *  把"这个账号领过的"再投一遍（回 `200112`：不是新结果，却会污染归因，
 *  看起来像"口令坏了"）。判据与 mcloud 的 `pick_for` 同一份 —— 见 `liveRoomRules.planDrawCodes`。
 *
 *  ⚠ 顺序是**人给的在前**（界面上会把这一列先显示出来，所以不是暗箱）：
 *  那一份是**他确认过的**。 */
export function collectCodes(store: Pick<Store, 'getState'>, nowMs: number = Date.now()): string[] {
  const human = loadLiveCodes(store)?.codes ?? [];
  const { pool } = loadFreshPool(store, nowMs);
  return planDrawCodes(pool, accountOf(store), human);
}

export function loadDrawState(store: Pick<Store, 'getState'>): DrawState | null {
  const raw = store.getState(STATE_DRAW);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DrawState;
    return typeof v?.step === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function claimEnabled(store: Pick<Store, 'getState'>): boolean {
  return store.getState(STATE_CLAIM_ENABLED) === '1';
}

export function setClaimEnabled(store: Store, on: boolean, nowIso: string): void {
  store.setState(STATE_CLAIM_ENABLED, on ? '1' : '0', nowIso);
}

/** **只读探针**：发一枪 `user/info`，回答"这一族能不能通"。
 *
 *  为什么要有它：这条链**唯一没在真账号上验过**的东西是**请求头形状**
 *  （见文件头那段诚实标注）。而 `user/info` 虽然是 POST，却**只读余额、不记账**
 *  —— 它是整条链上最便宜、最安全的那一枪。
 *
 *  没有它的话，"验头"这件事得先有真口令才做得了（步骤机要先有口令才肯起步），
 *  而口令只在直播那一小时有效 —— 于是"验证"被绑死在最难凑齐的时刻上。
 *
 *  ⚠ 它**不写任何状态**、不碰步骤机：跑多少次都无所谓。 */
export function probeLiveRoom(deps: TaskDeps): { ok: boolean; note: string; balance?: number } {
  const session = loadSession(deps.store);
  if (!session || !session.jwt) {
    return { ok: false, note: '这个号还没换到票 —— 上面「换票」那一步说了原因' };
  }
  const res = callOnce(deps.transport, withSession(userInfoRequest(deps.baseUrl), session.jwt));
  if (res.env === undefined) {
    return { ok: false, note: `读余额失败：${res.error ?? '未知失败'}` };
  }
  const code = res.env.code;
  if (code === 0) {
    const v = parseBalance(res.env);
    if (v === undefined) return { ok: false, note: '读到了 code=0，但响应里没有 result.flowerCnt' };
    return { ok: true, balance: v, note: `这一族能通：小红花余额 ${v} 朵` };
  }
  if (code === 90001) {
    // 这一支最值钱：它说明"凭据都在、却过不去" ⇒ 头形状不对（见文件头）
    return {
      ok: false,
      note: '服务端回 90001（未登录）—— 凭据是有的，所以问题在**请求头形状**：' +
        '先怀疑少了 `jwttoken` / `showloading`，或多了签到族那套头（见 liveDraw.ts 文件头）',
    };
  }
  return { ok: false, note: `服务端回 ${code}${res.env.message ? `（${res.env.message}）` : ''}` };
}

/** 步骤 → 这一步要发的请求 + 一行人话。**纯函数**（不推进状态、不发请求）。 */
export function stepRequest(
  s: DrawState,
  base?: string | undefined,
): { request: ReturnType<typeof userInfoRequest>; label: string } | null {
  switch (s.step) {
    case 'balance-before':
      return { request: userInfoRequest(base), label: '① 读余额（领之前）' };
    case 'journaling': {
      const ev = JOURNALING_EVENTS[s.journalingSent];
      if (ev === undefined) return null;
      return { request: journalingRequest(ev, base), label: `② 埋点 ${s.journalingSent + 1}/5` };
    }
    case 'first-participate':
      return { request: firstParticipateGiveRequest(base), label: '③ 首次参与惊喜奖' };
    case 'draw': {
      const code = s.codes[s.drawIndex];
      if (code === undefined) return null;
      return {
        request: drawRequest(code, base),
        label: `④ 领口令「${code}」（${s.drawIndex + 1}/${s.codes.length}）`,
      };
    }
    case 'revival':
      return { request: queryRevivalFlowersRequest(base), label: '⑤ 复活花' };
    case 'balance-after':
      return { request: userInfoRequest(base), label: '⑥ 再读余额（核对进账）' };
    default:
      return null;
  }
}

/** 推进一步。**一次调用最多发一个请求。** */
export function runLiveDraw(deps: TaskDeps, opts: { force?: boolean } = {}): TaskOutcome {
  const TASK = 'live-room';

  if (!opts.force && !claimEnabled(deps.store)) {
    // 关着的时候**一个请求都不发**，而且不写失败 —— 这不是错误状态
    // 这个开关只是允许插件去领；功能本身要服务端那边开
    return { ok: true, idle: true, note: '领小红花没开（要先在服务端那边开启）' };
  }

  let s = loadDrawState(deps.store);
  const codes = collectCodes(deps.store, Date.parse(deps.nowIso));

  if (!s || s.step === 'done') {
    // 跑完了、或还没开始 ⇒ 看要不要起一轮新的。
    // 口令列表变了就自动起新一轮（新一期直播发了新口令），否则什么都不做。
    const done = s?.codes ?? [];
    // ⚠ 2026-10-14：`codes` 现在来自**池**，而池会滤掉"这个账号领过的"
    // ⇒ 一轮跑完之后 `codes` 通常是**空的**（都领过了），而那不是"没有口令可领"。
    // 判据要按"上一轮那批口令是不是都已经被这个账号领过"来分，不能按长度分 ——
    // 否则界面上会写着"没有口令可领（先抓主页…）"，而人明明刚领完一轮。
    const { pool } = loadFreshPool(deps.store, Date.parse(deps.nowIso));
    const account = accountOf(deps.store);
    const allClaimed = done.length > 0 && done.every((c) => accountClaimed(pool, account, c));
    if (codes.length === 0) {
      // 池会把"领过的/判过无效的"滤掉 ⇒ 长度为 0 有**两种**意思，必须分开说：
      //   ① 上一轮那批都已经被这个账号领过 ⇒ **已跑完**（别写成"没有口令可领"）
      //   ② 手上确实什么都没有          ⇒ 让他去抓主页或填口令
      return allClaimed
        ? { ok: true, idle: true, note: `这一轮已跑完（${s?.summary ?? ''}）；口令没变，不重复领` }
        : { ok: true, idle: true, note: '没有口令可领（先抓主页或把口令填进输入框）' };
    }
    if (s?.step === 'done' && sameList(done, codes) && s.account === account) {
      return { ok: true, idle: true, note: `这一轮已跑完（${s.summary ?? ''}）；口令没变，不重复领` };
    }
    // ⚠ 走到这里有两种情况，都要起新一轮：口令变了，**或者账号换了**
    //   （后者是人最容易忽略的：口令一样，但余额是另一个账号的）。
    s = {
      step: 'balance-before',
      journalingSent: 0,
      drawIndex: 0,
      codes,
      account,
      results: [],
      startedAt: deps.nowIso,
    };
    deps.store.setState(STATE_DRAW, JSON.stringify(s), deps.nowIso);
  }

  // 没有会话就别打上游 —— 这一族**要凭据**（与只读那半不同）
  const session = loadSession(deps.store);
  if (!session || !session.jwt) {
    const note = '领小红花要先有票 —— 上面「换票」那一步说了原因';
    recordError(deps.store, TASK, note, deps.nowIso);
    return { ok: false, note };
  }

  // ⚠️ 每次调用时从 state 读 baseUrl（不是用注入的那份快照）——
  // "刚把基址指到 mock，这一枪却打了真上游"正是靠这条避免的
  const step = stepRequest(s, deps.baseUrl);
  if (!step) {
    // 下标越界（口令被改短了之类）⇒ 直接跳到收尾，别卡在半路
    s.step = 'balance-after';
    deps.store.setState(STATE_DRAW, JSON.stringify(s), deps.nowIso);
    return { ok: true, note: '步骤下标越界，已跳到收尾' };
  }

  const res = callOnce(deps.transport, withSession(step.request, session.jwt));
  const before = s.results.length;
  const advance = judge(s, step.label, res, deps.nowIso);
  deps.store.setState(STATE_DRAW, JSON.stringify(advance.state), deps.nowIso);

  // ── 把这一枪的结论**写回口令池**（状态跃迁的唯一入口）
  //
  // 为什么必须写回：`draw` 是整条链上唯一会**验**口令的一枪 —— 在它之前，
  // 池里那条口令的状态是"未知"（抓到了、没验过）。不写回的话：
  //
  // ```text
  //   判过无效的 ⇒ 下一轮还会再投一次（白跑一枪 200108）
  //   已经领过的 ⇒ 下一轮还会再投一次（回 200112，把归因搅浑）
  //   有效但没记 ⇒ "够 2 条有效就停止抓取"这条口径永远不成立 ⇒ 一直抓
  // ```
  //
  // ⚠ 只在**这一步真的发过 draw 请求、并且拿到了信封**时才写：
  // 判据是"结果行数变多了"（失败时 `judge` 不推进行、不追加结果行）。
  if (s.step === 'draw' && advance.state.results.length > before) {
    const row = advance.state.results[advance.state.results.length - 1];
    if (row !== undefined) {
      const loaded = loadFreshPool(deps.store, Date.parse(deps.nowIso));
      noteClaim(loaded.pool, accountOf(deps.store), row.code, claimVerdictOf(row.kind), Date.parse(deps.nowIso));
      savePoolTo(deps.store, loaded.pool, deps.nowIso);
    }
  }

  if (!advance.ok) {
    recordError(deps.store, TASK, advance.note, deps.nowIso);
    return { ok: false, note: advance.note };
  }
  clearError(deps.store, TASK, deps.nowIso);
  return { ok: true, note: advance.note };
}

/** 把这一族的头补齐（见文件头：**不带**签到族那套签名头与 cookie）。 */
function withSession(req: ReturnType<typeof userInfoRequest>, jwt: string) {
  return {
    ...req,
    headers: { ...req.headers, showloading: 'true', jwttoken: jwt },
  };
}

interface Advance {
  state: DrawState;
  ok: boolean;
  note: string;
}

/** 判定这一步的结果并推进状态。**每一步都各自说话**（不许只写"失败"两个字）。 */
function judge(s: DrawState, label: string, res: CallResult, nowIso: string): Advance {
  const st: DrawState = { ...s, results: [...s.results] };

  if (res.env === undefined) {
    // ⚠⚠ 这一族的判据是「**有没有拿到信封**」，不是 `res.ok`。
    //
    // `callOnce` 的 `ok` 是「HTTP 200 **且** code === 0」，而那对这条链是错的：
    // `draw` 的 `200112`（已兑换过）/`200108`（口令无效）/`200118`（本场已结束）
    // 全是**有意义的结论**，`firstParticipate` 的 `200110`（已参与过）也是。
    // 拿 `res.ok` 当门槛，这些结论会被当成"失败"吞掉 —— 表现是
    // 「界面上一片红，而其实该领的已经领了、该说的没说」。
    const why = res.error ?? '未知失败';
    return { state: st, ok: false, note: `${label} 失败：${why}` };
  }
  const biz = (): string =>
    `${label}：服务端回 ${res.env?.code ?? '?'}${res.env?.message ? `（${res.env.message}）` : ''}`;

  switch (s.step) {
    case 'balance-before': {
      if (res.env.code !== 0) return { state: st, ok: false, note: biz() };
      const v = parseBalance(res.env);
      if (v === undefined) {
        return { state: st, ok: false, note: `${label}：响应里没有 result.flowerCnt（余额）` };
      }
      st.balanceBefore = v;
      st.step = 'journaling';
      return { state: st, ok: true, note: `${label}：${v} 朵 → 开始领` };
    }
    case 'journaling': {
      // 埋点失败**不该**拦住领取（它是"到场"证据，不是账）—— 如实说一句，继续走
      st.journalingSent = s.journalingSent + 1;
      if (st.journalingSent >= JOURNALING_EVENTS.length) st.step = 'first-participate';
      return {
        state: st,
        ok: true,
        note: res.env.code === 0 ? `${label} 完成` : `${biz()}（埋点失败不拦领取）`,
      };
    }
    case 'first-participate': {
      // ⚠ `200110`（已参与过）是**正常**的一支，不是失败
      const code = res.env.code;
      st.firstParticipate =
        code === 0 ? '领到首次参与惊喜奖' : code === 200110 ? '已参与过（正常）' : `服务端回 ${code ?? '?'}`;
      st.step = 'draw';
      return { state: st, ok: true, note: `${label}：${st.firstParticipate}` };
    }
    case 'draw': {
      const code = s.codes[s.drawIndex] ?? '';
      const out = classifyDraw(res.env);
      st.results.push({
        code,
        kind: out.kind,
        note: drawLine(code, out),
        flowerNum: out.result?.flowerNum ?? 0,
      });
      st.drawIndex = s.drawIndex + 1;
      if (st.drawIndex >= st.codes.length) st.step = 'revival';
      return { state: st, ok: true, note: drawLine(code, out) };
    }
    case 'revival': {
      const r = res.env.result;
      st.revival = typeof r === 'number' ? r : undefined;
      st.step = 'balance-after';
      return {
        state: st,
        ok: true,
        note:
          res.env.code === 0
            ? `${label}：${st.revival ?? '?'} 朵（**不是**小红花余额）`
            : biz(),
      };
    }
    case 'balance-after': {
      if (res.env.code !== 0) return { state: st, ok: false, note: biz() };
      const v = parseBalance(res.env);
      if (v === undefined) {
        return { state: st, ok: false, note: `${label}：响应里没有 result.flowerCnt` };
      }
      st.balanceAfter = v;
      st.step = 'done';
      st.finishedAt = nowIso;
      // ⚠ 进账是 **⑥ − ①**，不是把各口令的 flowerNum 加起来 ——
      // 相加会漏掉③首次参与惊喜奖那几朵（它不属于任何一个口令）
      const gained = (st.balanceAfter ?? 0) - (st.balanceBefore ?? 0);
      const okCount = st.results.filter((r) => r.kind === 'succeeded').length;
      st.summary = `${st.results.length} 条口令领到 ${okCount} 条，进账 ${gained} 朵（${st.balanceBefore} → ${st.balanceAfter}）`;
      return { state: st, ok: true, note: st.summary };
    }
    default:
      return { state: st, ok: true, note: '没有可推进的步骤' };
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ══════════════════════════════ 一次领取的**结论** ══════════════════════════════
//
// 这一步单独抽出来，是因为"这一轮到底发生了什么"要**分四栏**说清楚，
// 而分错的后果是**排查方向一开始就错**：
//
//   | 栏 | 上游的码 | 用户该怎么做 |
//   |---|---|---|
//   | 领到了 | `0` | 没事 |
//   | 已领过 | `200112` | 没事（换个账号跑，或者等下一场） |
//   | 口令无效 | `200108` | **口令抄错了** —— 值得重听一次 |
//   | 本场已结束 | `200118` | **不是口令的问题** —— 口令是对的，是直播散了 |
//   | 未分类 | 别的 | 上游说了个我们没见过的码，去看原始码 |
//
// ⚠ 「本场已结束」与「口令无效」**必须分开**：前者的口语说法是
//   「这条口令本场已经结束了」，而如果把它归进"无效口令"，
//   用户会去重新抄一遍口令 —— 而口令本来就是对的（错的才回 `200108`）。
//
// ⚠ 「未分类」也必须单独一栏：它是"上游加了个新码"，
//   与"口令错"的排查方向**完全不同**；混进"口令无效"会触发一次
//   **毫无意义**的重听（60 秒），而且把真正的原因藏起来。

/** 一次领取的结论（四栏 + 进账）。 */
export interface DrawReport {
  /** 试了几条口令（一条都没发出去时是 0）。 */
  attempted: number;
  /** 真领到的条数。 */
  succeeded: number;
  /** **进账几朵** = ⑥ 的读数 − ① 的读数。
   *
   *  ⚠ 不是把各口令的 `flowerNum` 加起来 —— 相加会漏掉「首次参与惊喜奖」
   *  进账的那几朵（它**不属于任何一个口令**），而那正是"总数对不上"最常见的来源。 */
  gained: number;
  balanceBefore: number | undefined;
  balanceAfter: number | undefined;
  /** 已领过的（`200112`）—— 不是失败。 */
  alreadyDrawn: string[];
  /** 口令无效的（`200108`）—— **这个才值得重听一次**。 */
  invalid: string[];
  /** 本场已结束的（`200118`）—— 口令是对的，别让人去重抄。 */
  expired: string[];
  /** 服务端回了别的码的 —— 单独一栏，排查方向与上面两栏都不同。 */
  other: string[];
  /** 解不出来的（响应形状变了）。 */
  unparsable: string[];
  /** 一句话结论（界面上第一行显示的就是它）。 */
  line: string;
}

/** 把一轮的状态收成结论。**纯函数**（同一份状态永远给同一份结论）。 */
export function drawReport(st: DrawState | null): DrawReport | null {
  if (st === null) return null;
  const of = (k: DrawKind): string[] => st.results.filter((r) => r.kind === k).map((r) => r.code);
  const succeeded = st.results.filter((r) => r.kind === 'succeeded').length;
  const gained =
    st.balanceBefore === undefined || st.balanceAfter === undefined
      ? 0
      : st.balanceAfter - st.balanceBefore;

  const parts: string[] = [];
  if (st.results.length === 0) parts.push('还没发出口令');
  else parts.push(`${st.results.length} 条口令领到 ${succeeded} 条`);
  if (st.balanceBefore !== undefined && st.balanceAfter !== undefined) {
    parts.push(`进账 ${gained} 朵（${st.balanceBefore} → ${st.balanceAfter}）`);
  }
  const expired = of('kouling-expired');
  if (expired.length > 0) {
    // ⚠ 这句话必须说"不是口令的问题" —— 否则用户会去重抄一遍
    parts.push(`${expired.length} 条口令认识但本场已经结束了（不是口令抄错）`);
  }
  const invalid = of('invalid-kouling');
  if (invalid.length > 0) parts.push(`${invalid.length} 条口令无效`);
  const other = [...of('other'), ...of('unparsable')];
  if (other.length > 0) parts.push(`${other.length} 条回了没见过的结果`);

  return {
    attempted: st.results.length,
    succeeded,
    gained,
    balanceBefore: st.balanceBefore,
    balanceAfter: st.balanceAfter,
    alreadyDrawn: of('already-drawn'),
    invalid,
    expired,
    other: of('other'),
    unparsable: of('unparsable'),
    line: parts.join(' · '),
  };
}
