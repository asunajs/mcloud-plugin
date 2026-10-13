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
