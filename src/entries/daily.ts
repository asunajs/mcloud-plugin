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
// ⚠ **一天两次**，不是"白天每 30 分钟一跳"。
//
// 老版本是 `*/30 7-22` —— 一天 30 次，而每一次做的是**同一件事**（签到 + 领豆 +
// 领小红花）。用户看到任务列表里那个表达式就说了：「太特么频繁了」「日常每天两次？」。
//
// 触发频率该由"**这件事一天发生几次**"决定，不是由"多久看一眼"决定。
//
// 上面那条"面板不补跑"的顾虑仍然成立，所以选的是 `0 8,20`（**两次**）而不是
// "每天 8:00 一次"：两次里漏掉一次还有另一次，而且这个族本身有
// 「今天已经整趟成功」的标记兜底（它挡的是**重跑**，不是频率）。
// 哪一步失败了就不落标记，下一跳重试 —— 这才是「一次运行 = 一个结果」该有的样子。
//
// ⚠ 标记用的是 **UTC 日期**。UTC+8 的用户在本地 08:00 之前拿到的是前一天的 UTC 日期，
// 所以 7 点那一跳和 8 点那一跳会各跑一次整趟；第二次上游已经签过了，各步自己会
// 秒返回。这是**刻意接受**的：宁可多一次便宜的整趟，也不要漏掉一整天。


import { debug, register_cron, warn } from 'host-api';
import { blockersFor, setTaskBlockers, setTaskSummary, summaryFor } from '../mcloud/taskReadiness.ts';
import { runAuthRefresh } from '../mcloud/authRefresh.ts';
import { appendRun } from '../mcloud/runLog.ts';
import {
  loadAuthRaw,
  loadExchange,
  needExchange,
  runExchangeStep,
  startExchange,
} from '../mcloud/sessionExchange.ts';
import type { SessionRecipe } from '../mcloud/h5session.ts';
import { labelOf, shortLabel } from '../mcloud/taskAccounts.ts';
import { logBoth } from '../mcloud/log.ts';
import { isPlumbing, lineLevel, lineText, onceHint, stepTally, userLine } from '../mcloud/tasks/stepLog.ts';
import { loadQueue } from '../mcloud/tasks/receive.ts';
import { rawStoreOf, scoped } from '../store/scoped.ts';

/** 这一趟要跑的族**分别落在哪一页** —— 一页一张票，所以按页换。
 *
 *  ⚠ 这里列的是"这一趟真的会用到票的页"。多列一页的代价是每次多三枪；
 *  少列一页的代价是那一族**用错页面的票**（而"行不行"没有样本）。 */
const DAILY_PAGES: readonly SessionRecipe[] = ['sign-in', 'msg-push-on'];

/** 界面上的名字。用"哪一族"而不是配方编号 —— 用户不认 `sign-in`。 */
const PAGE_LABEL: Record<SessionRecipe, string> = {
  'sign-in': '签到族',
  'msg-push-on': '消息推送',
};
import { MATRIX_MARKETS, runAppTaskMatrix } from '../mcloud/tasks/appTaskMatrix.ts';
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
import { DAILY_DONE_KEY, DAILY_LAST_KEY } from '../mcloud/dailyState.ts';
import type { DailyStep } from '../mcloud/dailyState.ts';
import {
  LONG_REQUEST_TIMEOUT_MS,
  drain,
  makeStore,
  makeTransport,
  notify,
  taskDeps,
  forEachTaskAccount,
} from './shared.ts';
import type { TaskPayload } from './shared.ts';

// 共享粗粒度 lane：日常一次跑几十秒，但不需要毫秒级；和直播排队即可。
// 只有 exchange 和路由插件需要独占（见 shared.ts 文件头）。

const store = makeStore();
// 长预算任务用长超时：一次上游调用慢一点是正常的（见 shared.ts 的说明）
const transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);

/** 整趟的预算。取 2 分钟：够把 ~40 个上游调用跑完，又不至于一条跑飞的链占住线程太久。 */
const BUDGET_MS = 120_000;

/** 主动收手的时刻。比预算早 15 秒 —— 见 shared.ts `drain` 里那段
 *  「主动收手和被掐断在日志里长得完全不一样」。 */
