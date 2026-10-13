// 任务：App 任务矩阵（`app-task-matrix`）—— `app-task` 的**只读那一半**。
//
// 为什么单独有这条：写的那半（`app-task`）每发一次 `task/click` 都在告诉上游
// "这条我做完了"，**不可回滚**，而且顺带**往用户网盘传文件**（玩法 106 / 522 /
// beiyong1 的名字门）。而"这一条要不要做、做几个"的判据在原项目里是**纯函数**
// （`upload_shape_for`）—— 也就是说，**先看清楚有什么**这件事本身不需要任何写。
//
// 于是这条任务只做一件事：把 8 个 group 的矩阵读出来，逐条判"已完成 / 可做 / 不参与"。
// 一个字节都不写。
//
// # 为什么一次只读一个 group
//
// 面板的单次执行预算是 2000ms，而且**打断不了阻塞中的请求** —— 一次调用里连发 8 个
// 请求，就多 8 倍撞预算的机会。所以按 group 分步：一次调用读一个，状态落 SQLite，
// 8 次覆盖一轮。慢，但每一步都能单独观察、单独复现（跟签到族那套是一个道理）。
//
// # 两个实拍坑（照抄，不"统一"）
//
// ① **`result` 可能是空对象**。实拍里 `{"code":0,"msg":"success","result":{},
//    "groupState":{}}` —— `result` 是 `{}` 而不是 `[]`。把它当数组读会炸，
//    当"有数据"读会误判。
// ② **`groupid` 全小写**，而拍拍那一族是驼峰 `groupId`。这是两族的**真实差异**
//    （原项目逐字比对过实拍）—— 所以两个都认，别"统一"成一种。

import { resultObject } from '../envelope.ts';
import { MARKET_NAME, TASK_CLIENT_VERSION } from '../h5.ts';
import { runTask } from './base.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 读到第几个 group 了（跨调用推进）。 */
export const STATE_GROUP_INDEX = 'mcloud.apptaskmatrix.group_index';
/** 最近一次读到的结论（排障用） */
export const STATE_LAST = 'mcloud.apptaskmatrix.last';

/** 8 个 group，顺序照原项目的常量表（逐字抄）。 */
export const MATRIX_GROUPS = [
  'new',
  'beiyong1',
  'beiyong2',
  'cloudEmail',
  'time',
  'day',
  'month',
  'hidden',
] as const;

export interface MatrixItem {
  taskId?: number;
  name?: string;
  /** 实拍是奖励文案，如「永葆童心 领38云朵」 */
  description?: string;
  groupId?: string;
  /** 实拍 `FINISH`。不归一：读不出原样就是 undefined */
  state?: string;
  /** 实拍 `EVER` / `DAY` */
  limitType?: string;
  /** 旧实现的门是 `enable != 1` ⇒ 跳过 */
  enable?: number;
  currStep?: number;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 解一条。字段名两个都认（`groupid` 小写 / `groupId` 驼峰 —— 见文件头 ②）。 */
export function parseMatrixItem(raw: unknown): MatrixItem | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const it: MatrixItem = {
    taskId: asInt(o.id ?? o.taskId ?? o.task_id),
    name: asStr(o.name),
    description: asStr(o.description),
    groupId: asStr(o.groupid ?? o.groupId),
    state: asStr(o.state),
    limitType: asStr(o.limitType ?? o.limit_type),
    enable: asInt(o.enable),
    currStep: asInt(o.currstep ?? o.currStep),
  };
  const any =
    it.taskId !== undefined || it.name !== undefined || it.state !== undefined || it.enable !== undefined;
  return any ? it : undefined;
}

/** 解 `result`。**`result` 可能是空对象**（见文件头 ①）—— 认不出就当空。 */
export function parseMatrix(result: unknown): MatrixItem[] {
  // `result` 自己可能是数组，也可能包着一层（`result.list` / `result.tasks`）
  let list: unknown = result;
  if (list !== null && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.list ?? o.tasks ?? o.taskList ?? o.items ?? [];
  }
  if (!Array.isArray(list)) return [];
  return list.map(parseMatrixItem).filter((x): x is MatrixItem => !!x);
}

/** 这一条现在该怎么算。
 *
 *  `done` 已完成（`state === 'FINISH'`）· `todo` 可做（`enable === 1`）·
 *  `skip` 不参与（`enable != 1`，或字段不全 —— **字段不全不算"可做"**，
 *  这条跟通知任务那边一个道理：宁可漏报"可做"，也不要报出一个不存在的活）。 */
export function judgeItem(i: MatrixItem): 'done' | 'todo' | 'skip' {
  if (i.state === 'FINISH') return 'done';
  if (i.enable === 1) return 'todo';
  return 'skip';
}

export interface MatrixSummary {
  done: number;
  todo: number;
  skip: number;
  /** 可做的那几条的名字（给人看的，最多列 3 条） */
  todoNames: string[];
}

export function summarize(items: MatrixItem[]): MatrixSummary {
  let done = 0;
  let todo = 0;
  let skip = 0;
  const todoNames: string[] = [];
  for (const i of items) {
    const j = judgeItem(i);
    if (j === 'done') done += 1;
    else if (j === 'todo') {
      todo += 1;
      if (todoNames.length < 3) todoNames.push(i.name ?? i.description ?? `#${i.taskId ?? '?'}`);
    } else skip += 1;
  }
  return { done, todo, skip, todoNames };
}

/** 一步：读**一个** group（只读）。读完推进游标；到末尾就回到第一个。 */
export function runAppTaskMatrix(deps: TaskDeps): TaskOutcome {
  const raw = deps.store.getState(STATE_GROUP_INDEX);
  const parsed = raw === undefined || raw === null ? 0 : Number(raw);
  const idx = Number.isFinite(parsed) && parsed >= 0 && parsed < MATRIX_GROUPS.length ? parsed : 0;
  const group = MATRIX_GROUPS[idx]!;

  const out = runTask(
    deps,
    {
      task: 'app-task-matrix',
      endpoint: 'taskListV2',
      method: 'POST',
      marketName: MARKET_NAME,
      isDeviceId: false,
      stateKey: STATE_LAST,
      // 实拍体：{"clientVersion":"12.6.0","group":<group>,"marketname":"sign_in_3"}
      // 体是**字符串**（与 receiveV3Body 同一约定）
      body: JSON.stringify({ clientVersion: TASK_CLIENT_VERSION, group, marketname: MARKET_NAME }),
    },
    (env) => {
      const items = parseMatrix(env.result);
      const s = summarize(items);
      deps.store.setState(STATE_GROUP_INDEX, String((idx + 1) % MATRIX_GROUPS.length), deps.nowIso);
      const names = s.todoNames.length ? `（可做：${s.todoNames.join('、')}）` : '';
      return {
        ok: true,
        note:
          `App 任务矩阵[${idx + 1}/${MATRIX_GROUPS.length} group=${group}]：` +
          `已完成 ${s.done} 条、可做 ${s.todo} 条、不参与 ${s.skip} 条${names}`,
        snapshot: { group, ...s, items: items.slice(0, 20) },
      };
    },
  );
  return out;
}

/** 让 `resultObject` 在这个模块里也被用到（保持与其它任务同一套信封解析）。 */
export const __envelope = resultObject;
