// 登录会话的**落盘**：设备指纹 + 三种登录各自的会话状态。
//
// # 为什么设备指纹必须落盘（这一层存在的首要理由）
//
// 二维码的 `dID` 就是设备指纹，而服务端**按它定位"这次扫码是哪台设备"**。
// 每次重新生成的表现是轮询**永远停在** `200059541 未找到设备的二维码信息`
// —— 而这看起来像"码过期了"，极难往"设备号变了"上想。
//
// 所以它在**第一次用到时生成、之后一直复用**（`loadDeviceId`）。
// 面板的插件沙箱里没有"进程级常量"这种东西：每次任务运行是同一个 VM，
// 但**面板重启 / 插件重载**会重来 —— 所以只能落库。
//
// # 为什么登录会话也要落盘
//
// 登录是**跨请求**的（用户扫个码要几秒到几十秒，中间面板可能重启）。
// 会话放内存的话，用户扫完码回来点「我扫完了」会得到"没有正在进行的登录" ——
// 而那时候二维码在服务端还是有效的，只是我们这边忘了。


import type { Store } from '../store/types.ts';
import {
  DEFAULT_PC_PLATFORM,
  QR_TTL_SECONDS,
  newPcDeviceId,
  newQrSession,
  newSmsSession,
  parsePcPlatform,
  qrExpired,
  qrRemainingMs,
  type PcPlatform,
  type QrSession,
  type SmsSession,
  type SliderPuzzle,
} from './login.ts';
import { newLoginRandom, type AppSession } from './appLogin.ts';
import { sha1, toHex } from '../crypto/index.ts';
import { utf8 } from '../crypto/bytes.ts';

/** 设备指纹（PC 客户端形态的 `dID`）。**持久化，见文件头。** */
export const STATE_DEVICE_ID = 'mcloud.login.deviceId';

/** 正在进行的扫码会话。 */
export const STATE_QR_SESSION = 'mcloud.login.qr';

/** 正在进行的短信会话。 */
export const STATE_SMS_SESSION = 'mcloud.login.sms';

/** 正在进行的**手机端（App）**登录。
 *
 *  ⚠ 与 `sms` **分开一格**。两端的滑块语义不同（PC 取图自己解；App 真机是开
 *  WebView，短信由那个 H5 发），响应分类也不同（App 的成功载荷是**密文字符串**）。
 *  共用一格的话，"进行中的是哪一端"就得靠猜。 */
export const STATE_APP_SESSION = 'mcloud.login.app';

/** 登录方式与平台的记忆（下一次开界面时预填）。值是 `windows` / `macos`。
 *
 *  ⚠ **它不是身份来源**：身份是每次登录时冻结进会话的那一个（`QrSession.platform`）。
 *  这一格只回答"上次用的是哪种形态"，给弹窗预填用 —— 出码那一刻用户选了什么，
 *  这一趟就用什么，哪怕之后再改这一格也影响不到进行中的会话。 */
export const STATE_LOGIN_PREF = 'mcloud.login.pref';

/** 登录那一族接口的主机（空 = 真上游）。**与云盘业务基址不是同一个口子。** */
export const STATE_LOGIN_BASE = 'mcloud.login.base';

/** 登录结果里的 `userDomainId`。
 *
 *  ⚠ **只有登录响应里才有它** —— 别的接口都不回，所以不在这里存下来，
 *  后面就没有第二次机会。 */
export const STATE_LOGIN_DOMAIN = 'mcloud.login.userDomainId';

/** 取设备指纹，没有就生成一个**并落盘**。
 *
 *  ⚠ 这个函数有副作用（第一次调用会写库）—— 这是刻意的：
 *  把"生成"和"落盘"分开的话，调用方漏掉落盘那一步的表现就是
 *  上面说的"轮询永远停在 200059541"，而那个错**看不出是这里的错**。 */
export function loadDeviceId(store: Store, nowIso: string): string {
  const cur = store.getState(STATE_DEVICE_ID);
  if (cur !== undefined && cur !== null && cur !== '') return cur;
  const fresh = newPcDeviceId();
  store.setState(STATE_DEVICE_ID, fresh, nowIso);
  return fresh;
}

/** 换一个设备指纹（"我的码一直扫不出来"时的救命按钮）。
 *
 *  ⚠ 换了之后**旧会话必须一起清掉**：旧会话的 `dID` 是旧指纹，
 *  继续轮它只会一直 `200059541`。 */
export function resetDeviceId(store: Store, nowIso: string): string {
  const fresh = newPcDeviceId();
  store.setState(STATE_DEVICE_ID, fresh, nowIso);
  clearLogin(store);
  return fresh;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as T;
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    // 库里那段坏了（手改过 / 老版本写的）⇒ 当作"没有会话"，
    // 而不是让整个登录路由 500（那会让用户点什么都失败）
    return null;
  }
}

