// aiTools（`ai.yun.139.com`）—— 趣玩AI 里那 9 件 **H5 工具任务**的接口。
//
// ⚠ 这是**另一个子系统**，和 `funai`（`m.mcloud.139.com/ycloud/funai/*`）不是一套：
//   · `funai` 管"任务清单 / 是否完成"（`page/getmodule` 的 `isComplete`）；
//   · `aiTools` 管"真的把那张图生成出来"。
//   两边通过 **taskId** 对上（`getmodule` 的 `id` = 这边的 `command` / `algorithmCode`）。
//
// ═══════════════════════════════════════════════════════════════════════
// 鉴权：**不用自己带**
// ═══════════════════════════════════════════════════════════════════════
//
// 这些接口在 `ai.yun.139.com`，属于 `*.yun.139.com` 族 ⇒ 传输层的
// `authorizeRequest`（`cloudUpload.ts`，`AUTH_DOMAINS` 含 `yun.139.com`）
// 会自动注入 `Authorization: <mcloud.h5.auth>`。
//
// ⚠ 2026-11-27 踩过：手写 `fetch` 去试这个头，绕过了自己的传输层，
//   试了 `jwttoken` / `ssoToken` / `Bearer` / 不带 —— 全回 `01000002 鉴权失败`，
//   白折腾半天。**验票一律走本仓 `Transport`。**
//   选票口径：`docs/auth-families.md` §5。
//
// ═══════════════════════════════════════════════════════════════════════
// 状态机（四步）
// ═══════════════════════════════════════════════════════════════════════
//
// ```text
// ① 生成  POST /api/image/<后缀>       → data.taskId（19 位数字串）
// ② 轮询  POST /api/outer/async/task/result {"taskId"} → data.status 1 → 2 → 3
// ③ 完成  status === 3（progress 100）→ resultList[0].fileUrlList[0] 是签名 URL（24h）
// ④ 翻位  回读 funai 的 page/getmodule → 那条任务 isComplete 变 1
// ```
//
// 取证与 9 件的路径表：`mcloud-capture/mcloud/upstream/aitools.md`。

import type { BuiltRequest } from './h5.ts';

export const AITOOLS_BASE = 'https://ai.yun.139.com';

/** 结果轮询口（`status` 在这里）。 */
export const TASK_RESULT_PATH = '/api/outer/async/task/result';
/** 查上次记录（页面打开时那一下，`data` 常为 null）。 */
export const LAST_RECORD_PATH = '/api/image/async/task/getLastRecord';

/** AI 头像（趣玩AI 的 `007`）的生成口。 */
export const AVATAR_CARTOON_PATH = '/api/image/avatar/cartoon';
/** 智能抠图（趣玩AI 的 `003`）的生成口。**和头像同一套 7 字段 body**，只换路径与 `context.source`。 */
export const PORTRAIT_MATTING_PATH = '/api/image/edit/portraitMatting';

/** 生成请求里那几个**固定**字段。全部来自实拍抓包（`aitools-avatar-samples.txt`）。 */
export const AITOOLS_CHANNEL_ID = '100103';
export const AITOOLS_SUPPLIER_TYPE = 4;
/** 头像风格。抓包里是 `"001"`；上游的风格表在 `AItouxiangStyles.*.png` 里，**没取到编号表**。 */
export const AITOOLS_AVATAR_STYLE = '001';
/** `context.source` —— 头像那个工具的 `sourceId`（`getmodule` 的 `innerLink` 里也是它）。 */
export const AITOOLS_AVATAR_SOURCE = '170420';
/** 智能抠图那个工具的 `sourceId`（`getmodule` 的 `innerLink` 里）。 */
export const AITOOLS_MATTING_SOURCE = '170423';

/** 「哪件任务走哪个生成口」——**只登记验过的**。
 *
 *  ⚠ 2026-11-27 拿同一个 7 字段 body 挨个打过（详见 `mcloud-capture/mcloud/upstream/aitools.md`）：
 *   · `003` 智能抠图 → `/edit/portraitMatting` ✅ 生成成功、回读翻位；
 *   · `004` AI漫画风 → `/edit/faceAnime` 提交成功但**算法侧失败**（status=4）⇒ 不登记；
 *   · `006` 智能消除 → 回「Mask图不能为空」（要用户圈选，做不了）；
 *   · `008` / `009` → 回「该功能尚未开发，敬请期待」——**上游自己没做**；
 *   · `031` 表情包 → 回「贴纸URL不能为空」（要贴纸素材，不是人像照）；
 *   · `034` / `3Drenou` → 「参数错误」，路径还没定。
 */
