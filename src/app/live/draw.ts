// 领取：**按账号各领一次**（拿共享池里的口令去领小红花）。
//
// ⚠ 这一支才是"按账号"的 —— "哪个账号领过哪条"必须分开记（\`claims\`）。

import { drain } from '../../drain.ts';
import { runAuthRefresh } from '../../mcloud/authRefresh.ts';
import type { RunStep } from '../../mcloud/runLog.ts';
import type { TaskDeps } from '../../mcloud/tasks/base.ts';
import { loadDrawState, runLiveDraw } from '../../mcloud/tasks/liveDraw.ts';
import { userLine } from '../../mcloud/tasks/stepLog.ts';
import type { LiveCtx } from './ctx.ts';

/** 每个账号：拿**共享池**里的口令去领。
 *
 *  ⚠ 这一支才是"按账号"的 —— 因为"哪个账号领过哪条"必须分开记（`claims`）。
 *  口令本身不按账号分：同一张口令，每个账号都能领一次。 */
export async function drawOnce(
  ctx: LiveCtx,
  deps: TaskDeps,
  runStartMs: number,
  onlyCodes: readonly string[] | null,
): Promise<{ steps: RunStep[]; detail: string[]; ok: boolean; note: string; didWork: boolean }> {
  // 每次领取前先判一次原生 token：到期就自动续，离到期还远则零请求。
  const auth = await runAuthRefresh(deps);
  const before = loadDrawState(deps.store);
  const r = await drain(
    async (d) => await runLiveDraw(d, onlyCodes ? { codes: onlyCodes } : {}),
    deps,
    {
    label: '领小红花',
    maxSteps: 12,
    // 一次抽奖 = 一步，连着抽就是连发 ⇒ 步与步之间随机隔 0.5–2 秒（`deps.gapMs`）
    gap: true,
  });
  // `drain` 的 `brief` 对超长 note 会退成「领小红花：好了」，用户根本不知道
  // 领没领到。这里直接读本轮落盘的 summary（`3 条领到 2 条，进账 10 朵`）。
  const st = loadDrawState(deps.store);
  // **本次到底有没有真做事** —— 判据只有一条：这一趟 drain 有没有走到
  // "真的发了请求"那一步。
  //
  // ⚠ 别再用时间戳去猜（以前拿状态里的 startedAt 和 deps.nowIso 比相等）：
  //   · 时间戳是**全局冻结值**，一次 run 里所有行都一样 ⇒ 猜不出"这轮是不是新的"；
  //   · 2026-11-16 11:59:48 现场：整趟 14 行只跨 12 毫秒（根本没发请求），
  //     却把**上一轮**的 `results` 当成本轮战果播了出来（「领到 5 朵 / 10 朵」+
  //     「3/3 个账号好了」）。用户的原话：「上次成功关你屁事啊」。
  //
  // `drain` 的 `steps` 是"真的执行了几步"，`notes` 是每步原话；"口令没变/没有口令/
  // 这一轮已跑完"这三种收尾**一步都不发请求**，状态机自己也是这么说的。
  const idleNoRequest = /没再发请求|没有口令|已跑完|那一轮已跑完/.test(r.note);
  const didWork = r.steps > 0 && !idleNoRequest;
  const rows = didWork ? (st?.results ?? []) : [];
  const steps: RunStep[] = [
    {
      name: '凭据续期',
      ok: auth.ok,
      note: auth.note,
      idle: auth.idle === true || auth.skipped === true,
    },
  ];
  steps.push(...rows.map((row) => {
    const head = `口令「${row.code}」`;
    const detail = row.note.startsWith(head) ? row.note.slice(head.length).trim() : row.note;
    return {
      name: head,
      ok: row.kind === 'succeeded',
      note: detail,
      idle: false,
    };
  }));
  const finalNote = didWork && st?.step === 'done' && st.summary
    ? st.summary
    : didWork
      ? r.note
      : `本次没发请求 —— ${r.note}`;
  // `drain` 收尾时 `idle` 常为 true（状态机“走完”），不能拿它当“没领”。
  // 只有明确说没开/跳过才算 idle；领到/好了是实打实的结果。
  const noClaim = /没开|跳过|没有可|不用领|无需/.test(finalNote);
  steps.push({
    name: '领小红花',
    ok: r.ok,
    note: finalNote,
    // 没真发请求 ⇒ `idle`（灰色 info，**不是**成功绿灯）。
    // 用户口径：什么都没做还盖绿灯，就是假成功。
    idle: didWork ? r.idle === true && noClaim : true,
    pending: r.pending === true,
  });
  return {
    steps,
    detail: steps.map((s) => userLine(s)).filter((x): x is string => x !== null),
    ok: r.ok,
    note: finalNote,
    didWork,
  };
}

