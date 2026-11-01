// 任务拓展 —— 读状态 → （严格读到 false 才）传文件+快照触发备份 → 清理 → **复查**。
//
// 四条边界是这一族真正的重点：
//   ① 严格判据：`curMonthBackup === false` 才传（`undefined` 不算 —— 否则上游一改字段
//      就会**白发一堆上传**）
//   ② 「已完成」的判据是**复查读到备份已开启**，不是"步骤走完了"：
//      现场 2026-11-01 三个号都是快照被上游打回 `04000003`、而状态照样写 `done`
//      ⇒ 数据页显示「本月备份：未开启（任务拓展：已完成）」（自相矛盾）。
//   ③ **任务隔离**：上传那台状态机按任务分槽，App 任务传完的文件不能被当成
//      任务拓展传完了（反之亦然）—— 否则"到底是谁传的、传完没有"判不出来。
//   ④ **账号隔离**：A 的完成标记不能挡 B，也不能被 B 读到。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_EXPAND,
  STATE_UPLOAD_EXPANSION,
  activeExpansionFileId,
  parseExpand,
  runExpansionStep,
  shouldUpload,
  startExpansion,
} from '../src/mcloud/tasks/taskExpansion.ts';
import { STATE_UPLOAD } from '../src/mcloud/tasks/upload.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import type { Store } from '../src/store/types.ts';

const NOW = '2026-10-14T01:00:00.000Z';

/** 一个路由体，或者"按调用次序依次给"的一串体（最后一发会一直重复）。 */
type RouteBody = unknown | unknown[];

interface MkOpts {
  /** 缺省 0：测试不真等（生产缺省 5 秒，见 taskExpansion.ts 的 BACKUP_WAIT_MS）。 */
  settleMs?: number;
  lateMs?: number;
  nowMs?: () => number;
  spin?: () => void;
}

function mkDeps(routes: Record<string, RouteBody>, opts: MkOpts = {}) {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  const sent: BuiltRequest[] = [];
  const hits: Record<string, number> = {};
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    for (const [frag, body] of Object.entries(routes)) {
      if (!req.url.includes(frag)) continue;
      let one = body;
      if (Array.isArray(body)) {
        const i = Math.min(hits[frag] ?? 0, body.length - 1);
        hits[frag] = i + 1;
        one = body[i];
      }
      return { status: 200, headers: {}, body: JSON.stringify(one) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: {} }) };
  }) as never;
  const deps = {
    store,
    transport,
    nowIso: NOW,
    baseUrl: undefined,
    settleMs: opts.settleMs ?? 0,
    lateMs: opts.lateMs,
    nowMs: opts.nowMs,
    spin: opts.spin,
  } as TaskDeps;
  return { deps, sent, store, hits };
}

const expandState = (store: Store): { step: string; [k: string]: unknown } =>
  JSON.parse(store.getState(STATE_EXPAND)!) as { step: string };

/** 一次把状态机推到**终局**（done/blocked/unknown），返回那一步的结果。
 *
 *  ⚠ 判"停"看的是**状态**，不是返回值：快照失败那一步回 ok:true（只是记下了原因），
 *  真正下结论的是链尾那一步（cleanup）。看错就会把"还没下结论"当成"已经没成"。 */
function drainTo(deps: TaskDeps, n = 14): { note: string; ok: boolean } {
  let last = { note: '', ok: true };
  for (let i = 0; i < n; i += 1) {
    last = runExpansionStep(deps);
    const st = expandState(deps.store);
    if (st.step === 'done' || st.step === 'blocked' || st.step === 'unknown') break;
    if (!last.ok) break;
  }
  return { note: last.note, ok: last.ok };
}

const OK_ROUTES = (): Record<string, RouteBody> => ({
  taskExpansion: { code: 0, result: { curMonthBackup: false, curMonthTaskRecordCount: 0 } },
  'hcy/file/create': {
    code: 0,
    data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s.example/k', rapidUpload: false, exist: false },
  },
  'hcy/file/complete': { code: 0 },
  'backup/createSnapshot': {
    code: '0000',
    data: { fileId: 'S', uploadId: 'SU', partInfos: [{ uploadUrl: 'https://s.example/snap' }], rapidUpload: false },
  },
  'backup/completeSnapshot': { code: '0000', data: null },
  'recyclebin/batchTrash': { code: '0000', success: true },
});

