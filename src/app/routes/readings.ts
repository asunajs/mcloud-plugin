// GET /readings 的那个大对象：界面首屏要的全部读数。
//
// 单独一份是因为它只读：不写状态、不发请求（只读会话）。

import { PLUGIN_VERSION } from '../../version.ts';
import { loadBaseUrl, sessionStatus } from '../../mcloud/session.ts';
import { hasBigInt } from '../../mcloud/caps.ts';
import { parseAuthorization } from '../../mcloud/authRefresh.ts';
import { pushReading } from '../../mcloud/pushConfig.ts';
import { hourKey, targetHourOf, timingReading } from '../../mcloud/exchangeTiming.ts';
import { recentRuns } from '../../mcloud/runLog.ts';
import { STATE_ORDERED_HOUR, exchangeLeadMs } from '../../mcloud/tasks/exchangeOrder.ts';
import { STATE_SCHEDULE_CRON, STATE_SCHEDULE_MODE, STATE_SCHEDULE_ONCE_DATE, STATE_SCHEDULE_PLAN, STATE_SCHEDULE_PLAN_NAME, STATE_SCHEDULE_UNTIL, scheduleEnabled, scheduleLeadSec, scheduleMaxRuns, scheduleNextTargetMs, scheduleRuns } from '../../mcloud/tasks/exchangeRun.ts';
import { claimEnabled, drawReport, loadDrawState } from '../../mcloud/tasks/liveDraw.ts';
import { MATRIX_MARKETS, readMatrix } from '../../mcloud/tasks/appTaskMatrix.ts';
import { DAILY_DONE_KEY, readDailyRun } from '../../mcloud/dailyState.ts';
import { VERDICT_TEXT, readExchangeList, readPickCache, readSubscriptions } from '../../mcloud/tasks/exchangeList.ts';
import { loadLiveCodes, loadLiveUrl, readLiveReading, readPoolSummary } from '../../mcloud/tasks/liveRoom.ts';
import { XIAOHONGSHU_KOULING_PROFILE_URL } from '../../mcloud/liveKouling.ts';
import { accountKey, loadFreshPool, localStamp } from '../../mcloud/koulingPool.ts';
import { loadGateBase, readGateReading } from '../../mcloud/tasks/liveGateTask.ts';
import { currentAccountDomain, loadAccounts } from '../../mcloud/accounts.ts';
import { listenReadingLine, loadImBase, loadListenRoom, loadListenSeconds, loadListenState, loadWsBase, loadWsHeartbeat } from '../../mcloud/tasks/liveListen.ts';
import { loadWakePlan } from '../../mcloud/tasks/liveAutoTask.ts';
import { qrSvg } from '../../crypto/qr.ts';
import { pcClient, qrPayload } from '../../mcloud/login.ts';
import { loginReading } from '../../mcloud/loginSession.ts';
import { rawStoreOf, scoped } from '../../store/scoped.ts';
import { resolveTaskAccounts, taskAccountsView } from '../../mcloud/taskAccounts.ts';
import { planViews } from '../../mcloud/exchangePlans.ts';
import { accountsView, loadLoginBase, loginPlatform, readBackupState, readMatrixLocal, sessionPlatform } from './support.ts';
import type { RouteDeps } from './support.ts';

