// 独立版（CLI）的日志器 —— **只给 CLI 用**。
//
// 面板那边走 `host-api` 的 log/start/success/fail，由 WebUI 着色；
// 这里只复刻 mcloud-sign 的 consoleTransport：
//
//   `[info] 11:04:00 msg`
//
// 为什么单独一层：CLI 和面板共用任务层，但两边看到的输出形状不同。
// 把格式写在这里，任务层继续只返回 `{steps, detail}`，面板的 `userLine`
// 一个字都不用改。
//
// 颜色与 mcloud-sign 同一张表；`common.colorize` 能覆盖自动判断。

export type CliLogType =
  | 'info'
  | 'debug'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'success'
  | 'start'
  | 'fail';

export interface CliLogger {
  info: (msg: unknown) => void;
  debug: (msg: unknown) => void;
  warn: (msg: unknown) => void;
  error: (msg: unknown) => void;
  fatal: (msg: unknown) => void;
  success: (msg: unknown) => void;
  start: (msg: unknown) => void;
  fail: (msg: unknown) => void;
}

/** 与 mcloud-sign 的 `COLORS` 同一张表。 */
const COLORS: Record<CliLogType, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[31m',
  success: '\x1b[32m',
  debug: '\x1b[90m',
  start: '\x1b[35m',
  fail: '\x1b[31m',
};
const RESET = '\x1b[0m';

function textOf(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.stack ?? `${msg.name}: ${msg.message}`;
  try {
    return JSON.stringify(msg) ?? String(msg);
  } catch {
    return String(msg);
  }
}

function hhmmss(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

/** 纯函数：一行日志的最终形状（测试不必等真实时间）。 */
export function formatLogLine(
  type: CliLogType,
  msg: unknown,
  at: Date = new Date(),
  colorize = false,
): string {
  const color = colorize ? COLORS[type] : '';
  const reset = colorize ? RESET : '';
  return `${color}[${type}]${reset} ${hhmmss(at)} ${textOf(msg)}`;
}

/** `common.colorize` 优先；否则按 TTY / NO_COLOR / FORCE_COLOR 判断。 */
export function colorizeFrom(common: Record<string, unknown>): boolean {
  const v = common.colorize;
  if (typeof v === 'boolean') return v;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY === true;
}

export function autoColorize(): boolean {
  return colorizeFrom({});
}

export function createCliLogger(opts: { colorize?: boolean } = {}): CliLogger {
  const colorize = opts.colorize ?? autoColorize();
  const write = (type: CliLogType, msg: unknown): void => {
    console.log(formatLogLine(type, msg, new Date(), colorize));
  };
  return {
    info: (msg) => write('info', msg),
    debug: (msg) => write('debug', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    fatal: (msg) => write('fatal', msg),
    success: (msg) => write('success', msg),
    start: (msg) => write('start', msg),
    fail: (msg) => write('fail', msg),
  };
}
