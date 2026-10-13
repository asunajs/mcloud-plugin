// mock 上游：让签到族的任务能在 CI 里跑完，而**永远不碰真账号**。
//
// 三件事必须做对，否则这个 mock 只是个自我安慰：
//
//   ① **记录收到的每一个请求**（方法、路径、头、body），通过 `/_debug/requests` 读出来。
//      这样测试断言的不只是「任务返回了 ok」，而是「我们真的发对了头与签名」——
//      签名错是这条链最常见的失败，而它在真机上的表现只有一句「签名错误」。
//   ② **形状照抄实拍**：`{"code":0,"msg":"success","result":…}`（数字 code），
//      以及 result 是数组还是对象——不同端点不一样，别统一。
//   ③ 能**故意失败**：业务失败（`code!=0`）、HTTP 500、超时、非 JSON。
//      错误路径不测，等于没测——上线后遇到的第一件事就是它。
//
// 可以作为模块用（`startMock()`，给测试），也可以直接跑（`node mock/upstream.mjs`，
// 给手工联调：把插件的基址指到它就行）。

import { createServer } from 'node:http';

/** 固定的会话凭据：mock 不校验，但插件要带，测试就能断言「确实带了」。 */
export const MOCK_JWT = 'mock-jwttoken';
export const MOCK_COOKIE = 'mockcookie=1';

const json = (res, status, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8' });
  res.end(body);
};

/** 默认夹具：形状照抄 mcloud 文档里记的实拍。 */
export const FIXTURES = {
  // taskListV3 的 result 是**数组**
  taskListV3: {
    code: 0,
    msg: 'success',
    result: [
      { id: 596, name: '签到', state: 'FINISH', enable: 1, process: 0, currstep: 4 },
      { id: 597, name: '分享', state: 'UNFINISH', enable: 1, process: 0, currstep: 6 },
      { id: 598, name: '固定入口', state: 'FINISH', enable: 1, process: 0, currstep: 8 },
    ],
  },
  // taskListV2 的 result 是**以 group 为键的对象**（与 V3 形状不同，故意保留）
  taskListV2: { code: 0, msg: 'success', result: {}, groupState: {} },
  // infoV3 由状态机生成，见下面 case 分支
  infoV3: { code: 0, msg: 'success', result: {} },
  startSignIn: { code: 0, msg: 'success', result: { bean: 10 } },
  receiveV3: { code: 0, msg: 'success', result: { bean: 10 } },
  multiple: { code: 0, msg: 'success', result: { multiple: 2 } },
  receiveRevivalReward: { code: 0, msg: 'success', result: { bean: 5 } },
  cloudRecordV2: { code: 0, msg: 'success', result: [{ date: '2026-10-13', bean: 123 }] },
  prizeRecord: { code: 0, msg: 'success', result: [{ id: 1, name: 'AI豆', state: 'UNRECEIVED' }] },
  backupGiftInfo: { code: 0, msg: 'success', result: { canReceive: true } },
  backupGiftReceive: { code: 0, msg: 'success', result: {} },
};

/**
 * 起一个 mock 上游。
 * @returns {{ url: string, port: number, requests: object[], reset(): void, setBehavior(b): void, close(): Promise<void> }}
 */