const DEADLINE_MS = BUDGET_MS - 15_000;

// 状态键与读数字形放在 `mcloud/dailyState.ts`：写它的是这里（引 host-api），
// 读它的是路由层（**故意不引 host-api**，那样才能在 Node 里测）。放这里的话
// 路由层就得从 entries/ import，会把 host-api 一起拖进来。
//
// 为什么每步都要落盘：面板的日志是**环形 200 行**、混着所有插件 ——
// 用户在上面只看到「日常：15 步全部完成」一行。「哪一步做了什么」只在我打进
// 日志的那些 warn 行里，而成功的那些**故意没打**（打了就是刷屏）。
// 界面要的是「这一次运行，每一步的结果」⇒ 整趟的结果落一条**读数**。
// 这正是「按一次运行组织的日志」那条需求的落点：组织单位是**一次运行**，
// 而运行的结果是一条读数，不是一个滚动窗口。
// ⚠ 这两个**按账号分**（F-050）—— 全局的话第二个账号的日常会被整个跳过。
//   分法在 `scoped()` 里（store 自己路由），所以这里就是键名。
const DONE_KEY = DAILY_DONE_KEY;
const LAST_KEY = DAILY_LAST_KEY;


/** 一步的调度：跑一次 `step`，把结果收进 `steps` 数组。
 *
 *  为什么不让每一步自己 try/catch：那会把「哪一步抛了」这件事埋进 14 个地方。
 *  集中在这里，异常信息里带得上步骤名。 */
interface StepResult {
  name: string;
  ok: boolean;
  note: string;
  idle?: boolean;
  /** 内部管道步骤（成功时不进用户日志）—— 见 `tasks/stepLog.ts` */
  plumb?: boolean;
}

