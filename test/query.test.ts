// 查询串解析。
//
// # 为什么它值得一组测试
//
// 宿主给的 `req.query` 是**原始字符串**，而"解析查询串"这件事看着像一行代码，
// 实际有几个**静默出错**的地方：`+` 的含义、值里的 `=`、重复的键、坏编码。
// 每一条错了都不会报错，只会让某个参数**悄悄变成别的值或 undefined** ——
// 而表现是"路由收到了请求但读不到参数"。
//
// 更糟的是 `Object.keys('id=abc')` 在 JS 里**不报错**（给的是字符下标），
// 所以"把字符串当对象用"这个错误连症状都不明显。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery } from '../src/mcloud/query.ts';

test('基本形状', () => {
  assert.deepEqual(parseQuery('id=abc&x=1'), { id: 'abc', x: '1' });
  assert.deepEqual(parseQuery('?id=abc'), { id: 'abc' }, '带问号也要认');
  assert.deepEqual(parseQuery(''), {});
});

test('⚠ `+` 是空格（表单编码），不是加号', () => {
  assert.deepEqual(parseQuery('q=a+b'), { q: 'a b' });
  assert.deepEqual(parseQuery('q=a%2Bb'), { q: 'a+b' }, '%2B 才是真的加号');
});

test('⚠ 值里可以有 `=`（只按**第一个** `=` 切）', () => {
  // 按所有 `=` 切会让 `a` 变成 "b"、多出一个空键 —— 而 base64 参数里全是 `=`
  assert.deepEqual(parseQuery('a=b=c'), { a: 'b=c' });
  assert.deepEqual(parseQuery('token=abc=='), { token: 'abc==' });
});

test('⚠ 重复的键取**第一个**（与 `URLSearchParams.get` 一致）', () => {
  assert.deepEqual(parseQuery('a=1&a=2'), { a: '1' });
});

test('没有值的键 ⇒ 空串（不是 undefined）', () => {
  assert.deepEqual(parseQuery('flag&x=1'), { flag: '', x: '1' });
  assert.deepEqual(parseQuery('a='), { a: '' });
});

test('⚠ 坏编码**不抛**（手敲的 `%zz` 不该让整个路由 500）', () => {
  assert.deepEqual(parseQuery('x=%zz'), { x: '%zz' }, '原样返回');
  assert.deepEqual(parseQuery('x=%E4%B8'), { x: '%E4%B8' }, '半截的 UTF-8 也不抛');
  // 好的编码照常解
  assert.deepEqual(parseQuery('x=%E4%B8%AD'), { x: '中' });
});

test('空段被跳过（`&&` / 结尾的 `&`）', () => {
  assert.deepEqual(parseQuery('a=1&&b=2&'), { a: '1', b: '2' });
});

test('非字符串输入 ⇒ 空对象（宿主没给 query 时）', () => {
  assert.deepEqual(parseQuery(undefined), {});
  assert.deepEqual(parseQuery(null), {});
  assert.deepEqual(parseQuery(123), {});
  assert.deepEqual(parseQuery({ id: 'x' }), {}, '给对象也返回空 —— 不猜');
});

test('⚠ 键也要解码（不然带中文/空格的键读不到）', () => {
  assert.deepEqual(parseQuery('%E4%B8%AD=x'), { 中: 'x' });
  assert.deepEqual(parseQuery('a+b=1'), { 'a b': '1' });
});

test('真实场景：运行记录的 id', () => {
  // `daily-1760486400000` 里有 `-`，不需要转义；但 id 里带别的字符时要能解回来
  assert.deepEqual(parseQuery('id=daily-1760486400000'), { id: 'daily-1760486400000' });
  assert.deepEqual(parseQuery('id=a%3Db'), { id: 'a=b' });
});
