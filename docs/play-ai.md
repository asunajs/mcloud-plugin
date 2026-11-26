# 趣玩AI赢好礼（`National_playAI`）

> **状态：读 / 点 / 做（只接「AI 助手」）/ 验 已接进日常（第 ④.7 步），抽奖缺省关。**
> 判据来源：两轮**实拍**，没有参照实现。

## 0. 证据（只有实拍，没有第三方实现）

1. `mcloud-capture/mcloud/capture/app-play-ai-samples.txt` —— 2026-09-25 三轮
   （进页 / 点任务 / 真做一件并抽了三次），原始 HAR 在那边 `har/2026-09-25-playai-*.har`。
2. `mcloud-capture/mcloud/capture/app-playai-2026-11-26-samples.txt` —— 2026-11-26 复核
   （进页 + 一次任务登记），原始 HAR `har/2026-11-26-playai-portal.har`。

⚠ 两轮之间**任务表与主题模块都换过**（`2-260907-*` → `2-261104-*`，任务从 15 件到 15 件但内容不同），
所以代码里**没有任何 `moduleId` 常量**，一律现读。

## 1. 端点

| 用途 | 方法 | 路径 |
| --- | --- | --- |
| 门户页模块（含任务表、次数） | GET | `/ycloud/funai/api/page/getmodule` |
| 主题/限时模块（数组） | GET | `/ycloud/funai/api/timed/getmodule` |
| 本活动奖品记录 | GET | `/ycloud/funai/api/page/prizes` |
| 邀请码 | GET | `/ycloud/funai/api/invite/getcode` |
| **点一件任务（写）** | POST | `/ycloud/funai/api/page/register`，body `{moduleId,taskId}` |
| **抽一次（写）** | POST | `/ycloud/funai/api/page/lottery`，body `{moduleId}` |
| 刮刮乐（写，**未接**） | POST | `/ycloud/funai/api/timed/lottery`，body `{moduleId}` |

头画像：`jwttoken` / `appversion` / `referer`（本页 H5）/ `cache-control: no-cache`；
写口另加 `content-type: application/json;charset=UTF-8` 与 `origin`。

- ⚠ **`showloading` 逐口不同**：`page/getmodule` 与 `page/prizes` 是 `true`，
  `timed/getmodule` 是 `false`（两轮实拍一致）。
- ⚠ **`activityid` 不发**：它是壳层把 `localStorage.marketName` 原样写进请求头的
  （谁最后写过谁就赢），09-25 那轮是 `sign_in_3`、11-26 那轮是 `National_TokenPK`，
  同一批端点两轮都 `code:0` ⇒ 上游不看它。编一个值就是猜。

## 2. 三条判据（改代码前先看）

1. **`taskSign` 只认 `0` 才走 `register`**：`1` = 邀请（分享链路）、`2` = AI 录音转写
   （2026-11-26 才出现，走法**零样本**）⇒ 这两档一律「要手动」，一个字节都不发。
2. **`register` 的回执零信息**（`{"code":0,"msg":"success","result":0}`）：
   点了不等于做完。判据只有**回读 `getmodule` 看那条 `isComplete` 有没有翻位**
   （09-25 实拍：点了 003、也进了工具，8 小时里一直是 `0`；另一件 `aizhushou`
   是用户在 AI 助手里聊完 68 秒后才翻的）。
3. **`moduleId` 随周次变** ⇒ 现读，别写死。认"门户页那个模块"看的是**计数有没有值**
   （`drawTimes !== null`），不是 id 前缀。

次数口径（09-25 同日 11 个时刻闭环）：`todayGetLotteryCount == drawTimes + drawsUsed`
⇒ `drawTimes` **本身已是余额**，别再减 `drawsUsed`。规则成文：每日最多 5 次、
邮箱版与云盘版共用、**相同任务只算 1 次**、当日有效。

## 3. 状态机（`src/mcloud/tasks/playAi.ts`）

