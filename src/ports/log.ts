// 日志端口。
//
// 业务层只说"这是什么级别的一句话"，往哪写由宿主决定：面板进日志表（界面按级别着色），
// CLI 打到 stdout（自己着色）。**这是日志，不是 I/O 错误通道** —— 写失败不该让任务失败。

export type LogLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'start'
  | 'success'
  | 'fail';

export type Logger = (level: LogLevel, msg: string) => void;

let current: Logger = () => {
  /* 没配就是静默：单测里不该因为"没装日志"炸掉 */
};

/** 宿主在启动时装一次。重复装是允许的（热重载/测试换桩）。 */
export function configureLogger(l: Logger): void {
  current = l;
}

/** 写一条日志。**唯一**的业务侧入口（不要在各处直接摸宿主）。 */
export function logTo(level: LogLevel, msg: string): void {
  try {
    current(level, msg);
  } catch {
    // 日志是旁路：它自己炸了不该带着任务一起炸
  }
}
