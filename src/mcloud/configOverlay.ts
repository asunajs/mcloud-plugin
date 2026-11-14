// 面板「插件配置」→ state：**三方合并**（谁后改谁生效，且谁也不把谁盖回去）。
//
// # 为什么要有这一层
//
// 同一格设置两处都能改：
//
//   · 面板 → 插件卡片 → 配置：写 `plugin-data/<插件>/config.json`，插件用
//     `host.self_config()` 读（这是面板给的正式入口，配置页有表单，见 `<插件>.panel.json`
//     的 `config.fields`）；
//   · 插件自己的界面：直接写 state。
//
// 两处都能改 ⇒ 必须定一套判据，否则必然一方把另一方盖回去。试过、都不行：
//
//   · **「缺失才播种」**（参考 mgmusic 的写法）在这里不成立：这几格首次加载就写了
//     默认值（见 `dailyBudgetMs` / `scheduleEnabled`）⇒ "缺失"永远不出现，
//     面板上的字段成了摆设；
//   · **「config.json 有值就覆盖」**：用户在界面上把预算改成 300，下次加载又被文件里
//     那个旧的 180 盖回去 —— 界面上的改动看起来"没生效"。
//
// # 判据（记一份指纹，三条对同一个输入给出同一个结果）
//
// `mcloud.cfg.applied` 里躺着「上次从 config.json **应用进去**的是什么值」：
//
//   ｜ config.json 没给这一格              ｜ 不动                                    ｜
//   ｜ 给了，且与指纹**不同**（文件改过）    ｜ 应用进 state，并把指纹更新成这个值        ｜
//   ｜ 给了，且与指纹**相同**（文件没动过）  ｜ 不动 —— 那之后 state 是用户自己在界面上改的 ｜
//
// 于是「文件里那个值」只在**它自己变过**的那一次生效；用户之后在界面上的改动会一直留着，
// 直到他再次改文件。重载多少次都是同一个结果。
//
// # 收窄到「用户真会改」的那几格
//
// 不把内部键摊出来（基址 / 心跳 / 房间号那些是搭测试环境的口子，写进配置页只会让人
// 把面板指到错的地方去）。现在只有两格，每一格都指向**真读它**的代码：
//
//   daily_budget_s   → `mcloud.daily.budget_s`（日常那一趟的单次预算，见 entries/daily.ts）
//   exchange_enabled → `mcloud.exchange.schedule.enabled`（定时抢兑开没开，见 tasks/exchangeRun.ts）
//
// ⚠ 这一层**只碰 state**、不发请求、不 import `host-api`（读 `self_config` 那一半在
// `entries/shared.ts` 的 `syncConfigToState`）—— 这样合并逻辑能在 Node 的单测里跑全套。

import type { Store } from '../store/types.ts';

/** 「上次从 config.json 应用进去的值」这份指纹。**全局**（它说的是文件，不是某个账号）。 */
export const STATE_APPLIED = 'mcloud.cfg.applied';

/** 日常预算的上下限（秒）。
 *
 *  下限 60：一趟日常再怎么快也不该低于这个数（多账号 + 任务间间隔）。
 *  上限 600：面板对单任务预算的硬上限（`MAX_DECLARED_BUDGET_MS` = 10 分钟），
 *  超过**不是夹一下，是抛异常、插件整个加载失败**（2026-11-03 09:58 现场）。
 *  这里先夹住，永远不往宿主递一个超限的数。 */
export const MIN_BUDGET_S = 60;
export const MAX_BUDGET_S = 600;

/** 一格配置的映射规则。 */
export interface ConfigRule {
  /** config.json 里的键名（= 清单 `config.fields` 里的 `name`） */
  name: string;
  /** 落到哪个 state 键 */
  stateKey: string;
  /** 把 config.json 的值规整成 state 存的那个字符串；认不出来 ⇒ `null`（跳过并报出来） */
  normalize(raw: unknown): string | null;
}

/** `180` / `'180'` / `' 180 '` → `'180'`（夹在 60–600）。别的（`''` / `'abc'` / `null`）→ null。 */
function budgetText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const sec = Math.min(Math.max(Math.round(n), MIN_BUDGET_S), MAX_BUDGET_S);
  return String(sec);
}

/** 开关：`'1'`/`'0'` 是 state 里的存法（`scheduleEnabled` 认的就是它们）。
 *
 *  ⚠ 关要写 `'0'`、不能写 `''`：那一格空串的含义是"老库没设过"⇒ 有定时目标就算开
 *  （见 `tasks/exchangeRun.ts` 的 `scheduleEnabled`）。写成空串等于"关不掉"。 */
function boolText(raw: unknown): string | null {
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  if (typeof raw === 'number') return raw === 1 ? '1' : raw === 0 ? '0' : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (t === '1' || t === 'true' || t === 'on' || t === 'yes') return '1';
  if (t === '0' || t === 'false' || t === 'off' || t === 'no') return '0';
  return null;
}

/** 面板配置页 → state 的映射表。**加一格之前先问**：插件里真的有代码读它吗？ */
export const CONFIG_RULES: readonly ConfigRule[] = [
  { name: 'daily_budget_s', stateKey: 'mcloud.daily.budget_s', normalize: budgetText },
  { name: 'exchange_enabled', stateKey: 'mcloud.exchange.schedule.enabled', normalize: boolText },
];

/** 合并结果（给日志用，也是单测的断言面）。 */
export interface OverlayResult {
  /** 这次真的写进 state 的：`名字=值` */
  applied: string[];
  /** 文件里的值与指纹相同 ⇒ 不动（用户在界面上改过） */
  kept: string[];
  /** 文件给了、但值认不出来 ⇒ 跳过（要报出来，别静默） */
  ignored: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 读指纹。坏了就当没有（**不抛**：这份文件是给人手改的，坏值不该让插件加载失败）。 */
function loadApplied(store: Pick<Store, 'getState'>): Record<string, string> {
  const raw = store.getState(STATE_APPLIED);
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 把 `config.json`（原样拿来的那个对象）里声明过的格子合并进 state。
 *
 *  `cfg` 可以是 `null` / `{}`（没配过）—— 那就是"什么都没给"，一格都不动。 */
export function applyConfigOverlay(
  store: Store,
  cfg: unknown,
  nowIso: string,
): OverlayResult {
  const src = isPlainObject(cfg) ? cfg : {};
  const applied = loadApplied(store);
  const out: OverlayResult = { applied: [], kept: [], ignored: [] };
  let dirty = false;

  for (const rule of CONFIG_RULES) {
    if (!Object.prototype.hasOwnProperty.call(src, rule.name)) continue;
    const want = rule.normalize(src[rule.name]);
    if (want === null) {
      out.ignored.push(rule.name);
      continue;
    }
    // 指纹相同 ⇒ 文件没动过，state 里的现值可能是用户在界面上改的 ⇒ **不动**。
    if (applied[rule.name] === want) {
      out.kept.push(rule.name);
      continue;
    }
    store.setState(rule.stateKey, want, nowIso);
    applied[rule.name] = want;
    dirty = true;
    out.applied.push(rule.name + '=' + want);
  }

  if (dirty) store.setState(STATE_APPLIED, JSON.stringify(applied), nowIso);
  return out;
}
