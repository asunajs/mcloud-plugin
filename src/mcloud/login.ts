// 登录三种（扫码 / 短信 / 账密）—— 协议层。
//
// 权威源：`mcloud/crates/mcloud-upstream/src/login.rs` 与 `mcloud-tasks/src/login.rs`。
// 逐字要点都在下面的注释里，**不要凭直觉改常量**：这一层每个字面量都有实测出处。
//
// # 为什么登录是「一步一步」的，而任务不是
//
// 用户的要求是「任务不要一次一步」。但**登录恰恰必须一步一步** —— 因为
// **状态机是用户本人**：
//
//   扫码：我出码 → 用户掏出手机扫 → 用户在手机上点确认 → 我才拿得到凭据
//   短信：我发码 → 用户看手机 → 用户把 6 位码告诉我 → 我才拿得到凭据
//   账密：用户给我手机号和口令 → 我一次换到凭据
//
// 中间那几步的**时间由用户决定**，不是我决定。硬把它塞进一个"从头跑到尾"
// 的函数，结果只能是"函数停在等用户输入" —— 那是把交互做成轮询。
//
// 所以分工是：
//   · **登录**：路由一步一步推（`/login/qr/start` → `/login/qr/poll`），
//     推进的触发者是用户点按钮。
//   · **任务**（日常/兑换/直播）：一次跑完（`register_cron` + `drain`）。
//
// 账密是个例外 —— 它没有用户交互，所以它**一个路由就完成**（`/login/pwd`）。
//
// # 三个易错点（都踩过）
//
// 1. **设备头是登录必需的**。只带 `x-yun-tid` 调 `/user/thirdlogin` 会被回
//    `{"code":"9999","message":"登录失败！"}` —— 看起来像"账号被拒"，
//    实际是"头不全"。见 `pcHeaders`。
// 2. **设备指纹必须持久化**。二维码的 `dID` 就是它；每次重新生成的表现是
//    轮询**永远停在** `200059541 未找到设备的二维码信息` —— 而这看起来像
//    "码过期了"，极难往"设备号变了"上想。
// 3. **`sID` 与 `thirdlogin` 的 `dycpwd` 是同一个值**（客户端源码注释：
//    `// QRCodeID也是sessionId`）。所以它要一直带到轮询结束。

import { aesEcbPkcs7DecryptHex, decryptWithDynamicIv, encryptWithDynamicIv } from '../crypto/aes.ts';
import { sha1, toHex } from '../crypto/index.ts';
import { toBase64, utf8 } from '../crypto/bytes.ts';
import type { BuiltRequest } from './h5.ts';

// ══════════════════════════════ 上游主机 ══════════════════════════════

/** 登录那一族接口的主机。**与云盘业务主机（`mcloud.139.com`）不是同一台。**
 *
 *  所以它需要自己的配置口子（`mcloud.login.base`）—— 混用业务基址的话，
 *  指到 mock 之后登录仍然打真上游（而登录打真上游的表现是"账号密码不对"）。 */
export const LOGIN_HOST = 'https://user-njs.yun.139.com';

export const THIRD_LOGIN_PATH = '/user/thirdlogin';
export const SEND_SMS_CODE_PATH = '/user/sms/getSmsCode';
/** ⚠ 是 `verfycode` **不是** `verifycode` —— 上游就这么拼的。 */
export const SLIDER_PUZZLE_PATH = '/user/verfycode';
export const LOGOUT_PATH = '/user/logout';

// ══════════════════════════════ 平台档案 ══════════════════════════════

export type PcPlatform = 'windows' | 'macos';

/** 冒充成 PC 客户端的档案：平台 + 设备指纹。
 *
 *  登录时**还没有凭据**，但已经有形态 —— 所以它单独一个类型，
 *  不与「已登录客户端的凭证」混在一起。 */
export interface PcClient {
  platform: PcPlatform;
  /** 设备指纹。**必须持久化** —— 见文件头第 2 条易错点。 */
  deviceId: string;
}

export function pcClient(platform: PcPlatform, deviceId: string): PcClient {
  return { platform, deviceId };
}

/** `clientType` 业务参数。 */
export function clientType(c: PcClient): string {
  return c.platform === 'windows' ? '656' : '710';
}

/** `cpid` 业务参数。 */
export function cpid(c: PcClient): string {
  return c.platform === 'windows' ? '277' : '332';
}

/** 该平台客户端上报的版本号。
 *
 *  ⚠ 它是**业务参数**而非展示信息：同时进请求体的 `version` 字段与二维码的
 *  `ver` 参数，上游按版本分流。mac 的 `clientType` 配 Windows 的版本号，
 *  是一个上游一眼可辨的矛盾组合。
 *
 *  出处：Windows `8.8.6.20260829` 来自抓包归档里的真实请求体；
 *  macOS `4.2.1` 来自客户端 `app.asar` 的 `package.json`。 */
