// 签到族任务共用的底座。
//
// 「共用」的范围刻意很窄：**只有管道**（会话检查 → 构造 → 发送 → cookie 回写 → 落盘）。
// **解析和判定一律各写各的** —— 原实现在这点上吃过亏：上游不同端点的 `result`
// 形状不同（数组 / 以 group 为键的对象），写一个「两种都吃」的兼容解析器，
// 等上游改形状时这条链**不会响**。所以底座只把「发出去、收回来」这段收掉，
// 每个任务自己决定「收回来的是什么意思」。
//
// 另一件事是**错过太久的不可逆动作不做**：原实现的任务表给每条任务标了
// catch-up / skip 两种语义（`docs/task-inventory.md`）：
//   - 签到、领豆、翻倍、备份好礼 → catch-up（晚了也补做，上游自己有幂等）
//   - 用复活卡 → **skip**（不可逆，晚了就别补）
// 本底座把这条做成 `skipIfLaterThanMs` + payload 里的 `lateMs`。
// ⚠️ 手动触发时 `lateMs` 是**负数**（面板的已知问题，见 F-001）——
// 负数一律当「手动」处理，不参与跳过判断，否则点了「立即执行」反而什么都不做。


import { callOnce, mergeCookieJar } from '../client.ts';
import type { CallResult, Transport } from '../client.ts';
import type { SignInEnvelope } from '../envelope.ts';
/** ⚠ `WsFrame` 来自宿主 API 的**类型声明**（`src/host-api.d.ts`）——
 *  它描述的是宿主返回的形状，插件这边不自己另立一份（两处定义必然漂移）。 */
import type { WsFrame } from 'host-api';
import { CLIENT_QUERY, EP_METHOD, REFERER_SIGN_IN, SHOW_LOADING, buildH5Request, resolveUrl } from '../h5.ts';
import type { EndpointName } from '../h5.ts';
import { SESSION_KEY, loadSession, saveSession } from '../../store/types.ts';
import type { Session, Store } from '../../store/types.ts';
import { jwtExpiry } from '../session.ts';

/** 宿主的长连接那一族（`ws_*`）。**注入式**的理由与 `transport` 一样：
 *  插件里注入真的（`host-api` 的 `ws_open` 等），Node 测试里注入桩 ——
 *  否则"听弹幕"这条链在 Node 里根本跑不动（Node 没有宿主 API，适配器也只给桩）。
 *
 *  ⚠ 它**不进 `TaskDeps`**：只有听弹幕那一个任务要它（[`ListenDeps`]），
 *  塞进公共 deps 会让"宿主必须提供长连接"变成所有任务的隐含前提。 */
export interface HostWs {
  wsOpen(
    url: string,
    opts: { headers?: Record<string, string>; timeout_ms?: number; tls?: 'rustls' | 'native' },
  ): number;
  wsSend(id: number, text: string): true;
  wsRecv(id: number, timeout_ms?: number): WsFrame;
  wsClose(id: number): true;
}

/** 业务主机的基址（`baseUrl` 空串 / 全空白 = 用真主机）。
 *
 *  ⚠ 不能写 `` `${deps.baseUrl ?? HOST}/ycloud/…` ``：`??` 只挡 `undefined`，
 *  **空串会拼出相对 URL**，宿主那边报 `bad uri: /ycloud/… is missing scheme` ——
 *  而这句话在界面上看起来像"上游坏了"，其实是我们自己没给主机（F-081 现场）。
 *  `h5.ts::resolveUrl` 早就是 `base ? … : …`，这里只是把同一条口径收成一处。 */
export function hostBase(deps: { baseUrl?: string | undefined }, fallback: string): string {
  const b = (deps.baseUrl ?? '').trim();
  return b === '' ? fallback : b.replace(/\/+$/, '');
}

export interface TaskDeps {
  store: Store;
  transport: Transport;
  /** 当前时刻（ISO），注入是为了测试可复现 */
  nowIso: string;
  /** 覆盖上游基址（指到 mock 用）；空 = 用真地址 */
  baseUrl?: string | undefined;
  /** payload 里的 `lateMs`：本次触发比计划晚了多久（负数 = 手动触发，见 F-001） */
  lateMs?: number | undefined;
  /** 取当前毫秒时刻。**注入**是为了让"等待"能在测试里用假时钟跑 ——
   *  真等 20 秒的测试没人会跑。不注入就用 `Date.now()`。 */
  nowMs?: (() => number) | undefined;
  /** 自旋一小会儿（毫秒级等待用，沙箱里没有计时器）。
   *  注入的理由同上：测试里换成"把假时钟往前推"。 */
  spin?: (() => void) | undefined;
  /** 动作做完到复查上游之间等多久（毫秒）。默认 5 秒；测试传 0。 */
  settleMs?: number | undefined;
}

