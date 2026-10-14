// 推送配置的存取与**掩码**。
//
// # 这一层守的是"秘密不上屏"
//
// 推送配置里全是凭据（token / corpsecret / pass / key）。所以这条界线必须钉死：
//
//   · 存进去的是**原值**（要拿去发请求）
//   · 读数里给界面的是**掩码**
//
// 掩码写坏的两种方式都不会报错：
//   ① 忘了掩某个字段 ⇒ 秘密直接上屏（而界面在 iframe 里，可能被截屏/分享）
//   ② 掩得太短 ⇒ 一个 6 字符的 token 留前 2 后 2，等于没掩

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_PUSH_BINDINGS,
  STATE_PUSH_CONFIG,
  STATE_PUSH_RULES,
  TASK_KEYS,
  TASK_LABELS,
  loadPushBindings,
  loadPushConfig,
  loadPushRules,
  maskSecret,
  pushFields,
  pushReading,
  savePushBindings,
  savePushConfig,
  savePushRules,
} from '../src/mcloud/pushConfig.ts';
import type { Store } from '../src/store/types.ts';

/** 一个内存 store（与真的 Store 同接口）。 */
function memStore(): Store {
  const m = new Map<string, string>();
  return {
    getState: (k: string) => m.get(k) ?? null,
    setState: (k: string, v: string) => void m.set(k, v),
  } as unknown as Store;
}

const cfg = {
  bark: { key: 'barkkey_abcdefghijklmnop' },
  pushplus: { token: 'pp_1234567890abcdef' },
  email: { host: 'smtp.example.com', from: 'a@b.c', pass: 'supersecretpass', to: 'd@e.f' },
  dingTalk: { token: 'dtok_1234567890', secret: 'dsec_9876543210' },
  tgBot: { token: 'tgtok_abcdefgh', chat_id: -100123 },
};

test('存进去是原值、读数里是掩码', () => {
  const s = memStore();
  savePushConfig(s, cfg, '2026-10-15T00:00:00.000Z');
  // 原值在库里（要拿去发请求）
  assert.ok(loadPushConfig(s).bark!.key.includes('abcdefghijklmnop'));

  // 读数里一个原值都不许有
  const r = pushReading(s);
  const json = JSON.stringify(r);
  for (const secret of ['barkkey_abcdefghijklmnop', 'pp_1234567890abcdef', 'supersecretpass', 'dtok_1234567890', 'dsec_9876543210', 'tgtok_abcdefgh']) {
    assert.ok(!json.includes(secret), `读数里出现了原值：${secret}`);
  }
});

test('⚠ 非秘密字段**不掩**（host / port / msgtype / touser / chat_id / url）', () => {
  // 掩多了会让界面没法显示"发到哪个邮箱"，那是另一个方向的坏
  const f = pushFields(cfg);
  assert.equal(f['email']!['host'], 'smtp.example.com', 'host 不是秘密');
  assert.equal(f['email']!['to'], 'd@e.f', '收件人不是秘密');
  assert.equal(f['email']!['from'], 'a@b.c');
  assert.equal(f['tgBot']!['chat_id'], '-100123', 'chat_id 不是秘密（群 ID）');
  // 秘密要掩
  assert.ok(f['email']!['pass']!.includes('（共 15 字符）'), f['email']!['pass']);
  assert.ok(f['bark']!['key']!.includes('（共 24 字符）'), f['bark']!['key']);
});

test('⚠ 掩码的两种写法都要防：短值全遮、长值留头尾', () => {
  // 短值：留头尾等于没掩
  assert.equal(maskSecret('abc123'), '（已配）', '6 个字符留 4 个等于没掩');
  assert.equal(maskSecret('abcdefgh'), '（已配）', '8 个字符是边界');
  // 长值：留头尾但要带长度（不然没法判断"我填的是不是那一个"）
  const m = maskSecret('abcdefghijklmnop');
  assert.ok(m.startsWith('abc'), m);
  assert.ok(m.includes('（共 16 字符）'), m);
  assert.ok(!m.includes('efghijklmn'), '中间那段不能露');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(undefined), '');
});

