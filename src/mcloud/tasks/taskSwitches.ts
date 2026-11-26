// 日常子任务的开关（按账号 + 公共默认）。
//
// # 为什么要这一层
//
// 「日常」一条任务里有好几族互不相干的事（签到、任务拓展、App 任务、云手机、算力大作战）。
// 用户想只跑其中几族：有的族会往云机里装应用、有的族要花抽奖次数。以前只有 CLI 能关，
// 面板上关不掉 ⇒ 面板用户只能全开或全不跑。
//
// # 三层取值：账号 > 公共 > 缺省
//
// ```text
//   账号层  mcloud.task.<id>.on   （账号袋，'1'/'0'；空串 = 没设过）
//   公共层  config.json 的 task_<id>（bool；缺席 = 缺省）
//   缺省    TASK_SWITCHES[].defaultOn
// ```
//
// ⚠ **空串不是关**：`''` / `null` 一律当"没设过"，回落到公共层。这与旧的
// `redpackEnabled` 用 `!== '0'` 判"开"是同一个语义 —— 改成"空串=关"会让所有老用户
// 在升级那一刻静默关掉一半任务。
//
// ⚠ **云手机缺省关**（2026-11-25 用户口径）：它会往用户的云机里装应用，默认不碰。
//   显式设过 `'1'` 的（CLI 写的老键，见 `migrateTaskSwitches`）迁移后仍然是开。

import { readBag, moveBagKey } from '../../store/keys.ts';
import { loadAccounts } from '../accounts.ts';
import type { Store } from '../../store/types.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

export type TaskSwitchId = 'signin' | 'expansion' | 'appTask' | 'redpack' | 'tokenpk' | 'playAI';

export interface TaskSwitchSpec {
  id: TaskSwitchId;
  /** 面板与日志里的名字（用户认得的词） */
  label: string;
  /** 这一格管哪些步骤 —— 写清楚，否则用户不知道关了会少什么 */
  help: string;
  defaultOn: boolean;
}

/** **单一事实源**：界面、文档、测试都读这张表，别各写一份。 */
export const TASK_SWITCHES: readonly TaskSwitchSpec[] = [
  {
    id: 'signin',
    label: '每日签到',
    help: '签到、签到翻倍、复活卡',
    defaultOn: true,
  },
  {
    id: 'expansion',
    label: '任务拓展',
    help: '随机文件上传 + 快照（会往网盘里写文件，跑完自己清理）',
    defaultOn: true,
  },
  {
    id: 'appTask',
    label: 'App 任务',
    help: 'App 任务清单与打卡、分享领奖',
    defaultOn: true,
  },
  {
    id: 'redpack',
    label: '云手机',
    help: '红包派对（会往云机里装应用）',
    defaultOn: false,
  },
  {
    id: 'tokenpk',
    label: '算力大作战',
    help: '活动任务、阶段奖励、代抽',
    defaultOn: true,
  },
  {
    id: 'playAI',
    // ⚠ 名字要让用户认得出：活动页上写的是「趣玩AI赢好礼」
    label: '趣玩AI',
    help: 'AI 任务的读数；第一版**只读**（不替你做任务、不抽奖）',
    defaultOn: true,
  },
];

export const TASK_SWITCH_BY_ID: ReadonlyMap<TaskSwitchId, TaskSwitchSpec> = new Map(
  TASK_SWITCHES.map((s) => [s.id, s]),
);

export function isTaskSwitchId(v: string): v is TaskSwitchId {
  return TASK_SWITCH_BY_ID.has(v as TaskSwitchId);
}

/** 账号层键。**每个 id 一个形状**（别在注释里写死条数：加族时最容易被忘掉的就是它）—— 不许再出现 `enabled` / `on` 混用。 */
export function accountKeyOf(id: TaskSwitchId): string {
  return `mcloud.task.${id}.on`;
}

/** 公共层键（`config.json` 的顶层名）。 */
export function commonKeyOf(id: TaskSwitchId): string {
  return `mcloud.task.${id}.common`;
}

/** 公共层在配置文件里的点路径（与 `CONFIG_BINDINGS` 一致）。 */
export function commonPathOf(id: TaskSwitchId): string {
  return `task_${id === 'appTask' ? 'app_task' : id}`;
}

/** 把各种历史编码归一成布尔。`null` = 没有明确的值。 */
function parseOn(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  if (t === '1' || t === 'true' || t === 'on' || t === 'yes') return true;
  if (t === '0' || t === 'false' || t === 'off' || t === 'no') return false;
  return null;
}

export type TaskSwitchSource = 'account' | 'common' | 'default';

/** 这一格现在**从哪一层**取值（界面用它显示「跟随公共配置」）。 */
export function taskSource(store: Pick<Store, 'getState'>, id: TaskSwitchId): TaskSwitchSource {
  if (parseOn(store.getState(accountKeyOf(id))) !== null) return 'account';
  if (parseOn(store.getState(commonKeyOf(id))) !== null) return 'common';
  return 'default';
}

/** 这一格开不开（三层合并）。 */
export function taskOn(store: Pick<Store, 'getState'>, id: TaskSwitchId): boolean {
  const acct = parseOn(store.getState(accountKeyOf(id)));
  if (acct !== null) return acct;
  const common = parseOn(store.getState(commonKeyOf(id)));
  if (common !== null) return common;
  return TASK_SWITCH_BY_ID.get(id)?.defaultOn ?? true;
}

