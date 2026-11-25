// 旧配置（`asign.json`，老版 mcloud-sign 的格式）→ 本插件的状态与统一配置。
//
// # 这个文件为什么在**业务层**而不是 `standalone/`
//
// 面板与 CLI 都必须能做同一件事（R3：一份配置、一套行为），而 `standalone/` 那几个文件
// 顶层 import 了 `node:fs` / `node:path` —— 面板插件跑在沙箱里，一 import 就炸。
// 所以"怎么搬"这半段（纯函数 + store 写入）放这里，两边共用；
// "从哪读文件、备份到哪"那半段留在 `standalone/configImport.ts`（只有 CLI 有文件系统）。
//
// # 搬什么（照 mcloud-sign 的旧格式）
//
// ```text
//   caiyun[].auth / nickname / label / disabled   → 账号表（shared.json，契约不变）
//   caiyun[].红包派对.开启                          → mcloud.task.redpack.on
//   caiyun[].算力大作战.开启 / .代抽                → mcloud.task.tokenpk.on / mcloud.tokenpk.draw
//   common.红包派对.开启 / common.算力大作战.开启    → 公共默认（config.json 的 task_*）
//   standalone.http.* / standalone.ws.*            → cli.http.* / cli.ws.*
// ```
//
// ⚠ **不认识的键不搬**，但要在报告里列出来（用户要能看出"我那份配置里哪些没进来"）。
// ⚠ 幂等：账号按手机号 / auth / 配置顺序对齐，已有的更新、缺的补上；开关同值不重写。

import { loadAccounts, phoneOf, upsertAccount, type Account } from './accounts.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';
import type { Store } from '../store/types.ts';
import { setTaskOn } from './tasks/taskSwitches.ts';
import { setTokenPkDraw, type PkDrawConfig } from './tokenPkState.ts';

/** 旧配置里的一个账号（`caiyun[]` 的一项）。 */
export interface LegacyAccountSeed {
  auth: string;
  nickname?: string | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
  replaceAuth?: boolean | undefined;
  /** 旧配置里**明确写了**的开关。`undefined` = 没写 ⇒ 不碰状态（缺省才生效）。 */
  redpackEnabled?: boolean | undefined;
  tokenPkEnabled?: boolean | undefined;
  tokenPkDraw?: PkDrawConfig | undefined;
}

/** `seedAccounts` 需要的那几格（`StandaloneConfig` 的**结构子集**，不依赖 `standalone/`）。 */
export interface SeedableConfig {
  accounts: LegacyAccountSeed[];
  commonRedpackEnabled?: boolean | undefined;
  commonTokenPkEnabled?: boolean | undefined;
  commonTokenPkDraw?: PkDrawConfig | undefined;
}

/** 把旧配置里的账号并进账号表（**纯 store 写入**，不碰文件）。
 *
 *  三层合并照参照实现：账号那层赢，其次 `common`，**都没写就不写这一格**。
 *  ⚠ 这一格是 `account` 作用域 ⇒ 必须经 `scoped(raw, acctId)` 写。
 */