/** 老会话没有 `tid` 时的补法：**从 `sessionId` 推出来**，不随机。
 *
 *  ⚠ 随机会让"每次读都换一个"—— 那等于没补（同一趟轮询里两次读到不同的 tid，
 *  就又回到"每轮换一个问话的人"那个毛病上）。推出来的这个天然稳定，
 *  跨请求、跨面板重启都一样。
 *
 *  ⚠ 只对**升级前存下的**会话有意义（新会话出码时就带着随机 tid）。这类会话
 *  最长也只活 120 秒，所以推出来的值不需要"不可预测"—— 它只是这一次问话的名字。 */
function derivedTid(sessionId: string): string {
  const h = toHex(sha1(utf8(`mcloud-qr-tid:${sessionId}`)));
  // 拼成 UUID 的样子（版本 4 / variant a）：上游与日志都按这个形态认
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function loadQrSession(store: Pick<Store, 'getState'>): QrSession | null {
  const s = parseJson<QrSession>(store.getState(STATE_QR_SESSION));
  if (s === null) return null;
  // 形状自检：缺字段的老数据当没有（`sessionId` 丢了就没法继续轮）
  if (typeof s.sessionId !== 'string' || typeof s.deviceId !== 'string') return null;
  // ⚠ `platform` 是后加的格子：老会话没有它 ⇒ 按默认形态继续轮，**不要把会话判死**
  //   （判死的表现是"面板升级后，正在进行的那张码突然变成没有会话"）。
  // ⚠ `tid` 同理：升级前存的会话没有它 ⇒ 补一个。补出来的这个从此**固定**，
  //   不能每轮再换（见 `QrSession.tid` 的说明）。
  return {
    ...s,
    platform: parsePcPlatform(s.platform) ?? DEFAULT_PC_PLATFORM,
    tid: typeof s.tid === 'string' && s.tid !== '' ? s.tid : derivedTid(s.sessionId),
  };
}

export function saveQrSession(store: Store, s: QrSession, nowIso: string): void {
  store.setState(STATE_QR_SESSION, JSON.stringify(s), nowIso);
}

export function loadSmsSession(store: Pick<Store, 'getState'>): SmsSession | null {
  const s = parseJson<SmsSession>(store.getState(STATE_SMS_SESSION));
  if (s === null) return null;
  if (typeof s.phone !== 'string' || typeof s.random !== 'string') return null;
  return { ...s, platform: parsePcPlatform(s.platform) ?? DEFAULT_PC_PLATFORM };
}

export function saveSmsSession(store: Store, s: SmsSession, nowIso: string): void {
  store.setState(STATE_SMS_SESSION, JSON.stringify(s), nowIso);
}

/** 清掉正在进行的登录（换方式 / 取消 / 成功之后都要清）。 */
export function loadAppSession(store: Pick<Store, 'getState'>): AppSession | null {
  return parseJson<AppSession>(store.getState(STATE_APP_SESSION));
}

export function saveAppSession(store: Store, a: AppSession, nowIso: string): void {
  store.setState(STATE_APP_SESSION, JSON.stringify(a), nowIso);
}

export function startAppSession(store: Store, phone: string, nowMs: number, nowIso: string): AppSession {
  const a: AppSession = {
    phone,
    // ⚠ 用 App 的随机串构造（`newLoginRandom`），**不是** PC 那个 ——
    //   它是 `smsThirdloginBody` 的一个字段，两端格式不同。
    random: newLoginRandom(),
    startedAtMs: nowMs,
    sent: false,
    slider: null,
    lastNote: '还没发码',
  };
  saveAppSession(store, a, nowIso);
  return a;
}

export function clearLogin(store: Store): void {
  store.setState(STATE_QR_SESSION, '', new Date().toISOString());
  store.setState(STATE_SMS_SESSION, '', new Date().toISOString());
  store.setState(STATE_APP_SESSION, '', new Date().toISOString());
}

/** 开一次扫码登录：**用已有的设备指纹**，不要新生成。
 *
 *  `platform` 由调用方给（用户在这一趟出码前选的那一个）—— 它会被**冻结进会话**，
 *  之后轮询照它发请求，见 `QrSession.platform`。 */
export function startQrSession(
  store: Store,
  nowMs: number,
  nowIso: string,
  platform: PcPlatform = DEFAULT_PC_PLATFORM,
): QrSession {
  const deviceId = loadDeviceId(store, nowIso);
  const s = newQrSession(deviceId, nowMs, platform);
  saveQrSession(store, s, nowIso);
  return s;
}

/** 开一次短信登录。形态同样**冻进会话**（发码 / 取滑块 / 提交三步同一套档案）。 */
export function startSmsSession(
  store: Store,
  phone: string,
  nowMs: number,
  nowIso: string,
  platform: PcPlatform = DEFAULT_PC_PLATFORM,
): SmsSession {
  const s = newSmsSession(phone, nowMs, platform);
  saveSmsSession(store, s, nowIso);
  return s;
}

export function setSmsSlider(
  store: Store,
  s: SmsSession,
  slider: SliderPuzzle | null,
  nowIso: string,
): SmsSession {
  const next: SmsSession = { ...s, slider };
  saveSmsSession(store, next, nowIso);
  return next;
}

/** 扫码轮询间隔（毫秒）。**由插件这一侧给**，界面不许自己写死一个数。
 *
 *  ⚠ 这条规矩有来处：参考实现的注释写着「客户端写死一个数会和状态机分叉」。
 *
 *  ⚠ **1000ms，照参考实现**：客户端源码是 `setInterval(…, 1000)`，
 *  `mcloud` 那边是 `QR_POLL_INTERVAL_MS: u64 = 1000`。这一侧原来写 2000 ——
 *  而真机上扫码成功那一枪**只出现一次**（拿到就没了），2 秒一档等于一半的
 *  机会直接跳过它（F-071）。慢一点省的那点上游压力，换不回一次白扫。
 *
 *  ⚠ 为什么放在这里（而不是路由那一层）：界面**不只在出码那一次**需要它 ——
 *  页面刷新 / 面板重启之后，会话还活着（它是落盘的），那时界面得**接着轮**，
 *  而它手上只有读数。所以间隔必须跟着读数一起下去。 */
export const QR_POLL_MS = 1000;

/** 登录页要的读数（一次给全，界面只调一个接口）。
 *
 *  ⚠ 凭据**不进这里**（见 accounts.ts 的文件头：只给界面看掩码过的形状）。 */
export interface LoginReading {
  deviceId: string;
  qr: {
    active: boolean;
    sessionId: string;
    payload: string;
    /** 这张码是按哪种形态出的。界面据此把「客户端形态」那两个按钮摆到
     *  **跟这张码一致**的位置 —— 否则用户会看到一个"选了 macOS、码却是
     *  Windows 的"界面，而两个都不是错的。 */
    platform: PcPlatform;
    /** 接着轮的时候用这个间隔（见 `QR_POLL_MS`）。 */
    pollMs: number;
    scanned: boolean;
    expiresInMs: number;
    expired: boolean;
    note: string;
  } | null;
  sms: {
    active: boolean;
    phone: string;
    /** 这一趟短信登录用的形态。理由同 `qr.platform`。 */
    platform: PcPlatform;
    sent: boolean;
    hasSlider: boolean;
    /** 滑块图（base64）—— 要渲染给人看，所以必须给界面。 */
    slider: SliderPuzzle | null;
    expiresInMs: number;
    note: string;
  } | null;
  /** 手机端（App 那条）。形状与 `sms` 一样 —— 见 `loginReading` 里那段说明。 */
  app: {
    active: boolean;
    phone: string;
    sent: boolean;
    hasSlider: boolean;
    slider: SliderPuzzle | null;
    expiresInMs: number;
    note: string;
  } | null;
}

export function loginReading(
  store: Pick<Store, 'getState'>,
  nowMs: number,
  qrPayloadOf: (sessionId: string, deviceId: string) => string,
): LoginReading {
  const qr = loadQrSession(store);
  const sms = loadSmsSession(store);
  return {
    deviceId: store.getState(STATE_DEVICE_ID) ?? '',
    qr:
      qr === null
        ? null
        : {
            active: true,
            sessionId: qr.sessionId,
            payload: qrPayloadOf(qr.sessionId, qr.deviceId),
            platform: qr.platform,
            pollMs: QR_POLL_MS,
            scanned: qr.scanned,
            expiresInMs: qrRemainingMs(qr, nowMs),
            expired: qrExpired(qr, nowMs),
            note: qr.lastNote,
          },
    sms:
      sms === null
        ? null
        : {
            active: true,
            phone: sms.phone,
            platform: sms.platform,
            sent: sms.sent,
            hasSlider: sms.slider !== null,
            slider: sms.slider,
            // 验证码 5 分钟（上游实测），从**发码**那一刻算 —— 这里用会话开始时刻近似
            expiresInMs: Math.max(0, sms.startedAtMs + 300_000 - nowMs),
            note: sms.lastNote,
          },
    // 手机端（App 那条）。形状与 `sms` 刻意一致 —— 界面上两者的进度显示一样，
    // 差别只在**这一趟走的是哪一套头/体**，而那件事由页签决定，不用读数来说。
    app: (() => {
      const a = loadAppSession(store);
      return a === null
        ? null
        : {
            active: true,
            phone: a.phone,
            sent: a.sent,
            hasSlider: a.slider !== null,
            slider: a.slider,
            expiresInMs: Math.max(0, a.startedAtMs + 300_000 - nowMs),
            note: a.lastNote,
          };
    })(),
  };
}
