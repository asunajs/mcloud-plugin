// 趣玩AI赢好礼（`National_playAI`）的**只读**协议层：端点、请求构造、回执解析。纯函数。
//
// 形状来源：`mcloud-capture/mcloud/capture/app-play-ai-samples.txt`（2026-09-25 三轮）
// 与 `app-playai-2026-11-26-samples.txt`（2026-11-26 复核）。两份都是 iOS App WebView 实拍。
//
// # 这一族与算力大作战的关系
//
// 同一个 `funai` 端点族、同一套 `jwttoken`、**同一张 `activityid: sign_in_3`**（跨页残留值）。
// 差别在页面与判据：
//
// ```text
//   page/getmodule  → 门户页模块（moduleId 1-250730；带 drawTimes/drawsUsed/todayGetLotteryCount）
//   timed/getmodule → 主题/限时模块数组（moduleId 形如 2-261104-1，随周次变 ⇒ 不许写死）
//   taskIds[]       → 每个模块下的任务 {id, taskName, taskSign, isComplete, innerLink…}
// ```
//
// # 三条**实测**出来的判据（写代码前先记住，别"优化"掉）
//
// ① **`taskSign` 只认 `0` 才走 `page/register`**：`1` = 邀请（走分享链路）、
//    `2` = AI录音转写（2026-11-26 才出现，走法零样本）⇒ 这两档一律「需手动」，一个字节都不发。
// ② **`register` 的响应零信息**（`{"code":0,"result":0}`）：成败只能**回读 `getmodule`**
//    看那条 `isComplete` 有没有翻位（实测隔 68 秒才翻；点一下不等于完成）。
// ③ **`moduleId` 会变**（页面那个 `1-250730` 稳定，主题那批 `2-261104-*` 随周次换）
//    ⇒ 一律从 `getmodule` 现取，代码里不许有 moduleId 常量。
//
// # 本文件只做"读"
//
// 写口（`page/register` / `page/lottery` / `timed/lottery`）在下一轮接，形状先按抓包写好常量，
// 但**不导出构造器** —— 免得有人顺手调一个还没实测过的写口。

import { H5_APP_VERSION, rootOrDefault } from './h5.ts';
import type { BuiltRequest } from './h5.ts';
import { parseSignInEnvelope } from './envelope.ts';

/** 活动市场名（`activityid` 头与所有写口的 `marketName` 都用它）。 */
export const PLAYAI_MARKET = 'National_playAI';
/** 活动页路径与渠道号（实拍两轮一致：`path=National_playAI&sourceid=1044`）。 */
export const PLAYAI_PAGE_PATH = 'portal/cloudCircle/v1/index.html';
export const PLAYAI_SOURCE_ID = '1044';
/** 活动页 URL（不含 `token=`；抓包里带的是页口令，我们不复用）。 */
export const PLAYAI_REFERER =
  `https://m.mcloud.139.com/${PLAYAI_PAGE_PATH}` +
  `?path=${PLAYAI_MARKET}&sourceid=${PLAYAI_SOURCE_ID}&enableShare=1`;

/** 端点（都在 `m.mcloud.139.com/ycloud` 下）。 */
export const PLAYAI_EP = {
  /** 门户页模块（含任务表） */
  page: '/ycloud/funai/api/page/getmodule',
  /** 主题/限时模块数组 */
  timed: '/ycloud/funai/api/timed/getmodule',
  /** 本活动自己的奖品记录 */
  prizes: '/ycloud/funai/api/page/prizes',
  /** 邀请码 */
  invite: '/ycloud/funai/api/invite/getcode',
  /** 写：点一件任务（本轮**不接**） */
  register: '/ycloud/funai/api/page/register',
  /** 写：抽一次（本轮**不接**） */
  lottery: '/ycloud/funai/api/page/lottery',
  /** 写：刮刮乐（本轮**不接**） */
  timedLottery: '/ycloud/funai/api/timed/lottery',
} as const;

/** 规则里写死的上限（`getByMarketName` 的 `result.rule` 第 (三) 条）。 */
export const PLAYAI_DAILY_CHANCE_CAP = 5;

/** 会话里与请求头有关的那几格（与算力/签到族同一个 `Session` 形状）。 */
export interface PlayAiSession {
  jwt: string;
  cookie?: string | undefined;
  userAgent?: string | undefined;
}

