// **把 store 包成"按账号自动路由"的那一层。**
//
// # 为什么是包 store，而不是让每个调用点写 `readKey(store, k)`
//
// 我先做的是后者（显式读写），做完发现它**是失败开放的**：
//
//   · 新代码只要顺手写成 `store.getState(K)` 就**绕过了账号袋** ⇒
//     那个键又静默变回全局 ⇒ 多账号串号那一串 bug（F-048/049/050）原样回来
//   · 而且"记得用哪个函数"是**纪律**，不是**结构**。纪律会松。
//
// 参考实现之所以没有这类 bug，是因为它的 API **强制**带账号：
//
//     async fn account_state(&self, id: &AccountId) -> Result<serde_json::Value>;
//
// 你没法在不指名账号的情况下读状态。包 store 得到的是**同一个性质**：
// `store.getState(K)` 永远走对，调用点没有"用错函数"的机会，而且一行都不用改。
//
// # 包在哪
//
// 只包两个构造点：`memStore()`（测试）与 `makeStore()`（生产）。
// 这样测试与生产走**同一条**路由 —— 不然"测试里对、生产里错"就有一整类
// 只有在真机上才出现。

import type { Store } from './types.ts';
import { routeGet, routeSet } from './keys.ts';

/** 已包过的标记。**防双重包装** —— 见下面那段说明。 */
const WRAPPED = Symbol.for('__mcloud_scoped_store__');

/** 裸 store 挂在这个 symbol 上。 */
const RAW = Symbol.for('__mcloud_raw_store__');

/** 取回被包住的那个**裸** store。
 *
 *  # 谁需要它
 *
 *  只有**迁移**（`migrateFlatKeys`）与测它的测试 —— 迁移读写的是**扁平键**，
 *  必须绕过路由，否则会把袋键当普通键读，越搬越乱。
 *
 *  ⚠ 业务代码**不许**用这个函数。用了就等于绕过账号路由，而那正是
 *  `scoped()` 要根除的东西（见文件头）。这里导出是为了让"绕过"这件事
 *  有一个**显式、可搜到**的入口，而不是让各处自己去扒属性。 */
export function rawStoreOf(s: Store): Store {
  const raw = (s as unknown as Record<symbol, unknown>)[RAW];
  return (raw as Store | undefined) ?? s;
}

/** 把 store 包成"按账号的键自动落到当前账号的袋里"的样子。
 *
 *  ⚠ **不许包两次**。包两次的行为是：外层把 `mcloud.acct.<id>` 这个键也拿去
 *  查登记表 ⇒ 查不到 ⇒ 抛 `UnregisteredKeyError`。也就是说双重包装会**立刻炸**
 *  （而不是静默出错），这是有意的；这里的标记只是把错误信息说得更清楚。 */
export function scoped(base: Store): Store {
  if ((base as unknown as Record<symbol, unknown>)[WRAPPED] === true) {
    throw new Error(
      'store 已经被 scoped() 包过一次了 —— 双重包装会让 `mcloud.acct.*` 也去查登记表然后抛错。',
    );
  }
  // ⚠ 这两个闭包捕获的是**裸 store**：`routeGet` 自己会用 `base.getState` 去读
  //   袋（`mcloud.acct.*`）与全局键。所以它是"唯一路由点"，不会递归。
  const wrapped: Store = {
    ...base,
    getState: (key) => routeGet(base, key),
    setState: (key, value, nowIso) => routeSet(base, key, value, nowIso),
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
  Object.defineProperty(wrapped, RAW, { value: base, enumerable: false });
  return wrapped;
}