/** 两种 body 形态。**别想着"统一"** —— 它们连字段名都不一样。 */
export type AiToolBodyKind = 'plain' | 'faceswap';

export interface AiToolRoute {
  path: string;
  source: string;
  /** 请求体形态。`plain` = 那 7 个字段（多数工具）；`faceswap` = `personList` + `extJson`（AI快照）。 */
  kind: AiToolBodyKind;
  /** **唯一真正要紧的字段**（2026-11-27 实测）：同一个 `restore` 路径，
   *  `supplierType: 4` 回「该功能尚未开发」、`8` 就正常生成。
   *  它决定"用哪家的算法"，填错的表现是**像上游没做**，最容易误判。 */
  supplierType: number;
  /** 风格编号。各工具不同（头像是 `"001"`，老图修复抓包是 `0`）；
   *  ⚠ 类型也不统一（字符串/数字都有），按抓包原样存，别"统一"成一种。 */
  style: string | number;
}

/** 「哪件任务走哪个生成口」——**只登记验过的**。
 *
 *  ⚠ `imageExt` 与 base64 前缀**实测不重要**（同一路径下 `png`/`jpeg`、
 *  带不带 `data:image/jpeg;base64,` 前缀，都能出 taskId）⇒ 统一用 `png` + 裸 base64。
 *
 *  ⚠ 2026-11-27 挨个打过的结论：
 *   · `003` → `/edit/portraitMatting` ✅ 生成 + 回读翻位；
 *   · `007` → `/avatar/cartoon` ✅ 同上；
 *   · `008` → `/edit/restore`（`supplierType:8`）✅ 同上；
 *   · `009` → `/edit/qualityRestore`（`supplierType:8`）✅ 同上；
 *   · `004` → `/edit/faceAnime`：参数对了仍回 `10022001 该功能尚未开发` ⇒ **上游没做**；
 *   · `006` → 回「Mask图不能为空」（要用户圈选区域）；
 *   · `031` → 回「贴纸URL不能为空」（要贴纸素材，不是人像照）；
 *   · `034` / `3Drenou` → 「参数错误」，路径还没定。
 */
export const AITOOLS_ACTION_ROUTES: Record<string, AiToolRoute> = {
  aiToolsAvatar: {
    kind: 'plain',
    path: AVATAR_CARTOON_PATH,
    source: AITOOLS_AVATAR_SOURCE,
    supplierType: 4,
    style: AITOOLS_AVATAR_STYLE,
  },
  aiToolsMatting: {
    kind: 'plain',
    path: PORTRAIT_MATTING_PATH,
    source: AITOOLS_MATTING_SOURCE,
    supplierType: 4,
    style: AITOOLS_AVATAR_STYLE,
  },
  aiToolsRestore: { kind: 'plain', path: '/api/image/edit/restore', source: '170425', supplierType: 8, style: 0 },
  aiToolsQuality: { kind: 'plain', path: '/api/image/edit/qualityRestore', source: '170483', supplierType: 8, style: 0 },
  // AI快照（`034`）：**换脸**，不是"生成一张图"。body 是 `personList` + `extJson.templateImg`。
  aiToolsSnapshot: {
    kind: 'faceswap',
    path: '/api/image/faceswap',
    source: '170422',
    supplierType: 0,
    style: 1009,
  },
};

/** 轮询多久算超时。实测头像 2 次（≈6 秒）就好；留到 60 秒够慢网。 */
export const AITOOLS_WAIT_MS = 60_000;
/** 两次轮询之间隔多久（抓包里是 3 秒）。 */
export const AITOOLS_POLL_MS = 3_000;

function jsonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'x-yun-api-version': 'v1',
    Origin: 'https://yun.139.com',
    Referer: 'https://yun.139.com/aiTools/',
  };
}

/** ① 生成 AI 头像。
 *
 *  ⚠ **七个字段一个都不能少**（2026-11-27 踩过）：只发 `{sendType, base64}` 会回
 *  `01000001 参数错误`，看上去像"图不合格"，实际是少了 `imageExt` / `style` /
 *  `supplierType` / `channelId` / `context` 这五个。
 *
 *  `photoB64` 是**图片原始字节的 base64**（JPEG 以 `/9j/` 开头），不是 URL。 */
