// 手机端（App）验证码登录 —— 参考实现 `mcloud/crates/mcloud-upstream/src/app_login.rs`。
//
// # 为什么单独一个模块，而不是给 `login.ts` 加个平台开关
//
// App 与 PC 走的是**同一个接口** `POST /user/thirdlogin`，但**没有一处可以复用**：
//
// | | PC 端 | App 端 |
// |---|---|---|
// | `pintype` | `"21"` / `"5"` / `"9"` | **`"8"`**（短信也是 8，不是 5）|
// | `clienttype` | `"656"` / `"710"` | **`"412"`** |
// | `cpid` | `"277"` / `"332"` | **`"55"`** |
// | 请求体 | 明文 JSON | **AES-128-ECB + 末 10 位错位的 hex** |
// | AES 密钥 | `qPqDw263XgFgL3u8` | **`lYzvvBMUjucw+h^R`** |
// | `extInfo.ifOpenAccount` | 数字 `1` | **字符串 `"1"`** |
// | `getSmsCode` 的 `mode`/`reqType` | 数字 | **字符串** |
// | `Authorization` 首段 | `pc` | **`mobile`** |
//
// 所以这里**刻意不参数化平台**：把两端塞进一个泛型构造器，只会让"传错端"变成
// 一个能静默通过的选项 —— 而那正好是最容易犯的错（把 PC 的密钥搬到 App 路径上，
// 上游回 `9103`）。
//
// # 三层封装，第三层是 App 独有的
//
// ```text
// 第 1 层  明文 JSON
// 第 2 层  AES-128-ECB/PKCS7  →  384 个 hex 字符
// 第 3 层  末 10 个字符移到最前（错位）   ← App 独有，PC 没有
// ```
//
// 第 3 层**不是加密**，只是一次字符串旋转；但少做这一步服务端会回
// `9103 输入参数不合法`，因为它要先反旋转再解密。
//
// # 一个不需要真登录成功的判据
//
// `9103` / `9441` 构成**二值判别器**：
//
// | 送出的体 | 期望响应 |
// |---|---|
// | 加密体 + 生产密钥 + 末 10 位错位 | `9441 验证码不正确` |
// | 同一个密文但**不旋转** | `9103 输入参数不合法` |
// | 明文 JSON（没加密） | `9103 输入参数不合法` |
//
// 回 `9441` 就说明密钥、模式、填充、错位方向、hex 大小写**全部正确** ——
// 因为服务端是"先反旋转、再解密、再解析"才可能走到校验验证码那一步。

import { aesEcbPkcs7EncryptHex, aesEcbPkcs7DecryptHex } from '../crypto/aes.ts';

// ══════════════════════════════ 常量 ══════════════════════════════

/** 登录体的 AES 密钥（`isCurrentEnvironment = YES` 那一支）。
 *
 *  反汇编实证：客户端里它是 `csel` 选出来的**字面量**，不是从配置取的 ——
 *  所以客户端改个变量名不影响我们，改的是这个常量本身。 */
import type { BuiltRequest } from './h5.ts';

export const APP_LOGIN_AES_KEY = 'lYzvvBMUjucw+h^R';

/** 备用密钥（`isCurrentEnvironment = NO` 那一支）。
 *
 *  ⚠ **它不是"测试环境密钥"**：客户端只是按一个布尔位二选一，实测生产流量
 *  走的是上面那把。留它是因为「用错这把会得到 `9103`」是排查密钥问题
 *  最快的判据。 */
export const APP_LOGIN_AES_KEY_ALT = '+09T5lHhO+smS7x@';

/** `getSmsCode` 请求体里的 `random`：**客户端硬编码的常量**。
 *
 *  不是"一个随机值的示例"：跨一个月的全部 4 次 `getSmsCode` 请求它都是
 *  同一个 `qwert`。一个真正随机的值不可能每次相同。
 *
 *  所以它**不做成参数** —— 参数会暗示"这里可以也应该变化"。 */
