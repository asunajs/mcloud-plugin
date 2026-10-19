// 状态键的**作用域登记表** —— 全插件唯一一处说"这个键属于谁"的地方。
//
// # 为什么要有这张表
//
// 原来所有状态键都在**一个扁平命名空间**里，而"这个键是不是属于某个账号"
// 只存在于**每个调用点的脑子里**。于是多账号下出了一串同类 bug：
//
//   · `mcloud.session` 全局 ⇒ 账号 B 换票覆盖 A 的票 ⇒ **A 的请求带 B 的票**
//   · `mcloud.daily.done_date` 全局 ⇒ A 跑完落标记 ⇒ **B 的日常整个被跳过**
//
// 它们都**只在"一趟跑两个账号"时才出现**，单账号测不出来 —— 所以能活很久。
//
// # 参考实现怎么做的（`mcloud-core/src/traits.rs`）
//
// ```rust
// /// 读取账号运行期状态（deviceId、jwtToken 缓存等）。
// async fn account_state(&self, id: &AccountId) -> Result<serde_json::Value>;
// async fn save_account_state(&self, id: &AccountId, state: &serde_json::Value) -> Result<()>;
// ```
//
// **账号的全部运行时状态是一个 blob，而且 API 强制你传账号 id** ——
// "忘了分账号"在结构上不可能发生：你没法在不指名账号的情况下读状态。
//
// `mcloud-tasks/src/task_expansion.rs` 里那句注释说的就是本文件要防的东西：
//
// > 落在 `ctx.store.account_state(&ctx.account.id)` 上 —— **按账号 id** 存的一份状态；
// > **绝不做成进程级全局**，那会让 A 账号的"没备份"把 B 账号的 month 任务一起跳掉。
//
// 宿主只给扁平的 `getState/setState`，所以这里照它的**形状**做：
// 一个账号一个袋（`mcloud.acct.<账号 id>`），袋里是这个账号的全部运行时状态。
//
// # 三条纪律
//
// 1. **每个键都必须登记**。没登记的键 `routeGet`/`routeSet` 会**报错**，
//    不是静默当全局 —— 静默当全局正是上面那些 bug 的成因。
//    另有一条测试扫源码里出现的所有 `mcloud.*` 键，漏登记的会红。
//
// 2. **不许有"没有作用域"的路径**。即使一个账号都没有（单账号那套），
//    也走 `mcloud.acct.default` 这个袋 —— 而不是裸键。裸键等于"全局"，
//    而"全局"就是那些 bug。
//
// 3. **判据是一句话**：
//
//    > 账号 A 写进去之后，账号 B 读到它会不会做出**错的**决定？
//
//    · `mcloud.session`（票）—— 会（B 以 A 的身份发请求）⇒ account
//    · `mcloud.daily.done_date`（今天跑完了吗）—— 会（B 被**跳过**）⇒ account
//    · `mcloud.exchange.target_hour`（几点抢兑）—— 不会（是**配置**）⇒ global
//
// 4. **说不清楚就保持原行为**。改写这一层时容易犯的错是"顺手把能想到的都改成
//    按账号" —— 但那些键**原来就是扁平的**，改成按账号是**改变行为**：
//    典型表现是"登录一次之后，另一个账号名下也看不到这台机器"。
//    只有**明确能说出"这是某个账号的状态"**的键才登记成 `account`。

import type { ReadableState, WritableState } from './keys-types.ts';

export type { ReadableState, WritableState };

/** 一个键属于谁。 */
export type KeyScope =
  /** **账号运行期状态**：跟着账号走，换账号就该换一份。 */
  | 'account'
  /** **实例级配置 / 跨账号共享**：与"现在是谁"无关。 */
  | 'global';

/** 没有账号时的袋名。
 *
 *  ⚠ **不是"裸键"**：单账号那套也装在一个袋里。理由见文件头第 2 条 ——
 *  留一条"没有作用域"的路径，就等于留一条回到全局键的路。 */
