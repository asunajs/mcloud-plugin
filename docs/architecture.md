# 架构：一份异步核心，两个宿主

> 这份是**现状的骨架**（不是业务规格）。业务口径看 `live-spec.md` / `prize-claim.md` /
> `task-state.md`；历史与踩坑看 `findings.md`；这一轮为什么要重构看 `refactor-plan.md`。

## 1. 一句话

四个面板插件 + 一个 Node CLI，**共用同一份核心**；一切 I/O 走**端口**，两个宿主各写一份实现。
不再有"同步步骤机 + 每步落盘"那套东西 —— 它是被"2 秒预算 + 打不断的阻塞调用"逼出来的，
而 panel-llrt 早就是全 async + 长预算 + 可取消了。

## 2. 分层与 import 规则

    src/                         ← **现状**（下面 §2.1 是"最终想长成的样子"）
      mcloud/      业务：协议（签名/信封/H5）、登录、口令池、每条任务的步骤与运行记录
      app/routes/  路由：原来 mcloud/routes.ts 那 3400 行，按界面块拆成一堆组文件
      app/live/    直播那条任务的一次运行：collect（收口令）/ draw（按账号领）/ run（编排+日志）
      app/daily/   日常那条任务的一次运行：run（逐账号跑 + 日志 + 运行记录 + 推送）
      app/exchange/ 兑换那条任务的一次运行：run（按计划分发 + 日志 + 记录 + 推送）
      store/       状态语义：键的作用域（哪个键跟账号、哪个是全局）、账号袋
      ports/       端口接口：io（fetch/sql/smtp/ws）/ log / panel / ws
      host/
        panel/    `panel:host` 的唯一使用者；四个插件的注册、路由分派、任务合成
        fs/       FileStore —— 面板与 Node CLI 共用的 JSON 存储
      entries/     四个薄入口（名字 + cron + budget，其余交给 mcloud/app）
                   register.ts：三条任务共用的开场（建 store → 并配置 → 算预算 → 注册 → 写卡片）
      standalone/  Node CLI（mcloud-sign 与那几个子命令）
      types/       `panel:host` 的 `declare module`

### 2.1 最终形态（还没搬完，别照着找文件）

    src/
      core/        现在的 src/mcloud/（协议 + 业务）
      app/         现在的 src/app/routes/ 之外再加：runTask.ts（统一 runner）
      present/     文案 / 级别 / 去重 / tally —— 现在散在 mcloud/ 各处的"人话"
      host/cli/    现在叫 src/standalone/

> 为什么现在不一次搬完：`mcloud/` 里 140 多个文件互相 import，改目录名一次就是几千行
> diff，而 P3（同步 → 异步）本来就要把这些文件再动一遍。**先做 P3，再搬目录** ——
> 否则同一批文件要改两次，中间还要重新验证。

| # | 规则 | 谁在守 |
|---|---|---|
| R1 | 只有 `src/host/panel/*` 能 `import 'panel:host'` | `scripts/check-layers.mjs` |
| R2 | 只有 `src/host/panel/task.ts` 能写 `globalThis.__handlers` | 同上 |
| R3 | `src/mcloud/` 等业务层不许 import `host/`、不许 `node:*` / `process` / `Buffer` / `setTimeout` | `scripts/check-layers.mjs`（tsconfig 的 `types` 留着 Node —— 宿主层要写文件，围栏改成可执行的门禁更准） |
| R4 | 所有 I/O 走端口；产物里出现同步宿主 op 判红 | `scripts/check-contract.mjs` |
| R5 | 缺能力先找面板加 API，不在插件里造同步桥 | 人工（面板 `plugin-contract.md` R6） |
| R6 | `src/host/fs` 只用 LLRT 也有的 fs 子集 | `scripts/check-layers.mjs` |

> 为什么 R2 要有：面板的 `register_cron(name, cron, budget)` **只认名字**，函数必须落在
> 引擎预建的 `globalThis.__handlers` 表里。这是面板的契约，收在一个文件里就够；
> 散到四个入口就是「插件上下文污染」的来源。

## 3. 存储：本地 JSON（含凭据）

    <store>/
      config.json                 ★**唯一用户配置文件**（见 §3.1）
      meta.json                   schema 版本 / 插件版本 / 创建时间（存在 = 已初始化过）
      shared.json                 运行时状态：账号表、口令池、环形日志、session…
      state/<acct>.json           账号袋（一个号一个文件，里面的键名与实现无关）
      runs/<plugin>.json          运行记录（写者唯一：四个插件各写各的）
      backup/                     迁移前的一次性快照（config-migration-* / config-import-*）

