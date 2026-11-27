// aiTools 那一族：AI 头像（趣玩AI 的 `007`）的接口与状态机。
//
// 钉三件事：
//  ① 生成请求**七个字段一个不能少** —— 少一个上游回 `01000001 参数错误`，
//     而那句话看上去像"图不合格"，2026-11-27 就是被它骗了半天；
//  ② 状态机：`status` 1/2 = 等，**3 = 完**，别的都按失败（别死等）；
//  ③ `algorithmCode` 要和 `data.aiTask` 对拍 —— 挑错活儿时要能看出来。
//
// ⚠ 不碰真主机：`transport` 注入假函数。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AITOOLS_AVATAR_SOURCE,
  AITOOLS_CHANNEL_ID,
  AITOOLS_SUPPLIER_TYPE,
  avatarCartoonRequest,
  isTaskDone,
  isTaskFailed,
  lastRecordRequest,
  parseGenTask,
  parseTaskStatus,
  taskResultRequest,
  upsteamMessage,
} from '../src/mcloud/aiTools.ts';
import { DEFAULT_AITOOLS_PHOTO_B64 } from '../src/mcloud/aiToolsPhoto.ts';
import { firstActionStep, stepAction } from '../src/mcloud/tasks/tokenPkActions.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import type { PkAttempt } from '../src/mcloud/tokenPkState.ts';

const NOW = '2026-11-27T04:00:00.000Z';

test('⚠ 生成请求七个字段一个不能少（少一个就回「参数错误」，会被误读成图不合格）', () => {
  const req = avatarCartoonRequest('AAAA');
  const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    'base64',
    'channelId',
    'context',
    'imageExt',
    'sendType',
    'style',
    'supplierType',
  ]);
  assert.equal(body['sendType'], 2);
  assert.equal(body['channelId'], AITOOLS_CHANNEL_ID);
  assert.equal(body['supplierType'], AITOOLS_SUPPLIER_TYPE);
  // ⚠ 抓包里明明是 JPEG，`imageExt` 却写 "png" —— 逐字照抄，别"修正"
  assert.equal(body['imageExt'], 'png');
  // ⚠ context 是**字符串**（里面又套一层 JSON），不是对象
  assert.equal(typeof body['context'], 'string');
  assert.deepEqual(JSON.parse(String(body['context'])), { source: AITOOLS_AVATAR_SOURCE });
});

test('生成 / 轮询 / 查记录三条都打到 ai.yun.139.com·且不自带 Authorization', () => {
  const reqs = [avatarCartoonRequest('AAAA'), taskResultRequest('123'), lastRecordRequest('007')];
  for (const r of reqs) {
    assert.match(String(r.url), /^https:\/\/ai\.yun\.139\.com\//);
    // 凭据由传输层按主机后缀注入（AUTH_DOMAINS 含 yun.139.com）——
    // 这里自带一份就是重复，而且会绕过 `authorizeRequest` 的口径
    const has = Object.keys(r.headers).some((k) => k.toLowerCase() === 'authorization');
    assert.equal(has, false, `${r.url} 不该自己带 Authorization`);
  }
  // 查记录那口的 body 逐字对：`command` 就是趣玩AI 的 taskId
  assert.deepEqual(JSON.parse(lastRecordRequest('007').body ?? '{}'), {
    command: '007',
    channelId: AITOOLS_CHANNEL_ID,
    appendReqParams: true,
  });
});

test('回执解析：只有 code "0000" 算成功，别的把原话带出来', () => {
  assert.equal(parseGenTask('{"success":true,"code":"0000","data":{"taskId":"123"}}'), '123');
  assert.equal(parseGenTask('{"success":true,"code":"0000","data":{}}'), undefined);
  assert.equal(parseGenTask('{"success":false,"code":"01000001","message":"参数错误"}'), undefined);
  assert.equal(parseGenTask('不是 JSON'), undefined);
  assert.equal(
    upsteamMessage('{"success":false,"code":"01000001","message":"参数错误"}'),
    '01000001 参数错误',
  );
});

test('状态机：status 1/2 是等、3 是完、别的按失败（别死等）', () => {
  assert.equal(isTaskDone({ status: 3 }), true);
  assert.equal(isTaskDone({ status: 2 }), false);
  assert.equal(isTaskFailed({ status: 1 }), false);
  assert.equal(isTaskFailed({ status: 2 }), false);
  assert.equal(isTaskFailed({ status: 3 }), false);
  assert.equal(isTaskFailed({ status: 4 }), true);
  assert.equal(isTaskFailed({ status: 0 }), true);
  // 完成那次要把结果 URL 与算法号一起解出来
  const done = parseTaskStatus(
    JSON.stringify({
      success: true,
      code: '0000',
      data: {
        status: 3,
        progress: 100,
        resultList: [{ algorithmCode: '007', fileUrlList: ['https://x/y.jpg'] }],
      },
    }),
  );
  assert.deepEqual(done, { status: 3, progress: 100, algoCode: '007', fileUrl: 'https://x/y.jpg' });
});

test('⚠ 默认图真的在、而且是能过算法的那种规格（748×748 / JPEG / q85）', async () => {
  // 不是"随便一张图"：算法对尺寸与质量有要求，纯色 256×256 会被拒（实测 01000001）。
  // 这条钉住"默认图别被人删了/换成占位图"—— 删了 `aitools` 那几个动作就跑不起来。
  const buf = Buffer.from(DEFAULT_AITOOLS_PHOTO_B64, 'base64');
  assert.ok(buf.length > 40_000, `默认图太小了（${buf.length} 字节），大概是占位图`);
  assert.ok(buf.length < 200_000, `默认图太大了（${buf.length} 字节），会让插件产物翻倍`);
  // JPEG 的 magic number
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  // SOF0 段里取尺寸（0xFFC0）
  const i = buf.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(i > 0, '找不到 SOF0 段');
  const h = buf.readUInt16BE(i + 5);
  const w = buf.readUInt16BE(i + 7);
  assert.equal(w, 748, `宽度是 ${w}，抓包里那张是 748`);
  assert.equal(h, 748, `高度是 ${h}，抓包里那张是 748`);
});

test('入口步骤：aiToolsAvatar 走 aitools-gen（不是 AI 助手那条链）', () => {
  assert.equal(firstActionStep('aiToolsAvatar'), 'aitools-gen');
  // 别的 action 别被带跑
  assert.equal(firstActionStep('aiAssistant'), 'ai-mail-sso');
  assert.equal(firstActionStep('createNote'), 'note-auth');
});

function harness(answers: string[]): { deps: TaskDeps; sent: BuiltRequest[] } {
  const sent: BuiltRequest[] = [];
  let n = 0;
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const body = answers[Math.min(n, answers.length - 1)] ?? '{}';
    n += 1;
    return { status: 200, headers: {}, body };
  }) as never;
  const deps = {
    store: undefined,
    transport,
    nowIso: NOW,
    nowMs: () => Date.parse(NOW),
    spin: () => undefined,
  } as unknown as TaskDeps;
  return { deps, sent };
}

