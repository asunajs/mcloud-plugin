// 禁止串号（R8）：**结构性**保证，不靠调用方自觉。
//
// 2026-11-27 真实事故：领奖页选了 A，读回 B 的待领取、短信也发到 B；
// GitHub issue #2 的 `10010021 validateRisk` 是同一个根因。
// 原因是请求里混了两个账号的凭据（A 的 jwttoken + 入口层补的"当前账号" Authorization）。
//
// 修法不是"记得把票对齐"，而是让**串号发不出去**：
//   ① `bindAccountCredentials` 把整条请求的账号头清干净、只注入本账号那份；
//   ② `authorizeRequest` 见请求自带**别的账号**的 Authorization 就**抛错**；
//   ③ 路由层一律用 `transportForStore` / `transportForAccount`（绑死账号的 transport）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeRequest,
  bindAccountCredentials,
} from '../src/mcloud/cloudUpload.ts';
import { transportForAccount, transportForStore } from '../src/mcloud/accountRuntime.ts';
import { memStore } from '../src/store/memory.ts';
import { rawStoreOf, scoped } from '../src/store/scoped.ts';
import { upsertAccount } from '../src/mcloud/accounts.ts';
import type { BuiltRequest } from '../src/mcloud/h5.ts';
import type { Transport } from '../src/mcloud/client.ts';

const NOW = '2026-11-27T14:00:00.000Z';
const AUTH_A = 'Basic YTph'; // 两个号的凭据，内容不重要，只要不同
const AUTH_B = 'Basic Yjpi';

function req(headers: Record<string, string> = {}): BuiltRequest {
  return { url: 'https://m.mcloud.139.com/ycloud/x', method: 'GET', headers, body: undefined };
}

test('⚠ `bindAccountCredentials` 把**别人的票全丢掉**，只留本账号那份', () => {
  const mixed = req({
    jwttoken: 'JWT-A',
    Authorization: AUTH_B, // 别人的
    cookie: 'c=B-account', // 别人的
    'x-yun-tid': 'keep-me', // 不是账号头，留着
  });
  const bound = bindAccountCredentials(mixed, { auth: AUTH_A, jwt: 'JWT-A2', cookie: 'c=A' });
  assert.equal(bound.headers['Authorization'], AUTH_A);
  assert.equal(bound.headers['jwttoken'], 'JWT-A2');
  assert.equal(bound.headers['cookie'], 'c=A');
  assert.equal(bound.headers['x-yun-tid'], 'keep-me', '非账号头要原样保留');
  // 入参不被改（纯函数）
  assert.equal(mixed.headers['Authorization'], AUTH_B);
});

test('⚠⚠ `authorizeRequest` 见**别的账号**的 Authorization ⇒ 抛错（不是放行、不是覆盖）', () => {
  // 这条是闸门：放过去等于让上游去决定认哪个号，那正是串号的成因。
  const mixed = req({ Authorization: AUTH_B });
  assert.throws(
    () => authorizeRequest(mixed, AUTH_A),
    /串号/,
    '两个账号的凭据同时出现在一个请求里，必须发不出去',
  );
});

test('同一个账号的 Authorization 重复带 —— 放行（不算串号）', () => {
  const same = req({ Authorization: AUTH_A });
  assert.equal(authorizeRequest(same, AUTH_A), same, '同一个号不必重复处理');
});

test('没带 Authorization 时照旧补上（原有行为不变）', () => {
  const clean = req({ jwttoken: 'JWT-A' });
  const out = authorizeRequest(clean, AUTH_A);
  assert.equal(out.headers['Authorization'], AUTH_A);
  assert.equal(out.headers['jwttoken'], 'JWT-A', '别的头不动');
});

test('不是凭据域名就不注入（预签名 URL 那条）', () => {
  const s3 = { url: 'https://bucket.example.com/x.jpg', method: 'GET', headers: {}, body: undefined };
  assert.deepEqual(authorizeRequest(s3, AUTH_A).headers, {}, '别人家的主机不带我们的票');
});

function twoAccounts(): { base: ReturnType<typeof memStore>; a: string; b: string } {
  const base = memStore();
  base.ensureSchema();
  const a = upsertAccount(base, AUTH_A, NOW, '15900007542');
  const b = upsertAccount(base, AUTH_B, NOW, '13900139000');
  return { base, a: a.account.id, b: b.account.id };
}

test('⚠⚠ `transportForAccount` 发出去的请求**只带这个号的凭据**（换号就换票）', async () => {
  const { base, a, b } = twoAccounts();
  const sentA: BuiltRequest[] = [];
  const sentB: BuiltRequest[] = [];
  const innerA: Transport = async (r) => { sentA.push(r); return { status: 200, headers: {}, body: '{}' }; };
  const innerB: Transport = async (r) => { sentB.push(r); return { status: 200, headers: {}, body: '{}' }; };

  await transportForAccount(base, a, innerA)(req({ jwttoken: 'JWT-STALE-FROM-OTHER' }));
  await transportForAccount(base, b, innerB)(req({ jwttoken: 'JWT-STALE-FROM-OTHER' }));

  assert.equal(sentA[0]?.headers['Authorization'], AUTH_A);
  assert.equal(sentB[0]?.headers['Authorization'], AUTH_B);
  assert.notEqual(sentA[0]?.headers['Authorization'], sentB[0]?.headers['Authorization'],
    '两个号必须是两份不同的凭据');
  // 请求里原来那张别人的 jwttoken 要被清掉（现在是"清干净再注入"）
  assert.notEqual(sentA[0]?.headers['jwttoken'], 'JWT-STALE-FROM-OTHER');
});

test('⚠ `transportForStore` 在**没绑账号**的 store 上直接抛错（不许拿它发按账号的请求）', () => {
  const { base } = twoAccounts();
  const raw = rawStoreOf(base);
  assert.throws(
    () => transportForStore(base, raw, (async () => ({ status: 200, headers: {}, body: '{}' })) as Transport),
    /串号/,
    '没 scoped 就拿它发请求，等于用当前账号的身份去读别人的账',
  );
});

test('`transportForStore` 在 scoped 过的 store 上按那个账号注入', async () => {
  const { base, b } = twoAccounts();
  const sent: BuiltRequest[] = [];
  const inner: Transport = async (r) => { sent.push(r); return { status: 200, headers: {}, body: '{}' }; };
  await transportForStore(base, scoped(rawStoreOf(base), b), inner)(req());
  assert.equal(sent[0]?.headers['Authorization'], AUTH_B);
});