test('⚠ 严格判据：只有**读到 false** 才去传（`undefined` 不算）', () => {
  assert.equal(shouldUpload({ curMonthBackup: false }), true);
  assert.equal(shouldUpload({ curMonthBackup: true }), false);
  assert.equal(shouldUpload({ curMonthBackup: undefined }), false, '没读到 ≠ 未开启备份');
  assert.equal(shouldUpload({}), false);
});

test('解析：字段缺就是 undefined（**不猜**）', () => {
  const r = parseExpand({ curMonthBackup: true, curMonthTaskRecordCount: 2, nextMonthTaskRecordCount: 5 });
  assert.equal(r.curMonthBackup, true);
  assert.equal(r.curMonthTaskRecordCount, 2);
  assert.equal(r.nextMonthTaskRecordCount, 5);
  assert.equal(r.acceptDate, undefined, '实拍里没有 acceptDate —— 别编一个');
  assert.deepEqual(parseExpand({}), parseExpand({}), '空对象两边一样（用 deepEqual，不是引用比较）');
  assert.equal(parseExpand(null).curMonthBackup, undefined);
});

test('起一趟**一个请求都不发**', () => {
  const { deps, sent } = mkDeps({});
  assert.equal(startExpansion(deps).ok, true);
  assert.equal(sent.length, 0);
});

test('⚠ 当天 done 不重跑；跨天必须重新起（不能永久 done）', () => {
  const { deps, store } = mkDeps({});
  // ⚠ 真·完成要带 `backupOn: true` —— 只有 step=done 的那种是旧版本留下的谎（见下面那条）。
  store.setState(STATE_EXPAND, JSON.stringify({ step: 'done', day: NOW.slice(0, 10), backupOn: true }), NOW);
  const same = startExpansion(deps);
  assert.equal(same.idle, true);
  assert.equal(expandState(store).step, 'done');
  const nextDay = { ...deps, nowIso: '2026-10-15T01:00:00.000Z' } as TaskDeps;
  const next = startExpansion(nextDay);
  assert.notEqual(next.idle, true);
  assert.equal(expandState(store).step, 'read');
});

test('⚠ 备份已开（`true`）⇒ 不传文件、不建快照，直接清理收尾', () => {
  const { deps, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 1 } },
  });
  startExpansion(deps);
  const r1 = runExpansionStep(deps);
  assert.equal(r1.ok, true, r1.note);
  assert.doesNotMatch(r1.note, /传一个文件/);
  assert.equal(sent.length, 1);
  assert.equal(expandState(deps.store).step, 'cleanup');
  const r2 = runExpansionStep(deps);
  assert.equal(r2.ok, true, r2.note);
  assert.equal(expandState(deps.store).step, 'done');
  assert.equal(sent.filter((x) => x.url.includes('receiveTaskExpansion')).length, 0, '不再领云朵');
});

test('⚠ 未开启备份（false）⇒ 上传三枪 + 快照三枪 + 清理；复查读到 true 才叫 done', () => {
  const routes = OK_ROUTES();
  // 第一次读 false（要凑）→ 第二次读 true（凑成了）。
  routes['taskExpansion'] = [
    { code: 0, result: { curMonthBackup: false, curMonthTaskRecordCount: 0 } },
    { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 0 } },
  ];
  const { deps, sent, store } = mkDeps(routes);
  startExpansion(deps);
  const r1 = runExpansionStep(deps); // ① 读 → 起上传
  assert.match(r1.note, /未开启备份/);
  assert.ok(store.getState(STATE_UPLOAD_EXPANSION), '上传那台状态机被起了（**任务拓展自己的槽位**）');
  assert.equal(store.getState(STATE_UPLOAD), null, '不许占 App 任务那一格');
  const last = drainTo(deps);
  assert.equal(last.ok, true, last.note);
  assert.equal(expandState(store).step, 'done');
  assert.equal(sent.length, 9, '读 / 建 / 传 / 确认 / 快照建 / 快照传 / 快照确认 / 复查 / 清理 —— 九枪');
  assert.equal(sent.filter((x) => x.url.includes('receiveTaskExpansion')).length, 0, '不再领云朵');
  assert.ok(sent.some((x) => x.url.includes('backup/createSnapshot')), '要建快照');
  assert.ok(sent.some((x) => x.url.includes('recyclebin/batchTrash')), '要清理自己传的文件');
});

