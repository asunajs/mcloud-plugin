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
  /** normal / biz-fail / http-500 / not-json / timeout（签到族） */
  setBehavior(b: string, ms?: number): void;
  /** 直播族专用失败注入（与签到族分开，互不污染） */
  setLiveBehavior(b: string): void;
  /** 可观测/可改的直播夹具：liveChatRoomId / liveDrawClaims 等（e2e 走 /_debug/live/state） */
  readonly state: Record<string, unknown>;
  close(): Promise<void>;
}

export function startMock(options?: {
  port?: number;
  behavior?: string;
  delayMs?: number;
}): Promise<MockUpstream>;

export const MOCK_JWT: string;
export const MOCK_COOKIE: string;
/** 直播侧（/cmlive）的 JWT，与签到族的 jwttoken 不是同一枚 */
export const MOCK_LIVE_JWT: string;
/** 领奖滑块夹具的期望偏移（碎片 x − 切片 x） */
export const PRIZE_SLIDE_OFFSET: number;
export const PRIZE_SLIDE_PICTURE_B64: string;
export const PRIZE_SLIDE_PUZZLE_B64: string;
export const FIXTURES: Record<string, unknown>;
/** 直播间弹幕池（自动流用）*/
export const DANMAKU_CHAT: string[];
export const DANMAKU_QUESTION: string[];
export const DANMAKU_KOULING: string[];
/** 拼一条 MSync 字节串（SockJS 弹幕帧用）*/
export function msyncBytes(o: { command: number; msgId?: string | null; text?: string | null }): Uint8Array;
