// 任务：AI豆余额快照（`cloud-snapshot`）—— 纯只读，查的是流水账。
//
// 端点：`GET /ycloud/signin/public/cloudRecordV2?aiDou=1&type=0&pageNumber=1&pageSize=100`
// 参数来自 `mcloud-tasks/src/beans.rs`：`LEDGER_AI_DOU = 1`、`TYPE_ALL = 0`、
// `PAGE_SIZE = 100`。那一页的注释还点明了分页规则：**一页正好装满（== PAGE_SIZE）
// 就要下一页**，拿满上限还没到底就报错（不要静默取前 N 条）。
//
// ⚠️ 本任务只取**第一页**，并把「满了可能还有下一页」如实记进 note ——
// 不在这里偷偷循环拉全（那会把一次调用拖成多个请求，撞执行预算）。
// 真正的翻页应该做成步骤机的一步一步（下一天再说）。

import { resultArray } from '../envelope.ts';
import type { SignInEnvelope } from '../envelope.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export const STATE_SNAPSHOT = 'mcloud.cloudsnapshot.last';

/** 账本与参数（抄自 `mcloud-tasks/src/beans.rs`）。 */
export const LEDGER_AI_DOU = 1;
export const TYPE_ALL = 0;
export const PAGE_SIZE = 100;

export function snapshotQuery(pageNumber = 1): string {
  return `aiDou=${LEDGER_AI_DOU}&type=${TYPE_ALL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
}

export interface SnapshotEntry {
  id: number | undefined;
  /** 变动量（正数进、负数出） */
  value: number | undefined;
  /** 变动原因/类型 */
  reason: string | undefined;
  insertTime: string | undefined;
}

export function runCloudSnapshot(deps: TaskDeps): TaskOutcome {
  return runTask(
    deps,
    {
      task: 'cloud-snapshot',
      endpoint: 'cloudRecordV2',
      method: 'GET',
      query: snapshotQuery(),
      isDeviceId: false,
      stateKey: STATE_SNAPSHOT,
    },
    (env: SignInEnvelope) => {
      const list = resultArray(env);
      const entries: SnapshotEntry[] = list.map((x) => {
        const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
        const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        return {
          id: num(o.id),
          value: num(o.aiDou ?? o.value ?? o.change),
          reason: str(o.typeName ?? o.reason ?? o.type),
          insertTime: str(o.insertTime ?? o.time),
        };
      });
      // 最近一条有数值的变动，当"最新一笔"
      const latest = [...entries].reverse().find((e) => e.value !== undefined);
      const full = entries.length === PAGE_SIZE;
      return {
        ok: true,
        note:
          `流水 ${entries.length} 条` +
          (latest ? `，最新一笔 ${latest.value}（${latest.reason ?? '—'}）` : '') +
          (full ? `；== pageSize(${PAGE_SIZE}) 说明可能还有下一页（本任务只取第一页）` : ''),
        snapshot: { entries, truncated: full },
      };
    },
  );
}
