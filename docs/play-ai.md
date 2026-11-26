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

⚠ 同一件任务会**同时出现在页面模块和主题模块**里（实拍：`004` 两处都有）。规则成文是
「相同任务只能获得 1 次」⇒ 挑任务时**按 taskId 去重**：任一模块里已完成、或今天在任一模块里
点过，就整件跳过。不这么做的话，换个 `moduleId` 再点一次是白发一发，回读不翻位还会给出
一个莫名其妙的 pending。

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
list      读两个模块 → 落读数 → **活动还在吗**（endTime / flag）→ 挑**一件**
          （taskSign=0 + 未完成 + 今天没点过 + 我们会做）
register  POST page/register → 记进 tried（不论成败）
act       复用算力族的动作层（stepAction），一次推一步
verify    再读一次 getmodule → **只有 isComplete 翻位才算做完**
          （动作**成了**且没翻位 ⇒ 等 3 秒**再读一次**；动作没成不等；
            两次都没翻才写「已上报，服务端还没认」）
draw      开了代抽且 drawTimes > 0 时抽一发（一趟最多一发）
```

- **活动结束就停**：`endTime` 过了或 `flag=0` ⇒ 不再点、不再抽，只留一句「已结束」。
  判据只用本来就读到的模块（**不多发请求**）；`endTime` 解析不出来时**当它还在** ——
  宁可多跑一趟，也不因为解析失败把好端端的活动停掉。
- 一趟最多做 **1 件**（`PLAYAI_TASKS_PER_RUN`），`drain` 上限 **16** 步
  （最长那条：list 1 + register 1 + 相机链 5 + verify 1 + 再读 1 + verify 1 + draw 1 = 11，
  余下是重试的余量 —— 撞上限时 `drain` 报的是"假失败"）；
- **同一天第二趟会重开一轮**（否则 `phase='done'` 会把这一族当天封死），`tried` 带过来；
- **动作没成也照样回读** —— 那件事可能本来就算完成；失败那句进 `lines`。

### 会做的五件，以及其余 19 件为什么不做

`PLAYAI_ACTION_KEYS` 现在登记五件（**全部复用动作层已有的动作**）：

| 趣玩AI 任务 | 动作 | 落盘 | 怎么找到的 |
| --- | --- | --- | --- |
| `aizhushou`（AI 助手） | `aiAssistant`（灵犀对话） | **不落盘**（09-25 第三轮实拍零 `hcy/file/create`） | `innerLink` 是 `aiAssistantGlobal` |
| `aixiangji`（AI 相机） | `aiCamera`（识图 → 对话） | 会落一张图，**已登记**，链尾清理会删（F-153） | `innerLink` 是 `main/aiCamera` |
| `204`（扫描文档） | `aiCamera` | 同上 | 同上（`target=document`） |
| `ailuyinzhuanxie`（AI 录音转写） | **独立完成口** `timed/transcriptioncompleted` | 不落盘 | 抓包 §7.8：`taskSign=2` 不走 `register` |
| `yunbiji`（AI 云笔记） | `createNote`（笔记鉴权 → 建 → 回读） | 建一条笔记 | `innerLink` 是 `featureServices?linkUrl=0|2040`；动作层早就有（算力族 107 号） |

挑的**偏好**：不落盘的排前面（`ACTION_RANK`）。

#### 其余 19 件：**H5 工具那一族做不了，这不是"还没抓包"**

按 `innerLink` 分两类，两类都卡死在同一个地方：

**① 9 件是 `yun.139.com/aiTools/#/xxx?token=#ssoToken#` 的 H5 工具**
（智能抠图 / AI头像 / AI快照 / 表情包 / 老图片修复 / 画质修复 / 智能消除 / AI漫画风 / 3D人偶）

2026-11-27 把 `aiTools` 的前端 bundle 拆开看过，**接口全在手里**：

```
POST https://ai.yun.139.com/aitools/applet/content/createUploadTask   body {imageBase64List, module}
POST https://ai.yun.139.com/aitools/applet/task/getLastTaskRecordStatus
加密：AES-CBC/Pkcs7，key = appKey，iv = appKey 末 16 位 → base64（`pu()` 逐字）
appKey：按 module 编号硬编在 bundle 里（module 10/13/4/5/9/12 六组 `outerAppKey`）
```

**但登录链过不去**：这些接口要 `Authorization: <aiTools 自己的 token>`，
而那个 token 要先 `auth-rebuild/permission/v1.0/login`（`mcloud-client: 10805` + `mcloud-skey`
+ 短信验证码）。拿我们的 `jwttoken` 去换，上游回 **`05050009 非法的token！`**（实测）。

**更要紧的一条**：`aiTools` 的 bundle 里**一处 funai 的引用都没有**（`grep funai|playAI`
零命中）⇒ 两边不互通，`isComplete` 是**服务端自己核对的**（用户真在工具里做完，服务端从
工具那边拿记录）。所以"调一次接口就算完成"这条路**不存在**——要接这 9 件，
等于把 9 个图片工具本身复刻一遍（传图、选模板、轮询生成、取结果）。**那是另一个产品**。

**② 剩下 10 件**（AI知识库 / AI写真 / 邀请 / 其余）
`zhishiku`（AI知识库）试过：`innerLink` 与 AI 助手同一个原生页（只是 tab 不同），
复用 `aiAssistant` 后**点了、也聊了，回读 `isComplete` 两次都没翻** ⇒ 它要的是知识库里
真建了东西。`invite`（邀请）要真邀一位好友登录。其余同理：**都要求工具内的具体动作**。

⚠ 这一段的结论是**实测的**（2026-11-26/27，三个真号）：不是"形状没抓过"，
是**这些任务的完成判据落在工具内部**，插件够不着。别再把它们当成"再抓一轮包就能做"。

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

## 5.5 真跑之后怎么判读（三种结局，各代表什么）

日志里出现哪一句，就决定了下一步该做什么：

| 日志那一句 | 含义 | 下一步 |
| --- | --- | --- |
| `「AI助手」做完了（回读已翻位）` | **成了**：服务端认这一句，`todayGetLotteryCount` 应该 +1 | 可以接抽奖；再考虑接别的工具 |
| `「AI助手」已上报，服务端还没认 —— …` | 点了、也聊了，但 `isComplete` 两次回读都没翻 | **说明灵犀对话不算那件任务**（抓包里那次是 App 内 AI 助手）⇒ 要换动作，先抓一轮"在 App 内做那件任务"的包 |
| `做「AI助手」那一步没成：…` | 动作链断在某一段（换票 / 邮箱登录 / 拿鉴权 / 对话） | 看冒号后面那一段：`querySpecTokenV2 失败` = 邮箱那条链的入口；`queryUserToken` 之后失败 = 鉴权派生 |

⚠ 三种都不是"失败"，只有第三种才是**我们这边**没做成。第二种是**上游不认**，
是最有价值的信息 —— 它把"灵犀 = AI 助手"这个假设直接否掉。

## 6. 怎么自己验

```bash
# 面板：插件页 →「调试」→ 勾「趣玩AI」→ 选一个号 →「只跑这个号」
# CLI（同一份参数解析）：
mcloud-sign --only playAI --account <账号 id> --force
```

只看这三行就够：`趣玩AI：… 件可做 …`（读数）、`「AI助手」已上报 …`（点）、
`「AI助手」做完了（回读已翻位）` 或 `… 服务端还没认`（判）。
