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
import { MATRIX_GROUPS, matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';

const NOW = '2026-10-14T01:00:00.000Z';

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
    [MATRIX_GROUPS[0]!]: [
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
    [MATRIX_GROUPS[0]!]: [
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
  assert.match(out.note, /没有待办/);
  assert.equal(sent.length, 0);
});

test('打卡那一枪的形状：**GET**、主机**带端口**、`key=task&id=`', () => {
  const { deps } = mkDeps({});
  const req = clickRequest(deps, 115);
  assert.equal(req.method, 'GET');
  assert.equal(CLICK_HOST, 'https://caiyun.feixin.10086.cn:7071');
  assert.ok(req.url.startsWith(`${CLICK_HOST}${CLICK_PATH}`));
  assert.ok(req.url.includes('key=task'), '实拍逐字 key=task');
  assert.ok(req.url.includes('id=115'));
  assert.ok(req.url.includes('?'), '它是 GET **却是写** —— 参数在查询串上');
});

test('⚠ 同一轮**不重发**打卡（不可回滚的东西不能"当没发过"）', () => {
  const { deps, sent, store } = mkDeps({
    [MATRIX_GROUPS[0]!]: [{ taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' }],
  });
  startAppTask(deps);
  const r1 = runAppTaskStep(deps); // 打卡
  assert.equal(r1.ok, true, r1.note);
  assert.equal(sent.length, 1);
  // 手工把游标退回 click（模拟"又轮到这条"）
  const st = JSON.parse(store.getState(STATE_TASK)!) as Record<string, unknown>;
  store.setState(STATE_TASK, JSON.stringify({ ...st, phase: 'click' }), NOW);
  const r2 = runAppTaskStep(deps);
  assert.equal(r2.ok, true);
  assert.match(r2.note, /已经点过/);
  assert.equal(sent.length, 1, '⚠ 不许再发一枪');
});

test('⚠ 收尾**不许发空 `fileIds`**', () => {
  const { deps, sent } = mkDeps({});
  const req = trashRequest(deps, []);
  assert.equal(JSON.parse(req.body!).fileIds.length, 0, '这个构造器本身不管挡');
  // 但状态机必须挡住：没有 fileId 就不发那一枪
  const { deps: d2, sent: s2 } = mkDeps({
    [MATRIX_GROUPS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  d2.store.setState(
    STATE_TASK,
    JSON.stringify({ gi: 0, ii: 0, phase: 'trash', itemId: 106, clicked: [] }),
    NOW,
  );
  const out = runAppTaskStep(d2);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /不发空数组/);
  assert.equal(s2.filter((r) => r.url.includes('batchTrash')).length, 0, '⚠ 一枪都不发');
  void sent;
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
    [MATRIX_GROUPS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  startAppTask(deps);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'upload');
  const r1 = runAppTaskStep(deps); // 传（秒传 ⇒ 一枪就完）
  assert.equal(r1.ok, true, r1.note);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'click', '传完自动推进');
  const r2 = runAppTaskStep(deps); // 点
  assert.equal(r2.ok, true, r2.note);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'trash', '有 fileId ⇒ 要收尾');
  const r3 = runAppTaskStep(deps); // 收尾
  assert.equal(r3.ok, true, r3.note);
  assert.match(r3.note, /回收站/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 1);
  assert.deepEqual(JSON.parse(sent.at(-1)!.body!), { fileIds: ['F1'] }, '收尾带的就是刚传上去的那个 id');
});
