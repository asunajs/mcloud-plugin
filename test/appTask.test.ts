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
  activeAppTaskFileId,
  appTaskFresh,
  clickRequest,
  makePdf,
  pendingItems,
  runAppTaskStep,
  startAppTask,
  trashRequest,
} from '../src/mcloud/tasks/appTask.ts';
import { MATRIX_MARKETS, matrixKey } from '../src/mcloud/tasks/appTaskMatrix.ts';
import { STATE_MONTH_BACKUP } from '../src/mcloud/tasks/taskExpansion.ts';
import {
  ownedFileIds,
  registerOwnedFile,
} from '../src/mcloud/tasks/ownedFiles.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import { desEncryptBase64 } from '../src/crypto/des.ts';

const NOW = '2026-10-14T01:00:00.000Z';

/** 推进一步，并把 `visit`（记访问日志 —— "我点了哪条任务"）那一枪带过。
 *  它是打卡的**前置**，测试关心的是"点了没点"，所以默认带过。 */
function step(deps: TaskDeps): { ok?: boolean; idle?: boolean; note: string } {
  const parse = (): { phase?: string; itemId?: number } =>
    JSON.parse(deps.store.getState(STATE_TASK) ?? '{}') as { phase?: string; itemId?: number };
  const before = parse().itemId;
  const r = runAppTaskStep(deps);
  // 老流程是 `visit` → `click`：同一条要**再推一步**才真的点到。
  // 现在是先 click：点完已经换到下一条（itemId 变了），不能再替下一条点一枪。
  if (parse().phase === 'click' && parse().itemId === before) return runAppTaskStep(deps);
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
  // 107 / 1004 要 authToken / phone；`pc:13800138000:tok` 的 base64
  store.setState('mcloud.h5.auth', 'Basic cGM6MTM4MDAxMzgwMDA6dG9r', NOW);
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
    if (req.url.includes('file/create')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { fileId: 'F1', rapidUpload: true, exist: false } }) };
    if (req.url.includes('getOutLink')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: '0', data: { getOutLinkRes: { getOutLinkResSet: [{ linkID: 'L1' }] } } }),
      };
    }
    if (req.url.includes('delOutLink')) return { status: 200, headers: {}, body: JSON.stringify({ code: '0' }) };
    if (req.url.includes('querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { token: 'S' } }) };
    }
    if (req.url.includes('inlogin.action')) {
      return { status: 200, headers: {}, body: JSON.stringify({ var: { sid: 's', rmkey: 'r' } }) };
    }
    if (req.url.includes('disk:getDirectorys')) {
      return { status: 200, headers: {}, body: '<string name="directoryId">D</string>' };
    }
    if (req.url.includes('SearchByFidOrCondition')) {
      return { status: 200, headers: {}, body: '<string name="mid">M</string>' };
    }
    if (req.url.includes('mobilebill.html')) return { status: 200, headers: {}, body: '<html></html>' };
    if (req.url.includes('mbox:searchMessages')) {
      return { status: 200, headers: {}, body: '<string name="mid">M</string>' };
    }
    if (req.url.includes('mbox:updateMessagesStatus')) return { status: 200, headers: {}, body: '{}' };
    if (req.url.includes('view:readMessage')) return { status: 200, headers: {}, body: '<html></html>' };
    if (req.url.includes('mailReportToMQ')) return { status: 200, headers: {}, body: JSON.stringify({ code: 'S_OK' }) };
    if (req.url.includes('logBehaviorAction')) return { status: 200, headers: {}, body: 'ok' };
    if (req.url.includes('convertPdfFromYunFile')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 'S_OK' }) };
    }
    if (req.url.includes('disk:backupMail')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 'S_OK' }) };
    }
    if (req.url.includes('disk:queryUserToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          var: { data: { data: { account: desEncryptBase64('13800138000', '139_mail'), token: 'T', userDomainId: 'D' } } },
        }),
      };
    }
    if (req.url.includes('getUserTaskAndCloudStatusExternal')) {
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { taskStatus: 1, cloudStatus: 0 } }) };
    }
    if (req.url.includes('authTokenRefresh.do')) {
      return { status: 200, headers: {}, body: JSON.stringify({ headers: { app_auth: 'A' } }) };
    }
    if (req.url.includes('createNote.do')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
    if (req.url.includes('moveToRecycleBin.do')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
    if (req.url.includes('autologin.action')) return { status: 200, headers: {}, body: '{}' };
    if (req.url.includes('taskClickV2')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
    if (req.url.includes('mbox:getComposeId')) return { status: 200, headers: {}, body: JSON.stringify({ var: 'C' }) };
    if (req.url.includes('mbox:compose')) return { status: 200, headers: {}, body: JSON.stringify({ code: 'S_OK' }) };
    if (req.url.includes('aiRecognize')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { fileId: 'F', taskId: '7' } }) };
    }
    if (req.url.includes('assistant/chat/v2/add')) {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"data":{"flowResult":{"outContent":"hi"}}}\n\n',
      };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: {} }) };
  }) as never;
  return { deps: { store, transport, nowIso: NOW, baseUrl: undefined, settleMs: 0, gapMs: [0, 0] } as TaskDeps, sent, store };
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

