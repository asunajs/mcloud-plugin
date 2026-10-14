// 直播口令池（**业务档**）—— 照 mcloud 的 `crates/mcloud-core/src/kouling.rs` 落地。
//
// # 权威顺序（用户口径 2026-10-14，见 docs/findings.md F-026）
//
// ```text
//   ① 业务逻辑  → 照 **mcloud**（Rust，能跑的那一份）
//   ② 内容      → 用**抓包**核对
//   ③ ts 算法   → 参考 **mcloud-sign**
//   ④ 效果      → 靠**实测**确认
// ```
//
// 本文件属于 ①：**一条算法都没有，全是判据**。所以它的权威源是
// `mcloud-core/src/kouling.rs`（池本身）与 `mcloud-tasks/src/live_room.rs`（池的调用方），
// **不是** mcloud-sign —— 那边根本没有这一层（它的口令池是单进程里一个
// `let sharedKouling: {codes, at}` 加一个 `SHARED_KOULING_TTL = 5h`）。
// 那条 5 小时 TTL 本文件继承下来了，理由是它已经被验证过（见 [`CYCLE_TTL_MS`]）。
//
// # 它解决什么问题
//
// 直播口令（弹幕/笔记里那串东西）是**全实例共享**的资源：任何账号拿到一条，
// 别的账号、别的人都能拿它去领小红花 —— 上游一场直播只发那么几条，而
// "每个账号各抓一次" = N 次主页请求 + N 次弹幕连接，抓回来的还是**同一批**。
// 所以池要回答的是四件事，全都在这里：
//
// ```text
//   ① 这一批口令里哪些**还能用**（unknown / valid / invalid，只有 valid 算数）
//   ② 什么时候**停止抓取**（够 2 条有效就停，见 VALID_ENOUGH）
//   ③ 什么时候**换新周期**（5 小时兜底 / 判定门关上 + 宽限，见 isStale）
//   ④ 哪一条**该投给哪个账号**（这个账号领过的、判过无效的都不再投）
// ```
//
// # 三条口径（用户 2026-10-01 逐条定的，mcloud 的注释原样带过来）
//
// 1. **按周期划界**：5 小时 TTL 兜底；另外"判定门关上之后再等一段"就封场
//    （见 [`GATE_CLOSE_GRACE_MS`]）—— 门会因网络抖动"闪"一下，立刻封场会把
//    一场直播从中间劈开。
// 2. **够 2 条有效就全场停止抓取**（[`stopScraping`]）。
// 3. **过期视同无效**（行为上不可复用），但**原因留着** —— 界面上要能看出
//    "这条是口令错还是过期了"，那对判断上游什么时候作废口令有用。
//
// # ⚠⚠ 一处**刻意分开**的判据，改动前务必读完
//
// 领取结果里 `200118`（**本场已结束**）在本层算 **无效** ✓；但协议层有一条**相反的**
// 规矩：`rejectedKouling()` 对 `200118` 必须返回 `false`，否则会触发一次毫无意义的
// 重听（见 `liveFlower.ts` 里 `rejectedKouling` 的注释）。
//
// 这**不是矛盾**，是两个不同的问题：
//
// ```text
//   池问的是   "这条口令还能不能再拿去用"  ⇒ 过期了就不能 ⇒ 无效 ✓
//   重听听的是 "我是不是把口令认错了"      ⇒ 过期说明我认得没错 ⇒ 不重听 ✓
// ```
//
// 谁要是把这两处合并成一处，就会得到"要么不停地重听、要么拿着过期口令反复投"。
// 单测 `200118 在池里算无效，但在协议层**不算认错**` 把这一对钉在一起。
//
// # 纯逻辑：不 import host-api、不发请求、不读时钟
//
// 时刻一律由调用方给（`nowMs`，毫秒 —— 与 mcloud 的 `i64` 同一口径，
// **不是** ISO 串：这个池要在"5 小时""10 分钟""180 秒"这些量上做减法）。
// 只有最底下那两个 `loadPoolFrom` / `savePoolTo` 碰 `Store`，它们是薄适配层。
//
// # 方法是**就地改**（照 mcloud 的 `&mut self`）
//
// 调用方的节奏固定是：`load → normalize 一次 → 改几次 → save`。
// 每个改动的入口**自己也会先 normalize**（与 mcloud 逐条相同）——
// 于是"忘了先归一化"这种错不会出现，代价是一次多余的比较。

import { sha256, toHex, utf8 } from '../crypto/index.ts';
import type { Store } from '../store/types.ts';

// ══════════════════════════ 常量（数值全部照 mcloud，不自己定）══════════════════════════

/** 周期的兜底长度：**5 小时** —— 与 mcloud（以及它之前那份 TS）**同值**。
 *
 *  为什么不改成"自然日"：直播会跨零点，按日切会把一场直播从中间劈开，
 *  于是后半场又要重新抓一遍 —— 那正是这一层要消灭的事。 */
