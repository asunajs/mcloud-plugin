// 由 src/entries/daily.ts 打包生成 —— **不要手改这个文件**。
//
//   改代码：编辑 src/，然后 `npm run build`
//   只在构建产物上改动的东西，下一次构建就没了
//   mcloud-plugin 0.0.0 · 插件 `mcloud-daily`

// src/entries/daily.ts
import { log, register_cron, warn, worker_hint } from "host-api";

// src/crypto/bytes.ts
function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319 && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 56320 && low <= 57343) {
        cp = 65536 + (cp - 55296 << 10) + (low - 56320);
        i += 1;
      } else {
        cp = 65533;
      }
    } else if (cp >= 55296 && cp <= 57343) {
      cp = 65533;
    }
    if (cp < 128) {
      out.push(cp);
    } else if (cp < 2048) {
      out.push(192 | cp >> 6, 128 | cp & 63);
    } else if (cp < 65536) {
      out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    } else {
      out.push(
        240 | cp >> 18,
        128 | cp >> 12 & 63,
        128 | cp >> 6 & 63,
        128 | cp & 63
      );
    }
  }
  return new Uint8Array(out);
}
function fromUtf8(b) {
  let s = "";
  let codePoint = 0;
  let bytesSeen = 0;
  let bytesNeeded = 0;
  let lower = 128;
  let upper = 191;
  const emit = (cp) => {
    if (cp < 65536) {
      s += String.fromCharCode(cp);
    } else {
      const v = cp - 65536;
      s += String.fromCharCode(55296 + (v >> 10), 56320 + (v & 1023));
    }
  };
  const reset = () => {
    codePoint = 0;
    bytesSeen = 0;
    bytesNeeded = 0;
    lower = 128;
    upper = 191;
  };
  let i = 0;
  while (i < b.length) {
    const byte = b[i];
    let reprocess = false;
    if (bytesNeeded === 0) {
      if (byte <= 127) {
        s += String.fromCharCode(byte);
      } else if (byte >= 194 && byte <= 223) {
        bytesNeeded = 1;
        codePoint = byte & 31;
      } else if (byte >= 224 && byte <= 239) {
        if (byte === 224) lower = 160;
        if (byte === 237) upper = 159;
        bytesNeeded = 2;
        codePoint = byte & 15;
      } else if (byte >= 240 && byte <= 244) {
        if (byte === 240) lower = 144;
        if (byte === 244) upper = 143;
        bytesNeeded = 3;
        codePoint = byte & 7;
      } else {
        s += "�";
      }
    } else if (byte < lower || byte > upper) {
      reset();
      s += "�";
      reprocess = true;
    } else {
      lower = 128;
      upper = 191;
      codePoint = codePoint << 6 | byte & 63;
      bytesSeen += 1;
      if (bytesSeen === bytesNeeded) {
        emit(codePoint);
        reset();
      }
    }
    if (!reprocess) i += 1;
  }
  if (bytesNeeded !== 0) s += "�";
  return s;
}
var HEX = "0123456789abcdef";
function toHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 1) {
    const v = b[i];
    s += HEX[v >> 4] + HEX[v & 15];
  }
  return s;
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = b[i] << 16 | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0);
    s += B64[n >> 18 & 63] + B64[n >> 12 & 63];
    s += i + 1 < b.length ? B64[n >> 6 & 63] : "=";
    s += i + 2 < b.length ? B64[n & 63] : "=";
  }
  return s;
}
function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor(clean.length * 6 / 8));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = acc >> bits & 255;
      o += 1;
    }
  }
  return out.subarray(0, o);
}
function writeU32BE(out, off, v) {
  out[off] = v >>> 24 & 255;
  out[off + 1] = v >>> 16 & 255;
  out[off + 2] = v >>> 8 & 255;
  out[off + 3] = v & 255;
}
function writeU32LE(out, off, v) {
  out[off] = v & 255;
  out[off + 1] = v >>> 8 & 255;
  out[off + 2] = v >>> 16 & 255;
  out[off + 3] = v >>> 24 & 255;
}
function readU32BE(b, off) {
  return (b[off] << 24 | b[off + 1] << 16 | b[off + 2] << 8 | b[off + 3]) >>> 0;
}
function readU32LE(b, off) {
  return (b[off + 3] << 24 | b[off + 2] << 16 | b[off + 1] << 8 | b[off]) >>> 0;
}
function lengthBits(bytes) {
  const bits = bytes * 8;
  return { hi: Math.floor(bits / 4294967296) >>> 0, lo: bits >>> 0 };
}

// src/mcloud/envelope.ts
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseSignInEnvelope(body) {
  let v;
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
  if (typeof raw === "number") code = Number.isFinite(raw) ? raw : -1;
  else if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
    code = Number(raw);
  }
  const msg = v.msg ?? v.message;
  const message = typeof msg === "string" ? msg : "";
  return {
    code,
    message,
    result: v.result,
    ok: code === 0
  };
}
function resultArray(env) {
  return Array.isArray(env.result) ? env.result : [];
}
function resultObject(env) {
  return isRecord(env.result) ? env.result : {};
}

