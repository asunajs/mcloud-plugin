// 推送：10 个渠道 + 「一次运行结束」时发一条。
//
// 权威源：`mcloud/crates/mcloud-app/src/push.rs`（1200+ 行）。
//
// # 这个文件**不引 host-api**（故意的）
//
// 它只做「把一条消息变成一个请求」，发出去由调用方注入 —— 这样整层能在 Node 里测
// （与 `routes.ts` 同一条理由）。邮件那条要 `smtp_send`，那是宿主 API，
// 所以它由调用方当参数传进来（见 `PushDeps.smtp`）。
//
// # 10 个渠道
//
// | id | 名字 | 要什么 |
// |---|---|---|
// | `pushplus` | pushplus | token |
// | `serverChan` | Server酱 | token |
// | `workWeixin` | 企业微信推送 | corpid + corpsecret + agentid（**两步**：先换 token） |
// | `workWeixinBot` | 企业微信Bot推送 | 一个 webhook URL |
// | `tgBot` | Telegram Bot 推送 | token + chat_id |
// | `bark` | Bark ios 推送 | key |
// | `twoIm` | 回逍推送 | key + sid |
// | `dingTalk` | 钉钉推送 | token（有 secret 就加签） |
// | `email` | 邮件消息 | host + from + pass（走面板的 `smtp_send`） |
// | `customPost` | 自定义消息 | 一个模板数组 |
//
// # 三条**逐字照抄**、看着像笔误但不能改的
//
// 1. **钉钉正文前面有个前导空格**（`" {title}\n\n{text}"`）—— TS 原文。
// 2. **Server酱的 `desp` 里每个换行翻倍**（`\n` → `\n\n`）—— TS 的
//    `text.replace(/\n/g, "\n\n")`。
// 3. **Telegram 的 `chat_id` / `disable_web_page_preview` 是 snake_case**，
//    而同一个配置里 `apiHost` 是 camelCase —— 混用的。跟着"统一成一种"改，
//    表现是这两个字段**永远读不到**（被收进 extra），于是"缺 chat_id"的跳过
//    分支被误触发。

import { hmacSha256 } from '../crypto/hmac.ts';
import { toBase64, utf8 } from '../crypto/bytes.ts';
import type { BuiltRequest } from './h5.ts';

/** 每个渠道请求的超时（毫秒）。**与参考实现同值**。
 *
 *  ⚠ 这个值**只能当文档看**：面板的 `BuiltRequest` 没有逐请求超时这个字段
 *  （超时在 **transport** 那一层定，见 `entries/shared.ts` 的 `makeTransport`）。
 *  所以推送走的是**长超时那条 transport**（20 秒）——
 *  用默认那条（1.5 秒）的话，稍慢的渠道会被判成失败，而"失败"看起来像渠道配错了。
 *
 *  这也意味着**推送请求的超时比执行预算可能还长**：别把推送放进需要毫秒精度的
 *  任务里（兑换那条链）。它挂在「一次运行结束」上，跑得慢没关系。 */
export const PUSH_TIMEOUT_MS = 10_000;

// ══════════════════════════════ 渠道 ══════════════════════════════

export type PushChannel =
  | 'pushplus'
  | 'serverChan'
  | 'workWeixin'
  | 'workWeixinBot'
  | 'tgBot'
  | 'bark'
  | 'twoIm'
  | 'dingTalk'
  | 'email'
  | 'customPost';

/** 全部渠道，**顺序就是界面上显示的顺序**。 */
export const CHANNELS: PushChannel[] = [
  'pushplus',
  'serverChan',
  'workWeixin',
  'workWeixinBot',
  'tgBot',
  'bark',
  'twoIm',
  'dingTalk',
  'email',
  'customPost',
];

