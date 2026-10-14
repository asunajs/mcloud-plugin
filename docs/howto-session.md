# 怎么给插件一份可用的会话

插件要能跑任务，需要一份**云盘账号的凭据**。

> **先看这一句**：正常情况下你**不需要**看这份文档 —— 面板侧边栏点进「云盘」，
> 在「账号」块里点「扫码登录」，用手机 App 扫一下就完了（短信 / 账密也可以）。
> 那三种登录都已经做好了。
>
> 这份文档是给两种情况用的：
>
> 1. **你手上已经有一份会话串**（cookie / JSON），想直接贴进去
> 2. **你要写脚本**，想直接调接口，而不是点界面

⚠️ 面板的「账号」块里那个「贴会话串导入」按钮走的就是下面第 2 节那个接口。

> ⚠️ **凭据等于账号密码。** 别贴进聊天窗口、别提交进仓库、别放进截图。
> 它只存在本机的 SQLite（`state` 表的 `mcloud.session` 键）里，插件的接口
> 和日志都只输出脱敏摘要（长度 + 前 4 位）。

## 拿会话：三种办法，按你手边有什么挑

### ① 从浏览器（最省事）

1. 电脑浏览器打开并登录 <https://yun.139.com>（手机号 + 验证码登进去）
2. 按 F12 打开开发者工具 → **Network** 面板 → 刷新页面
3. 随便点一个请求 → 右键 → **Copy as cURL**
4. 从粘贴出来的命令里找这两段：

```text
-H 'cookie: SESSIONID=…; UID=…; …'      ← 这一整串
-H 'jwttoken: eyJ…'                     ← 有就一起拿
```

5. 拼成一个 JSON：

```json
{ "cookie": "SESSIONID=…; UID=…; …", "jwt": "eyJ…" }
```

也可以用 **Application → Cookies → https://yun.139.com** 面板，
把 `SESSIONID`、`UID` 这些逐个抄下来拼成 `名字=值; 名字=值` 的形式。

### ② 从手机 App（用抓包工具）

手机装个抓包代理（Reqable / Charles / mitmproxy 都行），登录云盘 App，
在抓到的 `m.mcloud.139.com` 请求里找 `cookie` 与 `jwttoken` 两枚头。
**顺便**把 `user-agent` 和 `deviceid` 也复制下来一起放进 JSON —— 这两个是可选的，
但带上会更像客户端（有些端点会看）。

### ③ 只要 cookie 也行

最省事的形式：直接把 cookie 串贴进去，`jwt` / `deviceId` / `userAgent` 都留空。
签到族多数端点只认 cookie。

## 怎么塞进插件

**点界面**：面板侧边栏「云盘」→「账号」→「贴会话串导入」→ 把下面第 ① 或第 ② 步
拿到的那一整段贴进去 → 「导入并验证」。

**写脚本**（同一件事）：用面板的令牌调一次接口：

```bash
# 就贴 cookie 串（最简单的形式）
curl -X POST http://127.0.0.1:8787/plugins/mcloud/api/session \
  -H 'X-Panel-Token: <你的面板令牌>' \
  -H 'x-panel: 1' \
  -d '{"session":"SESSIONID=…; UID=…"}'

# 或者贴 JSON
curl -X POST http://127.0.0.1:8787/plugins/mcloud/api/session \
  -H 'X-Panel-Token: <你的面板令牌>' \
  -H 'x-panel: 1' \
  -d '{"session":"{\"cookie\":\"SESSIONID=…\",\"jwt\":\"eyJ…\",\"userAgent\":\"…\"}"}'
```

> ⚠️ **写接口必须带 `-H 'x-panel: 1'`。** 这是面板的防跨站请求伪造要求，
> **插件自己注册的路由同样适用**。漏了会收到一句中文说明（不是 500），
> 但如果你在写脚本，这一行很容易漏 —— 插件的 WebUI 里也要记得带上。

**导入时会立刻真验一次**（发一个最便宜的只读请求），返回里的 `verified` 才是
「能不能用」的答案，而不是只看格式对不对：

```json
{ "imported": true, "verified": true, "note": "会话有效（412ms）", "status": { … } }
```

失败的两种情况要分清：

```json
{ "imported": true, "verified": false, "note": "会话可能已失效：code=90001 msg=未登录" }
```
→ 凭据是**过期或抄错了**（上游明确说了未登录）

```json
{ "imported": true, "verified": false, "note": "会话可能已失效：请求失败：http status: 405" }
```
→ 请求本身没被受理（协议层问题，通常是插件该改，不是你该重贴凭据）

## 看看当前状态

```bash
curl http://127.0.0.1:8787/plugins/mcloud/api/session \
  -H 'X-Panel-Token: <你的面板令牌>'
```

```json
{ "present": true, "savedAt": "2026-10-13T11:18:37.071Z", "ageHours": 0.2,
  "cookie": "SESS…（共 31 字符）", "jwt": "（无）",
  "lastCheck": "2026-10-13T11:18:37.071Z", "lastCheckOk": false,
  "lastCheckNote": "会话可能已失效：code=90001 msg=未登录" }
```

## 过期了怎么办

**不用手动管**：日常那条链的倒数第二步就是**凭据续期**（票新鲜时一个请求都不发），
它失效时会在「日常」块里那次运行的结果里写出来。

> ⓘ 早先有个独立的 `session-check` 任务（每天 7:50 跑一次），**它已经没有了** ——
> 25 条任务合并成 3 条之后，这一步并进了日常那条链里。

手动验一次：

```bash
curl -X POST http://127.0.0.1:8787/plugins/mcloud/api/session/verify \
  -H 'X-Panel-Token: <你的面板令牌>' -H 'x-panel: 1'
```

想换一份凭据，直接再 `POST /session` 覆盖；想清空：

```bash
curl -X POST http://127.0.0.1:8787/plugins/mcloud/api/session \
  -H 'X-Panel-Token: <你的面板令牌>' -H 'x-panel: 1' -d '{"clear":true}'
```
