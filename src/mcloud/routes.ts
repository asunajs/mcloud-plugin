// 插件自己的 HTTP 接口（`register_route`）—— **纯逻辑，不 import host-api**。
//
// 面板把插件路由挂在同一个端口上，路径是完整路径（`/plugins/mcloud/…`），键是
// `"{METHOD} {path}"`（大写方法、path 不含查询串）。handler 收到
// `{method, path, query, headers, body}`，返回 `{status, headers, body}`，`body` 必须是字符串。
//
// 本文件只**产出**路由表（`{path, method, handler}` 的数组），由 main.ts 真正注册。
// 这么分是为了守住那条硬约束：Node 里没有 host-api，任何 import 它的模块都加载不了 ——
// 路由逻辑要能在 Node 里跑测试，就不能碰宿主 API。（第一版我在这里 import 了 log，
// 还用了一个模块级可变注入，两样都不对。）
//
// ⚠️ 安全纪律：这些接口**不回显凭据**。状态只给 `redact()` 过的摘要（长度 + 前 4 位）。
// 想看完整 cookie 的人应该去读本机的 SQLite，而不是调一个「任何拿到面板会话的人都能调」
// 的 HTTP 接口。


import {
  STATE_BASE_URL,
  importSession,
  jwtExpiryOf,
  loadBaseUrl,
  parseSessionInput,
  sessionStatus,
  verifySession,
} from './session.ts';
import { TASK_NAMES, STATE_LAST_TASKLIST } from './tasks/taskList.ts';
import { SCHEDULED_TASKS } from './taskAccounts.ts';
import { groupView } from './groups.ts';
import { hasBigInt, sandboxCaps } from './caps.ts';
import { runAuthRefresh } from './authRefresh.ts';
import { STATE_STEP, clearOrder, runOrderStep, startOrder } from './tasks/exchangeOrder.ts';
import {
  CHANNELS,
  configuredChannels,
  sendPush,
  type PushChannel,
  type PushConfig,
  type PushDeps,
} from './push.ts';
import {
  loadPushConfig,
  pushReading,
  savePushBindings,
  savePushConfig,
  savePushRules,
  type PushRule,
} from './pushConfig.ts';
import { hourKey, timingReading } from './exchangeTiming.ts';
import { parseQuery } from './query.ts';
import { parseCron } from './scheduleCron.ts';
import { readRun, recentRuns } from './runLog.ts';
import { readRing } from './logRing.ts';
import { STATE_LEAD_MS, STATE_ORDERED_HOUR, exchangeLeadMs } from './tasks/exchangeOrder.ts';
import {
  STATE_LEAD_SEC,
  STATE_SCHEDULE_GEN,
  STATE_SCHEDULE_MAX_RUNS,
  STATE_SCHEDULE_CRON,
  STATE_SCHEDULE_MODE,
  STATE_SCHEDULE_ONCE_DATE,
  STATE_SCHEDULE_PLAN,
  STATE_SCHEDULE_PLAN_NAME,
  STATE_SCHEDULE_UNTIL,
  runExchange,
  scheduleLeadSec,
  scheduleMaxRuns,
  scheduleRuns,
  scheduleNextTargetMs,
  scheduleEnabled,
  setScheduleEnabled,
} from './tasks/exchangeRun.ts';
import { STATE_TARGET_HOUR, targetHourOf } from './exchangeTiming.ts';
import { APP_AUTH_PREFIX, parseAuth } from './auth.ts';
import { drawReport } from './tasks/liveDraw.ts';
import { MATRIX_MARKETS, readMatrix } from './tasks/appTaskMatrix.ts';
import { DAILY_DONE_KEY, readDailyRun } from './dailyState.ts';
import {
  VERDICT_TEXT,
  readExchangeList,
  readPickCache,
  readSubscriptions,
  runExchangeList,
  toggleSubscription,
} from './tasks/exchangeList.ts';
import {
  EMPTY_SHELL_HINT_CHARS,
  clearLiveCodes,
  loadLiveCodes,
  loadLiveUrl,
  readLiveReading,
  readPoolSummary,
  saveLiveCodes,
  saveLiveUrl,
} from './tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from './liveKouling.ts';
import { localStamp } from './koulingPool.ts';
import {
  loadGateBase,
  loadGateState,
  readGateReading,
  runLiveGate,
  saveGateBase,
} from './tasks/liveGateTask.ts';
import {
  currentAccount,
  loadAccounts,
  maskAuth,
  removeAccount,
  selectAccount,
  upsertAccount,
} from './accounts.ts';
import {
  BASE_VIDEO_IM_WS,
  STATE_LISTEN_SECONDS,
  listenReadingLine,
  loadImBase,
  loadListenRoom,
  loadListenSeconds,
  loadWsHeartbeat,
  loadListenState,
  loadWsBase,
  runLiveListen,
  saveImBase,
  saveListenRoom,
  saveWsBase,
  saveWsHeartbeat,
} from './tasks/liveListen.ts';
import {
  JWT_TTL_MS,
  authStatus,
  clearAuth,
  loadExchange,
  loadJwt,
  maskMobile,
  runExchangeStep,
  loadAuthRaw,
  needExchange,
  startExchange,
  jwtFresh,
} from './sessionExchange.ts';
import {
  claimEnabled,
  collectCodes,
  loadDrawState,
  probeLiveRoom,
  runLiveDraw,
  setClaimEnabled,
} from './tasks/liveDraw.ts';
import { loadWakePlan, planTrusted } from './tasks/liveAutoTask.ts';
import { qrSvg } from '../crypto/qr.ts';
import { callOnce } from './client.ts';
import { uuidV4 } from './rand.ts';
import {
  CODES,
  DEFAULT_PC_PLATFORM,
  PC_AUTH_PREFIX,
  QR_TTL_SECONDS,
  accountForm,
  applyPoll,
  authFromUserInfo,
  classifyPoll,
  classifySendSms,
  decryptUserInfo,
  isSuccessCode,
  parseLoginEnvelope,
  parsePcPlatform,
  LOGIN_AES_KEY,
  parseSliderPuzzle,
  puzzleVerfycodeEncrypt,
  type SliderPuzzle,
  pcClient,
  qrExpired,
  qrPayload,
  qrRemainingMs,
  qrThirdloginBody,
  sendSmsCodeBody,
  sendSmsCodeBodyWithSlider,
  sendSmsCodeRequest,
  sliderAnswer,
  sliderPuzzleBody,
  sliderPuzzleRequest,
  smsThirdloginBody,
  passwordThirdloginBody,
  maskPhone,
  userDomainIdFrom,
  thirdloginRequest,
  type LoginEnvelope,
  type PcPlatform,
} from './login.ts';
import {
  QR_POLL_MS,
  STATE_LOGIN_BASE,
  STATE_LOGIN_DOMAIN,
  STATE_LOGIN_PREF,
  clearLogin,
  loadDeviceId,
  loadQrSession,
  loadSmsSession,
  loginReading,
  resetDeviceId,
  saveQrSession,
  saveSmsSession,
  setSmsSlider,
  startQrSession,
  startSmsSession,
  loadAppSession,
  saveAppSession,
  startAppSession,
} from './loginSession.ts';
import type { Store } from '../store/types.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';
import { currentAccountDomain, setAccountDisabled, setAccountLabel } from './accounts.ts';
import { resolveTaskAccounts, saveTaskAccounts, taskAccountsView } from './taskAccounts.ts';
import {
  loadPlans,
  maxLeadMs,
  newPlanId,
  planSummary,
  planViews,
  resetPlanRuns,
  savePlans,
  unionCron,
  type ExchangePlan,
} from './exchangePlans.ts';
import { setTaskBlockers, setTaskPaused, setTaskSchedule, setTaskSummary, syncTaskReadiness } from './taskReadiness.ts';

import {
  APP_LOGIN_AES_KEY,
  APP_SLIDER_PUZZLE_PATH,
  appPost,
  appSendSmsCodeRequest,
  appThirdloginRequest,
  classifyAppLogin,
  classifyAppSendSms,
} from './appLogin.ts';
import { readBag } from '../store/keys.ts';
import type { BuiltRequest } from './h5.ts';
import type { Transport } from './client.ts';
import type { HostWs } from './tasks/base.ts';
import { normalizeDays, readDayForAccount, readRecordsForAccount } from './beansRead.ts';

/** 插件名（= 文件名去掉扩展名）。路由路径要用它。 */
export const PLUGIN = 'mcloud';

export interface RouteRequest {
  method?: string;
  path?: string;
  /** ⚠ **原始查询串**（`"id=abc&x=1"`），不是解析好的对象 ——
   *  见 `host-api.d.ts` 里 `RouteRequest.query` 那段实测记录。
   *  要按名取值用 `parseQuery()`。 */
  query?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface RouteEntry {
  path: string;
  method: string;
  handler: (req: RouteRequest) => RouteResponse;
  /** 这条路由的执行预算（毫秒）。不给就用面板的全局值（2000ms）。
   *
   *  ⚠ 面板的看门狗到点会把 handler **强制打断**并回一个 500（"路由处理超过预算 …
   *    被强制中断"）。默认那一档只够一两次上游往返；像「今日AI豆」那样
   *    **逐账号 × 翻页**的只读链，一发 `cloudRecordV2` 的超时就有 1500ms，
   *    两个账号各读两页就顶到 2 秒了 —— 所以它必须自己声明预算。
   *    见 `entries/mcloud.ts` 把这一格透给 `register_route`。 */
  budget_ms?: number;
}

export interface RouteDeps {
  store: Store;
  transport: Transport;
  now(): string;
  /** 注入日志：本文件不能 import host-api（见文件头） */
  log(msg: string): void;
  baseUrl?: string | undefined;
  /** 长连接那一族（`ws_*`）—— **可选**：宿主没有它时那个口子要如实 503。
   *  `routes.ts` 同样不 import `host-api`（见文件头），所以由 main.ts 注进来。 */
  ws?: HostWs | undefined;
  /** 推送要用的宿主能力（`http_fetch` + `smtp_send`）。
   *  同样**注入**（本文件不 import host-api）—— 「试发一条」那个路由要用它。 */
  pushDeps: PushDeps;
}

/** 把请求体当 JSON 解。**解不出来给 `null`**（调用方按"格式不对"处理），
 *  不抛异常 —— 路由里一个抛出去的异常会变成 500，而 400 才是对的。 */
function parseJson(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 账号列表的**对外形状**：只给掩码，不给凭据（见 accounts.ts 模块头）。 */
function accountsView(store: Pick<Store, 'getState'>): {
  current: string;
  accounts: {
    id: string;
    label: string;
    masked: string;
    current: boolean;
    addedAt: string;
    /** `pc` / `mobile` / `''`（认不出）。界面要说清"这条是哪一端"。 */
    platform: string;
    /** PC 端才有：`win` / `mac`。手机端恒为 `''`。 */
    pcPlatform: string;
    /** 凭据还有几天到期（`null` = 这条凭据里没带到期时间）。
     *
     *  ⚠ 来源是凭据 token 的第 4 段（`|` 分隔）。**没有样本**说明它一定存在，
     *  所以 `null` 要如实显示成"不知道"，不能画成 0（那看起来像"已过期"）。 */
    expireDays: number | null;
    /** 手机端凭据（JWT）什么时候到期 —— `''` = 这一格没有 JWT（只看得到 PC 端凭据）。
     *
     *  ⚠ 它与 `expireDays` **不是同一个凭据**：那个来自 PC 端 token 的第 4 段（29 天），
     *  这个来自手机端 JWT（通常只有 2 小时）。只看前者会漏掉"手机端今天就过期了"——
     *  而那正是所有 App 侧任务一起回「未登录」的原因。 */
    jwtExpiresAt: string;
    /** 手机端凭据已经过期了（按现在算）。 */
    jwtExpired: boolean;
    /** 这个账号自己的设备号（`B…`/`…-ENDIN` 那种）。没上报过 ⇒ `''`。 */
    deviceId: string;
    /** 停用。⚠ 与"删掉"不是一回事：停用**保留**状态（见 accounts.ts）。 */
    disabled: boolean;
    /** 听窗口长度（秒）。**按账号**。`NaN` = 还没设过（用缺省值）。 */
    listenSeconds: number;
    /** 只听这间房（0 / `NaN` = 自动）。**按账号**。 */
    listenRoom: number;
    /** 弹幕心跳的回帧内容。**按账号**。空串 = 用缺省。 */
    wsHeartbeat: string;
  }[];
} {
  const cur = currentAccount(store);
  const nowMs = Date.now();
  // ⚠ 袋是**按账号**存的，所以"每一条自己的设备号"要**按 id 逐个读**
  //   （不能用当前账号那一格 —— 那只会读到当前这个的）。
  const raw = rawStoreOf(store);
  return {
    current: cur?.id ?? '',
    accounts: loadAccounts(store).map((a) => {
      const info = parseAuth(a.auth);
      const exp = info?.expire ?? 0;
      return {
        id: a.id,
        label: a.label,
        masked: maskAuth(a.auth),
        current: cur?.id === a.id,
        addedAt: a.addedAt,
        platform: a.platform,
        pcPlatform: a.pcPlatform ?? '',
        expireDays: exp > 0 ? Math.floor((exp - nowMs) / 86_400_000) : null,
        ...(() => {
          const bag = readBag(raw, a.id);
          let jwt = '';
          try {
            jwt = (JSON.parse(bag['mcloud.session'] ?? '{}') as { jwt?: string }).jwt ?? '';
          } catch {
            jwt = '';
          }
          const e = jwtExpiryOf(jwt, new Date(nowMs).toISOString());
          return { jwtExpiresAt: e?.atIso ?? '', jwtExpired: e?.expired ?? false };
        })(),
        deviceId: readBag(raw, a.id)['mcloud.smid.deviceId'] ?? '',
        disabled: a.disabled === true,
        // ⚠ 这两个键**是按账号的**（`KEY_SCOPE` 里登记成 `account`）。
        //   所以"哪一条的设置"必须**按 id 读那一条的袋** —— 用当前账号那一格
        //   会把 A 的设置显示在 B 的弹窗里。
        listenSeconds: Number.parseInt(readBag(raw, a.id)['mcloud.live.listen_seconds'] ?? '', 10),
        listenRoom: Number.parseInt(readBag(raw, a.id)['mcloud.live.listen_room'] ?? '', 10),
        wsHeartbeat: readBag(raw, a.id)['mcloud.live.ws_heartbeat_reply'] ?? '',
      };
    }),
  };
}

const json = (status: number, obj: unknown): RouteResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(obj),
});

function readBody(req: RouteRequest): Record<string, unknown> {
  const raw = (req.body ?? '').trim();
  if (raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    // 不是 JSON 就当成「直接把 cookie 串贴进来了」—— 让人少一步转换
    return { session: raw };
  }
}


