/** 日志行的两个小工具（三块任务页共用）。
 *
 *  形状照参考实现（`mcloud-sign` 的 logger 有 `start/success/fail` 三种类型）：
 *  `成功 签到` / `跳过 备份好礼 —— 今天领过了` / `失败 领取AI豆 —— <真原因>`。
 */

/** 这一步的 `note` 里有没有重复行首的信息。
 *
 *  各步的 `note` 是给**运行记录**写的（那一行里没有步骤名，所以自带 `签到：`、
 *  还带 `第 1 步失败 —— `）。进了日志，行首已经有「失败 签到 —— 」，再抄一遍就是
 *  `失败 签到 —— 签到：第 1 步失败 —— …`（同一件事说两遍）。 */
export function trimNote(name: string, note: string): string {
  let t = note;
  // 名字可能带括注（`App 任务矩阵（只看）`），而 `note` 里写的是不带的那半截
  for (const n of [name, name.split('（')[0] ?? name]) {
    const pre = `${n}：`;
    if (t.startsWith(pre)) {
      t = t.slice(pre.length);
      break;
    }
  }
  // 还有一种重复：`note` 里的前缀是名字的**一部分**（`消息推送：…` vs
  // 名字 `消息推送奖励（问状态）`）。这种也要剥，否则一行里同一个词出现两次。
  const lead = /^([^：]{2,12})：/.exec(t);
  if (lead !== null && name.includes(lead[1] ?? '')) t = t.slice(lead[0].length);
  t = t.replace(/^(第 )?\d+ 步(失败|走完) —— /, '');
  // 传输层那句 `code=500 msg=2025年无云朵记录` 是给排查用的，日志里说人话：
  // 有 msg 就只留 msg，没有就老实说"只给了个编号"。
  const raw = /^code=(-?\d+)(?: msg=(.*))?$/.exec(t.trim());
  if (raw !== null) {
    const msg = (raw[2] ?? '').trim();
    t = msg === '' ? `服务端没给原因（编号 ${raw[1]}）` : `服务端说：${msg}`;
  }
  // `（服务端回 {"code":0,"msg":"success",…}）` → `（服务端确认了）`
  t = t.replace(/（服务端回 \{[^）]*\}）/g, '（服务端确认了）');
  return t.trim();
}

/** 「走到步数上限，下一次接着走」—— 它不是成功，也不是失败（多段任务的一口气）。
 *  标成「成功」会让人以为那一步真的做完了。 */
export function stepCap(note: string): boolean {
  // ⚠ 两种写法都认：`drain` 现在说的是「这一趟走到第 N 步就停了」，
  //   旧记录里还是「走到步数上限」。只认一种的话，改文案那天起
  //   「未完」会静默变回「成功」——而这两件事对用户意思相反。
  return (
    note.includes('步数上限') ||
    /走到第 \d+ 步就停了/.test(note) ||
    note.includes('还有没做完的')
  );
}

/** **给用户看的一行**。用户只需要两件事：成了没有、没成是什么原因。
 *
 *  # 为什么不是「成功/跳过/未完/失败 + 步数」
 *
 *  用户的原话：「12 步是啥意思，用户只需要知道成功与否，失败是啥原因」。
 *  所以：
 *
 *  · 一行一个**他认得的任务**（签到 / 领取AI豆 / …），名字在前、结论在后；
 *  · 结论只有三种说法：`成了` / `没成 —— <原因>` / `跳过`（今天没这回事）；
 *  · 「这一趟走到第 N 步就停了」这种内部机制**不写**——它是"还没做完"，
 *    说成「成了（还有没做完的）」就够了；
 *  · **管道步骤**（换票 / 凭据续期）成功时**一行都不写**：用户不需要知道
 *    我们内部换了张票。只有它**失败**时才出现 —— 那时它是"为什么后面全没成"的原因。
 *
 *  返回 `null` = 这一行不该出现在用户的日志里（运行记录里仍然有，排查用）。
 */
/** 内部管道步骤：用户不需要知道"我们换了张票"。
 *  ⚠ 只有**这里**知道哪些算管道；界面读的是运行记录里的 `plumb` 标记。 */
const PLUMBING = ['换票', '凭据续期'];

/** 这一步是不是内部管道（`userLine` 与运行记录都用它）。 */
export function isPlumbing(name: string): boolean {
  return PLUMBING.some((p) => name.startsWith(p));
}

/**
 * 同一趟日志里，**同一句解释只说一遍**。
 *
 * 为什么：有些后缀是"整个账号族共用一个事实"，比如
 * `领小红花没开（要先在服务端那边开启）` —— 服务端那个开关不按账号分，
 * 三个账号连着三行把同一句解释抄三遍，读的人只会觉得啰嗦（用户截图圈出来的就是这个）。
 * 第一次带解释，后面只留结论（`领小红花没开`）。
 *
 * ⚠ 只对**下面这几个固定后缀**生效，不做"任意重复就去重" —— 那会把
 *   `签到：今天已经签过了` 这种"每个账号各说一次才对"的行也吃掉。
 */
