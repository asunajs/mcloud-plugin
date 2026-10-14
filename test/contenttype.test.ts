// 传输层补默认 `content-type` —— 守着 F-015 那条真机实测抓到的规则。
//
// 这条规则的位置很要紧：它在**传输层**，不在构造器里。散在构造器里就会漏，
// 而漏的表现是一个**看起来像"路径不存在"**的 404（线上网关按 content-type 路由）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTENT_TYPE_JSON, applyDefaultContentType, hostFetchOptions } from '../src/mcloud/client.ts';
import { userInfoRequest } from '../src/mcloud/liveFlower.ts';
import { drawRequest, journalingRequest, firstParticipateGiveRequest } from '../src/mcloud/liveFlower.ts';
import { tyrzLoginRequest, SIGN_IN_RECIPE, makeSign } from '../src/mcloud/h5session.ts';

test('有体且没声明 ⇒ 补 `application/json;charset=UTF-8`（带 charset，逐字抄真实现）', () => {
  assert.equal(CONTENT_TYPE_JSON, 'application/json;charset=UTF-8');
  const r = applyDefaultContentType({ url: 'u', method: 'POST', headers: {}, body: '{}' });
  assert.equal(r.headers['content-type'], CONTENT_TYPE_JSON);
});

test('无体 ⇒ **不补**（`draw` 的实拍就是 `content-length: 0`、无 content-type）', () => {
  const r = applyDefaultContentType({ url: 'u', method: 'POST', headers: {}, body: undefined });
  assert.equal(r.headers['content-type'], undefined);
});

test('已声明 ⇒ **不覆盖**（否则线上会出现两枚 content-type）', () => {
  // `journaling` 声明的是表单，不能被补成 json —— 补错了这一枪就废
  const r = applyDefaultContentType({
    url: 'u',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'a=1',
  });
  assert.equal(r.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  // 大小写不敏感：`Content-Type` 也算声明过
  const r2 = applyDefaultContentType({
    url: 'u', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x',
  });
  assert.equal(r2.headers['content-type'], undefined, '不该再补一个');
  assert.equal(r2.headers['Content-Type'], 'text/plain');
});

test('不改原对象（纯函数）', () => {
  const src = { url: 'u', method: 'POST' as const, headers: { a: 'b' }, body: '{}' };
  applyDefaultContentType(src);
  assert.deepEqual(src.headers, { a: 'b' });
});

test('逐条按真实现的形状过一遍：哪几个该补、哪几个不该', () => {
  const cases: [string, boolean][] = [
    ['user/info', true], //  构造器不设 ⇒ 传输层补（**真机实测过**：不补这条它回 404/90001 家族）
    ['tyrzLogin', true], //  同上 —— 就是这一条在真机上先回 404
    ['journaling', false], // 自己声明了表单类型
    ['draw', false], //      无体
    ['firstParticipate/give', false], // 无体
  ];
  const built: Record<string, ReturnType<typeof userInfoRequest>> = {
    'user/info': userInfoRequest(),
    tyrzLogin: tyrzLoginRequest(SIGN_IN_RECIPE, 'S', makeSign('1'), 'r'),
    journaling: journalingRequest('E'),
    draw: drawRequest('X'),
    'firstParticipate/give': firstParticipateGiveRequest(),
  };
  for (const [name, shouldAdd] of cases) {
    const src = built[name]!;
    const out = applyDefaultContentType(src);
    // ⚠ 判据是"**被补了没有**"，不是"有没有 content-type" ——
    // `journaling` 自己声明了表单类型，它有 content-type 但不是被补的
    const added =
      src.headers['content-type'] === undefined && out.headers['content-type'] === CONTENT_TYPE_JSON;
    assert.equal(added, shouldAdd, `${name}：期望${shouldAdd ? '补' : '不补'}，实际 ${out.headers['content-type'] ?? '（无）'}`);
  }
});

// ── hostFetchOptions：`tls` 只对 https 生效（e2e 能在默认构建上跑的原因）──────

test("hostFetchOptions：https + tls ⇒ 带上；http + tls ⇒ **丢掉**", () => {
  // ⚠ 这条守卫不是"顺手":宿主对 `tls:"native"` 是**先校验选项再发请求**
  //   （面板 `hostapi::parse_tls_choice`）⇒ 给 http 请求填它，在没有 `legacy-tls`
  //   的宿主上会直接报错，连"反正用不上"的机会都没有。
  //   而本仓 e2e 全程只打 mock（`http://127.0.0.1`）—— 这条守卫正是
  //   「e2e 可以在默认构建的面板上跑」的原因。
  const base = { method: 'POST', headers: {}, body: 'x' } as const;

  const https = hostFetchOptions({ ...base, url: 'https://v.cmcc-cs.cn/a', tls: 'native' }, 1500);
  assert.equal(https.tls, 'native');

  const http = hostFetchOptions({ ...base, url: 'http://127.0.0.1:19000/a', tls: 'native' }, 1500);
  assert.equal(http.tls, undefined);
  assert.equal('tls' in http, false);

  // 没写 tls 的请求（绝大多数）一个字段都不多 —— 宿主默认 rustls
  const plain = hostFetchOptions({ ...base, url: 'https://user-njs.yun.139.com/x' }, 1500);
  assert.equal('tls' in plain, false);
  assert.equal(plain.timeout_ms, 1500);
  assert.equal(plain.method, 'POST');
});
