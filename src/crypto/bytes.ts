// 字节与编码工具。
//
// 为什么全都手写：插件跑在 QuickJS 沙箱里，**没有 `TextEncoder` / `Buffer` / `atob`**。
// 这里每一个函数在 test/bytes.test.ts 里都跟 Node 的实现逐个用例对过
// （`Buffer.from(s,'utf8')` / `Buffer.from(b).toString('base64')`）。
//
// UTF-8 编码手写最容易错的就是**代理对**（emoji、部分生僻字）：一个码点占 4 字节，
// 用 charCodeAt 逐字符处理会把它拆成两个孤立的 3 字节序列 —— 上游签名用错了
// 只会得到「签名错误」，很难查。所以这里按码点处理，孤立代理按规范替换成 U+FFFD。

/** 字符串 → UTF-8 字节。孤立的代理项按 WHATWG 规范替换为 U+FFFD。 */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 字节 → 字符串。严格按 WHATWG 的 UTF-8 解码算法（与 `TextDecoder` 一致）。
 *
 *  为什么值得照抄算法而不是「手写个能跑的」：非法序列上「吐几个 U+FFFD」是有规范的 ——
 *  按字节吐是不对的（一个非法字节序列只该吐**一个**替换符，然后从违规的那个字节重新处理）。
 *  第一版我就是按字节吐，test 里那条「跟 TextDecoder 逐字节一致」的断言直接把它抓了出来。
 *  插件拿它解上游响应，虽然正常情况都是合法 UTF-8，但「差不多对」在这种基础层没有意义。 */
export function fromUtf8(b: Uint8Array): string {
  let s = '';
  let codePoint = 0;
  let bytesSeen = 0;
  let bytesNeeded = 0;
  let lower = 0x80;
  let upper = 0xbf;

  const emit = (cp: number) => {
    if (cp < 0x10000) {
      s += String.fromCharCode(cp);
    } else {
      const v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  };
  const reset = () => {
    codePoint = 0;
    bytesSeen = 0;
    bytesNeeded = 0;
    lower = 0x80;
    upper = 0xbf;
  };

  let i = 0;
  while (i < b.length) {
    const byte = b[i]!;
    let reprocess = false;

    if (bytesNeeded === 0) {
      if (byte <= 0x7f) {
        s += String.fromCharCode(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        bytesNeeded = 1;
        codePoint = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        bytesNeeded = 2;
        codePoint = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        bytesNeeded = 3;
        codePoint = byte & 0x07;
      } else {
        s += '\ufffd';
      }
    } else if (byte < lower || byte > upper) {
      // 违规：吐一个替换符，**从当前字节重新处理**（这就是「最大子部分」那条规则）
      reset();
      s += '\ufffd';
      reprocess = true;
    } else {
      lower = 0x80;
      upper = 0xbf;
      codePoint = (codePoint << 6) | (byte & 0x3f);
      bytesSeen += 1;
      if (bytesSeen === bytesNeeded) {
        emit(codePoint);
        reset();
      }
    }

    if (!reprocess) i += 1;
  }
  // 结尾还挂着半个序列 → 一个替换符
  if (bytesNeeded !== 0) s += '\ufffd';
  return s;
}

const HEX = '0123456789abcdef';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 1) {
    const v = b[i]!;
    s += HEX[v >> 4]! + HEX[v & 15]!;
  }
  return s;
}

export function fromHex(h: string): Uint8Array {
  const clean = h.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    s += i + 1 < b.length ? B64[(n >> 6) & 63]! : '=';
    s += i + 2 < b.length ? B64[n & 63]! : '=';
  }
  return s;
}

/** 宽容解码：忽略空白与非法字符（有些上游会在 base64 里带换行）。 */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64.indexOf(clean[i]!);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return out.subarray(0, o);
}

/** 定长大端写入（哈希的长度填充要用，不能用 DataView —— 少一个依赖面）。 */
export function writeU32BE(out: Uint8Array, off: number, v: number): void {
  out[off] = (v >>> 24) & 0xff;
  out[off + 1] = (v >>> 16) & 0xff;
  out[off + 2] = (v >>> 8) & 0xff;
  out[off + 3] = v & 0xff;
}

export function writeU32LE(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
}

export function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

export function readU32LE(b: Uint8Array, off: number): number {
  return ((b[off + 3]! << 24) | (b[off + 2]! << 16) | (b[off + 1]! << 8) | b[off]!) >>> 0;
}

/** 高低 32 位合成 64 位长度（哈希的长度字段）。用不到 BigInt。 */
export function lengthBits(bytes: number): { hi: number; lo: number } {
  const bits = bytes * 8;
  return { hi: Math.floor(bits / 4294967296) >>> 0, lo: bits >>> 0 };
}