/** 取当前毫秒时刻（没注入就用真时钟）。 */
export function depsNowMs(deps: TaskDeps): number {
  return (deps.nowMs ?? Date.now)();
}

export interface TaskOutcome {
  ok: boolean;
  /** 一行结果，进 runs 表的 note */
  note: string;
  /** 是否因为「错过太久」而主动跳过（不是失败） */
  skipped?: boolean;
  /** 这一轮**什么都没做**（开关关着 / 已经跑完 / 没料）——
   *  调用方据此决定要不要记一笔 run。不标的话，"关着"会每 5 分钟刷一行噪声。 */
  idle?: boolean;
  /** 动作做了、但还在等服务端确认（不是失败，也不该染红整趟）。 */
  pending?: boolean;
}

export interface TaskSpec {
  /** 任务名，进日志 */
  task: string;
  /** 端点名（`EP` / `EP_METHOD` 的表键） */
  endpoint: EndpointName;
  /** 方法；默认按 `EP_METHOD` 表 */
  method?: 'GET' | 'POST';
  /** 追加到 URL 的 query（**不含** `?`）；`infoV3`/`startSignIn` 用 `CLIENT_QUERY` */
  query?: string | undefined;
  /** POST body（字符串） */
  body?: string | undefined;
  contentType?: string | undefined;
  isDeviceId?: boolean | undefined;
  /** `activityid` 用的市场名；默认 `sign_in_3`，备份好礼那页是 `backupgift` */
  marketName?: string | undefined;
  /** 快照落盘的 state 键（不落盘就不传） */
  stateKey?: string | undefined;
  /** 比计划晚超过这么多毫秒就**不做**（只给不可逆动作用）。负数/缺省 = 总是做 */
  skipIfLaterThanMs?: number | undefined;
  /** 把**文案骗人的**上游失败码翻成人话（返回 `undefined` = 不翻，照原话报）。
   *
   *  为什么需要它：`receiveV3` 的 615 回的是「活动太火爆啦，兑换失败」——
   *  那句话让人以为是限流，而抓包实证（`app-signin-samples.txt` §4.2）说它是
   *  **请求没带 `deviceId`**；614 是 `deviceId` 内容无效，文案是「锁定失败」。
   *  照原话报的后果：一个**参数错误**被当成**瞬时失败**，于是无限重试。 */
  explainFail?: ((env: SignInEnvelope | undefined, raw: string) => string | undefined) | undefined;
  /** 上游回的**错误**里有些其实是"已经完成了"（例如复活卡的「已领取」）。
   *  给一个判据，命中时算成功、并把这个判据的说明写进 note。
   *  不这么做的后果：面板里每天多一条红，而实际上什么都没坏。 */
  okWhenError?: ((error: string) => boolean) | undefined;
}

/** 落盘的失败原因的键前缀。 */
export const ERR_PREFIX = 'mcloud.last_error.';

/** 跑了没成 / 跳过，都要写一份「最近一次怎么回事」——否则界面只能显示「失败」。
 *  靠 `note` 就够的事不再额外存（`runs` 表里已经有全量历史）。 */
export function recordError(store: Store, task: string, note: string, nowIso: string): void {
  store.setState(`${ERR_PREFIX}${task}`, `${note} @ ${nowIso}`, nowIso);
}

export function clearError(store: Store, task: string, nowIso: string): void {
  store.setState(`${ERR_PREFIX}${task}`, '', nowIso);
}

/** 会话 → 请求头那几项。 */
export function sessionHeaders(s: Session): {
  jwt: string | undefined;
  deviceId: string | undefined;
  userAgent: string | undefined;
  cookie: string | undefined;
} {
  return { jwt: s.jwt, deviceId: s.deviceId, userAgent: s.userAgent, cookie: s.cookie };
}

/** 执行一个任务：管道共用，判定交给调用方。
 *
 *  `judge` 拿到成功响应的信封，返回 `{ok, note, snapshot}`；
 *  `snapshot` 会原样 JSON 落到 `spec.stateKey`（给界面/后续步骤读）。 */
