// mcloud 插件（JS/TS 重写版）的入口。
//
// M0 阶段：先把**能在沙箱里真正跑起来并自证**的那一层做好 ——
//
//   selftest  在面板内部把密码学、SQLite、宿主 API 串一遍（≠ Node 里跑通，
//             沙箱是另一套环境：没有 TextEncoder/Buffer/crypto，BigInt 也没赌）
//   diag      每次触发记一行 lateMs —— 这是「调度精度」那条测量的原始数据，
//             也是插件自己的健康底噪
//
// 上游调用（登录、签到族 8 条任务）在 M1/M2：先有 mock 上游，再接真账号。
//
// 关于调度声明方式的取舍：这里用 `every` / `register_cron`（**插件声明**），
// 装上去任务就存在，不用手工在面板上建。想改节奏就在面板上改
// —— 面板的「覆盖层」正是为这件事设计的（`jobs.override_expr`），
// 改完不会跟插件代码打架，插件热更新也会把覆盖保留下来。

import { error, every, http_fetch, log, register_cron, register_route, warn } from 'host-api';
import { md5Hex, sha256Hex, toBase64, fromBase64, fromUtf8, utf8 } from './crypto/index.ts';
import { hostStore } from './store/host.ts';
import type { Store } from './store/types.ts';
import type { Transport } from './mcloud/client.ts';
import { SLOW_CALL_MS } from './mcloud/client.ts';
import { runTaskList } from './mcloud/tasks/taskList.ts';
import { runPrizes } from './mcloud/tasks/prizes.ts';
import { runCloudSnapshot } from './mcloud/tasks/cloudSnapshot.ts';
import { runSign } from './mcloud/tasks/sign.ts';
import { runBackupGift } from './mcloud/tasks/backupGift.ts';
import { runNotice } from './mcloud/tasks/notice.ts';
import { runAppTaskMatrix } from './mcloud/tasks/appTaskMatrix.ts';
import { runExchangeList } from './mcloud/tasks/exchangeList.ts';
import { runReceive } from './mcloud/tasks/receive.ts';
import { runMultiple } from './mcloud/tasks/multiple.ts';
import { runRevival } from './mcloud/tasks/revival.ts';
import { mcloudRoutes } from './mcloud/routes.ts';
import { loadBaseUrl, verifySession } from './mcloud/session.ts';

const store: Store = hostStore();
store.ensureSchema();

/** 插件用的 transport：宿主 API 的**同步**请求（这是沙箱里唯一的选择）。
 *
 *  ⚠️ 超时刻意取得比面板的执行预算（默认 `EXEC_BUDGET_MS=2000`）**短**。
 *
 *  原因是预算的行为不是「到点掐断」：QuickJS 的 interrupt handler 只在 JS 字节码边界
 *  被检查，所以一个阻塞中的请求会**跑完**，然后任务在那之后才被判超时 ——
 *  结果是「上游动作已经发生、任务却报失败」（同族的坑见 docs/findings.md F-001）。
 *  把超时设在预算里面，就是让它**在预算之前**干净地失败。
 *
 *  如果目标网络上到游确实更慢：把 `EXEC_BUDGET_MS` 和这个数**一起**调大 ——
 *  只调一个会退化成上面那种「动作发生了但报失败」。 */
const REQUEST_TIMEOUT_MS = 1500;

const transport: Transport = (req) =>
  // 返回值可能是 {status,headers,body}，也可能是失败形状 {"error":…} ——
  // client.ts 的 callOnce 负责认形状（实测踩过，见 docs/findings.md F-006）
  http_fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    timeout_ms: REQUEST_TIMEOUT_MS,
  });

/** 在沙箱里自证：密码学 + 编码 + SQLite 三件事都对。
 *
 *  为什么这件事必须在**面板里**做一遍，而不是只信 Node 里的测试：
 *  插件跑的是 QuickJS + PocketPy，没有 TextEncoder/Buffer/crypto。Node 里绿
 *  不代表这里绿 —— 而一旦不对，表现是「上游回一个签名错误」，在真机上排查很贵。 */
