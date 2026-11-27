// 趣玩AI 的任务体：**读 → 点一件 → 做那件事 → 回读判完成**。
//
// # 三段，一次跑完（不跨趟）
//
// ```text
//   list     读门户页 + 主题模块，挑**一件**可做的（预算见 PLAYAI_TASKS_PER_RUN）
//   register POST page/register {moduleId,taskId}   ← 抓包里官方顺序就是"先点后做"
//   act      把那件事**真的做一遍**（复用算力族已有的动作层）
//   verify   回读 getmodule，看那条 isComplete 有没有翻位
// ```
//
// ⚠ **判据只有一条：回读翻位**。`register` 回 `{"code":0,"result":0}` 什么也不说明
//   （2026-09-25 实拍：点了 003、也进了工具，8 小时里 `isComplete` 一直是 0）。
//   所以"点了"只写「已上报」，翻位了才写「做完了」，没翻就 `pending`（不是失败，也不是成功）。
//
// # 为什么只做「AI 助手」这一件
//
// 动作层（`tokenPkActions.stepAction`）现在实现了这些工具：上传照片 / 分享 / 备份 /
// 云笔记 / 外链 / **灵犀对话（aiAssistant）** / **AI 相机识图（aiCamera）** / 智能相册。
// 但只有 `aiAssistant` 这一条**不往云盘写文件**（2026-09-25 第三轮实拍：AI 助手那一趟
// 一次 `hcy/file/create` 都没有），所以先接它 —— 不产生需要收尾的垃圾。
// 其余任务（智能抠图 / AI头像 / 扫描文档 …）要各自进工具页做图，形状还没抓，
// 一律**不点也不做**，只在日志里说"要你自己做"。
//
// # 预算
//
// 一次运行只做**一件**：`register` 是写口，动作链要发十来发，做多了既慢又难查。
// 想做下一件就再跑一趟（调试页/「现在跑一次」都行）。

import { callRawText } from '../client.ts';
import type { Transport } from '../client.ts';
import { loadSession } from '../../store/types.ts';
import { loadJwt } from '../sessionExchange.ts';
import {
  activityState,
  pageModuleRequest,
  parseEnvelope,
  pageModule,
  parseModules,
  readingLine,
  journalingRequest,
  lotteryJournalingKeywords,
  lotteryRequest,
  parseDraw,
  registerRequest,
  transcriptionCompletedRequest,
  shortTaskName,
  summarize,
  timedModuleRequest,
} from '../playAi.ts';
import type { PlayAiModule, PlayAiSession, PlayAiTask } from '../playAi.ts';
import {
  loadDrawDay,
  loadPlayAi,
  loadPlayAiSnapshot,
  newPlayAi,
  playAiDrawEnabled,
  saveDrawDay,
  savePlayAi,
  savePlayAiSnapshot,
} from '../playAiState.ts';
import type { PlayAiState, PlayAiTarget } from '../playAiState.ts';
import { firstActionStep, stepAction } from './tokenPkActions.ts';
import { waitMs } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 一趟最多做几件（**真的会做这么多**，2026-11-26 起）。
 *
 *  原来是 1：做完一件回读就 `idle` 收工。真号实测之后改成"做满 N 件再收工"——
 *  用户一趟只想跑一次，而这一族有二十来件可做，一件一趟等于要手动点二十次。
 *
 *  ⚠ 三道边界，别只看到这一个数：
 *    · 每件之间**不等**：`register → act → verify` 本身就是十来发请求，
 *      再叠一层等待只会把预算吃光（面板的执行预算是外部的，见 `drain` 文件头）；
 *    · 做过的任务记在 `tried`（`(moduleId|taskId) → 时刻`）里，**同一趟不会再挑**；
 *    · 真正兜底的是 `drain` 的 `PLAYAI_MAX_STEPS`：步数走满就如实说"没走完"。
 *
 *  动作链本身失败（换票/登录/对话没成）时**立刻收工**：那种情况下再挑一件也一样做不成，
 *  继续撞只会把同一段错误刷 N 遍。 */
export const PLAYAI_TASKS_PER_RUN = 3;

/** 一趟最多抽几次。**5** —— 与上游"每天最多 5 次"对齐（`PLAYAI_DAILY_CHANCE_CAP`）。
 *
 *  用户口径（2026-11-27）：「获取到次数就抽」。所以是"有几次抽几次"，不是"一趟一发"。
 *  ⚠ 真正的上限由**服务端**的 `drawTimes` 兜着：抽到 0 就自然停。这个常量只是保险丝。 */
