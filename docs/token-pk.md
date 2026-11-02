# 算力大作战（`National_TokenPK`）

> **状态：已接进日常（第 ④.6 步），默认开、无界面、可整块拆掉。**
> 判据来源按用户 2026-11-01 的口径：**抓包有的以抓包为准，没抓到的照参照实现**。

三份证据（按可信度排）：

1. **实拍**（2026-10-24 / 2026-11-01，iOS App WebView）：
   `mcloud-capture/mcloud/capture/app-tokenpk-playai-samples.txt` §2 / §8；
   原始 HAR 在 `mcloud-capture/har/2026-{10-24,11-01}-tokenpk*.har`（那边 `har/` 不入库）。
2. **页面 JS**（2026-11-01 取的静态面）：
   `https://img.mcloud.139.com/portal/yunClound/public/js/index.0f001dad.js`
   → chunk `National_TokenPK.8b4a93ba.js`。只用来补分支判据；与实拍冲突时以实拍为准。
3. **参照实现**：[`3238614968/caiyun`](https://github.com/3238614968/caiyun)
   `backend/internal/core/tasks/tokenpk.go` + `api/caiyun_tokenpk.go`（计划分类、汇总句、收尾两发）。

## 0. 它是什么

H5 活动页（不是独立 App 页），接口在 `/ycloud/tokenpk/**`，**只带云盘 `jwttoken`** 就能调
（实拍：与签到 H5 同一套鉴权，不需要另换活动站票，也不需要先"开活动页建会话"）。

任务状态机（两轮实拍）：

```text
WAIT ──click──► WAIT(currstep=1) ──原生动作──► SUCCESS(currstep=2) ──receivePrize──► FINISH(currstep=3)
WAIT(RESERVE) ──reserve──► SUCCESS(currstep=1)     ← 预约成功**不是奖品**，之后也不再领
WAIT ──click──► SUCCESS                          ← openUrl 这一类：只认 click，没有原生信号
```

`button.action` **恒为 `jump`**：点「去完成」只是**登记**（`task/step/click`），业务动作在原生页里做；
服务端看的是信号（例：`loginPc` 的 `rule` 写着 `hw_request_pc=10200153`）。

## 1. 端点（实拍）

| 用途 | 方法 · 路径 | 体 | 回执 |
|---|---|---|---|
| 任务表 | `GET /ycloud/tokenpk/task/list` | —（query：`marketName=National_TokenPK&platform=ios&sortState=true`） | `{code:0,result:[…]}` |
| 登记 | `POST /ycloud/tokenpk/task/step/click` | `{marketName,taskId,key,source:"app"}` | `{code:0,msg:"success"}`（**无 `result`**） |
| 预约 | `POST /ycloud/tokenpk/task/step/reserve` | 同上 | `{code:0,result:{allSuccess,task,prizes}}` |
| 领奖 | `POST /ycloud/tokenpk/task/step/receivePrize` | `{marketName,taskId,source:"app"}` | 同上；`prizes[].success/errorMsg` 才是"到没到" |
| 开启智能相册 | `GET /ycloud/tokenpk/task/smartAlbum/open` | — | `{code:0}` |
| 算力进度 | `GET /ycloud/tokenpk/toplist/progress/queryHome` | — | `{usedToken,rewardStages,…}` |
| 领抽奖次数 | `POST /ycloud/tokenpk/toplist/progress/autoReceiveLotteryChance` | **字面 `null`** | `{totalChance,rewardCount}` |
| 抽一次奖 | `POST /ycloud/tokenpk/toplist/progress/lottery` | **字面 `null`** | `{win,prizeId,prizeName,prizeImage,prizeDesc,remainChance}` |
| 剩余次数 | `GET /ycloud/tokenpk/toplist/progress/queryRemainChance` | — | 数字（**只在代抽开启时**读一次：先看清剩几次，别拿上限去撞 0 次机会） |

头画像（实拍，全小写）：`jwttoken`、`activityid: National_TokenPK`、`appversion`、
`showloading`、`referer`；POST 另带 `origin: https://m.mcloud.139.com` 与
`content-type: application/json;charset=UTF-8`。**没有签名头**。
活动页 `sourceid=1016`（实拍；参照实现写 `1073`，与线上不一致 —— 以实拍为准）。

## 2. 计划（`tokenPkRules.planTasks`）

按任务表原序，一条最多一格：

1. `FINISH` ⇒ 跳过；
2. `SUCCESS` + `taskType=RESERVE` ⇒ 跳过（页面在这里直接 return）；
3. `SUCCESS` + 其它 ⇒ **领奖**（到达月上限也可领）；
4. `WAIT` + `monthlyLimit>0 && monthlyCompleted>=monthlyLimit` ⇒ 跳过；
5. `WAIT` + `RESERVE` ⇒ **预约**；
6. `WAIT` + `ext ∈ {backup, uploadPhoto, aiCamera, aiAssistant, createNote, shareFile, openUrl, loginPc, openAlbum}` ⇒ **做**；
7. 其余（`inviteFriend` / `toXhs` / 未知 / 空按钮）⇒ **需手动**，一个字节都不发。

`key` 取 `button.ios.ext`（抓包是 iOS）→ `android` → `other` → `harmony` → 任意。
同一 `id` 出现两次只做第一格。

## 3. 动作矩阵（`tasks/tokenPkActions.ts`）

| ext | 本仓怎么造证据 | 复用件 |
|---|---|---|
| `openUrl` | 只发 click（实拍：点完就 SUCCESS） | — |
| `loginPc` | click → 传一个文件（**PC 档 `10200153`**） | `tasks/upload.ts`（`channel:'pc'`） |
| `uploadPhoto` | click → 传一张真 JPEG | `tasks/upload.ts` + `tokenPkAssets.ts` |
| `backup` | click → 备份档上传 JPEG（`op:'backup'`）→ 快照三枪 | `tasks/upload.ts` + `cloudUpload` |
| `shareFile` | click → 传文本 → 建外链 | + `appTaskExtra.getOutLinkRequest` |
| `createNote` | click → 笔记鉴权 → 建 → 等 2s → 删 | `appTaskExtra.note*` |
| `aiAssistant` | click → 邮箱 SSO → 登录 → `queryUserToken` → 灵犀对话 | `appTaskExtra`（609 同链） |
| `aiCamera` | click → 同上 → `aiRecognize` → 相机对话 | `appTaskExtra`（585 同链） |
| `openAlbum` | click → `smartAlbum/open` | `tokenPk.ts` |
| `reserveLogin` | `reserve`（无动作） | `tokenPk.ts` |

顺序是 **click → 动作**（页面在点按钮那一刻就发 click；参照实现反过来，实拍优先）。
动作做完**不算完**：重新拉 `task/list`，翻成 `SUCCESS` 才领 —— 判据只看服务端。

## 4. 用户看到的那一行

汇总句逐字照参照实现：

```text
领取奖励N项；执行任务N项；抽奖次数+N；代抽D次（中M次）；累计算力X；需手动: a、b；N项步骤失败；N项待服务端确认或跨月完成
```

全空时：`本轮无可执行步骤（已完成、达到月上限或待好友互助）`。
逐行（`DailyStep.lines`）一条任务一行：`领取「成功备份一次文件」→ 移动云盘100万tokens叠加包` /
`已点「了解PC同步盘」……` / `「分享活动给好友」没成 —— …`。

`formatTokenCount`：`>=1e8 → X.X亿`、`>=1e4 → N万`、否则原数。

## 5. 还没实拍到的（照参照实现 / 留待读数）

- **代抽默认关**：`lottery` 会**花掉**用户的次数、结果随机且不可逆，所以只在配置显式写
  `算力大作战.代抽` 时才发（见 §6）。抽中的记录**直接进奖品表**（抓包 §2.1：抽奖不另发记录口），
  会被第 ⑤ 步「待领取奖品」领走；上限按**天**算（第二趟同一天不重置）。
  `win:false` 的回执形状没实拍到（抓包那次是 `win:true`）—— 按同一形状收（次数照扣、`prizeName` 空）。
  代抽前会读一次 `queryRemainChance`（见 §1 表最后一行的说明）。
- `receivePrize` 的失败形态（"已领取"/"活动太火爆"这类 `code/msg`）—— 目前按非 0 = 失败如实报；
- `openAlbum` 的回执细节（只按 `code=0` 判）；
- `aiCamera`/`aiAssistant` 的动作是否能被活动站认成信号（造的是同一族真实信号，第一次真跑读数是判据）；
- 上传链的图片 `Content-Type`：2026-11-02 真跑第一次就撞了 —— `.jpg` 的 PUT 回 **403**
  （同一次 `.bin` 的 PUT 是 200），因为预签名按 create 声明的类型签。现在 `.jpg/.jpeg/.png`
  在 create 与 PUT 都发 `image/jpeg` / `image/png`（见 `docs/upload-chain.md` §四）；
- cookie `jwtToken`：实拍里**头和 cookie 都在**（cookie 是页面 JS 从 URL 的 `token=` 写进去的）。
  本仓只发 `jwttoken` 头、cookie 沿用 H5 会话那一份 —— 真跑若回 401，先看这一格。

## 6. 开关与拆卸

- 开关：state 键 `mcloud.tokenpk.enabled`（**没写过 = 开**）；standalone 配置可用
  `算力大作战: {开启: false}`（账号级）或 `common.算力大作战.开启`。**没有界面**。
- 代抽：state 键 `mcloud.tokenpk.draw`（**没写过 = 不抽**）+ `mcloud.tokenpk.draw.state`（按天账）。
  standalone 配置：

  ```json
  { "算力大作战": { "开启": true, "代抽": { "开启": true, "每日上限": 3 } } }
  ```

  `代抽: true` = 开 + 默认上限 10；`每日上限: 0` = 不抽；`代抽: false`/形状不对 = 当没写。
- 拆卸：删 `tokenPk.ts` / `tokenPkRules.ts` / `tokenPkState.ts` / `tokenPkAssets.ts` /
  `tasks/tokenPk.ts` / `tasks/tokenPkActions.ts`、4 个测试、本文件；
  再删 `dailyRun.ts` 的 ④.6 段与 2 个 import、`groups.ts` 一行、`store/keys.ts` 三条、
  `standalone/{config,runtime}.ts` 各两三行、mock/e2e 那几段。除此之外没有耦合。

## 7. 测试钉在哪

- `test/tokenPkRules.test.ts`：分类（SUCCESS/FINISH/RESERVE/月上限/inviteFriend）、平台优先序、汇总句、`tasksFrom`；
- `test/tokenPk.test.ts`：整趟（click 先于动作、复查后才领、`openUrl` 只认 click、RESERVE 不领）、
  一条失败不拖垮整趟、关掉开关零请求；
- `test/dailyTokenPk.test.ts`：日常顺序（红包之后、领取类之前）与开关；
- `mock/upstream.mjs` + `scripts/e2e-mock.sh`：任务表/click/reserve/领奖/收尾两发 + mock 侧状态真的变了。
