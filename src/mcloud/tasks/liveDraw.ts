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
// 如果上游回 `90001`（凭据都在却过不去），第一个要怀疑的就是这里少了什么头。

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
import { loadLiveCodes, readLiveReading } from './liveRoom.ts';
import { MAX_CODES } from '../liveKouling.ts';

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
  kind: string;
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
}

/** 一轮要试哪些口令。
 *
 *  顺序是**人给的在前、自动抓的在后**，去重、上限 [`MAX_CODES`]。
 *  为什么合并：两个来源拿到的是**同一种东西**（口令），而人的意图本来就是
 *  "把我手上有的都试一遍"。界面上会把这一列**先显示出来**，所以不是暗箱。
 *  ⚠ 人给的在前面是有意的：那一份是**他确认过的**。 */
export function collectCodes(store: Pick<Store, 'getState'>): string[] {
  const human = loadLiveCodes(store)?.codes ?? [];
  const auto = readLiveReading(store)?.codes ?? [];
  const out: string[] = [];
  for (const c of [...human, ...auto]) {
    const v = c.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_CODES) break;
  }
  return out;
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
    return { ok: true, idle: true, note: '领小红花未开启（界面上那个开关）' };
  }

  let s = loadDrawState(deps.store);
  const codes = collectCodes(deps.store);

  if (!s || s.step === 'done') {
    // 跑完了、或还没开始 ⇒ 看要不要起一轮新的。
    // 口令列表变了就自动起新一轮（新一期直播发了新口令），否则什么都不做。
    const done = s?.codes ?? [];
    if (codes.length === 0) return { ok: true, idle: true, note: '没有口令可领（先抓主页或把口令填进输入框）' };
    if (s?.step === 'done' && sameList(done, codes)) {
      return { ok: true, idle: true, note: `这一轮已跑完（${s.summary ?? ''}）；口令没变，不重复领` };
    }
    s = {
      step: 'balance-before',
      journalingSent: 0,
      drawIndex: 0,
      codes,
      results: [],
      startedAt: deps.nowIso,
    };
    deps.store.setState(STATE_DRAW, JSON.stringify(s), deps.nowIso);
  }

  // 没有会话就别打上游 —— 这一族**要凭据**（与只读那半不同）
  const session = loadSession(deps.store);
  if (!session || !session.jwt) {
    const note = '未登录：领小红花要 jwttoken（见 docs/howto-session.md）';
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
  const advance = judge(s, step.label, res, deps.nowIso);
  deps.store.setState(STATE_DRAW, JSON.stringify(advance.state), deps.nowIso);

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
    `${label}：上游回 ${res.env?.code ?? '?'}${res.env?.message ? `（${res.env.message}）` : ''}`;

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
        code === 0 ? '领到首次参与惊喜奖' : code === 200110 ? '已参与过（正常）' : `上游回 ${code ?? '?'}`;
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