/** 这一族的头画像。
 *
 *  ⚠ 两点**照实拍、别"统一"**：
 *   · `activityid` 打的是 `sign_in_3`（跨页残留值，两轮实拍 32/148 发里条条如此）；
 *   · `showloading` 是**逐口不同**的：`page/getmodule` 实拍 `true`、`timed/getmodule` 实拍 `false`
 *     （见 09-25 样本 §7.6）。所以它进参数，不写死。 */
export function playAiHeaders(
  s: PlayAiSession,
  opts: { showLoading?: boolean } = {},
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: '*/*',
    appversion: H5_APP_VERSION,
    Referer: PLAYAI_REFERER,
    jwttoken: s.jwt,
  };
  // ⚠ `activityid` 这一格**故意不发**。
  //   它是壳层把 `localStorage.marketName` 原样写进请求头的（谁最后写过 localStorage 谁就赢，
  //   见 `app-play-ai-samples.txt` §7.9 后面那段机制），**不是这一页设的**。
  //   两轮实拍就撞出两个不同的值：09-25 全是 `sign_in_3`、11-26 全是 `National_TokenPK`
  //   —— 同一批端点、两轮都 `code:0` ⇒ 上游**不看**它。
  //   所以这里不编一个值：编 `sign_in_3` 是照抄旧样本（我第一版就写错了），编别的同样是猜。
  if (opts.showLoading !== undefined) h.showloading = opts.showLoading ? 'true' : 'false';
  if (s.userAgent !== undefined && s.userAgent !== '') h['user-agent'] = s.userAgent;
  if (s.cookie !== undefined && s.cookie !== '') h.cookie = s.cookie;
  return h;
}

function playAiUrl(path: string, base: string | undefined): string {
  const root = rootOrDefault(base, 'https://m.mcloud.139.com').replace(/\/+$/, '');
  return `${root}${path}`;
}

/** 门户页模块（GET，无 query；实拍 12246 字节）。 */
export function pageModuleRequest(s: PlayAiSession, base?: string | undefined): BuiltRequest {
  return {
    url: playAiUrl(PLAYAI_EP.page, base),
    method: 'GET',
    // 实拍：这一口带 `showloading: true`
    headers: { ...playAiHeaders(s, { showLoading: true }), 'cache-control': 'no-cache' },
    body: undefined,
  };
}

/** 主题/限时模块（GET，无 query；实拍 8870 字节）。**`showloading: false`**。 */
export function timedModuleRequest(s: PlayAiSession, base?: string | undefined): BuiltRequest {
  return {
    url: playAiUrl(PLAYAI_EP.timed, base),
    method: 'GET',
    headers: { ...playAiHeaders(s, { showLoading: false }), 'cache-control': 'no-cache' },
    body: undefined,
  };
}

/** 本活动的奖品记录（GET）。实拍（11-26）：`showloading: true`。 */
export function prizesRequest(s: PlayAiSession, base?: string | undefined): BuiltRequest {
  return {
    url: playAiUrl(PLAYAI_EP.prizes, base),
    method: 'GET',
    headers: { ...playAiHeaders(s, { showLoading: true }), 'cache-control': 'no-cache' },
    body: undefined,
  };
}

/** 点一件任务（**写**）：`{moduleId,taskId}` 两键，回 `{"code":0,"result":0}`。
 *
 *  ⚠ 回执**零信息**（`result` 是数字 0）：这一次算不算数，只能回读 `getmodule`
 *    看那条 `isComplete` 有没有翻位（见文件头 ②）。 */
export function registerRequest(
  s: PlayAiSession,
  moduleId: string,
  taskId: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: playAiUrl(PLAYAI_EP.register, base),
    method: 'POST',
    headers: {
      ...playAiHeaders(s, { showLoading: true }),
      'content-type': 'application/json;charset=UTF-8',
      origin: 'https://m.mcloud.139.com',
      'cache-control': 'no-cache',
    },
    body: JSON.stringify({ moduleId, taskId }),
  };
}

/** 抽一次（**写**）：body 只带 `moduleId`（实拍七发逐字 `{"moduleId":"1-250730"}`）。
 *
 *  ⚠ 判"中没中"**只看 `isWin`**：`isWin:0` 时 `prizeId/prizeName/prizeUrl` 三键都是 `null`，
 *    但 `prizeType` **有值**（`1`）—— 拿 `prizeType` 当"有没有奖品"的信号会判错。 */
