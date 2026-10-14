// 推送：10 个渠道的请求构造 + 投递编排。
//
// # 这一层守的是什么
//
// 推送的每个渠道都是"把一条消息变成一个请求"，而**请求形状错了不会报错** ——
// 上游回一个 200 带 `{"errcode":40013}`，或者干脆回 200 什么都不做。
// 用户看到的是"推送没收到"，而排查方向可能是网络、可能是 token、可能是模板。
//
// 所以这里**逐字段**钉住每个渠道的 URL 与方法、以及三处"看着像笔误但不能改"的原文：
//
//   1. 钉钉正文前面那个**前导空格**
//   2. Server酱的 `desp` 里换行**翻倍**
//   3. Telegram 的 `chat_id` / `disable_web_page_preview` 是 **snake_case**
//      （同一个配置里 `apiHost` 是 camelCase —— 混用是原文，不是笔误）
//
// 第三条最阴：跟着"统一成一种"改，表现是这两个字段**永远读不到**，
// 于是"缺 chat_id"的跳过分支被误触发 —— 而跳过**不是失败**，日志里看不出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS,
  CHANNEL_LABELS,
  DEFAULT_TITLE,
  buildBark,
  buildCustomPost,
  buildDingTalk,
  buildPushplus,
  buildServerChan,
  buildTgBot,
  buildTwoIm,
  buildWorkWeixinBot,
  buildWorkWeixinMessage,
  buildWorkWeixinToken,
  configuredChannels,
  encodeUriComponent,
  formUrlencode,
  hmacSha256Base64,
  jsTruthy,
  sendPush,
  type Built,
  type PushConfig,
} from '../src/mcloud/push.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';

const req = (b: Built): BuiltRequest => {
  assert.ok(b.ok, `期望建出请求，实际跳过：${b.ok ? '' : b.skip}`);
  return b.request;
};
const bodyOf = (r: BuiltRequest): Record<string, unknown> => JSON.parse(r.body ?? '{}');

// ══════════════════════════════ 渠道表 ══════════════════════════════

test('恰好 10 个渠道，名字与参考实现一致', () => {
  assert.equal(CHANNELS.length, 10);
  assert.deepEqual(CHANNELS, [
    'pushplus',
    'serverChan',
    'workWeixin',
    'workWeixinBot',
    'tgBot',
    'bark',
    'twoIm',
    'dingTalk',
    'email',
    'customPost',
  ]);
  assert.equal(CHANNEL_LABELS.serverChan, 'Server酱');
  assert.equal(CHANNEL_LABELS.workWeixin, '企业微信推送');
  assert.equal(CHANNEL_LABELS.workWeixinBot, '企业微信Bot推送');
  assert.equal(CHANNEL_LABELS.tgBot, 'Telegram Bot 推送');
  assert.equal(CHANNEL_LABELS.bark, 'Bark ios 推送');
  assert.equal(CHANNEL_LABELS.twoIm, '回逍推送');
  assert.equal(CHANNEL_LABELS.dingTalk, '钉钉推送');
  assert.equal(CHANNEL_LABELS.email, '邮件消息');
  assert.equal(CHANNEL_LABELS.customPost, '自定义消息');
  assert.equal(DEFAULT_TITLE, '云盘任务');
});

// ══════════════════════════════ ① pushplus ② Server酱 ══════════════════════════════

test('pushplus：`http://`（**不是 https**）+ token/title/content', () => {
  const r = req(buildPushplus({ token: 'T' }, '标题', '正文'));
  // ⚠ 参考实现里就是 `http://www.pushplus.plus/send` —— 写成 https 不是"顺手改好"
  assert.equal(r.url, 'http://www.pushplus.plus/send');
  assert.equal(r.method, 'POST');
  assert.deepEqual(bodyOf(r), { token: 'T', title: '标题', content: '正文' });
});

test('⚠ Server酱：`desp` 里每个换行**翻倍**（TS 的原文）', () => {
  const r = req(buildServerChan({ token: 'T' }, '标题', 'a\nb\nc'));
  assert.equal(r.url, 'https://sctapi.ftqq.com/T.send');
  const b = bodyOf(r);
  assert.equal(b['text'], '标题');
  assert.equal(b['title'], '标题');
  // `\n` → `\n\n`：不翻倍的话 Server酱 把整段压成一行
  assert.equal(b['desp'], 'a\n\nb\n\nc');
  assert.notEqual(b['desp'], 'a\nb\nc');
});

test('pushplus / Server酱 的 `extra` 会并进请求体（且不覆盖具名字段）', () => {
  const r = req(buildPushplus({ token: 'T', extra: { topic: 'x' } }, 't', 'b'));
  assert.equal(bodyOf(r)['topic'], 'x');
  assert.equal(bodyOf(r)['token'], 'T');
});