/** 渠道的中文名（参考实现里 `Channel::label` 的原文）。 */
export const CHANNEL_LABELS: Record<PushChannel, string> = {
  pushplus: 'pushplus',
  serverChan: 'Server酱',
  workWeixin: '企业微信推送',
  workWeixinBot: '企业微信Bot推送',
  tgBot: 'Telegram Bot 推送',
  bark: 'Bark ios 推送',
  twoIm: '回逍推送',
  dingTalk: '钉钉推送',
  email: '邮件消息',
  customPost: '自定义消息',
};

// ══════════════════════════════ 配置 ══════════════════════════════

/** 只有一个 token 的渠道（pushplus / Server酱）。 */
export interface TokenConfig {
  token: string;
  /** 额外的顶层字段（原样并进请求体）。 */
  extra?: Record<string, unknown>;
}

export interface WorkWeixinConfig {
  msgtype?: string;
  touser?: string;
  agentid?: number;
  corpid?: string;
  corpsecret?: string;
  extra?: Record<string, unknown>;
}

export interface WorkWeixinBotConfig {
  url: string;
  msgtype?: string;
  extra?: Record<string, unknown>;
}

export interface TgBotConfig {
  apiHost?: string;
  token: string;
  /** ⚠ snake_case（见文件头第 3 条）。 */
  chat_id?: unknown;
  /** ⚠ snake_case。 */
  disable_web_page_preview?: boolean;
  proxy?: string;
  extra?: Record<string, unknown>;
}

export interface BarkConfig {
  key: string;
  level?: string;
  extra?: Record<string, unknown>;
}

export interface TwoImConfig {
  key: string;
  sid: string;
  msgtype?: string;
  query?: { plat?: string; group?: string; icon?: unknown; extra?: Record<string, unknown> };
  extra?: Record<string, unknown>;
}

export interface DingTalkConfig {
  token: string;
  secret?: string;
  extra?: Record<string, unknown>;
}

export interface EmailConfig {
  host: string;
  from: string;
  pass: string;
  port?: number;
  user?: string;
  to?: string;
  tls?: string;
  extra?: Record<string, unknown>;
}

/** 自定义模板的一条。 */
export interface CustomPostItem {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: Record<string, unknown>;
  body?: Record<string, unknown>;
  timeout?: number;
}

/** 整个推送配置。**每个渠道都是可选的** —— 没配就是不发。 */
export interface PushConfig {
  title?: string;
  pushplus?: TokenConfig;
  serverChan?: TokenConfig;
  workWeixin?: WorkWeixinConfig;
  workWeixinBot?: WorkWeixinBotConfig;
  tgBot?: TgBotConfig;
  bark?: BarkConfig;
  twoIm?: TwoImConfig;
  dingTalk?: DingTalkConfig;
  email?: EmailConfig;
  customPost?: CustomPostItem[];
}

/** 默认标题（参考实现里 `default_title`）。 */
export const DEFAULT_TITLE = '云盘任务';

// ══════════════════════════════ 编码小工具 ══════════════════════════════

/** `encodeURIComponent` 的等价物。
 *
 *  ⚠ **不能**用 `URLSearchParams`：它把空格编成 `+`，而 `encodeURIComponent`
 *  编成 `%20`。钉钉的签名进查询串时这个差别会让签名对不上（服务端算的是 `%20`）。 */
export function encodeUriComponent(s: string): string {
  return encodeURIComponent(s);
}

