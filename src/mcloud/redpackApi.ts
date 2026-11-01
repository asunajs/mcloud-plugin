// 红包派对（移动云手机的活动站）—— **协议层**：只造请求、只解响应，不认识"该不该发"。
//
// # 这一族为什么单独一套
//
// 它挂在**另一个站点**上，跟仓库里已有的族都不共用凭据：
//
// | 族 | 站点 | 凭证 |
// |---|---|---|
// | 签到族 / 网盘 | `m.mcloud.139.com`、`*.yun.139.com` | `jwttoken` / `Authorization` |
// | 消息推送 / 备份好礼 | `caiyun.feixin.10086.cn` | `jwttoken` |
// | **红包派对** | **`cpactiv.buy.139.com/cloudphone-market`** | **它自己的 `token` 头** |
//
// 那个 `token` 是用 SSO 票向 `/user/tokenValidate` 换来的，**不能**拿网盘的
// `Authorization` 或 H5 的 `jwttoken` 顶替。而 `cpactiv.buy.139.com` **不在**
// `cloudUpload.ts::AUTH_DOMAINS` 那四条后缀里 ⇒ 传输层不会往这一族注入凭据（这是对的）。
//
// # 证据等级：零抓包，依据是参照实现**跑通过的读数**
//
// `mcloud-capture` 里搜不到任何 `cpactiv` 的样本（含 `har/` 全量），所以路径与字段名
// **不是**逐字实拍来的。但我手上有更硬的一格：参照实现自己**真跑成功过**，那一次的
// 逐行产出留了档（`mcloud-sign/packages/api/data/history.json` 里 2026-09-16 两条账号
// 的运行，3.7s / 3.9s 都判成功）。⇒ 这一族的**语义**（状态码、金额单位、任务表结构）
// 有真实读数撑着；**线格式**没有。所以：
//
// * 请求形状照"那一次成功运行经由的那套 http 层"复刻（含 UA / `deviceid`，见下面
//   {@link redpackHeaders} 的注释）—— 这不是"旧实现这么做所以我也这么做"，
//   而是那是手上唯一一份**已知能拿到 200 的**请求形状；
// * 任何"上游大概会……"的话都不写，真跑第一次的读数才算数（见 `tasks/redpack.ts` 文件头）。
//
// # 信封与签到族**不是一回事**
//
// 签到族判成功看 `code`（0 / "0000"），这一族看 `String(header.status) === "200"`，
// 错误文案按 `data.errorMsg → header.errMsg → header.respMsg` 依次取。
// ⇒ 不能套 `envelope.ts::parseSignInEnvelope`（那个会把形状不认识的响应悄悄判成成功）。

import { callRawText } from './client.ts';
import type { Transport } from './client.ts';
import type { BuiltRequest } from './h5.ts';
import { rootOrDefault } from './h5.ts';
import { md5Hex } from '../crypto/index.ts';

// ───────────────────────── 常量（逐字照参照实现）─────────────────────────

/** 业务路径前缀。界面/CI 要指到 mock 时替换的是**根**（见 `loadRedpackBase`）。 */
export const REDPACK_BASE = 'https://cpactiv.buy.139.com/cloudphone-market';

/** 活动页地址（`x-origin` 头，**不是** `Origin` 头）。 */
export const REDPACK_ORIGIN =
  'https://cpactiv.buy.139.com/#/redEnvelopeParty/home?loginType=0&enableShare=1&channelSrc=red-mcloudapp-001';

/** 除 `tokenValidate` 外，每条请求体里的 `version`。 */
export const REDPACK_VERSION = 'SYS_CONFIG_Y';

/** `tokenValidate` 请求体里的 `version` —— ⚠ **故意与其余 16 条不同**。
 *
 *  参照实现的 `req()` 先写 `{version: SYS_CONFIG_Y, ...data}`，而它 `tokenValidate`
 *  的 `data` 里又有一个 `version: "1.0"`，对象展开是**后面的赢** ⇒ 发出去的是 `"1.0"`。
 *  顺手统一成 `SYS_CONFIG_Y` 就会打到一个上游不认的版本上。 */
