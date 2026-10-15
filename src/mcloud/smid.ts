// smid 设备指纹：把 `deviceid` 换回来的那条链。
//
// # 为什么需要它
//
// 领取类接口（`receiveV3`）必须带一个 H5 的 `deviceId`：不带回 `615`、带错回 `614`，
// 而这两句的文案都是「活动太火爆啦」——**看起来像限流**（见 findings F-018）。
//
// # 它在干什么
//
// `deviceid` **不是本地算出来的串**：客户端把一份 WebView 特征加密上报，
// cmpassport 的风控服务回一个 `deviceId`，客户端在前面拼一个 `B` 当自己的设备 id。
//
// ```text
// uid = randomUUID()
//   ├─ ep     = RSA-PKCS1v15(uid)        公钥 1024 位
//   └─ priId  = md5(uid)[0..16]          下面那份特征的 AES 密钥
// 特征体（`desTarget`）→ tn = md5(getTn(体)) → 写回 tn
//   → 按 DES_RULE 逐字段 DES 加密 + 改名
//   → JSON → gzip（OS=19）→ base64
//   → AES-CBC（固定 IV，密钥 priId）→ hex      = data
// POST https://slw.h5cmpassport.com:9090/deviceprofile/v4
//   {appId, organization, ep, data, os:"web", encode:5, compress:2}
//   → code == 1100 → deviceId = "B" + detail.deviceId
// ```
//
// # ⚠ 生命周期：**稳定的那一半按账号存下来复用**
//
// mcloud 的实测结论（`smid.rs` 文件头）：旧实现**每跑一次就重随机一份特征**，
// 等于同一台机器每次上报都长成另一台机器的样子 —— 那正是最容易触发风控核验的姿态。
// 所以这里拆成两半：
//
// | | 会不会变 | 处理 |
// |---|---|---|
// | 屏幕 / dpr / platform / 触点数 / RTT / cpu 数 / canvas | 真机上**不变** | **按账号存**，复用 |
// | smid / vpw / trees / 时间戳 svm·pmf / 电量 | 每次都变 | 每次现算，**不落盘** |
// | `deviceId`（`B…`） | 服务端发的，会变 | 每次上报重新取 |
//
// # 来源
//
// 字段清单、取值池、`getTn` 的规则、`DES_RULE` 表都照
// `mcloud-sign/packages/shared/src/smid/index.ts`（TS 版，它走 crypto-js）
// 与 mcloud 的 `smid.rs`（Rust 版）**同一口径**；四个加密原语是本仓自己实现的
// （面板的插件沙箱不提供 crypto，见 `src/crypto/`）。
//
// ⚠ 但那两位在**一处**不一致，我们照 Rust：非 ASCII 的 DES 填充（见 `crypto/des.ts`）。


import { md5Hex } from '../crypto/index.ts';
import { aesEncryptCompatHex } from '../crypto/aes.ts';
import { desEncryptBase64 } from '../crypto/des.ts';
import { gzipWithOs19Base64 } from '../crypto/gzip.ts';
import { rsaEncryptBase64 } from '../crypto/rsa.ts';
import { utf8 } from '../crypto/index.ts';
import { rootOrDefault } from './h5.ts';
import { uuidV4 } from './rand.ts';
import { DES_RULE, SKLAND_SM_CONFIG } from './smidRules.ts';
import type { DesRules } from './smidRules.ts';
import type { BuiltRequest } from './h5.ts';
import type { Store } from '../store/types.ts';

/** 上报主机（**不是**云盘的域，所以也不走 `baseUrl` 覆盖的那套端点表）。 */
export const SMID_HOST = `${SKLAND_SM_CONFIG.protocol}://${SKLAND_SM_CONFIG.apiHost}`;
export const SMID_PATH = SKLAND_SM_CONFIG.apiPath;
/** 成功码 —— ⚠ **数字** 1100，与云盘那批字符串码（`"0000"`）不是一类。 */
export const SMID_OK_CODE = 1100;
/** `deviceId` 的前缀，拿到 `detail.deviceId` 后硬拼上去的那一个字母。 */
export const DEVICE_ID_PREFIX = 'B';

/** 上报体的头（照 TS 版逐字）。 */
export const SMID_UA =
  'Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36';
export const SMID_ORIGIN = 'https://m.mcloud.139.com';
export const SMID_REFERER = 'https://m.mcloud.139.com/portal/mobilecloud/index.html';
const SMID_PAGE_URL =
  'https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=1002&token=';
const SMID_PLUGINS =
  'ChromePDFViewerPortableDocumentFormatinternal-pdf-viewer2,' +
  'ChromiumPDFViewerPortableDocumentFormatinternal-pdf-viewer2,' +
  'MicrosoftEdgePDFViewerPortableDocumentFormatinternal-pdf-viewer2,' +
  'PDFViewerPortableDocumentFormatinternal-pdf-viewer2,' +
  'WebKitbuilt-inPDFPortableDocumentFormatinternal-pdf-viewer2';

