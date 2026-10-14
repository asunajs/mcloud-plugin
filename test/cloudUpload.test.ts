// 上传链的纯构造/解析层 —— 见 `docs/upload-chain.md` 与 `src/mcloud/cloudUpload.ts`。
//
// 这一层最该钉住的不是"体长什么样"（照抄就有），而是**两条安全规则**：
//   ① 凭据**不许**跟着上存储主机（`sendsAuthorizationTo`）
//   ② `uploadUrl` 按**凭据**对待（不许进日志/夹具/错误文本）
// 以及几个"少一个字母就错"的常量（`oct-stream` 少个 `et`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_DOMAINS,
  CHANNEL_ANDROID,
  CHANNEL_PC,
  CREATE_CONTENT_TYPE,
  CREATE_CONTENT_TYPE_OCTET,
  FILE_CREATE_PATH,
  HASH_ALGORITHM,
  PERSONAL_KD,
  PUT_ORIGIN,
  PUT_UPLOAD_COMPLETE,
  RENAME_FORCE,
  buildCompleteRequest,
  buildCreateRequest,
  buildPutRequest,
  completeBody,
  contentHashOf,
  createBody,
  deterministicFile,
  hostOf,
  latin1FromBytes,
  parseComplete,
  parseCreate,
  sendsAuthorizationTo,
} from '../src/mcloud/cloudUpload.ts';
import { sha256Hex } from '../src/crypto/index.ts';

test('⚠ 凭据判据：控制面带、**存储主机不带**（逐字照 mcloud 的 sends_authorization_to）', () => {
  assert.equal(AUTH_DOMAINS.length, 4);
  // 控制面：personal-kd-njs.yun.139.com 是 yun.139.com 的子域 ⇒ 带
  assert.equal(sendsAuthorizationTo(`${PERSONAL_KD}${FILE_CREATE_PATH}`), true);
  assert.equal(sendsAuthorizationTo('https://m.mcloud.139.com/ycloud/signin/page/infoV3'), true);
  assert.equal(sendsAuthorizationTo('https://caiyun.feixin.10086.cn/market/backupgift/info'), true);
  // 存储主机：预签名直传那口**不是**这四个域 ⇒ 绝不带
  assert.equal(sendsAuthorizationTo('https://oss-cn-xyz.aliyuncs.com/bucket/key?X-Amz-Signature=x'), false);
  assert.equal(
    sendsAuthorizationTo('https://kd-njs-storage.139.com/put/abc'),
    false,
    '139.com 但不是那四个后缀（**许不许**看后缀，不是看"像不像"）',
  );
  // 解析不出来 ⇒ 不带（**不许猜一个主机**）
  assert.equal(sendsAuthorizationTo(''), false);
  assert.equal(sendsAuthorizationTo('不是 URL'), false);
  assert.equal(sendsAuthorizationTo('/relative/path'), false);
  assert.equal(hostOf('https://u:p@Host.Example.com:8443/x'), 'host.example.com', '去 userinfo 与端口、转小写');
});

test('⚠ `uploadUrl` 是**另一台主机**，PUT 那一枪必须被认出来"不带凭据"', () => {
  const bytes = deterministicFile('seed', 16);
  const { req, leaksCredential } = buildPutRequest(
    'https://storage.example.net/k?X-Amz-Signature=abc',
    bytes,
  );
  assert.equal(leaksCredential, false);
  assert.equal(req.method, 'PUT');
  assert.equal(req.headers.Authorization, undefined, '构造层不许设 Authorization');
  assert.equal(req.headers.authorization, undefined);
});

test('数据面那一枪的头：`upload-complete: ?1`（**带问号**）、origin 是**云盘域**', () => {
  const { req } = buildPutRequest('https://storage.example.net/k', deterministicFile('s', 8));
  assert.equal(req.headers['upload-complete'], '?1');
  assert.equal(PUT_UPLOAD_COMPLETE, '?1');
  assert.equal(req.headers.origin, PUT_ORIGIN);
  assert.equal(req.headers.origin, 'https://yun.139.com', '不是 m.mcloud.139.com');
  assert.equal(req.headers['upload-draft-interop-version'], '6');
  // ⚠ 基础支与备份支是**两套** op 值
  assert.equal(req.headers['x-yun-op-type'], '2');
  assert.equal(req.headers['x-yun-sub-op-type'], '200');
  const { req: b } = buildPutRequest('https://storage.example.net/k', deterministicFile('s', 8), true);
  assert.equal(b.headers['x-yun-op-type'], '0');
  assert.equal(b.headers['x-yun-sub-op-type'], '0');
});

