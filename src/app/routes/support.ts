// 路由层的共用件：请求/响应的类型、JSON 帮手、账号视图、登录那几步的助手。
//
// 为什么单独一个文件：routes.ts 原来是 3400 行的一坨，任何改动都要读懂整份。
// 拆开之后「一条路由要什么」在 groups/ 里，共用件在这里 —— 按路径检索就找得到。
//
// ⚠ 这一层**不知道宿主存在**：不 import host，也不 import panel:host（见 check-layers R3）。

import { readBag } from '../../store/keys.ts';
import { rawStoreOf, scoped } from '../../store/scoped.ts';
import type { Store } from '../../store/types.ts';
import { currentAccount, loadAccounts, maskAuth, selectAccount, upsertAccount } from '../../mcloud/accounts.ts';
import { parseAuth } from '../../mcloud/auth.ts';
import { callOnce } from '../../mcloud/client.ts';
import type { Transport } from '../../mcloud/client.ts';
import type { BuiltRequest } from '../../mcloud/h5.ts';
import { DEFAULT_PC_PLATFORM, LOGIN_AES_KEY, PC_AUTH_PREFIX, accountForm, authFromUserInfo, decryptUserInfo, maskPhone, parseLoginEnvelope, parsePcPlatform, userDomainIdFrom } from '../../mcloud/login.ts';
import type { LoginEnvelope, PcPlatform } from '../../mcloud/login.ts';
import { STATE_LOGIN_BASE, STATE_LOGIN_DOMAIN, STATE_LOGIN_PREF, clearLogin, loadQrSession } from '../../mcloud/loginSession.ts';
import type { PushDeps } from '../../mcloud/push.ts';
import { parseQuery } from '../../mcloud/query.ts';
import { uuidV4 } from '../../mcloud/rand.ts';
import { jwtExpiryOf } from '../../mcloud/session.ts';
import { resolveTaskAccounts } from '../../mcloud/taskAccounts.ts';
import { syncTaskReadiness } from '../../mcloud/taskReadiness.ts';
import type { HostWs } from '../../mcloud/tasks/base.ts';
import { STATE_EXPAND, STATE_MONTH_BACKUP } from '../../mcloud/tasks/taskExpansion.ts';
import { TASK_SWITCHES, taskOn, taskSource } from '../../mcloud/tasks/taskSwitches.ts';
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
  /** 路由处理。**可以是 async** —— 面板把 handler 的返回值 `await` 过再序列化
   *  （`engine.rs::call_json`：`(async () => { const v = await __dispatch(...) })()` + `rt.idle()`），
   *  所以上游一慢，这里 await 是"让出线程"，不是"多一层壳"。 */
  handler: (req: RouteRequest) => RouteResponse | Promise<RouteResponse>;
  /** 这条路由的执行预算（毫秒）。
   *
   *  ⚠ panel-llrt 对**整个插件的 web 调用**统一给 30 秒（`web.rs::WEBUI_BUDGET_MS`），
   *    **没有**按路由声明的口子 —— 这一格在插件侧收下来没处递（`register_web`
   *    只收一个函数）。留着它：一是文档（说明这条路由预期多贵），
   *    二是等面板加 per-route 预算的 API 时直接接上（R5：缺能力找面板加，
   *    不在插件里造同步桥）。看门狗到点**强制打断**并回 500。 */
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

