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

import { error, every, log, warn } from 'host-api';
import { md5Hex, sha256Hex, toBase64, fromBase64, fromUtf8, utf8 } from './crypto/index.ts';
import { ensureSchema, lateStats, recordRun, setState } from './store.ts';

ensureSchema();

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
  const id = recordRun({
    task: '__selftest__',
    runs: 0,
    scheduledAt: new Date(0).toISOString(),
    firedAt: new Date(0).toISOString(),
    lateMs: 0,
    ok: true,
    note: 'selftest',
  });
  checks.push(['sqlite 自增主键返回', id > 0]);

  const stats = lateStats('__selftest__', 10);
  checks.push(['sqlite 聚合查询可用', stats.n >= 1]);

  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join('、')}`,
  };
}

// ── 任务：自检（装上去先跑一次这个，确认沙箱这一层是好的）──
every('selftest', '5m', (p) => {
  try {
    const r = selftest();
    recordRun({
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
    recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: true,
    });
    // 每 10 次报一次分布：面板的日志行数有限（环形 200 行），别刷屏
    if (p.runs % 10 === 0) {
      const s = lateStats(p.name, 500);
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
setState('plugin.loaded_at', new Date().toISOString(), new Date().toISOString());
log('mcloud 插件已加载（M0：自检 + 调度健康；上游任务在 M1/M2）');

// 供将来的路由与任务复用
export { selftest };
