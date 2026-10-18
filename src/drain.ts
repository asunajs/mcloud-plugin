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

import type { TaskDeps, TaskOutcome } from './mcloud/tasks/base.ts';

/** 把一条「一次一步」的状态机在**一次触发里**跑到走完。
 *
 *  # 这是整个重写的核心原语
 *
 *  老的 25 条任务里有一半是状态机（任务拓展、App 任务、领小红花、换票），
 *  每次触发只推进一步 —— 因为全局执行预算是 2 秒，一次触发发不了几个请求。
 *  于是「任务拓展」在面板上表现为一条**永远在跑**的任务，用户看不出它到底做完没有。
 *
 *  现在任务可以声明长预算（`{ budget_ms }`），就可以在一次触发里连跑多步，
 *  直到状态机自己说「没得做了」（`idle`）或者碰到上限。面板上就变成
 *  「一次运行 = 一条任务 = 一个结果」。
 *
 *  # 什么时候算「走完」——三个出口，缺一不可
 *
 *  老的状态机**不统一**地表达「做完了」，所以这里认三种信号：
 *
 *  | 信号 | 谁用 | 含义 |
 *  |---|---|---|
 *  | `idle: true` | taskExpansion · appTask · exchangeOrder · liveDraw | 「这一趟没得做了 / 已经走完」 |
 *  | `skipped: true` | receive · notice · backupGift | 「条件不成立，不发请求」 |
 *  | `more()` 返回 false | sign（唯一一个） | 调用方自己说「状态里还有没有未完成的段」 |
 *
 *  ⚠ **`sign` 是那个必须给 `more` 的**：它是「问状态 → 提交 → 回查」三段式，
 *  而**回查那一句才是成败判据**（动作响应会撒谎，见 sign.ts 文件头）。
 *  只调一次的话，签到会被提交出去、然后回查永远不跑 —— 而 `runSign` 提交完
 *  返回的是 `ok: true`，于是整趟会被判成功、落「今天已完成」的标记，
 *  回查**再也**不会发生。签到等于没确认。
 *  （这个 bug 是重写时差点漏掉的：老的「一次一步 + 每 15 分钟」结构恰好绕开了它。）
 *
 *  # 两道上限都要有
 *
 *  - `maxSteps`：状态机可能因为上游一直给新待办而**永不**停
 *    （App 任务是真实例子：做完一条，读数刷新后又冒一条）。
 *  - `deadlineMs`：比任务的 `budget_ms` 略小 —— 到点主动收手，
 *    留下「还差多少」的信息，而不是被看门狗当成死循环掐断。
 *    **主动收手和被掐断在日志里长得完全不一样**，前者能继续，后者只会留下
 *    「疑似死循环」这句误导人的话。
 */
export function drain(
  step: (d: TaskDeps) => TaskOutcome,
  deps: TaskDeps,
  opts: {
    label: string;
    maxSteps: number;
    deadlineMs: number;
    startedAt?: number;
    /** 「状态里还有没做完的段吗」。给了就在每轮**开头**判（第一轮除外 ——
     *  总得先跑一次才知道要干嘛）。没给就只认 `idle` / `skipped`。 */
    more?: () => boolean;
  },
): DrainResult {
  const startedAt = opts.startedAt ?? Date.now();
  const notes: string[] = [];
  let steps = 0;
  // 上一步的原话。摘要里要带上它 —— 「2 步走完」不告诉任何人发生了什么，
  // 而最后一步的原话（「签到完成（回查确认）」）才是那行日志的价值所在。
  let lastNote = '';

  for (let i = 0; i < opts.maxSteps; i++) {
    // 第一轮永远跑（总得先跑一次才知道要干嘛）；之后由调用方说还有没有未完成的段
    if (i > 0 && opts.more && !opts.more()) {
      return {
        ok: true,
        idle: true,
        steps,
        note: `${opts.label}：${steps} 步走完${lastNote ? ` —— ${lastNote}` : ''}`,
        notes,
      };
    }
    if (Date.now() - startedAt > opts.deadlineMs) {
      return {
        ok: true,
        idle: false,
        steps,
        note: `${opts.label}：走到时间上限（${opts.deadlineMs}ms / ${steps} 步），下一次接着走`,
        notes,
      };
    }
    let r: TaskOutcome;
    try {
      r = step(deps);
    } catch (e) {
      // 状态机设计上不抛；真抛了就是插件自己的 bug，要说出来而不是吞掉
      notes.push(`抛异常：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps + 1} 步抛异常`, notes };
    }
    steps++;
    lastNote = r.note;
    notes.push(r.note);
    if (!r.ok) {
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps} 步失败 —— ${r.note}`, notes };
    }
    if (r.idle || r.skipped) {
      // 两种「不用继续」：`idle`（没得做/已经走完）、`skipped`（条件不成立）。
      // 对 drain 来说都是「停下」。
      // 用最后一步自己的话（它是具体的：「今天没有可领的」「领到了」）
      return { ok: true, idle: true, steps, note: brief(r.note, opts.label), notes };
    }
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
  return t.length === 0 || t.length > BRIEF_MAX ? `${label}：好了` : t;
}

export interface DrainResult {
  ok: boolean;
  /** 状态机说「没得做了 / 已经走完」 */
  idle: boolean;
  steps: number;
  /** 一行摘要（进 runs 表的 note） */
  note: string;
  /** 每一步的原话（进日志，方便出问题时看清走到哪一步） */
  notes: string[];
}
