// 签到族的响应信封。
//
// 复刻自 `crates/mcloud-upstream/src/app_signin.rs` 的 `SignInEnvelope`。
//
// ⚠️ 两个信封**不能互换**，这是原实现明确踩过的坑：
//   - 签到族：`code` 是**数字**（`{"code":0,"msg":"success"}`）
//   - 登录族：`code` 是**字符串** `"0000"`，且外层有 `success: bool`
//
// 方向要说清楚：**登录族那个解析器**去解签到响应，会永远把数字 0 判成「不等于 0000」
// → 每次都说失败。反方向（本文件去解登录响应）反而"能过" —— `"0000"` 转成数字也是 0。
// 也就是说这类混用**只在一个方向上会响**，所以本文件只服务签到族，登录族另写一个。
//
// 另外两处上游自己就不一致、必须两种都收的地方：
//   - `code` 有时是数字、有时是数字字符串
//   - 消息键名有时 `msg`、有时 `message`

export interface SignInEnvelope {
  /** 归一化成数字；解析不出来给 -1（不是 0 —— 0 是成功） */
  code: number;
  message: string;
  /** `result` 原样保留；`undefined` = 响应里没有这个键 */
  result: unknown;
  /** `code === 0` */
  ok: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 解析签到族响应。非 JSON、或形状完全不对时抛错（不静默当失败）。 */
export function parseSignInEnvelope(body: string): SignInEnvelope {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    throw new Error(`签到响应不是 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(v)) {
    throw new Error(`签到响应不是对象：${body.slice(0, 120)}`);
  }

  const raw = v.code;
  let code = -1;
  if (typeof raw === 'number') code = Number.isFinite(raw) ? raw : -1;
  else if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    code = Number(raw);
  }

  const msg = v.msg ?? v.message;
  const message = typeof msg === 'string' ? msg : '';

  return {
    code,
    message,
    result: v.result,
    ok: code === 0,
  };
}

/** 取 `result` 里的数组；不是数组就返回空数组。
 *
 *  上游在不同端点上是「数组」还是「以 group 为键的对象」，这里只管前者 ——
 *  形状不同的端点各写各的解析（原实现特意强调过：别写一个「两种都吃」的兼容解析器，
 *  那样上游改形状时这条链不会响）。 */
export function resultArray(env: SignInEnvelope): unknown[] {
  return Array.isArray(env.result) ? env.result : [];
}

/** 取 `result` 里的对象；不是对象就返回空对象。 */
export function resultObject(env: SignInEnvelope): Record<string, unknown> {
  return isRecord(env.result) ? env.result : {};
}
