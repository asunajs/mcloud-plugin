# App 任务：Rust mcloud 与本插件对照

**只参考 Rust 版 mcloud**（`/Users/catlair/mobile/workspace/mcloud`）。`mcloud-sign` 是旧 TS，很多已过期，不作为依据。

- `crates/mcloud-tasks/src/app_task.rs` —— 判形状、上传、分享、入口、月门
- `crates/mcloud-tasks/src/app_task/runners.rs` —— 107 / 472 / 473 / 1004 / 1014 / 1020 / 1028 / 585 / 1029 / 609
- `crates/mcloud-upstream/src/app_task_entry.rs` —— 409 / 1005 的两发上报
- `crates/mcloud-upstream/src/app_cloud_outlink.rs` —— 434 的建外链 / 删外链
- `crates/mcloud-upstream/src/mail139.rs` —— 邮箱登录、邮件转存、queryUserToken、账单、PE
- `crates/mcloud-upstream/src/ai_cloud.rs` —— 状态查询、SSE 对话、AI 相机

插件对应：

- `src/mcloud/tasks/appTaskMatrix.ts` —— 只读矩阵
- `src/mcloud/tasks/appTask.ts` —— 状态机：**先打卡**（`currstep==0`）→ 上传/特殊动作 → 收尾；`currstep!=0` 不打卡，动作照做
- `src/mcloud/tasks/appTaskExtra.ts` —— 入口 / 外链 / 邮箱 / 笔记 / AI / 账单的请求与解析
- `src/mcloud/appTaskRules.ts` —— 纯判据

## 已接上的

| 任务 | 动作 |
|---|---|
| 106 上传文件 | 上传一发 |
| 113 使用 PC 客户端 | PC 渠道上传 |
| 522 上传满 100 | 上传闸，5 发/趟 |
| 409 从固定入口访问云朵中心 | 两发上报 + task2 补打卡 |
| 1005 从固定入口进入云朵中心 | 两发上报 + task2；currstep=1 不重复默认 key |
| 1017 登录移动云盘云朵中心 | 入口页 + task2 |
| 604 去云盘图书馆阅读书籍 | 入口页（button.app.link） |
| 434 分享文件领好礼 | 本趟文件建外链 → 立刻删 |
| 107 创建云笔记 | 笔记鉴权 → 建 → 移进回收站 |
| 472 / 473 体验 139 邮箱 | 邮箱登录 → autologin → 市场打卡 |
| 1004 给好友发邮件 | composeId → compose → 市场打卡 |
| 1014 PDF 转换 | 传最小 PDF → convertPdfFromYunFile |
| 1020 重要邮件存储云盘 | 登录 → 目录 → 找 mid → disk:backupMail |
| 1028 / 1057 AI 工作台 | 邮箱登录 → queryUserToken → 状态 → SSE 对话 |
| 585 / 618 AI 相机 | 邮箱登录 → 派生鉴权 → aiRecognize → SSE 对话 |
| 1029 查看“我的账单” | 账单页 → 找 mid → 标读 → 读信 → 3 发 MQ → 像素 |
| 609 和 AI 助手对话 | 登录 → queryUserToken → 状态 → SSE 对话 |
| 115 / 431 / 435 / 1009 / 1010 / 1013 / 1016 / 447 / 547 | 只点一下 |
| 117 / 437 / 991 / 406 / 385 / 480 / 1022 / 1018 / 603 / 1021 / 120 | 刻意不做 |

## 打卡顺序

照 Rust `should_click()` + 旧 TS `_handleClick()`：

- `currstep == 0`：**先打 `task/click`，再补 `visitlog/journaling`，最后做动作**（106 是打卡后才上传）
- `currstep != 0`：不打卡，但门照样通过、动作照做（上传族尤其）；visitlog 仍补一次
- 打完卡之后不再走 `visit`/`click`，直接上传/特殊动作/收尾

### 106 实机对照（2026-10-20 23:09）

同一小号（159****7542）上直接跑参考 `mcloud app-task --onlyTaskIds=106`：

```text
106：currStep=1 ⇒ clicked:false（参考自己也不打卡）
上传 1 个文件、随即回收
跑完后矩阵仍是 WAIT / currStep=1
```

⇒ 本插件当前的 `currStep!=0 不打卡 + 上传` 与参考一致；106 不翻 FINISH
不是本插件少做了一步，而是该账号上游当前就不入账。

旧版 `mcloud-sign` 同一账号也跑了 `appTask`（只留 106）：

```text
上传文件成功 1
上传文件成功 2
失败 需前往云盘完成 手动上传一个文件
```

⇒ 三份实现（Rust mcloud / 旧 TS / 本插件）在该账号上都是“文件传得上去、任务不入账”。

## 月门

已按 Rust mcloud 的 `month_gate_skips` 接上：

- `market=sign_in_3` 且 `group=month` 且本月备份**确认**为 `false` 且日期 < 20 ⇒ 跳过；
- `task-expansion` 读到 `curMonthBackup` 时落盘到 `mcloud.month.backup`（按月份存，跨月失效）；
- 没读到（`undefined`）不跳 —— 把“不知道”当成“没开”会白跳一次。

## 还没接的

无（Rust mcloud 的 AppTask runner 已全部接上）。

## 安全边界

- 不认识的条目**不点**：task/click 不可回滚，宁可少做，也不制造假完成。
- 434 没有文件就**不发空外链**；1020 取不到 mid 就如实失败。
- 入口页只发 https；#ssoToken# 用当前凭据里的 token 替换。
- 所有特殊动作都走“一次调用一步”的状态机，状态落 SQLite，可恢复。
- 走起来的条目（currstep != 0）不再重复打默认 key。

## 日志

- 每行带账号短名：[137****7004]
- 特殊动作会说明走到哪一步、失败是哪一发。
- 没实现的条目仍会在起趟时报“另有 N 条还没搬”。