test('⚠ 快照被上游打回（04000003）⇒ **不是 done**，更不许说已完成', () => {
  const routes = OK_ROUTES();
  routes['backup/createSnapshot'] = { code: '04000003' };
  const { deps, store } = mkDeps(routes);
  startExpansion(deps);
  const last = drainTo(deps);
  assert.equal(last.ok, false, '没成就是没成 —— 要进运行记录的"没成"那一栏');
  assert.equal(expandState(store).step, 'blocked');
  const st = JSON.parse(store.getState(STATE_EXPAND)!) as { blockedWhy?: string };
  assert.match(String(st.blockedWhy), /04000003/, '原因里要带上游那个编号');
  assert.match(String(st.blockedWhy), /未开启/, '还要说清是"备份仍未开启"');
  assert.equal(store.getState(STATE_UPLOAD_EXPANSION) !== null, true, '文件传过（自己那格）');
});

test('⚠ 撞上用户已有同名文件（exist:true）⇒ 不建快照、不清理；备份仍 false ⇒ 没成', () => {
  const { deps, sent, store } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: false } },
    'hcy/file/create': {
      code: 0,
      data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s.example/k', rapidUpload: false, exist: true },
    },
  });
  startExpansion(deps);
  const out = drainTo(deps); // 读 → 建（exist:true）→ 等 → 复查 → 清理（跳过）→ 下结论
  assert.equal(out.ok, false, out.note);
  assert.equal(expandState(store).step, 'blocked', '备份没开 ⇒ 不是完成');
  assert.equal(sent.filter((x) => x.url.includes('backup/createSnapshot')).length, 0, '不是我们的文件，不建快照');
  assert.equal(sent.filter((x) => x.url.includes('batchTrash')).length, 0, '不是我们的文件，绝不删');
});

test('读那一步没读到 `curMonthBackup` ⇒ 一枪不发、结论是"判不了"', () => {
  const { deps, store } = mkDeps({ taskExpansion: { code: 500 } });
  startExpansion(deps);
  const r = runExpansionStep(deps);
  assert.equal(r.ok, true, r.note);
  assert.equal(expandState(store).step, 'cleanup');
  const out = runExpansionStep(deps);
  assert.equal(out.ok, false, '没读到就不能说完成');
  assert.equal(expandState(store).step, 'unknown');
});

test('⏳ 快照确认之后先"等一会儿"再复查（上游记账不是同一瞬间）', () => {
  let t = Date.parse(NOW);
  const routes = OK_ROUTES();
  routes['taskExpansion'] = [
    { code: 0, result: { curMonthBackup: false } },
    { code: 0, result: { curMonthBackup: true } },
  ];
  const { deps, store } = mkDeps(routes, {
    settleMs: 5000,
    nowMs: () => t,
    spin: () => {
      t += 100;
    },
  });
  startExpansion(deps);
  runExpansionStep(deps); // read → upload
  for (let i = 0; i < 6; i += 1) runExpansionStep(deps); // 上传三枪 + 快照三枪
  assert.equal(expandState(store).step, 'wait', '快照成了 ⇒ 进"等一会儿"那一档');
  const out = runExpansionStep(deps); // 真等（假时钟按 100ms 走）
  assert.match(out.note, /等满/);
  assert.ok(t >= Date.parse(NOW) + 5000, '要真等够 5 秒（假时钟也照走）');
  assert.equal(expandState(store).step, 'recheck');
});

