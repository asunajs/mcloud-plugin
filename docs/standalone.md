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
- 状态默认写 `./.mcloud/state.json`，与面板数据库不互通
- 运行时换票后的 auth 保存在状态里，旧 config 不会覆盖；要强制覆盖某账号加 `"replaceAuth": true`

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
