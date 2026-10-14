# smid 设备指纹链 —— 施工图（把 `deviceid` 换回来的那条链）

**为什么需要它**：`receive`（领AI豆）等领取类接口必须带一个 H5 的 `deviceId`，
不带回 `615`、带错回 `614` —— 而这两句的文案都是「活动太火爆啦」，**看起来像限流**。
细节见 `docs/findings.md` F-018。

真机已经确认过：塞进一份有效的 `deviceId`（89 字符，`B` 开头）之后，`receive` 当场领到了东西。

> **本文是施工图，不是实现**。权威源是 `mcloud/crates/mcloud-upstream/src/smid.rs`（743 行）。
> 记下它的目的是：下次动手时不用把那份 Rust 重读一遍。

---

## 一、这条链在干什么

`deviceid` **不是本地算出来的串** —— 它是中国移动统一认证（cmpassport）的风控服务
**发下来的**：客户端把一份"浏览器 / WebView 特征"加密上报，服务端回一个 `deviceId`，
客户端在前面**拼一个字母 `B`** 当自己的设备 id 用。

```text
uid = randomUUID()
  ├─ ep     = RSA-PKCS1v15(uid)          公钥：mcloud_crypto::SKLAND_PUBLIC_KEY_B64（**1024 位**）
  └─ priId  = md5(uid)[0..16]            下面那份特征的 AES 密钥
特征体（约 30 字段，含当场随机出来的 smid）
  → tn = md5(getTn(特征体))               ← 先算摘要，再写回 tn 字段
  → 按 RULES 逐字段 DES 加密 + 改名（appId→um、ua→pu、…）
  → JSON → gzip（OS 字节写 19）→ base64
  → AES-CBC/PKCS7 固定 IV，密钥 priId → hex      = data
POST https://slw.h5cmpassport.com:9090/deviceprofile/v4
  { appId, organization, ep, data, os:"web", encode:5, compress:2 }
  → code == 1100 → deviceId = "B" + detail.deviceId
```

## 二、四样东西的生命周期**完全不同**（混起来会把该变的钉死）

| | 会不会变 | 本项目的处理 |
|---|---|---|
| **设备特征**（屏幕、dpr、platform、canvas、cpu 数、ua…） | 真机上**不变** | **按账号存一份**，之后复用 |
| **smid 字段** | **每次都变**（内嵌 `yyyyMMddHHmmss` + 现生成 uuid） | 每次现算，**不落库** |
| **deviceId**（`B…`） | 服务端发的，会变 | 每次上报重新取；库里那份只是"最近拿到的" |

⚠ 旧实现**每跑一次就重随机一份特征** ⇒ 同一台机器每次上报都长成另一台机器的样子，
那正是最容易触发风控核验的姿态。**不跟。**

## 三、四个密码学原语（都要自己写；面板**不提供** crypto）

| 原语 | 用在哪 | 插件现状 |
|---|---|---|
| **RSA-1024 PKCS#1 v1.5 加密** | `ep` | ❌ 要新写（BigInt 可用 → 只需 modexp + 填充 + SPKI 解析） |
| **AES-128-CBC + PKCS7**（固定 IV） | 特征体那一步 | ❌ 要新写 |
| **DES**（逐字段） | 按 RULES 加密字段 | ❌ 要新写 |
| **gzip**（OS 字节 19） | 压缩 | ❌ 要新写（**DEFLATE stored 块**即可：合法 gzip，且不必实现 Huffman） |

已有：md5 / sha1 / sha256 / hmac / base64 / hex（`src/crypto/`）。

⚠ **沙箱能力已实测**（`GET /api/caps`）：`BigInt=function`、`DataView=function`，
但 `String.fromCharCode.apply` 十万实参**抛 RangeError** ⇒ 拼大字符串**不能**用 `apply`。
（现有 `bytes.ts` 是逐字节 `+=`，没踩这个坑。）

## 四、还没抄过来的两块**数据**

| 内容 | 位置 | 规模 |
|---|---|---|
| `SmFingerprint` 字段池 + `caiyun_android_web()` | `smid.rs:91-238` | 约 30 字段 + 若干候选池（屏幕 4 档、dpr 2 档、cpu 5 档…） |
| `RULES`：逐字段「是否加密 + 改成什么名」 | `smid.rs:415-593` | **25 条** |

两处都是**纯数据照抄**，风险低但量大 —— 抄的时候要**逐条对**，
因为「少抄一条字段」的表现是"上报被拒"，而看不出是哪一条。

## 五、两个小函数（已在 Rust 里读到，直接可抄）

```rust
smid_string(time_digits, uid):
  v       = time_digits + md5_hex(uid) + "00"
  smsk    = md5_hex("smsk_web_" + v)[0..14]
  return v + smsk + "0"

private_id(uid) = md5_hex(uid)[0..16]
```

## 六、怎么验（三层，缺一不可）

1. **原语层**：对着 Node 的 `crypto` 逐用例比 —— DES/AES/RSA 都有标准测试向量；
   RSA 用 `crypto.generateKeyPairSync` 造一对临时钥匙，**用私钥解出来对拍**。
2. **组装层**：给定同一份指纹、同一时间、同一随机源，特征体必须**逐字节可复现**
   （Rust 那边就是按这个可测性设计的 —— `rng` 是入参）。
3. **真机层**：拿服务端真回一个 `deviceId`，再用它去跑 `receive` 领到东西。
   ⚠ 前两层全绿**不等于**第三层能过 —— 这一条是 F-015/F-018 反复教的。

## 七、开工顺序（按"最早暴露风险"排）

1. RSA + 测试（最高风险：modexp 写错只会表现为"服务端拒绝"）
2. AES-CBC + 测试
3. gzip（stored 块）+ 测试
4. DES + 测试
5. `RULES` 表 + `SmFingerprint` 照抄
6. `smid.ts` 组装 + 上报 + 解析 `B…`
7. 接进 `sessionExchange`：换票之后顺手取 deviceId 并写进会话
8. 真机验 `receive`