export const DEFAULT_ACCT = 'default';

/** 本插件的命名空间。**只有**这个前缀下的键归登记表管。 */
export const PLUGIN_NS = 'mcloud.';

/** 账号袋的物理键前缀。 */
export const ACCT_PREFIX = 'mcloud.acct.';

/** "当前选中哪个账号"的键。
 *
 *  ⚠ 它**定义在这里**，而不是 `mcloud/accounts.ts` —— 因为 {@link acctIdOf}
 *  要用它，而 `acctIdOf` 被 `routeGet`/`routeSet` 调用。
 *
 *  如果键名定义在 `accounts.ts`、`keys.ts` 去 import 它，就会形成
 *  `keys.ts` → `accounts.ts` → `keys.ts` 的**运行时循环**
 *  （`accounts.ts` 要用会话那层）。ESM 对函数声明能靠提升兜住，但那是运气，
 *  不是设计。把键名放在低层（键登记表）就没有这个问题，而且
 *  「键名归键登记表所有」本来就该是这样。 */
export const STATE_CURRENT_ACCOUNT = 'mcloud.account.current';

/** 账号表的键。同上，放这里是为了让 `keys.ts` 不依赖 `accounts.ts`。 */
export const STATE_ACCOUNTS = 'mcloud.accounts';