test('⚠ 任务隔离：App 任务的上传格是 done，也不许当成"任务拓展传完了"', () => {
  const routes = OK_ROUTES();
  routes['taskExpansion'] = [
    { code: 0, result: { curMonthBackup: false } },
    { code: 0, result: { curMonthBackup: true } },
  ];
  const { deps, store, sent } = mkDeps(routes);
  // App 任务昨天/刚才传完的文件躺在它自己那一格里。
  store.setState(
    STATE_UPLOAD,
    JSON.stringify({ step: 'done', name: 'asign-abc.bin', fileId: 'F-APP', ownedByUs: true }),
    NOW,
  );
  startExpansion(deps);
  runExpansionStep(deps); // read → 起**自己的**上传
  assert.ok(store.getState(STATE_UPLOAD_EXPANSION), '任务拓展有自己的槽位');
  const own = JSON.parse(store.getState(STATE_UPLOAD_EXPANSION)!) as { name: string; op?: string };
  assert.match(own.name, /^[0-9a-f]{16}\.bin$/, '备份支用随机名，不是 App 任务的 asign-*');
  assert.equal(own.op, 'backup');
  runExpansionStep(deps); // 自己那一枪 create（真的发了）
  assert.ok(sent.some((x) => x.url.includes('hcy/file/create')), '必须真的发自己的 create');
  // App 任务那一格原样没被动过。
  assert.match(String(store.getState(STATE_UPLOAD)), /F-APP/);
});

test('⚠ 账号隔离：A 的完成标记不挡 B，B 也读不到 A 的槽位', () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify({ cookie: '', jwt: 'J', savedAt: NOW }), NOW);
  const a = upsertAccount(store, `Basic ${Buffer.from('mobile:19900000001:t').toString('base64')}`, NOW, 'A').account;
  const b = upsertAccount(store, `Basic ${Buffer.from('mobile:19900000002:t').toString('base64')}`, NOW, 'B').account;
  const oneA = scoped(rawStoreOf(store), a.id);
  const oneB = scoped(rawStoreOf(store), b.id);
  const day = NOW.slice(0, 10);
  oneA.setState(STATE_EXPAND, JSON.stringify({ step: 'done', day, backupOn: true }), NOW);
  oneA.setState(STATE_UPLOAD_EXPANSION, JSON.stringify({ step: 'done', name: 'a.bin' }), NOW);
  oneB.setState(STATE_UPLOAD_EXPANSION, JSON.stringify({ step: 'create', name: 'b.bin' }), NOW);

  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result: { curMonthBackup: false } }) };
  }) as never;
  const depsB = { store: oneB, transport, nowIso: NOW, baseUrl: undefined, settleMs: 0 } as TaskDeps;
  const kick = startExpansion(depsB);
  assert.notEqual(kick.idle, true, 'B 没跑过 —— A 的 done 不许把它挡在门外');
  assert.equal(expandState(oneB).step, 'read');
  assert.equal(expandState(oneA).step, 'done', 'A 的状态一个字都不许动');
  assert.match(String(oneB.getState(STATE_UPLOAD_EXPANSION)), /b\.bin/, 'B 只看到自己的槽位');
});

test('⚠ blocked 之后：Auto 只**只读复查**（不再传文件），手动可以真的重来', () => {
  const day = NOW.slice(0, 10);
  // 上游这会儿还没记账 ⇒ 复查仍是 false
  const { deps, store, sent } = mkDeps({ taskExpansion: { code: 0, result: { curMonthBackup: false } } });
  store.setState(
    STATE_EXPAND,
    JSON.stringify({ step: 'blocked', day, backupOn: false, attempted: true, blockedWhy: '快照没建上：code=04000003' }),
    NOW,
  );
  const auto = startExpansion(deps);
  assert.notEqual(auto.idle, true, '自动那趟不是"什么都不做"，是只读复查一次');
  assert.match(auto.note, /只复查/);
  assert.equal(expandState(store).step, 'read');
  const out = runExpansionStep(deps); // 读一遍（一个 GET）
  assert.equal(expandState(store).step, 'cleanup');
  const end = runExpansionStep(deps); // 下结论
  assert.equal(end.ok, true, '复查没翻成 true 也**不该再染一次红**');
  assert.equal(end.skipped, true, '这是"还没记账"，不是又一次失败');
  assert.match(end.note, /复查仍是「未开启」/);
  assert.equal(expandState(store).step, 'blocked');
  assert.equal(sent.filter((x) => x.url.includes('hcy/file/create')).length, 0, '复查不许再传文件');
  assert.equal(sent.filter((x) => x.url.includes('batchTrash')).length, 0, '已经清过的文件不许再删一次');

  const manual = startExpansion({ ...deps, lateMs: -1000 } as TaskDeps);
  assert.equal(manual.idle, undefined);
  assert.equal(expandState(store).step, 'read', '手动那一趟可以真的重来（要真有上传）');
});

