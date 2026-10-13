// task-list（taskListV3）这条链的测试，分三层：
//
//   ① 纯函数层：断言**发出去的字节**（body 逐字节、头、签名由发出去的值重算）
//   ② 逻辑层：`runTaskList` 配桩 transport，断言结果、state 写入、错误路径
//   ③ 线上层：起 mock 上游，**真发一次 HTTP**，断言两端对得上
//
// 为什么要分三层：插件的 transport 是**同步**的（对齐 `host.http_fetch` 的阻塞语义），
// 而 Node 的 `fetch` 是异步的 —— 包不起来。既然如此就别硬凑：把「字节对不对」
// 放在纯函数层断言（那里最精确），把「线上能不能通」单独发一次真 HTTP。
//
// ⚠️ 踩过的坑（写在这里免得后人重踩）：线上层**不能用 `execFileSync('curl', …)`**。
// mock 服务器跑在**同一个进程**里，而 `execFileSync` 会阻塞这个进程的事件循环 ——
// 父进程在等 curl 返回、curl 在等同进程里的 mock 应答，**直接死锁**（表现是测试一直挂着、
// 只打出一行 `TAP version 13`）。线上层一律用异步 `fetch`；要用 curl 就得把 mock
// 放到另一个进程去。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  REFERER_SIGN_IN,
  SHOW_LOADING,
  TASK_LIST_V3_CONTENT_TYPE,
  buildH5Request,
  resolveUrl,
  taskListV3Body,
} from '../src/mcloud/h5.ts';
import { generateSignature } from '../src/mcloud/sign.ts';
import { STATE_LAST_ERROR, STATE_LAST_TASKLIST, runTaskList } from '../src/mcloud/tasks/taskList.ts';
import { SESSION_KEY } from '../src/store/types.ts';
import { memStore } from '../src/store/memory.ts';
import { startMock } from '../mock/upstream.mjs';
import type { Transport } from '../src/mcloud/client.ts';

const SESSION = {
  cookie: 'mockcookie=1',
  jwt: 'mock-jwttoken',
  deviceId: 'dev-1',
  userAgent: 'UA/1',
  savedAt: '2026-10-13T00:00:00.000Z',
};

function seededStore() {
  const store = memStore();
  store.ensureSchema();
  store.setState(SESSION_KEY, JSON.stringify(SESSION), SESSION.savedAt);
  return store;
}

test('① body 逐字节：与实拍 content-length 62 一致', () => {
  const body = taskListV3Body();
  assert.equal(body, '{"marketname":"sign_in_3","clientVersion":"12.6.0","group":""}');
  // 上游实拍里这个请求的 content-length 就是 62 —— 独立于我们自己的第二个信源
  assert.equal(new TextEncoder().encode(body).length, 62);
});

test('① 发出去的头：content-type 带 charset、activityid 跟 marketname、jwttoken 小写', () => {
  const req = buildH5Request({
    url: resolveUrl('taskListV3'),
    method: 'POST',
    body: taskListV3Body(),
    contentType: TASK_LIST_V3_CONTENT_TYPE,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    session: SESSION,
  });

  assert.equal(req.url, 'https://m.mcloud.139.com/ycloud/signin/task/taskListV3');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, '{"marketname":"sign_in_3","clientVersion":"12.6.0","group":""}');
  assert.equal(req.headers['content-type'], 'application/json;charset=UTF-8');
  assert.equal(req.headers.activityid, 'sign_in_3');
  assert.equal(req.headers.appversion, '12.6.0.0');
  assert.equal(req.headers.jwttoken, 'mock-jwttoken');
  assert.equal(req.headers.jwtToken, undefined, '不能驼峰化');
  assert.equal(req.headers.cookie, 'mockcookie=1');
  assert.equal(req.headers.deviceid, 'dev-1');
  assert.equal(req.headers['user-agent'], 'UA/1');
  assert.equal(req.headers.Referer, REFERER_SIGN_IN);
  assert.equal(req.headers['isdeviceid'], undefined, '这一口不带 isdeviceid');

  // **用发出去的那三个值重算签名**，必须等于发出去的 x-signature ——
  // 这是端到端验签：不是「我算的对」，而是「线上那四个头自洽」
  const expected = generateSignature(
    req.headers['x-request-id']!,
    req.headers['x-timestamp']!,
    req.headers['x-nonce']!,
    1,
    '',
  );
  assert.equal(req.headers['x-signature'], expected);
  // 盐确实参与了（换个盐就不一样）
  assert.notEqual(
    expected,
    generateSignature(
      req.headers['x-request-id']!,
      req.headers['x-timestamp']!,
      req.headers['x-nonce']!,
      2,
      '',
    ),
  );
});