/** 表单串：`k=v&k=v`，键与值都按 `encodeURIComponent` 转义。 */
export function formUrlencode(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${encodeUriComponent(k)}=${encodeUriComponent(v)}`).join('&');
}

/** JS 的"真值"口径：空串 / `0` / `null` / `undefined` / `false` / `NaN` 都算假。
 *
 *  ⚠ Telegram 的 `chat_id` 是**数字或字符串都合法**（群 ID 是负数），
 *  所以判"缺没缺"必须按 JS 真值，不能按"是不是空串"。 */
export function jsTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'string') return v !== '';
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return true;
}

/** `base64(HmacSHA256(key, message))` —— 钉钉签名用。 */
export function hmacSha256Base64(key: string, message: string): string {
  return toBase64(hmacSha256(utf8(key), utf8(message)));
}

// ══════════════════════════════ 各渠道的请求构造（纯函数） ══════════════════════════════

function postJson(url: string, body: Record<string, unknown>): BuiltRequest {
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** 建一个请求，或说明**为什么跳过**。 */
export type Built = { ok: true; request: BuiltRequest } | { ok: false; skip: string };

export function buildPushplus(c: TokenConfig, title: string, text: string): Built {
  return {
    ok: true,
    request: postJson('http://www.pushplus.plus/send', {
      token: c.token,
      title,
      content: text,
      ...(c.extra ?? {}),
    }),
  };
}

/** Server酱。⚠ `desp` 里每个换行**翻倍**（TS 原文）。 */
export function buildServerChan(c: TokenConfig, title: string, text: string): Built {
  return {
    ok: true,
    request: postJson(`https://sctapi.ftqq.com/${c.token}.send`, {
      text: title,
      title,
      desp: text.replace(/\n/g, '\n\n'),
      ...(c.extra ?? {}),
    }),
  };
}

/** 企业微信**第一步**：用 corpid + corpsecret 换 `access_token`。 */
export function buildWorkWeixinToken(c: WorkWeixinConfig): BuiltRequest {
  const body: Record<string, unknown> = {};
  if (c.corpid !== undefined) body['corpid'] = c.corpid;
  if (c.corpsecret !== undefined) body['corpsecret'] = c.corpsecret;
  return postJson('https://qyapi.weixin.qq.com/cgi-bin/gettoken', body);
}

/** 企业微信**第二步**：`agentid` + 动态类型键（`text` / `markdown` …）。 */
export function buildWorkWeixinMessage(
  c: WorkWeixinConfig,
  accessToken: string,
  title: string,
  text: string,
): BuiltRequest {
  const msgtype = c.msgtype ?? 'text';
  const body: Record<string, unknown> = {
    touser: c.touser ?? '@all',
    msgtype,
  };
  if (c.agentid !== undefined) body['agentid'] = c.agentid;
  body[msgtype] = { content: `${title}\n\n${text}` };
  return postJson(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
    { ...body, ...(c.extra ?? {}) },
  );
}

/** 企业微信机器人：一个 webhook URL，动态类型键。 */
export function buildWorkWeixinBot(c: WorkWeixinBotConfig, title: string, text: string): Built {
  const msgtype = c.msgtype ?? 'text';
  const body: Record<string, unknown> = { msgtype };
  body[msgtype] = { content: `${title}\n\n${text}` };
  return { ok: true, request: postJson(c.url, { ...body, ...(c.extra ?? {}) }) };
}

/** Telegram Bot。缺 `token` 或 `chat_id` 时**跳过**（不是塞个 null 发上去）。 */
export function buildTgBot(c: TgBotConfig, title: string, text: string): Built {
  if (c.token === '' || !jsTruthy(c.chat_id)) {
    return { ok: false, skip: '缺少 token 或 chat_id' };
  }
  const host = c.apiHost ?? 'api.telegram.org';
  const body: Record<string, unknown> = {
    disable_web_page_preview: c.disable_web_page_preview ?? true,
  };
  if (c.chat_id !== undefined) body['chat_id'] = c.chat_id;
  if (c.proxy !== undefined) body['proxy'] = c.proxy;
  Object.assign(body, c.extra ?? {});
  // ⚠ `text` 排在展开**之后** ⇒ 永远由它收尾（TS 的字段顺序就是这样）
  body['text'] = `${title}\n\n${text}`;
  return { ok: true, request: postJson(`https://${host}/bot${c.token}/sendMessage`, body) };
}

