// 算力大作战的**判定层**：任务表 → 计划；汇总句；数字格式化。纯函数，零 IO。
//
// 判据顺序：**抓包优先**（`mcloud-capture/.../app-tokenpk-playai-samples.txt` §8.2/§8.6），
// 抓包没有的分支照参照实现（`caiyun/tasks/tokenpk.go::planTokenPKActions`）。
//
// # 状态与动作（两轮实拍出来的）
//
// ```text
//   WAIT ──click──► WAIT(currstep=1) ──原生动作──► SUCCESS(currstep=2) ──receivePrize──► FINISH(currstep=3)
//   WAIT(RESERVE) ──reserve──► SUCCESS(currstep=1)          ← 预约不是"领"，也不再领
//   WAIT ──click──► SUCCESS（openUrl 这一类：只有 click，没有原生信号）
//   FINISH ──► 跳过
// ```
//
// ⚠ **`taskType=RESERVE` 的两种状态都要单独判**：
//   · `WAIT` ⇒ 预约（走 `step/reserve`，不走 `click`）；
//   · `SUCCESS` ⇒ **什么都不做**（页面在这里直接 return：预约成功不是奖品，别去领）。

/** 任务表里的一条（只收判据用得到的格子；原始对象见 `tokenPk.ts::parseTaskList`）。 */
export interface PkTask {
  id: number;
  name: string;
  description: string;
  state: string;
  taskType: string;
  limitType: string;
  currstep: number;
  claimable: boolean;
  monthlyCompleted: number;
  monthlyLimit: number;
  prizes: { prizeType: string; prizeName: string; amount: number }[];
  button: Record<string, { ext: string; action: string; text: string }>;
}

export type PkKind = 'run' | 'claim' | 'reserve';

export interface PkAction {
  task: PkTask;
  /** 动作词（`ext`）—— `click`/`reserve` 的 `key` 就是它 */
  key: string;
  kind: PkKind;
}

export interface PkPlan {
  /** 按任务表原序，一条任务最多一格 */
  actions: PkAction[];
  /** 需手动：`名称(ext)` */
  manual: string[];
  /** 跳过（FINISH / 月上限 / 预约成功） */
  skipped: number;
}

/** 能让插件自己造证据的动作词（抓包实测到的 7 个 + 静态面看到的 `openAlbum`）。 */
export const RUN_KEYS: readonly string[] = [
  'backup',
  'uploadPhoto',
  'aiCamera',
  'aiAssistant',
  'createNote',
  'shareFile',
  'openUrl',
  'loginPc',
  'openAlbum',
];

/** 平台优先序：抓包是 iOS ⇒ 先读 `ios`；其余按参照实现的顺序兜底。 */
const PLATFORMS = ['ios', 'android', 'other', 'harmony', 'app'] as const;

/** 按钮的 `ext`（= 动作词）。空串表示这一条没有按钮。 */
export function stepKeyOf(t: PkTask): string {
  for (const p of PLATFORMS) {
    const b = t.button[p];
    if (b !== undefined && b.ext.trim() !== '') return b.ext.trim();
  }
  for (const b of Object.values(t.button)) {
    if (b.ext.trim() !== '') return b.ext.trim();
  }
  return '';
}

function stateOf(t: PkTask): string {
  return t.state.trim().toUpperCase();
}

export function isReserve(t: PkTask): boolean {
  return t.taskType.trim().toUpperCase() === 'RESERVE';
}

/** 月上限到了没。`monthlyLimit` 可能是 `null`（没有上限）⇒ 永远没到。 */
export function overMonthlyLimit(t: PkTask): boolean {
  return t.monthlyLimit > 0 && t.monthlyCompleted >= t.monthlyLimit;
}

/** 任务表 → 计划。**原序**，按 id 去重（同一 id 出现两次只做第一格）。 */
export function planTasks(tasks: readonly PkTask[]): PkPlan {
  const plan: PkPlan = { actions: [], manual: [], skipped: 0 };
  const seen = new Set<number>();
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const st = stateOf(t);
    if (st === 'FINISH') {
      plan.skipped += 1;
      continue;
    }
    if (st === 'SUCCESS') {
      // 预约成功不是奖品：页面在 SUCCESS+RESERVE 时直接 return
      if (isReserve(t)) {
        plan.skipped += 1;
        continue;
      }
      plan.actions.push({ task: t, key: stepKeyOf(t), kind: 'claim' });
      continue;
    }
    // WAIT / 其它（ING 之类）：先判月上限，再判能不能自动做
    if (overMonthlyLimit(t)) {
      plan.skipped += 1;
      continue;
    }
    if (isReserve(t)) {
      plan.actions.push({ task: t, key: stepKeyOf(t), kind: 'reserve' });
      continue;
    }
    const key = stepKeyOf(t);
    if (RUN_KEYS.includes(key)) {
      plan.actions.push({ task: t, key, kind: 'run' });
      continue;
    }
    // `inviteFriend`（要人真的邀好友）与没见过的 key：一个字节都不发
    plan.manual.push(`${t.name}(${key === '' ? '没有按钮' : key})`);
  }
  return plan;
}

