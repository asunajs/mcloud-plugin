# 压测发现

**协议**（用户定的）：这一轮**先压出来再改** —— 插件只用面板现有能力，
压出来的问题记在这里，回面板改是下一轮的事。每条都要有：怎么发现的、证据、
面板侧的根因（精确到文件行）、影响、插件侧怎么绕、建议怎么修、状态。

编号从 F-001 开始。

---

## F-001 手动触发时 `lateMs` 是负数、`scheduledAt` 指向未来

**怎么发现的**：插件第一次跑起来，在真面板上点「立即执行」跑 `selftest`，
插件把它记进了自己的 `runs` 表 —— 表里 `late_ms = -290918`。
负数延迟不是「迟到」，是公式用错了时刻。

**证据**（面板 `PLUGINS_DIR` 指向本仓库 `plugins/`，手动触发 `selftest`）：

```
[18:42:40] [mcloud] 已注册任务 `selftest`（@every 5m），下次触发 2026-10-13 18:47:40.950
[18:42:50] [mcloud] 自检通过（6/6 通过）· lateMs=-290918
```

`-290918 ms ≈ -4.84 分钟`，正好等于「18:47:40 的下次触发」减「18:42:50 的实际时刻」。
同一条记录在 `runs` 表里：`('selftest', 1, -290918, 1, '6/6 通过')`。

**面板侧根因**（`src/engine.rs:1822-1832`）：

```rust
let (plugin, name, expr, scheduled, runs_before) = {
    let t = &sched.tasks()[idx];
    (…, t.next_fire, t.runs)          // ← scheduled 取的是 next_fire
};
let late_ms = (now - scheduled).num_milliseconds();
```

定时触发时 `next_fire` 刚好是「这一刻本来该触发的时间」，`now - scheduled >= 0` ✓。
但**手动触发**（`POST /api/tasks/{plugin}/{name}/run`）时这个任务还没到点，
`next_fire` 在未来 → 差值必然是负的，`scheduledAt` 也成了未来的时刻。

**影响**：

- 任何「立即执行」都往数据里灌一条假样本。插件要拿 `lateMs` 做调度精度统计，
  手动触发的次数越多，分布被拉得越偏 —— 而这恰好是本轮要测的重点
- 对插件作者来说，`payload.scheduledAt` 在手动触发时**是错的**（未来时刻），
  按它做判断会出错
- 界面上「立即执行」是个正常功能，用户会经常用，所以这不是边角路径

**插件侧怎么绕**（本轮）：`store.lateStats` 只统计 `late_ms >= 0` 的样本，
并把被排除的条数一起报出来（不静默丢数据）；`recordRun` 对负值在 `note` 里标记。

**建议怎么修**（面板侧，下一轮）：手动触发不是「晚到」，它没有计划时刻可言。
两种改法里倾向后者：

1. `scheduledAt = firedAt`、`lateMs = 0` —— 最小改动，但同样把「手动」混进了调度样本
2. **payload 里加 `manual: true`**，`scheduledAt = firedAt`、`lateMs = 0` ——
   插件能明确区分，统计天然干净；代价是 payload 形状变了（要同步 `docs/host-api.md`
   与两个适配器）

**状态**：待修（面板侧）。插件侧已绕开。

---

## F-002 启动时打印「插件目录里没有找到任何 .js / .py 插件」，但目录里明明有

**怎么发现的**：把 `PLUGINS_DIR` 指向本仓库 `plugins/` 起面板，启动日志里出现这条
`warn`，紧接着两行之后就是「mcloud 插件已加载」。

**证据**：

```
[18:42:40] [kernel] [warn] 插件目录 /Users/catlair/mobile/workspace/mcloud-plugin/plugins 里没有找到任何 .js / .py 插件
[18:42:40] [mcloud] [info] mcloud 插件已加载（M0：自检 + 调度健康；上游任务在 M1/M2）
```

**面板侧根因**（`src/engine.rs:762-771`）：这条警告在**每个 worker 的启动路径**上，
条件是 `plugins.is_empty()` —— 即「**这个 worker** 名下一个插件都没有」。
`ENGINE_WORKERS=2` 而只有一个插件时，worker 1 必然是空的，于是每次启动都报一次。

