// 面板宿主 API 的类型声明。
//
// 这不是 npm 包 —— `import ... from 'host-api'` 由面板的 Resolver 解析成内置模块
// （tsconfig 的 paths 把类型指到这里，打包时 esbuild 又把它标成 external）。
// 声明是照着 docs/host-api.md 写的**跨运行时最小公共子集**。
//
// 注意这里一个 Node 类型都没有：沙箱里没有 process / Buffer / setTimeout / fs。

/** handler 收到的 payload（字段与 JS / Python 完全一致，见 host-api 规范） */
export interface JobPayload {
  /** 任务名（同一插件内唯一） */
  name: string;
  /** 插件名（= 文件名去掉扩展名） */
  plugin: string;
  /** 调度表达式，例如 `@every 2s` */
  expr: string;
  /** 生命周期内第几次触发（跨重启接着数） */
  runs: number;
  /** 原定触发时刻（ISO 字符串） */
  scheduledAt: string;
  /** 实际触发时刻（ISO 字符串） */
  firedAt: string;
  /** 实际比原定晚多少毫秒 —— 观察调度精度就看它 */
  lateMs: number;
  /** 这一拍相对**理论**时刻抖了多少毫秒（没写抖动规则时恒为 0）。
   *
   *  ⚠ 面板从第二十三轮起就在发这一格（`docs/host-api.md` 的 ①-4 那节），
   *  但**这里一直没声明** —— 用的时候只能 `as`。补上。
   *
   *  关系式：`firedAt - scheduledAt == lateMs + jitterMs`。 */
  jitterMs: number;
  /** 这一拍是**落后重对齐**（或熔断重试、首次装载）来的，不是按理论线走到的。
   *
   *  ⚠ 那几种情况**故意不加抖动** ⇒ `jitterMs` 是 `0`，而对称抖动的**中点也是
   *  `0`**（合法取值）⇒ 只看 `jitterMs == 0` 分不出「没抖」与「重对齐」。
   *
   *  实测撞上过：`rust-plugin-panel/scripts/jitter_check.py` 那条
   *  "同一种子给出同一偏移"的断言会随机红 —— 三个实例同时跑，谁被负载拖得
   *  落后谁就重对齐，而重对齐是**时刻**决定的、不是种子决定的。 */
  realigned: boolean;
  /** `register_cron(…, { params })` 给的那份参数（没给就是 `undefined`）。
   *  形状由插件自己定，面板只原样存、原样交回（第二十三轮新增）。 */
  params?: unknown;
}

export type JobHandler = (payload: JobPayload) => void;

/** `register_cron` / `every` 的可选项（第二十三轮新增）。
 *
 *  ⚠ `budget_ms` 要**和 `worker_hint('exclusive')` 一起用**：全局执行预算原本
 *  是为了「一个跑飞的插件把同一条线程上的别的任务拖住」。独占线程之后那个理由
 *  不成立了，长预算才安全。共享线程上声明长预算，加载期会打一条警告。 */
export interface TaskOpts {
  /** 交给 handler 的 `payload.params`。形状由插件定，面板不解释。 */
  params?: unknown;
  /** 这条任务需要多久的执行预算（毫秒）。范围 100 ~ 600000，越界**报错**。
   *  不给就用全局 `EXEC_BUDGET_MS`（默认 2000）。 */
  budget_ms?: number;
}

/** 侧边栏入口。`label` 面板自己推不出来（插件名不是人话），所以由插件给。 */
export interface NavOpts {
  /** 菜单上显示的名字，≤ 12 个字符 */
  label: string;
  /** 一个字符的图标（emoji 也行），≤ 2 个字符 */
  icon?: string;
  /** 页面路径，默认 `/plugins/<插件名>/index.html` */
  path?: string;
}

export function log(msg: unknown): void;
export function warn(msg: unknown): void;
export function error(msg: unknown): void;

/** 5 段或 6 段 cron；表达式非法会在**注册阶段**就报错（加载插件时失败） */
export function register_cron(
  name: string,
  expr: string,
  handler: JobHandler,
  opts?: TaskOpts,
): void;
/** `500ms` / `2s` / `1m` / `1h`，毫秒级精度 */
export function every(
  name: string,
  interval: string,
  handler: JobHandler,
  opts?: TaskOpts,
): void;
/** 只登记处理函数、不声明调度 —— 任务由面板创建 */
export function register_handler(name: string, handler: JobHandler): void;

