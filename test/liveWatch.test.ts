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
  // ⚠ 听到新的口令是**去验证**，不是收工：万一口令是废的，收工就白听了
  assert.match(d, /firstSeenMs >= runStartMs && !verified\.has\(c\.value\)/, '新的没验过的才验');
  assert.match(d, /runLiveDraw\(d, \{ codes: \[fresh\.value\] \}\)/, '当场拿这一条去领（领就是验证）');
  // 窗口是"这一句到 continue 之间"，中间可以夹别的（追踪环就插在那里）——
  // 判据只有一条：**不许 break**。窗口给到 900 字是因为中间现在多了一段 traceStep。
  assert.ok(
    /验证「\$\{fresh\.value\}」[\s\S]{0,900}continue;/.test(d),
    '验完要**接着听**（continue），不许 break',
  );
  assert.ok(
    !/验证「\$\{fresh\.value\}」[\s\S]{0,900}break;/.test(d),
    '⚠ 验完不许 break（万一口令是废的，收工就白听了）',
  );
  // 停下要有话说，别让用户以为被截断
  assert.match(d, /listenStop/, '要说清为什么提前不听了');
  assert.match(d, /const verified = new Set<string>\(\);/, '同一条口令不重复验');
});

test('播报：不许再出现「上次：」这种把上一轮当这一轮的说法', () => {
  const d = src('src/entries/live.ts');
  assert.ok(!/prefix = replay \? '上次：'/.test(d), '旧的 replay 前缀必须删掉');
  assert.ok(!/`\$\{prefix\}/.test(d), '不许再拼那个前缀');
  // ⚠ 2026-11-16 改：判"本轮有没有做事"**不许**用时间戳。
  //   时间戳是一次 run 里冻结的同一个值 ⇒ 猜不出这轮是不是新的；
  //   11:59:48 现场就是 14 行只跨 12 毫秒、却把上一轮结果当本轮播了。
  assert.ok(!/st\.startedAt === deps\.nowIso/.test(d), '不许再用冻结时间戳判"本轮"');
  assert.match(d, /const didWork = r\.steps > 0 && !idleNoRequest;/, '按"真的走了几步 + 有没有发请求"判');
  assert.match(d, /本次没发请求/, '没发请求就要明说');
  // 收尾统计只算真做了事的账号（"3/3 个账号好了"不许把什么都不算进去）
  assert.match(d, /didWork !== false/, '收尾统计要排除没做事的账号');
});

test('领小红花：没得领时要把判据印出来（池/可领/上一轮/已领过）', () => {
  const d = src('src/mcloud/tasks/liveDraw.ts');
  assert.match(d, /池里 \$\{pool\.codes\.length\} 条/, 'idle 时印池子条数');
  assert.match(d, /这个号能领 \$\{codes\.length\} 条/, '印这个号能领几条');
  assert.match(d, /上一轮 \$\{done\.length\} 条/, '印上一轮几条');
  // 2026-11-16：那句改写 `drawReport(s)?.line`（统一措辞，含"已领过"那一栏）
  assert.match(d, /上次那轮：\$\{drawReport\(s\)\?\.line/, '口令没变时也要说清是"上次那轮"');
});

test('池子：2 条有效 = 够了（VALID_ENOUGH 是抓取停止的唯一判据）', () => {
  const d = src('src/mcloud/koulingPool.ts');
  assert.match(d, /VALID_ENOUGH = 2/);
  assert.match(d, /validCount\(pool\) >= VALID_ENOUGH/, 'stopScraping 按 validCount 判');
});