`plugins.is_empty()` 判断的其实是「本 worker 分到的插件集为空」，
而文案说的是「插件目录里没有插件」—— 两件不同的事。

**影响**：运维排障时会被误导去找一个不存在的问题（目录明明有插件）。
日志是这个项目的重要事实来源，错的警告比没有警告更贵。

**插件侧怎么绕**：无（纯面板日志问题）。本轮只记录。

**建议怎么修**（面板侧，下一轮）：两种改法：

1. 只在**所有** worker 的插件集都为空时报警告（把「全局为空」和「本 worker 为空」分开）
2. 本 worker 为空时降级成 `debug` 级、且文案改成「worker N 未分到插件（共 M 个文件）」

倾向 2：`ENGINE_WORKERS=2` + 单插件是正常状态，不该是 `warn`。

**状态**：待修（面板侧）。

---

## F-003 `/api/state` 无法区分「没有插件」和「还没装完」

**怎么发现的**：本仓库 CI 的 E2E 第一次跑就红了，报「没有加载 mcloud 插件，只有 `[]`」——
但同一份面板日志里明明写着「已加载 1 个插件、2 个调度任务」。时间戳对得死死的：

```
10:47:22.34  我的断言跑完（state.plugins = []）
10:47:22.38  插件装好（[mcloud] 插件已加载 … 任务: 2）
```

**面板侧根因**：HTTP 服务在引擎装插件**之前**就开始响应了，而 `/api/state` 的
`plugins` 在那段时间里是空数组 —— 调用方无法区分「这个配置下真没有插件」和
「还在装」。脚本（包括本仓库的 CI、面板自己的冒烟）只能靠轮询「等到出现为止」。

**影响**：任何「起面板→立刻查状态」的自动化都会偶发拿到空列表。
这一类错在现场表现为「**有时**插件没加载」——很难复现，也容易被归咎于插件本身。

**插件侧怎么绕**：CI 里等的是「插件带着任务出现」，不是「接口返回 200」。

**建议怎么修**（面板侧，下一轮）：`/api/state` 暴露一个就绪标志，例如
`"engine": {"loaded": true, "plugins_loaded": 1, "plugins_scanned": 1}`，
或者在启动完成前让 `/api/state` 返回 503。前者对轮询更友好（也不破坏既有字段）。

**状态**：待修（面板侧）。

---

## F-004 `tasks` 与 `jobs` 语义不同，字段名不提示

**怎么发现的**：本仓库 CI 写断言时，把任务名去 `/api/state` 的 **`tasks`** 里找
（看名字以为是「所有任务」），结果拿到 `[]`。实际形状：

```
/api/state
  plugins[]  →  { name, runtime, tasks: 2, ticks, has_ui, has_on_tick, error … }
                                                     ↑ 这里是**数量**，不是列表
  tasks[]    →  只有正在跑的调用（样例里只有 kernel 自己的 heartbeat）
  jobs[]     →  **任务定义**在这里：{ plugin, name, next_run, last_run, deleted, last_error … }
```

**影响**：本仓库是这套 API 的**第一个外部消费者**，两次断言都栽在这里
（第一次 `p['tasks']` 拿到 int 2 → TypeError；第二次按 `tasks` 过滤拿不到任务）。
对插件作者来说这是纯摩擦：名字不提示区别，而猜错的代价是一轮 CI。

**插件侧怎么绕**：CI 改用 `jobs` 并按 `plugin` 过滤。

**建议怎么修**（面板侧，下一轮）：不一定要改名（改名是破坏性的），
在 `/api/state` 的字段注释 / `docs` 里写清「`tasks` = 正在跑的调用，`jobs` = 任务定义」，
或者把 `tasks` 改成 `inflight`（语义更准）。这条优先度低 —— 但它是**第一个外部消费者
真实的踩坑记录**，值得留下。

**状态**：待定（面板侧，属于文档/命名的摩擦，不是 bug）。

---

## F-005 插件沙箱里没有任何随机源

**怎么发现的**：M1 复刻上游签名时，`x-request-id` 与 `x-nonce` 在原实现里是
`uuid::Uuid::new_v4()`（172 位随机）。翻遍宿主 API 的最小公共子集，
没有任何一处能拿到随机字节：没有 `crypto`、没有 `crypto.getRandomValues`、
没有 `host.random` —— 只有 `Math.random()`。

