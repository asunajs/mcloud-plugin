// beans 那一组路由（5 条）：/beans/today · /beans/records · /prizes · /prizes/claim · /prizes/confirm
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { loadBaseUrl } from '../../../mcloud/session.ts';
import { parseQuery } from '../../../mcloud/query.ts';
import { currentAccount, loadAccounts, upsertAccount } from '../../../mcloud/accounts.ts';
import { rawStoreOf, scoped } from '../../../store/scoped.ts';
import { resolveTaskAccounts } from '../../../mcloud/taskAccounts.ts';
import { PRIZE_CACHE_TTL_MS, confirmPrizeClaim, ensurePrizeToken, loadClaimState, loadPrizeCache, maskPhoneLike, readPendingPrizes, savePrizeCache, startPrizeClaim, withPrizeTokenGate } from '../../../mcloud/tasks/prizeClaim.ts';
import type { PrizeListResult } from '../../../mcloud/tasks/prizeClaim.ts';
import { LoginExpiredError } from '../../../mcloud/tokenGate.ts';
import { dayStartMs } from '../../../mcloud/beans.ts';
import type { BeanDay } from '../../../mcloud/beans.ts';
import { BEANS_CACHE_TTL_MS, loadBeansCache, normalizeDays, readDayForAccount, readRecordsForAccount, saveBeansCache } from '../../../mcloud/beansRead.ts';
import { fetchInfoV3 } from '../../../mcloud/tasks/info.ts';
import { json, readBody } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';

/** beans 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
/** 面板/上游的错误常被包成一整串 `{"message":"…"}` —— 显示前拆开，别把 JSON 原样糊到界面上。 */
function plainError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  try {
    const v = JSON.parse(s) as unknown;
    if (v !== null && typeof v === 'object') {
      const m = (v as { message?: unknown }).message;
      if (typeof m === 'string' && m !== '') return m;
    }
  } catch {
    /* 不是 JSON，原样返回 */
  }
  return s;
}

