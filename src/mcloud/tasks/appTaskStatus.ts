// App 任务**状态播报** —— 只读，一个请求都不发。
//
// # 为什么需要它
//
// 2026-11-01 删掉三条旧任务（备份好礼 / 开启通知领AI豆 / 消息推送奖励）：
// 新版 taskList 里这些事**由服务端自己记账**，我们既不用点也不用领（挣到的云朵进
// `receiveList`，由「领取AI豆」那一步领走）。但**用户还是要知道它们现在什么状态**：
// 通知开了几天、备份好礼是不是本月已经领过、分享攒到几份。
//
// 这些答案上游已经**替我们写好在一句话里**了 —— 任务条目上的 `buttonOutText`
// 就是 App 上那个按钮的字（`开启中` / `去开启` / `下月再来` / `已完成`），
// 配上 `buttonOutDay`/`buttonOutTotal`（29/31）与标题里的 `1/7` 进度。
//
// ⚠ 所以这里**不许自己造状态词**：读不到 `buttonOutText` 就跳过这一条
//   （"没说"不等于"没做"，编一个「待办」上去就是另一种说谎）。
//
// 判据对照（2026-11-01 真机实拍，三个号两种市场）：
//   549  备份文件领好礼          buttonOutText=下月再来        ⇒ 本月已完成，下月再来
//   551  连续31天开启云盘APP通知  buttonOutText=开启中 day=29 total=31 ⇒ 已开启 29/31 天
//   1021 连续31天开启邮箱APP通知  buttonOutText=去开启 day=0    ⇒ 还没开启（去 App 打开）
//   434  分享文件领好礼           buttonOutText=已完成 + name 里 1/7 ⇒ 已完成 1/7

import { readMatrix } from './appTaskMatrix.ts';
import type { MatrixItem } from './appTaskMatrix.ts';

export interface StatusSpec {
  id: number;
  title: string;
}

/** 要播报哪几条。加一行就多播一条 —— 前提是上游会写 `buttonOutText`。 */
export const STATUS_TASKS: readonly StatusSpec[] = [
  { id: 549, title: '备份文件领好礼' },
  { id: 551, title: '连续31天开启云盘APP通知' },
  { id: 1021, title: '连续31天开启邮箱APP通知' },
  { id: 434, title: '分享文件领好礼' },
];

/** 标题里可能带标签（`分享文件领好礼<span id='share_title'>1/7</span>`）—— 去掉标签。 */
function plainName(raw: string): string {
  // ⚠ 先把**带内容的**标签整块去掉：`分享文件领好礼<span id='share_title'>1/7</span>`
  //   里的 `1/7` 应该进"进度"，不该留在标题里（否则会念成「分享文件领好礼 1/7：已完成 1/7」）。
  return raw
    .replace(/<[^>]*>[^<]*<\/[^>]*>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题里那个 `N/M` 进度（434 的分享份数就在这儿，上游没给单独字段）。 */
function progressOf(item: MatrixItem): string | undefined {
  const m = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(item.name ?? '');
  return m === null ? undefined : `${m[1]}/${m[2]}`;
}

/** 一条 → 一句话。`undefined` = 上游没说，别猜。 */
export function describeStatus(item: MatrixItem, title?: string): string | undefined {
  const btn = (item.buttonOutText ?? '').trim();
  if (btn === '') return undefined;
  const head = title ?? (plainName(item.name ?? '') || `#${String(item.taskId ?? '')}`);
  const day = (item.buttonOutDay ?? '').trim();
  const total = (item.buttonOutTotal ?? '').trim();
  const prog = progressOf(item);

  let body: string;
  if (/开启中|已开启/.test(btn)) {
    body = day !== '' && total !== '' ? `已开启 ${day}/${total} 天` : '已开启';
  } else if (/^(去开启|立即开启|开启)$/.test(btn)) {
    body = '还没开启（去 App 打开）';
  } else if (/下月再来|下月可领/.test(btn)) {
    body = '本月已完成，下月再来';
  } else if (/^已完成$/.test(btn)) {
    body = prog === undefined ? '已完成' : `已完成 ${prog}`;
  } else if (/预定/.test(btn)) {
    body = '下月再来（现在还不能做）';
  } else if (/^(去完成|立即完成|去参与|立即参与)$/.test(btn)) {
    body = '还没做';
  } else {
    // 认不出来就**照抄上游那句**：它的原话比我们编的准。
    body = btn;
  }
  return `${head}：${body}`;
}

/** 两个市场里同一条可能各出现一次（549 两处都有）—— 去重，优先"有进度"的那条。 */
function pickBetter(a: MatrixItem, b: MatrixItem): MatrixItem {
  const score = (x: MatrixItem): number =>
    (x.buttonOutText === undefined ? 0 : 1) + (x.buttonOutDay === undefined ? 0 : 2) + (progressOf(x) === undefined ? 0 : 4);
  return score(b) > score(a) ? b : a;
}

/** 播报这几条。`backupOn === false` 时给 549 补一句"备份没开"（开关不在这条任务里）。 */
export function appTaskStatusLines(
  store: { getState(k: string): string | null | undefined },
  opts: { backupOn?: boolean | undefined } = {},
): string[] {
  const seen = new Map<number, MatrixItem>();
  for (const reading of readMatrix(store)) {
    for (const item of reading?.items ?? []) {
      const id = item.taskId;
      if (id === undefined) continue;
      if (!STATUS_TASKS.some((s) => s.id === id)) continue;
      const prev = seen.get(id);
      seen.set(id, prev === undefined ? item : pickBetter(prev, item));
    }
  }
  const out: string[] = [];
  for (const spec of STATUS_TASKS) {
    const item = seen.get(spec.id);
    if (item === undefined) continue;
    const line = describeStatus(item, spec.title);
    if (line === undefined) continue;
    out.push(spec.id === 549 && opts.backupOn === false ? `${line}（备份开关没开，开了才会有）` : line);
  }
  return out;
}
