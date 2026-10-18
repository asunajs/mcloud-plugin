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
import { http_fetch } from 'host-api';
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
  /** ④ 挂了的话，**把原因带出来**（自检存在的意义就是"哪一项、为什么"）。 */
  let sqliteWhy = '';
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
  } catch (e) {
    // 记下来当作失败项，而不是让整个自检抛出去 ——
    // 自检本身挂了的话，用户看到的是「设置页打不开」，那比「哪一项失败」难查得多。
    // ⚠ 但**原因必须带出来**：只报"失败"两个字的自检，查起来要重新走一遍
    //   （F-064 就是这么被拖了一整轮的）。
    statsOk = false;
    sqliteWhy = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  checks.push(['sqlite 自增主键返回', id > 0]);
  checks.push(['sqlite 聚合查询可用', statsOk]);

  // ⑤ 宿主的 **native TLS** 后端在不在。
  //
  //  ⚠ 这条是**真的会坏**的：直播那一链（换直播侧 JWT / 门 / WS）走 `tls:"native"`，
  //  而面板默认构建里只有 rustls ⇒ 整个「直播」会在第一步就 warn「没成」，
  //  而自检那时候是绿的。用户看到的是"日志里一句 warn，其余全好"。
  //  （2026-10-17 真撞到：面板被重编成不带 `--features legacy-tls`，直播就废了。）
  //
  //  探法不连网：TLS 选项在**连接之前**解析 —— 不支持会立刻回那句
  //  「需要 `--features legacy-tls`」，支持则走到"连不上"（说明后端存在）。
  let nativeTls = false;
  let tlsWhy = '';
  try {
    // ⚠ `http_fetch` 失败时是**返回** `{error}`，不是抛（见 host-api.d.ts）
    const r = http_fetch('https://127.0.0.1:9/', { tls: 'native', timeout_ms: 2000 });
    const err = (r as unknown as { error?: string }).error ?? '';
    nativeTls = !/legacy-tls/.test(err);
    if (!nativeTls) tlsWhy = err;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    nativeTls = !/legacy-tls/.test(m);
    if (!nativeTls) tlsWhy = m;
  }
  checks.push(['宿主支持 native TLS（直播那条链要它）', nativeTls]);

  // ⑥ 沙箱能力探测（只报告、不判失败；探的每一项决定后面哪条链能做 —— 见 caps.ts）
  const caps = sandboxCaps();

  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail:
      (bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join('、')}`) +
      (sqliteWhy === '' ? '' : `（sqlite：${sqliteWhy}）`) +
      (tlsWhy === '' ? '' : `（tls：${tlsWhy}）`) +
      ` · ${caps}`,
    checks: checks.map(([name, ok]) => ({ name, ok })),
    caps,
  };
}