// src/mcloud/client.ts
var isFetchError = (v) => typeof v === "object" && v !== null && typeof v.error === "string";
function pickError(msg) {
  return msg.replace(/^\s*请求失败[:：]\s*/, "").trim() || msg;
}
function hostFetchOptions(req, timeoutMs) {
  const opts = {
    method: req.method,
    headers: req.headers,
    body: req.body,
    timeout_ms: timeoutMs
  };
  if (req.tls !== void 0 && req.url.startsWith("https:")) opts.tls = req.tls;
  return opts;
}
function callOnce(transport2, req) {
  const t0 = Date.now();
  const fail = (error2) => ({
    status: 0,
    tookMs: Date.now() - t0,
    env: void 0,
    ok: false,
    error: error2,
    raw: "",
    setCookies: []
  });
  let res;
  try {
    res = transport2(req);
  } catch (e) {
    return fail(`请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (isFetchError(res)) return fail(pickError(res.error));
  if (typeof res !== "object" || res === null || typeof res.body !== "string") {
    return fail(`请求返回的形状不认识：${JSON.stringify(res)?.slice(0, 200) ?? String(res)}`);
  }
  const tookMs = Date.now() - t0;
  const raw = res.body.length > 500 ? `${res.body.slice(0, 500)}…` : res.body;
  let env;
  let error;
  if (res.status !== 200) {
    error = `HTTP ${res.status}`;
  } else {
    try {
      env = parseSignInEnvelope(res.body);
      if (!env.ok) error = `code=${env.code}${env.message ? ` msg=${env.message}` : ""}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    status: res.status,
    tookMs,
    env,
    ok: res.status === 200 && !!env?.ok,
    error,
    raw,
    setCookies: extractSetCookies(res.headers)
  };
}
var CONTENT_TYPE_JSON = "application/json;charset=UTF-8";
function applyDefaultContentType(req) {
  if (req.body === void 0) return req;
  const declared = Object.keys(req.headers).some((k) => k.toLowerCase() === "content-type");
  if (declared) return req;
  return { ...req, headers: { ...req.headers, "content-type": CONTENT_TYPE_JSON } };
}
function callRawText(transport2, req) {
  const t0 = Date.now();
  const fail = (error) => ({
    ok: false,
    status: 0,
    text: "",
    chars: 0,
    tookMs: Date.now() - t0,
    error
  });
  let res;
  try {
    res = transport2(req);
  } catch (e) {
    return fail(`请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const tookMs = Date.now() - t0;
  if (isFetchError(res)) return { ...fail(pickError(res.error)), tookMs };
  if (typeof res !== "object" || res === null || typeof res.body !== "string") {
    return {
      ...fail(`请求返回的形状不认识：${JSON.stringify(res)?.slice(0, 200) ?? String(res)}`),
      tookMs
    };
  }
  const chars = res.body.length;
  if (res.status !== 200) {
    return { ok: false, status: res.status, text: res.body, chars, tookMs, error: `HTTP ${res.status}` };
  }
  return { ok: true, status: 200, text: res.body, chars, tookMs, error: void 0 };
}
function extractSetCookies(headers) {
  const raw = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "set-cookie") raw.push(v);
  }
  const out = [];
  for (const line of raw) {
    let cur = line;
    const parts = [];
    let idx = 0;
    for (; ; ) {
      const m = /,\s*([A-Za-z0-9_.-]+)=/.exec(cur.slice(idx));
      if (!m || m.index === void 0) break;
      parts.push(cur.slice(idx, idx + m.index));
      idx += m.index + 1;
    }
    parts.push(cur.slice(idx));
    for (const p of parts) {
      cur = p.trim();
      if (!cur) continue;
      const pair = cur.split(";")[0]?.trim() ?? "";
      if (pair.includes("=")) out.push(pair);
    }
  }
  return out;
}
function mergeCookieJar(existing, incoming) {
  const jar = /* @__PURE__ */ new Map();
  const eat = (s) => {
    for (const part of s.split(";")) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      if (eq <= 0) continue;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      if (v === "" || /^(deleted|expired)$/i.test(v)) jar.delete(k);
      else jar.set(k, v);
    }
  };
  eat(existing);
  for (const c of incoming) eat(c);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// src/store/types.ts
var SESSION_KEY = "mcloud.session";
function loadSession(store2) {
  const raw = store2.getState(SESSION_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const cookie = typeof v.cookie === "string" ? v.cookie : "";
    const jwt = typeof v.jwt === "string" ? v.jwt : "";
    if (cookie === "" && jwt === "") return null;
    return {
      cookie,
      jwt: jwt === "" ? void 0 : jwt,
      deviceId: typeof v.deviceId === "string" ? v.deviceId : void 0,
      userAgent: typeof v.userAgent === "string" ? v.userAgent : void 0,
      savedAt: typeof v.savedAt === "string" ? v.savedAt : ""
    };
  } catch {
    return null;
  }
}
function saveSession(store2, s, nowIso) {
  store2.setState(SESSION_KEY, JSON.stringify({ ...s, savedAt: nowIso }), nowIso);
}

// src/mcloud/accounts.ts
var STATE_ACCOUNTS = "mcloud.accounts";
var STATE_CURRENT_ACCOUNT = "mcloud.account.current";
function loadAccounts(store2) {
  const raw = store2.getState(STATE_ACCOUNTS);
  if (raw === null || raw === void 0 || raw.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const it of parsed) {
    if (it === null || typeof it !== "object") continue;
    const o = it;
    if (typeof o.id !== "string" || typeof o.auth !== "string" || o.auth === "") continue;
    out.push({
      id: o.id,
      label: typeof o.label === "string" && o.label !== "" ? o.label : o.id,
      auth: o.auth,
      addedAt: typeof o.addedAt === "string" ? o.addedAt : ""
    });
  }
  return out;
}
function currentAccount(store2) {
  const id = (store2.getState(STATE_CURRENT_ACCOUNT) ?? "").trim();
  if (id === "") return void 0;
  return loadAccounts(store2).find((a) => a.id === id);
}

// src/crypto/md5.ts
var S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
var K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}
function rotl(x, n) {
  return (x << n | x >>> 32 - n) >>> 0;
}
function padLE(bytes) {
  const { hi, lo } = lengthBits(bytes.length);
  const total = (bytes.length + 8 >> 6) + 1 << 6;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 128;
  writeU32LE(out, total - 8, lo);
  writeU32LE(out, total - 4, hi);
  return out;
}
function md5(bytes) {
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const padded = padLE(bytes);
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = readU32LE(padded, off + j * 4);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = b & c | ~b & d;
        g = i;
      } else if (i < 32) {
        f = d & b | ~d & c;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = 7 * i % 16;
      }
      f = f + a + K[i] + m[g] >>> 0;
      a = d;
      d = c;
      c = b;
      b = b + rotl(f, S[i]) >>> 0;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  const out = new Uint8Array(16);
  writeU32LE(out, 0, a0);
  writeU32LE(out, 4, b0);
  writeU32LE(out, 8, c0);
  writeU32LE(out, 12, d0);
  return out;
}

// src/crypto/tables.ts
var SHA256_K = [
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
];
var SHA256_H = [
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
];

// src/crypto/sha256.ts
function rotr(x, n) {
  return (x >>> n | x << 32 - n) >>> 0;
}
function sha256(bytes) {
  const h = Uint32Array.from(SHA256_H);
  const { hi, lo } = lengthBits(bytes.length);
  const total = (bytes.length + 8 >> 6) + 1 << 6;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 128;
  writeU32BE(padded, total - 8, hi);
  writeU32BE(padded, total - 4, lo);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = readU32BE(padded, off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10) >>> 0;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = (e & f ^ ~e & g) >>> 0;
      const t1 = hh + S1 + ch + SHA256_K[i] + w[i] >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = (a & b ^ a & c ^ b & c) >>> 0;
      const t2 = S0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) writeU32BE(out, i * 4, h[i]);
  return out;
}

// src/crypto/hmac.ts
var md5Hex = (d) => toHex(md5(anyBytes(d)));
var sha256Hex = (d) => toHex(sha256(anyBytes(d)));
function anyBytes(d) {
  return typeof d === "string" ? utf8(d) : d;
}

// src/crypto/aes.ts
function gfMul(a, b) {
  let r = 0;
  let x = a & 255;
  let y = b & 255;
  while (y > 0) {
    if (y & 1) r ^= x;
    const hi = x & 128;
    x = x << 1 & 255;
    if (hi) x ^= 27;
    y >>= 1;
  }
  return r & 255;
}
function rotl8(x, n) {
  return (x << n | x >> 8 - n) & 255;
}
var SBOX = (() => {
  const s = new Uint8Array(256);
  for (let a = 0; a < 256; a += 1) {
    let inv = 0;
    if (a !== 0) {
      let r = 1;
      let b = a;
      let e = 254;
      while (e > 0) {
        if (e & 1) r = gfMul(r, b);
        b = gfMul(b, b);
        e >>= 1;
      }
      inv = r;
    }
    s[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 99) & 255;
  }
  return s;
})();
var INV_SBOX = (() => {
  const inv = new Uint8Array(256);
  for (let a = 0; a < 256; a += 1) inv[SBOX[a]] = a;
  return inv;
})();
function fitKey16(key) {
  const out = new Uint8Array(16);
  const src = utf8(key);
  out.set(src.subarray(0, 16));
  return out;
}
function aes128KeyExpansion(key) {
  if (key.length !== 16) throw new Error(`AES: 密钥必须是 16 字节（得到 ${key.length}）`);
  const RCON = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 4; i < 44; i += 1) {
    let t0 = w[(i - 1) * 4];
    let t1 = w[(i - 1) * 4 + 1];
    let t2 = w[(i - 1) * 4 + 2];
    let t3 = w[(i - 1) * 4 + 3];
    if (i % 4 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ RCON[i / 4 - 1];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    }
    const p = (i - 4) * 4;
    w[i * 4] = w[p] ^ t0;
    w[i * 4 + 1] = w[p + 1] ^ t1;
    w[i * 4 + 2] = w[p + 2] ^ t2;
    w[i * 4 + 3] = w[p + 3] ^ t3;
  }
  return w;
}
function aes128EncryptBlock(rk, block) {
  if (block.length !== 16) throw new Error(`AES: 块必须是 16 字节（得到 ${block.length}）`);
  const s = new Uint8Array(block);
  const addRoundKey = (round) => {
    for (let i = 0; i < 16; i += 1) s[i] = s[i] ^ rk[round * 16 + i];
  };
  const subBytes = () => {
    for (let i = 0; i < 16; i += 1) s[i] = SBOX[s[i]];
  };
  const shiftRows = () => {
    for (let r = 1; r < 4; r += 1) {
      const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
      for (let c = 0; c < 4; c += 1) s[r + 4 * c] = row[(c + r) % 4];
    }
  };
  const mixColumns = () => {
    for (let c = 0; c < 4; c += 1) {
      const i = 4 * c;
      const a0 = s[i];
      const a1 = s[i + 1];
      const a2 = s[i + 2];
      const a3 = s[i + 3];
      s[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
      s[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
      s[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
      s[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
    }
  };
  addRoundKey(0);
  for (let round = 1; round <= 9; round += 1) {
    subBytes();
    shiftRows();
    mixColumns();
    addRoundKey(round);
  }
  subBytes();
  shiftRows();
  addRoundKey(10);
  return s;
}
function pkcs7Pad(msg, blockSize) {
  const pad = blockSize - msg.length % blockSize;
  const out = new Uint8Array(msg.length + pad);
  out.set(msg);
  out.fill(pad, msg.length);
  return out;
}
function aes128CbcEncrypt(key, iv, msg) {
  if (iv.length !== 16) throw new Error("AES: IV 必须是 16 字节");
  if (msg.length % 16 !== 0) throw new Error(`AES: 明文必须是 16 的整数倍（得到 ${msg.length}）`);
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(msg.length);
  let prev = new Uint8Array(iv);
  for (let off = 0; off < msg.length; off += 16) {
    const blk = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) blk[i] = msg[off + i] ^ prev[i];
    prev = aes128EncryptBlock(rk, blk);
    out.set(prev, off);
  }
  return out;
}
var AES_FIXED_IV = (() => {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = "0102030405060708".charCodeAt(i);
  return out;
})();
function aesEncryptCompatHex(key, message) {
  const padded = pkcs7Pad(utf8(message), 16);
  return toHex(aes128CbcEncrypt(fitKey16(key), AES_FIXED_IV, padded));
}

// src/crypto/desTables.ts
var PC1 = [
  57,
  49,
  41,
  33,
  25,
  17,
  9,
  1,
  58,
  50,
  42,
  34,
  26,
  18,
  10,
  2,
  59,
  51,
  43,
  35,
  27,
  19,
  11,
  3,
  60,
  52,
  44,
  36,
  63,
  55,
  47,
  39,
  31,
  23,
  15,
  7,
  62,
  54,
  46,
  38,
  30,
  22,
  14,
  6,
  61,
  53,
  45,
  37,
  29,
  21,
  13,
  5,
  28,
  20,
  12,
  4
];
var PC2 = [
  14,
  17,
  11,
  24,
  1,
  5,
  3,
  28,
  15,
  6,
  21,
  10,
  23,
  19,
  12,
  4,
  26,
  8,
  16,
  7,
  27,
  20,
  13,
  2,
  41,
  52,
  31,
  37,
  47,
  55,
  30,
  40,
  51,
  45,
  33,
  48,
  44,
  49,
  39,
  56,
  34,
  53,
  46,
  42,
  50,
  36,
  29,
  32
];
var BIT_SHIFTS = [1, 2, 4, 6, 8, 10, 12, 14, 15, 17, 19, 21, 23, 25, 27, 28];
var SBOX_P = [
  {
    0: 8421888,
    268435456: 32768,
    536870912: 8421378,
    805306368: 2,
    1073741824: 512,
    1342177280: 8421890,
    1610612736: 8389122,
    1879048192: 8388608,
    2147483648: 514,
    2415919104: 8389120,
    2684354560: 33280,
    2952790016: 8421376,
    3221225472: 32770,
    3489660928: 8388610,
    3758096384: 0,
    4026531840: 33282,
    134217728: 0,
    402653184: 8421890,
    671088640: 33282,
    939524096: 32768,
    1207959552: 8421888,
    1476395008: 512,
    1744830464: 8421378,
    2013265920: 2,
    2281701376: 8389120,
    2550136832: 33280,
    2818572288: 8421376,
    3087007744: 8389122,
    3355443200: 8388610,
    3623878656: 32770,
    3892314112: 514,
    4160749568: 8388608,
    1: 32768,
    268435457: 2,
    536870913: 8421888,
    805306369: 8388608,
    1073741825: 8421378,
    1342177281: 33280,
    1610612737: 512,
    1879048193: 8389122,
    2147483649: 8421890,
    2415919105: 8421376,
    2684354561: 8388610,
    2952790017: 33282,
    3221225473: 514,
    3489660929: 8389120,
    3758096385: 32770,
    4026531841: 0,
    134217729: 8421890,
    402653185: 8421376,
    671088641: 8388608,
    939524097: 512,
    1207959553: 32768,
    1476395009: 8388610,
    1744830465: 2,
    2013265921: 33282,
    2281701377: 32770,
    2550136833: 8389122,
    2818572289: 514,
    3087007745: 8421888,
    3355443201: 8389120,
    3623878657: 0,
    3892314113: 33280,
    4160749569: 8421378
  },
  {
    0: 1074282512,
    16777216: 16384,
    33554432: 524288,
    50331648: 1074266128,
    67108864: 1073741840,
    83886080: 1074282496,
    100663296: 1073758208,
    117440512: 16,
    134217728: 540672,
    150994944: 1073758224,
    167772160: 1073741824,
    184549376: 540688,
    201326592: 524304,
    218103808: 0,
    234881024: 16400,
    251658240: 1074266112,
    8388608: 1073758208,
    25165824: 540688,
    41943040: 16,
    58720256: 1073758224,
    75497472: 1074282512,
    92274688: 1073741824,
    109051904: 524288,
    125829120: 1074266128,
    142606336: 524304,
    159383552: 0,
    176160768: 16384,
    192937984: 1074266112,
    209715200: 1073741840,
    226492416: 540672,
    243269632: 1074282496,
    260046848: 16400,
    268435456: 0,
    285212672: 1074266128,
    301989888: 1073758224,
    318767104: 1074282496,
    335544320: 1074266112,
    352321536: 16,
    369098752: 540688,
    385875968: 16384,
    402653184: 16400,
    419430400: 524288,
    436207616: 524304,
    452984832: 1073741840,
    469762048: 540672,
    486539264: 1073758208,
    503316480: 1073741824,
    520093696: 1074282512,
    276824064: 540688,
    293601280: 524288,
    310378496: 1074266112,
    327155712: 16384,
    343932928: 1073758208,
    360710144: 1074282512,
    377487360: 16,
    394264576: 1073741824,
    411041792: 1074282496,
    427819008: 1073741840,
    444596224: 1073758224,
    461373440: 524304,
    478150656: 0,
    494927872: 16400,
    511705088: 1074266128,
    528482304: 540672
  },
  {
    0: 260,
    1048576: 0,
    2097152: 67109120,
    3145728: 65796,
    4194304: 65540,
    5242880: 67108868,
    6291456: 67174660,
    7340032: 67174400,
    8388608: 67108864,
    9437184: 67174656,
    10485760: 65792,
    11534336: 67174404,
    12582912: 67109124,
    13631488: 65536,
    14680064: 4,
    15728640: 256,
    524288: 67174656,
    1572864: 67174404,
    2621440: 0,
    3670016: 67109120,
    4718592: 67108868,
    5767168: 65536,
    6815744: 65540,
    7864320: 260,
    8912896: 4,
    9961472: 256,
    11010048: 67174400,
    12058624: 65796,
    13107200: 65792,
    14155776: 67109124,
    15204352: 67174660,
    16252928: 67108864,
    16777216: 67174656,
    17825792: 65540,
    18874368: 65536,
    19922944: 67109120,
    20971520: 256,
    22020096: 67174660,
    23068672: 67108868,
    24117248: 0,
    25165824: 67109124,
    26214400: 67108864,
    27262976: 4,
    28311552: 65792,
    29360128: 67174400,
    30408704: 260,
    31457280: 65796,
    32505856: 67174404,
    17301504: 67108864,
    18350080: 260,
    19398656: 67174656,
    20447232: 0,
    21495808: 65540,
    22544384: 67109120,
    23592960: 256,
    24641536: 67174404,
    25690112: 65536,
    26738688: 67174660,
    27787264: 65796,
    28835840: 67108868,
    29884416: 67109124,
    30932992: 67174400,
    31981568: 4,
    33030144: 65792
  },
  {
    0: 2151682048,
    65536: 2147487808,
    131072: 4198464,
    196608: 2151677952,
    262144: 0,
    327680: 4198400,
    393216: 2147483712,
    458752: 4194368,
    524288: 2147483648,
    589824: 4194304,
    655360: 64,
    720896: 2147487744,
    786432: 2151678016,
    851968: 4160,
    917504: 4096,
    983040: 2151682112,
    32768: 2147487808,
    98304: 64,
    163840: 2151678016,
    229376: 2147487744,
    294912: 4198400,
    360448: 2151682112,
    425984: 0,
    491520: 2151677952,
    557056: 4096,
    622592: 2151682048,
    688128: 4194304,
    753664: 4160,
    819200: 2147483648,
    884736: 4194368,
    950272: 4198464,
    1015808: 2147483712,
    1048576: 4194368,
    1114112: 4198400,
    1179648: 2147483712,
    1245184: 0,
    1310720: 4160,
    1376256: 2151678016,
    1441792: 2151682048,
    1507328: 2147487808,
    1572864: 2151682112,
    1638400: 2147483648,
    1703936: 2151677952,
    1769472: 4198464,
    1835008: 2147487744,
    1900544: 4194304,
    1966080: 64,
    2031616: 4096,
    1081344: 2151677952,
    1146880: 2151682112,
    1212416: 0,
    1277952: 4198400,
    1343488: 4194368,
    1409024: 2147483648,
    1474560: 2147487808,
    1540096: 64,
    1605632: 2147483712,
    1671168: 4096,
    1736704: 2147487744,
    1802240: 2151678016,
    1867776: 4160,
    1933312: 2151682048,
    1998848: 4194304,
    2064384: 4198464
  },
  {
    0: 128,
    4096: 17039360,
    8192: 262144,
    12288: 536870912,
    16384: 537133184,
    20480: 16777344,
    24576: 553648256,
    28672: 262272,
    32768: 16777216,
    36864: 537133056,
    40960: 536871040,
    45056: 553910400,
    49152: 553910272,
    53248: 0,
    57344: 17039488,
    61440: 553648128,
    2048: 17039488,
    6144: 553648256,
    10240: 128,
    14336: 17039360,
    18432: 262144,
    22528: 537133184,
    26624: 553910272,
    30720: 536870912,
    34816: 537133056,
    38912: 0,
    43008: 553910400,
    47104: 16777344,
    51200: 536871040,
    55296: 553648128,
    59392: 16777216,
    63488: 262272,
    65536: 262144,
    69632: 128,
    73728: 536870912,
    77824: 553648256,
    81920: 16777344,
    86016: 553910272,
    90112: 537133184,
    94208: 16777216,
    98304: 553910400,
    102400: 553648128,
    106496: 17039360,
    110592: 537133056,
    114688: 262272,
    118784: 536871040,
    122880: 0,
    126976: 17039488,
    67584: 553648256,
    71680: 16777216,
    75776: 17039360,
    79872: 537133184,
    83968: 536870912,
    88064: 17039488,
    92160: 128,
    96256: 553910272,
    100352: 262272,
    104448: 553910400,
    108544: 0,
    112640: 553648128,
    116736: 16777344,
    120832: 262144,
    124928: 537133056,
    129024: 536871040
  },
  {
    0: 268435464,
    256: 8192,
    512: 270532608,
    768: 270540808,
    1024: 268443648,
    1280: 2097152,
    1536: 2097160,
    1792: 268435456,
    2048: 0,
    2304: 268443656,
    2560: 2105344,
    2816: 8,
    3072: 270532616,
    3328: 2105352,
    3584: 8200,
    3840: 270540800,
    128: 270532608,
    384: 270540808,
    640: 8,
    896: 2097152,
    1152: 2105352,
    1408: 268435464,
    1664: 268443648,
    1920: 8200,
    2176: 2097160,
    2432: 8192,
    2688: 268443656,
    2944: 270532616,
    3200: 0,
    3456: 270540800,
    3712: 2105344,
    3968: 268435456,
    4096: 268443648,
    4352: 270532616,
    4608: 270540808,
    4864: 8200,
    5120: 2097152,
    5376: 268435456,
    5632: 268435464,
    5888: 2105344,
    6144: 2105352,
    6400: 0,
    6656: 8,
    6912: 270532608,
    7168: 8192,
    7424: 268443656,
    7680: 270540800,
    7936: 2097160,
    4224: 8,
    4480: 2105344,
    4736: 2097152,
    4992: 268435464,
    5248: 268443648,
    5504: 8200,
    5760: 270540808,
    6016: 270532608,
    6272: 270540800,
    6528: 270532616,
    6784: 8192,
    7040: 2105352,
    7296: 2097160,
    7552: 0,
    7808: 268435456,
    8064: 268443656
  },
  {
    0: 1048576,
    16: 33555457,
    32: 1024,
    48: 1049601,
    64: 34604033,
    80: 0,
    96: 1,
    112: 34603009,
    128: 33555456,
    144: 1048577,
    160: 33554433,
    176: 34604032,
    192: 34603008,
    208: 1025,
    224: 1049600,
    240: 33554432,
    8: 34603009,
    24: 0,
    40: 33555457,
    56: 34604032,
    72: 1048576,
    88: 33554433,
    104: 33554432,
    120: 1025,
    136: 1049601,
    152: 33555456,
    168: 34603008,
    184: 1048577,
    200: 1024,
    216: 34604033,
    232: 1,
    248: 1049600,
    256: 33554432,
    272: 1048576,
    288: 33555457,
    304: 34603009,
    320: 1048577,
    336: 33555456,
    352: 34604032,
    368: 1049601,
    384: 1025,
    400: 34604033,
    416: 1049600,
    432: 1,
    448: 0,
    464: 34603008,
    480: 33554433,
    496: 1024,
    264: 1049600,
    280: 33555457,
    296: 34603009,
    312: 1,
    328: 33554432,
    344: 1048576,
    360: 1025,
    376: 34604032,
    392: 33554433,
    408: 34603008,
    424: 0,
    440: 34604033,
    456: 1049601,
    472: 1024,
    488: 33555456,
    504: 1048577
  },
  {
    0: 134219808,
    1: 131072,
    2: 134217728,
    3: 32,
    4: 131104,
    5: 134350880,
    6: 134350848,
    7: 2048,
    8: 134348800,
    9: 134219776,
    10: 133120,
    11: 134348832,
    12: 2080,
    13: 0,
    14: 134217760,
    15: 133152,
    2147483648: 2048,
    2147483649: 134350880,
    2147483650: 134219808,
    2147483651: 134217728,
    2147483652: 134348800,
    2147483653: 133120,
    2147483654: 133152,
    2147483655: 32,
    2147483656: 134217760,
    2147483657: 2080,
    2147483658: 131104,
    2147483659: 134350848,
    2147483660: 0,
    2147483661: 134348832,
    2147483662: 134219776,
    2147483663: 131072,
    16: 133152,
    17: 134350848,
    18: 32,
    19: 2048,
    20: 134219776,
    21: 134217760,
    22: 134348832,
    23: 131072,
    24: 0,
    25: 131104,
    26: 134348800,
    27: 134219808,
    28: 134350880,
    29: 133120,
    30: 2080,
    31: 134217728,
    2147483664: 131072,
    2147483665: 2048,
    2147483666: 134348832,
    2147483667: 133152,
    2147483668: 32,
    2147483669: 134348800,
    2147483670: 134217728,
    2147483671: 134219808,
    2147483672: 134350880,
    2147483673: 134217760,
    2147483674: 134219776,
    2147483675: 0,
    2147483676: 133120,
    2147483677: 2080,
    2147483678: 131104,
    2147483679: 134350848
  }
];
var SBOX_MASK = [
  4160749569,
  528482304,
  33030144,
  2064384,
  129024,
  8064,
  504,
  2147483679
];

// src/crypto/des.ts
function fitKey8(key) {
  const out = new Uint8Array(8);
  const src = utf8(key);
  out.set(src.subarray(0, 8));
  return out;
}
function zeroPadToBlock(msg, blockSize) {
  const rem = msg.length % blockSize;
  if (rem === 0) return msg;
  const out = new Uint8Array(msg.length + (blockSize - rem));
  out.set(msg);
  return out;
}
function keyWords(key) {
  const be = (o) => (key[o] << 24 | key[o + 1] << 16 | key[o + 2] << 8 | key[o + 3]) >>> 0;
  return [be(0), be(4)];
}
function desSubKeys(key) {
  const [w0, w1] = keyWords(key);
  const words = [w0, w1];
  const keyBits = [];
  for (let i = 0; i < 56; i += 1) {
    const p = PC1[i] - 1;
    keyBits[i] = words[p >>> 5] >>> 31 - p % 32 & 1;
  }
  const subKeys = [];
  for (let n = 0; n < 16; n += 1) {
    const subKey = [];
    const bitShift = BIT_SHIFTS[n];
    for (let i = 0; i < 24; i += 1) {
      const left = keyBits[(PC2[i] - 1 + bitShift) % 28] << 31 - i % 6;
      const right = keyBits[28 + (PC2[i + 24] - 1 + bitShift) % 28] << 31 - i % 6;
      const a = i / 6 | 0;
      subKey[a] = (subKey[a] ?? 0) | left;
      subKey[4 + a] = (subKey[4 + a] ?? 0) | right;
    }
    subKey[0] = (subKey[0] << 1 | subKey[0] >>> 31) >>> 0;
    for (let i = 1; i < 7; i += 1) subKey[i] = subKey[i] >>> (i - 1) * 4 + 3;
    subKey[7] = (subKey[7] << 5 | subKey[7] >>> 27) >>> 0;
    subKeys.push(subKey);
  }
  return subKeys;
}
function desCryptBlock(l, r, subKeys) {
  let L = l >>> 0;
  let R = r >>> 0;
  const exLR = (off, mask) => {
    const t2 = (L >>> off ^ R) & mask;
    R = (R ^ t2) >>> 0;
    L = (L ^ t2 << off) >>> 0;
  };
  const exRL = (off, mask) => {
    const t2 = (R >>> off ^ L) & mask;
    L = (L ^ t2) >>> 0;
    R = (R ^ t2 << off) >>> 0;
  };
  exLR(4, 252645135);
  exLR(16, 65535);
  exRL(2, 858993459);
  exRL(8, 16711935);
  exLR(1, 1431655765);
  for (let round = 0; round < 16; round += 1) {
    const sk = subKeys[round];
    let f = 0;
    for (let i = 0; i < 8; i += 1) {
      const idx = ((R ^ sk[i]) & SBOX_MASK[i]) >>> 0;
      f |= SBOX_P[i][idx] ?? 0;
    }
    const nl = R;
    const nr = (L ^ f) >>> 0;
    L = nl;
    R = nr;
  }
  const t = L;
  L = R;
  R = t;
  exLR(1, 1431655765);
  exRL(8, 16711935);
  exRL(2, 858993459);
  exLR(16, 65535);
  exLR(4, 252645135);
  return [L >>> 0, R >>> 0];
}
function desEcbEncrypt(key, msg) {
  if (key.length !== 8) throw new Error(`DES: 密钥必须是 8 字节（得到 ${key.length}）`);
  const padded = zeroPadToBlock(msg, 8);
  if (padded.length === 0) return new Uint8Array(0);
  const subKeys = desSubKeys(key);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 8) {
    const l = (padded[off] << 24 | padded[off + 1] << 16 | padded[off + 2] << 8 | padded[off + 3]) >>> 0;
    const r = (padded[off + 4] << 24 | padded[off + 5] << 16 | padded[off + 6] << 8 | padded[off + 7]) >>> 0;
    const [cl, cr] = desCryptBlock(l, r, subKeys);
    out[off] = cl >>> 24 & 255;
    out[off + 1] = cl >>> 16 & 255;
    out[off + 2] = cl >>> 8 & 255;
    out[off + 3] = cl & 255;
    out[off + 4] = cr >>> 24 & 255;
    out[off + 5] = cr >>> 16 & 255;
    out[off + 6] = cr >>> 8 & 255;
    out[off + 7] = cr & 255;
  }
  return out;
}
function desEncryptBase64(message, key) {
  const padded = zeroPadToBlock(utf8(message), 8);
  if (padded.length === 0) return "";
  return toBase64(desEcbEncrypt(fitKey8(key), padded));
}

// src/crypto/gzip.ts
var GZIP_OS = 19;
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 4294967295;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 255] ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
}
function deflateStored(data) {
  const MAX = 65535;
  const chunks = data.length === 0 ? [data.subarray(0, 0)] : [];
  for (let off = 0; off < data.length; off += MAX) {
    chunks.push(data.subarray(off, Math.min(off + MAX, data.length)));
  }
  let total = 0;
  for (const c of chunks) total += 5 + c.length;
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach((c, i) => {
    const last = i === chunks.length - 1;
    out[p++] = last ? 1 : 0;
    const len = c.length;
    out[p++] = len & 255;
    out[p++] = len >>> 8 & 255;
    out[p++] = ~len & 255;
    out[p++] = ~len >>> 8 & 255;
    out.set(c, p);
    p += len;
  });
  return out;
}
function gzipWithOs19(data) {
  const body = deflateStored(data);
  const out = new Uint8Array(10 + body.length + 8);
  out[0] = 31;
  out[1] = 139;
  out[2] = 8;
  out[3] = 0;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = GZIP_OS;
  out.set(body, 10);
  const crc = crc32(data);
  const n = data.length >>> 0;
  const tail = 10 + body.length;
  out[tail] = crc & 255;
  out[tail + 1] = crc >>> 8 & 255;
  out[tail + 2] = crc >>> 16 & 255;
  out[tail + 3] = crc >>> 24 & 255;
  out[tail + 4] = n & 255;
  out[tail + 5] = n >>> 8 & 255;
  out[tail + 6] = n >>> 16 & 255;
  out[tail + 7] = n >>> 24 & 255;
  return out;
}
function gzipWithOs19Base64(data) {
  return toBase64(gzipWithOs19(data));
}

// src/crypto/rsa.ts
function derRead(buf, at) {
  const tag = buf[at];
  let p = at + 1;
  let len = buf[p];
  p += 1;
  if ((len & 128) !== 0) {
    const nLenBytes = len & 127;
    if (nLenBytes === 0 || nLenBytes > 4) {
      throw new Error(`RSA: 不支持的长度形式（0x80|${nLenBytes}）`);
    }
    len = 0;
    for (let i = 0; i < nLenBytes; i += 1) len = len * 256 + buf[p + i];
    p += nLenBytes;
  }
  return { tag, start: p, end: p + len };
}
function parseSpkiRsaPublicKey(b64) {
  const der = fromBase64(b64);
  const outer = derRead(der, 0);
  if (outer.tag !== 48) throw new Error("RSA: SPKI 不是 SEQUENCE");
  const algo = derRead(der, outer.start);
  if (algo.tag !== 48) throw new Error("RSA: AlgorithmIdentifier 缺失");
  const bits = derRead(der, algo.end);
  if (bits.tag !== 3) throw new Error("RSA: BIT STRING 缺失");
  if (der[bits.start] !== 0) throw new Error("RSA: BIT STRING 有未用位");
  const inner = derRead(der, bits.start + 1);
  if (inner.tag !== 48) throw new Error("RSA: 公钥不是 SEQUENCE");
  const intAt = (p) => {
    const it = derRead(der, p);
    if (it.tag !== 2) throw new Error("RSA: 期望 INTEGER");
    let v = 0n;
    for (let i = it.start; i < it.end; i += 1) v = v << 8n | BigInt(der[i]);
    return { v, next: it.end };
  };
  const nn = intAt(inner.start);
  const ee = intAt(nn.next);
  if (nn.v <= 0n || ee.v <= 0n) throw new Error("RSA: 公钥分量非正数");
  return { n: nn.v, e: ee.v };
}
function modPow(base, exp, m) {
  let result = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = result * b % m;
    b = b * b % m;
    e >>= 1n;
  }
  return result;
}
function bytesToBig(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i += 1) v = v << 8n | BigInt(bytes[i]);
  return v;
}
function bigToBytes(v, len) {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error(`RSA: 模幂结果装不进 ${len} 字节`);
  return out;
}
function rsaEncryptPkcs1v15(key, message, rng) {
  const k = Math.ceil(key.n.toString(16).length / 2);
  if (message.length > k - 11) {
    throw new Error(`RSA: 明文太长（${message.length} > ${k - 11}）`);
  }
  const psLen = k - message.length - 3;
  const ps = new Uint8Array(psLen);
  let filled = 0;
  let rounds = 0;
  while (filled < psLen) {
    if ((rounds += 1) > 64) {
      throw new Error("RSA: 随机源像是坏了（连取 64 轮都填不满 PS，取到的几乎全是 0）");
    }
    const chunk = rng(Math.max(8, psLen - filled));
    for (let i = 0; i < chunk.length && filled < psLen; i += 1) {
      if (chunk[i] !== 0) {
        ps[filled] = chunk[i];
        filled += 1;
      }
    }
  }
  const em = new Uint8Array(k);
  em[0] = 0;
  em[1] = 2;
  em.set(ps, 2);
  em[2 + psLen] = 0;
  em.set(message, 3 + psLen);
  const c = modPow(bytesToBig(em), key.e, key.n);
  return bigToBytes(c, k);
}
function rsaEncryptBase64(publicKeyB64, message, rng) {
  return toBase64(rsaEncryptPkcs1v15(parseSpkiRsaPublicKey(publicKeyB64), message, rng));
}

// src/mcloud/sign.ts
var SALT_MAP = [
  [1, "seedMdYYLIZfbCxg"],
  [2, "sekaMdYYLIZfbCfm"]
];
function saltFor(saltKey) {
  return saltKey === 2 ? SALT_MAP[1][1] : SALT_MAP[0][1];
}
function generateSignature(id, timestamp, nonce2, saltKey, other) {
  const salt = saltFor(saltKey);
  return md5Hex(salt + id + timestamp + nonce2 + other + salt);
}
function signHeadersWith(id, nonce2, timestampMs, saltKey, other) {
  return {
    "x-request-id": id,
    "x-timestamp": timestampMs,
    "x-nonce": nonce2,
    "x-signature": generateSignature(id, timestampMs, nonce2, saltKey, other)
  };
}

// src/mcloud/rand.ts
var counter = 0;
function rnd32() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
var HEX2 = "0123456789abcdef";
function uuidV4() {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    const v = rnd32();
    b[i] = v >>> 24 & 255;
    b[i + 1] = v >>> 16 & 255;
    b[i + 2] = v >>> 8 & 255;
    b[i + 3] = v & 255;
  }
  b[6] = b[6] & 15 | 64;
  b[8] = b[8] & 63 | 128;
  let s = "";
  for (let i = 0; i < 16; i += 1) {
    const v = b[i];
    s += HEX2[v >> 4] + HEX2[v & 15];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}
function nonce() {
  counter = (counter + 1) % 1e6;
  const r = rnd32().toString(16).padStart(8, "0");
  return `${Date.now().toString(16)}-${counter.toString(16)}-${r}`;
}

// src/mcloud/h5.ts
var MARKET_NAME = "sign_in_3";
var H5_APP_VERSION = "12.6.0.0";
var TASK_CLIENT_VERSION = "12.6.0";
function buildH5Request(spec) {
  const ts = spec.signInputs?.timestampMs ?? String(Date.now());
  const sign = signHeadersWith(
    spec.signInputs?.id ?? uuidV4(),
    spec.signInputs?.nonce ?? nonce(),
    ts,
    spec.saltKey,
    spec.other ?? ""
  );
  const headers = {
    Accept: "*/*",
    // ⚠ 跟本次的 marketname 走，不是恒定的 sign_in_3
    activityid: spec.marketName ?? MARKET_NAME,
    appversion: H5_APP_VERSION,
    Referer: spec.referer,
    showloading: spec.showLoading
  };
  if (spec.isDeviceId) headers.isdeviceid = "true";
  if (spec.session.jwt) headers.jwttoken = spec.session.jwt;
  if (spec.session.deviceId) headers.deviceid = spec.session.deviceId;
  if (spec.session.userAgent) headers["user-agent"] = spec.session.userAgent;
  if (spec.session.cookie) headers.cookie = spec.session.cookie;
  if (spec.method === "POST") {
    headers["content-type"] = spec.contentType ?? "application/json";
  }
  return {
    url: spec.url,
    method: spec.method,
    headers: { ...headers, ...sign },
    body: spec.method === "POST" ? spec.body ?? "null" : void 0
  };
}
var MCLOUD_HOST = "https://m.mcloud.139.com";
var BACKUP_GIFT_HOST = "https://caiyun.feixin.10086.cn";
var EP = {
  infoV3: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/infoV3" },
  startSignIn: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/startSignIn" },
  receiveV3: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/receiveV3" },
  taskExpansion: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/taskExpansion" },
  receiveTaskExpansion: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/receiveTaskExpansion" },
  receiveRevivalReward: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/receiveRevivalReward" },
  multiple: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/multiple" },
  prizeRecord: { origin: MCLOUD_HOST, path: "/ycloud/signin/public/record" },
  cloudRecordV2: { origin: MCLOUD_HOST, path: "/ycloud/signin/public/cloudRecordV2" },
  taskListV2: { origin: MCLOUD_HOST, path: "/ycloud/signin/task/taskListV2" },
  taskListV3: { origin: MCLOUD_HOST, path: "/ycloud/signin/task/taskListV3" },
  // 通知任务（`notice`）：两个端点都在主域，**裸 GET、不带查询参数**。
  // ⚠ "不带参数"本身是个**未验证的选择** —— 实拍的完整 URL 被脱敏，只见到路径。
  //   真要出问题（例如回了另一个活动的状态），改这一处加参数即可。
  // 兑换清单：**只读**，查询串只有 client 与 clientVersion，**不带 deviceId**
  exchangeList: { origin: MCLOUD_HOST, path: "/ycloud/signin/page/exchangeList" },
  noticeInfo: { origin: MCLOUD_HOST, path: "/ycloud/openemailsms-service/openEmailsms/getTaskInfo" },
  noticeReward: { origin: MCLOUD_HOST, path: "/ycloud/openemailsms-service/openEmailsms/reward" },
  backupGiftInfo: { origin: BACKUP_GIFT_HOST, path: "/market/backupgift/info" },
  backupGiftReceive: { origin: BACKUP_GIFT_HOST, path: "/market/backupgift/receive" },
  // 消息推送奖励（msgpushon 那一页）—— **同一台主机、不同一族**
  msgPushStatus: { origin: BACKUP_GIFT_HOST, path: "/market/msgPushOn/task/status" },
  msgPushObtain: { origin: BACKUP_GIFT_HOST, path: "/market/msgPushOn/task/obtain" }
};
function resolveUrl(name, base) {
  const ep = EP[name];
  return base ? base + ep.path : ep.origin + ep.path;
}
var REFERER_SIGN_IN = `${MCLOUD_HOST}/mcloud/sign_in/index.html`;
var SHOW_LOADING = "true";
var EP_METHOD = {
  infoV3: "GET",
  //  ?client=app（有 deviceId 时再 &deviceId=…）
  startSignIn: "GET",
  //  ?client=app（有 deviceId 时再 &deviceId=…）
  receiveV3: "POST",
  // json body
  taskExpansion: "GET",
  // 更正记录：这一条我起初写成 POST，查 `receive_task_expansion_request` 后改成 GET
  // （`h5(false, HttpRequest::get(url), "true")`）。表是从源码抄的，抄错就会得到 405——
  // 而 405 只会说"方法不对"，不会说"该用哪个"。
  receiveTaskExpansion: "GET",
  receiveRevivalReward: "POST",
  // json body `{}`
  multiple: "GET",
  prizeRecord: "GET",
  // 带 query 参数
  cloudRecordV2: "GET",
  // 带 query 参数
  taskListV2: "POST",
  // body 带 group=<组名>
  taskListV3: "POST",
  // body 带 group=""（空串）
  exchangeList: "GET",
  noticeInfo: "GET",
  noticeReward: "GET",
  // 写（会真入账），但上游用 GET
  backupGiftInfo: "GET",
  // 另一个域
  backupGiftReceive: "GET",
  // 另一个域
  msgPushStatus: "GET",
  msgPushObtain: "POST"
  // 这一族用 POST，body `{"type":2}`
};
var CLIENT_QUERY = "client=app";
function rootOrDefault(base, fallback) {
  const t = (base ?? "").trim();
  return t === "" ? fallback : t.replace(/\/+$/, "");
}

// src/mcloud/smidRules.ts
var SKLAND_SM_CONFIG = {
  organization: "FXlyfmWg2AzwbrxDKSv5",
  appId: "default",
  publicKey: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8KHAcHbkCn5rxGgGJE+07tY+pt86D/oZ7sA51FaEBv2jgno2TI9zHJVYKJynmiKpixgwUcv93EfWIrU/p/UCs5Vu+odS3I4UBp3R7IZ1A0W01FkumAHYW2PQpMm8ueQKPLUq/idkpG/9b2JDv/qU+Ks36nbUPwlW4CjdfrV+V9QIDAQAB",
  protocol: "https",
  apiHost: "slw.h5cmpassport.com:9090",
  apiPath: "/deviceprofile/v4"
};
var DES_RULE = {
  appId: {
    cipher: "DES",
    is_encrypt: 1,
    key: "a9kbown8",
    obfuscated_name: "um"
  },
  box: {
    is_encrypt: 0,
    obfuscated_name: "aw"
  },
  canvas: {
    cipher: "DES",
    is_encrypt: 1,
    key: "ultuhs59",
    obfuscated_name: "iu"
  },
  clientSize: {
    cipher: "DES",
    is_encrypt: 1,
    key: "7s9eixjh",
    obfuscated_name: "na"
  },
  organization: {
    cipher: "DES",
    is_encrypt: 1,
    key: "14e30pp1",
    obfuscated_name: "nl"
  },
  os: {
    cipher: "DES",
    is_encrypt: 1,
    key: "j862vr1f",
    obfuscated_name: "lz"
  },
  platform: {
    cipher: "DES",
    is_encrypt: 1,
    key: "pgutfbo7",
    obfuscated_name: "lm"
  },
  plugins: {
    cipher: "DES",
    is_encrypt: 1,
    key: "x98c92bm",
    obfuscated_name: "hy"
  },
  pmf: {
    cipher: "DES",
    is_encrypt: 1,
    key: "gwvvsmr4",
    obfuscated_name: "yu"
  },
  protocol: {
    is_encrypt: 0,
    obfuscated_name: "protocol"
  },
  referer: {
    cipher: "DES",
    is_encrypt: 1,
    key: "gka1ljjt",
    obfuscated_name: "mf"
  },
  res: {
    cipher: "DES",
    is_encrypt: 1,
    key: "ht2n6dwf",
    obfuscated_name: "ut"
  },
  rtype: {
    cipher: "DES",
    is_encrypt: 1,
    key: "k2p9ifij",
    obfuscated_name: "fm"
  },
  sdkver: {
    cipher: "DES",
    is_encrypt: 1,
    key: "q4ij0mv5",
    obfuscated_name: "ir"
  },
  status: {
    cipher: "DES",
    is_encrypt: 1,
    key: "moyspi7i",
    obfuscated_name: "kp"
  },
  subVersion: {
    cipher: "DES",
    is_encrypt: 1,
    key: "egsyl21v",
    obfuscated_name: "dk"
  },
  svm: {
    cipher: "DES",
    is_encrypt: 1,
    key: "yf780e9w",
    obfuscated_name: "ee"
  },
  time: {
    cipher: "DES",
    is_encrypt: 1,
    key: "btb17oag",
    obfuscated_name: "jt"
  },
  timezone: {
    cipher: "DES",
    is_encrypt: 1,
    key: "l94h8clc",
    obfuscated_name: "bl"
  },
  tn: {
    cipher: "DES",
    is_encrypt: 1,
    key: "crnw0x7e",
    obfuscated_name: "as"
  },
  trees: {
    cipher: "DES",
    is_encrypt: 1,
    key: "x6the9nq",
    obfuscated_name: "ij"
  },
  ua: {
    cipher: "DES",
    is_encrypt: 1,
    key: "bewicpxu",
    obfuscated_name: "pu"
  },
  url: {
    cipher: "DES",
    is_encrypt: 1,
    key: "llj8yd1x",
    obfuscated_name: "sb"
  },
  version: {
    is_encrypt: 0,
    obfuscated_name: "version"
  },
  vpw: {
    cipher: "DES",
    is_encrypt: 1,
    key: "f1zlae4b",
    obfuscated_name: "qb"
  }
};

// src/mcloud/smid.ts
var SMID_HOST = `${SKLAND_SM_CONFIG.protocol}://${SKLAND_SM_CONFIG.apiHost}`;
var SMID_PATH = SKLAND_SM_CONFIG.apiPath;
var SMID_OK_CODE = 1100;
var DEVICE_ID_PREFIX = "B";
var SMID_UA = "Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36";
var SMID_ORIGIN = "https://m.mcloud.139.com";
var SMID_REFERER = "https://m.mcloud.139.com/portal/mobilecloud/index.html";
var SMID_PAGE_URL = "https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=1002&token=";
var SMID_PLUGINS = "ChromePDFViewerPortableDocumentFormatinternal-pdf-viewer2,ChromiumPDFViewerPortableDocumentFormatinternal-pdf-viewer2,MicrosoftEdgePDFViewerPortableDocumentFormatinternal-pdf-viewer2,PDFViewerPortableDocumentFormatinternal-pdf-viewer2,WebKitbuilt-inPDFPortableDocumentFormatinternal-pdf-viewer2";
var SCREENS = [
  [375, 667],
  [390, 844],
  [414, 896],
  [360, 640],
  [360, 740],
  [412, 915],
  [1920, 1080],
  [1366, 768]
];
var PLATFORMS = ["Linux armv8l", "Linux aarch64"];
var DPRS = [2, 3];
var TOUCH_POINTS = [1, 5];
var CONNECTION_RTTS = [50, 100, 150];
var CPU_COUNTS = [4, 6, 8, 10, 12];
function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}
function newFingerprint(rnd = Math.random) {
  const s = pick(SCREENS, rnd);
  return {
    screenWidth: s[0],
    screenHeight: s[1],
    dpr: pick(DPRS, rnd),
    platform: pick(PLATFORMS, rnd),
    maxTouchPoints: pick(TOUCH_POINTS, rnd),
    connectionRtt: pick(CONNECTION_RTTS, rnd),
    cpucount: pick(CPU_COUNTS, rnd),
    // canvas 是一个 8 位 hex 摘要 —— 它也是"这台设备"的特征，所以同样只掷一次
    canvas: md5Hex(uuidV4()).slice(0, 8)
  };
}
var STATE_FINGERPRINT = "mcloud.smid.fingerprint";
function loadFingerprint(store2) {
  const raw = store2.getState(STATE_FINGERPRINT);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v.screenWidth !== "number" || typeof v.canvas !== "string") return null;
    return {
      screenWidth: v.screenWidth,
      screenHeight: v.screenHeight ?? v.screenWidth,
      dpr: v.dpr ?? 2,
      platform: v.platform ?? "Linux armv8l",
      maxTouchPoints: v.maxTouchPoints ?? 1,
      connectionRtt: v.connectionRtt ?? 50,
      cpucount: v.cpucount ?? 4,
      canvas: v.canvas
    };
  } catch {
    return null;
  }
}
function ensureFingerprint(store2, nowIso, rnd = Math.random) {
  const had = loadFingerprint(store2);
  if (had) return had;
  const fp = newFingerprint(rnd);
  store2.setState(STATE_FINGERPRINT, JSON.stringify(fp), nowIso);
  return fp;
}
function getTn(obj) {
  const out = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (typeof v === "number") {
      out.push(String(Number.isInteger(v) ? v * 1e4 : Math.floor(v * 1e4)));
    } else if (typeof v === "object" && v !== null) {
      out.push(getTn(v));
    } else {
      out.push(String(v));
    }
  }
  return out.join("");
}
function buildSmid(d, uid) {
  const p = (n, w) => String(n).padStart(w, "0");
  const timeStr = p(d.getFullYear(), 4) + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) + p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2);
  const v = `${timeStr}${md5Hex(uid)}00`;
  return `${v}${md5Hex(`smsk_web_${v}`).slice(0, 14)}0`;
}
function buildSmBody(fp, box, now, rnd = Math.random) {
  const level = Math.round(rnd() * 100) / 100;
  const body = {
    protocol: 4,
    organization: SKLAND_SM_CONFIG.organization,
    appId: SKLAND_SM_CONFIG.appId,
    os: "web",
    version: "3.0.0",
    sdkver: "3.0.0",
    box,
    rtype: "all",
    smid: buildSmid(now, uuidV4()),
    subVersion: "1.0.0",
    time: 7,
    platform: fp.platform,
    clientSize: `0_0_0_0_${fp.screenWidth}_${fp.screenHeight}_${fp.screenWidth}_${fp.screenHeight}`,
    res: `${fp.screenWidth}_${fp.screenHeight}_${fp.dpr}_2`,
    status: "0010",
    timezone: -480,
    vpw: uuidV4(),
    svm: now.getTime(),
    trees: uuidV4(),
    pmf: now.getTime(),
    cdp: 0,
    maxTouchPoints: fp.maxTouchPoints,
    connectionRtt: fp.connectionRtt,
    cpucount: fp.cpucount,
    battery: { charging: pick([0, 1], rnd), level },
    canvas: fp.canvas,
    plugins: SMID_PLUGINS,
    referer: "",
    ua: SMID_UA,
    url: SMID_PAGE_URL,
    tn: ""
  };
  body.tn = md5Hex(getTn(body));
  return body;
}
function encryptByDesRules(obj, rules = DES_RULE) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const rule = rules[key];
    if (!rule) {
      out[key] = value;
      continue;
    }
    if (rule.is_encrypt === 1) {
      out[rule.obfuscated_name] = desEncryptBase64(String(value), rule.key ?? "");
    } else {
      out[rule.obfuscated_name] = value;
    }
  }
  return out;
}
function encryptSmBody(body, priId, rules = DES_RULE) {
  const gz = gzipWithOs19Base64(utf8(JSON.stringify(encryptByDesRules(body, rules))));
  return aesEncryptCompatHex(priId, gz);
}
function smidUploadRequest(fp, box, now, rnd = Math.random, base) {
  const uid = uuidV4();
  const priId = md5Hex(uid).slice(0, 16);
  const ep = rsaEncryptBase64(
    SKLAND_SM_CONFIG.publicKey,
    utf8(uid),
    (n) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) b[i] = Math.floor(rnd() * 256) & 255;
      return b;
    }
  );
  const data = encryptSmBody(buildSmBody(fp, box, now, rnd), priId);
  return {
    // ⚠ `base` 覆盖**必须**有：这台主机是第三方（cmpassport 风控），
    // 而"CI 全程只打 mock"是本仓的硬规则。少了这个口子，E2E 会真去打那个域 ——
    // 那不是"测试不严"，是**把 CI 变成对外发流量**。
    url: `${rootOrDefault(base, SMID_HOST)}${SMID_PATH}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: SMID_ORIGIN,
      referer: SMID_REFERER,
      "user-agent": SMID_UA
    },
    body: JSON.stringify({
      appId: SKLAND_SM_CONFIG.appId,
      organization: SKLAND_SM_CONFIG.organization,
      ep,
      data,
      os: "web",
      encode: 5,
      compress: 2
    })
  };
}
function parseDeviceId(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `smid 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.code !== SMID_OK_CODE) {
    return { ok: false, error: `smid 上报失败：code=${String(v.code ?? "?")}（期望 ${SMID_OK_CODE}）` };
  }
  const detail = v.detail;
  const raw = detail && typeof detail === "object" ? detail.deviceId : void 0;
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, error: "smid 响应没有 detail.deviceId" };
  }
  return { ok: true, deviceId: DEVICE_ID_PREFIX + raw };
}