/** 键 → 作用域。**唯一事实来源**（见文件头第 1 条）。 */
export const KEY_SCOPE: Readonly<Record<string, KeyScope>> = {
  // ── 账号运行期状态 ──────────────────────────────────────────
  'mcloud.session': 'account',
  'mcloud.session.last_check': 'account',
  'mcloud.h5.auth': 'account',
  // 宿主"能不能用 tls:native"的探测结论（= 这个面板构建支不支持直播）。
  // **与账号无关**，但按账号存最省事 —— 结论一样，多存几份不花钱。
  'mcloud.host.native_tls': 'account',
  'mcloud.h5.exchange': 'account',
  'mcloud.h5.jwt': 'account',
  'mcloud.daily.done_date': 'account',
  'mcloud.daily.last_run': 'account',
  // ⚠ 登录这一族是**本机**的，不是某个账号的。
  //
  //   · `deviceId` —— 本机设备指纹。参考实现（`accounts-page.tsx`）的原话：
  //     「扫码时它作为 `dID` 上报，服务端据此定位会话。它**跨重启稳定**；
  //      换掉会让旧的扫码会话立即失效，但已登录账号不受影响。」
  //     ⇒ 它是"这台机器长什么样"，写在**账号**名下是错的。
  //   · `qr` / `sms` —— "我正在进行的那次登录"（还没变成账号）。
  //   · `base` / `userDomainId` —— 登录服下发的主机，同样是本机的。
  //
  //   ⚠ 这几格**原来就是扁平的全局键**。把它们改成按账号是**我的改动**，不是原行为
  //   —— 而"语义说不清楚时保持原行为"才是对的。见下面那段纪律。
  'mcloud.login.deviceId': 'global',
  'mcloud.login.qr': 'global',
  'mcloud.login.sms': 'global',
  // 手机端（App 链路）那次登录。与 `sms` **分开存**：两端的滑块语义不同
  //（PC 取图自己解、App 真机是开 WebView），共用一格会让"进行中的是哪一端"
  // 变成要靠猜。
  'mcloud.login.app': 'global',
  // 每条任务跑哪些账号。**global** —— 它说的是这条任务用哪些号，
  // 不是某个号自己的设置（放进账号袋会让 A 的名单被 B 读到）。
  // ⚠ 动态键（键里带任务名）⇒ 靠  登记，见下面那张表。
  'mcloud.task.accounts.': 'global',
  // 运行日志的**环形副本**（最近 N 行）。global —— 它记的是"这台机器上发生过什么"，
  // 不属于某个号；而且它要能在**面板重启之后**还读得到（面板的内存日志环是重启就没的，
  // 见 findings F-085）。写的时候按"全局"落，界面上再按插件名过滤。
  'mcloud.log.ring': 'global',
  'mcloud.login.base': 'global',
  'mcloud.login.userDomainId': 'global',
  'mcloud.sign.stage': 'account',
  'mcloud.sign.last': 'account',
  'mcloud.upload.state': 'account',
  'mcloud.taskexpansion.state': 'account',
  'mcloud.apptask.state': 'account',
  'mcloud.apptaskmatrix.last': 'account',
  'mcloud.apptaskmatrix.group_index': 'account',
  'mcloud.notice.can_claim': 'account',
  'mcloud.notice.info': 'account',
  'mcloud.backupgift.can_receive': 'account',
  'mcloud.backupgift.info': 'account',
  'mcloud.msgpush.can': 'account',
  'mcloud.msgpush.last': 'account',
  'mcloud.prizes.last': 'account',
  'mcloud.multiple.last': 'account',
  'mcloud.revival.last': 'account',
  'mcloud.receive.last': 'account',
  'mcloud.receive.queue': 'account',
  'mcloud.cloudsnapshot.last': 'account',
  'mcloud.exchangelist.last': 'account',
  'mcloud.exchangelist.raw': 'account',
  // 界面上「选一件」的下拉缓存（全量清单里挑出来的四格）。
  // **按账号** —— 清单与"能不能换"都是账号级的。日界作废，见 exchangeList.ts。
  'mcloud.exchangelist.pick': 'account',
  // 「我关注的奖品」：按账号存（不同账号的清单不同，关注的 id 也可能不同）。
  'mcloud.exchange.subs': 'account',
  'mcloud.exchange.plan': 'account',
  // 定时抢兑每个账号已经真正发起过几次（按账号）。
  'mcloud.exchange.schedule.runs': 'account',
  'mcloud.exchange.schedule.runs_gen': 'account',
  'mcloud.exchange.order.step': 'account',
  'mcloud.exchange.order.baseline': 'account',
  'mcloud.exchange.order.plan': 'account',
  'mcloud.exchange.order.round': 'account',
  'mcloud.exchange.order.ordered_hour': 'account',
  'mcloud.exchange.order.last_wait': 'account',
  'mcloud.live.gate': 'account',
  'mcloud.live.gate.reading': 'account',
  'mcloud.live.gate_base': 'account',
  'mcloud.live.reading': 'account',
  'mcloud.live.draw': 'account',
  'mcloud.live.codes': 'account',
  'mcloud.live.listen': 'account',
  'mcloud.live.listen_room': 'account',
  'mcloud.live.listen_seconds': 'account',
  'mcloud.live.url': 'account',
  'mcloud.live.wake_plan': 'account',
  'mcloud.live.ws_base': 'account',
  'mcloud.live.ws_heartbeat_reply': 'account',
  'mcloud.live.im_base': 'account',
  'mcloud.smid.deviceId': 'account',
  'mcloud.smid.fingerprint': 'account',
  'mcloud.auth.refresh.last': 'account',

  // ── 实例级配置 / 跨账号共享 ────────────────────────────────
  /** 账号表本身。 */
  'mcloud.accounts': 'global',
  /** "当前选中哪个账号"。⚠ 它是**选择**，不是某个账号的状态。 */
  'mcloud.account.current': 'global',
  /** 上游域名。 */
  'mcloud.base_url': 'global',
  /** 登录方式偏好（扫码 / 短信 / 账密）。 */
  'mcloud.login.pref': 'global',
  /** 几点抢兑 —— 是**配置**，跟账号无关。 */
  'mcloud.exchange.target_hour': 'global',
  // 「定时抢兑」的目标：与手动目标分开，避免改一个把另一个带跑。
  // 全局 —— 定时任务按「任务账号」逐个跑，但只认这一件目标。
  'mcloud.exchange.schedule.plan': 'global',
  'mcloud.exchange.schedule.mode': 'global',
  'mcloud.exchange.schedule.cron': 'global',
  'mcloud.exchange.schedule.until': 'global',
  'mcloud.exchange.schedule.once_date': 'global',
  'mcloud.exchange.schedule.max_runs': 'global',
  'mcloud.exchange.schedule.gen': 'global',
  'mcloud.exchange.schedule.plan_name': 'global',
  'mcloud.exchange.schedule.enabled': 'global',
  'mcloud.exchange.lead_sec': 'global',
  /** 提前量 —— "网络慢的人该调大"，是**这台机器**的调参，与账号无关。 */
  'mcloud.exchange.order.lead_ms': 'global',
  /** 领小红花的开关。 */
  'mcloud.live.claim_enabled': 'global',
  /** 推送配置（渠道 / 规则 / 事件绑到哪个渠道）。 */
  'mcloud.push.config': 'global',
  'mcloud.push.rules': 'global',
  'mcloud.push.bindings': 'global',
  /** ⚠ 共享口令池 —— 参考实现明写"实例级：跨 mcloud 用户、跨重启"。 */
  'mcloud.kouling.pool': 'global',
  /** 运行日志（每条记录里自己带账号）。 */
  'mcloud.run.log': 'global',
  /** 任务清单缓存。 */
  'mcloud.tasklist.last': 'global',
};

