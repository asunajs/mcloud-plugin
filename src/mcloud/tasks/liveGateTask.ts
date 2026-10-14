// 任务：直播日程（「门」）—— **只读**地取直播房间列表，回答两件事。
//
// ```text
//   ① 今天开播了吗（那个会发口令的主播在不在播）
//   ② 下一场几点（预告场给的本地时刻串）
// ```
//
// 权威源：mcloud 的 `mcloud-tasks/src/live_room.rs::gate_jwt` / `gate_rooms`
// （编排层那三步）+ `mcloud-upstream/src/live_room.rs`（协议层，见 `../liveGate.ts`）。
//
// # 门是**实证**的，不是"接线完成、真机未验证"
//
// mcloud 那边把证据等级分得很细，这一段是**实证**那一档：出处是抓包
// `app-live-redflower-samples.txt` 的 §5.3（第 345–365 行）与证据等级表（第 466–475 行）。
//
// ⚠ **那份文档在兄弟仓库** `../mcloud-capture/docs/capture/`（mcloud 在 `9c53bd7`
// 把抓包面迁出去了，所以 `mcloud/docs/capture/` 现在是空的）—— 更正于 2026-10-14：
// 本文件先前写成"文档不在本 checkout 里"，那是**看错了地方**，不是文档不存在。
// 那一轮用**临时只读探针主动走了一遍** —— 因为门第③步是 **GET、不需要开播**，
// 所以"没开播就抓不到"这句话只解释了 WS 那半段。
//
// ⚠ 与它**分开标**的是 WS / 弹幕那一支：那才是"结构性抓不到"（未开播时
// `chatRoomId: null`，一个样本都没有）。本文件不碰它。
//
// # 为什么要两步（而不是 mcloud 那样一次跑完四发）
//
// 门的四发请求里，**第①发换到的 SSO token 只活几分钟**（mcloud 的实测注释：
// 「换到 4 分钟后重放已被拒」），而面板的 cron 间隔是 10 分钟
// ⇒ 把 ①②拆成两次调用**必然**让 SSO 过期。所以：
//
// ```text
//   handshake 步：① querySpecTokenV2(017027) → ② cmpassLoginByCmToken   （两发，同一次调用）
//   rooms 步    ：③ tabContentList(127) + ③ tabContentList(129)          （两发，同一次调用）
// ```
//
// 这是**刻意的取舍**，代价与理由都写清楚：
//
// * 面板的单次执行预算 2000ms，而且**打断不了正在阻塞的宿主调用**（见 F-001 那一族）
//   ⇒ 一次调用两发是"2×单发耗时"，实拍每发都在几百毫秒量级（e2e 里记了实测数）；
// * 这条路**全是只读**：万一真被预算判超时，上游一个字节都没改，重跑没有代价
//   —— 这也是它敢两发一次调用的原因（`live-draw` 那条写链就不敢）。
//
// # JWT 落盘是必要的，但**跑完就抹**
//
// 直播侧 JWT（≈30 天）要从 handshake 步活到 rooms 步 ⇒ 必须落盘（跨调用）。
// 但它是一份**凭据**，所以：`done` 时立刻 `delete`，接口**一律不回显**
// （`/api/live` 只回读数；e2e 里有"响应里不含 JWT"的断言）。
// ⚠ 每轮都重新换一次（照 mcloud 的 `gate_jwt`，不缓存跨轮）—— 少写一个"票还有多久过期"
// 的判据，就少一处会与上游真实有效期脱节的地方。
//
// # 结果落两处
//
// ```text
//   池（koulingPool.noteProbe）：日程 + 门开没开 + 场次 —— 「下一场」与"封场"的判据来源
//   读数（STATE_READING）      ：界面那张卡片要看的那几个数（门开没开、看到几间房）
// ```

import { callRawText } from '../client.ts';
import { clearError, recordError } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import {
  GATE_TAB_IDS,
  cmpassLoginRequest,
  gateReadingLine,
  gateSpecTokenRequest,
  koulingRooms,
  mergeRooms,
  parseCmlive,
  parseCmpassLogin,
  parseTabContentList,
  tabContentListRequest,
  toProbeRooms,
} from '../liveGate.ts';
import type { LiveRoom } from '../liveGate.ts';
import { parseSsoToken } from '../h5session.ts';
import { STATE_AUTH, loadAuthRaw } from '../sessionExchange.ts';
import { loadPoolFrom, noteProbe, normalize, poolSummary, savePoolTo } from '../koulingPool.ts';
import type { PoolSummary, ProbeRoom } from '../koulingPool.ts';
import type { Store } from '../../store/types.ts';