- **账号袋为什么不按插件拆文件**：拆了要先有一张"每个键归谁"的 owner 表，
  收益只是少几次短锁 —— 先把"别再每次一个线程"做掉，这件事留到真需要时。
- **环形日志与全局键在 `shared.json`**：四个插件都会写（日志每行一次），
  所以写一律过目录锁；读不加锁（原子 rename 保证读到完整文件）。
- **凭据也在这些文件里** ⇒ 每次写后 `chmodSync(0o600)`。
- **旧数据**：`meta.json` 不存在时跑一次导入（面板 SQLite 的 `state`/`mcloud_runs`，
  或 CLI 老的 `state.json`），导入在锁里做 ⇒ 四个插件同时首启也只搬一遍。

- **面板**：`<data>/plugin-data/mcloud/`（`host.plugin_data_dir()` 的约定）；
  另三个插件用 `join(dirname(自己的 data_dir), 'mcloud')` 指过去。
- **对外契约（别的插件会读）**：`shared.json` 里的 `mcloud.accounts`（全局键，
  JSON 数组，元素含 `id` / `label` / `auth` / `disabled`；`auth` 是
  `Basic base64(<pc|mobile>:<手机号>:<token>)`）。咪咕音乐插件（mgmusic 0.6.0 起）
  按这条约定**只读**它，用云盘维护的那份凭据换咪咕登录态 —— 所以键名、位置、字段
  都是跨仓契约，由 `test/accountsContract.test.ts` 钉住，别随手改名。
- **CLI**：`MCLOUD_DATA_DIR` 或 `~/.mcloud`。指到面板那个目录 = 两边共用账号与凭据。
- **写**：tmp + `renameSync`（原子）；跨进程互斥用 `mkdirSync(lock)` + 陈旧锁超时。
- **为什么不是 SQLite**：面板的 `sqlite_*_sync` 每次调用**新起一个线程 + 一个新 runtime**
  （`sync_bridge::run`），而业务侧有 305 处读写；换成文件之后一次运行只有"装载 + 落盘"两次 I/O。
  附带好处：CLI 与面板共用同一份数据，不用再维护两套。

### 3.1 唯一配置文件：`config.json`

**用户能改的东西只有一份**：`<data>/plugin-data/mcloud/config.json`。面板「插件 → 配置」、
插件自己的设置页、CLI（`--config` 指它）读写的都是这一份。

```json
{
  "schema_version": 1,
  "daily_budget_s": 600,
  "exchange_enabled": true,
  "exchange": { "plans": [] },
  "live": { "listen_seconds": 600 },
  "push": { "config": {}, "rules": [], "bindings": {} },
  "cli": { "http": { "timeout_ms": 20000 } },
  "accounts": { "13800138000": { "listen_seconds": 300, "listen_room": 147606 } }
}
```

* **判据（一句话）**：**需要用户手设、或者可能手动设置的**才叫配置。
  程序自己算出来的、只有老客户端兼容入口会写的、以及已经没写入口的死开关，都不算 ——
  它们留 state（`RETIRED_BINDINGS` 记着哪几格是**曾经搬进去又搬出来**的，升版时迁移会把
  已经写进文件的值搬回 state，值不丢）。
* **哪些键归它**：`src/store/userConfigKeys.ts` 的 `CONFIG_BINDINGS` —— 一张表说了算。
  那些键**不在** `KEY_SCOPE` 里出现，`scopeOf()` 先查绑定表并返回 `'config'`。
* **调用点不用改**：`scoped()` 的 `getState/setState` 照旧，物理位置由路由层决定。
  裸 store 上写配置键**直接抛错**（`assertNotConfigKey`）—— 免得又造出第二个家。
* **不必重载插件**：`JsonFile` 按 `mtime+size` 失效缓存 ⇒ 面板保存之后，插件**下一次读**
  就是新值（以前要等面板重载那个插件）。
* **面板清单**只有 `mcloud` 声明 `config.fields`（两格：日常预算 / 定时抢兑）；
  `mcloud-daily` / `mcloud-exchange` / `mcloud-live` **不再有配置表单** —— 同一格设置
  不会再有四个入口。面板机制要求文件存在的话也无所谓：那三份 `config.json` 从此没人读。
* **迁移**：第一次加载把旧来源合进来，然后**删掉**旧 state 键（`shared.json` / 账号袋），
  旧的四份 `plugin-data/<插件>/config.json` 原样留着但不再读。幂等判据 = `schema_version`。
  合并前把旧文件原文与被搬走的键备份到 `backup/config-migration-<时间>/`。