function selftest(): { ok: boolean; detail: string } {
  const checks: [string, boolean][] = [];

  // ① 公开测试向量（与 Node 那一套用同一批值）
  checks.push(['md5("abc")', md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72']);
  checks.push([
    'sha256("abc")',
    sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  ]);

  // ② UTF-8：中文与代理对（emoji）走一遍编解码
  const cn = '签到·AI豆🎉';
  checks.push(['utf8 往返（含 emoji）', fromUtf8(utf8(cn)) === cn]);

  // ③ base64 往返
  const raw = utf8('mcloud-plugin');
  checks.push(['base64 往返', fromUtf8(fromBase64(toBase64(raw))) === 'mcloud-plugin']);

  // ④ SQLite 真的能写能读（顺带验证占位符与自增主键）
  const id = store.recordRun({
    task: '__selftest__',
    runs: 0,
    scheduledAt: new Date(0).toISOString(),
    firedAt: new Date(0).toISOString(),
    lateMs: 0,
    ok: true,
    note: 'selftest',
  });
  checks.push(['sqlite 自增主键返回', id > 0]);

  const stats = store.lateStats('__selftest__', 10);
  checks.push(['sqlite 聚合查询可用', stats.n >= 1]);

  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join('、')}`,
  };
}

// ── HTTP 接口（给界面与脚本用；见 src/mcloud/routes.ts）──
//
// 路径是完整路径，方法大写 —— 面板那边按 `"{METHOD} {path}"` 建键。
for (const r of mcloudRoutes({
  store,
  transport,
  now: () => new Date().toISOString(),
  log,
  baseUrl: undefined, // 路由内部按需读 state（改了配置立刻生效）
})) {
  register_route(r.path, r.method, r.handler);
}

// ── 任务：会话体检（每天 7:50，排在 8:00 的签到流程之前）──
//
// 为什么单独一条：凭据失效是所有签到任务共同的失败原因，而它们的报错长得都一样
// （「未登录」）。在流程之前先体检一次，日志里就会**先**出现「会话可能已失效」，
// 后面那一串失败就有了单一解释 —— 排查时间从「翻一堆任务」变成「看一行」。
register_cron('session-check', '50 7 * * *', (p) => {
  const check = verifySession({
    store,
    transport,
    nowIso: new Date().toISOString(),
    baseUrl: loadBaseUrl(store),
  });
  store.recordRun({
    task: p.name,
    runs: p.runs,
    scheduledAt: p.scheduledAt,
    firedAt: p.firedAt,
    lateMs: p.lateMs,
    ok: check.ok,
    note: check.note,
  });
  if (check.ok) log(`会话体检：${check.note}`);
  else warn(`会话体检：${check.note} —— 需要用 POST /plugins/mcloud/api/session 重新导入`);
});

// ── 任务：任务清单（签到族第 1 条，纯只读）──
//
// 调度用 cron 且默认每天 8:00 —— 与 mcloud 的语义一致（「每日签到」那一天的流程）。
// 想改节奏不用改代码：面板上的「编辑」会写进 `jobs.override_expr` 覆盖层，
// 插件热更新也会把覆盖保留下来（见 §12.4 那三步收尾）。
// 想立刻跑一次就点「立即执行」。
register_cron('task-list', '0 8 * * *', (p) => {
  const t0 = Date.now();
  try {
    const out = runTaskList({
      store,
      transport,
      nowIso: new Date().toISOString(),
      // 每次调用都重新读：改了基址不用重载插件（CI 与手工联调都靠这条）
      baseUrl: loadBaseUrl(store),
    });
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: out.ok,
      note: out.note,
    });
    if (out.ok) log(`任务清单：${out.note}`);
    else warn(`任务清单失败：${out.note}`);
    const took = Date.now() - t0;
    if (took > SLOW_CALL_MS) warn(`这次调用用了 ${took}ms —— 接近执行预算，注意上游是否变慢`);
  } catch (e) {
    // runTaskList 设计上不抛；真抛了说明是插件自己的 bug，必须让它可见
    error(`任务清单抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
  }
});

