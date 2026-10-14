// 插件 `mcloud-live` —— 用户可见任务「直播」。
//
// # 一个函数从头跑到尾
//
// 老版本这里是 5 条 cron（`live-room` / `live-gate` / `live-listen` /
// `live-auto` / `live-draw`），各自一个节奏：30 分钟 / 10 分钟 / 10 秒 /
// 5 分钟 / 30 秒。在面板上就是 5 行任务，名字分别是「直播口令（只看）」
// 「直播日程（门）」「听弹幕口令」「直播自动定时」「领小红花」——
// 用户要自己拼出「它们是同一件事的五个零件」。
//
// 现在是一条任务、**一个听窗口**：一次触发里判门 → 读口令 → 听弹幕 → 领小红花。
//
// # 「听窗口」是这条任务的核心
//
// 口令只在**开播那一小时**有效，而弹幕是**实时**的 —— 所以「听」这件事必须
// 在一段**连续时间**里反复读。老版本用 `@every 10s` 的 cron 来近似，
// 但那让「听」变成了「每 10 秒看一眼」，两帧之间漏掉的东西只能靠宿主的
// 无界队列补 —— 补不补得上取决于队列有多深。
//
// 现在预算够长，可以在一**次**触发里连听几十秒：`@every 1m` + 70 秒预算，
// 窗口内循环读帧直到快到上限。门关着时第一次调用就进冷却、返回 `idle`，
// 循环立刻停下 —— **零请求**，和以前一样便宜。
//
// # 两种模式
//
//   ① **手动**：用户在界面上贴一条口令 → 直接进「领」那一段（听窗口跳过）
//   ② **自动**：预先设好时段 → 到点自动起听窗口 → 听到口令自动领
//
// 两种模式共用同一个 `runLiveDraw`（它有 `force` 口子，见 liveDraw.ts）。
// 模式 ② 的「到点」由 `runLiveAuto` 算（**只算时刻，一个上游请求都不发**），
// 听窗口的冷却会睡到那一刻。

import { log, register_cron, warn, worker_hint } from 'host-api';
import { runLiveAuto } from '../mcloud/tasks/liveAutoTask.ts';
import { runLiveDraw } from '../mcloud/tasks/liveDraw.ts';
import { runLiveGate } from '../mcloud/tasks/liveGateTask.ts';
import { loadListenSeconds, runLiveListen } from '../mcloud/tasks/liveListen.ts';
import type { ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { runLiveRoom } from '../mcloud/tasks/liveRoom.ts';
import type { TaskDeps, TaskOutcome } from '../mcloud/tasks/base.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  makeHost,
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

// 独占线程：听窗口是**连续几十秒**的占用，和别的插件共用线程会把它们全拖住
// （见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
const host = makeHost();

/** 听窗口预算。70 秒 = 一分钟的 cron 周期 + 10 秒余量，
 *  这样窗口之间几乎不留缝（口令是当场有效的东西，缝就是漏）。 */
const BUDGET_MS = 70_000;
/** 主动收手的时刻：留 15 秒给「领小红花」那一段（它要发好几个请求）。 */
const LISTEN_DEADLINE_MS = BUDGET_MS - 15_000;

function listenDeps(deps: TaskDeps): ListenDeps {
  return { ...deps, host };
}

/** 一趟直播。 */
function runLive(deps: TaskDeps): { ok: boolean; note: string; detail: string[] } {
  const started = Date.now();
  const detail: string[] = [];

  const step = (name: string, fn: () => TaskOutcome): TaskOutcome => {
    try {
      const r = fn();
      detail.push(`${name}：${r.ok ? '' : '失败 '}${r.note}`);
      return r;
    } catch (e) {
      const note = `抛异常 ${e instanceof Error ? e.message : String(e)}`;
      detail.push(`${name}：${note}`);
      return { ok: false, note };
    }
  };

  // ① 算下一次窗口（只算时刻，零请求）。听窗口的冷却会睡到那一刻。
  step('自动定时', () =>
    runLiveAuto(deps, { windowMs: loadListenSeconds(store) * 1000 }),
  );

  // ② 门：今天开播了吗 / 下一场几点（只读）
  step('日程门', () => runLiveGate(deps));

  // ③ 口令笔记（公开 GET，**不需要凭据** —— 所以凭据失效时它照样有产出）
  step('口令笔记', () => runLiveRoom(deps));

  // ④ 听窗口：在一次触发里连听几十秒。
  //
  //    循环的出口有两个，都是**正常**出口：
  //      · `idle` —— 门关着（冷却里）或者窗口结束。这时候立刻停，零请求。
  //      · 时间上限 —— 窗口还没完但预算快到了，下一次触发接着听。
  //
  //    ⚠ 这里**不用 `drain`**：`drain` 的语义是「状态机走完」，
  //      而听是一个**持续的**动作（读帧 → 读帧 → …），`idle` 在这里的意思是
  //      「现在不用听」而不是「听完了」。混用会让日志说错话。
  let frames = 0;
  let listenNote = '';
  const ld = listenDeps(deps);
  while (Date.now() - started < LISTEN_DEADLINE_MS) {
    const r = step('听弹幕', () => runLiveListen(ld));
    listenNote = r.note;
    if (!r.ok || r.idle) break;
    frames++;
    // 一次调用读一轮帧（~1.6 秒），所以循环天然有节奏；
    // 这里不再 sleep —— 沙箱里没有 timers（见 docs/host-api.md）。
    if (frames > 60) break; // 兜底：调用方每轮只读一次，60 轮足够覆盖 55 秒
  }
  if (frames > 0) detail.push(`听弹幕：共读 ${frames} 轮`);

  // ⑤ 领小红花（有口令才动；六步链，drain 到走完）
  const r = drain(runLiveDraw, deps, {
    label: '领小红花',
    maxSteps: 12,
    deadlineMs: BUDGET_MS - (Date.now() - started) - 3_000,
    startedAt: started,
  });
  detail.push(`领小红花：${r.note}`);

  const failed = detail.filter((l) => l.includes('失败') || l.includes('抛异常'));
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length > 0) {
    return { ok: false, note: `${failed.length} 步有问题：${failed[0]}`, detail };
  }
  return { ok: true, note: `${listenNote || '未进入听窗口'}（用时 ${elapsed}s）`, detail };
}

register_cron(
  '直播',
  // 一分钟一跳，配合 70 秒预算 ⇒ 窗口之间几乎不留缝。
  // 门关着时第一次调用就进冷却、零请求秒返回。
  '@every 1m',
  (p: TaskPayload) => {
    const deps = taskDeps(store, transport, p);
    const r = runLive(deps);

    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.note,
    });
    if (r.ok) log(`直播：${r.note}`);
    else warn(`直播：${r.note}`);
    for (const line of r.detail) {
      if (line.includes('失败') || line.includes('抛异常')) warn(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS },
);

log(`mcloud-live：任务「直播」（预算 ${BUDGET_MS / 1000}s，独占线程）`);