// src/mcloud/h5session.ts
var BASE_USER_YUN = "https://user-njs.yun.139.com";
var BASE_MCLOUD = "https://m.mcloud.139.com";
var H5_SALT_KEY = 2;
var H5_CONTENT_TYPE = "application/json;charset=UTF-8";
var H5_APP_VERSION2 = "12.6.0.0";
var SPEC_TOKEN_PATH = "/user/querySpecTokenV2";
var TIMESTAMP_PATH = "/ycloud/api/timestamp";
var TYRZ_LOGIN_PATH = "/ycloud/auth-service/auth/tyrzLogin";
var SIGN_IN_RECIPE = {
  toSourceId: "001005",
  marketName: "sign_in_3",
  sourceId: "1002",
  h5AppId: "cy62d5a5e8373a272aeca467accad61722c51cfd48",
  pagePath: "newsignin",
  portalPage: "mobilecloud",
  targetSourceId: "001005"
};
function pageUrl(p, ssoToken) {
  let url = `${BASE_MCLOUD}/portal/${p.portalPage}/index.html?path=${p.pagePath}&sourceid=${p.sourceId}`;
  if (p.h5AppId !== void 0) url += `&enableShare=1&appID=${p.h5AppId}`;
  url += `&token=${ssoToken}`;
  if (p.targetSourceId !== void 0) url += `&targetSourceId=${p.targetSourceId}`;
  if (p.h5AppId === void 0) url += "&enableShare=1";
  return url;
}
function h5Headers(params, referer, jwt, showLoading) {
  const h = {
    Accept: "*/*",
    activityid: params.marketName,
    appversion: H5_APP_VERSION2,
    Referer: referer,
    showloading: showLoading
  };
  if (jwt !== void 0) h.jwttoken = jwt;
  return h;
}
function specTokenRequest(params, authorization, base) {
  return {
    url: `${rootOrDefault(base, BASE_USER_YUN)}${SPEC_TOKEN_PATH}`,
    method: "POST",
    headers: { "Content-Type": H5_CONTENT_TYPE, Authorization: authorization },
    body: JSON.stringify({ toSourceId: params.toSourceId })
  };
}
function timestampRequest(params, referer, base) {
  return {
    url: `${rootOrDefault(base, BASE_MCLOUD)}${TIMESTAMP_PATH}`,
    method: "GET",
    headers: h5Headers(params, referer, void 0, "true"),
    body: void 0
  };
}
function tyrzLoginRequest(params, ssoToken, sign, referer, base) {
  const body = JSON.stringify({
    marketName: params.marketName,
    openAccount: 0,
    sourceId: params.sourceId,
    token: ssoToken
  });
  return {
    url: `${rootOrDefault(base, BASE_MCLOUD)}${TYRZ_LOGIN_PATH}`,
    method: "POST",
    headers: {
      ...h5Headers(params, referer, void 0, "true"),
      Origin: BASE_MCLOUD,
      "x-request-id": sign["x-request-id"],
      "x-timestamp": sign["x-timestamp"],
      "x-nonce": sign["x-nonce"],
      "x-signature": sign["x-signature"]
    },
    body
  };
}
function makeSign(serverTimestamp) {
  return signHeadersWith(uuidV4(), nonce(), serverTimestamp, H5_SALT_KEY, "");
}
function parseSsoToken(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `querySpecTokenV2 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.success !== true) {
    return {
      ok: false,
      error: `querySpecTokenV2 失败：code=${String(v.code ?? "?")} message=${String(v.message ?? "")}`
    };
  }
  const data = v.data;
  const token = data && typeof data === "object" ? data.token : void 0;
  if (typeof token !== "string" || token === "") {
    return { ok: false, error: "querySpecTokenV2 响应没有 data.token" };
  }
  return { ok: true, value: token };
}
function parseServerTimestamp(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `api/timestamp 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const r = v.result;
  if (typeof r === "number" && Number.isFinite(r)) return { ok: true, value: String(r) };
  if (typeof r === "string" && r !== "") return { ok: true, value: r };
  if (r === void 0) return { ok: false, error: "api/timestamp 响应没有 result" };
  return { ok: false, error: `api/timestamp 的 result 不是整数：${JSON.stringify(r)}` };
}
function parseJwtToken(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `tyrzLogin 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v.code;
  let codeOk;
  if (typeof code === "number") codeOk = code === 0;
  else if (typeof code === "string") codeOk = code === "0" || code === "0000";
  else if (code === null || code === void 0) codeOk = v.success === true;
  else return { ok: false, error: `tyrzLogin 的 code 类型意外：${JSON.stringify(code)}` };
  if (!codeOk) {
    const msg = typeof v.msg === "string" ? v.msg : typeof v.message === "string" ? v.message : "(无消息)";
    return { ok: false, error: `tyrzLogin 失败：code=${JSON.stringify(code ?? null)} msg=${msg}` };
  }
  const result = v.result;
  if (!result || typeof result !== "object") return { ok: false, error: "tyrzLogin 响应没有 result" };
  const r = result;
  if (typeof r.token !== "string" || r.token === "") {
    return { ok: false, error: "tyrzLogin 响应没有 result.token" };
  }
  return {
    ok: true,
    // `mobile` 可能缺失 —— 它是"确认签的是哪个账号"的回显，不是凭据的一部分，
    // 缺了不该让整次登录失败
    value: { jwt: r.token, mobile: typeof r.mobile === "string" ? r.mobile : void 0 }
  };
}
function normalizeAuthorization(raw) {
  const v = raw.trim();
  if (v === "") return { ok: false, error: "凭据是空的" };
  if (/^(basic|bearer)\s/i.test(v)) return { ok: true, value: v };
  if (/\s/.test(v)) {
    return {
      ok: false,
      error: '这个值里有空格但又不是 Basic/Bearer 开头 —— 像是抄断了。正确形状是 `Basic base64("mobile:手机号:token")`（整串一个空格）'
    };
  }
  return { ok: true, value: `Basic ${v}` };
}
function authFingerprint(sha256hex) {
  return sha256hex.slice(0, 16);
}

// src/mcloud/sessionExchange.ts
var STATE_AUTH = "mcloud.h5.auth";
function loadAuthRaw(store2) {
  const cur = currentAccount(store2);
  if (cur !== void 0) return cur.auth;
  return store2.getState(STATE_AUTH) ?? "";
}
var STATE_EXCHANGE = "mcloud.h5.exchange";
var STATE_JWT = "mcloud.h5.jwt";
var STATE_DEVICE_ID = "mcloud.smid.deviceId";
var JWT_TTL_MS = 100 * 60 * 1e3;
function parse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadExchange(store2) {
  return parse(store2.getState(STATE_EXCHANGE));
}
function loadJwt(store2) {
  return parse(store2.getState(STATE_JWT));
}
function jwtFresh(store2, nowMs) {
  const r = loadJwt(store2);
  if (!r) return false;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && nowMs - at < JWT_TTL_MS;
}
function startExchange(store2, raw, nowIso) {
  const norm = normalizeAuthorization(raw);
  if (!norm.ok || norm.value === void 0) return { ok: false, error: norm.error };
  const fingerprint = authFingerprint(sha256Hex(norm.value));
  store2.setState(STATE_AUTH, norm.value, nowIso);
  store2.setState(
    STATE_EXCHANGE,
    JSON.stringify({ step: "spec-token", fingerprint, startedAt: nowIso }),
    nowIso
  );
  return { ok: true, fingerprint };
}
function runExchangeStep(deps) {
  const st = loadExchange(deps.store);
  const auth = loadAuthRaw(deps.store) || null;
  if (!st || st.step === "done" || !auth) {
    return { ok: true, note: "没有待换票的任务（先去界面上贴一份原生凭据）", done: true };
  }
  const finish = (s, ok, note) => {
    s.step = "done";
    s.finishedAt = deps.nowIso;
    s.ok = ok;
    s.note = note;
    delete s.ssoToken;
    delete s.ts;
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(s), deps.nowIso);
    return { ok, note, done: true };
  };
  if (st.step === "smid") {
    const fp = ensureFingerprint(deps.store, deps.nowIso);
    const req = smidUploadRequest(
      fp,
      deps.store.getState(STATE_DEVICE_ID) ?? "",
      new Date(deps.nowIso),
      Math.random,
      deps.baseUrl
    );
    const res2 = callRawText(deps.transport, req);
    if (!res2.ok) return failStep(deps, st, `④ 换 deviceId 失败：${res2.error ?? "未知失败"}`);
    const got = parseDeviceId(res2.text);
    if (!got.ok || got.deviceId === void 0) return failStep(deps, st, `④ ${got.error}`);
    deps.store.setState(STATE_DEVICE_ID, got.deviceId, deps.nowIso);
    const cur = loadSession(deps.store);
    saveSession(
      deps.store,
      {
        cookie: cur?.cookie ?? "",
        jwt: cur?.jwt ?? "",
        deviceId: got.deviceId,
        userAgent: cur?.userAgent,
        savedAt: ""
      },
      deps.nowIso
    );
    return finish(st, true, `④ 换到 deviceId（${got.deviceId.length} 字符，B 开头）—— 领取类接口现在能用了`);
  }
  if (st.step === "spec-token") {
    const res2 = callRawText(deps.transport, specTokenRequest(SIGN_IN_RECIPE, auth, deps.baseUrl));
    if (!res2.ok) return failStep(deps, st, `① 换 SSO token 失败：${res2.error ?? "未知失败"}`);
    const p2 = parseSsoToken(res2.text);
    if (!p2.ok || p2.value === void 0) return failStep(deps, st, `① ${p2.error}`);
    st.ssoToken = p2.value;
    st.referer = pageUrl(SIGN_IN_RECIPE, p2.value);
    st.step = "timestamp";
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
    return { ok: true, note: "① 换到 SSO token（**不缓存**，下一步立刻用）", done: false };
  }
  if (st.step === "timestamp") {
    const res2 = callRawText(deps.transport, timestampRequest(SIGN_IN_RECIPE, st.referer ?? "", deps.baseUrl));
    if (!res2.ok) return failStep(deps, st, `② 取时间戳失败：${res2.error ?? "未知失败"}`);
    const p2 = parseServerTimestamp(res2.text);
    if (!p2.ok || p2.value === void 0) return failStep(deps, st, `② ${p2.error}`);
    st.ssoToken = st.ssoToken ?? "";
    st.ts = p2.value;
    st.step = "tyrz-login";
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
    return { ok: true, note: `② 服务端时间戳 ${p2.value}（**必须用它**，本地时钟偏一点就是 401）`, done: false };
  }
  const ts = st.ts;
  if (ts === void 0 || !st.ssoToken) {
    return finish(st, false, "③ 前置状态丢了（SSO token 或时间戳）—— SSO token 不缓存，得从头再来");
  }
  const res = callRawText(
    deps.transport,
    tyrzLoginRequest(SIGN_IN_RECIPE, st.ssoToken, makeSign(ts), st.referer ?? "", deps.baseUrl)
  );
  if (!res.ok) return failStep(deps, st, `③ 换 jwttoken 失败：${res.error ?? "未知失败"}`);
  const p = parseJwtToken(res.text);
  if (!p.ok || p.value === void 0) return failStep(deps, st, `③ ${p.error}`);
  const rec = {
    at: deps.nowIso,
    jwt: p.value.jwt,
    referer: st.referer ?? "",
    mobile: p.value.mobile,
    fingerprint: st.fingerprint
  };
  deps.store.setState(STATE_JWT, JSON.stringify(rec), deps.nowIso);
  const sess = loadSession(deps.store);
  const needDevice = (sess?.deviceId ?? "") === "";
  if (needDevice) {
    saveSession(
      deps.store,
      {
        cookie: sess?.cookie ?? "",
        jwt: p.value.jwt,
        deviceId: sess?.deviceId,
        userAgent: sess?.userAgent,
        savedAt: ""
      },
      deps.nowIso
    );
    st.step = "smid";
    deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
    return {
      ok: true,
      note: `③ 换到 jwttoken（${p.value.jwt.length} 字符）—— 再走一步换 \`deviceId\`（领取类接口要它）`,
      done: false
    };
  }
  saveSession(
    deps.store,
    {
      cookie: sess?.cookie ?? "",
      jwt: p.value.jwt,
      deviceId: sess?.deviceId,
      userAgent: sess?.userAgent,
      savedAt: ""
    },
    deps.nowIso
  );
  return finish(
    st,
    true,
    `③ 换到 jwttoken（${p.value.jwt.length} 字符${p.value.mobile ? `，回显 ${maskMobile(p.value.mobile)}` : ""}）—— 约 ${Math.round(JWT_TTL_MS / 6e4)} 分钟后该续` + // ⚠ 主动说出"缺 deviceId"：不说的话，用户第一次用 `receive` 会看到
    // 「活动太火爆啦」，然后以为过会儿就好 —— 而它其实永远不会好（是参数问题）。
    ((sess?.deviceId ?? "") === "" && (loadSession(deps.store)?.deviceId ?? "") === "" ? "。⚠ 这份会话**没有 `deviceId`**：领取类接口（receive）会回 615，而它的文案是「活动太火爆啦」—— 那不是在限流，是缺参数。要修：在会话 JSON 里带上 `deviceId`（H5 那一份是 `B` + 88 字符 base64）" : "")
  );
}
function failStep(deps, st, note) {
  st.step = "done";
  st.finishedAt = deps.nowIso;
  st.ok = false;
  st.note = note;
  delete st.ssoToken;
  delete st.ts;
  deps.store.setState(STATE_EXCHANGE, JSON.stringify(st), deps.nowIso);
  return { ok: false, note, done: true };
}
var RETRY_AFTER_MS = 30 * 60 * 1e3;
function needExchange(store2, nowMs) {
  if (loadAuthRaw(store2) === "") return false;
  if (jwtFresh(store2, nowMs)) return false;
  const st = loadExchange(store2);
  if (!st) return true;
  if (st.step !== "done") return true;
  if (st.ok === true) return true;
  const at = Date.parse(st.finishedAt ?? st.startedAt);
  return !Number.isFinite(at) || nowMs - at > RETRY_AFTER_MS;
}
function maskMobile(m) {
  return m.length >= 7 ? `${m.slice(0, 3)}****${m.slice(-4)}` : "***";
}