export function appVersion(c: PcClient): string {
  return c.platform === 'windows' ? '8.8.6.20260829' : '4.2.1';
}

/** 渠道号（`x-yun-app-channel`）。**这个才随平台变**。 */
export function appChannel(c: PcClient): string {
  return c.platform === 'windows' ? '10200153' : '10301000';
}

/** `x-huawei-channelSrc` —— ⚠ **常量，不随平台变**。
 *
 *  这一度写错过：曾让它与 `appChannel` 取同一个值，于是 mac 会发出
 *  `x-huawei-channelSrc: 10301000`。
 *
 *  证据是客户端源码里那一行**字面量**：
 *  ```js
 *  xhr.setRequestHeader("x-huawei-channelSrc","10200153");
 *  ```
 *  同一段里 `x-yun-app-channel` 才是三元表达式 —— **只有它随平台变**。
 *
 *  为什么这个错误要紧：这个头是**登录必需**的那 5 个之一，发错值等于把一个
 *  必需头填错，而上游对此的回应是 `9999 登录失败！` —— 看不出是头的问题。 */
export const HUAWEI_CHANNEL_SRC = '10200153';

/** `x-MM-Source` 的兜底值（客户端源码：`appSource || "000"`）。 */
export const MM_SOURCE = '000';

/** HTTP `User-Agent`。
 *
 *  ⚠ 证据等级比其它字段低，如实标注：两个参考实现都**没有**给 PC 端设过
 *  HTTP UA（只发自定义的 `x-UserAgent: PC`），所以"原生 PC 客户端到底发什么
 *  UA"没有实测。这里用的是**同平台浏览器外壳的实测串**。
 *
 *  仍然要区分它，是因为客户端**自己**就是靠 UA 里的 `mac` 判断平台的，
 *  所以"UA 反映平台"是真实客户端的行为，不是我们的发明。
 *
 *  ⚠ 两串的大版本号（153 / 149）只是各自采集时的版本，**不要**当成
 *  "平台 → 版本"的映射去解读；有意义的只是 OS 段。 */
export function userAgent(c: PcClient): string {
  return c.platform === 'windows'
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0';
}

/** 设备信息串（`x-yun-client-info` / `x-DeviceInfo`，14 段，`|` 分隔）。
 *
 *  | 下标 | 内容 |
 *  |---|---|
 *  | 0,1 | 空串（前导 `\|\|`） |
 *  | 2 | `11`（固定） |
 *  | 3 | `appVersion` ← **平台差异就在这里** |
 *  | 4 | `PC` |
 *  | 5 | base64(设备型号码)，兜底是固定常量 |
 *  | 6 | 设备指纹（与 `x-yun-device-id` 同值） |
 *  | 7 | 空串 |
 *  | 8 | OS 描述 |
 *  | 9 | 分辨率 |
 *  | 10 | base64(语言) |
 *  | 11-13 | 空串 |
 *
 *  ⚠ 第 5 / 10 段是 base64 包一层、第 6 段是明文 —— 同一串里两种编码混用。
 *
 *  ⚠ **已知的保真缺口，不猜**：这段模板来自客户端源码里"原生接口失败时的
 *  兜底"，而那份兜底是 **Windows 专用**的（` Windows 10 (10.0)`、`1920X1040`）。
 *  macOS 真实客户端会走原生接口拿到自己的 OS 串与分辨率，但**两个参考实现
 *  都没有 mac 的实测样本**。所以这里也复用同一份兜底，**只让第 3 段随平台变**：
 *  与其编一个看起来合理的 macOS OS 串，不如留一个有据可查的缺口。 */
export function deviceInfo(c: PcClient): string {
  return (
    `||11|${appVersion(c)}|PC|QkYtMjAyMDAzMTAxNjQ3|${c.deviceId}` +
    '|| Windows 10 (10.0)|1920X1040|Q2hpbmVzZSAoU2ltcGxpZmllZCk=|||'
  );
}

/** 登录链路要带的设备头。
 *
 *  # 这 5 个是**实测**出来的最小集合，不是装饰
 *
 *  原始排查：只带 `x-yun-tid` 调 `/user/thirdlogin` 会被回
 *  `{"code":"9999","message":"登录失败！"}`，补上这几个设备头之后才是正常的
 *  `200059541 未找到设备的二维码信息`。也就是说**"头不对"的失败长得像
 *  "登录被拒"**，很容易误判成账号问题。
 *
 *  ⚠ `x-yun-client-info` 与 `x-DeviceInfo` 是**两个头、同一个值**
 *  （大小写不同）—— 不是笔误，客户端源码里就是两行 `setRequestHeader`。
 *
 *  ⚠ 这里**只发登录分支的那 5 个头**。`x-yun-app-channel` 属于**登录后**的头
 *  集合，所以**不在这里** —— 它由 [`appChannel`] 提供给别的请求构造点。
 *  上一版多发了一个 `x-yun-app-channel`：那是把"两个分支的头"合并成了一套。
 *  合并的后果不是报错，而是登录请求多带一个上游没预期的头。 */