export function seedAccounts(raw: Store, config: SeedableConfig): void {
  const nowIso = new Date().toISOString();
  const existing = loadAccounts(raw);
  const next: Account[] = [];
  const used = new Set<string>();
  // 攒着统一落：新号要等 `upsertAccount` 之后才有 id 可写
  const switches: { id: string; switchId: 'redpack' | 'tokenpk'; on: boolean }[] = [];
  const draws: { id: string; cfg: PkDrawConfig }[] = [];
  for (const [index, seed] of config.accounts.entries()) {
    const phone = phoneOf(seed.auth);
    // ⚠ 「按配置顺序对齐」只在**认不出手机号**时才用。
    //   认得出手机号却对不上任何账号 ⇒ 这是一个**新号**，绝不能拿第 N 个已有账号
    //   去顶替（那样会把别人的号改名、并把开关写到别人名下）。
    const hit =
      existing.find((a) => (phone !== undefined && phoneOf(a.auth) === phone) || a.auth === seed.auth) ??
      (phone === undefined ? existing.find((a, i) => i === index && !used.has(a.id)) : undefined) ??
      undefined;
    const label = seed.label ?? seed.nickname ?? hit?.label ?? phone ?? '账号';
    const on = seed.redpackEnabled ?? config.commonRedpackEnabled;
    const pkOn = seed.tokenPkEnabled ?? config.commonTokenPkEnabled;
    const pkDraw = seed.tokenPkDraw ?? config.commonTokenPkDraw;
    if (hit !== undefined) {
      if (used.has(hit.id)) continue;
      used.add(hit.id);
      next.push({
        ...hit,
        label,
        auth: seed.replaceAuth === true || hit.auth === '' ? seed.auth : hit.auth,
        disabled: seed.disabled === true,
      });
      if (on !== undefined) switches.push({ id: hit.id, switchId: 'redpack', on });
      if (pkOn !== undefined) switches.push({ id: hit.id, switchId: 'tokenpk', on: pkOn });
      if (pkDraw !== undefined) draws.push({ id: hit.id, cfg: pkDraw });
      continue;
    }
    // 新号：走 `upsertAccount`，id / 平台 / 手机号规则与面板一致
    const { account } = upsertAccount(raw, seed.auth, nowIso, label);
    if (account.id === '') continue;
    if (used.has(account.id)) continue;
    used.add(account.id);
    next.push({ ...account, label, disabled: seed.disabled === true });
    if (on !== undefined) switches.push({ id: account.id, switchId: 'redpack', on });
    if (pkOn !== undefined) switches.push({ id: account.id, switchId: 'tokenpk', on: pkOn });
    if (pkDraw !== undefined) draws.push({ id: account.id, cfg: pkDraw });
  }
  // 保留配置里没提到的账号（别把用户的号删了）
  for (const a of existing) if (!used.has(a.id)) next.push(a);
  raw.setState('mcloud.accounts', JSON.stringify(next), nowIso);
  if (next.length > 0 && (raw.getState('mcloud.account.current') ?? '') === '') {
    raw.setState('mcloud.account.current', next[0]!.id, nowIso);
  }
  // ⚠ 调用方可能传进来的是**已经 scoped 过**的 store（面板路由就是）——
  //   直接 `scoped()` 会双重包装然后抛。统一先取裸 store。
  const bare = rawStoreOf(raw);
  for (const one of switches) setTaskOn(scoped(bare, one.id), one.switchId, one.on, nowIso);
  for (const one of draws) setTokenPkDraw(scoped(bare, one.id), one.cfg, nowIso);
}

/** 从旧 `asign.json` 的对象里抽出"要搬什么"。**不写任何东西**（`--dry-run` 就靠它）。 */
export interface LegacyPlan {
  /** 统一配置要写的键（点路径 → 值），走 `store.userConfig` */
  settings: { path: string; value: unknown }[];
  /** 公共层的三个开关（`task_redpack` / `task_tokenpk` / `tokenpk.draw`） */
  common: SeedableConfig;
  /** 旧文件里我们不认识的键（原样给用户看，**不搬**） */
  skipped: string[];
}

const KNOWN_TOP = new Set(['version', 'caiyun', 'common', 'standalone', 'message']);

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `true` / `'true'` / `1` / `'1'` 算开；其余（含缺省）`undefined`。 */
function switchOn(v: unknown): boolean | undefined {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  const o = asObject(v);
  return o === undefined ? undefined : switchOn(o['开启']);
}

/** 旧配置里「算力大作战.代抽」的形状：`{开启, 每日上限}`。 */
function drawOf(v: unknown): PkDrawConfig | undefined {
  const o = asObject(v);
  if (o === undefined) return undefined;
  const sub = asObject(o['代抽']);
  if (sub === undefined) return undefined;
  const enabled = switchOn(sub['开启']) ?? false;
  const max = Number(sub['每日上限']);
  return { enabled, max: Number.isFinite(max) && max > 0 ? Math.round(max) : 0 };
}

