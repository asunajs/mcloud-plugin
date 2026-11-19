// 独立运行的配置加载：兼容 mcloud-sign 的 asign.json / asign.config.js|mjs。
//
// 面板版配置存在 SQLite + 前端页面里；独立版只认文件，且**默认按旧版顺序找**，
// 这样用户从 mcloud-sign 迁过来不用改启动方式。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_DRAW_MAX } from '../mcloud/tokenPkState.ts';
import { pathToFileURL } from 'node:url';
import { normalizeAuth, phoneOf } from '../mcloud/accounts.ts';
import { SCHEMA_KEY, getPath, isPlainObject } from '../store/userConfigKeys.ts';

export interface HttpConfig {
  timeoutMs: number;
  insecure: boolean;
  followRedirects: boolean;
  proxy?: string | undefined;
}

export interface WsConfig {
  insecure: boolean;
  timeoutMs: number;
}

/** 代抽配置：开关 + 每日上限。 */
export interface DrawSeed {
  enabled: boolean;
  max: number;
}

export interface AccountSeed {
  auth: string;
  nickname?: string | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
  replaceAuth?: boolean | undefined;
  /** 配置里**明确写了**的「红包派对.开启」。`undefined` = 没写 ⇒ 不碰状态里那一格
   *  （面板上的开关可能已经改过，不能被每次启动都覆盖一遍）。 */
  redpackEnabled?: boolean | undefined;
  /** 配置里**明确写了**的「算力大作战.开启」。`undefined` = 没写 ⇒ 不碰状态里那一格
   *  （默认是开，见 `tokenPkState.tokenPkEnabled`）。 */
  tokenPkEnabled?: boolean | undefined;
  /** 「算力大作战.代抽」：显式写了才动状态里那一格（默认**不抽**）。 */
  tokenPkDraw?: DrawSeed | undefined;
}

export interface StandaloneConfig {
  /** 实际使用的配置文件绝对路径 */
  path: string;
  dir: string;
  /** 这份是**统一配置文件**（`config.json`，带 `schema_version`）而不是旧的 `asign.json`。
   *
   *  统一模式下：设置从这份文件读（`daily_budget_s` / `live.*` / `push.*` / `cli.*`…），
   *  账号从**同一目录的 `shared.json`** 读（账号是运行期状态，不在配置里），
   *  目录默认就是这份文件所在目录。
   *  ⚠ 旧 `asign.json` 的 `caiyun[]` + `standalone.*` 仍按老语义工作 —— 用
   *  `mcloud-sign config:import` 可以一次性搬进统一配置文件（见 `configImport.ts`）。 */
  unified: boolean;
  accounts: AccountSeed[];
  stateFile: string;
  http: HttpConfig;
  ws: WsConfig;
  common: Record<string, unknown>;
  message: unknown;
  /** `common.红包派对.开启` —— 参照实现是「默认 → 通用 → 账号」三层合并，
   *  账号那层赢。这里同样只在**明确写了**时才落到账号状态上。 */
  commonRedpackEnabled?: boolean | undefined;
  /** `common.算力大作战.开启`（与红包同一套三层合并：账号 > 通用 > 缺省开）。 */
  commonTokenPkEnabled?: boolean | undefined;
  /** `common.算力大作战.代抽`。 */
  commonTokenPkDraw?: DrawSeed | undefined;
  raw: Record<string, unknown>;
}

const CONFIG_FILES = ['asign.json', 'asign.config.js', 'asign.config.mjs'];

/** 旧版查找顺序：cwd → cwd/config → 可执行文件目录 → 其 config。 */
export function findConfigPath(
  cwd: string = process.cwd(),
  execPath: string = process.argv[1] ?? '',
): string | undefined {
  const dirs: string[] = [cwd, join(cwd, 'config')];
  if (execPath !== '') {
    const execDir = resolve(execPath, '..');
    if (execDir !== cwd) dirs.push(execDir, join(execDir, 'config'));
  }
  for (const dir of dirs) {
    for (const file of CONFIG_FILES) {
      const p = join(dir, file);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${what} 必须是对象`);
  }
  return v as Record<string, unknown>;
}

function readJson(p: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件读不了 / 不是合法 JSON：${p}（${e instanceof Error ? e.message : String(e)}）`);
  }
  return asObject(raw, '配置文件');
}

async function readConfigFile(p: string): Promise<Record<string, unknown>> {
  if (p.endsWith('.js') || p.endsWith('.mjs')) {
    const mod = (await import(pathToFileURL(p).href)) as { default?: unknown };
    return asObject(mod.default ?? mod, '配置文件');
  }
  return readJson(p);
}