export const PLAYAI_DRAWS_PER_RUN = 5;

/** 这一族一趟最多推几步（`drain` 的 `maxSteps`）。
 *
 *  账（**按"做满 `PLAYAI_TASKS_PER_RUN` 件"算**，一件的链是）：
 *  `list` 1 + `register` 1 + **相机链 5**（换票 → 邮箱登录 → 拿鉴权 → 识图 → 对话）
 *  + `verify` 1（+ 没翻位时再读 1）= **8~9 步**。
 *
 *  · 3 件：24~27 步
 *  · 抽奖：1 步
 *  ⇒ **给到 32**，够 3 件满链 + 两次重试。
 *
 *  ⚠ 这个数**跟着 `PLAYAI_TASKS_PER_RUN` 一起改**：改大件数忘了改这里，表现是
 *  `drain` 报「走到第 N 步就停了」—— 那是**假失败**（事情在推进，只是这一趟没走完），
 *  而用户看到的是"这一族没成"。两个常量挨着放就是为了让人看见这件事。 */
export const PLAYAI_MAX_STEPS = 32;

/** 趣玩AI 的任务 → 动作层认识的那把钥匙。
 *
 *  ⚠ 只登记**实拍确认过**的对应关系：
 *   · `aizhushou`（AI 助手）→ `aiAssistant`：09-25 §7.9 就是用户进 AI 助手聊了一轮，
 *     68 秒后 `isComplete` 从 0 翻到 1、`todayGetLotteryCount` 0→1；
 *   · `aixiangji` / `204`（AI 相机 / 扫描文档）→ `aiCamera`：**形状没抓过这一族**
 *     （它会往云盘写文件），先不接；
 *   · 其余（智能抠图 / AI头像 / AI快照 / 表情包 / 老图片修复 / 画质修复 / 3D人偶 /
 *     AI漫画风 / 智能消除 / AI知识库 / 云笔记）→ 没有对应动作，一律"要你自己做"。
 *
 *  表里没有的 taskId 就是"我们不会做"，`actionKey` 留空。 */
export const PLAYAI_ACTION_KEYS: Record<string, string> = {
  aizhushou: 'aiAssistant',
  // `yunbiji`（AI云笔记）的 `innerLink` 是 `mcloud://main/featureServices?linkUrl=0|2040`
  // —— 就是"打开云笔记页"。动作层里已有 `createNote`（建一条笔记的完整链：
  // 笔记鉴权 → 建 → 回读），算力族那 107 号任务走的就是它。
  // ⚠ 只登记**动作层真的会做**的那件：这里登记了却没有 case 的话，`firstActionStep`
  //   会拿不到入口，表现是"挑中了但一步也走不动"。
  yunbiji: 'createNote',
  // ⚠ `zhishiku`（AI知识库）**登记过又被撤掉**（2026-11-26 真号实测）：
  //   它的 `innerLink` 是 `mcloud://main/aiAssistantGlobal?params={jumpConfig:{tab:'aiKnowledge'}}`
  //   —— 与 AI助手同一个原生页，所以试过复用 `aiAssistant`（灵犀对话）。
  //   结果：点了、也聊了，回读 `isComplete` **两次都没翻**。
  //   ⇒ "同一个页面"不等于"同一件任务"：它要的是**知识库里真的建了东西**。
  //   登记了却没做成，只会把"看起来在干活"写进日志（`已上报，服务端还没认`）——
  //   那比不登记更糟：用户会以为这条路是通的。
  // 这两件的 `innerLink` 都是 `mcloud://main/aiCamera`（扫描文档也是那一台相机），
  // 与 App 任务的 585/618 是同一个工具 ⇒ 复用同一个动作（识图 → 对话）。
  // ⚠ 这条会**往用户云盘落一张图**：`tokenPkActions` 里已登记成"我们造的"，
  //   链尾「清理临时文件」会删掉它（见 findings F-153）。
  aixiangji: 'aiCamera',
  '204': 'aiCamera',
  // ⚠ `007`（AI头像）走**另一套**：它不是"进工具里做个动作"，而是直接调
  //   `ai.yun.139.com/api/image/avatar/cartoon` 把图生成出来（生成成功上游就认）。
  //   2026-11-27 用本仓凭据复跑通过：status=3、回读 `isComplete` 翻到 1。
  //   其余 8 件的路径已查明（`mcloud-capture/mcloud/upstream/aitools.md`），
  //   但**每件 body 形状不同**、只有头像验过，所以先只登记这一件。
  '007': 'aiToolsAvatar',
  // `003` 智能抠图：和头像**同一套 7 字段 body**，只换生成口与 `context.source`。
  // 2026-11-27 实测：生成成功、回读翻位（那号从 6 件变 8 件）。
  '003': 'aiToolsMatting',
  // `008` 老图片修复 / `009` 画质修复：走 aiTools 的 `restore` / `qualityRestore`，
  // ⚠ 这两件要用 `supplierType: 8`（填 4 会回「该功能尚未开发」，像上游没做）。
  // 2026-11-27 实测：生成成功、`status=3`、`algorithmCode` 与 taskId 一致。
  '008': 'aiToolsRestore',
  '009': 'aiToolsQuality',
  // `034` AI快照：走 `/api/image/faceswap`（**换脸**，不是生成），
  // body 是另一套形态（`personList` + `extJson.templateImg`）。
  // 2026-11-27 实测：用内置那张人脸照样出 `status=3`、`algorithmCode=034`。
  '034': 'aiToolsSnapshot',
  // `3Drenou` 3D人偶：和 AI漫画风共用 `/edit/faceAnime`，靠 `supplierType:"7"` +
  // `style:"plastic_bubble_figure"` + `addWatermark:true` 区分。
  // 2026-11-27 实测：生成成功、`status=3`（`algorithmCode` 回 "004" —— 上游那两件撞号）。
  '3Drenou': 'aiToolsDoll',
  // `006` 智能消除：要一张 `maskBase64`（涂抹蒙版）。插件没有触屏涂抹，
  // 内置一张同尺寸的固定蒙版（中间一块方形）。
  // ⚠ 这一族的 `supplierType` 必须是 **8** —— 用 4 会一直回「Mask图不能为空」。
  '006': 'aiToolsEraser',
  // `031` AI表情包：`/api/image/emo`（**第三种 body**）。模板从广告位 `66344` 拉，
  // `templateUrl` 用模板的 **`templateSamp`**（`.mov`）—— 用 `templatePic`/`emojiUrl` 会 `status=4`。
  '031': 'aiToolsEmoji',
};

