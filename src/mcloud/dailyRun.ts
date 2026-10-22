// 「日常」整趟逻辑 —— 面板入口与 Node 独立入口共用。
//
// 这里只放**不依赖 host-api** 的任务编排；账号循环、cron、日志落盘留在入口。

import { drain } from '../drain.ts';
import { isPlumbing, stepTally, userLine } from './tasks/stepLog.ts';
import type { TaskDeps, TaskOutcome } from './tasks/base.ts';
import type { DailyStep } from './dailyState.ts';
import type { SessionRecipe } from './h5session.ts';
import {
  loadAuthRaw,
  loadExchange,
  needExchange,
  runExchangeStep,
  startExchange,
} from './sessionExchange.ts';
import { MATRIX_MARKETS, runAppTaskMatrix } from './tasks/appTaskMatrix.ts';
import { appTaskFresh, runAppTaskStep, startAppTask } from './tasks/appTask.ts';
import { runBackupGift } from './tasks/backupGift.ts';
import { runMsgPushObtain, runMsgPushStatus } from './tasks/msgPush.ts';
import { runMultiple } from './tasks/multiple.ts';
import { runNotice } from './tasks/notice.ts';
import { runPrizes } from './tasks/prizes.ts';
import { runReceive } from './tasks/receive.ts';
import { runRevival } from './tasks/revival.ts';
import { STATE_STAGE as SIGN_STAGE, runSign } from './tasks/sign.ts';
import { runExpansionStep, startExpansion } from './tasks/taskExpansion.ts';
import { loadQueue } from './tasks/receive.ts';
import { runAuthRefresh } from './authRefresh.ts';

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
/** 一步的调度：跑一次 `step`，把结果收进 `steps` 数组。
 *
 *  为什么不让每一步自己 try/catch：那会把「哪一步抛了」这件事埋进 14 个地方。
 *  集中在这里，异常信息里带得上步骤名。 */
