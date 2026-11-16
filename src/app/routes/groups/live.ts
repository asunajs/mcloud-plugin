// live 那一组路由（8 条）：/live · /live/draw/probe · /live/claim · /live/draw/step · /live/gate/step · /live/listen/step · /live/raw · /live/codes
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { loadBaseUrl } from '../../../mcloud/session.ts';
import { EMPTY_SHELL_HINT_CHARS, clearLiveCodes, loadLiveCodes, loadLiveUrl, readLiveReading, readPoolSummary, saveLiveCodes } from '../../../mcloud/tasks/liveRoom.ts';
import { xiaohongshuProfileHeaders } from '../../../mcloud/liveKouling.ts';
import { localStamp } from '../../../mcloud/koulingPool.ts';
import { loadGateState, readGateReading, runLiveGate } from '../../../mcloud/tasks/liveGateTask.ts';
import { listenReadingLine, loadListenState, runLiveListen } from '../../../mcloud/tasks/liveListen.ts';
import { claimEnabled, collectCodes, loadDrawState, probeLiveRoom, runLiveDraw, setClaimEnabled } from '../../../mcloud/tasks/liveDraw.ts';
import { loadWakePlan, planTrusted } from '../../../mcloud/tasks/liveAutoTask.ts';
import { callRawText } from '../../../mcloud/client.ts';
import { json, readBody } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';