/** 挑任务的偏好：**不写云盘**的排前面。
 *
 *  ⚠ 顺序有实际后果：一趟只做一件，先做 `aiAssistant`（零落盘）能少一份垃圾；
 *    真要跑相机那件时，那一张图也是登记过的、当趟就清。 */
const ACTION_RANK: Record<string, number> = {
  aiAssistant: 0,
  aiCamera: 1,
  // 转写完成口是纯 POST、不需要动作层，排最后
  transcription: 9,
};

/** 会话：H5 票（`jwttoken`）+ cookie + UA —— 与算力族同一张票，不另换活动站票。 */
function session(deps: TaskDeps): PlayAiSession | undefined {
  const sess = loadSession(deps.store);
  if (sess === null) return undefined;
  const rec = loadJwt(deps.store);
  if (rec === null || rec.jwt === '') return undefined;
  return { jwt: rec.jwt, cookie: sess.cookie, userAgent: sess.userAgent };
}

async function readModules(
  transport: Transport,
  s: PlayAiSession,
  base: string | undefined,
): Promise<{ ok: true; modules: PlayAiModule[] } | { ok: false; error: string }> {
  const out: PlayAiModule[] = [];
  for (const req of [pageModuleRequest(s, base), timedModuleRequest(s, base)]) {
    const res = await callRawText(transport, req);
    if (!res.ok) return { ok: false, error: `读不到模块：${res.error ?? '未知失败'}` };
    const env = parseEnvelope(res.text);
    if (!env.ok) return { ok: false, error: env.error };
    out.push(...parseModules(env.result));
  }
  return { ok: true, modules: out };
}

/** 挑一件：`taskSign===0` + 没完成 + **今天没点过** + 我们**会做**（有动作钥匙）。
 *
 *  ⚠ 三档过滤缺一不可：
 *   · `taskSign!==0`（邀请 / 录音转写）—— 点了也不会走 `register`，服务端不认；
 *   · `isComplete` —— 已完成再点是白发一发；
 *   · `tried` —— 今天点过就别再撞（回执零信息，重复点只是浪费）；
 *   · 没有动作钥匙的 —— **不点**。点了却做不了那件事，等于把"看起来在干活"写进日志。 */