/** 一次调用把**七个区块要的读数**全给出来。
 *
 *  # 为什么要聚合
 *
 *  旧界面是「一个区块一个接口」，于是打开页面要打十几次请求，而且每一块各自
 *  有各自的加载/错误状态 —— 用户看到的是「有的块有数、有的块空着、有的块报错」，
 *  而**没人知道该看哪个**。那是「界面完全搞不懂」的来源之一。
 *
 *  聚合之后界面只有两种状态：**有读数** 或者 **一次都没读到**（一个错误信息）。
 *
 *  # 区块与键的对应（界面菜单栏的七块）
 *
 *  | 键 | 区块 | 里面是什么 |
 *  |---|---|---|
 *  | `account` | 账号 | 登录状态、账号列表、会话体检 |
 *  | `daily` | 日常 | 今天跑没跑、**最近一次运行的每一步结果** |
 *  | `exchange` | 兑换 | 兑换目标、奖品清单、判据文案 |
 *  | `live` | 直播 | 口令池、日程门、听窗口、下一次几点醒 |
 *  | `data` | 数据 | 沙箱能力、App 任务矩阵读数（纯读数，没有动作） |
 *  | `push` | 推送 | **阶段 ⑤ 才实现** —— 现在给一个诚实的空壳 |
 *  | `settings` | 设置 | 五个上游口子 + 听窗口参数 |
 *
 *  ⚠ 这里**只读**：一个上游请求都不发。要刷新上游读数得跑对应的任务
 *  （日常 / 直播 / 兑换），或者用区块里的「现在跑一次」按钮。
 *  这样「打开页面」永远不会因为上游慢而卡住。
 */
function buildReadings(deps: RouteDeps): Record<string, unknown> {
  const nowMs = Date.parse(deps.now());
  const nowIso = deps.now();
  const view = accountsView(deps.store);

  return {
    at: nowIso,
    account: {
      loggedIn: view.accounts.length > 0,
      current: view.current,
      accounts: view.accounts,
      session: sessionStatus(deps.store, nowIso),
    },

    // 三条任务各自"跑哪些账号"。⚠ 与上面那个 `account`（账号表）**分开给**：
    //   一个是"有哪些号"，一个是"这条任务用哪些号"—— 界面上它们在不同页
    //  （账号页 / 任务页）。合成一个的话，界面分不清该显示哪一个。
    taskAccounts: {
      日常: taskAccountsView(deps.store, '日常'),
      兑换: taskAccountsView(deps.store, '兑换'),
      直播: taskAccountsView(deps.store, '直播'),
    },
    // 登录会话（三种方式的进行中状态）。挂在 `account` 块里 ——
    // 界面上的「登录」那一节就是它。
    //
    // ⚠ `svg` 要在这里也带上：界面**只调 `/readings`**（见 app.js 的文件头），
    //   所以码必须由这个接口给出来。只在 `/login/qr/start` 上给的话，
    //   `act()` 之后的 `load()` 会用"没有 svg 的读数"把码**擦掉** ——
    //   表现是"点了扫码登录，二维码框是空的"。
    login: (() => {
      const r = loginReading(deps.store, nowMs, (sid, did) =>
        qrPayload(pcClient(sessionPlatform(deps.store), did), sid),
      );
      return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
    })(),
    daily: {
      // ⚠ `doneToday` 是**读数**，不是闸 —— 日常一天两趟都照跑（第二趟兜底，
      //   见 `entries/daily.ts` 里那段）。界面上别把它说成"今天已完成（不会再跑）"。
      // 「今天跑过没」看标记；「上次跑成什么样」看读数。两个都要，
      // 因为它们回答的是不同的问题（用户真正会问的是后面那个）。
      // ⚠ 用常量，**不要**写键名字面量 —— 那处原来是硬编码的
      //   `'mcloud.daily.done_date'`；改名/改分法时字面量不会跟着动。
      //   按账号那一层由 `scoped()` 负责（store 自己路由）。
      doneToday: (deps.store.getState(DAILY_DONE_KEY) ?? '') === nowIso.slice(0, 10),
      last: readDailyRun(deps.store),
      // 最近几次的**摘要**（只有一行一句）。步骤要按需再取 ——
      // 20 条 × 40 步全塞进来，首屏就是几百 KB 的 JSON。
      recent: recentRuns(deps.store, 'daily'),
    },
    exchange: {
      recent: recentRuns(deps.store, 'exchange'),
      // 时间读数：链上一大半时间在**等**（等到窗口、压到整点）。
      // 用户点了"现在试一次"然后看界面十几秒不动，第一反应是"卡住了" ——
      // 这个读数就是回答那个问题的。
      timing: timingReading(nowMs, exchangeLeadMs(deps.store)),
      // 到目标时刻那一场还有多久（界面第一行用）
      toTargetMs: Math.max(0, (scheduleNextTargetMs(deps.store, nowMs) ?? nowMs) - nowMs),
      // 这一小时已经发过单了吗（那道防重复花豆的闸）
      orderedThisHour:
        deps.store.getState(STATE_ORDERED_HOUR) ===
        hourKey(scheduleNextTargetMs(deps.store, nowMs) ?? nowMs),
      // 目标时刻（几点抢）。`null` = 每小时都试。
      targetHour: targetHourOf(deps.store),
      leadMs: exchangeLeadMs(deps.store),
      plan: deps.store.getState('mcloud.exchange.plan') ?? '',
      // 定时目标与手动目标分开存：页面上的「手动兑换」和「定时抢兑」不再互相改。
      // `schedulePlan` 是**显示名**（界面一直用它）；目标是 prizeId 或旧库的名字。
      schedulePlan: deps.store.getState(STATE_SCHEDULE_PLAN_NAME) ?? deps.store.getState(STATE_SCHEDULE_PLAN) ?? '',
      schedulePlanTarget: deps.store.getState(STATE_SCHEDULE_PLAN) ?? '',
      // 多计划：一条 = 一个账号 + 一个目标 + 一个整点。
      plans: planViews(deps.store),
      scheduleEnabled: scheduleEnabled(deps.store),
      scheduleCron: deps.store.getState(STATE_SCHEDULE_CRON) ?? '',
      scheduleMode: deps.store.getState(STATE_SCHEDULE_MODE) ?? 'daily',
      scheduleUntil: deps.store.getState(STATE_SCHEDULE_UNTIL) ?? '',
      scheduleOnceDate: deps.store.getState(STATE_SCHEDULE_ONCE_DATE) ?? '',
      scheduleMaxRuns: scheduleMaxRuns(deps.store),
      scheduleRuns: scheduleRuns(deps.store),
      leadSec: scheduleLeadSec(deps.store),
      reading: readExchangeList(deps.store),
      // 「选一件」那份缓存。**过期即清**发生在读的时候（本地写一格，不打上游）——
      // 用户点开这一屏就是"今天第一次看"，那一份昨天的清单在这一刻作废。
      picks: readPickCache(deps.store, nowIso),
      subs: readSubscriptions(deps.store),
      verdictText: VERDICT_TEXT,
    },
    live: {
      reading: readLiveReading(deps.store),
      codes: loadLiveCodes(deps.store),
      url: loadLiveUrl(deps.store),
      pool: readPoolSummary(deps.store, localStamp(nowMs), nowMs),
      gate: readGateReading(deps.store),
      listen: {
        reading: loadListenState(deps.store),
        line: listenReadingLine(loadListenState(deps.store)),
      },
      recent: recentRuns(deps.store, 'live'),
      auto: (() => {
        const plan = loadWakePlan(deps.store);
        return {
          wakeAt: plan?.wakeAt ?? '',
          wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
        };
      })(),
      // 领小红花的**结论**（四栏 + 进账）。界面第一行显示的就是 `line`。
      // ⚠ 「本场已结束」与「口令无效」分栏的理由见 liveDraw.drawReport 的注释 ——
      //   分错的后果是用户去重抄一条本来就对的口令。
      draw: (() => {
        const st = loadDrawState(deps.store);
        const r = drawReport(st);
        return {
          enabled: claimEnabled(deps.store),
          step: st?.step ?? '',
          report: r,
          // 这个开关只是"允许插件去领"；功能本身要服务端那边开（用户口径 2026-10-17）
          line:
            r === null
              ? claimEnabled(deps.store)
                ? '还没领过'
                : '领小红花没开 —— 要先在服务端那边开启（这里的开关只是允许插件去领）'
              : r.line,
        };
      })(),
    },
    data: {
      caps: sandboxCaps(),
      hasBigInt: hasBigInt(),
      matrix: {
        groups: readMatrix(deps.store).map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
        read: readMatrix(deps.store).filter(Boolean).length,
        total: MATRIX_MARKETS.length,
      },
    },
    // ⚠ 推送（10 渠道）在**阶段 ⑤**。这里给一个诚实的空壳而不是编一个假读数 ——
    //    界面据此显示「还没做」，而不是显示一个看着像好的空表。
    // 推送：配了哪几个渠道、有几条规则、三个任务各绑了哪条。
    //
    // ⚠ 是**顶层**块，不是挂在 `live` 里 —— 推送是「一次运行结束」的出口，
    //   三条任务都用它，与直播没有从属关系。（第一版插错了位置，
    //   表现是读数里 `live.push.channels` 为空而顶层根本没有 `push`。）
    // **秘密只给掩码**（见 pushConfig.maskSecret）—— token / pass / secret
    // 一个字符都不进这里。
    push: pushReading(deps.store),
    settings: {
      baseUrl: loadBaseUrl(deps.store),
      liveUrl: loadLiveUrl(deps.store),
      liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
      gateBase: loadGateBase(deps.store),
      wsBase: loadWsBase(deps.store),
      wsHeartbeat: loadWsHeartbeat(deps.store),
      listenRoom: loadListenRoom(deps.store) ?? 0,
      imBase: loadImBase(deps.store),
      listenSeconds: loadListenSeconds(deps.store),
      // 登录主机是**另一个口子**：登录那一族接口在 `user-njs.yun.139.com`，
      // 与云盘业务主机不是同一台。混用的话指到 mock 之后登录仍然打真上游。
      loginBase: loadLoginBase(deps.store),
      loginPlatform: loginPlatform(deps.store),
      // ⚠ 现在是**当前账号**的域（账号级那一格），不是全局那格 —— 见 F-075
      loginDomain: currentAccountDomain(deps.store) ?? '',
    },
  };
}


// ══════════════════════════════ 登录（②-3） ══════════════════════════════
//
// # 为什么登录是**一步一步**的，而任务不是
//
// 用户的要求是「任务不要一次一步」。但登录恰恰必须一步一步 —— 因为
// **状态机是用户本人**：出码 → 用户掏出手机扫 → 用户在手机上点确认 → 才拿得到凭据。
// 中间那几步的时间由用户决定，硬塞进一个"从头跑到尾"的函数只能变成
// "函数停在等用户输入"。所以推进的触发者是**用户点按钮**，不是定时器。
//
// 账密是例外：没有用户交互，所以它**一个路由就完成**（`/login/pwd`）。
//
// # 落盘
//
// 会话与设备指纹都在 `loginSession.ts` 落库。设备指纹**必须**落盘：
// 服务端按它定位"这次扫码是哪台设备"，每次重新生成的表现是轮询永远停在
// `200059541` —— 看起来像"码过期了"。

/** 登录那一族接口的主机。**与云盘业务主机不是同一台**，所以它有自己的口子。
 *
 *  混用业务基址的话，指到 mock 之后登录仍然打真上游 —— 而登录打真上游的
 *  表现是"账号密码不对"。 */
function loadLoginBase(store: Pick<Store, 'getState'>): string {
  return store.getState(STATE_LOGIN_BASE) ?? '';
}

/** 一次登录请求：发出去 → 解析信封。**不抛**（把失败当读数带回来）。
 *
 *  ⚠⚠ `ok` 的含义是「**拿到了上游的信封**」，**不是**「登录成功」。
 *
 *  这里原来是 `if (!res.ok) return { env: null, … }`，而 `callOnce.ok` 只对
 *  `code === 0` 成立 —— 于是登录这一族的**每一种**正常回答（`200059541`
 *  未找到设备的二维码信息 = 还没扫到、验证码不对、登录失败…）都被压成
 *  `env: null`，调用方每一处又都写 `if (r.env === null) → "没问到"`，
 *  结果是**真上游永远显示"移动云盘没回应"**，而码好好地在那儿等着（F-068）。
 *
 *  判据只能是「**解析出信封没有**」（`res.env === undefined` 才是真没问到：
 *  网络层失败、HTTP 非 200、或响应不是 JSON）。 */
function loginCall(
  deps: RouteDeps,
  req: BuiltRequest,
): { ok: boolean; env: LoginEnvelope | null; error: string; tookMs: number } {
  const res = callOnce(deps.transport, req);
  if (res.env === undefined) {
    return { ok: false, env: null, error: res.error ?? `http ${res.status}`, tookMs: res.tookMs };
  }
  try {
    // ⚠ 用 `res.body`（完整），**不是** `res.raw`（截断到 500 字符，给日志用）。
    //   登录成功的响应有 1–2 KB，拿截断过的去解析必然报
    //   "Unexpected end of JSON input" —— 而那句话看着像"上游回了个空响应"（F-072）。
    return { ok: true, env: parseLoginEnvelope(res.body), error: '', tookMs: res.tookMs };
  } catch (e) {
    return { ok: false, env: null, error: e instanceof Error ? e.message : String(e), tookMs: res.tookMs };
  }
}

// ══════════════════════ 自动过滑块（PC 与手机端共用）══════════════════════

/** 滑块最多自动重试几轮。
 *
 *  ⚠ 这个接口**计失败次数**（`200059553` = 这一道题的尝试次数用完）—— 无限重试
 *  会把配额烧光，然后真的要等。两轮够用：第一轮正常过，第二轮对付"题面取到就被
 *  判作废"那种时序问题。 */
const SLIDER_MAX_ATTEMPTS = 2;

/** 带答案发一次的结果（两条登录路共用这一套语义）。 */
type SliderSendResult =
  | { kind: 'sent'; remainGetTimes: number | null }
  | { kind: 'need-slider' }
  | { kind: 'exhausted' }
  | { kind: 'other'; note: string };

/** **自动过滑块**：取新题 → 解坐标 → 带答案重发，最多两轮。
 *
 *  ⚠ 为什么要它（用户的原话：「你这是让我肉眼看像素吗」）：
 *  参考实现是**全自动**的 —— `AppSmsNeedCaptcha` 之后自动取图、解坐标、带答案重发，
 *  人只负责等短信（`mcloud-capture/docs/upstream/app-sms-login.md` §7.2：
 *  「协议优先、H5 兜底」）。这一侧原来是"取图 → 界面摆一张图 → 提示用户再点一次
 *  「发验证码」"，而**坐标本来就是解出来的**（`puzzleLeft` 里就是答案，
 *  见 `sliderAnswer`），那张图对人没有任何用处。
 *
 *  ⚠ 每轮都取**新**题：失败之后旧挑战已经作废，拿旧答案再试只会一直失败。
 *  ⚠ 失败不抛异常、也不谎报成功：把最后一轮的原话带回去。 */
