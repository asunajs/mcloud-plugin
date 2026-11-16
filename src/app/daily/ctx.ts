// 一趟日常运行要用的"全局件"。
//
// 逐账号那段拿到的是**某个账号**的 \`TaskDeps\`（store 是 scoped 的），
// 而日志、运行记录、卡片摘要都必须是整趟一份 —— 所以显式传。
import type { Transport } from '../../mcloud/client.ts';
import type { Store } from '../../store/types.ts';

export interface DailyCtx {
  /** 全局 store（不是 scoped 的那个） */
  store: Store;
  /** 长预算 transport（20 秒） */
  transport: Transport;
  /** 这条任务声明的预算（毫秒） */
  budgetMs: number;
  /** 推送：跑完之后按规则发一条（实现由入口注入 —— 推送要宿主能力，领域层不认识） */
  notify(taskKey: 'daily' | 'exchange' | 'live', title: string, text: string, hadFailure: boolean): Promise<unknown>;
}