export type SqlParam = null | boolean | number | string;
export type SqlRow = Record<string, SqlParam>;
/** 结果最多 1000 行；BLOB 列返回 `"<blob N bytes>"` */
export function sqlite_query(sql: string, params?: SqlParam[]): SqlRow[];
export function sqlite_exec(
  sql: string,
  params?: SqlParam[],
): { changes: number; lastInsertRowid: number };

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 默认 10000，钳制到 [100, 60000] */
  timeout_ms?: number;
}
export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  /** 响应体上限 1 MiB */
  body: string;
}

/** 失败时的返回形状：`{"error": "…"}`——**没有** status / headers / body。
 *
 *  ⚠️ 这条是实测出来的，文档里只写了成功形状（`docs/host-api.md` 只说
 *  `http_fetch(url, options) -> { "status": …, "headers": …, "body": … }`）。
 *  面板的 JS 绑定在 `Err` 时返回 `json_error(&e)`，即 `{"error": msg}`。
 *
 *  为什么这条很坑：它**长得像一个正常结果**。任何写 `res.body` 的代码会拿到
 *  `TypeError: cannot read property 'length' of undefined` —— 报错位置在插件里，
 *  看起来像插件自己的 bug。我自己就是这么被真面板抓到的（见 docs/findings.md F-006）。
 *  本文件第一版把返回值声明成纯 `FetchResult`，TypeScript 因此**没有机会提醒我** ——
 *  一个写错的 .d.ts 会悄悄拿走类型安全。 */
export interface FetchError {
  error: string;
}

/** ⚠️ **同步阻塞**：会占住引擎线程，一次慢请求会推迟同轮的其他任务。
 *
 *  返回可能是 `FetchResult`，也可能是 `FetchError`（见上）。 */
export function http_fetch(url: string, options?: FetchOptions): FetchResult | FetchError;

export interface RouteRequest {
  method: string;
  path: string;
  /** ⚠⚠ **原始查询串**，不是解析好的对象。
   *
   *  实测（2026-10-15，面板 `src/web.rs:1519`）：
   *
   *      GET /plugins/qprobe/api/echo?id=abc&x=1
   *      → { "type": "string", "value": "id=abc&x=1" }
   *
   *  面板那一行是 `req.uri().query().unwrap_or("")` —— 拿的是**整段字符串**。
   *
   *  这一条踩过：这份声明原来写的是 `Record<string, string>`（面板不发 d.ts，
   *  这份是插件自己写的），于是 `req.query['id']` **类型检查通过、
   *  运行时永远是 `undefined`** —— 表现是"路由收到了请求但读不到参数"。
   *  更坏的是 `Object.keys('id=abc')` 在 JS 里**不报错**，给的是字符下标
   *  `["0","1","2",…]`，所以连"读错了"都看不出来。
   *
   *  要按名取值就用 `parseQuery()`（见 `src/mcloud/query.ts`）。 */
  query: string;
  headers: Record<string, string>;
  body: string;
}
export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}
/** 仅 JS：Python 插件调用会抛 NotImplementedError */
export function register_route(
  path: string,
  method: string,
  handler: (req: RouteRequest) => RouteResponse | void,
  opts?: Pick<TaskOpts, 'budget_ms'>,
): void;

/** 声明侧边栏入口。一个插件最多一个（后注册的覆盖前面的）。
 *
 *  为什么由插件给而不是面板推：面板只有插件名（`mcloud`），推不出人话。 */
export function register_nav(opts: NavOpts): void;

/** 声明这个插件要**独占一条执行线程**（第二十三轮新增）。
 *
 *  # 为什么需要它
 *
 *  面板的执行线程数是固定的（`ENGINE_WORKERS`，默认 2），插件被分到哪条线程上
 *  由面板按代价自动分。默认策略会把多个插件塞进同一条 —— 对「每 10 秒拍一下」
 *  的轻任务是合适的，对「一次跑几十秒」的长链不是：后者会把同线程的邻居全拖住。
 *
 *  # 什么时候该声明
 *
 *  - 有任务会**长时间占住**线程（几十秒级）
 *  - 任务之间有**毫秒级**的时序要求（抢兑那种）
 *
 *  声明之后面板会给它单开一条线程（`ENGINE_WORKERS` 会自动抬）。
 *  代价是线程数变多，所以**别给每个插件都加**。
 *
 *  ⚠ 它必须在插件**顶层**调用（加载期就要能看见）。 */