**影响**：

- 本插件这一层**可以接受**（诚实写在 `src/mcloud/rand.ts` 的文件头）：
  `x-request-id` 只要求唯一；`x-nonce` 是防重放用的，但签名盐**写死在客户端里**，
  真正的凭据是 cookie / jwttoken —— 猜中 nonce 并不能伪造签名
- 但这是面板侧的一个**真实能力缺口**：生成密钥、一次性口令、抽签、幂等 ID
  这类插件做不了。而且「用 `Math.random()` 顶上」这种写法会悄悄扩散 ——
  每个插件作者都会踩一遍，然后各自写一句「这里够用」的注释

**插件侧怎么绕**：`Math.random()` + `Date.now()` + 自增计数（保证同毫秒内不重复），
并把强度取舍写在文件头。

**建议怎么修**（面板侧，下一轮）：加 `host.random(n) -> string`（宿主侧用现成的
`getrandom`，返回 hex 或 base64）。这是**小改动、明确的能力缺口**：
宿主已经依赖了 `getrandom`（令牌盐就是它生成的）。

**状态**：待修（面板侧）。

---

## F-006 宿主 `http_fetch` 失败时的返回形状与文档不一致，而且**长得像正常结果**

**怎么发现的**：在真面板里导入会话 → 插件内部发一次上游请求（假凭据，注定失败）→
路由返回 500，错误是：

```
TypeError: cannot read property 'length' of undefined
    at callOnce (mcloud.js:591:15)
```

**面板侧实际行为**（读源码确认）：

```rust
// src/jshost.rs
match state_for_http.do_http_fetch(&url, &opts) {
    Ok(s)  => s,
    Err(e) => json_error(&e),          // → {"error": "…"}
}
```

也就是说失败时返回的是 `{"error": "…"}` —— **没有** `status` / `headers` / `body`。
而 `docs/host-api.md` 只写了成功形状（`→ { "status": int, "headers": {…}, "body": str }`），
没写失败形状。

**为什么这条比一般的「文档不全」更坑**：

1. 返回的对象**长得像一个正常结果**。任何写 `res.body` 的代码会拿到
   `TypeError: cannot read property 'length' of undefined` ——
   报错位置在**插件里**，看起来像插件自己的 bug。我第一反应也是去翻自己的 `callOnce`。
2. 它**只在真面板里出现**。Node 测试里的桩是我自己写的，形状当然"正确" ——
   也就是说：你越是只在 Node 里测，越测不到它。
3. 我自己写的那份 `src/host-api.d.ts` 把它声明成了纯 `FetchResult`，
   于是 **TypeScript 没有机会提醒我** —— 一个写错的 `.d.ts` 会悄悄拿走类型安全。

**插件侧怎么绕**：`callOnce` 先认形状（`error` 字段 / `body` 不是字符串 / 干脆是
`undefined`），再取字段；三种都变成「可读的失败」而不是异常。
测试里补了三条用例，桩**故意造出**失败形状与畸形形状。

**建议怎么修**（面板侧，下一轮，二选一）：

- **推荐**：`docs/host-api.md` 里把失败形状写进返回签名 ——
  `-> { "status", "headers", "body" } | { "error" }`，并加一句
  「失败时**没有** `status`/`headers`/`body`，不要直接读 `res.body`」
- 更彻底：成功/失败都带 `ok` 字段（`{"ok":true,status,headers,body}` /
  `{"ok":false,error}`），调用方先看 `ok` —— 破坏性变更，需要发版说明

**顺带**：`docs/host-api.md` 的返回签名是给**插件作者**看的契约，
这类「成功一种形状、失败另一种形状」的接口，文档里应该像错误码一样列出来。

**状态**：待修（面板侧）。

---

## F-007 面板对写请求强制 `x-panel: 1`，**插件自己注册的路由也适用** —— 但插件文档里没提

**怎么发现的**：在真面板上用 curl 调自己插件的 `POST /plugins/mcloud/api/session`，
收到一句中文说明：

```
写接口要求请求头 `x-panel: 1`（防跨站请求伪造；面板页面自己会带上）
```

