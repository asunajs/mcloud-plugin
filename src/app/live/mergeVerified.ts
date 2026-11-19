// 验证阶段领到的账，并进「领取」那一段的结果里。
//
// 为什么要这一步：**验证就是领取**（领就是验）。一个号在收口令阶段被拿去验口令时，
// 已经真领过小红花了；到「领取」那一段，它的状态机已经 `done`，于是一步都不发，
// 回一句「本次没发请求」。若照抄这句话，日志会：
//
//   · 只带**最后一次**的进账（前一次的 5 朵凭空消失）；
//   · 收尾把它算成「没做事」⇒ 冒出「2/3 个账号好了」的 WARN。
//
// 2026-11-19 现场就是这样：小号实际领了两次共 10 朵（310→315→320），
// 日志却写「本次没发请求 …… 进账 5 朵 (315 → 320)」，最后还给了个 2/3 的 WARN。
//
// 判据只认「验证时**真领到了**」（`codes` 非空），不拿时间戳猜 —— 时间戳是一次
// run 里冻结的同一个值，猜不出「这轮是不是新的」（`draw.ts` 里那条老教训）。

import type { RunStep } from '../../mcloud/runLog.ts';
import { userLine } from '../../mcloud/tasks/stepLog.ts';

/** 领取那一段的返回（与 `app/live/draw.ts::drawOnce` 同形）。 */
export interface DrawResult {
  steps: RunStep[];
  detail: string[];
  ok: boolean;
  note: string;
  /** 这一趟有没有**真的发请求**（`false` = 状态机说没得做）。 */
  didWork?: boolean;
}

/** 验证阶段真领到的账（按账号）。 */
export interface VerifiedClaim {
  codes: string[];
  gained: number;
}

/** 把验证阶段的领取并进这个号的领取结果（**原地改**）。
 *
 *  返回是否改过 —— `false` 表示这个号在领取阶段本来就有结果，别覆盖它。 */
export function mergeVerifiedClaims(r: DrawResult, v: VerifiedClaim | undefined): boolean {
  // 没验过、或验证时没真领到 ⇒ 不动（「没做事」就该照实说）。
  if (v === undefined || v.codes.length === 0) return false;
  // 领取阶段自己发过请求 ⇒ 它已经有真结果，验证那几朵是**另一条**口令的账，
  // 不该覆盖（那种情况下 `claims` 会把两条都记进池，收尾看的是领取这一条）。
  if (r.didWork !== false) return false;
  // ⚠ 措辞要跟 `stepLog.lineLevel` 对齐：**真进账**那支必须含「领到」——
  //   它才会被判成 success（绿）。写成「已领」会被 `/已领/` 那条规则判成 debug
  //   （灰），明明领到了 10 朵却像什么都没发生（2026-11-19 现场就是这样）。
  //   没进账那支（200112 之类）保持「已领」⇒ 灰色，别假装这次又领了一次。
  const line =
    v.gained > 0
      ? `验证时领到 ${v.codes.length} 条 · 进账 ${v.gained} 朵`
      : `验证时已领 ${v.codes.length} 条`;
  r.didWork = true;
  r.note = line;
  // 把「没发请求」那条换成真结论：收尾的 tally 按它算（不是假绿灯 ——
  // 这个号确实领到了，只是发生在验证那一段）。
  r.steps = [
    ...r.steps.filter((s) => s.name !== '领小红花'),
    { name: '领小红花', ok: true, note: line, idle: false },
  ];
  r.detail = r.steps.map((s) => userLine(s)).filter((x): x is string => x !== null);
  return true;
}