/** 一轮的状态（**含凭据** —— 见文件头"跑完就抹"）。 */
export const STATE_GATE = 'mcloud.live.gate';
/** 读数（界面用，**不含凭据**）。 */
export const STATE_READING = 'mcloud.live.gate.reading';
/** 门的上游基址（**CI 的口子**，见 [`loadGateBase`]）。 */
export const STATE_GATE_BASE = 'mcloud.live.gate_base';

export type GateStep = 'handshake' | 'rooms' | 'done';

export interface GateState {
  step: GateStep;
  /** 直播侧 JWT —— 只在**这一轮**里活（handshake → rooms）。`done` 时抹掉。 */
  jwt?: string;
  /** rooms 步的结果（落盘是为了让"这一轮看到了什么"可查）。 */
  rooms?: LiveRoom[];
  startedAt: string;
  finishedAt?: string;
  note?: string;
}

/** 界面读这个（**不含任何凭据**）。 */
export interface GateReading {
  at: string;
  /** 门开着吗（有「中国移动云盘」在播）。 */
  active: boolean;
  /** 筛完 `status == 1` 之后的房间数 —— 它用来区分两种"没有"（见 `liveRoomRules.judgeKoulingGate`）。 */
  liveCount: number;
  /** 这一趟看到的**全部**房间（含预告/回放）—— "日程不能跟着丢"。 */
  rooms: ProbeRoom[];
  /** 门那两种"没有"的人话。 */
  note: string;
}

/** 门的上游基址：**一个口子同时替换两台主机**。
 *
 *  # 为什么要有它
 *
 *  CI 的纪律是「全程只打 mock」，而门会打**两个**外站主机
 *  （`user-njs.yun.139.com` 与 `v.cmcc-cs.cn`）—— 没有这个口子，CI 就得去敲真站点。
 *
 *  ⚠ 为什么**一个**口子而不是两个：生产上它们确实是两台机器，但 CI 里只有一个 mock；
 *  拆成两个口子只会多出一处"配了一个忘了配另一个"的错法，而那种错的表现是
 *  「门一直说没有直播」（假结论），不是报错。
 *
 *  ⚠ 与 `baseUrl`（mcloud 端点）、`liveUrl`（**完整 URL**，第三方页面）都不同：
 *  这个替换的是**两台主机的源**，端点自带路径。三个语义混成一个就会写出
 *  「指到 mock 之后路径丢了」这种错。 */