export const SEND_SMS_RANDOM = 'qwert';

/** App 端 `clienttype` / `clientType`（两者同值、**大小写不同**）。 */
export const APP_CLIENT_TYPE = '412';

/** App 端 `cpid`。 */
export const APP_CPID = '55';

/** App 端版本号（也是设备串第 4 段）。 */
export const APP_VERSION = '12.6.0';

/** App 端渠道号。 */
export const APP_CHANNEL = '10000020';

/** `service_identifier_key` 请求头的值。 */
export const APP_SERVICE_IDENTIFIER = 'service_identifier_userDomain';

/** App 端 `User-Agent`（括号里 `iOS` 大写，与设备串的 `ipados` 大小写不同）。 */
export const APP_USER_AGENT = 'mCloud_iPhone/12.6.0 (iPad; iOS 26.6; Scale/2.00)';

/** App 端 `x-UserAgent`（低版本号形态）。 */
export const APP_X_USER_AGENT = '412|iPad|ios 26.6|12.6.0-200';

/** App 端 `x-yun-user-agent`。 */
export const APP_X_YUN_USER_AGENT = 'iPad|iPad|ios 26.6|mCloud12.6.0-200';

/** `x-DeviceName` 的 base64（`aVBhZA==` = `iPad`）。 */
export const APP_DEVICE_NAME_B64 = 'aVBhZA==';

/** 设备串里的局域网地址（实测值，非真实用户网络）。 */
export const APP_DEFAULT_IP = '192.168.3.179';

/** App 端设备型号。 */
export const APP_DEVICE_MODEL = 'iPad8,6';

/** 发码接口。 */
export const APP_SEND_SMS_CODE_PATH = '/user/sms/getSmsCode';

/** 登录接口（与 PC **同一个**，靠请求体区分）。 */
export const APP_THIRDLOGIN_PATH = '/user/thirdlogin';

// ══════════════════════════ 错位（第 3 层）══════════════════════════

/** 末 10 个字符移到最前。**加密方向**。
 *
 *  ⚠ 方向写反的话服务端回 `9103`（不是解密失败那种报错）—— 很容易误判成
 *  "参数不对"去查字段名。参考实现为此专门有黄金值测试钉住方向。 */
export function shiftTail10ToFront(hex: string): string {
  if (hex.length <= 10) return hex;
  return hex.slice(-10) + hex.slice(0, -10);
}

/** 前 10 个字符移到最后。**解密方向**（就是上面那步的逆）。 */
export function shiftHead10ToBack(hex: string): string {
  if (hex.length <= 10) return hex;
  return hex.slice(10) + hex.slice(0, 10);
}

// ══════════════════════════ 加解密 ══════════════════════════

/** 明文 → 线上请求体（hex 字符串，**小写**）。 */
export function encryptBody(plaintext: string, key: string = APP_LOGIN_AES_KEY): string {
  return shiftTail10ToFront(aesEcbPkcs7EncryptHex(key, plaintext));
}

/** 线上响应 `data` → 明文。
 *
 *  ⚠ 两步都**必须**成功。错位不改变字符集，所以"只反错位不解密"也能得到
 *  一个看起来正常的 hex 串 —— 那种情况下会解出乱码而不是报错。
 *  靠 AES 的 PKCS7 校验兜底（解错必然填充非法）。 */
export function decryptBody(wireHex: string, key: string = APP_LOGIN_AES_KEY): string {
  return aesEcbPkcs7DecryptHex(key, shiftHead10ToBack(wireHex.trim()));
}

// ══════════════════════════ 请求体（纯函数）══════════════════════════

/** `/user/sms/getSmsCode` 的请求体。
 *
 *  三个**易错点**，抓包里都能对上：
 *
 *  1. **所有值都是字符串**（PC 端这里 `mode` / `reqType` 是数字）——
 *     `"mode":"0"` 不是 `"mode":0`
 *  2. 字段名是 `puzzleVerfycode` —— 上游自己就把 `verify` 拼成了 `verfy`
 *  3. 首次请求它是**空串**，不是 `null`、也不是省略字段
 */
