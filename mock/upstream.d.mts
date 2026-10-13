// mock/upstream.mjs 的类型声明。
//
// 给 mock 写声明而不是让 TS 从 JS 推：推出来的 `requests` 是 `object[]`，
// 断言里就得到处 cast。顺便这份声明也是 mock 的接口文档。

export interface MockRequest {
  method: string | undefined;
  /** 含查询串的路径 */
  path: string | undefined;
  /** 头的名字都已被 Node 转成小写 */
  headers: Record<string, string | undefined>;
  body: string;
}

export interface MockUpstream {
  url: string;
  port: number;
  /** 收到的请求，按时间顺序 */
  readonly requests: MockRequest[];
  /** 取某个路径后缀的请求里某个头的值（找不到给 undefined） */
  headerOf(pathSuffix: string, name: string): string | undefined;
  /** 清空请求记录 */
  reset(): void;
  /** normal / biz-fail / http-500 / not-json / timeout */
  setBehavior(b: string, ms?: number): void;
  close(): Promise<void>;
}

export function startMock(options?: {
  port?: number;
  behavior?: string;
  delayMs?: number;
}): Promise<MockUpstream>;

export const MOCK_JWT: string;
export const MOCK_COOKIE: string;
export const FIXTURES: Record<string, unknown>;
