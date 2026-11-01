# 鉴权分族（抓包实测）与对齐判据

日期：2026-10-23
素材：`mcloud-capture/har/` 下 52 份 HAR
范围：只统计非 `OPTIONS`、非静态资源（js/css/图片/字体）的请求。

## 0. 先定判据：对齐的是用户看得见的东西

对齐 `mcloud-sign`，对齐的是**用户的观感与结果**：

- 日志里出现哪些行、每行的说法；
- 一个账号/一趟任务最后算成还是没成；
- 推送正文里有什么；
- CLI 的退出码；
- 账号上的数据（云朵、AI豆、文件、奖品）有没有变成该有的样子。

**不是**对齐它的内部写法。实现细节可以不同 —— 否则重写就没有意义。
所以“参考实现也这么发头 / 也这么拆函数 / 也用这个状态键”**不能**拿来当保留一个行为差异的理由；
只有用户可见结果不同时，才需要改。

抓包在这里回答的是**服务端认哪种票**，不是“我们该抄哪套代码”。

## 1. 抓包结论：两套票，按接口族分，不按主机分

| 族 | 典型主机 / 路径 | 带的票 | 读数 | 反例 |
|---|---|---|---|---|
| H5 签到族 | `m.mcloud.139.com/ycloud/signin/*`、`cloudRecordV2` | `jwttoken` + cookie | 577 / 645 带 jwttoken | **0 条**带 `Authorization` |
| 原生 App / 云盘族 | `*.yun.139.com`（`personal-kd-njs`、`user-njs` 等） | `Authorization: Basic base64("mobile:号:token")` | 3078 / 4809 带 Authorization | **0 条**带 `jwttoken` |
| 邮箱族 | `appmail.mail.10086.cn`、`html5.mail.10086.cn` | cookie | 850 条带 cookie | 多数两枚票都没有 |
| mrp | `mrp.mcloud.139.com/*` | **混合**（见下） | — | 不能按主机一刀切 |

两条硬读数：

- 这批 6700+ 条请求里，**没有一条同时带 `Authorization` 与 `jwttoken`**；
- H5 族和原生族各自内部很干净：H5 不带 Basic，原生不带 jwttoken。

“两者都不带”的那一批不是漏统计：登录前请求、公开页面、静态文案，以及走
`signtoken` / cookie 的其他族都在里面。

### 1.1 mrp 是混合的

| 路径 | 抓包里带的票 | 发送方 |
|---|---|---|
| `market/api/message/notify` | `Authorization` | iOS 原生 |
| `market/mcmm/appConfig` | `Authorization` | iOS 原生 |
| `mc/mc-client-service/openapi/letter/query` | `Authorization` | iOS 原生 |
| `market/signin/page/pointsNotClaimed` | `signtoken`（两枚票都没有） | WebView |
| 公开页 / 根路径 | 无 | — |

同一台主机上同时出现 Basic、signtoken、无票三种形态，所以
**“主机后缀命中 mcloud 就发 Basic”不是一条可靠判据**。

### 1.2 证据出处

- `mcloud-capture/mcloud/capture/app-api-families.txt` §1：原生形态 A/B 的完整头集合，
  两族都明确写 `Authorization: Basic base64("mobile:…")`。
- `mcloud-capture/mcloud/capture/app-signin-samples.txt` §6：纯协议跑通签到，
  `infoV3` 明确是“带 `jwttoken` 头”，签名只用于换票。
- `mcloud-capture/docs/client-profiles.md` §3：按 UA 分组时，
  `jwttoken` 只出现在 WebView 那一组，原生 App 组是 `Authorization`。
- `mcloud-capture/har/2026-10-06-app-precheck-tun.har`：
  `caiyun.feixin.10086.cn:7071/market/signin/page/pointsNotClaimed` 原生版带 302 字符的
  `Authorization`；同路径的 WebView 版在别的窗口里是 `signtoken`。

## 2. 「今日云朵」这一口：端点与票

### 2.1 端点用 `cloudRecordV2`，不是参考实现的旧 `cloudRecord`