export const REDPACK_TOKEN_VALIDATE_VERSION = '1.0';

export const REDPACK_APP_ID = '12345681';
export const REDPACK_CHANNEL_SRC = 'red-mcloudapp-001';

/** 签名里的盐。参照实现里就是**明文写死在源码**里的，不是运行时下发的。 */
export const REDPACK_SIGN_SALT = 'e10adc3949ba59abbe56e057f20f883e';

/** `x-DeviceInfo` 的固定中段（写死的 iPad 串，与实际跑在什么设备上无关）。 */
export const REDPACK_DEVICE_INFO_HEAD =
  '|h5|1.0.0|v1.0.0||Mozilla/5.0 (iPad; CPU OS 18_5) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/12.6.0 iPad AppLanguage/zh-CN|';

/** `x-DeviceInfo` 的后半段（屏幕那一截）。 */
export const REDPACK_DEVICE_INFO_TAIL = '|||375X667|zh||';

/** 活动站那一族在 HTTP 层上的固定 UA。
 *
 *  ⚠ 它与 `x-DeviceInfo` 里那串 **iPad** UA 是两回事：前者是**传输层**默认头，
 *  后者是业务头 —— 参照实现那一次成功的运行**两串都发了**。
 *  这里跟着发，理由不是"旧实现发了"，而是**那是唯一一份已知能拿到 200 的请求形状**。 */
export const REDPACK_HTTP_UA =
  'Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36';

/** `tokenValidate` 请求体里的 `pintype` 与 `loginConfig`。 */
export const REDPACK_PINTYPE = 13;
export const REDPACK_LOGIN_CONFIG = 'redpacketLoginConfig';

/** 请求体里那条链共用的 `platformType`。 */
export const REDPACK_PLATFORM_TYPE = 1;

/** 信封判成功的那个值（**字符串比**，上游给的是数字 200）。 */
export const REDPACK_STATUS_OK = '200';

/** 任务状态码（参照实现 `statusText` 那张表）。 */
export const REDPACK_STATUS_TODO = 0;
export const REDPACK_STATUS_DONE = 1;
export const REDPACK_STATUS_SOLD_OUT = 3;
export const REDPACK_STATUS_TOMORROW = 4;

/** 换 SSO 票时的 `toSourceId` —— 别的族各有各的值（001003 / 001005 / 001248 / 这一条）。 */
export const REDPACK_SSO_SOURCE_ID = '001216';

// ───────────────────────── 签名与头 ─────────────────────────

/** 一次调用要带的"每次现算"的四样东西。
 *
 *  ⚠ `timestampMs` 与 `requestId` 里那段毫秒**必须是同一个值**：签名含 `requestId`，
 *  两边不同就会差 1ms 而对不上（参照实现里那是两次 `Date.now()`，属它手滑）。 */
export interface RedpackCall {
  token: string;
  timestampMs: number;
  requestId: string;
  /** `x-DeviceInfo` 里跟在时间戳后面的随机段 */
  deviceRand: string;
}

/** 签名配方：`md5(requestId + appId + token + salt + timestamp)`。
 *
 *  ⚠ **五项的顺序就是配方本身**，中间**没有任何分隔符** —— 少一项、换一次序都会
 *  得到一个形状完全合法、上游直接拒的签名。所以它由外部算出来的摘要钉死
 *  （见 `test/redpackApi.test.ts`，不是拿 `md5Hex` 自证）。 */
export function redpackSign(requestId: string, token: string, timestampMs: number): string {
  return md5Hex(`${requestId}${REDPACK_APP_ID}${token}${REDPACK_SIGN_SALT}${timestampMs}`);
}

/** `yyyyMMddHHmmss`（**本地**时刻，照参照实现用 `new Date()` 的 getter）。 */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

/** 小写 base36 随机片段（长度固定 —— 参照实现那个 `Math.random().toString(36)`
 *  偶尔会短几位，上游只看"一串字母数字"，定长更稳，也不参与任何判据）。 */
function base36(len: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(Math.random() * 36)];
  return s;
}

