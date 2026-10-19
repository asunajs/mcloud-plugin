# App 任务：mcloud 与本插件对照

对照的是 mcloud 的实现：

- crates/mcloud-tasks/src/app_task.rs —— 判形状、上传、分享、入口、月门
- crates/mcloud-tasks/src/app_task/runners.rs —— 107 / 472 / 473 / 1004 / 1014 / 1020 / 1028 / 585 / 609
- crates/mcloud-upstream/src/app_task_entry.rs —— 409 / 1005 的两发上报
- crates/mcloud-upstream/src/app_cloud_outlink.rs —— 434 的建外链 / 删外链
- crates/mcloud-upstream/src/mail139.rs —— 邮箱登录、邮件转存、queryUserToken
- crates/mcloud-upstream/src/ai_cloud.rs —— 状态查询、SSE 对话

本插件对应的是：

- src/mcloud/tasks/appTaskMatrix.ts —— 只读：拉矩阵（V3，两个市场）
- src/mcloud/tasks/appTask.ts —— 写：上传 → 访问日志 → 打卡 → 特殊动作 → 收尾
- src/mcloud/tasks/appTaskExtra.ts —— 入口 / 入口页 / 外链 / 邮箱 / AI 的请求与解析
- src/mcloud/appTaskRules.ts —— 纯判据：哪条走哪一步

## 已接上的（按 mcloud 的成功口径）

| 任务 | 动作 | 插件 |
|---|---|---|
| 106 上传文件 | 上传一发 | ✅ |
| 113 使用 PC 客户端 | PC 渠道上传 | ✅ |
| 522 上传满 100 | 上传闸，5 发/趟 | ✅ |
| 409 从固定入口访问云朵中心 | 两发上报 + task2 补打卡 | ✅ |
| 1005 从固定入口进入云朵中心 | 两发上报 + task2 补打卡 | ✅ |
| 1017 登录移动云盘云朵中心 | 入口页 + task2 补打卡 | ✅ |
| 604 去云盘图书馆阅读书籍 | 入口页（button.app.link） | ✅ |
| 434 分享文件领好礼 | 本趟文件建外链 → 立刻删 | ✅ |
| 1020 重要邮件存储云盘 | 邮箱登录 → 目录 → 找 mid → 转存 | ✅ |
| 609 和 AI 助手对话 | 邮箱登录 → queryUserToken → 状态 → SSE 对话 | ✅ |
| 115 / 431 / 435 / 1009 / 1010 / 1013 / 1016 / 447 / 547 | 只点一下 | ✅ |
| 117 / 437 / 991 / 406 / 385 / 480 / 1022 / 1018 / 603 / 1021 / 120 | 刻意不做 | ✅ 跳过 |

## 还没接的

| 任务 | 原因 |
|---|---|
| 107 创建云笔记 | 需要笔记鉴权；mcloud 实测上游已不再给 headers.app_auth，照抄也做不成 |
| 472 / 473 体验 139 邮箱 | mcloud 实测 market taskClickV2 整体 404；且这两条已不在今天的任务表里 |
| 1004 给好友发邮件 | mcloud 自己也标“未实现”（参考侧有 runner，但未验收） |
| 1014 PDF 转换 | 同上 |
| 1028 AI 工作台 | mcloud 有实现，但今天两张真机任务表里没有 1028（同能力叫 1057，参考侧也没 runner） |
| 585 AI 相机 | mcloud 有实现，但今天叫 618，mcloud 自己标“未实现” |
| 618 / 1057 | mcloud 未验收；不照抄 |
| 1029 查看“我的账单” | mcloud 还在试，未做成 |
| 月门 | mcloud 的 sign_in_3/month + 本月备份未开 + 日期 < 20 跳过；插件还没读 curMonthBackup |

## 安全边界

- 不认识的条目**不点**：task/click 不可回滚，宁可少做，也不制造假完成。
- 434 没有文件就**不发空外链**；1020 取不到 mid 就如实失败。
- 入口页只发 https；#ssoToken# 用当前凭据里的 token 替换。
- 所有特殊动作都走“一次调用一步”的状态机，状态落 SQLite，可恢复。

## 日志

- 每行带账号短名：[137****7004]
- 409/1005/1017/434/1020/609 都会在日志里说明走到哪一步、失败是哪一发。
- 没实现的条目仍会在起趟时报“另有 N 条还没搬”。
