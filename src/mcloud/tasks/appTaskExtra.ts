// App 任务的**专用动作**：固定入口 / 入口页 / 分享外链 / 邮件转存。
//
// 这一层只负责**构造请求与解析响应**（纯函数，除了读会话），状态机在 appTask.ts。
// 形状来自参考实现 mcloud：
//   crates/mcloud-upstream/src/app_task_entry.rs
//   crates/mcloud-upstream/src/app_cloud_outlink.rs
//   crates/mcloud-upstream/src/mail139.rs
//   crates/mcloud-tasks/src/app_task.rs（entry_reports / portal_entry / share_first_uploaded）
//
// ⚠ 一次调用只发一个请求的纪律不在这里，在状态机：这里只造请求。

import { callRawText } from '../client.ts';
import { parseAuth } from '../auth.ts';
import { buildH5Request, REFERER_SIGN_IN, SHOW_LOADING } from '../h5.ts';
import { loadAuthRaw } from '../sessionExchange.ts';
import { loadSession } from '../../store/types.ts';
import { sessionHeaders } from './base.ts';
import { specTokenRequest } from '../h5session.ts';
import { uuidV4 } from '../rand.ts';
import { desDecryptBase64 } from '../../crypto/des.ts';
import { rsaEncryptBase64 } from '../../crypto/rsa.ts';
import { toBase64, toHex, utf8 } from '../../crypto/bytes.ts';
import { md5 } from '../../crypto/md5.ts';
import type { BuiltRequest } from '../h5.ts';
import type { TaskDeps } from './base.ts';

const MCLOUD = 'https://m.mcloud.139.com';
const MRP = 'https://mrp.mcloud.139.com';
const YUN = 'https://yun.139.com';
const APPMAIL = 'https://appmail.mail.10086.cn';
const HTML5_MAIL = 'https://html5.mail.10086.cn';
const MAIL_LOGIN = 'https://mail.10086.cn/login/inlogin.action';

function sessionOf(deps: TaskDeps) {
  return loadSession(deps.store);
}

function accountPhone(deps: TaskDeps): string {
  return parseAuth(loadAuthRaw(deps.store))?.phone ?? '';
}

// ── 409 / 1005：固定入口 ────────────────────────────────────────────────

/** 新路径：`POST /ycloud/signin/page/doTaskPost`（App 实拍）。 */
export function entryPostRequest(deps: TaskDeps, marketName: string): BuiltRequest {
  const s = sessionOf(deps);
  return buildH5Request({
    url: `${MCLOUD}/ycloud/signin/page/doTaskPost`,
    method: 'POST',
    body: JSON.stringify({ client: 'app', deviceId: s?.deviceId ?? '' }),
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: true,
    saltKey: 1,
    marketName,
    session: s ? sessionHeaders(s) : {},
  });
}

/** 旧路径：`GET mrp…/market/signin/page/doTask`（旧 TS 的形状）。 */
export function entryGetRequest(deps: TaskDeps): BuiltRequest {
  const s = sessionOf(deps);
  return buildH5Request({
    url: `${MRP}/market/signin/page/doTask?client=app&deviceId=${encodeURIComponent(s?.deviceId ?? '')}`,
    method: 'GET',
    body: undefined,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    session: s ? sessionHeaders(s) : {},
  });
}

// ── 1017 / 604：入口页 ──────────────────────────────────────────────────

export const SSO_TOKEN_PLACEHOLDER = '#ssoToken#';

/** 入口页 URL（`#ssoToken#` 换成当前凭据里的 token）。 */
export function portalUrl(link: string, deps: TaskDeps): string | undefined {
  const token = parseAuth(loadAuthRaw(deps.store))?.token ?? '';
  if (!link.startsWith('https://')) return undefined;
  return link.split(SSO_TOKEN_PLACEHOLDER).join(token);
}

/** 取入口页（GET，带会话头；不是 H5 签名族）。 */
export function portalPageRequest(deps: TaskDeps, url: string): BuiltRequest {
  const s = sessionOf(deps);
  return {
    url,
    method: 'GET',
    headers: {
      Accept: '*/*',
      ...(s ? sessionHeaders(s) : {}),
    },
    body: undefined,
  };
}

// ── 434：分享外链 ───────────────────────────────────────────────────────

const OUTLINK_HEADERS: Record<string, string> = {
  caller: 'web',
  'cms-device': 'default',
  'mcloud-channel': '1000101',
  'mcloud-version': '7.14.4',
  'x-deviceinfo': '||9|7.14.4|edge||||linux unknow||zh-CN|||',
  'x-huawei-channelsrc': '10000034',
  'x-svctype': '1',
  'x-yun-api-version': 'v1',
  'x-yun-app-channel': '10000034',
  'x-yun-channel-source': '10000034',
  'x-yun-client-info': '||9|7.14.4|edge||||linux unknow||zh-CN|||||',
  'x-yun-module-type': '100',
  'x-yun-svc-type': '1',
  'content-type': 'application/json',
};

