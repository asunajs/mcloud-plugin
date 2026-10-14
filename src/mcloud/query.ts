// 查询串解析。
//
// # 为什么要有这个文件
//
// 宿主给的 `req.query` 是**原始字符串**（`"id=abc&x=1"`），不是解析好的对象
// —— 见 `host-api.d.ts` 里 `RouteRequest.query` 那段（实测记在那里）。
//
// 所以按名取值必须先解析。而"解析查询串"这件事有几个**看着无所谓、
// 其实会静默出错**的地方，都钉在下面：
//
//   · `+` 是**空格**（表单编码），不是加号
//   · 值里可以有 `=`（`?a=b=c` ⇒ `a` = `"b=c"`），所以只按**第一个** `=` 切
//   · 重复的键（`?a=1&a=2`）—— 取**第一个**（与 `URLSearchParams.get` 一致）
//   · 没有值的键（`?flag`）⇒ 空串（不是 `undefined`）
//   · 值要 `decodeURIComponent`，而**坏编码不能抛**（`%zz` 会让整个路由 500，
//     而那是用户随便敲了个地址）

/** 解析查询串（可以带也可以不带开头的 `?`）。 */
export function parseQuery(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'string' || raw === '') return out;
  const s = raw.startsWith('?') ? raw.slice(1) : raw;
  for (const pair of s.split('&')) {
    if (pair === '') continue;
    // 只按**第一个** `=` 切：值里允许有 `=`
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    const key = safeDecode(k.replace(/\+/g, ' '));
    // 重复的键取第一个（与 `URLSearchParams.get` 一致）
    if (key in out) continue;
    out[key] = safeDecode(v.replace(/\+/g, ' '));
  }
  return out;
}

/** `decodeURIComponent`，**坏编码原样返回**而不是抛。
 *
 *  ⚠ 抛出去的话，一个手敲的 `?x=%zz` 会让整个路由 500 ——
 *  而这个参数可能只是用户在地址栏里试东西。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
