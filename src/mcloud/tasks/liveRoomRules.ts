// 直播口令 → 小红花：**编排层的判据**（纯函数，零 IO）。
//
// 权威源：mcloud 的 `crates/mcloud-tasks/src/live_room.rs`（编排层）。
// 它自己的分层话是这么说的：
//
// > 请求构造与响应判定全在 `mcloud_upstream` 的纯函数层
// > （`live_flower` / `live_room` / `live_kouling` / `live_ws`），本模块只做**编排**：
// > 串步骤、判分支、把结论说成一句人话。
// >
// > 为什么判据住在这一层（而不是散在流程里）：这条链一年里只有主播开播的那几小时
// > 才能真跑一次，所以"哪一步该发什么、拿到什么响应该往哪走"必须能在单测里全部走完。
//
// 插件的对应分层：
//
// ```text
//   liveFlower.ts     协议层（请求构造 + 响应判定）—— 已落地，照 mcloud 的 live_flower
//   koulingPool.ts    池（业务档）                —— 本轮落地，照 mcloud-core/kouling.rs
//   本文件            编排层判据                  —— 门 / 参数 / 合并 / 分隔 / 结论映射
//   tasks/*.ts        动作（一枪一枪的 IO，一次调用一步）
// ```
//
// # 四条产品事实（不是提示文案，是判据 —— mcloud 原文）
//
// 1. **`codes` 不是可选项**：小红书那条口令没法自动化（那边无法鉴权），必须由人工喂进来
//    —— 这就是为什么"听弹幕"永远拿不全两条。
// 2. **任何"历史口令"都是废值**：口令只在**本次直播**有效，上一场的不能用。
//    ⇒ 不保存口令、不跨场复用、**不拿已结束场次的弹幕当口令来源**。
//    （插件侧的落点是池：周期一翻篇，口令与领取记录**一起清**。）
// 3. 每场 **2~3 条**是正常形状：别把"只收到 1 条"当成已收全，也别把"收到 3 条"当脏数据。
// 4. 弹幕里的口令**署名是谁都能用**：**不要**按"发信人是不是我"过滤。
//
// # 本文件**没有**搬过来的两条判据（写清楚免得后人以为是抄漏了）
//
// mcloud 的编排层还有一对纯函数：`retry_plan`（要不要再听一次 + 排除表）与
// `pick_new_codes`（重听结果里哪些该领）。它们的存在前提是**"听弹幕"那个循环**：
//
// ```text
//   听 60 秒 → 领一遍 → 够 2 条有效吗？不够就**排除已试过的**再听一次
// ```
//
// 插件**没有这一支**（沙箱里没有 WebSocket，见 `liveKouling.ts` 文件头与
// `groups.ts` 里 `live-room` 那条的注释）。硬搬会得到一个**没有对象**的函数 ——
// 而它们的判据在插件里**已经有了落点**，且是同一份：
//
// ```text
//   retry_plan 的"够 2 条就停"   ⇒ koulingPool.stopScraping（抓取侧）
//   retry_plan 的"排除已试过的"  ⇒ koulingPool.pickFor + 本文件的 planDrawCodes（领取侧）
// ```
//
// ⚠ 等 WS 那一支真接上时，这两个函数要**照 mcloud 原样补在这里**，别各写一遍
// （判据分叉的代价用户已经见过一次：`200118` 被当成"口令抄错了"）。

import { KOULING_ANCHOR, accountClaimed, accountKey, codeState, pickFor } from '../koulingPool.ts';
import type { ClaimVerdict, KoulingPool } from '../koulingPool.ts';
import type { DrawKind } from '../liveFlower.ts';
import { parseAuthorization } from '../authRefresh.ts';
import { STATE_AUTH, loadAuthRaw } from '../sessionExchange.ts';
import type { Store } from '../../store/types.ts';

export { KOULING_ANCHOR };

// ══════════════════════════ 账号键 ══════════════════════════