/** 旧版 mcloud.auth.json：数组或 { [configPath]: auth[] }。只读合并，不写回。 */
function legacyAuths(dir: string): string[] {
  const p = join(dir, "mcloud.auth.json");
  if (!existsSync(p)) return [];
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'object' && v !== null) {
    const out: string[] = [];
    for (const x of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(x)) out.push(...x.filter((y): y is string => typeof y === 'string'));
    }
    return out;
  }
  return [];
}

/** 老 auth 只按手机号判断；同号才替换，避免把账号顺序错位当成“更新”。 */
function mergeLegacyAuth(accounts: AccountSeed[], dir: string): AccountSeed[] {
  const old = legacyAuths(dir);
  if (old.length === 0) return accounts;
  return accounts.map((a) => {
    const phone = phoneOf(a.auth);
    if (phone === undefined) return a;
    const hit = old.find((x) => phoneOf(x) === phone);
    return hit === undefined ? a : { ...a, auth: hit };
  });
}

/** 「红包派对.开启」那种"对象里一个开关"的写法。
 *
 *  ⚠ **没写这一格 ⇒ `undefined`**，不是 `false`。参照实现的默认来自
 *  `defaultAccountConfig`（`红包派对: {开启: true}`）⇒ 缺省是**开**，
 *  这里要是把"没写"折成 `false`，就等于把整族偷偷关掉，而日志里一句不说。 */
/** 读「代抽」那一格：`true` 或 `{开启, 每日上限}`。形状不对 ⇒ `undefined`（当没写）。 */
function drawOf(pk: unknown): DrawSeed | undefined {
  if (typeof pk !== 'object' || pk === null || Array.isArray(pk)) return undefined;
  const d = (pk as Record<string, unknown>)['代抽'];
  if (d === true) return { enabled: true, max: DEFAULT_DRAW_MAX };
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined;
  const o = d as Record<string, unknown>;
  if (typeof o['开启'] !== 'boolean') return undefined;
  const lim = o['每日上限'];
  const max =
    typeof lim === 'number' && Number.isFinite(lim) && lim >= 0 ? Math.floor(lim) : DEFAULT_DRAW_MAX;
  return { enabled: o['开启'], max };
}

function switchOn(v: unknown): boolean | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return typeof o['开启'] === 'boolean' ? o['开启'] : undefined;
}

function accountSeeds(raw: Record<string, unknown>): AccountSeed[] {
  const list = raw.caiyun ?? raw.accounts;
  if (!Array.isArray(list)) throw new Error('配置里没有 caiyun（或 accounts）数组');
  const out: AccountSeed[] = [];
  for (const [i, it] of list.entries()) {
    const o = asObject(it, `caiyun[${i}]`);
    const auth = typeof o.auth === 'string' ? o.auth.trim() : '';
    if (auth === '') throw new Error(`caiyun[${i}] 缺少 auth`);
    const nickname = typeof o.nickname === 'string' && o.nickname.trim() !== '' ? o.nickname.trim() : undefined;
    const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : undefined;
    out.push({
      auth: normalizeAuth(auth),
      nickname,
      label: label ?? nickname,
      disabled: o.disabled === true,
      replaceAuth: o.replaceAuth === true,
      redpackEnabled: switchOn(o['红包派对']),
      tokenPkEnabled: switchOn(o['算力大作战']),
      tokenPkDraw: drawOf(o['算力大作战']),
    });
  }
  return out;
}

/** 这份 JSON 是统一配置文件吗（`schema_version` 在、而且不是旧的 asign.json 形状）。 */
function isUnifiedDoc(raw: Record<string, unknown>): boolean {
  if (raw[SCHEMA_KEY] === undefined) return false;
  // 旧 asign.json 一定带 caiyun/accounts；两个都有时按旧格式走（用户的账号更值钱）
  return raw['caiyun'] === undefined && raw['accounts'] === undefined;
}

