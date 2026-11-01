// 独立版（CLI）的领取日志 —— **照 mcloud-sign 的句子**，不是面板那套。
//
// 为什么单独一层：
//   · 面板入口 `entries/live.ts` 的日志是「段头 + 逐条 + 条数/进账」，给 WebUI 看的；
//   · CLI 是 `mcloud-sign` 的替代品，用户原来的 cron 日志里认的是
//     `当前红花：N` / `口令「X」领取成功，获得 N 朵（…）` / `最终红花：N（+N）`。
// 两边都从同一份 `DrawState` 出，格式各自成文，别互相借。
//
// ⚠ 这里只做**展示**：不发请求、不改状态。`runLiveDraw` 已经把结果落盘。

import type { DrawRow, DrawState } from '../mcloud/tasks/liveDraw.ts';

/** CLI 一行日志：句子 + 该用哪种颜色。 */
export interface LiveLogLine {
  level: 'info' | 'success' | 'warn';
  text: string;
}

/** 一条口令的结果，句子逐字对齐 `mcloud-sign` 的 `drawRedFlowerForAccount`。 */
function rowLine(row: DrawRow): LiveLogLine {
  switch (row.kind) {
    case 'succeeded':
      return {
        level: 'success',
        text: `口令「${row.code}」领取成功，获得 ${row.flowerNum} 朵${
          row.prizeName === undefined ? '' : `（${row.prizeName}）`
        }`,
      };
    case 'already-drawn':
      return { level: 'info', text: `口令「${row.code}」已兑换过` };
    case 'invalid-kouling':
    case 'kouling-expired':
    case 'other': {
      // mcloud-sign 就是 `口令「X」：${msg} (code: N)`，不把码翻译成自己的话。
      const fallback =
        row.kind === 'invalid-kouling'
          ? '口令无效'
          : row.kind === 'kouling-expired'
            ? '口令已失效'
            : '服务端回了没见过的码';
      const msg = row.message === undefined || row.message === '' ? fallback : row.message;
      const code = row.envCode === undefined ? '' : ` (code: ${row.envCode})`;
      return { level: 'info', text: `口令「${row.code}」：${msg}${code}` };
    }
    default:
      // mcloud-sign 对解不出来的响应是 warn。
      return { level: 'warn', text: `口令「${row.code}」响应异常，跳过` };
  }
}

/** 把一轮领取状态收成 mcloud-sign 形状的日志行。没有状态就什么都不说。 */
export function drawLogLines(st: DrawState | null): LiveLogLine[] {
  if (st === null) return [];
  const lines: LiveLogLine[] = [];
  if (st.balanceBefore !== undefined) {
    lines.push({ level: 'info', text: `当前红花：${st.balanceBefore}` });
  }
  if (st.firstParticipateCode === 0) {
    lines.push({
      level: 'success',
      text: `首次参与惊喜奖，获得 ${st.firstParticipateNum ?? 0} 朵小红花`,
    });
  } else if (st.firstParticipateCode !== undefined && st.firstParticipateCode !== 200110) {
    // `200110`（已参与过）在 mcloud-sign 里**不打印**；别的码才说一句。
    const msg =
      st.firstParticipateMessage !== undefined && st.firstParticipateMessage !== ''
        ? st.firstParticipateMessage
        : `服务端回 ${st.firstParticipateCode}`;
    lines.push({ level: 'info', text: `首次参与奖：${msg}` });
  }
  for (const row of st.results) lines.push(rowLine(row));
  if (st.revival !== undefined) {
    lines.push({ level: 'info', text: `复活花：${st.revival}` });
  }
  if (st.balanceAfter !== undefined) {
    // mcloud-sign 的 `+total` 是「各条成功 flowerNum + 首次参与那几朵」的和，
    // 不是余额差（余额差是面板的 `gained`，两者在异常场次可能不同）。
    const total =
      st.results.reduce((n, row) => n + (row.kind === 'succeeded' ? row.flowerNum : 0), 0) +
      (st.firstParticipateNum ?? 0);
    lines.push({ level: 'info', text: `最终红花：${st.balanceAfter}（+${total}）` });
  }
  return lines;
}
