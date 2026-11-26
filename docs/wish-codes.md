# 全网许愿赢好礼（`National_MakeWish`）

> 一句话：**插件只做"能自动推进"的那几条**（上游自己用 `autoAdvanceable` / `clickAdvance`
> 标出来的），其余要用户在 App 里做。豆换码花的是用户的 AI豆，**默认关**。

实现：`src/mcloud/tasks/wishCodes.ts`（写）· `src/mcloud/tasks/cloudActs.ts`（读，5 个只读端点里含许愿主页与奖品列表）

---

## 0. 证据来源（2026-11-27 真号实测）

| 结论 | 怎么验的 |
|---|---|
| `task/list` 是 **GET**、且**必须**带 `platform/appVersion/channel` | 少了三个参数回 **404**（不是 401，很容易误判成"接口不存在"） |
| `auto-advance` 能把 `autoAdvanceable` 的推成 `FINISH` | 真号：抽奖码 **8 → 9 张**，`TASK_DAILY_CHECKIN` 从 2 变 3 |
| `page/click` 能推 `clickAdvance` 的 | 真号：`CLOUD_SIGN_IN` 当场 `FINISH`、码 +1；`PC_UPLOAD` 同样 |
| 豆换码真扣豆 | 余额 `10843 → 10543`、已换 `0 → 1`、剩余 `9 → 8`、码 `11 → 12` |
| `luckybag` 全族已下线 | `task/list` / `bag/list` / `isNewUser` / `blindbox` 逐个试过，全 404 |

---

## 1. 端点

全部在 `https://m.mcloud.139.com`（与签到族同一台主机、同一张 `jwttoken`）。

```text
GET  /ycloud/makewish/page/home                    活动配置 + 我的许愿 + 抽奖码清单 + 加码礼
GET  /ycloud/makewish/prize/list                   奖品列表（21 项）
GET  /ycloud/makewish/task/list?platform&appVersion&channel   任务表（13 条）
POST /ycloud/makewish/task/auto-advance            推 autoAdvanceable 的那几条（写）
POST /ycloud/makewish/task/page/click              点 clickAdvance 的那一条（写）
GET  /ycloud/makewish/task/cloud-exchange/info     豆换码余额与剩余次数（只读）
POST /ycloud/makewish/task/cloud-exchange          用 AI豆换一张码（写、花豆）
GET  /ycloud/makewish/rafflecode/history           码的领取历史
GET  /ycloud/makewish/prize/mine                   我中过的奖
POST /ycloud/makewish/share/generate               分享码
GET  /ycloud/makewish/drawing/history              开奖记录
```

### 那三个 query 参数不能省

```js
// 页面 JS 原样
getTaskList({ platform, appVersion, channel })
// platform: 'ios' | 'android' | 'harmony'（按 UA 判，我们固定 android）
// channel:  'app' | 'out'
```

⚠ 少了它们 `task/list` 回 **404**（nginx 那种 HTML），`auto-advance` / `page/click` 同理。
**这类 404 要怀疑参数不全，别急着说接口不存在** —— 我第一版就误判了。

---

## 2. 任务表：上游自己标了"能不能替你做"

`task/list` 的 `result.tasks[]` 每条带：

| 字段 | 意思 |
|---|---|
| `taskState` | `WAIT` / `FINISH` |
| `autoAdvanceable` | **能自动推进**（走 `auto-advance`，一次推完） |
| `clickAdvance` | **点一下就行**（走 `page/click`） |
| `button.action` | 按钮动作词；`popAdvanceJump` 那条**不能**走 `page/click`（页面 JS 明确排除） |
| `viewAvailability` | `AVAILABLE` / `DISABLED` —— 后者说明这号**没许愿**，任务全锁着 |

13 条任务，按能不能自动分：