export function sendSmsCodeBody(phone: string, puzzleVerfycode = ''): Record<string, unknown> {
  return {
    mode: '0',
    phoneNumber: phone,
    reqType: '3',
    clientType: APP_CLIENT_TYPE,
    random: SEND_SMS_RANDOM,
    puzzleVerfycode,
  };
}

/** `/user/thirdlogin` 的请求体（**明文**，加密交给 {@link encryptBody}）。
 *
 *  ⚠ 键序：参考实现的黄金值是按**排序后**的键算的，而这里用对象字面量 ——
 *  JS 的 `JSON.stringify` 按**插入顺序**输出。两者的密文**不同**，但**都对**
 *  （服务端不关心键序）。要逐字节对上黄金值的话，用
 *  {@link smsThirdloginBodySorted}。 */
export function smsThirdloginBody(
  phone: string,
  smsCode: string,
  random: string,
): Record<string, unknown> {
  return {
    cpid: APP_CPID,
    extInfo: { ifOpenAccount: '1' },
    dycpwd: smsCode,
    pintype: '8',
    loginMode: '0',
    verType: '1',
    version: APP_VERSION,
    msisdn: phone,
    random,
    clienttype: APP_CLIENT_TYPE,
  };
}

/** 同 {@link smsThirdloginBody}，但键**按字典序**排 —— 与参考实现的黄金值逐字节可比。
 *
 *  存在的理由：那两条黄金值测试是"加密 + 错位"唯一能离线验证的判据，
 *  而它们钉的是**排序后**的明文。留一个显式排序的构造器，测试才真的在测实现。 */
export function smsThirdloginBodySorted(
  phone: string,
  smsCode: string,
  random: string,
): Record<string, unknown> {
  const raw = smsThirdloginBody(phone, smsCode, random);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw).sort()) out[k] = raw[k];
  return out;
}

/** 生成登录体里的 `random`：6 位大小写字母 + 数字。
 *
 *  形状取自实测（`hOjseB`）。它**不参与任何可观测的校验** —— 依据是
 *  `getSmsCode` 那个同名字段是硬编码常量，服务端照样受理。
 *
 *  ⚠ 诚实记一笔：`thirdlogin` 的 `random` **只有 1 个样本**，
 *  "每次不同"是从"客户端为什么要随机"推的，**不是实测到的**。
 */
