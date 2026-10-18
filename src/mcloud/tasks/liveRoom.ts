// 任务：直播口令（`live-room`）—— **只读那一半**。
//
// 写的那半是「拿口令去领小红花」（写、会入群足迹、不可回滚），在 `liveDraw.ts`。
// 这一半做的是：**抓口令发布方的小红书公开主页 → 解出最新一条口令 → 列出来**。
//
// # ⚠ 2026-10-14：口令不再"抓完就扔"，而是**进共享池**（业务档，照 mcloud）
//
// 池在 `../koulingPool.ts`（判据照 mcloud 的 `mcloud-core/src/kouling.rs`），
// 本文件是它的**生产者**之一（另一个是人工粘贴，经 `liveDraw` 验证后进池）。
// 由此多出两条**口径**，两条都是 mcloud 已有的、不是我发明的：
//
// ```text
//   ① 够 2 条**有效**口令 ⇒ 停止抓取（VALID_ENOUGH / stopScraping）
//   ② 两次抓主页之间至少隔 30 分钟（XHS_MIN_INTERVAL_MS）
// ```
//
// ① 的理由：一场直播只发那么几条，验出两条有效之后继续抓**只会重复撞同一批**，
// 而每一次抓取都在给对方风控送样本。② 的理由更硬：**风控挡下的表现是"页面里没有口令"**，
// 与"这一期还没发笔记"在解析层**长得一模一样** —— 抓太勤会把"没发"和"被挡"
// 混成同一个现象，连排查都没有下手处。
//
// 两条都标成 `idle`（不是失败）：它们说的是"按口径不该抓"，不是"抓失败"。
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
//    这里只负责"我看到了什么"，不替上游下结论 —— 判它有效/无效的唯一途径是
//    拿去领（见 `liveDraw`），而结论由它写回池。


import { callRawText } from '../client.ts';
import { clearError, recordError } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';
import {
  XIAOHONGSHU_KOULING_PROFILE_URL,
  checkCodeLimits,
  extractKoulingFromXiaohongshuHtml,
  isKoulingMarker,
  isQuestion,
  parseCodeInput,
  trimKoulingTail,
  xiaohongshuProfileHeaders,
} from '../liveKouling.ts';
import {
  loadPoolFrom,
  normalize,
  note as notePoolCodes,
  noteXhs,
  poolSummary,
  savePoolTo,
  stopScraping,
  validCount,
  xhsReady,
  xhsWaitMs,
} from '../koulingPool.ts';
import type { PoolSummary } from '../koulingPool.ts';
import { mergeKouling, splitKouling } from './liveRoomRules.ts';
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
  const nowMs = Date.parse(deps.nowIso);
  const loaded = loadPoolFrom(deps.store);
  const pool = loaded.pool;
  normalize(pool, nowMs);

  // ① 够 2 条**有效** ⇒ 按口径**停止抓取**（见文件头；判据在 koulingPool.stopScraping）。
  if (stopScraping(pool)) {
    return {
      ok: true,
      idle: true,
      note: `已经有 ${validCount(pool)} 条能用的口令了，不用再抓`,
    };
  }

  // ② 小红书主页限速：两次之间至少 30 分钟（见 XHS_MIN_INTERVAL_MS 的理由）。
  if (!xhsReady(pool, nowMs)) {
    const mins = Math.ceil(xhsWaitMs(pool, nowMs) / 60000);
    return {
      ok: true,
      idle: true,
      // 原因留给代码注释，日志只说"什么时候再看"
      note: `刚看过，${mins} 分钟后再看`, 
    };
  }

  // ⚠ 在**动手之前**记（成功失败都记）：抓完再记等于整个窗口都敞着。
  noteXhs(pool, nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);

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
  // 进池（**来源如实标 xiaohongshu**）。已判无效的不会再进池（见 koulingPool.note）。
  const added = notePoolCodes(pool, codes, 'xiaohongshu', nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);

  const guess = res.chars < EMPTY_SHELL_HINT_CHARS;
  const reset = loaded.reset ? '（⚠ 盘上那份池解不出来，已按空池重开 —— 这一场的领取记录丢了）' : '';
  const poolLine = `池：新增 ${added} 条，有效 ${validCount(pool)} 条${stopScraping(pool) ? '（已够 2 条 ⇒ 停止抓取）' : ''}`;
  const note = codes.length
    ? `小红书主页：${codes.length} 条口令（${codes.join('、')}）· ${poolLine}`
    : `小红书主页：没读到口令（页面 ${res.chars} 字符）· ${poolLine}` +
      (guess
        ? ` —— 页面小得可疑，**猜**是被挡成了空壳（不是判据）`
        : ` —— 也可能是这期没发：空壳页与"没发"在解析层长得一样`) +
      reset;

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

