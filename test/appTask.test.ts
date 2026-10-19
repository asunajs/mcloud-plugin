// `app-task` 的动作层 —— 这一层真正要钉的是**三条不该发的边界**：
//   ① `task/click` 不可回滚 ⇒ 同一轮**不重发**
//   ② `batchTrash` **不许发空 `fileIds`**（mcloud 专门记过：忘了挡的表现是发一枪
//      `{"fileIds":[]}`，而上游回什么**没有样本**）
//   ③ 判据说"不做"的（`SKIP_TASK_LIST`）**一枪都不发**

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_TRASH_URL,
  CLICK_HOST,
  CLICK_PATH,
  STATE_TASK,
  clickRequest,
  pendingItems,
  runAppTaskStep,
  startAppTask,
  trashRequest,
} from '../src/mcloud/tasks/appTask.ts';
import { MATRIX_MARKETS, matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-14T01:00:00.000Z';

/** 推进一步，并把 `visit`（记访问日志 —— "我点了哪条任务"）那一枪带过。
 *  它是打卡的**前置**，测试关心的是"点了没点"，所以默认带过。 */
function step(deps: TaskDeps): { ok?: boolean; idle?: boolean; note: string } {
  const phase = (): string =>
    (JSON.parse(deps.store.getState(STATE_TASK) ?? '{}') as { phase?: string }).phase ?? '';
  const r = runAppTaskStep(deps);
  // ⚠ `phase` 的语义是"**下一步**要做什么"。做完 `visit` 之后它变成 `click`
  //   ⇒ 想真的点到，得**再推一步**（这正是我第一版辅助写错的地方：等 `visit` 就永远不点）。
  if (phase() === 'click') return runAppTaskStep(deps);
  return r;
}
/** 打卡那一枪发了几次（别数总数 —— visit 也是请求）。 */
function clicks(sent: BuiltRequest[]): number {
  return sent.filter((r) => r.url.includes('task/click')).length;
}

/** 造一份矩阵读数（写进 store，供动作层消费）。 */
function mkDeps(groups: Record<string, unknown[]>) {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  for (const [g, items] of Object.entries(groups)) {
    store.setState(
      matrixKey(g),
      JSON.stringify({ group: g, at: NOW, done: 0, todo: items.length, skip: 0, todoNames: [], items }),
      NOW,
    );
  }
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    if (req.url.includes('task/click')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
    if (req.url.includes('batchTrash')) return { status: 200, headers: {}, body: JSON.stringify({ code: '0000', success: true }) };
    if (req.url.includes('file/create')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { fileId: 'F1', rapidUpload: true } }) };
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: {} }) };
  }) as never;
  return { deps: { store, transport, nowIso: NOW, baseUrl: undefined } as TaskDeps, sent, store };
}

test('待办：只挑 `todo`，**"不做"名单里的不发**', () => {
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' },
      { taskId: 117, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '在不做名单里' },
      { taskId: 106, state: 'FINISH', enable: 1, groupId: 'g1', name: '已做完' },
      { taskId: 999, state: 'UNFINISH', enable: 0, groupId: 'g1', name: '门没开' },
    ],
  });
  const pend = pendingItems(deps);
  assert.equal(pend.length, 1, '只有 115 该做');
  assert.equal(pend[0]!.itemId, 115);
  assert.equal(pend[0]!.needUpload, false, '115 是"只点一下"那一类');
});

test('待办：需要传文件的那些被认出来（106 / 113 / beiyong1 两道门）', () => {
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' },
      { taskId: 113, state: 'UNFINISH', enable: 1, groupId: 'g1', name: 'PC 客户端' },
      { taskId: 615, state: 'UNFINISH', enable: 1, groupId: 'beiyong1', name: '记录国庆节欢乐瞬间', buttonAppLink: 'x?action=uploadView' },
      { taskId: 116, state: 'UNFINISH', enable: 1, groupId: 'beiyong1', name: '上传照片' },
    ],
  });
  const by = Object.fromEntries(pendingItems(deps).map((p) => [p.itemId, p.needUpload]));
  assert.equal(by[106], true);
  assert.equal(by[113], true);
  assert.equal(by[615], true, '⚠ 615 全靠**按钮门** —— 名字里既没"上传"也没"图/照"');
  assert.equal(by[116], true, '名字门命中');
});

test('起一趟**一个请求都不发**；没有待办 ⇒ idle', () => {
  const { deps, sent } = mkDeps({});
  const out = startAppTask(deps);
  assert.equal(out.idle, true);
  assert.match(out.note, /没有能替你做的了/);
  assert.equal(sent.length, 0);
});