export function getOutLinkRequest(deps: TaskDeps, fileIds: string[]): BuiltRequest | undefined {
  if (fileIds.length === 0) return undefined;
  const account = accountPhone(deps);
  return {
    url: `${YUN}/orchestration/personalCloud-rebuild/outlink/v1.0/getOutLink`,
    method: 'POST',
    headers: { ...OUTLINK_HEADERS },
    body: JSON.stringify({
      getOutLinkReq: {
        subLinkType: 0,
        encrypt: 1,
        coIDLst: fileIds,
        caIDLst: [],
        pubType: 1,
        dedicatedName: '',
        period: 1,
        periodUnit: 1,
        viewerLst: [],
        extInfo: { isWatermark: 0, shareChannel: '3001' },
        commonAccountInfo: { account, accountType: 1 },
      },
    }),
  };
}

export function delOutLinkRequest(deps: TaskDeps, linkIds: string[]): BuiltRequest | undefined {
  if (linkIds.length === 0) return undefined;
  const account = accountPhone(deps);
  return {
    url: `${YUN}/orchestration/personalCloud-rebuild/outlink/v1.0/delOutLink`,
    method: 'POST',
    headers: { ...OUTLINK_HEADERS },
    body: JSON.stringify({
      delOutLinkReq: {
        linkIDs: linkIds,
        commonAccountInfo: { account, accountType: 1 },
      },
    }),
  };
}

/** 从 getOutLink 响应里收集 `linkID`（松解析，找不到就空）。 */
export function parseLinkIds(body: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const it of x) walk(it);
      return;
    }
    if (x === null || typeof x !== 'object') return;
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      if ((k === 'linkID' || k === 'linkId') && typeof val === 'string' && val !== '') out.push(val);
      else walk(val);
    }
  };
  walk(v);
  return [...new Set(out)];
}

// ── 1020：邮件转存 ──────────────────────────────────────────────────────

const MAIL_UA =
  'Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

export interface MailSession {
  sid: string;
  rmkey: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** ① 换邮箱 SSO token（`toSourceId=001003`）。 */
export function mailSpecTokenRequest(deps: TaskDeps): BuiltRequest {
  return specTokenRequest({ toSourceId: '001003' }, loadAuthRaw(deps.store));
}

/** ② `POST mail.10086.cn/login/inlogin.action`。 */
export function mailLoginRequest(sso: string): BuiltRequest {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n      <object>\n       ' +
    '<string name="clientId">10804</string>\n       ' +
    '<string name="version">9</string>\n       ' +
    '<string name="loginType">7</string>\n       ' +
    `<string name="token">${xmlEscape(sso)}</string>\n      </object>`;
  return {
    url: MAIL_LOGIN,
    method: 'POST',
    headers: { 'content-type': 'application/xml;charset=UTF-8' },
    body,
  };
}

export function parseMailSession(body: string): MailSession | undefined {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return undefined;
  }
  const varObj = (v as { var?: unknown }).var;
  if (varObj === null || typeof varObj !== 'object') return undefined;
  const sid = (varObj as { sid?: unknown }).sid;
  const rmkey = (varObj as { rmkey?: unknown }).rmkey;
  if (typeof sid !== 'string' || typeof rmkey !== 'string' || sid === '' || rmkey === '') {
    return undefined;
  }
  return { sid, rmkey };
}

function mailHeaders(session: MailSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    // ⚠ 参考实现（`mail139.rs` 的 `MailSession::cookie`）是**两枚**：
    //   `RMKEY=<rmkey>; Os_Sso_Sid=<sid>`。只给 RMKEY 时 `disk:convertPdfFromYunFile`
    //   回 `FA_INVALID_SESSION User Session Expired`（现场 2026-11-01 自测：1014 卡在这）。
    Cookie: `RMKEY=${session.rmkey}; Os_Sso_Sid=${session.sid}`,
    'Content-Type': 'application/xml;charset=UTF-8',
    Accept: '*/*',
    'User-Agent': MAIL_UA,
    ...extra,
  };
}

/** ③ 云盘目录（拿 directoryId，可空）。 */
export function mailDirsRequest(session: MailSession, cguid: string): BuiltRequest {
  const body =
    '<object><string name="qureySubDirectory">1</string><string name="parentId"></string></object>';
  return {
    url: `${HTML5_MAIL}/mw2/file/disk?func=disk:getDirectorys&sid=${session.sid}&comefrom=54&cguid=${cguid}`,
    method: 'POST',
    headers: mailHeaders(session, {
      Origin: HTML5_MAIL,
      Referer: `${HTML5_MAIL}/`,
      'X-Requested-With': 'cn.cj.pe',
    }),
    body,
  };
}

/** ④ 邮件列表（拿 mid）。 */
export function mailSearchRequest(session: MailSession, cguid: string): BuiltRequest {
  const body =
    '<object><int name="fid">1</int><string name="order">receiveDate</string><int name="desc">1</int>' +
    '<int name="total">1</int><int name="limit">10</int><int name="start">0</int>' +
    '<int name="ignoreCase">0</int><int name="isSearch">1</int><int name="statType">1</int>' +
    '<int name="isFullSearch">0</int></object>';
  return {
    url: `${APPMAIL}/RmWeb/mail?func=mbox:SearchByFidOrCondition&peFlag=1&sid=${session.sid}&comefrom=54&cguid=${cguid}`,
    method: 'POST',
    headers: mailHeaders(session, { 'X-Requested-With': 'cn.cj.pe' }),
    body,
  };
}

