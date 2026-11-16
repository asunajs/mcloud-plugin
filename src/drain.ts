// 「一次一步」→「一个函数从头跑到尾」的核心原语。
//
// # 为什么要单独一个文件
//
// 它**不引 host-api**（纯逻辑，只依赖两个类型）—— 这样 Node 里的测试能直接
// import 它。放在 `entries/shared.ts` 里的话，那个文件为了 `http_fetch` / `ws_*`
// 引了 host-api，而 Node 里没有 `host-api` 这个模块 ⇒ 测试进不来 ⇒
// 这个最容易错的原语反而没有测试。
//
// # 它解决什么
//
// 老的 25 条任务里有一半是状态机（签到、领取、任务拓展、App 任务、领小红花、换票），
// 每次触发只推进一步 —— 因为全局执行预算是 2 秒，一次触发发不了几个请求。
// 于是「任务拓展」在面板上表现为一条**永远在跑**的任务，用户看不出它到底做完没有。
//
// 现在任务可以声明长预算（`{ budget_ms }`），就可以在一次触发里连跑多步，
// 直到状态机自己说「没得做了」。面板上就变成「一次运行 = 一条任务 = 一个结果」。
//
// # 为什么这里**没有**时间闸（2026-11-16 删掉）
//
// 以前有 `deadlineMs` + `startedAt`：跑到"还剩多少毫秒"就主动收手。它带来的是
// **纯麻烦**，没有一分好处：
//
//   · 两个参数语义相反 —— 调用点传的是「还剩多久」（如 `runStart + 600s - now`），
//     而这里算的是 `now - startedAt`（「已经过了多久」）。前面步骤一多，
//     一进循环就成立 ⇒ **0 步**退出，却还返回 `ok: true`。
//     2026-11-16 10:30 现场的「领小红花：走到时间上限（16166ms / 0 步）」+
//     「直播完成：3/3 个账号好了」就是它：三个号一步没做，日志说全好了。
//   · 就算语义写对，它也只会**砍掉本来能做完的步骤**（用户原话：「不需要任何内部
//     时间限制，这个没搞懂有什么作用除了制造麻烦」）。
//
// 现在只剩一道护栏：`maxSteps`（**步数**，不是时间）。上游可能一直派新活
//（App 任务就是真实例子：做完一条，读数刷新后又冒一条），所以要有上限；
// 走满上限就**如实说没走完**，不假装成功。
//
// 运行时长由**面板的执行预算**管（`register_cron` / `register_route` 的 `budget_ms`），
// 那是外部的、看得见的；插件自己不再叠一层。

import { waitGap, type TaskDeps, type TaskOutcome } from './mcloud/tasks/base.ts';

/** 把一条「一次一步」的状态机在**一次触发里**跑到走完。
 *
 *  # 什么时候算「走完」——三个出口，缺一不可
 *
 *  老的状态机**不统一**地表达「做完了」，所以这里认三种信号：
 *
 *  | 信号 | 谁用 | 含义 |
 *  |---|---|---|
 *  | `idle: true` | taskExpansion · appTask · exchangeOrder · liveDraw | 「这一趟没得做了 / 已经走完」 |
 *  | `skipped: true` | receive · prizes | 「条件不成立，不发请求」 |
 *  | `more()` 返回 false | sign（唯一一个） | 调用方自己说「状态里还有没有未完成的段」 |
 *
 *  ⚠ **`sign` 是那个必须给 `more` 的**：它是「问状态 → 提交 → 回查」三段式，
 *  而**回查那一句才是成败判据**（动作响应会撒谎，见 sign.ts 文件头）。
 *  只调一次的话，签到会被提交出去、然后回查永远不跑 —— 而 `runSign` 提交完
 *  返回的是 `ok: true`，于是整趟会被判成功、落「今天已完成」的标记，
 *  回查**再也**不会发生。签到等于没确认。
 *  （这个 bug 是重写时差点漏掉的：老的「一次一步 + 每 15 分钟」结构恰好绕开了它。）
 *
 *  # 唯一的护栏：`maxSteps`
 *
 *  状态机可能因为上游一直给新待办而**永不**停。走满 `maxSteps` 时：
 *  · 调用方给了 `more()` 且它仍说"还有" ⇒ `ok: false`（**没走完就是没走完**，
 *    不冒充成功；下一趟接着走）
 *  · 否则（没有 `more` 判据）⇒ `ok: true`，用最后一步自己的原话收尾
 */
