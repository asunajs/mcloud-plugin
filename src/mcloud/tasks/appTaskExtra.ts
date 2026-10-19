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
import { toBase64, utf8 } from '../../crypto/bytes.ts';
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
    Cookie: `RMKEY=${session.rmkey}`,
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
  const re = new RegExp(`name=["']${key}["']\\s*>([^<]*)<`, 'i');
  const m = re.exec(body);
  if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  const j = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i');
  const mj = j.exec(body);
  return mj?.[1];
}

/** 邮箱族 `{code, summary}`：`S_OK` 才算成。 */
export function mailCode(body: string): { ok: boolean; code: string; summary: string } {
  try {
    const v = JSON.parse(body) as { code?: unknown; summary?: unknown };
    const code = typeof v.code === 'string' ? v.code : String(v.code ?? '');
    return { ok: code === 'S_OK', code, summary: typeof v.summary === 'string' ? v.summary : '' };
  } catch {
    return { ok: false, code: '', summary: '响应不是 JSON' };
  }
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
  if (phone === '') return undefined;
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

/** SSE：收 `flowResult.outContent` / `outContent`，事件数为 0 视为没成。 */
export function parseSse(body: string): { events: number; text: string } {
  let events = 0;
  let text = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line === '[DONE]') continue;
    const data = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (data === '') continue;
    try {
      const ev = JSON.parse(data) as {
        data?: { flowResult?: { outContent?: unknown }; outContent?: unknown };
      };
      events++;
      const a = ev.data?.flowResult?.outContent;
      const b = ev.data?.outContent;
      if (typeof a === 'string') text += a;
      if (typeof b === 'string') text += b;
    } catch {
      // 非 JSON 行不算事件
    }
  }
  return { events, text };
}

/** 发一个请求（给状态机复用）。 */
export function send(deps: TaskDeps, req: BuiltRequest) {
  return callRawText(deps.transport, req);
}