export const CYCLE_TTL_MS = 5 * 60 * 60 * 1000;

/** 判定门关上之后再等多久才封场。
 *
 *  ⚠ 判定门会因网络抖动"闪"一下（这一趟没拉到房间 ≠ 直播结束了），
 *  立刻封场会把一场直播切碎 ⇒ 留一个宽限窗口，宽限期内池子照旧可用。
 *
 *  ⚠⚠ 这条判据**现在没有生产者**：它要的是"判定门"（直播侧那三步探针），
 *  而插件还没接那一支（见文件尾"还没接上的"）。判据照 mcloud 落地并被单测钉住，
 *  理由是池的**磁盘形状**一旦分两次改，就会留下"文件里有字段但没人写"这种烂账。 */
export const GATE_CLOSE_GRACE_MS = 10 * 60 * 1000;

/** 够多少条**有效**口令就不再抓取。用户口径：2。
 *
 *  为什么是"有效"而不是"收到"：一条没验过的口令可能已经被上游作废，
 *  拿它当"够了两条"会让这一场提前收工，而收工之后**不会再有机会**（直播只有那几小时）。 */
export const VALID_ENOUGH = 2;

/** 历史场次最多留几条（够界面上"最近几场"用，不无限长）。 */
export const MAX_SESSIONS = 12;

/** 两次**自动抓取**之间的最小间隔。
 *
 *  ⚠⚠ mcloud 有一条**跨 crate 的不变量**：这个常量必须 **≥ 一次抓取的时长**
 *  （那边 `DEFAULT_LISTEN_SECONDS = 180`，所以取 180 秒，**正好等于**一次抓取）。
 *  违反它 = 第一个账号的抓取还没结束、第二个账号就另起一次 ✗。
 *
 *  插件这边**没有弹幕那一支**（沙箱里没有 WebSocket），一次抓取就是"一发主页 GET"
 *  （毫秒级），所以 180 秒在插件里**更宽**、不可能违反那条不变量 ✓。
 *  ⚠ 但也因此**别拿它当"抓主页的节流"** —— 抓主页的节流是 [`XHS_MIN_INTERVAL_MS`]，
 *  两个量管的是两件事（这个管"谁去抓"，那个管"能不能打小红书"）。 */
export const SCRAPE_MIN_INTERVAL_MS = 180 * 1000;

/** 两次**小红书主页**请求之间的最小间隔：**30 分钟**。
 *
 *  依据（mcloud 的注释原样）：小红书面不需要鉴权，低频调用是允许的；
 *  频繁调用会被风控挡下 —— 而风控挡下的表现是"页面里没有口令"，
 *  与"这一期还没发笔记"在解析层**长得一模一样**，查都没法查。所以宁可慢。 */
export const XHS_MIN_INTERVAL_MS = 30 * 60 * 1000;

/** 池里最多留多少条口令（防呆上限：弹幕里什么都可能被当成口令）。
 *
 *  ⚠ 与 `liveKouling.ts` 的 `MAX_CODES`（=10）**不是同一个东西**：
 *  那个是"一次**输入**最多几条"（人贴进来的，护栏），这个是"池里**存**多少条"
 *  （跨周期攒下来的，防呆）。两个都叫 MAX_CODES 会让人把一处改动的效果算到另一处上。 */
export const MAX_POOL_CODES = 200;

/** 有效主播的昵称 —— 挑「下一场」时唯一认的那个名字。
 *
 *  ⚠ 判据是**精确相等**，不是包含：上游那张表里还有「福建移动」「移动心选」「移动臻选」，
 *  而 `status == 1` 的房间里就出现过「福建移动」（实拍房间 147490）⇒ 只看状态会误判。
 *  ⚠ 有效的主播**只有一个**（用户口径 2026-10-02）⇒ 认不出就**不显示**，
 *  绝不拿别人的场次顶（用户看到过"10-02 那场不是目标直播间"）。 */
export const KOULING_ANCHOR = '中国移动云盘';

/** 池在面板 state 表里的键。 */
export const POOL_KEY = 'mcloud.kouling.pool';

// ══════════════════════════ 形状（字段名照 mcloud 的 serde 输出）══════════════════════════

/** 一条口令在池里的**可复用性**。 */
export type KoulingState =
  /** 见过、还没验过（抓到了但还没拿去领）。 */
  | 'unknown'
  /** 验过、能用。**只有这个状态计入 [`validCount`]**。 */
  | 'valid'
  /** 不能用（口令错 / 过期）。不再投给任何账号，也不再算作"抓取成果"。 */
  | 'invalid';