/** 造一次调用。测试把 `inputs` 传进来就能复现整条请求。 */
export function makeRedpackCall(
  token: string,
  nowMs: number,
  inputs: { requestId?: string; deviceRand?: string } = {},
): RedpackCall {
  const requestId = inputs.requestId ?? `${localStamp(nowMs)}${nowMs}${base36(8)}`;
  return { token, timestampMs: nowMs, requestId, deviceRand: inputs.deviceRand ?? base36(16) };
}

/** 这一族的 10 枚业务头（外加传输层默认那两枚）。
 *
 *  ⚠ `token` 在**换票那一枪**里是空串，签名也按空串算（见 `tokenValidateRequest`）：
 *  头和签名都由同一个 `RedpackCall` 出，不会出现"头是空的、签名按有票算"。 */
export function redpackHeaders(call: RedpackCall, deviceId = ''): Record<string, string> {
  const ts = String(call.timestampMs);
  return {
    appId: REDPACK_APP_ID,
    token: call.token,
    sign: redpackSign(call.requestId, call.token, call.timestampMs),
    timestamp: ts,
    requestId: call.requestId,
    xChannelSrc: REDPACK_CHANNEL_SRC,
    'x-DeviceInfo': `${REDPACK_DEVICE_INFO_HEAD}${ts}${call.deviceRand}${REDPACK_DEVICE_INFO_TAIL}`,
    'x-origin': REDPACK_ORIGIN,
    Referer: 'https://cpactiv.buy.139.com/',
    Origin: 'https://cpactiv.buy.139.com',
    // 下面两枚是参照实现那层 HTTP 的默认头（见 `REDPACK_HTTP_UA` 的注释）。
    'user-agent': REDPACK_HTTP_UA,
    ...(deviceId === '' ? {} : { deviceid: deviceId }),
  };
}

/** 基址口子（CI / 真跑前的探针指到 mock 用）。空 = 真站点。 */
export function redpackUrl(base: string | undefined, path: string): string {
  return `${rootOrDefault(base, REDPACK_BASE)}${path}`;
}

/** 一条业务请求：`POST <base><path>`，体是 `{version, ...data}`。
 *
 *  ⚠ 体里**不写** `content-type`：那是传输层补的（见 `client.ts::applyDefaultContentType`），
 *  散到构造器里就会漏 —— 而这一族的网关和网盘那族一样，缺它可能直接路由不到。 */
export function redpackPost(
  call: RedpackCall,
  path: string,
  data: Record<string, unknown>,
  opts: { base?: string | undefined; version?: string; deviceId?: string } = {},
): BuiltRequest {
  const version = opts.version ?? REDPACK_VERSION;
  return {
    url: redpackUrl(opts.base, path),
    method: 'POST',
    headers: redpackHeaders(call, opts.deviceId ?? ''),
    body: JSON.stringify({ version, ...data }),
  };
}

// ───────────────────────── 17 条请求 ─────────────────────────
//
// 只读 9 条：configTaskLoginList / userAccountInfo / userToastInfo / configTopicList /
// thirdQueryUserRelationshipV2 / configAppList / gethwToken /
// instanceApkInstallStatus / appInstallTaskStatus。
// 写 7 条（+ 有副作用的 getRcsToken）：userSign / userCompleteTask / userBrowse /
// userTopicAnswer / apkInstall / userInstallApp。
// ⚠ 这一层**只构造**；发不发由 `tasks/redpack.ts` 按 `userStatus` 判。

/** ② 用 SSO 票换这一族自己的 token。**它自己不带业务 `version` 之外的一切**。
 *
 *  ⚠ 头里的 `token` 与签名**按空串**算（照参照实现），`ssoToken` 是**请求体**里的字段。 */
export function tokenValidateRequest(
  call: RedpackCall,
  ssoToken: string,
  deviceId: string,
  base?: string | undefined,
): BuiltRequest {
  const anon: RedpackCall = { ...call, token: '' };
  return redpackPost(
    anon,
    '/user/tokenValidate',
    {
      version: REDPACK_TOKEN_VALIDATE_VERSION,
      pintype: REDPACK_PINTYPE,
      token: ssoToken,
      deviceId,
      loginConfig: REDPACK_LOGIN_CONFIG,
    },
    { base, version: REDPACK_TOKEN_VALIDATE_VERSION, deviceId },
  );
}

