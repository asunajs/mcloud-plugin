// 多账号：账号列表 + "当前用哪一个"。
//
// # 为什么要有这一层
//
// mcloud 是**账号列表**（一条定时带着它要跑的账号），而这个插件到现在都是**单账号**：
// 一份凭据放在 `mcloud.h5.auth` 那一格里，所有任务直接读它。
//
// ⇒ 这一层补"列表 + 当前账号"，并且保证**旧的单凭据照原样工作**：
//   `loadAuthRaw`（在 sessionExchange.ts，见那里的注释）优先取列表里的当前账号，
//   列表为空就回落到那一格。这样**任何调用点都不用知道现在是单账号还是多账号** ——
//   迁移是一格一格来的，不是一次性翻掉。
//
// ⚠ 凭据是**秘密**：这个模块只负责存取，**不许**把它写进日志/读数/界面
//   （要给界面看的一律走 `maskAuth`）。

import { STATE_ACCOUNTS, STATE_CURRENT_ACCOUNT, clearBag } from '../store/keys.ts';

import { PC_AUTH_PREFIX, parseAuth, type PcPlatform } from './auth.ts';
import { fromBase64, fromUtf8 } from '../crypto/bytes.ts';
import type { Store } from '../store/types.ts';

// ⚠ 键名**定义在** `store/keys.ts`（键名归键登记表所有，见那里的说明），
//   这里只是转出给老的调用方。所以是 import + export，不是纯 re-export ——
//   纯转出的话名字不进本地作用域，本文件自己那几处用不了。
export { STATE_ACCOUNTS, STATE_CURRENT_ACCOUNT };
/** 当前用哪一个（存 `id`）。没设过 = 用 `mcloud.h5.auth` 那一格（单账号那套）。 */


export type Account = {
  /** 稳定的短标识：能从凭据里认出手机号就用手机号，否则用凭据的短哈希。 */
  id: string;
  /** 给人看的名字（手机号或 `账号 N`）。 */
  label: string;
  /** 原始凭据（`Authorization` 那一串）。**不许**进日志/界面。 */
  auth: string;
  /** 凭据里那段平台：`pc` 或 `mobile`（从 `auth` 里解出来的）。
   *
   *  ⚠ **可能为空**：上游有缺段的样本，而"报错"会让一条能用但信息不全的凭据
   *  变成不可用 —— 所以缺段留空串。判平台要**显式比对前缀**，不能靠"非空"。
   *  见 `mcloud/auth.ts` 的 `parseAuth` / `isPcAuth`。 */
  platform: string;
  /** **只对 `pc` 有意义**：是 Windows 还是 macOS。
   *
   *  # 为什么它必须单独存
   *
   *  凭据里那一格恒是字面量 `pc`（Windows 与 macOS 都是它，客户端源码里
   *  就是 `pc`，不是平台号）⇒ **光看凭据分不出平台**。而它决定后续每一次
   *  请求的 UA 与设备头 —— 选错的话这个账号以后一直用错的身份发请求。
   *
   *  参考实现里也是单独一格（`Account::pc_platform`）。
   *  `platform === 'mobile'` 时这一格**没有意义**（手机端不存在 win/mac 之分）。 */
  pcPlatform?: PcPlatform | undefined;
  /** 这个账号的**用户域**（`userInfo.userDomainId`，登录响应里才有）。
   *
   *  # 为什么必须在账号上，而不是全局一格
   *
   *  它回答的是"**这个账号**属于哪个用户域"——是**每个账号**的事实。原来存在
   *  全局一格 `mcloud.login.userDomainId` 里，换账号登录一次就把上一号的域盖掉，
   *  于是"当前账号的域"和"库里那一格"会悄悄不一致（而它决定 `x-yun-uni`）。
   *
   *  参考实现就是账号级：`Account::user_domain_id`。
   *
   *  ⚠ **可能没有**：贴凭据进来的账号拿不到它（凭据里没有这一格），
   *  而这**不影响续期** —— 上游不要求（见 F-075）。 */
  userDomainId?: string | undefined;
  /** **停用**：停用的账号不参与任务（但仍留在列表里）。
   *
   *  ⚠ 与"删掉"不是一回事：删掉会连它的状态袋一起清（见 `removeAccount`），
   *  而停用**保留**状态 —— 重新启用时票、进度、`ordered_hour` 都还在。
   *  所以不能用"删掉再重加"来模拟停用。 */
  disabled?: boolean | undefined;
  addedAt: string;
};