/** 当前这份会话是**哪个账号**（池按它分账：`claims[account][code]`）。
 *
 *  # 为什么它住在编排层
 *
 *  池只知道"账号键"这个字符串，**不知道**它从哪来（那是凭据的存储细节）。
 *  而两个任务（抓取 / 领取）都要问同一个问题 ⇒ 判据只能有一份，写在这里。
 *
 *  # 从哪读
 *
 *  原生凭据 `Authorization: Basic base64("mobile:手机号:token")` —— 手机号段是
 *  里面**唯一稳定**的东西（token 会被 `authRefresh` 换掉）。
 *  ⇒ 键 = 手机号的哈希前缀，见 `koulingPool.accountKey` 那段注释（为什么不存原文、
 *  为什么不能用凭据指纹）。
 *
 *  ⚠ 拿不到手机号时退化成 `'default'`：**不是**保守，是如实 ——
 *  一份会话的面板里"账号"这个概念本来就不存在。 */
export function accountOf(store: Pick<Store, 'getState'>): string {
  const raw = loadAuthRaw(store);
  if (raw === '') return accountKey('');
  const seg = parseAuthorization(raw);
  return accountKey(seg?.phone ?? '');
}

// ══════════════════════════ 判定门 ══════════════════════════

/** 上游那份房间列表里的一间（**只留判据要用的三格**）。
 *
 *  ⚠ 与 `koulingPool.ProbeRoom` **不是同一个东西**：那个是**进池**的形状
 *  （含 `expectStartTime` / `title`，给"下一场"用），这个是**判定门**的输入
 *  （只要 id / status / 昵称）。两者由 `toProbeRooms()` 单向连起来 ——
 *  合成一个类型会让"门筛掉的房间也要进池"这件事看不出来。 */
export interface GateRoom {
  id: number;
  /** `0` 未开播（预告）/ `1` 直播中 / `2` 已结束（回放）。 */
  status: number;
  /** 主播昵称（上游 `anchor.nickname` 原样）。 */
  anchorNickname: string;
}

/** "要不要去听口令"的判定结果。 */
export interface KoulingGate {
  /** **有**符合条件的（直播中 + 主播是那个固定昵称）直播间。 */
  active: boolean;
  /** 通过筛选的直播间（已按 id 去重）。 */
  rooms: GateRoom[];
  /** 筛完 `status == 1` 之后剩下的房间数（**用于区分两种"没有"**）。
   *
   *  ⚠ 它与 `active` 一起才说得清现状：
   *
   *  ```text
   *    liveCount == 0            → 谁都没在播（今天没有直播）
   *    liveCount > 0 && !active  → 有人**在播**，但不是那个主播
   *  ```
   *
   *  实拍踩过：房间 147490「福建移动」是 `status == 1`，与真正要听的那间
   *  在**同一个页签**里。只报 `active == false` 会把这两种情况混成一句"没有直播"，
   *  而它们的下一步**完全不同**（一个是等，一个是别等了）。 */
  liveCount: number;
}

/** 判定门的开合（纯函数）。
 *
 *  # 判据是**两个条件同时成立**
 *
 *  ```text
 *    room.status == 1  且  room.anchorNickname === "中国移动云盘"
 *  ```
 *
 *  ⚠ **只看 `status == 1` 会误判**：同一个页签里别的主播也在播（实拍 147490）。
 *  ⚠ **`channelId` 不能当过滤条件**：返回的房间的 `channelId` 有 29/51/243/134
 *  —— 它表达的是"房间归属哪个频道"，不是"我拉的是哪个频道"。
 *  ⚠ 去重按 **id**：同一间房可能因为分页/多频道出现两次，不去重会让"要听几间"
 *  这个数虚高（而它决定要不要并发听）。 */
export function judgeKoulingGate(rooms: readonly GateRoom[]): KoulingGate {
  const live = rooms.filter((r) => r.status === 1);
  const hit: GateRoom[] = [];
  const seen = new Set<number>();
  for (const r of live) {
    if (r.anchorNickname !== KOULING_ANCHOR) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    hit.push(r);
  }
  return { active: hit.length > 0, rooms: hit, liveCount: live.length };
}

