// livemock —— 直播（领小红花）链路的**离线录音机**。
//
// # 它解决什么
//
// 直播任务几天才触发一次、一次窗口只有几小时 —— 拿它当测试手段是错的：
// 一个月也只能考几次，而且每次考的都是新题。2026-11-16 那两段莫名词
// （「走到时间上限（16166ms / 0 步）」+「3/3 个账号好了」、「12 毫秒里三个号各领到 X 朵」）
// 全都是**纯逻辑**问题，只要有一份报文就能几秒复现出来。
//
// 所以这里照**真实报文形状**做一个可编排的 mock：
//
//   | 请求 | 形状来源 |
//   |---|---|
//   | `POST /ycloud/liveRoomFeedback/user/info` | 余额在 `result.flowerCnt` |
//   | `POST /ycloud/visitlog/journaling`（5 发） | `{code:0,msg:"success"}` |
//   | `POST /ycloud/liveRoomFeedback/firstParticipate/give` | 0 / `200110` 已参与 |
//   | `POST /ycloud/liveRoomFeedback/redFlower/draw?code=` | **唯一的写请求**，由脚本逐条应答 |
//   | `GET /ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers` | 复活花 |
//
// ⚠ 它**不是**"我发出去长什么样"的证明 —— 那是抓包的事（见
// `mcloud-capture/mcloud/capture/`）。它证明的是"**收到这样的回包时，状态机怎么走、
// 日志怎么说**"。两者不能互相冒充。

import type { BuiltRequest } from '../../src/mcloud/h5.ts';

/** 一次 `draw` 的应答脚本。 */
export type DrawReply =
  | { kind: 'ok'; flowerNum: number; prizeName?: string }
  | { kind: 'already' } // 200112 已兑换过
  | { kind: 'invalid' } // 口令无效
  | { kind: 'not-started' }
  | { kind: 'http-error'; httpStatus: number }
  | { kind: 'raw'; body: string };

export interface LiveMockCall {
  method: string;
  /** 去掉 base 之后的路径 + query */
  path: string;
  body: string | undefined;
}

export interface LiveMock {
  transport: (req: BuiltRequest) => { status: number; headers?: Record<string, string>; body: string };
  /** 全部请求（按发生顺序），断言"到底发了几发、发的什么" */
  calls: LiveMockCall[];
  /** 只看 draw 的 `code=` 参数 */
  drawCodes(): string[];
  /** 当前小红花余额（读到多少就是多少） */
  balance(): number;
  /** 运行中追加一条 draw 应答（模拟"中途上游变了"） */
  pushDraw(reply: DrawReply): void;
  /** 清空请求计数（不影响余额） */
  reset(): void;
}

export interface LiveMockOpts {
  /** 起手小红花余额 */
  flowerStart: number;
  /** 每条口令的应答；用完按"ok 5 朵"兜底 */
  draws?: readonly DrawReply[];
  /** 首次参与惊喜奖：`ok`（发 3 朵）或 `already`（200110） */
  firstParticipate?: 'ok' | 'already';
  /** 复活花数量 */
  revival?: number;
}

export function createLiveMock(opts: LiveMockOpts): LiveMock {
  let flower = opts.flowerStart;
  const queue: DrawReply[] = [...(opts.draws ?? [])];
  const calls: LiveMockCall[] = [];

  const json = (o: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(o) });

  function drawBody(reply: DrawReply): { status: number; headers: Record<string, string>; body: string } {
    switch (reply.kind) {
      case 'ok':
        flower += reply.flowerNum;
        return json({
          code: 0,
          msg: 'success',
          result: { prizeId: 1001, flowerNum: reply.flowerNum, prizeName: reply.prizeName ?? '小红花' },
        });
      case 'already':
        return json({ code: 200112, msg: '已兑换过' });
      case 'invalid':
        return json({ code: 200111, msg: '口令无效' });
      case 'not-started':
        return json({ code: 200113, msg: '活动未开始' });
      case 'http-error':
        return { status: reply.httpStatus, headers: {}, body: '{"code":500,"msg":"server error"}' };
      case 'raw':
        return { status: 200, headers: {}, body: reply.body };
    }
  }

  const transport = (req: BuiltRequest) => {
    const path = req.url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: req.method, path, body: req.body });
    if (path.startsWith('/ycloud/liveRoomFeedback/user/info')) {
      return json({ code: 0, msg: 'success', result: { flowerCnt: flower } });
    }
    if (path.startsWith('/ycloud/visitlog/journaling')) {
      return json({ code: 0, msg: 'success' });
    }
    if (path.startsWith('/ycloud/liveRoomFeedback/firstParticipate/give')) {
      return opts.firstParticipate === 'already'
        ? json({ code: 200110, msg: '已参与过' })
        : json({ code: 0, msg: 'success', result: { num: 3 } });
    }
    if (path.startsWith('/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers')) {
      return json({ code: 0, msg: 'success', result: { revivalFlower: opts.revival ?? 0 } });
    }
    if (path.startsWith('/ycloud/liveRoomFeedback/redFlower/draw')) {
      return drawBody(queue.shift() ?? { kind: 'ok', flowerNum: 5 });
    }
    // 没覆盖到的路径**抛错**，而不是回一个看起来正常的 {} ——
    // 否则"忘了 mock 的请求"会静默成功，测试从此测不到东西。
    throw new Error(`livemock 没覆盖这个请求：${req.method} ${path}`);
  };

  return {
    transport: transport as unknown as LiveMock['transport'],
    calls,
    drawCodes: () =>
      calls
        .filter((c) => c.path.includes('/redFlower/draw'))
        .map((c) => {
          const m = /[?&]code=([^&]*)/.exec(c.path);
          return m === null ? '' : decodeURIComponent(m[1]!);
        }),
    balance: () => flower,
    pushDraw: (reply) => queue.push(reply),
    reset: () => {
      calls.length = 0;
    },
  };
}