test('跨天的 done 不算今天起过（否则上传任务会被永远跳过）', () => {
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'WAIT', enable: 1, groupId: 'day', name: '手动上传一个文件' }],
  });
  deps.store.setState(
    STATE_TASK,
    JSON.stringify({ gi: 0, ii: 0, phase: 'done', itemId: 106, clicked: [], day: '2026-10-13' }),
    NOW,
  );
  assert.equal(appTaskFresh(deps), false);
  const out = startAppTask(deps);
  assert.equal(out.idle, undefined, '旧状态必须能重新起一趟');
  assert.equal(appTaskFresh(deps), true);
  const st = JSON.parse(deps.store.getState(STATE_TASK) ?? '{}') as { day?: string };
  assert.equal(st.day, NOW.slice(0, 10));
});

test('月门：本月备份确认没开且 <20 号 ⇒ 跳过 month 任务；true/没读到不跳', () => {
  const mk = (backup: boolean | undefined) => {
    const { deps, store } = mkDeps({
      [MATRIX_MARKETS[0]!]: [
        { taskId: 1017, state: 'UNFINISH', enable: 1, groupId: 'month', name: '月任务' },
      ],
    });
    if (backup !== undefined) {
      store.setState(STATE_MONTH_BACKUP, JSON.stringify({ month: NOW.slice(0, 7), backup }), NOW);
    }
    return deps;
  };
  assert.equal(pendingItems(mk(false)).length, 0, '确认没开 ⇒ 跳过');
  assert.equal(pendingItems(mk(true)).length, 1, '已开 ⇒ 不跳');
  assert.equal(pendingItems(mk(undefined)).length, 1, '不知道 ⇒ 不跳');
});

test('409 固定入口：两发上报 + 补一发 task2', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 409, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '从固定入口访问云朵中心' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 12; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('doTaskPost')), '新路径上报');
  assert.ok(urls.some((u) => u.includes('/market/signin/page/doTask')), '旧路径上报');
  assert.ok(
    sent.some((r) => r.url.includes('task/click') && r.url.includes('key=task2')),
    '补打卡要 task2',
  );
});

test('1005 已经走起来（currstep=1）：不再打默认 key，只补 task2', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 1005, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '从固定入口进入云朵中心', currStep: 1 },
    ],
  });
  startAppTask(deps);
  for (let i = 0; i < 12; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const clicks = sent.filter((r) => r.url.includes('task/click'));
  assert.equal(clicks.length, 1, '只发补的那一发');
  assert.ok(clicks[0]!.url.includes('key=task2'));
});

test('1017 入口页：取 button.email.link，再用 task2 补一发', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      {
        taskId: 1017,
        state: 'UNFINISH',
        enable: 1,
        groupId: 'g1',
        name: '登录移动云盘云朵中心',
        buttonEmailLink: 'https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&token=#ssoToken#',
      },
    ],
  });
  startAppTask(deps);
  for (let i = 0; i < 15; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('/portal/mobilecloud/index.html')), '要取入口页');
  assert.ok(
    sent.some((r) => r.url.includes('task/click') && r.url.includes('key=task2')),
    '1017 补打卡要 task2',
  );
});

test('609 AI 助手：换票 → 登录 → 派生鉴权 → 状态 → SSE 对话', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 609, state: 'UNFINISH', enable: 1, groupId: 'time', name: '和AI助手对话' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 25; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('queryUserToken')), '派生 AI 鉴权');
  assert.ok(urls.some((u) => u.includes('getUserTaskAndCloudStatusExternal')), '状态查询');
  assert.ok(urls.some((u) => u.includes('assistant/chat/v2/add')), 'SSE 对话');
});

test('107 云笔记：鉴权 → 建 → 删', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 107, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '创建云笔记' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 20; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('authTokenRefresh.do')));
  assert.ok(urls.some((u) => u.includes('createNote.do')));
  assert.ok(urls.some((u) => u.includes('moveToRecycleBin.do')));
});

test('472 邮箱活跃：autologin + 市场打卡', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 472, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '体验 139 邮箱' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 20; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('autologin.action')));
  assert.ok(urls.some((u) => u.includes('taskClickV2')));
});

test('1004 发邮件：composeId → compose → **PE 活跃上报** → 打卡', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1004, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '给好友发邮件' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 20; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('mbox:getComposeId')));
  assert.ok(urls.some((u) => u.includes('mbox:compose')));
  // ⚠ PE 活跃上报（`eventType=3`）：少了这一枪，1004 在真机上一直停在第 1 步。
  assert.ok(urls.some((u) => u.includes('logreport/s?func=user:activeAction')), '要有 PE 上报');
  // 打卡打的是**已知能用**的那一口（`taskClickV2` 已经 404/405 死了）
  const clicks = urls.filter((u) => u.includes('/ycloud/signin/task/click') && u.includes('id=1004'));
  assert.equal(clicks.length, 1, `同一趟只许打一发 id=1004 的 task/click（实际 ${clicks.length} 发）`);
  assert.equal(urls.some((u) => u.includes('taskClickV2')), false, 'taskClickV2 已经死了，别再打');
});

test('585 AI 相机：识图 → 对话', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 585, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '体验AI相机' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 25; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('aiRecognize')));
  assert.ok(urls.some((u) => u.includes('assistant/chat/v2/add')));
});

