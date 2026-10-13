// 上游调用层。
//
// 三个设计决定，都不是随手定的：
//
// ① **transport 可注入**。插件里注入 `host.http_fetch`（同步阻塞、没有异步），
//    Node 测试里注入桩或 mock 上游。构造逻辑与发送逻辑因此可以分开测。
//
// ② **一次调用只发一个请求**。面板的单次执行预算只有 2000ms（`EXEC_BUDGET_MS`），
//    而且**打断不了正在阻塞的宿主调用** —— 一个 5 秒的请求会跑完，然后任务被判超时
//    （上游动作已发生、任务却报失败）。所以整个插件按「可恢复步骤机」写：
//    一次 handler 调用只推进一步，状态落 SQLite。这个约束在这里体现为
//    `callOnce()` 而不是「一个流程函数」。
//
// ③ **上游错误不抛异常，返回结构化结果**。步骤机要能区分「业务失败（可以重试）」
//    与「环境炸了（应该停下来）」——用异常表达会让调用方到处 try/catch，
//    而且一旦漏 catch，任务会以「未知异常」结束，排查时看不到上游原话。

import type { FetchError, FetchResult } from 'host-api';

/** 宿主 `http_fetch` 的返回：成功是 `FetchResult`，失败是 `FetchError`。
 *  （插件里由 main.ts 注入真实的 `http_fetch`，测试里注入桩 —— 桩也必须能造出失败形状，
 *  否则测不到这条路径。） */
export type HostFetchResult = FetchResult | FetchError;

const isFetchError = (v: unknown): v is FetchError =>
  typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string';

/** 宿主消息里已经带了「请求失败:」就原样用，避免叠成「请求失败：请求失败: …」。 */
function pickError(msg: string): string {
  return msg.replace(/^\s*请求失败[:：]\s*/, '').trim() || msg;
}
import { parseSignInEnvelope } from './envelope.ts';
import type { SignInEnvelope } from './envelope.ts';
import type { BuiltRequest } from './h5.ts';

/** 发送一个请求。返回值与 `host.http_fetch` 一致，便于直接用宿主实现。 */
export type Transport = (req: BuiltRequest) => HostFetchResult;

export interface CallResult {
  /** HTTP 状态码；网络层直接失败时为 0 */
  status: number;
  /** 请求本身的耗时（毫秒）—— 用来盯执行预算 */
  tookMs: number;
  /** 解析出来的签到族信封；HTTP 失败或非 JSON 时为 undefined */
  env: SignInEnvelope | undefined;
  /** `env.ok`（HTTP 200 且 code === 0） */
  ok: boolean;
  /** 失败原因（人话，带上游原话） */
  error: string | undefined;
  /** 原始响应体（截断到 500 字符，进日志用） */
  raw: string;
  /** 响应里的 set-cookie（已解析成 k=v 列表） */
  setCookies: string[];
}

/** 一次请求的耗时超过这个值就在日志里点名。
 *
 *  面板的单次执行预算默认 2000ms。单次 HTTP 一旦接近它，任务就会在**上游动作已经发生**
 *  之后被判超时（见 docs/findings.md F-001/预算那条），所以这个阈值是预警线，不是装饰。 */
export const SLOW_CALL_MS = 1500;