// src/mcloud/authRefresh.ts
var REFRESH_BASE = "https://user-njs.yun.139.com";
var REFRESH_PATH = "/user/auth/refreshToken";
var APP_CLIENT_TYPE = "412";
var PC_CLIENT_TYPE = "414";
function parseAuthorization(raw) {
  const b64 = raw.replace(/^Basic\s+/i, "").trim();
  if (!b64) return null;
  let plain;
  try {
    plain = fromUtf8(fromBase64(b64));
  } catch {
    return null;
  }
  const i = plain.indexOf(":");
  if (i < 0) return null;
  const j = plain.indexOf(":", i + 1);
  if (j < 0) {
    return { platform: plain.slice(0, i), phone: "", token: plain.slice(i + 1) };
  }
  return { platform: plain.slice(0, i), phone: plain.slice(i + 1, j), token: plain.slice(j + 1) };
}
function rebuildAuthorization(platform, phone, token) {
  return `Basic ${toBase64(utf8(`${platform}:${phone}:${token}`))}`;
}
function jwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const seg = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = seg + "=".repeat((4 - seg.length % 4) % 4);
  try {
    const v = JSON.parse(fromUtf8(fromBase64(padded)));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
function jwtUserDomainId(jwt) {
  const p = jwtPayload(jwt);
  if (!p) return null;
  const top = p.userDomainId;
  if (typeof top === "string" && top !== "") return top;
  const sub = p.sub;
  if (typeof sub === "string" && sub.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(sub);
      const v = inner.userDomainId;
      if (typeof v === "string" && v !== "") return v;
    } catch {
    }
  }
  return null;
}
function clientTypeFor(platform) {
  return platform === "pc" ? PC_CLIENT_TYPE : APP_CLIENT_TYPE;
}
function escapeJsonString(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (c < 32) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}
function refreshRequest(raw, userDomainId, platform) {
  const body = `{"userDomainId":"${escapeJsonString(userDomainId)}","clientType":"${escapeJsonString(clientTypeFor(platform))}"}`;
  return {
    url: `${REFRESH_BASE}${REFRESH_PATH}`,
    method: "POST",
    headers: {
      Authorization: raw
      // content-type 由传输层补（`application/json;charset=UTF-8`）—— 见 client.ts
    },
    body
  };
}
function parseRefresh(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `refreshToken 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v.code;
  const codeOk = typeof code === "string" && (code === "0000" || code === "0") || typeof code === "number" && code === 0;
  const success = typeof v.success === "boolean" ? v.success : codeOk;
  if (!success || !codeOk) {
    const msg = String(v.message ?? v.msg ?? "(无消息)");
    return { ok: false, error: `refreshToken 失败：code=${String(code ?? "?")} ${msg}` };
  }
  const data = v.data;
  if (!data || typeof data !== "object") return { ok: false, error: "refreshToken 响应没有 data" };
  const token = data.token;
  if (typeof token !== "string" || token === "") {
    return { ok: false, error: "refreshToken 响应没有 data.token" };
  }
  const exp = data.expireTime;
  const expireSeconds = typeof exp === "number" ? Math.trunc(exp) : typeof exp === "string" && /^\d+$/.test(exp) ? Number(exp) : void 0;
  return { ok: true, result: { token, expireSeconds } };
}
function applyRefreshResult(raw, res) {
  const seg = parseAuthorization(raw);
  if (!seg) return { ok: false, error: "当前凭据解不开（不是 `Basic base64(端别:手机号:token)`），无法重拼" };
  if (seg.phone === "") return { ok: false, error: "当前凭据里没有手机号段，无法重拼" };
  return { ok: true, raw: rebuildAuthorization(seg.platform, seg.phone, res.token) };
}
var DEFAULT_LEAD_DAYS = 10;
function tokenExpireMs(token) {
  const f = token.split("|")[3]?.trim() ?? "";
  if (!/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(f)) return 0;
  const v = Number(f);
  return Number.isFinite(v) && v !== 0 ? Math.trunc(v) : 0;
}
function credentialExpireMs(raw) {
  const seg = parseAuthorization(raw);
  if (!seg) return -1;
  return tokenExpireMs(seg.token);
}
function decide(expireMs, nowMs, leadDays = DEFAULT_LEAD_DAYS) {
  if (expireMs < 0) return "manual-only";
  if (expireMs === 0) return "needed";
  const leadMs = Math.trunc(leadDays * 864e5);
  return expireMs - nowMs <= leadMs ? "needed" : "not-yet";
}
function daysLeft(expireMs, nowMs) {
  if (expireMs <= 0) return void 0;
  return Math.floor((expireMs - nowMs) / 864e5);
}
function assertUsable(raw) {
  const seg = parseAuthorization(raw);
  if (!seg) return { ok: false, error: "新凭据解不开（不是 `Basic base64(端别:手机号:token)`）" };
  if (seg.platform === "" || seg.phone === "" || seg.token === "") {
    return { ok: false, error: "新凭据有段是空的，拒绝落库" };
  }
  return { ok: true };
}
var STATE_LAST = "mcloud.auth.refresh.last";
function runAuthRefresh(deps, force = false, leadDays = DEFAULT_LEAD_DAYS) {
  const raw = loadAuthRaw(deps.store);
  if (raw === "") {
    return { ok: true, skipped: true, note: "没有原生凭据，谈不上续期（先贴一份）" };
  }
  const nowMs = Date.parse(deps.nowIso);
  const expireMs = credentialExpireMs(raw);
  const decision = force ? "needed" : decide(expireMs, nowMs, leadDays);
  if (decision === "manual-only") {
    return {
      ok: true,
      skipped: true,
      note: "凭据解不开（过期段也没有）—— 这一档只能重新贴一份，续期接口帮不上"
    };
  }
  if (decision === "not-yet") {
    const d2 = daysLeft(expireMs, nowMs);
    return {
      ok: true,
      skipped: true,
      note: `凭据还有 ${d2 ?? "?"} 天，离提前量（${leadDays} 天）还远，不打上游`
    };
  }
  const jwt = loadJwt(deps.store);
  const domain = jwt ? jwtUserDomainId(jwt.jwt) : null;
  if (!domain) {
    return {
      ok: false,
      note: "该续期，但手里没有可用的 jwttoken ⇒ 取不到 userDomainId（它的唯一本地来源）。先跑一次换票"
    };
  }
  const seg = parseAuthorization(raw);
  const req = refreshRequest(raw, domain, seg.platform);
  const res = callRawText(deps.transport, req);
  if (!res.ok) return { ok: false, note: `续期失败：${res.error ?? "未知失败"}` };
  const parsed = parseRefresh(res.text);
  if (!parsed.ok || !parsed.result) return { ok: false, note: parsed.error ?? "续期失败" };
  const applied = applyRefreshResult(raw, parsed.result);
  if (!applied.ok) return { ok: false, note: applied.error };
  const usable = assertUsable(applied.raw);
  if (!usable.ok) return { ok: false, note: `拒绝落库：${usable.error}` };
  deps.store.setState(STATE_AUTH, applied.raw, deps.nowIso);
  deps.store.setState(
    STATE_LAST,
    JSON.stringify({
      at: deps.nowIso,
      expireSeconds: parsed.result.expireSeconds ?? null,
      oldFingerprint: seg.token.slice(-6),
      newFingerprint: parsed.result.token.slice(-6)
    }),
    deps.nowIso
  );
  startExchange(deps.store, applied.raw, deps.nowIso);
  const newExpire = tokenExpireMs(parsed.result.token);
  const d = daysLeft(newExpire, nowMs);
  return {
    ok: true,
    note: `凭据已续期（旧尾 ${seg.token.slice(-6)} → 新尾 ${parsed.result.token.slice(-6)}；上游说还能用 ${parsed.result.expireSeconds ?? "?"} 秒` + (d === void 0 ? "" : `，新过期还剩 ${d} 天`) + "）—— 已重起一轮换票，让票也来自新凭据"
  };
}

// src/mcloud/tasks/base.ts
var ERR_PREFIX = "mcloud.last_error.";
function recordError(store2, task, note, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, `${note} @ ${nowIso}`, nowIso);
}
function clearError(store2, task, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, "", nowIso);
}
function sessionHeaders(s) {
  return { jwt: s.jwt, deviceId: s.deviceId, userAgent: s.userAgent, cookie: s.cookie };
}
function runTask(deps, spec, judge) {
  const late = deps.lateMs ?? 0;
  if (spec.skipIfLaterThanMs !== void 0 && late > spec.skipIfLaterThanMs) {
    const mins = Math.round(late / 6e4);
    const note = `错过太久（晚了 ${mins} 分钟，阈值 ${Math.round(spec.skipIfLaterThanMs / 6e4)} 分钟）→ 主动跳过`;
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: true, skipped: true, note };
  }
  const session = loadSession(deps.store);
  if (!session) {
    const note = "未登录：state 里没有会话（见 docs/howto-session.md）";
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: false, note };
  }
  const method = spec.method ?? EP_METHOD[spec.endpoint] ?? "GET";
  const url = resolveUrl(spec.endpoint, deps.baseUrl) + (spec.query ? `?${spec.query}` : "");
  const req = buildH5Request({
    url,
    method,
    body: spec.body,
    contentType: spec.contentType,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: spec.isDeviceId ?? method === "POST",
    saltKey: 1,
    marketName: spec.marketName,
    session: sessionHeaders(session)
  });
  const res = callOnce(deps.transport, req);
  if (res.setCookies.length > 0) {
    saveSession(
      deps.store,
      { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
      deps.nowIso
    );
  }
  if (!res.ok) {
    const explained = spec.explainFail?.(res.env, res.error ?? "");
    if (explained !== void 0) {
      recordError(deps.store, spec.task, explained, deps.nowIso);
      return { ok: false, note: explained };
    }
    const note = res.error ?? "未知失败";
    if (spec.okWhenError?.(note)) {
      clearError(deps.store, spec.task, deps.nowIso);
      return { ok: true, note: `上游说「${note}」—— 按"已经完成"处理（见 okWhenError）` };
    }
    recordError(deps.store, spec.task, note, deps.nowIso);
    return { ok: false, note };
  }
  const verdict = judge(res.env, res);
  if (verdict.snapshot !== void 0 && spec.stateKey) {
    deps.store.setState(
      spec.stateKey,
      JSON.stringify({ at: deps.nowIso, lateMs: late, value: verdict.snapshot }),
      deps.nowIso
    );
  }
  if (verdict.ok) clearError(deps.store, spec.task, deps.nowIso);
  else recordError(deps.store, spec.task, verdict.note, deps.nowIso);
  return { ok: verdict.ok, note: verdict.note };
}

// src/mcloud/tasks/appTaskMatrix.ts
var STATE_GROUP_INDEX = "mcloud.apptaskmatrix.group_index";
var STATE_LAST2 = "mcloud.apptaskmatrix.last";
var MATRIX_MARKETS = ["sign_in_3", "newsign_139mail"];
function asInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function asStr(v) {
  return typeof v === "string" && v !== "" ? v : void 0;
}
function nestedLink(button) {
  if (button === null || typeof button !== "object") return void 0;
  const app = button.app;
  if (app === null || typeof app !== "object") return void 0;
  return asStr(app.link);
}
function parseMatrixItem(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const o = raw;
  const it = {
    taskId: asInt(o.id ?? o.taskId ?? o.task_id),
    name: asStr(o.name),
    description: asStr(o.description),
    groupId: asStr(o.groupid ?? o.groupId),
    state: asStr(o.state),
    limitType: asStr(o.limitType ?? o.limit_type),
    enable: asInt(o.enable),
    currStep: asInt(o.currstep ?? o.currStep),
    buttonAppLink: asStr(o.buttonAppLink ?? o.button_app_link) ?? nestedLink(o.button)
  };
  const any = it.taskId !== void 0 || it.name !== void 0 || it.state !== void 0 || it.enable !== void 0;
  return any ? it : void 0;
}
function parseMatrix(result, group) {
  let list = result;
  if (list !== null && typeof list === "object" && !Array.isArray(list)) {
    const o = list;
    if (group !== void 0 && Array.isArray(o[group])) list = o[group];
    else list = o.list ?? o.tasks ?? o.taskList ?? o.items ?? [];
  }
  if (!Array.isArray(list)) return [];
  return list.map(parseMatrixItem).filter((x) => !!x);
}
function judgeItem(i) {
  if (i.state === "FINISH") return "done";
  if (i.enable === 1) return "todo";
  return "skip";
}
function matrixKey(group) {
  return `mcloud.apptaskmatrix.g.${group}`;
}
function readMatrix(store2) {
  return MATRIX_MARKETS.map((g) => {
    const raw = store2.getState(matrixKey(g));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === "object" && v ? { ...v, group: g } : null;
    } catch {
      return null;
    }
  });
}
function summarize(items) {
  let done = 0;
  let todo = 0;
  let skip = 0;
  const todoNames = [];
  for (const i of items) {
    const j = judgeItem(i);
    if (j === "done") done += 1;
    else if (j === "todo") {
      todo += 1;
      if (todoNames.length < 3) todoNames.push(i.name ?? i.description ?? `#${i.taskId ?? "?"}`);
    } else skip += 1;
  }
  return { done, todo, skip, todoNames };
}
function runAppTaskMatrix(deps) {
  const raw = deps.store.getState(STATE_GROUP_INDEX);
  const parsed = raw === void 0 || raw === null ? 0 : Number(raw);
  const idx = Number.isFinite(parsed) && parsed >= 0 && parsed < MATRIX_MARKETS.length ? parsed : 0;
  const market = MATRIX_MARKETS[idx];
  const out = runTask(
    deps,
    {
      task: "app-task-matrix",
      endpoint: "taskListV3",
      method: "POST",
      // ⚠ `activityid` 跟着**本次的 marketname** 走（mcloud 的 V3 构造器：先剥再补）
      marketName: market,
      isDeviceId: false,
      stateKey: STATE_LAST2,
      // 实拍体：{"clientVersion":"12.6.0","group":<group>,"marketname":"sign_in_3"}
      // 体是**字符串**（与 receiveV3Body 同一约定）
      // ⚠ V3：`group` 是**空串** = 一次拿整个市场（实拍 content-length 62 逐字节对出来的）
      body: JSON.stringify({ marketname: market, clientVersion: TASK_CLIENT_VERSION, group: "" })
    },
    (env) => {
      const items = parseMatrix(env.result, market);
      const s = summarize(items);
      deps.store.setState(STATE_GROUP_INDEX, String((idx + 1) % MATRIX_MARKETS.length), deps.nowIso);
      const reading = {
        group: market,
        at: deps.nowIso,
        ...s,
        items,
        groupState: env.groupState
      };
      deps.store.setState(matrixKey(market), JSON.stringify(reading), deps.nowIso);
      const names = s.todoNames.length ? `（可做：${s.todoNames.join("、")}）` : "";
      return {
        ok: true,
        note: `App 任务矩阵[${idx + 1}/${MATRIX_MARKETS.length} market=${market}]：已完成 ${s.done} 条、可做 ${s.todo} 条、不参与 ${s.skip} 条${names}`,
        snapshot: { group: market, ...s, items: items.slice(0, 20) }
      };
    }
  );
  return out;
}