// ══════════════════════════════ ③ 企业微信（两步） ══════════════════════════════

test('企业微信**第一步**：corpid + corpsecret 换 access_token', () => {
  const r = buildWorkWeixinToken({ corpid: 'C', corpsecret: 'S' });
  assert.equal(r.url, 'https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  assert.deepEqual(bodyOf(r), { corpid: 'C', corpsecret: 'S' });
  // 缺字段时**不塞 null**（塞了上游会说"参数错"，而真正的原因是没有配置）
  const bare = buildWorkWeixinToken({});
  assert.deepEqual(bodyOf(bare), {});
});

test('企业微信**第二步**：动态类型键 + `touser` 默认 `@all`', () => {
  const r = buildWorkWeixinMessage({ agentid: 7 }, 'TOK', '标题', '正文');
  assert.equal(r.url, 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOK');
  const b = bodyOf(r);
  assert.equal(b['touser'], '@all', '不给就用 @all');
  assert.equal(b['msgtype'], 'text');
  assert.equal(b['agentid'], 7);
  assert.deepEqual(b['text'], { content: '标题\n\n正文' });
  // 换 msgtype ⇒ 那个键也跟着换（不是恒定写 text）
  const md = bodyOf(buildWorkWeixinMessage({ msgtype: 'markdown' }, 'T', 'a', 'b'));
  assert.equal(md['msgtype'], 'markdown');
  assert.deepEqual(md['markdown'], { content: 'a\n\nb' });
  assert.ok(!('text' in md), '换了 msgtype 就不该再写 text 键');
});

test('企业微信机器人：一个 webhook URL', () => {
  const r = req(buildWorkWeixinBot({ url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K' }, 'a', 'b'));
  assert.ok(r.url.includes('webhook/send?key=K'));
  assert.deepEqual(bodyOf(r)['text'], { content: 'a\n\nb' });
});

// ══════════════════════════════ ⑤ Telegram ══════════════════════════════

test('⚠ Telegram：`chat_id` / `disable_web_page_preview` 是 **snake_case**', () => {
  // 跟着"统一成 camelCase"改的表现是这两个字段**永远读不到** ⇒
  // "缺 chat_id"的跳过分支被误触发，而**跳过不是失败**，日志里看不出来。
  const r = req(buildTgBot({ token: 'T', chat_id: -100123, disable_web_page_preview: false }, '标题', '正文'));
  const b = bodyOf(r);
  assert.ok('chat_id' in b, 'chat_id 必须是 snake_case');
  assert.ok(!('chatId' in b), '不许驼峰化');
  assert.ok('disable_web_page_preview' in b);
  assert.equal(b['disable_web_page_preview'], false, '给了 false 要用 false（不是回落默认的 true）');
  assert.equal(b['chat_id'], -100123, '群 ID 是负数，别当"假值"跳过');
  assert.equal(b['text'], '标题\n\n正文');
});

test('Telegram：缺 token 或 chat_id 就**跳过**（不是塞个 null 发上去）', () => {
  assert.equal(buildTgBot({ token: '', chat_id: 1 }, 'a', 'b').ok, false);
  assert.equal(buildTgBot({ token: 'T', chat_id: '' }, 'a', 'b').ok, false);
  assert.equal(buildTgBot({ token: 'T', chat_id: 0 }, 'a', 'b').ok, false, 'JS 真值：0 算缺');
  assert.equal(buildTgBot({ token: 'T', chat_id: null }, 'a', 'b').ok, false);
  assert.equal(buildTgBot({ token: 'T', chat_id: 1 }, 'a', 'b').ok, true);
  // 跳过时要说清缺什么
  const b = buildTgBot({ token: 'T', chat_id: '' }, 'a', 'b');
  assert.ok(!b.ok && b.skip.includes('chat_id'), b.ok ? '' : b.skip);
});

test('Telegram：`apiHost` 可换（自建反代）；`text` 永远收尾（在 extra 之后）', () => {
  const r = req(buildTgBot({ token: 'T', chat_id: 1, apiHost: 'tg.example.com' }, 'a', 'b'));
  assert.equal(r.url, 'https://tg.example.com/botT/sendMessage');
  // extra 里塞一个同名 `text` ⇒ 必须被真正的 text 覆盖（TS 的字段顺序就是这样）
  const b = bodyOf(req(buildTgBot({ token: 'T', chat_id: 1, extra: { text: '坏的' } }, 'a', 'b')));
  assert.equal(b['text'], 'a\n\nb');
});

test('`jsTruthy`：JS 的真值口径（空串 / 0 / null / NaN 都算假）', () => {
  assert.equal(jsTruthy(''), false);
  assert.equal(jsTruthy(0), false);
  assert.equal(jsTruthy(null), false);
  assert.equal(jsTruthy(undefined), false);
  assert.equal(jsTruthy(false), false);
  assert.equal(jsTruthy(NaN), false);
  assert.equal(jsTruthy('x'), true);
  assert.equal(jsTruthy(1), true);
  assert.equal(jsTruthy(-1), true);
  assert.equal(jsTruthy([]), true, '空数组在 JS 里是真值');
});

// ══════════════════════════════ ⑥ Bark ⑦ 回逍 ══════════════════════════════

test('Bark：key 进路径，`level` 默认 `passive`；缺 key 跳过', () => {
  const r = req(buildBark({ key: 'K' }, '标题', '正文'));
  assert.equal(r.url, 'https://api.day.app/K');
  const b = bodyOf(r);
  assert.equal(b['title'], '标题');
  assert.equal(b['body'], '正文');
  assert.equal(b['level'], 'passive');
  assert.equal(bodyOf(req(buildBark({ key: 'K', level: 'timeSensitive' }, 'a', 'b')))['level'], 'timeSensitive');
  assert.equal(buildBark({ key: '' }, 'a', 'b').ok, false);
});

test('回逍：`key` / `sid` 走查询串，其余走请求体', () => {
  const r = req(buildTwoIm({ key: 'K', sid: 'S' }, '标题', '正文'));
  assert.ok(r.url.startsWith('https://api.2im.cn/push?'));
  assert.ok(r.url.includes('key=K'));
  assert.ok(r.url.includes('sid=S'));
  const b = bodyOf(r);
  assert.equal(b['title'], '标题');
  assert.equal(b['content'], '正文');
  assert.equal(b['msgtype'], 'text');
  // query 里的字段也进查询串
  const r2 = req(buildTwoIm({ key: 'K', sid: 'S', query: { plat: 'ios', group: 'g' } }, 'a', 'b'));
  assert.ok(r2.url.includes('plat=ios') && r2.url.includes('group=g'), r2.url);
});

// ══════════════════════════════ ⑧ 钉钉 ══════════════════════════════

test('⚠ 钉钉：正文前面那个**前导空格**是原文，别顺手删掉', () => {
  const r = req(buildDingTalk({ token: 'T' }, '标题', '正文', 1730000000000));
  const b = bodyOf(r);
  assert.deepEqual(b['text'], { content: ' 标题\n\n正文' }, '前导空格没了就对不上原文');
  assert.equal(b['msgtype'], 'text');
  assert.ok(!r.url.includes('timestamp='), '没 secret 就不加签');
});

test('⚠ 钉钉签名：`base64(HmacSHA256(secret, ts + "\\n" + secret))`（独立向量）', () => {
  // 期望值由 Node 的 crypto 独立算出（不是"跑一遍看看是多少"）
  const secret = 'SEC8f0d1e2a3b4c5d6e7f8a9b0c1d2e3f4a';
  const ts = 1730000000000;
  assert.equal(
    hmacSha256Base64(secret, `${ts}\n${secret}`),
    'qR6aOWev12Grv19mEIbWWABrBv9QAAe8nWTN1cgy2HE=',
  );
  const r = req(buildDingTalk({ token: 'T', secret }, 'a', 'b', ts));
  assert.ok(r.url.includes(`&timestamp=${ts}`), r.url);
  // ⚠ 签名要 `encodeURIComponent` 转义（base64 里有 `+` `/` `=`）
  assert.ok(
    r.url.includes('sign=qR6aOWev12Grv19mEIbWWABrBv9QAAe8nWTN1cgy2HE%3D'),
    `签名没转义：${r.url}`,
  );
});

test('钉钉：`secret` 是空串 ⇒ 不加签（不是"加一个空签"）', () => {
  const r = req(buildDingTalk({ token: 'T', secret: '' }, 'a', 'b', 1));
  assert.ok(!r.url.includes('timestamp='));
});

test('`encodeUriComponent`：空格编成 `%20` 不是 `+`（钉钉签名对不上就死在这）', () => {
  assert.equal(encodeUriComponent('a b'), 'a%20b');
  assert.notEqual(encodeUriComponent('a b'), 'a+b');
  assert.equal(encodeUriComponent('a=b'), 'a%3Db');
  assert.equal(formUrlencode([['k', 'a b'], ['j', 'x&y']]), 'k=a%20b&j=x%26y');
});

// ══════════════════════════════ ⑩ 自定义模板 ══════════════════════════════

test('⚠ 自定义模板：URL 与请求体的替换规则**不一样**', () => {
  // URL：只替换**第一次**，值转义
  const r = buildCustomPost(
    { url: 'https://x/{title}?t={title}', data: { a: '{title}' } },
    '标 题',
    '正文',
  );
  assert.ok(r.ok);
  assert.equal(r.request.url, 'https://x/%E6%A0%87%20%E9%A2%98?t={title}', 'URL 只换第一次且转义');
  // 请求体：**全局**替换且**不转义**
  const b = bodyOf(r.request);
  assert.equal(b['a'], '标 题', '请求体不转义，且该出现的地方都换');
});

test('自定义模板：正文里的换行能活（替换后转成字面量再解析回去）', () => {
  const r = buildCustomPost({ url: 'https://x', data: { msg: '{text}' } }, 't', '第一行\n第二行');
  assert.ok(r.ok);
  assert.equal(bodyOf(r.request)['msg'], '第一行\n第二行', '换行被吃掉了');
});

test('自定义模板：标题里带引号会让解析失败 ⇒ 报错（TS 的 catch）', () => {
  const r = buildCustomPost({ url: 'https://x', data: { msg: '{title}' } }, '带"引号"的标题', 'b');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && 'error' in r && r.error.includes('JSON'), r.ok ? '' : JSON.stringify(r));
});

test('自定义模板：没有 URL ⇒ 跳过；`data` 优先于 `body`；method 默认 POST', () => {
  const skip = buildCustomPost({ url: '' }, 'a', 'b');
  assert.ok(!skip.ok && 'skip' in skip);
  // `data` 只要存在就取胜（哪怕 body 也在）
  const r = buildCustomPost({ url: 'https://x', data: { from: 'data' }, body: { from: 'body' } }, 'a', 'b');
  assert.ok(r.ok && bodyOf(r.request)['from'] === 'data');
  assert.equal(r.request.method, 'POST');
  const g = buildCustomPost({ url: 'https://x', method: 'get' }, 'a', 'b');
  assert.ok(g.ok && g.request.method === 'GET', 'method 要大写');
});

// ══════════════════════════════ 投递编排 ══════════════════════════════

/** 一个假宿主：记录发出去的请求，按 URL 里的关键词决定成败。 */
function fakeDeps(failOn: string[] = []) {
  const sent: BuiltRequest[] = [];
  const smtps: Record<string, unknown>[] = [];
  return {
    sent,
    smtps,
    deps: {
      http: (r: BuiltRequest) => {
        sent.push(r);
        const hit = failOn.find((f) => r.url.includes(f));
        if (hit !== undefined) {
          return { ok: false, status: 0, body: '', error: `连不上 ${hit}` };
        }
        // 企业微信第一步要回一个 access_token
        if (r.url.includes('/gettoken')) {
          return { ok: true, status: 200, body: JSON.stringify({ access_token: 'AT' }), error: undefined };
        }
        return { ok: true, status: 200, body: '{"errcode":0}', error: undefined };
      },
      smtp: (o: Record<string, unknown>) => {
        smtps.push(o);
        return { ok: true, response: '250 message accepted' };
      },
      nowMs: () => 1730000000000,
      log: () => {},
    },
  };
}

test('一个都没配 ⇒ 说清"没有配置推送渠道"（不是"发了 0 条成功"）', () => {
  const { deps, sent } = fakeDeps();
  const r = sendPush(deps, {}, 't', 'b');
  assert.equal(r.results.length, 0);
  assert.equal(sent.length, 0, '一个请求都不该发');
  assert.equal(r.line, '没有配置推送渠道');
});

test('10 个渠道全配上 ⇒ 全发到（企业微信是两步 ⇒ 11 个请求）', () => {
  const { deps, sent, smtps } = fakeDeps();
  const cfg: PushConfig = {
    pushplus: { token: 'A' },
    serverChan: { token: 'B' },
    workWeixin: { corpid: 'C', corpsecret: 'S', agentid: 1 },
    workWeixinBot: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K' },
    tgBot: { token: 'T', chat_id: 1 },
    bark: { key: 'K' },
    twoIm: { key: 'K', sid: 'S' },
    dingTalk: { token: 'D' },
    email: { host: 'smtp.example.com', from: 'a@b.c', pass: 'p', to: 'd@e.f' },
    customPost: [{ url: 'https://custom.example.com/hook' }],
  };
  const r = sendPush(deps, cfg, '标题', '正文');
  assert.equal(r.sent, 10, r.line);
  assert.equal(r.failed, 0, r.line);
  assert.equal(r.skipped, 0, r.line);
  // 邮件走 smtp 不走 HTTP
  assert.equal(smtps.length, 1);
  assert.equal(smtps[0]!['host'], 'smtp.example.com');
  assert.equal(smtps[0]!['subject'], '标题');
  assert.equal(smtps[0]!['text'], '正文');
  // HTTP 请求数 = 10 个渠道 − 邮件（走 smtp）+ 企业微信多一个换 token
  //   = 9 + 1 = 10
  assert.equal(sent.length, 10, sent.map((s) => s.url).join('\n'));
  assert.equal(configuredChannels(cfg).length, 10);
});

test('⚠ 一个渠道失败**不影响别的**（推送是最不能"因为一个挂了就全不发"的东西）', () => {
  const { deps } = fakeDeps(['pushplus.plus']);
  const r = sendPush(
    deps,
    { pushplus: { token: 'A' }, serverChan: { token: 'B' }, bark: { key: 'K' } },
    't',
    'b',
  );
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 2, r.line);
  assert.equal(r.results.find((x) => x.channel === 'pushplus')!.outcome, 'failed');
  assert.equal(r.results.find((x) => x.channel === 'serverChan')!.outcome, 'sent');
  assert.equal(r.results.find((x) => x.channel === 'bark')!.outcome, 'sent');
  assert.ok(r.line.includes('2 个渠道发到了') && r.line.includes('1 个失败'), r.line);
});

test('⚠ 企业微信拿不到 `access_token` ⇒ 失败并说清，**不拿假 token 再打一枪**', () => {
  const sent: BuiltRequest[] = [];
  const deps = {
    http: (r: BuiltRequest) => {
      sent.push(r);
      // 200 但没有 access_token（上游回了 errcode）
      return { ok: true, status: 200, body: '{"errcode":40013,"errmsg":"invalid corpid"}', error: undefined };
    },
    smtp: () => ({ ok: true, response: '' }),
    nowMs: () => 0,
    log: () => {},
  };
  const r = sendPush(deps, { workWeixin: { corpid: 'bad', corpsecret: 's' } }, 't', 'b');
  assert.equal(r.failed, 1);
  assert.equal(sent.length, 1, '只该发那一个换 token 的请求 —— 假 token 那一枪不许发');
  assert.ok(r.results[0]!.note.includes('access_token'), r.results[0]!.note);
});

test('跳过**不是失败**（没配全不算错）', () => {
  const { deps } = fakeDeps();
  const r = sendPush(deps, { tgBot: { token: 'T', chat_id: '' } }, 't', 'b');
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.sent, 0);
  assert.ok(r.line.includes('跳过'), r.line);
});

test('邮件失败要带上服务器那句原话（`535 bad credentials` 这种）', () => {
  const deps = {
    http: () => ({ ok: true, status: 200, body: '{}', error: undefined }),
    smtp: () => {
      throw new Error('535 bad credentials');
    },
    nowMs: () => 0,
    log: () => {},
  };
  const r = sendPush(deps, { email: { host: 'h', from: 'f@x.y', pass: 'bad' } }, 't', 'b');
  assert.equal(r.failed, 1);
  assert.ok(r.results[0]!.note.includes('535 bad credentials'), r.results[0]!.note);
});

test('邮件缺 host / from ⇒ 跳过，不去连一个空地址', () => {
  const { deps, smtps } = fakeDeps();
  const r = sendPush(deps, { email: { host: '', from: '', pass: 'p' } }, 't', 'b');
  assert.equal(r.skipped, 1);
  assert.equal(smtps.length, 0);
});

test('HTTP 非 2xx 算失败（**不看响应体里的 `errcode`**）', () => {
  const deps = {
    http: () => ({ ok: true, status: 502, body: 'bad gateway', error: undefined }),
    smtp: () => ({ ok: true, response: '' }),
    nowMs: () => 0,
    log: () => {},
  };
  const r = sendPush(deps, { bark: { key: 'K' } }, 't', 'b');
  assert.equal(r.failed, 1);
  assert.ok(r.results[0]!.note.includes('502'), r.results[0]!.note);
});

test('`configuredChannels`：只看有没有这一栏，不判配得全不全', () => {
  assert.deepEqual(configuredChannels({}), []);
  assert.deepEqual(configuredChannels({ pushplus: { token: '' } }), ['pushplus'], '空 token 也算"配了这一栏"');
  assert.deepEqual(configuredChannels({ customPost: [] }), [], '空模板数组不算配了');
  assert.deepEqual(configuredChannels({ customPost: [{ url: 'https://x' }] }), ['customPost']);
});
