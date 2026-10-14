// 兑换下单 —— **写**，而且是这一族里唯一不可逆的一步（真扣 AI 豆）。
//
// # 枪序照 mcloud 逐条搬
//
// ```text
// 1  GET  exchangeList   清单：limit 与三个余量、价格（只读）
// 2  GET  infoV3         余额（判"够不够"，也是成交后的**对照基准**）
// 2.5 ← 换 deviceId      ⚠ **在等待之前**取好（拿不到 id 时先白等再白打两枪）
// 3  POST visitlog ×2    预热：`…_to_exchange` → 等 500ms → `…_exchange_times`
// 4  POST getSlide       取滑块题面 + 本地算 offset
// 5  POST exchangeV3     下单（`514` 之后重取一题再来一枪，上限 `SLIDER_ROUNDS` 轮）
// 6  GET  infoV3         复查余额差
// ```
//
// # 三条不许"顺手改"的地方
//
// ① **算不出滑块就不发**。
//
//    ⚠ 理由要**说准**：mcloud 那里写的是"拿 `0` 或上一次的答案去凑，是拿真豆去赌"，
//    这个说法我照抄过，但它**不对** —— offset 错了那一枪回 `514`，**根本不成交**，
//    也就**不扣豆**。所以代价不是豆，而是白耗一次题面（滑块接口计失败次数）。
//
//    真正的理由是**它不可能成功**：一枪确定失败的请求，发出去只是浪费。
//    而"扣豆"是**成交的标志**（扣了 = 拿到奖品了），是目标，不是损失 ——
//    把扣豆讲成损失，等于把成交讲成亏。这一点我一开始想反了。
// ② **判成功要看余额差**，不是看响应里那句话：这一族没有幂等键，`oid` 由服务端生成，
//    所以"发出去就不收回来"—— 只有余额真的少了才算成交。
// ③ 两处逐接口的入参差异，**不是**一刀切：取滑块那条用 `application/x-www-form-urlencoded`，
//    下单那条**有** `isdeviceid: true`，而取滑块那条**没有**。
//
// # ⚠ 总方针：**优先发出去**
//
// 这是**用户定的方向**，与 mcloud 的保守口径**不同**，所以写在这里免得被"顺手改稳"：
//
// · 清单判据说"不能兑" ⇒ **照样发**（把判据写进 note，让人看得见）；
// · 余额看着不够 ⇒ **照样发**（那是估算，上游才是真判据）。
//
// 理由：这两处**发了是可能成功的** —— 判据是本地估算，而放不放行由上游说了算。
// 不发 = 少一次机会，发了被拒 = 一次失败响应（失败不扣豆，扣豆只发生在成交那一刻）。
//
// # ⚠ 但**滑块**不属于这一类：算错了发出去是**无效的**，所以不发
//
// 这一条我一度也按"倾向于发"改了（解不出来就用 `puzzleOffset: null` 发出去），
// 方向是错的：offset 错了，那一枪**不可能成功** —— 它只会回 `514`，
// 而且**白白消耗一次题面**（滑块接口计失败次数）。"发出去"在这里换不到任何机会，
// 只多一次确定的失败。所以滑块的处置仍然是**算不出就不发**。
//
// 判断标准是这一句：**发出去有没有可能成功？**
// 可能 ⇒ 倾向于发；不可能 ⇒ 不发（那不是"少一次机会"，是"多一次白打"）。
//
// # 为什么是"一次调用一个请求"的状态机
//
// 面板的执行预算默认 2000ms，而这条链有 7 枪 + 一次 500ms 等待 ⇒ 必须能被打断、
// 下次接着走。状态落在 SQLite 里，`step` 就是游标。

import { callRawText } from '../client.ts';
import { REFERER_SIGN_IN, SHOW_LOADING, buildH5Request, MCLOUD_HOST } from '../h5.ts';
import { sessionHeaders } from './base.ts';
import { calcPuzzleOffset, usable } from '../slide.ts';
import { loadSession, SESSION_KEY } from '../../store/types.ts';
import { LIMIT_AVAILABLE, VERDICT_TEXT, parseExchangeList, verdictOf } from './exchangeList.ts';
import type { ExchangePrize } from './exchangeList.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_STEP = 'mcloud.exchange.order.step';
export const STATE_PLAN = 'mcloud.exchange.order.plan';
export const STATE_BASE = 'mcloud.exchange.order.baseline';
export const STATE_ROUND = 'mcloud.exchange.order.round';