test('1014 PDF 转换：传 PDF → convertPdfFromYunFile', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1014, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '体验PDF转换' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 30; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  assert.ok(sent.some((r) => r.url.includes('convertPdfFromYunFile')));
});

test('1029 我的账单：页 → 找 mid → 标读 → 读信 → 3 发 MQ → 像素', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1029, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '查看我的账单' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 30; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('mobilebill.html')));
  assert.ok(urls.some((u) => u.includes('mbox:searchMessages')));
  assert.equal(sent.filter((r) => r.url.includes('mailReportToMQ')).length, 3);
  assert.ok(urls.some((u) => u.includes('logBehaviorAction')));
});

test('1028 AI 工作台：派生鉴权 → 对话', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1028, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '体验AI工作台' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 25; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('queryUserToken')));
  assert.ok(urls.some((u) => u.includes('assistant/chat/v2/add')));
});

test('434 分享：建外链后立刻删（不空发）', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '分享文件领好礼' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 30; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  assert.ok(sent.some((r) => r.url.includes('getOutLink')), '要建外链');
  assert.ok(sent.some((r) => r.url.includes('delOutLink')), '建完要删');
});

test('1020 邮件转存：换票 → 登录 → 目录 → 找邮件 → 转存', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1020, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '重要邮件存储云盘' }],
  });
  startAppTask(deps);
  for (let i = 0; i < 20; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const urls = sent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('querySpecTokenV2')), '换 SSO token');
  assert.ok(urls.some((u) => u.includes('inlogin.action')), '邮箱登录');
  assert.ok(urls.some((u) => u.includes('disk:getDirectorys')), '云盘目录');
  assert.ok(urls.some((u) => u.includes('SearchByFidOrCondition')), '邮件列表');
  assert.ok(urls.some((u) => u.includes('disk:backupMail')), '转存');
});

test('没有待办时要说清“还有几条没搬”，且“刻意不做”的不算', () => {
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 999, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '未知任务' },
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

test('走完一条带收尾的（需要传文件的那条）：**点 → 传 → 收尾**（参考实现 106 的顺序）', () => {
  const { deps, sent, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  startAppTask(deps);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'click');
  const r1 = runAppTaskStep(deps); // 先打卡
  assert.equal(r1.ok, true, r1.note);
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'upload', '打完卡才传文件');
  const clickAt = sent.findIndex((r) => r.url.includes('task/click'));
  const r2 = runAppTaskStep(deps); // 传（秒传 ⇒ 一枪就完）
  assert.equal(r2.ok, true, r2.note);
  const createAt = sent.findIndex((r) => r.url.includes('file/create'));
  assert.ok(clickAt >= 0 && createAt > clickAt, '所有任务都先 click，再上传');
  assert.equal((JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase, 'trash', '传完直接收尾，不能再点一次');
  const r3 = runAppTaskStep(deps); // 收尾
  assert.equal(r3.ok, true, r3.note);
  assert.match(r3.note, /回收站/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 1);
  assert.deepEqual(JSON.parse(sent.at(-1)!.body!), { fileIds: ['F1'] }, '收尾带的就是刚传上去的那个 id');
});

test('上传族 currStep != 0：按参考实现不打卡（106 走起来后不再点）', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 106, state: 'WAIT', enable: 1, groupId: 'day', name: '手动上传一个文件', currStep: 1 },
    ],
  });
  startAppTask(deps);
  for (let i = 0; i < 10; i++) {
    const r = runAppTaskStep(deps);
    if (r.idle) break;
  }
  assert.equal(clicks(sent), 0, 'currStep=1 的上传任务按 should_click 不该打卡');
  assert.equal(sent.filter((r) => r.url.includes('file/create')).length, 1, '但文件还要照传');
});

test('⚠ 点过的名单**按天重置**（矩阵读数是慢的，同一份读数会被反复消费）', () => {
  const { deps, store, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' }],
  });
  startAppTask(deps);
  step(deps);
  assert.equal(clicks(sent), 1);
  // ⚠ 读数没刷新（还是 todo）⇒ 上一发**没有服务端确认**，不能被当成"今天做完了"。
  //   本地动作不是成功，下一趟必须能重试。
  const out2 = startAppTask(deps);
  assert.notEqual(out2.idle, true, `未确认的任务必须能重试：${out2.note}`);
  step(deps);
  runAppTaskStep(deps); // settle：用新矩阵复查（测试 settleMs=0）
  assert.equal(clicks(sent), 2, '未确认的任务要能重试');
  const after = JSON.parse(store.getState(STATE_TASK)!) as {
    clicked: number[];
    unconfirmed: number[];
  };
  assert.equal(after.clicked.includes(115), false, '服务端没确认，不能留在成功名单');
  assert.ok(after.unconfirmed.includes(115), '要记成未确认，留给下一趟重试');
  // 换一天 ⇒ 昨天那份状态不再影响今天（每日任务的有效期）
  const nextDay = { ...deps, nowIso: '2026-10-15T01:00:00.000Z' } as TaskDeps;
  const st = JSON.parse(store.getState(STATE_TASK) ?? '{}') as Record<string, unknown>;
  store.setState(STATE_TASK, JSON.stringify({ ...st, day: '2026-10-14' }), NOW);
  const out3 = startAppTask(nextDay);
  assert.equal(out3.idle, undefined, `换一天该能再做：${out3.note}`);
  step(nextDay);
  assert.equal(clicks(sent), 3, '换一天就该能再做');
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
  // 只有 106（上传）与 115（click-only）该做 —— 其余五条"未实现"。
  // ⚠ 顺序是 **taskId 升序**（参考实现 `app_task.rs` 的 `merge_pages` 排序），
  //   不是上游返回的原序 —— 以前这里按原序取了 115，现在 106 在前。
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [106, 115]);
  const out = startAppTask(deps);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /从 #106 开始/, `实际：${out.note}`);
  runAppTaskStep(deps);
  assert.equal(clicks(sent), 1, '只点 115 那一发');
  assert.equal(sent.filter((r) => /id=(548|549|550|551|607)/.test(r.url)).length, 0, '⚠ 那五条一个都不许碰');
});