/** ⑤ 邮件转存。 */
export function mailBackupRequest(
  session: MailSession,
  cguid: string,
  mid: string,
  directoryId: string,
): BuiltRequest {
  const body =
    `<object><string name="mailIds">${xmlEscape(mid)}</string><string name="backupType" />` +
    `<string name="channel">16861</string><string name="directoryId">${xmlEscape(directoryId)}</string></object>`;
  return {
    url: `${HTML5_MAIL}/mw2/file/disk?func=disk:backupMail&sid=${session.sid}&comefrom=16861&cguid=${cguid}`,
    method: 'POST',
    headers: mailHeaders(session, {
      Origin: HTML5_MAIL,
      Referer: `${HTML5_MAIL}/`,
      'X-Requested-With': 'cn.cj.pe',
    }),
    body,
  };
}

/** 从 XML/JSON 两种形状里取第一枚键值（参考实现 first_field）。 */
export function firstField(body: string, key: string): string | undefined {
  // XML 那一支：值到 `<` **或到串尾**为止（旧写法要求闭合标签，体被截断就取不到）。
  const re = new RegExp(`name=["']${key}["']\\s*>([^<]*)`, 'i');
  const m = re.exec(body);
  if (m !== null && m[1] !== undefined) {
    const v = m[1].trim();
    if (v !== '') return v;
  }
  // ⚠ 键**可能是单引号**：实测 `mbox:searchMessages`（1029 账单）回的是
  //   `{'code':'S_OK','var':[{'mid':"d4864e…"}]}` —— 键单引号、值双引号混着用。
  //   只认 `"mid":"…"` 的话，账单那条永远"取不到 mid"（2026-11-01 现场）。
  //
  // ⚠ 但**键和值必须各自配对**：一条 `["']([^"']*)["']` 会在值里带撇号时
  //   截出半截（`"subject":"it's mine"` → `it`），半截值比取不到更糟 ——
  //   它会被原样拼进下游请求 URL（评审 2026-11-01）。
  for (const re of [
    new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i'),
    new RegExp(`'${key}'\\s*:\\s*"([^"]*)"`, 'i'),
    new RegExp(`'${key}'\\s*:\\s*'([^']*)'`, 'i'),
    // 值**不带引号**那一支：参考实现 `first_mail_id` 专门补过（实拍的壳混着用）
    new RegExp(`"${key}"\\s*:\\s*([^,}\\s]+)`, 'i'),
  ]) {
    const mj = re.exec(body);
    const v = mj?.[1];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** 邮箱族 `{code, summary}`：`S_OK` 才算成。 */
export function mailCode(body: string): { ok: boolean; code: string; summary: string } {
  // ⚠ 邮箱那一族**不全是标准 JSON**：实测 `mbox:getComposeId` 回的是
  //   `{'code':'S_OK','var':'…'}` —— **单引号**。`JSON.parse` 直接抛 ⇒ 以前报
  //   "响应不是 JSON"（2026-11-01 自测：1004 一直卡在"取不到 composeId"）。
  //   所以先按标准 JSON 试，失败再按单引号那份兜。
  const tryParse = (t: string): { code?: unknown; summary?: unknown } | undefined => {
    try {
      return JSON.parse(t) as { code?: unknown; summary?: unknown };
    } catch {
      return undefined;
    }
  };
  // ⚠ **不要** `body.replace(/'/g,'"')` 上来就全局换：值里本来就有撇号时
  //   （`{'code':'S_OK','summary':"can't"}`）会把合法体整成非法 JSON，
  //   然后一次撇号就把 `S_OK` 说成"不是 JSON"（评审 2026-11-01 实测）。
  //   单引号那一支改成**按字段抽**（与 `firstField` 同一手法，原文原样留在 summary）。
  const v = tryParse(body);
  if (v !== undefined) {
    const code = typeof v.code === 'string' ? v.code : String(v.code ?? '');
    // ⚠ 只认 `S_OK`（参考实现 `is_ok` 逐字就是它）。以前还收 `0000`，
    //   那会让一个没验证过的码被当成"成了"（评审 2026-11-01）。
    return { ok: code === 'S_OK', code, summary: typeof v.summary === 'string' ? v.summary : '' };
  }
  const loose = /['"]?code['"]?\s*:\s*['"]([^'"]*)['"]/i.exec(body)?.[1];
  const looseSum = /['"]?summary['"]?\s*:\s*['"]([^'"]*)['"]/i.exec(body)?.[1];
  if (loose !== undefined) {
    return { ok: loose === 'S_OK', code: loose, summary: looseSum ?? '' };
  }
  // 还解析不了就把原文前 80 字带出来 —— 只说"响应不是 JSON"等于把最该看的那一格丢了。
  return { ok: false, code: '', summary: `响应不是 JSON：${body.slice(0, 80)}` };
}

/** 一个新的 cguid（参考实现用随机串；这里用 UUID 的紧凑形式）。 */
export function newCguid(): string {
  return uuidV4().replace(/-/g, '');
}


// ── 609 / 1028：AI 助手 ────────────────────────────────────────────────

const AI_CHAT_URL = 'https://ai.yun.139.com/api/outer/assistant/chat/v2/add';
const AI_STATUS_URL = 'https://m.mcloud.139.com/ycloud/signin/public/getUserTaskAndCloudStatusExternal';
const AI_CHAT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AI_STATUS_PUBKEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1PWBlhoygGhj2uqniCjI' +
  'PXbyufSSeST1yojxn1w1G6E/Uc9OpOFcXqcZYb1uc111zYdBAupYOxG+PXsQoZnZ' +
  'TXiZfYO6oTBC623OzEPnE3afYGa62E/8g8C4Zrzaqng4Sw+YvERoroHRM29SRvCB' +
  'QK7qcszK2kGLuPVh02WhHuprvR6GQPWcOOXLYOUbg2qVhKu+J1+bJ2wS4camxNF2' +
  'W96YSTdWPysHSw0o3fPIOfkDylCmj4odAVIln5vBP/rYtKeFskco+Tpyd5UM+zpw' +
  'Rf+VOJ/c/7DIC2iUjsENdb2pasLlhp5mTDeARDK4lzQR+MkJaGzYis3NqSu2PAPJ' +
  'TwIDAQAB';

/** queryUserToken（AI 域鉴权的来源）。 */
export function queryUserTokenRequest(session: MailSession, cguid: string): BuiltRequest {
  return {
    url: `${HTML5_MAIL}/mw2/file/disk?func=disk:queryUserToken&sid=${session.sid}&behaviorData=&rnd=${Math.random()}&cguid=${cguid}&k=&comefrom=166`,
    method: 'POST',
    headers: mailHeaders(session, {
      Origin: HTML5_MAIL,
      Referer: `${HTML5_MAIL}/`,
      'X-Requested-With': 'cn.cj.pe',
    }),
    body: '<object></object>',
  };
}

export interface AiToken {
  account: string;
  token: string;
  userDomainId?: string;
}

export function parseQueryUserToken(body: string): AiToken | undefined {
  try {
    const v = JSON.parse(body) as {
      var?: { data?: { data?: { account?: unknown; token?: unknown; userDomainId?: unknown } } };
    };
    const inner = v.var?.data?.data;
    if (!inner) return undefined;
    const account = typeof inner.account === 'string' ? inner.account : '';
    const token = typeof inner.token === 'string' ? inner.token : '';
    if (account === '' || token === '') return undefined;
    return {
      account,
      token,
      userDomainId: typeof inner.userDomainId === 'string' ? inner.userDomainId : undefined,
    };
  } catch {
    return undefined;
  }
}

/** queryUserToken 的内层 → AI 域鉴权（手机号是 DES 加密的）。 */
export function deriveAiAuth(t: AiToken):
  | { phone: string; authorization: string; userDomainId: string }
  | undefined {
  let phone = '';
  try {
    phone = desDecryptBase64(t.account, '139_mail');
  } catch {
    return undefined;
  }
  // ⚠ 解出来必须是**11 位数字**（中国大陆手机号）。DES 的填充去掉之后如果还剩
  //   乱码（错钥/坏填充），拼进 `Authorization` 只会换来一个"鉴权失败"，
  //   而那时我们连"是解不出来"还是"上游不认"都分不清（评审 2026-11-01）。
  if (!/^\d{11}$/.test(phone)) return undefined;
  const authorization = `Basic ${toBase64(utf8(`mobile:${phone}:${t.token}`))}`;
  return { phone, authorization, userDomainId: t.userDomainId ?? '' };
}

/** 用 AI 状态口的 RSA 公钥加密手机号。 */
export function encryptPhone(phone: string): string {
  const bytes = new Uint8Array(phone.length);
  for (let i = 0; i < phone.length; i++) bytes[i] = phone.charCodeAt(i) & 0xff;
  const rng = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c?.getRandomValues) {
      c.getRandomValues(out);
      return out;
    }
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  };
  return rsaEncryptBase64(AI_STATUS_PUBKEY, bytes, rng);
}

export function cloudTaskStatusRequest(rsaToken: string, taskId: number): BuiltRequest {
  return {
    url: AI_STATUS_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://appmail.mail.10086.cn',
      Referer: 'https://appmail.mail.10086.cn/',
      'User-Agent': AI_CHAT_UA,
    },
    body: JSON.stringify({ token: rsaToken, taskId, sourceChannel: '10175' }),
  };
}

export function parseCloudTaskStatus(body: string): { taskStatus?: number; cloudStatus?: number } | undefined {
  try {
    const v = JSON.parse(body) as { result?: { taskStatus?: unknown; cloudStatus?: unknown } };
    const r = v.result;
    if (!r) return undefined;
    return {
      taskStatus: typeof r.taskStatus === 'number' ? r.taskStatus : undefined,
      cloudStatus: typeof r.cloudStatus === 'number' ? r.cloudStatus : undefined,
    };
  } catch {
    return undefined;
  }
}

function beijingStamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function dialogueInput(message: string): Record<string, unknown> {
  return {
    dialogue: message,
    prompt: '',
    inputTime: beijingStamp(),
    commands: '000',
    command: null,
    resourceType: '0',
    resourceId: '',
    dialogueType: '0',
    commandType: 1,
    enableForceNetworkSearch: false,
    enableAllNetworkSearch: false,
    enableAiSearch: false,
    extInfo: '{}',
    versionInfo: { pcVersion: '1.7.0', h5Version: '2.5.0' },
    toolSetting: { imageToolSetting: { enableLlmDescribe: false } },
    attachment: {},
    aiWritingSetting: {},
  };
}

export function aiChatRequest(auth: string, userId: string, message: string): BuiltRequest {
  return {
    url: AI_CHAT_URL,
    method: 'POST',
    headers: {
      'x-yun-api-version': 'v1',
      'x-yun-client-info': '4g||30|||||||1440/900|zh-CN||||',
      'x-yun-app-channel': '10175',
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': AI_CHAT_UA,
    },
    body: JSON.stringify({
      applicationType: 'chat',
      sessionId: '',
      dialogueInput: dialogueInput(message),
      sourceChannel: '10175',
      userId,
      continuationInfo: null,
    }),
  };
}

/** SSE：收 `flowResult.outContent` / `outContent`，事件数为 0 视为没成。
 *
 *  ⚠ 顺手把 `code` / `message` 也带出来：现场 2026-11-01 只印得出
 *  「events=1」——那条事件里到底是什么（审核拦截 / 配额 / 参数错）**一个字都没有**，
 *  等于把最该看的那一格丢了。Rust 那边（`ai_cloud.rs` 的 `SseChat`）留了
 *  `last_code` / `last_message`，这里照抄。 */
export function parseSse(body: string): {
  events: number;
  text: string;
  code?: string | undefined;
  message?: string | undefined;
} {
  let events = 0;
  let text = '';
  let code: string | undefined;
  let message: string | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line === '[DONE]') continue;
    const data = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (data === '') continue;
    try {
      const ev = JSON.parse(data) as {
        code?: unknown;
        message?: unknown;
        data?: { code?: unknown; message?: unknown; flowResult?: { outContent?: unknown }; outContent?: unknown };
      };
      events++;
      const a = ev.data?.flowResult?.outContent;
      const b = ev.data?.outContent;
      if (typeof a === 'string') text += a;
      if (typeof b === 'string') text += b;
      // 最后一条带 code/message 的才算（流里可能先来心跳、后来错）
      const c = ev.code ?? ev.data?.code;
      const m = ev.message ?? ev.data?.message;
      if (c !== undefined && c !== null && c !== '') code = String(c);
      if (typeof m === 'string' && m !== '') message = m;
    } catch {
      // 非 JSON 行不算事件
    }
  }
  return { events, text, code, message };
}


// ── 107：云笔记 ────────────────────────────────────────────────────────

const NOTE_AUTH_URL = 'https://note.mcloud.139.com/noteServer/api/authTokenRefresh.do';
const MNOTE = 'https://mnote.caiyun.feixin.10086.cn';

export function noteAuthRequest(token: string, phone: string): BuiltRequest {
  return {
    url: NOTE_AUTH_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      APP_CP: 'android',
      APP_NUMBER: phone,
      CP_VERSION: '3.2.0',
      'x-huawei-channelsrc': '10001400',
      'User-Agent': 'mobile',
    },
    body: JSON.stringify({ authToken: token, userPhone: phone }),
  };
}