function autoPassSlider(
  deps: RouteDeps,
  logTag: string,
  fetchAnswer: () => { answer: string } | { error: string },
  sendWith: (answer: string) => SliderSendResult,
): { ok: true; remainGetTimes: number | null } | { ok: false; error: string } {
  for (let attempt = 1; attempt <= SLIDER_MAX_ATTEMPTS; attempt += 1) {
    const got = fetchAnswer();
    if ('error' in got) return { ok: false, error: got.error };
    const r = sendWith(got.answer);
    if (r.kind === 'sent') {
      deps.log(`${logTag}：滑块过了（第 ${attempt} 轮），验证码已发出`);
      return { ok: true, remainGetTimes: r.remainGetTimes };
    }
    if (r.kind === 'other') return { ok: false, error: r.note };
    // need-slider / exhausted ⇒ 换一道新题再试（旧题已作废）
    deps.log(`${logTag}：滑块没过（${r.kind}），换一道新题再试`);
  }
  return { ok: false, error: '滑块连着两轮没过 —— 过一会儿再点一次' };
}

/** 一次链路追踪 id（`x-yun-tid`）。每次请求新生成一个。 */
function newTid(): string {
  return uuidV4();
}

/** **默认**形态（上次选过的那个），给弹窗预填与"还没选就先出码"用。
 *
 *  ⚠ 它**不是身份来源**。一次登录用哪种形态，是那一趟出码时冻进会话的那个值
 *  （`sessionPlatform`）—— 这一格只回答"上次用的是哪种"。 */
function loginPlatform(store: Pick<Store, 'getState'>): PcPlatform {
  return parsePcPlatform(store.getState(STATE_LOGIN_PREF)) ?? DEFAULT_PC_PLATFORM;
}

/** 这一趟登录真正用的形态：**会话里冻着的那一个**优先，没有会话才用默认。
 *
 *  ⚠ 出码 / 轮询 / 读数重画码都走这里，不许各写各的：码里的 `ver` 与轮询请求体的
 *  `version` 必须出自同一个值，否则就是"码说 4.2.1、请求说 8.8.6"。 */
function sessionPlatform(store: Pick<Store, 'getState'>): PcPlatform {
  return loadQrSession(store)?.platform ?? loginPlatform(store);
}

/** 登录成功之后：解 `userInfo` → 拼凭据 → 落账号。
 *
 *  ⚠ 手机号**显式当标签传进去**：`upsertAccount` 会用 `phoneOf` 从凭据里抠，
 *  而 PC 凭据是 `Basic base64(...)` —— 那个函数现在能解 base64 了，
 *  但这里已经有权威值（`userInfo.account`），没必要让它再猜一次。
 *
 *  ⚠ `userDomainId` **只有登录响应里才有**，别的地方拿不到 ⇒ 这里不存就永远丢了。 */
function adoptLoginResult(
  deps: RouteDeps,
  encrypted: string,
  note: string,
  // ⚠ 这两样**必须参数化**：PC 与手机端用的是**两把不同的钥匙**
  //（`qPqDw263XgFgL3u8` / `lYzvvBMUjucw+h^R`）与**两个不同的前缀**
  //（`pc` / `mobile`）。写死一个的话，另一端登录出来的凭据会带着错的前缀，
  // 而"前缀不对"在任务里表现为"身份用错了"，离现场很远。
  prefix: string = PC_AUTH_PREFIX,
  key: string = LOGIN_AES_KEY,
  // ⚠ 登录**这一趟用的形态**要跟着凭据一起落盘：凭据里那一格恒是 `pc`
  //  （Windows 与 macOS 都是它），分不出 win/mac。不传的话账号卡上只能瞎标一个，
  //  而"这条凭据当初是按哪种客户端登的"就永远丢了（见 `Account.pcPlatform`）。
  pcPlatform?: PcPlatform,
): { ok: boolean; note: string; account?: { id: string; label: string } } {
  let info: Record<string, unknown>;
  try {
    info = decryptUserInfo(encrypted, key);
  } catch (e) {
    return { ok: false, note: `登录成功了，但结果解不开：${e instanceof Error ? e.message : String(e)}` };
  }
  let auth: string;
  try {
    auth = authFromUserInfo(info, prefix);
  } catch (e) {
    return { ok: false, note: `登录结果缺字段：${e instanceof Error ? e.message : String(e)}` };
  }

  const phone = typeof info['account'] === 'string' ? info['account'] : '';
  // ⚠ `userDomainId` **只有登录响应里才有** ⇒ 落到**这个账号**上（F-075 之前是全局一格，
  //   换账号登录一次就把上一号的域盖掉）。
  const domain = userDomainIdFrom(info);
  const up = upsertAccount(
    deps.store,
    auth,
    deps.now(),
    phone === '' ? undefined : maskPhone(phone),
    // ⚠ 词表在这里换一次（`windows` → `win`）—— 见 `accountForm` 的注释
    pcPlatform === undefined ? undefined : accountForm(pcPlatform),
    domain === '' ? undefined : domain,
  );
  // 新登录的账号一律**启用**，并且**切成当前账号** —— 用户刚扫码进来，
  // 想的就是"用这个号"，还要他再去列表里点一次是把动作做两遍。
  selectAccount(deps.store, up.account.id, deps.now());
  // 全局那格已经不用了 —— 顺手清掉（老库里可能还留着上一版写进去的值，
  // 而"两个地方都能读到域"正是这个结构问题本身）
  deps.store.setState(STATE_LOGIN_DOMAIN, '', deps.now());

  clearLogin(deps.store);
  deps.log(`登录成功：${up.account.label}${up.created ? '（新账号）' : '（已有账号，凭据已更新）'}`);
  // 账号数变了 ⇒ 三条任务的“未就绪”和卡片摘要跟着变（日常/直播不再显示“还没有账号”，
  // 兑换也不再显示“还没有选账号”）。
  syncTaskReadiness(deps.store);
  return { ok: true, note: `${note} · ${up.account.label}`, account: { id: up.account.id, label: up.account.label } };
}

/** 把计划表的变化同步给面板那一条「兑换」任务：
 *  cron = 所有启用计划整点的并集；暂停/未就绪/摘要都跟着计划走。 */
function syncExchangeJob(store: Store): void {
  const plans = loadPlans(store);
  const on = plans.filter((p) => p.enabled);
  const expr = unionCron(on);
  const lead = maxLeadMs(on);
  setTaskSchedule('兑换', expr, lead);
  setTaskPaused('兑换', on.length === 0);
  setTaskBlockers(
    '兑换',
    on.length > 0
      ? []
      : [plans.length === 0 ? '还没设定时计划' : '所有计划都未启用'],
  );
  setTaskSummary('兑换', planSummary(store));
}