export function pcHeaders(c: PcClient): Record<string, string> {
  const info = deviceInfo(c);
  return {
    'x-yun-client-info': info,
    'x-DeviceInfo': info,
    'x-MM-Source': MM_SOURCE,
    'x-huawei-channelSrc': HUAWEI_CHANNEL_SRC,
    'x-UserAgent': 'PC',
  };
}

/** **已登录**的业务请求要带的全部 PC 设备头（登录那 5 个 + 登录后追加的）。 */
export function pcBusinessHeaders(c: PcClient): Record<string, string> {
  return { ...pcHeaders(c), 'x-yun-app-channel': appChannel(c) };
}

// ══════════════════════════════ 随机量 ══════════════════════════════

/** 从沙箱里能拿到的随机源造 n 个字节。
 *
 *  ⚠ 面板的插件沙箱**没有密码学随机源**（见 `rand.ts` 的文件头）。
 *  这里够用吗？—— 设备指纹与 `sID` 只要求**唯一且稳定**，不要求不可预测：
 *  它们是标识符，不是凭据。真正的凭据是登录换回来的 token。
 *  已记进 `docs/findings.md` F-005。 */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256) & 0xff;
  return out;
}

/** PC 设备指纹（`windowMachine`）：32 位**大写** hex + `-ENDIN`。
 *
 *  ⚠ **必须持久化**。它是服务端定位"这次扫码会话是哪台设备"的唯一凭据
 *  （二维码的 `dID`）。每次重新生成的表现是轮询**永远停在**
 *  `200059541 未找到设备的二维码信息`。 */
export function newPcDeviceId(): string {
  return `${toHex(randomBytes(16)).toUpperCase()}-ENDIN`;
}

/** `sID`：32 位**大写**十六进制（对齐客户端 `Utils.getGUID32()`）。 */
export function newSessionId(): string {
  return toHex(randomBytes(16)).toUpperCase();
}

/** 发码请求里的 `random`：**24 位小写**十六进制。
 *
 *  ⚠ 不用 UUID：客户端源码里它是两段 `Math.random().toString(16).substring(2)`
 *  拼出来的，既不是 UUID 也不是 16/32 位 —— 长度（24）与字符集（小写十六进制）
 *  都由服务端校验。换成 UUID 会得到 36 字符带连字符的串，形态就不对了。 */
export function newSmsRandom(): string {
  return toHex(randomBytes(12));
}

// ══════════════════════════════ 二维码 ══════════════════════════════

/** 扫码登录的二维码落地页。`sID` / `dID` 以 query 形式拼在 `#/` 之后。 */
export const QR_LOGIN_URL = 'https://yun.139.com/w/#/qrcLogin';

/** 拼出二维码载荷。
 *
 *  # 没有"申请二维码"这个请求
 *
 *  客户端源码里就是四行字符串拼接，**不发起任何网络请求**；实测 1622 个
 *  body 文件里也没有对应的取码接口。它推翻了"取码要调接口"的直觉假设。
 *
 *  `cType=11` 是 PC 端的固定值（与业务参数 `clientType` 的 `656/710` 不是一回事）。 */
export function qrPayload(c: PcClient, sessionId: string): string {
  return `${QR_LOGIN_URL}?dID=${c.deviceId}&sID=${sessionId}&cType=11&ver=${appVersion(c)}`;
}

// ══════════════════════════════ 登录方式 ══════════════════════════════

export type LoginKind = 'qr' | 'sms' | 'password';

/** `/user/thirdlogin` 的 `pintype`。 */
export function pintype(kind: LoginKind): string {
  return kind === 'qr' ? '21' : kind === 'sms' ? '5' : '9';
}

/** `extInfo.ifOpenAccount`：短信是 `1`，扫码与账密是 `0`。 */
export function ifOpenAccount(kind: LoginKind): number {
  return kind === 'sms' ? 1 : 0;
}

/** 上游业务码（实测汇总）。
 *
 *  单列成常量而不是散在 `if` 里，是为了让"这个码的含义有实测依据"可见。 */
export const CODES = {
  OK_ZERO: 0,
  OK_200: 200,

  /** 未找到设备的二维码信息 —— 码还没被扫。 */
  QR_NOT_SCANNED: 200_059_541,
  /** 二维码信息未授权 —— **已扫码，等用户在手机上确认**。 */
  QR_SCANNED: 200_059_548,
  /** 二维码信息与登录二维码信息不一致 —— `sID` 不匹配。 */
  QR_MISMATCH: 200_059_544,
  /** 二维码已失效 —— 超时，必须重新出码。 */
  QR_EXPIRED: 200_059_542,
  /** 扫码登录过于频繁 —— 语义是**限流**：该退避，不该换张码立刻重试。 */
  QR_TOO_FREQUENT: 200_059_545,

  /** 请先获取滑块拼图验证码。 */
  NEED_SLIDER: 200_059_554,
  /** 同一滑块验证码校验失败次数超限 —— 挑战作废，**必须重新取图**。 */
  SLIDER_EXHAUSTED: 200_059_553,

  /** 用户 token 不能为空（退出登录的实测常态：客户端先清 token 再调 logout）。 */
  TOKEN_EMPTY: 1_000_001,

  /** 输入参数不合法 —— 服务端**解不开请求体**。 */
  UNDECRYPTABLE_BODY: 9_103,
  /** 验证码不正确 —— 请求体已被正确解析，只是短信码不对/过期。 */
  SMS_CODE_WRONG: 9_441,
  /** 登录失败！—— 设备头缺失/不完整时的表现。 */
  LOGIN_FAILED: 9_999,
} as const;