export function parseNoteHeaders(body: string): Record<string, string> | undefined {
  try {
    const v = JSON.parse(body) as { headers?: unknown };
    if (v.headers === null || typeof v.headers !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.headers as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out.app_auth ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 建笔记的**成败判据**：回包里有没有 `noteid`。
 *
 *  ⚠ 鉴权不对时上游照样回 200，正文是个**空模板**（`{"noteid":"","title":"",…}`，
 *  2026-11-12 实测）—— 所以"HTTP 200"完全不能当成功。 */
export function parseNoteCreated(body: string): string | undefined {
  try {
    const v = JSON.parse(body) as { noteid?: unknown; result?: { noteid?: unknown } };
    const id = typeof v.noteid === 'string' ? v.noteid : typeof v.result?.noteid === 'string' ? v.result.noteid : '';
    return id.trim() === '' ? undefined : id.trim();
  } catch {
    return undefined;
  }
}

export function noteCreateRequest(
  noteId: string,
  title: string,
  phone: string,
  headers: Record<string, string>,
  nowMs: number,
): BuiltRequest {
  const ts = String(nowMs);
  return {
    url: `${MNOTE}/noteServer/api/createNote.do`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      APP_CP: 'pc',
      APP_NUMBER: phone,
      CP_VERSION: '7.7.1.20240115',
      ...headers,
    },
    body: JSON.stringify({
      archived: 0,
      attachmentdir: '',
      attachmentdirid: '',
      attachments: [],
      contentid: '',
      contents: [{ data: '<span></span>', noteId, sortOrder: 0, type: 'TEXT' }],
      cp: '',
      createtime: ts,
      description: '',
      expands: { noteType: 0 },
      landMark: [],
      latlng: '',
      location: '',
      noteid: noteId,
      remindtime: '',
      remindtype: 0,
      revision: '1',
      system: '',
      tags: [],
      title,
      topmost: '0',
      updatetime: ts,
      userphone: phone,
      version: '',
      visitTime: ts,
    }),
  };
}

export function noteDeleteRequest(noteId: string, headers: Record<string, string>): BuiltRequest {
  return {
    url: `${MNOTE}/noteServer/api/moveToRecycleBin.do`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      APP_CP: 'pc',
      CP_VERSION: '7.7.1.20240115',
      ...headers,
    },
    body: JSON.stringify({ noteids: [{ noteid: noteId }] }),
  };
}

// ── 472 / 473：邮箱活跃 ─────────────────────────────────────────────────

export function mailAutologinRequest(session: MailSession): BuiltRequest {
  return {
    url: `https://mail.10086.cn/login/autologin.action?sid=${session.sid}&rmkey=${session.rmkey}`,
    method: 'GET',
    headers: {},
    body: undefined,
  };
}

export function marketClickRequest(taskId: number, marketname: string): BuiltRequest {
  return {
    url: 'https://m.mcloud.139.com/ycloud/signin/task/taskClickV2',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketname, clientVersion: '11.2.1', taskId }),
  };
}