* **旧 CLI 配置**：`asign.json` / `asign.config.js|mjs` 可以一次性搬进来 ——
  `mcloud-sign config:import --config asign.json --data-dir <…> [--dry-run]`
  （或导出的 `importLegacyConfig()`）。账号进 `shared.json` 的 `mcloud.accounts`，
  `standalone.http|ws` 进 `cli.*`。之后 `--config` 直接指 `<store>/config.json` 即可。
* **文件权限**：0600（里面有推送口令 / 代理地址这类东西）；坏 JSON 不拦加载 ——
  `JsonFile` 会把它改名成 `config.json.corrupt-<ts>` 后按空继续。

**边界（一句话）**：**用户能改的 → config.json；程序自己写的 → shared.json / 账号袋。**
账号凭据、session、进度、口令池、追踪环、运行记录、日志都属于后者，一个字节没动。

## 4. 产物

    dist/panel-llrt/            面板（4 个插件 + 4 份清单 + mcloud.webui/）
      mcloud/                   （目录式插件时）唯一的共用核心
    dist/standalone/            CLI（mcloud-sign）

面板与 CLI 用的是**同一份 `src/core`**，只有 `src/host/*` 不同。

## 5. 这一轮的基线（重构前，2026-11-16）

| 项 | 读数 |
|---|---|
| 类型检查 | 通过 |
| 单元测试 | **1225 / 1225** 通过（101 个文件，7.8s） |
| 产物体积 | mcloud 527KB · daily 386KB · exchange 207KB · live 225KB（合计 1345KB） |
| 源码规模 | `src` 138 个 TS / 41.4k 行；`test` 101 个 / 25.4k 行 |
| 请求站点 | 97（`callRawText` 87 + `callOnce` 10） |
| 状态读写点 | 305（`getState` 150 + `setState` 155） |
| 测试里的任务调用点 | 327 |

## 6. 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 基线、本文档 | ✅ |
| P1 | 删老面板目标（产物 / 构建 / CI / 检查脚本） | ✅ |
| P2 | 端口化 + `defineTask`，全局收口 | 进行中 |
| P3 | HTTP 全 async（`Transport` / `Io.fetch` 是 Promise）；CLI 的同步桥已拆（直接 await `fetch`） | ✅ |
| P4 | 存储换本地 JSON（含旧数据一次性导入） | ✅ |
| P5 | 编排层 / 呈现层 / 路由拆分 | 🚧 路由拆完；三条任务的编排都搬出 entries（`app/daily`、`app/exchange`、`app/live`，入口 90/100/82 行）；`runTask` 统一 runner 与 `present` 未动 |
| P6 | 直播收口成一个 invocation + trace | ✅ 入口 82 行只做注册；编排在 `src/app/live/{collect,draw,run}.ts`；`GET /live/trace` 真机验过 |
| P7 | 目录式插件（共用核心）+ 界面分块 | ✅ 产物可用（见下） |

### P7 的两种产物形状

| 形状 | 命令 | 什么时候用 |
|---|---|---|
| 单文件（**默认**） | `npm run build` | 面板**没有**多文件插件能力时（≤ 0.5.1 的已发布版）。四个包各自内联核心 |
| 目录式 + 共用核心 | `npm run build:dir` | 面板有 `plugins/<name>/index.js` + 相对 import 时。四个入口 import **同一份** `mcloud/lib/` |

`npm run deploy:panel` 会**自动选**：它读目标实例的二进制里有没有"import 的文件不存在"
那句错误串（多文件插件是 commit `9af5403` 才进面板的，而 `panel version` 没变号）。
要强制某一种：`MCLOUD_PKG=single|dir`。

> ⚠ 目录式产物的构建方式必须是 **`bundle:true` + 把相对 import 全标 external**：
> 面板不解析 npm 包（裸包名 `fflate` 会在加载期 `Error resolving module`），
> 而自己人要保持文件边界（四个插件共用、栈里是真实文件名）。`bundle:false` 两头都做不到。
> 另外 esbuild 会把手脚瘦掉的类型 import 留成 `import "../x.ts";`（**副作用形式**），
> 改写 `.ts → .js` 必须覆盖这种形状。两处都踩过（F-142）。

> 实测（隔离实例 + 临时插件）：目录式插件 + **跨目录** `import '../mcloud/lib/…'` 能加载；
> 单文件插件做同样的相对 import 会失败（`Failed to resolve`）。所以"共用核心"只能走目录式。
> 代价：四个插件是一套 —— 删掉 `mcloud/` 会让另外三个起不来（部署脚本整份拷贝、备份成对做）。
