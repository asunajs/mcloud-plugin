// 推送配置的存取。
//
// # 为什么单独一个文件（不并进 push.ts）
//
// `push.ts` 是**纯**的（只把消息变成请求，能在 Node 里测）。
// 这一层碰 `Store`，而且要在路由层（**故意不引 host-api**）与插件入口
// （引 host-api）两边都用 —— 所以它只依赖 `Store` 的类型。
//
// # 配置里**有秘密**
//
// token / corpsecret / pass 全在配置里。所以：
//   · 这一层存**原样**（要拿去发请求）
//   · 给界面看的读数一律走 `maskPushConfig()`（见文件末尾）
//   · 日志里**一行都不打**配置内容
//
// 这条界线与 `accounts.ts` 的 `maskAuth` 是同一条。


import type { Store } from '../store/types.ts';
import { CHANNELS, type PushChannel, type PushConfig } from './push.ts';

/** 推送配置落在这一格（JSON）。 */
export const STATE_PUSH_CONFIG = 'mcloud.push.config';

/** 「哪个任务用哪条规则」。
 *
 *  # 为什么先做"每个任务挑一条"
 *
 *  参考实现里推送规则是一套完整的编排（`PushRule` + 行为绑定 + 节流 +
 *  按日志级别过滤）。那套东西要的界面是"规则编辑器"，而**用户看不懂规则编辑器** ——
 *  这正是这一版要解决的问题。
 *
 *  所以先做最简模型：**每个任务（日常/兑换/直播）各选一条规则**，
 *  规则就是"这组渠道 + 一个最低级别"。界面上是三行下拉框，不是编辑器。
 *  要更细的粒度再加，而不是先把编辑器摆出来让人猜。 */
export const STATE_PUSH_RULES = 'mcloud.push.rules';

/** 一条推送规则：一组渠道 + 一个最低级别。 */
export interface PushRule {
  id: string;
  name: string;
  /** 这条规则要用哪些渠道（空 = 全部配了的渠道）。 */
  channels: PushChannel[];
  /** 最低级别：`error` 只在有失败时发，`always` 每次都发。 */
  minLevel: 'error' | 'always';
}

/** 三个任务各自用哪条规则（值是规则 id，空 = 不发）。 */
export interface PushBindings {
  daily: string;
  exchange: string;
  live: string;
}

export const STATE_PUSH_BINDINGS = 'mcloud.push.bindings';

/** 三个任务的 id（与界面上的三块一致）。 */
export const TASK_KEYS = ['daily', 'exchange', 'live'] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

export const TASK_LABELS: Record<TaskKey, string> = {
  daily: '日常',
  exchange: '兑换',
  live: '直播',
};

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return typeof v === 'object' && v !== null ? v : fallback;
  } catch {
    // 库里那段坏了（手改过 / 老版本写的）⇒ 当作"没配"，
    // 而不是让整个界面 500
    return fallback;
  }
}

export function loadPushConfig(store: Pick<Store, 'getState'>): PushConfig {
  return parse<PushConfig>(store.getState(STATE_PUSH_CONFIG), {});
}

export function savePushConfig(store: Store, cfg: PushConfig, nowIso: string): void {
  store.setState(STATE_PUSH_CONFIG, JSON.stringify(cfg), nowIso);
}

export function loadPushRules(store: Pick<Store, 'getState'>): PushRule[] {
  const raw = parse<PushRule[]>(store.getState(STATE_PUSH_RULES), []);
  return Array.isArray(raw) ? raw.filter((r) => typeof r?.id === 'string') : [];
}

export function savePushRules(store: Store, rules: PushRule[], nowIso: string): void {
  store.setState(STATE_PUSH_RULES, JSON.stringify(rules), nowIso);
}

export function loadPushBindings(store: Pick<Store, 'getState'>): PushBindings {
  const raw = parse<Partial<PushBindings>>(store.getState(STATE_PUSH_BINDINGS), {});
  return {
    daily: typeof raw.daily === 'string' ? raw.daily : '',
    exchange: typeof raw.exchange === 'string' ? raw.exchange : '',
    live: typeof raw.live === 'string' ? raw.live : '',
  };
}

