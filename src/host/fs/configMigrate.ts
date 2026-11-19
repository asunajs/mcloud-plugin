// 一次性迁移：把散在各处的**用户设置**收进唯一配置文件 `<store>/config.json`。
//
// # 它替代了什么
//
// 以前同一格设置有两个家：面板「插件配置」写的 `plugin-data/<插件>/config.json`，
// 与插件界面写的 state。`mcloud/configOverlay.ts` 用「指纹 + 三方合并」让两边都不盖
// 对方 —— 那套机制的存在本身就说明配置被切成了两半。收成一份之后它不再成立，
// 所以这一版把它删掉，只留这条**一次性**迁移。
//
// # 迁移的四个来源（后面的覆盖前面的）
//
//   ① 绑定的 `seed`（新安装时的默认值）
//   ② 四份旧 `plugin-data/<插件>/config.json`（daily / exchange / live / mcloud，按此顺序）
//   ③ 旧 state 键（`shared.json` 里的扁平键）
//   ④ 账号袋里的按账号设置（`state/<账号>.json`）
//
// # 幂等
//
// 判据只有一条：`config.json` 存在 + 是对象 + `schema_version >= 1` ⇒ **直接返回**，
// 一个旧来源都不读。所以「用户后来把 config.json 删了」= 重新按默认值来一次，
// 而**不会**把几年前的旧值复活（旧 state 键在第一次迁移后已经删掉了）。
//
// # 备份
//
// 写之前把四份旧文件**原文**拷到 `<store>/backup/config-migration-<时间>/`，
// 并把「被搬走的旧 state 键」存成 `state-keys.json`。迁移是有信息损失的一步
// （旧键要删掉，见下），没有备份就不能做。
//
// # 为什么必须删旧 state 键
//
// 不删就等于「同一格设置两个家」照旧存在，只是这次我们**读**的是文件 —— 迟早有人
// 去读旧键，然后两个值对不上。删掉 + 备份副本，是唯一说得清的边界。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from '../../store/types.ts';
import {
  CONFIG_BINDINGS,
  RETIRED_BINDINGS,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  bindingPath,
  decodeValue,
  encodeValue,
  getPath,
  isPlainObject,
  setPath,
  type ConfigDoc,
} from '../../store/userConfigKeys.ts';

/** 旧的面板配置页写的那四份文件（相对 `<store>` 的兄弟目录）。 */
const LEGACY_PLUGINS = ['mcloud-daily', 'mcloud-exchange', 'mcloud-live', 'mcloud'] as const;

export interface MigrateResult {
  /** `false` = 已经是新格式（幂等返回） */
  migrated: boolean;
  /** 从旧来源搬进来的键（诊断用） */
  adopted: string[];
  /** 从旧 config.json 读到的文件路径 */
  sources: string[];
  /** 备份目录（没迁移时是空串） */
  backupDir: string;
  /** 写好的 config.json 路径 */
  path: string;
}

function readJsonFile(path: string): ConfigDoc | null {
  try {
    statSync(path);
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isPlainObject(v) ? v : null;
  } catch {
    // 坏文件：当作没有（迁移不该因为一份手改坏的旧文件而失败）
    return null;
  }
}

