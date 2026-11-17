// 收口令：**整趟只跑一次**（门 → 小红书 → 听弹幕）。
//
// ⚠ 这一支**不按账号分**：口令是共享资源，一个账号听到所有人都能用；
//   分着听就是 3 倍请求、3 倍时间，还重复撞同一批弹幕。
//   用的是**第一个账号**的凭据（换票/门/WS 都要一张票，随便哪张都行）。

import { drain } from '../../drain.ts';
import { runAuthRefresh } from '../../mcloud/authRefresh.ts';
import { capNote, hostNativeTls } from '../../mcloud/hostCap.ts';
import { KOULING_ANCHOR, loadPoolFrom, stopScraping, validCount } from '../../mcloud/koulingPool.ts';
import { maskCode, traceStep } from '../../mcloud/liveTrace.ts';
import { logBoth } from '../../mcloud/log.ts';
import { resolveTaskAccounts } from '../../mcloud/taskAccounts.ts';
import type { RunStep } from '../../mcloud/runLog.ts';
import { rawStoreOf } from '../../store/scoped.ts';
import type { TaskDeps, TaskOutcome } from '../../mcloud/tasks/base.ts';
import { loadDrawState, runLiveDraw } from '../../mcloud/tasks/liveDraw.ts';
import { readGateReading, runLiveGate } from '../../mcloud/tasks/liveGateTask.ts';
import { clearListenCooldown, loadListenSeconds, runLiveListen } from '../../mcloud/tasks/liveListen.ts';
import type { ListenDeps } from '../../mcloud/tasks/liveListen.ts';
import { runLiveRoom } from '../../mcloud/tasks/liveRoom.ts';
import { userLine } from '../../mcloud/tasks/stepLog.ts';
import { logTo } from '../../ports/log.ts';
import type { LiveCtx } from './ctx.ts';

/** 一趟直播。 */
/** 整趟**只跑一次**：收口令（门 → 小红书 → 听弹幕）。
 *
 *  ⚠⚠ **口令是共享的**：一个账号听到，所有账号都能拿去领（用户口径 2026-10-17：
 *  「一个听到其他人就能用了」）。所以这一支**不按账号分**，也不该把听窗口的
 *  预算按账号摊 —— 那样 3 个账号就是 3 倍请求、3 倍时间，还会重复撞同一批弹幕。
 *
 *  用**第一个账号**的凭据（换票/门/WS 都要一张票，随便哪张都行）。
 */

/** 听弹幕要的 deps：在 TaskDeps 上加**全局**的长连接与弹幕回调。 */
function listenDeps(ctx: LiveCtx, deps: TaskDeps): ListenDeps {
  return {
    ...deps,
    host: ctx.host,
    // 照 mcloud-sign：`[WS] 弹幕: ...` 只放 debug —— 用户能看到听到了什么，
    // 又不至于把正常日志刷成 info。
    onDanmaku: (text) => logBoth(ctx.store, 'debug', `弹幕：${text}`, new Date().toISOString()),
  };
}

