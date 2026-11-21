// 时间戳：界面上凡是说「上一轮」的地方都要能回答「上一轮是什么时候」。
//
// 2026-11-17 用户原话：「为啥是具体时间，因为说上一轮，也没人知道上一轮是什么时候」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../src/store/memory.ts';
import { mcloudRoutes } from '../src/mcloud/routes.ts';
import { saveLiveCodes } from '../src/mcloud/tasks/liveRoom.ts';
import { STATE_DRAW } from '../src/mcloud/tasks/liveDraw.ts';
import { testDeps } from './helpers.ts';
import { readFileSync } from 'node:fs';

const srcOf = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const NOW = '2026-11-17T10:11:30.625Z';
const LATER = '2026-11-17T10:12:05.100Z';

async function live(store: ReturnType<typeof memStore>) {
  const deps = testDeps(store, { now: NOW });
  const entry = mcloudRoutes(deps).find(
    (r) => r.method === 'GET' && r.path === '/plugins/mcloud/api/readings',
  );
  assert.ok(entry, '缺 GET /api/readings');
  const r = await entry.handler({ method: 'GET', path: '/plugins/mcloud/api/readings', query: '', headers: {}, body: '' });
  assert.equal(r.status, 200);
  const all = JSON.parse(r.body) as {
    live: {
      codes: { code: string; source?: string; atMs?: number }[] | null;
      draw: { at?: string | null; line: string };
    };
  };
  return all.live;
}

test('人贴的口令带「什么时候贴的」', async () => {
  const store = memStore();
  store.ensureSchema();
  saveLiveCodes(store, '复制口令1：云盘AI高效复盘', NOW);
  const d = await live(store);
  assert.ok(d.codes && d.codes.length === 1, JSON.stringify(d.codes));
  assert.equal(d.codes[0]!.source, '手动');
  assert.equal(d.codes[0]!.atMs, Date.parse(NOW), '要给出贴进来的时刻（界面照它写「今天 18:11」）');
});

test('上一轮的口令结论带「那一轮是什么时候」', async () => {
  const store = memStore();
  store.ensureSchema();
  store.setState(
    STATE_DRAW,
    JSON.stringify({
      step: 'done',
      journalingSent: 1,
      drawIndex: 1,
      codes: ['云盘AI高效复盘'],
      results: [{ code: '云盘AI高效复盘', kind: 'succeeded' }],
      balanceBefore: 120,
      balanceAfter: 130,
      startedAt: NOW,
      finishedAt: LATER,
    }),
    NOW,
  );
  const d = await live(store);
  // 用**跑完**的时刻：那句结论是跑完才有的
  assert.equal(d.draw.at, LATER, '要说清这一轮是什么时候的');
  assert.match(d.draw.line, /1 条口令领到 1 条/);
});

test('界面：上一轮那句带时间、日志时间带日期', async () => {
  const js = srcOf('webui/app.js');
  // 口令池那行：`上一轮（<具体日期时间>）<结论>`
  assert.ok(/const roundAt = draw\.at \? `上一轮（\$\{stamp\(Date\.parse\(draw\.at\)\)\}）` : '';/.test(js), '上一轮要带具体日期');
  assert.ok(/`\$\{poolHead\} · \$\{roundAt\}\$\{rep\.line\}/.test(js), '口令池那行要用上它');
  // 每条口令带时间
  assert.ok(/` \u00b7 \$\{stamp\(c\.atMs\)\}`/.test(js), '每条口令要带具体日期');
  // 日志：只写时分秒的话，翻到几百行以前就不知道是哪天的了
  assert.ok(/const stamp = logStamp\(tsRaw\);/.test(js), '日志时间统一走 logStamp');
  assert.ok(/function logStamp\(raw\)/.test(js), '缺 logStamp');
  // 三种来路都要带日期：epoch 毫秒 / ISO(UTC) 转本地；已经是本地完整时间的原样留
  assert.ok(/\/\^\\d\{13\}\$\//.test(js), '要认 epoch 毫秒');
  assert.ok(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\//.test(js), '要认 ISO');
  assert.ok(/getFullYear\(\)/.test(js), '要输出年份');
  assert.ok(!/raw\.slice\(11\)/.test(js), '不许再把日期切掉');
  // 历史那一路（本地环存 ISO）也不许自己切时分秒
  assert.ok(/const ts = Number\.isNaN\(d\.getTime\(\)\) \? '' : one\.t;/.test(js), '历史交 ISO 给 logStamp');
});
