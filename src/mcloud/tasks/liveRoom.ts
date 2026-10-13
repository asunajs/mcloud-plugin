// 任务：直播口令（`live-room`）—— **只读那一半**。
//
// 写的那半是「拿口令去领小红花」（写、会入群足迹、不可回滚），还没做。
// 这一半做的是：**抓口令发布方的小红书公开主页 → 解出最新一条口令 → 列出来**。
//
// # 为什么这条任务"只读"却值得单独做
//
// ① 口令是**全实例共享**的资源（任何账号拿到一条，别的账号都能拿去领小红花）。
//    所以"看到口令"本身就是有价值的产出，不需要先有写的那半。
// ② 它是**第一条不需要凭据的任务** —— 主页是公开 GET，与云盘账号无关。
//    于是它能在"还没导入会话"的机器上先跑起来，也能在凭据失效时继续提供信息
//    （凭据失效是所有签到任务共同的失败原因，这条恰好不受影响）。
// ③ 抓到的口令要有人**看**。只写进日志等于没有 —— 所以读数落库 + 界面卡片。
//
// # 一条硬约束：整条任务**只发一个请求**
//
// 面板的单次执行预算默认 2000ms，而且**打断不了正在阻塞的宿主调用**
// （见 docs/findings.md F-001 那一族）。所以这里只发"抓主页"这一枪，
// 不做任何后续动作 —— 一次 handler 调用一步，状态落 SQLite。
//
// ⚠️ 与 `callOnce` 那条路不同的是：这条路**不需要会话**（没有凭据可失效），
// 所以它**不走 base.ts 的 `runTask`** —— 那个底座的第二步就是"没有会话就别打上游"，
// 而这条任务恰恰没有会话也能打。共用底座会把它挡在门外。
//
// # 两个如实说清楚的地方
//
// ① **空壳页面与"这期没有口令"长得一模一样**（都是解出空数组）。
//    小红书对非常规 UA 会回一个空壳，而空壳页与"主播这期没发"在解析层无法区分
//    —— 源码里明说了这一点。所以 note 里两种可能都要提，并且**如实报出页面大小**
//    （小于一个阈值时给一条**标注为猜测**的提示，不当作判据）。
// ② 抓到了也**不代表能用**：口令由服务端当场校验，且只在直播那一小时有效。
//    这里只负责"我看到了什么"，不替上游下结论。

import { callRawText } from '../client.ts';
import { clearError, recordError } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import {
  XIAOHONGSHU_KOULING_PROFILE_URL,
  extractKoulingFromXiaohongshuHtml,
  parseCodeInput,
  xiaohongshuProfileHeaders,
} from '../liveKouling.ts';
import type { Store } from '../../store/types.ts';

/** 最近一次抓主页的读数。 */
export const STATE_READING = 'mcloud.live.reading';
/** 人给的口令（输入口）。 */
export const STATE_CODES = 'mcloud.live.codes';
/** 口令主页地址（可改）。 */
export const STATE_LIVE_URL = 'mcloud.live.url';

/** 抓哪个主页。**可配置**，不是写死的常量 —— 两个理由：
 *
 *  ① 发布方**可能换账号**（这是迟早的事）。写死的话换一次就要改一次代码、发一版；
 *  ② CI 要能把它指到 mock。仓库的纪律是「CI 全程只打 mock」，而这条链是**唯一**
 *     会打第三方站点的 —— 不给出这个口子，CI 就得去敲小红书，那既不稳也不该。
 *
 *  ⚠ 与 `baseUrl` **不是一回事**：`baseUrl` 替换的是 mcloud 端点的**源**
 *  （端点自带路径），这里要的是一个**完整 URL**（第三方页面有自己的路径）。
 *  两个语义混成一个，就会写出「指到 mock 之后路径丢了」这种错。 */
export function loadLiveUrl(store: Pick<Store, 'getState'>): string {
  const v = store.getState(STATE_LIVE_URL);
  return v && v.trim() ? v.trim() : XIAOHONGSHU_KOULING_PROFILE_URL;
}

export function saveLiveUrl(store: Store, url: string, nowIso: string): void {
  store.setState(STATE_LIVE_URL, url.trim().replace(/\/+$/, ''), nowIso);
}

