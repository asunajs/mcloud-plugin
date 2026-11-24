/** 一条日志的**两个去处**：面板的日志流（给终端看实时）+ 插件自己的环（重启后还在）。
 *
 *  用法（三块任务页都走这里，别直接调 `host-api` 的 `log`/`warn`）：
 *
 *  ```ts
 *  logBoth(store, 'start', `账号 138***8001`);
 *  logBoth(store, 'success', `签到：领到 3 云朵`);
 *  logBoth(store, 'fail', `换票：没成 —— 暂无权限！`);
 *  ```
 *
 *  `start/success/fail` 是**语义类型**：面板按类型着色，过滤级别仍按 info 算
 *  （见面板 `log::Type::level`）。`debug` 是“跳过/没有可领”这类过程信息。
 *  `error` / `fatal` 仍是**严重级别**：前者表示“这条路坏了”，后者表示“已经不可用”；
 *  它们不会被当成普通任务失败（那是 `fail`）。
 *
 *  ⚠ 两个都写是有意的：面板那条带时间戳/级别/插件名，是**权威**；环那条只为
 *    "面板重启之后界面还能看见上一次"。只写一处都会缺一块（见 `logRing.ts`）。
 */
import { logTo } from '../ports/log.ts';
import type { Store } from '../store/types.ts';
import { appendRing } from './logRing.ts';

export type { LogLevel } from '../ports/log.ts';
import type { LogLevel } from '../ports/log.ts';

export function logBoth(
  store: Pick<Store, 'getState' | 'setState'>,
  // ⚠ `error` 也是要的：有些话不是"这次没成"，而是"这东西坏了"
  //   （例：面板二进制编漏了直播要的那条 TLS 路）。warn 会被读成"偶发，下次再看"。
  level: LogLevel,
  msg: string,
  /** @deprecated 只为兼容既有调用点保留；**不再**当作日志时间戳（见下面那段）。 */
  nowIso: string,
): void {
  // 级别 → 宿主的写法由宿主决定（面板映到 info/warn/error 并保留前缀，CLI 自己着色）
  logTo(level, msg);
  // ⚠ 环里记的是**真实发生时刻**，不是调用方传进来的 `nowIso`。
  //   那个值是**一次 run 里冻结的**（为"跨零点算日界"设计的），拿它当时间戳会让
  //   一整趟的日志看起来全在同一毫秒（2026-11-16 现场：14 行只跨 12 毫秒，
  //   于是面板算出「用时 0.0 秒」）。日界判断继续用 `nowIso`，时间戳不再用它。
  appendRing(store, new Date().toISOString(), level, msg);
}