/** 只给界面看的一眼认得出的形状：`1****2716 · 302 字符`。 */
export function maskAuth(raw: string): string {
  const phone = phoneOf(raw);
  const len = raw.length;
  if (phone !== undefined) return `${phone.slice(0, 1)}****${phone.slice(-4)} · ${len} 字符`;
  return `（认不出手机号）· ${len} 字符`;
}

/** 从凭据里抠手机号（认不出就 `undefined`）。
 *
 *  # 为什么要试两种形态
 *
 *  两种凭据里手机号的**位置不同**：
 *
 *  | 来源 | 形态 | 手机号在哪 |
 *  |---|---|---|
 *  | H5 换票 | 一段带着明文手机号的串 | **明文**，正则直接扫得到 |
 *  | PC 登录（扫码/短信/账密） | `Basic base64("pc:<手机号>:<token>")` | 在 **base64 里面** |
 *
 *  只扫明文的话，PC 登录进来的账号会认不出手机号 ⇒ 标签变成「账号 1」，
 *  而且更糟的是 **id 会变成 token 的哈希** —— token 每次登录都变，
 *  于是**同一个号每登录一次就多出一条重复账号**。
 *
 *  所以这里再试一次"解 base64 之后扫"。解不开就当认不出（不抛）。 */
export function phoneOf(raw: string): string | undefined {
  const plain = /1\d{10}/.exec(raw);
  if (plain !== null) return plain[0];

  // `Basic <base64>`（大小写都认，中间空白容忍）
  const m = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(raw);
  if (m === null) return undefined;
  try {
    const decoded = fromUtf8(fromBase64(m[1]!));
    const inB64 = /1\d{10}/.exec(decoded);
    return inB64 === null ? undefined : inB64[0];
  } catch {
    // 不是合法 base64 ⇒ 认不出（不抛：这个函数只用来做标签与 id）
    return undefined;
  }
}

/** 稳定 id：手机号优先（人能对上），否则凭据的短哈希。 */
/** 落库前**归一**成一串能直接当 `Authorization` 用的东西（**带 `Basic `**）。
 *
 *  ⚠ 用户从别处（mcloud、抓包、笔记）把凭据贴进来时，**经常没有 `Basic ` 前缀** ——
 *  而这一格是原样当请求头发出去的。少了前缀的表现是上游回
 *  `05050009 非法的token！`，一句**指向"凭据过期"的假线索**（真因是格式）。
 *  更隐蔽的是 `phoneOf` 认不出手机号 ⇒ 账号 id 变成 `anon-xxxx`（与真实手机号脱钩）。
 *
 *  `parseAuth` 本来就容忍缺前缀并会补回来（它的 `raw` 是归一后的形状）——
 *  这里只是把"归一"这件事**放到落库这一处**，而不是指望每个调用点都记得。 */
export function normalizeAuth(raw: string): string {
  // ⚠ 不直接调 `parseAuth`：它只认字面量 `'Basic '`（一个空格），
  //   而真实粘贴里见过 `basic   `（多空格）、`Basic\n`、外层带引号这几种。
  const t = raw.replace(/\uFEFF/g, '').trim();
  // ⚠ 这里**不能**用带引号的正则（`/^(['"])…/`）：面板扫描 `worker_hint('exclusive')`
  //   时用一个很朴素的状态机剥字符串/注释（`workers.rs::code_mask`），正则字面量里的
  //   引号会把它的状态带歪 ⇒ 从那以后整段代码都被当成"字符串"，插件声明了独占也
  //   扫不到 ⇒ 每次加载都报一句假警告（见 findings F-080）。
  //   所以用 `charAt` 手写"去外层引号"，语义一样，扫的时候不添乱。
  const head = t.charAt(0);
  const unquoted =
    t.length >= 2 && (head === '"' || head === "'") && t.charAt(t.length - 1) === head
      ? t.slice(1, -1).trim()
      : t;
  const m = /^basic[\s:]+([\s\S]+)$/i.exec(unquoted);
  const b64 = (m !== null ? m[1]! : unquoted).replace(/\s+/g, '');
  if (b64 === '') return unquoted;
  // 只认"解出来是三段"的那种 —— 解不开就原样留着，不替用户猜
  const info = parseAuth(b64);
  return info !== undefined && info.raw !== '' ? `Basic ${b64}` : unquoted;
}

