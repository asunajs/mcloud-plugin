/** 一条日志的**两个去处**：面板的日志流（给终端看实时）+ 插件自己的环（重启后还在）。
 *
 *  用法（三块任务页都走这里，别直接调 `host-api` 的 `log`/`warn`）：
 *
 *  ```ts
 *  logBoth(store, 'start', `账号 138****8001`);
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
import { debug, error, fail, fatal, log, start, success, warn } from 'host-api';
import type { Store } from '../store/types.ts';
import { appendRing } from './logRing.ts';

export type LogLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'start'
  | 'success'
  | 'fail';

export function logBoth(
  store: Pick<Store, 'getState' | 'setState'>,
  // ⚠ `error` 也是要的：有些话不是"这次没成"，而是"这东西坏了"
  //   （例：面板二进制编漏了直播要的那条 TLS 路）。warn 会被读成"偶发，下次再看"。
  level: LogLevel,
  msg: string,
  nowIso: string,
): void {
  switch (level) {
    case 'debug':
      debug(msg);
      break;
    case 'warn':
      warn(msg);
      break;
    case 'error':
      error(msg);
      break;
    case 'fatal':
      fatal(msg);
      break;
    case 'start':
      start(msg);
      break;
    case 'success':
      success(msg);
      break;
    case 'fail':
      fail(msg);
      break;
    default:
      log(msg);
  }
  appendRing(store, nowIso, level, msg);
}