function pickTarget(modules: readonly PlayAiModule[], tried: Record<string, string>): PlayAiTarget | null {
  const all: PlayAiTask[] = modules.flatMap((m) => m.tasks);
  // ⚠ 同一件任务会**同时出现在页面模块和主题模块**里（实拍：`004` 两处都有）。
  //   规则成文是「相同任务只能获得 1 次」⇒ 只要它在**任一模块**里已完成，就整件跳过；
  //   今天在**任一模块**里点过，也别换个 moduleId 再点一次（那是白发一发，
  //   而且回读不翻位时会给用户一个莫名其妙的 pending）。
  const doneIds = new Set(all.filter((t) => t.isComplete).map((t) => t.id));
  const triedIds = new Set(Object.keys(tried).map((k) => k.split('|')[1] ?? ''));
  const cands: PlayAiTarget[] = [];
  for (const t of all) {
    if (doneIds.has(t.id)) continue;
    if (triedIds.has(t.id)) continue;
    // `taskSign=2`（AI录音转写）：有**独立完成口**（`timed/transcriptioncompleted`），
    // 不走动作层、也不需要 `PLAYAI_ACTION_KEYS` 里那条。
    // 2026-11-26 在 cmcc-plugin 侧实测：POST 之后回读该条任务翻位。
    if (t.taskSign === 2) {
      if (!cands.some((c) => c.taskId === t.id)) {
        cands.push({
          moduleId: t.moduleId,
          taskId: t.id,
          name: shortTaskName(t.name),
          actionKey: 'transcription',
        });
      }
      continue;
    }
    if (t.taskSign !== 0) continue;
    const actionKey = PLAYAI_ACTION_KEYS[t.id] ?? '';
    if (actionKey === '') continue;
    // 同一 taskId 在多个模块里出现时只留第一条（顺序已按 ACTION_RANK 之外的偏好排）
    if (cands.some((c) => c.taskId === t.id)) continue;
    cands.push({ moduleId: t.moduleId, taskId: t.id, name: shortTaskName(t.name), actionKey });
  }
  // 偏好按 `ACTION_RANK`（不写云盘的先做）；同档按任务表原顺序，保证可预测
  cands.sort((a, b) => (ACTION_RANK[a.actionKey] ?? 9) - (ACTION_RANK[b.actionKey] ?? 9));
  return cands[0] ?? null;
}

/** 日期键（与其它族同一口径：`nowIso` 的 UTC 日）。 */
function dayKey(deps: TaskDeps): string {
  return deps.nowIso.slice(0, 10);
}

/** 现在该不该抽一发。
 *
 *  四个条件缺一不可：① 用户**显式开了**代抽（缺省关）；② 页面模块说**还有次数**
 *  （`drawTimes > 0` —— 它本身已经是余额，别再减 `drawsUsed`）；
 *  ③ 今天还没抽满这一趟的上限；④ 这一趟还没抽过（`drawn` 按天记）。 */
function shouldDraw(deps: TaskDeps, modules: readonly PlayAiModule[], drawnSoFar = 0): boolean {
  if (!playAiDrawEnabled(deps.store)) return false;
  const page = pageModule(modules);
  if (page === undefined) return false;
  if (page.drawTimes === null || page.drawTimes <= 0) return false;
  // 这一趟已经抽掉的，从余额里减掉；抽满 `PLAYAI_DRAWS_PER_RUN` 或余额见底就停
  if (drawnSoFar >= PLAYAI_DRAWS_PER_RUN) return false;
  if (page.drawTimes - drawnSoFar <= 0) return false;
  // ⚠ **不再**拿按天账卡这里：那样一天只能抽一次，而用户有几次就该能抽几次
  //   （跑几趟由用户定）。"一趟最多一发"由状态机保证 —— 抽完就 `phase='done'`，
  //   同一次运行里回不到 `draw` 了。按天账（`drawn/wins`）只用来报数。
  return true;
}

function save(deps: TaskDeps, st: PlayAiState): void {
  savePlayAi(deps.store, st, deps.nowIso);
}

function snapshot(deps: TaskDeps, modules: readonly PlayAiModule[], ok: boolean, error: string): string {
  const reading = summarize(modules);
  const line = ok ? readingLine(reading) : error;
  savePlayAiSnapshot(deps.store, { at: deps.nowIso, ok, line, reading: ok ? reading : null, error }, deps.nowIso);
  return line;
}

/** 读失败时**保留上一份好读数**，只把错误挂上去。
 *
 *  ⚠ 别用 `snapshot(..., false, ...)` 覆盖：那会把"上次读到的那几件任务"一起擦掉，
 *    卡片变成只剩一句错误 —— 用户本来能照着那张单子去 App 里做，现在连单子都没了。 */