export function runTask(
  deps: TaskDeps,
  spec: TaskSpec,
  judge: (env: SignInEnvelope, res: CallResult) => { ok: boolean; note: string; snapshot?: unknown },
): TaskOutcome {
  // ① 错过太久就不做（只对不可逆动作设了这个阈值；手动触发的负数不算「晚」）
  const late = deps.lateMs ?? 0;
  if (spec.skipIfLaterThanMs !== undefined && late > spec.skipIfLaterThanMs) {
    const mins = Math.round(late / 60000);
    const note = `错过太久（晚了 ${mins} 分钟，阈值 ${Math.round(spec.skipIfLaterThanMs / 60000)} 分钟）→ 主动跳过`;
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: true, skipped: true, note };
  }

  // ② 没有会话就别打上游
  const session = loadSession(deps.store);
  if (!session) {
    const note = '还没有网页会话 —— 上面「换票」那一步说了原因';
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: false, note };
  }

  // ③ 构造（含签名）
  const method = spec.method ?? EP_METHOD[spec.endpoint] ?? 'GET';
  const url = resolveUrl(spec.endpoint, deps.baseUrl) + (spec.query ? `?${spec.query}` : '');
  const req = buildH5Request({
    url,
    method,
    body: spec.body,
    contentType: spec.contentType,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: spec.isDeviceId ?? method === 'POST',
    saltKey: 1,
    marketName: spec.marketName,
    session: sessionHeaders(session),
  });

  // ④ 发（一次调用只发一个请求 —— 执行预算只有 2000ms，见 README）
  const res = callOnce(deps.transport, req);

  // ⑤ 上游顺手给的 cookie 要并回去（会话续期就靠这个）
  if (res.setCookies.length > 0) {
    saveSession(
      deps.store,
      { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
      deps.nowIso,
    );
  }

  if (!res.ok) {
    // ⚠ 上游有些失败**文案是骗人的**：`receiveV3` 的 615 回「活动太火爆啦」，
    // 看着像限流，实际是**请求没带 `deviceId`**（另有 614 = `deviceId` 内容无效）。
    // 按原话归类会把"参数问题"当成"过一会儿再试"，于是重试到天荒地老也不成。
    // 所以给任务一个口子，把这类码翻成人话 —— 翻不了就照原话报（不猜）。
    const explained = spec.explainFail?.(res.env, res.error ?? '');
    if (explained !== undefined) {
      recordError(deps.store, spec.task, explained, deps.nowIso);
      return { ok: false, note: explained };
    }
    var note = res.error ?? '未知失败';
    // ⚠ `90001` 在所有任务里长一个样（「未登录」），而它有两种完全不同的原因：
    //   ① 手机端凭据（JWT）真的过期了 ⇒ 重新导入会话就好；
    //   ② 这一环要的那张票过期了（H5 的 `jwttoken`）⇒ 同一句话，但重新拿票即可。
    //   不区分的话，用户看到的是"8 项没成 · 未登录"，只能猜。
    if (res.env?.code === 90001) {
      const exp = jwtExpiry(deps.store, deps.nowIso);
      // ISO → 本地 `H:MM`（只给人看，别把整串 ISO 糊到日志里）
      const clock = (iso: string): string => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '刚才';
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };
      note =
        exp !== null && exp.expired
          ? `凭据过期了（今天 ${clock(exp.atIso)} 就到期）—— 去「账号」页重新导入会话`
          : '这一环要的票没被认（不是账号被踢）—— 重新导入会话最快';
    }
    // 「上游说失败，其实是已经做过了」这一类：算完成，但把上游原话留在 note 里
    if (spec.okWhenError?.(note)) {
      clearError(deps.store, spec.task, deps.nowIso);
      // ⚠ 这句话是给**用户**看的：不写 `okWhenError` 这种代码里的名字，
      //   也不把 `code=500 msg=…` 原样糊上去（那是传输层的形状）。
      const plain = note.replace(/^code=(-?\d+)(?: msg=(.*))?$/, (_m, _c, msg: string | undefined) =>
        msg === undefined || msg.trim() === '' ? '' : msg.trim(),
      );
      return { ok: true, note: plain === '' ? '已经做过了' : `已经做过了（服务端说：${plain}）` };
    }
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: false, note };
  }

  // ⑥ 判定（各任务自己的事）+ 落盘
  const verdict = judge(res.env as SignInEnvelope, res);
  if (verdict.snapshot !== undefined && spec.stateKey) {
    deps.store.setState(spec.stateKey, JSON.stringify({ at: deps.nowIso, lateMs: late, value: verdict.snapshot }), deps.nowIso);
  }
  if (verdict.ok) clearError(deps.store, spec.task, deps.nowIso);
  else recordError(deps.store, spec.task, verdict.note, deps.nowIso);
  return { ok: verdict.ok, note: verdict.note };
}

/** 常用：`infoV3`/`startSignIn` 那一族的 query（`client=app`，有设备号时再带一个）。 */
export function clientQuery(deviceId?: string | undefined): string {
  return deviceId ? `${CLIENT_QUERY}&deviceId=${encodeURIComponent(deviceId)}` : CLIENT_QUERY;
}

export { SESSION_KEY };