| 类别 | 任务 | 插件做不做 |
|---|---|---|
| `autoAdvanceable` | `DAILY_CHECKIN`（每日打卡） | ✅ 做 |
| `clickAdvance` | `CLOUD_SIGN_IN`（云朵签到）、`PC_UPLOAD`（PC上传） | ✅ 做 |
| 已完成 | `ENABLE_NOTIFICATION_V2` / `BACKUP_FILE_V2` / `UPLOAD_20` / `AI_LINGXI` / `CREATE_NOTE` | 已 `FINISH` |
| 要进工具 | `AI_ERASE` / `AI_AVATAR` / `AI_SNAPSHOT` | ❌ 见 §5 |
| 要真人 | `SHARE_ACTIVITY`（邀好友）、`CLOUD_EXCHANGE` | 分享不做；豆换码**默认关** |

---

## 3. 豆换码：缺省关（花的是用户的豆）

```text
GET  /ycloud/makewish/task/cloud-exchange/info
→ {"cost":300,"exchangedCount":0,"maxTimes":9,"remaining":9,"balance":10843,"canExchange":true}

POST /ycloud/makewish/task/cloud-exchange   body: {platform,appVersion,channel}
```

- 开关：`mcloud.wish.exchange`（账号层），**没写过 = 关**；
- 关着时**一发请求都不发**（连余额都不读）；
- 开了也只换**一张**（不循环换到没豆 —— 那会把用户的豆一次花光）；
- 三道边界都如实说：次数用完 / 豆不够 / 上游拒绝。

---

## 4. 状态与界面

- 快照：`mcloud.wish.reading` = `{at, ok, line}`（每趟跑完落一份）；
- `/readings` 的 `wish` 字段给界面：`{at, ok, line, exchangeEnabled}`；
- 数据页那张卡**只显示上次跑到的**，进页面不发请求（与趣玩AI 同一口径）；
- ⚠ 「还没领过」与「上次没领成」必须分开：`at === ''` 时说前者。

---

## 5. 做不了的那几条（**别当成"再抓一轮包就能做"**）

### ① 三条要进 AI 工具的（`AI_ERASE` / `AI_AVATAR` / `AI_SNAPSHOT`）

它们的 `button.link` 是 `https://yun.139.com/aiTools/#/xxx?token=#ssoToken#` —— 与趣玩AI
那 9 件**是同一批 H5 工具**。2026-11-27 把那个 bundle 拆开看过，接口全在手里
（`createUploadTask` / `getLastTaskRecordStatus` / AES 加密 / 各 module 的 `appKey`），
**但登录链过不去**：要 `auth-rebuild/permission/v1.0/login`（`mcloud-client: 10805` +
`mcloud-skey` + 短信验证码）。拿我们的 `jwttoken` 去换，回 **`05050009 非法的token！`**。

详细判据见 [`play-ai.md`](play-ai.md)「会做的五件」那一节 —— 结论一样：
**要接它们等于把图片工具本身复刻一遍**。

### ② `SHARE_ACTIVITY`

规则原文：「好友本月内打开分享的活动链接完成登录，则获得1张抽奖码」—— 要真邀一位好友。

### ③ 没许愿的号

`viewAvailability: DISABLED`，两条 `page/click` 都回「**心愿记录不存在，请先许愿**」。
⚠ 这**不是失败**，是用户还没参加活动 —— 插件如实说那句，不标红（标红会让人以为坏了）。

---

## 6. 怎么自己验

```bash
# 只跑许愿码那一族（一个号）
MCLOUD_DATA_DIR=~/panel-3030/data/plugin-data/mcloud \
  node dist/standalone/mcloud-sign.mjs \
  --config ~/panel-3030/data/plugin-data/mcloud/config.json \
  --account <账号 id> --only wishCodes --force
```

判读：

| 日志 | 意思 |
|---|---|
| `领到 N 张许愿码：…` | 成了 |
| `没有能自动领的许愿码（M/13 条已完成）` | 可自动的都领完了 |
| `这个号还没参加许愿活动` | 没许愿，去 App 里许一次 |
| `豆换码(-300豆)` | 换了一张（要先开那个开关） |

⚠ `--only` 用的是**族 id**，许愿码这一族目前挂在日常的第 ⑫ 步，**没有独立的开关 id**
（它跟着日常跑）。要单独测就 `--only playAI` 之外的那趟完整跑，或直接看日志。