**这不是 bug** —— CSRF 防护是对的，而且这条对插件路由生效**也是对的**
（否则第三方页面就能借用户的浏览器打插件接口）。但它是**插件作者必须知道的事**：

- 插件自己的 WebUI（`plugins/<name>/**` 下的静态页）里发 POST 时**必须带上这枚头**，
  否则会失败。失败信息是人话，排查不难；但如果插件作者只看了 `docs/host-api.md`
  （那里只讲 `register_route` 的注册与请求/响应形状），就会以为「我的路由我作主」。
- 写脚本的人同样容易漏（我自己就漏了，第一轮验证白跑一次）。

**插件侧怎么绕**：在 `docs/howto-session.md` 里显式写了这一行，并说明
「插件自己注册的路由同样适用」。后面做 WebUI（M4）时，页面里的 fetch 统一包一层
自动加头。

**建议怎么修**（面板侧，下一轮，都是小改动）：

1. `docs/host-api.md` 的 `register_route` 一节加一句：写方法（POST/PUT/DELETE…）
   需要请求头 `x-panel: 1`，与面板自身接口同一套规则
2. 可选：给插件作者一个现成的 GET 出口读「本面板对写接口的要求」，
   或者在 `docs/plugins.md`（如果存在）里点一下

**状态**：待修（面板侧，文档）。低优先，但能省掉每个插件作者的一次白跑。

---

## F-008 相对 `import` 其实不成立，而报错文案偏偏建议你用它 ✅ **已修（面板侧）**

**怎么发现的**：想按"一份 core + 多个薄插件"来切这个项目，先写了个探针验证插件能不能
`import './lib.js'`：

```text
[probe] 插件加载失败: ReferenceError: Error loading module './lib.js':
        只内置了 `host-api` 模块；插件之间请用相对路径 import
```

**面板侧根因**（读源码确认）：

- `HostApiResolver::resolve` 把模块名**原样返回**，连 `base`（导入方路径）参数
  都标着 `_base` 没用上 —— 注释还写着"其它交给默认规则（相对路径）"，那是**意图**，
  从来没实现
- `HostApiLoader::load` 只认 `host-api`，其余一律 `Err`
- 于是"相对 import"两头都不成立，而错误文案建议的就是这件事

顺带撞出第二个问题：`plugins/js/lib.js` 这个"库文件"**自己也被当成一个插件加载**
（任务数 0）。扫描规则是"下钻两层 + 只跳过带 `index.html` 的目录"，只考虑到了
配置页资源，没想到模块目录。

**影响**：插件作者按报错提示做，会收到同一句话 —— 很容易以为自己路径写错了，
去反复检查相对路径。对"把一个大项目拆成 core + 薄插件"这种结构，等于门是关着的。

**已修**（`asunajs/panel`，commit 见仓库）：

- 解析器按 **URL 语义**把相对说明符解析成 `file://` URL（模块标识就是 URL，
  顺带 `import.meta.url` 也填上了 —— QuickJS 不自动给，得宿主填）
- 加载器按解析出的路径读文件；边界限制在插件目录内
- ESM 语义，但解析**放宽**：扩展名可省、目录自动找 `index.js`（候选链
  `原样 → +.js → +.mjs → /index.js → /index.mjs`），这条链与 `require` 共用
- 另加 `require`（CJS 兼容）：`require('host-api')`、`require('./lib/x.js')`、
  与 import 同一套解析、按 URL 缓存；读 ES 模块时明确报错「请用 import」
- 两个方向都给了能照着做的提示：`require` 读 ES 模块 → 「请用 import」；
  `import` 读 CJS 文件 → 「请用 require，或改成 ES 模块」
- 扫描规则收紧：只收 `plugins/` 根与 `plugins/js|py/` 这一层 → 「模块放子目录」
  成了结构性约定，库文件不会再变成插件

**对本仓库的意义**：`core + 薄插件` 这条路通了，而且**不复制 core** ——
同一个模块文件被多个插件 import 只加载一次（按 URL 缓存），
这对"低配盒子上跑很多插件"的内存账很关键。也意味着不必为了共用 core
而接受 N 份打包产物（esbuild 每条入口都会内联一份 ✗）。

**状态**：已修（面板侧），本仓库可开始按这个结构切分。