function snapshotError(deps: TaskDeps, error: string): void {
  const prev = loadPlayAiSnapshot(deps.store);
  const keep = prev !== null && prev.ok === true && prev.reading !== null;
  savePlayAiSnapshot(
    deps.store,
    {
      at: deps.nowIso,
      ok: false,
      line: keep ? prev.line : error,
      reading: keep ? prev.reading : null,
      error,
    },
    deps.nowIso,
  );
}

/** 这一趟**还在用**的那个文件（AI 相机识图落的那张图）。
 *
 *  ⚠ 为什么要有它：清理那一步会把"我们造的"文件全删。若相机链被打断
 *    （识图完了、对话还没发），下一趟要接着用那枚 `fileId` —— 先删了就只能重来。
 *    与 `activeAppTaskFileId` / `activeExpansionFileId` 是同一类护栏。
 */
export function activePlayAiFileId(deps: TaskDeps): string | undefined {
  const st = loadPlayAi(deps.store);
  if (st === null || st.day !== dayKey(deps)) return undefined;
  if (st.phase !== 'act') return undefined;
  const attempt = st.attempt as { key?: string; step?: string; data?: Record<string, string> } | undefined;
  if (attempt === undefined) return undefined;
  if (attempt.key !== 'aiCamera') return undefined;
  // 只有"已经识图完、还没对话"那一段才需要留着那张图
  if (attempt.step !== 'ai-camera-chat') return undefined;
  return attempt.data?.['fileId'];
}

