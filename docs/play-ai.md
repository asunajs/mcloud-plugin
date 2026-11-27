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

1. **`taskSign` 决定走哪一口**（**已全部实测**，2026-11-27）：
   - `0` → `page/register`（点一件，然后要靠动作链做完）；
   - `1` → 邀请（分享链路，**不发上报**，要真人邀好友）；
   - `2` → `timed/transcriptioncompleted`（**独立完成口**，一发就完，见下）。
   ⇒ 只有 `1` 仍是「要手动」。⚠ 这条以前写的是"`2` 走法零样本 ⇒ 要手动" ——
   2026-11-26 在真号上跑通了，那半句已作废。
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

### 会做的十三件（2026-11-27 加了八件 aiTools 任务 —— **9 件 H5 工具全接上**）

`PLAYAI_ACTION_KEYS` 现在登记**十三件**：

| 趣玩AI 任务 | 动作 | 落盘 | 怎么找到的 |
| --- | --- | --- | --- |
| `aizhushou`（AI 助手） | `aiAssistant`（灵犀对话） | **不落盘**（09-25 第三轮实拍零 `hcy/file/create`） | `innerLink` 是 `aiAssistantGlobal` |
| `aixiangji`（AI 相机） | `aiCamera`（识图 → 对话） | 会落一张图，**已登记**，链尾清理会删（F-153） | `innerLink` 是 `main/aiCamera` |
| `204`（扫描文档） | `aiCamera` | 同上 | 同上（`target=document`） |
| `ailuyinzhuanxie`（AI 录音转写） | **独立完成口** `timed/transcriptioncompleted` | 不落盘 | 抓包 §7.8：`taskSign=2` 不走 `register` |
| `yunbiji`（AI 云笔记） | `createNote`（笔记鉴权 → 建 → 回读） | 建一条笔记 | `innerLink` 是 `featureServices?linkUrl=0|2040`；动作层早就有（算力族 107 号） |
| **`003`（智能抠图）** | **`aiToolsMatting`** → `/api/image/edit/portraitMatting` | 不落用户云盘 | 与头像同一套 body，只换路径与 `context.source` |
| **`008`（老图片修复）** | **`aiToolsRestore`** → `/api/image/edit/restore` | 同上 | ⚠ **`supplierType` 必须是 8**（填 4 回「该功能尚未开发」） |
| **`009`（画质修复）** | **`aiToolsQuality`** → `/api/image/edit/qualityRestore` | 同上 | 同上（`supplierType: 8`） |
| **`034`（AI快照）** | **`aiToolsSnapshot`** → `/api/image/faceswap` | 同上 | ⚠ **另一种 body**：`personList`（放一张脸）+ `extJson.templateImg`（固定模板图），不是那 7 个字段 |
| **`3Drenou`（3D人偶）** | **`aiToolsDoll`** → `/api/image/edit/faceAnime` | 同上 | ⚠ 与 AI漫画风**共用**同一路径，靠 `supplierType:"7"`（**字符串**）+ `style:"plastic_bubble_figure"`（风格**名**）+ `addWatermark:true` 区分 |
| **`006`（智能消除）** | **`aiToolsEraser`** → `/api/image/edit/erasure` | 同上 | ⚠ 要一张 `maskBase64`（涂抹蒙版）。插件没有触屏，内置一张**同尺寸固定蒙版**（中间一块方形）⇒ 效果是"去掉中间那块"，不是用户手涂的那块 |
| **`031`（AI表情包）** | **`aiToolsEmoji`** → `/api/image/emo` | 同上 | ⚠ **第三种 body**：`templateUrl` 要用模板的 **`templateSamp`**（`.mov`），模板从广告位 `66344` 拉 |
| **`007`（AI 头像）** | **`aiToolsAvatar`**：直接调 `ai.yun.139.com/api/image/avatar/cartoon` 把图生成出来 | **不落用户云盘**（结果落在算法侧的签名 URL，24h 有效） | 2026-11-27 抓包 + 静态提取，见下节 |

挑的**偏好**：不落盘的排前面（`ACTION_RANK`）。`aiToolsAvatar` 默认排最后 ——
它**消耗算法额度**（`estimateTokenUsage` 7136），先把不耗额度的做完。

#### AI 头像（`007`）走的是**另一套**：aiTools，不是动作链

前面五件都是"模拟用户在工具里做一件事"；`007` 不是 —— 它是**直接把图生成出来**，
生成成功服务端就认。链路（2026-11-27 真跑通过，`191****16` 那号）：

```text
① POST ai.yun.139.com/api/image/avatar/cartoon   body 七个字段（缺一个就「参数错误」）
                                        → data.taskId
② POST /api/outer/async/task/result  {"taskId"}  → data.status 1 → 2 → **3 = 完成**
③ 回读 funai 的 page/getmodule                  → 007.isComplete 变 1
```

- **鉴权用 `auth`**（`Authorization: Basic …`），由传输层按 `AUTH_DOMAINS` 自动注入 ——
  见 `docs/auth-families.md` §5。不是 `jwttoken`、也不是 `ssoToken`；
- **图片默认用内置那张**（`src/mcloud/aiToolsPhoto.ts`，748×748 JPEG q85）：
  这类算法要**一张人脸照**，而插件没有相册读取权（面板运行时只有 `fs.existsSync`）；
- **`supplierType` 是唯一真正要紧的字段**（2026-11-27 实测）：同一个 `restore` 路径，
  填 `4` 回「该功能尚未开发」、填 `8` 就正常出 taskId ——
  **填错的表现像"上游没做"**，最容易误判；