export function savePushBindings(store: Store, b: PushBindings, nowIso: string): void {
  store.setState(STATE_PUSH_BINDINGS, JSON.stringify(b), nowIso);
}

/** 只给界面看的形状：**秘密一律换成掩码**。
 *
 *  规则与绑定的形状照原样给（界面要拿它渲染下拉框）。 */
export interface PushReading {
  configured: PushChannel[];
  channels: { id: PushChannel; label: string; configured: boolean; hint: string }[];
  rules: PushRule[];
  bindings: PushBindings;
  /** 每个渠道**配没配**（不给值）。 */
  fields: Record<string, Record<string, string>>;
}

/** 一个字段的掩码：短值全遮，长值留头尾。
 *
 *  ⚠ 短值**全遮**而不是"留前 2 后 2" —— 一个 6 字符的 token 留 4 个字符
 *  等于没遮。 */
export function maskSecret(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '';
  if (v.length <= 8) return '（已配）';
  return `${v.slice(0, 3)}…${v.slice(-2)}（共 ${v.length} 字符）`;
}

/** 每个渠道"配没配、配了哪些字段"（**值只给掩码**）。 */
export function pushFields(cfg: PushConfig): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const take = (ch: PushChannel, obj: Record<string, unknown> | undefined): void => {
    if (obj === undefined) return;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'extra') continue;
      if (v === undefined || v === null || v === '') continue;
      // 秘密字段掩码；非秘密（host / port / msgtype / touser / agentid / url）原样
      const secretish = /token|secret|pass|key|sid|corpsecret/i.test(k);
      fields[k] = secretish ? maskSecret(v) : String(v);
    }
    out[ch] = fields;
  };

  take('pushplus', cfg.pushplus as unknown as Record<string, unknown> | undefined);
  take('serverChan', cfg.serverChan as unknown as Record<string, unknown> | undefined);
  take('workWeixin', cfg.workWeixin as unknown as Record<string, unknown> | undefined);
  take('workWeixinBot', cfg.workWeixinBot as unknown as Record<string, unknown> | undefined);
  take('tgBot', cfg.tgBot as unknown as Record<string, unknown> | undefined);
  take('bark', cfg.bark as unknown as Record<string, unknown> | undefined);
  take('twoIm', cfg.twoIm as unknown as Record<string, unknown> | undefined);
  take('dingTalk', cfg.dingTalk as unknown as Record<string, unknown> | undefined);
  take('email', cfg.email as unknown as Record<string, unknown> | undefined);
  if (cfg.customPost && cfg.customPost.length > 0) {
    out['customPost'] = { 模板数: String(cfg.customPost.length) };
  }
  return out;
}

/** 每个渠道"要填什么"（界面上的提示语）。 */
export const CHANNEL_HINTS: Record<PushChannel, string> = {
  pushplus: '要一个 token（pushplus 网站上拿）',
  serverChan: '要一个 SendKey',
  workWeixin: '要 corpid + corpsecret + agentid（**两步**：先换 access_token）',
  workWeixinBot: '要一个群机器人 webhook 地址',
  tgBot: '要 bot token + chat_id（群 ID 是负数）',
  bark: '要一个 key（Bark App 里拿）',
  twoIm: '要 key + sid',
  dingTalk: '要 access_token（有加签密钥就一起填）',
  email: '要 SMTP 主机 + 发件人 + 密码（走面板的 smtp_send）',
  customPost: '自己写请求模板（URL + 请求体）',
};

/** 界面要的读数。**秘密只给掩码。** */
export function pushReading(store: Pick<Store, 'getState'>): PushReading {
  const cfg = loadPushConfig(store);
  const configured = CHANNELS.filter((c) => {
    if (c === 'customPost') return (cfg.customPost ?? []).length > 0;
    return cfg[c] !== undefined && cfg[c] !== null;
  });
  return {
    configured,
    channels: CHANNELS.map((id) => ({
      id,
      label: id,
      configured: configured.includes(id),
      hint: CHANNEL_HINTS[id],
    })),
    rules: loadPushRules(store),
    bindings: loadPushBindings(store),
    fields: pushFields(cfg),
  };
}