export async function startMock(options = {}) {
  const requests = [];

  // ── 一个小小状态机 ──────────────────────────────────────────────────────
  //
  // 一开始这里是纯静态夹具，结果测不了**多步流程**：签到是「提交 → 回查状态」，
  // 静态夹具永远回「今天还没签」，于是回查那一步必然报失败 —— 那是 mock 的毛病，
  // 不是插件的。所以给它一点状态：动作打过来就改变后续的只读响应。
  //
  // 默认起点：今天还没签、有 2 条待领（其中 1 条是延期领取）、有翻倍机会、备份好礼可领。
  const st = {
    // 通知任务：能不能领（reward 之后翻成 false）
    noticeClaimable: true,
    todaySigned: false,
    receiveList: [{ recordId: 'r1', cloudType: 2 }, { recordId: 'r2', cloudType: 1 }],
    curMonthBackup: true,
    curMonthBackupSignAccept: false,
    backupCanReceive: true,
  };
  // behavior: 'normal' | 'biz-fail' | 'http-500' | 'not-json' | 'timeout'
  let behavior = options.behavior ?? 'normal';
  const delayMs = options.delayMs ?? 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      // `/_debug/*` 是 mock 自己的管理接口，不算"上游收到的请求" —— 记进去只会
      // 让断言里多出噪声（而且分分钟把 clear 自己也算成一次请求）
      if (!url.pathname.startsWith('/_debug/')) {
        requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      }

      if (url.pathname === '/_debug/requests') return json(res, 200, requests);
      // 清空记录：CI 里分段落断言时用（不然前面步骤发的请求也会混进来）
      if (url.pathname === '/_debug/requests/clear') {
        const n = requests.length;
        requests.length = 0;
        return json(res, 200, { cleared: n });
      }
      if (url.pathname === '/_debug/state') return json(res, 200, st);
      if (url.pathname === '/_debug/behavior') {
        if (req.method === 'POST') {
          behavior = body || 'normal';
          return json(res, 200, { behavior });
        }
        return json(res, 200, { behavior });
      }

      const finish = () => {
        if (behavior === 'http-500') return json(res, 500, { code: -1, msg: 'boom' });
        if (behavior === 'not-json') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>502 Bad Gateway</html>');
        }
        if (behavior === 'biz-fail') return json(res, 200, { code: 1001, msg: '今天已经签过了' });

        const map = {
          '/ycloud/signin/task/taskListV3': FIXTURES.taskListV3,
          '/ycloud/signin/task/taskListV2': FIXTURES.taskListV2,
          '/ycloud/signin/page/infoV3': FIXTURES.infoV3,
          '/ycloud/signin/page/startSignIn': FIXTURES.startSignIn,
          '/ycloud/signin/page/receiveV3': FIXTURES.receiveV3,
          '/ycloud/signin/page/multiple': FIXTURES.multiple,
          '/ycloud/signin/page/receiveRevivalReward': FIXTURES.receiveRevivalReward,
          '/ycloud/signin/public/cloudRecordV2': FIXTURES.cloudRecordV2,
          '/ycloud/signin/public/record': FIXTURES.prizeRecord,
          '/market/backupgift/info': FIXTURES.backupGiftInfo,
          '/market/backupgift/receive': FIXTURES.backupGiftReceive,
        };
        // ── 会改变状态的那几口 ──
        if (url.pathname === '/ycloud/openemailsms-service/openEmailsms/getTaskInfo') {
          // 四个字段名来自实拍：cloudStatus / sum / progress / taskStatus。
          // sum 与 progress 是**假数**（含义未证实，插件只原样搬运）。
          const cloud = st.noticeClaimable ? 1 : 2;
          return json(res, 200, {
            code: 0,
            msg: 'success',
            result: {
              taskOneInfo: { cloudStatus: cloud, sum: 10, progress: 16, taskStatus: 3 },
              taskTwoInfo: { cloudStatus: cloud, sum: 10, progress: 16, taskStatus: 3 },
            },
          });
        }
        if (url.pathname === '/ycloud/openemailsms-service/openEmailsms/reward') {
          st.noticeClaimable = false;
          // 实拍响应就是这个形状 —— 连 result 都没有，报不出到账数
          return json(res, 200, { code: 0, msg: 'success' });
        }
        if (url.pathname === '/ycloud/signin/task/taskListV2') {
          // 只读：按 group 给不同的矩阵。两个实拍坑都要在夹具里出现一次：
          //   · `new` 这一组回**空对象**（实拍就是 result:{}，不是 []）
          //   · 一条 `enable != 1`（旧实现的门是 enable != 1 ⇒ 跳过）
          // mock 里 `body` 是原始字符串，要自己解
          let g = 'new';
          try {
            g = JSON.parse(body || '{}').group || 'new';
          } catch {}
          if (g === 'new') {
            return json(res, 200, { code: 0, msg: 'success', result: {}, groupState: {} });
          }
          if (g === 'beiyong1') {
            return json(res, 200, {
              code: 0,
              msg: 'success',
              result: [
                { id: 106, name: '永葆童心', description: '领38云朵', groupid: 'beiyong1', state: 'FINISH', limitType: 'EVER', enable: 1, currstep: 4 },
                { id: 522, name: '备份有礼', description: '领5云朵', groupid: 'beiyong1', state: 'DOING', limitType: 'DAY', enable: 1, currstep: 2 },
              ],
              groupState: { beiyong1: { taskFinishState: 2 } },
            });
          }
          if (g === 'cloudEmail') {
            return json(res, 200, {
              code: 0,
              msg: 'success',
              result: [
                // enable != 1 ⇒ 不参与（不是"可做"）
                { id: 1021, name: '邮箱通知', groupid: 'cloudEmail', state: 'DOING', enable: 0 },
                // 驼峰 groupId（拍拍那一族的真实差异）也要认得
                { id: 2001, name: '拍拍盘点', groupId: 'cloudEmail', state: 'DOING', enable: 1 },
              ],
            });
          }
          return json(res, 200, { code: 0, msg: 'success', result: [], groupState: {} });
        }
        if (url.pathname === '/ycloud/signin/page/infoV3') {
          return json(res, 200, {
            code: 0,
            msg: 'success',
            result: {
              todaySignIn: st.todaySigned,
              cal: [{ d: 19, s: st.todaySigned, n: 3, p: 0, t: true, currentMonth: 1 }],
              receiveList: st.receiveList,
              curMonthBackup: st.curMonthBackup,
              curMonthBackupSignAccept: st.curMonthBackupSignAccept,
            },
          });
        }
        if (url.pathname === '/ycloud/signin/page/startSignIn') {
          // 上游的语义：提交之后**状态可能还没变**（真实世界里会延迟入账）。
          // 这里让它立刻变 —— 好测「回查确认」那条路径；想测"没入账"的话把
          // `st.todaySigned` 后面的赋值去掉即可。
          st.todaySigned = true;
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 10 } });
        }
        if (url.pathname === '/ycloud/signin/page/receiveV3') {
          let rid = '';
          try {
            rid = JSON.parse(body || '{}').cloudId ?? '';
          } catch {
            /* 体不是 JSON 就算了 */
          }
          st.receiveList = st.receiveList.filter((x) => x.recordId !== rid);
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 5, cloudId: rid } });
        }
        if (url.pathname === '/ycloud/signin/page/receiveTaskExpansion') {
          // 延期领取：真实客户端发的是**裸 GET**（没有 acceptDate）——
          // 这一口把 cloudType=1 的条目消化掉
          st.receiveList = st.receiveList.filter((x) => x.cloudType !== 1);
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 3 } });
        }
        if (url.pathname === '/ycloud/signin/page/multiple') {
          st.curMonthBackupSignAccept = true; // 每月只用一次
          return json(res, 200, { code: 0, msg: 'success', result: { multiple: 2 } });
        }
        if (url.pathname === '/market/backupgift/receive') {
          st.backupCanReceive = false;
          return json(res, 200, { code: 0, msg: 'success', result: {} });
        }

        const hit = map[url.pathname];
        if (!hit) return json(res, 404, { code: -1, msg: `mock 没有这个端点：${url.pathname}` });
        if (url.pathname === '/market/backupgift/info') {
          return json(res, 200, { code: 0, msg: 'success', result: { canReceive: st.backupCanReceive } });
        }
        return json(res, 200, hit);
      };

      if (behavior === 'timeout' || delayMs > 0) {
        setTimeout(finish, behavior === 'timeout' ? 60_000 : delayMs);
      } else {
        finish();
      }
    });
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    /** 收到的请求（按时间顺序） */
    get requests() {
      return requests;
    },
    headerOf(pathSuffix, name) {
      const r = requests.find((x) => x.path?.endsWith(pathSuffix));
      return r ? (r.headers[String(name).toLowerCase()] ?? undefined) : undefined;
    },
    reset() {
      requests.length = 0;
    },
    setBehavior(b, ms = 0) {
      behavior = b;
      if (ms) options.delayMs = ms;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 直接运行：给手工联调用，把插件的基址指到 http://127.0.0.1:<port>
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: Number(process.argv[2] ?? 18080) });
  console.log(`mock 上游已起：${m.url}`);
  console.log(`  · 收到的请求：${m.url}/_debug/requests`);
  console.log(`  · 切换行为：  curl -X POST -d 'biz-fail' ${m.url}/_debug/behavior`);
  console.log(`    （normal / biz-fail / http-500 / not-json / timeout）`);
}