// src/mcloud/cloudUpload.ts
var PERSONAL_KD = "https://personal-kd-njs.yun.139.com";
var FILE_CREATE_PATH = "/hcy/file/create";
var FILE_COMPLETE_PATH = "/hcy/file/complete";
var CREATE_CONTENT_TYPE = "application/oct-stream";
var PUT_CONTENT_TYPE = "application/octet-stream";
var PUT_ORIGIN = "https://yun.139.com";
var PUT_REFERER = "https://yun.139.com/";
var PUT_UPLOAD_COMPLETE = "?1";
var PUT_UPLOAD_DRAFT_INTEROP_VERSION = "6";
var HASH_ALGORITHM = "SHA256";
var FILE_TYPE_FILE = "file";
var CHANNEL_ANDROID = "10000023";
var RENAME_FORCE = "force_rename";
var OP_TYPE_UPLOAD = "2";
var SUB_OP_TYPE_UPLOAD = "200";
var OP_TYPE_BACKUP = "0";
var SUB_OP_TYPE_BACKUP = "0";
var CLIENT_INFO_ANDROID = "1|127.0.0.1|1|12.6.0|Xiaomi|22041216C||02-00-00-00-00-00|android 14|1080X2360|zh||||032|0|";
function androidOpCodes(op) {
  const code = op === "backup" ? 2 : op === "upload" ? 1 : 0;
  return { opType: String(code), subOpType: String(code * 100) };
}
function cloudFileOpHeaders(op, channel = CHANNEL_ANDROID) {
  const { opType, subOpType } = androidOpCodes(op);
  return {
    // base 三枚（三档都有）
    "x-yun-api-version": "v1",
    "x-yun-app-channel": channel,
    "x-yun-op-type": opType,
    // Android 档那三枚
    "x-huawei-channelSrc": channel,
    "x-yun-client-info": CLIENT_INFO_ANDROID,
    "x-yun-sub-op-type": subOpType
  };
}
var AUTH_DOMAINS = [
  "yun.139.com",
  "mcloud.139.com",
  "feixin.10086.cn",
  "mail.10086.cn"
];
function hostOf(rawUrl) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl);
  if (!m) return "";
  let host = m[1].toLowerCase();
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.lastIndexOf(":");
  if (colon >= 0) host = host.slice(0, colon);
  return host;
}
function sendsAuthorizationTo(rawUrl) {
  const host = hostOf(rawUrl);
  if (host === "") return false;
  return AUTH_DOMAINS.some((suffix) => host.endsWith(suffix));
}
function contentHashOf(bytes) {
  return sha256Hex(bytes);
}
function createBody(input) {
  const body = {
    name: input.name,
    type: FILE_TYPE_FILE,
    size: input.size,
    fileRenameMode: input.renameMode ?? RENAME_FORCE,
    contentHash: input.contentHash,
    contentHashAlgorithm: HASH_ALGORITHM,
    contentType: input.contentType ?? CREATE_CONTENT_TYPE,
    parallelUpload: input.parallelUpload ?? false
  };
  body[input.locate.key] = input.locate.value;
  if (input.localCreatedAt !== void 0) body.localCreatedAt = input.localCreatedAt;
  body.partInfos = [
    { parallelHashCtx: { partOffset: 0 }, partNumber: 1, partSize: input.size }
  ];
  return JSON.stringify(body);
}
function buildCreateRequest(input) {
  return {
    url: `${PERSONAL_KD}${FILE_CREATE_PATH}`,
    method: "POST",
    // ⚠ 真机实测（2026-10-14）：这一口**要 `application/json`**。
    //   写成 `application/oct-stream` / `octet-stream` 会回 `04000018 请求体媒体格式不支持`。
    //   ⚠ 我一开始把 404 归因成 content-type —— **认错了**：那次同时改了两样（头画像 +
    //   content-type），而真因是**缺头画像**。一次只改一样才分得清。
    headers: { "Content-Type": "application/json", ...cloudFileOpHeaders(input.op ?? "backup") },
    body: createBody(input)
  };
}
function parseCreate(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `create 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (v.code !== void 0 && v.code !== 0 && v.code !== "0000" && v.code !== "0") {
    return { ok: false, error: `create 失败：code=${String(v.code)}` };
  }
  const data = v.data ?? v.result;
  if (!data || typeof data !== "object") return { ok: false, error: "create 响应没有 data/result" };
  const fileId = data.fileId;
  const uploadId = data.uploadId;
  const parts = Array.isArray(data.partInfos) ? data.partInfos : [];
  const first = parts[0];
  const nested = first !== null && typeof first === "object" ? first.uploadUrl : void 0;
  const uploadUrl = nested ?? data.uploadUrl;
  const rapid = data.rapidUpload === true;
  if (typeof fileId !== "string" || fileId === "") return { ok: false, error: "create 响应缺 fileId" };
  if (!rapid) {
    if (typeof uploadId !== "string" || uploadId === "") {
      return { ok: false, error: "create 响应缺 uploadId（且不是秒传）" };
    }
    if (typeof uploadUrl !== "string" || uploadUrl === "") {
      return { ok: false, error: "create 响应缺 uploadUrl（且不是秒传）" };
    }
  }
  return {
    ok: true,
    created: {
      fileId,
      uploadId: typeof uploadId === "string" ? uploadId : "",
      uploadUrl: typeof uploadUrl === "string" ? uploadUrl : "",
      rapidUpload: rapid
    }
  };
}
function buildPutRequest(uploadUrl, bytes, backup = false) {
  const req = {
    url: uploadUrl,
    method: "PUT",
    headers: {
      "Content-Type": PUT_CONTENT_TYPE,
      origin: PUT_ORIGIN,
      referer: PUT_REFERER,
      // ⚠ 值是**带问号**的 `?1`
      "upload-complete": PUT_UPLOAD_COMPLETE,
      "upload-draft-interop-version": PUT_UPLOAD_DRAFT_INTEROP_VERSION,
      "x-yun-op-type": backup ? OP_TYPE_BACKUP : OP_TYPE_UPLOAD,
      "x-yun-sub-op-type": backup ? SUB_OP_TYPE_BACKUP : SUB_OP_TYPE_UPLOAD
    },
    // 二进制体：插件里用 latin1 字符串承载（每个字符一个字节）
    body: latin1FromBytes(bytes)
  };
  return { req, leaksCredential: sendsAuthorizationTo(uploadUrl) };
}
function latin1FromBytes(bytes) {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let s = "";
    for (let j = i; j < end; j += 1) s += String.fromCharCode(bytes[j]);
    out += s;
  }
  return out;
}
function completeBody(fileId, uploadId, contentHash) {
  return JSON.stringify({
    fileId,
    uploadId,
    contentHash,
    contentHashAlgorithm: HASH_ALGORITHM
  });
}
function buildCompleteRequest(fileId, uploadId, contentHash, op = "backup") {
  return {
    url: `${PERSONAL_KD}${FILE_COMPLETE_PATH}`,
    method: "POST",
    headers: { "Content-Type": "application/json", ...cloudFileOpHeaders(op) },
    body: completeBody(fileId, uploadId, contentHash)
  };
}
function parseComplete(body) {
  try {
    const v = JSON.parse(body);
    const code = v.code;
    if (code === void 0 || code === 0 || code === "0000" || code === "0") return { ok: true };
    return { ok: false, error: `complete 失败：code=${String(code)}` };
  } catch (e) {
    return { ok: false, error: `complete 响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
}
function deterministicFile(seed, bytes = 1024) {
  const out = new Uint8Array(bytes);
  const base = utf8(seed);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = 33 + ((base[i % base.length] ^ i & 127) - 33 + 94) % 94;
  }
  return out;
}