export function idOf(raw: string): string {
  const phone = phoneOf(raw);
  if (phone !== undefined) return phone;
  // ⚠ 只用它做标识，不做安全用途：碰撞概率够低即可（真撞了也只是"列表里认错一个"）。
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `anon-${(h >>> 0).toString(36)}`;
}

export function loadAccounts(store: Pick<Store, 'getState'>): Account[] {
  const raw = store.getState(STATE_ACCOUNTS);
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ⚠ 坏数据当成"没有列表"：**不要**在这里抛 —— 抛出去会让每个任务都挂掉，
    //   而真正该发生的是"回落到单账号那格"（用户还能用）。
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Account[] = [];
  for (const it of parsed) {
    if (it === null || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.auth !== 'string' || o.auth === '') continue;
    // ⚠ 顺手归一：老库里可能存着"没有 `Basic ` 前缀"的那一串（贴进来时就没带），
    //   而它会被原样当请求头发出去 ⇒ 上游回 `05050009`。这里归一**不改 id**
    //   （改了 id 会连累账号袋与"当前账号"），只把那一格修正过来。
    const auth = normalizeAuth(o.auth);
    const info = parseAuth(auth);
    const pc = o.pcPlatform;
    out.push({
      id: o.id,
      label: typeof o.label === 'string' && o.label !== '' ? o.label : o.id,
      auth,
      // 老账号没存过这两格 ⇒ 从凭据里现解一次（不用迁移）
      platform: typeof o.platform === 'string' ? o.platform : (info?.platform ?? ''),
      pcPlatform: pc === 'win' || pc === 'mac' ? pc : undefined,
      userDomainId:
        typeof o.userDomainId === 'string' && o.userDomainId !== '' ? o.userDomainId : undefined,
      disabled: o.disabled === true,
      addedAt: typeof o.addedAt === 'string' ? o.addedAt : '',
    });
  }
  return out;
}

export function saveAccounts(store: Store, list: readonly Account[], nowIso: string): void {
  store.setState(STATE_ACCOUNTS, JSON.stringify(list), nowIso);
}

/** 加一个账号（同一个人再加一次 = **更新**那份凭据，不新增一条）。 */
export function upsertAccount(
  store: Store,
  authInput: string,
  nowIso: string,
  label?: string,
  pcPlatform?: PcPlatform,
  /** 登录响应里的 `userDomainId`。**不传 = 保留原来那份**（贴凭据那条路没有它，
   *  不能因此把已有的域抹掉）。 */
  userDomainId?: string,
): { list: Account[]; account: Account; created: boolean } {
  let auth = authInput;
  const list = loadAccounts(store);
  // ⚠ 先归一（补 `Basic ` 前缀），再算 id —— 否则贴进来"缺前缀"的那串会拿到
  //   `anon-xxxx` 的 id，与真实手机号那条并存（同一个号两条记录）。
  auth = normalizeAuth(auth);
  const id = idOf(auth);
  // 老行可能还挂着 `anon-xxxx` 的 id：按"归一之后的 id"再找一遍，避免重复
  const idx = list.findIndex((a) => a.id === id || idOf(normalizeAuth(a.auth)) === id);
  const info = parseAuth(auth);
  const account: Account = {
    id,
    label: label !== undefined && label !== '' ? label : (phoneOf(auth) ?? `账号 ${list.length + 1}`),
    auth,
    platform: info?.platform ?? '',
    // ⚠ 只在 PC 端才有意义。手机端传进来也丢掉 —— 留着会让"这个账号用哪套
    //   设备头"这件事出现两个互相矛盾的来源。
    pcPlatform: info?.platform === PC_AUTH_PREFIX ? (pcPlatform ?? list[idx]?.pcPlatform ?? 'win') : undefined,
    // ⚠ 重加同一个号时**保留**用户域（贴凭据/换凭据那条路拿不到它）
    userDomainId:
      userDomainId !== undefined && userDomainId !== ''
        ? userDomainId
        : list[idx]?.userDomainId,
    // ⚠ 重加同一个号时**保留**停用状态（"刷新凭据"不该顺手把人启用回来）
    disabled: list[idx]?.disabled === true,
    addedAt: idx >= 0 ? list[idx]!.addedAt : nowIso,
  };
  if (idx >= 0) list[idx] = account;
  else list.push(account);
  saveAccounts(store, list, nowIso);
  return { list, account, created: idx < 0 };
}

