// 一趟兑换运行要用的"全局件"。
import type { Transport } from '../../mcloud/client.ts';
import type { Store } from '../../store/types.ts';

export interface ExchangeCtx {
  /** 全局 store（不是 scoped 的那个） */
  store: Store;
  /** 长预算 transport（20 秒） */
  transport: Transport;
  /** 这条任务声明的预算（毫秒） */
  budgetMs: number;
  /** 推送（实现由入口注入 —— 要宿主能力，领域层不认识） */
  notify(taskKey: 'daily' | 'exchange' | 'live', title: string, text: string, hadFailure: boolean): Promise<unknown>;
}