export function lotteryRequest(
  s: PlayAiSession,
  moduleId: string,
  base?: string | undefined,
): BuiltRequest {
  return {
    url: playAiUrl(PLAYAI_EP.lottery, base),
    method: 'POST',
    headers: {
      ...playAiHeaders(s, { showLoading: true }),
      'content-type': 'application/json;charset=UTF-8',
      origin: 'https://m.mcloud.139.com',
      'cache-control': 'no-cache',
    },
    body: JSON.stringify({ moduleId }),
  };
}

/** 一次抽奖的结果（只留判据格 + 奖品名）。 */
export interface PlayAiDraw {
  /** `isWin === 1` 才算中；没有这个键 ⇒ `null`（判不出来就别当成功） */
  win: boolean | null;
  prizeName: string;
  prizeType: number | null;
}

export function parseDraw(result: unknown): PlayAiDraw {
  const o = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const raw = o['isWin'];
  // ⚠ 只认 1/0（数字或数字串）。缺键 / 别的值 ⇒ null，**不当成功也不当没中**
  const win = raw === 1 || raw === '1' ? true : raw === 0 || raw === '0' ? false : null;
  return {
    win,
    prizeName: typeof o['prizeName'] === 'string' ? o['prizeName'] : '',
    prizeType: typeof o['prizeType'] === 'number' ? o['prizeType'] : null,
  };
}

// ══════════════════════════ 解析 ══════════════════════════

/** 一件任务（**原样留几个判据格**，别把整条对象塞进状态）。 */
export interface PlayAiTask {
  /** 任务 id（`003` / `aizhushou` / `204` …；跨族共享，判据是 `(moduleId, taskId)` 这一对） */
  id: string;
  name: string;
  /** `0` = 走 `page/register`；`1` = 邀请；`2` = AI录音转写（走法零样本） */
  taskSign: number;
  /** 服务端的事后翻位 —— **完成判据只看这一格** */
  isComplete: boolean;
  /** `taskDesc` 原话（写着奖励，例如「抽奖次数+1」） */
  desc: string;
  /** 深链（`mcloud://…` 或 `https://yun.139.com/aiTools/#/…`） */
  innerLink: string;
  /** 归属模块（`1-250730` / `2-261104-1` …） */
  moduleId: string;
}

/** 一个模块（门户页那一个 / 主题那三个）。 */
export interface PlayAiModule {
  moduleId: string;
  subtitle: string;
  /** 活动窗口（`2025-05-28T00:00:00` 这种墙钟串；主题模块没有） */
  startTime: string;
  endTime: string;
  /** 页面模块才有；主题模块是 `null`（实拍如此，别当成 0） */
  drawTimes: number | null;
  drawsUsed: number | null;
  todayGetLotteryCount: number | null;
  tasks: PlayAiTask[];
}

/** 读一份 `getmodule` 的 `result`（单个对象或数组，两口同形）。 */
export function parseModules(result: unknown): PlayAiModule[] {
  const one = (raw: unknown): PlayAiModule | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const moduleId = typeof o['moduleId'] === 'string' ? o['moduleId'] : '';
    if (moduleId === '') return null;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number(v);
    const tasks: PlayAiTask[] = [];
    for (const t of Array.isArray(o['taskIds']) ? o['taskIds'] : []) {
      const it = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
      const id = it['id'] === undefined || it['id'] === null ? '' : String(it['id']);
      if (id === '') continue;
      tasks.push({
        id,
        name: typeof it['taskName'] === 'string' ? it['taskName'] : '',
        // ⚠ 缺省给 `9`（"未知档"）而不是 `0`：`0` 会被当成"可以 register"
        taskSign: typeof it['taskSign'] === 'number' ? it['taskSign'] : 9,
        isComplete: it['isComplete'] === 1 || it['isComplete'] === true || it['isComplete'] === '1',
        desc: typeof it['taskDesc'] === 'string' ? it['taskDesc'] : '',
        innerLink: typeof it['innerLink'] === 'string' ? it['innerLink'] : '',
        moduleId,
      });
    }
    const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
    return {
      moduleId,
      subtitle: s('subtitle') || s('title'),
      startTime: s('startTime'),
      endTime: s('endTime'),
      drawTimes: num(o['drawTimes']),
      drawsUsed: num(o['drawsUsed']),
      todayGetLotteryCount: num(o['todayGetLotteryCount']),
      tasks,
    };
  };
  if (Array.isArray(result)) return result.map(one).filter((x): x is PlayAiModule => x !== null);
  const single = one(result);
  return single === null ? [] : [single];
}

