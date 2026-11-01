// 专用动作的纯解析层 —— 没有网络也能钉住形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAiAuth,
  firstField,
  mailCode,
  parseLinkIds,
  parseMailSession,
  parseQueryUserToken,
  parseSse,
  peActiveReportRequest,
} from '../src/mcloud/tasks/appTaskExtra.ts';
import { desEncryptBase64 } from '../src/crypto/des.ts';

test('getOutLink：收集 linkID（深一层也收）', () => {
  const body = JSON.stringify({
    code: '0',
    data: { getOutLinkRes: { getOutLinkResSet: [{ linkID: 'a' }, { linkID: 'b' }] } },
  });
  assert.deepEqual(parseLinkIds(body), ['a', 'b']);
  assert.deepEqual(parseLinkIds('{}'), []);
  assert.deepEqual(parseLinkIds('not json'), []);
});

test('firstField：XML 属性式与 JSON 式两种都收', () => {
  assert.equal(firstField('<string name="mid">123</string>', 'mid'), '123');
  assert.equal(firstField('{"mid":"456"}', 'mid'), '456');
  assert.equal(firstField('<string name="mid"></string>', 'mid'), undefined);
  assert.equal(firstField('{}', 'mid'), undefined);
});

test('mailCode：只有 S_OK 算成', () => {
  assert.equal(mailCode('{"code":"S_OK"}').ok, true);
  assert.equal(mailCode('{"code":"E_FAIL","summary":"x"}').ok, false);
  assert.equal(mailCode('not json').ok, false);
});

test('queryUserToken：解出 account/token/userDomainId，并派生 AI 鉴权', () => {
  const account = desEncryptBase64('13800138000', '139_mail');
  const body = JSON.stringify({ var: { data: { data: { account, token: 'T', userDomainId: 'D' } } } });
  const t = parseQueryUserToken(body);
  assert.ok(t);
  const auth = deriveAiAuth(t!);
  assert.ok(auth);
  assert.equal(auth!.phone, '13800138000');
  assert.equal(auth!.userDomainId, 'D');
  assert.match(auth!.authorization, /^Basic /);
  assert.equal(parseQueryUserToken('{}'), undefined);
});

test('SSE：收 flowResult.outContent，事件数为 0 视为没成', () => {
  const body = 'data: {"data":{"flowResult":{"outContent":"你"}}}\n\ndata: {"data":{"outContent":"好"}}\n\n';
  const r = parseSse(body);
  assert.equal(r.events, 2);
  assert.equal(r.text, '你好');
  const empty = parseSse('');
  assert.equal(empty.events, 0);
  assert.equal(empty.text, '');
  // ⚠ 光有 events 没用：现场 2026-11-01 只印得出「events=1」，说不出为什么没内容。
  //   信封里的 code/message 要留下来（Rust 的 `SseChat` 就是这么留的）。
  const err = parseSse('data: {"code":"40000001","message":"内容审核未通过"}\n\n');
  assert.equal(err.events, 1);
  assert.equal(err.text, '');
  assert.equal(err.code, '40000001');
  assert.equal(err.message, '内容审核未通过');
});

test('parseMailSession：必须同时有 sid/rmkey', () => {
  assert.deepEqual(parseMailSession('{"var":{"sid":"s","rmkey":"r"}}'), { sid: 's', rmkey: 'r' });
  assert.equal(parseMailSession('{"var":{"sid":"s"}}'), undefined);
  assert.equal(parseMailSession('{}'), undefined);
});

test('PE 活跃上报（1004 发邮件后的那一枪）：头/体照参考实现', () => {
  // 现场 2026-11-01：光"发信 + 打卡"，1004 一直停在第 1 步；补上这一枪才翻 FINISH。
  // 参考实现把体 gzip 了，我们发明文 —— 实测同一个口回 S_OK（见函数注释）。
  const req = peActiveReportRequest({ sid: 'S1', rmkey: 'R1' }, 'CG1', Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.equal(req.method, 'POST');
  assert.ok(req.url.startsWith('https://pesupport.mail.10086.cn/logreport/s?func=user:activeAction'));
  assert.ok(req.url.includes('sid=S1'));
  assert.ok(req.url.includes('cguid=CG1'));
  assert.match(req.headers['Authorization'] ?? '', /^Basic [0-9a-f]{32}$/);
  assert.equal(req.headers['Cookie'], 'RMKEY=R1');
  const body = JSON.parse(req.body ?? '{}') as { body?: { logDatas?: { eventType?: string; eventTime?: string }[] } };
  assert.equal(body.body?.logDatas?.[0]?.eventType, '3', 'eventType 3 = 发邮件');
  assert.equal(body.body?.logDatas?.[0]?.eventTime, '2026-11-01 14:30:00', '东八区墙钟');
});

test('firstField：键是**单引号**也要认（1029 账单的 mid 就长这样）', () => {
  // 实测 `mbox:searchMessages`：{'code':'S_OK','var':[{'mid':"d4864e…",…}]}
  // 只认 `"mid":"…"` 的话账单那条永远"取不到 mid"（2026-11-01 现场）。
  const body = "{'code':'S_OK','var':[{'mid':\"d4864e05ed3c2dcf00000001\",'fid':1}]}";
  assert.equal(firstField(body, 'mid'), 'd4864e05ed3c2dcf00000001');
  // 标准 JSON 与 XML 那两种老形状照旧
  assert.equal(firstField('{"mid":"abc"}', 'mid'), 'abc');
  assert.equal(firstField('<object><string name="mid">xyz</string></object>', 'mid'), 'xyz');
});

test('firstField：值里带撇号不能截半截、无引号值要认、XML 要 trim', () => {
  assert.equal(firstField('{"subject":"it\'s mine","mid":"a"}', 'subject'), "it's mine");
  assert.equal(firstField('{\'mid\':"abc"}', 'mid'), 'abc');
  // 参考实现的第三支：值不带引号（实拍的壳混着用）
  assert.equal(firstField('{"mid":12345,"fid":1}', 'mid'), '12345');
  assert.equal(firstField('<string name="mid"> 123 </string>', 'mid'), '123');
});

test('mailCode：值里带撇号也要认 S_OK；0000 不算成（参考实现只认 S_OK）', () => {
  assert.deepEqual(mailCode("{'code':'S_OK','summary':\"can't\"}").ok, true);
  assert.equal(mailCode('{"code":"0000"}').ok, false, '0000 不是 S_OK');
  assert.equal(mailCode("{'code':'E_FAIL','summary':'boom'}").ok, false);
  assert.match(mailCode('not json at all').summary, /响应不是 JSON/);
});