/** 界面读这个：池的快照（**不含任何凭据**，只有口令与状态）。
 *
 *  `nowLocal` = 与上游同格式的本地时刻（「下一场」的判据要用它；
 *  现在还没有生产者 —— 门的三步还没接，见 koulingPool 文件尾）。 */
export function readPoolSummary(
  store: Pick<Store, 'getState'>,
  nowLocal: string,
  nowMs: number,
): PoolSummary {
  const { pool } = loadPoolFrom(store);
  return poolSummary(pool, nowLocal, nowMs);
}

/** 界面读这个（最近一次读数）。 */
export function readLiveReading(store: Pick<Store, 'getState'>): LiveReading | null {
  return parseJson<LiveReading>(store.getState(STATE_READING));
}

/** 界面读这个（人给的口令）。 */
export function loadLiveCodes(store: Pick<Store, 'getState'>): LiveCodes | null {
  return parseJson<LiveCodes>(store.getState(STATE_CODES));
}

/** 存人给的口令。解析失败时**什么都不写**（半截数据比没有更难查）。
 *
 *  # ⚠ 2026-10-14：解析出来的候选还要过一遍**分隔符**（这是补的一处真 bug）
 *
 *  原先"没匹配到弹幕格式"那条路只按**换行**切，于是 `"口令甲 口令乙"`（空格分隔）
 *  会被当成**一条**口令发上去 —— 上游必然回 `200108 口令无效`，而用户看到的是
 *  "我明明填了两条，怎么只领了一条还说口令错"。
 *
 *  这条判据的权威源是 mcloud 的 `split_kouling`（`live_room.rs`，编排层）。
 *  它把**空白（含全角空格）/ 逗号 / 顿号 / 换行**都算分隔符，理由写在那边：
 *  口令是从**手机**里复制粘贴出来的，而手机输入法默认就是全角空格
 *  ⇒ 全角空格在这里是**常见**输入，不是边角情况。
 *
 *  它**为什么会漏**（mcloud 的注释原话）：那边的 WebUI 自己在 `api.ts` 里先按空格
 *  拆过一遍（作为"超集"），于是界面上看着是对的，而 CLI 与 HTTP API 两条路都直接
 *  走那个函数、没有那层补偿 ⇒ 修在**判据这一处**，不是在各调用方各补一次。
 *
 *  ⚠ 切的是**解析出来的候选**（不是原始文本）：弹幕原文里的 `复制口令1：` / `无随机口令`
 *  这些格式记号已经被算法层处理过了，拿原文去切会把记号本身切成口令。
 *  切完再滤掉两类碎片：**看着像提问的**（`什么`）与**收尾标记**（`无随机`）。
 *
 *  ⚠ 算法层的契约**没动**：`extractKouling('小红花口令：AAA 无随机')` 仍然回
 *  两条候选（那是它**刻意**的"更全"）。这里做的是**另一个问题** ——
 *  "到底拿哪几条去发" —— 而按 mcloud 的口径，`AAA 无随机` 切开就是 `AAA` + 标记。 */
export function saveLiveCodes(
  store: Store,
  raw: string,
  nowIso: string,
): { ok: boolean; codes: string[]; how: string; error?: string } {
  const parsed = parseCodeInput(raw);
  if (!parsed.ok) return { ok: false, codes: [], how: '', error: parsed.error ?? '解不出口令' };

  // ⚠ `splitKouling` 是**按分隔符切**（人贴的可能是"口令1：A 口令2：B"），
  //   切出来的每一段仍可能带收批尾巴（`A 无` / `A 无随机`）⇒ 这里再去一次。
  const cut = parsed.codes.flatMap((c) => splitKouling(c)).map(trimKoulingTail);
  const kept = cut.filter((c) => c !== '' && !isQuestion(c) && !isKoulingMarker(c));
  const limited = checkCodeLimits(kept);
  if (!limited.ok) return { ok: false, codes: [], how: '', error: limited.error ?? '解不出口令' };
  const codes = limited.codes;
  if (codes.length === 0) {
    return { ok: false, codes: [], how: '', error: '拆完之后一条口令都不剩（剩下的看着都像提问或格式标记）' };
  }
  const how =
    cut.length === codes.length
      ? parsed.how
      : `${parsed.how}；按分隔符切开 ${cut.length} 段，滤掉提问/标记、去重后剩 ${codes.length} 条`;

  const v: LiveCodes = { at: nowIso, codes, raw: raw.trim(), how };
  store.setState(STATE_CODES, JSON.stringify(v), nowIso);
  return { ok: true, codes, how };
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