export function newLoginRandom(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ══════════════════════════ 设备串与请求头 ══════════════════════════

/** App 端 `x-DeviceInfo`。 */
export function appDeviceInfo(deviceId: string): string {
  return (
    `1|${APP_DEFAULT_IP}|2|${APP_VERSION}|APPLE|${APP_DEVICE_MODEL}|${deviceId}` +
    `|AAA000000000|ipados 26.6|375 * 667|zh-Hans-CN|0.0000|0.0000|`
  );
}

/** App 端 `x-yun-client-info`：设备串 + `x-DeviceName` 的 base64 + `0|;`。 */
export function appClientInfo(deviceId: string): string {
  return `${appDeviceInfo(deviceId)}${APP_DEVICE_NAME_B64}|0|;`;
}

/** 登录链路要带的**全部** App 设备头。
 *
 *  # 为什么是一整套而不是最小集合
 *
 *  实测：缺设备头时上游回 `9999 登录失败！` —— 也就是**"头不对"的失败长得像
 *  "登录被拒"**，很容易误判成账号问题。所以照抓包给全套。
 *
 *  # ⚠ 刻意**不发** `hcy-cool-flag`
 *
 *  抓包里 App 是带这个头的，但实测：**只要带上它**（任意值），服务端就会把响应体
 *  换成一段 144 字节的加密串，而我们**没有那把密钥**（试过错位前后、也试过
 *  SM4-ECB，都解不开）。不发它时语义与抓包完全一致（同样回 `200059554`）。
 *
 *  这是"照抄抓包"与"能跑起来"冲突时唯一说得通的选择 —— 所以这里**不是漏了**，
 *  是**故意不发**。
 */
export function appHeaders(deviceId: string, timestamp: number): Record<string, string> {
  return {
    Pragma: 'no-cache',
    'x-yun-user-timestamp': String(timestamp),
    'x-yun-app-channel': APP_CHANNEL,
    'x-yun-net-type': '1',
    'x-yun-svc-type': '1',
    'x-huawei-channelSrc': APP_CHANNEL,
    'x-yun-api-version': 'v1',
    'x-UserAgent': APP_X_USER_AGENT,
    'x-yun-client-info': appClientInfo(deviceId),
    'Accept-Language': 'zh-CN',
    service_identifier_key: APP_SERVICE_IDENTIFIER,
    'User-Agent': APP_USER_AGENT,
    'x-DeviceName': APP_DEVICE_NAME_B64,
    'x-DeviceInfo': appDeviceInfo(deviceId),
    'x-yun-user-agent': APP_X_YUN_USER_AGENT,
    'x-SvcType': '1',
    // ⚠ 这里**故意没有** `hcy-cool-flag`（见上面的说明）。
    //   要加的话响应体会变成一段没有密钥的加密串。
    'Content-Type': 'application/json;charset=UTF-8',
  };
}

// ══════════════════════ 请求构造 ══════════════════════
//
// ⚠ 主机与 PC 那条**是同一个**（`user-njs.yun.139.com`）—— 参考实现里
//   `SEND_SMS_CODE` / `THIRD_LOGIN` 都在 `endpoints.rs`，和 PC 的同一个域。
//   差别全在**请求头**（App 那套）与**请求体**（App 的字段 + 第三枪要加密）。

/** 登录服主机。与 PC 那条共用（见上面那段说明）。 */
export const APP_LOGIN_HOST = 'https://user-njs.yun.139.com';

/** App 端的一枪。
 *
 *  ⚠ `rawBody` 是**已经拼好的字符串**，不是对象 —— 因为 `/user/thirdlogin`
 *  的体是**加密后的 hex 文本**（`Content-Type` 仍是
 *  `application/json;charset=UTF-8`，抓包原样如此，别"顺手改成 text/plain"）。
 *  收对象的话，加密这一步就会被推到调用点 —— 而"忘了加密"必须**在类型层面
 *  不可能发生**（参考实现的原话）。 */
export function appPost(
  path: string,
  rawBody: string,
  deviceId: string,
  timestamp: number,
): BuiltRequest {
  return {
    url: `${APP_LOGIN_HOST}${path}`,
    method: 'POST',
    headers: appHeaders(deviceId, timestamp),
    body: rawBody,
  };
}

/** 发验证码（**明文体**）。`puzzleVerfycode` 是过滑块时带回来的答案，首次为空。 */
export function appSendSmsCodeRequest(
  deviceId: string,
  timestamp: number,
  phone: string,
  puzzleVerfycode = '',
): BuiltRequest {
  return appPost(
    APP_SEND_SMS_CODE_PATH,
    JSON.stringify(sendSmsCodeBody(phone, puzzleVerfycode)),
    deviceId,
    timestamp,
  );
}

/** 换凭据（**加密体**）。
 *
 *  ⚠ 明文进、密文出：加密在**这里**完成。调用点拿不到"忘了加密"这个选项。 */
export function appThirdloginRequest(
  deviceId: string,
  timestamp: number,
  phone: string,
  smsCode: string,
  random: string,
  key: string = APP_LOGIN_AES_KEY,
): BuiltRequest {
  const plaintext = JSON.stringify(smsThirdloginBody(phone, smsCode, random));
  return appPost(APP_THIRDLOGIN_PATH, encryptBody(plaintext, key), deviceId, timestamp);
}