- `imageExt` 与 base64 前缀**实测不影响成败**（`png`/`jpeg`、带不带 `data:image/jpeg;base64,`
  都能出 taskId）⇒ 代码里统一 `png` + 裸 base64，不给每件配这两格。
- **`034` AI快照是不同的形态**：它调的是 `/api/image/faceswap`（**换脸**），
  body 是 `personList: [{sendType, channelId, imageExt, base64}]` + `extJson: "{\"templateImg\":\"<素材 URL>\"}"`
  + `style: 1009` + `supplierType: 0` + `poseIdList: [0]`。
  模板是一张**固定素材图**（`material_media/20250116/…png`），抓包里只见过这一个。
  ⚠ 换脸必须有一张**能检出人脸**的图，所以内置默认那张（人脸照）正好；纯色图会被拒
  （`face/analysis` 会回 `existFace: false`）。

#### 做不了的（**现在 9 件全接上了**，下面这张表只剩 `004` 上游那一条）

| taskId | 工具 | 为什么 |
| --- | --- | --- |
| `004` | AI漫画风 | 参数对了仍回 `10022001 该功能尚未开发`（另一次提交成功但算法侧 status=4）⇒ **上游没做** |




⚠ 还有一个**队列上限**：连发到第 4 个会回 `10000112 您当前还有任务正在处理中`。
实现里没做并发，一趟串行做，所以正常路径碰不到；但**手动连着试**会撞上。

⚠ **蒙版不是关键，`supplierType` 才是**：智能消除这一族要 **8**。
用 4 的时候一直回「Mask图不能为空」，看着像"缺参数"，其实是供应商填错了 ——
2026-11-27 从 `_buildEliminateParams()` 里才看出来。
蒙版本身的**内容不敏感**（全黑 / 全白 / 白框 / 带 alpha 的 RGBA 全都 `status=3`），
但**尺寸必须和照片一致**。

⚠ **3D 人偶算得慢**：实测要 **9 次以上轮询**（30 秒开外），其余几件 1–2 次就好。
`AI_MAX_POLLS` 按最慢的给到 12（≈36 秒）；再慢就交给回读 —— 打满不算"没成"。

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

## 5. 已经验过的（2026-11-26/27，三个真号）

这一节以前叫「还没验的」，四条缺口里**三条已经有答案**：

| 曾经的缺口 | 现在的答案 |
|---|---|
| 真实账号上没跑过 `register → act → verify` | ✅ **跑通了**。三个号都做过（`「AI录音转写」做完了（回读已翻位）` 等） |
| **灵犀对话算不算「AI 助手」那件任务** | ✅ **算**。`aizhushou` 用灵犀对话做完，回读翻位（`15****42` 那一趟） |
| 其余 20 件任务的动作 | ❌ **不是"还没抓包"** —— 是**做不了**，见 §3「会做的五件」那一节（9 件 H5 工具要 aiTools 登录态，实测 `05050009 非法的token！`；其余要工具内的具体动作） |
| 刮刮乐 `timed/lottery` 的**响应体** | ⏳ **仍未验**（没有真中奖样本，不编） |

### 顺带验出来的两条（都是真号现场）

- **一趟可以做多件**：`PLAYAI_TASKS_PER_RUN = 3`，`15****42` 一趟连做 3 件全翻位；
- **一件没翻位不代表别的做不成**：原来 `pending` 直接收工，害得后面本来做得成的
  「AI云笔记」「AI录音转写」一起没做 —— 现在接着挑下一件。

### 只剩这一条真缺口

| 缺口 | 怎么补 |
|---|---|
| 刮刮乐 `timed/lottery` 的响应体 | 要等真中一次（花的是主题的每期一次机会），中了再抓一发 |

## 5.5 真跑之后怎么判读（三种结局，各代表什么）

日志里出现哪一句，就决定了下一步该做什么：

| 日志那一句 | 含义 | 下一步 |
| --- | --- | --- |
| `「X」做完了（回读已翻位）` | **成了**：服务端认这一句 | 可以接抽奖；再考虑接别的工具 |
| `「X」已上报，服务端还没认 —— …` | 点了、动作也做了，但 `isComplete` 两次回读都没翻 | 那件事**要在工具里真做完才算**（不是点了就行）；换动作前先抓一轮"在工具里真做一次"的包 |
| `做「X」那一步没成：…` | 动作链断在某一段（换票 / 邮箱登录 / 拿鉴权 / 对话） | 看冒号后面那一段：`querySpecTokenV2 失败` = 邮箱那条链的入口；`queryUserToken` 之后失败 = 鉴权派生 |
| `这个号还没参加许愿活动`（许愿码那一族） | 上游说「心愿记录不存在，请先许愿」 | **不是失败**：去 App 里许一次愿 |

⚠ 只有第三种是**我们这边**没做成。第二种是**上游不认**（`AI知识库` 试过：聊了但不翻位，
说明它要的是知识库里真建了东西）—— 那是最有价值的信息，别当成"再试一次就好"。

## 6. 怎么自己验

```bash
# 面板：插件页 →「调试」→ 勾「趣玩AI」→ 选一个号 →「只跑这个号」
# CLI（同一份参数解析）：
mcloud-sign --only playAI --account <账号 id> --force
```

只看这三行就够：`趣玩AI：… 件可做 …`（读数）、`「AI助手」已上报 …`（点）、
`「AI助手」做完了（回读已翻位）` 或 `… 服务端还没认`（判）。