export function callOnce(transport: Transport, req: BuiltRequest): CallResult {
  const t0 = Date.now();
  const fail = (error: string): CallResult => ({
    status: 0,
    tookMs: Date.now() - t0,
    env: undefined,
    ok: false,
    error,
    raw: '',
    setCookies: [],
  });

  let res: HostFetchResult;
  try {
    res = transport(req);
  } catch (e) {
    return fail(`请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ⚠️ 宿主失败时返回的是 `{"error": "…"}`，**没有 body** —— 先认形状再取字段。
  // 不这么写就会在下面读 `res.body.length` 时抛 TypeError，而报错位置在插件里，
  // 看起来像插件自己的 bug（实测踩过，见 docs/findings.md F-006）。
  // 宿主自己的消息里常常已经带了「请求失败:」，别再叠一层 —— 否则日志里会出现
  // 「请求失败：请求失败: http status: 405」，读起来像两个错误
  if (isFetchError(res)) return fail(pickError(res.error));
  if (typeof res !== 'object' || res === null || typeof res.body !== 'string') {
    // 形状再变也不该让插件崩：说清收到了什么，然后当失败处理
    return fail(`请求返回的形状不认识：${JSON.stringify(res)?.slice(0, 200) ?? String(res)}`);
  }

  const tookMs = Date.now() - t0;
  const raw = res.body.length > 500 ? `${res.body.slice(0, 500)}…` : res.body;

  let env: SignInEnvelope | undefined;
  let error: string | undefined;
  if (res.status !== 200) {
    error = `HTTP ${res.status}`;
  } else {
    try {
      env = parseSignInEnvelope(res.body);
      if (!env.ok) error = `code=${env.code}${env.message ? ` msg=${env.message}` : ''}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    status: res.status,
    tookMs,
    env,
    ok: res.status === 200 && !!env?.ok,
    error,
    raw,
    setCookies: extractSetCookies(res.headers),
  };
}

/** 原样取回响应**文本**的结果。 */
export interface RawTextResult {
  ok: boolean;
  status: number;
  /** 响应体原文（**不截断** —— 调用方要拿它做解析） */
  text: string;
  /** `text.length`（UTF-16 码元数，不是字节数）。用于在界面上说清"页面多大" */
  chars: number;
  tookMs: number;
  error: string | undefined;
}

/** 发一个请求并**原样**拿回文本（不解析信封）。
 *
 *  为什么不让 `callOnce` 加个开关：两者的**契约不同**。
 *  `callOnce` 的契约是"签到族信封"（JSON + `code` 字段），失败要能区分
 *  「业务失败（可重试）」与「环境炸了（该停）」。而这里要拿的是**第三方页面的 HTML**
 *  —— 拿信封去解必然失败，且失败信息会误导（`code=undefined` 看起来像上游坏了）。
 *  两条路的失败语义不一样，所以分成两个函数。
 *
 *  ⚠️ 这里**不做 500 字符截断**（`callOnce` 的 `raw` 截断是给日志用的）——
 *  调用方要拿全文做正则。页面大小由 `chars` 如实报出去，别在解析前就把内容丢了。 */
export function callRawText(transport: Transport, req: BuiltRequest): RawTextResult {
  const t0 = Date.now();
  const fail = (error: string): RawTextResult => ({
    ok: false,
    status: 0,
    text: '',
    chars: 0,
    tookMs: Date.now() - t0,
    error,
  });

  let res: HostFetchResult;
  try {
    res = transport(req);
  } catch (e) {
    return fail(`请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const tookMs = Date.now() - t0;

  // 与 callOnce 同一套形状识别（宿主失败时返回 `{"error": …}`，没有 body）
  if (isFetchError(res)) return { ...fail(pickError(res.error)), tookMs };
  if (typeof res !== 'object' || res === null || typeof res.body !== 'string') {
    return {
      ...fail(`请求返回的形状不认识：${JSON.stringify(res)?.slice(0, 200) ?? String(res)}`),
      tookMs,
    };
  }

  const chars = res.body.length;
  if (res.status !== 200) {
    // 非 200 也把 body 带回去：有些站点把错误说明写在正文里，日志里看得到比只看状态码有用
    return { ok: false, status: res.status, text: res.body, chars, tookMs, error: `HTTP ${res.status}` };
  }
  return { ok: true, status: 200, text: res.body, chars, tookMs, error: undefined };
}

/** 从响应头里取 set-cookie。
 *
 *  ⚠ 这里保守处理：不同层可能把多枚 `set-cookie` 合成了一个字符串，
 *  而 cookie 的值里**可以带逗号**（`Expires=Wed, 21 Oct 2015 …`）——
 *  所以不能简单按逗号切。只在逗号后面看起来像 `名字=` 时才认为是新的一枚。 */
export function extractSetCookies(headers: Record<string, string>): string[] {
  const raw: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'set-cookie') raw.push(v);
  }
  const out: string[] = [];
  for (const line of raw) {
    let cur = line;
    // 找出「逗号 + 空格 + 名字=」的位置，切成多枚
    const parts: string[] = [];
    let idx = 0;
    for (;;) {
      const m = /,\s*([A-Za-z0-9_.-]+)=/.exec(cur.slice(idx));
      if (!m || m.index === undefined) break;
      parts.push(cur.slice(idx, idx + m.index));
      idx += m.index + 1;
    }
    parts.push(cur.slice(idx));
    for (const p of parts) {
      cur = p.trim();
      if (!cur) continue;
      // 只取 `k=v` 那一段（丢掉 Path/Expires 等属性）
      const pair = cur.split(';')[0]?.trim() ?? '';
      if (pair.includes('=')) out.push(pair);
    }
  }
  return out;
}

/** 把 `k=v` 列表并进 cookie 串（同名覆盖）。 */
export function mergeCookieJar(existing: string, incoming: string[]): string {
  const jar = new Map<string, string>();
  const eat = (s: string) => {
    for (const part of s.split(';')) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      if (v === '' || /^(deleted|expired)$/i.test(v)) jar.delete(k);
      else jar.set(k, v);
    }
  };
  eat(existing);
  for (const c of incoming) eat(c);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