参考实现 `mcloud-sign` 的 `afterTask::printTodayCloud` 打的是
`GET https://mrp.mcloud.139.com/market/signin/public/cloudRecord?type=1&…`。
2026-10-23 第一次补这一行时照抄了它，真跑也能出数（「2 次 / 9 朵」）。

**但那是过时的端点。** 现在的 H5 签到页（`har/h5-signin/newsignin.336f18c3.js`）
只定义 `getAIBeanRecordData`：

```text
GET https://m.mcloud.139.com/ycloud/signin/public/cloudRecordV2
    ?aiDou=1&type=0&pageNumber=1&pageSize=100
```

`aiDou=1` 是 2026-07-31「云朵按 1:1 转成云盘专属 AI豆」之后的账本；
`aiDou=0` 那本只展示 2016-01-01 ~ 2026-07-30 的历史，**不含今天的进账**。
所以「今日获得」必须查 `aiDou=1`。

2026-10-23 只读探针（同一账号、同一天，两个端点各一次）：

| 端点 | 读数 |
|---|---|
| 旧 `mrp…/market/signin/public/cloudRecord?type=1` | 2 次 / 9 朵 |
| 当前 `m.mcloud.139.com/ycloud/signin/public/cloudRecordV2?aiDou=1&type=0` | 2 笔 / 9（`count=2, gained=9`） |

用户可见读数不变，所以这次换端点**不是**为了改数字，而是不再维护一条过时的链。
实现侧直接复用面板「今日AI豆」的 `readDayForAccount`（同一套翻页、日界、解析）。

### 2.2 V2 的票：`jwttoken`

真账号四格只读探针（`cloudRecordV2?aiDou=1&type=0&pageNumber=1&pageSize=100`）：

| 带的头 | 结果 |
|---|---|
| 只带 `jwttoken`（+ deviceid / UA / cookie） | `code 0`，`result.records` 100 条（`total=156`） |
| 只带 `Authorization`（+ deviceid / UA） | `code 90001`，未登录 |
| 两者都带 | `code 0`，100 条 |
| 两者都不带 | `code 90001`，未登录 |

结论：`cloudRecordV2` 是 **jwttoken 鉴权**，与 H5 签到族一致。
响应里的时间字段是 `inserttime`，带显式偏移（实拍
`2026-10-23T00:00:08.000+00:00`），所以日界按 `beans.ts` 的东八区口径判即可。

最初“只带 Authorization”回 90001，不是票过期，是**拿错了票**；
换端点之后同样只有 `jwttoken` 能过。

## 3. 对本仓的含义

- `authorizeRequest` 目前按主机后缀注入 `Authorization`，所以 H5 请求会**双发**
  （`buildH5Request` 已有 jwttoken，传输层又补 Basic）。
- 这是实现现状，**不是**保留它的理由。用户可见结果没有因为多这一枚头而改变
  （2026-10-23 真跑：签到、领取、今日云朵都正常），所以暂不改。
- 一旦出现“用户看到的结果和 mcloud-sign 不一样”，先按用户可见行为定位；
  真要收紧鉴权，给 `BuiltRequest` 加显式 `auth: 'basic' | 'jwt' | 'none'`，
  H5 只发 jwttoken、原生只发 Basic，然后**整趟真跑**（两族都跑，不能只跑一头）。
- 新增接口时，先找同族抓包；找不到就做四格只读探针
  （jwt-only / auth-only / both / none），不要按主机后缀推断。

## 4. 复现口径

统计脚本只依赖 HAR 的 `log.entries[].request.headers`：

- 逐条取 URL 的 host + path（去掉 query）；
- 排除 `OPTIONS` 与静态后缀；
- 看 `authorization`、`jwttoken`、`cookie` 三枚头是否存在（不读值）；
- 分族按路径前缀，不按 host 一刀切。

鉴权探针只打 `cloudRecordV2?aiDou=1&type=0&pageNumber=1&pageSize=100` 这一条只读 GET；
四个变体各一次（jwt-only / auth-only / both / none），打印 `code` / 记录数 / 第一笔的
`num` 与 `inserttime`，不打印响应正文与任何票值。
端点对比探针再把旧 `cloudRecord` 打一次（只读、同一账号、同一天），只打印汇总数。