const ATTEMPT = (): PkAttempt => ({
  taskId: 0,
  name: 'AI头像',
  key: 'aiToolsAvatar',
  step: 'aitools-gen',
  data: { aiTask: '007' },
});

test('状态机真跑一遍：生成 → 还在排队 → 完成', async () => {
  const { deps, sent } = harness([
    '{"success":true,"code":"0000","data":{"taskId":"999"}}',
    '{"success":true,"code":"0000","data":{"status":2,"progress":13}}',
    '{"success":true,"code":"0000","data":{"status":3,"progress":100,"resultList":[{"algorithmCode":"007"}]}}',
  ]);
  const a = ATTEMPT();

  const r1 = await stepAction(deps, {} as never, a);
  assert.equal(r1.finished, false, '提交生成只是"下一步"，不是完成');
  assert.match(r1.note, /已提交生成/);
  assert.equal(a.step, 'aitools-poll');
  assert.equal(a.data?.['aiTaskId'], '999');

  const r2 = await stepAction(deps, {} as never, a);
  assert.equal(r2.finished, false, 'status=2 还要等');
  assert.match(r2.note, /还在生成/);

  const r3 = await stepAction(deps, {} as never, a);
  assert.equal(r3.finished, true);
  assert.equal(r3.ok, true);
  assert.match(r3.note, /生成好了/);

  assert.equal(sent.length, 3);
  assert.match(String(sent[0]?.url), /avatar\/cartoon/);
  assert.match(String(sent[1]?.url), /async\/task\/result/);
});

test('⚠ algorithmCode 与 taskId 不符时要写在日志里（挑错活儿要看得见）', async () => {
  const { deps } = harness([
    '{"success":true,"code":"0000","data":{"taskId":"999"}}',
    '{"success":true,"code":"0000","data":{"status":3,"progress":100,"resultList":[{"algorithmCode":"004"}]}}',
  ]);
  const a = ATTEMPT();
  await stepAction(deps, {} as never, a);
  const r = await stepAction(deps, {} as never, a);
  assert.equal(r.ok, true, '算法号不符不改变"做成了"这个结论');
  assert.match(r.note, /algorithmCode=004/);
  assert.match(r.note, /与 taskId 007 不符/);
});

test('生成被拒：把上游原话带进失败原因（别只说"没成"）', async () => {
  const { deps } = harness(['{"success":false,"code":"01000001","message":"参数错误"}']);
  const a = ATTEMPT();
  const r = await stepAction(deps, {} as never, a);
  assert.equal(r.finished, true);
  assert.equal(r.ok, false);
  assert.match(r.note, /01000001 参数错误/);
});

test('轮询次数打满就停手，不无限等', async () => {
  const { deps } = harness([
    '{"success":true,"code":"0000","data":{"taskId":"999"}}',
    '{"success":true,"code":"0000","data":{"status":2}}',
  ]);
  const a = ATTEMPT();
  await stepAction(deps, {} as never, a);
  // 一直 status=2 ⇒ 打满 AI_MAX_POLLS 后必须 fail
  let last = await stepAction(deps, {} as never, a);
  for (let i = 0; i < 20 && !last.finished; i++) last = await stepAction(deps, {} as never, a);
  assert.equal(last.finished, true);
  // ⚠ **不是失败**：生成已经提交、服务端在算，只是没等到 status 3。
  //   真判据是后面那次回读 —— 这里说成"没成"会写进运行记录误导用户（真跑踩过）。
  assert.equal(last.ok, true, '打满次数不等于没做成');
  assert.match(last.note, /还在算/);
  assert.equal(/没成|失败/.test(last.note), false, '这句话里不许出现"没成/失败"');
});