/** 成功码判定：`0`（含 `"0000"`）与 `200`。 */
export function isSuccessCode(code: number | null): boolean {
  return code === CODES.OK_ZERO || code === CODES.OK_200;
}

// ══════════════════════════════ 请求体（纯函数） ══════════════════════════════

/** `/user/thirdlogin` 的请求体。三种登录方式共用这一个构造器。
 *
 *  ⚠ 字段顺序按 **JSON key 字典序**（`clientType, cpid, dycpwd, extInfo,
 *  loginMode, msisdn, pintype, verType, version`）。参考实现是 serde 的
 *  `BTreeMap` 天然给的；我们这里**显式按这个顺序写字面量**，
 *  因为 `JSON.stringify` 保留插入顺序 —— 顺序错了签名/校验就可能不过。 */
export function thirdloginBody(
  c: PcClient,
  kind: LoginKind,
  dycpwd: string,
  msisdn: string,
): Record<string, unknown> {
  return {
    clientType: clientType(c),
    cpid: cpid(c),
    dycpwd,
    extInfo: { ifOpenAccount: ifOpenAccount(kind) },
    loginMode: '0',
    msisdn,
    pintype: pintype(kind),
    verType: '2',
    version: appVersion(c),
  };
}

/** 扫码登录：`dycpwd` 直传二维码里的 `sID`，**无需任何变换**。 */
export function qrThirdloginBody(c: PcClient, sessionId: string): Record<string, unknown> {
  return thirdloginBody(c, 'qr', sessionId, '');
}

/** 短信登录：`dycpwd` 是 **6 位验证码明文**（不是哈希）。 */
export function smsThirdloginBody(
  c: PcClient,
  phone: string,
  smsCode: string,
): Record<string, unknown> {
  return thirdloginBody(c, 'sms', smsCode, phone);
}

/** 账密登录：`dycpwd` 是**哈希后的口令**，`msisdn` 是用户名。 */
export function passwordThirdloginBody(
  c: PcClient,
  username: string,
  password: string,
): Record<string, unknown> {
  return thirdloginBody(c, 'password', passwordHash(password), username);
}

/** `/user/sms/getSmsCode` 的请求体。
 *
 *  `mode` / `reqType` 是固定值（实测），**不当可变参数暴露出去**。 */
export function sendSmsCodeBody(
  c: PcClient,
  phone: string,
  random: string,
): Record<string, unknown> {
  return {
    phoneNumber: phone,
    random,
    mode: 0,
    reqType: 3,
    clientType: clientType(c),
  };
}

/** `/user/verfycode` 的请求体：取滑块拼图。
 *
 *  ⚠ 路径与字段名都**没有 `i`**：是 `verfycode` 不是 `verifycode` —— 上游就这么拼的。 */
export function sliderPuzzleBody(phone: string): Record<string, unknown> {
  return { account: phone, type: 2 };
}

/** 带滑块的发码请求体：在基础 body 上追加 `puzzleVerfycode`。
 *
 *  单独一个函数而不是给 `sendSmsCodeBody` 加可选参数：走滑块是**异常路径**
 *  （首次发码被风控拦下才走），让它在调用点显式可见，比在每个调用点传
 *  `undefined` 更不容易埋掉。 */
export function sendSmsCodeBodyWithSlider(
  c: PcClient,
  phone: string,
  random: string,
  sliderAnswer: string,
): Record<string, unknown> {
  return {
    ...sendSmsCodeBody(c, phone, random),
    puzzleVerfycode: puzzleVerfycodeEncrypt(sliderAnswer),
  };
}

// ══════════════════════════════ 口令与滑块 ══════════════════════════════

/** 口令哈希的前缀（客户端 `common/utils.js` 的 `HASHTEXT`）。 */
export const PASSWORD_HASH_PREFIX = 'fetion.com.cn:';

/** 账密登录 `dycpwd` 的取值：`SHA1("fetion.com.cn:" + 口令)` 的**大写** hex。
 *
 *  ⚠ 这**不是**"密码存储"意义上的哈希（固定前缀、无盐、SHA-1），只是移动服务端
 *  用来校验口令的协议字段。本系统自己的口令存储走别的路，两者**不要混用**。 */