test('① 的体：定位键是**两支不同**的（按 id / 按路径）', () => {
  const base = { name: 'a.txt', size: 3, contentHash: 'x'.repeat(64) };
  const byId = JSON.parse(createBody({ ...base, locate: { key: 'parentFileId', value: 'F1' } })) as Record<string, unknown>;
  const byPath = JSON.parse(createBody({ ...base, locate: { key: 'parentPath', value: '/' } })) as Record<string, unknown>;
  assert.equal(byId.parentFileId, 'F1');
  assert.equal(byId.parentPath, undefined, '不该同时塞两个定位键');
  assert.equal(byPath.parentPath, '/');
  assert.equal(byPath.parentFileId, undefined);
  // 其余键
  assert.equal(byId.type, 'file');
  assert.equal(byId.contentHashAlgorithm, HASH_ALGORITHM);
  assert.equal(byId.contentHashAlgorithm, 'SHA256');
  assert.equal(byId.fileRenameMode, RENAME_FORCE, '默认力改名');
  assert.equal(byId.parallelUpload, false);
  // ⚠ partInfos 是**数组**且带 parallelHashCtx.partOffset —— 不是裸的 {partNumber, partSize}
  assert.deepEqual(byId.partInfos, [
    { parallelHashCtx: { partOffset: 0 }, partNumber: 1, partSize: 3 },
  ]);
});

test('⚠ create 的 content-type 是 `oct-stream`（少个 `et`），而 `octet-stream` 也是真值', () => {
  assert.equal(CREATE_CONTENT_TYPE, 'application/oct-stream');
  assert.equal(CREATE_CONTENT_TYPE_OCTET, 'application/octet-stream');
  assert.notEqual(CREATE_CONTENT_TYPE, CREATE_CONTENT_TYPE_OCTET, '两个不是一个值，别"统一"');
  const req = buildCreateRequest({
    name: 'a',
    size: 1,
    contentHash: 'h',
    locate: { key: 'parentFileId', value: '/' },
  });
  assert.ok(req.url.startsWith(PERSONAL_KD));
  assert.ok(req.url.endsWith(FILE_CREATE_PATH));
  assert.equal(req.method, 'POST');
});

test('① 的响应解析：正常 / 秒传（不用 PUT）/ 缺件 / 错码', () => {
  const ok = parseCreate(
    JSON.stringify({ code: 0, data: { fileId: 'F', uploadId: 'U', uploadUrl: 'https://s/k', rapidUpload: false } }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.created!.fileId, 'F');
  assert.equal(ok.created!.rapidUpload, false);
  // 秒传：没有 uploadId/uploadUrl 也**算成功**（那一枪不用发了）
  const rapid = parseCreate(JSON.stringify({ code: 0, data: { fileId: 'F', rapidUpload: true } }));
  assert.equal(rapid.ok, true);
  assert.equal(rapid.created!.rapidUpload, true);
  // 非秒传但缺 url ⇒ 失败（别拿空串去 PUT）
  assert.equal(parseCreate(JSON.stringify({ code: 0, data: { fileId: 'F', rapidUpload: false } })).ok, false);
  assert.equal(parseCreate(JSON.stringify({ code: 0, data: {} })).ok, false);
  assert.equal(parseCreate(JSON.stringify({ code: 400 })).ok, false);
  assert.equal(parseCreate('不是 JSON').ok, false);
});

test('③ 的体是 4 键；判据看 code', () => {
  const body = JSON.parse(completeBody('F', 'U', 'H')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['contentHash', 'contentHashAlgorithm', 'fileId', 'uploadId']);
  assert.equal(body.contentHashAlgorithm, 'SHA256');
  const req = buildCompleteRequest('F', 'U', 'H');
  assert.ok(req.url.endsWith('/hcy/file/complete'));
  assert.equal(parseComplete('{"code":0}').ok, true);
  assert.equal(parseComplete('{"code":"0000"}').ok, true);
  assert.equal(parseComplete('{"code":9}').ok, false);
  assert.equal(parseComplete('{}').ok, true, '没有 code 就按成功（这一族如此）');
});

test('`contentHash` 与 sha256 同源（夹具与日志要能复现）', () => {
  const bytes = deterministicFile('seed', 32);
  assert.equal(contentHashOf(bytes), sha256Hex(bytes));
  assert.equal(bytes.length, 32);
  // 确定：同 seed 两次一样（这样夹具可复现 —— 刻意不用随机）
  assert.deepEqual(Array.from(deterministicFile('s', 8)), Array.from(deterministicFile('s', 8)));
  assert.notDeepEqual(Array.from(deterministicFile('a', 8)), Array.from(deterministicFile('b', 8)));
});

test('`latin1FromBytes`：每字符一字节，且**大体不炸**（沙箱里 apply 十万实参抛 RangeError）', () => {
  const big = new Uint8Array(100_000);
  for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
  const s = latin1FromBytes(big);
  assert.equal(s.length, big.length);
  assert.equal(s.charCodeAt(0), 0);
  assert.equal(s.charCodeAt(255), 255);
  assert.equal(s.charCodeAt(65_537), 65_537 & 0xff);
  assert.equal(latin1FromBytes(new Uint8Array(0)), '');
});

test('渠道是枚举的两个真值（没有"未识别走 web 兜底"那一档）', () => {
  assert.equal(CHANNEL_ANDROID, '10000023');
  assert.equal(CHANNEL_PC, '10200153');
});