export async function drain(
  step: (d: TaskDeps) => TaskOutcome | Promise<TaskOutcome>,
  deps: TaskDeps,
  opts: {
    label: string;
    maxSteps: number;
    /** 「状态里还有没做完的段吗」。给了就在每轮**开头**判（第一轮除外 ——
     *  总得先跑一次才知道要干嘛）。没给就只认 `idle` / `skipped`。 */
    more?: () => boolean | Promise<boolean>;
    /** 每步的原话（**立刻**回调）。给长状态机用：文件上传、任务重试这些过程
     *  要能在日志里看到，而不是等整趟 drain 结束只剩一句结论。 */
    onStep?: ((note: string, step: number) => void) | undefined;
    /** 每步之间**随机**隔一会儿（`deps.gapMs`，默认 0.5–2 秒）。
     *
     *  什么时候该开：这一条 drain 的"一步"**就是**一个独立任务时（领取AI豆 是
     *  "队列里一条一个请求"）—— 各条之间不该连着打。
     *  什么时候别开：一步只是同一条任务内部的一段（上传→确认→转换），
     *  开了会把整条拉长；那种要按**任务边界**等（见 `appTask.advance`）。 */
    gap?: boolean | undefined;
  },
): Promise<DrainResult> {
  const notes: string[] = [];
  let steps = 0;
  // 上一步的原话。摘要里要带上它 —— 「2 步走完」不告诉任何人发生了什么，
  // 而最后一步的原话（「签到完成（回查确认）」）才是那行日志的价值所在。
  let lastNote = '';

  for (let i = 0; i < opts.maxSteps; i++) {
    // 条与条之间隔一会儿（第一轮不等 —— 前面没有"上一条"）
    if (i > 0 && opts.gap === true) waitGap(deps);
    // 第一轮永远跑（总得先跑一次才知道要干嘛）；之后由调用方说还有没有未完成的段
    if (i > 0 && opts.more && !(await opts.more())) {
      return {
        ok: true,
        idle: true,
        steps,
        note: `${opts.label}：${steps} 步走完${lastNote ? ` —— ${lastNote}` : ''}`,
        notes,
      };
    }
    let r: TaskOutcome;
    try {
      r = await step(deps);
    } catch (e) {
      // 状态机设计上不抛；真抛了就是插件自己的 bug，要说出来而不是吞掉
      notes.push(`抛异常：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps + 1} 步抛异常`, notes };
    }
    steps++;
    lastNote = r.note;
    notes.push(r.note);
    opts.onStep?.(r.note, steps);
    if (!r.ok && r.pending !== true) {
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps} 步失败 —— ${r.note}`, notes };
    }
    if (r.idle || r.skipped) {
      // 两种「不用继续」：`idle`（没得做/已经走完）、`skipped`（条件不成立）。
      // `pending` = 动作做了、等服务端确认 —— 也要停，但**不算失败**。
      return {
        ok: true,
        idle: true,
        pending: r.pending === true,
        steps,
        note: brief(r.note, opts.label),
        notes,
      };
    }
  }

  // 走满 `maxSteps`。**区分两种**：调用方还有判据且仍说"还有" ⇒ 没走完，
  // 不许报成功（否则就是"跑了 40 步没做完"却绿灯）。
  if (opts.more !== undefined && (await opts.more())) {
    return {
      ok: false,
      idle: false,
      steps,
      note:
        `${opts.label}：走满 ${opts.maxSteps} 步还没完 —— 下一趟接着走` +
        `${lastNote ? `（最后一步：${brief(lastNote, opts.label)}）` : ''}`,
      notes,
    };
  }

  return {
    ok: true,
    idle: false,
    steps,
    // ⚠ 这里**不说**"还有没做完的"。踩过的坑：领取AI豆的队列刚好在第 12 步领空，
    //   而"到上限"和"刚好做完"从这一步看不出区别 —— 于是每一趟都说"还有没做完的"，
    //   用户看到的是一句假话（他的原话：「领取云朵应该没有步数啊」）。
    //   对用户只报**结论**：成了。真想看走到哪一步，运行记录里每一步都在。
    // 同样用最后一步自己的话（跑到上限时，它刚做完的那件事就是结论），
    // 但**截短**：这一格要进 runs 表当一行摘要，不能塞整段原话。
    note: brief(lastNote ?? '', opts.label),
    notes,
  };
}

/** 一行摘要的长度上限。超过就不是"一句话"了（是段原话/JSON），退回一句结论。 */
const BRIEF_MAX = 40;

function brief(s: string, label: string): string {
  const t = s.trim();
  // ⚠ 太长就**截短**，绝不能折成「好了」：长 note 往往是"没成"的详情
  //   （评审 2026-11-01：任务拓展判 `blocked` 那句 60 多字，被折成
  //   「任务拓展：好了」，跑一次记录里写着好了、而备份根本没开）。
  //   `好了` 只留给"真的一句都没说"的那一档。
  if (t.length === 0) return `${label}：好了`;
  return t.length > BRIEF_MAX ? `${t.slice(0, BRIEF_MAX - 1)}…` : t;
}

export interface DrainResult {
  ok: boolean;
  /** 状态机说「没得做 / 已经走完」 */
  idle: boolean;
  /** 动作做了、还在等服务端确认（不是失败） */
  pending?: boolean;
  steps: number;
  /** 一行摘要（进 runs 表的 note） */
  note: string;
  /** 每一步的原话（进日志，方便出问题时看清走到哪一步） */
  notes: string[];
}
