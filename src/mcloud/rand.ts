// 随机量：UUID v4（给 `x-request-id` / `x-nonce`）与重试抖动。
//
// ⚠️ **诚实写清楚这一层的强度**：面板的插件沙箱里没有随机源
// （没有 `crypto`、没有 `crypto.getRandomValues`、宿主 API 里也没有 random），
// 所以这里只能用 `Math.random()` 混上 `Date.now()` 和一个自增计数。
//
// 对这个用途够不够？
//   - `x-request-id`：只要求唯一，强度无所谓
//   - `x-nonce`：上游用它防重放。但签名密钥（盐）是**写死在客户端里的**，
//     所以「猜到 nonce」并不能伪造签名 —— 真正的凭据是 cookie / jwttoken。
//     也就是说这里弱一点，不会把整条链的安全边界打穿。
//
// 但这是**面板侧的一个真实缺口**：任何需要「不可预测随机」的插件都没法做
// （生成密钥、一次性口令、抽签）。已记进 docs/findings.md（F-005），
// 建议面板加 `host.random(bytes)`。等它有了，这里换掉实现即可，调用方不用动。

let counter = 0;

/** 32 位无符号随机数（`Math.random()` 的 53 位精度里取低 32 位）。 */
function rnd32(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

const HEX = '0123456789abcdef';

/** UUID v4 的字符串形式。**格式正确，但随机性来自 `Math.random`**（见文件头）。 */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    const v = rnd32();
    b[i] = (v >>> 24) & 0xff;
    b[i + 1] = (v >>> 16) & 0xff;
    b[i + 2] = (v >>> 8) & 0xff;
    b[i + 3] = v & 0xff;
  }
  // 版本 4 与 variant（RFC 4122）
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;

  let s = '';
  for (let i = 0; i < 16; i += 1) {
    const v = b[i]!;
    s += HEX[v >> 4]! + HEX[v & 15]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

/** 单调的 nonce：时间戳 + 自增计数 + 一点随机。
 *
 *  比纯 `Math.random()` 好在**同一毫秒内也不会重复**（计数在兜底），
 *  而重复的 nonce 是上游会拒绝的那类错。 */
export function nonce(): string {
  counter = (counter + 1) % 1000000;
  const r = rnd32().toString(16).padStart(8, '0');
  return `${Date.now().toString(16)}-${counter.toString(16)}-${r}`;
}

/** 当前毫秒时间戳，**以字符串形式返回** —— 它要原样进 `x-timestamp` 与签名拼接。 */
export function timestampMs(): string {
  return String(Date.now());
}