/** 一条负责"读"的汇总（只读；不碰任何写口）。 */
export interface PlayAiReading {
  modules: PlayAiModule[];
  /** 页面模块（`1-…`）与主题模块合在一起的任务总数 */
  total: number;
  /** 已完成 / 可登记（`taskSign:0` 且未完成）/ 需手动（`taskSign≠0`） */
  done: number;
  runnable: number;
  manual: number;
  /** 页面模块的 `todayGetLotteryCount`（还没挣到的次数） */
  todayGot: number | null;
  /** 现在**可抽**几次：`drawTimes`（它本身已经是余额，别再减 `drawsUsed`） */
  canDraw: number | null;
}

/** 门户页那个模块（带 `drawTimes/drawsUsed/todayGetLotteryCount` 的那一个）。
 *
 *  ⚠ 判据是**计数是不是 `null`**，不是 `moduleId` 的前缀：主题模块的这三个格子实拍全是
 *    `null`，而页面模块有值。按 `2-` 前缀猜是能跑，但那是在猜 id 的命名规则 ——
 *    上游哪天换前缀就会静默认错模块（抽奖的 `moduleId` 也跟着错）。
 */
export function pageModule(modules: readonly PlayAiModule[]): PlayAiModule | undefined {
  return modules.find((m) => m.drawTimes !== null) ?? modules[0];
}

export function summarize(modules: readonly PlayAiModule[]): PlayAiReading {
  const tasks = modules.flatMap((m) => m.tasks);
  const page = pageModule(modules);
  return {
    modules: [...modules],
    total: tasks.length,
    done: tasks.filter((t) => t.isComplete).length,
    runnable: tasks.filter((t) => !t.isComplete && t.taskSign === 0).length,
    manual: tasks.filter((t) => !t.isComplete && t.taskSign !== 0).length,
    todayGot: page ? page.todayGetLotteryCount : null,
    // ⚠ `drawTimes` 已经是"还剩几次"（实拍 11 个时刻：todayGet = drawTimes + drawsUsed）
    canDraw: page ? page.drawTimes : null,
  };
}

/** 任务名的**短名**：上游给的是整句营销名（「智能抠图，一键抠图超轻松」），
 *  日志里只需要逗号前那一段。 */
export function shortTaskName(name: string): string {
  const head = name.split(/[，,]/)[0] ?? '';
  return (head.trim() === '' ? name : head).trim();
}

/** 给界面/日志的一行读数。
 *
 *  ⚠ 措辞有两处讲究（`stepLog.lineLevel` 按词着色）：
 *   · 用「**要手动**」而不是「需手动」—— 后者会命中"需要用户动手"那条规则被涂成**黄**，
 *     可这一行是**读数**（跟「今日云朵」一类），不是"这一趟要你去做点什么"；
 *   · 不出现 `moduleId`（`1-250730` 这种）—— 那是我们内部的对号用的，用户不认。 */
export function readingLine(r: PlayAiReading): string {
  const bits = [`${r.modules.length} 个模块`, `${r.total} 件任务`];
  if (r.done > 0) bits.push(`${r.done} 件已完成`);
  if (r.runnable > 0) bits.push(`${r.runnable} 件可做`);
  if (r.manual > 0) bits.push(`${r.manual} 件要手动`);
  if (r.canDraw !== null && r.canDraw > 0) bits.push(`可抽 ${r.canDraw} 次`);
  // ⚠ 写「今日」不写「今天」：`lineLevel` 里「今天」是**过程信息**（灰）的触发词，
  //   而这一行是读数（跟「今日云朵」同一类），要 info。
  else if (r.todayGot !== null) bits.push(`今日已得 ${r.todayGot} 次`);
  return bits.join(' · ');
}

/** 调一次 `getmodule` 并把信封解开（**只读**）。
 *
 *  与算力族同一个口径：`{code,msg,result}`，`code` 数字或数字串都见过。 */
export function parseEnvelope(
  text: string,
): { ok: true; result: unknown } | { ok: false; error: string } {
  let env: ReturnType<typeof parseSignInEnvelope>;
  try {
    env = parseSignInEnvelope(text);
  } catch (e) {
    // 非 JSON / 形状不对：如实报（别当成"没有任务"）
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!env.ok) return { ok: false, error: `服务端说 ${env.message || `code=${env.code}`}` };
  return { ok: true, result: env.result };
}