test('动作和复查之间必须有间隔：settle 前不拿旧矩阵判成功/失败', () => {
  const { deps: base, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 115, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '点一下' }],
  });
  let t = Date.parse(NOW);
  let spins = 0;
  const deps = {
    ...base,
    settleMs: 5000,
    nowMs: () => t,
    spin: () => {
      spins += 1;
      t += 1000;
    },
  } as TaskDeps;
  startAppTask(deps);
  step(deps);
  const phase = (): string => (JSON.parse(store.getState(STATE_TASK)!) as { phase: string }).phase;
  assert.equal(phase(), 'settle', '动作完必须先进入 settle');
  const out = runAppTaskStep(deps);
  assert.ok(spins >= 5, `必须等满 5 秒再复查（实际 spin ${spins} 次）`);
  assert.equal(phase(), 'done', '等完才复查并收摊');
  assert.match(out.note, /复查完成/);
  assert.notEqual(out.ok, false, '等待本身不能报失败');
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
  // ⚠ 不重新 start：那会先把未确认的 115 剔掉再从 115 起；这里要验的是
  //   已经在 431 上、收摊时回头报 115 的那一步。
  // ⚠ 辅助 `step()` 已经把 `visit` + `click` 一起做掉了，而"点了没生效"的警告
  //   就在**点完换下一条**那一步报出来 ⇒ 结论看**这一下**，不用再推一步。
  step(deps);
  // 动作完先进入 settle；**等复查那一步**才拿新矩阵判"没生效"。
  const r = runAppTaskStep(deps);
  assert.equal(r.ok, false, `有"点了没生效"的 ⇒ 不能报成 ok：${r.note}`);
  assert.match(r.note, /本机动过|点了但状态没变/);
  assert.match(r.note, /#115/);
});

// ───────────────────────── 收尾的两条漏（PDF / 分享） ─────────────────────────

test('PDF 转换完**不能直接换下一条**：先收尾，再 advance', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 1014, state: 'UNFINISH', enable: 1, groupId: 'g1', name: 'PDF 转换' }],
  });
  registerOwnedFile(deps, 'FPDF');
  deps.store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'pdfConvert',
      itemId: 1014,
      fileId: 'FPDF',
      fileOwned: true,
      clicked: [1014],
      data: { pdfTs: '1700000000000', sid: 's', rmkey: 'r' },
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  const r1 = runAppTaskStep(deps);
  assert.match(r1.note, /下一步收尾/);
  assert.equal(
    (JSON.parse(deps.store.getState(STATE_TASK)!) as { phase: string }).phase,
    'trash',
    '转换完必须进收尾，不能把 fileId 丢掉',
  );
  const r2 = runAppTaskStep(deps);
  assert.match(r2.note, /回收站/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 1);
  assert.deepEqual(JSON.parse(sent.at(-1)!.body!), { fileIds: ['FPDF'] });
  assert.deepEqual(ownedFileIds(deps), [], '收尾成功后要注销');
});

test('分享：删完外链再收尾；判不了归属的文件绝不删', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '分享' }],
  });
  registerOwnedFile(deps, 'FSHARE');
  deps.store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'shareDel',
      itemId: 434,
      fileId: 'FSHARE',
      fileOwned: true,
      clicked: [434],
      data: { linkIds: '["L1"]' },
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  const r1 = runAppTaskStep(deps);
  assert.match(r1.note, /下一步收尾/);
  assert.equal((JSON.parse(deps.store.getState(STATE_TASK)!) as { phase: string }).phase, 'trash');
  const r2 = runAppTaskStep(deps);
  assert.match(r2.note, /回收站/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 1);
  assert.deepEqual(ownedFileIds(deps), []);

  // 不是我们造的（撞同名）⇒ 只删外链，不发 batchTrash
  const other = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '分享' }],
  });
  other.deps.store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'shareDel',
      itemId: 434,
      fileId: 'FUSER',
      fileOwned: false,
      clicked: [434],
      data: { linkIds: '["L1"]' },
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  const r3 = runAppTaskStep(other.deps);
  assert.match(r3.note, /外链已删/);
  assert.equal(other.sent.filter((r) => r.url.includes('batchTrash')).length, 0, '❌ 不能删用户的文件');
});