export function passwordHash(password: string): string {
  return toHex(sha1(utf8(`${PASSWORD_HASH_PREFIX}${password}`))).toUpperCase();
}

/** 滑块答案的 AES 密钥（客户端 `encryptByAesCBC` 的 `aesKey`）。 */
export const PUZZLE_AES_KEY = 'CREATPUZZLE03F9A';

/** 滑块答案的 AES IV。
 *
 *  ⚠ **硬编码**，不是服务端下发的挑战值 —— 文档里曾把它推测为"服务端挑战标识"
 *  （因为两次请求间保持不变），从源码看它就是这一行常量。 */
export const PUZZLE_AES_IV = 'E526E1F3F9765444';

/** 把滑块答案加密成 `puzzleVerfycode`：AES-128-CBC/PKCS7，输出 `base64(IV ‖ CT)`。
 *
 *  两个易错点：
 *  - 字段名是 `puzzleVerfycode`（`verfy` 不是 `verify`）——
 *    客户端源码在这里专门写了句「大坑！！！」；
 *  - 答案是**拖动像素偏移的十进制字符串**（实测两条真实请求解出来是 `461` / `391`），
 *    不是轨迹点数组。 */
export function puzzleVerfycodeEncrypt(sliderAnswer: string): string {
  return encryptWithDynamicIv(utf8(PUZZLE_AES_KEY), utf8(PUZZLE_AES_IV), sliderAnswer);
}

/** 滑块拼图：两张图 + **缺口坐标**。 */
export interface SliderPuzzle {
  /** 背景图（带缺口的那张，实测是 JPEG），base64。 */
  backgroundB64: string;
  /** 滑块小图，base64。 */
  puzzleB64: string;
  picWidth: number | null;
  puzzleWidth: number | null;
  /** `base64(IV ‖ AES-128-CBC/PKCS7 密文)` —— 解出来就是答案。 */
  leftEncrypted: string;
}

/** 解出滑块答案。
 *
 *  ⚠ **不需要图像识别**，也不需要人眼量像素：`data.puzzleLeft` 就是
 *  `base64(IV ‖ AES-128-CBC/PKCS7 密文)`，密钥是客户端里那个硬编码公开常量。
 *
 *  解出来会做两道自检（必须是十进制数、必须落在图宽内）：宁可报错也不要
 *  把一个荒谬的坐标发上去 —— 那会被判滑块失败，**而失败次数是有限的**。 */
export function sliderAnswer(p: SliderPuzzle): string {
  const plain = decryptWithDynamicIv(utf8(PUZZLE_AES_KEY), p.leftEncrypted).trim();
  if (plain === '' || !/^\d+$/.test(plain)) {
    throw new Error(`滑块缺口坐标不是十进制数：${JSON.stringify(plain)}`);
  }
  const x = Number(plain);
  if (p.picWidth !== null && (x < 0 || x > p.picWidth)) {
    throw new Error(`滑块缺口坐标 ${x} 超出图宽 ${p.picWidth}`);
  }
  return plain;
}

// ══════════════════════════════ 响应信封 ══════════════════════════════

/** `thirdlogin` 一族的响应信封。
 *
 *  ⚠ `code` 可能是**数字**（`200059541`）也可能是**字符串**
 *  （`"0000"` / `"9999"`），两种都在实测里出现过，所以统一归一成数字。 */
export interface LoginEnvelope {
  /** 归一后的业务码。既不是数字也不是数字字符串时为 `null`。 */
  code: number | null;
  /** 原始 code 文本（排障用；归一化会丢掉 `"0000"` 的形态）。 */
  rawCode: string;
  /** 消息。上游用过 `message` 与 `msg` 两个键名。 */
  message: string;
  /** `data` 原样保留。 */
  data: unknown;
}

