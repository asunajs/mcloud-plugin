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
  // ⚠ 含 `PUT`：网盘上传的数据面那枪是 **PUT**（预签名直传）。
  //   宿主 API 的 `method` 是字符串、不收窄（`hostapi.rs:269`），所以这里放开是安全的。
  method: 'GET' | 'POST' | 'PUT';
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
  /** POST 的 content-type。默认 `application/json`；`taskListV3` 要的是
   *  `application/json;charset=UTF-8`（原实现逐字如此，别自作主张统一）。 */
  contentType?: string | undefined;
  /** `activityid` 用的市场名。**各页不同**：签到页 `sign_in_3`、
   *  备份有礼页 `backupgift`（见 `session.rs` 的配方表）。
   *  原实现每次 POST 都拿本次的 marketname 去**先剥再补**这枚头 ——
   *  同名两枚头会让「哪枚生效」变成传输层的事，所以这里是一枚、可覆盖的。 */
  marketName?: string | undefined;
  session: SessionHeaders;
  /** 显式传入随机量与时间戳，测试可复现；生产不传 */
  signInputs?: { id?: string; nonce?: string; timestampMs?: string } | undefined;
}

export interface BuiltRequest {
  url: string;
  // ⚠ 含 `PUT`：网盘上传的数据面那枪是 **PUT**（预签名直传）。
  //   宿主 API 的 `method` 是字符串、不收窄（`hostapi.rs:269`），所以这里放开是安全的。
  method: 'GET' | 'POST' | 'PUT';
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
    activityid: spec.marketName ?? MARKET_NAME,
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
  if (spec.method === 'POST') {
    headers['content-type'] = spec.contentType ?? 'application/json';
  }

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
  infoV3: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/infoV3' },
  startSignIn: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/startSignIn' },
  receiveV3: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/receiveV3' },
  taskExpansion: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/taskExpansion' },
  receiveTaskExpansion: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/receiveTaskExpansion' },
  receiveRevivalReward: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/receiveRevivalReward' },
  multiple: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/multiple' },
  prizeRecord: { origin: MCLOUD_HOST, path: '/ycloud/signin/public/record' },
  cloudRecordV2: { origin: MCLOUD_HOST, path: '/ycloud/signin/public/cloudRecordV2' },
  taskListV2: { origin: MCLOUD_HOST, path: '/ycloud/signin/task/taskListV2' },
  taskListV3: { origin: MCLOUD_HOST, path: '/ycloud/signin/task/taskListV3' },
  // 通知任务（`notice`）：两个端点都在主域，**裸 GET、不带查询参数**。
  // ⚠ "不带参数"本身是个**未验证的选择** —— 实拍的完整 URL 被脱敏，只见到路径。
  //   真要出问题（例如回了另一个活动的状态），改这一处加参数即可。
  // 兑换清单：**只读**，查询串只有 client 与 clientVersion，**不带 deviceId**
  exchangeList: { origin: MCLOUD_HOST, path: '/ycloud/signin/page/exchangeList' },
  noticeInfo: { origin: MCLOUD_HOST, path: '/ycloud/openemailsms-service/openEmailsms/getTaskInfo' },
  noticeReward: { origin: MCLOUD_HOST, path: '/ycloud/openemailsms-service/openEmailsms/reward' },
  backupGiftInfo: { origin: BACKUP_GIFT_HOST, path: '/market/backupgift/info' },
  backupGiftReceive: { origin: BACKUP_GIFT_HOST, path: '/market/backupgift/receive' },
  // 消息推送奖励（msgpushon 那一页）—— **同一台主机、不同一族**
  msgPushStatus: { origin: BACKUP_GIFT_HOST, path: '/market/msgPushOn/task/status' },
  msgPushObtain: { origin: BACKUP_GIFT_HOST, path: '/market/msgPushOn/task/obtain' },
} as const;

export type EndpointName = keyof typeof EP;