function once(
  name: string,
  fn: (d: TaskDeps) => TaskOutcome,
  deps: TaskDeps,
): StepResult {
  try {
    const r = fn(deps);
    // `skipped` 也是「这一步什么都没做」—— 运行记录里要显示成灰色，不是绿勾。
    return { name, ok: r.ok, note: r.note, idle: r.idle === true || r.skipped === true };
  } catch (e) {
    return { name, ok: false, note: `抛异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 一趟日常。返回一行结果 + 每一步的结果（落盘给界面读，同时进日志）。 */
function runDaily(deps: TaskDeps): {
  ok: boolean;
  note: string;
  detail: string[];
  steps: DailyStep[];
} {
  const started = Date.now();
  const steps: StepResult[] = [];
  const detail: string[] = [];

  const push = (r: StepResult): StepResult => {
    // ⚠ 每一行都打 `plumb` 标记（管道步骤成功时界面不显示）——
    //   只给 `shape()` 打的话，换票那两行（本函数自己 push 的）会漏掉。
    const one: StepResult = isPlumbing(r.name) ? { ...r, plumb: true } : r;
    steps.push(one);
    // 一行一个用户认得的任务（`userLine` 里定了口径：成了 / 没成+原因 / 跳过）。
    // ⚠ 管道步骤（换票）成功时不出现；「走到第 N 步」这种内部机制也不出现。
    const line = userLine(one);
    if (line !== null) detail.push(line);
    return one;
  };

  // ① 换票（H5 的 jwttoken 约 2 小时即废）。票新鲜时 `needExchange` 直接说不用。
  //
  // ⚠ **一页一张票**，所以这里按页循环。参考实现的实测结论是
  //   「每个页面用自己的参数换自己的票，票与票之间逐字节不等」——
  //   而这一趟要跑的两族正好落在两页上：
  //
  //     签到族（签到 / 备份有礼 / …） → `sign-in`
  //     消息推送奖励                   → `msg-push-on`
  //
  //   只换一页的表现是另一族**用错页面的票**。而那"行不行"**没有样本**
  //   （参考实现自己标的是"反向未验证"）—— 所以不赌，该换的都换。
  //
  // ⚠⚠ 这里必须用 `deps.store`，**不能用模块级那个 `store`**。
  //   模块级那份是"没作用在某个账号上"的（`scopedAccountOf` 得到 undefined），
  //   于是 `loadAuthRaw` 会回落到**当前账号**、`needExchange` 读的也是当前账号的票。
  //   表现：多账号跑的时候，B 的票过期了，判据却在看 A 的票 —— A 刚续过就说"不用换"，
  //   B 的票就这么一直烂着，整段任务「code=90001 未登录」。
  //   （现场 2026-10-17：移动的票 15:33 过期，而「测试」16:31 刚续过 ⇒ 判"还新"，
  //     移动那 8 步全废。与 F-081 同一族。）
  for (const page of DAILY_PAGES) {
    if (needExchange(deps.store, Date.now(), page)) {
      // ⚠ `runExchangeStep` 只**接着走**已有那一轮，它不会**开始**一轮 ——
      //   参考实现里换票是任务自己做的事，没有"让用户去点某个按钮"这一步。
      //   少了这一句，新登录的号永远是「没有会话」，而日志里只说"没有会话"、
      //   不说为什么（因为压根没试）。
      // ⚠ 两种情况都要**开一轮新的**：
      //   ① 从来没换过（`null`）；
      //   ② 上一轮已经 `done`（票过期了要再换一张）—— 只判 `null` 的话，
      //      票过期之后 `runExchangeStep` 只会回"没有待换票的任务"，
      //      于是整趟任务全部 `code=90001 未登录`（现场：13:30 那一趟）。
      const st = loadExchange(deps.store, page);
      if (st === null || st.step === 'done') {
        startExchange(deps.store, loadAuthRaw(deps.store), deps.nowIso, page);
      }
      // ⚠ `runExchangeStep` 返回的是 `{ok, note, done}`，不是 `TaskOutcome` ——
      //   它用 `done` 而不是 `idle` 表示「这一趟走完了」。包一层对上 drain 的契约。
      const r = drain(
        (d) => {
          const x = runExchangeStep(d, page);
          return { ok: x.ok, note: x.note, idle: x.done };
        },
        deps,
        { label: `换票（${PAGE_LABEL[page]}）`, maxSteps: 4, deadlineMs: 30_000, startedAt: started },
      );
      push({ name: `换票（${PAGE_LABEL[page]}）`, ok: r.ok, note: r.note, idle: r.idle });
    } else {
      push({ name: `换票（${PAGE_LABEL[page]}）`, ok: true, note: '还新，不用换', idle: true });
    }
  }

  // ② 签到族。
  //
  // ⚠ 这一族里三条是**多段**的，必须在一次触发里 drain 到走完 —— 见 shared.ts
  //   里 `drain` 那段表格。最要命的是「签到」：它是「问状态 → 提交 → 回查」，
  //   而**回查那一句才是成败判据**。只调一次的话签到会被提交出去、回查永远不跑，
  //   而提交返回的是 ok ⇒ 整趟被判成功 ⇒ 落「今天已完成」标记 ⇒ 回查再也不发生。
  //
  // 判据从状态键读，不从返回值猜：`runSign` 提交完和回查完都是 ok。
  // ⚠ 同样按账号（多账号下读模块级 store 会读到别的号那一格）
  const signPending = () => (deps.store.getState(SIGN_STAGE) ?? '') === 'need-verify';
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
      // ⚠ 领取这一类是"队列里一条一个请求"：**队列空了就停**（`more`），
      //   而不是靠步数上限兜 —— 靠上限兜的表现是"刚好领完"也被说成"没做完"。
      maxSteps: 24,
      deadlineMs: 40_000,
      startedAt: started,
      ...(name === '领取AI豆' ? { more: () => loadQueue(deps.store).length > 0 } : {}),
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
  // ⚠ 矩阵是**轮着读**的：一次调用只读一个市场（`MATRIX_MARKETS` 两个）。
  //   旧的靠「每 15 分钟一跳」在几个小时内把一轮读满 —— 而一轮没读满时，
  //   待办列表是**不全**的，App 任务就会漏做。
  //   所以这里 drain **整一轮**：两发，很便宜，而且读完就是完整读数。
  push(
    (() => {
      const r = drain(runAppTaskMatrix, deps, {
        label: 'App 任务矩阵',
        maxSteps: MATRIX_MARKETS.length,
        deadlineMs: 25_000,
        startedAt: started,
      });
      // 它不报 idle（每读一个市场都是"有事做"），所以 drain 会正好跑满 maxSteps。
      // 但对用户来说它是**只读**，不是这一趟做成了什么 ⇒ 运行记录里标 idle。
      return { name: 'App 任务矩阵（只看）', ok: r.ok, note: r.note, idle: true };
    })(),
  );
  // 没有在跑的就起一趟（起单只写字、不发请求）。
  // ⚠ 起不出来时**用它自己的话**（「另有 4 条要在 App 里手动做」）——
  //   这里硬写"没有待办"会和上一行「还能做 4 条」自相矛盾（用户就是这么发现的）。
  const kick = deps.store.getState('mcloud.apptask.state') ? null : startAppTask(deps);
  if (kick !== null && kick.idle) {
    push({ name: 'App 任务', ok: true, note: kick.note, idle: true });
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
    // 「问状态」是只读，不是动作；「领」才可能真的做成一件事。
    push({ name, ok: r.ok, note: r.note, idle: name.includes('问状态') ? true : r.idle });
  }

  // ⑥ 凭据续期（每天判一次，离过期还远时一个请求都不发）
  push(once('凭据续期', (d) => runAuthRefresh(d), deps));

  // ⑦ 收尾读数
  // 收尾两发都是**只读**：它们回答"现在有什么"，不是"这一趟做成了什么"。
  push({ ...once('待领取奖品', runPrizes, deps), idle: true });
  push({ ...once('AI豆快照', runCloudSnapshot, deps), idle: true });

  const failed = steps.filter((s) => !s.ok);
  const elapsed = Date.now() - started;
  const done = steps.filter((s) => !s.idle).length;

  const shape = (r: StepResult): DailyStep => ({
    name: r.name,
    ok: r.ok,
    note: r.note,
    idle: r.idle === true,
    ...(isPlumbing(r.name) ? { plumb: true } : {}),
  });

  if (failed.length === 0) {
    return {
      ok: true,
      note: `${steps.length} 步全部完成（${done} 步有动作，用时 ${(elapsed / 1000).toFixed(1)}s）`,
      detail,
      steps: steps.map(shape),
    };
  }
  return {
    ok: false,
    // ⚠ 不再把失败的名字串成一句：那是一张表塞进一行话里，
    //   而"哪几步"已经在 `steps` 里、日志里也一行一步了。
    // chip 上显示的就是这一句；不提步数（用户不看那个）
    // ⚠ 全是「未登录」的时候要说一句 —— 但那句话是**给用户下一步**，
    //   不是解释内部机制（票多长、什么时候到期，他既管不了也不需要知道）。
    //   正常情况下这一趟根本不该走到这里：票由任务自己续（见上面 ① 换票）。
    //   真走到这里 = 自动续票也没成（凭据废了），这时唯一有意义的动作就是重新导入。
    note: (() => {
      const { bad, hard } = stepTally(steps);
      const skipped = bad - hard;
      const base = `${steps.length - bad} 项好了、${hard} 项没成${skipped > 0 ? `、${skipped} 项跳过` : ''}`;
      const allLogin = failed.every((x) => /未登录|没登录|90001|凭据过期|票没被认/.test(x.note));
      if (!allLogin) return base;
      return `${base} —— 登录状态失效了，去「账号」页重新导入会话`;
    })(),
    detail,
    steps: steps.map(shape),
  };
}

// ── 注册 ──

register_cron(
  '日常',
  // 白天每 30 分钟一跳：低配盒子不常在线时，上线之后的下一跳就能补上
  // （面板不补跑，见文件头）。整趟成功后剩下的跳是零请求的秒返回。
  '0 8,20 * * *',
  (p: TaskPayload) => {
    const nowIso = new Date().toISOString();
    const startedMs = Date.parse(nowIso);
    const today = nowIso.slice(0, 10);

    // ── 这一趟跑**这条任务选的账号**（多选 / 全部），**串行** ──
    //
    // ⚠ 串行不是性能取舍，是**必须**：一个插件只有一条工作线程，而且上游有限流。
    //   参考实现的口径：「点击运行后**后端保证串行执行**」。
    //
    // ⚠ 每一条的 `DONE_KEY`（今天跑过没）**在它自己的袋里** —— 所以"今天已经
    //   成功过"要**逐条**判。放在循环外面判一次的话，A 跑完之后 B 就被跳过了
    //   （那正是 F-050 那个"B 的整趟被跳过"的老毛病）。
    // ⚠⚠ **不再有"今天跑过了就跳过"那道闸**（2026-10-17 用户口径）。
    //
    // 原来 08:00 跑成之后，20:00 那一趟会被这道闸直接跳过。用户否了这个设计：
    //
    //   「定时不能第二次就不做，因为目前插件没能力确定小任务是否全部已经
    //     达到预期，第二次跑是容错」
    //
    // 说得对：一趟"成功"只代表**我们以为**都做到了 —— 而"以为"和"上游的实际状态"
    // 是两件事（上游可能把某一步判成"已经做过了"其实没做、领取可能静默失败、
    // 某个步骤可能被判成 idle 提前停下）。插件没有能力证明所有小任务都到了预期状态，
    // 那么一天两趟就该**都跑**：第二趟是兜底，不是重复。
    //
    // 反复跑安全的理由在每一**步**里，不在这道闸上：签到、领取家族都是
    // "先问状态、已经做过就不再发请求"（`skipped` / `idle` 出口）。
    // 所以这里放开闸不会重复领奖，只是又核对一遍。
    //
    // `DONE_KEY` 仍然要写（下面 writeDone 那段）：它现在是**读数**
    // （"今天跑过几趟 / 今天有没有跑过"），不再是闸。

    const runs = forEachTaskAccount(store, '日常', p, transport, (deps) => runDaily(deps));

    // 没选到账号 ⇒ **静默返回**。那不是失败，是"这条任务没配账号"。
    if (runs.length === 0) return;

    const results: typeof runs = [];
    // 这一趟里"已经解释过的后缀"（跨账号共用，见 onceHint）
    const onceHints = new Set<string>();
    const willRun = runs.filter((x) => x.result !== null).length;
    if (willRun > 0) logBoth(store, 'start', `日常 · ${willRun} 个账号`, nowIso);
    for (const [i, one] of runs.entries()) {
      const r = one.result;
      if (r === null) continue; // 这一条今天已经跑过
      results.push(one);

      const who = labelOf(store, one.acctId);
      const note = runs.length > 1 ? `${who}：${r.note}` : r.note;

      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: r.ok,
        note,
      });

      // 同时进**运行记录**（留最近 N 次）。`LAST_KEY` 只有最后一次，
      // 覆盖掉之后"上次明明好的"这类问题就查不了了。
      const runId = appendRun(store, {
        task: 'daily',
        acct: one.acctId,
        who,
        at: nowIso,
        ms: Date.now() - startedMs,
        ok: r.ok,
        note,
        steps: r.steps,
      });

      if (r.ok) {
        // ⚠ 标记落在**这一条自己的袋里**（`deps.store` 已经按账号路由过了）
        // ⚠ 标记必须落在**这一条自己的袋里** —— `deps.store` 已经按账号路由过了，
        //   但它在闭包里，所以这里现取一个"作用在指定账号上"的 store。
        scoped(rawStoreOf(store), one.acctId).setState(DONE_KEY, today, nowIso);
      }
      // 日志照 `mcloud-sign`：账号头用 start，步骤按结论着色，
      // 级联失败只留 debug 的"跳过" —— 根因（换票）才红。
      const tag = `[${shortLabel(who)}]`;
      logBoth(store, 'start', tag, nowIso);
      let prev = '';
      // 级联的“没有网页会话”不逐行刷：一个根因会拖垮十步，逐行写就是十行同样的字。
      // 合并成一行“跳过 N 项（…）”，根因和段尾已经说清了。
      const skippedSteps: string[] = [];
      for (const line of r.detail) {
        // ⚠ `onceHint`：跨账号的同一句解释只说一遍（见 stepLog.ts 那段）
        const shown = lineText(onceHint(line, onceHints));
        if (shown === prev) continue;
        prev = shown;
        if (shown.includes('跳过（没有网页会话）')) {
          skippedSteps.push(shown.split('：')[0] ?? shown);
          continue;
        }
        logBoth(store, lineLevel(shown), `${tag} ${shown}`, nowIso);
      }
      if (skippedSteps.length > 0) {
        const head = skippedSteps.slice(0, 3).join('、');
        logBoth(
          store,
          'debug',
          `${tag} 跳过 ${skippedSteps.length} 项（没有网页会话）：${head}${skippedSteps.length > 3 ? ' 等' : ''}`,
          nowIso,
        );
      }
      const { bad, hard } = stepTally(r.steps);
      // 段尾只说"几项没成"（用户要的是结论）；都成了就一句"都成了"。
      // 级联失败单独说"跳过"，否则 1 个根因会被写成 11 项没成。
      const tail =
        bad === 0
          ? '都成了'
          : hard === 0
            ? `${bad} 项跳过（没有网页会话）`
            : `${hard} 项没成${bad > hard ? `、${bad - hard} 项跳过` : ''}`;
      logBoth(store, hard > 0 ? 'warn' : 'debug', `${tag} ${tail}`, nowIso);
    }

    // 全都"今天已经跑过" ⇒ 静默返回（不推、不记）
    if (results.length === 0) return;

    // 「一次运行」的完整结果落一条读数 —— 界面读它，不用去翻环形日志
    const okAll = results.every((x) => x.result!.ok);
    const okCount = results.filter((x) => x.result!.ok).length;
    logBoth(
      store,
      okAll ? 'success' : 'warn',
      `日常完成：${okCount}/${results.length} 个账号好了`,
      nowIso,
    );
    const summary =
      results.length === 1
        ? results[0]!.result!.note
        : `${results.length} 个账号：${results.filter((x) => x.result!.ok).length} 成功 / ${results.filter((x) => !x.result!.ok).length} 失败`;
    store.setState(LAST_KEY, JSON.stringify({
        at: nowIso,
        ok: okAll,
        note: summary,
        steps: results.flatMap((x) => x.result!.steps),
      }), nowIso);

    // 面板卡片上的“这次跑成什么样”。账号可能在运行期间被删/停用，
    // 所以 blockers 也顺手重算一次（不然卡片会一直停在旧的就绪状态）。
    setTaskBlockers('日常', blockersFor(store, '日常'));
    setTaskSummary('日常', summary);

    // 下面那段推送用这两个名字（原来它们指"那一次"的结果）
    const r = {
      ok: okAll,
      note: summary,
      detail: results.flatMap((x) =>
        results.length > 1
          ? x.result!.detail.map((l) => `${labelOf(store, x.acctId)} ${l}`)
          : x.result!.detail,
      ),
      steps: results.flatMap((x) => x.result!.steps),
    };

    // ── 推送：挂在**一次运行结束**上（不是每条日志推一次）──
    // 正文 = 这次的结果 + **失败的那几步**。带上失败的那几步是必须的：
    // 否则用户收到「有失败」还得回界面翻是哪一步。
    const bad = r.detail.filter((l) => l.includes('失败'));
    notify(
      store,
      transport,
      'daily',
      `日常：${r.ok ? '跑完了' : '有失败'}`,
      [
        r.note,
        '',
        ...r.detail.map((l) => `· ${l}`),
        ...(bad.length > 0 ? ['', '失败的那几步在上面（带 · 的行）'] : []),
      ].join('\n'),
      !r.ok,
    );
  },
  {
    budget_ms: BUDGET_MS,
    // 日常是“随时跑都安全”的环境型任务：面板任务列表里显示，默认 cron 保留。
    // 没账号时是“未就绪”（灰），不是“失败”（红）。
    surface: 'panel',
    summary: summaryFor(store, '日常'),
    blockers: blockersFor(store, '日常'),
  },
);

debug(`mcloud-daily：任务「日常」（预算 ${BUDGET_MS / 1000}s，共享粗粒度 lane）`);