export function parseLoginEnvelope(body: string): LoginEnvelope {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`登录响应不是 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof v !== 'object' || v === null) throw new Error('登录响应不是 JSON 对象');

  const raw = v['code'];
  const rawCode =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : raw == null ? '' : JSON.stringify(raw);
  // `"0000"` → 0；`"200059541"` → 200059541；非数字文本 → null
  const code = rawCode === '' ? null : /^-?\d+$/.test(rawCode) ? Number(rawCode) : null;

  const msg = v['message'] ?? v['msg'];
  return {
    code,
    rawCode,
    message: typeof msg === 'string' ? msg : '',
    data: v['data'] ?? null,
  };
}

// ══════════════════════════════ 归类 ══════════════════════════════

/** 一次扫码轮询的结果。
 *
 *  刻意**不把"未扫码"当成错误**：轮询期间绝大多数响应都是它，
 *  当成错误会让调用方拿异常做流程控制，日志也会被刷满。 */
export type PollOutcome =
  | { kind: 'not-scanned' }
  | { kind: 'scanned' }
  | { kind: 'session-mismatch' }
  | { kind: 'expired' }
  | { kind: 'too-frequent' }
  /** 登录成功。`encrypted` 是 `data` 原文（AES 密文）。 */
  | { kind: 'success'; encrypted: string }
  /** 其它码：原样带回交给上层判断，**不硬编码成错误** —— 上游在活动期会加新码。 */
  | { kind: 'other'; code: number | null; message: string };

export function classifyPoll(env: LoginEnvelope): PollOutcome {
  switch (env.code) {
    case CODES.QR_NOT_SCANNED:
      return { kind: 'not-scanned' };
    case CODES.QR_SCANNED:
      return { kind: 'scanned' };
    case CODES.QR_MISMATCH:
      return { kind: 'session-mismatch' };
    case CODES.QR_EXPIRED:
      return { kind: 'expired' };
    case CODES.QR_TOO_FREQUENT:
      return { kind: 'too-frequent' };
    default:
      break;
  }
  if (isSuccessCode(env.code)) {
    if (typeof env.data === 'string') return { kind: 'success', encrypted: env.data };
    // 成功码但没有密文载荷：如实报告"形状不对"，**不要伪造一个空凭据**
    return { kind: 'other', code: env.code, message: '登录成功但 data 不是密文字符串' };
  }
  return { kind: 'other', code: env.code, message: env.message };
}

/** 一次"发送验证码"的结果。 */
export type SendSmsOutcome =
  | { kind: 'sent'; remainGetTimes: number | null }
  | { kind: 'need-slider'; captchaType: number | null }
  /** 滑块挑战已作废（失败次数超限）：**必须重新取图**，不能复用旧挑战。 */
  | { kind: 'slider-exhausted'; captchaType: number | null }
  | { kind: 'other'; code: number | null; message: string };

export function classifySendSms(env: LoginEnvelope): SendSmsOutcome {
  const payload = env.data && typeof env.data === 'object' ? (env.data as Record<string, unknown>) : {};
  const captchaType = typeof payload['captchaType'] === 'number' ? payload['captchaType'] : null;

  if (isSuccessCode(env.code)) {
    const remain = payload['remainGetTimes'];
    return { kind: 'sent', remainGetTimes: typeof remain === 'number' ? remain : null };
  }
  if (env.code === CODES.NEED_SLIDER) return { kind: 'need-slider', captchaType };
  if (env.code === CODES.SLIDER_EXHAUSTED) return { kind: 'slider-exhausted', captchaType };
  return { kind: 'other', code: env.code, message: env.message };
}

// ══════════════════════════════ 成功响应的解密 ══════════════════════════════

/** 生产环境的登录数据 AES 密钥。 */
export const LOGIN_AES_KEY = 'qPqDw263XgFgL3u8';

/** 测试环境的登录数据 AES 密钥（`systemEnvironment` 为 11 / 22）。
 *
 *  客户端在测试环境会换这把 key —— 拿生产 key 去打测试环境的表现是
 *  "解出来是乱码"。 */
export const LOGIN_AES_KEY_TEST = '2ErfJus1Ofr@2o24';

/** 解密登录成功响应里 `data` 的 `userInfo`。
 *
 *  ⚠ 是 AES-128 的 **ECB** 模式 + PKCS7（客户端 `common/utils.js: decryptByAes`），
 *  **不是 CBC** —— 模式用错的表现是"解出来是乱码"，而人往往把它当成
 *  "密钥不对"，白查半天。
 *
 *  （写这段注释时踩过一次：把模式名与 PKCS7 用斜杠连写，那个斜杠加星号
 *  会**提前闭合块注释**；报的错是一堆"Invalid character"、指向下面好几行 ——
 *  与真正的位置无关。所以这里改用"加号"连写。） */
export function decryptUserInfo(ciphertext: string, key = LOGIN_AES_KEY): Record<string, unknown> {
  const plain = aesEcbPkcs7DecryptHex(key, ciphertext);
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch (e) {
    throw new Error(
      `userInfo 不是合法 JSON（密钥不对或用错模式都会落到这里）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof v !== 'object' || v === null) throw new Error('userInfo 不是 JSON 对象');
  return v as Record<string, unknown>;
}

// ══════════════════════════════ 凭据 ══════════════════════════════

/** PC 端的 auth 前缀。App 端是 `mobile`。 */
import { PC_AUTH_PREFIX } from './auth.ts';

/** ⚠ 这一个**从这里转出**，定义在 `auth.ts`。
 *
 *  原来这里和 `auth.ts` 各写了一份 `'pc'` —— 那正是"同一个事实有两个常量
 *  就会漂移"的典型：两边不一致时，表现是"登录能出码、但凭据被当成手机端"，
 *  排查时很难联想到是两处常量不一致。 */
export { PC_AUTH_PREFIX } from './auth.ts';
export const APP_AUTH_PREFIX = 'mobile';