// ── 签到族：剩下的四条（与上面两条同一套管道 base.ts）──
//
// 调度照 mcloud 的语义：签到流程一早在 8 点前后，查询类挪到稍晚、避免与动作抢上游。
// 每条任务的 `lateMs` 都进 payload（面板给的），底座按「catch-up / skip」语义处理。
function makeRunner(
  name: string,
  run: (deps: { store: Store; transport: Transport; nowIso: string; baseUrl: string; lateMs: number }) => { ok: boolean; note: string; skipped?: boolean },
) {
  return (p: TaskPayload) => {
    try {
      const out = run({
        store,
        transport,
        nowIso: new Date().toISOString(),
        baseUrl: loadBaseUrl(store),
        lateMs: p.lateMs,
      });
      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: out.ok,
        note: out.note,
      });
      if (out.ok) log(`${name}：${out.note}`);
      else warn(`${name} 失败：${out.note}`);
    } catch (e) {
      // 各任务设计上不抛；真抛了说明是插件自己的 bug，必须让它可见
      error(`${name} 抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** 任务 payload（面板给的形状，见 docs/host-api.md）。 */
interface TaskPayload {
  name: string;
  plugin: string;
  expr: string;
  runs: number;
  scheduledAt: string;
  firedAt: string;
  lateMs: number;
}

// 签到族挂在**白天每 15 分钟**，而不是"每天 8:05 打一枪"。三条理由：
//   ① 签到是「提交 → 回查状态」的多步流程，多步需要多次调用（一次调用一个请求的纪律）
//   ② 低配盒子不常在线：8 点整没开机，9 点上线照样补上（这就是 catch-up 的意义）
//   ③ 每一步都便宜且自带门槛：状态说不需要动作时就只是一次只读检查
// 真正"每天一次"的东西只有一个：翻倍机会，而它的门槛（curMonthBackup 两个值）
// 由插件自己判 —— 条件不成立时一个字节都不发。
const SIGNIN_CRON = '*/15 7-22 * * *';
register_cron('sign', SIGNIN_CRON, makeRunner('签到', runSign));
register_cron('receive', SIGNIN_CRON, makeRunner('领取AI豆', runReceive));
register_cron('multiple', SIGNIN_CRON, makeRunner('签到翻倍', runMultiple));
register_cron('revival', SIGNIN_CRON, makeRunner('复活卡', runRevival));
register_cron('backup-gift', SIGNIN_CRON, makeRunner('备份好礼', runBackupGift));
register_cron('notice', SIGNIN_CRON, makeRunner('开启通知领AI豆', runNotice));
// App 任务矩阵：**只读那一半**（`app-task` 写的那半会传文件且不可回滚）
register_cron('app-task-matrix', SIGNIN_CRON, makeRunner('App 任务矩阵（只看）', runAppTaskMatrix));
// 兑换清单：**只读那一半**（下单要过滑块，且真扣豆不可回滚）
register_cron('exchange-list', SIGNIN_CRON, makeRunner('兑换清单（只看）', runExchangeList));
register_cron('prizes', '20 8 * * *', makeRunner('待领取奖品', runPrizes));
register_cron('cloud-snapshot', '30 8 * * *', makeRunner('AI豆快照', runCloudSnapshot));

// ── 任务：自检（装上去先跑一次这个，确认沙箱这一层是好的）──
every('selftest', '5m', (p) => {
  try {
    const r = selftest();
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.detail,
    });
    if (r.ok) {
      log(`自检通过（${r.detail}）· lateMs=${Math.round(p.lateMs)}`);
    } else {
      error(`自检失败（${r.detail}）—— 沙箱环境与预期不符，先别接上游任务`);
    }
  } catch (e) {
    error(`自检抛异常：${e instanceof Error ? e.message : String(e)}`);
  }
});

// ── 任务：调度健康（每次触发记一行 lateMs）──
every('diag', '30s', (p) => {
  try {
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: true,
    });
    // 每 10 次报一次分布：面板的日志行数有限（环形 200 行），别刷屏
    if (p.runs % 10 === 0) {
      const s = store.lateStats(p.name, 500);
      log(
        `调度健康：n=${s.n} p50=${s.lateP50}ms p99=${s.lateP99}ms max=${s.lateMax}ms` +
          (s.excluded > 0 ? ` · 排除负延迟 ${s.excluded} 条（手动触发，见 F-001）` : '') +
          (s.lateP99 > 200 ? ' ⚠️ p99 偏高，同轮可能有慢任务' : ''),
      );
    }
  } catch (e) {
    warn(`diag 记录失败：${e instanceof Error ? e.message : String(e)}`);
  }
});

// 记一次启动，方便从表里看出「插件是什么时候被加载/热更新的」
store.setState('plugin.loaded_at', new Date().toISOString(), new Date().toISOString());
log('mcloud 插件已加载（自检 + 调度健康 + 任务清单；其余签到族任务在 M2 逐个接）');

// 供将来的路由与任务复用
export { selftest };