test('收尾阶段：fileOwned === false ⇒ 一枪 batchTrash 都不发', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '上传文件' }],
  });
  deps.store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'trash',
      itemId: 106,
      fileId: 'FUSER',
      fileOwned: false,
      clicked: [434],
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  const out = runAppTaskStep(deps);
  assert.equal(out.ok, true, out.note);
  assert.match(out.note, /不是我们造的/);
  assert.equal(sent.filter((r) => r.url.includes('batchTrash')).length, 0);
});

test('链尾清理要跳过“今天还在任务里用”的文件', () => {
  const { deps, store } = mkDeps({});
  const put = (st: Record<string, unknown>) =>
    store.setState(STATE_TASK, JSON.stringify({ gi: 0, ii: 0, itemId: 106, clicked: [], ...st }), NOW);

  put({ phase: 'trash', fileId: 'F1', fileOwned: true, day: NOW.slice(0, 10) });
  assert.equal(activeAppTaskFileId(deps), 'F1');
  put({ phase: 'share', fileId: 'F1', fileOwned: true, day: NOW.slice(0, 10) });
  assert.equal(activeAppTaskFileId(deps), 'F1');
  // 收摊/跨天/不是我们造的 ⇒ 不该再占着
  put({ phase: 'done', fileId: 'F1', fileOwned: true, day: NOW.slice(0, 10) });
  assert.equal(activeAppTaskFileId(deps), undefined);
  put({ phase: 'trash', fileId: 'F1', fileOwned: true, day: '2026-10-22' });
  assert.equal(activeAppTaskFileId(deps), undefined);
  put({ phase: 'trash', fileId: 'F-USER', fileOwned: false, day: NOW.slice(0, 10) });
  assert.equal(activeAppTaskFileId(deps), undefined);
});

// ── 逐条隔离（2026-11-01 现场：三账号全停在 #609，「已完成 0 条」） ──
//
// 参考实现（`mcloud/crates/mcloud-tasks/src/app_task.rs` 的逐条循环）**从不因为
// 某一条没成而中止整趟** —— 打卡失败 / runner 失败都只是 `continue` 下一条，
// 整趟只有"取消"才停。我们原先是 `return {ok:false}` ⇒ `drain` 当场停 ⇒
// 第 10 步那条 AI 对话一没回话，后面 10 条永远轮不到。

/** 让某个 URL 片段挂掉（其余照旧走 mkDeps 的 mock）。 */
function failOn(deps: TaskDeps, match: string): TaskDeps {
  const orig = deps.transport;
  (deps as unknown as { transport: typeof orig }).transport = (req) =>
    req.url.includes(match) ? { error: 'mock 让它挂' } : orig(req);
  return deps;
}

test('⚠ 某一条没成**不拖垮整趟**：AI 对话没回话只记一笔，接着做下一条', () => {
  const { deps, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 609, state: 'UNFINISH', enable: 1, groupId: 'time', name: '和AI助手对话' },
      { taskId: 547, state: 'UNFINISH', enable: 1, groupId: 'time', name: '加入一个知识库' },
    ],
  });
  // 直接停在「AI 对话」这一步（前面几步的登录/鉴权不在这一条要钉的范围里）
  store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'aiChat',
      itemId: 609,
      special: 'aiAssistant',
      data: { auth: 'Basic x', domain: 'D' },
      clicked: [609],
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  failOn(deps, 'chat/v2/add');
  const out = runAppTaskStep(deps);
  assert.equal(out.ok, true, '⚠ 以前这里回 false ⇒ drain 当场停，后面每条都没机会做');
  assert.match(out.note, /没取到输出/);
  assert.match(out.note, /下一条 #547/, '这一条记下之后就换下一条');
});

test('⚠ 某一条的鉴权失败只跳过这一条（`failed` 记原因，不拖垮整趟）', () => {
  const { deps, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 1020, state: 'UNFINISH', enable: 1, groupId: 'month', name: '完成一次邮件转存' },
      { taskId: 547, state: 'UNFINISH', enable: 1, groupId: 'time', name: '加入一个知识库' },
    ],
  });
  store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'mailLogin',
      itemId: 1020,
      special: 'mailBackup',
      data: {},
      clicked: [],
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  failOn(deps, 'querySpecToken');
  const out = runAppTaskStep(deps);
  assert.equal(out.ok, true, '鉴权失败是"这一条没成"，不是"整趟别做了"');
  assert.match(out.note, /邮箱 SSO token/);
  assert.match(out.note, /继续下一条/);
  assert.match(out.note, /下一条 #547/);
  const st = JSON.parse(store.getState(STATE_TASK)!) as { failed?: { id: number; why: string }[] };
  assert.deepEqual((st.failed ?? []).map((f) => f.id), [1020], '原因要留下（收尾如实报）');
});

test('⚠ 这一趟失败过的那几条**不回头再撞**（同一天、同一趟）', () => {
  // ⚠ 失败那条必须是**最小的 id**（409 < 547）：不然 `advance` 里就算不滤掉 `failed`，
  //   按 id 升序也会先挑到 547 —— 那种用例恒过，抓不住任何东西（评审 2026-11-01）。
  const { deps, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 409, state: 'UNFINISH', enable: 1, groupId: 'month', name: '体验云盘小程序' },
      { taskId: 547, state: 'UNFINISH', enable: 1, groupId: 'time', name: '加入一个知识库' },
    ],
  });
  store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'mailLogin',
      itemId: 409,
      special: 'mailBackup',
      data: {},
      clicked: [],
      failed: [],
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  failOn(deps, 'querySpecToken');
  runAppTaskStep(deps); // 409 挂 ⇒ failed=[409]，换到 547（**不许**再挑回 409）
  const st = JSON.parse(store.getState(STATE_TASK)!) as { itemId: number };
  assert.equal(st.itemId, 547);
});