/** 口令从哪来。 */
export type KoulingSource =
  /** 直播间弹幕（WebSocket）。⚠ 插件**还没有**这一支（沙箱里没有 WebSocket）。 */
  | 'danmaku'
  /** 小红书主页。 */
  | 'xiaohongshu'
  /** 手工粘贴（**验证通过后与抓到的同等待遇**，用户口径 2026-10-01）。 */
  | 'manual'
  /** **自动抓取**来的，但没细分是弹幕还是小红书（抓取端把两个来源并发合在一个结果里，
   *  分不出谁给的 —— 与其编一个来源，不如如实说"抓来的"）。 */
  | 'auto';

/** 归一化后的领取结论。
 *
 *  ⚠ 这**不是**协议层那个 `DrawKind`（`liveFlower.ts` 里的 `succeeded` / `200108` 那一套）。
 *  任务层负责把协议结论映射到这里 —— 映射表见 `liveRoomRules.ts` 的 [`claimVerdictOf`]。
 *  池**刻意**不 import 协议层：mcloud 的分层理由原样成立（"那个在 mcloud-upstream，
 *  本 crate 看不到它，方向也不该反过来"）。 */
export type ClaimVerdict =
  /** 领到了。 */
  | 'claimed'
  /** 已经领过（上游 `200112`）。**口令是对的**，所以算有效。 */
  | 'alreadyClaimed'
  /** 口令不对（上游 `200108`）。 */
  | 'invalid'
  /** 口令认识但已失效（上游 `200118`）。按用户口径**视同无效**。 */
  | 'expired'
  /** 别的业务码，本层不分类 ⇒ **不改状态**（不能拿它当有效性判据）。 */
  | 'other';

/** 池里的一条口令。 */
export interface PoolCode {
  value: string;
  state: KoulingState;
  source: KoulingSource;
  /** 判定为无效时的原因（人类的说法，直接给界面看）。 */
  reason?: string;
  /** 第一次见到它的时刻（ms）。 */
  firstSeenMs: number;
  /** 判定为有效的时刻（ms）。 */
  validAtMs?: number;
}

/** 一次探测里看到的一间直播房 —— **预告 / 在播 / 回放都留**。
 *
 *  # ⚠ 为什么必须留"门会筛掉"的那些房间
 *
 *  判定门只认「正在直播」+ 主播昵称精确相等，所以**预告场与回放场必然被它筛掉**。
 *  而界面上那行「下一场几点」读的正是**预告场的 `expectStartTime`** ——
 *  门筛掉之后不在这里留一份，日历就跟着丢了。
 *  Go 参考实现踩过这个坑，注释原话是「**日程不能跟着丢**」。 */
export interface ProbeRoom {
  roomId: number;
  /** 房间标题（预告场常常写的就是场次名）。 */
  title: string;
  /** `0` 未开播（预告）/ `1` 直播中 / `2` 已结束（回放）。 */
  status: number;
  /** 预告开播时间：`2026-09-23 14:30:00` 形态的**本地**字符串。
   *
   *  ⚠ **不要**解析成时间戳：它没有时区，解析只会凭空造出一个错误的时刻。
   *  界面**原样显示**它，比较时也只比字符串（定长 ⇒ 字典序等于时间序）。 */
  expectStartTime: string;
  /** 主播昵称（上游原样，判定门的真正判据）。空串 ⇒ **认不出那个唯一有效的主播** ⇒ 那一场不显示。 */
  anchorNickname: string;
}

/** 观测到的一场直播：门开 ⇒ 开场；门关到过了宽限 ⇒ 散场。
 *
 *  ⚠ 散场时刻记的是「**最后一次看到它在播**」而不是"发现它关了的那一刻" ——
 *  后者会把我们没在看的那几个小时也算成直播（门是按分钟抖动的）。 */
export interface LiveSession {
  startedAtMs: number;
  /** `undefined` = 还在播（或我们还没看到它结束）。 */
  endedAtMs?: number;
}

/** 全实例共享的口令池。 */
export interface KoulingPool {
  /** 本周期开始的时刻（`0` = 还没有任何周期）。 */
  cycleAtMs: number;
  codes: PoolCode[];
  /** 账号 → 口令 → 领取结论。
   *
   *  为什么要记：同一条口令对**同一个账号**只能领一次，重复投会被上游拒（`200112`）、
   *  界面上还会显示成一次"失败"。有这张表，挑口令时就能跳过它领过的。 */
  claims: Record<string, Record<string, ClaimVerdict>>;
  /** 最近一次**看见开播**的时刻。 */
  lastLiveAtMs: number | null;
  /** 最近一次**判定门关上**的时刻（用来算封场宽限）。 */
  gateClosedAtMs: number | null;
  /** 最近一次请求小红书主页的时刻（限速用）。 */
  lastXhsAtMs: number | null;
  /** 最近一次**自动抓取**开始的时刻（去重用，见 [`SCRAPE_MIN_INTERVAL_MS`]）。 */
  lastScrapeAtMs: number | null;
  /** 最近一次探测看到的**全部**房间（含预告与回放）——「日程不能跟着丢」。 */
  schedule: ProbeRoom[];
  /** 上面那份日程是什么时候看到的。 */
  scheduleAtMs: number | null;
  /** 这份日程是**哪个主播**的（**只写不读**，排查用 —— mcloud 原注释：要换主播得改
   *  [`KOULING_ANCHOR`]，不是改这里）。 */
  scheduleAnchor: string | null;
  /** 观测到的场次（新的在后）。**不随周期翻篇清空** —— 它是历史。 */
  sessions: LiveSession[];
}

