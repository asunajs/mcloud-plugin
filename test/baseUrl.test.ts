// 「口子给空串 ⇒ 必须落到默认主机」——**全族**的网。
//
// # 这张网是 2026-10-14 真机上用一次失败换来的
//
// `loadBaseUrl()` / `loadGateBase()` 这些读口子的函数用 **空串或 `undefined`** 表示
// "没配 ⇒ 用真上游"（界面也这么显示）。而整整四个模块的构建函数都写成
// `base ?? DEFAULT` —— `??` 只挡 `undefined`，**空串会一路穿到底**：
//
// ```text
//  url = `${'' .replace(...)}/user/querySpecTokenV2`   ⇒  "/user/querySpecTokenV2"
//  ⇒ 宿主报 bad uri: … is missing scheme
// ```
//
// 症状一串三个（换票 ①②③④ → 领小红花的 ①）：**真上游跑时整条链一步都发不出去**。
// 而 e2e 里所有口子都指着 mock（非空），所以这个洞被**完整地挡在测试之外** ——
// 这也解释了为什么"446 项测试全绿 + e2e 全绿"仍然会漏掉它。
//
// ⇒ 结论写进纪律：**"口子为空"是一个必须被单测覆盖的配置**，
//    因为它只在真上游跑的时候才出现，而那正是 e2e 打不到的地方。

import { test } from 'node:test';
import { hostBase } from '../src/mcloud/tasks/base.ts';
import assert from 'node:assert/strict';

import { userInfoRequest as flowerUserInfo } from '../src/mcloud/liveFlower.ts';
import { applyRoomRequest } from '../src/mcloud/liveIm.ts';
import {
  roomBeatRequest,
  tabContentListRequest,
  userTokenRequest,
  cmpassLoginRequest,
  gateSpecTokenRequest,
} from '../src/mcloud/liveGate.ts';
import { specTokenRequest, timestampRequest, tyrzLoginRequest, SIGN_IN_RECIPE } from '../src/mcloud/h5session.ts';
import { makeSign } from '../src/mcloud/h5session.ts';
import { smidUploadRequest, newFingerprint } from '../src/mcloud/smid.ts';

const ABS = /^https?:\/\//;

test('口子给空串/空白 ⇒ 每一条族的 URL 仍然是绝对的（真上游那一档）', () => {
  const sign = makeSign('1791965211987');
  const cases: Array<{ name: string; url: string }> = [
    { name: 'h5① specToken', url: specTokenRequest(SIGN_IN_RECIPE, 'Basic x', '').url },
    { name: 'h5② timestamp', url: timestampRequest(SIGN_IN_RECIPE, 'https://x/y', '').url },
    { name: 'h5③ tyrzLogin', url: tyrzLoginRequest(SIGN_IN_RECIPE, 'SSO', sign, 'https://x/y', '').url },
    { name: '门① specToken', url: gateSpecTokenRequest('Basic x', '').url },
    { name: '门② cmpassLogin', url: cmpassLoginRequest('tok', '').url },
    { name: '门③ tabContentList', url: tabContentListRequest(127, 'jwt', '').url },
    { name: '门③ userToken', url: userTokenRequest('jwt', '').url },
    { name: '门④ roomBeat', url: roomBeatRequest('147868', 'jwt', '').url },
    { name: 'IM⑤ member/apply', url: applyRoomRequest('2026', 'u', 'u', 't', '1791965211987', { base: '' }).url },
    { name: '小红花① user/info', url: flowerUserInfo('').url },
    {
      name: 'smid deviceprofile',
      url: smidUploadRequest(newFingerprint(), 'box', new Date(1791965211987), () => 0.5, '').url,
    },
  ];
  for (const c of cases) {
    assert.match(c.url, ABS, `${c.name} 在口子为空时必须落到默认主机，实际是 ${c.url}`);
  }
  // 空白同理（界面上手输一个空格是常事）
  assert.match(specTokenRequest(SIGN_IN_RECIPE, 'Basic x', '   ').url, ABS);
  assert.match(flowerUserInfo('   ').url, ABS);
});

test('口子非空时**整个源被替换**（mock 就是这么接进来的）', () => {
  const m = 'http://127.0.0.1:19000';
  assert.equal(specTokenRequest(SIGN_IN_RECIPE, 'Basic x', m).url, `${m}/user/querySpecTokenV2`);
  assert.equal(flowerUserInfo(m).url.startsWith(`${m}/ycloud/`), true, flowerUserInfo(m).url);
  assert.equal(roomBeatRequest('147868', 'jwt', m).url.startsWith(`${m}/api/`), true);
});

test('⚠ 基址是**空串**时不许拼出相对 URL（现场踩到的 `missing scheme`）', () => {
  // 现场那句是 `bad uri: /ycloud/signin/page/taskExpansion is missing scheme` ——
  // 它看起来像"上游坏了"，其实是 `deps.baseUrl ?? HOST` 里的 `??` 只挡 undefined，
  // 空串拼出来的就是 `/ycloud/...`（没有主机）。
  assert.equal(hostBase({ baseUrl: '' }, 'https://真主机'), 'https://真主机');
  assert.equal(hostBase({ baseUrl: '   ' }, 'https://真主机'), 'https://真主机');
  assert.equal(hostBase({}, 'https://真主机'), 'https://真主机');
  assert.equal(hostBase({ baseUrl: 'http://127.0.0.1:9/' }, 'https://真主机'), 'http://127.0.0.1:9');
  assert.equal(hostBase({ baseUrl: 'http://127.0.0.1:9' }, 'https://真主机'), 'http://127.0.0.1:9');
});