/** 拼出整串凭据：`Basic base64("<前缀>:<账号>:<authToken>")`。
 *
 *  ⚠ 前缀**不给默认值**：默认值会让"给 App 的结果套 PC 前缀"静默通过。 */
export function formatAuth(prefix: string, account: string, authToken: string): string {
  if (account === '' || authToken === '') {
    throw new Error('拼 auth 缺少账号或 authToken');
  }
  return `Basic ${toBase64(utf8(`${prefix}:${account}:${authToken}`))}`;
}

/** 手机号掩码：前 2 + `****` + 后 2（`19900000001` → `19****01`）。
 *
 *  长度不足 4 位时**原样返回**：掩码成 `****` 会让"这是个短号"这件事消失，
 *  而短号只可能来自脏数据，原样显示更利于排查。 */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 2)}****${phone.slice(-2)}`;
}

/** 从 `userInfo` 里取 `account` 与 `authToken`，拼出整串凭据。
 *
 *  ⚠ 两个字段都必须是**非空字符串**：上游的 `account` / `authToken` 从来都是
 *  字符串，容忍数字类型只会让"上游改了类型"这件事静默通过。 */
export function authFromUserInfo(userInfo: Record<string, unknown>, prefix = PC_AUTH_PREFIX): string {
  const field = (name: string): string => {
    const v = userInfo[name];
    if (typeof v !== 'string' || v === '') throw new Error(`登录结果缺少字段 ${name}`);
    return v;
  };
  return formatAuth(prefix, field('account'), field('authToken'));
}

/** 登录结果里那个"用户域"ID。
 *
 *  ⚠ **只有登录响应里才有**（`userInfo.userDomainId`）—— 别的接口都不回它，
 *  所以不在这里存下来，后面就没有第二次机会。 */
export function userDomainIdFrom(userInfo: Record<string, unknown>): string {
  const v = userInfo['userDomainId'];
  return typeof v === 'string' ? v : '';
}

// ══════════════════════════════ 请求构造 ══════════════════════════════

/** 给请求补上"端"头与每次新的 `x-yun-tid`（UUID，链路追踪）。
 *
 *  `tid` 由调用方传入而不是在这里生成：这样请求构造函数保持**纯函数**，
 *  才能被逐字段断言（生成随机数会让每次调用结果都不同，测试就只能断言形状）。 */
function withClientHeaders(
  req: BuiltRequest,
  c: PcClient,
  tid: string,
): BuiltRequest {
  return { ...req, headers: { ...req.headers, ...pcHeaders(c), 'x-yun-tid': tid } };
}

function postJson(path: string, body: Record<string, unknown>, base?: string): BuiltRequest {
  return {
    url: `${(base ?? LOGIN_HOST).replace(/\/+$/, '')}${path}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** `POST /user/thirdlogin`（扫码 / 短信 / 账密共用）。 */
export function thirdloginRequest(
  c: PcClient,
  tid: string,
  body: Record<string, unknown>,
  base?: string,
): BuiltRequest {
  return withClientHeaders(postJson(THIRD_LOGIN_PATH, body, base), c, tid);
}

/** `POST /user/sms/getSmsCode`。 */
export function sendSmsCodeRequest(
  c: PcClient,
  tid: string,
  body: Record<string, unknown>,
  base?: string,
): BuiltRequest {
  return withClientHeaders(postJson(SEND_SMS_CODE_PATH, body, base), c, tid);
}

/** `POST /user/verfycode`。 */
export function sliderPuzzleRequest(
  c: PcClient,
  tid: string,
  body: Record<string, unknown>,
  base?: string,
): BuiltRequest {
  return withClientHeaders(postJson(SLIDER_PUZZLE_PATH, body, base), c, tid);
}

// ══════════════════════════════ 滑块图的解析 ══════════════════════════════

/** 从 `/user/verfycode` 的响应里取出滑块挑战。
 *
 *  取不到就报错而不是返回空串：空图片会让人以为"图挂了"，而真实原因往往是
 *  上游换了字段名（那时应该立刻看见**字段名**不对）。 */
export function parseSliderPuzzle(env: LoginEnvelope): SliderPuzzle {
  const payload = env.data;
  if (!payload || typeof payload !== 'object') throw new Error('取滑块响应里没有 data');
  const p = payload as Record<string, unknown>;

  const field = (name: string): string => {
    const v = p[name];
    if (typeof v !== 'string' || v === '') throw new Error(`取滑块响应里缺少 ${name}`);
    return v;
  };
  // 尺寸上游给的是**字符串**，但也容忍数字 —— 这类字段在小步演进的接口里很常见
  const size = (name: string): number | null => {
    const v = p[name];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    return null;
  };

  return {
    backgroundB64: field('picture'),
    puzzleB64: field('puzzle'),
    picWidth: size('picWidth'),
    puzzleWidth: size('puzzleWidth'),
    leftEncrypted: field('puzzleLeft'),
  };
}

// ══════════════════════════════ 会话 ══════════════════════════════