/** 特征里**稳定**的那一半（生成一次、按账号存下来复用）。 */
export interface SmFingerprint {
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  platform: string;
  maxTouchPoints: number;
  connectionRtt: number;
  cpucount: number;
  canvas: string;
}

const SCREENS: readonly (readonly [number, number])[] = [
  [375, 667],
  [390, 844],
  [414, 896],
  [360, 640],
  [360, 740],
  [412, 915],
  [1920, 1080],
  [1366, 768],
];
const PLATFORMS: readonly string[] = ['Linux armv8l', 'Linux aarch64'];
const DPRS: readonly number[] = [2, 3];
const TOUCH_POINTS: readonly number[] = [1, 5];
const CONNECTION_RTTS: readonly number[] = [50, 100, 150];
const CPU_COUNTS: readonly number[] = [4, 6, 8, 10, 12];

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

/** 掷一份**新**的稳定特征。只在"库里还没有"或"主动换指纹"时调 —— 别每次上报都调。 */
export function newFingerprint(rnd: () => number = Math.random): SmFingerprint {
  const s = pick(SCREENS, rnd);
  return {
    screenWidth: s[0],
    screenHeight: s[1],
    dpr: pick(DPRS, rnd),
    platform: pick(PLATFORMS, rnd),
    maxTouchPoints: pick(TOUCH_POINTS, rnd),
    connectionRtt: pick(CONNECTION_RTTS, rnd),
    cpucount: pick(CPU_COUNTS, rnd),
    // canvas 是一个 8 位 hex 摘要 —— 它也是"这台设备"的特征，所以同样只掷一次
    canvas: md5Hex(uuidV4()).slice(0, 8),
  };
}

export const STATE_FINGERPRINT = 'mcloud.smid.fingerprint';

/** 读已存的稳定特征；没有（或存坏了）就返回 `null`。 */
export function loadFingerprint(store: Pick<Store, 'getState'>): SmFingerprint | null {
  const raw = store.getState(STATE_FINGERPRINT);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SmFingerprint>;
    if (typeof v.screenWidth !== 'number' || typeof v.canvas !== 'string') return null;
    return {
      screenWidth: v.screenWidth,
      screenHeight: v.screenHeight ?? v.screenWidth,
      dpr: v.dpr ?? 2,
      platform: v.platform ?? 'Linux armv8l',
      maxTouchPoints: v.maxTouchPoints ?? 1,
      connectionRtt: v.connectionRtt ?? 50,
      cpucount: v.cpucount ?? 4,
      canvas: v.canvas,
    };
  } catch {
    return null;
  }
}

/** 取一份可用的稳定特征：有就用，没有就掷一份并**存下来**。 */
export function ensureFingerprint(
  store: Store,
  nowIso: string,
  rnd: () => number = Math.random,
): SmFingerprint {
  const had = loadFingerprint(store);
  if (had) return had;
  const fp = newFingerprint(rnd);
  store.setState(STATE_FINGERPRINT, JSON.stringify(fp), nowIso);
  return fp;
}

/** `getTn`：特征体的摘要输入。**规则逐条照抄，别按直觉改。**
 *
 *  1. 键名**排序**（排序本身是内容的一部分）；
 *  2. `number` 一律 `* 10000`（非整数先 `floor` 再乘）；
 *  3. `object`（含数组，不含 `null`）递归；
 *  4. 其余 `String(v)`，其中 `null` ⇒ `"null"`（**不是空串**）。 */
export function getTn(obj: Record<string, unknown>): string {
  const out: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (typeof v === 'number') {
      out.push(String(Number.isInteger(v) ? v * 10000 : Math.floor(v * 10000)));
    } else if (typeof v === 'object' && v !== null) {
      out.push(getTn(v as Record<string, unknown>));
    } else {
      out.push(String(v));
    }
  }
  return out.join('');
}

/** `smid` 串：内嵌 `yyyyMMddHHmmss` + 一个现生成的 uuid 的 md5。**每次都变**，不落盘。 */
export function buildSmid(d: Date, uid: string): string {
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  const timeStr =
    p(d.getFullYear(), 4) + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) +
    p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2);
  const v = `${timeStr}${md5Hex(uid)}00`;
  return `${v}${md5Hex(`smsk_web_${v}`).slice(0, 14)}0`;
}

/** 一份**加密前**的特征体（稳定的一半 + 现掷的那一半）。
 *
 *  `rnd` 是入参 ⇒ 给定同一份特征、同一个时间、同一个随机源，整份体**逐字节可复现**。 */
