// 一次直播运行要用的"全局件"。
//
// 为什么要单独一个 ctx：\`collectOnce\` / \`drawOnce\` 拿到的是**某个账号**的
// \`TaskDeps\`（它的 \`store\` 是 scoped 到那个号的）。而日志、追踪环、听弹幕用的
// 长连接都必须是**整趟一份**的全局件 —— 混用会写出"拿 A 的袋记 B 的事"。
import type { HostWs } from '../../mcloud/tasks/base.ts';
import type { Transport } from '../../mcloud/client.ts';
import type { Store } from '../../store/types.ts';

export interface LiveCtx {
  /** 全局 store（不是 scoped 的那个） */
  store: Store;
  /** 长预算 transport（20 秒） */
  transport: Transport;
  /** 长连接那一族（ws_*） */
  host: HostWs;
  /** 这一趟的预算（毫秒），只是给读数用 */
  budgetMs: number;
}