/** 任务表（只读）。整趟的判据都从这一发来。 */
export const taskListRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/redpacket/configTaskLoginList', {}, { base });

/** 余额（只读）。 */
export const accountInfoRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/redpacket/userAccountInfo', { platformType: REDPACK_PLATFORM_TYPE }, { base });

/** 每日签到（**写**）。 */
export const userSignRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/redpacket/userSign', { platformType: REDPACK_PLATFORM_TYPE }, { base });

/** 登记"这条任务做了"（**写**）。`taskId` 原样发回（上游给的是数字还是字符串都照它）。 */
export const completeTaskRequest = (call: RedpackCall, taskId: number | string, base?: string) =>
  redpackPost(
    call,
    '/redpacket/userCompleteTask',
    { platformType: REDPACK_PLATFORM_TYPE, taskId },
    { base },
  );

/** 浏览确认（**写**）：按 `taskCode` 报，不是 id。 */
export const browseRequest = (call: RedpackCall, taskCode: string, base?: string) =>
  redpackPost(call, '/redpacket/userBrowse', { taskCode }, { base });

/** 这一条任务刚拿到的奖（只读）。 */
export const toastInfoRequest = (call: RedpackCall, taskCode: string, base?: string) =>
  redpackPost(call, '/redpacket/userToastInfo', { configTaskCode: taskCode }, { base });

/** 题库（只读）。 */
export const topicListRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/redpacket/configTopicList', {}, { base });

/** 交答案（**写**）。`taskId` / `topicId` 要**数字**（参照实现 `Number(...)`）。 */
export const topicAnswerRequest = (
  call: RedpackCall,
  taskId: number,
  topicId: number,
  answer: string,
  base?: string,
) =>
  redpackPost(
    call,
    '/redpacket/userTopicAnswer',
    { taskId, topicId, answer, platformType: REDPACK_PLATFORM_TYPE },
    { base },
  );

/** 云手机列表（只读）。`status` 两档都要问：ACTIVE 在用、PENDING 待激活。 */
export const cloudPhonesRequest = (
  call: RedpackCall,
  status: 'ACTIVE' | 'PENDING',
  base?: string,
) =>
  redpackPost(
    call,
    '/thirdapi/huawei/thirdQueryUserRelationshipV2',
    { pageNumber: 1, pageSize: 10, status },
    { base },
  );

/** 华为侧的 token（只读，装机那支要用它当参数）。 */
export const hwTokenRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/user/gethwToken', {}, { base });

/** 云机侧会话票（**有副作用**：它算"进过一次云机"）。 */
export const rcsTokenRequest = (call: RedpackCall, targetSourceId = '0', base?: string) =>
  redpackPost(call, '/user/getRcsToken', { targetSourceId }, { base });

/** 可装的应用列表（只读）。 */
export const appListRequest = (call: RedpackCall, base?: string) =>
  redpackPost(call, '/redpacket/configAppList', { platformType: REDPACK_PLATFORM_TYPE }, { base });

/** 某台云机上这些包的装机状态（只读）。 */
export const installStatusRequest = (
  call: RedpackCall,
  hwToken: string,
  instanceId: string,
  packageName: string,
  base?: string,
) =>
  redpackPost(
    call,
    '/app/activity/instanceApkInstallStatus',
    { hwToken, apkList: [packageName], instanceIdList: [instanceId] },
    { base },
  );

/** 装机任务的进度（只读轮询）。 */
export const installTaskStatusRequest = (
  call: RedpackCall,
  hwToken: string,
  installTaskId: string,
  base?: string,
) =>
  redpackPost(call, '/app/activity/appInstallTaskStatus', { taskId: installTaskId, hwToken }, { base });

/** 真的往云机里装一个包（**写**，装到用户的云手机上）。
 *  ⚠ `appId` 这一发要的是 `packageId` 的**字符串**形式，而下一发上报要的是 `id`。 */
export const apkInstallRequest = (
  call: RedpackCall,
  instanceId: string,
  packageId: string,
  hwToken: string,
  base?: string,
) =>
  redpackPost(call, '/app/activity/apkInstall', { instanceId, appId: packageId, hwToken }, { base });