export function buildSmBody(
  fp: SmFingerprint,
  box: string,
  now: Date,
  rnd: () => number = Math.random,
): Record<string, unknown> {
  const level = Math.round(rnd() * 100) / 100;
  const body: Record<string, unknown> = {
    protocol: 4,
    organization: SKLAND_SM_CONFIG.organization,
    appId: SKLAND_SM_CONFIG.appId,
    os: 'web',
    version: '3.0.0',
    sdkver: '3.0.0',
    box,
    rtype: 'all',
    smid: buildSmid(now, uuidV4()),
    subVersion: '1.0.0',
    time: 7,
    platform: fp.platform,
    clientSize: `0_0_0_0_${fp.screenWidth}_${fp.screenHeight}_${fp.screenWidth}_${fp.screenHeight}`,
    res: `${fp.screenWidth}_${fp.screenHeight}_${fp.dpr}_2`,
    status: '0010',
    timezone: -480,
    vpw: uuidV4(),
    svm: now.getTime(),
    trees: uuidV4(),
    pmf: now.getTime(),
    cdp: 0,
    maxTouchPoints: fp.maxTouchPoints,
    connectionRtt: fp.connectionRtt,
    cpucount: fp.cpucount,
    battery: { charging: pick([0, 1], rnd), level },
    canvas: fp.canvas,
    plugins: SMID_PLUGINS,
    referer: '',
    ua: SMID_UA,
    url: SMID_PAGE_URL,
    tn: '',
  };
  // ⚠ `tn` 最后算、**写回自己**（摘要的输入是"还没有 tn 的那一份"）
  body.tn = md5Hex(getTn(body));
  return body;
}

/** 按 `DES_RULE` 逐字段加密 + 改名。
 *
 *  ⚠ **没有规则也算一遍**（原样带出去）：漏掉"只改名"的那三条
 *  （`box`→`aw`、`protocol`、`version`）会让字段名原样发出去。 */
export function encryptByDesRules(
  obj: Record<string, unknown>,
  rules: DesRules = DES_RULE,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const rule = rules[key];
    if (!rule) {
      out[key] = value;
      continue;
    }
    if (rule.is_encrypt === 1) {
      out[rule.obfuscated_name] = desEncryptBase64(String(value), rule.key ?? '');
    } else {
      out[rule.obfuscated_name] = value;
    }
  }
  return out;
}

/** 两层加密：特征体 → DES 逐字段 → gzip(OS=19, base64) → AES-CBC(hex)。 */
export function encryptSmBody(
  body: Record<string, unknown>,
  priId: string,
  rules: DesRules = DES_RULE,
): string {
  const gz = gzipWithOs19Base64(utf8(JSON.stringify(encryptByDesRules(body, rules))));
  return aesEncryptCompatHex(priId, gz);
}

/** 组装上报请求（**纯函数**：给定输入就给出确定的字节）。 */
export function smidUploadRequest(
  fp: SmFingerprint,
  box: string,
  now: Date,
  rnd: () => number = Math.random,
  base?: string | undefined,
): BuiltRequest {
  const uid = uuidV4();
  const priId = md5Hex(uid).slice(0, 16);
  const ep = rsaEncryptBase64(
    SKLAND_SM_CONFIG.publicKey,
    utf8(uid),
    (n) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) b[i] = Math.floor(rnd() * 256) & 0xff;
      return b;
    },
  );
  const data = encryptSmBody(buildSmBody(fp, box, now, rnd), priId);
  return {
    // ⚠ `base` 覆盖**必须**有：这台主机是第三方（cmpassport 风控），
    // 而"CI 全程只打 mock"是本仓的硬规则。少了这个口子，E2E 会真去打那个域 ——
    // 那不是"测试不严"，是**把 CI 变成对外发流量**。
    url: `${rootOrDefault(base, SMID_HOST)}${SMID_PATH}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin: SMID_ORIGIN,
      referer: SMID_REFERER,
      'user-agent': SMID_UA,
    },
    body: JSON.stringify({
      appId: SKLAND_SM_CONFIG.appId,
      organization: SKLAND_SM_CONFIG.organization,
      ep,
      data,
      os: 'web',
      encode: 5,
      compress: 2,
    }),
  };
}

/** 解析上报响应：`code == 1100` ⇒ `"B" + detail.deviceId`。
 *
 *  ⚠ `code` 是**数字** 1100（云盘那批是字符串 `"0000"`）—— 别写成一类判据。 */
export function parseDeviceId(body: string): { ok: boolean; deviceId?: string; error?: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `smid 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.code !== SMID_OK_CODE) {
    return { ok: false, error: `smid 上报失败：code=${String(v.code ?? '?')}（期望 ${SMID_OK_CODE}）` };
  }
  const detail = v.detail;
  const raw = detail && typeof detail === 'object'
    ? (detail as Record<string, unknown>).deviceId
    : undefined;
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, error: 'smid 响应没有 detail.deviceId' };
  }
  return { ok: true, deviceId: DEVICE_ID_PREFIX + raw };
}