// ── AI快照的**模板**：不是写死的，是页面从广告位接口拉的 ─────────────
//
// 2026-11-27 从 `aiPhotoStudioOffice` 的 chunk 里挖出：
//   `getPhotoStudioTemplateList()` → `getAdInfos({adpostid})`
//   `single: "66391"`（单人写真）/ `multi: "66392"`（多人合照）
// 响应 `body[]` 每项是 `{templateId, materialList:[{materialUrl}], adposname, …}`。
//
// ⚠ **`style` 就是 `templateId`**：抓包里 `style:1009` 正对应列表里
//   `templateId=1009` / `…/20250116/1737015803541.png` 那一项（已核对）。
//   写死一个 URL 的做法在模板轮换后会失效（表现是 `status` 到不了 3，不是参数错）。
//
// 默认取列表**第一个**——页面自己的兜底也是 `onSelectTemplate(t[0])`。
export const ADVERT_BASE = 'https://ad.mcloud.139.com';
export const ADINFO_PATH = '/advertapi/adv-config/adv-config/AdInfoFilter/getAdInfos';
/** 单人写真的广告位；多人合照是 `66392`（单人这一档就够做任务了）。 */
export const PHOTO_STUDIO_SINGLE_ADPOSTID = '66391';

export function templateListRequest(adpostid = PHOTO_STUDIO_SINGLE_ADPOSTID): BuiltRequest {
  return {
    url: ADVERT_BASE + ADINFO_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://yun.139.com',
      Referer: 'https://yun.139.com/aiTools/',
    },
    body: JSON.stringify({ adpostid }),
  };
}

export interface PhotoTemplate {
  templateId: string;
  materialUrl: string;
}

/** 解析模板列表。取不到就给空数组（调用方决定要不要退到默认）。 */
export function parseTemplates(body: string): PhotoTemplate[] {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return [];
  }
  const o = v as { returnCode?: unknown; body?: unknown };
  if (String(o?.returnCode ?? '') !== '0') return [];
  const list = Array.isArray(o?.body) ? o.body : [];
  const out: PhotoTemplate[] = [];
  for (const raw of list) {
    const t = raw as { templateId?: unknown; materialList?: unknown };
    const id = t?.templateId === undefined || t?.templateId === null ? '' : String(t.templateId);
    const mats = Array.isArray(t?.materialList) ? t.materialList : [];
    const url = String((mats[0] as { materialUrl?: unknown } | undefined)?.materialUrl ?? '');
    if (id === '' || !/^https:\/\//.test(url)) continue;
    out.push({ templateId: id, materialUrl: url });
  }
  return out;
}

export function aiToolsGenRequest(
  photoB64: string,
  route: AiToolRoute = AITOOLS_ACTION_ROUTES['aiToolsAvatar']!,
  /** AI快照用：**当趟从广告位拉到的**模板（`style` 就是 `templateId`）。
   *  不传就退到空——`faceswap` 那支会返回 `undefined` 让调用方先拉模板。 */
  template?: PhotoTemplate | undefined,
): BuiltRequest | undefined {
  if (route.kind === 'faceswap') {
    if (template === undefined) return undefined;
    // ⚠ 形态完全不同：外层 `personList` 数组里放**一张脸**，模板走 `extJson.templateImg`。
    //   实测 `imageExt` 这里不是 `webp` 也行（JPEG 直接过）。
    return {
      url: AITOOLS_BASE + route.path,
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        personList: [
          {
            sendType: 2,
            channelId: AITOOLS_CHANNEL_ID,
            imageExt: 'jpeg',
            base64: 'data:image/jpeg;base64,' + photoB64,
          },
        ],
        channelId: AITOOLS_CHANNEL_ID,
        supplierType: route.supplierType,
        // ⚠ `style` **就是**模板的 `templateId`，不是另一套编号
        style: Number(template.templateId) || template.templateId,
        poseIdList: [0],
        extJson: JSON.stringify({ templateImg: template.materialUrl }),
        context: JSON.stringify({ source: route.source }),
      }),
    };
  }
  return {
    url: AITOOLS_BASE + route.path,
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      sendType: 2,
      base64: photoB64,
      // ⚠ `imageExt` / base64 前缀**都不影响成败**（实测），统一 png + 裸 base64。
      imageExt: 'png',
      style: route.style,
      // ⚠ **这一格是真的要紧**：改错一侧（4 vs 8）上游就回「功能尚未开发」。
      supplierType: route.supplierType,
      channelId: AITOOLS_CHANNEL_ID,
      // ⚠ 这一格**是字符串**（里面又套了一层 JSON），不是对象。
      context: JSON.stringify({ source: route.source }),
    }),
  };
}