export function beansRoutes(deps: RouteDeps, base: string, verify: () => Promise<{ ok: boolean; note: string }>): RouteEntry[] {
  void verify;
  return [
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
      //   · **缓存 2 小时**：余额和当日汇总都缓存（用户口径）；手动「刷新」带
      //     `?refresh=1` 强刷。缓存按账号存在各自的袋里。
      path: `${base}/beans/today`,
      method: 'GET',
      // 逐账号 × 翻页 + **当场续票**的只读链：一发上游的超时就有 1500ms，
      // 面板默认 2 秒撑不到"把所有账号读一遍"。现在票过期还会**内联换票**
      // （`withTokenGate`：到期主动一轮 + `90001` 被动最多两轮，每轮四步 × 1500ms）。
      // 按最坏一档留预算：几个账号各可能"读失败→换票→再读"若干轮。健康路径秒回，
      // 这一档只在票全烂时才顶到。
      budget_ms: 60_000,
      handler: async (req) => {
        const q = parseQuery(req.query ?? '');
        const refresh = q['refresh'] === '1';
        const raw = rawStoreOf(deps.store);
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        // 同一趟**所有账号共用同一个 `nowMs`**：不然跨零点那一瞬间两个账号会按
        //   不同的日界算（照参考实现 `BeansEnv::clock` 那一条）。
        const baseUrl = loadBaseUrl(deps.store);
        const todayStart = dayStartMs(nowMs);
        const rows: {
          id: string;
          label: string;
          net: number;
          gained: number;
          spent: number;
          count: number;
          balance?: number | undefined;
          balanceReason?: string | undefined;
          cached: boolean;
          cachedAt?: number | undefined;
        }[] = [];
        const failed: { id: string; label: string; reason: string }[] = [];
        for (const a of loadAccounts(deps.store)) {
          // ⚠ **跳停用的账号** —— 停用就是"别拿它跑"（见 `accounts.ts::disabled`
          //   与 `resolveTaskAccounts`），读账也一样：它都停用了还去点它上游，
          //   用户看到一行"停用里的账号读失败"就是纯噪声。
          if (a.disabled === true) continue;
          const one = scoped(raw, a.id);
          const cache = loadBeansCache(one);
          const dayFresh =
            !refresh &&
            cache.day !== undefined &&
            nowMs - cache.day.atMs < BEANS_CACHE_TTL_MS &&
            cache.day.dayStart === todayStart;
          let day: BeanDay;
          let cached = false;
          if (dayFresh) {
            day = cache.day!.day;
            cached = true;
          } else {
            try {
              day = await readDayForAccount(
                { store: one, transport: deps.transport, baseUrl, nowIso },
                nowMs,
              );
              cache.day = { atMs: nowMs, dayStart: todayStart, day };
            } catch (e) {
              failed.push({
                id: a.id,
                label: a.label,
                reason: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }

          // 当前余额：`infoV3.result.total`。缓存和当日汇总独立过期——
          // 余额读失败不影响今日流水已经拿到的数。
          const balanceFresh =
            !refresh &&
            cache.balance !== undefined &&
            nowMs - cache.balance.atMs < BEANS_CACHE_TTL_MS;
          let balance: number | undefined;
          let balanceReason: string | undefined;
          if (balanceFresh) {
            balance = cache.balance!.value ?? undefined;
            balanceReason = cache.balance!.reason;
          } else {
            const info = await fetchInfoV3({ store: one, transport: deps.transport, baseUrl });
            if (info.ok && info.info.total !== undefined) {
              balance = info.info.total;
              cache.balance = { atMs: nowMs, value: balance };
            } else {
              balanceReason = info.ok ? '服务端没给余额字段' : info.error;
              // 读失败不缓存：下一次刷新还要再试，不能把一次网络抖动冻两小时。
              cache.balance = undefined;
            }
          }
          saveBeansCache(one, cache, nowIso);
          rows.push({
            id: a.id,
            label: a.label,
            ...day,
            balance,
            balanceReason,
            cached,
            cachedAt: cached ? cache.day?.atMs : undefined,
          });
        }
        return json(200, {
          nowMs,
          accounts: rows,
          failed,
          cached: rows.length > 0 && rows.every((r) => r.cached),
          cacheTtlMs: BEANS_CACHE_TTL_MS,
        });
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
      handler: async (req) => {
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
          const data = await readRecordsForAccount(
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

{
      path: `${base}/prizes`,
      method: 'GET',
      // 翻最多 3 页 × 100 条 + 可能的当场续票（到期主动一轮 / 90001 被动两轮）。
      budget_ms: 90_000,
      handler: async (req) => {
        const q = parseQuery(req.query ?? '');
        const wanted = (q['account'] ?? '').trim();
        const refresh = q['refresh'] === '1';
        const accounts = loadAccounts(deps.store);
        const cur = currentAccount(deps.store);
        // ⚠ 账号标签默认就是**完整手机号**（`accounts.ts::upsertAccount` 用 `phoneOf`）。
        //   领奖页会把 label 显示在下拉与"验证码发到 …"那一句里 ⇒ 这一层统一脱敏。
        const view = accounts.map((a) => ({
          id: a.id,
          label: maskPhoneLike(a.label) ?? a.label,
          current: cur !== undefined && cur.id === a.id,
          disabled: a.disabled === true,
        }));
        // 默认看"当前账号"；当前那个停用了就退到第一条启用的（停用的号不该被默认读）
        const found =
          wanted === ''
            ? cur !== undefined && cur.disabled !== true
              ? cur
              : accounts.find((a) => a.disabled !== true)
            : accounts.find((a) => a.id === wanted);
        if (wanted !== '' && found === undefined) {
          return json(400, { error: `列表里没有这个账号：${wanted}` });
        }
        if (found === undefined) {
          // 没有账号 ≠ 读失败：界面要显示"去账号页加一个"，不是一句红字
          return json(200, {
            ok: true,
            accounts: view,
            account: null,
            nowMs: Date.parse(deps.now()),
            cached: false,
            pending: 0,
            scanned: 0,
            hasMore: false,
            items: [],
            noAccount: true,
          });
        }
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        const one = scoped(rawStoreOf(deps.store), found.id);
        const who = maskPhoneLike(found.label) ?? found.label;
        const prizeDeps = {
          store: one,
          transport: deps.transport,
          nowIso,
          baseUrl: loadBaseUrl(deps.store),
          nowMs: () => Date.parse(deps.now()),
        };
        const last = loadPrizeCache(one);
        // 新鲜度：`refresh=1` 一律重读；否则 TTL 内直接用缓存。
        const fresh = last !== null && !refresh && nowMs - last.atMs < PRIZE_CACHE_TTL_MS;
        let list: PrizeListResult;
        let cached = false;
        // 读失败但手上有旧清单时**退回旧清单**（2026-11-17 现场：链路抖一下，
        // 明明 10 分钟前刚读过 18 件，整页却变成「读不到」）。
        // 宁可说「这是 15:32 的清单，刚才没读到（原因）」，也别把有数据的页面清空。
        let stale = false;
        let staleAtMs = 0;
        let staleReason: string | undefined;
        if (fresh) {
          list = last.list;
          cached = true;
        } else {
          try {
            const read = await withPrizeTokenGate(prizeDeps, async () => await readPendingPrizes(prizeDeps));
            // ⚠ 网络失败**不会抛**：`readPendingPrizes` 把它收成 `failed`（这样后几页挂了
            //   还能给出前几页）。所以「一条都没读到」要在这里判，和抛异常一样退回旧清单。
            if (read.failed !== undefined && read.items.length === 0 && last !== null) {
              list = last.list;
              stale = true;
              staleAtMs = last.atMs;
              staleReason = plainError(read.failed);
              deps.log(
                `领奖：${who} 这次没读到（${read.failed}），先用 ${new Date(last.atMs).toISOString()} 那份清单` +
                  `（${last.list.items.length} 件）`,
              );
            } else {
              list = read;
              savePrizeCache(one, list, nowMs, nowIso);
              deps.log(
                `领奖：${who} 读到 ${list.items.length} 件待领取（共翻到 ${list.scanned} 条记录` +
                  `${list.failed === undefined ? '' : `；${list.failed}`}）`,
              );
            }
          } catch (e) {
            // 读失败**不写缓存**（网络抖一下不该被冻住 60 秒），但原因要如实带回界面
            const why = plainError(e);
            if (last === null) {
              list = { items: [], scanned: 0, hasMore: false, failed: why };
            } else {
              list = last.list;
              stale = true;
              staleAtMs = last.atMs;
              staleReason = why;
              deps.log(
                `领奖：${who} 这次没读到（${why}），先用 ${new Date(last.atMs).toISOString()} 那份清单` +
                  `（${last.list.items.length} 件）`,
              );
            }
          }
        }
        return json(200, {
          ok: true,
          accounts: view,
          account: { id: found.id, label: maskPhoneLike(found.label) ?? found.label },
          nowMs,
          cached,
          pending: list.items.length,
          scanned: list.scanned,
          hasMore: list.hasMore === true,
          ...(list.totalCount !== undefined ? { totalCount: list.totalCount } : {}),
          items: list.items,
          ...(list.failed !== undefined ? { failed: list.failed } : {}),
          ...(stale ? { stale: true, cachedAtMs: staleAtMs, staleReason } : {}),
        });
      },
    },

{
      // 第一段：读详情 → 取滑块题面（本地解偏移）→ 发验证码短信。
      //
      // ⚠ 这一枪**会真的发一条短信**（到账号绑定的手机）。所以只有用户点了
      //   「领取」才会走到这里；同一件 60 秒内不重发（本地闸，别让上游回 1001）。
      path: `${base}/prizes/claim`,
      method: 'POST',
      // 详情一发 + 题面一发 + 发码一发，再加"当场续票"与本地解图（JPEG 680×400）。
      budget_ms: 120_000,
      handler: async (req) => {
        const b = readBody(req);
        const id = typeof b['account'] === 'string' ? b['account'] : '';
        const oidRaw = b['oid'];
        const oid =
          typeof oidRaw === 'string'
            ? oidRaw.trim()
            : typeof oidRaw === 'number' && Number.isFinite(oidRaw)
              ? String(oidRaw)
              : '';
        const accounts = loadAccounts(deps.store);
        const found =
          id === '' ? currentAccount(deps.store) : accounts.find((a) => a.id === id);
        if (found === undefined) {
          return json(400, { error: id === '' ? '还没有账号 —— 去「账号」页加一个' : `列表里没有这个账号：${id}` });
        }
        if (oid === '') return json(400, { error: '要带一个 oid（领哪一件）' });
        const one = scoped(rawStoreOf(deps.store), found.id);
        const nowIso = deps.now();
        const prizeDeps = {
          store: one,
          transport: deps.transport,
          nowIso,
          baseUrl: loadBaseUrl(deps.store),
          nowMs: () => Date.parse(deps.now()),
        };
        const cache = loadPrizeCache(one);
        const item = cache?.list.items.find((x) => x.oid === oid);
        if (item === undefined) {
          return json(400, { error: '列表里没有这一件 —— 先点「刷新」再点一次「领取」' });
        }
        const who = maskPhoneLike(found.label) ?? found.label;
        // ⚠ **写这一族不走 `withPrizeTokenGate` 的自动重跑**：票过期先换一轮票，
        //   换不成就让用户自己再点（他点了才算重试）。理由见 `ensurePrizeToken`。
        const pre = await ensurePrizeToken(prizeDeps);
        if (!pre.ok) {
          return json(200, {
            ok: false,
            note: pre.note ?? '登录信息需要换一次 —— 去「账号」页点一下刷新，再回来领',
          });
        }
        try {
          const r = await startPrizeClaim(prizeDeps, item, who);
          deps.log(`领奖：${who} · ${item.name} —— ${r.note}`);
          return json(200, { ...r, at: r.at ?? Date.parse(nowIso) });
        } catch (e) {
          const note =
            e instanceof LoginExpiredError
              ? '登录信息过期了 —— 去「账号」页重新登录一次再试（这一枪没有发出去）'
              : e instanceof Error
                ? e.message
                : String(e);
          deps.log(`领奖：${who} · ${item.name} —— ${note}`);
          return json(200, { ok: false, note });
        }
      },
    },

{
      // 第二段：提交验证码，真正领取。
      //
      // ⚠ 状态来自上一步落的那一单（`mcloud.prizes.claim`）：没发过短信就不许确认
      //   —— 否则拿旧单/别人的单去撞，只会换回一个看不懂的错误码。
      path: `${base}/prizes/confirm`,
      method: 'POST',
      // 一发写请求 + 可能的当场续票；不重试写这一枪（没有幂等键，重试由用户决定）。
      budget_ms: 60_000,
      handler: async (req) => {
        const b = readBody(req);
        const id = typeof b['account'] === 'string' ? b['account'] : '';
        const oidRaw = b['oid'];
        const oid =
          typeof oidRaw === 'string'
            ? oidRaw.trim()
            : typeof oidRaw === 'number' && Number.isFinite(oidRaw)
              ? String(oidRaw)
              : '';
        const codeRaw = b['code'];
        const code =
          typeof codeRaw === 'string'
            ? codeRaw
            : typeof codeRaw === 'number' && Number.isFinite(codeRaw)
              ? String(codeRaw)
              : '';
        const accounts = loadAccounts(deps.store);
        const found =
          id === '' ? currentAccount(deps.store) : accounts.find((a) => a.id === id);
        if (found === undefined) {
          return json(400, { error: id === '' ? '还没有账号 —— 去「账号」页加一个' : `列表里没有这个账号：${id}` });
        }
        if (oid === '') return json(400, { error: '要带一个 oid（领哪一件）' });
        if (code.trim() === '') return json(400, { error: '验证码没填' });
        const one = scoped(rawStoreOf(deps.store), found.id);
        const nowIso = deps.now();
        // 没发过码就不许确认：拿旧单/别人的单去撞，只会换回一个看不懂的错误码
        const pendingClaim = loadClaimState(one);
        if (pendingClaim === null || pendingClaim.oid !== oid) {
          return json(400, { error: '先点「领取」发验证码，再来填这一条' });
        }
        const prizeDeps = {
          store: one,
          transport: deps.transport,
          nowIso,
          baseUrl: loadBaseUrl(deps.store),
          nowMs: () => Date.parse(deps.now()),
        };
        const who = maskPhoneLike(found.label) ?? found.label;
        // 同 claim：只"写前换票"，**不自动重跑**这一枪（没有幂等键）
        const pre = await ensurePrizeToken(prizeDeps);
        if (!pre.ok) {
          return json(200, {
            ok: false,
            note: pre.note ?? '登录信息需要换一次 —— 去「账号」页点一下刷新，再回来确认',
          });
        }
        try {
          const r = await confirmPrizeClaim(prizeDeps, oid, code);
          // ⚠ 验证码与 deviceId **不进日志**：这里只记结果那一句
          deps.log(`领奖：${who} · ${r.ok ? r.note : `没成（${r.note}）`}`);
          return json(200, r);
        } catch (e) {
          const note =
            e instanceof LoginExpiredError
              ? '登录信息过期了 —— 去「账号」页重新登录一次再试（这一枪没有发出去）'
              : e instanceof Error
                ? e.message
                : String(e);
          deps.log(`领奖：${who} · 确认失败 —— ${note}`);
          return json(200, { ok: false, note });
        }
      },
    }
  ];
}
