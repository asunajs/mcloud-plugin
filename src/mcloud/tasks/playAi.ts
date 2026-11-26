// 趣玩AI 的第①步任务体：**只读** —— 读门户页模块 + 主题模块 + 奖品记录，落读数。
//
// # 为什么先只做"读"
//
// 写口（`page/register` / `page/lottery`）都有真副作用，而"点了不等于完成、判据要回读"
// 这条（见 `playAi.ts` 文件头 ②）意味着写那半要先有稳定的读，否则没法判。
// 所以第一步只读：用**调试页**跑一次，拿真实读数对 App 上看到的东西，形状对上再往下做。
//
// # 一族的读数答什么
//
// ```text
//   几个模块 / 几件任务 / 几件已完成 / 几件可做 / 几件需手动 / 现在能抽几次
// ```

import { callRawText } from '../client.ts';
import type { Transport } from '../client.ts';
import { loadSession } from '../../store/types.ts';
import { loadJwt } from '../sessionExchange.ts';
import {
  pageModuleRequest,
  parseEnvelope,
  parseModules,
  readingLine,
  shortTaskName,
  summarize,
  timedModuleRequest,
} from '../playAi.ts';
import type { PlayAiModule } from '../playAi.ts';
import { loadPlayAi, newPlayAi, savePlayAi, savePlayAiSnapshot } from '../playAiState.ts';
import type { PlayAiSession } from '../playAi.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 会话：H5 票（`jwttoken`）+ cookie + UA —— 与算力族同一张票，不另换活动站票。 */
function session(deps: TaskDeps): PlayAiSession | undefined {
  const sess = loadSession(deps.store);
  if (sess === null) return undefined;
  const rec = loadJwt(deps.store);
  if (rec === null || rec.jwt === '') return undefined;
  return { jwt: rec.jwt, cookie: sess.cookie, userAgent: sess.userAgent };
}

/** 读一次（**两发只读**）。返回模块列表或错误原话。 */
async function readModules(
  transport: Transport,
  s: PlayAiSession,
  base: string | undefined,
): Promise<{ ok: true; modules: PlayAiModule[] } | { ok: false; error: string }> {
  const out: PlayAiModule[] = [];
  for (const req of [pageModuleRequest(s, base), timedModuleRequest(s, base)]) {
    const res = await callRawText(transport, req);
    if (!res.ok) return { ok: false, error: `读不到模块：${res.error ?? '未知失败'}` };
    const env = parseEnvelope(res.text);
    if (!env.ok) return { ok: false, error: env.error };
    out.push(...parseModules(env.result));
  }
  return { ok: true, modules: out };
}

/** 推进一步。第一版只有 `list → done` 两段（**一个请求都不写**）。 */
export async function playAiStep(deps: TaskDeps): Promise<TaskOutcome> {
  const day = deps.nowIso.slice(0, 10);
  const prev = loadPlayAi(deps.store);
  const st = prev !== null && prev.day === day && prev.phase === 'list' ? prev : newPlayAi(day, deps.nowIso);

  const s = session(deps);
  if (s === undefined) {
    const error = '还没有可用的 H5 票（日常第①步换票没成）—— 这一族这次没做';
    savePlayAiSnapshot(deps.store, { at: deps.nowIso, ok: false, line: error, reading: null, error }, deps.nowIso);
    return { ok: false, note: error };
  }

  const got = await readModules(deps.transport, s, deps.baseUrl);
  if (!got.ok) {
    const line = `读不到趣玩AI：${got.error}`;
    savePlayAiSnapshot(deps.store, { at: deps.nowIso, ok: false, line, reading: null, error: got.error }, deps.nowIso);
    st.phase = 'done';
    savePlayAi(deps.store, st, deps.nowIso);
    return { ok: false, note: line };
  }

  const reading = summarize(got.modules);
  const line = readingLine(reading);
  savePlayAiSnapshot(deps.store, { at: deps.nowIso, ok: true, line, reading, error: '' }, deps.nowIso);

  // 逐行：只报"可做"的**名字**（短名、不带上游的整句营销词、不带 `moduleId`）。
  // ⚠ 别把整张表刷出来：22 件 × 一句营销名 = 日志三四行，读的人只会跳过。
  //   要明细的看运行记录里的 `lines`/读数，日志只给"大概有什么可做"。
  const runnable = got.modules
    .flatMap((m) => m.tasks)
    .filter((t) => !t.isComplete && t.taskSign === 0)
    .map((t) => shortTaskName(t.name));
  st.modules = got.modules;
  st.lines =
    runnable.length === 0
      ? []
      : [
          `可做：${runnable.slice(0, 3).join('、')}${
            runnable.length > 3 ? ` 等 ${runnable.length} 件` : ''
          }`,
        ];
  st.phase = 'done';
  savePlayAi(deps.store, st, deps.nowIso);

  // ⚠ 必须 `idle: true`：`drain` 看到非 idle 会再调一次，而这一族只有一步
  return { ok: true, idle: true, note: line };
}
