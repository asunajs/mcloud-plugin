// 任务分组：把 mcloud 的任务按**它的真实维度**分组，而不是按我的臆想。
//
// 来源是 mcloud 自己的 `docs/task-inventory.md` —— 那张表逐条列了每条任务的
// 类型（Action/Query）、副作用（记账 / 不可逆 / 往网盘写 / 真扣AI豆）、
// 依赖的凭据（jwt / 活动站票 / Basic+jWT / WebSocket / 滑块）、
// 能否进编排（批量）、是否隐藏、错过时补跑还是放弃（catch-up / skip）。
//
// 这些维度**正好就是分组该用的东西**：操作一条任务之前，人真正要知道的是
// 「它安不安全、要哪种凭据、错过会不会补」——而不是它属于哪个功能模块。
//
// 所以这里的分组是按**风险与依赖**切的，不是按功能名切的：
//
//   签到族      无害且幂等（重复只会回"今日已签到"）→ 可以随便点
//   通知与趣玩  记账，但幂等 → 可以点
//   活动站票    需要**另一套凭据**（活动会话票，与 jwt 无关）→ 点了多半是失败，
//               除非那份票还在
//   网盘写入    会往你的网盘里写东西/建删外链/发邮件 → 看清楚再点
//   高风险      真扣 AI豆、不可回滚 → 默认关，且面板上要二次确认
//   查询诊断    只读，点多少次都无所谓
//
// ─────────────────────────────────────────────────────────────────────
// 下一步的拆分方案（用户拍的板，按**功能族**）：
//
//   mcloud-signin    签到族，**含 `app-task` 等每日/月默认任务**
//   mcloud-exchange  兑换
//   mcloud-live      直播
//
// 起名即分组（面板按名字前缀归拢），所以拆出来的前缀都用 `mcloud`。
//
// 去源码核对了这三族的"另一半"，结论比想象的好 —— **每一族都有只读半边，
// 现在就能做**，写的那半各自卡在不同的东西上：
//
//   · `app-task`   读的那半叫 `app-task-matrix`（只看）。写的那半每发
//                  `task/click` 都在写且**不可回滚**，还会**往用户网盘传文件**
//                  （玩法 106 / 522 / beiyong1 的名字门；传完自己移回收站）。
//                  判据是纯函数 `upload_shape_for` ⇒ 能在无网络下钉住 ⇒
//                  **先做只读那半**，写的那半等有真账号再说。
//   · `exchange`   只读那半源码写得明明白白："读一次清单，逐件判能不能兑，
//                  **不碰余额、不碰滑块、不下单**"。下单要过**滑块**，
//                  而滑块接口**计失败次数**（白花额度）⇒ 只读那半先做。
//   · `live-room`  ⚠️ 我原以为沙箱没有 WebSocket 就等于做不了。**错了**：
//                  它有两个**地位相同**的来源 —— WebSocket 弹幕 **和小红书主页**
//                  （源码原话："任一来源为空不影响另一个"）⇒ 少一条腿不等于走不了。
//                  但**口令本身要人给**（那边无法鉴权）⇒ 先做"抓主页 + 输入口"这一半
//                  （已做，见 TASK_META 里那条的注释）；领小红花那半没做。
//
// 同一个套路：先把能照实写的写完，写的那半等证据或凭据到位。
// ─────────────────────────────────────────────────────────────────────

// ⚠️ 有一列是**给未来的自己看的**：`implemented`。20 条里目前只接了 8 条
// （另加 3 条插件自己的：selftest / diag / session-check）。没接的照样列出来 ——
// 一是让你知道**总共有什么**，二是这份表本身就是路线图，免得"还剩什么"要靠记忆。

import type { Store } from '../store/types.ts';

/** 副作用等级。顺序即"从安全到危险"，界面按它排序/配色。 */
export type Risk = 'none' | 'ledger' | 'write-cloud' | 'irreversible' | 'spend';