/** **前缀式**的键（末尾带点，如 `mcloud.last_error.` + 任务名）。
 *
 *  单独一张表是因为它们不是完整键名 —— 拼出来才知道是哪个。
 *  ⚠ 查表要**最长前缀优先**（将来出现 `mcloud.a.b.` 与 `mcloud.a.` 两个前缀时，
 *  短的那个会抢走本该属于长的键）。 */
export const KEY_PREFIX_SCOPE: readonly (readonly [string, KeyScope])[] = [
  // 每条任务"跑哪些账号"（`mcloud.task.accounts.日常`）—— 键里带任务名，
  // 静态扫描扫不到整串，所以按前缀登记。⚠ **global**：它说的是"这条任务用哪些号"，
  // 不是"某个号自己的设置"。
  ['mcloud.task.accounts.', 'global'],
  ['mcloud.last_error.', 'account'],
  // 票与换票进度：**按配方**分（`mcloud.h5.jwt.sign-in` / `.msg-push-on`）。
  // ⚠ 账号那一维由 `scoped()` 加（袋名），所以这里只剩配方这一段。
  //   两个维度都必要：不分账号会串身份，不分配方会用错页面的票。
  ['mcloud.h5.jwt.', 'account'],
  ['mcloud.h5.exchange.', 'account'],
  // 矩阵按**市场**分（`mcloud.apptaskmatrix.g.sign_in_3`）—— 动态拼出来的，
  // 静态扫描扫不到整串，所以按前缀登记。
  ['mcloud.apptaskmatrix.g.', 'account'],
];

/** 查一个**完整**键名的作用域。没登记 ⇒ `undefined`（调用方必须报错，不许当全局）。 */
export function scopeOf(key: string): KeyScope | undefined {
  const exact = KEY_SCOPE[key];
  if (exact !== undefined) return exact;
  // 最长前缀优先
  let best: { len: number; scope: KeyScope } | undefined;
  for (const [prefix, scope] of KEY_PREFIX_SCOPE) {
    if (key.startsWith(prefix) && (best === undefined || prefix.length > best.len)) {
      best = { len: prefix.length, scope };
    }
  }
  return best?.scope;
}

// ══════════════════════════ 账号袋 ══════════════════════════

/** 当前账号的袋名。没有账号 ⇒ {@link DEFAULT_ACCT}（**不是**裸键）。
 *
 *  ⚠ 直接读那一格，**不**走 `currentAccount()` —— 后者还要去账号表里找这个 id
 *  在不在（会引入循环依赖，见 {@link STATE_CURRENT_ACCOUNT}）。
 *  "当前 id 指向一个已删掉的账号"由 `removeAccount` 负责清（它已经会清）。 */
