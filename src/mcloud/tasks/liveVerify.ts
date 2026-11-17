// 拿到口令就验：拿它去「领」一次 —— 领就是验（用户口径：已使用也算有效）。
//
// 两条口径（2026-11-17 复核）：
//   ① 「获取到口令就用账号验证是否可用」—— 不许攒着等窗口结束；
//   ② 「应该记录操作者账号或者干脆全操作，避免漏掉」—— 所以这里**依次试**账号：
//      第一个号能给结论就用它（并把 id 记进池里的 `validatedBy`），给不出就换下一个。
//
// ⚠ 为什么不是「所有号都跑一遍」：一条口令每个号都要各领一次，那是 ② 领取那段的活；
//   这里只求**先有一个结论**好判「够 2 条了没有」。3 个号 × 每条 9+ 步 = 三倍请求，
//   而结论一样。真正要「不漏」的是领取（② 本来逐号跑），不是验证。

import { drain } from '../../drain.ts';
import { rawStoreOf, scoped } from '../../store/scoped.ts';
import { loadFreshPool } from '../koulingPool.ts';
import type { TaskDeps } from './base.ts';
import { loadDrawState, runLiveDraw } from './liveDraw.ts';

export interface VerifyOutcome {
  code: string;
  /** `unknown` = 试遍了也没结论（票坏了/上游回了没见过的码）—— 不当判据。 */
  state: 'valid' | 'invalid' | 'unknown';
  /** 谁验出来的（账号 id，落进池里的 `validatedBy`）。空串 = 没结论。 */
  by: string;
  note: string;
}

/** 验一条口令。`accounts` 是**依次试**的顺序（一般是任务里勾的那几个号）。
 *
 *  ⚠ `maxSteps` / `gap` 必须给足：一条口令的链是「读余额 → 埋点 → 进房 → 领 → 回读余额」，
 *  掐在半路会让下一轮拿旧基准算差值，进账数字是废的（F-137 / F-145 的教训）。 */
export async function verifyCode(
  base: TaskDeps,
  accounts: readonly string[],
  code: string,
): Promise<VerifyOutcome> {
  const baseStore = rawStoreOf(base.store);
  const order = accounts.length > 0 ? accounts : [''];
  let last = '';
  for (const id of order) {
    const deps = id === '' ? base : { ...base, store: scoped(baseStore, id) };
    // ⚠ `runLiveDraw` 是**一次一步**的状态机：单调用只发第一个请求（读余额），
    //   推完整条链要 `drain`。早先直接调一次 = 只发了读余额那一枪、什么结论都没有。
    // ⚠ `fresh: true` 绕开「这号领过这批 ⇒ 不发请求」那条捷径 —— 验要的就是那一枪。
    // ⚠ 步数按「读余额 1 + 埋点 5 + 进房 1 + 口令 N + 复活花 1 + 回读余额 1」给足，
    //   掐在半路会让下一轮拿旧基准算差值（F-137 / F-145）。
    const r = await drain(
      async (d) => await runLiveDraw(d, { codes: [code], fresh: true }),
      deps,
      {
        label: `验「${code}」`,
        maxSteps: 14,
        // ⚠ `more()` 必须看**这一步写进去的那个袋**（`deps.store`，不是外层 base 的袋）：
        //   两个袋不是同一个的时候，它读到的是旧状态（done）⇒ 立刻说"没得做了"，
        //   整条链只发第一枪，结论永远是「没结论」（2026-11-17 端到端现场）。
        more: () => {
          const s = loadDrawState(deps.store);
          return s !== null && s.step !== 'done';
        },
        gap: true,
      },
    );
    last = r.note;
    const { pool } = loadFreshPool(deps.store, Date.parse(deps.nowIso));
    const state = pool.codes.find((c) => c.value === code)?.state ?? 'unknown';
    if (state === 'valid' || state === 'invalid') return { code, state, by: id, note: r.note };
  }
  return { code, state: 'unknown', by: '', note: last };
}

/** 一批口令逐个验。返回每条的结论（顺序与入参一致）。 */
export async function verifyCodes(
  base: TaskDeps,
  accounts: readonly string[],
  codes: readonly string[],
): Promise<VerifyOutcome[]> {
  const out: VerifyOutcome[] = [];
  for (const code of codes) out.push(await verifyCode(base, accounts, code));
  return out;
}