/** 端点 → 绝对 URL。
 *
 *  `base` 非空时**替换整个源**（把上游指到 mock / 别的环境），端点自带的源被丢掉。
 *  第一版我用的是 `base + EP.x` 前缀拼接 —— 那是错的：`EP.x` 原本是**绝对 URL**，
 *  拼出来是 `http://127.0.0.1:9https://m.mcloud.139.com/…`（测试当场抓到）。
 *  正确模型是「端点 = 源 + 路径」，替换的是源。 */
export function resolveUrl(name: EndpointName, base?: string | undefined): string {
  const ep = EP[name];
  return base ? base + ep.path : ep.origin + ep.path;
}

/** `Referer` 用的签到页地址（原实现按端点给不同值，这里集中成常量，便于以后按端点细化）。 */
export const REFERER_SIGN_IN = `${MCLOUD_HOST}/mcloud/sign_in/index.html`;

/** `showloading` 头的值。
 *
 *  ⚠️ 是字符串 `'true'`，**不是 `'1'`** —— 原实现每次都传字面量 `"true"`
 *  （`h5(…, "true")`）。我第一版写的是 `'1'`，纯属自己脑补。 */
export const SHOW_LOADING = 'true';

/** 每个端点的**方法**与附加项 —— 逐条从原实现抄下来的表。
 *
 *  为什么值得占一块地方：我第一版凭「这些看着像 POST」把 `infoV3` 写成了 POST，
 *  结果真面板里发出去收到 **405 Method Not Allowed**。405 是个很含糊的信号
 *  （它不说「你该用 GET」），而这两个家族（GET 带 query / POST 带 json body）
 *  混起来很容易写错。表放在这里，下一条任务照着抄就行。
 *
 *  来源：`mcloud-upstream` 里各 `*_request()` 函数的 `HttpRequest::get/post`。 */
export const EP_METHOD: Record<string, 'GET' | 'POST'> = {
  infoV3: 'GET', //  ?client=app（有 deviceId 时再 &deviceId=…）
  startSignIn: 'GET', //  ?client=app（有 deviceId 时再 &deviceId=…）
  receiveV3: 'POST', // json body
  taskExpansion: 'GET',
  // 更正记录：这一条我起初写成 POST，查 `receive_task_expansion_request` 后改成 GET
  // （`h5(false, HttpRequest::get(url), "true")`）。表是从源码抄的，抄错就会得到 405——
  // 而 405 只会说"方法不对"，不会说"该用哪个"。
  receiveTaskExpansion: 'GET',
  receiveRevivalReward: 'POST', // json body `{}`
  multiple: 'GET',
  prizeRecord: 'GET', // 带 query 参数
  cloudRecordV2: 'GET', // 带 query 参数
  taskListV2: 'POST', // body 带 group=<组名>
  taskListV3: 'POST', // body 带 group=""（空串）
  exchangeList: 'GET',
  noticeInfo: 'GET',
  noticeReward: 'GET', // 写（会真入账），但上游用 GET
  backupGiftInfo: 'GET', // 另一个域
  backupGiftReceive: 'GET', // 另一个域
  msgPushStatus: 'GET',
  msgPushObtain: 'POST', // 这一族用 POST，body `{"type":2}`
};

/** `infoV3` / `startSignIn` 这类 GET 端点带的固定 query。 */
export const CLIENT_QUERY = 'client=app';

/** 任务清单 V3 的请求体：**`group` 是空字符串**、`clientVersion` 三段。
 *
 *  复刻自 `app_task_list_v2.rs::task_list_v3_request`，那里的注释说明了它为什么可信：
 *  实拍没存下 body，但 `content-length: 62` 能逐字节对出来正好是下面这个串 ——
 *  空 body 与带 `client` 两种写法都试过，**都 404**。 */
export function taskListV3Body(market: string = MARKET_NAME): string {
  return JSON.stringify({ marketname: market, clientVersion: TASK_CLIENT_VERSION, group: '' });
}

/** 任务清单 V3 用的 content-type（注意 charset 后缀）。 */
export const TASK_LIST_V3_CONTENT_TYPE = 'application/json;charset=UTF-8';