/** 需要的凭据。 */
export type Dep = 'jwt' | 'activity-token' | 'basic+jwt' | 'websocket' | 'slider';

/** 错过触发点时的兜底策略（与面板的 `lateMs` 配合，见 base.ts 的跳过策略）。 */
export type Missed = 'catch-up' | 'skip';

export interface TaskMeta {
  name: string;
  title: string;
  group: GroupId;
  kind: 'Action' | 'Query';
  risk: Risk;
  missed: Missed;
  deps: Dep[];
  /** 能否进编排（mcloud 的 `RunInBatch`） */
  batch: boolean;
  /** 是否从通用列表里隐藏（mcloud 的 `Hidden`） */
  hidden: boolean;
  /** **本插件实现到哪了**（见文件头） */
  implemented: boolean;
  /** 上游证据到哪一步 —— 决定"现在**能不能**忠实实现"。
   *
   *  **可选**，而且是故意的：只在我们真去源码里核对过的地方才填。
   *  没填 = 没核对过（不是我估了个值）—— 要查就看 mcloud 的 `docs/task-inventory.md`。 */
  evidence?: Evidence;
  /** 为什么危险 / 为什么要这套凭据 —— 一两句人话，界面直接显示 */
  note?: string;
}

/** 上游证据状态。这一列区分的是「能照实写」与「只能照旧项目的口径猜」。
 *
 *  `captured` —— 有实拍：路径/方法/字段名都逐字见过
 *  `partial`  —— 只实拍到"成功那一枪"，失败形态还没样本
 *  `none`     —— 零样本：方法、非 0 例文全空
 *  `no-ticket` —— **连那张票怎么换都没抓到**，页面的特有取法无从得知
 *
 *  `none` / `no-ticket` 两条是**拦路石**：不是难度问题，是没证据就没法照实写。
 */
export type Evidence = 'captured' | 'partial' | 'none' | 'no-ticket';

export type GroupId =
  | 'signin'
  | 'daily'
  | 'activity'
  | 'cloud-write'
  | 'risky'
  | 'query'
  | 'plugin';

export interface GroupMeta {
  id: GroupId;
  title: string;
  /** 这一组为什么这么分（界面上一句话说明） */
  why: string;
  /** 展示顺序；越小越前 */
  order: number;
}

export const GROUPS: GroupMeta[] = [
  {
    id: 'plugin',
    title: '插件自身',
    why: '不是云盘的事，是这个插件自己的健康检查与自检',
    order: 0,
  },
  {
    id: 'signin',
    title: '签到族',
    why: '无害且幂等：重复只会回「今日已签到」。可以放心点、可以补跑',
    order: 1,
  },
  { id: 'daily', title: '通知与趣玩', why: '记账类，幂等，漏了可以补', order: 2 },
  { id: 'query', title: '查询与快照', why: '只读，点多少次都无所谓', order: 3 },
  {
    id: 'activity',
    title: '活动与站票',
    why: '要**另一套凭据**（活动会话票，与 jwt 无关）—— 那份票不在，点了必然失败',
    order: 4,
  },
  {
    id: 'cloud-write',
    title: '网盘写入',
    why: '会往你的网盘里写文件 / 建删外链 / 发邮件 —— 想清楚再点',
    order: 5,
  },
  {
    id: 'risky',
    title: '高风险',
    why: '真扣 AI豆、不可回滚 —— 默认关闭，要开必须自己想清楚',
    order: 6,
  },
];