test('没有待办时要说清“还有几条没搬”，且“刻意不做”的不算', () => {
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 107, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '创建云笔记' },
      { taskId: 117, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '刻意不做' },
    ],
  });
  const out = startAppTask(deps);
  assert.equal(out.idle, true);
  assert.match(out.note, /另有 1 条还没搬/, '117 在 SKIP_TASK_LIST 里，不该算“没搬”');
  assert.match(out.note, /App 里手动做/);
});

test('打卡那一枪的形状：**GET**、主机**带端口**、`key=task&id=`', () => {
  const { deps } = mkDeps({});
  const req = clickRequest(deps, 115);
  assert.equal(req.method, 'GET');
  // ⚠ 正确的主机是 **`m.mcloud.139.com`**（与矩阵同一个域）。
  //   我一开始抄成了 `caiyun.feixin.10086.cn:7071` —— 那是**「开启通知」那条链**的口
  //   （`app_notice.rs`）。两处**路径字面相同**，所以"看着抄对了"而主机不同。
  assert.equal(CLICK_HOST, 'https://m.mcloud.139.com');
  assert.notEqual(CLICK_HOST, 'https://caiyun.feixin.10086.cn:7071', '那是通知那条链的口');
  assert.ok(req.url.startsWith(`${CLICK_HOST}${CLICK_PATH}`));
  assert.ok(req.url.includes('key=task'), '实拍逐字 key=task');
  assert.ok(req.url.includes('id=115'));
  assert.ok(req.url.includes('?'), '它是 GET **却是写** —— 参数在查询串上');
});

test('⚠ 同一轮**不重发**打卡（不可回滚的东西不能"当没发过"）', () => {
  const { deps, sent, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' },
      { taskId: 431, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '再点一下' },
    ],
  });
  startAppTask(deps);
  const r1 = step(deps); // 记日志 + 点第一条
  assert.equal(r1.ok, true, r1.note);
  assert.equal(clicks(sent), 1);
  assert.match(r1.note, /下一条 #431/, '⚠ 点完必须**换下一条**（原地打转是真机上的 bug）');
  // 手工把游标退回第一条（模拟"读数没刷新，又轮到它"）
  const st = JSON.parse(store.getState(STATE_TASK)!) as Record<string, unknown>;
  store.setState(STATE_TASK, JSON.stringify({ ...st, itemId: 115, phase: 'click' }), NOW);
  const r2 = step(deps);
  assert.equal(r2.ok, true);
  assert.match(r2.note, /已经点过/);
  assert.equal(clicks(sent), 1, '⚠ 不许再发一枪');
  assert.match(r2.note, /下一条 #431/, '换到下一条，不原地打转');
});

test('⚠ 收尾**不许发空 `fileIds`**', () => {
  const { deps, sent } = mkDeps({});
  const req = trashRequest(deps, []);
  assert.equal(JSON.parse(req.body!).fileIds.length, 0, '这个构造器本身不管挡');
  // 但状态机必须挡住：没有 fileId 就不发那一枪
  const { deps: d2, sent: s2 } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  d2.store.setState(
    STATE_TASK,
    JSON.stringify({ gi: 0, ii: 0, phase: 'trash', itemId: 106, clicked: [], day: NOW.slice(0, 10) }),
    NOW,
  );
  const out = runAppTaskStep(d2);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /不发空数组/);
  assert.equal(s2.filter((r) => r.url.includes('batchTrash')).length, 0, '⚠ 一枪都不发');
  void sent;
  void pendingItems;
});

test('收尾那一枪：体是 `{fileIds:[…]}`，信封是**字符串 code + success**', () => {
  const { deps } = mkDeps({});
  const req = trashRequest(deps, ['F1']);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, BATCH_TRASH_URL);
  assert.deepEqual(JSON.parse(req.body!), { fileIds: ['F1'] });
});

test('走完一条带收尾的（需要传文件的那条）：传 → 点 → 收尾', () => {
  const { deps, sent, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  startAppTask(deps);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'upload');
  const r1 = runAppTaskStep(deps); // 传（秒传 ⇒ 一枪就完）
  assert.equal(r1.ok, true, r1.note);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'visit', '传完先记访问日志');
  const r2 = step(deps); // 记日志 + 点
  assert.equal(r2.ok, true, r2.note);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'trash', '有 fileId ⇒ 要收尾');
  const r3 = runAppTaskStep(deps); // 收尾
  assert.equal(r3.ok, true, r3.note);
  assert.match(r3.note, /回收站/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 1);
  assert.deepEqual(JSON.parse(sent.at(-1)!.body!), { fileIds: ['F1'] }, '收尾带的就是刚传上去的那个 id');
});