/** 推进一步。**一次调用最多一发上游请求**（动作链自己也是这个粒度）。 */
export async function playAiStep(deps: TaskDeps): Promise<TaskOutcome> {
  const day = deps.nowIso.slice(0, 10);
  const prev = loadPlayAi(deps.store);
  // ⚠ 同一天**第二趟**：上一趟已经 `done` ⇒ 必须重开一轮。
  //   不重开的话 `phase === 'done'` 会一直落到 `default:` 分支，这一族当天就再也不干活了
  //   —— 那正好违反"用户设几趟就跑几趟、每一趟都是独立的"这条口径。
  //   重开时把 `tried`（今天点过的）带过来：点过的不再点。
  const st =
    prev === null || prev.day !== day
      ? newPlayAi(day, deps.nowIso)
      : prev.phase === 'done'
        ? { ...newPlayAi(day, deps.nowIso), tried: prev.tried }
        : prev;

  const s = session(deps);
  if (s === undefined) {
    const error = '还没有网页会话（票没换成）—— 这一族这次没做';
    snapshotError(deps, error);
    return { ok: false, note: error };
  }

  switch (st.phase) {
    // ① 读一遍，挑一件
    case 'list': {
      const got = await readModules(deps.transport, s, deps.baseUrl);
      if (!got.ok) {
        const line = `读不到趣玩AI：${got.error}`;
        snapshotError(deps, got.error);
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: line };
      }
      const line = snapshot(deps, got.modules, true, '');
      st.modules = got.modules;
      // 活动结束了就**到此为止**：不再点、不再抽、不再每天刷一遍"0 件任务"。
      // （判据只用我们本来就读到的模块，不多发请求。）
      const live = activityState(got.modules, Date.parse(deps.nowIso));
      if (!live.live) {
        st.phase = 'done';
        st.lines = [live.why];
        save(deps, st);
        // ⚠ 快照也要说清"结束了"：卡上显示的是 `line`，只存读数的话
        //   用户看到的还是「4 个模块 · 24 件任务 …」，像一切正常。
        savePlayAiSnapshot(
          deps.store,
          {
            at: deps.nowIso,
            ok: true,
            line: `${live.why} —— ${line}`,
            reading: summarize(got.modules),
            error: '',
          },
          deps.nowIso,
        );
        return { ok: true, idle: true, note: `${live.why} —— 这一族不再往下做（${line}）` };
      }
      // 这一趟做满了就收工（`verify` 那边已经判过一次，这里再判一道 —— 因为
      // `list` 也可能是这一趟的第一拍：上一趟 `done` 之后重开、而 `doneCount` 没清）。
      if ((st.doneCount ?? 0) >= PLAYAI_TASKS_PER_RUN) {
        st.phase = 'done';
        save(deps, st);
        return { ok: true, idle: true, note: `做满 ${PLAYAI_TASKS_PER_RUN} 件了 —— ${line}` };
      }
      const target = pickTarget(got.modules, st.tried ?? {});
      if (target === null) {
        // 没有会做的任务 ⇒ 直接看能不能抽（次数是之前攒下的）
        // ⚠ **追加**不是覆盖：一趟会连做几件，覆盖的话前面几件的成绩全没了
        //   （实测现场：做完「AI助手」之后下一件点不动，账上只剩"没有我会做的"）。
        st.lines = [...(st.lines ?? []), `没有我会做的可做任务（${line}）`];
        if (shouldDraw(deps, got.modules, st.drawnThisRun ?? 0)) {
          st.phase = 'draw';
          save(deps, st);
          return { ok: true, note: `没有要做的任务，但还有次数 —— 去抽一次（${line}）` };
        }
        st.phase = 'done';
        save(deps, st);
        return { ok: true, idle: true, note: `没有我会做的可做任务 —— ${line}` };
      }
      st.target = target;
      st.phase = 'register';
      save(deps, st);
      return { ok: true, note: `准备做「${target.name}」（${line}）` };
    }

    // ② 点它（写）
    case 'register': {
      const t = st.target;
      if (t === undefined) {
        st.phase = 'done';
        save(deps, st);
        return { ok: true, idle: true, note: '没有挑中的任务' };
      }
      // `taskSign=2`（AI录音转写）不是「先点后做」，而是**一发完成口**。
      // 所以这里分流：直接 POST `timed/transcriptioncompleted`，然后进 verify 回读。
      const isTranscription = t.actionKey === 'transcription';
      const res = await callRawText(
        deps.transport,
        isTranscription
          ? transcriptionCompletedRequest(s, t.moduleId, t.taskId, deps.baseUrl)
          : registerRequest(s, t.moduleId, t.taskId, deps.baseUrl),
      );
      // ⚠ 点过就记下（**不论成败**）：成败都不该在当天再点一次
      st.tried = { ...(st.tried ?? {}), [`${t.moduleId}|${t.taskId}`]: deps.nowIso };
      if (!res.ok) {
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: `「${t.name}」上报没成：${res.error ?? '未知失败'}` };
      }
      const env = parseEnvelope(res.text);
      if (!env.ok) {
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: `「${t.name}」上报被拒：${env.error}` };
      }
      // 转写已经「做完」了（那一发就是完成口）⇒ 直接回读判据，不进动作层
      if (isTranscription) {
        st.phase = 'verify';
        // ⚠ 这里**不给** `actOk`（保持 undefined ⇒ 会等一次）：
        //   转写是"提交完成口、服务端事后翻位"，跟动作链那种"动作没成就不用等"不是一回事。
        //   实测：转写提交后回读确实要等一下才翻（抓包里页面版隔了几十秒）。
        save(deps, st);
        return { ok: true, note: `「${t.name}」完成口已提交 —— 回读看服务端认不认` };
      }
      // 动作钥匙在挑的时候就定下了；没有钥匙的不会被挑中
      st.phase = 'act';
      // ⚠ 入口步骤**问动作层**，别硬编 `'ai-mail-sso'`：动作层哪天换入口，
      //   硬编的那一份会静默走错分支（`stepAction` 会一路落到默认 done）。
      // ⚠ `PkAttempt.taskId` 是 **number**（算力族那边就是数字），而趣玩AI 的 taskId 是
      //   **字符串**（`'007'` / `'aixiangji'` / `'3Drenou'`）⇒ 那边传 0，真正的那个放进 `data`，
      //   动作层要用就从 `data.aiTask` 取（`aiTools` 那条要拿它和 `algorithmCode` 对拍）。
      st.attempt = {
        taskId: 0,
        name: t.name,
        key: t.actionKey,
        step: firstActionStep(t.actionKey),
        data: { aiTask: String(t.taskId) },
      };
      save(deps, st);
      return { ok: true, note: `「${t.name}」已上报 —— 下一步去做那件事` };
    }

    // ③ 真的做一遍（复用算力族的动作层）
    case 'act': {
      const t = st.target;
      if (t === undefined || st.attempt === undefined) {
        st.phase = 'verify';
        save(deps, st);
        return { ok: true, note: '没有要做的动作 —— 直接回读' };
      }
      // 动作层要的那份会话形状（与算力族同一个 `PkSession`）
      const attempt = st.attempt as Parameters<typeof stepAction>[2];
      const r = await stepAction(deps, { jwt: s.jwt, cookie: s.cookie, userAgent: s.userAgent }, attempt);
      st.attempt = attempt;
      if (!r.finished) {
        save(deps, st);
        return { ok: true, note: r.note };
      }
      st.attempt = undefined;
      st.actOk = r.ok;
      st.phase = 'verify';
      // 动作没做成也**照样回读**：那一件事可能本来就算完成（或者上一趟已经做完了），
      // 判据只有回读。失败那一句进 `lines`（运行记录里看得到），不吞掉。
      if (!r.ok) st.lines = [...(st.lines ?? []), `做「${t.name}」那一步没成：${r.note}`];
      save(deps, st);
      return { ok: true, note: `${r.note} —— 回读看服务端认不认` };
    }

    // ④ 回读：**唯一**的完成判据
    case 'verify': {
      const t = st.target;
      const got = await readModules(deps.transport, s, deps.baseUrl);
      if (!got.ok) {
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: `回读没成：${got.error}` };
      }
      const line = snapshot(deps, got.modules, true, '');
      st.modules = got.modules;
      // ⚠ **先别**把 `phase` 写成 `done`：下面"再读一次"那条路要停在 `verify`。
      //   写成 done 的后果实测过：下一拍会被当成"上一趟已走完 ⇒ 重开一轮"，
      //   于是它回去重新 `list`、报「没有我会做的可做任务」，pending 那句永远出不来。
      const now = got.modules.flatMap((m) => m.tasks).find((x) => x.id === t?.taskId && x.moduleId === t?.moduleId);
      if (t === undefined) {
        st.phase = 'done';
        st.lines = [];
        save(deps, st);
        return { ok: true, idle: true, note: line };
      }
      if (now?.isComplete === true) {
        // 做成了 ⇒ 记一笔（一件一行），然后看"这一趟还做不做下一件"
        const doneCount = (st.doneCount ?? 0) + 1;
        st.doneCount = doneCount;
        st.doneNames = [...(st.doneNames ?? []), t.name];
        // ⚠ **追加**不是覆盖：一趟现在会连做几件，覆盖的话前面几件的成绩就没了
        //   （只有最后一件留在账上）。用户要看的是"这一趟做成了哪几件"。
        st.lines = [...(st.lines ?? []), `「${t.name}」做完了（回读已翻位）`];
        // 次数应该 +1 ⇒ 抽奖排在"这一趟做完所有能做之后"，别每件后面插一发
        const more = doneCount < PLAYAI_TASKS_PER_RUN
          && pickTarget(got.modules, st.tried ?? {}) !== null;
        if (more) {
          // ⚠ 回 `list` 继续挑下一件，**不返回 `idle`** —— `idle` 是 `drain` 的出口，
          //   一返回这一趟就收工了（那就又变成"一件一趟"）。
          st.phase = 'list';
          st.target = undefined;
          st.verifyTries = 0;
          st.actOk = undefined;
          st.attempt = undefined;
          save(deps, st);
          return { ok: true, note: `「${t.name}」做完了（${doneCount}/${PLAYAI_TASKS_PER_RUN}）—— 接着做下一件` };
        }
        if (shouldDraw(deps, got.modules, st.drawnThisRun ?? 0)) {
          st.phase = 'draw';
          save(deps, st);
          return { ok: true, note: `「${t.name}」做完了 —— 还有次数，去抽一次` };
        }
        st.phase = 'done';
        save(deps, st);
        return { ok: true, idle: true, note: `「${t.name}」做完了 —— ${line}` };
      }
      // 没翻位：**再读一次**再下结论。
      //   ⚠ 服务端翻位是**事后**的（抓包里隔了 68 秒），刚聊完就回读很容易读到"还没翻"。
      //   只多读一次、等 3 秒 —— 不无限重试（那是"下一趟再验"，用户否过）。
      // ⚠ 只有**动作成了**才值得等：动作没成（换票/登录/对话失败）时，服务端不会因为
      //   等 3 秒就翻位 —— 那 3 秒是白等的，还占着面板的执行位。
      const tries = st.verifyTries ?? 0;
      if (st.actOk !== false && tries < 1) {
        st.verifyTries = tries + 1;
        save(deps, st);
        waitMs(deps, 3000);
        return { ok: true, note: `「${t.name}」回读还没翻位 —— 等一会儿再读一次` };
      }
      // 两次都没翻位：**如实说**。这不是失败（我们该做的都做了），也不是成功（服务端没认）
      st.lines = [...(st.lines ?? []), `「${t.name}」已上报，服务端还没认 —— 那件事要在工具里真的做完才算`];
      // ⚠ **这一件没翻位，不代表别的也做不成** —— 接着挑下一件（2026-11-26 真号现场：
      //   挑中「扫描文档」回读没翻位，整趟就收工了，而后面「AI云笔记」「AI录音转写」
      //   本来都做得成）。`tried` 已经记下这件，不会重复点它。
      //   挑不到下一件时才收工。
      const next = pickTarget(got.modules, st.tried ?? {});
      if ((st.doneCount ?? 0) < PLAYAI_TASKS_PER_RUN && next !== null) {
        st.phase = 'list';
        st.target = undefined;
        st.verifyTries = 0;
        st.actOk = undefined;
        st.attempt = undefined;
        save(deps, st);
        return { ok: true, pending: true, note: `「${t.name}」已上报，服务端还没认 —— 接着做下一件` };
      }
      // 没有下一件了：要是前面做成过、次数也在，抽奖照样给机会
      if ((st.doneCount ?? 0) > 0 && shouldDraw(deps, got.modules, st.drawnThisRun ?? 0)) {
        st.phase = 'draw';
        save(deps, st);
        return { ok: true, pending: true, note: `「${t.name}」已上报，服务端还没认 —— 但前面做成的还有次数，去抽一次` };
      }
      st.phase = 'done';
      save(deps, st);
      return { ok: true, pending: true, idle: true, note: `「${t.name}」已上报，服务端还没认 —— ${line}` };
    }

    // ⑤ 抽一发（**写**：花次数）。只在"开了代抽 + 今天还有次数"时才走到这里
    case 'draw': {
      const page = pageModule(st.modules);
      if (page === undefined) {
        st.phase = 'done';
        save(deps, st);
        return { ok: true, idle: true, note: '没有页面模块 —— 不抽' };
      }
      // ① 埋点先发 —— 用户口径「记得埋点也调用一下，无所谓有没有作用，防患于未然」。
      //    ⚠ 失败一律吞掉：埋点不该让抽奖停下来（直播族的注释里也写着"少发可能被静默拒"，
      //    但那是推测；宁可多发一条，不能因为埋点挂了就抽不成）。
      for (const kw of lotteryJournalingKeywords()) {
        await callRawText(deps.transport, journalingRequest(kw, deps.baseUrl));
      }
      const res = await callRawText(deps.transport, lotteryRequest(s, page.moduleId, deps.baseUrl));
      const day = loadDrawDay(deps.store, dayKey(deps));
      if (!res.ok) {
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: `抽奖没发出去：${res.error ?? '未知失败'}` };
      }
      const env = parseEnvelope(res.text);
      if (!env.ok) {
        st.phase = 'done';
        save(deps, st);
        return { ok: false, note: `抽奖被拒：${env.error}` };
      }
      const d = parseDraw(env.result);
      // 账要记：抽了就是抽了（**不论中没中**，次数已经花掉）
      saveDrawDay(deps.store, { day: day.day, drawn: day.drawn + 1, wins: day.wins + (d.win === true ? 1 : 0) }, deps.nowIso);
      const drawn = (st.drawnThisRun ?? 0) + 1;
      st.drawnThisRun = drawn;
      // ② 用户口径「获取到次数就抽」⇒ 还有剩余次数就**接着抽**，别一趟只抽一发。
      //    `page.drawTimes` 是**读模块时**的余额，抽了 `drawn` 次后剩这么多：
      const left = (page.drawTimes ?? 0) - drawn;
      if (left > 0 && drawn < PLAYAI_DRAWS_PER_RUN) {
        const what = d.win === true ? `中了「${d.prizeName || '没给名字'}」` : d.win === false ? '没中' : '判不出中没中';
        st.lines = [...(st.lines ?? []), `抽了第 ${drawn} 次（${what}）`];
        st.phase = 'draw';
        save(deps, st);
        return { ok: true, note: `抽了第 ${drawn} 次（${what}）—— 还剩 ${left} 次，接着抽` };
      }
      st.phase = 'done';
      if (d.win === null) {
        // 判不出来 ⇒ 既不写"中了"也不写"没中"
        st.lines = [...(st.lines ?? []), '抽了一次，但回执里没有 isWin —— 中了没中判不出来，去活动页看一眼'];
        save(deps, st);
        return { ok: true, idle: true, note: '抽了一次，但回执判不出中没中' };
      }
      st.lines = [
        ...(st.lines ?? []),
        d.win
          ? `抽中了：${d.prizeName || '（回执没给奖品名）'}`
          : '抽了一次，没中',
      ];
      save(deps, st);
      return { ok: true, idle: true, note: d.win ? `抽中了：${d.prizeName || '（没给名字）'}` : '抽了一次，没中' };
    }

    default: {
      const line = summarize(st.modules).modules.length > 0 ? readingLine(summarize(st.modules)) : '这次已经走完';
      return { ok: true, idle: true, note: line };
    }
  }
}
