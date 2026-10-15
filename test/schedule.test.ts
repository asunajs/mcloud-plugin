// 任务频率。
//
// # 为什么单独一条测试
//
// 这三条 cron 第一版分别是 `*/30 7-22 * * *`（一天 30 次）、`@every 10s`
//（一天 **8640** 次）、`@every 1m`（一天 1440 次）。逻辑上都没错 —— 每一次
// 便宜、零请求、秒返回。但用户看到任务列表里那几个表达式就说了：
//
//     「太特么频繁了」「日常每天两次？直播能和兑换需要用户指定时间，
//       不要上来就不停的跑」
//
// 而用户是对的：**触发频率该由"这件事一天发生几次"决定，不是由"多久看一眼"决定**。
//
// 所以这条测试钉的不是"表达式长什么样"，而是**一天触发几次**。钉表达式的话，
// 换个写法（`0 */2 * * *` 和 `*/2 * * * *` 完全不同）就会误报；钉次数才是在
// 检查我们真正在意的那件事。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

/** 一个 cron/`@every` 表达式**一天触发多少次**。
 *
 *  ⚠ 只认这几种实际用到的形状；认不出来就抛 —— 那说明有人写了新形状而没更新
 *  这里，这时候**报错比猜**好（猜出来的数字会让这条测试变成安慰剂）。 */
function perDay(expr: string): number {
  const every = /^@every\s+(\d+)\s*([smh])$/.exec(expr);
  if (every) {
    const n = Number(every[1]);
    const secs = every[2] === 's' ? n : every[2] === 'm' ? n * 60 : n * 3600;
    return 86_400 / secs;
  }
  const parts = expr.trim().split(/\s+/);
  assert.equal(parts.length, 5, `认不出的表达式：${expr}`);
  const [min, hour] = parts as [string, string, string, string, string];

  const count = (field: string, span: number): number => {
    if (field === '*') return span;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Math.ceil(span / Number(step[1]));
    return field.split(',').length;
  };
  return count(min, 60) * count(hour, 24);
}

test('⚠ 三个任务的触发频率（一天几次），不是"多久看一眼"', () => {
  const daily = read('src/entries/daily.ts');
  const exchange = read('src/entries/exchange.ts');
  const live = read('src/entries/live.ts');

  const cronOf = (src: string, task: string): string => {
    // `register_cron(\n  '名字',\n  …注释…\n  '表达式',\n` —— 取名字后面第一个
    // 引号包着的 cron 形状的串。
    const at = src.indexOf(`'${task}'`);
    assert.ok(at >= 0, `${task}: 没找到 register_cron`);
    const after = src.slice(at);
    const m = /'((?:@every\s+\d+[smh])|(?:\S+\s+\S+\s+\S+\s+\S+\s+\S+))'/.exec(after);
    assert.ok(m, `${task}: 没找到表达式`);
    return m[1]!;
  };

  const cases = [
    ['日常', cronOf(daily, '日常')],
    ['兑换', cronOf(exchange, '兑换')],
    ['直播', cronOf(live, '直播')],
  ] as const;

  for (const [name, expr] of cases) {
    const n = perDay(expr);
    // 一天 300 次是条很宽的线 —— 它拦的不是"稍微频繁一点"，而是
    // `@every 10s`（8640）、`@every 1m`（1440）这种"一直在跑"。
    assert.ok(
      n <= 300,
      `${name}：\`${expr}\` 一天触发 ${n} 次 —— 太多了。\n` +
        '  频率该由"这件事一天发生几次"决定，不是由"多久看一眼"决定。',
    );
  }

  // 具体到每一条：日常一天两次（用户点名要的）
  assert.equal(perDay(cases[0][1]), 2, `日常该是一天两次，实际 ${cases[0][1]}`);
  // 兑换：每小时醒一次（一天 24），落在目标小时的前一分钟
  assert.equal(perDay(cases[1][1]), 24, `兑换该是一天 24 次，实际 ${cases[1][1]}`);
});

test('⚠ 离窗口还远的那些触发**一条日志都不写**', () => {
  // 频率降下来之后，剩下的噪声就是"23 次静默零请求"里如果还写日志，
  // 一天仍有 23 行「还没到抢兑时间」。所以 `idle` 必须传到顶层并让入口闭嘴。
  const run = read('src/mcloud/tasks/exchangeRun.ts');
  const entry = read('src/entries/exchange.ts');

  assert.ok(/idle\?: boolean;/.test(run), '`runExchange` 的返回类型要带 `idle`');
  assert.ok(
    /if \(r\.idle\) \{/.test(entry),
    '入口要认 `r.idle` —— 否则离窗口远的那 23 次各写一行日志',
  );
  // 而且 idle 那支**不许**调 `log(`（`recordRun` 是记数，不是日志）
  const idleBranch = entry.slice(entry.indexOf('if (r.idle) {'));
  const branch = idleBranch.slice(0, idleBranch.indexOf('\n    }'));
  assert.ok(!/\blog\s*\(/.test(branch), `idle 那一支里不该有 log()：\n${branch}`);
  assert.ok(!/appendRun\s*\(/.test(branch), 'idle 那一支不该记一笔 run（它什么都没做）');
});