/** live 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function liveRoutes(deps: RouteDeps, base: string, verify: () => { ok: boolean; note: string }): RouteEntry[] {
  void verify;
  return [
{
      // 直播口令（只读那半）：自动抓到的读数 + **人给的口令**。
      // 界面要能看见 —— 否则"抓主页"就只是日志里的一行数。
      path: `${base}/live`,
      method: 'GET',
      handler: () =>
        json(200, {
          reading: readLiveReading(deps.store),
          codes: loadLiveCodes(deps.store),
          url: loadLiveUrl(deps.store),
          emptyShellHintChars: EMPTY_SHELL_HINT_CHARS,
          // 口令池（业务档，照 mcloud）：**口令的权威来源**（读数只是最近一次抓取的快照）。
          // 界面要能看见「够没够 2 条有效」「还要等多久才能再抓」「哪些判过无效」。
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
          // 直播日程（门）：只读探针的读数 —— 门开没开、看到几间房、「下一场」在 pool 里
          gate: readGateReading(deps.store),
          // 听弹幕（第二十三轮）：窗口里的过程事实 —— 收到几帧、几条弹幕、哪几条口令
          listen: {
            reading: loadListenState(deps.store),
            line: listenReadingLine(loadListenState(deps.store)),
          },
          // 直播自动定时（mcloud 的 `live_auto`）：**下一次几点醒**。
          // 它只有读数、没有动作 —— 定时器算时刻，听弹幕那条链到点才动。
          auto: (() => {
            const nowMs = Date.parse(deps.now());
            const plan = loadWakePlan(deps.store);
            const sum = readPoolSummary(deps.store, localStamp(nowMs), nowMs);
            return {
              nextStart: sum.nextStart ?? '',
              wakeAt: plan?.wakeAt ?? '',
              wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
              expr: plan?.expr ?? '',
              fromStart: plan?.fromStart ?? '',
              trusted: planTrusted(sum.scheduleAtMs, nowMs),
              line:
                plan === null
                  ? sum.nextStart === undefined || sum.nextStart === ''
                    ? '没有日程 ⇒ 不排定时（门探到「下一场」才会排）'
                    : '日程太旧 ⇒ 不按它睡（等门下次探到再说）'
                  : `下一次醒 ${plan.wakeAt}（= ${plan.fromStart} +1 小时）`,
            };
          })(),
          note:
            '口令本身**没法自动化**（主播在弹幕/小红书发，那边无法鉴权）⇒ 要人给；' +
            '能自动的只有「抓主页 + 列出看到的口令」。',
          // 写那半（领小红花）：默认关，开关在这里
          claim: {
            enabled: claimEnabled(deps.store),
            codes: collectCodes(deps.store, Date.parse(deps.now())),
            state: loadDrawState(deps.store),
          },
        }),
    },

{
      // **只读探针**：一枪 `user/info`，回答"这一族能不能通"（不记账、不写状态）。
      // 没有它，"验请求头"得先有真口令，而口令只在直播那一小时有效。
      path: `${base}/live/draw/probe`,
      method: 'POST',
      handler: () => {
        const r = probeLiveRoom({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
        });
        deps.log(`小红花探针：${r.note}`);
        return json(200, r);
      },
    },

{
      // 开关：领小红花（写）。默认关。
      path: `${base}/live/claim`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (typeof body.enabled !== 'boolean') {
          return json(400, { error: '需要 {"enabled": true|false}' });
        }
        setClaimEnabled(deps.store, body.enabled, deps.now());
        deps.log(`领小红花：${body.enabled ? '已开启（会真往账号里写）' : '已关闭'}`);
        return json(200, { enabled: claimEnabled(deps.store) });
      },
    },

{
      // **推进一步**（一次调用一个上游请求 —— 面板执行预算 2000ms，见 liveDraw.ts 文件头）。
      //
      // 为什么是"一步"而不是"跑完整条链"：一个从头发到尾的函数会在第 2、3 个请求处
      // 被判超时，而那时**上游的账已经记了**。界面上那个按钮是**浏览器循环调这里**
      // 直到 `done` —— 每步一次 HTTP，每次一个上游请求。
      path: `${base}/live/draw/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveDraw(
          {
            store: deps.store,
            transport: deps.transport,
            nowIso: deps.now(),
            baseUrl: loadBaseUrl(deps.store),
          },
          { force: true }, // 手动那一枪不受开关限制（开关只管 cron）
        );
        const state = loadDrawState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: state?.step === 'done' || out.idle === true,
          state,
        });
      },
    },

{
      // 直播日程（门）：**推进一步**（handshake 步两发 / rooms 步两发，见 liveGateTask.ts）。
      // 与 `live/draw/step` 同一个形状：界面上的按钮是浏览器循环调这里直到 `done`。
      path: `${base}/live/gate/step`,
      method: 'POST',
      handler: () => {
        const out = runLiveGate({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
        });
        const st = loadGateState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || out.idle === true,
          step: st?.step ?? 'handshake',
          reading: readGateReading(deps.store),
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
        });
      },
    },

{
      // 听弹幕推进一步（界面上的「听一拍」/ e2e 用）。
      // ⚠ 与门那个 step 口子同样的形状（`done` + `note` + `reading`），
      //   因为它们是**同一类**东西：一个按步骤推进的只读探针。
      path: `${base}/live/listen/step`,
      method: 'POST',
      handler: () => {
        const st0 = loadListenState(deps.store);
        if (deps.ws === undefined) {
          // ⚠ 宿主没有长连接能力时**明确说不**，而不是走到一半才发现
          //   （Python / Node 适配器都是"函数存在、调用时抛"）。
          return json(503, { error: '宿主没有长连接能力（ws_*）—— 这一族只有嵌入式 JS 宿主有' });
        }
        const out = runLiveListen({
          store: deps.store,
          transport: deps.transport,
          host: deps.ws,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
          lateMs: 0,
        });
        const st = loadListenState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === 'done' || st?.step === undefined,
          step: st?.step ?? 'idle',
          reading: st,
          line: listenReadingLine(st),
          windowOpen: st0?.step === 'listen' || st0?.step === 'open',
        });
      },
    },

{
      // 调试口：原样返回这次小红书请求的 body。只读、无凭据；
      // 用户要核对“到底请求到了什么”时，不能只给字符数。
      path: `${base}/live/raw`,
      method: 'GET',
      handler: () => {
        const url = loadLiveUrl(deps.store);
        const res = callRawText(deps.transport, {
          url,
          method: 'GET',
          headers: xiaohongshuProfileHeaders(),
          body: undefined,
        });
        deps.log(`小红书原始页：HTTP ${res.status}，${res.chars} 字符`);
        return json(200, {
          url,
          status: res.status,
          ok: res.ok,
          chars: res.chars,
          error: res.error,
          text: res.text,
        });
      },
    },

{
      path: `${base}/live/codes`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearLiveCodes(deps.store, deps.now());
          deps.log('直播口令：已清空');
          return json(200, { cleared: true });
        }
        // `readBody` 对"不是 JSON 的 body"会兜成 `{session: 原文}`（让人少一步转换）
        // —— 这里顺着那个约定，贴纯文本也能存
        const raw =
          typeof body.codes === 'string'
            ? body.codes
            : typeof body.session === 'string'
              ? body.session
              : '';
        if (!raw.trim()) {
          return json(400, { error: '需要 {"codes": "<口令，一行一条>"} 或 {"clear": true}' });
        }
        const r = saveLiveCodes(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error ?? '解不出口令' });
        // ⚠ 口令不是账号凭据（它是**共享资源**，谁拿到都能用），所以这里如实回显
        deps.log(`直播口令：存了 ${r.codes.length} 条（${r.how}）`);
        return json(200, {
          saved: r.codes.length,
          codes: r.codes,
          how: r.how,
          stored: loadLiveCodes(deps.store),
        });
      },
    }
  ];
}
