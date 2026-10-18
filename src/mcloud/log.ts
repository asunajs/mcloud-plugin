/** 一条日志的**两个去处**：面板的日志流（给终端看实时）+ 插件自己的环（重启后还在）。
 *
 *  用法（三块任务页都走这里，别直接调 `host-api` 的 `log`/`warn`）：
 *
 *  ```ts
 *  logBoth(store, 'info', `成功 签到`);
 *  logBoth(store, 'warn', `失败 签到 —— ${why}`);
 *  ```
 *
 *  ⚠ 两个都写是有意的：面板那条带时间戳/级别/插件名，是**权威**；环那条只为
 *    "面板重启之后界面还能看见上一次"。只写一处都会缺一块（见 `logRing.ts`）。
 */
import { error, log, warn } from 'host-api';
import type { Store } from '../store/types.ts';
import { appendRing } from './logRing.ts';

export function logBoth(
  store: Pick<Store, 'getState' | 'setState'>,
  // ⚠ `error` 也是要的：有些话不是"这次没成"，而是"这东西坏了"
  //   （例：面板二进制编漏了直播要的那条 TLS 路）。warn 会被读成"偶发，下次再看"。
  level: 'info' | 'warn' | 'error',
  msg: string,
  nowIso: string,
): void {
  if (level === 'error') error(msg);
  else if (level === 'warn') warn(msg);
  else log(msg);
  appendRing(store, nowIso, level, msg);
}