/** 路由表。四个入口遍历它去调用真的 `register_route`。 */
export function mcloudRoutes(deps: RouteDeps): RouteEntry[] {
  const base = `/plugins/${PLUGIN}/api`;
  // 基址**每次调用时从 state 读**，而不是用注入的那份快照 ——
  // 否则「刚把基址指到 mock，导入会话却去打了真上游」：配置改了要立刻生效
  const verify = (): { ok: boolean; note: string } =>
    verifySession({
      store: deps.store,
      transport: deps.transport,
      nowIso: deps.now(),
      baseUrl: loadBaseUrl(deps.store),
    });

  return [
    {
      // 沙箱能力（**随时可问**，不用等 5 分钟一跳的自检）
      path: `${base}/caps`,
      method: 'GET',
      handler: () => json(200, { caps: sandboxCaps(), hasBigInt: hasBigInt() }),
    },

    // ── 运行记录 ────────────────────────────────────────────────────
    {
      // 某一次运行的**步骤**。列表只给摘要，点开才取这个 ——
      // 理由见 `runLog.ts` 的 `RunSummary`。
      // ⚠ 走**查询串**而不是 `/runs/:id`：宿主给的是 `req.query`，
      //   没有路径参数（见 `host-api.d.ts` 的 `RouteRequest`）。
      path: `${base}/runs`,
      method: 'GET',
      handler: (req) => {
        // ⚠ `req.query` 是**原始字符串** —— 要 `parseQuery` 才能按名取
        //   （见 host-api.d.ts 里那段实测记录）
        const id = parseQuery(req.query)['id'] ?? '';
        if (id === '') return json(400, { error: '要带一个 id' });
        const r = readRun(deps.store, id);
        // 找不到就 404，**不返回空对象** —— 界面据此显示"这次记录已经过期了"
        // （运行记录只留最近 N 次，用户手上那个 id 可能已经被挤掉了）
        if (r === null) return json(404, { error: `没有这次运行（可能已经被新记录挤掉了）：${id}` });
        return json(200, r);
      },
    },

    {
      // 运行日志的**历史**（最近 N 行）。
      //
      // 终端面板平时靠面板的日志流（SSE），可那条流的底子是内存环 ——
      // **面板一重启就空**。所以插件自己留了一份副本（`logRing.ts`），
      // 界面首屏先读这一份，再接流看新的。
      //
      // ⚠ 这是"上一次跑到哪"的答案，不是日志系统本身：没有级别过滤、没有续传，
      //   只留最近 400 行。别拿它当审计。
      path: `${base}/log/tail`,
      method: 'GET',
      handler: (req) => {
        const q = parseQuery(req.query);
        const want = Number(q.limit ?? '200');
        const limit = Number.isFinite(want) ? Math.min(Math.max(Math.trunc(want), 1), 400) : 200;
        const all = readRing(deps.store);
        return json(200, {
          lines: all.slice(Math.max(0, all.length - limit)),
          total: all.length,
        });
      },
    },

    // ── 推送 ────────────────────────────────────────────────────────
    {
      // 存推送配置。
      //
      // # 为什么是**合并**而不是整份覆盖
      //
      // 界面上**拿不到已经存着的值**（读数里只有掩码 —— token 不上屏是硬规则）。
      // 所以界面没法"把整份发回来"，它只知道用户这次改了什么。
      //
      // 但纯合并又做不到"删掉一个渠道"（删了下次会被旧值补回来）——
      // 所以请求体里带一个**显式的 `remove` 列表**：
      //
      //     { "set": { "bark": { "key": "…" } }, "remove": ["pushplus"] }
      //
      // 两种形状都收：给一个裸的配置对象就是"合并这几项"（写脚本时更顺手），
      // 给 `{set, remove}` 就是完整语义。
      path: `${base}/push/config`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json(400, { error: '请求体要是 JSON 对象' });
        }
        const raw = body as Record<string, unknown>;
        // `{set, remove}` 形状 vs 裸配置对象
        const isPatch = raw['set'] !== undefined || raw['remove'] !== undefined;
        const setObj = (isPatch ? raw['set'] : raw) as Record<string, unknown> | undefined;
        const remove = Array.isArray(raw['remove']) ? (raw['remove'] as unknown[]) : [];

        const cur = loadPushConfig(deps.store);
        if (setObj !== undefined && setObj !== null) {
          for (const [k, v] of Object.entries(setObj)) {
            if (k === 'title') {
              cur.title = typeof v === 'string' ? v : undefined;
              continue;
            }
            if (!CHANNELS.includes(k as PushChannel)) continue; // 不认识的键直接丢
            if (v === null) delete (cur as Record<string, unknown>)[k];
            else if (k === 'customPost') cur.customPost = v as PushConfig['customPost'];
            else (cur as Record<string, unknown>)[k] = v;
          }
        }
        for (const k of remove) {
          if (typeof k === 'string' && CHANNELS.includes(k as PushChannel)) {
            delete (cur as Record<string, unknown>)[k];
          }
        }
        savePushConfig(deps.store, cur, deps.now());
        const n = configuredChannels(cur);
        deps.log(`推送配置已保存（配了 ${n.length} 个渠道）`);
        return json(200, { ok: true, configured: n });
      },
    },
    {
      // 存推送规则（整份覆盖，同上的理由）。
      path: `${base}/push/rules`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (!Array.isArray(body)) return json(400, { error: '请求体要是数组' });
        // 只收形状对的那些 —— 一条坏规则不该让整份存不进去
        const rules = (body as PushRule[]).filter(
          (r) => r !== null && typeof r === 'object' && typeof r.id === 'string' && r.id !== '',
        );
        savePushRules(deps.store, rules, deps.now());
        deps.log(`推送规则已保存（${rules.length} 条）`);
        return json(200, { ok: true, count: rules.length });
      },
    },
    {
      // 存「哪个任务用哪条规则」。
      path: `${base}/push/bindings`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (body === null || typeof body !== 'object') {
          return json(400, { error: '请求体要是 JSON 对象' });
        }
        const src = body as Record<string, unknown>;
        const b = {
          daily: typeof src['daily'] === 'string' ? src['daily'] : '',
          exchange: typeof src['exchange'] === 'string' ? src['exchange'] : '',
          live: typeof src['live'] === 'string' ? src['live'] : '',
        };
        savePushBindings(deps.store, b, deps.now());
        deps.log('推送绑定已保存');
        return json(200, { ok: true, bindings: b });
      },
    },
    {
      // **试发一条**。存在的理由：推送最难受的失败方式是"配好了、但收不到"，
      // 而那时用户不知道是配置错了、还是任务没跑、还是根本没到发送那一步。
      // 这个按钮把这三件事分开：它直接发一条，成不成当场告诉你。
      path: `${base}/push/test`,
      method: 'POST',
      handler: () => {
        const cfg = loadPushConfig(deps.store);
        const chans = configuredChannels(cfg);
        if (chans.length === 0) {
          return json(200, { ok: false, line: '一个渠道都没配', results: [] });
        }
        const r = sendPush(deps.pushDeps, cfg, '云盘 · 试发', '这是一条试发的推送。\n收到就说明配置对了。');
        deps.log(`试发推送：${r.line}`);
        return json(200, { ok: r.failed === 0 && r.sent > 0, line: r.line, results: r.results });
      },
    },

    // ── 登录：读数 ──────────────────────────────────────────────────
    {
      // 登录页的读数（一次给全）。凭据**不进这里** —— 只给掩码过的形状。
      path: `${base}/login/state`,
      method: 'GET',
      handler: () =>
        json(200, {
          ...(() => {
            const r = loginReading(deps.store, Date.parse(deps.now()), (sid, did) =>
              qrPayload(pcClient(sessionPlatform(deps.store), did), sid),
            );
            // 二维码由**插件这一侧**渲染成 SVG（浏览器里没有二维码库）
            return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
          })(),
          platform: sessionPlatform(deps.store),
        }),
    },

    // ── 登录：扫码 ──────────────────────────────────────────────────
    {
      // 出码。**不发任何上游请求** —— 客户端源码里就是字符串拼接，
      // 实测 1622 个 body 文件里也没有对应的取码接口。
      path: `${base}/login/qr/start`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { pcPlatform?: unknown };
        // ⚠ 形态**在这一刻定下来**（用户出码前选的那个），冻进会话；
        //   之后改界面上的选择也不会改到这张码 —— 想换就重新出码。
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const nowMs = Date.parse(deps.now());
        const s = startQrSession(deps.store, nowMs, deps.now(), platform);
        const c = pcClient(s.platform, s.deviceId);
        const payload = qrPayload(c, s.sessionId);
        deps.log(`扫码登录：已出码（${s.platform === 'macos' ? 'macOS' : 'Windows'}），等手机扫`);
        return json(200, {
          sessionId: s.sessionId,
          payload,
          platform: s.platform,
          // **在插件这一侧编码**、界面只画格子：浏览器里没有二维码库，
          // 在那里现写一个等于把"码对不对"交给前端（见 crypto/qr.ts 的文件头）。
          svg: qrSvg(payload),
          expiresInMs: QR_TTL_SECONDS * 1000,
          // ⚠ 轮询间隔**由这一侧给**，界面不许自己写死一个数 ——
          //   参考实现的注释：「客户端写死一个数会和状态机分叉」。
          //   2 秒是"人扫完到界面看到"的延迟与上游压力的折中。
          pollMs: QR_POLL_MS,
          note: '用手机上的移动云盘 App 扫这个码，然后在手机上确认',
        });
      },
    },
    {
      // 轮一次。**"还没扫"不是错误** —— 轮询期间绝大多数响应都是它。
      path: `${base}/login/qr/poll`,
      method: 'POST',
      handler: () => {
        const s = loadQrSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的扫码登录（先点「扫码登录」）' });
        const nowMs = Date.parse(deps.now());
        // ⚠ 每一次回应都带上"这张码还剩多少毫秒"：界面上那一行要显示倒计时，
        //   而轮询每 2 秒就会把那行重写一次 —— 不带这个数的话，第一次轮询之后
        //   倒计时就消失了（用户判断"码还活着吗"全靠它）。
        const remain = qrRemainingMs(s, nowMs);
        if (qrExpired(s, nowMs)) {
          return json(200, {
            stop: true,
            ok: false,
            note: '二维码过期了，点「扫码登录」重新出码',
            expiresInMs: 0,
            pollMs: QR_POLL_MS,
          });
        }
        const c = pcClient(s.platform, s.deviceId);
        const r = loginCall(
          deps,
          // ⚠ 用**会话里那一个** `x-yun-tid`（整趟复用），不要每轮新生成 ——
          //   参考实现的会话表存的就是 `(qr, tid, owner)`（F-071）。
          thirdloginRequest(c, s.tid, qrThirdloginBody(c, s.sessionId), loadLoginBase(deps.store)),
        );
        // ⚠⚠ 判据是「**有没有拿到信封**」（`r.env === null`），**不是** `r.ok`。
        //
        //  `callOnce` 的 `ok` 只对 `code === 0` 成立，而扫码登录轮询里绝大多数响应
        //  是 `code=200059541`（未找到设备的二维码信息 = **还没扫到**）—— 那是个
        //  **正常状态**，不是失败。写成 `!r.ok` 的后果：真上游一直在这一支里，
        //  界面上永远显示"移动云盘没回应（200）"，而码其实好好地在那儿等着。
        //  （这个洞和 F-067 那个"没人轮询"是叠在一起的：轮询从来没跑过 ⇒ 这一支
        //   也就从来没被真上游走到过。清空设置页、真的去打上游之后当场露出来。）
        if (r.env === null) {
          // ⚠ 到这儿才算"没问到"：网络失败**不当作登录失败**，会话还在，再点一次就好。
          //
          // ⚠ 这句话是**给用户看的**（它显示在二维码下面那一行）：
          //   写「移动云盘」而不是「上游」；原始错误压一下 —— 能抠出状态码就
          //   写「（404）」，抠不出来才原样带上（docs/ui-wording.md：
          //   「HTTP 502 不算说明」，但也要求留下原始文本，别只回一个数字）。
          //   ⚠ 只认 `HTTP 502` / `http status: 404` 这两种写法里的数字：
          //   宽松地抓"头三位数字"会把上游的 `code=200059541` 抓成「200」，
          //   于是界面上一句"移动云盘没回应（200）"看着像上游好好的（F-068）。
          //   ⚠ **空响应**单独说（F-070）：真机上实测到移动云盘偶尔回一个空体，
          //   而 `Unexpected end of JSON input` 这种解析器原话贴在二维码下面
          //   只会让人以为是自己哪里填错了。原文进日志。
          //   ⚠ **连不上**也单独说（F-071）：`io: Connection refused (os error 61)`
          //   是宿主那一层的话，用户看了只会以为是自己弄坏了什么。
          const err = r.error ?? '没有回应';
          deps.log(`扫码登录：问服务端没成（${err}）`);
          const empty = /不是 JSON/.test(err);
          const offline = /Connection refused|connection reset|io: |dns error|timed out|timeout/i.test(err);
          const code = /\b(?:HTTP|status:)\s*(\d{3})\b/.exec(err)?.[1];
          const why = empty
            ? '移动云盘回了个空响应 —— 过一会儿再点一次'
            : offline
              ? '连不上移动云盘 —— 过一会儿再点一次'
              : `移动云盘没回应（${code ?? err}），过一会儿再点一次`;
          return json(200, {
            stop: false,
            ok: true,
            note: why,
            retry: true,
            expiresInMs: remain,
            pollMs: QR_POLL_MS,
          });
        }
        const out = classifyPoll(r.env);
        const applied = applyPoll(s, out, nowMs);
        saveQrSession(deps.store, applied.session, deps.now());
        if (applied.encrypted !== undefined) {
          const adopted = adoptLoginResult(
            deps,
            applied.encrypted,
            '扫码登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform,
          );
          return json(200, { ...applied, ...adopted, stop: true });
        }
        // ⚠ 记日志的判据是「**结论变了**」，并且要带上上游的原话（`code`）。
        //
        //   原来只在 `applied.stop` 时记一条：于是"手机扫到了"这一步在日志里**没有痕迹**，
        //   真机上出问题只能靠猜（2026-10-17 排"扫了没用"就卡在这里：日志里只有出码
        //   与超时，中间那几十次轮询到底说了什么，一个字都没留下）。
        //   按"结论变了"记既补上了这条链，又不会每 2 秒刷一行。
        if (applied.note !== s.lastNote) {
          const raw = `${r.env.code ?? '无 code'}${r.env.message ? ` ${r.env.message}` : ''}`;
          deps.log(`扫码登录：${applied.note}（服务端 code=${raw}）`);
        }
        return json(200, {
          stop: applied.stop,
          ok: applied.ok,
          note: applied.note,
          scanned: applied.session.scanned,
          // ⚠ 终态（过期 / 会话对不上 / 限流）时剩余时间必须给 0：
          //   否则界面上会出现「二维码过期了 · 剩 119 秒」这种自相矛盾的一行
          //   （实测到过：出码后第一次轮询恰好撞上上游回 `200059542`）。
          expiresInMs: applied.stop ? 0 : remain,
          pollMs: QR_POLL_MS,
        });
      },
    },


    // ── 登录：短信 ──────────────────────────────────────────────────
    {
      path: `${base}/login/sms/start`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { phone?: unknown; pcPlatform?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: '手机号要 11 位、以 1 开头' });
        // 形态同样在这一刻冻进会话（发码 / 取滑块 / 提交三步同一套档案）
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const s = startSmsSession(deps.store, phone, Date.parse(deps.now()), deps.now(), platform);
        return json(200, { phone: s.phone, platform: s.platform, note: '点「发验证码」' });
      },
    },
    {
      // 发码。**可能被风控拦下** ⇒ 这一侧**自己去过滑块**，人只负责等短信。
      path: `${base}/login/sms/send`,
      method: 'POST',
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const base = loadLoginBase(deps.store);

        // 发一次（`answer` 为空 = 不带滑块答案）
        const attempt = (answer?: string): SliderSendResult => {
          const body =
            answer === undefined
              ? sendSmsCodeBody(c, s.phone, s.random)
              : sendSmsCodeBodyWithSlider(c, s.phone, s.random, answer);
          const r = loginCall(deps, sendSmsCodeRequest(c, newTid(), body, base));
          // ⚠ 判据是「**有没有拿到信封**」（`r.env === null`）：非零 `code` 是
          //   **上游的回答**，要交给分类去说人话（"要过滑块" / "验证码不对"），
          //   不是网络故障。写成 `!r.ok` 的话，真上游的每一种回答都会被压成一句
          //   "发码请求没成功"，而那几句人话（分类）就成了永远走不到的死代码。
          if (r.env === null) return { kind: 'other', note: `发码请求没成功：${r.error}` };
          const out = classifySendSms(r.env);
          if (out.kind === 'sent') return { kind: 'sent', remainGetTimes: out.remainGetTimes };
          if (out.kind === 'need-slider') return { kind: 'need-slider' };
          if (out.kind === 'slider-exhausted') return { kind: 'exhausted' };
          return { kind: 'other', note: `发码没成：${out.message || `code=${out.code}`}` };
        };

        // 取一道**新**题并解出坐标（缺口坐标是解出来的，不是量出来的）
        const fetchAnswer = (): { answer: string } | { error: string } => {
          const pr = loginCall(deps, sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), base));
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            // 会话里留一份：界面上不画它，但排障时能对得上"这一轮用的哪道题"
            saveSmsSession(deps.store, { ...s, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };

        let sent: { remainGetTimes: number | null } | null = null;
        const first = attempt();
        if (first.kind === 'sent') {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === 'other') {
          return json(200, { ok: false, note: first.note });
        } else {
          // 要过滑块（或旧题作废）⇒ **自动**取新题、解坐标、带答案重发
          deps.log(`短信登录：要过滑块（${first.kind === 'exhausted' ? '旧图已作废' : '首次发码被拦'}），自动过`);
          const passed = autoPassSlider(deps, '短信登录', fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }

        const next = { ...s, sent: true, lastNote: '验证码已发出' };
        saveSmsSession(deps.store, next, deps.now());
        deps.log('短信登录：验证码已发出');
        return json(200, {
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note: '看手机短信，把 6 位验证码填进来',
        });
      },
    },
    {
      // 取滑块拼图。**缺口坐标是解出来的**，不需要图像识别。
      path: `${base}/login/sms/slider`,
      method: 'POST',
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `取滑块失败：${r.error}` });
        if (!isSuccessCode(r.env.code)) {
          return json(200, { ok: false, note: `取滑块被拒：${r.env.message || `code=${r.env.code}`}` });
        }
        let puzzle;
        try {
          puzzle = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(502, { error: `滑块响应看不懂：${e instanceof Error ? e.message : String(e)}` });
        }
        // 先自检一遍能不能解出坐标 —— 解不开就别把图发给用户白拖
        let answer: string;
        try {
          answer = sliderAnswer(puzzle);
        } catch (e) {
          return json(502, { error: `滑块缺口解不开（服务端换字段了？）：${e instanceof Error ? e.message : String(e)}` });
        }
        setSmsSlider(deps.store, s, puzzle, deps.now());
        return json(200, {
          ok: true,
          background: puzzle.backgroundB64,
          piece: puzzle.puzzleB64,
          picWidth: puzzle.picWidth,
          puzzleWidth: puzzle.puzzleWidth,
          answer,
          note: '答案已经解出来了，点「带滑块发码」',
        });
      },
    },
    {
      // 提交验证码。
      path: `${base}/login/sms/submit`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { code?: unknown };
        const code = typeof b.code === 'string' ? b.code.trim() : '';
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: '验证码要 4–8 位数字' });
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: '没有正在进行的短信登录（先填手机号）' });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), smsThirdloginBody(c, s.phone, code), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            '短信登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform,
          );
          return json(200, { ...adopted, stop: true });
        }
        const note =
          r.env.code === CODES.SMS_CODE_WRONG
            ? '验证码不对（或者过期了），再看一眼短信'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: false, note });
      },
    },

    {
      // 写"这条任务跑哪些账号"。
      //
      // ⚠ 校验两件事：任务名必须是我们认识的那三个（不然键会被人拼出来乱写），
      //   以及**选中的 id 必须真的存在** —— 存一堆不存在的 id 会让任务静默不跑，
      //   而界面上看起来"选好了"。
      path: `${base}/task/accounts`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { task?: unknown; all?: unknown; ids?: unknown };
        const task = typeof b.task === 'string' ? b.task : '';
        // ⚠ 校验的是**排期任务名**（`日常`/`兑换`/`直播`），不是内部步骤名。
        //   这里曾经误用 `TASK_NAMES`（那是 `sign`/`receive` 那一套）⇒ 保存账号选择
        //   每次都回「不认识的任务：日常」，而界面上只看到"点了没反应"。
        if (!(SCHEDULED_TASKS as readonly string[]).includes(task)) {
          return json(400, { error: `不认识的任务：${task || '(空)'}` });
        }
        const all = b.all === true;
        const known = new Set(loadAccounts(deps.store).map((a) => a.id));
        const ids = Array.isArray(b.ids)
          ? b.ids.filter((x): x is string => typeof x === 'string' && known.has(x))
          : [];
        saveTaskAccounts(deps.store, task, { all, ids }, deps.now());
        deps.log(`任务账号（${task}）：${all ? '全部' : `${ids.length} 个`}`);
        syncTaskReadiness(deps.store, [task]);
        return json(200, {
          ...taskAccountsView(deps.store as unknown as Store, task),
          note: all ? `${task}：全部账号` : `${task}：${ids.length} 个账号`,
        });
      },
    },

    // ── 登录：手机端（App 链路）─────────────────────────────────────
    //
    // ⚠ 与短信那条**不是一个东西**，所以四条路由都是新的：
    //   · 请求头是 App 那套（`appHeaders`），凭据前缀是 `mobile`
    //   · 第三枪的体是**加密的**（AES-128-ECB + 末 10 位错位）
    //   · 响应的成功载荷是**密文字符串**，要用 **App 那把钥匙**解
    //   参考实现特意没复用 PC 的枚举，理由写得很直白：「共用一个枚举会让调用方
    //   写错分支却仍然编译通过」。
    {
      path: `${base}/login/app/start`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { phone?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: '手机号要 11 位（1 开头）' });
        const a = startAppSession(deps.store, phone, Date.parse(deps.now()), deps.now());
        deps.log('手机端登录：手机号记下了');
        return json(200, { ok: true, phone: a.phone, note: '手机号记下了 —— 点「发验证码」' });
      },
    },
    {
      path: `${base}/login/app/send`,
      method: 'POST',
      handler: () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const nowMs = Date.parse(deps.now());

        // 发一次（`answer` 为空 = 不带滑块答案）
        const attempt = (answer?: string): SliderSendResult => {
          const puzzle = answer === undefined ? '' : puzzleVerfycodeEncrypt(answer);
          const r = loginCall(
            deps,
            appSendSmsCodeRequest(deviceId, nowMs, a.phone, puzzle, loadLoginBase(deps.store)),
          );
          if (r.env === null) return { kind: 'other', note: `发码请求没成功：${r.error}` };
          const out = classifyAppSendSms(r.env);
          if (out.kind === 'sent') return { kind: 'sent', remainGetTimes: out.remainGetTimes };
          if (out.kind === 'need-captcha') return { kind: 'need-slider' };
          if (out.kind === 'slider-exhausted') return { kind: 'exhausted' };
          return { kind: 'other', note: out.note };
        };

        // 取一道**新**题并解出坐标（App 那条路径与 PC 同一个 `/user/verfycode`）
        const fetchAnswer = (): { answer: string } | { error: string } => {
          const pr = loginCall(
            deps,
            appPost(
              APP_SLIDER_PUZZLE_PATH,
              JSON.stringify(sliderPuzzleBody(a.phone)),
              deviceId,
              nowMs,
              loadLoginBase(deps.store),
            ),
          );
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            saveAppSession(deps.store, { ...a, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };

        let sent: { remainGetTimes: number | null } | null = null;
        const first = attempt();
        if (first.kind === 'sent') {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === 'other') {
          return json(200, { ok: false, sent: false, note: first.note });
        } else {
          // ⚠ `exhausted` **不是**"账号被限流了"，而是"这一道题的尝试次数用完了"
          //   ⇒ 换一道新题。这一侧**自己去过**，不让用户拖。
          deps.log(`手机端登录：要过滑块（${first.kind === 'exhausted' ? '旧图已作废' : '首次发码被拦'}），自动过`);
          const passed = autoPassSlider(deps, '手机端登录', fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, sent: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }

        saveAppSession(deps.store, { ...a, sent: true, lastNote: '验证码已发出' }, deps.now());
        deps.log('手机端登录：验证码已发出');
        return json(200, {
          ok: true,
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note:
            sent.remainGetTimes === null
              ? '验证码已发出'
              : `验证码已发出（今天还能发 ${sent.remainGetTimes} 次）`,
        });
      },
    },
    {
      path: `${base}/login/app/slider`,
      method: 'POST',
      handler: () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        // 题面体与 PC **一样**（`{account, type: 2}`，`type` 是数字）—— 路径也同一个
        //（`/user/verfycode`）。差别只在**请求头**是 App 那套。
        const r = loginCall(
          deps,
          appPost(
            APP_SLIDER_PUZZLE_PATH,
            JSON.stringify(sliderPuzzleBody(a.phone)),
            deviceId,
            Date.parse(deps.now()),
            loadLoginBase(deps.store),
          ),
        );
        if (r.env === null) return json(502, { error: `取题面没成功：${r.error}` });
        let p: SliderPuzzle;
        try {
          p = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(200, { ok: false, note: `题面解不开：${e instanceof Error ? e.message : String(e)}` });
        }
        saveAppSession(deps.store, { ...a, slider: p, lastNote: '题面已取到' }, deps.now());
        return json(200, {
          ok: true,
          background: p.backgroundB64,
          note: '题面已取到 —— 缺口位置由这一侧解出，再点一次「发验证码」会带着答案发',
        });
      },
    },
    {
      path: `${base}/login/app/submit`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { code?: unknown };
        const code = typeof b.code === 'string' ? b.code.trim() : '';
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: '验证码要 4–8 位数字' });
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: '没有正在进行的手机端登录（先填手机号）' });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const r = loginCall(
          deps,
          appThirdloginRequest(
            deviceId,
            Date.parse(deps.now()),
            a.phone,
            code,
            a.random,
            undefined,
            loadLoginBase(deps.store),
          ),
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });

        const out = classifyAppLogin(r.env);
        if (out.kind === 'success') {
          // ⚠ 前缀是 **`mobile`**，钥匙是 **App 那把** —— 两处都与 PC 不同。
          const adopted = adoptLoginResult(deps, out.encrypted, '手机端登录成功', APP_AUTH_PREFIX, APP_LOGIN_AES_KEY);
          return json(200, { ...adopted, stop: true });
        }
        return json(200, { ok: false, stop: false, note: out.note });
      },
    },

    // ── 登录：账密 ──────────────────────────────────────────────────
    {
      // 账密登录**一个路由就完成** —— 它没有用户交互，所以不是状态机。
      path: `${base}/login/pwd`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { phone?: unknown; password?: unknown; pcPlatform?: unknown };
        const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
        const password = typeof b.password === 'string' ? b.password : '';
        if (phone === '') return json(400, { error: '要填手机号' });
        if (password === '') return json(400, { error: '要填口令' });
        // ⚠ 这里原来**没读** `pcPlatform`（界面一直在发它）—— 于是"选了 macOS"
        //   在账密这一路上静默变成 Windows。形态是**请求里带的那一个**。
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const c = pcClient(platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), passwordThirdloginBody(c, phone, password), loadLoginBase(deps.store)),
        );
        if (r.env === null) return json(502, { error: `登录请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === 'success') {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            '账密登录成功',
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            platform,
          );
          return json(200, { ...adopted, stop: true });
        }
        // ⚠ 错误信息里**不许回显口令**（日志与响应都不行）
        const note =
          r.env.code === CODES.LOGIN_FAILED
            ? '服务端说登录失败 —— 手机号或口令不对（也可能是设备头被拒）'
            : `登录没成：${out.kind === 'other' ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: true, note });
      },
    },

    // ── 登录：取消 / 换设备 ─────────────────────────────────────────
    {
      path: `${base}/login/cancel`,
      method: 'POST',
      handler: () => {
        clearLogin(deps.store);
        deps.log('登录：已取消');
        return json(200, { ok: true, note: '已取消' });
      },
    },
    {
      // 「我的码一直扫不出来」的救命按钮。
      // ⚠ 换设备指纹**必须同时清会话** —— 旧会话的 dID 是旧指纹，继续轮只会
      //   一直 200059541（而这看起来像"码过期了"）。
      path: `${base}/login/device/reset`,
      method: 'POST',
      handler: () => {
        const fresh = resetDeviceId(deps.store, deps.now());
        deps.log('登录：换了设备指纹（旧会话已清）');
        return json(200, { deviceId: fresh, note: '设备指纹已换新，旧会话已清 —— 重新出码' });
      },
    },

    {
      // **七个区块的读数一次给全** —— 界面只调这一个
      path: `${base}/readings`,
      method: 'GET',
      handler: () => json(200, buildReadings(deps)),
    },
    {
      path: `${base}/session`,
      method: 'GET',
      handler: () => json(200, sessionStatus(deps.store, deps.now())),
    },
    {
      path: `${base}/session`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);

        if (body.clear === true) {
          deps.store.setState('mcloud.session', '', deps.now());
          deps.log('会话已清空');
          return json(200, { cleared: true, status: sessionStatus(deps.store, deps.now()) });
        }

        const raw = typeof body.session === 'string' ? body.session : '';
        if (!raw) {
          return json(400, { error: '需要 {"session": "<cookie 串或 JSON>"} 或 {"clear": true}' });
        }
        const parsed = parseSessionInput(raw, deps.now());
        if (!parsed.ok) return json(400, { error: parsed.reason });

        importSession(deps.store, parsed.session, deps.now());
        // 导入后立刻真验一次：「能不能用」要靠上游回答，不是靠格式对不对
        const check = verify();
        const st = sessionStatus(deps.store, deps.now());
        // 日志只出结论与脱敏摘要
        deps.log(`导入会话：${check.note}（cookie ${st.cookie}）`);
        return json(200, { imported: true, verified: check.ok, note: check.note, status: st });
      },
    },
    {
      path: `${base}/session/verify`,
      method: 'POST',
      handler: () => {
        const check = verify();
        return json(200, {
          verified: check.ok,
          note: check.note,
          status: sessionStatus(deps.store, deps.now()),
        });
      },
    },
    {
      // 上游基址：CI 指向 mock 用；生产留空 = 用真地址。
      // 口令主页地址：同一条路（**完整 URL**，不是源 —— 见 liveRoom.ts 的 loadLiveUrl）
      path: `${base}/config`,
      method: 'GET',
      handler: () =>
        json(200, {
          baseUrl: loadBaseUrl(deps.store) || '(真主机)',
          liveUrl: loadLiveUrl(deps.store),
          liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
          // 门的两个主机（user-njs / v.cmcc-cs.cn）—— 一个口子，见 liveGateTask.loadGateBase
          gateBase: loadGateBase(deps.store) || '(真主机)',
          // 弹幕那条 WS 的主机（videoim.cmcc-cs.cn:20102）—— **另一个口子**：
          // 它是 `wss://` 且带端口，与上面那两台 http 主机不是同一族（混成一个会写出
          // "指到 mock 之后协议的 scheme/端口丢了"这种错）。
          wsBase: loadWsBase(deps.store),
          // 收到 SockJS 心跳帧 `h` 回什么（空=不回）。默认 `h`（2026-10-14 真机验过）。
          wsHeartbeat: loadWsHeartbeat(deps.store) || '(不回)',
          // 听哪一间房的**诊断口子**（空 = 按主播昵称选）。见 liveListen.loadListenRoom 的注释。
          listenRoom: loadListenRoom(deps.store) ?? 0,
          // 进房间那一台（videoim.cmcc-cs.cn:20103，HTTPS）—— **第三个口子**：
          // 与上面两台 http 主机、以及带端口的 wss 主机都不是同一个。
          imBase: loadImBase(deps.store) || '(真主机)',
          listenSeconds: loadListenSeconds(deps.store),
        }),
    },
    {
      path: `${base}/config`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const out: Record<string, string> = {};

        // ⚠️ 只改**传了的**那个字段。
        // 早先这里无条件写 `baseUrl`（没传就当空串），于是"只想改口令主页"会把
        // 上游基址一起抹掉 —— 抹掉之后所有云盘任务都会打**真上游**（CI 里就是打公网）。
        // 这正是"看着只是多了个配置项、实际把另一个配置清了"的那类错。
        if ('baseUrl' in body) {
          const v = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'baseUrl 要以 http:// 或 https:// 开头（清空就传空串）' });
          }
          deps.store.setState(STATE_BASE_URL, v.replace(/\/+$/, ''), deps.now());
          deps.log(v ? `接口基址已改为 ${v}` : '接口基址已恢复成真主机');
          out.baseUrl = v || '(真主机)';
        }

        // ── 兑换的两个时间参数（③-3）───────────────────────────────
        //
        // 两个都是"用户的网络/习惯决定的"，所以必须是可配的：
        //   · `targetHour`：几点抢（参考实现是一天一次 10 点）
        //   · `leadMs`：压着整点提前多少毫秒发 —— 它是**本地到云端的传输耗时补偿**，
        //     所以**网络慢的人该调大**。默认 10。
        if ('targetHour' in body) {
          const raw = body.targetHour;
          const v = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
          if (v !== '') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 23) {
              return json(400, { error: '兑换时刻要是 0~23 的整点（清空 = 每小时都试）' });
            }
          }
          deps.store.setState(STATE_TARGET_HOUR, v, deps.now());
          deps.log(v === '' ? '兑换时刻：每小时都试' : `兑换时刻：每天 ${v} 点`);
          out.targetHour = v;
        }

        if ('leadMs' in body) {
          const raw = body.leadMs;
          const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
          if (!Number.isFinite(n) || n < 0 || n > 2000) {
            return json(400, { error: '提前量要是 0~2000 毫秒（网络慢就调大）' });
          }
          deps.store.setState(STATE_LEAD_MS, String(Math.round(n)), deps.now());
          deps.log(`兑换提前量：${Math.round(n)}ms`);
          out.leadMs = String(Math.round(n));
        }

        if ('liveUrl' in body) {
          const v = typeof body.liveUrl === 'string' ? body.liveUrl.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, {
              error: 'liveUrl 要以 http:// 或 https:// 开头（清空 = 用默认主页）',
            });
          }
          saveLiveUrl(deps.store, v, deps.now());
          deps.log(v ? `口令主页已改为 ${v}` : '口令主页已恢复为默认（发布方的小红书主页）');
          out.liveUrl = v || XIAOHONGSHU_KOULING_PROFILE_URL;
        }

        if ('loginBase' in body) {
          const v = typeof body.loginBase === 'string' ? body.loginBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'loginBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          deps.store.setState(STATE_LOGIN_BASE, v.replace(/\/+$/, ''), deps.now());
          deps.log(v ? `登录主机已改为 ${v}` : '登录主机已恢复为真主机');
          out.loginBase = v || '(真主机)';
        }

        // 形态的**记忆**（"上次用的是哪种"）。写它的只有添加账号弹窗那两个按钮 ——
        // 它是预填值，不是身份来源：一次登录用哪种形态，是出码时冻进会话的那一个。
        if ('loginPlatform' in body) {
          const v = parsePcPlatform(body.loginPlatform) ?? DEFAULT_PC_PLATFORM;
          deps.store.setState(STATE_LOGIN_PREF, v, deps.now());
          out.loginPlatform = v;
        }

        if ('gateBase' in body) {
          const v = typeof body.gateBase === 'string' ? body.gateBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'gateBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          saveGateBase(deps.store, v, deps.now());
          deps.log(v ? `直播日程的接口基址已改为 ${v}` : '直播日程的接口基址已恢复成真主机');
          out.gateBase = v || '(真主机)';
        }

        if ('wsBase' in body) {
          const v = typeof body.wsBase === 'string' ? body.wsBase.trim() : '';
          // ⚠ 判据是 **ws:// 或 wss://**，不是 http —— 写成 http 这条口子在 CI 里
          //   连不上 mock，而现象是"WS 握手失败"，会让人去查协议而不是查配置。
          if (v && !/^wss?:\/\//.test(v)) {
            return json(400, { error: 'wsBase 要以 ws:// 或 wss:// 开头（清空 = 用真主机）' });
          }
          saveWsBase(deps.store, v, deps.now());
          deps.log(v ? `听弹幕的 WS 主机已改为 ${v}` : '听弹幕的 WS 主机已恢复为真主机');
          out.wsBase = v || BASE_VIDEO_IM_WS;
        }

        if ('imBase' in body) {
          const v = typeof body.imBase === 'string' ? body.imBase.trim() : '';
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: 'imBase 要以 http:// 或 https:// 开头（清空 = 用真主机）' });
          }
          saveImBase(deps.store, v, deps.now());
          deps.log(v ? `进房间的主机已改为 ${v}` : '进房间的主机已恢复为真主机');
          out.imBase = v || '(真主机)';
        }

        if ('wsHeartbeat' in body) {
          // ⚠ 先把人话别名归一（`none` ⇒ 空串），再校验 —— 否则"校验里放行 none、
          //   下面又比较 none"会被 TS 判成不可达分支（那一支真的是死的）。
          const given = typeof body.wsHeartbeat === 'string' ? body.wsHeartbeat.trim() : '';
          const raw = given === 'none' ? '' : given;
          // ⚠ 只认这两档：`h`（默认，实测有效）与空（不回）。别让它变成"回任意字符串"——
          //   那是往一条协议连接里写自由文本，出错时的现象是"服务端把我们踢了"，
          //   而原因在日志里根本看不出来。
          // 两档（2026-10-14 实测定下来）：`h`（回，默认）/ 空或 none（不回）。
          // ⚠ 两档都**不**把 `h` 当收尾理由 —— 实测不回也活了 6 拍/90 秒。
          if (raw !== '' && raw !== 'h') {
            return json(400, { error: 'wsHeartbeat 只能是 "h"（默认）或 "none"（不回）' });
          }
          saveWsHeartbeat(deps.store, raw, deps.now());
          deps.log(raw === '' ? '读到 SockJS 心跳帧 h 时**不回**' : '读到 h 时回一帧 h');
          out.wsHeartbeat = raw === '' ? '(不回)' : raw;
        }

        if ('listenRoom' in body) {
          const raw = String(body.listenRoom ?? '').trim();
          if (raw !== '' && !/^\d+$/.test(raw)) {
            return json(400, { error: 'listenRoom 要给房间号（纯数字）或空串（= 按主播昵称选）' });
          }
          saveListenRoom(deps.store, raw, deps.now());
          deps.log(raw === '' ? '听弹幕：恢复按主播昵称选房' : `听弹幕：诊断口子 —— 只听房间 ${raw}`);
          out.listenRoom = raw === '' ? '0' : raw;
        }

        if ('listenSeconds' in body) {
          const n = Number.parseInt(String(body.listenSeconds), 10);
          if (!Number.isFinite(n) || n <= 0 || n > 3600) {
            return json(400, { error: 'listenSeconds 要给 1..3600 之间的整数（秒）' });
          }
          deps.store.setState(STATE_LISTEN_SECONDS, String(n), deps.now());
          deps.log(`听弹幕的窗口改为 ${n} 秒`);
          out.listenSeconds = String(n);
        }

        if (Object.keys(out).length === 0) {
          return json(400, {
            error: '要传 baseUrl / liveUrl / gateBase / wsBase / imBase / wsHeartbeat / listenRoom / listenSeconds（清空就传空串）',
          });
        }
        return json(200, out);
      },
    },
    {
      // 兑换清单的读数（只读任务采集，界面展示）—— 含"没有余额读数"那句提醒
      path: `${base}/exchange`,
      method: 'GET',
      handler: () => {
        const reading = readExchangeList(deps.store);
        return json(200, {
          reading,
          // 界面上必须写出来：没有余额读数 ⇒ 标"可兑"的仍可能被余额挡下
          note: '没有余额读数：标「可兑」的仍可能被余额挡下（但那次挡下有错误码，不会静默）',
          verdictText: VERDICT_TEXT,
        });
      },
    },
    {
      // App 任务矩阵的读数（8 个 group 各一条）—— 只读任务采集，界面展示。
      // 界面要能看见，否则"只读"就只是日志里的一行数。
      path: `${base}/matrix`,
      method: 'GET',
      handler: () => {
        const rows = readMatrix(deps.store);
        return json(200, {
          // ⚠ 标签必须跟着 **market** 走，不是 group：`readMatrix` 返回的是
          //   按市场的两条（游标早就从 group 改成 market 了，见 appTaskMatrix.ts
          //   里那句「游标现在是**市场**（不是 group）」）。
          //   用 MATRIX_GROUPS 打标签的话，`sign_in_3` 会被标成 "new"、
          //   `newsign_139mail` 标成 "beiyong1"，而且 total 报 8 ——
          //   界面会显示 8 行、只有 2 行有数、两行还都标错。
          //   （这个 bug 是给 readings 写测试时顺带发现的。）
          groups: rows.map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
          read: rows.filter(Boolean).length,
          total: MATRIX_MARKETS.length,
        });
      },
    },
    {
      // 直播口令（只读那半）：自动抓到的读数 + **人给的口令**。
      // 界面要能看见 —— 否则"抓主页"就只是日志里的一行数。
      path: `${base}/live`,
      method: 'GET',
      handler: () =>
        json(200, {
          reading: readLiveReading(deps.store),
          codes: loadLiveCodes(deps.store),
          url: loadLiveUrl(deps.store),
          emptyShellHintChars: EMPTY_SHELL_HINT_CHARS,
          // 口令池（业务档，照 mcloud）：**口令的权威来源**（读数只是最近一次抓取的快照）。
          // 界面要能看见「够没够 2 条有效」「还要等多久才能再抓」「哪些判过无效」。
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
          // 直播日程（门）：只读探针的读数 —— 门开没开、看到几间房、「下一场」在 pool 里
          gate: readGateReading(deps.store),
          // 听弹幕（第二十三轮）：窗口里的过程事实 —— 收到几帧、几条弹幕、哪几条口令
          listen: {
            reading: loadListenState(deps.store),
            line: listenReadingLine(loadListenState(deps.store)),
          },
          // 直播自动定时（mcloud 的 `live_auto`）：**下一次几点醒**。
          // 它只有读数、没有动作 —— 定时器算时刻，听弹幕那条链到点才动。
          auto: (() => {
            const nowMs = Date.parse(deps.now());
            const plan = loadWakePlan(deps.store);
            const sum = readPoolSummary(deps.store, localStamp(nowMs), nowMs);
            return {
              nextStart: sum.nextStart ?? '',
              wakeAt: plan?.wakeAt ?? '',
              wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
              expr: plan?.expr ?? '',
              fromStart: plan?.fromStart ?? '',
              trusted: planTrusted(sum.scheduleAtMs, nowMs),
              line:
                plan === null
                  ? sum.nextStart === undefined || sum.nextStart === ''
                    ? '没有日程 ⇒ 不排定时（门探到「下一场」才会排）'
                    : '日程太旧 ⇒ 不按它睡（等门下次探到再说）'
                  : `下一次醒 ${plan.wakeAt}（= ${plan.fromStart} +1 小时）`,
            };
          })(),
          note:
            '口令本身**没法自动化**（主播在弹幕/小红书发，那边无法鉴权）⇒ 要人给；' +
            '能自动的只有「抓主页 + 列出看到的口令」。',
          // 写那半（领小红花）：默认关，开关在这里
          claim: {
            enabled: claimEnabled(deps.store),
            codes: collectCodes(deps.store, Date.parse(deps.now())),
            state: loadDrawState(deps.store),
          },
        }),
    },
    {
      // H5 换票（三步）：凭据状态 + 进度 + 换到的票。**都不回显凭据本身。**
      path: `${base}/h5`,
      method: 'GET',
      handler: () => {
        const jwt = loadJwt(deps.store);
        return json(200, {
          auth: authStatus(deps.store),
          exchange: loadExchange(deps.store),
          // ⚠ 票**不**回显（长度也不给 —— 它比凭据更接近"能直接用"）
          jwt: jwt
            ? {
                present: true,
                at: jwt.at,
                fresh: jwtFresh(deps.store, Date.now()),
                // 脱敏放**响应边界**（存储里留真值）：回显值不是凭据，
                // 但也没必要整串进界面与日志 —— 与凭据的处理同一套纪律。
                // ⚠ 上游字段叫 `mobile`，但真机上它不是手机号（见 maskMobile）
                mobile: jwt.mobile ? maskMobile(jwt.mobile) : null,
                ttlMinutes: Math.round(JWT_TTL_MS / 60000),
              }
            : { present: false },
          note:
            '贴一份**原生凭据**（`Basic base64("mobile:号:token")`，' +
            '也就是 mcloud 的 `auth.raw` 那个形状），插件自己走三步换成 H5 的 jwttoken，' +
            '并按 100 分钟自动续 —— 不用再手工从浏览器抄票（它 2 小时就废）。',
        });
      },
    },
    {
      // ⚠ **这条没有界面入口了**（2026-10-15 删掉了那个「H5 换票」按钮）。
      //
      // 为什么删：它是个**用户看不懂**的按钮 —— 而参考实现里根本没有它。
      // 那边换票是**任务里自动的一步**，而且**每个页面有自己的票**
      // （`SessionRecipe`：`SignInPage` → `sign_in_3`/`1002`、
      //  `MsgPushOn` → `msgpushon`/`1062`；实拍一趟抓到**三张互不相等的
      //  `jwttoken`**）。一个叫「H5 换票」的按钮会让人以为换的是"通用的票"。
      //
      // 留着这条路由的理由：它是**单账号那套**（`mcloud.h5.auth`）唯一的写入口，
      // 而 `loadAuthRaw` 还回落到那一格（老数据）。也留一条不带界面的
      // "清空"路径（`{clear:true}`）。
      //
      // 界面上的凭据入口是 `/accounts` 的 `op:'add'`（那个「凭据」页签）。
      path: `${base}/h5/auth`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearAuth(deps.store, deps.now());
          deps.log('原生凭据与换到的票：已清空');
          return json(200, { cleared: true });
        }
        const raw =
          typeof body.authorization === 'string'
            ? body.authorization
            : typeof body.session === 'string'
              ? body.session
              : '';
        if (!raw.trim()) {
          return json(400, { error: '需要 {"authorization": "Basic …"} 或 {"clear": true}' });
        }
        const r = startExchange(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error });
        // ⚠ 日志只出指纹，不出凭据
        deps.log(`原生凭据已收下（指纹 ${r.fingerprint}）—— 点「换票」走三步`);
        return json(200, { stored: true, fingerprint: r.fingerprint, ...authStatus(deps.store) });
      },
    },
    {
      // **推进一步**（一次调用一个上游请求）。界面上的按钮循环调这里直到 done。
      path: `${base}/h5/step`,
      method: 'POST',
      handler: (req) => {
        // ⚠ 可以**指定账号**（`{id}`）：卡片上那个「连接」是给**那一条**连的，
        //   而默认那条路用的是"当前账号"。不指定时行为与以前完全一样。
        const b = readBody(req) as { id?: unknown };
        const id = typeof b.id === 'string' ? b.id : '';
        const one = id === '' ? deps.store : scoped(rawStoreOf(deps.store), id);
        // ⚠ `runExchangeStep` 只**接着走**已有那一轮，它不会**开始**一轮 ——
        //   开始是 `startExchange`。少了这一句，"连接"永远回"没有待换票的任务"。
        // ⚠ 上一轮 `done`（票过期要再换一张）时也要开新的 —— 只判 `null` 的话，
        //   票一过期这里就永远回"没有待换票的任务"。
        // ⚠ 只有"真需要换"时才开新一轮（`needExchange` 会看票新不新鲜）——
        //   否则每点一次都会白换一张票。
        if (needExchange(one, Date.now())) {
          const st0 = loadExchange(one);
          if (st0 === null || st0.step === 'done') {
            startExchange(one, loadAuthRaw(one), deps.now());
          }
        }
        const r = runExchangeStep({
          store: one,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`换票${id === '' ? '' : `（${id}）`}：${r.note}`);
        return json(200, { ...r, exchange: loadExchange(one) });
      },
    },
    {
      // 「现在试一次」—— **干跑**：清单 / 余额 / 预热 / 取题解滑块都做完，
      // 到"只差下单"就停，**一枪都不发**。
      //
      // ⚠ 为什么不做成"现在就发一枪"：下单**不可逆**（没有幂等键，发出去就扣真豆）。
      //   用户点这个按钮想知道的是「**现在能不能兑**」—— 判据过不过、余额够不够、
      //   滑块算不算得出来。这些**不需要发那一枪**就能答。
      //   真下单走界面上的「立即兑换」（会二次确认）或定时那一场（时间闸 + 压整点）。
      path: `${base}/exchange/try`,
      method: 'POST',
      handler: () => {
        const d = {
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        };
        // ⚠ 干跑前先清掉上一条链的残留状态：不清的话会**接着上次的位置**跑
        //   （比如直接停在 order 上，那就什么都不做了）
        clearOrder(d);
        const r = runExchange(d, { dryRun: true });
        deps.log(`兑换试一次：${r.note}`);
        return json(200, r);
      },
    },
    {
      // 刷新「选一件」那份缓存 —— 界面上那颗「刷新清单」，以及"今天还没读到过"时自动打一次。
      //
      // ⚠ 只发**清单那一枪**（只读）：不碰余额、不碰滑块、更不下单。
      // 与 `/exchange/try` 的区别就在这个"轻"字上 —— 干跑是把整条链走到"只差发枪"，
      // 而这一条只是把清单重新拿一遍（用户点开界面不该惊动整条链）。
      path: `${base}/exchange/picks`,
      method: 'POST',
      handler: () => {
        const d = {
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        };
        const r = runExchangeList(d);
        deps.log(`兑换清单：${r.note}`);
        return json(200, { ...r, picks: readPickCache(d.store, d.nowIso) });
      },
    },
    {
      // 「我关注的奖品」—— 读。
      path: `${base}/exchange/subs`,
      method: 'GET',
      handler: () => json(200, { ok: true, subs: readSubscriptions(deps.store) }),
    },
    {
      // 「我关注的奖品」—— 开/关。按 id（有）或名字（没有）定位。
      path: `${base}/exchange/subs`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { id?: unknown; name?: unknown; on?: unknown };
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name === '') return json(400, { error: '要传奖品名字（name）' });
        const id =
          typeof b.id === 'number' && Number.isFinite(b.id)
            ? Math.trunc(b.id)
            : typeof b.id === 'string' && /^\d+$/.test(b.id.trim())
              ? Number(b.id.trim())
              : undefined;
        const on = b.on !== false;
        const subs = toggleSubscription(
          deps.store,
          id === undefined ? { name } : { id, name },
          on,
          deps.now(),
        );
        deps.log(`兑换关注：${on ? '关注' : '取消关注'}「${name}」`);
        return json(200, {
          ok: true,
          subs,
          note: on ? `已关注「${name}」` : `已取消关注「${name}」`,
        });
      },
    },
    {
      // 定时抢兑的「计划表」—— 一条计划 = 一个账号 + 一个目标 + 一个整点。
      path: `${base}/exchange/plans`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as {
          action?: unknown;
          id?: unknown;
          accountId?: unknown;
          prizeId?: unknown;
          prizeName?: unknown;
          cron?: unknown;
          leadSec?: unknown;
          until?: unknown;
          maxRuns?: unknown;
          enabled?: unknown;
        };
        const store = deps.store;
        const plans = loadPlans(store);
        const nowIso = deps.now();
        const action = typeof b.action === 'string' ? b.action : 'save';

        if (action === 'delete') {
          const id = typeof b.id === 'string' ? b.id : '';
          const next = plans.filter((p) => p.id !== id);
          if (next.length === plans.length) return json(404, { ok: false, error: '计划不存在' });
          savePlans(store, next, nowIso);
          resetPlanRuns(store, id, nowIso);
          syncExchangeJob(store);
          deps.log('定时计划已删除');
          return json(200, { ok: true, note: '计划已删除', plans: planViews(store) });
        }

        if (action === 'toggle') {
          const id = typeof b.id === 'string' ? b.id : '';
          const on = b.enabled === true;
          const idx = plans.findIndex((p) => p.id === id);
          if (idx < 0) return json(404, { ok: false, error: '计划不存在' });
          const next = plans.slice();
          next[idx] = { ...next[idx]!, enabled: on };
          savePlans(store, next, nowIso);
          syncExchangeJob(store);
          deps.log('定时计划「' + next[idx]!.prizeName + '」：' + (on ? '启用' : '暂停'));
          return json(200, {
            ok: true,
            note: on ? '计划已启用' : '计划已暂停',
            plans: planViews(store),
          });
        }

        // save（新增或编辑）
        const accountId = typeof b.accountId === 'string' ? b.accountId.trim() : '';
        if (accountId === '') return json(400, { ok: false, error: '要选一个账号' });
        const acct = loadAccounts(store).find((a) => a.id === accountId);
        if (!acct) return json(400, { ok: false, error: '账号不存在' });
        if (acct.disabled === true) return json(400, { ok: false, error: '这个账号已停用' });
        const prizeName = typeof b.prizeName === 'string' ? b.prizeName.trim() : '';
        const prizeIdRaw = Number(b.prizeId);
        const prizeId = Number.isInteger(prizeIdRaw) && prizeIdRaw > 0 ? prizeIdRaw : undefined;
        if (prizeName === '' && prizeId === undefined) {
          return json(400, { ok: false, error: '要选一个兑换目标' });
        }
        const cron = typeof b.cron === 'string' ? b.cron.trim() : '';
        try {
          parseCron(cron);
        } catch (e) {
          return json(400, {
            ok: false,
            error: 'cron 不对：' + (e instanceof Error ? e.message : String(e)),
          });
        }
        const leadRaw = Number(b.leadSec);
        const leadSec = Number.isFinite(leadRaw)
          ? Math.min(300, Math.max(60, Math.floor(leadRaw)))
          : 120;
        const until = typeof b.until === 'string' ? b.until.trim() : '';
        if (until !== '' && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(until)) {
          return json(400, { ok: false, error: '截止时间格式：YYYY-MM-DD 或 YYYY-MM-DDTHH:mm' });
        }
        const maxRaw = Number(b.maxRuns);
        const maxRuns = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(999, Math.floor(maxRaw)) : 0;
        const id = typeof b.id === 'string' && b.id.trim() !== '' ? b.id.trim() : '';
        const idx = id === '' ? -1 : plans.findIndex((p) => p.id === id);
        if (id !== '' && idx < 0) return json(404, { ok: false, error: '计划不存在' });
        const plan: ExchangePlan = {
          id: idx >= 0 ? id : newPlanId(),
          accountId,
          ...(prizeId === undefined ? {} : { prizeId }),
          prizeName: prizeName === '' ? String(prizeId) : prizeName,
          cron,
          leadSec,
          until,
          maxRuns,
          enabled: b.enabled === false ? false : true,
        };
        const next = plans.slice();
        if (idx >= 0) next[idx] = plan;
        else next.push(plan);
        savePlans(store, next, nowIso);
        resetPlanRuns(store, plan.id, nowIso);
        syncExchangeJob(store);
        deps.log(
          '定时计划：' +
            acct.label +
            ' · ' +
            plan.prizeName +
            ' · ' +
            cron +
            ' · 提前 ' +
            leadSec +
            's' +
            (until ? ' · 截止 ' + until : '') +
            (maxRuns > 0 ? ' · 最多 ' + maxRuns + ' 次' : ''),
        );
        return json(200, {
          ok: true,
          note: '计划已保存：' + acct.label + ' · ' + plan.prizeName,
          plans: planViews(store),
        });
      },
    },
    {
      // 兑换下单 —— **不可逆**（真扣豆）。起单只是写字（**不发请求**），
      // 后面每次 `step` 走一步、发一枪。见 tasks/exchangeOrder.ts 的枪序。
      path: `${base}/exchange/order`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as {
          query?: unknown;
          action?: unknown;
          mode?: unknown;
          until?: unknown;
          onceDate?: unknown;
          maxRuns?: unknown;
          leadSec?: unknown;
          cron?: unknown;
          prizeId?: unknown;
          prizeName?: unknown;
        };
        const d = { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) };
        if (b.action === 'clear') {
          clearOrder(d);
          return json(200, { ok: true, note: '这一单已清掉' });
        }
        // 只写「手动目标」，不起单。手动区的「保存手动目标」用它；
        // 「立即兑换」仍走下面的 `query`（会 startOrder）。
        if (b.action === 'manual-plan') {
          const query = typeof b.query === 'string' ? b.query.trim() : '';
          if (query === '') return json(400, { ok: false, error: '手动目标不能为空' });
          deps.store.setState('mcloud.exchange.plan', query, d.nowIso);
          deps.log(`手动目标：${query}`);
          return json(200, { ok: true, note: `手动目标已设为「${query}」` });
        }
        // 只写「定时目标」，**不**起单、不发请求。定时弹窗用它；
        // 手动兑换那条仍走下面的 `query`（会 startOrder）。
        // 启用/暂停「定时抢兑」。面板任务列表不显示这条任务，所以开关必须在这里。
        if (b.action === 'schedule-pause' || b.action === 'schedule-resume') {
          const on = b.action === 'schedule-resume';
          // 注意语义：`on` 是“启用”，而 `set_job_paused` 收的是“暂停与否” ——
          // 直接传 `on` 会把“启用”写成暂停（实测就是这么反的）。
          setTaskPaused('兑换', !on);
          setScheduleEnabled(deps.store, on, deps.now());
          deps.log(`定时抢兑：${on ? '启用' : '暂停'}`);
          return json(200, { ok: true, note: on ? '定时已启用' : '定时已暂停' });
        }
        if (b.action === 'plan') {
          const query = typeof b.query === 'string' ? b.query.trim() : '';
          // 目标是 **prizeId**（稳定），名字只用于显示。老客户端只传 query（名字）时
          // 继续按名字走 —— `pickPrize` 本来就兼容两种写法。
          const prizeIdRaw = Number(b.prizeId);
          const prizeId = Number.isInteger(prizeIdRaw) && prizeIdRaw > 0 ? prizeIdRaw : undefined;
          const prizeName = typeof b.prizeName === 'string' && b.prizeName.trim() !== ''
            ? b.prizeName.trim()
            : query;
          const target = prizeId === undefined ? query : String(prizeId);
          if (target === '') return json(400, { ok: false, error: '定时目标不能为空' });
          const cron = typeof b.cron === 'string' ? b.cron.trim() : '';
          if (cron === '') return json(400, { ok: false, error: 'cron 表达式不能为空' });
          try {
            parseCron(cron);
          } catch (e) {
            return json(400, { ok: false, error: `cron 不对：${(e as Error).message}` });
          }
          const until = typeof b.until === 'string' ? b.until.trim() : '';
          if (until !== '' && !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/.test(until)) {
            return json(400, { ok: false, error: '截止时间要写成 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm' });
          }
          const maxRunsRaw = Number(b.maxRuns ?? 0);
          if (!Number.isInteger(maxRunsRaw) || maxRunsRaw < 0 || maxRunsRaw > 999) {
            return json(400, { ok: false, error: '次数要是 0~999 的整数（0 = 不限）' });
          }
          const leadRaw = Number(b.leadSec ?? 120);
          if (!Number.isFinite(leadRaw) || leadRaw < 60 || leadRaw > 300) {
            return json(400, { ok: false, error: '提前触发要在 60~300 秒之间' });
          }
          const gen = String(Date.now());
          deps.store.setState(STATE_SCHEDULE_PLAN, target, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_PLAN_NAME, prizeName, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_CRON, cron, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_UNTIL, until, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_MAX_RUNS, String(maxRunsRaw), d.nowIso);
          deps.store.setState(STATE_LEAD_SEC, String(Math.round(leadRaw)), d.nowIso);
          // 换一版定时 = 每个账号的已跑次数从头算。
          deps.store.setState(STATE_SCHEDULE_GEN, gen, d.nowIso);
          // 兼容旧客户端：旧版只有“一条全局计划”，按当时选的账号拆成计划表。
          // 新界面直接走 `/exchange/plans`，这里只做兜底。
          const accounts = resolveTaskAccounts(deps.store, '兑换');
          const plans = loadPlans(deps.store);
          for (const accountId of accounts) {
            const idx = plans.findIndex((p) => p.accountId === accountId);
            const plan: ExchangePlan = {
              id: idx >= 0 ? plans[idx]!.id : newPlanId(),
              accountId,
              ...(prizeId === undefined ? {} : { prizeId }),
              prizeName,
              cron,
              leadSec: Math.round(leadRaw),
              until,
              maxRuns: maxRunsRaw,
              enabled: true,
            };
            if (idx >= 0) plans[idx] = plan;
            else plans.push(plan);
          }
          savePlans(deps.store, plans, d.nowIso);
          setScheduleEnabled(deps.store, true, d.nowIso);
          syncExchangeJob(deps.store);
          deps.log(
            `定时目标：${prizeName}${prizeId === undefined ? '' : `（prizeId=${prizeId}）`}` +
              `（cron ${cron}，提前 ${Math.round(leadRaw)}s，每号最多 ${maxRunsRaw || '不限'} 次）`,
          );
          return json(200, {
            ok: true,
            note: `定时已保存：${prizeName}（提前 ${Math.round(leadRaw)}s）`,
          });
        }
        if (b.action === 'step') {
          const r = runOrderStep(d);
          const step = d.store.getState(STATE_STEP) ?? '';
          deps.log(`兑换：${r.note}`);
          return json(200, { ...r, step, done: step === 'done' });
        }
        // ⚠ 保存**手动目标**要同时写两格，少一格这条链就断：
        //   · `mcloud.exchange.plan` = 手动要换的那一句（旧版本的定时链也会回退读它）。
        //   · `mcloud.exchange.order.plan` = **这一单**在排队时用的那一句（`startOrder` 写，
        //     `runOrderStep` 读）。
        //   定时目标另存 `mcloud.exchange.schedule.plan`，见上面 `action: 'plan'`；
        //   两条线分开之后，改手动目标不会把定时目标带跑。
        const query = typeof b.query === 'string' ? b.query.trim() : '';
        if (query !== '') deps.store.setState('mcloud.exchange.plan', query, d.nowIso);
        const r = startOrder(d, query);
        deps.log(`兑换起单：${r.note}`);
        return json(200, { ...r, queue: deps.store.getState('mcloud.exchange.order.step') ?? '' });
      },
    },
    {
      // 凭据续期。默认**按判据**（离过期还远就一个请求都不发）；
      // `{"force":true}` 对应 mcloud CLI 的 `--force`，用来"我现在就想试一下"。
      path: `${base}/auth/refresh`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as { force?: unknown; leadDays?: unknown };
        const force = b.force === true;
        const leadDays = typeof b.leadDays === 'number' ? b.leadDays : undefined;
        const cur = currentAccount(deps.store);
        const r = runAuthRefresh(
          { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) },
          force,
          leadDays,
          // 明确"刷当前这一条、写回这一条"（没有账号时才是单账号那格）
          cur === undefined ? {} : { auth: cur.auth, accountId: cur.id },
        );
        deps.log(`凭据续期：${r.note}`);
        return json(200, { ...r, auth: authStatus(deps.store) });
      },
    },
    {
      // **只读探针**：一枪 `user/info`，回答"这一族能不能通"（不记账、不写状态）。
      // 没有它，"验请求头"得先有真口令，而口令只在直播那一小时有效。
      path: `${base}/live/draw/probe`,
      method: 'POST',
      handler: () => {
        const r = probeLiveRoom({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`小红花探针：${r.note}`);
        return json(200, r);
      },
    },
    {
      // 账号列表（多账号第 2 片，见 accounts.ts 模块头）。
      //
      // ⚠ 只回**掩码**：凭据本身不许出这个口子（它已经能从别处拿，但少一个出口就少一处泄露面）。
      path: `${base}/accounts`,
      method: 'GET',
      handler: () => json(200, { ...accountsView(deps.store) }),
    },
    {
      path: `${base}/accounts`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const op = typeof body.op === 'string' ? body.op : '';
        const now = deps.now();
        if (op === 'add') {
          const auth = typeof body.auth === 'string' ? body.auth.trim() : '';
          if (auth === '') return json(400, { error: '要传 auth（原生凭据那一串）' });
          // ⚠ **先解析再落盘**：解不开的串存进去只会变成一个"永远登录不上、
          //   也看不出为什么"的账号。参考实现也是先 `parse_auth` 再建账号。
          const info = parseAuth(auth);
          if (info === undefined) {
            return json(400, {
              error:
                '这段凭据解不开。它应该是 `Basic <base64>`（或只有 base64 那段），' +
                '里面是 `<平台>:<手机号>:<token>`',
            });
          }
          const pcRaw = typeof body.pcPlatform === 'string' ? body.pcPlatform : '';
          if (pcRaw !== '' && pcRaw !== 'win' && pcRaw !== 'mac') {
            return json(400, { error: 'pcPlatform 只能是 win 或 mac' });
          }
          // ⚠ PC 端**要问**形态：凭据里那一格恒是 `pc`（Windows 与 macOS 都是它），
          //   分不出 win/mac，而它决定后续每一次请求的 UA 与设备头 ——
          //   选错的话这个账号以后一直用错的身份发请求。
          //
          //   界面上**没有**解析逻辑（`app.js` 是静态文件，import 不到解析器），
          //   所以这里用 `needPcPlatform` 让界面把那个选择露出来 ——
          //   解析只在后端做一次，界面不复制一份（两份会漂移）。
          if (info.platform === PC_AUTH_PREFIX && pcRaw === '') {
            return json(400, {
              error: '这条是 PC 端 —— 选一下它当初是 Windows 还是 macOS（决定以后的请求头）',
              needPcPlatform: true,
            });
          }
          const r = upsertAccount(
            deps.store,
            auth,
            now,
            undefined,
            pcRaw === '' ? undefined : (pcRaw as 'win' | 'mac'),
          );
          // ⚠ 日志里只说"谁"，不说凭据
          deps.log(`账号：${r.created ? '添加' : '更新'} ${r.account.label}`);
          if (loadAccounts(deps.store).length === 1) selectAccount(deps.store, r.account.id, now);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `${r.created ? '已添加' : '已更新'} ${r.account.label}` });
        }
        // **按账号**写设置。
        //
        // ⚠ 与 `refresh` 同一个理由：这两个键是按账号的，而"改哪一条"必须由
        //   调用方**指名**，不能靠"当前选中是谁" —— 那会改错人而且看不出来。
        if (op === 'set-settings') {
          const id = typeof body.id === 'string' ? body.id : '';
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          const one = scoped(rawStoreOf(deps.store), id);
          const secs = typeof body.listenSeconds === 'number' ? body.listenSeconds : null;
          const room = typeof body.listenRoom === 'number' ? body.listenRoom : null;
          if (secs !== null) {
            // 后端上限 3600（与 `loadListenSeconds` 的夹取一致）—— 这里也夹一次，
            // 免得库里存着一个读的时候会被悄悄改掉的值（那会让人以为"没存上"）。
            const clamped = Math.max(10, Math.min(3600, Math.round(secs)));
            one.setState('mcloud.live.listen_seconds', String(clamped), now);
          }
          if (room !== null) {
            one.setState('mcloud.live.listen_room', room > 0 ? String(Math.round(room)) : '', now);
          }
          if (typeof body.wsHeartbeat === 'string') {
            one.setState('mcloud.live.ws_heartbeat_reply', body.wsHeartbeat.trim(), now);
          }
          deps.log(`账号设置（${found.label}）：窗口 ${secs ?? '不变'}s / 房间 ${room ?? '不变'}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${found.label} 的设置已存下`,
          });
        }

        // **按账号**刷新凭据。
        //
        // ⚠ 这一条必须有"指定账号"的能力：`/auth/refresh` 刷的是**当前**账号，
        //   而卡片上的「刷新」是要刷**那一条**的。老做法只能"先切过去再刷" ——
        //   那会**改掉用户当前选中的账号**，而用户只是想让另一个号刷新一下。
        //   现在 `scoped(store, id)` 直接给出"作用在指定账号上"的 store。
        if (op === 'refresh') {
          const id = typeof body.id === 'string' ? body.id : '';
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          // ⚠ **不要**用 `scoped(store, id)` 来"指定账号"：`loadAuthRaw` 先看
          //   `currentAccount()`，而"当前是谁"是**全局**键（`mcloud.account.current`）
          //   ⇒ 刷的是当前账号、提示写的却是被点的那条，新串还落进被点那条的袋里
          //   （谁都不读）。这里把"刷哪串、写回哪条"显式传下去（F-077）。
          const r = runAuthRefresh(
            {
              store: deps.store,
              transport: deps.transport,
              nowIso: deps.now(),
              baseUrl: loadBaseUrl(deps.store),
            },
            true,
            undefined,
            { auth: found.auth, accountId: found.id },
          );
          deps.log(`凭据续期（${found.label}）：${r.note}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${found.label}：${r.note}`,
          });
        }

        // 停用 / 启用。⚠ 与"删掉"不是一回事：停用**保留**状态袋
        //（票、进度、`ordered_hour` 都还在），所以不能用"删了重加"来模拟。
        if (op === 'disable') {
          const id = typeof body.id === 'string' ? body.id : '';
          // ⚠ 第一版这里写的是 `const on = body.disabled !== true` —— **反了**：
          //   传 `disabled:true` 实际执行的是"启用"。测试当场抓到（传 true 回
          //   "已启用"）。命名也是坑：一个叫 `on` 的变量存的是"停用与否"，
          //   读代码时看不出反了。这里直接用 `disabled` 这个名字。
          const disabled = body.disabled === true;
          const a = setAccountDisabled(deps.store, id, disabled, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：${disabled ? '停用' : '启用'} ${a.label}`);
          syncTaskReadiness(deps.store);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${disabled ? '已停用' : '已启用'} ${a.label}`,
          });
        }
        // 改昵称。空串 = 回落成手机号（与参考实现的 PATCH 语义一致）。
        if (op === 'edit') {
          const id = typeof body.id === 'string' ? body.id : '';
          const label = typeof body.label === 'string' ? body.label : '';
          const a = setAccountLabel(deps.store, id, label, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：改名为 ${a.label}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `已改名为 ${a.label}`,
          });
        }
        if (op === 'select') {
          const id = typeof body.id === 'string' ? body.id : '';
          if (!selectAccount(deps.store, id, now)) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(id === '' ? '账号：清掉"当前"（回到单账号那格）' : `账号：当前切到 ${id}`);
          return json(200, { ...accountsView(deps.store), note: id === '' ? '已清掉当前账号' : `当前：${id}` });
        }
        if (op === 'remove') {
          const id = typeof body.id === 'string' ? body.id : '';
          removeAccount(deps.store, id, now);
          deps.log(`账号：删掉 ${id}`);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `已删掉 ${id}` });
        }
        return json(400, { error: '需要 {"op":"add|select|remove", …}' });
      },
    },
    {
      // 开关：领小红花（写）。默认关。
      path: `${base}/live/claim`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (typeof body.enabled !== 'boolean') {
          return json(400, { error: '需要 {"enabled": true|false}' });
        }
        setClaimEnabled(deps.store, body.enabled, deps.now());
        deps.log(`领小红花：${body.enabled ? '已开启（会真往账号里写）' : '已关闭'}`);
        return json(200, { enabled: claimEnabled(deps.store) });
      },
    },
    {
      // **推进一步**（一次调用一个上游请求 —— 面板执行预算 2000ms，见 liveDraw.ts 文件头）。
      //
      // 为什么是"一步"而不是"跑完整条链"：一个从头发到尾的函数会在第 2、3 个请求处
      // 被判超时，而那时**上游的账已经记了**。界面上那个按钮是**浏览器循环调这里**
      // 直到 `done` —— 每步一次 HTTP，每次一个上游请求。
      path: `${base}/live/draw/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveDraw(
          {
            store: deps.store,
            transport: deps.transport,
            nowIso: deps.now(),
            baseUrl: loadBaseUrl(deps.store),
          },
          { force: true }, // 手动那一枪不受开关限制（开关只管 cron）
        );
        const state = loadDrawState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: state?.step === 'done' || out.idle === true,
          state,
        });
      },
    },
    {
      // 直播日程（门）：**推进一步**（handshake 步两发 / rooms 步两发，见 liveGateTask.ts）。
      // 与 `live/draw/step` 同一个形状：界面上的按钮是浏览器循环调这里直到 `done`。
      path: `${base}/live/gate/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveGate({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
        });
        const st = loadGateState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || out.idle === true,
          step: st?.step ?? 'handshake',
          reading: readGateReading(deps.store),
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
        });
      },
    },
    {
      // 听弹幕推进一步（界面上的「听一拍」/ e2e 用）。
      // ⚠ 与门那个 step 口子同样的形状（`done` + `note` + `reading`），
      //   因为它们是**同一类**东西：一个按步骤推进的只读探针。
      path: `${base}/live/listen/step`,
      method: 'POST',
      handler: () => {
        const st0 = loadListenState(deps.store);
        if (deps.ws === undefined) {
          // ⚠ 宿主没有长连接能力时**明确说不**，而不是走到一半才发现
          //   （Python / Node 适配器都是"函数存在、调用时抛"）。
          return json(503, { error: '宿主没有长连接能力（ws_*）—— 这一族只有嵌入式 JS 宿主有' });
        }
        const out = runLiveListen({
          store: deps.store,
          transport: deps.transport,
          host: deps.ws,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
          lateMs: 0,
        });
        const st = loadListenState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || st?.step === undefined,
          step: st?.step ?? 'idle',
          reading: st,
          line: listenReadingLine(st),
          windowOpen: st0?.step === 'listen' || st0?.step === 'open',
        });
      },
    },
    {
      path: `${base}/live/codes`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearLiveCodes(deps.store, deps.now());
          deps.log('直播口令：已清空');
          return json(200, { cleared: true });
        }
        // `readBody` 对"不是 JSON 的 body"会兜成 `{session: 原文}`（让人少一步转换）
        // —— 这里顺着那个约定，贴纯文本也能存
        const raw =
          typeof body.codes === 'string'
            ? body.codes
            : typeof body.session === 'string'
              ? body.session
              : '';
        if (!raw.trim()) {
          return json(400, { error: '需要 {"codes": "<口令，一行一条>"} 或 {"clear": true}' });
        }
        const r = saveLiveCodes(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error ?? '解不出口令' });
        // ⚠ 口令不是账号凭据（它是**共享资源**，谁拿到都能用），所以这里如实回显
        deps.log(`直播口令：存了 ${r.codes.length} 条（${r.how}）`);
        return json(200, {
          saved: r.codes.length,
          codes: r.codes,
          how: r.how,
          stored: loadLiveCodes(deps.store),
        });
      },
    },
    {
      // 分组视图：把 20 条云盘任务按**风险与依赖**分组，附每条的实际状态。
      // 界面（M4）直接吃这个; 现在也能 curl 看。
      path: `${base}/groups`,
      method: 'GET',
      handler: () => json(200, groupView(deps.store)),
    },
    {
      path: `${base}/tasks`,
      method: 'GET',
      handler: () => {
        let last: unknown = null;
        const raw = deps.store.getState(STATE_LAST_TASKLIST);
        try {
          last = raw ? JSON.parse(raw) : null;
        } catch {
          last = { broken: true };
        }
        // 每条任务各自的最近失败原因（base.ts 写的 `mcloud.last_error.<任务名>`）。
        // 给界面用，也让 CI 能断言「这一批任务都没报错」——如果没有这个字段，
        // 那种断言会因为拿不到数据而**永远通过**（我第一版就是这么写的，等于没测）。
        const lastErrorByTask: Record<string, string> = {};
        for (const t of TASK_NAMES) {
          const v = deps.store.getState(`mcloud.last_error.${t}`);
          if (v) lastErrorByTask[t] = v;
        }
        return json(200, {
          lastTaskList: last,
          lastErrorByTask,
          recent: deps.store.recentRuns(20),
        });
      },
    },
    {
      // 「今日AI豆」—— **只读**，一枪 `cloudRecordV2` 翻到底再按**东八区自然日**汇总。
      //
      // 照参考实现（`mcloud-tasks/src/beans.rs` + 路由 `GET /api/beans/today`）：
      //   · **按账号一列**，**没有 `total` / `net` 这种跨账号字段** ——
      //     豆是每个账号各一本账，加出来的总数哪个账号都花不了。
      //   · **失败按账号隔离**：某个账号读不到（无会话 / 网络 / 上游码 /
      //     翻不到底 / 解不出 `insertTime`）只让它那一行进 `failed[]`，
      //     其余账号照常出数。这一条**不返回错误状态** —— 一个账号挂了不该
      //     把整张卡打成"服务挂了"。
      //   · **点了才取**：界面上那一格不做自动刷新；这一条路由每次点都真打上游。
      path: `${base}/beans/today`,
      method: 'GET',
      // 逐账号 × 翻页 + **当场续票**的只读链：一发上游的超时就有 1500ms，
      // 面板默认 2 秒撑不到"把所有账号读一遍"。现在票过期还会**内联换票**
      // （`withTokenGate`：到期主动一轮 + `90001` 被动最多两轮，每轮四步 × 1500ms）。
      // 按最坏一档留预算：几个账号各可能"读失败→换票→再读"若干轮。健康路径秒回，
      // 这一档只在票全烂时才顶到。
      budget_ms: 60_000,
      handler: () => {
        const raw = rawStoreOf(deps.store);
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        // 同一趟**所有账号共用同一个 `nowMs`**：不然跨零点那一瞬间两个账号会按
        //   不同的日界算（照参考实现 `BeansEnv::clock` 那一条）。
        const baseUrl = loadBaseUrl(deps.store);
        const rows: {
          id: string;
          label: string;
          net: number;
          gained: number;
          spent: number;
          count: number;
        }[] = [];
        const failed: { id: string; label: string; reason: string }[] = [];
        for (const a of loadAccounts(deps.store)) {
          // ⚠ **跳停用的账号** —— 停用就是"别拿它跑"（见 `accounts.ts::disabled`
          //   与 `resolveTaskAccounts`），读账也一样：它都停用了还去点它上游，
          //   用户看到一行"停用里的账号读失败"就是纯噪声。
          if (a.disabled === true) continue;
          const one = scoped(raw, a.id);
          try {
            const day = readDayForAccount(
              { store: one, transport: deps.transport, baseUrl, nowIso },
              nowMs,
            );
            rows.push({ id: a.id, label: a.label, ...day });
          } catch (e) {
            failed.push({
              id: a.id,
              label: a.label,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return json(200, { nowMs, accounts: rows, failed });
      },
    },
    {
      // 「查看明细」—— 一个账号的流水，**不限于今日**。窗口 `days ∈ 1/7/30/0`
      // （`0` = 全部）；`MAX_DETAIL_RECORDS` 撞上时 `hasMore=true`，界面写一句
      // "还有更多没列出来"，**不静默截断**。
      //
      // ⚠ 数据源与 `/beans/today` **同一条**：还是上游 `cloudRecordV2`。
      //   **不是**本仓的运行记录 / 明细账本 —— 那是"我们做过什么"，
      //   流水是"上游账上发生了什么"，两者对不上是常态（重试、手动操作、别的端）。
      //   这一条要回答的是后者。
      path: `${base}/beans/records`,
      method: 'GET',
      // 「全部」那一档要把这个账号的流水**翻到底**（最多 `MAX_PAGES`=20 页）才能
      // 如实说"有没有更多"，一页一发 ⇒ 最坏 20 发 × 1500ms = 30s；再叠上"当场续票"
      // （到期主动一轮 + `90001` 被动最多两轮，每轮四步）⇒ 比今日那条再宽一档。
      budget_ms: 90_000,
      handler: (req) => {
        const q = parseQuery(req.query ?? '');
        const id = q['id'] ?? '';
        const days = normalizeDays(q['days']);
        const found = loadAccounts(deps.store).find((a) => a.id === id);
        if (!found) return json(400, { error: `列表里没有这个账号：${id || '（没给 id）'}` });
        const raw = rawStoreOf(deps.store);
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        const baseUrl = loadBaseUrl(deps.store);
        const one = scoped(raw, id);
        try {
          const data = readRecordsForAccount(
            { store: one, transport: deps.transport, baseUrl, nowIso },
            nowMs,
            days,
          );
          return json(200, {
            account: found.label,
            days,
            nowMs,
            records: data.records,
            undated: data.undated,
            hasMore: data.hasMore,
          });
        } catch (e) {
          return json(200, {
            account: found.label,
            days,
            nowMs,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
  ];
}
