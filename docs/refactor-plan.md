# 重构计划（2026-11）：从「面向老面板的同步插件」到「一份核心 + 两个宿主」

> 这份文档是**当时的计划与现在的账**。每条前面标状态：✅ 做完并验证 · 🚧 做到一半 · ⬜ 还没动。
> 为什么重构、病根在哪，见 `docs/architecture.md`；踩过的坑见 `docs/findings.md` F-138~F-141。

## 0. 为什么

插件本来是"面向 Node / 老面板"的：核心是**同步**的（`http_fetch`、`sqlite_query_sync`、
忙等 sleep），入口是**一份代码兜两个宿主** + 一层厚厚的适配。开发越久，越往老面板那边靠，
于是出现一类"说不上哪儿错、但就是跑不理想"的问题：

- 宿主 op 全是同步的 ⇒ 网络一慢，整段 JS 卡住（面板的执行位被占着）；
- 状态每次读写都穿一次跨线程 RPC（`sync_bridge::run` 每次新起线程 + 新 runtime）；
- 面板的 job 事件、cron 注册、`__handlers` 表、配置读写，全散在四个入口里；
- live 前前后后做了一个多月没跑通 —— 它的链路最长，最吃"同步阻塞 + 状态不落地"的亏。

## 1. 目标（已与用户确认）

| # | 决定 |
|---|---|
| 1 | 只面向 **panel-llrt（新面板）** 与 **Node CLI**；老面板产物冻结在 tag `legacy-0.4.2-sync` |
| 2 | **保持 4 个插件**（面板一个插件只有一条 JS 执行通道，拆不开） |
| 3 | **核心 import 共用**（不是四份拷贝） |
| 4 | 配置（含 auth）落**本地 JSON**；其余"看面板和 CLI 怎么方便" |

## 2. 分层（`docs/architecture.md` §2 是权威版本）

```
src/mcloud/**     业务（不知道宿主存在）
src/store/**      状态语义（键的作用域、账号袋）
src/ports/**      端口：io / log / panel / ws
src/host/panel/** 唯一 import 'panel:host' 的地方（任务注册、路由、宿主 op）
src/host/fs/**    本地 JSON 存储（面板与 CLI 共用）
src/entries/*.ts  四个入口（< 60 行只是目标，现状见 P5）
src/standalone/** Node CLI
```

## 3. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 基线、`docs/architecture.md`、打好 tag | ✅ |
| P1 | 只留面板目标：删老面板产物/打包脚本，构建只出 panel-llrt | ✅ |
| P2 | 宿主收进端口：`panel:host` / `__handlers` / SQLite 调用**全局只剩一处** | ✅ |
| P4 | 存储换本地 JSON（含一次性导入）；面板与 CLI 共用一份实现 | ✅ |
| P7 | 目录式插件：四个入口 import **同一份** `mcloud/lib/`；部署按面板能力自动选形状 | ✅ |
| P3 | 同步 → 异步：`Transport` / `Io.fetch` 变 Promise，`drain`/任务/入口/路由全部 await | ✅ |
| P5 | `src/app/runTask.ts` 统一 runner + `src/present/*` + 路由拆分 + 任务编排搬出 entries | 🚧 路由✅（`app/routes/`）、直播✅（`app/live/`）、日常✅（`app/daily/`）；兑换 / runTask / present 未动 |
| P6 | 直播收口成一个 invocation（门→连→听→领→关）+ trace 环 + `GET api/live/trace` | ✅ trace 环 + `GET /api/live/trace`；收口完成（`src/app/live/`：collect / draw / run，入口只剩注册） |

### P3 为什么还没做

它是**一条链上的整体改动**：`Transport` 一改成 `Promise`，`client` → 各业务模块 → 任务 →
drain → 四个入口全部要跟着 await（测试侧 327 处任务调用、97 处请求调用）。
半途停下的树是"类型不过、跑不起来"的状态，所以必须一次做完再做别的。

### P4 与 P7 的关键结论

- **存储**：`<store>/` 下 `meta.json` / `shared.json` / `state/<账号>.json` / `runs/<插件>.json`；
  原子写 + 目录锁；`meta.json` 不存在时从面板 SQLite（或 CLI 老 `state.json`）搬一次。
  面板里目录就是 `plugin-data/mcloud`（四个插件指同一处），CLI 用 `MCLOUD_DATA_DIR`。
- **共用核心只能走目录式插件**：单文件插件做相对 import 会解析失败（F-141 实测表）。
  面板多文件插件能力是 2026-11-16 才进的（commit `9af5403`），**装机的那份二进制比它早 22 秒**，
  所以 `npm run deploy:panel` 会自动判形状：老二进制 → 单文件；新二进制 → 目录式 + 共用核心。

## 4. 验收（现在的账）

| 项 | 结果 |
|---|---|
| `npm run all` | typecheck + build + 1226 单测 + check-build + check-layers 全绿 |
| 真面板（新构建的 panel-llrt）跑 `e2e-mock.sh` | 日常/兑换/直播三条任务 + 算力大作战字节级断言 + 口令池 + 领小红花 全过 |
| CLI | `MCLOUD_DATA_DIR=<tmp> mcloud-sign status` 能建出 store 并跑完一趟（无真凭据时按预期报"没有网页会话"） |
| 老数据 | 首次启动从面板 SQLite 搬 key + 运行记录（单测覆盖：袋按账号拆、运行记录按任务归属） |
| **真机换装（2026-11-16 17:26）** | 面板二进制换成 `2c5d027`（含多文件插件 + import 不设围栏），四个插件改成目录式装进 `~/panel-3030`：`failed_plugins: 0`；store 建在 `data/plugin-data/mcloud/`，搬过来 **3 个账号**、35 个全局键、4 份运行记录、400 行日志环 |
