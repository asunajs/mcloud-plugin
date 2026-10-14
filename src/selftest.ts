// 沙箱自检 —— 在**面板里**把密码学、编码、SQLite 串一遍。
//
// # 为什么这件事必须在沙箱里做一遍，而不是只信 Node 里的测试
//
// 插件跑的是 QuickJS + PocketPy，**没有** TextEncoder / Buffer / crypto，
// BigInt 也没赌（见 caps.ts）。Node 里绿不代表这里绿 —— 而一旦不对，
// 表现是「上游回一个签名错误」，在真机上排查很贵。
//
// # 为什么它是路由而不是任务
//
// 老写法是一条每 5 分钟跑一次的 `selftest` cron。那是「面板上 25 条任务」里的
// 两条之一 —— 用户看不懂「自检」是什么，也不该为它操心。
// 改成路由之后界面在「设置」页里点一下就能看到，而且**随时可问**。
//
// 写（`recordRun`）留在里面：它顺带验证「SQLite 真的能写能读」，
// 而那正是要验的东西之一 —— 只读探测盖不住占位符与自增主键。

import { fromBase64, fromUtf8, md5Hex, sha256Hex, toBase64, utf8 } from './crypto/index.ts';
import { sandboxCaps } from './mcloud/caps.ts';
import type { Store } from './store/types.ts';

export interface SelftestResult {
  ok: boolean;
  /** 一行摘要，可以直接显示在界面上 */
  detail: string;
  /** 逐项结果 —— 界面要能展开看是哪一项挂了 */
  checks: { name: string; ok: boolean }[];
  /** 沙箱能力探测（只报告、不判失败） */
  caps: string;
}

/** 跑一遍自检。**不改任何上游状态**：只写自己那一行 `__selftest__`。 */
export function selftest(store: Store): SelftestResult {
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
  let id = 0;
  let statsOk = false;
  try {
    id = store.recordRun({
      task: '__selftest__',
      runs: 0,
      scheduledAt: new Date(0).toISOString(),
      firedAt: new Date(0).toISOString(),
      lateMs: 0,
      ok: true,
      note: 'selftest',
    });
    statsOk = store.lateStats('__selftest__', 10).n >= 1;
  } catch {
    // 记下来当作失败项，而不是让整个自检抛出去 ——
    // 自检本身挂了的话，用户看到的是「设置页打不开」，那比「哪一项失败」难查得多
    statsOk = false;
  }
  checks.push(['sqlite 自增主键返回', id > 0]);
  checks.push(['sqlite 聚合查询可用', statsOk]);

  // ⑤ 沙箱能力探测（只报告、不判失败；探的每一项决定后面哪条链能做 —— 见 caps.ts）
  const caps = sandboxCaps();

  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail:
      (bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join('、')}`) +
      ` · ${caps}`,
    checks: checks.map(([name, ok]) => ({ name, ok })),
    caps,
  };
}