/** mcloud 的 `SLIDER_ROUNDS`：只有 `514`（滑块算错）可以再来一轮，**上限 2 轮**。 */
export const SLIDER_ROUNDS = 2;
export const EXCHANGE_CLIENT_VERSION = '12.6.0';
/** ⚠ 取滑块那条的 content-type 是 **form**（不是 JSON）—— 逐接口的，不是一刀切。 */
export const SLIDE_FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8';
export const VISIT_LOG_KEYWORD_EXCHANGE = 'newsignin_index_to_exchange';
export const VISIT_LOG_KEYWORD_EXCHANGE_TIMES = 'newsignin_index_exchange_times';
export const VISIT_LOG_MARKET_NAME = 'sign_in_3';
/** 滑块算错的那个业务码。**只有它**能触发重取一题。 */
export const CODE_SLIDER_WRONG = 514;
/** 预热那一枪与下一枪之间的等待（TS 的常量，照搬）。 */
export const PREHEAT_DELAY_MS = 500;

export type Step = 'list' | 'balance' | 'warm-1' | 'warm-2' | 'slide' | 'order' | 'verify' | 'done';

interface Plan {
  prizeId: number;
  prizeName: string;
  price?: number | undefined;
  query: string;
}

/** 取数字（`undefined` 就 `undefined`，**不编**）。 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

interface OrderState {
  step: Step;
  round: number;
  plan?: Plan;
  /** 上一轮算出来的 offset（**只在同一次尝试里用**，不许跨授权重放）。 */
  offset?: number | undefined;
}

/** 从原始响应文本里取 `result`（取不到就给整个对象）。
 *
 *  ⚠ 不用 `envelope.ts` 的 `resultObject`：那个要的是已经解析好的 `SignInEnvelope`，
 *  而这一族要边解边看（解析失败也要能报出原文）。 */
/** 构造一枪**带签名**的请求。
 *
 *  ⚠⚠ 这一层不能省，也不能手搓：真机上不给签名时 `getSlide` 回
 *  `{"code":501,"msg":"参数校验异常"}` —— 而那句话**不提示是签名的问题**，
 *  看起来像"参数传错了"，很容易往错的方向查（我第一版就是这样，绕过了
 *  `buildH5Request` 自己拼 URL 与头）。
 *
 *  `saltKey = 1`、`marketName = sign_in_3`：与已经跑通的 `exchangeList` 同一族
 *  （mcloud 那边这两枪也都是 `h5(...)`）。 */
function signedReq(
  deps: TaskDeps,
  spec: { url: string; method: 'GET' | 'POST'; body?: string | undefined; contentType?: string | undefined; isDeviceId?: boolean | undefined },
): ReturnType<typeof buildH5Request> {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: spec.url,
    method: spec.method,
    body: spec.body,
    contentType: spec.contentType,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    // ⚠ `isDeviceId` 是**逐接口**的：下单那条要，取滑块那条**不要**（照实拍）
    isDeviceId: spec.isDeviceId ?? false,
    saltKey: 1,
    marketName: 'sign_in_3',
    session: session ? sessionHeaders(session) : {},
  });
}

function digResult(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const r = v.result;
    return r && typeof r === 'object' ? (r as Record<string, unknown>) : v;
  } catch {
    return {};
  }
}

