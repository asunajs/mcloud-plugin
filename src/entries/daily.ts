// 插件 `mcloud-daily` —— 用户可见任务「日常」。
//
// # 一个函数从头跑到尾
//
// 老版本这里是 14 条 cron（`sign` / `receive` / `multiple` / `revival` /
// `backup-gift` / `task-expansion` / `auth-refresh` / `msg-push` /
// `msg-push-obtain` / `notice` / `app-task-matrix` / `app-task` /
// `exchange-list` / `session-refresh`），每条一次只推进一步 —— 因为全局执行
// 预算是 2 秒，一次触发发不了几个请求。
//
// 那套结构在面板上的样子是：14 行任务，名字分别是「签到」「领取AI豆」
// 「签到翻倍」「复活卡」「备份好礼」「任务拓展」…… 用户要自己拼出
// 「它们其实是一件事」。这就是「界面完全搞不懂」的来源之一。
//
// 现在任务可以声明长预算（`{ budget_ms }`），所以这里就是**一个函数**：
// 按固定顺序把每一步跑完，一次触发出一个结果。
//
// # 顺序为什么是这样
//
//   ① 换票      —— 票过期的话后面每一步都会回 `90001 未登录`，
//                  而那个现象看起来像「账号被踢了」
//   ② 签到族    —— 先签到再领（`receive` 依赖签到状态）
//   ③ 任务拓展  —— 状态机，drain 到走完
//   ④ App 任务  —— 先读矩阵（`app-task-matrix`），再做（`app-task`）
//   ⑤ 消息推送奖励 / 开启通知 —— 各自自带判据，没事就秒返回
//   ⑥ 凭据续期  —— 离过期还远时一个请求都不发
//   ⑦ 收尾读数  —— 待领取奖品 / AI豆快照
//
// # 「一天只跑一次」怎么做的
//
// 面板**不补跑**：一个任务落后太多时只重新对齐到当前时刻，错过的触发一律丢掉
// （见 `rust-plugin-panel` 的 `scheduler.rs`）。所以「每天 8:00 打一枪」这种写法
// 在低配盒子（不常在线）上会**整天不跑**。
//
// 于是这里用 `*/30 7-22`（白天每 30 分钟一跳）+ 一个「今天已经整趟成功」的标记：
// 第一次成功的整趟跑完之后，后面每一跳都是**零请求**的秒返回。
// 哪一步失败了就不落标记，下一跳重试 —— 这才是「一次运行 = 一个结果」该有的样子。
//
// ⚠ 标记用的是 **UTC 日期**。UTC+8 的用户在本地 08:00 之前拿到的是前一天的 UTC 日期，
// 所以 7 点那一跳和 8 点那一跳会各跑一次整趟；第二次上游已经签过了，各步自己会
// 秒返回。这是**刻意接受**的：宁可多一次便宜的整趟，也不要漏掉一整天。

import { log, register_cron, warn, worker_hint } from 'host-api';
import { runAuthRefresh } from '../mcloud/authRefresh.ts';
import { needExchange, runExchangeStep } from '../mcloud/sessionExchange.ts';
import { runAppTaskMatrix } from '../mcloud/tasks/appTaskMatrix.ts';
import { runAppTaskStep, startAppTask } from '../mcloud/tasks/appTask.ts';
import { runBackupGift } from '../mcloud/tasks/backupGift.ts';
import { runCloudSnapshot } from '../mcloud/tasks/cloudSnapshot.ts';
import { runMsgPushObtain, runMsgPushStatus } from '../mcloud/tasks/msgPush.ts';
import { runMultiple } from '../mcloud/tasks/multiple.ts';
import { runNotice } from '../mcloud/tasks/notice.ts';
import { runPrizes } from '../mcloud/tasks/prizes.ts';
import { runReceive } from '../mcloud/tasks/receive.ts';
import { runRevival } from '../mcloud/tasks/revival.ts';
import { STATE_STAGE as SIGN_STAGE, runSign } from '../mcloud/tasks/sign.ts';
import { runExpansionStep, startExpansion } from '../mcloud/tasks/taskExpansion.ts';
import type { TaskDeps, TaskOutcome } from '../mcloud/tasks/base.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  makeStore,
  makeTransport,
  taskDeps,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

// 独占线程：这条链一次跑几十秒，和别的插件共用线程会互相拖（见 shared.ts 文件头）
worker_hint('exclusive');