test('逐条台账：434 必须排在**最后**（它只消费"这一趟传上去的文件"）', () => {
  // 参考实现 `app_task.rs:1727-1731`：计划按 taskId 升序，然后把 434 挪到末尾。
  // 434 的 id 比 522/106 都小 —— 不挪的话它永远排在"传文件"前面 ⇒ 手里空着 ⇒
  // 每次都「没有可分享的文件，跳过分享任务」。
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 434, state: 'WAIT', enable: 1, groupId: 'month', name: '分享文件领好礼' },
      { taskId: 522, state: 'WAIT', enable: 1, groupId: 'time', name: '当月上传文件满100个' },
      { taskId: 106, state: 'WAIT', enable: 1, groupId: 'day', name: '手动上传一个文件' },
    ],
  });
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [106, 522, 434], '106 → 522 → **434 垫底**');
});

test('同一个 taskId 在两个市场各出现一次 ⇒ 待办里只算一条（重影会骗人）', () => {
  // 现场：522 在 sign_in_3 与 newsign_139mail 都有。打卡那一枪只带 `id`、不带市场，
  // 点一次两处都算 ⇒ 列表里留一条就够，否则"待办 17 条"里有一条是影子。
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 522, state: 'WAIT', enable: 1, groupId: 'time', name: '当月上传文件满100个' }],
    [MATRIX_MARKETS[1]!]: [{ taskId: 522, state: 'WAIT', enable: 1, groupId: 'time', name: '当月上传文件满100个' }],
  });
  assert.deepEqual(pendingItems(deps).map((p) => p.itemId), [522]);
});

test('⚠ 要邮箱会话的 runner 一律**先登录**（否则带空 sid 出去）', () => {
  // 现场 2026-11-01 自测：`advance` 换条目时 `data` 会丢，直接进 `sendMailAction`
  // / `pdfUpload`/`billViewAction` 的话带出去的是**空 sid** —— 1004 回
  // `FA_INVALID_PARAMETER`、1014 回 `FA_INVALID_SESSION User Session Expired`。
  const { deps, store } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 1004, state: 'WAIT', enable: 1, groupId: 'month', name: '给好友发邮件' },
      { taskId: 1014, state: 'WAIT', enable: 1, groupId: 'month', name: '体验PDF转换' },
      { taskId: 1020, state: 'WAIT', enable: 1, groupId: 'month', name: '完成一次邮件转存' },
      { taskId: 1029, state: 'WAIT', enable: 1, groupId: 'month', name: '查看我的账单' },
    ],
  });
  for (const id of [1004, 1014, 1020, 1029]) {
    store.setState(
      STATE_TASK,
      JSON.stringify({
        gi: 0,
        ii: 0,
        phase: 'click',
        itemId: id,
        special: id === 1004 ? 'sendMail' : id === 1014 ? 'pdfConvert' : id === 1020 ? 'mailBackup' : 'billView',
        data: { marketName: 'sign_in_3', link: '' },
        clicked: [],
        day: NOW.slice(0, 10),
      }),
      NOW,
    );
    const out = runAppTaskStep(deps); // 打卡那一发
    const st = JSON.parse(store.getState(STATE_TASK)!) as { phase?: string };
    assert.equal(st.phase, 'mailLogin', `#${id} 打完卡必须先去登邮箱（实际 ${String(st.phase)}）`);
    assert.match(out.note, /mailLogin|邮箱|登录/);
  }
});

test('113 使用PC客户端：上传按 **PC 档**发头（不是把安卓档换个渠道号）', () => {
  // 参考实现 `app_task.rs` 为 113 单开 `UPLOAD_ONE_PC`，头画像整组不同：
  // 少 `x-huawei-channelSrc` / `x-yun-sub-op-type`，多 `x-yun-market-source` /
  // `x-yun-module-type` / `x-yun-svc-type`，client-info 也换成 PC 那串。
  // 拿安卓档去传，上游当我们是手机 ⇒ 这条永远 WAIT。
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 113, state: 'WAIT', enable: 1, groupId: 'month', name: '使用PC客户端' },
    ],
  });
  startAppTask(deps);
  for (let i = 0; i < 12; i++) {
    const out = runAppTaskStep(deps);
    if (out.idle) break;
  }
  const create = sent.find((r) => r.url.includes('file/create'));
  assert.ok(create !== undefined, '要真发 create');
  assert.equal(create.headers['x-yun-app-channel'], '10200153', 'PC 渠道号');
  assert.equal(create.headers['x-yun-market-source'], '001');
  assert.equal(create.headers['x-yun-module-type'], '100');
  assert.equal(create.headers['x-yun-svc-type'], '1');
  assert.match(create.headers['x-yun-client-info'] ?? '', /\|PC\|/, 'PC 的 client-info');
  assert.equal(create.headers['x-huawei-channelSrc'], undefined, 'PC 档没有这一枚');
  assert.equal(create.headers['x-yun-sub-op-type'], undefined, 'PC 档没有这一枚');
  // 106（普通上传）仍走安卓档 —— 别一刀切
  const { deps: d2, sent: s2 } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 106, state: 'WAIT', enable: 1, groupId: 'day', name: '手动上传一个文件' }],
  });
  startAppTask(d2);
  for (let i = 0; i < 12; i++) {
    const out = runAppTaskStep(d2);
    if (out.idle) break;
  }
  const c2 = s2.find((r) => r.url.includes('file/create'));
  assert.ok(c2 !== undefined);
  assert.notEqual(c2.headers['x-yun-app-channel'], '10200153', '106 还是安卓档');
  assert.ok(c2.headers['x-yun-sub-op-type'] !== undefined, '安卓档有 sub-op-type');
});