test('② 逻辑层：成功时解析清单、写 state、把 cookie 并回去', () => {
  const store = seededStore();
  const seen: string[] = [];
  const stub: Transport = (req) => {
    seen.push(`${req.method} ${req.url}`);
    return {
      status: 200,
      headers: { 'set-cookie': 'mockcookie=1; Path=/, fresh=9' },
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        result: [
          { id: 1, state: 'FINISH' },
          { id: 2, state: 'UNFINISH' },
          { id: 3, state: 'FINISH' },
        ],
      }),
    };
  };

  const out = runTaskList({ store, transport: stub, nowIso: '2026-10-13T01:00:00.000Z' });
  assert.equal(out.ok, true);
  assert.equal(out.note, '清单 3 条，已完成 2 条');
  assert.deepEqual(seen, [`POST ${resolveUrl('taskListV3')}`]);

  const saved = JSON.parse(store.getState(STATE_LAST_TASKLIST)!);
  assert.equal(saved.total, 3);
  assert.equal(saved.done, 2);
  assert.equal(saved.at, '2026-10-13T01:00:00.000Z');

  // 会话续期：上游顺手给的 cookie 要并进去，否则跑一阵就被登出
  const sess = JSON.parse(store.getState(SESSION_KEY)!);
  assert.match(sess.cookie, /mockcookie=1/);
  assert.match(sess.cookie, /fresh=9/);
  assert.equal(sess.savedAt, '2026-10-13T01:00:00.000Z');
});

test('② 逻辑层：业务失败 / HTTP 失败 / 非 JSON 都不抛异常，且写失败原因', () => {
  const cases: Array<[string, string]> = [
    ['biz', '{"code":1001,"msg":"今天已经签过了"}'],
    ['http', 'boom'],
    ['not-json', '<html>502</html>'],
  ];
  for (const [name, body] of cases) {
    const store = seededStore();
    const transport: Transport = () => ({
      status: name === 'http' ? 500 : 200,
      headers: {},
      body,
    });
    const out = runTaskList({ store, transport, nowIso: '2026-10-13T01:00:00.000Z' });
    assert.equal(out.ok, false, `${name} 应当失败`);
    assert.ok((out.note ?? '').length > 0, `${name} 要有可读的原因`);
    assert.ok(store.getState(STATE_LAST_ERROR), `${name} 要把失败原因写下来`);
    assert.equal(store.getState(STATE_LAST_TASKLIST), null, `${name} 不该写成功结果`);
  }
});

test('② 逻辑层：没有会话时**一个请求都不发**', () => {
  const store = memStore();
  store.ensureSchema();
  let called = 0;
  const out = runTaskList({
    store,
    transport: () => {
      called += 1;
      return { status: 200, headers: {}, body: '{}' };
    },
    nowIso: '2026-10-13T01:00:00.000Z',
  });
  assert.equal(out.ok, false);
  assert.match(out.note, /未登录/);
  assert.equal(called, 0, '没有会话就不该打上游');
});

test('③ 线上层：起 mock，真发一次 HTTP，两端对得上', async () => {
  const mock = await startMock();
  try {
    const req = buildH5Request({
      url: `${mock.url}/ycloud/signin/task/taskListV3`,
      method: 'POST',
      body: taskListV3Body(),
      contentType: TASK_LIST_V3_CONTENT_TYPE,
      referer: REFERER_SIGN_IN,
      showLoading: SHOW_LOADING,
      isDeviceId: false,
      saltKey: 1,
      session: SESSION,
      // 固定随机量，断言才可复现
      signInputs: { id: 'ID-1', nonce: 'N-1', timestampMs: '1700000000000' },
    });

    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const outText = await resp.text();

    // 插件侧的解析器要能吃下它
    const env = JSON.parse(outText);
    assert.equal(env.code, 0);
    assert.equal(env.result.length, 3);

    // mock 记下来的请求：证明真的发了这些头与 body
    const sent = mock.requests[mock.requests.length - 1]!;
    assert.equal(sent.path, '/ycloud/signin/task/taskListV3');
    assert.equal(sent.headers['content-type'], 'application/json;charset=UTF-8');
    assert.equal(sent.headers.jwttoken, 'mock-jwttoken');
    assert.equal(sent.body, taskListV3Body());
    // 签名自洽：用 mock 收到的那三个值重算，必须等于收到的 x-signature
    assert.equal(
      sent.headers['x-signature'],
      createHash('md5')
        .update(
          'seedMdYYLIZfbCxg' + sent.headers['x-request-id'] + sent.headers['x-timestamp'] +
            sent.headers['x-nonce'] + 'seedMdYYLIZfbCxg',
          'utf8',
        )
        .digest('hex'),
    );
  } finally {
    await mock.close();
  }
});