function loadState(deps: TaskDeps): OrderState | null {
  const raw = deps.store.getState(STATE_STEP);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as OrderState;
    return typeof v.step === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveState(deps: TaskDeps, st: OrderState): void {
  deps.store.setState(STATE_STEP, JSON.stringify(st), deps.nowIso);
}

export function clearOrder(deps: TaskDeps): void {
  deps.store.setState(STATE_STEP, '', deps.nowIso);
  deps.store.setState(STATE_PLAN, '', deps.nowIso);
  deps.store.setState(STATE_BASE, '', deps.nowIso);
  deps.store.setState(STATE_ROUND, '', deps.nowIso);
}

/** 起一单：只写计划，**一个请求都不发**。 */
export function startOrder(deps: TaskDeps, query: string): TaskOutcome {
  if (query.trim() === '') {
    return { ok: false, note: '兑换要指定奖品（名字或 prizeId）—— 没有它无从下手' };
  }
  saveState(deps, { step: 'list', round: 0 });
  deps.store.setState(STATE_PLAN, query.trim(), deps.nowIso);
  return { ok: true, note: `已排队兑换「${query.trim()}」—— 后面每次触发走一步（一次调用一个请求）` };
}

/** 从清单里按**名字精确**或 `prizeId` 找出目标。 */
export function pickPrize(prizes: readonly ExchangePrize[], query: string): ExchangePrize | undefined {
  const q = query.trim();
  if (/^\d+$/.test(q)) return prizes.find((p) => String(p.prizeId) === q);
  // ⚠ 精确匹配，不做子串 —— 子串会让"钻石会员季卡"命中"钻石会员月卡"
  return prizes.find((p) => p.name === q);
}

export const STEP_TEXT: Record<Step, string> = {
  list: '① 读清单',
  balance: '② 读余额（成交后的对照基准）',
  'warm-1': '③ 预热第一枪',
  'warm-2': '③ 预热第二枪',
  slide: '④ 取滑块题面并本地解',
  order: '⑤ 下单',
  verify: '⑥ 复查余额差',
  done: '完成',
};

/** 推进一步。**一次调用只发一个请求**（`warm-1` → `warm-2` 之间还夹一次 500ms 等待）。 */
export function runOrderStep(deps: TaskDeps): TaskOutcome {
  const st = loadState(deps);
  if (!st) return { ok: true, idle: true, note: '没有在排队的兑换（先用 startOrder 起一单）' };
  const query = deps.store.getState(STATE_PLAN) ?? '';
  const step = st.step;
  const label = STEP_TEXT[step];

  const done = (note: string, ok = true): TaskOutcome => {
    saveState(deps, { ...st, step: 'done' });
    return { ok, note };
  };

  if (step === 'done') return { ok: true, idle: true, note: '这一单已经走完了（要再来一单得重新起）' };

  // ① 清单：读 + 判"该不该发"
  if (step === 'list') {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/exchangeList?client=app&clientVersion=${encodeURIComponent(EXCHANGE_CLIENT_VERSION)}`,
        method: 'GET',
      }),
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    // ⚠ 复用 `exchangeList.ts` 的 `parseExchangeList` —— **不要**在这里自己walk一遍：
    //   我第一版就是自己走的分组，结果对着真机清单说"清单里没有这件奖品"，
    //   而清单里明明有（字段名与分组形状都跟我猜的不一样）。
    //   已经有一份**真机验过**的解析，就没有理由再写第二份 —— 两份迟早分叉。
    const { prizes } = parseExchangeList(digResult(res.text));
    const p = pickPrize(prizes, query);
    if (!p) return done(`${label}：清单里没有「${query}」—— 这一单不做（名字要**精确**匹配）`, false);
    // 严格判据：**只有 `ok` 才往下走**。
    //
    // ⚠ 我一度把这里放宽成"只在明确否定时才拦"，理由是当时看到
    // "同一份数据在汇总里是 51/51 可兑，单独判这一件却是判不了"这个矛盾。
    // **那个矛盾是我的 bug，不是数据的问题**：我第 ① 步当时从**原始对象**上读
    // `limit`（没有走 `parsePrize`）⇒ `limit === undefined` ⇒ `unknown`。
    // 换成 `parseExchangeList` 之后真机实测：51/51 全是 `limit: 0` ⇒ 全部 `ok`。
    //
    // 所以闸门收回严格：判不了就不发 —— 与"滑块算不出就不发"同一个方向。
    // 放宽它等于把"不确定"当成"可以花豆"。
    // ⚠ 判据只记不挡（见文件头的总方针）：**优先发出去**
    const verdict = verdictOf(p);
    const verdictNote = verdict === 'ok' ? '' : `（上游判据说「${VERDICT_TEXT[verdict]}」，照样发）`;
    // ⚠ 取不到**数字** prizeId 就拒绝 —— 兜成 -1 会真把 `prizeId:-1` 发出去
    const prizeId = num(p.prizeId);
    if (prizeId === undefined) {
      return done(`${label}：清单里那条没有可用的 prizeId ⇒ 这一单不做（不许编一个数字发出去）`, false);
    }
    const plan: Plan = { prizeId, prizeName: String(p.name ?? ''), price: num(p.price), query };
    saveState(deps, { ...st, step: 'balance', plan });
    return { ok: true, note: `${label}：目标「${p.name}」（prizeId=${p.prizeId}）${p.price === undefined ? '' : `，${p.price} 豆`}${verdictNote} —— 下一步读余额` };
  }

  // ② 余额
  if (step === 'balance') {
    const res = callRawText(
      deps.transport,
      signedReq(deps, { url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/infoV3?client=app`, method: 'GET' }),
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    let balance: number | undefined;
    try {
      const env = digResult(res.text);
      // ⚠ 余额字段是 **`total`**（真机实测：infoV3 的 result 里没有 `point`/`balance`）
      const v = env.total ?? env.point ?? env.balance;
      if (typeof v === 'number') balance = v;
      else if (typeof v === 'string' && /^\d+$/.test(v)) balance = Number(v);
    } catch {
      /* 余额读不出来不算致命：后面靠成交后的差值判，这里只做"够不够"的前置 */
    }
    let shortNote = '';
    if (balance !== undefined) {
      const price = st.plan?.price;
      // ⚠ 余额只记不挡（总方针）：它是**估算**，而且这一族失败不扣豆
      if (price !== undefined && balance < price) shortNote = `（余额 ${balance} < 价格 ${price}，照样发）`;
      deps.store.setState(STATE_BASE, String(balance), deps.nowIso);
    }
    saveState(deps, { ...st, step: 'warm-1' });
    return { ok: true, note: `${label}：${balance ?? '没读到'}${balance === undefined ? '（照样往下走，成交判据靠余额差）' : ''}${shortNote} —— 下一步预热` };
  }

  // ③ 预热两枪（中间夹 500ms，顺序是契约）
  if (step === 'warm-1' || step === 'warm-2') {
    const keyword = step === 'warm-1' ? VISIT_LOG_KEYWORD_EXCHANGE : VISIT_LOG_KEYWORD_EXCHANGE_TIMES;
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/visitlog/journaling?module=uservisit&optkeyword=${encodeURIComponent(keyword)}&sourceid=1002&marketName=${encodeURIComponent(VISIT_LOG_MARKET_NAME)}`,
        method: 'POST',
        body: '',
      }),
    );
    // ⚠ 它只是埋点：**失败不挡路**（不该因为一次埋点失败就放弃这趟）
    const warn = res.ok ? '' : `（埋点失败但不挡路：${res.error ?? '未知'}）`;
    if (step === 'warm-1') {
      saveState(deps, { ...st, step: 'warm-2' });
      return { ok: true, note: `${label}：${keyword}${warn} —— 下一步第二枪（中间那 500ms 由面板的下一次触发承担）` };
    }
    saveState(deps, { ...st, step: 'slide' });
    return { ok: true, note: `${label}：${keyword}${warn} —— 下一步取滑块题面` };
  }

  // ④ 取题面 + 本地解 ⇒ **解不出就不发**
  if (step === 'slide') {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/auth-service/slide/getSlide`,
        method: 'POST',
        // ⚠ 这一条用 **form** content-type（不是 JSON）—— 逐接口的，不是一刀切
        contentType: SLIDE_FORM_CONTENT_TYPE,
        body: '{}',
        isDeviceId: false,
      }),
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    let puzzle: string | undefined;
    let picture: string | undefined;
    try {
      const env = digResult(res.text);
      const pz = env.puzzleImg ?? env.puzzle ?? env.puzzleImage;
      const bg = env.pictureImg ?? env.picture ?? env.backgroundImg;
      if (typeof pz === 'string') puzzle = pz;
      if (typeof bg === 'string') picture = bg;
    } catch (e) {
      return { ok: false, note: `${label}：题面解析不了（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (!puzzle || !picture) {
      return { ok: false, note: `${label}：题面上没有两张图（回 ${res.text.slice(0, 120)}）` };
    }
    // ⚠ **算不出就不发** —— 这一枪发出去是**无效的**（见文件头）：offset 错了必然回
    //   `514`、**不成交、也不扣豆**；代价是白耗一次题面。
    //   （"扣豆"是成交的标志 —— 扣了就是拿到奖品了，那是目标，不是损失。）
    let solution;
    try {
      solution = calcPuzzleOffset(puzzle, picture);
    } catch (e) {
      return done(
        `${label}：图解码失败（${e instanceof Error ? e.message : String(e)}）⇒ 不发下单那一枪` +
          '（offset 错了那一枪不可能成功，只会白耗一次题面）',
        false,
      );
    }
    if (!usable(solution)) {
      return done(
        `${label}：算不出可用的 offset（解出 ${solution.offsetX}，置信度 ${solution.confidence.toFixed(2)}）` +
          '⇒ 不发下单那一枪 —— 这一枪发出去是无效的，不是"少一次机会"而是"多一次白打"',
        false,
      );
    }
    saveState(deps, { ...st, step: 'order', offset: solution.offsetX });
    return { ok: true, note: `${label}：offset=${solution.offsetX}（置信度 ${solution.confidence.toFixed(2)}）—— 下一步下单` };
  }

  // ⑤ 下单
  if (step === 'order') {
    const plan = st.plan;
    if (!plan) return done('内部状态缺计划，这一单作废', false);
    const sess = loadSession(deps.store);
    const deviceId = sess?.deviceId ?? '';
    if (deviceId === '') {
      return done('没有 deviceId（它要现换，见 smid 链）—— 不带它下单会回 615，文案却像"活动太火爆"', false);
    }
    if (st.offset === undefined) return done('内部状态缺 offset，这一单作废（不发一个没算出来的数）', false);
    const body = `{"prizeId":${plan.prizeId},"client":"app","clientVersion":"${EXCHANGE_CLIENT_VERSION}","puzzleOffset":${st.offset},"smsCode":"","deviceId":"${deviceId}"}`;
    const req = signedReq(deps, {
      url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/exchangeV3`,
      method: 'POST',
      body,
      isDeviceId: true, // 这条**要** isdeviceid，而取滑块那条不要
    });
    req.headers.origin = MCLOUD_HOST;
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };

    let code: number | undefined;
    try {
      const env = digResult(res.text);
      const c = env.code;
      code = typeof c === 'number' ? c : typeof c === 'string' && /^-?\d+$/.test(c) ? Number(c) : undefined;
    } catch {
      /* 交给下面的余额复查 */
    }
    if (code === CODE_SLIDER_WRONG) {
      const round = (st.round ?? 0) + 1;
      if (round > SLIDER_ROUNDS) {
        return done(`${label}：滑块连续 ${SLIDER_ROUNDS} 轮被判错 ⇒ 停手（上限 SLIDER_ROUNDS 轮）`, false);
      }
      saveState(deps, { ...st, step: 'slide', round, offset: undefined });
      return { ok: true, note: `${label}：514（滑块算错）⇒ 重取一题再来一枪（第 ${round}/${SLIDER_ROUNDS} 轮），**没有重复下单**` };
    }
    saveState(deps, { ...st, step: 'verify' });
    return { ok: true, note: `${label}：上游回 ${JSON.stringify(env0(res.text)).slice(0, 140)} —— 下一步查余额差（**那句话不算数**）` };
  }

  // ⑥ 复查余额差 —— 这才是"成交"的判据
  if (step === 'verify') {
    const before = deps.store.getState(STATE_BASE);
    const res = callRawText(
      deps.transport,
      signedReq(deps, { url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/infoV3?client=app`, method: 'GET' }),
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? '未知失败'}` };
    let after: number | undefined;
    try {
      const env = digResult(res.text);
      // ⚠ 余额字段是 **`total`**（真机实测：infoV3 的 result 里没有 `point`/`balance`）
      const v = env.total ?? env.point ?? env.balance;
      if (typeof v === 'number') after = v;
    } catch {
      /* ignore */
    }
    if (before === '' || after === undefined) {
      return done(`${label}：拿不到余额差（基准「${before || '缺'}」/ 现在「${after ?? '缺'}」）⇒ 成交与否**不知道**，如实报`, false);
    }
    const delta = Number(before) - after;
    if (delta > 0) return done(`${label}：✅ 成交（余额 ${before} → ${after}，扣了 ${delta} 豆）`);
    return done(`${label}：❌ 没成交（余额 ${before} → ${after}，没扣豆）—— 上游那句话不算数，只有余额差算数`, false);
  }

  return { ok: false, note: `不认识的步骤「${step}」` };
}

/** 排障用：把响应体里的 `result` 摘出来（失败时留原文）。 */
function env0(text: string): unknown {
  const r = digResult(text);
  return Object.keys(r).length > 0 ? r : text.slice(0, 140);
}

export { SESSION_KEY };