export async function collectOnce(
  ctx: LiveCtx,
  deps: TaskDeps,
  runStartMs: number,
): Promise<{ steps: RunStep[]; detail: string[]; ok: boolean; note: string; stopped: boolean }> {
  const store = ctx.store;
  const host = ctx.host;
  const steps: RunStep[] = [];
  const step = async (name: string, fn: () => TaskOutcome | Promise<TaskOutcome>): Promise<TaskOutcome> => {
    // ⚠ 追踪在**这一处**记：收口令那一段每一步都走它 ⇒ 一条也不用漏。
    // ⚠ 时刻用**真实的现在**（F-137 第 3 条同一条口径）：`deps.nowIso` 是一次 run
    //   里冻结的同一个值，环里每一行都长一个时刻就失去"带时刻"的意义了。
    const t0 = Date.now();
    const traceAt = () => new Date().toISOString();
    try {
      const r = await fn();
      steps.push({ name, ok: r.ok, note: r.note, idle: r.idle === true });
      traceStep(deps.store, traceAt(), 'collect/' + name, r.note, { ok: r.ok, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      const note = `抛异常 ${e instanceof Error ? e.message : String(e)}`;
      steps.push({ name, ok: false, note, idle: false });
      traceStep(deps.store, traceAt(), 'collect/' + name, note, { ok: false, ms: Date.now() - t0 });
      return { ok: false, note };
    }
  };
  const done = (ok: boolean, note: string, stopped = false) => ({
    steps,
    detail: steps.map((s) => userLine(s)).filter((x): x is string => x !== null),
    ok,
    note,
    stopped,
    // 听口令那一支不发领取请求 ⇒ 这里明确"没做事"，收尾统计不算"好了"
    didWork: false,
  });

  logBoth(store, 'start', '直播口令：开始查开播', deps.nowIso);

  // ⓪ 原生 token 先判一次：到期自动续；不新鲜时门和 WS 都会一起失败。
  const auth = await step('凭据续期', async () => await runAuthRefresh(deps));
  // 管道步骤成功时不进用户日志；这里给排查留一行 debug，证明自动判过。
  logTo('debug', `凭据续期：${auth.note}`);

  // ⓪ 先问一次**这个面板构建支不支持直播**。
  //
  //   为什么放在最前面：不支持的时候，后面每一条（门、小红书、弹幕）都会
  //   以同一条 TLS 报错收场，而那条报错用户改不了、也看不懂。
  //   问一次、记住、然后**什么都不做** —— 一天两次的机会不该花在注定失败的路上。
  const cap = await hostNativeTls(deps.store, deps.nowIso, deps.transport);
  if (cap.verdict === 'no') {
    // ⚠ 这里不再单独 `error()` 一次：这一段会由下面的段尾统一印成**一行** error
    //   （同一句话说三遍比说一遍糟 —— 见 F-097 的同一条口径）。
    steps.push({ name: '这个面板能不能直播', ok: false, note: capNote(cap.verdict), idle: false });
    return done(false, capNote(cap.verdict), true);
  }

  // ① 先验开播 —— 没开播时抓到的口令一定是无效的，所以"先验开播"是判据，不是限制。
  const gateOut = await drain(runLiveGate, deps, {
    label: '有没有开播',
    maxSteps: 3,
  });
  // ⚠ 必须读**这个账号**的袋（deps.store），不能读模块级 `store`：
  //   模块级是 `default` 袋，直播检查/池子都写在第一个账号的袋里；读错袋
  //   就会拿旧读数说「没有一间是目标」—— 2026-10-20 实拍：159 的读数已经
  //   active=true，日志却还在报 2 间福建移动。
  const gate = readGateReading(deps.store);
  const liveCount = gate === null ? 0 : gate.liveCount;

  // ⚠ **门自己失败 ≠ 今天没直播**（"我们凭据坏了"与"今天没开播"是两件事）。
  //   参考实现这一支的做法是"警告一句、继续试"（`hasActiveLiveRoom`：验证失败返回 true，
  //   避免因临时故障漏掉口令）。一天只有两次机会，为一次偶发失败丢掉整场不值。
  if (!gateOut.ok) {
    steps.push({ name: '有没有开播', ok: false, note: `${gateOut.note}（继续试一次）`, idle: false });
  } else if (gate === null || gate.active !== true) {
    steps.push({
      name: '有没有开播',
      ok: true,
      idle: true,
      note:
        liveCount === 0
          ? '今天没有直播（谁都没在播）'
          : `有 ${liveCount} 间在播，但没有一间是「${KOULING_ANCHOR}」的`,
    });
    return done(true, '没在播 —— 不听，也不看小红书', true);
  } else {
    steps.push({
      name: '有没有开播',
      ok: true,
      idle: false,
      note: `「${KOULING_ANCHOR}」开播了（${liveCount} 间在播）`,
    });
    logBoth(
      store,
      'start',
      `开播了，先看小红书，再听弹幕（窗口 ${loadListenSeconds(deps.store)} 秒）`,
      deps.nowIso,
    );
    // ⚠ 门刚说"在播" ⇒ 把上一轮留下的冷却清掉。冷却的本意是"没在播就别反复探门"，
    //   它是**与门的结论绑着**的；上一趟的冷却可能还挂着（能一睡到下一场），
    //   矛盾时信**新的**门。不清的话，下面的听弹幕循环第一拍就被过期冷却
    //   `idle` 收手 —— 一场在播的直播被一个过期的"没在播"跳过（F-145）。
    //   清错了也没事：roomBeat 会自己发现没聊天室、把冷却重新种回去（自愈）。
    if (clearListenCooldown(deps.store, deps.nowIso)) {
      logTo('debug', '上一轮的「没在听」冷却与本次门的结论矛盾 —— 已清，照常听');
    }
  }

  // ② 小红书（公开 GET，封控要求 ≥30 分钟一次）
  // 先单独打一行“开始看”，否则这一枪慢/被限流时用户只看到听弹幕，
  // 会以为根本没请求小红书（2026-11-03 现场）。
  logBoth(store, 'start', '小红书：开始看口令发布方主页', deps.nowIso);
  const xhsAt = Date.now();
  const xhs = await step('小红书主页口令', async () => await runLiveRoom(deps));
  logBoth(store, 'debug', `小红书：这一步用了 ${Math.round((Date.now() - xhsAt) / 1000)} 秒`, deps.nowIso);

  // ③ 听弹幕 —— 池里够 2 条有效就不听了（再听只是重复撞同一批）
  const poolNow = loadPoolFrom(deps.store).pool;
  const enough = stopScraping(poolNow);
  if (enough) {
    steps.push({
      name: '听弹幕',
      ok: true,
      idle: true,
      note: `手里已经有 ${validCount(poolNow)} 条能用的口令，不用再听`,
    });
    return done(true, '口令够了，没再听');
  }

  let frames = 0;
  let listenNote = '';
  let listenPushed = false;
  /** 为什么提前不听了（够 2 条有效）—— 要有话说，别让用户以为被截断。 */
  let listenStop = '';
  /** 这一趟已经拿去验过的口令（同一个口令不重复验：重复领只会回 200112）。 */
  const verified = new Set<string>();
  const ld = listenDeps(ctx, deps);
  // 听满用户设的窗口，但给后面的**领取**留足余量。
  // ⚠ 领取按账号**串行**（每号一条 9+N 步的链，步间还有随机间隔 ≈ 15~25 秒）——
  //   以前固定留 20 秒是"单账号"时代的数：3 个号时第二个还没领完，
  //   面板就把整个 handler 掐了，后面账号的运行记录都来不及写（F-145）。
  //   现在按账号数预留（25 秒/号 + 10 秒底），预算太小就少听 —— 听是锦上添花，
  //   领是这趟的目的。
  const drawReserveMs =
    10_000 + resolveTaskAccounts(rawStoreOf(ctx.store), '直播', 'auto').length * 25_000;
  const listenDeadline =
    runStartMs + Math.min(loadListenSeconds(deps.store) * 1000, Math.max(0, ctx.budgetMs - drawReserveMs));
  while (Date.now() < listenDeadline) {
    // ⚠ 这里**不能**用 `step()`：它每拍都往 `steps` 里塞一条，30 拍就是 30 行
    //   「听弹幕：正在听…」——用户看到的是刷屏，不是进度。只在收尾时落一条。
    let r: TaskOutcome;
    try {
      r = await runLiveListen(ld);
    } catch (e) {
      const note = `抛异常 ${e instanceof Error ? e.message : String(e)}`;
      steps.push({ name: '听弹幕', ok: false, note, idle: false });
      listenPushed = true;
      break;
    }
    listenNote = r.note;
    if (!r.ok || r.idle) {
      steps.push({ name: '听弹幕', ok: r.ok, note: r.note, idle: r.idle === true });
      listenPushed = true;
      break;
    }
    frames++;
    // ⚠ **每拍都要判"够了没有"**。原先只在"开始听之前"判一次 `stopScraping`，
    //   于是明明已经听到 2 条能用的口令，还要**空听满 600 秒**才去领
    //   （2026-11-11 14:42–14:52 现场：听了 600 秒，池里 2 条口令却在 14:52 才动）。
    //   两件事都要在这里断：
    //     ① 已经有 2 条**验证过**的口令 ⇒ 再听只是重复撞同一批弹幕；
    //     ② 出现了**新的、还没验过**的口令 ⇒ 立刻停下，拿去领就是验证，
    //        不用等窗口结束（用户口径：「获取到一条口令就立刻测试」）。
    const tickPet = loadPoolFrom(deps.store).pool;
    if (stopScraping(tickPet)) {
      listenStop = `已经有 ${validCount(tickPet)} 条能用的口令，不再听`;
      break;
    }
    // 听到一条**还没验过**的口令 ⇒ **当场拿去领一次**（领就是验证），
    // 然后**接着听** —— 不能因为"来了一条"就收工：万一口令是废的，
    // 收工就等于这一趟白听（用户口径 2026-11-11：
    // 「是去验证而不是停止，万一口令没用呢」）。
    const fresh = tickPet.codes.find(
      (c) => c.state !== 'invalid' && c.state !== 'valid' && c.firstSeenMs >= runStartMs && !verified.has(c.value),
    );
    if (fresh !== undefined) {
      verified.add(fresh.value);
      logBoth(store, 'start', `听到口令「${fresh.value}」—— 立刻去验证（不等窗口）`, deps.nowIso);
      const v = await drain(async (d) => await runLiveDraw(d, { codes: [fresh.value] }), deps, {
        label: `验证「${fresh.value}」`,
        // 一条口令的验证 = 读余额 → 领 → 回读余额（9+1 步，带随机间隔）。
        // ⚠ 以前 maxSteps: 8：第 8 步刚好发完那一枪就被掐 ⇒ 轮次停在半路，
        //   下一趟拿旧基准算差值，进账数字是废的（F-145）。给足步数，并按
        //   F-137 立的规矩带上 `more()`：走满步数还有 ⇒ 如实 ok:false。
        maxSteps: 14,
        more: () => {
          const s = loadDrawState(deps.store);
          return s !== null && s.step !== 'done';
        },
        gap: true,
      });
      const nowPet = loadPoolFrom(deps.store).pool;
      const thisOne = nowPet.codes.find((c) => c.value === fresh.value);
      logBoth(
        store,
        v.ok ? 'info' : 'warn',
        `验证「${fresh.value}」：${thisOne?.state === 'valid' ? '有效' : thisOne?.state === 'invalid' ? '无效' : '没结论'} —— ${v.note}`,
        deps.nowIso,
      );
      // 追踪环里记**脱敏**的：口令原文会留在池里（那是业务数据），
      // 环是"上一趟走到哪"的快照，没必要再存一份明文。
      traceStep(
        deps.store,
        new Date().toISOString(),
        'collect/verify',
        maskCode(fresh.value) +
          ' → ' +
          (thisOne?.state === 'valid' ? '有效' : thisOne?.state === 'invalid' ? '无效' : '没结论'),
        { ok: thisOne?.state === 'valid' },
      );
      // ⚠ 这里**不 break**：继续听，直到"够 2 条有效"或听满窗口。
      continue;
    }
    // 长连接是同步循环，不在这里打点的话界面上整段时间一行日志都没有 ——
    // 用户只能看到一个「跑着呢 70s」，以为卡死了。每 5 拍报一次进度。
    if (frames === 1 || frames % 5 === 0) {
      logBoth(
        store,
        'debug',
        `听弹幕中：第 ${frames} 拍（已听约 ${Math.round((Date.now() - runStartMs) / 1000)} 秒）`,
        deps.nowIso,
      );
    }
  }
  if (frames > 0 && !listenPushed) {
    steps.push({
      name: '听弹幕',
      ok: true,
      note: listenStop !== '' ? `${listenStop}（听了 ${frames} 拍）` : listenNote || `听了 ${frames} 轮`,
      idle: false,
    });
  }
  const after = loadPoolFrom(deps.store).pool;
  const valid = validCount(after);
  // ⚠ 未知 ≠ 无效：池里的 unknown 就是“抓到了但还没验过”，验证的唯一途径
  //   就是拿去领（mcloud-sign 也是这么做）。只要还有非无效候选，就该继续；
  //   否则会把刚听到的口令永远晾在池里。
  const candidates = after.codes.filter((c) => c.state !== 'invalid');
  if (candidates.length === 0) {
    return done(false, `没捡到能用的口令（听了 ${frames} 拍）`, true);
  }
  return done(
    true,
    valid > 0
      ? `池里现在有 ${valid} 条已验证的口令`
      : `池里现在有 ${candidates.length} 条待验证口令（拿去领就会验）`,
  );
}