export function emptyPool(): KoulingPool {
  return {
    cycleAtMs: 0,
    codes: [],
    claims: {},
    lastLiveAtMs: null,
    gateClosedAtMs: null,
    lastXhsAtMs: null,
    lastScrapeAtMs: null,
    schedule: [],
    scheduleAtMs: null,
    scheduleAnchor: null,
    sessions: [],
  };
}

// ══════════════════════════ 周期 ══════════════════════════

/** 开一个新周期：**口令与领取记录一起清空**。
 *
 *  ⚠ 领取记录必须跟着清 —— 它记的是"这个账号领过这条口令"，而下一场直播的口令是新的；
 *  不清会让新口令被当成"已领过"跳过。
 *
 *  ⚠ 小红书限速**不跟着清**：那是防封的节流，不是这一场的数据。
 *  抓取间隔（`lastScrapeAtMs`）同理 —— 它管的是"谁去抓"，与场次无关。 */
export function startCycle(pool: KoulingPool, nowMs: number): void {
  pool.cycleAtMs = nowMs;
  pool.codes = [];
  pool.claims = {};
  pool.lastLiveAtMs = null;
  pool.gateClosedAtMs = null;
}

/** 周期是不是该翻篇了。 */
export function isStale(pool: KoulingPool, nowMs: number): boolean {
  if (pool.cycleAtMs === 0) {
    // 新池子：不算"过期"，由第一次写入时定周期起点。
    return false;
  }
  if (nowMs - pool.cycleAtMs > CYCLE_TTL_MS) return true;
  // 判定门关上 + 宽限期过了 ⇒ 这一场结束了。
  return pool.gateClosedAtMs !== null && nowMs - pool.gateClosedAtMs > GATE_CLOSE_GRACE_MS;
}

/** 把还开着的那一场收尾（散场时刻 = 最后一次看到它在播）。 */
export function closeOpenSession(pool: KoulingPool): void {
  const open = pool.sessions[pool.sessions.length - 1];
  if (open && open.endedAtMs === undefined) {
    open.endedAtMs = pool.lastLiveAtMs ?? pool.cycleAtMs;
  }
}

/** 读之前先归位：过期就翻篇。**所有对外操作都应该先走它。**
 *
 *  ⚠ 这里**不写日志**（mcloud 的注释原样）：数据结构不该负责记日志 ——
 *  调用方手上才有"翻篇是因为 TTL 还是因为判定门关了"这个上下文，
 *  它来说这句话才有信息量。 */
export function normalize(pool: KoulingPool, nowMs: number): void {
  if (isStale(pool, nowMs)) {
    closeOpenSession(pool);
    startCycle(pool, nowMs);
  }
  if (pool.cycleAtMs === 0) pool.cycleAtMs = nowMs;
}

// ══════════════════════════ 探测与门 ══════════════════════════

/** 记一次探测看到的东西：**全部房间**（含预告/回放）+ 门开没开。
 *
 *  场次也从这里推：门开 ⇒ 开场（已经有一场开着就不重复开）。
 *  收场不在这里 —— 它要等"门关超过宽限"，也就是周期翻篇那一刻（见 [`normalize`]）。 */
export function noteProbe(pool: KoulingPool, rooms: ProbeRoom[], active: boolean, nowMs: number): void {
  pool.schedule = rooms.slice();
  pool.scheduleAtMs = nowMs;
  // ⚠ **门的状态也从这里记**（内部调 noteGate），不要让它和 noteGate 成为两个
  // 必须同步的入口：`lastLiveAtMs` 靠 noteGate 维护，而"散场时刻"要用它
  // ⇒ 少调一次就会把散场时刻算错（丢的那几小时）。
  noteGate(pool, active, nowMs);
  if (active) {
    const last = pool.sessions[pool.sessions.length - 1];
    const open = last !== undefined && last.endedAtMs === undefined;
    if (!open) {
      pool.sessions.push({ startedAtMs: nowMs });
      while (pool.sessions.length > MAX_SESSIONS) pool.sessions.shift();
    }
  }
}

/** 记一次判定门的观察结果。
 *
 *  看见开播 ⇒ 清掉"门关着"的计时（宽限期重新开始算）；
 *  没看见开播 ⇒ 开始计时（宽限期后才封场，抖动切不碎一场直播）。 */
export function noteGate(pool: KoulingPool, live: boolean, nowMs: number): void {
  if (live) {
    pool.lastLiveAtMs = nowMs;
    pool.gateClosedAtMs = null;
  } else if (pool.gateClosedAtMs === null) {
    pool.gateClosedAtMs = nowMs;
  }
}