/** 算力数 → 人话。逐字照参照实现：`>=1e8` 一位小数「亿」，`>=1e4` 整数「万」，否则原数。 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 100_000_000) return `${(tokens / 100_000_000).toFixed(1)}亿`;
  if (tokens >= 10_000) return `${Math.floor(tokens / 10_000)}万`;
  return String(Math.floor(tokens));
}

/** 汇总句的计数。 */
export interface PkCounts {
  claimed: number;
  executed: number;
  chanceReward: number;
  /** 代抽了几次（0/未给 = 没抽） */
  drawn?: number | undefined;
  /** 代抽中了几次 */
  wins?: number | undefined;
  usedToken?: number | undefined;
  manual: readonly string[];
  failed: number;
  pending: number;
}

/** 汇总句：**句式逐字照参照实现**（用户看得见的那一行）。 */
export function summaryOf(c: PkCounts): string {
  const parts: string[] = [];
  if (c.claimed > 0) parts.push(`领取奖励${c.claimed}项`);
  if (c.executed > 0) parts.push(`执行任务${c.executed}项`);
  if (c.chanceReward > 0) parts.push(`抽奖次数+${c.chanceReward}`);
  if (c.drawn !== undefined && c.drawn > 0) {
    const wins = c.wins ?? 0;
    parts.push(wins > 0 ? `代抽${c.drawn}次（中${wins}次）` : `代抽${c.drawn}次（都没中）`);
  }
  if (c.usedToken !== undefined && c.usedToken > 0) parts.push(`累计算力${formatTokenCount(c.usedToken)}`);
  if (c.manual.length > 0) parts.push(`需手动: ${c.manual.join('、')}`);
  if (c.failed > 0) parts.push(`${c.failed}项步骤失败`);
  if (c.pending > 0) parts.push(`${c.pending}项待服务端确认或跨月完成`);
  if (parts.length === 0) return '本轮无可执行步骤（已完成、达到月上限或待好友互助）';
  return parts.join('；');
}

// ── 原始响应 → 窄形状（纯）────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown, d = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return d;
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

/** `task/list` 的 `result` → 任务表。**只收判据用得到的格子**（原始对象不落库）。
 *
 *  ⚠ `prizes[].available` 在 2026-11-01 的实拍里有：页面自己按它过滤（`available` 为真才算）。
 *  老形状（2026-10-24）没有这格 ⇒ 没有就照收，别把奖品全过滤掉。 */
export function tasksFrom(result: unknown): PkTask[] {
  if (!Array.isArray(result)) return [];
  const out: PkTask[] = [];
  for (const raw of result) {
    const t = asRecord(raw);
    if (t === undefined) continue;
    const id = num(t.id, -1);
    if (id < 0) continue;
    const buttons: PkTask['button'] = {};
    const b = asRecord(t.button);
    if (b !== undefined) {
      for (const [platform, one] of Object.entries(b)) {
        const o = asRecord(one);
        if (o === undefined) continue;
        buttons[platform] = {
          ext: str(o.ext),
          action: str(o.action),
          text: str(o.text),
        };
      }
    }
    const prizesRaw = Array.isArray(t.prizes) ? t.prizes : [];
    const prizes: PkTask['prizes'] = [];
    for (const p of prizesRaw) {
      const o = asRecord(p);
      if (o === undefined) continue;
      if (o.available !== undefined && o.available !== true) continue;
      prizes.push({
        prizeType: str(o.prizeType),
        prizeName: str(o.prizeName),
        amount: num(o.amount),
      });
    }
    out.push({
      id,
      name: str(t.name, `#${id}`),
      description: str(t.description),
      state: str(t.state).toUpperCase(),
      taskType: str(t.taskType).toUpperCase(),
      limitType: str(t.limitType).toUpperCase(),
      currstep: num(t.currstep),
      claimable: t.claimable === true,
      monthlyCompleted: num(t.monthlyCompleted),
      monthlyLimit: num(t.monthlyLimit),
      prizes,
      button: buttons,
    });
  }
  return out;
}