// src/mcloud/tasks/upload.ts
var STATE_UPLOAD = "mcloud.upload.state";
var STEP_TEXT = {
  create: "① 声明要传一个文件",
  put: "② 传字节（预签名直传）",
  complete: "③ 告诉上游传完了",
  done: "完成"
};
function loadUpload(deps) {
  const raw = deps.store.getState(STATE_UPLOAD);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v.step === "string" ? v : null;
  } catch {
    return null;
  }
}
function save(deps, st) {
  deps.store.setState(STATE_UPLOAD, JSON.stringify(st), deps.nowIso);
}
function startUpload(deps, opts) {
  if (opts.name.trim() === "") return { ok: false, note: "上传要有文件名" };
  if (opts.bytes.length === 0) return { ok: false, note: "上传的内容是空的" };
  const st = {
    step: "create",
    name: opts.name,
    size: opts.bytes.length,
    // ⚠ 摘要在这里就算好：第 ③ 枪 `complete` 要用**同一份**，而且它必须跨调用活下来
    contentHash: contentHashOf(opts.bytes),
    locateKey: opts.locateKey ?? "parentFileId",
    locateValue: opts.locateValue ?? "/"
  };
  save(deps, st);
  return {
    ok: true,
    note: `已排队上传「${opts.name}」（${st.size} 字节，摘要 ${st.contentHash.slice(0, 12)}…）—— 每次触发走一步`
  };
}
function runUploadStep(deps, bytes) {
  const st = loadUpload(deps);
  if (!st) return { ok: true, idle: true, note: "没有在排队的上传" };
  if (st.step === "done") return { ok: true, idle: true, note: "这一次上传已经走完" };
  const label = STEP_TEXT[st.step];
  if (st.step === "create") {
    const req = buildCreateRequest({
      name: st.name,
      size: st.size,
      contentHash: st.contentHash,
      locate: { key: st.locateKey, value: st.locateValue }
    });
    const res2 = callRawText(deps.transport, req);
    if (!res2.ok) return { ok: false, note: `${label}失败：${res2.error ?? "未知失败"}` };
    const parsed2 = parseCreate(res2.text);
    if (!parsed2.ok || !parsed2.created) return { ok: false, note: `${label}：${parsed2.error}` };
    const c = parsed2.created;
    const next = { ...st, fileId: c.fileId };
    if (c.rapidUpload) {
      next.step = "done";
      next.rapidUpload = true;
      save(deps, next);
      return { ok: true, note: `${label}：秒传命中（fileId ${c.fileId.length} 字符）⇒ 不用传字节，这次上传已完成` };
    }
    next.step = "put";
    next.uploadId = c.uploadId;
    next.uploadUrl = c.uploadUrl;
    next.rapidUpload = false;
    save(deps, next);
    return { ok: true, note: `${label}：拿到 fileId 与预签名地址（${c.uploadUrl.length} 字符）—— 下一步传字节` };
  }
  if (st.step === "put") {
    if (!st.uploadUrl || !st.uploadId) {
      return { ok: false, note: `${label}：状态里没有 uploadUrl/uploadId ⇒ 这一趟作废（重起一次上传）` };
    }
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        note: `${label}：这次调用没带字节 ⇒ 不发（拿空体去 PUT 会真的传一个 0 字节文件上去）`
      };
    }
    const { req, leaksCredential } = buildPutRequest(st.uploadUrl, bytes, false);
    if (leaksCredential) {
      return {
        ok: false,
        note: `${label}：目标主机落在应带凭据的域里（不是预签名直传该有的形状）⇒ 不发，先查 create 的响应`
      };
    }
    const res2 = callRawText(deps.transport, req);
    if (!res2.ok) return { ok: false, note: `${label}失败：${res2.error ?? "未知失败"}` };
    save(deps, { ...st, step: "complete" });
    return { ok: true, note: `${label}：${bytes.length} 字节已发（HTTP ${res2.status}）—— 下一步确认` };
  }
  const res = callRawText(deps.transport, buildCompleteRequest(st.fileId, st.uploadId, st.contentHash));
  if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
  const parsed = parseComplete(res.text);
  if (!parsed.ok) return { ok: false, note: `${label}：${parsed.error}` };
  save(deps, { ...st, step: "done" });
  return { ok: true, note: `${label}：已确认（fileId ${(st.fileId ?? "").length} 字符）—— 这次上传完成` };
}
function uploadDone(deps) {
  return loadUpload(deps)?.step === "done";
}

// src/mcloud/appTaskRules.ts
var UPLOAD_ONE = {
  rounds: 1,
  stopAtProcess: 0,
  topUpFromProcess: false,
  perRoundMs: 0,
  fileExt: ".bin",
  channel: "android"
};
var UPLOAD_TEN = {
  rounds: 10,
  stopAtProcess: 10,
  topUpFromProcess: true,
  perRoundMs: 300,
  fileExt: ".jpg",
  channel: "android"
};
var UPLOAD_ONE_PC = {
  rounds: 1,
  stopAtProcess: 0,
  topUpFromProcess: false,
  perRoundMs: 0,
  fileExt: ".bin",
  channel: "pc"
};
var ROUNDS_PER_RUN = 5;
var STOP_AT_PROCESS = 100;
var PC_UPLOAD_TASK_ID = 113;
var UPLOAD_TASK_ID = 106;
var GATE_UPLOAD_TASK_ID = 522;
var SKIP_TASK_LIST = [
  117,
  437,
  991,
  406,
  385,
  480,
  1022,
  1018,
  603,
  1021,
  120
];
var PORTAL_ENTRY_TASK_IDS = [1017, 604];
var CLICK_ONLY_TASK_IDS = [
  115,
  431,
  435,
  1009,
  1010,
  1013,
  1016,
  447,
  547
];
function beiyong1NameGate(name) {
  return name.includes("上传") && (name.includes("图") || name.includes("照"));
}
function beiyong1ButtonGate(link) {
  return typeof link === "string" && link.includes("uploadView");
}
function uploadShapeFor(item) {
  if (item.taskId === PC_UPLOAD_TASK_ID) return UPLOAD_ONE_PC;
  if (item.taskId === UPLOAD_TASK_ID) return UPLOAD_ONE;
  if (item.taskId === GATE_UPLOAD_TASK_ID) {
    return {
      rounds: ROUNDS_PER_RUN,
      stopAtProcess: STOP_AT_PROCESS,
      // ⚠ 522 是"闸"不是"剩余量"：那个 `process` 在循环里不会变
      topUpFromProcess: false,
      perRoundMs: 500,
      fileExt: ".bin",
      channel: "android"
    };
  }
  if (item.groupId === "beiyong1") {
    if (typeof item.name === "string" && beiyong1NameGate(item.name)) return UPLOAD_ONE;
    if (beiyong1ButtonGate(item.buttonAppLink)) return UPLOAD_TEN;
  }
  return void 0;
}
function shouldSkip(taskId) {
  return taskId !== void 0 && SKIP_TASK_LIST.includes(taskId);
}
function isClickOnly(taskId) {
  return taskId !== void 0 && CLICK_ONLY_TASK_IDS.includes(taskId);
}
function needsPortalEntry(taskId) {
  return taskId !== void 0 && PORTAL_ENTRY_TASK_IDS.includes(taskId);
}
function stepFor(item) {
  if (shouldSkip(item.taskId)) return void 0;
  const shape = uploadShapeFor(item);
  if (shape) return { kind: "upload", shape };
  if (isClickOnly(item.taskId)) return { kind: "clickOnly" };
  if (needsPortalEntry(item.taskId)) return { kind: "portalEntry" };
  return void 0;
}

// src/mcloud/tasks/appTask.ts
var STATE_TASK = "mcloud.apptask.state";
var CLICK_HOST = "https://m.mcloud.139.com";
var CLICK_PATH = "/ycloud/signin/task/click";
var JOURNALING_PATH = "/ycloud/visitlog/journaling";
var JOURNALING_SOURCE_ID = "1077";
var BATCH_TRASH_URL = "https://personal-kd-njs.yun.139.com/hcy/recyclebin/batchTrash";
function clickRequest(deps, id) {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: `${CLICK_HOST}${CLICK_PATH}?key=task&id=${id}`,
    method: "GET",
    body: void 0,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    marketName: "sign_in_3",
    session: session ? sessionHeaders(session) : {}
  });
}
function journalingRequest(deps, taskId, marketname = "sign_in_3") {
  const session = loadSession(deps.store);
  return {
    url: `${CLICK_HOST}${JOURNALING_PATH}`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      ...session ? sessionHeaders(session) : {}
    },
    body: `module=uservisit&optkeyword=139newsignin_index_task_${taskId}&sourceid=${JOURNALING_SOURCE_ID}&marketName=${marketname}`
  };
}
function trashRequest(deps, fileIds) {
  void deps;
  return {
    url: BATCH_TRASH_URL,
    method: "POST",
    headers: { "Content-Type": "application/json", ...cloudFileOpHeaders("upload") },
    body: JSON.stringify({ fileIds })
  };
}
function load(deps) {
  const raw = deps.store.getState(STATE_TASK);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v.phase === "string" ? v : null;
  } catch {
    return null;
  }
}
var save2 = (deps, st) => deps.store.setState(STATE_TASK, JSON.stringify(st), deps.nowIso);
function today(deps) {
  return deps.nowIso.slice(0, 10);
}
function freshClicked(st, deps) {
  return st.day === today(deps) ? st.clicked : [];
}
function clickedButIneffective(deps, st) {
  const clicked = freshClicked(st, deps);
  if (clicked.length === 0) return [];
  const still = pendingItems(deps).filter((p) => clicked.includes(p.itemId));
  return still.map((p) => p.itemId);
}
function advance(deps, st) {
  const clicked = freshClicked(st, deps);
  const next = pendingItems(deps).find((p) => !clicked.includes(p.itemId));
  if (!next) {
    save2(deps, { ...st, phase: "done", fileId: void 0, clicked, day: today(deps) });
    const dead = clickedButIneffective(deps, { ...st, clicked });
    const warn2 = dead.length === 0 ? "" : `。⚠ 其中 ${dead.length} 条**点了但状态没变**（#${dead.join("、")}）—— HTTP 200 只说明"请求被接受了"。这类多半要**先做那个动作**（开启备份 / 开启通知），光点一下不算数`;
    return { ok: dead.length === 0, note: `待办都走完了（这一趟点了 ${clicked.length} 条）${warn2}` };
  }
  if (next.needUpload) beginUpload(deps, next.itemId, next.name);
  save2(deps, {
    gi: next.gi,
    ii: next.ii,
    phase: next.needUpload ? "upload" : "visit",
    itemId: next.itemId,
    clicked,
    day: today(deps)
  });
  return { ok: true, note: `下一条 #${next.itemId}（「${next.name}」）` };
}
var lastSkipped = [];
function pendingItems(deps) {
  const out = [];
  const skipped = [];
  const readings = readMatrix(deps.store);
  readings.forEach((reading, gi) => {
    if (!reading) return;
    for (const [ii, item] of (reading.items ?? []).entries()) {
      if (judgeItem(item) !== "todo") continue;
      if (stepFor({ taskId: item.taskId, groupId: item.groupId, name: item.name, buttonAppLink: item.buttonAppLink }) === void 0) {
        skipped.push(item.taskId ?? 0);
        continue;
      }
      out.push({
        gi,
        ii,
        itemId: item.taskId ?? 0,
        name: item.name ?? `task-${item.taskId ?? 0}`,
        needUpload: uploadShapeFor({
          taskId: item.taskId,
          groupId: item.groupId,
          name: item.name,
          buttonAppLink: item.buttonAppLink
        }) !== void 0
      });
    }
  });
  return out;
}
function beginUpload(deps, itemId, name) {
  startUpload(deps, {
    name: `${name}.bin`,
    bytes: deterministicFile(`app-task-${itemId}`, 256)
  });
}
function startAppTask(deps) {
  const prev = load(deps);
  const clicked = prev ? freshClicked(prev, deps) : [];
  const all = pendingItems(deps);
  if (all.length === 0) {
    const sk = lastSkipped;
    const extra = sk.length === 0 ? "（先跑一次 `app-task-matrix` 把读数填上）" : `；另有 ${sk.length} 条上游列为待做，但**本插件还没实现**（#${sk.slice(0, 6).join("、")}${sk.length > 6 ? "…" : ""}）⇒ 不动它们（点了也不变状态）`;
    return { ok: true, idle: true, note: `矩阵里没有本插件能做的待办${extra}` };
  }
  const todo = all.filter((p) => !clicked.includes(p.itemId));
  if (todo.length === 0) {
    return {
      ok: true,
      idle: true,
      note: `读数里 ${all.length} 条待办**今天都点过了** —— 不重发（读数刷新后会自然变 FINISH）`
    };
  }
  const first = todo[0];
  if (first.needUpload) beginUpload(deps, first.itemId, first.name);
  save2(deps, {
    gi: first.gi,
    ii: first.ii,
    phase: first.needUpload ? "upload" : "visit",
    itemId: first.itemId,
    clicked,
    day: today(deps)
  });
  return { ok: true, note: `已排队 ${todo.length} 条待办（今天已点过 ${clicked.length} 条），从 #${first.itemId} 开始` };
}
function runAppTaskStep(deps) {
  const st = load(deps);
  if (!st) return { ok: true, idle: true, note: "没有在跑的 app-task" };
  if (st.phase === "done") {
    return { ok: true, idle: true, note: "这一趟已经走完（读数刷新后新出现的待办要重新起一趟）" };
  }
  const pend = pendingItems(deps);
  const cur = pend.find((p) => p.gi === st.gi && p.ii === st.ii);
  if (!cur) {
    return advance(deps, st);
  }
  if (st.phase === "upload") {
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState("mcloud.upload.state") ?? "{}");
      save2(deps, { ...st, phase: "visit", fileId: up.fileId, day: today(deps) });
      return { ok: true, note: `文件已传完（收尾要用它的 id）—— 下一步记访问日志` };
    }
    const out2 = runUploadStep(deps, deterministicFile(`app-task-${st.itemId}`, 256));
    if (out2.idle) {
      save2(deps, { ...st, phase: "visit", day: today(deps) });
      return { ok: true, note: "没有待传的 —— 下一步记访问日志" };
    }
    if (uploadDone(deps)) {
      const up = JSON.parse(deps.store.getState("mcloud.upload.state") ?? "{}");
      save2(deps, { ...st, phase: "visit", fileId: up.fileId, day: today(deps) });
    }
    return out2;
  }
  if (st.phase === "visit") {
    const res2 = callRawText(deps.transport, journalingRequest(deps, st.itemId));
    if (!res2.ok) return { ok: false, note: `记访问日志 #${st.itemId} 失败：${res2.error ?? "未知失败"}` };
    save2(deps, { ...st, phase: "click", day: today(deps) });
    return { ok: true, note: `已记访问日志 #${st.itemId}（HTTP ${res2.status}）—— 下一步打卡` };
  }
  if (st.phase === "click") {
    if (freshClicked(st, deps).includes(st.itemId)) {
      if (st.fileId) {
        save2(deps, { ...st, phase: "trash", day: today(deps) });
        return { ok: true, note: `#${st.itemId} 今天已经点过了 —— 不重发，去收尾` };
      }
      const out3 = advance(deps, st);
      return { ok: true, note: `#${st.itemId} 今天已经点过了 —— 不重发。${out3.note}` };
    }
    const res2 = callRawText(deps.transport, clickRequest(deps, st.itemId));
    if (!res2.ok) return { ok: false, note: `打卡 #${st.itemId} 失败：${res2.error ?? "未知失败"}` };
    const clicked = [...freshClicked(st, deps), st.itemId];
    if (st.fileId) {
      save2(deps, { ...st, phase: "trash", clicked, day: today(deps) });
      return { ok: true, note: `打卡 #${st.itemId}（HTTP ${res2.status}）—— 下一步收尾` };
    }
    const out2 = advance(deps, { ...st, clicked });
    return {
      ok: out2.ok,
      note: `打卡 #${st.itemId}（HTTP ${res2.status}）—— 这条没有要收尾的文件。${out2.note}`
    };
  }
  if (!st.fileId) {
    const out2 = advance(deps, st);
    return { ok: true, note: `这条没有要收尾的文件 —— 不发空数组那一枪。${out2.note}` };
  }
  const res = callRawText(deps.transport, trashRequest(deps, [st.fileId]));
  if (!res.ok) return { ok: false, note: `收尾 #${st.itemId} 失败：${res.error ?? "未知失败"}` };
  let ok = true;
  let why = "";
  try {
    const v = JSON.parse(res.text);
    const code = typeof v.code === "string" ? v.code : String(v.code ?? "");
    ok = v.success === true || code === "0000" || code === "0";
    if (!ok) why = `（code=${code}${typeof v.msg === "string" ? ` ${v.msg}` : ""}）`;
  } catch {
    ok = false;
    why = "（响应不是 JSON）";
  }
  const out = advance(deps, { ...st, fileId: void 0 });
  return ok ? { ok: true, note: `收尾 #${st.itemId}：文件已移进回收站。${out.note}` } : { ok: false, note: `收尾 #${st.itemId} 被拒 ${why}` };
}

// src/mcloud/tasks/backupGift.ts
var STATE_INFO = "mcloud.backupgift.info";
var STATE_CAN = "mcloud.backupgift.can_receive";
function parseCanReceive(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  const v = o.canReceive ?? o.can_receive ?? o.receivable ?? o.status;
  if (typeof v === "boolean") return { can: v, raw: v };
  if (typeof v === "number") return { can: v === 1, raw: v };
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "can") return { can: true, raw: v };
    return { can: false, raw: v };
  }
  return { can: false, raw: result ?? null };
}
function runBackupGiftInfo(deps) {
  return runTask(
    deps,
    {
      task: "backup-gift",
      endpoint: "backupGiftInfo",
      method: "GET",
      marketName: "backupgift",
      isDeviceId: false,
      stateKey: STATE_INFO
    },
    (env) => {
      const { can, raw } = parseCanReceive(env.result);
      deps.store.setState(STATE_CAN, can ? "yes" : `no:${JSON.stringify(raw)?.slice(0, 80)}`, deps.nowIso);
      return {
        ok: true,
        note: can ? "备份好礼：可以领取（下一次触发会去领）" : "备份好礼：当前没有可领的",
        snapshot: env.result ?? null
      };
    }
  );
}
function runBackupGiftReceive(deps) {
  const can = deps.store.getState(STATE_CAN);
  if (can !== "yes") {
    return {
      ok: true,
      skipped: true,
      note: `上次问过状态是「${can ?? "没问过"}」，不发领取请求`
    };
  }
  const out = runTask(
    deps,
    {
      task: "backup-gift",
      endpoint: "backupGiftReceive",
      method: "GET",
      marketName: "backupgift",
      isDeviceId: false
    },
    (env) => ({
      ok: true,
      note: `备份好礼已领取（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 120)}）`
    })
  );
  if (out.ok) deps.store.setState(STATE_CAN, "no:claimed", deps.nowIso);
  return out;
}
function runBackupGift(deps) {
  const can = deps.store.getState(STATE_CAN);
  if (can === "yes") return runBackupGiftReceive(deps);
  return runBackupGiftInfo(deps);
}