/** 记下"这份日程属于哪个主播"（**只写不读**，见 [`KoulingPool.scheduleAnchor`]）。 */
export function noteScheduleAnchor(pool: KoulingPool, anchor: string): void {
  if (anchor !== '') pool.scheduleAnchor = anchor;
}

// ══════════════════════════ 口令进出池 ══════════════════════════

/** 收一批口令进池。返回**新增**条数。
 *
 *  两条规矩：
 *  * 已知**无效**的直接丢 —— 抓取端会反复听到同一条死口令（弹幕里有人复读），
 *    让它进池就等于让"有效计数"永远凑不够 ⇒ 一直抓。
 *  * 已存在的**不改来源也不刷新时间**：口令的有效期由上游决定，
 *    不由我们见到几次决定。 */
export function note(
  pool: KoulingPool,
  values: readonly string[],
  source: KoulingSource,
  nowMs: number,
): number {
  normalize(pool, nowMs);
  let added = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (value === '') continue;
    const existing = pool.codes.find((c) => c.value === value);
    if (existing !== undefined) continue; // 含"无效的不再进池"——它已在池里且状态是 invalid
    if (pool.codes.length >= MAX_POOL_CODES) break;
    pool.codes.push({
      value,
      state: 'unknown',
      source,
      firstSeenMs: nowMs,
    });
    added += 1;
  }
  return added;
}

/** **状态跃迁的唯一入口**：记一条口令在某个账号上的领取结论。
 *
 *  # 映射表（用户 2026-10-01 拍的口径）
 *
 *  | 结论 | 口令状态 |
 *  |---|---|
 *  | `claimed` | 有效 |
 *  | `alreadyClaimed` | 有效（"口令本身是对的"） |
 *  | `invalid` | 无效 |
 *  | `expired` | 无效（**行为上**；原因留成"已过期"） |
 *  | `other` | **不变**（本层没分类，不能当判据） |
 *
 *  ⚠ 「有效」**只升不降**：一条口令被验成有效之后，别的账号再来领只会得到
 *  "已领过"，那不该把它退回未知 —— 否则"够 2 条"会反复丢失。 */
export function noteClaim(
  pool: KoulingPool,
  account: string,
  code: string,
  verdict: ClaimVerdict,
  nowMs: number,
): void {
  normalize(pool, nowMs);
  const value = code.trim();
  if (value === '') return;

  // 先记账号级结果（无论池里有没有这条：手工口令也走这里进池）。
  const mine = pool.claims[account] ?? {};
  mine[value] = verdict;
  pool.claims[account] = mine;

  let state: KoulingState | undefined;
  let reason: string | undefined;
  switch (verdict) {
    case 'claimed':
      state = 'valid';
      reason = '已验证有效';
      break;
    case 'alreadyClaimed':
      state = 'valid';
      reason = '已验证有效（这个账号已领过）';
      break;
    case 'invalid':
      state = 'invalid';
      reason = '口令无效';
      break;
    case 'expired':
      state = 'invalid';
      reason = '口令已过期';
      break;
    case 'other':
      break; // 不改状态（本层没分类，不能当判据）
  }
  if (state === undefined) return;

  const slot = pool.codes.find((c) => c.value === value);
  if (slot !== undefined) {
    // 「有效」不被后到的结论推翻（见上面那条 ⚠）。
    const downgrade = slot.state === 'valid' && state === 'invalid';
    if (!downgrade) slot.state = state;
    slot.reason = reason;
    if (state === 'valid' && slot.validAtMs === undefined) slot.validAtMs = nowMs;
    return;
  }
  // 池里没有它的两种情况：① 手工粘贴的口令（用户口径：**验证后也进共享**）；
  // ② 抓取端因为别的原因没入池。两种都按同一条规矩收进来。
  if (pool.codes.length >= MAX_POOL_CODES) return;
  pool.codes.push({
    value,
    state,
    source: 'manual',
    reason,
    firstSeenMs: nowMs,
    ...(state === 'valid' ? { validAtMs: nowMs } : {}),
  });
}

// ══════════════════════════ 读数与挑选 ══════════════════════════

/** **有效**口令条数。停止抓取的唯一判据（未知/无效都不算）。 */
export function validCount(pool: KoulingPool): number {
  return pool.codes.filter((c) => c.state === 'valid').length;
}

/** 够不够了 —— 够了就全场停止抓取。 */
export function stopScraping(pool: KoulingPool): boolean {
  return validCount(pool) >= VALID_ENOUGH;
}

/** 所有**已验证有效**的口令原文。 */
export function validValues(pool: KoulingPool): string[] {
  return pool.codes.filter((c) => c.state === 'valid').map((c) => c.value);
}

