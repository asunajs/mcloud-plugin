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
  assert.deepEqual(parseSse(body), { events: 2, text: '你好' });
  assert.deepEqual(parseSse(''), { events: 0, text: '' });
});

test('parseMailSession：必须同时有 sid/rmkey', () => {
  assert.deepEqual(parseMailSession('{"var":{"sid":"s","rmkey":"r"}}'), { sid: 's', rmkey: 'r' });
  assert.equal(parseMailSession('{"var":{"sid":"s"}}'), undefined);
  assert.equal(parseMailSession('{}'), undefined);
});
