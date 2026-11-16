// exchange 那一组路由（8 条）：/exchange · /matrix · /exchange/try · /exchange/picks · /exchange/subs · /exchange/subs · /exchange/plans · /exchange/order
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { loadBaseUrl } from '../../../mcloud/session.ts';
import { STATE_STEP, clearOrder, runOrderStep, startOrder } from '../../../mcloud/tasks/exchangeOrder.ts';
import { parseQuery } from '../../../mcloud/query.ts';
import { parseCron } from '../../../mcloud/scheduleCron.ts';
import { STATE_LEAD_SEC, STATE_SCHEDULE_CRON, STATE_SCHEDULE_GEN, STATE_SCHEDULE_MAX_RUNS, STATE_SCHEDULE_PLAN, STATE_SCHEDULE_PLAN_NAME, STATE_SCHEDULE_UNTIL, runExchange, setScheduleEnabled } from '../../../mcloud/tasks/exchangeRun.ts';
import { MATRIX_MARKETS, readMatrix, runAppTaskMatrix } from '../../../mcloud/tasks/appTaskMatrix.ts';
import { VERDICT_TEXT, readExchangeList, readPickCache, readSubscriptions, runExchangeList, toggleSubscription } from '../../../mcloud/tasks/exchangeList.ts';
import { currentAccount, loadAccounts } from '../../../mcloud/accounts.ts';
import { rawStoreOf, scoped } from '../../../store/scoped.ts';
import { resolveTaskAccounts } from '../../../mcloud/taskAccounts.ts';
import { loadPlans, newPlanId, planViews, resetPlanRuns, savePlans } from '../../../mcloud/exchangePlans.ts';
import type { ExchangePlan } from '../../../mcloud/exchangePlans.ts';
import { setTaskPaused, syncExchangeJob } from '../../../mcloud/taskReadiness.ts';
import { json, readBackupState, readBody, readMatrixLocal } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';

/** exchange 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function exchangeRoutes(deps: RouteDeps, base: string, verify: () => { ok: boolean; note: string }): RouteEntry[] {
  void verify;
  return [
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
      // 点「刷新」会真打移动云盘（两个市场各一发）——必须自己声明预算。
      budget_ms: 60_000,
      handler: (req) => {
        // **按账号读本地缓存**，默认当前账号；`?account=<id>` 切到别的号。
        // ⚠ 这一条**不发上游请求** —— 只读日常任务已经落下的矩阵读数。
        const q = parseQuery(req.query ?? '');
        const wanted = q['account'] ?? '';
        const accounts = loadAccounts(deps.store);
        const found = wanted === '' ? currentAccount(deps.store) : accounts.find((a) => a.id === wanted);
        if (!found) return json(400, { error: `列表里没有这个账号：${wanted || '（没给 id）'}` });
        const one = scoped(rawStoreOf(deps.store), found.id);
        // 默认只读本地；`refresh=1` 才真去请求（用户点「刷新」）。
        const refresh = q['refresh'] === '1';
        const refreshErrors: string[] = [];
        if (refresh) {
          for (const _ of MATRIX_MARKETS) {
            const out = runAppTaskMatrix({
              store: one,
              transport: deps.transport,
              nowIso: deps.now(),
              baseUrl: loadBaseUrl(deps.store),
            });
            if (!out.ok) refreshErrors.push(out.note);
          }
        }
        const rows = readMatrix(one);
        return json(200,{
          account: found.id,
          label: found.label,
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
          at: deps.now(),
          backup: readBackupState(one, deps.now()),
          local: readMatrixLocal(one),
          refreshed: refresh,
          refreshErrors,
        });
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
    }
  ];
}