export function loadGateBase(store: Pick<Store, 'getState'>): string | undefined {
  const v = store.getState(STATE_GATE_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : undefined;
}

export function saveGateBase(store: Store, base: string, nowIso: string): void {
  store.setState(STATE_GATE_BASE, base.trim().replace(/\/+$/, ''), nowIso);
}

export function loadGateState(store: Pick<Store, 'getState'>): GateState | null {
  return parseJson<GateState>(store.getState(STATE_GATE));
}

export function readGateReading(store: Pick<Store, 'getState'>): GateReading | null {
  return parseJson<GateReading>(store.getState(STATE_READING));
}

/** 推进一步（**一次调用最多两发上游请求** —— 见文件头）。
 *
 *  ⚠ 上一轮 `done` 之后**再触发就是新的一轮**：直播是会开始的，门要反复看。 */
export function runLiveGate(deps: TaskDeps): TaskOutcome {
  const base = loadGateBase(deps.store);
  const nowMs = Date.parse(deps.nowIso);
  const prev = loadGateState(deps.store);
  const st: GateState = prev && prev.step !== 'done' ? prev : { step: 'handshake', startedAt: deps.nowIso };

  if (st.step === 'handshake') return handshake(deps, st, base);
  return roomsStep(deps, st, base, nowMs);
}

/** handshake 步：① 换 SSO + ② 换直播侧 JWT（**必须同一次调用** —— SSO 只活几分钟）。 */
function handshake(deps: TaskDeps, st: GateState, base: string | undefined): TaskOutcome {
  const TASK = 'live-gate';
  const auth = loadAuthRaw(deps.store);
  if (auth === '') {
    const note = '门要**原生凭据**（`Authorization`）：先去界面贴一份（见 docs/howto-session.md）';
    recordError(deps.store, TASK, note, deps.nowIso);
    return { ok: false, note };
  }

  const r1 = callRawText(deps.transport, gateSpecTokenRequest(auth, base));
  if (!r1.ok) return stepFail(deps, TASK, `① 换 SSO token 失败：${r1.error ?? '未知失败'}`);
  const sso = parseSsoToken(r1.text);
  if (!sso.ok || sso.value === undefined) {
    return stepFail(deps, TASK, `① 换 SSO token 失败：${sso.error ?? '响应里没有 data.token'}`);
  }

  const r2 = callRawText(deps.transport, cmpassLoginRequest(sso.value, base));
  if (!r2.ok) return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${r2.error ?? '未知失败'}`);
  const env = parseCmlive(r2.text);
  if (!env.ok || env.value === undefined) {
    return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${env.error ?? '响应解不出来'}`);
  }
  const jwt = parseCmpassLogin(env.value);
  if (!jwt.ok || jwt.value === undefined) {
    return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${jwt.error ?? 'object 不是 JWT'}`);
  }

  st.jwt = jwt.value;
  st.step = 'rooms';
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  clearError(deps.store, TASK, deps.nowIso);
  return {
    ok: true,
    note: '① 换到 SSO token（**不落盘**，这一步就用掉了）+ ② 换到直播侧 JWT（≈30 天，这一轮用完就抹）',
  };
}

/** rooms 步：③ 两个页签各一发 → 合并 → 落池 + 落读数 → 抹掉 JWT。 */
function roomsStep(
  deps: TaskDeps,
  st: GateState,
  base: string | undefined,
  nowMs: number,
): TaskOutcome {
  const TASK = 'live-gate';
  const jwt = st.jwt;
  if (jwt === undefined || jwt === '') {
    // 凭据丢了（被手清过 / 盘上被抹过）⇒ 退回第一步，别拿空 JWT 去撞上游
    st.step = 'handshake';
    deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
    return { ok: true, idle: true, note: '这一轮没有 JWT ⇒ 退回第一步（下一趟重新握手）' };
  }

  const groups: LiveRoom[][] = [];
  for (const tabId of GATE_TAB_IDS) {
    const res = callRawText(deps.transport, tabContentListRequest(tabId, jwt, base));
    if (!res.ok) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${res.error ?? '未知失败'}`);
    }
    const env = parseCmlive(res.text);
    if (!env.ok || env.value === undefined) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${env.error ?? '响应解不出来'}`);
    }
    const parsed = parseTabContentList(env.value);
    if (!parsed.ok || parsed.value === undefined) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${parsed.error ?? '房间列表解不出来'}`);
    }
    groups.push(parsed.value);
  }

  const rooms = mergeRooms(groups);
  const hit = koulingRooms(rooms);
  const note = gateReadingLine(rooms);

  // ── 落池：日程（含预告/回放）+ 门开没开（`noteProbe` 内部也会记门的状态）
  const { pool } = loadPoolFrom(deps.store);
  normalize(pool, nowMs);
  noteProbe(pool, toProbeRooms(rooms), hit.length > 0, nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);

  const reading: GateReading = {
    at: deps.nowIso,
    active: hit.length > 0,
    liveCount: rooms.filter((r) => r.status === 1).length,
    rooms: toProbeRooms(rooms),
    note,
  };
  deps.store.setState(STATE_READING, JSON.stringify(reading), deps.nowIso);

  // ⚠ **凭据抹掉**：这一轮用完了（见文件头）
  delete st.jwt;
  st.rooms = rooms;
  st.step = 'done';
  st.finishedAt = deps.nowIso;
  st.note = note;
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  clearError(deps.store, TASK, deps.nowIso);
  return { ok: true, note: `${note}（页签 ${GATE_TAB_IDS.join('/')}，共 ${rooms.length} 间房）` };
}

/** ③ 失败：**把 JWT 丢掉**再如实报错。
 *
 *  为什么丢：它是最可能的原因（30 天的票也可能被上游作废），而这条路**全是只读**
 *  ⇒ 下一趟从头握手没有任何代价。留着它反而会让"票坏了"表现成"门一直是关的"
 *  —— 一个**假结论**，而假结论比失败难查得多（mcloud 在参考实现上吃过这个亏，
 *  注释原话：「让"凭据坏了"表现成"门开着、却一条口令也听不到"」）。 */
function dropJwtAndFail(deps: TaskDeps, st: GateState, note: string): TaskOutcome {
  st.step = 'handshake';
  delete st.jwt;
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  return stepFail(deps, 'live-gate', `${note}（已丢弃 JWT，下一趟重新握手）`);
}

function stepFail(deps: TaskDeps, task: string, note: string): TaskOutcome {
  recordError(deps.store, task, note, deps.nowIso);
  return { ok: false, note };
}

/** 门读数的**池视角**（界面那一行「下一场」用）—— 判据在池里，这里只是取出来。 */
export function gatePoolSummary(
  store: Pick<Store, 'getState'>,
  nowLocal: string,
  nowMs: number,
): PoolSummary {
  const { pool } = loadPoolFrom(store);
  return poolSummary(pool, nowLocal, nowMs);
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 存坏了就当作没有 —— 让界面显示"还没探测过"，而不是拿半截数据渲染出假象
    return null;
  }
}