export function acctIdOf(store: ReadableState, override?: string): string {
  // ⚠ `override` 是给"**操作指定账号**"用的（按账号刷新凭据那类动作）。
  //   没有它的话，这类动作只能"先切过去再刷"—— 那会**改掉用户当前选中的账号**，
  //   而用户只是想让另一个号刷新一下。
  if (override !== undefined && override !== '') return override;
  const id = (store.getState(STATE_CURRENT_ACCOUNT) ?? '').trim();
  return id === '' ? DEFAULT_ACCT : id;
}

/** 袋的物理键。 */
export function acctBagKey(acctId: string): string {
  return `${ACCT_PREFIX}${acctId}`;
}

/** 读一个账号的整个袋。
 *
 *  ⚠ 坏 JSON 当**空袋**（不是抛）：袋里可能被手改过，而"抛"会让整个插件
 *  在加载时炸掉 —— 代价远大于"这个账号的状态丢了"（任务会重跑一遍）。 */
export function readBag(store: ReadableState, acctId: string): Record<string, string> {
  const raw = store.getState(acctBagKey(acctId));
  if (raw === undefined || raw === null || raw === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function writeBag(store: WritableState, acctId: string, bag: Record<string, string>, nowIso: string): void {
  store.setState(acctBagKey(acctId), JSON.stringify(bag), nowIso);
}

/** 删掉一个账号的整个袋 —— **删账号时必须调**。
 *
 *  ⚠ 这是账号袋相对"扁平键加前缀"最实在的一个好处：扁平键是散落的，
 *  删账号根本清不干净（会留下 `mcloud.session.<id>`、`mcloud.live.*.<id>`…
 *  一堆孤儿键，而且**看不出是孤儿**）。袋是一个键，删一个就是删全部。 */
export function clearBag(store: WritableState, acctId: string, nowIso: string): void {
  store.setState(acctBagKey(acctId), '', nowIso);
}

// ══════════════════════════ 读写 ══════════════════════════

/** 键没登记时抛这个 —— 消息里要带上键名，否则只能靠猜。 */
export class UnregisteredKeyError extends Error {
  constructor(key: string) {
    super(
      `状态键「${key}」没有在 store/keys.ts 的 KEY_SCOPE 里登记。\n` +
        `⚠ 不许默认当成全局键 —— 那正是多账号串号那一串 bug 的成因（见该文件头）。\n` +
        `判据：账号 A 写进去之后，账号 B 读到它会不会做出**错的**决定？会 ⇒ 'account'。`,
    );
    this.name = 'UnregisteredKeyError';
  }
}

/** 读一个状态键。
 *
 *  · 登记为 `'account'` ⇒ 从**当前账号的袋**里读那个字段
 *  · 登记为 `'global'` ⇒ 读扁平键（原样）
 *  · **没登记** ⇒ 抛（见文件头第 1 条）
 *
 *  ⚠ 返回值与 `store.getState` 一致（`string | null`），所以这是**纯键改写**的迁移，
 *  调用点的判空/判 `''` 逻辑一行都不用动。 */
export function routeGet(store: ReadableState, key: string, acctId?: string): string | null {
  // ⚠ 袋自己的**物理**键：直接透传，不走登记表。
  //
  //   它不是逻辑键（没有"作用域"这回事 —— 它**就是**那个容器）。
  //   不透传的话，`clearBag` / `readBag` 这些"操作容器本身"的函数
  //   会去查登记表然后抛错 —— 而那正是它们该做的事。
  if (key.startsWith(ACCT_PREFIX)) return store.getState(key) ?? null;
  // ⚠ **宿主自己的键透传**（`plugin.loaded_at` 这种）。
  //   面板的 host-api 也用同一张表，但那些键不归我们管 ——
  //   拦下来会让**插件加载直接失败**（第一次跑就这么炸了一次）。
  //   边界：只有 `mcloud.` 这个命名空间下的键才查登记表。
  if (!key.startsWith(PLUGIN_NS)) return store.getState(key) ?? null;
  const scope = scopeOf(key);
  if (scope === undefined) throw new UnregisteredKeyError(key);
  if (scope === 'global') return store.getState(key) ?? null;
  const bag = readBag(store, acctIdOf(store, acctId));
  return bag[key] ?? null;
}

/** 写一个状态键。作用域语义同 {@link routeGet}。
 *
 *  ⚠ `'account'` 那支是**读-改-写整个袋**：袋里躺着这个账号**所有任务**的键
 *  （`deviceId` / `session` / `daily.done_date` …），只写一个字段会**把别人抹掉**。
 *  参考实现 `save_share_done_day` 同样是读-改-写，注释里点明了这个坑：
 *  「这张表里还躺着 `device_id` / `pc_platform` / `cur_month_backup` 这些别的任务的键」。 */
export function routeSet(
  store: WritableState,
  key: string,
  value: string,
  nowIso: string,
  acctId?: string,
): void {
  // 同上：袋的物理键直接透传（见 `routeGet` 那段说明）。
  if (key.startsWith(ACCT_PREFIX)) {
    store.setState(key, value, nowIso);
    return;
  }
  // 宿主自己的键透传（同 `routeGet`）
  if (!key.startsWith(PLUGIN_NS)) {
    store.setState(key, value, nowIso);
    return;
  }
  const scope = scopeOf(key);
  if (scope === undefined) throw new UnregisteredKeyError(key);
  if (scope === 'global') {
    store.setState(key, value, nowIso);
    return;
  }
  const acct = acctIdOf(store, acctId);
  const bag = readBag(store, acct);
  // ⚠ 空串**照存**，不删字段。
  //
  //   "写空串 = 删字段"看着更干净，但它**改了行为**：老的扁平键写 `''` 之后
  //   读回来是 `''`，删字段之后读回来是 `null` —— 而两者的判断在调用点截然不同
  //   （`x === ''` 与 `x === null` 不通用）。迁移的第一要求是**行为不变**，
  //   不是"顺便更干净"。袋里多几个空串字段的代价可以忽略。
  bag[key] = value;
  writeBag(store, acct, bag, nowIso);
}

/** 把一个账号的**旧扁平键**搬进它的袋（一次性迁移，幂等）。
 *
 *  # 为什么必须有
 *
 *  迁移前所有键都是扁平的。直接改成读袋 ⇒ **老用户的状态全读不到**：
 *  票"没了"（要重换）、`daily.done_date` 没了（今天重跑一遍）、
 *  `ordered_hour` 没了（**可能重复下单** —— 而抢兑不可逆）。
 *
 *  # 做法
 *
 *  对每一个登记为 `'account'` 的键：如果袋里没有、而扁平键里有 ⇒ 搬过去
 *  并**清掉扁平键**（留着的话下次还会搬，而且"袋里没有"这个判断会被误导）。
 *
 *  ⚠ 只搬**当前账号**那一份。多个账号的老数据搬不了（迁移前它们本来就
 *  共用一格，分不出谁是谁）—— 这一点如实写在返回值里。 */
export function migrateFlatKeys(store: WritableState, nowIso: string): { moved: string[] } {
  const acctId = acctIdOf(store);
  const bag = readBag(store, acctId);
  const moved: string[] = [];
  for (const [key, scope] of Object.entries(KEY_SCOPE)) {
    if (scope !== 'account') continue;
    const flat = store.getState(key);
    if (flat === undefined || flat === null || flat === '') continue;
    if (bag[key] === undefined) {
      bag[key] = flat;
      moved.push(key);
    }
    store.setState(key, '', nowIso);
  }
  if (moved.length > 0) writeBag(store, acctId, bag, nowIso);
  return { moved };
}