/** 20 条云盘任务 + 3 条插件自己的。逐条抄自 `docs/task-inventory.md`。 */
export const TASK_META: TaskMeta[] = [
  // ── 插件自身 ──
  { name: 'selftest', title: '沙箱自检', group: 'plugin', kind: 'Query', risk: 'none', missed: 'catch-up', deps: [], batch: false, hidden: false, implemented: true, note: '密码学/UTF-8/base64/SQLite 都跑一遍' },
  { name: 'diag', title: '调度健康', group: 'plugin', kind: 'Query', risk: 'none', missed: 'catch-up', deps: [], batch: false, hidden: false, implemented: true, note: '记录每次触发的调度延迟（面板 F-001 的那条测量）' },
  { name: 'session-check', title: '会话体检', group: 'plugin', kind: 'Query', risk: 'none', missed: 'catch-up', deps: [], batch: false, hidden: false, implemented: true, note: '每天 7:50 先问一次上游还认不认这份凭据' },
  // H5 换票（三步）：原生凭据 → `jwttoken`。**这是插件能不能用的前提** ——
  // 之前只能靠人手从浏览器抄票，而票 2 小时即废（过期时所有任务一起回 90001，
  // 看起来像"账号被踢了"）。现在自己换、自己续，鉴权细节见 mcloud/h5session.ts。
  { name: 'session-refresh', title: '会话续期（H5 换票）', group: 'plugin', kind: 'Action', risk: 'none', missed: 'catch-up', deps: [], batch: false, hidden: false, implemented: true, evidence: 'captured', note: '原生凭据 → 三步换 jwttoken，约 2 小时自动续；票新鲜时**一个请求都不发**' },

  // ── 签到族（8 条，全实现）──
  { name: 'sign', title: '每日签到', group: 'signin', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['jwt'], batch: true, hidden: false, implemented: true, evidence: 'captured', note: '三段式：问状态 → 提交 → 回查（判据是回查）' },
  { name: 'receive', title: '领取AI豆', group: 'signin', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['jwt'], batch: true, hidden: false, implemented: true, evidence: 'captured', note: '逐条独立；延期领取走另一口端点' },
  { name: 'multiple', title: '签到翻倍', group: 'signin', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['jwt'], batch: true, hidden: false, implemented: true, evidence: 'captured', note: '每月一次机会 —— 门槛由插件自己判，条件不成立时一个字节都不发' },
  { name: 'backup-gift', title: '备份好礼', group: 'signin', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['jwt'], batch: true, hidden: false, implemented: true, evidence: 'captured', note: '**GET 却是写**；两步：先问能不能领，能领才领' },
  { name: 'revival', title: '用复活卡/回馈卡', group: 'signin', kind: 'Action', risk: 'irreversible', missed: 'skip', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured', note: '**不可逆** —— 晚超过 2 小时就不做' },
  { name: 'prizes', title: '待领取奖品', group: 'query', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured' },
  { name: 'task-list', title: '任务清单', group: 'query', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured' },
  { name: 'cloud-snapshot', title: 'AI豆余额快照', group: 'query', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured', note: '只取第一页；一页装满会如实说可能还有下一页' },

  // ── 通知与趣玩（未实现）──
  // 它用**签到页那张票**（`SessionRecipe::SignInPage`）—— 就是本插件手里已有的会话，
  // 所以「只依赖 jwt」这条是对的。`getTaskInfo` 有实拍；`reward` 只实拍到成功那一枪。
  { name: 'exchange-list', title: '兑换清单（只看）', group: 'activity', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured', note: '逐件判能不能兑；**不碰余额、不碰滑块、不下单**' },
  { name: 'app-task-matrix', title: 'App 任务矩阵（只看）', group: 'signin', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'captured', note: '8 个 group 一次读一个；只读，一个字节都不写' },
  { name: 'notice', title: '开启通知领AI豆', group: 'daily', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['jwt'], batch: true, hidden: false, implemented: true, evidence: 'partial', note: '有手动前置（判不出来，见 notice.ts 文件头 ③）；reward 不报到账数 ⇒ 靠下一轮回查' },
  // ⚠️ 2026-10-14 第三次更正：**换票那一步现在有了**（通用机制，见 mcloud/h5session.ts
  //    与 sessionExchange.ts：原生凭据 → querySpecTokenV2 → 时间戳 → tyrzLogin → jwttoken）。
  //    所以"换票做不了"这句话**不再成立** —— 我连着两轮把"我没有"说成了"不能做"：
  //      ① 「实拍归档里没有」→ 那是**实拍**没有，**实现**有（Rust 侧那三百行）
  //      ② 「⇒ 现在做不了」 → 做不到的只是"照实拍逐字复刻"，而通用那套是**照实现**复刻的
  //    这一条真正缺的是**它自己那一页的换票参数**（`marketName` / `sourceId`）——
  //    签到页与 msgpushon 页有实拍，这一页没有。缺参数 ≠ 缺机制。
  { name: 'fun-ai', title: '趣玩AI抽奖', group: 'activity', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['activity-token'], batch: true, hidden: false, implemented: false, evidence: 'no-ticket', note: '换票那步没抓到 ⇒ 做不了' },
  // 更正：整条链在 `/ycloud/msgPushOn/` 下、要**另一张票**（marketName=msgpushon /
  // sourceId=1062）。`task/status` 有实拍，`task/obtain` **零样本** ——
  // "什么值该做什么"仍是旧项目口径，一条都没被上游证实过。
  { name: 'msg-push', title: '消息推送任务', group: 'activity', kind: 'Action', risk: 'ledger', missed: 'skip', deps: ['activity-token'], batch: false, hidden: false, implemented: false, evidence: 'partial', note: '要另一张票（msgpushon）；obtain 零样本' },

  // ── 活动与站票（未实现）──
  { name: 'cloud-phone-redpack', title: '红包派对', group: 'activity', kind: 'Action', risk: 'ledger', missed: 'catch-up', deps: ['activity-token'], batch: false, hidden: false, implemented: false, note: '⚠ 读到没见过的状态码时**刻意不发写**（旧 TS 会发）' },
  { name: 'play-ai-special', title: '拍拍盘点', group: 'activity', kind: 'Query', risk: 'none', missed: 'catch-up', deps: ['jwt', 'activity-token'], batch: false, hidden: false, implemented: false },
  // ⚠️ 这条我**改过两次口径**，第三次才对：
  //   ① 先说「需要 WebSocket ⇒ 做不了」✗
  //   ② 再说「两个来源地位相同（WS 弹幕 / 小红书主页），少一条腿不等于走不了」——
  //      这一半是对的：小红书主页确实只是一次**公开 GET**
  //   ③ 但源码里还有一句我漏了：**口令（codes）不是可选项** ——
  //      「小红书那条口令**没法自动化**（那边**无法鉴权**）」，只能由**人给**
  //   ⇒ 能自动的是「抓主页」，不能自动的是「口令本身」。这是两件事。
  //   所以拦路石不是 WS，是**缺一个输入口**（让人把口令填进来）。
  //
  // 2026-10-13：**只读那一半已实现**（用户选的方案：加口令输入框 + 只做「抓主页 + 列出口令」）。
  // 抓主页走的是原项目 `xiaohongshu.ts` 的公开 GET + 逐字移植的提取器（41 条黄金向量守着）。
  // 领小红花那一步（写、会入群足迹）**仍然没做** —— 所以 risk 维持 `ledger` 不变。
  { name: 'live-room', title: '直播口令（只看）', group: 'activity', kind: 'Query', risk: 'none', missed: 'catch-up', deps: [], batch: false, hidden: false, implemented: true, evidence: 'partial', note: '抓口令发布方的**公开**主页 + 列出口令（**不需要凭据**）；口令要人给（那边无法鉴权）' },
  // 写那半。**默认关**（`mcloud.live.claim_enabled`），开关与二次确认都在插件界面上。
  // 它虽然记账，但**基本幂等**：同一条口令再领一次回 `200112`（已兑换过），不会重复发奖。
  // 所以 risk 是 `ledger` 而不是 `irreversible`。
  { name: 'live-draw', title: '领小红花（写）', group: 'activity', kind: 'Action', risk: 'ledger', missed: 'skip', deps: ['jwt'], batch: false, hidden: false, implemented: true, evidence: 'partial', note: '六步链 9+N 个请求，一次调用一步；**默认关**。同口令重领回 200112 ⇒ 基本幂等。⚠ 请求头形状未在真账号上验过' },

  // ── 网盘写入（未实现）──
  { name: 'app-task', title: 'App 任务（做任务）', group: 'cloud-write', kind: 'Action', risk: 'write-cloud', missed: 'skip', deps: ['jwt'], batch: false, hidden: false, implemented: false, note: '会上传 / 建删外链 / 发邮件' },
  { name: 'task-expansion', title: '任务拓展', group: 'cloud-write', kind: 'Action', risk: 'write-cloud', missed: 'skip', deps: ['jwt'], batch: false, hidden: false, implemented: false, note: '会往网盘写文件（延期领取那一口已经接了，这是它的另一部分）' },
  { name: 'ai-avatar', title: 'AI 头像生成与抽奖', group: 'cloud-write', kind: 'Action', risk: 'write-cloud', missed: 'skip', deps: ['basic+jwt'], batch: false, hidden: false, implemented: false, note: '往网盘写图 —— 原实现里默认就是**关**的' },

  // ── 高风险（未实现）──
  { name: 'exchange', title: '兑换奖品', group: 'risky', kind: 'Action', risk: 'spend', missed: 'skip', deps: ['jwt', 'slider'], batch: false, hidden: true, implemented: false, note: '**真扣 AI豆、不可回滚**，还要过滑块 —— 上游没有幂等，本插件里必须默认关 + 二次确认' },
  { name: 'auth-refresh', title: '刷新 auth 凭据', group: 'risky', kind: 'Action', risk: 'irreversible', missed: 'catch-up', deps: ['basic+jwt'], batch: false, hidden: true, implemented: false, note: '换 token —— 唯一不需要 jwt 的写操作' },
];

/** 一条任务在界面上的完整一行：静态元信息 + **运行时的实际状态**。 */
export interface TaskRow extends TaskMeta {
  /** 最近一次失败原因（'' = 没有） */
  lastError: string;
  /** 最近几次触发的记录 */
  recent: { firedAt: string; ok: boolean; note: string; lateMs: number }[];
}

export interface GroupRow extends GroupMeta {
  tasks: TaskRow[];
  implemented: number;
  total: number;
}

/** 组装给界面/脚本用的分组视图。
 *
 *  ⚠️ 这里**不编造**：`next_run` 之类只有面板知道的东西不在这里（面板的 `/api/state`
 *  里有），界面需要就自己 join。插件只说插件自己知道的事 —— 状态表里的失败原因、
 *  runs 表里的最近记录。 */
export function groupView(store: Store): { groups: GroupRow[]; totals: Record<string, number> } {
  const recent = store.recentRuns(200);
  const byTask = new Map<string, { firedAt: string; ok: boolean; note: string; lateMs: number }[]>();
  for (const r of recent) {
    const t = String(r.task ?? '');
    if (!t) continue;
    const list = byTask.get(t) ?? [];
    if (list.length < 3) {
      list.push({
        firedAt: String(r.fired_at ?? ''),
        ok: Number(r.ok ?? 0) === 1,
        note: String(r.note ?? ''),
        lateMs: Number(r.late_ms ?? 0),
      });
    }
    byTask.set(t, list);
  }

  const groups: GroupRow[] = GROUPS.map((g) => {
    const tasks = TASK_META.filter((t) => t.group === g.id).map((t) => ({
      ...t,
      lastError: store.getState(`mcloud.last_error.${t.name}`) ?? '',
      recent: byTask.get(t.name) ?? [],
    }));
    return {
      ...g,
      tasks,
      implemented: tasks.filter((t) => t.implemented).length,
      total: tasks.length,
    };
  });

  return {
    groups,
    totals: {
      tasks: TASK_META.length,
      implemented: TASK_META.filter((t) => t.implemented).length,
      risky: TASK_META.filter((t) => t.risk === 'spend' || t.risk === 'irreversible').length,
    },
  };
}