/** 写账号层（`'1'` / `'0'`）。`store` 必须是 `scoped(raw, acctId)`。 */
export function setTaskOn(store: Store, id: TaskSwitchId, on: boolean, nowIso: string): void {
  store.setState(accountKeyOf(id), on ? '1' : '0', nowIso);
}

/** 清掉账号层 ⇒ 回到公共层（不是"设成开"）。 */
export function resetTaskOn(store: Store, id: TaskSwitchId, nowIso: string): void {
  store.setState(accountKeyOf(id), '', nowIso);
}

/** 关了就返回一个「跳过」结果：一个请求都不发，但运行记录里仍有一行（灰）。 */
export function taskGate(deps: TaskDeps, id: TaskSwitchId): TaskOutcome {
  if (taskOn(deps.store, id)) return { ok: true, idle: false, note: '' };
  const label = TASK_SWITCH_BY_ID.get(id)?.label ?? id;
  return { ok: true, idle: true, skipped: true, note: `「${label}」已关闭（账号设置里可以开）` };
}

/** 一次「调试运行」的参数（面板 `POST /api/tasks/<plugin>/<task>/run` 的 `params`）。
 *
 *  ```jsonc
 *  { "include": ["tokenpk"], "accounts": ["<账号 id>"], "force": true }
 *  ```
 *
 *  - `include`：只跑这些族；`null`/没写 = 全跑；**空数组是错误**（"至少选一族"，
 *    不是"全跑" —— 那会静默反直觉）；
 *  - `accounts`：**只接受一个** id。调试一次只跑一个号：多号请用「日常」页
 *    （那里的自动/本次选择才是多号的家）；
 *  - `force`：只放宽**两层门** —— 子任务开关（`taskOn`）与账号停用。
 *    凭据、幂等、串行、间隔、预算、脱敏**一律不放宽**。
 *
 *  ⚠ 为什么 `force` 存在：调试一个新族时，"先去账号设置里把它打开"这一步
 *  本身就是多余的门（用户原话：「总开关都关了我还调个屁」）。 */
export interface TaskRunParams {
  /** `null` = 全跑 */
  include: TaskSwitchId[] | null;
  /** 只跑这一个账号；`null` = 按任务自己的选择（auto/manual） */
  account: string | null;
  force: boolean;
}

export function parseTaskRunParams(raw: unknown): TaskRunParams | { error: string } {
  const valid = TASK_SWITCHES.map((t) => t.id);
  if (raw === null || raw === undefined) return { include: null, account: null, force: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'params 必须是对象' };
  const o = raw as Record<string, unknown>;

  let include: TaskSwitchId[] | null = null;
  if (o['include'] !== undefined && o['include'] !== null) {
    if (!Array.isArray(o['include'])) return { error: 'include 必须是族 id 的数组' };
    const list: TaskSwitchId[] = [];
    for (const one of o['include']) {
      if (typeof one !== 'string' || !isTaskSwitchId(one)) {
        return { error: `没有这个任务：${String(one)}（可用：${valid.join(' / ')}）` };
      }
      if (!list.includes(one)) list.push(one);
    }
    if (list.length === 0) return { error: '至少选一族（空数组不等于全跑）' };
    include = list;
  }

  let account: string | null = null;
  if (o['accounts'] !== undefined && o['accounts'] !== null) {
    if (!Array.isArray(o['accounts'])) return { error: 'accounts 必须是数组' };
    if (o['accounts'].length !== 1) {
      return { error: '调试一次只跑一个号；要跑多个号请用「日常」页的账号选择' };
    }
    const one = o['accounts'][0];
    if (typeof one !== 'string' || one.trim() === '') return { error: '账号 id 不能为空' };
    account = one.trim();
  }

  const force = o['force'] === true;
  return { include, account, force };
}

/** 旧键 → 新键。**只搬一次**，搬完旧键置空（不留两份值）。 */
const LEGACY_KEYS: readonly { from: string; id: TaskSwitchId }[] = [
  { from: 'mcloud.redpack.enabled', id: 'redpack' },
  { from: 'mcloud.tokenpk.enabled', id: 'tokenpk' },
];

/** 把旧的两个开关键搬到统一形状上（一次性、幂等）。
 *
 *  ⚠ 必须在**裸 store** 上跑（与 `migrateFlatKeys` 同序）：它直接读写账号袋。
 *  ⚠ 只搬"有明确值"的那些：老键没写过（空）就不写新键 ⇒ 落到新的缺省
 *  （云手机因此从"隐式开"变成"显式缺省关"，这是 2026-11-25 定的口径）。
 *  ⚠ 值要归一：老 `tokenpk` 写的是 `'true'/'false'`，新键只认 `'1'/'0'`。 */
export function migrateTaskSwitches(store: Store, nowIso: string): string[] {
  const moved: string[] = [];
  for (const a of loadAccounts(store)) {
    for (const { from, id } of LEGACY_KEYS) {
      const v = readBag(store, a.id)[from];
      if (parseOn(v) === null) continue;
      const to = accountKeyOf(id);
      if (moveBagKey(store, a.id, from, to, nowIso)) moved.push(`${a.label}:${id}`);
    }
  }
  return moved;
}
