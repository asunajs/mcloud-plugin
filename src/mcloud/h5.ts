// 签到族（H5）的请求构造。
//
// 复刻自 `crates/mcloud-upstream/src/app_signin.rs` 的 `h5()` +
// `session.rs` 的 `h5_headers()`。**纯函数**，不发请求 —— 这样构造逻辑可以
// 单独测（头对不对、签名对不对），发请求那层在 client.ts。
//
// 原实现的模块文档点明了两个头族的区别，这里照抄：
//   - App 原生：`Authorization` + 设备头（**无签名**）
//   - H5：`activityid` / `appversion` / `jwttoken`（+ 我们的签名头）
// 本文件只管 H5。
//
// 踩过的坑（都写在原实现注释里，值得留在这）：
//   * 头名是小写 `jwttoken`，不是 `jwtToken` —— H5 拦截器原样如此，别自作主张驼峰化
//   * `appversion` 是**四段** `12.6.0.0`；body 里的 `clientVersion` 是**三段** `12.6.0`。
//     混用会得到一个「看着对」的请求
//   * `activityid` 跟着本次的 `marketname` 走，**不是**恒定 `sign_in_3`

import { signHeadersWith } from './sign.ts';
import { nonce as newNonce, uuidV4 } from './rand.ts';

/** 签到页的市场名。多数端点用它，但 `activityid` 必须跟本次的 marketname 走。 */
export const MARKET_NAME = 'sign_in_3';
/** H5 的 `appversion`：**四段**。 */
export const H5_APP_VERSION = '12.6.0.0';
/** body 里的 `clientVersion`：**三段**。 */
export const TASK_CLIENT_VERSION = '12.6.0';

/** 会话里与请求头有关的东西。来源是本插件自己的 state 表（见 store.ts）。 */
export interface SessionHeaders {
  /** H5 令牌；建会话那几步没有它 */
  jwt?: string | undefined;
  /** 设备号（`deviceid`） */
  deviceId?: string | undefined;
  /** `user-agent` */
  userAgent?: string | undefined;
  /** cookie 串（`k=v; k2=v2`） */
  cookie?: string | undefined;
}

export interface H5RequestSpec {
  url: string;
  method: 'GET' | 'POST';
  /** POST 的 body（字符串，通常是 JSON 文本）；GET 时忽略 */
  body?: string | undefined;
  /** `Referer`。原实现按端点给不同的值 */
  referer: string;
  /** `showloading` 头 */
  showLoading: string;
  /** 是否带 `isdeviceid: true`（原实现按端点决定） */
  isDeviceId: boolean;
  /** 签名盐表的 key */
  saltKey: number;
  /** 签名里 `other` 段（多数端点是空串） */
  other?: string | undefined;
  session: SessionHeaders;
  /** 显式传入随机量与时间戳，测试可复现；生产不传 */
  signInputs?: { id?: string; nonce?: string; timestampMs?: string } | undefined;
}

export interface BuiltRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | undefined;
}

/** 构造一个 H5 请求（含签名头）。 */
export function buildH5Request(spec: H5RequestSpec): BuiltRequest {
  const ts = spec.signInputs?.timestampMs ?? String(Date.now());
  const sign = signHeadersWith(
    spec.signInputs?.id ?? uuidV4(),
    spec.signInputs?.nonce ?? newNonce(),
    ts,
    spec.saltKey,
    spec.other ?? '',
  );

  const headers: Record<string, string> = {
    Accept: '*/*',
    // ⚠ 跟本次的 marketname 走，不是恒定的 sign_in_3
    activityid: MARKET_NAME,
    appversion: H5_APP_VERSION,
    Referer: spec.referer,
    showloading: spec.showLoading,
  };
  if (spec.isDeviceId) headers.isdeviceid = 'true';
  // 头名小写：`jwttoken`
  if (spec.session.jwt) headers.jwttoken = spec.session.jwt;
  if (spec.session.deviceId) headers.deviceid = spec.session.deviceId;
  if (spec.session.userAgent) headers['user-agent'] = spec.session.userAgent;
  if (spec.session.cookie) headers.cookie = spec.session.cookie;
  if (spec.method === 'POST') headers['content-type'] = 'application/json';

  return {
    url: spec.url,
    method: spec.method,
    headers: { ...headers, ...sign },
    body: spec.method === 'POST' ? (spec.body ?? 'null') : undefined,
  };
}

// ── 端点（来自 mcloud-upstream 的常量，逐字照抄）────────────────────────────

export const MCLOUD_HOST = 'https://m.mcloud.139.com';
/** 备份好礼在另一个域（`caiyun.feixin.10086.cn`），原实现单独列出来 */
export const BACKUP_GIFT_HOST = 'https://caiyun.feixin.10086.cn';

export const EP = {
  infoV3: `${MCLOUD_HOST}/ycloud/signin/page/infoV3`,
  startSignIn: `${MCLOUD_HOST}/ycloud/signin/page/startSignIn`,
  receiveV3: `${MCLOUD_HOST}/ycloud/signin/page/receiveV3`,
  taskExpansion: `${MCLOUD_HOST}/ycloud/signin/page/taskExpansion`,
  receiveTaskExpansion: `${MCLOUD_HOST}/ycloud/signin/page/receiveTaskExpansion`,
  receiveRevivalReward: `${MCLOUD_HOST}/ycloud/signin/page/receiveRevivalReward`,
  multiple: `${MCLOUD_HOST}/ycloud/signin/page/multiple`,
  prizeRecord: `${MCLOUD_HOST}/ycloud/signin/public/record`,
  cloudRecordV2: `${MCLOUD_HOST}/ycloud/signin/public/cloudRecordV2`,
  taskListV2: `${MCLOUD_HOST}/ycloud/signin/task/taskListV2`,
  taskListV3: `${MCLOUD_HOST}/ycloud/signin/task/taskListV3`,
  backupGiftInfo: `${BACKUP_GIFT_HOST}/market/backupgift/info`,
  backupGiftReceive: `${BACKUP_GIFT_HOST}/market/backupgift/receive`,
} as const;

/** `Referer` 用的签到页地址（原实现按端点给不同值，这里集中成常量，便于以后按端点细化）。 */
export const REFERER_SIGN_IN = `${MCLOUD_HOST}/mcloud/sign_in/index.html`;
