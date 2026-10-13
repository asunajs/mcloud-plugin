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
}

export type JobHandler = (payload: JobPayload) => void;

export function log(msg: unknown): void;
export function warn(msg: unknown): void;
export function error(msg: unknown): void;

/** 5 段或 6 段 cron；表达式非法会在**注册阶段**就报错（加载插件时失败） */
export function register_cron(name: string, expr: string, handler: JobHandler): void;
/** `500ms` / `2s` / `1m` / `1h`，毫秒级精度 */
export function every(name: string, interval: string, handler: JobHandler): void;
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
  query: Record<string, string>;
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
): void;
