# P3 执行手册：同步 → 异步

> 这是**动手前的账**。P3 是整个重构最后一块，也是一块必须一次做完的 ——
> `Transport` 一旦变成 `Promise`，整条调用链都得 `await`，半途停下就是"类型不过、跑不起来"。
> 所以先把范围量出来，再决定窗口。

## 1. 量出来的范围（2026-11-16，HEAD `bd542d3`）

```
直接碰 transport 的函数        6 个（client 2 + authorized 2 + probeNativeTls 1 + makeTransport 1）
需要跟着变 async 的函数        106 个，分布在 52 个文件
测试侧任务调用点              ~327 处（`test/*.ts` 里 runXxx(...) 那一层）
```

最多的几个文件：

| 文件 | 要改的函数 |
|---|---|
| `src/mcloud/tasks/redpackJobs.ts` | 15 |
| `src/mcloud/tasks/prizeClaim.ts` | 7 |
| `src/mcloud/tasks/liveListen.ts` | 6 |
| `src/mcloud/tasks/redpack.ts` | 6 |
| `src/mcloud/tasks/tokenPkActions.ts` | 4 |
| `src/entries/{shared,live}.ts` | 3 + 3 |
| 其余 46 个文件 | 每个 1~3 |

## 2. 要改的三层

1. **端口**：`src/ports/io.ts` 的 `Io.fetch` → `Promise<FetchOutcome>`。
   面板实现改用 **`host.fetch`（异步 op）**，不再是 `http_fetch`（`sync_bridge` 每次新起线程 + 新 runtime）。
   `sql`（只剩"从旧库搬一次"用）与 `smtp`/`ws_*` 先保持同步 —— 它们没有异步版，也不在热路径上。
2. **协议层**：`src/mcloud/client.ts` 的 `Transport` → `(req) => Promise<HostFetchResult>`；
   `callRawText`/`callOnce` → `async`；`accountRuntime/shared.ts` 的 `authorized`、`hostCap.ts` 的
   `probeNativeTls` 跟着 `async`。
3. **业务层**：上表 106 个函数 `async` + 所有调用点 `await`；返回类型注解 `X` → `Promise<X>`。

## 3. 建议做法（机械变换 + tsc 收口）

1. 开分支：`git switch -c p3-async`。**先不动测试**。
2. 手改第 2 层（6 个函数），`npx tsc --noEmit` 会立刻列出几百个错误 —— 那就是清单。
3. 用脚本做机械变换（TS compiler API，别手改 106 处）：
   - 从 `transport`/`callRawText`/`callOnce` 出发，按"函数名 → 调用者"做**反向闭包**，
     得到 async 集合（本次量的 106 个就是它）；
   - 给集合里的声明加 `async`；返回类型注解包一层 `Promise<>`；
   - 给集合里的**调用点**插 `await`（按 import 表解析目标，别按名字瞎猜 —— 同名不同模块会串）；
   - 同一文件里调用本文件函数时按声明名解析。
4. `tsc` 收剩余：`Promise` 当值用（要 `await`）、`await` 出现在非 async 回调里（那个回调也要 async）、
   `forEach/map` 传 async 回调（改成 `for…of` + `await`，**顺带修一处并发 bug**）。
5. 测试：把 `test('…', () => …)` 改成 `async () => …`，调用点 `await`。
   `node --test` 认 async 用例，不用换框架。
6. 收尾：`npm run all` → 影子实例跑三条任务（照 P4/P6 验过的做法）→ `deploy:panel --restart`。

## 4. 已知的坑（提前写在这里，省一轮）

- **`void` 的即发即忘**：`panel.registerTask` 之类是有意不等的；机械变换别给它加 `await`。
- **面板的 ws 是同步的**（`ws_recv` 带超时）。`liveListen` 的循环会变成 `async` 但**不能**指望
  "异步收包" —— 面板没有那套 API。P3 只把 HTTP 变异步，WS 那一段的形状保持不变
  （这也是 P6 说要"收口"的原因：听窗口的阻塞要单独设计）。
- **`drain()` 的循环**：现在按"步数上限 + 预算"停；变 async 之后要把 `await` 放进循环体，
  别把 `for` 改成 `Promise.all`（上游限流，必须串行）。
- **测试里的假 transport**：`test/helpers.ts` 的 `noopTransport` 等一批桩要改成 `async` 返回；
  改了之后**所有**"桩签名"所在的文件都要跟一遍。
- **错误形状不变**：`callRawText` 仍返回结构化 `{status, json, text, error}`，不要顺手改成抛异常 ——
  那会把"业务失败 vs 环境炸了"的区分毁掉（见 client.ts 头注 ③）。

## 5. 验收

| 项 | 判据 |
|---|---|
| 单测 | `npm run all` 全绿（1235 条 + 新增的 async 相关用例） |
| 真面板 | 影子实例：日常 / 兑换 / 直播 各跑一趟，读数与日志和改之前**逐条对得上** |
| 不阻塞 | 跑日常期间并发请求 `/api/readings`：应当**立刻返回**（现在是排在后面等） |
| 计时 | `/api/live/trace` 与运行记录里的 `ms` 不应变差（异步不等于更快，别拿它当优化） |

## 6. 回滚

`git switch main && git branch -D p3-async`。因为 P3 是纯形状变换，**没有数据迁移**，
回滚不需要动 store（这点和 P4 不同）。
