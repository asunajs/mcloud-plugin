// 「日常」这条任务的**状态键与读数字形**。
//
// # 为什么单独一个文件
//
// 写它的是 `entries/daily.ts`（插件入口，引 `host-api`），读它的是
// `mcloud/routes.ts`（路由层，**故意不引 host-api** —— 见 routes.ts 文件头，
// 那样它才能在 Node 里被测）。
//
// 如果 routes.ts 直接从 entries/ 里 import 这两个键，就会把 host-api 一起拖进来，
// 于是路由层再也测不了。键名与形状放这里，两边各自 import 这个文件。

import { accountScopedKey } from '../store/types.ts';
import type { Store } from '../store/types.ts';

/** 「今天已经整趟成功」的标记（值是 UTC 日期）的**裸键**。
 *
 *  ⚠ 用它之前先问一句：**这个标记属于某一个账号吗？** 属于 ⇒ 用
 *  {@link dailyDoneKey} / {@link dailyLastKey}（按账号分），不要直接用裸键。
 *
 *  为什么要分：这两个标记原来是全局的，于是多账号下
 *
 *     账号 A 跑完日常 → 落 `done_date = 今天`
 *     账号 B 的日常   → 看到"今天跑过了" ⇒ **整个被跳过**
 *
 *  也就是**第二个账号的日常一次都不跑**，而界面显示"今天已完成"（看着是对的）。
 *  见 F-050。 */
export const DAILY_DONE_KEY = 'mcloud.daily.done_date';

/** 最近一次运行的**每一步结果**（见 `DailyRun`）的裸键。 */
export const DAILY_LAST_KEY = 'mcloud.daily.last_run';

/** 「今天已经整趟成功」的标记：**按账号分**。 */
export function dailyDoneKey(store: Pick<Store, 'getState'>): string {
  return accountScopedKey(store, DAILY_DONE_KEY);
}

/** 最近一次运行的结果：**按账号分**（否则界面会显示**另一个账号**的上次结果）。 */
export function dailyLastKey(store: Pick<Store, 'getState'>): string {
  return accountScopedKey(store, DAILY_LAST_KEY);
}

/** 一趟里的一个步骤。 */
export interface DailyStep {
  /** 步骤名（人话，直接显示在界面上） */
  name: string;
  ok: boolean;
  note: string;
  /** 这一步什么都没做（条件不成立）—— 界面据此把它显示成灰色而不是绿勾 */
  idle: boolean;
}

/** 一次运行的结果。**这是「按一次运行组织的日志」的落点**：
 *  面板的环形日志是滚动窗口，而运行的结果是一条读数。 */
export interface DailyRun {
  at: string;
  ok: boolean;
  /** 一行摘要 */
  note: string;
  steps: DailyStep[];
}

/** 读最近一次运行。没有过就返回 `null`（不是空对象 —— 界面要能分清
 *  「还没跑过」和「跑了但没步骤」）。 */
export function readDailyRun(store: Pick<Store, 'getState'>): DailyRun | null {
  const raw = store.getState(dailyLastKey(store));
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as DailyRun;
    if (typeof v !== 'object' || v === null || !Array.isArray(v.steps)) return null;
    return v;
  } catch {
    // 库里那段 JSON 坏了（手改过库 / 老版本写的）⇒ 当作"还没跑过"，
    // 而不是让整个读数接口 500（那会让界面全白）
    return null;
  }
}