const store = makeStore();
// 长预算任务用长超时：一次上游调用慢一点是正常的（见 shared.ts 的说明）
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

/** 整趟的预算。取 2 分钟：够把 ~40 个上游调用跑完，又不至于一条跑飞的链占住线程太久。 */
const BUDGET_MS = 120_000;

/** 主动收手的时刻。比预算早 15 秒 —— 见 shared.ts `drain` 里那段
 *  「主动收手和被掐断在日志里长得完全不一样」。 */
const DEADLINE_MS = BUDGET_MS - 15_000;

const DONE_KEY = 'mcloud.daily.done_date';

/** 一步的调度：跑一次 `step`，把结果收进 `steps` 数组。
 *
 *  为什么不让每一步自己 try/catch：那会把「哪一步抛了」这件事埋进 14 个地方。
 *  集中在这里，异常信息里带得上步骤名。 */
interface StepResult {
  name: string;
  ok: boolean;
  note: string;
  idle?: boolean;
}

function once(
  name: string,
  fn: (d: TaskDeps) => TaskOutcome,
  deps: TaskDeps,
): StepResult {
  try {
    const r = fn(deps);
    return { name, ok: r.ok, note: r.note, idle: r.idle === true };
  } catch (e) {
    return { name, ok: false, note: `抛异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 一趟日常。返回一行结果 + 每一步的原话（进日志）。 */
function runDaily(deps: TaskDeps): { ok: boolean; note: string; detail: string[] } {
  const started = Date.now();
  const steps: StepResult[] = [];
  const detail: string[] = [];

  const push = (r: StepResult): StepResult => {
    steps.push(r);
    detail.push(`${r.name}：${r.ok ? '' : '失败 '}${r.note}`);
    return r;
  };

  // ① 换票（H5 的 jwttoken 约 2 小时即废）。票新鲜时 `needExchange` 直接说不用。
  if (needExchange(store, Date.now())) {
    // ⚠ `runExchangeStep` 返回的是 `{ok, note, done}`，不是 `TaskOutcome` ——
    //   它用 `done` 而不是 `idle` 表示「这一趟走完了」。包一层对上 drain 的契约。
    const r = drain(
      (d) => {
        const x = runExchangeStep(d);
        return { ok: x.ok, note: x.note, idle: x.done };
      },
      deps,
      { label: '换票', maxSteps: 4, deadlineMs: 30_000, startedAt: started },
    );
    push({ name: '换票', ok: r.ok, note: r.note, idle: r.idle });
  } else {
    push({ name: '换票', ok: true, note: '票还新鲜，不用换', idle: true });
  }

  // ② 签到族。
  //
  // ⚠ 这一族里三条是**多段**的，必须在一次触发里 drain 到走完 —— 见 shared.ts
  //   里 `drain` 那段表格。最要命的是「签到」：它是「问状态 → 提交 → 回查」，
  //   而**回查那一句才是成败判据**。只调一次的话签到会被提交出去、回查永远不跑，
  //   而提交返回的是 ok ⇒ 整趟被判成功 ⇒ 落「今天已完成」标记 ⇒ 回查再也不发生。
  //
  // 判据从状态键读，不从返回值猜：`runSign` 提交完和回查完都是 ok。
  const signPending = () => (store.getState(SIGN_STAGE) ?? '') === 'need-verify';
  push(
    (() => {
      const r = drain(runSign, deps, {
        label: '签到',
        maxSteps: 4,
        deadlineMs: 20_000,
        startedAt: started,
        more: signPending,
      });
      return { name: '签到', ok: r.ok, note: r.note, idle: r.idle };
    })(),
  );
  // 这三条的「做完了」信号是 `skipped: true`（条件不成立时不发请求），
  // 所以不给 `more` —— drain 认 skipped 就够
  for (const [name, fn] of [
    ['领取AI豆', runReceive],
    ['备份好礼', runBackupGift],
    ['开启通知领AI豆', runNotice],
  ] as const) {
    const r = drain(fn, deps, {
      label: name,
      maxSteps: 12,
      deadlineMs: 40_000,
      startedAt: started,
    });
    push({ name, ok: r.ok, note: r.note, idle: r.idle });
  }
  // 这两条是单发动作（各自只有一个状态键，没有多段）
  for (const [name, fn] of [
    ['签到翻倍', runMultiple],
    ['复活卡', runRevival],
  ] as const) {
    push(once(name, fn, deps));
  }

  // ③ 任务拓展（状态机：读 → 传文件触发备份 → 领云朵）
  if (!store.getState('mcloud.taskexpansion.state')) startExpansion(deps);
  push(
    (() => {
      const r = drain(runExpansionStep, deps, {
        label: '任务拓展',
        maxSteps: 12,
        deadlineMs: 45_000,
        startedAt: started,
      });
      return { name: '任务拓展', ok: r.ok, note: r.note, idle: r.idle };
    })(),
  );

  // ④ App 任务：先读矩阵（只读），再做（写，且 `task/click` **不可回滚**）
  push(once('App 任务矩阵（只看）', runAppTaskMatrix, deps));
  // 没有在跑的就起一趟（起单只写字、不发请求）；起不出来说明没有待办
  if (!store.getState('mcloud.apptask.state') && startAppTask(deps).idle) {
    push({ name: 'App 任务', ok: true, note: '没有待办', idle: true });
  } else {
    const r = drain(runAppTaskStep, deps, {
      label: 'App 任务',
      maxSteps: 20,
      deadlineMs: 60_000,
      startedAt: started,
    });
    push({ name: 'App 任务', ok: r.ok, note: r.note, idle: r.idle });
  }

  // ⑤ 消息推送奖励：**两步**（问状态 → 领）。
  //    两条都各自带判据，所以 drain 会让「没得领」的那条一次就停。
  for (const [name, fn] of [
    ['消息推送奖励（问状态）', runMsgPushStatus],
    ['消息推送奖励（领）', runMsgPushObtain],
  ] as const) {
    const r = drain(fn, deps, {
      label: name,
      maxSteps: 6,
      deadlineMs: 20_000,
      startedAt: started,
    });
    push({ name, ok: r.ok, note: r.note, idle: r.idle });
  }

  // ⑥ 凭据续期（每天判一次，离过期还远时一个请求都不发）
  push(once('凭据续期', (d) => runAuthRefresh(d), deps));

  // ⑦ 收尾读数
  push(once('待领取奖品', runPrizes, deps));
  push(once('AI豆快照', runCloudSnapshot, deps));

  const failed = steps.filter((s) => !s.ok);
  const elapsed = Date.now() - started;
  const done = steps.filter((s) => !s.idle).length;

  if (failed.length === 0) {
    return {
      ok: true,
      note: `${steps.length} 步全部完成（${done} 步有动作，用时 ${(elapsed / 1000).toFixed(1)}s）`,
      detail,
    };
  }
  return {
    ok: false,
    note: `${failed.length}/${steps.length} 步失败：${failed.map((f) => f.name).join('、')}`,
    detail,
  };
}

// ── 注册 ──

register_cron(
  '日常',
  // 白天每 30 分钟一跳：低配盒子不常在线时，上线之后的下一跳就能补上
  // （面板不补跑，见文件头）。整趟成功后剩下的跳是零请求的秒返回。
  '*/30 7-22 * * *',
  (p: TaskPayload) => {
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);

    // 今天已经整趟成功过 ⇒ 零请求秒返回。
    //
    // ⚠ 这一步**不记 run**：记了的话面板上会看到一天 30 条「跳过」，
    //   把真事件埋掉（老版本实机 soak 踩过这个，见 main.ts 里 lastLogged 那段）。
    // ⚠ `getState` 返回的是**字符串本身**（不是 `{value}` 那种行对象）—— 见 store/types.ts
    const doneDate = store.getState(DONE_KEY);
    if (doneDate === today) return;

    const deps = taskDeps(store, transport, p);
    const r = runDaily(deps);

    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.note,
    });

    if (r.ok) {
      store.setState(DONE_KEY, today, nowIso);
      log(`日常：${r.note}`);
    } else {
      // 不落标记 ⇒ 下一跳重试（这正是「一次运行 = 一个结果」该有的样子）
      warn(`日常：${r.note}`);
    }
    // 每一步的原话都进日志：出问题时「走到哪一步」是最要紧的信息
    for (const line of r.detail) {
      if (line.includes('失败')) warn(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS },
);

log(`mcloud-daily：任务「日常」（预算 ${BUDGET_MS / 1000}s，独占线程）`);