/** 所有**不可复用**的口令原文（给抓取端当"别拿这些来凑数"的过滤器）。 */
export function invalidValues(pool: KoulingPool): string[] {
  return pool.codes.filter((c) => c.state === 'invalid').map((c) => c.value);
}

/** 这个账号是不是已经把这条口令领过了（用来给界面解释"为什么这次没投它"）。 */
export function accountClaimed(pool: KoulingPool, account: string, code: string): boolean {
  const mine = pool.claims[account];
  return mine !== undefined && Object.prototype.hasOwnProperty.call(mine, code.trim());
}

/** 池里这条口令的状态（不在池里 ⇒ `undefined`）。 */
export function codeState(pool: KoulingPool, code: string): KoulingState | undefined {
  return pool.codes.find((c) => c.value === code.trim())?.state;
}

/** 该投给这个账号的口令：**它还没领过的**、且不是无效的。
 *
 *  ⚠ 未知的也要投：池子里的"未知"正是"抓到了但还没验过"，
 *  而**验证的唯一途径就是拿去领** —— 用户口径："在听的同时能够去领取，
 *  直接验证是否有效"。 */
export function pickFor(pool: KoulingPool, account: string): string[] {
  const mine = pool.claims[account];
  return pool.codes
    .filter((c) => c.state !== 'invalid')
    .filter((c) => mine === undefined || !Object.prototype.hasOwnProperty.call(mine, c.value))
    .map((c) => c.value);
}

// ══════════════════════════ 节流 ══════════════════════════

/** 现在该不该由**这一趟**去抓口令。
 *
 *  ⚠ 空池（没抓过）⇒ 放行 —— 这正是"每个周期第一次谁先到谁抓"。 */
export function scrapeReady(pool: KoulingPool, nowMs: number): boolean {
  return pool.lastScrapeAtMs === null || nowMs - pool.lastScrapeAtMs >= SCRAPE_MIN_INTERVAL_MS;
}

/** 记一次"我要开抓了"。
 *
 *  ⚠ 在**动手之前**记，不是抓完之后：抓取要占住整个窗口，抓完再记等于
 *  整个窗口都敞着，别的账号照样扑上来。 */
export function noteScrape(pool: KoulingPool, nowMs: number): void {
  pool.lastScrapeAtMs = nowMs;
}

/** 现在能不能请求小红书主页（限速见 [`XHS_MIN_INTERVAL_MS`]）。 */
export function xhsReady(pool: KoulingPool, nowMs: number): boolean {
  return pool.lastXhsAtMs === null || nowMs - pool.lastXhsAtMs >= XHS_MIN_INTERVAL_MS;
}

/** 记一次小红书主页请求（**成功失败都记**：被风控挡下也算一次请求）。 */
export function noteXhs(pool: KoulingPool, nowMs: number): void {
  pool.lastXhsAtMs = nowMs;
}

/** 距下一次能抓主页还有多久（ms，0 = 现在就能）。给界面说人话用。 */
export function xhsWaitMs(pool: KoulingPool, nowMs: number): number {
  if (pool.lastXhsAtMs === null) return 0;
  return Math.max(0, XHS_MIN_INTERVAL_MS - (nowMs - pool.lastXhsAtMs));
}

// ══════════════════════════ 账号键 ══════════════════════════

/** 手机号 → 池里那个**账号键**。
 *
 *  # 为什么不直接存手机号（mcloud 存的是手机号）
 *
 *  两处都不划算：
 *  ① 池会落进面板的 state 表、还会进接口与界面 —— 手机号已经在凭据里了，
 *     **再抄一份**没有任何收益，只有多一个泄漏点；
 *  ② 判据不需要原文：池只问"这两次是不是同一个账号"。
 *
 *  # 为什么**不用**凭据指纹当键（这是最容易写错的一版）
 *
 *  凭据会被 `authRefresh` **改写**（换票之后 `Authorization` 里是新的 token）
 *  ⇒ 指纹跟着变 ⇒ 池会把同一个账号当成两个人 ⇒ **已经领过的口令再投一次**。
 *  那正是 `claims` 这张表要消灭的事（`200112` 噪声 + 归因被污染）。
 *
 *  ⇒ 键取**手机号**的哈希前缀：换票不变 ✓、不落原文 ✓。取 16 个十六进制字符
 *  （64 bit）—— 单机几个账号的规模下碰撞概率可以忽略。
 *
 *  ⚠ 拿不到手机号（凭据是两段式、或还没贴凭据）时**退化成一个常量键**：
 *  那时"账号"这个概念在插件里本来就不存在（一份会话），退化成 `'default'` 是如实的，
 *  而不是编一个身份。 */
export function accountKey(phone: string): string {
  const p = phone.trim();
  if (p === '') return 'default';
  return toHex(sha256(utf8(`mcloud.kouling.account:${p}`))).slice(0, 16);
}

// ══════════════════════════ 落盘（唯一的 IO 适配）═════════════════════════

