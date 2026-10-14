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

import {
  error,
  every,
  http_fetch,
  log,
  register_cron,
  register_route,
  warn,
  ws_close,
  ws_open,
  ws_recv,
  ws_send,
} from 'host-api';
import { hostFetchOptions } from './mcloud/client.ts';
import { md5Hex, sha256Hex, toBase64, fromBase64, fromUtf8, utf8 } from './crypto/index.ts';
import { hostStore } from './store/host.ts';
import type { Store } from './store/types.ts';
import type { HostWs } from './mcloud/tasks/base.ts';
import type { Transport } from './mcloud/client.ts';
import { SLOW_CALL_MS, applyDefaultContentType } from './mcloud/client.ts';
import { sandboxCaps } from './mcloud/caps.ts';
import { runTaskList } from './mcloud/tasks/taskList.ts';
import { runPrizes } from './mcloud/tasks/prizes.ts';
import { runCloudSnapshot } from './mcloud/tasks/cloudSnapshot.ts';
import { runSign } from './mcloud/tasks/sign.ts';
import { runBackupGift } from './mcloud/tasks/backupGift.ts';
import { runMsgPushObtain, runMsgPushStatus } from './mcloud/tasks/msgPush.ts';
import { runAuthRefresh } from './mcloud/authRefresh.ts';
import { runExpansionStep, startExpansion } from './mcloud/tasks/taskExpansion.ts';
import { runNotice } from './mcloud/tasks/notice.ts';
import { runAppTaskMatrix } from './mcloud/tasks/appTaskMatrix.ts';
import { runAppTaskStep, startAppTask } from './mcloud/tasks/appTask.ts';
import { runExchangeList } from './mcloud/tasks/exchangeList.ts';
import { runLiveRoom } from './mcloud/tasks/liveRoom.ts';
import { runLiveGate } from './mcloud/tasks/liveGateTask.ts';
import { runLiveListen } from './mcloud/tasks/liveListen.ts';
import { runLiveDraw } from './mcloud/tasks/liveDraw.ts';
import { needExchange, runExchangeStep } from './mcloud/sessionExchange.ts';
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