/** 解析旧 `asign.json`（**只认 JSON 对象**；`asign.config.js` 得先自己转成 JSON）。 */
export function parseLegacyAsign(doc: unknown): LegacyPlan {
  const o = asObject(doc);
  if (o === undefined) throw new Error('旧配置必须是一个 JSON 对象');

  const commonRaw = asObject(o['common']) ?? {};
  const common: SeedableConfig = {
    accounts: [],
    commonRedpackEnabled: switchOn(commonRaw['红包派对']),
    commonTokenPkEnabled: switchOn(commonRaw['算力大作战']),
    commonTokenPkDraw: drawOf(commonRaw['算力大作战']),
  };

  const list = Array.isArray(o['caiyun']) ? (o['caiyun'] as unknown[]) : [];
  const accounts: LegacyAccountSeed[] = [];
  for (const [i, item] of list.entries()) {
    const a = asObject(item);
    if (a === undefined) continue;
    const auth = typeof a['auth'] === 'string' ? a['auth'].trim() : '';
    if (auth === '') throw new Error(`caiyun[${i}] 缺少 auth`);
    const nickname = typeof a['nickname'] === 'string' && a['nickname'].trim() !== '' ? a['nickname'].trim() : undefined;
    const label = typeof a['label'] === 'string' && a['label'].trim() !== '' ? a['label'].trim() : undefined;
    accounts.push({
      auth,
      nickname,
      label: label ?? nickname,
      disabled: a['disabled'] === true,
      replaceAuth: a['replaceAuth'] === true,
      redpackEnabled: switchOn(a['红包派对']),
      tokenPkEnabled: switchOn(a['算力大作战']),
      tokenPkDraw: drawOf(a['算力大作战']),
    });
  }
  common.accounts = accounts;

  // `standalone.http.* / .ws.*` → `cli.*`
  const settings: { path: string; value: unknown }[] = [];
  const st = asObject(o['standalone']) ?? {};
  const http = asObject(st['http']) ?? {};
  const ws = asObject(st['ws']) ?? {};
  const put = (path: string, v: unknown): void => {
    if (v !== undefined) settings.push({ path, value: v });
  };
  put('cli.http.timeout_ms', numOf(http['timeoutMs']));
  put('cli.http.insecure', typeof http['insecure'] === 'boolean' ? http['insecure'] : undefined);
  put('cli.http.follow_redirects', typeof http['followRedirects'] === 'boolean' ? http['followRedirects'] : undefined);
  put('cli.http.proxy', typeof http['proxy'] === 'string' && http['proxy'] !== '' ? http['proxy'] : undefined);
  put('cli.ws.timeout_ms', numOf(ws['timeoutMs']));
  put('cli.ws.insecure', typeof ws['insecure'] === 'boolean' ? ws['insecure'] : undefined);

  // 公共层的三个开关也进统一配置（**没写就不写**：缺省才生效）
  if (common.commonRedpackEnabled !== undefined) put('task_redpack', common.commonRedpackEnabled);
  if (common.commonTokenPkEnabled !== undefined) put('task_tokenpk', common.commonTokenPkEnabled);
  if (common.commonTokenPkDraw !== undefined) put('tokenpk.draw', common.commonTokenPkDraw);

  // 不认识的顶层键：列出来，不搬
  const skipped = Object.keys(o).filter((k) => !KNOWN_TOP.has(k));
  // 认识但本插件没有的（照旧忽略，只是要让人看见）
  for (const k of ['message', 'version']) {
    if (o[k] !== undefined) skipped.push(`${k}（旧字段，本插件不用）`);
  }
  return { settings, common, skipped };
}

function numOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** 从**已解析**的旧配置（`standalone/config.ts::loadConfig` 的产物）做计划。
 *
 *  CLI 走这条：`asign.config.js|mjs` 得先被 `loadConfig` 求值，我们拿不到原始 JSON。
 *  映射与 `parseLegacyAsign` **同源**（都产出 `LegacyPlan`），所以两端不会漂。 */
export function planFromSeedableConfig(cfg: {
  accounts: LegacyAccountSeed[];
  commonRedpackEnabled?: boolean | undefined;
  commonTokenPkEnabled?: boolean | undefined;
  commonTokenPkDraw?: PkDrawConfig | undefined;
  http?: { timeoutMs?: number; insecure?: boolean; followRedirects?: boolean; proxy?: string } | undefined;
  ws?: { timeoutMs?: number; insecure?: boolean } | undefined;
}): LegacyPlan {
  const settings: { path: string; value: unknown }[] = [];
  const put = (path: string, v: unknown): void => {
    if (v !== undefined && v !== '') settings.push({ path, value: v });
  };
  put('cli.http.timeout_ms', cfg.http?.timeoutMs);
  put('cli.http.insecure', cfg.http?.insecure);
  put('cli.http.follow_redirects', cfg.http?.followRedirects);
  put('cli.http.proxy', cfg.http?.proxy);
  put('cli.ws.timeout_ms', cfg.ws?.timeoutMs);
  put('cli.ws.insecure', cfg.ws?.insecure);
  put('task_redpack', cfg.commonRedpackEnabled);
  put('task_tokenpk', cfg.commonTokenPkEnabled);
  if (cfg.commonTokenPkDraw !== undefined) put('tokenpk.draw', cfg.commonTokenPkDraw);
  return {
    settings,
    common: {
      accounts: cfg.accounts,
      commonRedpackEnabled: cfg.commonRedpackEnabled,
      commonTokenPkEnabled: cfg.commonTokenPkEnabled,
      commonTokenPkDraw: cfg.commonTokenPkDraw,
    },
    skipped: [],
  };
}

export interface LegacyApplyReport {
  /** 账号表里现在有多少个号 */
  accounts: number;
  /** 这次真正写下去的配置键 */
  settings: string[];
  /** 这次真正写下去的开关（`账号:开关=开/关`） */
  switches: string[];
  /** 没搬的键 */
  skipped: string[];
}

/** 把解析出来的计划落到 store（账号表 + 账号层开关 + 公共层配置）。**幂等。** */
export function applyLegacyImport(
  store: Store,
  plan: LegacyPlan,
  nowIso: string,
): LegacyApplyReport {
  const before = new Map(loadAccounts(store).map((a) => [a.id, a.auth]));
  seedAccounts(store, plan.common);

  const switches: string[] = [];
  for (const seed of plan.common.accounts) {
    const phone = phoneOf(seed.auth);
    const hit = loadAccounts(store).find(
      (a) => (phone !== undefined && phoneOf(a.auth) === phone) || a.auth === seed.auth,
    );
    if (hit === undefined) continue;
    const one = scoped(rawStoreOf(store), hit.id);
    if (seed.redpackEnabled !== undefined) {
      setTaskOn(one, 'redpack', seed.redpackEnabled, nowIso);
      switches.push(`${hit.label}:redpack=${seed.redpackEnabled ? '开' : '关'}`);
    }
    if (seed.tokenPkEnabled !== undefined) {
      setTaskOn(one, 'tokenpk', seed.tokenPkEnabled, nowIso);
      switches.push(`${hit.label}:tokenpk=${seed.tokenPkEnabled ? '开' : '关'}`);
    }
  }

  const port = store.userConfig;
  if (port === undefined) throw new Error('这个 store 没有 userConfig 端口，没法写统一配置');
  const written: string[] = [];
  for (const s of plan.settings) {
    port.write(s.path, s.value);
    written.push(s.path);
  }
  void before;
  return {
    accounts: loadAccounts(store).length,
    settings: written,
    switches,
    skipped: plan.skipped,
  };
}