// src/mcloud/tasks/cloudSnapshot.ts
var STATE_SNAPSHOT = "mcloud.cloudsnapshot.last";
var LEDGER_AI_DOU = 1;
var TYPE_ALL = 0;
var PAGE_SIZE = 100;
function snapshotQuery(pageNumber = 1) {
  return `aiDou=${LEDGER_AI_DOU}&type=${TYPE_ALL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
}
function runCloudSnapshot(deps) {
  return runTask(
    deps,
    {
      task: "cloud-snapshot",
      endpoint: "cloudRecordV2",
      method: "GET",
      query: snapshotQuery(),
      isDeviceId: false,
      stateKey: STATE_SNAPSHOT
    },
    (env) => {
      const list = resultArray(env);
      const entries = list.map((x) => {
        const o = typeof x === "object" && x !== null ? x : {};
        const num = (v) => typeof v === "number" ? v : void 0;
        const str = (v) => typeof v === "string" ? v : void 0;
        return {
          id: num(o.id),
          value: num(o.aiDou ?? o.value ?? o.change),
          reason: str(o.typeName ?? o.reason ?? o.type),
          insertTime: str(o.insertTime ?? o.time)
        };
      });
      const latest = [...entries].reverse().find((e) => e.value !== void 0);
      const full = entries.length === PAGE_SIZE;
      return {
        ok: true,
        note: `流水 ${entries.length} 条` + (latest ? `，最新一笔 ${latest.value}（${latest.reason ?? "—"}）` : "") + (full ? `；== pageSize(${PAGE_SIZE}) 说明可能还有下一页（本任务只取第一页）` : ""),
        snapshot: { entries, truncated: full }
      };
    }
  );
}

// src/mcloud/tasks/msgPush.ts
var STATE_STATUS = "mcloud.msgpush.last";
var STATE_CAN2 = "mcloud.msgpush.can";
var SECOND_STATUS_CLAIMABLE = 2;
function asInt2(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function parseStatus(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  return {
    pushOn: asInt2(o.pushOn),
    onDuaration: asInt2(o.onDuaration),
    firstTaskStatus: asInt2(o.firstTaskStatus),
    secondTaskStatus: asInt2(o.secondTaskStatus)
  };
}
var PUSH_ON_OFF = 0;
function planMsgPush(s) {
  if (s.pushOn !== void 0 && s.pushOn === PUSH_ON_OFF) return "manual";
  if (s.secondTaskStatus === void 0) return "unknown";
  if (s.secondTaskStatus === SECOND_STATUS_CLAIMABLE) return "obtain";
  return "nothing";
}
function runMsgPushStatus(deps) {
  return runTask(
    deps,
    {
      task: "msg-push",
      endpoint: "msgPushStatus",
      method: "GET",
      // ⚠ 这一族的 `activityid` 是 **msgpushon**，不是签到页那个 `sign_in_3`：
      // 「每个页面用自己的参数换自己的票，票与票之间逐字节不等」（见 session.rs 的配方表）
      marketName: "msgpushon",
      isDeviceId: false,
      stateKey: STATE_STATUS
    },
    (env) => {
      const s = parseStatus(env.result);
      const plan = planMsgPush(s);
      const can = plan === "obtain";
      deps.store.setState(STATE_CAN2, can ? "yes" : plan === "unknown" ? "unknown" : "no", deps.nowIso);
      let note;
      if (plan === "unknown") {
        note = "消息推送：判据字段缺失（没读到 secondTaskStatus）⇒ **判不了**，一个写请求都不发";
      } else if (s.pushOn === 0) {
        note = "消息推送：通知已被关闭，需要你在 App 里手动打开（这一步我们做不了）";
      } else if (can) {
        note = "消息推送：有可领的奖励（下一次触发会去领）";
      } else if (s.firstTaskStatus !== void 0 && s.firstTaskStatus !== 3) {
        note = "消息推送：首次奖励未领 —— 那一步要在 App 里手动完成，我们做不了";
      } else {
        note = `消息推送：暂无可领${s.onDuaration === void 0 ? "" : `（已开启 ${s.onDuaration} 天）`}`;
      }
      return { ok: true, note, snapshot: env.result ?? null };
    }
  );
}
function runMsgPushObtain(deps) {
  const can = deps.store.getState(STATE_CAN2);
  if (can !== "yes") {
    return {
      ok: true,
      skipped: true,
      note: `上次问到的状态是「${can === "unknown" ? "判不了（判据字段缺失）" : can === "no" ? "不该领" : can === "yes" ? "该领" : "没问过"}」，不发领取请求`
    };
  }
  const out = runTask(
    deps,
    {
      task: "msg-push",
      endpoint: "msgPushObtain",
      method: "POST",
      body: JSON.stringify({ type: 2 }),
      marketName: "msgpushon",
      isDeviceId: false
    },
    (env) => {
      const o = resultObject(env);
      const code = asInt2(o.obtainCode);
      if (code === 0) return { ok: true, note: "消息推送奖励：已领取" };
      return {
        ok: false,
        note: `消息推送奖励：没领到（obtainCode=${code ?? "缺字段"}；上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 120)}）`
      };
    }
  );
  if (out.ok) deps.store.setState(STATE_CAN2, "no", deps.nowIso);
  return out;
}

// src/mcloud/tasks/info.ts
var bool = (v, dflt = false) => typeof v === "boolean" ? v : dflt;
function parseInfoV3(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  const pick2 = (...keys) => {
    for (const k of keys) if (o[k] !== void 0) return o[k];
    return void 0;
  };
  const listRaw = pick2("receiveList", "receive_list");
  const receiveList = Array.isArray(listRaw) ? listRaw.map((x) => {
    const it = typeof x === "object" && x !== null ? x : {};
    const rid = it.recordId ?? it.record_id ?? it.cloudId ?? it.cloud_id;
    const ct = it.cloudType ?? it.cloud_type;
    return {
      recordId: typeof rid === "string" ? rid : rid === void 0 || rid === null ? "" : String(rid),
      cloudType: typeof ct === "number" ? ct : void 0,
      raw: x
    };
  }) : [];
  return {
    todaySigned: bool(pick2("todaySignIn", "today_sign_in")),
    receiveList,
    curMonthBackup: bool(pick2("curMonthBackup", "cur_month_backup")),
    curMonthBackupSignAccept: bool(pick2("curMonthBackupSignAccept", "cur_month_backup_sign_accept")),
    raw: result ?? null
  };
}
function fetchInfoV3(deps) {
  const session = loadSession(deps.store);
  if (!session) return { ok: false, error: "未登录：state 里没有会话" };
  const req = buildH5Request({
    url: `${resolveUrl("infoV3", deps.baseUrl)}?${CLIENT_QUERY}`,
    method: EP_METHOD.infoV3 === "GET" ? "GET" : "POST",
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: !!session.deviceId,
    saltKey: 1,
    session: sessionHeaders(session)
  });
  const res = callOnce(deps.transport, req);
  if (!res.ok) return { ok: false, error: res.error ?? "未知失败" };
  const env = res.env;
  return { ok: true, info: parseInfoV3(env.result), tookMs: res.tookMs };
}

// src/mcloud/tasks/multiple.ts
var STATE_MULTIPLE = "mcloud.multiple.last";
function runMultiple(deps) {
  const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `查询状态失败：${info.error}` };
  const { curMonthBackup, curMonthBackupSignAccept } = info.info;
  if (!curMonthBackup) {
    return { ok: true, skipped: true, note: "本月没有翻倍机会（infoV3.curMonthBackup=false）" };
  }
  if (curMonthBackupSignAccept) {
    return { ok: true, skipped: true, note: "本月翻倍机会已用过（infoV3.curMonthBackupSignAccept=true）" };
  }
  return runTask(
    deps,
    {
      task: "multiple",
      endpoint: "multiple",
      method: "GET",
      isDeviceId: false,
      stateKey: STATE_MULTIPLE
    },
    (env) => ({
      ok: true,
      note: `已领取翻倍（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 100)}）`,
      snapshot: env.result ?? null
    })
  );
}

// src/mcloud/tasks/notice.ts
var STATE_CAN3 = "mcloud.notice.can_claim";
var STATE_INFO2 = "mcloud.notice.info";
var NOTICE_CLOUD_STATUS_UNCLAIMED = 1;
var NOTICE_TASK_STATUS_DONE = 3;
function asInt3(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function parseNoticeSlot(raw) {
  if (raw === null || raw === void 0 || typeof raw !== "object") return void 0;
  const o = raw;
  const slot = {
    cloudStatus: asInt3(o.cloudStatus ?? o.cloud_status),
    sum: asInt3(o.sum),
    progress: asInt3(o.progress),
    taskStatus: asInt3(o.taskStatus ?? o.task_status)
  };
  const any = slot.cloudStatus !== void 0 || slot.sum !== void 0 || slot.progress !== void 0 || slot.taskStatus !== void 0;
  return any ? slot : void 0;
}
function parseNoticeInfo(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  return {
    one: parseNoticeSlot(o.taskOneInfo ?? o.task_one_info),
    two: parseNoticeSlot(o.taskTwoInfo ?? o.task_two_info)
  };
}
function slotJudged(slot) {
  return !!slot && slot.cloudStatus !== void 0 && slot.taskStatus !== void 0;
}
function slotClaimable(slot) {
  if (!slotJudged(slot)) return false;
  return slot.cloudStatus === NOTICE_CLOUD_STATUS_UNCLAIMED && slot.taskStatus === NOTICE_TASK_STATUS_DONE;
}
function noticePlan(info) {
  const slots = [
    ["槽一", info.one],
    ["槽二", info.two]
  ];
  const claimable = slots.filter(([, s]) => slotClaimable(s)).map(([n]) => n);
  const unjudged = slots.filter(([, s]) => s && !slotJudged(s)).map(([n]) => n);
  const missing = slots.filter(([, s]) => !s).map(([n]) => n);
  const parts = [];
  if (claimable.length) parts.push(`${claimable.join("/")}可领`);
  if (unjudged.length) parts.push(`${unjudged.join("/")}判据字段不全（不参与判断，避免静默漏领）`);
  if (missing.length) parts.push(`${missing.join("/")}上游没给`);
  if (!parts.length) parts.push("两槽都已入账或无可领");
  return {
    claimable: claimable.length > 0,
    unjudged: unjudged.length > 0,
    detail: parts.join("；")
  };
}
function runNoticeInfo(deps) {
  return runTask(
    deps,
    {
      task: "notice",
      endpoint: "noticeInfo",
      method: "GET",
      marketName: "sign_in_3",
      isDeviceId: false,
      stateKey: STATE_INFO2
    },
    (env) => {
      const info = parseNoticeInfo(env.result);
      const plan = noticePlan(info);
      deps.store.setState(STATE_CAN3, plan.claimable ? "yes" : `no:${plan.detail}`, deps.nowIso);
      return {
        ok: true,
        note: plan.claimable ? `通知任务：${plan.detail}（下一次触发会去领）` : `通知任务：${plan.detail}`,
        snapshot: { one: info.one ?? null, two: info.two ?? null }
      };
    }
  );
}
function runNoticeReward(deps) {
  const can = deps.store.getState(STATE_CAN3);
  if (can !== "yes") {
    return { ok: true, skipped: true, note: `上次问过状态是「${can ?? "没问过"}」，不发领取请求` };
  }
  const out = runTask(
    deps,
    {
      task: "notice",
      endpoint: "noticeReward",
      method: "GET",
      marketName: "sign_in_3",
      isDeviceId: false
    },
    (env) => ({
      ok: true,
      // 上游不报到账数 —— 这句必须说，否则下一个人会以为这里能看到领了多少
      note: `通知任务：已发领取请求（上游不报到账数，下一次触发回查 ${JSON.stringify(
        env.message ?? "success"
      ).slice(0, 40)}）`
    })
  );
  if (out.ok) deps.store.setState(STATE_CAN3, "no:sent", deps.nowIso);
  return out;
}
function runNotice(deps) {
  const can = deps.store.getState(STATE_CAN3);
  if (can === "yes") return runNoticeReward(deps);
  return runNoticeInfo(deps);
}

// src/mcloud/tasks/prizes.ts
var STATE_PRIZES = "mcloud.prizes.last";
var PRIZE_QUERY = {
  status: 1,
  pageNumber: 1,
  pageSize: 10
};
function prizeQuery(market) {
  return `marketname=${encodeURIComponent(market)}&type=${PRIZE_QUERY.status}&pageNumber=${PRIZE_QUERY.pageNumber}&pageSize=${PRIZE_QUERY.pageSize}`;
}
function runPrizes(deps, market = "sign_in_3") {
  return runTask(
    deps,
    {
      task: "prizes",
      endpoint: "prizeRecord",
      method: "GET",
      query: prizeQuery(market),
      isDeviceId: false,
      stateKey: STATE_PRIZES
    },
    (env) => {
      const list = resultArray(env);
      const items = list.map((x) => {
        const o = typeof x === "object" && x !== null ? x : {};
        return {
          id: typeof o.id === "number" ? o.id : void 0,
          name: typeof o.name === "string" ? o.name : void 0,
          state: typeof o.state === "string" ? o.state : void 0
        };
      });
      const unreceived = items.filter((i) => (i.state ?? "").toUpperCase().includes("UNRECEIVED"));
      return {
        ok: true,
        note: `奖品 ${items.length} 条（未领取 ${unreceived.length} 条）`,
        snapshot: items
      };
    }
  );
}

// src/mcloud/tasks/receive.ts
var STATE_QUEUE = "mcloud.receive.queue";
var STATE_RECEIVE = "mcloud.receive.last";
function loadQueue(store2) {
  const raw = store2.getState(STATE_QUEUE);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === "object" && x !== null).map((o) => ({
      recordId: typeof o.recordId === "string" ? o.recordId : "",
      cloudType: typeof o.cloudType === "number" ? o.cloudType : void 0,
      raw: o.raw
    }));
  } catch {
    return [];
  }
}
function saveQueue(store2, q, nowIso) {
  store2.setState(STATE_QUEUE, JSON.stringify(q), nowIso);
}
function readAcceptDate(raw) {
  if (typeof raw !== "object" || raw === null) return void 0;
  const v = raw.acceptDate ?? raw.accept_date;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : void 0;
}
function explainReceiveFail(env, raw) {
  let code = env?.code;
  if (typeof code !== "number") {
    const m = /\bcode=(-?\d+)/.exec(raw);
    if (m) code = Number(m[1]);
  }
  if (code === 615) {
    return '领取失败：这一枪**没带 `deviceId`**（上游文案说"活动太火爆啦"，但它不是在限流）。领取类接口要一份 **H5 的 deviceId**，那份得靠 smid 指纹链换回来 —— 本插件还没实现那条链；在会话 JSON 里手工带上 `deviceId`（`B` + 88 字符 base64）即可用。';
  }
  if (code === 614) {
    return '领取失败：`deviceId` **内容无效**（上游文案说"锁定失败"，同样不是在限流）。⚠ 登录时那个 `device_id`（32 hex + `-ENDIN`）**不是** H5 要的那一份 —— mcloud 实测拿它去领回的就是这个 614。H5 要的是 `B` + 88 字符 base64。';
  }
  return void 0;
}
function receiveV3Body(cloudId, cloudType, deviceId) {
  return JSON.stringify({
    client: "app",
    cloudId,
    cloudType: cloudType === void 0 ? "" : cloudType,
    deviceId
  });
}
function runReceive(deps) {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: "未登录：state 里没有会话（见 docs/howto-session.md）" };
  }
  let queue = loadQueue(deps.store);
  if (queue.length === 0) {
    const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
    if (!info.ok) return { ok: false, note: `查询待领清单失败：${info.error}` };
    if (info.info.receiveList.length === 0) {
      return { ok: true, skipped: true, note: "没有待领取的东西（infoV3.receiveList 为空）" };
    }
    saveQueue(deps.store, info.info.receiveList, deps.nowIso);
    return {
      ok: true,
      note: `发现 ${info.info.receiveList.length} 条待领取，已入队（下面几次触发逐条领）`
    };
  }
  const item = queue[0];
  const rest = queue.slice(1);
  if (item.cloudType === 1) {
    const acceptDate = readAcceptDate(item.raw);
    const out2 = runTask(
      deps,
      {
        task: "receive",
        endpoint: "receiveTaskExpansion",
        method: "GET",
        query: acceptDate ? `acceptDate=${encodeURIComponent(acceptDate)}` : void 0,
        // 原实现是 h5(false, …)：这一口不发 isdeviceid
        isDeviceId: false,
        stateKey: STATE_RECEIVE
      },
      (env) => ({
        ok: true,
        note: `延期领取已完成（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
        snapshot: { item: item.raw, result: env.result ?? null }
      })
    );
    saveQueue(deps.store, rest, deps.nowIso);
    const left1 = rest.length;
    return { ...out2, note: `${out2.note}${left1 > 0 ? `（队列还剩 ${left1} 条）` : "（队列已清空）"}` };
  }
  const out = runTask(
    deps,
    {
      task: "receive",
      endpoint: "receiveV3",
      method: "POST",
      body: receiveV3Body(item.recordId, item.cloudType, session.deviceId ?? ""),
      stateKey: STATE_RECEIVE,
      // 615/614 的原话是"活动太火爆啦"，而真相是 deviceId 的事 —— 翻成人话
      explainFail: explainReceiveFail
    },
    (env) => ({
      ok: true,
      note: `已领取（cloudId=${item.recordId || "空"}；上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
      snapshot: { item: item.raw, result: env.result ?? null }
    })
  );
  saveQueue(deps.store, rest, deps.nowIso);
  const left = rest.length;
  return { ...out, note: `${out.note}${left > 0 ? `（队列还剩 ${left} 条）` : "（队列已清空）"}` };
}

// src/mcloud/tasks/revival.ts
var STATE_REVIVAL = "mcloud.revival.last";
var REVIVAL_SKIP_AFTER_MS = 2 * 36e5;
function revivalMessageAlreadyClaimed(message) {
  if (!message.includes("已领取") && !message.includes("已领过")) return false;
  return message.includes("复活卡") || message.includes("回馈卡") || message.includes("奖励");
}
function runRevival(deps) {
  return runTask(
    deps,
    {
      task: "revival",
      endpoint: "receiveRevivalReward",
      method: "POST",
      body: "{}",
      stateKey: STATE_REVIVAL,
      // 不可逆：晚了太久就不做
      skipIfLaterThanMs: REVIVAL_SKIP_AFTER_MS,
      // 「已领取」是**完成**，不是失败（否则面板每天多一条红）
      okWhenError: revivalMessageAlreadyClaimed
    },
    (env) => ({
      ok: true,
      note: `已用掉一张卡（上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 100)}）`,
      snapshot: env.result ?? null
    })
  );
}

// src/mcloud/tasks/sign.ts
var STATE_SIGN = "mcloud.sign.last";
var STATE_STAGE = "mcloud.sign.stage";
function runSign(deps) {
  const session = loadSession(deps.store);
  if (!session) {
    return { ok: false, note: "未登录：state 里没有会话（见 docs/howto-session.md）" };
  }
  const stage = deps.store.getState(STATE_STAGE) ?? "";
  if (stage === "need-verify") {
    const info2 = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
    if (!info2.ok) return { ok: false, note: `回查失败：${info2.error}` };
    if (info2.info.todaySigned) {
      deps.store.setState(STATE_STAGE, "", deps.nowIso);
      return { ok: true, note: "签到完成（回查 infoV3 确认今日已签）" };
    }
    return { ok: false, note: "已提交签到，但回查 infoV3 显示今日仍未签（上游可能延迟入账）" };
  }
  const info = fetchInfoV3({ store: deps.store, transport: deps.transport, baseUrl: deps.baseUrl });
  if (!info.ok) return { ok: false, note: `查询签到状态失败：${info.error}` };
  if (info.info.todaySigned) {
    return { ok: true, note: "今日已签到（infoV3 判据）" };
  }
  const deviceId = session.deviceId;
  const out = runTask(
    deps,
    {
      task: "sign",
      endpoint: "startSignIn",
      method: "GET",
      query: deviceId ? `client=app&deviceId=${encodeURIComponent(deviceId)}` : "client=app",
      isDeviceId: !!deviceId,
      stateKey: STATE_SIGN
    },
    (env) => ({
      ok: true,
      // ⚠️ 这里**不说"签到成功"** —— 动作响应不是判据（见文件头）。
      note: `签到已提交（下次触发回查状态；上游回 ${JSON.stringify(env.result ?? env.message).slice(0, 80)}）`,
      snapshot: { result: env.result ?? null, message: env.message }
    })
  );
  if (out.ok) deps.store.setState(STATE_STAGE, "need-verify", deps.nowIso);
  return out;
}

// src/mcloud/tasks/taskExpansion.ts
function signedGet(deps, path) {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: withBase(deps, path),
    method: "GET",
    body: void 0,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: false,
    saltKey: 1,
    marketName: "sign_in_3",
    session: session ? sessionHeaders(session) : {}
  });
}
function digResult(text) {
  try {
    const v = JSON.parse(text);
    const r = v.result;
    return r && typeof r === "object" ? r : v;
  } catch {
    return {};
  }
}
var STATE_EXPAND = "mcloud.taskexpansion.state";
var STEP_TEXT2 = {
  read: "① 读任务拓展状态",
  upload: "② 传一个文件触发本月备份",
  recheck: "②b 再过一遍状态",
  claim: "③ 领云朵",
  done: "完成"
};
function shouldUpload(read) {
  return read.curMonthBackup === false;
}
function asInt4(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function parseExpand(result) {
  const o = result && typeof result === "object" ? result : {};
  return {
    curMonthBackup: typeof o.curMonthBackup === "boolean" ? o.curMonthBackup : void 0,
    curMonthTaskRecordCount: asInt4(o.curMonthTaskRecordCount),
    acceptDate: typeof o.acceptDate === "string" ? o.acceptDate : void 0,
    nextMonthTaskRecordCount: asInt4(o.nextMonthTaskRecordCount)
  };
}
function load2(deps) {
  const raw = deps.store.getState(STATE_EXPAND);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v.step === "string" ? v : null;
  } catch {
    return null;
  }
}
var save3 = (deps, st) => deps.store.setState(STATE_EXPAND, JSON.stringify(st), deps.nowIso);
function startExpansion(deps) {
  save3(deps, { step: "read" });
  return { ok: true, note: "已排队：读状态 → （需要时）传文件触发备份 → 领云朵" };
}
function runExpansionStep(deps) {
  const st = load2(deps) ?? { step: "read" };
  if (st.step === "done") return { ok: true, idle: true, note: "这一趟已经走完" };
  const label = STEP_TEXT2[st.step];
  if (st.step === "upload") {
    if (uploadDone(deps)) {
      save3(deps, { ...st, step: "recheck" });
      return { ok: true, note: `${label}：文件已传完 —— 下一步再过一遍状态` };
    }
    const out2 = runUploadStep(deps, deterministicFile(EXPAND_FILE_SEED, EXPAND_FILE_BYTES));
    if (out2.idle || uploadDone(deps)) {
      save3(deps, { ...st, step: "recheck" });
      return {
        ok: true,
        note: out2.idle ? `${label}：没有待传的（可能上次已传完）—— 下一步再过一遍状态` : `${label}：文件已传完 —— 下一步再过一遍状态`
      };
    }
    return out2;
  }
  if (st.step === "read" || st.step === "recheck") {
    const res2 = callRawText(deps.transport, signedGet(deps, "/ycloud/signin/page/taskExpansion"));
    if (!res2.ok) return { ok: false, note: `${label}失败：${res2.error ?? "未知失败"}` };
    let read;
    try {
      read = parseExpand(digResult(res2.text));
    } catch (e) {
      return { ok: false, note: `${label}：响应解析不了（${e instanceof Error ? e.message : String(e)}）` };
    }
    const next = {
      step: "claim",
      acceptDate: read.acceptDate,
      curMonthBackup: read.curMonthBackup,
      curMonthTaskRecordCount: read.curMonthTaskRecordCount,
      nextMonthTaskRecordCount: read.nextMonthTaskRecordCount
    };
    if (st.step === "read" && shouldUpload(read)) {
      save3(deps, { ...next, step: "upload" });
      startUpload(deps, { name: EXPAND_FILE_NAME, bytes: deterministicFile(EXPAND_FILE_SEED, EXPAND_FILE_BYTES) });
      return { ok: true, note: `${label}：本月**未开启备份** ⇒ 传一个文件把它做出来 —— 下一步开始传` };
    }
    save3(deps, next);
    const tail = read.nextMonthTaskRecordCount === void 0 ? "" : `；下月可领 ${read.nextMonthTaskRecordCount} 个`;
    return {
      ok: true,
      note: `${label}：备份=${read.curMonthBackup === void 0 ? "没读到" : String(read.curMonthBackup)}，可领次数=${read.curMonthTaskRecordCount ?? "没读到"}${tail} —— 下一步领`
    };
  }
  const res = callRawText(
    deps.transport,
    signedGet(deps, `/ycloud/signin/page/receiveTaskExpansion?acceptDate=${st.acceptDate ?? ""}`)
  );
  save3(deps, { ...st, step: "done" });
  if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
  let out;
  try {
    out = JSON.parse(res.text);
  } catch {
    out = void 0;
  }
  const code = out?.code;
  const codeOk = code === void 0 || code === 0 || code === "0" || code === "0000";
  const raw = out?.result;
  const detail = typeof raw === "number" ? `${raw}（这一族的 result 是裸数字）` : `${res.text.slice(0, 120)}（⚠ 这一枪**缺成功样本**，形状没被实拍验过）`;
  if (!codeOk) {
    const msg = typeof out?.msg === "string" ? out.msg : "";
    return { ok: false, note: `${label}：上游拒绝 —— code=${String(code)}${msg === "" ? "" : ` ${msg}`}` };
  }
  return { ok: true, note: `${label}：上游回 ${detail}` };
}
var EXPAND_FILE_NAME = "panel-backup-marker.txt";
var EXPAND_FILE_SEED = "mcloud-panel-backup-marker-v1";
var EXPAND_FILE_BYTES = 256;
function withBase(deps, path) {
  return `${deps.baseUrl ?? "https://m.mcloud.139.com"}${path}`;
}

// src/mcloud/dailyState.ts
var DAILY_DONE_KEY = "mcloud.daily.done_date";
var DAILY_LAST_KEY = "mcloud.daily.last_run";

// src/entries/shared.ts
import {
  http_fetch,
  ws_close,
  ws_open,
  ws_recv,
  ws_send
} from "host-api";

// src/drain.ts
function drain(step, deps, opts) {
  const startedAt = opts.startedAt ?? Date.now();
  const notes = [];
  let steps = 0;
  let lastNote = "";
  for (let i = 0; i < opts.maxSteps; i++) {
    if (i > 0 && opts.more && !opts.more()) {
      return {
        ok: true,
        idle: true,
        steps,
        note: `${opts.label}：${steps} 步走完${lastNote ? ` —— ${lastNote}` : ""}`,
        notes
      };
    }
    if (Date.now() - startedAt > opts.deadlineMs) {
      return {
        ok: true,
        idle: false,
        steps,
        note: `${opts.label}：走到时间上限（${opts.deadlineMs}ms / ${steps} 步），下一次接着走`,
        notes
      };
    }
    let r;
    try {
      r = step(deps);
    } catch (e) {
      notes.push(`抛异常：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps + 1} 步抛异常`, notes };
    }
    steps++;
    lastNote = r.note;
    notes.push(r.note);
    if (!r.ok) {
      return { ok: false, idle: false, steps, note: `${opts.label}：第 ${steps} 步失败 —— ${r.note}`, notes };
    }
    if (r.idle || r.skipped) {
      return { ok: true, idle: true, steps, note: `${opts.label}：${steps} 步走完 —— ${r.note}`, notes };
    }
  }
  return {
    ok: true,
    idle: false,
    steps,
    note: `${opts.label}：走到步数上限（${opts.maxSteps} 步），下一次接着走`,
    notes
  };
}

// src/store/host.ts
import { sqlite_exec, sqlite_query } from "host-api";
function hostStore() {
  let schemaReady = false;
  return {
    ensureSchema: () => {
      if (schemaReady) return;
      sqlite_exec(
        `CREATE TABLE IF NOT EXISTS runs (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           task         TEXT    NOT NULL,
           runs         INTEGER NOT NULL,
           scheduled_at TEXT    NOT NULL,
           fired_at     TEXT    NOT NULL,
           late_ms      INTEGER NOT NULL,
           ok           INTEGER NOT NULL,
           note         TEXT
         )`
      );
      sqlite_exec(`CREATE INDEX IF NOT EXISTS idx_runs_task_fired ON runs (task, fired_at)`);
      sqlite_exec(
        `CREATE TABLE IF NOT EXISTS state (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`
      );
      schemaReady = true;
    },
    getState: (key) => {
      const rows = sqlite_query(`SELECT value FROM state WHERE key = ?1`, [key]);
      const row = rows[0];
      return row ? String(row.value) : null;
    },
    setState: (key, value, nowIso) => {
      sqlite_exec(
        `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
        [key, value, nowIso]
      );
    },
    recordRun: (r) => {
      const res = sqlite_exec(
        `INSERT INTO runs (task, runs, scheduled_at, fired_at, late_ms, ok, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [r.task, r.runs, r.scheduledAt, r.firedAt, Math.round(r.lateMs), r.ok ? 1 : 0, r.note ?? null]
      );
      return res.lastInsertRowid;
    },
    // 分位数在 SQL 里算，不把行拉回来算：`sqlite_query` 一次最多返回 1000 行，
    // 跑到几万次触发之后「拉回来再算」会静默丢数据 —— 那种错很难发现（数字看着还合理）。
    // 另外两点和内存实现必须同口径：**排除负延迟**（F-001）、**按值排序取分位**（不是按 id）。
    lateStats: (task, lastN = 500) => {
      const agg = sqlite_query(
        `SELECT COUNT(*) AS n, MAX(late_ms) AS mx FROM (
           SELECT late_ms FROM runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
         )`,
        [task, lastN]
      );
      const n = Number(agg[0]?.n ?? 0);
      const neg = sqlite_query(
        `SELECT COUNT(*) AS c FROM (
           SELECT late_ms FROM runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2
         ) WHERE late_ms < 0`,
        [task, lastN]
      );
      const pick2 = (q) => {
        if (n === 0) return 0;
        const offset = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
        const rows = sqlite_query(
          `SELECT late_ms AS v FROM (
             SELECT late_ms FROM runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
           ) ORDER BY late_ms ASC LIMIT 1 OFFSET ?3`,
          [task, lastN, offset]
        );
        const v = rows[0]?.v;
        return v === void 0 || v === null ? 0 : Number(v);
      };
      return {
        task,
        n,
        lateP50: pick2(0.5),
        lateP99: pick2(0.99),
        lateMax: Number(agg[0]?.mx ?? 0),
        excluded: Number(neg[0]?.c ?? 0)
      };
    },
    recentRuns: (limit = 20) => sqlite_query(
      `SELECT task, runs, fired_at, late_ms, ok, note FROM runs ORDER BY id DESC LIMIT ?1`,
      [Math.min(limit, 1e3)]
    )
  };
}

// src/mcloud/session.ts
var STATE_BASE_URL = "mcloud.base_url";
function loadBaseUrl(store2) {
  const v = store2.getState(STATE_BASE_URL);
  if (!v) return "";
  const t = v.trim();
  if (!/^https?:\/\//.test(t)) return "";
  return t.replace(/\/+$/, "");
}

// src/entries/shared.ts
var DEFAULT_REQUEST_TIMEOUT_MS = 1500;
var LONG_REQUEST_TIMEOUT_MS = 2e4;
function makeTransport(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return (req) => {
    const r = applyDefaultContentType(req);
    return http_fetch(r.url, hostFetchOptions(r, timeoutMs));
  };
}
function makeStore() {
  const store2 = hostStore();
  store2.ensureSchema();
  return store2;
}
function taskDeps(store2, transport2, payload) {
  return {
    store: store2,
    transport: transport2,
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    // 基址**每次触发时从 state 读**，不用启动时的快照 ——
    // 否则「刚把基址指到 mock，任务却还在打真上游」
    baseUrl: loadBaseUrl(store2),
    lateMs: payload.lateMs
  };
}

// src/entries/daily.ts
worker_hint("exclusive");
var store = makeStore();
var transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
var BUDGET_MS = 12e4;
var DEADLINE_MS = BUDGET_MS - 15e3;
var DONE_KEY = DAILY_DONE_KEY;
var LAST_KEY = DAILY_LAST_KEY;
function once(name, fn, deps) {
  try {
    const r = fn(deps);
    return { name, ok: r.ok, note: r.note, idle: r.idle === true };
  } catch (e) {
    return { name, ok: false, note: `抛异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
function runDaily(deps) {
  const started = Date.now();
  const steps = [];
  const detail = [];
  const push = (r) => {
    steps.push(r);
    detail.push(`${r.name}：${r.ok ? "" : "失败 "}${r.note}`);
    return r;
  };
  if (needExchange(store, Date.now())) {
    const r = drain(
      (d) => {
        const x = runExchangeStep(d);
        return { ok: x.ok, note: x.note, idle: x.done };
      },
      deps,
      { label: "换票", maxSteps: 4, deadlineMs: 3e4, startedAt: started }
    );
    push({ name: "换票", ok: r.ok, note: r.note, idle: r.idle });
  } else {
    push({ name: "换票", ok: true, note: "票还新鲜，不用换", idle: true });
  }
  const signPending = () => (store.getState(STATE_STAGE) ?? "") === "need-verify";
  push(
    (() => {
      const r = drain(runSign, deps, {
        label: "签到",
        maxSteps: 4,
        deadlineMs: 2e4,
        startedAt: started,
        more: signPending
      });
      return { name: "签到", ok: r.ok, note: r.note, idle: r.idle };
    })()
  );
  for (const [name, fn] of [
    ["领取AI豆", runReceive],
    ["备份好礼", runBackupGift],
    ["开启通知领AI豆", runNotice]
  ]) {
    const r = drain(fn, deps, {
      label: name,
      maxSteps: 12,
      deadlineMs: 4e4,
      startedAt: started
    });
    push({ name, ok: r.ok, note: r.note, idle: r.idle });
  }
  for (const [name, fn] of [
    ["签到翻倍", runMultiple],
    ["复活卡", runRevival]
  ]) {
    push(once(name, fn, deps));
  }
  if (!store.getState("mcloud.taskexpansion.state")) startExpansion(deps);
  push(
    (() => {
      const r = drain(runExpansionStep, deps, {
        label: "任务拓展",
        maxSteps: 12,
        deadlineMs: 45e3,
        startedAt: started
      });
      return { name: "任务拓展", ok: r.ok, note: r.note, idle: r.idle };
    })()
  );
  push(
    (() => {
      const r = drain(runAppTaskMatrix, deps, {
        label: "App 任务矩阵",
        maxSteps: MATRIX_MARKETS.length,
        deadlineMs: 25e3,
        startedAt: started
      });
      return { name: "App 任务矩阵（只看）", ok: r.ok, note: r.note, idle: false };
    })()
  );
  if (!store.getState("mcloud.apptask.state") && startAppTask(deps).idle) {
    push({ name: "App 任务", ok: true, note: "没有待办", idle: true });
  } else {
    const r = drain(runAppTaskStep, deps, {
      label: "App 任务",
      maxSteps: 20,
      deadlineMs: 6e4,
      startedAt: started
    });
    push({ name: "App 任务", ok: r.ok, note: r.note, idle: r.idle });
  }
  for (const [name, fn] of [
    ["消息推送奖励（问状态）", runMsgPushStatus],
    ["消息推送奖励（领）", runMsgPushObtain]
  ]) {
    const r = drain(fn, deps, {
      label: name,
      maxSteps: 6,
      deadlineMs: 2e4,
      startedAt: started
    });
    push({ name, ok: r.ok, note: r.note, idle: r.idle });
  }
  push(once("凭据续期", (d) => runAuthRefresh(d), deps));
  push(once("待领取奖品", runPrizes, deps));
  push(once("AI豆快照", runCloudSnapshot, deps));
  const failed = steps.filter((s) => !s.ok);
  const elapsed = Date.now() - started;
  const done = steps.filter((s) => !s.idle).length;
  const shape = (r) => ({
    name: r.name,
    ok: r.ok,
    note: r.note,
    idle: r.idle === true
  });
  if (failed.length === 0) {
    return {
      ok: true,
      note: `${steps.length} 步全部完成（${done} 步有动作，用时 ${(elapsed / 1e3).toFixed(1)}s）`,
      detail,
      steps: steps.map(shape)
    };
  }
  return {
    ok: false,
    note: `${failed.length}/${steps.length} 步失败：${failed.map((f) => f.name).join("、")}`,
    detail,
    steps: steps.map(shape)
  };
}
register_cron(
  "日常",
  // 白天每 30 分钟一跳：低配盒子不常在线时，上线之后的下一跳就能补上
  // （面板不补跑，见文件头）。整趟成功后剩下的跳是零请求的秒返回。
  "*/30 7-22 * * *",
  (p) => {
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const today2 = nowIso.slice(0, 10);
    const doneDate = store.getState(DONE_KEY);
    if (doneDate === today2) return;
    const deps = taskDeps(store, transport, p);
    const r = runDaily(deps);
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.note
    });
    store.setState(
      LAST_KEY,
      JSON.stringify({
        at: nowIso,
        ok: r.ok,
        note: r.note,
        steps: r.steps
      }),
      nowIso
    );
    if (r.ok) {
      store.setState(DONE_KEY, today2, nowIso);
      log(`日常：${r.note}`);
    } else {
      warn(`日常：${r.note}`);
    }
    for (const line of r.detail) {
      if (line.includes("失败")) warn(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS }
);
log(`mcloud-daily：任务「日常」（预算 ${BUDGET_MS / 1e3}s，独占线程）`);