const transport: Transport = (req) => {
  // ⚠ 补默认 content-type **在这一层**，不是各个构造器里 —— 与真实现同构
  // （`client.rs::default_content_type`）。散在构造器里就会漏，而漏的表现是
  // 一个**看起来像"路径不存在"**的 404（线上网关按 content-type 路由）。
  // 这一条是踩出来的，见 client.ts 的 applyDefaultContentType 与 findings F-015。
  const r = applyDefaultContentType(req);
  // 返回值可能是 {status,headers,body}，也可能是失败形状 {"error":…} ——
  // client.ts 的 callOnce 负责认形状（实测踩过，见 docs/findings.md F-006）
  //
  // ⚠ 选项组装在 `hostFetchOptions` 里（**纯函数、Node 里可测**）：那里有一条
  //   「`tls` 只对 `https:` 生效」的守卫 —— 它是本仓 e2e 能在**默认构建**的面板上跑的原因。
  return http_fetch(r.url, hostFetchOptions(r, REQUEST_TIMEOUT_MS));
};

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

  // ⑤ 沙箱能力探测（只报告、不判失败；探的每一项决定后面哪条链能做 —— 见 caps.ts）
  const caps = sandboxCaps();

  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail:
      (bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join('、')}`) +
      ` · ${caps}`,
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
  ws: {
    wsOpen: (url, opts) => ws_open(url, opts),
    wsSend: (id, text) => ws_send(id, text),
    wsRecv: (id, timeoutMs) => ws_recv(id, timeoutMs),
    wsClose: (id) => ws_close(id),
  },
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
  run: (deps: {
    store: Store;
    transport: Transport;
    host: HostWs;
    nowIso: string;
    baseUrl: string;
    lateMs: number;
  }) => { ok: boolean; note: string; skipped?: boolean },
) {
  return (p: TaskPayload) => {
    try {
      const out = run({
        store,
        transport,
        // ⚠ 这一族**只有嵌入式 JS 宿主有**；Node 适配器与 Python 侧都是"函数存在、调用时抛"
        //   （见面板 docs/host-api.md）。所以任何用到它的任务都必须能在测试里换桩。
        host: {
          wsOpen: (url, opts) => ws_open(url, opts),
          wsSend: (id, text) => ws_send(id, text),
          wsRecv: (id, timeoutMs) => ws_recv(id, timeoutMs),
          wsClose: (id) => ws_close(id),
        },
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
// 消息推送奖励：**两步**（问状态 → 领），所以两条 cron。
// ⚠ 它**不是** `notice` —— 见 tasks/msgPush.ts 文件头那张对照表。
// 凭据续期：**每天一次**（mcloud 那边是 `auth refresh --lead-days`，
// 默认提前 10 天）。它自己也带判据，所以每天跑不等于每天打上游 ——
// 离过期还远时它**一个请求都不发**。见 authRefresh.ts 文件头。
// 任务拓展：**状态机**（读 → 传文件触发备份 → 领），一次调用走一步。
// ⚠ 领那一枪是**裸 GET**（抓包 §3.6.6）；判据**严格**读到 `false` 才传文件。
register_cron('task-expansion', SIGNIN_CRON, makeRunner('任务拓展', (deps) => {
  // 没有在跑的就把这一趟起起来（起单只写字、不发请求）
  const r = deps.store.getState('mcloud.taskexpansion.state');
  if (!r) startExpansion(deps);
  return runExpansionStep(deps);
}));
register_cron('auth-refresh', '0 6 * * *', makeRunner('凭据续期', (deps) => runAuthRefresh(deps)));
register_cron('msg-push', SIGNIN_CRON, makeRunner('消息推送奖励（问状态）', runMsgPushStatus));
register_cron('msg-push-obtain', SIGNIN_CRON, makeRunner('消息推送奖励（领）', runMsgPushObtain));
register_cron('notice', SIGNIN_CRON, makeRunner('开启通知领AI豆', runNotice));
// App 任务矩阵：**只读那一半**（`app-task` 写的那半会传文件且不可回滚）
register_cron('app-task-matrix', SIGNIN_CRON, makeRunner('App 任务矩阵（只看）', runAppTaskMatrix));
// ⚠ 写的那一半 —— 与只读那半**不是同一个 code**（拿一个 code 做两件事会让它
//   在两处指不同的东西）。它消费矩阵的读数（所以矩阵得先跑过）。
//
// 一枪一步：传文件（需要时，三枪）→ `task/click`（**不可回滚**）→ 收尾（移回收站）。
// 传上去的文件**必须收尾** —— 不收，用户网盘里就会慢慢堆垃圾。
register_cron('app-task', SIGNIN_CRON, makeRunner('App 任务（做任务）', (deps) => {
  // 没有在跑的就起一趟（起单只写字、不发请求）
  if (!deps.store.getState('mcloud.apptask.state')) {
    const started = startAppTask(deps);
    if (started.idle) return started; // 没有待办 ⇒ 如实回 idle（不刷噪声）
  }
  return runAppTaskStep(deps);
}));
// 兑换清单：**只读那一半**（下单要过滑块，且真扣豆不可回滚）
register_cron('exchange-list', SIGNIN_CRON, makeRunner('兑换清单（只看）', runExchangeList));
// 直播口令：**只读那一半**（抓主页 + 列出口令；领小红花那一步是写，还没做）
//
// 它是**第一条不需要凭据的任务** —— 主页是公开 GET，与云盘账号无关。
// 两个实际好处：还没导入会话的机器上它照样有产出；凭据失效时（所有签到任务
// 共同的失败原因）它不受影响。
//
// 节奏：直播多在晚上，但口令笔记白天也可能发 ⇒ 白天每 30 分钟抓一次。
// 一次只发一个请求（面板执行预算 2000ms，见 liveRoom.ts 文件头）。
register_cron('live-room', '*/30 7-23 * * *', makeRunner('直播口令（只看）', runLiveRoom));

// 直播日程（**门**）：只读地问上游「今天开播了吗 / 下一场几点」。
//
// 为什么值得单独一条任务：口令只在**开播那一小时**有效，而人要知道的是
// 「今天几点开」—— 那是**预告场**给的，不需要开播也能读到（门的第③步是 GET）。
//
// 节奏 10 分钟，与池里那条「门关 + 10 分钟宽限才封场」的宽限**同一个量级**：
// 门是按分钟抖动的，探测比宽限还稀会让"封场"判得比实际晚一截。
//
// 一次调用**最多两发**（handshake 步 ①② / rooms 步 ③③）——
// 为什么不能拆得更细见 liveGateTask.ts 文件头（SSO token 只活几分钟）。
register_cron('live-gate', '*/10 7-23 * * *', makeRunner('直播日程（门）', runLiveGate));

// 领小红花（**写那半**）：六步链 9+N 个请求，一次调用只推进一步（面板预算 2000ms）。
//
// ⚠️ **默认关**（`mcloud.live.claim_enabled`），开关在插件界面上。
// 关着的时候这条 cron 一个请求都不发、**也不记 run** ——
// 否则"关着"会每 5 分钟往面板上刷一行，把真信息淹掉。
//
// 为什么还要 cron：手动那条路（界面按钮）是浏览器循环调 `/api/live/draw/step`，
// 每步一次调用；cron 是**没人看着时的兜底**（口令变了就自动起一轮）。
// 听弹幕口令：**每 10 秒一拍**（一拍读 ~1.6 秒）。
// ⚠ 间隔不决定"漏不漏"：宿主侧那条入队通道是**无界**的，两次调用之间服务端推的帧
//   会在宿主里排队、下一次调用一次性读出来 ⇒ 节奏影响的是"多快看到口令"。
//   门关着时它一个请求都不发（`nextCheckAtMs` 冷却），所以放着不影响别的东西。
register_cron('live-listen', '@every 10s', makeRunner('听弹幕口令', runLiveListen));
register_cron('live-draw', '*/5 7-23 * * *', (p) => {
  try {
    const out = runLiveDraw({
      store,
      transport,
      nowIso: new Date().toISOString(),
      baseUrl: loadBaseUrl(store),
      lateMs: p.lateMs,
    });
    if (out.idle) return; // 什么都没做 ⇒ 不记 run（见上）
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: out.ok,
      note: out.note,
    });
    if (out.ok) log(`领小红花：${out.note}`);
    else warn(`领小红花失败：${out.note}`);
  } catch (e) {
    error(`领小红花抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
  }
});
register_cron('prizes', '20 8 * * *', makeRunner('待领取奖品', runPrizes));
register_cron('cloud-snapshot', '30 8 * * *', makeRunner('AI豆快照', runCloudSnapshot));

// ── 任务：会话续期（H5 的 jwttoken 约 2 小时即废，自己续）──
//
// 为什么值得单独一条：手工贴的票过期时**所有任务一起**回 `90001 未登录`
// ——那个现象看起来像"账号被踢了"，而其实只是票到期。
// 有原生凭据（界面上贴一份）就自己走三步续上。
//
// 节奏是每 **2 分钟**一跳而不是每 30 分钟：三步 = 三个请求，而一次调用只发一个
// （面板预算 2000ms），所以要跳三次才走完一轮 —— 30 分钟一跳会让续票拖一个半小时。
// 票新鲜时这条 cron **不发请求、也不记 run**（见 needExchange）。
register_cron('session-refresh', '*/2 * * * *', (p) => {
  try {
    if (!needExchange(store, Date.now())) return; // idle：不发请求、不记 run
    const r = runExchangeStep({
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
      ok: r.ok,
      note: r.note,
    });
    if (r.ok) log(`换票：${r.note}`);
    else warn(`换票失败：${r.note}`);
  } catch (e) {
    error(`换票抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
  }
});

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