export function parseJson(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 直播那一族读写的袋：`mcloud.live.*` 是 **account 键**，任务写在**第一个启用账号**
 *  的袋里（口令是共享的，只用第一个号的凭据去拿）。
 *
 *  ⚠ 路由必须读**同一个**袋。读默认袋的实拍（2026-11-16 e2e ⑨）：任务把那趟的
 *  「下一场几点醒」写进了 135 那个号的袋，`/api/live` 却在默认袋里找 ⇒ 页面永远
 *  显示「日程太旧」，而 `/api/readings` 是好的 —— 两个页面对不上，最难查的那类。
 */
export function liveStore(deps: RouteDeps): Store {
  const first = resolveTaskAccounts(deps.store, '直播', 'auto')[0] ?? '';
  return first === '' ? deps.store : scoped(rawStoreOf(deps.store), first);
}

export function accountsView(store: Store): {
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
    /** 这个号跑哪些子任务（`on` 是**合并后**的值，`source` 说明它是哪一层来的）。 */
    tasks: { id: string; label: string; on: boolean; source: 'account' | 'common' | 'default' }[];
  }[];
  /** 公共默认（所有号共用的那一层，写的是 `config.json`）。 */
  taskCommon: { id: string; label: string; on: boolean }[];
} {
  const cur = currentAccount(store);
  const nowMs = Date.now();
  // ⚠ 袋是**按账号**存的，所以"每一条自己的设备号"要**按 id 逐个读**
  //   （不能用当前账号那一格 —— 那只会读到当前这个的）。
  const raw = rawStoreOf(store);
  return {
    current: cur?.id ?? '',
    // 公共层：读的是**当前 store** 的 config 作用域（所有账号共用一份）
    taskCommon: TASK_SWITCHES.map((t) => ({ id: t.id, label: t.label, on: taskOn(store, t.id) })),
    accounts: loadAccounts(store).map((a) => {
      const one = scoped(raw, a.id);
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
        // ⚠ 同样**按 id 读那一条**（`scoped(raw, a.id)`）：用当前账号那一格会把 A 的开关
        //   显示在 B 的弹窗里，而用户改完才发现改错了号。
        tasks: TASK_SWITCHES.map((t) => ({
          id: t.id,
          label: t.label,
          on: taskOn(one, t.id),
          source: taskSource(one, t.id),
        })),
      };
    }),
  };
}

export const json = (status: number, obj: unknown): RouteResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(obj),
});

