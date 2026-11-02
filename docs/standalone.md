# 独立运行（替代 mcloud-sign）

同一份 `src/` 既能构建面板插件，也能构建 Node 独立版。独立版**没有 WebUI、没有内置 cron**，只提供命令和导出函数。

## 构建

```bash
npm run build:standalone
npm run check-build:standalone
```

产物：

```text
dist/standalone/mcloud-sign.mjs   CLI + 全部导出
dist/standalone/daily.mjs         只含日常
dist/standalone/exchange.mjs      只含兑换
dist/standalone/redflower.mjs     只含小红花
dist/standalone/wsWorker.mjs      同步 WS 用的 worker（已内嵌 ws）
dist/standalone/httpWorker.mjs    同步 HTTP 用的 worker（Node fetch）
```

## 日常

```bash
mcloud-sign
mcloud-sign --config ./asign.json
```

配置查找顺序与旧版一致：

```text
当前目录/asign.json
当前目录/asign.config.js
当前目录/asign.config.mjs
当前目录/config/...
可执行文件目录/...
可执行文件目录/config/...
```

配置沿用旧格式：

```json
{
  "version": 2,
  "caiyun": [
    { "auth": "Basic ...", "nickname": "小号" }
  ],
  "common": { "colorize": true },
  "message": {},
  "standalone": {
    "stateFile": "./.mcloud/state.json",
    "http": { "timeoutMs": 20000 },
    "ws": { "insecure": false, "timeoutMs": 15000 }
  }
}
```

- 无参数只跑日常，**不碰直播**
- 旧配置里的 `直播口令` 字段会被忽略；直播只能通过导出函数调用
- 旧配置里的 `红包派对.开启` / `算力大作战.开启` **会被读**（见下面两节）
- 状态默认写 `./.mcloud/state.json`，与面板数据库不互通
- 运行时换票后的 auth 保存在状态里，旧 config 不会覆盖；要强制覆盖某账号加 `"replaceAuth": true`

## 红包派对

日常的第 ④.5 步（App 任务之后、消息推送之前）。它是移动云手机活动站那一族，
用的是**自己的票**（原生凭据 → SSO → 活动站 `token`），跟签到用的 `jwttoken` 不是一张。

配置里可以按账号关：

```json
{
  "common": { "红包派对": { "开启": true } },
  "caiyun": [
    { "auth": "Basic ...", "红包派对": { "开启": false } }
  ]
}
```

合并顺序与参照实现一致：账号那层赢，其次 `common`。两层**都没写**这一格时，CLI 不碰
状态里的开关，缺省就是**开着**（参照实现的默认账号配置也是 `开启: true`）；
面板上那个开关因此不会被每次启动覆盖回去。

⚠ 这一族里有一条会**往用户的云机里装应用**（`在云手机里安装应用`）：先问那台云机上
装过没有，装过就只上报、不重复装。不想让它动云机就把这一族关掉。

日志里那几行（`余额: 可用3元，累计4.6元`、`去完成: 每日签到 (0.10元)`、
`需手动完成: 每日使用云机 (需云机内实际使用)`…）逐字照参照实现真跑留档的产出；
这一族我们**零抓包**，所以第一次真跑的读数才算数（`groups.ts` 里标的是
`evidence: 'ran-elsewhere'`，不是 `captured`）。

## 算力大作战

日常的第 ④.6 步（红包派对之后、领取类之前）。它跟签到族**同一张票**（`jwttoken`），
不需要另换活动站票；接口、状态机与动作矩阵见 [`token-pk.md`](token-pk.md)。

配置形状与红包派对一致（账号那层赢，其次 `common`，都没写就**开着**）：

```json
{
  "common": { "算力大作战": { "开启": true, "代抽": { "开启": true, "每日上限": 3 } } },
  "caiyun": [
    { "auth": "Basic ...", "算力大作战": { "开启": false } }
  ]
}
```

「代抽」是**可选**的：不写就不抽（次数留给用户自己在活动页点）。写了才按 `每日上限`
花次数（`0` = 不抽，`代抽: true` = 开 + 默认上限 10）；抽中的奖品直接进奖品表，
会被第 ⑤ 步「待领取奖品」领走。

⚠ 这一族会**往网盘里写文件**（上传照片 / 备份 / 分享）：文件都登记在 `ownedFiles`，
链尾「清理临时文件」会删掉；不想让它动网盘就把这一族关掉。
判据来自 2026-10-24 / 11-01 的 iOS WebView 实拍（`captured`），但**真账号还没跑过** ——
第一次真跑的读数是最后一道判据。

## 日志

CLI 的 console 输出照 `mcloud-sign` 的 transport：`[info] 11:04:00 ...`，
账号段头是 `------ 账号 1 (账号1) ------`，账号收尾是 `账号 1 执行完成`。
`common.colorize` 控制颜色；非 TTY 环境自动关色，落盘日志不会带 ANSI。
面板插件的 WebUI 日志走另一套（`host-api` + `userLine`），不受这里影响。

日常尾部两条读数两边共用同一份 `runDaily`：`清理临时文件：…` 和
`今日云朵：今日获得N次云朵数量共：X`。面板把这两行进日志流，也放进运行结束的
推送正文；CLI 只打印到 console。

「今日云朵」那行读的是 `m.mcloud.139.com/ycloud/signin/public/cloudRecordV2`
（`aiDou=1&type=0`，按东八区当日过滤），和面板「今日AI豆」卡片同一条链、同一个数；
不是 `mcloud-sign` 里那支过时的 `mrp…/cloudRecord`（为什么换见
[`auth-families.md`](auth-families.md)）。

## 导出函数

```ts
import {
  run,
  exchange,
  drawRedFlower,
  autoDrawRedFlower,
  printExchangeList,
} from './dist/standalone/mcloud-sign.mjs';
```

### 兑换

```ts
await exchange(123456, '小号');
await exchange([[123456, '小号'], ['奖品名', '大号']]);
```

### 手工口令小红花

```ts
await drawRedFlower(['口令A', '口令B']);
```

### 自动听直播 + 领小红花

```ts
await autoDrawRedFlower();
```

自动流程：判开播 → 开 WS → 收弹幕口令 → 逐账号领取 → 无效口令回写池。

## 依赖与限制

- 需要 Node 20+
- HTTP 走 Node 原生 `fetch`（worker + Atomics 同步桥），**不依赖系统 curl**
- 部署时 `httpWorker.mjs` / `wsWorker.mjs` 要和 `mcloud-sign.mjs` 放在同一目录
- WebSocket 走 worker + Atomics，worker 已打包 `ws`
- v1 不支持 SMTP 邮件推送；HTTP 推送渠道可用
- 没有内置 cron：由用户自己的 cron / CI 调 `mcloud-sign`
- 扫码 / 短信登录不在 v1；config 里直接提供完整 auth