export function worker_hint(hint: 'exclusive' | 'precision' | 'none'): void;

// ══════════════════════════ WebSocket（面板第二十一轮加的）══════════════════════════
//
// 权威源是**面板**：`rust-plugin-panel/src/wsclient.rs` + `docs/host-api.md` §1 末尾。
// 插件这边只声明形状，语义照抄那两处 —— 有分歧以面板为准（它是实现方）。
//
// ⚠ 三件最容易写错的事：
//   ① `ws_recv` 的 `{type:'timeout'}` **不是错误**（正常"这一步没收到东西"）；
//   ② 句柄不存在（关过了 / **面板重启过**）是**抛异常**，不是返回 close；
//   ③ 一次调用最多等 1800ms（面板执行预算 2000ms）—— 别按"长连接就能一直读"写。

export interface WsOptions {
  /** 握手请求的头（同名头**覆盖**而不是追加）。 */
  headers?: Record<string, string>;
  /** 握手总超时（含 DNS/TCP/TLS/Upgrade），默认 8000，钳制到 [500, 30000]。 */
  timeout_ms?: number;
}

/** `ws_recv` 的结果。**五种形状**，不是异常。 */
export type WsFrame =
  /** 收到一帧文本。 */
  | { type: 'text'; data: string }
  /** 收到二进制帧（hex；SockJS 走文本，一般用不上）。 */
  | { type: 'binary'; hex: string }
  /** 等满了超时 —— **不是错误**，存好状态下次再收。 */
  | { type: 'timeout' }
  /** 连接关了（`reason` 是给人看的一句话）⇒ 要重连。 */
  | { type: 'close'; reason: string }
  /** 出错（`message`）⇒ 要重连。 */
  | { type: 'error'; message: string };

/** 开一条连接，返回**句柄**（数字）。握手失败**抛异常**（不留半死的句柄）。
 *
 *  ⚠ 上限：同时最多 8 条；单帧 256 KiB（超了回 `error` 并关掉，**不静默截断**）。 */
export function ws_open(url: string, options?: WsOptions): number;

/** 发一帧文本。**入队即返回**（不等对端确认）。句柄不存在时抛异常。 */
export function ws_send(id: number, text: string): true;

/** 收一帧，最多等 `timeout_ms`（默认 1500，最大 1800）。句柄不存在时抛异常。 */
export function ws_recv(id: number, timeout_ms?: number): WsFrame;

/** 关掉一条连接（**幂等**：已经关掉的再关一次也算成功）。 */
export function ws_close(id: number): true;

/** 发一封邮件（面板的 SMTP 客户端）。见面板 `docs/host-api.md`「发邮件」。
 *
 *  # 三条要记住的
 *
 *  · **失败抛错**，错误文本是服务器那句原话（`535 bad credentials` /
 *    `550 no such user here`）—— 直接贴进日志就能排查。
 *  · `tls` **拼错会报错**，不会默认成 `none` —— 那会明文发密码。
 *  · 这是**阻塞调用**（默认超时 15 秒），比默认执行预算还长。
 *    别把它放进需要毫秒精度的任务里（兑换那条链）。
 *
 *  中文主题走 RFC 2047 编码字；`from` 可以写 `显示名 <a@b>`，
 *  信封里只用裸地址。不给 `port` 就按 `tls` 推（`implicit` → 465，其余 → 587）。 */
export interface SmtpOpts {
  host: string;
  port?: number;
  /** `starttls`（默认）/ `implicit`（465）/ `none`。**拼错报错**。 */
  tls?: string;
  /** 空就跳过 `AUTH`（内网中继常见）。 */
  user?: string;
  pass?: string;
  /** 可以写 `显示名 <a@b>`；信封里只用裸地址。 */
  from: string;
  /** 字符串或字符串数组。 */
  to: string | string[];
  subject?: string;
  /** 正文至少给一个（`text` / `html`）。两个都给就是 `multipart/alternative`。 */
  text?: string;
  html?: string;
  /** 额外的信任锚（PEM）。自建 SMTP / 内网中继用。 */
  ca_file?: string;
  /** 默认 15000，夹在 1s ~ 60s。 */
  timeout_ms?: number;
  /** EHLO 自报的名字，默认 `localhost`。 */
  ehlo?: string;
}

export interface SmtpResult {
  ok: boolean;
  /** 服务器那句原话，如 `250 message accepted`。 */
  response?: string;
}

export function smtp_send(opts: SmtpOpts): SmtpResult;