test('⚠ 点过的名单**按天重置**（矩阵读数是慢的，同一份读数会被反复消费）', () => {
  const { deps, store, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' }],
  });
  startAppTask(deps);
  step(deps);
  assert.equal(clicks(sent), 1);
  // 读数没刷新（还是 todo）⇒ 再跑也不会重复点
  startAppTask(deps); // ⚠ 起新一趟**不能**把今天的名单抹掉
  const out2 = startAppTask(deps);
  assert.equal(out2.idle, true, out2.note);
  assert.match(out2.note, /今天这 \d+ 条都点过了/);
  assert.equal(clicks(sent), 1, '同一天不许重复点');
  // 换一天 ⇒ 名单清掉（但读数还是 todo ⇒ 会再点一次，这是**期望**的：
  //   那天的新读数本来就该让它再做一遍）
  const nextDay = { ...deps, nowIso: '2026-10-15T01:00:00.000Z' } as TaskDeps;
  const st = JSON.parse(store.getState(STATE_TASK) ?? '{}') as Record<string, unknown>;
  store.setState(STATE_TASK, JSON.stringify({ ...st, day: '2026-10-14' }), NOW);
  const out3 = startAppTask(nextDay);
  assert.equal(out3.idle, undefined, `换一天该能再做：${out3.note}`);
  step(nextDay);
  assert.equal(clicks(sent), 2, '换一天就该能再做');
});

test('⚠ **只做"知道该做什么"的那些**（mcloud 账本里"未实现"的一律不动）', () => {
  // 真机读数（2026-10-14）：548/549/550/607 在 mcloud 的 `docs/app-task-status.md` 里
  // **全是"未实现"** ⇒ 点了四枪全回 HTTP 200、状态一条没变。
  // mcloud 的口径是**逐条实拍**：只有真知道"这条要做什么动作"的才动手。
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 548, state: 'WAIT', enable: 1, groupId: 'time', name: '开启备份领好礼' },
      { taskId: 549, state: 'WAIT', enable: 1, groupId: 'time', name: '开启备份领好礼' },
      { taskId: 550, state: 'WAIT', enable: 1, groupId: 'time', name: '开启云盘APP通知领好礼' },
      { taskId: 551, state: 'WAIT', enable: 1, groupId: 'time', name: '连续31天开启云盘APP通知' },
      { taskId: 607, state: 'WAIT', enable: 1, groupId: 'month', name: '下月签到领惊喜福利' },
      { taskId: 115, state: 'WAIT', enable: 1, groupId: 'day', name: '点一下' },
      { taskId: 106, state: 'WAIT', enable: 1, groupId: 'day', name: '手动上传一个文件' },
    ],
  });
  // 只有 115（click-only）与 106（上传）该做 —— 其余五条"未实现"
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [115, 106]);
  const out = startAppTask(deps);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /从 #115 开始/, `实际：${out.note}`);
  step(deps);
  assert.equal(clicks(sent), 1, '只点 115 那一发');
  assert.equal(sent.filter((r) => /id=(548|549|550|551|607)/.test(r.url)).length, 0, '⚠ 那五条一个都不许碰');
});

test('⚠ **判据是状态变了，不是 HTTP 200** —— 点了没生效要如实报出来', () => {
  // 115 记成"今天已点过"、再加 431 ⇒ 这一趟走 431，收摊时回头报 115（状态没变）
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 115, state: 'WAIT', enable: 1, groupId: 'day', name: '点一下' },
      { taskId: 431, state: 'WAIT', enable: 1, groupId: 'day', name: '再点一下' },
    ],
  });
  deps.store.setState(
    STATE_TASK,
    JSON.stringify({ gi: 0, ii: 0, phase: 'visit', itemId: 431, clicked: [115], day: NOW.slice(0, 10) }),
    NOW,
  );
  startAppTask(deps);
  // ⚠ 辅助 `step()` 已经把 `visit` + `click` 一起做掉了，而"点了没生效"的警告
  //   就在**点完换下一条**那一步报出来 ⇒ 结论看**这一下**，不用再推一步。
  const r = step(deps);
  assert.equal(r.ok, false, `有"点了没生效"的 ⇒ 不能报成 ok：${r.note}`);
  assert.match(r.note, /点了但状态没变/);
  assert.match(r.note, /#115/);
});
