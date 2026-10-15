// 凭据解析。
//
// # 为什么这一层要单独测
//
// 「凭据」= `Basic base64("<平台>:<手机号>:<token>")`。它有两个**看不见的**分岔：
//
//   · 平台只有 `pc` / `mobile` 两种，而 **`pc` 分不出 win/mac** ⇒
//     "是 win 还是 mac"必须单独落盘（错的话账号以后一直用错的身份发请求）
//   · `phone` 认不出的话 **id 会退化成 token 的哈希**，而 token 每次登录都变
//     ⇒ 同一个号每登录一次就多出一条重复账号
//
// 所以这里既钉"解析对不对"，也钉"缺段时不要抛"（上游实测有缺段样本）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_AUTH_PREFIX,
  PC_AUTH_PREFIX,
  isAppAuth,
  isPcAuth,
  parseAuth,
} from '../src/mcloud/auth.ts';

/** 造一条凭据（等价于 base64 编码 `平台:号:token`）。 */
function mk(payload: string, prefix = 'Basic '): string {
  const bytes = new TextEncoder().encode(payload);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return prefix + btoa(bin);
}

test('PC 凭据：平台是 `pc`，手机号在 base64 里', () => {
  const a = parseAuth(mk('pc:13800138000:tok|a|b|1735689600000'));
  assert.ok(a);
  assert.equal(a.platform, PC_AUTH_PREFIX);
  assert.equal(a.phone, '13800138000');
  assert.equal(a.token, 'tok|a|b|1735689600000');
  assert.equal(a.expire, 1735689600000, 'token 第 4 段是到期毫秒');
  assert.equal(isPcAuth(a), true);
  assert.equal(isAppAuth(a), false);
  assert.ok(a.raw.startsWith('Basic '), '落盘形态恒带 `Basic ` 前缀');
});

test('手机端凭据：平台是 `mobile`', () => {
  const a = parseAuth(mk('mobile:13900139000:tok'));
  assert.ok(a);
  assert.equal(a.platform, APP_AUTH_PREFIX);
  assert.equal(a.phone, '13900139000');
  assert.equal(isAppAuth(a), true);
  assert.equal(isPcAuth(a), false);
});

test('⚠ `Basic ` 前缀可有可无', () => {
  const noPrefix = parseAuth(mk('pc:13800138000:tok', ''));
  assert.ok(noPrefix);
  assert.equal(noPrefix.platform, 'pc');
  assert.equal(noPrefix.phone, '13800138000');
});

test('⚠ "只替换第一处 `Basic `"：前缀之前的**非字母表字符会被过滤掉**', () => {
  // 参考实现是 `auth.replace("Basic ", "")`（JS 语义）⇒ 只去掉**第一处**
  // `Basic `，其余原样保留；而宽容 base64 会把字母表以外的字符**丢掉**。
  //
  // 两者合起来的意思是：`Basic ` 前面**只能**出现非字母表字符
  // （空白、`!`、`-` …）才不会污染 payload。下面这条是能解出来的例子。
  const b64 = mk('pc:13800138000:tok', '');
  const a = parseAuth('!!!Basic ' + b64);
  assert.ok(a, '`!` 会被过滤掉，所以能解');
  assert.equal(a.phone, '13800138000');

  // ⚠ 而"带 HTTP 头名的整行"**不行** —— `Authorization` 里的字母都是合法
  //   base64 字符，会混进 payload。这条不是 bug，是照抄的语义：
  //   那一行是给"前缀出现在中间"的写法用的，不是给整行 HTTP 头用的。
  const withHeaderName = parseAuth('Authorization: Basic ' + b64);
  assert.notEqual(
    withHeaderName?.phone,
    '13800138000',
    '带 HTTP 头名的整行不该被当成一条有效凭据',
  );
});

test('⚠ 宽容 base64：忽略字母表以外的字符（严格模式会整条不可用）', () => {
  // 参考实现刻意不用严格 base64：Node 的 Buffer.from 会忽略这些字符，
  // 而严格模式报错 ⇒ "上游塞了个空白字符"会变成"凭据整条不可用"
  const good = mk('pc:13800138000:tok');
  const spaced = good.slice(0, 6) + ' ' + good.slice(6);
  const a = parseAuth(spaced);
  assert.ok(a, '带空白也要能解');
  assert.equal(a.phone, '13800138000');
});

test('⚠ 解不开就 `undefined`（不抛）—— 余 1 是无解的', () => {
  // 过滤后长度模 4 余 1 ⇒ 构不成任何字节，必须判不可用
  assert.equal(parseAuth('Basic A'), undefined, '长度 1 余 1');
  assert.equal(parseAuth('Basic'), undefined, '空');
  assert.equal(parseAuth(''), undefined);
  assert.equal(parseAuth('   '), undefined);
  assert.equal(parseAuth('Basic !!!'), undefined, '全是字母表外字符');
});

test('⚠ 缺段不报错：上游实测有缺段的样本', () => {
  // 报错会让一条"能用但信息不全"的凭据变成不可用 —— 代价不对等
  const only = parseAuth(mk('pc'));
  assert.ok(only, '只有一段也要能解出来');
  assert.equal(only.platform, 'pc');
  assert.equal(only.phone, '', '缺的段留空串，不是 undefined');
  assert.equal(only.token, '');
  assert.equal(only.expire, 0);
  // 判平台要**显式比对前缀**，不能靠"非空"
  assert.equal(isPcAuth(only), true);
});

test('token 含 `:` ⇒ 只取前 3 段（第 4 段起丢弃）', () => {
  const a = parseAuth(mk('pc:13800138000:a:b:c'));
  assert.ok(a);
  assert.equal(a.token, 'a', 'splitn(4) ⇒ token 只有第一段');
});

test('expire：token 第 4 段，非法/缺/0 都归 0', () => {
  assert.equal(parseAuth(mk('pc:1:t|1|2|1700000000000'))?.expire, 1700000000000);
  assert.equal(parseAuth(mk('pc:1:t'))?.expire, 0, '缺第 4 段');
  assert.equal(parseAuth(mk('pc:1:t|1|2|notanumber'))?.expire, 0, '非数字');
  assert.equal(parseAuth(mk('pc:1:t|1|2|0'))?.expire, 0, '0 归 0');
  assert.equal(parseAuth(mk('pc:1:t|1|2|1e5'))?.expire, 0, '`1e5` 不是"朴素十进制"');
  assert.equal(parseAuth(mk('pc:1:t|1|2|+123'))?.expire, 123, '带正号是合法的');
  assert.equal(parseAuth(mk('pc:1:t|1|2|123.9'))?.expire, 0, '小数不是朴素十进制');
});

test('`raw` 恒为 `Basic <clean>`（落盘形态统一），但**不**做空白清理', () => {
  const b64 = mk('pc:13800138000:tok', '');
  const a = parseAuth('Basic ' + b64);
  assert.ok(a);
  assert.equal(a.raw, 'Basic ' + b64, '规整之后就是这一串');

  // ⚠ 前导空白**会被保留**（参考实现也是 `format!("Basic {clean}")`，
  //   而 `clean` 只去掉了那一个 `Basic `）—— 这里如实钉住，不"顺手清理"，
  //   因为清理会让我们与参考实现对同一输入给出不同的 `raw`。
  const withSpaces = parseAuth('  Basic   ' + b64);
  assert.ok(withSpaces);
  assert.ok(withSpaces.raw.startsWith('Basic '));
  assert.equal(withSpaces.phone, '13800138000', '空白不影响解析结果');
});