/** 读盘的结果。
 *
 *  ⚠ `reset` 为真 = 盘上有东西但**解不出来** ⇒ 这是一份重开的空池，
 *  那一场的领取记录**已经丢了**。必须说出来：不说的话，界面会显示成
 *  "这一场还没领过"，而实际上是被我们丢的。 */
export interface PoolLoad {
  pool: KoulingPool;
  reset: boolean;
}

/** 从一段 JSON 文本里读出池（**容错**：缺字段走默认、坏文本 ⇒ 空池 + `reset`）。 */
export function parsePool(raw: string | null | undefined): PoolLoad {
  if (!raw) return { pool: emptyPool(), reset: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { pool: emptyPool(), reset: true };
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { pool: emptyPool(), reset: true };
  }
  const o = v as Record<string, unknown>;
  const pool = emptyPool();
  pool.cycleAtMs = num(o['cycleAtMs']) ?? 0;
  pool.codes = codeList(o['codes']);
  pool.claims = claimsOf(o['claims']);
  pool.lastLiveAtMs = num(o['lastLiveAtMs']) ?? null;
  pool.gateClosedAtMs = num(o['gateClosedAtMs']) ?? null;
  pool.lastXhsAtMs = num(o['lastXhsAtMs']) ?? null;
  pool.lastScrapeAtMs = num(o['lastScrapeAtMs']) ?? null;
  pool.schedule = roomsOf(o['schedule']);
  pool.scheduleAtMs = num(o['scheduleAtMs']) ?? null;
  pool.scheduleAnchor = typeof o['scheduleAnchor'] === 'string' ? o['scheduleAnchor'] : null;
  pool.sessions = sessionsOf(o['sessions']);
  return { pool, reset: false };
}

export function serializePool(pool: KoulingPool): string {
  return JSON.stringify(pool);
}

/** 从 state 表里读池。 */
export function loadPoolFrom(store: Pick<Store, 'getState'>): PoolLoad {
  return parsePool(store.getState(POOL_KEY));
}