export function readBody(req: RouteRequest): Record<string, unknown> {
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

export function readMatrixLocal(one: Store): {
  clicked: number[];
  unconfirmed: number[];
  uploadDone: boolean;
  uploadName: string;
} {
  let clicked: number[] = [];
  let unconfirmed: number[] = [];
  try {
    const st = JSON.parse(one.getState('mcloud.apptask.state') ?? 'null') as {
      clicked?: unknown;
      unconfirmed?: unknown;
    } | null;
    if (st !== null && Array.isArray(st.clicked)) clicked = st.clicked.filter((x): x is number => typeof x === 'number');
    if (st !== null && Array.isArray(st.unconfirmed)) {
      unconfirmed = st.unconfirmed.filter((x): x is number => typeof x === 'number');
    }
  } catch {
    clicked = [];
    unconfirmed = [];
  }
  let uploadDone = false;
  let uploadName = '';
  try {
    const up = JSON.parse(one.getState('mcloud.upload.state') ?? 'null') as {
      step?: unknown;
      name?: unknown;
    } | null;
    if (up !== null && up.step === 'done') {
      uploadDone = true;
      uploadName = typeof up.name === 'string' ? up.name : '';
    }
  } catch {
    uploadDone = false;
  }
  return { clicked, unconfirmed, uploadDone, uploadName };
}

export function readBackupState(
  one: Store,
  nowIso: string,
): {
  step: string;
  day: string;
  enabled?: boolean | undefined;
  why: string;
  stale: boolean;
} | null {
  try {
    const ex = JSON.parse(one.getState(STATE_EXPAND) ?? 'null') as {
      step?: unknown;
      day?: unknown;
      curMonthBackup?: unknown;
      backupOn?: unknown;
      blockedWhy?: unknown;
      snapError?: unknown;
    } | null;
    if (ex === null || typeof ex !== 'object') return null;
    const month = nowIso.slice(0, 7);
    // ⚠ `curMonthBackup` 是**当月**读数，跨月就不能再当"本月"用 ——
    //   它记在自己的 `month` 格里（`STATE_MONTH_BACKUP`），而状态袋里那份没有月份，
    //   所以只在"这趟是今天写的"时才采信它（评审 2026-11-01：月初第一次跑之前，
    //   上个月的读数会被印成「本月备份：未开启」）。
    const day0 = typeof ex.day === 'string' ? ex.day : '';
    const fresh0 = day0 === nowIso.slice(0, 10);
    let enabled: boolean | undefined =
      fresh0 && typeof ex.curMonthBackup === 'boolean' ? ex.curMonthBackup : undefined;
    const mb = JSON.parse(one.getState(STATE_MONTH_BACKUP) ?? 'null') as {
      month?: unknown;
      backup?: unknown;
    } | null;
    if (mb !== null && mb.month === month && typeof mb.backup === 'boolean') {
      enabled = mb.backup;
    }
    // 状态机那边的判据是 `backupOn ?? curMonthBackup`（见 `verdictOf`）；
    // 两处必须说同一句话，否则界面和状态机会各说各的。
    if (fresh0 && typeof ex.backupOn === 'boolean') enabled = ex.backupOn;
    const day = day0;
    const fresh = fresh0;
    let step = fresh && typeof ex.step === 'string' ? ex.step : '';
    let why = fresh && typeof ex.blockedWhy === 'string' ? ex.blockedWhy : '';
    // ⚠ 兜最后一道：**旧版本**写下的 `done` 不看目标（快照失败也写 done）。
    //   只要"备份还是 false + 状态说已完成"，这一行就不许照抄 —— 那句
    //   「本月备份：未开启（任务拓展：已完成）」正是这么来的。
    //   改在这里（读数层）而不是只改状态机：库里那些旧状态不会自己变。
    if (step === 'done' && enabled !== true) {
      // ⚠ 判据用 `!== true`：`enabled === undefined`（读不到）同样不能算"已完成"。
      step = 'blocked';
      const snap = fresh && typeof ex.snapError === 'string' ? ex.snapError : '';
      if (why === '') why = snap === '' ? '旧状态没记原因' : `快照没建上：${snap}`;
    }
    return {
      // 旧状态（没写 day 的 / 跨天的）不算今天这一趟的进度。
      step,
      day,
      enabled,
      why,
      stale: !fresh,
    };
  } catch {
    return null;
  }
}

export function loadLoginBase(store: Pick<Store, 'getState'>): string {
  return store.getState(STATE_LOGIN_BASE) ?? '';
}

export async function loginCall(
  deps: RouteDeps,
  req: BuiltRequest,
): Promise<{ ok: boolean; env: LoginEnvelope | null; error: string; tookMs: number }> {
  const res = await callOnce(deps.transport, req);
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

export const SLIDER_MAX_ATTEMPTS = 2;

export type SliderSendResult =
  | { kind: 'sent'; remainGetTimes: number | null }
  | { kind: 'need-slider' }
  | { kind: 'exhausted' }
  | { kind: 'other'; note: string };

export async function autoPassSlider(
  deps: RouteDeps,
  logTag: string,
  fetchAnswer: () => { answer: string } | { error: string } | Promise<{ answer: string } | { error: string }>,
  sendWith: (answer: string) => SliderSendResult | Promise<SliderSendResult>,
): Promise<{ ok: true; remainGetTimes: number | null } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= SLIDER_MAX_ATTEMPTS; attempt += 1) {
    const got = await fetchAnswer();
    if ('error' in got) return { ok: false, error: got.error };
    const r = await sendWith(got.answer);
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

export function newTid(): string {
  return uuidV4();
}

export function loginPlatform(store: Pick<Store, 'getState'>): PcPlatform {
  return parsePcPlatform(store.getState(STATE_LOGIN_PREF)) ?? DEFAULT_PC_PLATFORM;
}

export function sessionPlatform(store: Pick<Store, 'getState'>): PcPlatform {
  return loadQrSession(store)?.platform ?? loginPlatform(store);
}

export function adoptLoginResult(
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
  // 换解密器（手机端那条会用「带兜底与诊断」的那个；PC 那条仍是严格单密钥）
  decrypt?: (cipher: string) => { info: Record<string, unknown>; how?: string | undefined },
): { ok: boolean; note: string; account?: { id: string; label: string } } {
  let info: Record<string, unknown>;
  let how: string | undefined;
  try {
    const got = decrypt === undefined ? { info: decryptUserInfo(encrypted, key) } : decrypt(encrypted);
    info = got.info;
    how = got.how;
  } catch (e) {
    return { ok: false, note: `登录成功了，但结果解不开：${e instanceof Error ? e.message : String(e)}` };
  }
  if (how !== undefined && how !== 'primary/shift10') {
    deps.log(`登录结果是用 ${how} 解的 —— 服务端换了钥匙或错位，要落档`);
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
  const howNote = how === undefined || how === 'primary/shift10' ? '' : `（解密走了 ${how}）`;
  return {
    ok: true,
    note: `${note}${howNote} · ${up.account.label}`,
    account: { id: up.account.id, label: up.account.label },
  };
}
