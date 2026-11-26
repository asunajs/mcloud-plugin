// 动作层（`tokenPkActions.stepAction`）的 AI 相机那条链：识图 → 对话。
//
// 这一篇只钉一件**会漏在用户网盘里的事**：`aiRecognize` 会在云盘落一个文件，
// 不登记成"我们造的"，链尾 `runOwnedCleanup` 就不会删它 —— 每天跑就天天堆一个。
// 与 2026-11-12 那条「算力大作战每天上传图片却没有清理」是同一类，只是那一口漏了。
//
// ⚠ 不碰真主机：transport 是注入的假函数；`account` 用本仓的 `desEncryptBase64` 自己造。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stepAction } from '../src/mcloud/tasks/tokenPkActions.ts';
import { ownedFileIds } from '../src/mcloud/tasks/ownedFiles.ts';
import { desEncryptBase64 } from '../src/crypto/des.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { jwtKey } from '../src/mcloud/sessionExchange.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { TaskDeps } from '../src/mcloud/tasks/base.ts';
import type { PkAttempt } from '../src/mcloud/tokenPkState.ts';

const NOW = '2026-11-26T10:00:00.000Z';
const FILE_ID = 'FILEID-from-recognize';

function harness(): { deps: TaskDeps; sent: BuiltRequest[] } {
  const store = memStore();
  store.ensureSchema();
  const made = upsertAccount(store, 'Basic cGM6dG9rZW4=', NOW, '移动');
  const bag = scoped(rawStoreOf(store), made.account.id);
  bag.setState(jwtKey(bag), JSON.stringify({ at: NOW, jwt: 'JWT', referer: '', fingerprint: 'f' }), NOW);
  bag.setState(
    SESSION_KEY,
    JSON.stringify({ cookie: 'c=1', jwt: 'JWT', deviceId: 'D1', userAgent: 'UA', savedAt: NOW }),
    NOW,
  );

  const account = desEncryptBase64('13800138000', '139_mail');
  const sent: BuiltRequest[] = [];
  const transport = ((req: BuiltRequest) => {
    sent.push(req);
    const url = String(req.url);
    if (url.includes('querySpecTokenV2')) {
      return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { token: 'SSO' } }) };
    }
    if (url.includes('inlogin.action')) {
      return { status: 200, headers: {}, body: JSON.stringify({ var: { sid: 'SID', rmkey: 'RMKEY' } }) };
    }
    if (url.includes('queryUserToken')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ var: { data: { data: { account, token: 'TOK', userDomainId: 'DOM' } } } }),
      };
    }
    if (url.includes('aiRecognize')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ success: true, data: { fileId: FILE_ID, taskId: '7' } }),
      };
    }
    if (url.includes('assistant/chat/v2/add')) {
      return { status: 200, headers: {}, body: 'data: {"data":{"flowResult":{"outContent":"hi"}}}\n\n' };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0 }) };
  }) as never;
  const deps = { store, transport, nowIso: NOW, now: () => NOW, baseUrl: undefined } as unknown as TaskDeps;
  return { deps, sent };
}

test('AI 相机那条链：识图落的文件要登记成"我们造的"（否则清理那一步不会删）', async () => {
  const { deps, sent } = harness();
  const attempt: PkAttempt = { taskId: 585, name: '体验AI相机', key: 'aiCamera', step: 'ai-mail-sso' };
  const session = { jwt: 'JWT', cookie: 'c=1', userAgent: 'UA', deviceId: 'D1' };
  for (let i = 0; i < 12; i++) {
    const r = await stepAction(deps, session, attempt);
    if (r.finished) break;
  }
  const urls = sent.map((x) => String(x.url));
  assert.ok(urls.some((u) => u.includes('aiRecognize')), '要识图');
  assert.ok(urls.some((u) => u.includes('assistant/chat/v2/add')), '要对话');
  assert.deepEqual(ownedFileIds(deps), [FILE_ID], '识图落的文件必须进"我们造的"清单');
});

test('识图落的那张图，链尾清理会真的把它移进回收站（闭环）', async () => {
  const { deps, sent } = harness();
  const attempt: PkAttempt = { taskId: 585, name: '体验AI相机', key: 'aiCamera', step: 'ai-mail-sso' };
  const session = { jwt: 'JWT', cookie: 'c=1', userAgent: 'UA', deviceId: 'D1' };
  for (let i = 0; i < 12; i++) {
    const r = await stepAction(deps, session, attempt);
    if (r.finished) break;
  }
  assert.deepEqual(ownedFileIds(deps), [FILE_ID], '先确认登记上了');

  const { runOwnedCleanup } = await import('../src/mcloud/tasks/ownedFiles.ts');
  const before = sent.length;
  const out = await runOwnedCleanup(deps);
  assert.equal(out.ok, true, out.note);
  const trash = sent.slice(before).filter((x) => /trash|recycle/i.test(String(x.url)));
  assert.equal(trash.length, 1, `要发一发回收站请求（实际 ${trash.length}）`);
  assert.match(String(trash[0]!.body ?? ''), new RegExp(FILE_ID), '要删的就是那张图');
  assert.deepEqual(ownedFileIds(deps), [], '删干净之后名单要清空');
});