/** 向活动站上报装机结果（**写**）。`existed = 1` 表示"本来就已经装了"。 */
export const reportInstallRequest = (
  call: RedpackCall,
  taskId: number | string,
  appId: number | string,
  existed: number | undefined,
  base?: string,
) => {
  const data: Record<string, unknown> = { taskId, appId, platformType: REDPACK_PLATFORM_TYPE };
  if (existed !== undefined) data.existed = existed;
  return redpackPost(call, '/redpacket/userInstallApp', data, { base });
};

// ───────────────────────── 信封与取值 ─────────────────────────

export interface RedpackEnvelope {
  /** `String(header.status) === "200"` */
  ok: boolean;
  /** 原样的 `header.status`（`undefined` = 没这一格） */
  status: unknown;
  /** `data` 那一格（对象 / 数组都原样给出去） */
  data: unknown;
  /** 人话失败原因（`ok` 时是 `undefined`） */
  error: string | undefined;
  /** 响应原文（解析不出 JSON 时日志要能贴出它） */
  raw: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 错误文案的取法：`data.errorMsg` → `header.errMsg` → `header.respMsg` → 兜底。
 *  （`data` 是数组时它没有 `errorMsg`，那就照后两档走。） */
export function redpackError(env: unknown, fallback = '活动站没给原因'): string {
  if (!isRecord(env)) return fallback;
  const data = env.data;
  const fromData = isRecord(data) ? data.errorMsg : undefined;
  const header = isRecord(env.header) ? env.header : {};
  const first = [fromData, header.errMsg, header.respMsg].find(
    (x) => typeof x === 'string' && x.trim() !== '',
  );
  return typeof first === 'string' ? first.trim() : fallback;
}

/** 解这一族的信封。**非 JSON 不当成功**（参照实现判的是 `header.status`，
 *  形状完全不对时它 likewise 判失败），但错误要说清是"不是 JSON"还是"status 不对"。 */
export function parseRedpackEnvelope(body: string): RedpackEnvelope {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return {
      ok: false,
      status: undefined,
      data: undefined,
      error: `活动站回的不是 JSON：${e instanceof Error ? e.message : String(e)}`,
      raw: body,
    };
  }
  if (!isRecord(v)) {
    return { ok: false, status: undefined, data: undefined, error: '活动站回的不是对象', raw: body };
  }
  const header = isRecord(v.header) ? v.header : {};
  const status = header.status;
  const ok = String(status) === REDPACK_STATUS_OK;
  return { ok, status, data: v.data, error: ok ? undefined : redpackError(v), raw: body };
}

/** 发一枪并解信封（HTTP 层失败与业务失败都折成 `ok: false` + 人话）。 */
export function callRedpack(
  transport: Transport,
  req: BuiltRequest,
): RedpackEnvelope & { httpError: string | undefined } {
  const res = callRawText(transport, req);
  if (!res.ok) {
    const why = res.error ?? '未知失败';
    // 非 200 时 body 里常常才是真原因（有些活动站把错误写在正文里）
    const env = res.text === '' ? undefined : parseRedpackEnvelope(res.text);
    return {
      ok: false,
      status: env?.status,
      data: env?.data,
      error: env && !env.ok && env.error !== undefined ? `${why} ${env.error}` : why,
      raw: res.text,
      httpError: why,
    };
  }
  return { ...parseRedpackEnvelope(res.text), httpError: undefined };
}

/** `data` 里取一个数字（数字与数字字符串都收；其余给 `undefined`）。 */
export function rpNum(data: unknown, key: string): number | undefined {
  if (!isRecord(data)) return undefined;
  const v = data[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** `data` 里取一个非空字符串。 */
export function rpStr(data: unknown, key: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** `data` 里取一个数组（不是数组 ⇒ `[]`）。 */
export function rpArr(data: unknown, key: string): unknown[] {
  if (!isRecord(data)) return [];
  const v = data[key];
  return Array.isArray(v) ? v : [];
}

export { isRecord as redpackIsRecord };
