# App 任务：mcloud-sign 与本插件对照

对照的是 mcloud-sign 的 App 任务实现：

- packages/core/src/tasks/app/index.ts —— 拉列表、去重、分发、按组打印结果
- packages/core/src/tasks/app/tasks.ts —— dispatchTask / SKIP_TASK_LIST
- packages/core/src/tasks/app/runners.ts —— 逐条任务的 runner

本插件对应的是：

- src/mcloud/tasks/appTaskMatrix.ts —— 只读：拉矩阵（V3，两个市场）
- src/mcloud/tasks/appTask.ts —— 写：上传 → 访问日志 → 打卡 → 收尾
- src/mcloud/appTaskRules.ts —— 纯判据：哪条走哪一步

## 结论

没有对齐。插件只搬了「上传族 + 少量点击」；mcloud-sign 有 runner 的那些具体功能，
大部分还没搬。插件目前对不认识的条目不动手（这是有意的：task/click 不可回滚），
所以不会点坏，但那些任务也不会被完成。

## 逐条对照

| 任务 | mcloud-sign | 本插件 | 说明 |
|---|---|---|---|
| 106 上传文件 | 有 uploadRandomFile | 已实现 | 上传一发 |
| 107 创建云笔记 | 建/删笔记 | 未实现 | 需要笔记鉴权 |
| 113 使用 PC 客户端 | PC 渠道上传 | 已实现 | 上传一发，渠道不同 |
| 409 云朵中心入口 | 入口 + click | 未实现 | 插件没有入口动作 |
| 434 分享文件 | 建外链 / 删外链 / 多日进度 | 未实现 | 只有常量，没有 runner |
| 472 / 473 体验 139 邮箱 | 邮箱会话 + PE 活跃 + click | 未实现 | 没有邮箱链路 |
| 522 上传满 100 | 每次 5 发 | 已实现 | 上传闸，5 发/趟 |
| 585 AI 相机 | completeAiCameraTask | 未实现 | 没搬 |
| 1004 给好友发邮件 | 写邮件 + PE 事件 | 未实现 | 没搬 |
| 1005 云朵中心入口（新） | 入口 + click | 未实现 | 没搬 |
| 1014 PDF 转换 | 传 PDF + 转换 | 未实现 | 没搬 |
| 1020 邮箱资产备份 | 邮箱备份接口 | 未实现 | 没搬 |
| 1028 AI 工作台 | 鉴权 + SSE 对话 + 状态确认 | 未实现 | 没搬 |
| 115 / 431 / 435 / 1009 / 1010 / 1013 / 1016 / 447 / 547 | 默认 click | 已实现（显式 click-only） | 只点一下 |
| 1017 / 604 | 默认 click | 半成品 | 只声明了「入口页」，动作层没有 portal phase；已先按「没实现」处理，避免跳过入口直接点 |
| 117 / 437 / 991 / 406 / 385 / 480 / 1022 / 1018 / 603 / 1021 / 120 | SKIP_TASK_LIST | 同样跳过 | 刻意不做 |

## 还缺的判据

除了 runner，mcloud-sign 还有几条判据没搬：

1. 月度备份闸：sign_in_3 / month 的任务，在「本月备份未开启且日期 < 20」时跳过。
   插件只有 MONTH_GATE_MARKET / MONTH_GATE_GROUP 两个常量，没有消费者。
2. 分享任务 434 的多日进度：x/7 的进度、只打印进度不重复点。
3. 按组打印结果：success / failed / incomplete / completed 四桶。
   插件现在靠矩阵读数 + UI，没有把同样的分组结论写进日志。
4. 默认 click：mcloud-sign 对不在 skip 名单里的条目会点一下；插件故意不点
   不认识的条目（见 stepFor 的注释），所以覆盖更少，但不会制造假完成。

## 日志口径

- 没有实现的功能不许说成「没有能替你做的了」：
  startAppTask 现在会报「另有 N 条还没搬（当前要在 App 里手动做）」。
- SKIP_TASK_LIST 里的条目不算「没搬」—— 它们是刻意不做。
- 要补功能时，先补 runners 对应的 API 链路，再改 stepFor；
  不要用「默认 click」把没实现的任务点成假完成。