```text
list      读两个模块 → 落读数 → 挑**一件**（taskSign=0 + 未完成 + 今天没点过 + 我们会做）
register  POST page/register → 记进 tried（不论成败）
act       复用算力族的动作层（stepAction），一次推一步
verify    再读一次 getmodule → **只有 isComplete 翻位才算做完**
          （没翻位就等 3 秒**再读一次**；两次都没翻才写「已上报，服务端还没认」）
draw      开了代抽且 drawTimes > 0 时抽一发（一趟最多一发）
```

- 一趟最多做 **1 件**（`PLAYAI_TASKS_PER_RUN`），`drain` 上限 **12** 步
  （list 1 + register 1 + 动作链 4 + verify 1 + 再读 1 + verify 1 + draw 1 = 10，留余量）；
- **同一天第二趟会重开一轮**（否则 `phase='done'` 会把这一族当天封死），`tried` 带过来；
- **动作没成也照样回读** —— 那件事可能本来就算完成；失败那句进 `lines`。

### 为什么只接「AI 助手」

`PLAYAI_ACTION_KEYS` 现在登记三件（都是动作层已有的工具）：

| 趣玩AI 任务 | 动作 | 落盘 |
| --- | --- | --- |
| `aizhushou`（AI 助手） | `aiAssistant`（灵犀对话） | **不落盘**（09-25 第三轮实拍零 `hcy/file/create`） |
| `aixiangji`（AI 相机） | `aiCamera`（识图 → 对话） | 会落一张图，**已登记**，链尾清理会删（F-153） |
| `204`（扫描文档） | `aiCamera` | 同上（`innerLink` 也是那台相机） |

挑的**偏好**：不落盘的排前面（`ACTION_RANK`）—— 一趟只做一件，先做 AI 助手能少一份垃圾。

其余任务（智能抠图 / AI头像 / AI快照 / 表情包 / 老图片修复 / 画质修复 / 3D人偶 /
AI漫画风 / 智能消除 / AI知识库 / 云笔记 / 邀请 / AI录音转写）要进各自工具页做图，
形状没抓过，而且会往云盘写东西 —— **不点也不做**，免得把"看起来在干活"写进日志。

## 4. 抽奖

- `page/lottery` 判"中没中"**只看 `isWin`**。四份真样本（09-25 HAR）：
  `20云盘专属AI豆`（`prizeType:2`）、`30云盘专属AI豆`、`0.41元支付宝话费红包`（`prizeType:1`）、
  没中（`prizeId/prizeName/prizeUrl` 全 `null`，而 `prizeType` **还是 1**）
  ⇒ **`prizeType` 不是"有没有奖"的信号**。
- 回执没有 `isWin` 时既不写"中了"也不写"没中"，只写「判不出中没中」。
- 开关 `mcloud.playai.draw` **缺省关**（花的是用户的次数），入口在「数据」页那张卡上；
  按天账 `mcloud.playai.draw.state = {day,drawn,wins}` 只用来报数，**不卡次数**。

## 5. 还没验的（别当成已经成立）

| 缺口 | 怎么补 |
| --- | --- |
| **真实账号上没跑过** `register` → `act` → `verify` | 「调试」页选 趣玩AI + 一个号，点「只跑这个号」；日志会给「做完了 / 已上报服务端还没认 / 上报被拒」三种之一 |
| **灵犀对话算不算「AI 助手」那件任务** | 同上，看 `isComplete` 翻不翻。抓包里那次是用户在 App 内 AI 助手里聊的，不是灵犀 —— 这是**假设** |
| 其余 20 件任务的动作 | 要各自抓一轮（进工具页做图），并且会写云盘，得配套清理 |
| 刮刮乐 `timed/lottery` 的**响应体** | 09-25 那一发超时没导出；下次真中奖时抓一发 |

## 6. 怎么自己验

```bash
# 面板：插件页 →「调试」→ 勾「趣玩AI」→ 选一个号 →「只跑这个号」
# CLI（同一份参数解析）：
mcloud-sign --only playAI --account <账号 id> --force
```

只看这三行就够：`趣玩AI：… 件可做 …`（读数）、`「AI助手」已上报 …`（点）、
`「AI助手」做完了（回读已翻位）` 或 `… 服务端还没认`（判）。
