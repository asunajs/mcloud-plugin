// 直播这一趟的三条口径（2026-11-11 用户现场提的）：
//   ① 不许把**上次**的结果当这次的结果播（"上次关你屁事"）
//   ② 听到口令就立刻拿去领，不要空听满 600 秒
//   ③ 够了 2 条有效就停，别再重复撞同一批弹幕
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('听弹幕：每拍都判"够了没有 / 有没有新口令"，够了立刻停', () => {
  const d = src('src/entries/live.ts');
  // 循环体里必须有这两道提前退出
  assert.match(d, /const tickPet = loadPoolFrom\(deps\.store\)\.pool;/, '每拍要读一次池子');
  assert.match(d, /if \(stopScraping\(tickPet\)\) \{/, '够 2 条有效就停');
  assert.match(d, /firstSeenMs >= runStartMs/, '听到新的就停（拿去领立刻验证）');
  // 停下要有话说，别让用户以为被截断
  assert.match(d, /listenStop/, '要说清为什么提前不听了');
});

test('播报：不许再出现「上次：」这种把上一轮当这一轮的说法', () => {
  const d = src('src/entries/live.ts');
  assert.ok(!/prefix = replay \? '上次：'/.test(d), '旧的 replay 前缀必须删掉');
  assert.ok(!/`\$\{prefix\}/.test(d), '不许再拼那个前缀');
  // 只有"这一趟真的起了一轮"才播结果
  assert.match(d, /const freshRound = st !== null && st\.startedAt === deps\.nowIso;/, '按"本轮时间戳"判是否本次');
  assert.match(d, /本次没领/, '没跑就要明说没领');
});

test('领小红花：没得领时要把判据印出来（池/可领/上一轮/已领过）', () => {
  const d = src('src/mcloud/tasks/liveDraw.ts');
  assert.match(d, /池里 \$\{pool\.codes\.length\} 条/, 'idle 时印池子条数');
  assert.match(d, /这个号能领 \$\{codes\.length\} 条/, '印这个号能领几条');
  assert.match(d, /上一轮 \$\{done\.length\} 条/, '印上一轮几条');
  assert.match(d, /上次那轮：\$\{s\.summary/, '口令没变时也要说清是"上次那轮"');
});

test('池子：2 条有效 = 够了（VALID_ENOUGH 是抓取停止的唯一判据）', () => {
  const d = src('src/mcloud/koulingPool.ts');
  assert.match(d, /VALID_ENOUGH = 2/);
  assert.match(d, /validCount\(pool\) >= VALID_ENOUGH/, 'stopScraping 按 validCount 判');
});
