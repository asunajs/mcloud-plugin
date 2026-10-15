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
/** ⚠ **只走 V3**（`taskListV3`），不再按 group 拉 V2。
 *
 *  mcloud 的 `docs/task-log.md` 第 212 条（用户当场提的）已经查实：
 *  · **抓包里 `taskListV2` = 0 处** —— 真机云盘 App 云朵中心那一趟**只调 V3**；
 *    按 8 个 group 拉 V2 拿到的是**陈旧视图** ✗
 *  · **548 / 550 / 1078 是过期任务** —— `limitType` 从 `EVER` 变 `MONTH`、
 *    `lastupdate` 从 09-12 跳到 10-01 ⇒ `548/549`、`550/551`、`1078/1079` 是
 *    **同名新旧两版**，V2 里新旧都在、V3 里只剩新版 ✓
 *  ⇒ 改法：**每市场一发 V3**（`group` 空串 = 一次拿整个市场），拉取数 18 → 2 ✓
 *  ⇒ 改后列表里 **548/550/1078 消失**，与 App 一致 ✓
 *
 *  ⚠ 我一开始按 V2 拉，于是看到了 548/549/550/551/607 这些**根本不该出现的条目**，
 *  还据此写了"未实现"的表 —— 那是**照陈旧视图推**出来的结论。 */
export const MATRIX_MARKETS = ['sign_in_3', 'newsign_139mail'] as const;

/** V3 的路径（与 V2 同前缀，换末段）。 */
export const TASK_LIST_V3_PATH = '/ycloud/signin/task/taskListV3';

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
  /** 按钮链接。⚠ 写的那半的**按钮门**要它（`beiyong1ButtonGate` 找 `uploadView`）。
   *  实拍里它在 `button.app.link` 这一层，另外两种拼法也认（旧 TS 用过）。 */
  buttonAppLink?: string;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
/** 实拍形状是 `button: { app: { link } }` —— 缺一层就返回 `undefined`（不猜）。 */
function nestedLink(button: unknown): string | undefined {
  if (button === null || typeof button !== 'object') return undefined;
  const app = (button as Record<string, unknown>).app;
  if (app === null || typeof app !== 'object') return undefined;
  return asStr((app as Record<string, unknown>).link);
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
    buttonAppLink: asStr(o.buttonAppLink ?? o.button_app_link) ?? nestedLink(o.button),
  };
  const any =
    it.taskId !== undefined || it.name !== undefined || it.state !== undefined || it.enable !== undefined;
  return any ? it : undefined;
}

/** 解 `result`。**`result` 可能是空对象**（见文件头 ①）—— 认不出就当空。 */
export function parseMatrix(result: unknown, group?: string): MatrixItem[] {
  // `result` 自己可能是数组，也可能包着一层（`result.list` / `result.tasks`）
  let list: unknown = result;
  if (list !== null && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    // ⚠ V3：`result` **就是扁平数组**（mcloud 的 task-log 212 条：夹具改 V3 形状
    //   ⇒ "`result` 摊平成数组"）。V2 那种"按组名分键"的形状**也认**（老读数兼容）。
    // ⚠ **真机形状**（V2，已弃用）：`result` 是**按组名分键**的对象 ——
    //   `result.day` / `result.month` / …（`group=new` 那条回 `result:{}` 是真的空，
    //   不是解析失败）。原来这里只找 `list/tasks/taskList/items`，一个都对不上
    //   ⇒ **8 个组全读成 0 条**，而每条 note 都写着"成功"。
    if (group !== undefined && Array.isArray(o[group])) list = o[group];
    else list = o.list ?? o.tasks ?? o.taskList ?? o.items ?? [];
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

export interface MatrixReading extends MatrixSummary {
  group: string;
  at: string;
  /** ⚠ **条目本身也留一份**：写的那半（`app-task`）要靠它逐条行动 ——
   *  只留计数的话，那一半就没东西可做了（这是读写两半之间最容易漏的一环）。 */
  items?: MatrixItem[];
  /** 实拍里的 groupState（原样留一份，排障时看） */
  groupState?: unknown;
}

/** 每个 group 一条读数 —— 界面要一次看到 8 个，所以**按 group 存**，
 *  不是只留"最后读的那个"（那样界面上永远只有一格有数）。 */
export function matrixKey(group: string): string {
  return `mcloud.apptaskmatrix.g.${group}`;
}

export function readMatrix(store: { getState(k: string): string | null | undefined }): (MatrixReading | null)[] {
  return MATRIX_MARKETS.map((g) => {
    const raw = store.getState(matrixKey(g));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as MatrixReading;
      return typeof v === 'object' && v ? { ...v, group: g } : null;
    } catch {
      return null;
    }
  });
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
  const idx = Number.isFinite(parsed) && parsed >= 0 && parsed < MATRIX_MARKETS.length ? parsed : 0;
  // ⚠ 游标现在是**市场**（不是 group）：V3 一发拿整个市场，每市场一发 ⇒ 2 发跑完一轮
  const market = MATRIX_MARKETS[idx]!;

  const out = runTask(
    deps,
    {
      task: 'app-task-matrix',
      endpoint: 'taskListV3',
      method: 'POST',
      // ⚠ `activityid` 跟着**本次的 marketname** 走（mcloud 的 V3 构造器：先剥再补）
      marketName: market,
      isDeviceId: false,
      stateKey: STATE_LAST,
      // 实拍体：{"clientVersion":"12.6.0","group":<group>,"marketname":"sign_in_3"}
      // 体是**字符串**（与 receiveV3Body 同一约定）
      // ⚠ V3：`group` 是**空串** = 一次拿整个市场（实拍 content-length 62 逐字节对出来的）
      body: JSON.stringify({ marketname: market, clientVersion: TASK_CLIENT_VERSION, group: '' }),
    },
    (env) => {
      const items = parseMatrix(env.result, market);
      const s = summarize(items);
      deps.store.setState(STATE_GROUP_INDEX, String((idx + 1) % MATRIX_MARKETS.length), deps.nowIso);
      // 按**市场**落一条读数（界面直接吃这个）
      const reading: MatrixReading = {
        group: market,
        at: deps.nowIso,
        ...s,
        items,
        groupState: (env as { groupState?: unknown }).groupState,
      };
      deps.store.setState(matrixKey(market), JSON.stringify(reading), deps.nowIso);
      const names = s.todoNames.length ? `（可做：${s.todoNames.join('、')}）` : '';
      return {
        ok: true,
        note:
          `App 任务矩阵[${idx + 1}/${MATRIX_MARKETS.length} market=${market}]：` +
          `已完成 ${s.done} 条、可做 ${s.todo} 条、不参与 ${s.skip} 条${names}`,
        snapshot: { group: market, ...s, items: items.slice(0, 20) },
      };
    },
  );
  return out;
}

/** 让 `resultObject` 在这个模块里也被用到（保持与其它任务同一套信封解析）。 */
export const __envelope = resultObject;