// ── 1004：发邮件 ────────────────────────────────────────────────────────

/** PE 活跃上报（`eventType "3"` = 发邮件）—— 参考实现的 `report_pe_send_mail`。
 *
 *  ⚠ 参考实现把体 **gzip** 了（OS 字节 19）再发。我们发**明文 JSON**：
 *  2026-11-01 实测同一个口（同 `Authorization`、同 body）明文回 `{"code":"S_OK"}`，
 *  而我们的 `BuiltRequest.body` 是**字符串**、宿主按 UTF-8 编码 —— 二进制 gzip
 *  塞进去会被改字节。等哪天真需要压缩再给 transport 加二进制通道，别在这里硬塞。
 */
export function peActiveReportRequest(session: MailSession, cguid: string, nowMs: number): BuiltRequest {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date(nowMs + 8 * 3600 * 1000); // 东八区墙钟（参考实现同一个时刻既做 ts 又做 eventTime）
  const y = d.getUTCFullYear();
  const mo = p(d.getUTCMonth() + 1);
  const da = p(d.getUTCDate());
  const h = p(d.getUTCHours());
  const mi = p(d.getUTCMinutes());
  const se = p(d.getUTCSeconds());
  const ts = `${y}${mo}${da}${h}${mi}${se}`;
  const payload = {
    body: { logDatas: [{ eventTime: `${y}-${mo}-${da} ${h}:${mi}:${se}`, eventType: '3' }] },
    head: {
      appCode: '2a76b8c7-e9c4-478b-b1fd-0b2516cffd86',
      comeFrom: '4027001',
      eMode: '1',
      installPack: '139PushEmail_AC20X_10.3.2B20240906.4027001.apk',
      manufacturers: 'Xiaomi',
      model: 'MIX 2',
      netType: '1',
      os: 'Android',
      osVersion: '9',
      version: '10.3.2',
    },
  };
  return {
    url: `https://pesupport.mail.10086.cn/logreport/s?func=user:activeAction&cguid=${cguid}&sid=${session.sid}`,
    method: 'POST',
    headers: {
      Authorization: `Basic ${md5HexOf(ts + PE_SECRET)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: `RMKEY=${session.rmkey}`,
      'User-Agent': 'Apache-HttpClient/UNAVAILABLE (java 1.4)',
    },
    body: JSON.stringify(payload),
  };
}

/** `PE_SECRET`（参考实现 `mail139.rs` 逐字；末尾那个 `:` 也是内容）。 */
const PE_SECRET = ':5f4dcc3b5aa765d61d8327deb882cf99';

/** MD5 hex（PE 鉴权头要的就是这个）。 */
function md5HexOf(text: string): string {
  return toHex(md5(utf8(text)));
}

export function getComposeIdRequest(session: MailSession): BuiltRequest {
  return {
    url: `${APPMAIL}/RmWeb/mail?func=mbox:getComposeId&sid=${session.sid}`,
    method: 'POST',
    headers: mailHeaders(session),
    body: '',
  };
}

export function parseComposeId(body: string): string | undefined {
  const fromObj = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v !== '') return v;
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['m', 'id']) {
        if (typeof o[k] === 'string' && o[k] !== '') return o[k] as string;
      }
    }
    return undefined;
  };
  // 标准 JSON 先试；`mbox:getComposeId` 实测回的是**单引号**的 `{'code':'S_OK','var':'…'}`。
  for (const t of [body, body.replace(/'/g, '"')]) {
    try {
      const v = JSON.parse(t) as { var?: unknown };
      const hit = fromObj(v.var);
      if (hit !== undefined) return hit;
    } catch {
      // 换下一种写法
    }
  }
  const m = /['"]var['"]\s*:\s*['"]([^'"]+)['"]/.exec(body);
  return m?.[1];
}

export interface ComposeMail {
  composeId: string;
  account: string;
  to: string;
  subject: string;
  content: string;
}

export function composeMailRequest(session: MailSession, mail: ComposeMail): BuiltRequest {
  const e = xmlEscape;
  const xml =
    `<object><object name='attrs'>` +
    `<string name='id'>${e(mail.composeId)}</string>` +
    `<string name='mid'></string><string name='messageId'></string>` +
    `<string name='account'>${e(mail.account)}</string>` +
    `<string name='to'>${e(mail.to)}</string>` +
    `<string name='cc'></string><string name='bcc'></string><string name='replyTo'></string>` +
    `<string name='subject'>${e(mail.subject)}</string>` +
    `<string name='content'>${e(mail.content)}</string>` +
    `<int name='isHtml'>0</int><int name='priority'>3</int>` +
    `<int name='saveSentCopy'>1</int><int name='scheduleDate'>0</int>` +
    `<array name='attachments'></array></object>` +
    `<string name='action'>asyn</string></object>`;
  return {
    url: `${APPMAIL}/RmWeb/mail?func=mbox:compose&peFlag=1&sid=${session.sid}`,
    method: 'POST',
    headers: { ...mailHeaders(session), 'Content-Type': 'text/xml; charset=UTF-8' },
    body: xml,
  };
}

// ── 585 / 618：AI 相机 ─────────────────────────────────────────────────

const AI_RECOGNIZE_URL = 'https://ai.yun.139.com/api/image/aiRecognize';
const AI_CAMERA_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAACklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAASFhMcYAAAAASUVORK5CYII=';
const AI_CAMERA_UA =
  'Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36';

export function aiRecognizeRequest(
  auth: string,
  userId: string,
  tid: string,
  deviceId: string,
): BuiltRequest {
  return {
    url: AI_RECOGNIZE_URL,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': AI_CAMERA_UA,
      deviceid: deviceId,
      'x-yun-tid': tid,
      Authorization: auth,
      'x-yun-api-version': 'v1',
      'x-yun-module-type': '100',
      'x-yun-op-type': '1',
      'x-yun-app-channel': '10214200',
      'hcy-cool-flag': '1',
      'x-yun-uni': userId,
    },
    body: JSON.stringify({
      channelId: '101',
      userId,
      recognizeType: '1',
      base64: AI_CAMERA_BASE64,
      sendType: '2',
      imageExt: 'jpg',
      uploadToCloud: true,
      timeout: 30000,
    }),
  };
}

export function parseAiRecognize(body: string): {
  success: boolean;
  fileId?: string;
  taskId?: string;
  message?: string;
} | undefined {
  try {
    const v = JSON.parse(body) as {
      success?: unknown;
      data?: { fileId?: unknown; taskId?: unknown };
      message?: unknown;
    };
    return {
      success: v.success === true,
      fileId: typeof v.data?.fileId === 'string' ? v.data.fileId : undefined,
      taskId:
        typeof v.data?.taskId === 'string'
          ? v.data.taskId
          : typeof v.data?.taskId === 'number'
            ? String(v.data.taskId)
            : undefined,
      message: typeof v.message === 'string' ? v.message : undefined,
    };
  } catch {
    return undefined;
  }
}

export function aiCameraChatRequest(auth: string, userId: string, fileId: string, taskId: string, tid: string): BuiltRequest {
  const n = Number.parseInt(taskId, 10);
  const fileName = `${Number.isFinite(n) ? n + 1 : Date.now()}.jpeg`;
  return {
    url: AI_CHAT_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': AI_CAMERA_UA,
      'x-yun-tid': tid,
      Authorization: auth,
      'x-yun-api-version': 'v1',
      'x-yun-module-type': '100',
      'x-yun-op-type': '1',
      'x-yun-app-channel': '10214200',
      'hcy-cool-flag': '1',
      'x-yun-client-info': '||8||||||||||||',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      userId,
      sessionId: '',
      applicationType: 'chat',
      applicationId: '',
      sourceChannel: '101',
      dialogueInput: {
        dialogue: '？',
        prompt: '',
        inputTime: new Date().toISOString(),
        enableForceLlm: false,
        enableForceNetworkSearch: true,
        enableModelThinking: false,
        enableAllNetworkSearch: false,
        enableKnowledgeAndNetworkSearch: false,
        enableRegenerate: false,
        versionInfo: { h5Version: '2.7.6' },
        extInfo: '{}',
        sortInfo: {},
        toolSetting: { imageToolSetting: { enableLlmDescribe: true } },
        attachment: { attachmentTypeList: [3], fileList: [{ fileId, name: fileName }] },
      },
    }),
  };
}


/** 1014：`disk:convertPdfFromYunFile`。 */
export function convertPdfRequest(
  session: MailSession,
  fileName: string,
  fileRealSize: number,
  fileId: string,
  rnd: string,
  cguid: string,
): BuiltRequest {
  const body =
    '<object>\n  ' +
    `<string name="fileName">${xmlEscape(fileName)}</string>\n  ` +
    `<int name="fileRealSize">${fileRealSize}</int>\n  ` +
    `<string name="fileId">${xmlEscape(fileId)}</string>\n  ` +
    '<int name="convertType">1</int>\n  ' +
    '<string name="appType">1</string>\n  ' +
    '<string name="appVer">10.0.3</string>\n  ' +
    '<string name="channel">10242000</string>\n' +
    '</object>';
  return {
    url: `${HTML5_MAIL}/mw2/file/disk?func=disk:convertPdfFromYunFile&sid=${session.sid}&behaviorData=&rnd=${rnd}&cguid=${cguid}&k=&comefrom=166`,
    method: 'POST',
    headers: mailHeaders(session, {
      Origin: HTML5_MAIL,
      Referer: `${HTML5_MAIL}/`,
      'X-Requested-With': 'cn.cj.pe',
    }),
    body,
  };
}


// ── 1029：我的账单 ──────────────────────────────────────────────────────

export function billPageRequest(session: MailSession, cguid: string): BuiltRequest {
  return {
    url: `${HTML5_MAIL}/html/mobilebill.html?sendId=1000006&sid=${session.sid}&cguid=${cguid}`,
    method: 'GET',
    headers: {
      Cookie: `RMKEY=${session.rmkey}`,
      'User-Agent': MAIL_UA,
      Referer: `${HTML5_MAIL}/?id=bill`,
    },
    body: undefined,
  };
}

export function billMailsSearchRequest(session: MailSession, cguid: string): BuiltRequest {
  const cond = (field: string, op: string, value: number): string =>
    `<object><string name="field">${field}</string><string name="operator">${op}</string><int name="value">${value}</int></object>`;
  const conditions = [
    cond('sendId', '=', 1000006),
    cond('sendId1', '=', 1000007),
    cond('sendId2', 'GE', 1000301),
    cond('sendId2', 'LE', 1000700),
    cond('sendId3', '=', 1000010),
  ].join('');
  const body =
    '<object><int name="fid">1</int><int name="recursive">0</int><int name="ignoreCase">0</int>' +
    '<int name="isSearch">1</int><int name="isFullSearch">0</int><int name="start">0</int>' +
    '<int name="total">10</int><int name="limit">1000</int><string name="order">receiveDate</string>' +
    '<string name="desc">1</string><int name="highLight">0</int>' +
    '<array name="exceptFids"><int>4</int></array>' +
    `<array name="condictions">${conditions}</array>` +
    '<int name="addSendIdFlag">3</int><int name="statType">1</int></object>';
  return {
    url: `${APPMAIL}/RmWeb/mail?func=mbox:searchMessages&sid=${session.sid}&cguid=${cguid}`,
    method: 'POST',
    headers: mailHeaders(session, { 'X-Requested-With': 'cn.cj.pe' }),
    body,
  };
}

export function markMailReadRequest(session: MailSession, cguid: string, mid: string): BuiltRequest {
  return {
    url: `${APPMAIL}/RmWeb/mail?func=mbox:updateMessagesStatus&sid=${session.sid}&cguid=${cguid}`,
    method: 'POST',
    headers: mailHeaders(session, { 'X-Requested-With': 'cn.cj.pe' }),
    body: `<object><array name="ids"><string>${xmlEscape(mid)}</string></array><string name="type">read</string><string name="value">1</string></object>`,
  };
}

export function readMessageRequest(session: MailSession, cguid: string, mid: string): BuiltRequest {
  return {
    url: `${HTML5_MAIL}/RmWeb/view.do?func=view:readMessage&sid=${session.sid}&mid=${encodeURIComponent(mid)}&callback=getMailInfo&comefrom=166&fid=1&mode=mobile&resetdomain=0&cguid=${cguid}`,
    method: 'GET',
    headers: {
      Cookie: `RMKEY=${session.rmkey}`,
      Referer: `${HTML5_MAIL}/html/readmail.html`,
    },
    body: undefined,
  };
}

export function mailReportToMqRequest(
  session: MailSession,
  cguid: string,
  rnd: string,
  actionType: string,
  clientType: string,
  mid: string,
  channel: string,
): BuiltRequest {
  return {
    url: `${HTML5_MAIL}/mw2/file/disk?func=disk:mailReportToMQ&sid=${session.sid}&rnd=${rnd}&cguid=${cguid}&comefrom=166`,
    method: 'POST',
    headers: {
      Cookie: `RMKEY=${session.rmkey}`,
      'Content-Type': 'application/xml',
      Referer: `${HTML5_MAIL}/html/readmail.html`,
    },
    body: JSON.stringify({
      actionType,
      clientType,
      imapId: mid,
      clientVersion: 'h5',
      channel,
    }),
  };
}

export function logBehaviorActionRequest(
  session: MailSession,
  action: number,
  thingId: number,
  cguid: string,
  behaviorData: string,
): BuiltRequest {
  return {
    url: `${HTML5_MAIL}/mw2/weather/weather?func=user:logBehaviorAction&action=${action}&thingId=${thingId}&version=html5&cguid=${cguid}&behaviorData=${encodeURIComponent(behaviorData)}`,
    method: 'GET',
    headers: {
      Cookie: `RMKEY=${session.rmkey}`,
      'User-Agent': MAIL_UA,
    },
    body: undefined,
  };
}

/** 发一个请求（给状态机复用）。 */
export function send(deps: TaskDeps, req: BuiltRequest) {
  return callRawText(deps.transport, req);
}
