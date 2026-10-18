/** 运行日志的**环形副本** —— 让"重启之后还能看到上次跑到哪"成立。
 *
 *  # 为什么要有这一份
 *
 *  终端面板的数据源是面板自己的日志流（`/api/logs/stream`，SSE）。那条流的底子是
 *  面板内存里的一个 1MB 环 —— **面板一重启就空了**。于是用户看到的是：
 *  改个东西、重启、日志从头开始，上一次到底跑到哪一步、哪一步失败，全没了。
 *  （面板那边确实把日志落到 `data/logs/plugin-YYYY-MM-DD.jsonl`，但没有读它的接口，
 *  插件也读不到别人的文件。）
 *
 *  # 它是什么
 *
 *  插件自己每次 `log(...)` 时，顺手把同一句话塞进 state 里的一格（`mcloud.log.ring`）。
 *  state 是 SQLite 里的，重启照旧在。界面上先读这一份当**历史**，再接 SSE 看**新的**。
 *
 *  # 边界
 *
 *  · 只留最近 {@link RING_MAX} 行（再多没意义，也把 state 撑大）；
 *  · 一行一条，`{t: 时刻, l: 级别, m: 话}`；
 *  · ⚠ 这是**副本**，不是日志系统本身：面板那份才是权威（有级别过滤、有续传）。
 *    这里只为"界面首屏能看见上一次"服务。
 */
import type { Store } from '../store/types.ts';

export const RING_KEY = 'mcloud.log.ring';

/** 留多少行。400 行 ≈ 一次日常 × 3 个号的全部行数，翻得动也读得完。 */
export const RING_MAX = 400;

export interface RingLine {
  /** 时刻（ISO） */
  t: string;
  /** 级别：`info` / `warn` */
  l: string;
  /** 正文 */
  m: string;
}

function parse(raw: string): RingLine[] {
  if (raw === '') return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is RingLine =>
        typeof x === 'object' && x !== null && typeof (x as RingLine).m === 'string',
    );
  } catch {
    return [];
  }
}

/** 读最近的行（旧的在前，与终端一致）。 */
export function readRing(store: Pick<Store, 'getState'>): RingLine[] {
  return parse(store.getState(RING_KEY) ?? '');
}

/** 追加一行。满了从**上面**砍（终端只看最近的）。 */
export function appendRing(
  store: Pick<Store, 'getState' | 'setState'>,
  nowIso: string,
  level: 'info' | 'warn' | 'error',
  msg: string,
): void {
  const all = parse(store.getState(RING_KEY) ?? '');
  all.push({ t: nowIso, l: level, m: msg });
  const kept = all.length > RING_MAX ? all.slice(all.length - RING_MAX) : all;
  store.setState(RING_KEY, JSON.stringify(kept), nowIso);
}