/** 统一配置里的数字格（`cli.http.timeout_ms`）：数字或数字串都认。 */
function cliNum(o: unknown, key: string, d: number): number {
  const v = isPlainObject(o) ? o[key] : undefined;
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 统一配置里的开关格（`cli.http.insecure`）。 */
function cliBool(o: unknown, key: string, d: boolean): boolean {
  const v = isPlainObject(o) ? o[key] : undefined;
  return typeof v === 'boolean' ? v : d;
}

function numberOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

function boolOr(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

export async function loadConfig(path?: string): Promise<StandaloneConfig> {
  const found = path === undefined ? findConfigPath() : resolve(path);
  if (found === undefined) {
    throw new Error('找不到配置文件，请确保当前目录有 asign.json / asign.config.js / asign.config.mjs');
  }
  if (!existsSync(found)) throw new Error(`配置文件不存在：${found}`);
  const abs = resolve(found);
  const dir = resolve(abs, '..');
  const raw = await await readConfigFile(abs);
  const unified = isUnifiedDoc(raw);
  // 统一配置里**没有账号**（账号是运行期状态，在 shared.json）。硬要 accountSeeds 会抛
  // 「配置里没有 caiyun 数组」—— 那条错误对统一配置文件是**错的**。
  let accounts = unified ? [] : accountSeeds(raw);
  if (!unified) accounts = mergeLegacyAuth(accounts, dir);

  // 统一模式的宿主旋钮在 `cli.*` 段（`config:import` 会把旧 `standalone.*` 搬到那里）。
  const cliHttp = unified ? (isPlainObject(raw['cli']) ? (raw['cli'] as Record<string, unknown>)['http'] : undefined) : undefined;
  const cliWs = unified ? (isPlainObject(raw['cli']) ? (raw['cli'] as Record<string, unknown>)['ws'] : undefined) : undefined;
  const httpSrc = unified ? (isPlainObject(cliHttp) ? cliHttp : {}) : (() => {
    const st = raw.standalone === undefined ? {} : asObject(raw.standalone, 'standalone');
    return st.http === undefined ? {} : asObject(st.http, 'standalone.http');
  })();
  const wsSrc = unified ? (isPlainObject(cliWs) ? cliWs : {}) : (() => {
    const st = raw.standalone === undefined ? {} : asObject(raw.standalone, 'standalone');
    return st.ws === undefined ? {} : asObject(st.ws, 'standalone.ws');
  })();

  const http = httpSrc;
  const ws = wsSrc;
  const stateRaw = (() => {
    if (unified) return 'config.json'; // 统一模式：目录 = config.json 所在目录（见 runtime.ts）
    const st = raw.standalone === undefined ? {} : asObject(raw.standalone, 'standalone');
    return typeof st.stateFile === 'string' && st.stateFile !== '' ? st.stateFile : '.mcloud/state.json';
  })();

  // `MCLOUD_DATA_DIR` 压倒一切：指到面板那个 `plugin-data/mcloud` 就是**同一份**
  // 账号与凭据（面板与 CLI 共用一套本地 JSON 存储，见 host/fs/fileStore.ts 文件头）。
  // 目录里没有 state.json 也照样能用 —— 它只是给"老状态一次性导入"看的。
  const envDir = (process.env['MCLOUD_DATA_DIR'] ?? '').trim();

  return {
    path: abs,
    dir,
    unified,
    accounts,
    // 统一模式：状态目录就是配置所在目录（`shared.json` 与它并排）—— 除非 MCLOUD_DATA_DIR 覆盖
    stateFile: envDir !== ''
      ? resolve(envDir, 'state.json')
      : unified ? join(dir, 'state.json') : resolve(dir, stateRaw),
    // 统一模式下旋钮在 `cli.http.*` / `cli.ws.*`（**下划线键名**，与绑定表的 path 一致）；
    // 旧 asign.json 那条路仍是 `standalone.http.timeoutMs`（驼峰）—— 两边各按各的读。
    http: unified
      ? {
          timeoutMs: cliNum(http, 'timeout_ms', 20_000),
          insecure: cliBool(http, 'insecure', false),
          followRedirects: cliBool(http, 'follow_redirects', false),
          proxy: typeof (isPlainObject(http) ? http['proxy'] : undefined) === 'string'
            && String(http['proxy']) !== '' ? String(http['proxy']) : undefined,
        }
      : {
          timeoutMs: numberOr(http.timeoutMs, 20_000),
          insecure: boolOr(http.insecure, false),
          followRedirects: boolOr(http.followRedirects, false),
          proxy: typeof http.proxy === 'string' && http.proxy !== '' ? http.proxy : undefined,
        },
    ws: unified
      ? {
          insecure: cliBool(ws, 'insecure', false),
          timeoutMs: cliNum(ws, 'timeout_ms', 15_000),
        }
      : {
          insecure: boolOr(ws.insecure, false),
          timeoutMs: numberOr(ws.timeoutMs, 15_000),
        },
    common: raw.common === undefined ? {} : asObject(raw.common, 'common'),
    commonRedpackEnabled:
      raw.common === undefined ? undefined : switchOn(asObject(raw.common, 'common')['红包派对']),
    commonTokenPkEnabled:
      raw.common === undefined ? undefined : switchOn(asObject(raw.common, 'common')['算力大作战']),
    commonTokenPkDraw:
      raw.common === undefined ? undefined : drawOf(asObject(raw.common, 'common')['算力大作战']),
    message: raw.message,
    raw,
  };
}