test('分享建链失败 / 没 linkID：仍要收尾（文件不许留在网盘）', () => {
  // 评审 2026-11-01：这条支路原来没用例 —— 建链失败就 advance，`trash` 永远不跑。
  const { deps, store, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'month', name: '分享文件领好礼' }],
  });
  store.setState(
    STATE_TASK,
    JSON.stringify({
      gi: 0,
      ii: 0,
      phase: 'share',
      itemId: 434,
      special: 'share',
      fileId: 'F1',
      fileOwned: true,
      clicked: [434],
      failed: [],
      day: NOW.slice(0, 10),
    }),
    NOW,
  );
  failOn(deps, 'getOutLink');
  let sawTrash = false;
  for (let i = 0; i < 8; i++) {
    const r = runAppTaskStep(deps);
    if (sent.some((x) => x.url.includes('batchTrash'))) sawTrash = true;
    if (r.idle) break;
  }
  assert.equal(sawTrash, true, '建链挂了也必须把文件收尾（batchTrash 要发出去）');
  const st = JSON.parse(store.getState(STATE_TASK) ?? '{}') as { fileId?: string };
  assert.equal(st.fileId, undefined, '收尾之后不许还留着 fileId');
});

test('`currstep != 0` 的条目：**不打卡**，收尾后也不再被挑回来（1014 那次 60 步死循环）', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [
      { taskId: 1014, state: 'UNFINISH', enable: 1, groupId: 'time', name: '体验PDF转换', currStep: 1 },
    ],
  });
  startAppTask(deps);
  for (let i = 0; i < 25; i++) {
    const r = runAppTaskStep(deps);
    if (r.idle) break;
  }
  assert.equal(
    sent.filter((x) => x.url.includes('task/click') && x.url.includes('id=1014')).length,
    0,
    'currstep=1 的条目按参考实现不打卡',
  );
  // 收尾之后不许再挑回同一条（旧 bug：收完尾 advance 又选它，60 步循环）
  assert.equal(
    sent.filter((x) => x.url.includes('convertPdfFromYunFile')).length,
    1,
    '转换只许发一次',
  );
});

test('1014 的 PDF：240×240 小页 + **xref 偏移真的对**（转换后端是 AI，按面积算量）', () => {
  // `makePdf` 是纯函数，直接验字节；上传那段由 1014 那条 e2e 用例覆盖。
  const pdf = makePdf(1793600000000);
  assert.ok(pdf.startsWith('%PDF-1.4'), pdf.slice(0, 20));
  assert.match(pdf, /\/MediaBox \[0 0 240 240\]/, '页面要小（612×792 → 240×240，面积 1/8.4）');
  assert.ok(Buffer.byteLength(pdf, 'utf8') < 700, `别又涨回去：${Buffer.byteLength(pdf, 'utf8')} 字节`);
  const at = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)?.[1]);
  assert.equal(pdf.slice(at, at + 4), 'xref', 'startxref 没指向 xref 表');
  // `xref` / `0 6` / 第一条 free 记录 / 5 条对象记录 ⇒ 对象从第 3 行起
  const table = pdf.slice(pdf.indexOf('xref\n0 6\n')).split('\n').slice(3, 8);
  table.forEach((line, idx) => {
    const off = Number(line.slice(0, 10));
    assert.match(pdf.slice(off, off + 12), new RegExp(`^${idx + 1} 0 obj`), `obj${idx + 1} 的偏移不对`);
  });
  // 内容流里的字还是那句（转换那边认的是"一页有字"）
  assert.match(pdf, /\(asign pdf 1793600000000\) Tj/);
});

test('434 分享：建外链失败**不能静默**（要记进 failed，复查点名）', () => {
  // 现场问题（2026-11-02）：建链失败只写一句 note 就 `ok: true`，
  // 于是日志看着像"分享过了"，云朵没涨，而复查那句话里一个字都不提。
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '分享文件领好礼' }],
  });
  // `getOutLink` 那一枪直接 500（模拟"建链挂了"），其余照旧
  const inner = deps.transport as unknown as (r: BuiltRequest) => unknown;
  (deps as { transport: unknown }).transport = (r: BuiltRequest) =>
    r.url.includes('getOutLink') ? { status: 500, headers: {}, body: 'boom' } : inner(r);
  startAppTask(deps);
  const notes: string[] = [];
  for (let i = 0; i < 30; i++) {
    const out = runAppTaskStep(deps);
    notes.push(out.note);
    if (out.idle) break;
  }
  const all = notes.join('\n');
  assert.match(all, /分享 #434 没成：建外链失败/, `失败要说出原因：${all.slice(-300)}`);
  // 复查那一步要**点名**（只有矩阵回 FINISH 才算成功）
  assert.match(all, /没做成（#434 建外链失败/, `复查要带上这条：${all.slice(-400)}`);
  // 而且这一趟要如实报"没成"（`ok:false`），别只是 note
  const settle = notes.find((n) => n.includes('复查完成')) ?? '';
  assert.ok(settle !== '', '要有复查那一步');
});

