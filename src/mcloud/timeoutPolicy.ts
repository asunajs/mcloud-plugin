// 单发请求的超时策略（**纯**，不 import host-api —— 所以 Node 里能直接测）。
//
// # 为什么需要"按 URL 分档"
//
// 1500ms 是给"点一下就回来"的路由用的：它比面板默认执行预算（2000ms）短，
// 于是请求会**在预算之前**干净地失败（见 `entries/shared.ts` 那段与 F-001）。
//
// 但只读的慢端点不吃这一套。2026-11-15 10:05 现场：三个账号的 AI豆余额全报
// 「请求超时（1500ms）」。本机实测 `infoV3` 单发 0.83~1.05 秒（每次重做 TLS
// 握手约 0.65 秒，没有连接复用），1500ms 只剩 1.5 倍余量 —— 抖一下就超。
// `cloudRecordV2`（流水，逐页查账）更慢。
//
// ⇒ 只读 GET 放宽到 12 秒；**写操作死死留在 1500ms**：写操作一旦放宽，就会出现
//   "上游动作已经发生、任务却报失败"（同族坑见 F-001）。

export const DEFAULT_REQUEST_TIMEOUT_MS = 1500;

/** 只读、但慢的端点。⚠ 只放只读 GET，写操作不许进这张表。 */
export const SLOW_READ_PATTERNS: readonly RegExp[] = [
  // ⚠ 按**端点名**匹配，不要把前缀写死：真实路径是
  //   `/ycloud/signin/public/cloudRecordV2`（第一版写成 `/ycloud/cloudRecordV2`
  //   就一条都没匹配上，2026-11-15 自测现场：小号余额仍报「请求超时（1500ms）」）
  /\/cloudRecordV2(\?|$)/, // AI豆流水（逐页查账，慢）
  /\/signin\/page\/infoV3(\?|$)/, // 云朵/AI豆总览（余额就在 result.total）
];

/** 慢只读端点给多久。比上游 99 分位宽，比那几条路由的预算（60s）窄得多。 */
export const SLOW_READ_TIMEOUT_MS = 12_000;

/** 这个 URL 该给多久，以及为什么（`why` 只用于日志/自检，不参与逻辑）。 */
export function timeoutForUrl(
  url: string,
  fallback: number = DEFAULT_REQUEST_TIMEOUT_MS,
): { ms: number; why: 'slow-read' | 'default' } {
  return SLOW_READ_PATTERNS.some((re) => re.test(url))
    ? { ms: SLOW_READ_TIMEOUT_MS, why: 'slow-read' }
    : { ms: fallback, why: 'default' };
}
