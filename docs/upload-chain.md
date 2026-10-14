# 网盘上传链 —— 施工图

> 三族任务的**共用地基**：`task-expansion`（触发本月备份）、`ai-avatar`（头像落盘才能抽奖）、
> `app-task`（App 原生的上传/建外链/发邮件）都要往网盘写文件。
> 所以先落这一支，再往上搭 —— 按族各写一遍上传是浪费，而且必然分叉。

## 一、枪序（mcloud 权威口径）

**基础支 = 三枪**：

```
① POST {PERSONAL_KD}/hcy/file/create      声明"我要传一个文件" → 拿 fileId / uploadId / uploadUrl
② PUT  <uploadUrl>                        发**原始字节**（预签名直传）
③ POST {PERSONAL_KD}/hcy/file/complete    告诉上游这段传完了
```

**相册自动备份支 = 六枪**（历史样本里从没出现过第 ④ 枪，是 2026-10-07 才实拍到的）：

```
④ POST {PERSONAL_KD}/hcy/backup/createSnapshot
⑤ PUT  <uploadUrl>（`ot=system`，op 0/0）   ← 与 ② 的参数**不同**
⑥ POST {PERSONAL_KD}/hcy/backup/completeSnapshot
```

⚠ ② 与 ⑤ 是**同一口 URL 的两种形态**：`ot=personal` + `x-yun-op-type: 2` / `x-yun-sub-op-type: 200`
对 `ot=system` + op `0/0`。别把一支的参数套到另一支上。

## 二、⚠ 凭据**不许**跟着上存储主机

`uploadUrl` 是**预签名**的（AWS4，查询串里自带 `X-Amz-Signature`），它指向**另一台主机**。
而 mcloud 的发送层是按**域名 + profile** 注入 `authorization` / `deviceid` 的，
**不在请求构造层设** —— 也就是"这一枪该不该带凭据，由目标主机决定"。

所以实现时必须有一个显式的判据，例如 mcloud 的 `sends_authorization_to(raw_url)`
（`app_cloud_upload.rs:471`）。**照抄这个"有判据"的做法，而不是照抄它的具体域名表** ——
具体表会随上游改，而"存储主机不发凭据"这条原则不会。

## 三、`uploadUrl` 按**凭据**对待

mcloud 的原话：它与凭据同类 —— **绝不进日志、夹具、错误文本**。

- 本仓已有约定：出错时只回显长度与指纹，不回显原文
- 那 14 个查询参数里 `X-Amz-Credential` / `X-Amz-Signature` / `uploadId` / `u` / `oi` / `f` / `ext`
  抓包也只记长度 —— 照这个口径走

## 四、容易抄错的常量（先钉住，实现时逐字核）

| 常量 | 值 | 坑在哪 |
|---|---|---|
| `CLOUD_CREATE_CONTENT_TYPE` | `application/oct-**stream**` | 少一个 `et` —— 与下一行**不是**同一个值 |
| `CLOUD_CREATE_CONTENT_TYPE_OCTET` | `application/oct**et**-stream` | 同一支里**两种都存在**（抓包按 profile 分），别"统一"成一个 |
| `CLOUD_PUT_CONTENT_TYPE` | `application/octet-stream` | 数据面用这个 |
| `CLOUD_PUT_ORIGIN` / `REFERER` | `https://yun.139.com` / `…/` | PUT 那枪的 origin 是**云盘域**，不是 `m.mcloud.139.com` |
| `CLOUD_PUT_UPLOAD_COMPLETE` | `?1` | 头名 `upload-complete`，值是 `?1`（带问号） |
| `…_UPLOAD_DRAFT_INTEROP_VERSION` | `6` | |
| `CLOUD_HASH_ALGORITHM` | `SHA256` | 与 `contentHash` 那一族配套 |
| 渠道 | Android `10000023` / PC `10200153` | Rust 是**枚举** ⇒ 没有"未识别走 web 兜底"那种分支；本仓也别加 |
| 改名模式 | `auto_rename` / `force_rename` / `refuse_duplicate_content` / `refuse` | 四个值，不是"要不要覆盖"两个 |
| 文件类型 | `file` / `folder` | |

## 五、同一台主机上的两套画像

`hcy/file/list` 与这一支在**同一台主机**，但用的是 **R16 / R27 两套画像**（2026-09-26 收口）。
⇒ 别以为"同主机就同头集"。实现时按**接口**取画像，不按主机。

## 六、与 mcloud 参考实现的三处**已知分歧**（本仓口径）

1. `User-Agent` **不在请求构造层设**（参考实现给这一族写死）
2. `authorization` / `deviceid` **不在请求构造层设** —— 由发送层按域名与 profile 注入（见 §二）
3. 渠道是枚举 ⇒ 参考实现那个"未识别渠道值走 web 兜底"的 `default:` 分支，本仓**没有**

⚠ 这三条是**刻意的**，不是漏抄。落到插件上同理：URL 与体在构造层定，
`Authorization` 由传输层按目标主机决定。

## 七、本仓的形状（一次调用一个请求）

面板执行预算 2000ms，而这条链是 3（或 6）枪、中间还要传字节 ⇒ **必须是可恢复的状态机**，
状态落 SQLite，`step` 当游标（与 `exchangeOrder.ts`、`sessionExchange.ts` 同构）。

- 传的字节从哪来：`task-expansion` 只要"触发备份"⇒ 传一个**小**的确定内容即可
  （mcloud-sign 是"随机文件"；本仓宜用确定内容，这样夹具与日志可复现）
- 尺寸/内容要**落库**：第 ③ 枪 `complete` 要 `contentHash`，它在第 ① 枪之前就得算好

## 八、证据在哪

```
mcloud/crates/mcloud-upstream/src/app_cloud_upload.rs     ← 权威实现（1513 行，含上述常量与规则）
mcloud/crates/mcloud-tasks/src/task_expansion.rs          ← 这一支的第一个消费者（1039 行）
mcloud-capture/docs/capture/app-upload-samples.txt        ← 同端**手动**上传（§3 create 键集、§5 数据面、§7 头数）
mcloud-capture/docs/capture/app-album-backup-samples.txt  ← **自动备份**支（六枪，task-expansion 走这条）
mcloud-capture/docs/capture/pc-upload-samples.txt         ← PC 同链路（§3.3/§3.4）；跨端对照 app-upload §10
```

抓包量到的是**字节级**的：12 枚头、14 个查询参数、`uploadUrl` 长度落在 **583 / 585**
（记着"这是**无 ctx 基线长**，本轮第三、四次落在同一个数上"）。这类"反复落在同一个数上"
的记录可以直接当夹具锚点 —— 比单次采样可靠得多。

⚠ **先看 mcloud，再看抓包**（用户定的顺序）：mcloud 是权威实现、把"为什么"写在注释里，
抓包用来判"源码形状 vs 线上字节"的分歧（`?acceptDate=` 那个坑就是这么发现的）。