/** 门那两种"没有"说成人话（**不许混成一句"没有直播"**，理由见 [`KoulingGate.liveCount`]）。 */
export function gateLine(g: KoulingGate): string {
  // 「门」是内部说法（指"有没有我们等的那个直播间"）—— 用户看到的是"在不在听"
  if (g.active) return `正在听：${KOULING_ANCHOR} 开播了（${g.rooms.length} 间在播）`;
  if (g.liveCount === 0) return '现在没在听：谁都没开播';
  return `现在没在听：有 ${g.liveCount} 间在播，但不是「${KOULING_ANCHOR}」的`;
}

// ══════════════════════════ 参数组合的判据 ══════════════════════════

/** 一趟运行里**由使用者决定**的那几件事（插件版）。
 *
 *  ⚠ 与 mcloud 的 `LiveRoomParams` 差一格：那边还有 `listen_seconds`（听弹幕多久），
 *  插件**没有弹幕来源**，所以没有这一格 —— 见 [`LiveRoomFault`] 里那条说明。 */
export interface LiveRoomParams {
  /** 手工口令。**非空就不再抓取**（这一趟没有口令要抓）。 */
  codes: string[];
  /** 开不开自动抓取（插件里 = 抓小红书主页）。 */
  autoScrape: boolean;
}

/** 参数组合上的冲突**种类** —— 只有种类，没有措辞。
 *
 *  # 为什么判据在这层、措辞不在（mcloud 原文，逐字成立）
 *
 *  判据本身只有一个答案，两个产物各写一遍必然漂移（一处放行、一处拒绝，
 *  而"哪一处才是对的"没人能从那两份代码里读出来）。措辞则**必须**各写一遍：
 *  cron 那条路要说"这一趟没有来源"，界面那条路要说"先去输入框贴一条"。
 *
 *  ⚠ **mcloud 的第二条判据（`listen_seconds == 0`）没有搬过来**：它判的是
 *  "要听弹幕、可时长不是正数"，而插件**没有弹幕那一支** —— 编一个假的 `listenSeconds`
 *  只会得到一个永远为假的条件。等 WS 接上时，那条判据照 mcloud 原样加在这里
 *  （它的注释理由也照抄：时长那一条**不看** `skipKouling`，非正在任何情况下都不是合法输入）。 */
export type LiveRoomFault =
  /** 关掉了自动抓取，又没给手工口令 —— 这一趟连一个来源都没有。 */
  | 'noSource';

/** 判据的中性描述（**不含界面文案**，措辞由调用方自己写）。 */
export function describeFault(f: LiveRoomFault): string {
  switch (f) {
    case 'noSource':
      return '关掉了自动抓取，却没有给手工口令';
  }
}

/** 判这一组参数**是否成立**（纯函数）：`!autoScrape && codes.length === 0` ⇒ 不成立。 */
export function checkParams(p: LiveRoomParams): LiveRoomFault | null {
  if (!p.autoScrape && p.codes.length === 0) return 'noSource';
  return null;
}

// ══════════════════════════ 口令的合并与拆分 ══════════════════════════

/** 合并多个来源的口令（**保序去重、逐条 trim、丢掉空串**）。
 *
 *  两个来源（小红书主页 / 人工粘贴）**地位相同**：任一来源为空不影响另一个。 */
