// 定时抢兑的 cron：只支持「整点」的 5 段表达式（分 时 日 月 周）。
//
// 用户要的是一天多个整点，例如 `0 10,14,20 * * *`；也允许用日/月/周
// 把范围收窄（`0 10 19 10 *` = 每年 10 月 19 日 10 点）。不引入第三方
// cron 库：插件跑在 QuickJS 里，能少一个依赖就少一个。

export interface CronSpec {
  hours: number[];
  dom: number[] | null;
  month: number[] | null;
  dow: number[] | null;
}

const MIN = 0;
const MAX_HOUR = 23;

function parseNum(s: string, min: number, max: number): number {
  if (!/^\d+$/.test(s)) throw new Error(`不是数字：${s}`);
  const n = Number(s);
  if (n < min || n > max) throw new Error(`超出范围：${s}`);
  return n;
}

/** 解析一个 cron 字段；`*` 返回 null（表示不限）。 */
function parseField(field: string, min: number, max: number): number[] | null {
  const f = field.trim();
  if (f === '') throw new Error('cron 字段不能为空');
  if (f === '*') return null;
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const p = part.trim();
    if (p === '') throw new Error('cron 字段里有空项');
    const base = p.split('/')[0]!;
    const stepRaw = p.split('/')[1];
    const step = stepRaw === undefined ? 1 : parseNum(stepRaw, 1, 999);
    let start = min;
    let end = max;
    if (base !== '*') {
      if (base.includes('-')) {
        const [a, b] = base.split('-');
        start = parseNum(a!, min, max);
        end = parseNum(b!, min, max);
        if (start > end) throw new Error(`范围反了：${base}`);
      } else {
        start = parseNum(base, min, max);
        end = start;
      }
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** 只接受 5 段、且分钟必须是 0（每个点都是整点）。 */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 要 5 段：分 时 日 月 周');
  const minute = parseField(parts[0]!, 0, 59);
  if (minute === null || minute.length !== 1 || minute[0] !== 0) {
    throw new Error('分钟只能是 0（抢兑点都是整点）');
  }
  const hoursRaw = parseField(parts[1]!, MIN, MAX_HOUR);
  const hours = hoursRaw ?? Array.from({ length: MAX_HOUR + 1 }, (_, i) => i);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dow = parseField(parts[4]!, 0, 7);
  return {
    hours,
    dom,
    month,
    dow: dow === null ? null : [...new Set(dow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (spec.month !== null && !spec.month.includes(d.getMonth() + 1)) return false;
  const domOk = spec.dom === null || spec.dom.includes(d.getDate());
  const dowOk = spec.dow === null || spec.dow.includes(d.getDay());
  // cron 的惯例：日/周都限定时是「或」，只限一个时就是那个。
  if (spec.dom !== null && spec.dow !== null) return domOk || dowOk;
  return domOk && dowOk;
}

/** 下一个目标整点（本地时区）。找不到返回 null。 */
export function nextCronTargetMs(expr: string, nowMs: number): number | null {
  const spec = parseCron(expr);
  const base = new Date(nowMs);
  for (let day = 0; day < 370; day += 1) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + day);
    if (!dayMatches(spec, d)) continue;
    for (const h of spec.hours) {
      const t = new Date(d.getTime());
      t.setHours(h, 0, 0, 0);
      if (t.getTime() >= nowMs) return t.getTime();
    }
  }
  return null;
}

/** 界面预览用：一天里的整点。 */
export function cronHoursText(expr: string): string {
  const spec = parseCron(expr);
  return spec.hours.map((h) => `${String(h).padStart(2, '0')}:00`).join('、');
}