/** 旧名字留着（一处调用，别为改名牵动动作层）。 */
export const avatarCartoonRequest = aiToolsGenRequest;

/** ② 取结果（轮询这一口）。 */
export function taskResultRequest(taskId: string): BuiltRequest {
  return {
    url: AITOOLS_BASE + TASK_RESULT_PATH,
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ taskId }),
  };
}

/** 查上次记录（`command` 就是趣玩AI 的 taskId）。 */
export function lastRecordRequest(taskId: string): BuiltRequest {
  return {
    url: AITOOLS_BASE + LAST_RECORD_PATH,
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      command: taskId,
      channelId: AITOOLS_CHANNEL_ID,
      appendReqParams: true,
    }),
  };
}

/** 从生成的回执里取 `taskId`。`code !== "0000"` ⇒ `undefined`（调用方负责把原话写进日志）。 */
export function parseGenTask(body: string): string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return undefined;
  }
  const o = v as { success?: unknown; code?: unknown; data?: unknown };
  if (o?.success !== true && o?.code !== '0000') return undefined;
  const d = o?.data as { taskId?: unknown } | null;
  const id = d?.taskId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 认输的话术（上游回的不是 `0000` 时，取它的 `message` 给日志）。 */
export function upsteamMessage(body: string): string {
  try {
    const o = JSON.parse(body) as { message?: unknown; code?: unknown };
    const m = typeof o?.message === 'string' ? o.message : '';
    const c = typeof o?.code === 'string' ? o.code : '';
    if (m === '' && c === '') return '';
    return c === '' ? m : `${c} ${m}`.trim();
  } catch {
    return '';
  }
}

export interface AiTaskStatus {
  /** 1 排队 / 2 处理中 / **3 完成** / 其它 = 失败态 */
  status: number;
  /** 完成时的结果图 URL（**签名 URL，24 小时有效**，要转存得当趟做）。 */
  fileUrl?: string | undefined;
  /** 算法编号 —— 应该等于那件任务的 taskId，用来交叉核对挑对了没有。 */
  algoCode?: string | undefined;
  /** 进度百分比（完成时 100）。 */
  progress?: number | undefined;
}

/** 解析轮询回执。`status` 拿不到 ⇒ `undefined`。 */
export function parseTaskStatus(body: string): AiTaskStatus | undefined {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return undefined;
  }
  const d = (v as { data?: unknown })?.data as
    | { status?: unknown; progress?: unknown; resultList?: unknown }
    | null
    | undefined;
  if (d === null || d === undefined) return undefined;
  const status = typeof d.status === 'number' ? d.status : Number(d.status);
  if (!Number.isFinite(status)) return undefined;
  const list = Array.isArray(d.resultList) ? d.resultList : [];
  const first = (list[0] ?? {}) as { fileUrlList?: unknown; algorithmCode?: unknown };
  const urls = Array.isArray(first.fileUrlList) ? first.fileUrlList : [];
  const url = typeof urls[0] === 'string' ? urls[0] : undefined;
  const algo = typeof first.algorithmCode === 'string' ? first.algorithmCode : undefined;
  const progress = typeof d.progress === 'number' ? d.progress : Number(d.progress);
  return {
    status,
    ...(url === undefined ? {} : { fileUrl: url }),
    ...(algo === undefined ? {} : { algoCode: algo }),
    ...(Number.isFinite(progress) ? { progress } : {}),
  };
}

/** 完成判据只有这一个：`status === 3`。 */
export function isTaskDone(s: AiTaskStatus): boolean {
  return s.status === 3;
}

/** 失败态：抓包里只见过 1 / 2 / 3，**别的取值按失败处理**（别死等）。 */
export function isTaskFailed(s: AiTaskStatus): boolean {
  return s.status !== 1 && s.status !== 2 && s.status !== 3;
}
