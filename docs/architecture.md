# 架构：一份异步核心，两个宿主

> 这份是**现状的骨架**（不是业务规格）。业务口径看 `live-spec.md` / `prize-claim.md` /
> `task-state.md`；历史与踩坑看 `findings.md`；这一轮为什么要重构看 `refactor-plan.md`。

## 1. 一句话

四个面板插件 + 一个 Node CLI，**共用同一份核心**；一切 I/O 走**端口**，两个宿主各写一份实现。
不再有"同步步骤机 + 每步落盘"那套东西 —— 它是被"2 秒预算 + 打不断的阻塞调用"逼出来的，
而 panel-llrt 早就是全 async + 长预算 + 可取消了。

## 2. 分层与 import 规则

    src/
      core/       协议与任务（签名、信封、H5、登录、口令池、每条任务的步骤）
      app/        编排：一次运行 = 一个 async 函数；routes/ 按界面块
      present/    文案 / 级别 / 去重 / tally（「人话」的唯一出处）
      ports/      Http / Clock / Store / Ws / Log / Panel 的**接口**
      host/
        panel/    panel:host 的唯一使用者；四个插件的注册
        cli/      Node CLI 宿主（fetch / ws / setTimeout / fs）
        fs/       FileStore —— 面板与 Node 都能跑的 JSON 存储
      entries/    四个薄入口（名字 + cron + budget + 交给 app）
      cli/        mcloud-sign 入口（参数、退出码、着色）

| # | 规则 | 谁在守 |
|---|---|---|
| R1 | 只有 `src/host/panel/*` 能 `import 'panel:host'` | `scripts/check-layers.mjs` |
| R2 | 只有 `src/host/panel/task.ts` 能写 `globalThis.__handlers` | 同上 |
| R3 | `core/`、`app/` 不许 import `host/`；不许 `node:*` / `process` / `Buffer` / `setTimeout` | 同上 + tsconfig `types: []` |
| R4 | 所有 I/O 走端口；产物里出现同步宿主 op 判红 | `scripts/check-contract.mjs` |
| R5 | 缺能力先找面板加 API，不在插件里造同步桥 | 人工（面板 `plugin-contract.md` R6） |
| R6 | `src/host/fs` 只用 LLRT 也有的 fs 子集 | `scripts/check-layers.mjs` |

> 为什么 R2 要有：面板的 `register_cron(name, cron, budget)` **只认名字**，函数必须落在
> 引擎预建的 `globalThis.__handlers` 表里。这是面板的契约，收在一个文件里就够；
> 散到四个入口就是「插件上下文污染」的来源。

## 3. 存储：本地 JSON（含凭据）

    <store>/
      meta.json                   schema 版本 / 插件版本 / 创建时间
      config.json                 设置（面板「插件配置」表单写的就是它）
      accounts.json               账号表
      auth/<acct>.json            凭据（0600）
      state/<acct>/<plugin>.json  每插件 × 账号的状态袋（写者唯一）
      state/<acct>/shared.json    跨插件共享的账号级状态
      runs/<plugin>.json          运行记录（最近 N 次）
      pool.json                   口令池
      logs/<plugin>.json          环形日志

- **面板**：`<data>/plugin-data/mcloud/`（`host.plugin_data_dir()` 的约定）；
  另三个插件用 `join(dirname(自己的 data_dir), 'mcloud')` 指过去。
- **CLI**：`MCLOUD_DATA_DIR` 或 `~/.mcloud`。指到面板那个目录 = 两边共用账号与凭据。
- **写**：tmp + `renameSync`（原子）；凭据写完 `chmodSync(0o600)`；
  跨宿主互斥用 `mkdirSync(lock)` + 陈旧锁超时。
- **为什么不是 SQLite**：面板的 `sqlite_*_sync` 每次调用**新起一个线程 + 一个新 runtime**
  （`sync_bridge::run`），而业务侧有 305 处读写；换成文件之后一次运行只有"装载 + 落盘"两次 I/O。
  附带好处：CLI 与面板共用同一份数据，不用再维护两套。

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
| P3 | HTTP 全 async；CLI 同步重写 | — |
| P4 | 存储换本地 JSON（含旧数据一次性导入） | — |
| P5 | 编排层 / 呈现层 / 路由拆分 | — |
| P6 | 直播收口 + trace | — |
| P7 | 目录式插件（共用核心）+ 界面分块 | — |

> 面板要能加载**目录式插件**（`plugins/<name>/index.js` + 相对 import）才做得了 P7；
> 装机的那份二进制比这个能力早 22 秒（`15:28:31` vs 提交 `15:28:53`），要重装。
> 在它跟上之前，产物仍是单文件（同一份源码，行为一致）。