/** Bark（iOS）。缺 `key` 时跳过。 */
export function buildBark(c: BarkConfig, title: string, text: string): Built {
  if (c.key === '') return { ok: false, skip: '缺少 key' };
  return {
    ok: true,
    request: postJson(`https://api.day.app/${c.key}`, {
      body: text,
      title,
      level: c.level ?? 'passive',
      ...(c.extra ?? {}),
    }),
  };
}

/** 回逍（2Im）。`key` / `sid` 走查询串，其余走请求体。 */
export function buildTwoIm(c: TwoImConfig, title: string, text: string): Built {
  const pairs: [string, string][] = [
    ['key', c.key],
    ['sid', c.sid],
  ];
  const q = c.query;
  if (q) {
    if (q.plat !== undefined) pairs.push(['plat', q.plat]);
    if (q.group !== undefined) pairs.push(['group', q.group]);
    if (q.icon !== undefined) pairs.push(['icon', String(q.icon)]);
    for (const [k, v] of Object.entries(q.extra ?? {})) pairs.push([k, String(v)]);
  }
  return {
    ok: true,
    request: postJson(`https://api.2im.cn/push?${formUrlencode(pairs)}`, {
      msgtype: c.msgtype ?? 'text',
      content: text,
      title,
      ...(c.extra ?? {}),
    }),
  };
}

/** 钉钉机器人：有 `secret` 就加签。
 *
 *  签名逐字照 TS：以 secret 为密钥、以「毫秒时间戳 + 换行 + secret」为消息做
 *  HmacSHA256，结果 base64 后按 `encodeURIComponent` 转义进查询串。
 *
 *  ⚠ `timestampMs` 由调用方传入（不从 `Date.now()` 取）—— 这样这个构造函数
 *  是**纯的**，测试可以用固定向量钉住签名。 */
export function buildDingTalk(
  c: DingTalkConfig,
  title: string,
  text: string,
  timestampMs: number,
): Built {
  let query = '';
  if (c.secret !== undefined && c.secret !== '') {
    const sign = hmacSha256Base64(c.secret, `${timestampMs}\n${c.secret}`);
    query = `&timestamp=${timestampMs}&sign=${encodeUriComponent(sign)}`;
  }
  return {
    ok: true,
    request: postJson(
      `https://oapi.dingtalk.com/robot/send?access_token=${c.token}${query}`,
      {
        msgtype: 'text',
        // ⚠ 正文前面那个**前导空格**是 TS 原文，别顺手删掉
        text: { content: ` ${title}\n\n${text}` },
        ...(c.extra ?? {}),
      },
    ),
  };
}

/** 自定义模板。`url` 为空 ⇒ 跳过（TS 的 `if (!apiTemplate?.url) return;`）。
 *
 *  # 替换规则**两处不一样**（逐字照 TS）
 *
 *  - **URL**：`{title}` / `{text}` 各自只替换**第一次**，值按 `encodeURIComponent` 转义；
 *  - **请求体**：`{title}` / `{text}` 全局替换且**不转义**，替换完再把真实的
 *    换行/回车转成字面量再 `JSON.parse` 回去 —— 所以正文里的换行能活，
 *    而标题里带引号会让这一步解析失败（TS 落进 catch），这里相应地报错。 */
