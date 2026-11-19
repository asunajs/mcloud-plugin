// 一趟直播的**收尾统计** —— 按账号算，并且按「没领到」的原因分档。
//
// 用户口径 2026-11-19：「**已经领取过不是错误；没有口令、口令错误才是错误**」。
//
// 以前只有一个判据：`didWork === false` 就不算「好了」。于是：
//   · 这个号今天已经领过了（正常收尾）⇒ 也被排除 ⇒ 「2/3 个账号好了」的 WARN；
//   · 而「一步没做」（票坏了 / 状态机卡住）和「已经领过」在日志上长得一样。
//
// 现在分开：**已经领过算好了**，只有「没口令 / 口令无效 / 真没做成」才算没成。
// ⚠ 别退回「一步没做也算 N/N 好了」：2026-11-16 现场就是三个号一步没做、日志写
//   「3/3 个账号好了」—— 那种原因落在 `other`，仍然不算好。

import { idleReason } from '../../mcloud/tasks/stepLog.ts';
import type { LineLevel } from '../../mcloud/tasks/stepLog.ts';

/** 一个账号这一趟的结论（与 `app/live/draw.ts::drawOnce` 同形）。 */
export interface AcctResult {
  ok: boolean;
  note: string;
  /** 这一趟有没有**真的发请求**（`false` = 状态机说没得做）。 */
  didWork?: boolean;
}

export interface Tally {
  level: LineLevel;
  text: string;
  /** 真领到了的账号数 */
  worked: number;
  /** 已经领过（正常收尾，**不是**错误） */
  already: number;
  /** 没成（没有口令 / 口令无效 / 真失败） */
  bad: number;
}

export function liveTally(results: readonly AcctResult[]): Tally {
  const n = results.length;
  let worked = 0;
  let already = 0;
  let bad = 0;
  const badNotes: string[] = [];
  for (const r of results) {
    // ⚠ 先看 `ok`：真失败（上游 500 / 链断在半路）时 `didWork` 仍是 true
    //   （确实发了请求），只看 `didWork` 会把它算成「好了」—— 假绿灯。
    if (r.ok === false) {
      bad++;
      badNotes.push(r.note);
      continue;
    }
    if (r.didWork !== false) {
      worked++;
      continue;
    }
    if (idleReason(r.note) === 'already') {
      already++;
      continue;
    }
    bad++;
    badNotes.push(r.note);
  }
  if (n === 0) return { level: 'info', text: '直播：这一趟没有账号', worked, already, bad };
  // 全都正常收尾（领到 / 已领过）
  if (bad === 0) {
    if (worked === 0) {
      return { level: 'info', text: `直播：${n} 个账号都领过了，这一趟不用领`, worked, already, bad };
    }
    const suffix = already > 0 ? `（${already} 个已经领过）` : '';
    return { level: 'success', text: `直播完成：${n}/${n} 个账号好了${suffix}`, worked, already, bad };
  }
  // 一个都没成：把原因说出来（没口令 / 口令无效 / 失败）
  if (worked === 0 && already === 0) {
    return { level: 'warn', text: `直播：${n} 个账号都没领 —— ${badNotes[0] ?? ''}`, worked, already, bad };
  }
  return {
    level: 'warn',
    text: `直播完成：${worked + already}/${n} 个账号好了（${bad} 个没成）`,
    worked,
    already,
    bad,
  };
}