/** 页面小于这个大小就**猜**它是空壳（UA 被挡）。
 *
 *  ⚠ 这是**提示，不是判据** —— 我没有"小红书主页最小真实大小"的实拍样本。
 *  真实主页是几百 KB 级别，5 KB 无论如何装不下一页笔记列表，所以这个阈值取保守值。
 *  界面上必须写明它是猜的；把它当判据（例如"小于它就报失败"）就是编造结论。 */
export const EMPTY_SHELL_HINT_CHARS = 5000;

export interface LiveReading {
  at: string;
  url: string;
  /** 这次抓到的口令（**最多一条笔记**的解析结果 —— 第一条命中即返回） */
  codes: string[];
  /** 页面大小（UTF-16 码元数），用于区分"空壳"与"这期没有" */
  chars: number;
  tookMs: number;
  /** 解析层分不清空壳与"没发"，所以这里如实留一句两种可能 */
  note: string;
}

export interface LiveCodes {
  at: string;
  codes: string[];
  /** 人贴进来的原文（口令**不是**账号凭据 —— 它是共享资源，所以不必脱敏） */
  raw: string;
  /** 这次是怎么解出来的（`parseCodeInput` 给的那句话） */
  how: string;
}

/** 抓一次主页并解出口令（**只读**：一个字节都不往上游写）。 */
export function runLiveRoom(deps: TaskDeps): TaskOutcome {
  const url = loadLiveUrl(deps.store);
  const res = callRawText(deps.transport, {
    url,
    method: 'GET',
    headers: xiaohongshuProfileHeaders(),
    body: undefined,
  });

  if (!res.ok) {
    const note = `抓小红书主页失败：${res.error ?? '未知失败'}`;
    recordError(deps.store, 'live-room', note, deps.nowIso);
    return { ok: false, note };
  }

  const codes = extractKoulingFromXiaohongshuHtml(res.text);
  const guess = res.chars < EMPTY_SHELL_HINT_CHARS;
  const note = codes.length
    ? `小红书主页：${codes.length} 条口令（${codes.join('、')}）`
    : `小红书主页：没读到口令（页面 ${res.chars} 字符）` +
      (guess
        ? ` —— 页面小得可疑，**猜**是被挡成了空壳（不是判据）`
        : ` —— 也可能是这期没发：空壳页与"没发"在解析层长得一样`);

  const reading: LiveReading = {
    at: deps.nowIso,
    url,
    codes,
    chars: res.chars,
    tookMs: res.tookMs,
    note,
  };
  deps.store.setState(STATE_READING, JSON.stringify(reading), deps.nowIso);

  // 没读到口令**不算失败** —— 那多半是"这期没发"，报红只会在面板上刷出一片噪声，
  // 而"抓不到"这件事已经由读数与 note 说清了（读数里 chars 是原始证据）。
  clearError(deps.store, 'live-room', deps.nowIso);
  return { ok: true, note };
}

/** 界面读这个（最近一次读数）。 */
export function readLiveReading(store: Pick<Store, 'getState'>): LiveReading | null {
  return parseJson<LiveReading>(store.getState(STATE_READING));
}

/** 界面读这个（人给的口令）。 */
export function loadLiveCodes(store: Pick<Store, 'getState'>): LiveCodes | null {
  return parseJson<LiveCodes>(store.getState(STATE_CODES));
}

/** 存人给的口令。解析失败时**什么都不写**（半截数据比没有更难查）。 */
export function saveLiveCodes(
  store: Store,
  raw: string,
  nowIso: string,
): { ok: boolean; codes: string[]; how: string; error?: string } {
  const parsed = parseCodeInput(raw);
  if (!parsed.ok) return { ok: false, codes: [], how: '', error: parsed.error ?? '解不出口令' };
  const v: LiveCodes = { at: nowIso, codes: parsed.codes, raw: raw.trim(), how: parsed.how };
  store.setState(STATE_CODES, JSON.stringify(v), nowIso);
  return { ok: true, codes: parsed.codes, how: parsed.how };
}

export function clearLiveCodes(store: Store, nowIso: string): void {
  store.setState(STATE_CODES, '', nowIso);
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 存坏了就当作没有 —— 让界面显示"还没读到"，而不是拿半截数据渲染出假象
    return null;
  }
}