const ONCE_HINTS = ['（要先在服务端那边开启）'];

/** 把已经说过一次的解释去掉（`seen` 由调用方按**一趟运行**持有）。 */
export function onceHint(line: string, seen: Set<string>): string {
  for (const h of ONCE_HINTS) {
    if (!line.includes(h)) continue;
    if (seen.has(h)) return line.replace(h, '');
    seen.add(h);
  }
  return line;
}

export function userLine(step: {
  name: string;
  ok: boolean;
  idle?: boolean | undefined;
  note: string;
}): string | null {
  if (isPlumbing(step.name) && step.ok) return null; // 内部的事，成了就不提
  const why = trimNote(step.name, step.note);
  // ⚠ 不写"成了/成功/跳过"这种抽象词（用户的原话：「成了是啥啊」）——
  //   直接把这一步**发生了什么**说出来：`签到：今天已经签过了`、
  //   `领取AI豆：今天没有可领的`、`复活卡：没成 —— 服务端说：2025年无云朵记录`。
  if (!step.ok) return `${step.name}：没成${why === '' ? '' : ` —— ${why}`}`;
  return `${step.name}：${why === '' ? '好了' : why}`;
}

/** 用户日志的**着色类型**。与面板的 `start/success/fail/debug` 对齐。
 *
 *  规则只有一条：**根因失败**才红（`fail`）；被根因拖下水的步骤
 *  （"还没有网页会话"）只是 `debug` —— 否则一个票过期会刷十几行红字，
 *  用户根本看不出哪一行才是真正要处理的。
 */
export type LineLevel = 'debug' | 'info' | 'success' | 'warn' | 'error' | 'fail' | 'fatal';

export function lineLevel(line: string): LineLevel {
  // 级联失败：根因（换票 / 凭据续期）已经单独一行 fail
  if (
    line.includes('没成') &&
    /还没有网页会话|上面「换票」|没有会话|未登录|90001|票没被认/.test(line)
  ) {
    return 'debug';
  }
  if (line.includes('没成')) return 'fail';
  // 需要用户动手的，黄一下（不是错误，但不该被当成"成了"）
  if (/需手动|手动完成|需前往|需要你|手动打开|这一步我们做不了/.test(line)) return 'warn';

  // 读数 / 状态：这些不是"这一趟做成了什么"，别涂成 success。
  // mcloud-sign 的日志里这类行是 info 或 debug，不是 success。
  if (
    /（只看）|快照|问状态|流水|本月排名|已开启|有效期|剩余|当前云朵|登录账号|过期时间|已完成 \d+ 条|另有 \d+ 条/.test(
      line,
    )
  ) {
    return 'info';
  }

  // success 的口径：**做了事情 + 明确拿到奖励**。
  // 只有「成功」两个字不算 —— 签到成功、分享成功、领取请求成功都只是"动作发出去了"，
  // 没有拿到东西就不能涂成 success（用户 2026-10-20 的原话）。
  const gotReward =
    /(领到|领取到|获得|中奖|抽到|成功获得|兑换成功.*【)/.test(line) &&
    !/未获得|没获得|没领到|未领到/.test(line);
  if (gotReward) return 'success';

  // 今天已经做过 / 没有可领的 / 跳过 —— 过程信息，别用绿色假装是这次做的
  if (/跳过|已经|已领|没有可|没有能|无需|今天|未开启|没开|不发|不领|没问过|走完|做完了|暂无|无待领取|无可领|无.*可领|都领过了/.test(line)) {
    return 'debug';
  }
  // 其余是普通信息，不是成功 —— 这就是"大部分日志都是 success"的根因。
  return 'info';
}

/** 级联失败的那一行改成"跳过"：不要每行都把根因抄一遍。 */
export function lineText(line: string): string {
  if (line.includes('还没有网页会话') || line.includes('上面「换票」')) {
    const m = /^(.+?)：没成 —— /.exec(line);
    if (m !== null) return `${m[1]}：跳过（没有网页会话）`;
  }
  return line;
}

/** 段尾的口径：`bad` 是全部没成的步数，`hard` 是**根因**（不是级联）。
 *
 *  一个票过期会拖垮十步；段尾写「11 项没成」会让人以为要做 11 件事，
 *  实际只有「换票」那一件。分开报才读得懂。 */
export function stepTally(steps: { ok: boolean; note: string }[]): {
  bad: number;
  hard: number;
} {
  const failed = steps.filter((x) => !x.ok);
  const hard = failed.filter(
    (x) => !/还没有网页会话|上面「换票」|没有会话|未登录|90001|票没被认/.test(x.note),
  ).length;
  return { bad: failed.length, hard };
}