test('⚠ 只读复查翻成 true ⇒ 直接记 done（这就是"备份自己完成"那条路）', () => {
  const day = NOW.slice(0, 10);
  const { deps, store, sent } = mkDeps({
    taskExpansion: { code: 0, result: { curMonthBackup: true, curMonthTaskRecordCount: 6 } },
  });
  // 现场：12:52 传完读到 false；13:40 再读就是 true（中间没人做任何事）
  store.setState(
    STATE_EXPAND,
    JSON.stringify({ step: 'blocked', day, backupOn: false, attempted: true, blockedWhy: '凑过一次备份，重读仍是「未开启」' }),
    NOW,
  );
  startExpansion(deps);
  const out = runExpansionStep(deps);
  assert.equal(out.ok, true, out.note);
  const end = runExpansionStep(deps);
  assert.equal(end.ok, true, end.note);
  assert.equal(expandState(store).step, 'done');
  assert.equal((JSON.parse(store.getState(STATE_EXPAND)!) as { backupOn?: boolean }).backupOn, true);
  assert.equal(sent.length, 1, '只有那一个 GET（本来就没有文件要清，也没再传文件）');
  assert.equal(store.getState('mcloud.month.backup'), JSON.stringify({ month: '2026-10', backup: true }));
});

test('⚠ 库里旧版本的 done（备份其实没开）⇒ 自动那趟只复查，手动可重来', () => {
  const day = NOW.slice(0, 10);
  const { deps, store, sent } = mkDeps({ taskExpansion: { code: 0, result: { curMonthBackup: false } } });
  store.setState(
    STATE_EXPAND,
    JSON.stringify({
      step: 'done',
      day,
      curMonthBackup: false,
      uploadFileId: 'F-OLD',
      uploadOwned: true,
      snapError: 'createSnapshot 失败：code=04000003',
    }),
    NOW,
  );
  const auto = startExpansion(deps);
  assert.notEqual(auto.idle, true);
  assert.match(auto.note, /只复查/);
  assert.equal(expandState(store).step, 'read', '旧那条 done 不许再把今天锁死（只读一遍）');
  runExpansionStep(deps); // 读
  runExpansionStep(deps); // 清理（旧版本已经清过 ⇒ 跳过）+ 下结论
  assert.equal(expandState(store).step, 'blocked');
  assert.equal(sent.filter((x) => x.url.includes('batchTrash')).length, 0, '旧 fileId 不许再删一遍');
  assert.equal(sent.filter((x) => x.url.includes('hcy/file/create')).length, 0, '复查不许再传文件');

  const manual = startExpansion({ ...deps, lateMs: -1 } as TaskDeps);
  assert.equal(manual.idle, undefined);
  assert.equal(expandState(store).step, 'read', '手动必须能重来（否则只能等到明天）');
});

test('链尾清理要跳过“今天还没走完”的上传文件', () => {
  const { deps, store } = mkDeps({});
  const put = (st: Record<string, unknown>) =>
    store.setState(STATE_EXPAND, JSON.stringify({ step: 'read', day: NOW.slice(0, 10), ...st }), NOW);

  put({ step: 'snapshot', uploadFileId: 'F1', uploadOwned: true });
  assert.equal(activeExpansionFileId(deps), 'F1');
  put({ step: 'done', uploadFileId: 'F1', uploadOwned: true });
  assert.equal(activeExpansionFileId(deps), undefined);
  put({ step: 'blocked', uploadFileId: 'F1', uploadOwned: true });
  assert.equal(activeExpansionFileId(deps), undefined, '当天收手了（文件已清）⇒ 不再是"在用"');
  put({ step: 'snapshot', uploadFileId: 'F1', uploadOwned: true, day: '2026-10-13' });
  assert.equal(activeExpansionFileId(deps), undefined);
  put({ step: 'snapshot', uploadFileId: 'F-USER', uploadOwned: false });
  assert.equal(activeExpansionFileId(deps), undefined);
});