export function mergeKouling(sources: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of sources) {
    const code = raw.trim();
    if (code === '' || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}

/** 把**一栏自由文本**拆成口令（空白 / 换行 / 逗号 / 顿号都算分隔符）。
 *
 *  # ⚠ 空白也算分隔符，而这一点**原先漏了**（mcloud 的原注释，代价照抄）
 *
 *  早先只拆 `\n \r , ， 、`，于是 `"口令甲 口令乙"` 会被当成**一条**口令发上去
 *  —— 服务端必然回 `200108 口令无效`，而用户看到的是
 *  "我明明填了两条，怎么只领了一条还说口令错"。
 *
 *  mcloud 那边为什么会漏：它的 WebUI 自己在 `api.ts` 里先按空格拆了一遍（作为"超集"），
 *  于是**界面上看着是对的**；而 CLI 与 HTTP API 两条路都直接走本函数，没有那层补偿。
 *  ⇒ 修在**这一处**（所有入口共用），而不是在各调用方各补一次。
 *
 *  ⚠ 用 `\s`（含全角空格 `U+3000`、`\t`、NBSP）**不是** ASCII 空格 ——
 *  手机输入法默认就是全角空格，而口令是从手机里复制粘贴出来的，
 *  全角空格在这里是**常见**输入而不是边角情况。 */
export function splitKouling(raw: string): string[] {
  return mergeKouling(raw.split(/[\s,，、]+/));
}

// ══════════════════════════ 协议结论 → 池 ══════════════════════════

/** 协议层的 `DrawKind` → 池的 [`ClaimVerdict`]（**映射表只有这一份**）。
 *
 *  | 协议结论 | 池的结论 | 为什么 |
 *  |---|---|---|
 *  | `succeeded` | `claimed` | 领到了 |
 *  | `already-drawn`（`200112`）| `alreadyClaimed` | **口令是对的**，只是这个账号领过 |
 *  | `invalid-kouling`（`200108`）| `invalid` | 口令错 |
 *  | `kouling-expired`（`200118`）| `expired` | 口令对、场次结束了 ⇒ 行为上不可复用，**原因留着** |
 *  | `other` | `other` | 本层没分类 ⇒ **不改状态**（拿它当有效性判据就是编结论）|
 *  | `unparsable` | `other` | 连码都没有 ⇒ 同样是"没分类" |
 *
 *  ⚠⚠ `kouling-expired` 在这里算**无效**，但 `liveFlower.rejectedKouling()` 对它
 *  必须返回 **`false`**（"我是不是把口令认错了" ⇒ 过期说明我认得没错 ⇒ 不重听）。
 *  两处**刻意分开**，理由见 `koulingPool.ts` 文件头那段。 */
export function claimVerdictOf(kind: DrawKind): ClaimVerdict {
  switch (kind) {
    case 'succeeded':
      return 'claimed';
    case 'already-drawn':
      return 'alreadyClaimed';
    case 'invalid-kouling':
      return 'invalid';
    case 'kouling-expired':
      return 'expired';
    default:
      return 'other';
  }
}

// ══════════════════════════ 这一轮要试哪些口令 ══════════════════════════

/** 挑出这一轮**真正要投**的口令：人给的那份在前，池里该投的在后。
 *
 *  # 两道筛，判据与池同一份
 *
 *  ```text
 *    ① 池里已判**无效**的 ⇒ 不投（否则每轮都白跑一枪 200108）
 *    ② 这个账号**领过**的 ⇒ 不投（否则回 200112：不是新结果，却会污染归因，
 *                              看起来像"口令坏了"）
 *  ```
 *
 *  ⚠ 为什么人给的那份**也要过筛**（mcloud 里不需要这一步）：
 *  那边的判据是 `pick_for(account)`，而**手工口令在验证后会进池**
 *  ⇒ 池的筛自然覆盖到它。插件这边人给的那份**可能还没进池**
 *  （它进池的时机是"第一次被拿去领"）⇒ 所以要在这一层补一次**同样的筛**。
 *  判据同一份，只是作用域大一圈。
 *
 *  ⚠ 顺序是**人给的在前**（界面上会把这一列先显示出来，所以不是暗箱）：
 *  那一份是**他确认过的**。 */
export function planDrawCodes(
  pool: KoulingPool,
  account: string,
  humanCodes: readonly string[],
): string[] {
  const picked = pickFor(pool, account);
  const out: string[] = [];
  for (const code of mergeKouling([...humanCodes, ...picked])) {
    if (codeState(pool, code) === 'invalid') continue;
    if (accountClaimed(pool, account, code)) continue;
    out.push(code);
  }
  return out;
}