/** 读旧 state 值：全局键直接读；按账号的键从账号袋里读。 */
function legacyStateValue(store: Store, key: string, acct: string): string | null {
  if (acct === '') return store.getState(key) ?? null;
  const raw = store.getState('mcloud.acct.' + acct) ?? '';
  if (raw === '') return null;
  try {
    const bag = JSON.parse(raw) as Record<string, unknown>;
    const v = bag[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function accountIds(store: Store): string[] {
  const raw = store.getState('mcloud.accounts') ?? '';
  if (raw === '') return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => (isPlainObject(x) && typeof x['id'] === 'string' ? x['id'] : ''))
      .filter((x) => x !== '');
  } catch {
    return [];
  }
}

/** 把旧 state 里的这格**删掉**（不是写成空串）。
 *
 *  ⚠ 用 `update(key, () => null)`：那是宿主「整段在锁里做、返回 null = 删」的接口
 *  （见 `store/types.ts`）。写成空串的话 `shared.json` 里照样留着这个键，
 *  「state 里不再出现同名字段」就不成立。 */
function dropStateKey(store: Store, key: string, acct: string): void {
  if (acct === '') {
    store.update?.(key, () => null);
    return;
  }
  const bagKey = 'mcloud.acct.' + acct;
  store.update?.(bagKey, (prev) => {
    if (prev === null) return null;
    let bag: Record<string, string>;
    try {
      bag = JSON.parse(prev) as Record<string, string>;
    } catch {
      return prev;
    }
    delete bag[key];
    return JSON.stringify(bag);
  });
}

/** 迁移（幂等）。`store` 必须是**裸 store**（不包 `scoped`）——
 *  我们要直接读旧键、直接删旧键，而路由层此刻已经在把配置键指到新文件了。 */
export function migrateUserConfig(store: Store, nowIso: string): MigrateResult {
  const port = store.userConfig;
  if (port === undefined) {
    throw new Error('这个 store 没有 userConfig 端口 —— 迁移无处可写');
  }
  const path = port.path;
  const storeDir = dirname(path);
  const current = port.snapshot();
  const version = Number(current[SCHEMA_KEY] ?? 0);
  if (Number.isFinite(version) && version >= SCHEMA_VERSION) {
    return { migrated: false, adopted: [], sources: [], backupDir: '', path };
  }

  // ⚠ **已有值一律不动**：`schema_version` 升版（加了新绑定）时会再跑一次，
  //   从零重建就等于把用户改过的值冲回默认值。所以下面三步都是「只补空缺」。
  const doc: ConfigDoc = JSON.parse(JSON.stringify(current)) as ConfigDoc;
  delete doc[SCHEMA_KEY];
  const empty = (path: string): boolean => getPath(doc, path) === undefined;

  // 默认值**最后**才补（见文件头：真实来源优先于种子）。

  // ② 四份旧 config.json（在 `<store>` 的兄弟目录里）
  const sources: string[] = [];
  const parent = dirname(storeDir);
  for (const name of LEGACY_PLUGINS) {
    const p = join(parent, name, 'config.json');
    const old = readJsonFile(p);
    if (old === null) continue;
    sources.push(p);
    for (const b of CONFIG_BINDINGS) {
      if (!empty(b.path)) continue; // 已有值优先（见上面那段 ⚠）
      // 旧的表单字段名 = 绑定的 path（`daily_budget_s` / `exchange_enabled`）
      const v = getPath(old, b.path);
      const text = encodeValue(b, typeof v === 'string' ? v : v === undefined || v === null ? null : String(v));
      const typed = v === undefined ? undefined : v;
      const val = typeof typed === 'boolean' || typeof typed === 'number' ? typed : text;
      if (val !== undefined) setPath(doc, b.path, val);
    }
  }

  // ③④ 旧 state 键 / 账号袋
  const adopted: string[] = [];
  const accts = accountIds(store);
  for (const b of CONFIG_BINDINGS) {
    const isAcct = b.path.includes('{acct}');
    const owners = isAcct ? accts : [''];
    for (const acct of owners) {
      const old = legacyStateValue(store, b.key, acct);
      if (old === null || old === '') continue;
      const val = encodeValue(b, old);
      if (val === undefined) continue;
      const at = bindingPath(b, isAcct ? acct : undefined);
      if (!empty(at)) continue; // 文件里已经有值了 ⇒ 不拿旧 state 盖它
      setPath(doc, at, val);
      adopted.push(isAcct ? b.key + '@' + acct : b.key);
    }
  }

  // ④ 种子：只补前面三步都没给的空缺（全新安装就走这一支）
  for (const b of CONFIG_BINDINGS) {
    if (b.seed === undefined || !empty(b.path)) continue;
    setPath(doc, b.path, b.seed);
  }

  // ⑤ **退役的绑定搬回 state**（见 `userConfigKeys.RETIRED_BINDINGS`）：
  //    曾经进过文件、但按「配置 = 用户手设 / 可手设」不该在里面的那几格。
  //    先写回 state（值不丢），再从文件里删掉 —— 这一步之后文件里不该再出现它们。
  for (const b of RETIRED_BINDINGS) {
    const raw = getPath(doc, b.path);
    if (raw !== undefined) {
      const text = decodeValue(b, raw);
      if (text !== null && text !== '') store.setState(b.key, text, nowIso);
      setPath(doc, b.path, undefined);
    }
  }

  doc[SCHEMA_KEY] = SCHEMA_VERSION;

  // 备份：旧文件原文 + 被搬走的旧键（迁移有信息损失，没备份不做）
  const stamp = nowIso.replace(/[:.]/g, '-');
  const backupDir = join(storeDir, 'backup', 'config-migration-' + stamp);
  try {
    mkdirSync(backupDir, { recursive: true });
    for (const src of sources) {
      // 名字取「插件目录-config.json」，别让两个插件互相覆盖；用非字母数字全替换成 _ 避免路径字符。
      const safe = src.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      // ⚠ 不用 `copyFileSync`：LLRT 没有它（check-layers 的 R6 盯着）。
      //   配置就几 KB，读出来写过去等价，而且只用到了两边都有的那两个 API。
      writeFileSync(join(backupDir, safe + '.json'), readFileSync(src));
    }
    const dump: Record<string, string> = {};
    for (const b of CONFIG_BINDINGS) {
      const isAcct = b.path.includes('{acct}');
      const owners = isAcct ? accts : [''];
      for (const acct of owners) {
        const old = legacyStateValue(store, b.key, acct);
        if (old === null || old === '') continue;
        dump[isAcct ? b.key + '@' + acct : b.key] = old;
      }
    }
    writeFileSync(join(backupDir, 'state-keys.json'), JSON.stringify(dump, null, 2) + '\n');
  } catch {
    // 备份失败也继续：迁移不写坏东西（原子写），但没有备份时**不删旧键**
  }

  port.replace(doc);

  // 旧 state 键删除（备份没成功就留着 —— 宁可留两个家，也不留一个没有副本的家）
  let backedUp = false;
  try {
    statSync(backupDir);
    backedUp = true;
  } catch {
    backedUp = false;
  }
  if (backedUp) {
    for (const b of CONFIG_BINDINGS) {
      const isAcct = b.path.includes('{acct}');
      const owners = isAcct ? accts : [''];
      for (const acct of owners) {
        if (legacyStateValue(store, b.key, acct) === null) continue;
        dropStateKey(store, b.key, isAcct ? acct : '');
      }
    }
  }

  return { migrated: true, adopted, sources, backupDir: backedUp ? backupDir : '', path };
}