/** 写回 state 表。 */
export function savePoolTo(store: Pick<Store, 'setState'>, pool: KoulingPool, nowIso: string): void {
  store.setState(POOL_KEY, serializePool(pool), nowIso);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function codeList(v: unknown): PoolCode[] {
  if (!Array.isArray(v)) return [];
  const out: PoolCode[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const value = str(o['value']);
    if (value === '') continue;
    const state = o['state'];
    const code: PoolCode = {
      value,
      // 认不出的状态按 **unknown**（不是 valid）：保守方向是"还要再验一次"，
      // 而"当成有效"会让 stopScraping 提前为真。
      state: state === 'valid' || state === 'invalid' ? state : 'unknown',
      source: sourceOf(o['source']),
      firstSeenMs: num(o['firstSeenMs']) ?? 0,
    };
    const reason = str(o['reason']);
    if (reason !== '') code.reason = reason;
    const validAt = num(o['validAtMs']);
    if (validAt !== undefined) code.validAtMs = validAt;
    out.push(code);
  }
  return out;
}

function sourceOf(v: unknown): KoulingSource {
  return v === 'danmaku' || v === 'xiaohongshu' || v === 'manual' || v === 'auto' ? v : 'auto';
}

function verdictOf(v: unknown): ClaimVerdict | undefined {
  return v === 'claimed' || v === 'alreadyClaimed' || v === 'invalid' || v === 'expired' || v === 'other'
    ? v
    : undefined;
}

function claimsOf(v: unknown): Record<string, Record<string, ClaimVerdict>> {
  const out: Record<string, Record<string, ClaimVerdict>> = {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [account, codes] of Object.entries(v as Record<string, unknown>)) {
    if (codes === null || typeof codes !== 'object' || Array.isArray(codes)) continue;
    const mine: Record<string, ClaimVerdict> = {};
    for (const [code, verdict] of Object.entries(codes as Record<string, unknown>)) {
      const v2 = verdictOf(verdict);
      if (v2 !== undefined) mine[code] = v2;
    }
    out[account] = mine;
  }
  return out;
}

function roomsOf(v: unknown): ProbeRoom[] {
  if (!Array.isArray(v)) return [];
  const out: ProbeRoom[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({
      roomId: num(o['roomId']) ?? 0,
      title: str(o['title']),
      status: num(o['status']) ?? 0,
      expectStartTime: str(o['expectStartTime']),
      anchorNickname: str(o['anchorNickname']),
    });
  }
  return out;
}

function sessionsOf(v: unknown): LiveSession[] {
  if (!Array.isArray(v)) return [];
  const out: LiveSession[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const started = num(o['startedAtMs']);
    if (started === undefined) continue;
    const s: LiveSession = { startedAtMs: started };
    const ended = num(o['endedAtMs']);
    if (ended !== undefined) s.endedAtMs = ended;
    out.push(s);
  }
  return out;
}

// ══════════════════════════ 给界面看的快照 ══════════════════════════

/** 上游那种**本地**时刻串：`YYYY-MM-DD HH:MM:SS`。
 *
 *  ⚠ 它只用来**比较**（定长 ⇒ 字典序等于时间序），**不解析回时间戳** ——
 *  上游给的这串东西**没有时区**，解析只会凭空造出一个错误的时刻。
 *  ⚠ 用**本地时区**（上游给的就是本地时刻）：所以它跟着运行机器的时区走，
 *  测试里**不要断言它的具体值**（F-019 就是"测试依赖了机器的时区"那条）。 */
export function localStamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 池状态快照。`nowLocal` = "现在"的**本地**时刻（与上游同一个格式、同一个时区）。
 *
 *  ⚠ 「下一场」的三个字段（时间/标题/主播）**必须来自同一次选择** ——
 *  否则可能出现"时间取的是 A 场、标题取的是 B 场"这种自相矛盾的快照。 */
export interface PoolSummary {
  cycleAtMs: number;
  validCount: number;
  /** 够 2 条了 ⇒ 界面可以正大光明地写"不需要再抓口令了"。 */
  stopScraping: boolean;
  codes: PoolCode[];
  /** 下一场的开播时间（预告场给的**本地字符串**，原样）。 */
  nextStart?: string;
  /** 下一场是**哪一间**（房间标题）—— 光有时间分不出是不是自己那个直播间。 */
  nextTitle?: string;
  /** 下一场是**哪个主播**（上游昵称，原样）。 */
  nextAnchor?: string;
  /** 上面那个时间是什么时候探测到的（判断它还新不新）。 */
  scheduleAtMs: number | null;
  /** 观测到的场次（**新的在前**，界面上"最近几场"）。 */
  sessions: LiveSession[];
  /** 距下一次能抓小红书主页还有多久（ms，0 = 现在就能）。 */
  xhsWaitMs: number;
}

export function poolSummary(pool: KoulingPool, nowLocal: string, nowMs: number): PoolSummary {
  const next = nextRoomAt(pool.schedule, nowLocal);
  const s: PoolSummary = {
    cycleAtMs: pool.cycleAtMs,
    validCount: validCount(pool),
    stopScraping: stopScraping(pool),
    codes: pool.codes.slice(),
    scheduleAtMs: pool.scheduleAtMs,
    sessions: pool.sessions.slice().reverse(),
    xhsWaitMs: xhsWaitMs(pool, nowMs),
  };
  if (next !== undefined) {
    s.nextStart = next.expectStartTime;
    if (next.title !== '') s.nextTitle = next.title;
    if (next.anchorNickname !== '') s.nextAnchor = next.anchorNickname;
  }
  return s;
}

// ══════════════════════════ 「下一场」的判据（自由函数，判据只有一份）══════════════════════════

/** 从一串**上游原样**的房间（[`ProbeRoom`]）里挑「下一场」。
 *
 *  判据三条：
 *  1. **只认目标主播**（昵称精确等于 [`KOULING_ANCHOR`]）—— 上游列表里混着别的主播；
 *  2. **只认预告场**（`status == 0`）—— `expectStartTime` 只在那一档有意义；
 *  3. **跳过已经过去的场次**（`expectStartTime >= nowLocal`）—— 上游会把开过的场次
 *     继续挂在预告里（用户实测 2026-10-02：「16:31 还显示 15:00」）。
 *
 *  再取**最早**那一条（只比字符串：定长 ⇒ 字典序等于时间序）。
 *
 *  ⚠ 为什么做成**自由函数**：mcloud 那边「下一场」有两个来源（盘上的池 / 上游现取），
 *  两个来源必须**同一套判据**。插件将来接上门的三步之后同理 —— 判据只写在这里。 */
export function nextRoomAt(rooms: readonly ProbeRoom[], nowLocal: string): ProbeRoom | undefined {
  return earliestPreviewIn(rooms, true, nowLocal);
}

/** [`nextRoomAt`] 与"不筛时间"那一支共用的那一段。
 *
 *  ⚠ 两个入口的参数**刻意保留**（`onlyTarget` / `notBefore` 各是一档）：
 *  "不筛时间"的那一支（`nextRoom()`）也要走它 —— 合成一个只认"目标 + 现在"的函数
 *  会让那一支被迫造一个假的 `nowLocal`。 */
export function earliestPreviewIn(
  rooms: readonly ProbeRoom[],
  onlyTarget: boolean,
  notBefore?: string,
): ProbeRoom | undefined {
  let best: ProbeRoom | undefined;
  for (const r of rooms) {
    if (r.status !== 0) continue;
    if (r.expectStartTime === '') continue;
    if (onlyTarget && r.anchorNickname !== KOULING_ANCHOR) continue;
    if (notBefore !== undefined && r.expectStartTime < notBefore) continue;
    if (best === undefined || r.expectStartTime < best.expectStartTime) best = r;
  }
  return best;
}