/** 停用 / 启用。返回改完之后的那一条（找不到 ⇒ `undefined`）。 */
export function setAccountDisabled(
  store: Store,
  id: string,
  disabled: boolean,
  nowIso: string,
): Account | undefined {
  const list = loadAccounts(store);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  list[idx] = { ...list[idx]!, disabled };
  saveAccounts(store, list, nowIso);
  return list[idx];
}

/** 改昵称。空串 = 回落成手机号（与参考实现的 PATCH 语义一致）。 */
export function setAccountLabel(
  store: Store,
  id: string,
  label: string,
  nowIso: string,
): Account | undefined {
  const list = loadAccounts(store);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  const auth = list[idx]!.auth;
  list[idx] = {
    ...list[idx]!,
    label: label.trim() !== '' ? label.trim() : (phoneOf(auth) ?? `账号 ${idx + 1}`),
  };
  saveAccounts(store, list, nowIso);
  return list[idx];
}

/** 这个账号现在能不能跑（没被停用）。 */
export function isAccountEnabled(store: Pick<Store, 'getState'>): boolean {
  return currentAccount(store)?.disabled !== true;
}

export function removeAccount(store: Store, id: string, nowIso: string): Account[] {
  const list = loadAccounts(store).filter((a) => a.id !== id);
  saveAccounts(store, list, nowIso);
  // ⚠ 删掉的正好是"当前"那一格 ⇒ 把当前也清掉，否则会留一个指向空气的 id
  if (store.getState(STATE_CURRENT_ACCOUNT) === id) store.setState(STATE_CURRENT_ACCOUNT, '', nowIso);
  // ⚠ **连它的状态袋一起清**。不清的话会留下一袋孤儿数据 —— 而且
  //   "看不出是孤儿"：下次有人用同一个手机号再加账号时 id 相同，
  //   于是**新账号会继承旧账号的状态**（票、进度、`ordered_hour`…）。
  //   那比"留着垃圾"严重得多。
  clearBag(store, id, nowIso);
  return list;
}

export function selectAccount(store: Store, id: string, nowIso: string): boolean {
  if (id !== '' && !loadAccounts(store).some((a) => a.id === id)) return false;
  store.setState(STATE_CURRENT_ACCOUNT, id, nowIso);
  return true;
}

/** **换掉某个账号的凭据**（其余字段原样保留）。
 *
 *  ⚠ 为什么必须有它：`loadAuthRaw` 读的是 `Account.auth` —— 账号列表里的那一格
 *  才是权威。续期把新串写进**别处**（`STATE_AUTH` 或账号袋里的那份）时，
 *  表现就是"提示说续期成功、卡片上还是原来的天数，点几次都一样"（F-077）。 */
export function setAccountAuth(
  store: Store,
  id: string,
  auth: string,
  nowIso: string,
): Account | undefined {
  if (auth === '') return undefined;
  const list = loadAccounts(store);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  if (list[idx]!.auth === auth) return list[idx];
  list[idx] = { ...list[idx]!, auth };
  saveAccounts(store, list, nowIso);
  return list[idx];
}

/** 给某个账号补上用户域（拿不到就什么也不做）。 */
export function setAccountDomain(
  store: Store,
  id: string,
  domain: string,
  nowIso: string,
): Account | undefined {
  if (domain === '') return undefined;
  const list = loadAccounts(store);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  if (list[idx]!.userDomainId === domain) return list[idx];
  list[idx] = { ...list[idx]!, userDomainId: domain };
  saveAccounts(store, list, nowIso);
  return list[idx];
}

/** **当前账号**的用户域（没有 ⇒ `null`）。
 *
 *  ⚠ 读的是账号上那一格，不是全局那格 —— 后者是 F-075 里挪掉的那份。 */
export function currentAccountDomain(store: Pick<Store, 'getState'>): string | null {
  const a = currentAccount(store);
  return a?.userDomainId !== undefined && a.userDomainId !== '' ? a.userDomainId : null;
}

/** 当前账号（没设 / 设的 id 已不在列表里 ⇒ `undefined`）。 */
export function currentAccount(store: Pick<Store, 'getState'>): Account | undefined {
  const id = (store.getState(STATE_CURRENT_ACCOUNT) ?? '').trim();
  if (id === '') return undefined;
  return loadAccounts(store).find((a) => a.id === id);
}