export function buildReadings(deps: RouteDeps): Record<string, unknown> {
  const nowMs = Date.parse(deps.now());
  const nowIso = deps.now();
  const view = accountsView(deps.store);

  return {
    at: nowIso,
    // 界面右上角要印「跑的是哪一版」—— 用户排查时第一句就是这个。
    version: PLUGIN_VERSION,
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
      // ⚠ `doneToday` 是**读数**，不是闸 —— 日常的每一趟都照跑（后一趟兜底，
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
      // ⚠ 上限给到 20：一次触发**每个账号各一条**记录（共用 `at`），默认 5 条
      //   在多账号时会把更早那一趟截掉 ⇒ 界面按 `at` 去重算「趟」就会少算。
      recent: recentRuns(deps.store, 'daily', 20),
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
    live: (() => {
      // ⚠ 直播的「收口令」只用**第一个选中账号**（口令是共享的），所以界面也必须
      //   读那个号的袋。读当前账号会把「移动」10 月 17 日的旧读数印到今天的卡片上
      //   —— 实际直播正在 小号 的袋里 active=true，界面却报「没有目标主播的房间」。
      const first = resolveTaskAccounts(deps.store, '直播', 'auto')[0] ?? '';
      const liveOne = first === '' ? deps.store : scoped(rawStoreOf(deps.store), first);
      const liveGate = readGateReading(liveOne);
      const liveListen = loadListenState(liveOne);
      return {
      reading: readLiveReading(liveOne),
      // 界面要看到**所有抓到的口令**（包括无效的），不能只显示人贴的那一份；
      // 也不能把 `LiveCodes` 这个对象直接丢给界面（它要的是数组）。
      codes: (() => {
        const human = loadLiveCodes(liveOne)?.codes ?? [];
        const fresh = loadFreshPool(deps.store, nowMs);
        const poolCodes = fresh.pool.codes;
        const claims = fresh.pool.claims;
        const labels = new Map(
          loadAccounts(deps.store).map((a) => [accountKey(parseAuthorization(a.auth)?.phone ?? ''), a.label]),
        );
        // 「谁验的」在池里按账号 id 记（validatedBy），界面上要换成标签
        const byId = new Map(loadAccounts(deps.store).map((a) => [a.id, a.label]));
        // 口令是共享的，但“领过”是**按账号**记的；这里把账号标签一并给界面，
        // 否则三个号时只写“这个账号”根本不知道是哪个（2026-11-03 现场）。
        const claimedBy = (code: string): string[] =>
          Object.entries(claims)
            .filter(([, mine]) => mine[code] === 'claimed' || mine[code] === 'alreadyClaimed')
            .map(([id]) => labels.get(id) ?? id);
        const seen = new Set<string>();
        // 人贴的那一份是什么时候贴的（`LiveCodes.at`）；池子里的按「判有效 / 第一次见到」。
        // 界面上每条口令都要能说出时间 —— 没有时间的「已验证有效」读者没法判断新旧。
        const humanAt = Date.parse(loadLiveCodes(liveOne)?.at ?? '');
        const out: Array<{
          code: string;
          state?: string;
          source?: string;
          reason?: string;
          claimedBy?: string[];
          atMs?: number;
          /** 谁验的（账号标签）：用户口径「应该记录操作者账号」。 */
          by?: string;
        }> = [];
        for (const c of human) {
          const code = c.trim();
          if (code === '' || seen.has(code)) continue;
          seen.add(code);
          out.push({
            code,
            source: '手动',
            claimedBy: claimedBy(code),
            ...(Number.isFinite(humanAt) ? { atMs: humanAt } : {}),
          });
        }
        for (const c of poolCodes) {
          if (seen.has(c.value)) continue;
          seen.add(c.value);
          const by = claimedBy(c.value);
          out.push({
            code: c.value,
            state: c.state,
            source: c.source,
            // 老池子里存的是“这个账号已领过”；有具体账号标签时不要再显示这句
            // 含糊话，统一成“已验证有效 + 已领过：<账号名>”。
            reason: by.length > 0 ? '已验证有效' : c.reason,
            claimedBy: by,
            atMs: c.validAtMs ?? c.firstSeenMs,
            // `validatedBy` 记的是**账号键**（`accountOf` = phone 的 hash），与 `labels` 同一套键；
            // 再兜一层 id（万一哪天改成记 id）
            ...(c.validatedBy === undefined
              ? {}
              : { by: labels.get(c.validatedBy) ?? byId.get(c.validatedBy) ?? c.validatedBy }),
          });
        }
        return out;
      })(),
      url: loadLiveUrl(liveOne),
      pool: readPoolSummary(deps.store, localStamp(nowMs), nowMs),
      gate: liveGate,
      listenSeconds: loadListenSeconds(deps.store),
      listen: {
        reading: liveListen,
        line: listenReadingLine(liveListen),
      },
      recent: recentRuns(deps.store, 'live'),
      auto: (() => {
        const plan = loadWakePlan(liveOne);
        return {
          wakeAt: plan?.wakeAt ?? '',
          wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
        };
      })(),
      // 写那半的本地闸门（默认关）。界面要能看见并打开它，否则永远只会说
      // 「领小红花没开」，而用户找不到开关。
      claim: { enabled: claimEnabled(deps.store) },
      // 领小红花的**结论**（四栏 + 进账）。界面第一行显示的就是 `line`。
      // ⚠ 「本场已结束」与「口令无效」分栏的理由见 liveDraw.drawReport 的注释 ——
      //   分错的后果是用户去重抄一条本来就对的口令。
      draw: (() => {
        // ⚠ 必须读**第一个任务账号**的袋（liveOne）：`mcloud.live.draw` 是按账号的键，
        //   而任务是写在那里。用 `deps.store`（当前查看的号）会在「看的号和跑的号不是同一个」时
        //   显示别人的那一轮，或者干脆「还没领过」—— 2026-11-17 复核的 F3。
        const st = loadDrawState(liveOne);
        const r = drawReport(st);
        return {
          enabled: claimEnabled(deps.store),
          step: st?.step ?? '',
          report: r,
          // ⚠ 上一轮是**什么时候**的（2026-11-17 用户原话：「说上一轮，也没人知道上一轮
          //   是什么时候」）。界面那句「1 条口令领到 1 条」没有时间就等于没回答。
          at: st === null ? null : (st.finishedAt ?? st.startedAt),
          // 这个开关只是"允许插件去领"；功能本身要服务端那边开（用户口径 2026-10-17）
          line:
            r === null
              ? claimEnabled(deps.store)
                ? '还没领过'
                : '领小红花没开 —— 要先在服务端那边开启（这里的开关只是允许插件去领）'
              : r.line,
        };
      })(),
      };
    })(),
    data: {
      hasBigInt: hasBigInt(),
      // ⚠ 矩阵读数按账号存在各自的袋里；`deps.store` 是**默认袋**，
      //   直接 `readMatrix(deps.store)` 会让数据页永远显示另一个号的状态。
      matrix: (() => {
        const one = view.current === '' ? deps.store : scoped(rawStoreOf(deps.store), view.current);
        const rows = readMatrix(one);
        return {
          groups: rows.map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
          read: rows.filter(Boolean).length,
          total: MATRIX_MARKETS.length,
          backup: readBackupState(one, nowIso),
          local: readMatrixLocal(one),
        };
      })(),
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