interface StepResult {
  name: string;
  ok: boolean;
  note: string;
  idle?: boolean;
  /** 动作做了、等服务端确认（不是失败） */
  pending?: boolean;
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
    return {
      name,
      ok: r.ok,
      note: r.note,
      idle: r.idle === true || r.skipped === true,
      pending: r.pending === true,
    };
  } catch (e) {
    return { name, ok: false, note: `抛异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 一趟日常。返回一行结果 + 每一步的结果（落盘给界面读，同时进日志）。 */
export function runDaily(
  deps: TaskDeps,
  opts: {
    onLine?: (line: string) => void;
    onPhase?: (phase: string) => void;
    /** 长状态机的逐步原话（上传 / 打卡 / 重试）—— 不等整步结束。 */
    onNote?: (note: string) => void;
  } = {},
): {
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
    if (line !== null) {
      detail.push(line);
      // 边跑边打：面板的日志流是实时的，但以前要等 `runDaily` 整趟返回
      // 才在入口统一打印，任务一慢就只剩开头三行。
      opts.onLine?.(line);
    }
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
  opts.onPhase?.('正在检查登录票');
  for (const page of DAILY_PAGES) {
    opts.onPhase?.(`换票（${PAGE_LABEL[page]}）`);
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
  opts.onPhase?.('签到');
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
  // 这两条是单发动作（各自只有一个状态键，没有多段）
  for (const [name, fn] of [
    ['签到翻倍', runMultiple],
    ['复活卡', runRevival],
  ] as const) {
    push(once(name, fn, deps));
  }

  // ③ 任务拓展（状态机：读 → 随机文件+快照触发备份 → 清理自己造的；不再领云朵）
  // ⚠ 不能只看“键在不在”：`done` 是**当天**的完成标记，跨天必须重新起。
  const expKick = startExpansion(deps);
  if (expKick.idle) {
    push({ name: '任务拓展', ok: true, note: expKick.note, idle: true });
  } else {
    push(
      (() => {
        const r = drain(runExpansionStep, deps, {
          label: '任务拓展',
          maxSteps: 12,
          deadlineMs: 45_000,
          startedAt: started,
          onStep: (note) => opts.onNote?.(`任务拓展：${note}`),
        });
        return { name: '任务拓展', ok: r.ok, note: r.note, idle: r.idle };
      })(),
    );
  }

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
  // ⚠ 跨天的 `done` 不算「今天已经起过」—— 只看键在不在，昨天的「做完了」会把今天
  //   永远挡在门外（现场：移动的 apptask.state 停在 10-17，连续几天一个任务都没做）。
  const kick = appTaskFresh(deps) ? null : startAppTask(deps);
  if (kick !== null && kick.idle) {
    push({ name: 'App 任务', ok: true, note: kick.note, idle: true });
  } else {
    const r = drain(runAppTaskStep, deps, {
      label: 'App 任务',
      maxSteps: 20,
      deadlineMs: 60_000,
      startedAt: started,
      // 上传 / 访问日志 / 打卡 / 重试逐步打出来；否则日志只剩最后一句
      // 「这一趟没有全确认」，用户看不到文件到底传没传。
      onStep: (note) => opts.onNote?.(`App 任务：${note}`),
    });
    push({ name: 'App 任务', ok: r.ok, note: r.note, idle: r.idle, pending: r.pending === true });
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

  // ⑥ 领取类必须放在**所有会产生奖励的动作之后**：签到/任务拓展/App 任务/
  //    消息推送都会往 receiveList 里放新条目，先领就会漏掉这一趟刚挣到的。
  //    三条的「做完了」信号都是 `skipped: true`，所以不给 `more`。
  for (const [name, fn] of [
    ['备份好礼', runBackupGift],
    ['开启通知领AI豆', runNotice],
    ['领取AI豆', runReceive],
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

  // ⑦ 凭据续期（每天判一次，离过期还远时一个请求都不发）
  push(once('凭据续期', (d) => runAuthRefresh(d), deps));

  // ⑧ 收尾读数
  // 收尾两发都是**只读**：它们回答"现在有什么"，不是"这一趟做成了什么"。
  push({ ...once('待领取奖品', runPrizes, deps), idle: true });
  // mcloud 2026-10-07 起把 `cloud-snapshot` / `task-list` 从任务注册里摘掉，
  // 读数改由「上游状态 / 数据」页按需取 —— 这里不再作为日常一步跑。

  // ⚠ `pending` 不是失败：动作做了、服务端还没确认，不能把整趟染红。
  const pendingCount = steps.filter((s) => s.pending === true).length;
  const failed = steps.filter((s) => !s.ok && s.pending !== true);
  const elapsed = Date.now() - started;
  const done = steps.filter((s) => !s.idle && s.pending !== true).length;

  const shape = (r: StepResult): DailyStep => ({
    name: r.name,
    ok: r.ok,
    note: r.note,
    idle: r.idle === true,
    pending: r.pending === true,
    ...(isPlumbing(r.name) ? { plumb: true } : {}),
  });

  if (failed.length === 0) {
    return {
      ok: true,
      note:
        pendingCount > 0
          ? `${steps.length} 步都有结果（${done} 步有动作，${pendingCount} 项等服务端确认，用时 ${(elapsed / 1000).toFixed(1)}s）`
          : `${steps.length} 步全部完成（${done} 步有动作，用时 ${(elapsed / 1000).toFixed(1)}s）`,
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
      const base = `${steps.length - bad - pendingCount} 项好了、${hard} 项没成${
        pendingCount > 0 ? `、${pendingCount} 项等服务端确认` : ''
      }${skipped > 0 ? `、${skipped} 项跳过` : ''}`;
      const allLogin = failed.every((x) => /未登录|没登录|90001|凭据过期|票没被认/.test(x.note));
      if (!allLogin) return base;
      return `${base} —— 登录状态失效了，去「账号」页重新导入会话`;
    })(),
    detail,
    steps: steps.map(shape),
  };
}