export function buildCustomPost(
  item: CustomPostItem,
  title: string,
  text: string,
): { ok: true; request: BuiltRequest } | { ok: false; skip: string } | { ok: false; error: string } {
  if (item.url === '') return { ok: false, skip: '这个模板没有 URL' };

  const method = (item.method ?? 'POST').toUpperCase() as BuiltRequest['method'];
  const url = item.url
    .replace('{title}', encodeUriComponent(title))
    .replace('{text}', encodeUriComponent(text));

  // JS 的 `data || body`：`data` 只要**存在**（哪怕空对象，空对象在 JS 里是真值）就取胜
  const fields = item.data ?? item.body;
  let body: string | undefined;
  if (fields !== undefined && Object.keys(fields).length > 0) {
    const raw = JSON.stringify(fields);
    const patched = raw
      .replace(/\{title\}/g, title)
      .replace(/\{text\}/g, text)
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    try {
      JSON.parse(patched);
      body = patched;
    } catch (e) {
      return { ok: false, error: `模板体替换后不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return {
    ok: true,
    request: {
      url,
      method,
      headers: { ...(item.headers ?? {}) },
      body,
    },
  };
}

// ══════════════════════════════ 计划与投递 ══════════════════════════════

/** 投递时要用到的宿主能力。**注入**（这个文件不引 host-api）。 */
export interface PushDeps {
  /** 发一个 HTTP 请求。 */
  http(req: BuiltRequest): { ok: boolean; status: number; body: string; error?: string | undefined };
  /** 发一封邮件（面板的 `smtp_send`）。形状见 `host-api.d.ts` 的 `SmtpOpts`。 */
  smtp(opts: {
    host: string;
    port?: number;
    tls?: string;
    user?: string;
    pass: string;
    from: string;
    to: string;
    subject: string;
    text: string;
  }): { ok: boolean; response: string };
  /** 当前毫秒时间戳（钉钉签名要用）。 */
  nowMs(): number;
  log(msg: string): void;
}

/** 一条渠道这一次的结果。 */
export interface ChannelResult {
  channel: PushChannel;
  label: string;
  /** `sent` = 发出去了；`skipped` = 没配/缺字段（**不是失败**）；`failed` = 发了但没成。 */
  outcome: 'sent' | 'skipped' | 'failed';
  note: string;
}

/** 一次推送的总结果。 */
export interface PushResult {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  results: ChannelResult[];
  /** 一句话（界面上显示的就是它）。 */
  line: string;
}

/** 按配置发一条。**每个配了的渠道都发一遍**，一个失败不影响别的。 */
export function sendPush(
  deps: PushDeps,
  config: PushConfig,
  title: string,
  text: string,
): PushResult {
  const results: ChannelResult[] = [];
  const add = (channel: PushChannel, outcome: ChannelResult['outcome'], note: string): void => {
    results.push({ channel, label: CHANNEL_LABELS[channel], outcome, note });
  };

  /** 发一个已经建好的请求，按 HTTP 状态归结果。 */
  const deliver = (channel: PushChannel, built: Built): void => {
    if (!built.ok) {
      add(channel, 'skipped', built.skip);
      return;
    }
    const res = deps.http(built.request);
    if (!res.ok) {
      add(channel, 'failed', res.error ?? `HTTP ${res.status}`);
      return;
    }
    // ⚠ 200 之外都算失败。**不看响应体里的 `errcode`** —— 参考实现里只有
    //   自定义模板那条路不看（它连状态码都不判）；其余渠道统一按 HTTP 状态。
    if (res.status < 200 || res.status >= 300) {
      add(channel, 'failed', `HTTP ${res.status}`);
      return;
    }
    add(channel, 'sent', `HTTP ${res.status}`);
  };

  // ① pushplus
  if (config.pushplus) deliver('pushplus', buildPushplus(config.pushplus, title, text));
  // ② Server酱
  if (config.serverChan) deliver('serverChan', buildServerChan(config.serverChan, title, text));

  // ③ 企业微信应用：**两步**
  if (config.workWeixin) {
    const c = config.workWeixin;
    const tok = deps.http(buildWorkWeixinToken(c));
    let accessToken: string | undefined;
    if (tok.ok && tok.status >= 200 && tok.status < 300) {
      try {
        const j = JSON.parse(tok.body) as Record<string, unknown>;
        if (typeof j['access_token'] === 'string') accessToken = j['access_token'];
      } catch {
        /* 不是 JSON ⇒ 下面统一按"没拿到"处理 */
      }
    }
    if (accessToken === undefined) {
      // ⚠ 拿不到 token 就**跳过并说清楚**，不拿一个假 token 再打一枪 ——
      //   那只会往上游留一条失败记录，而真正的原因（corpid 不对）看不出来。
      add('workWeixin', 'failed', tok.ok ? '换 access_token 失败（响应里没有）' : `换 access_token 失败：${tok.error ?? `HTTP ${tok.status}`}`);
    } else {
      deliver('workWeixin', {
        ok: true,
        request: buildWorkWeixinMessage(c, accessToken, title, text),
      });
    }
  }

  // ④ 企业微信机器人
  if (config.workWeixinBot) deliver('workWeixinBot', buildWorkWeixinBot(config.workWeixinBot, title, text));
  // ⑤ Telegram
  if (config.tgBot) deliver('tgBot', buildTgBot(config.tgBot, title, text));
  // ⑥ Bark
  if (config.bark) deliver('bark', buildBark(config.bark, title, text));
  // ⑦ 回逍
  if (config.twoIm) deliver('twoIm', buildTwoIm(config.twoIm, title, text));
  // ⑧ 钉钉
  if (config.dingTalk) deliver('dingTalk', buildDingTalk(config.dingTalk, title, text, deps.nowMs()));

  // ⑨ 邮件：**走面板的 `smtp_send`**（不是 HTTP）
  if (config.email) {
    const e = config.email;
    if (e.host === '' || e.from === '') {
      add('email', 'skipped', '缺少 host 或 from');
    } else {
      try {
        const r = deps.smtp({
          host: e.host,
          ...(e.port !== undefined ? { port: e.port } : {}),
          ...(e.tls !== undefined ? { tls: e.tls } : {}),
          ...(e.user !== undefined ? { user: e.user } : {}),
          pass: e.pass,
          from: e.from,
          to: e.to ?? '',
          subject: title,
          text,
        });
        if (r.ok) add('email', 'sent', r.response.slice(0, 80));
        else add('email', 'failed', r.response.slice(0, 120));
      } catch (err) {
        // `smtp_send` 失败是**抛错**，错误文本是服务器那句原话（`535 bad credentials`）
        add('email', 'failed', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ⑩ 自定义模板（**可以有多条**）
  if (config.customPost && config.customPost.length > 0) {
    let anySent = false;
    let anyFailed = false;
    for (const item of config.customPost) {
      const built = buildCustomPost(item, title, text);
      if (!built.ok) {
        if ('skip' in built) add('customPost', 'skipped', built.skip);
        else {
          anyFailed = true;
          add('customPost', 'failed', built.error);
        }
        continue;
      }
      const res = deps.http(built.request);
      if (!res.ok) {
        anyFailed = true;
        add('customPost', 'failed', res.error ?? `HTTP ${res.status}`);
      } else if (res.status < 200 || res.status >= 300) {
        anyFailed = true;
        add('customPost', 'failed', `HTTP ${res.status}`);
      } else {
        anySent = true;
        add('customPost', 'sent', `HTTP ${res.status}`);
      }
    }
    void anySent;
    void anyFailed;
  }

  const sent = results.filter((r) => r.outcome === 'sent').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;

  // 一句话结论。**没配任何渠道时要说清是"没配"**，而不是"发了 0 条成功"
  let line: string;
  if (results.length === 0) line = '没有配置推送渠道';
  else if (failed > 0) line = `${sent} 个渠道发到了，${failed} 个失败${skipped > 0 ? `，${skipped} 个跳过` : ''}`;
  else if (sent > 0) line = `${sent} 个渠道发到了${skipped > 0 ? `，${skipped} 个跳过` : ''}`;
  else line = `${skipped} 个渠道都跳过了（没配全）`;

  return { attempted: sent + failed, sent, skipped, failed, results, line };
}

/** 配置里到底配了哪些渠道（界面用；**不判"配得全不全"**，只看有没有这一栏）。 */
export function configuredChannels(config: PushConfig): PushChannel[] {
  return CHANNELS.filter((c) => {
    if (c === 'customPost') return (config.customPost ?? []).length > 0;
    return config[c] !== undefined && config[c] !== null;
  });
}