test('434 分享：链内两处动作之间不是 0ms（传完→建链、建链→删链）', () => {
  const t = { ms: Date.parse(NOW) };
  const { deps } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 434, state: 'UNFINISH', enable: 1, groupId: 'g1', name: '分享文件领好礼' }],
  });
  // 换成带假钟的 deps：`spin` 推进时间，间隔才看得见
  const clocked = { ...deps, nowMs: () => t.ms, spin: () => void (t.ms += 100), gapMs: [500, 2000] } as TaskDeps;
  startAppTask(clocked);
  const hits: Array<{ at: number; url: string }> = [];
  const tr = clocked.transport as unknown as (r: BuiltRequest) => unknown;
  (clocked as { transport: unknown }).transport = (r: BuiltRequest) => {
    if (/getOutLink|delOutLink|file\/create|upload|complete/i.test(r.url)) hits.push({ at: t.ms, url: r.url });
    return tr(r);
  };
  for (let i = 0; i < 40; i++) {
    const out = runAppTaskStep(clocked);
    if (out.idle) break;
  }
  const at = (re: RegExp) => hits.filter((h) => re.test(h.url)).map((h) => h.at);
  const created = at(/file\/create/);
  const outlink = at(/getOutLink/);
  const del = at(/delOutLink/);
  assert.ok(outlink.length > 0 && del.length > 0, '这一趟要走到建链与删链');
  assert.ok(outlink[0]! - created[created.length - 1]! >= 500, '传完到建链之间要隔 ≥500ms');
  assert.ok(del[0]! - outlink[0]! >= 500, '建链到删链之间要隔 ≥500ms');
});

// ── 619：两轮打卡（2026-11-14 实拍，见 appTaskRules.ts 的 ENTRY_TWICE_TASK_IDS） ──

test('619 两轮打卡：doTaskPost→key=task、doTaskPost→key=task2，且不发 market/signin/page/doTask', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 619, state: 'WAIT', enable: 1, groupId: 'month', name: '从“我的”入口访问云朵中心' }],
  });
  startAppTask(deps);
  // 推进到 entryTwice 阶段并跑完（click-first → 那次 click 会进特殊阶段）
  let guard = 0;
  while (guard < 12) {
    const st = JSON.parse(deps.store.getState(STATE_TASK) ?? '{}') as { phase?: string };
    if (st.phase === 'done') break;
    step(deps);
    guard += 1;
    if (st.phase === 'entryTwice') break;
  }
  // 再推一步执行 entryTwice 本体
  runAppTaskStep(deps);

  const urls = sent.map((r) => r.url);
  const clicks = urls.filter((u) => u.includes('/ycloud/signin/task/click'));
  // ⚠ `key=task` **只发一次**：两轮里自带，标准流程那一发不再重复（不可回滚的东西不重发）
  assert.equal(
    clicks.filter((u) => u.includes('key=task&id=619')).length,
    1,
    `key=task 恰好一次：${clicks.join(' | ')}`,
  );
  assert.ok(
    clicks.some((u) => u.includes('key=task2&id=619')),
    `要发 key=task2：${clicks.join(' | ')}`,
  );
  assert.ok(
    !urls.some((u) => u.includes('/market/signin/page/doTask')),
    `不许再发旧入口页那一发：${urls.filter((u) => u.includes('doTask')).join(' | ')}`,
  );
  // 两发 doTaskPost（每轮一发）
  assert.equal(
    urls.filter((u) => u.includes('/ycloud/signin/page/doTaskPost')).length,
    2,
    '每轮各一发 doTaskPost',
  );
});

test('409 仍然走原来那套入口（含 page/doTask），619 的改法不外溢', () => {
  const { deps, sent } = mkDeps({
    [MATRIX_MARKETS[0]!]: [{ taskId: 409, state: 'WAIT', enable: 1, groupId: 'month', name: '云朵中心入口' }],
  });
  startAppTask(deps);
  let guard = 0;
  while (guard < 12) {
    const st = JSON.parse(deps.store.getState(STATE_TASK) ?? '{}') as { phase?: string };
    if (st.phase === 'done' || st.phase === 'entry') break;
    step(deps);
    guard += 1;
  }
  runAppTaskStep(deps);
  const urls = sent.map((r) => r.url);
  // ⚠ 409 老流程里**本来就有** `key=task`（那是"先打卡"那一发），
  //   两者真正的区别是入口页那一发：409 发 `market/signin/page/doTask`，619 不发。
  assert.ok(
    urls.some((u) => u.includes('/market/signin/page/doTask')),
    `409 还是老那套（含旧入口页那一发）：${urls.join(' | ')}`,
  );
  assert.ok(
    urls.some((u) => u.includes('key=task2&id=409')),
    `409 收尾那一发照旧：${urls.filter((u) => u.includes('click')).join(' | ')}`,
  );
});