test('配置坏了（手改过 / 老版本写的）⇒ 当作没配，不让界面 500', () => {
  const s = memStore();
  s.setState(STATE_PUSH_CONFIG, '这不是 JSON', '');
  assert.deepEqual(loadPushConfig(s), {});
  s.setState(STATE_PUSH_CONFIG, '"一个字符串"', '');
  assert.deepEqual(loadPushConfig(s), {});
  s.setState(STATE_PUSH_CONFIG, 'null', '');
  assert.deepEqual(loadPushConfig(s), {});
});

test('规则：坏条目被滤掉，好条目留下', () => {
  const s = memStore();
  s.setState(STATE_PUSH_RULES, JSON.stringify([{ id: 'a', name: 'x' }, null, { name: '没有 id' }, '字符串']), '');
  const rules = loadPushRules(s);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.id, 'a');
});

test('绑定：三个键**永远都在**（缺的给空串，不是 undefined）', () => {
  // 界面要拿它渲染三个下拉框；给 undefined 会让那个框变成"未选择"而不是"不发"
  const s = memStore();
  assert.deepEqual(loadPushBindings(s), { daily: '', exchange: '', live: '' });
  s.setState(STATE_PUSH_BINDINGS, JSON.stringify({ daily: 'r1' }), '');
  const b = loadPushBindings(s);
  assert.equal(b.daily, 'r1');
  assert.equal(b.exchange, '');
  assert.equal(b.live, '');
  // 存进去再读出来是同一份
  savePushBindings(s, { daily: 'r1', exchange: 'r2', live: '' }, '');
  assert.deepEqual(loadPushBindings(s), { daily: 'r1', exchange: 'r2', live: '' });
});

test('三个任务的键与名字对得上（界面与配置共用同一份）', () => {
  assert.deepEqual(TASK_KEYS, ['daily', 'exchange', 'live']);
  assert.deepEqual(TASK_LABELS, { daily: '日常', exchange: '兑换', live: '直播' });
});

test('读数：`configured` 与 `channels[].configured` 一致', () => {
  const s = memStore();
  savePushConfig(s, cfg, '');
  const r = pushReading(s);
  const fromList = r.channels.filter((c) => c.configured).map((c) => c.id);
  assert.deepEqual([...r.configured].sort(), [...fromList].sort());
  assert.equal(r.channels.length, 10);
  assert.ok(r.configured.includes('bark'));
  assert.ok(r.configured.includes('email'));
  assert.ok(!r.configured.includes('serverChan'), '没配的不该出现');
  // 每个渠道都有一句"要填什么"
  for (const c of r.channels) assert.ok(c.hint.length > 0, `${c.id} 缺提示语`);
});

test('自定义模板：读数里只说"几个模板"，不铺开内容', () => {
  const s = memStore();
  savePushConfig(s, { customPost: [{ url: 'https://x' }, { url: 'https://y' }] }, '');
  const r = pushReading(s);
  assert.ok(r.configured.includes('customPost'));
  assert.deepEqual(r.fields['customPost'], { 模板数: '2' });
  assert.ok(!JSON.stringify(r).includes('https://x'), '模板 URL 不该进读数');
});

test('空配置 ⇒ 一个渠道都没配，但 10 个渠道都列出来（要能配）', () => {
  const r = pushReading(memStore());
  assert.deepEqual(r.configured, []);
  assert.equal(r.channels.length, 10);
  assert.deepEqual(r.rules, []);
  assert.deepEqual(r.bindings, { daily: '', exchange: '', live: '' });
});

test('`extra` 不进读数（那是原样并进请求体的自由字段，可能是秘密）', () => {
  const s = memStore();
  savePushConfig(s, { pushplus: { token: 'T123456789', extra: { 偷偷的: 'SECRET_EXTRA' } } }, '');
  assert.ok(!JSON.stringify(pushReading(s)).includes('SECRET_EXTRA'));
});