/** 二维码在我们这一侧的有效期。
 *
 *  ⚠ 这是一个**产品取值**，不是实测值：归档里 `200059542 二维码已失效`
 *  只出现过 1 次，推不出时长。取 120 秒 —— 宁可早一点失效让用户重新出码
 *  （代价是一次点击），也不要让用户对着一个已经无效的码干等
 *  （代价是"这软件坏了"）。 */
export const QR_TTL_SECONDS = 120;

/** 扫码轮询间隔。实测客户端是 `setInterval` 1000ms。 */
export const QR_POLL_INTERVAL_MS = 1000;

/** 一次扫码登录会话（落盘的那份）。
 *
 *  ⚠ `deviceId` 与 `sessionId` **都要持久化**：前者是服务端定位设备的凭据，
 *  后者是 `thirdlogin` 的 `dycpwd`。丢任何一个的表现都是轮询卡住。 */
export interface QrSession {
  sessionId: string;
  deviceId: string;
  startedAtMs: number;
  /** 已经看到"已扫码，等确认" —— 界面据此提示用户去手机上点确认。 */
  scanned: boolean;
  /** 已经拿到凭据（凭据本身不在这里，在会话库里）。 */
  done: boolean;
  /** 最后一次轮询的原话，界面直接显示。 */
  lastNote: string;
}

export function newQrSession(deviceId: string, nowMs: number): QrSession {
  return {
    sessionId: newSessionId(),
    deviceId,
    startedAtMs: nowMs,
    scanned: false,
    done: false,
    lastNote: '等手机扫码',
  };
}

/** 这个会话还能撑到什么时候（毫秒时间戳）。 */
export function qrExpiresAt(s: QrSession): number {
  return s.startedAtMs + QR_TTL_SECONDS * 1000;
}

export function qrExpired(s: QrSession, nowMs: number): boolean {
  return nowMs >= qrExpiresAt(s);
}

/** 把一次轮询结果并进会话，返回给界面的读数 + 要不要继续轮询。
 *
 *  ⚠ **不把"未扫码"当错误**（见 `PollOutcome` 的注释）：它返回
 *  `{ stop: false, ok: true }`，界面继续轮。
 *
 *  ⚠ **限流要退避**，不是立刻换张码重试 —— 换码会再吃一次限流。 */
export function applyPoll(
  s: QrSession,
  out: PollOutcome,
  nowMs: number,
): { session: QrSession; stop: boolean; ok: boolean; note: string; encrypted?: string } {
  switch (out.kind) {
    case 'not-scanned':
      return { session: { ...s, lastNote: '等手机扫码' }, stop: false, ok: true, note: '等手机扫码' };
    case 'scanned':
      return {
        session: { ...s, scanned: true, lastNote: '已扫码，去手机上点「确认登录」' },
        stop: false,
        ok: true,
        note: '已扫码，去手机上点「确认登录」',
      };
    case 'success':
      return {
        session: { ...s, done: true, lastNote: '登录成功' },
        stop: true,
        ok: true,
        note: '登录成功',
        encrypted: out.encrypted,
      };
    case 'expired':
      return {
        session: { ...s, lastNote: '二维码过期了，重新出码' },
        stop: true,
        ok: false,
        note: '二维码过期了（超过 120 秒），点「扫码登录」重新出码',
      };
    case 'too-frequent':
      return {
        session: { ...s, lastNote: '扫码太频繁，等一下' },
        // ⚠ **停下来**，不是继续轮。注释与代码一度不一致（注释写"停在这里
        //   让用户自己等"、代码写的 `stop: false`）—— 测试把这条抓出来了。
        //   继续每秒轮的表现是把限流喂得更狠，然后上游给更长的封禁。
        stop: true,
        ok: true,
        note: '扫码登录过于频繁，等一会儿再试（不要重新出码）',
      };
    case 'session-mismatch':
      return {
        session: { ...s, lastNote: '会话对不上，重新出码' },
        stop: true,
        ok: false,
        note: '会话对不上（`sID` 变了），点「扫码登录」重新出码',
      };
    default:
      return {
        session: { ...s, lastNote: `上游说：${out.message || `code=${out.code}`}` },
        stop: true,
        ok: false,
        note: `登录没成：${out.message || `code=${out.code}`}`,
      };
  }
}

/** 一次短信登录会话。 */
export interface SmsSession {
  phone: string;
  random: string;
  startedAtMs: number;
  /** 已经发过码。 */
  sent: boolean;
  /** 已经取过滑块挑战（且还没作废）。 */
  slider: SliderPuzzle | null;
  lastNote: string;
}

export function newSmsSession(phone: string, nowMs: number): SmsSession {
  return {
    phone,
    random: newSmsRandom(),
    startedAtMs: nowMs,
    sent: false,
    slider: null,
    lastNote: '还没发码',
  };
}

/** 验证码有效期（上游实测 5 分钟，界面按这个倒计时）。 */
export const SMS_CODE_TTL_SECONDS = 300;
