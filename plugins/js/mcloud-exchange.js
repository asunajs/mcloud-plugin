// 由 src/entries/exchange.ts 打包生成 —— **不要手改这个文件**。
//
//   改代码：编辑 src/，然后 `npm run build`
//   只在构建产物上改动的东西，下一次构建就没了
//   mcloud-plugin 0.0.0 · 插件 `mcloud-exchange`

// src/entries/exchange.ts
import { log as log2, register_cron, warn as warn2, worker_hint } from "host-api";

// src/mcloud/exchangeTiming.ts
var WINDOW_SECOND = 40;
var WINDOW_TAIL_MS = 15e3;
var FIRE_LEAD_MS = 10;
var WINDOW_LEAD_MS = 6e4 - WINDOW_SECOND * 1e3;
var HOUR_MS = 36e5;
function mod(a, n) {
  return (a % n + n) % n;
}
function hourStartMs(nowMs) {
  return nowMs - mod(nowMs, HOUR_MS);
}
function hourKey(nowMs) {
  return String(hourStartMs(nowMs));
}
var NO_WAIT = { needed: false, untilMs: 0, ms: 0 };
function planWindowWait(nowMs) {
  const into = mod(nowMs, HOUR_MS);
  const startMs = (59 * 60 + WINDOW_SECOND) * 1e3;
  if (into >= startMs || into < WINDOW_TAIL_MS) return NO_WAIT;
  const untilMs = hourStartMs(nowMs) + startMs;
  return { needed: true, untilMs, ms: untilMs - nowMs };
}
function planFireWait(nowMs, leadMs = FIRE_LEAD_MS) {
  const into = mod(nowMs, HOUR_MS);
  if (into < WINDOW_LEAD_MS) return NO_WAIT;
  const untilMs = hourStartMs(nowMs) + HOUR_MS - leadMs;
  if (untilMs <= nowMs) return NO_WAIT;
  return { needed: true, untilMs, ms: untilMs - nowMs };
}
var DEFAULT_TARGET_HOUR = 10;
var STATE_TARGET_HOUR = "mcloud.exchange.target_hour";
function targetHourOf(store2) {
  const raw = store2.getState(STATE_TARGET_HOUR);
  if (raw === void 0 || raw === null) return DEFAULT_TARGET_HOUR;
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_TARGET_HOUR;
}
function planTargetWait(nowMs, targetHour, tailMs = WINDOW_TAIL_MS) {
  if (targetHour === null) return planWindowWait(nowMs);
  const d = new Date(nowMs);
  const localHour = d.getHours();
  const minutesIntoHour = d.getMinutes() * 6e4 + d.getSeconds() * 1e3 + d.getMilliseconds();
  if (localHour === targetHour && minutesIntoHour < tailMs) return NO_WAIT;
  if (localHour === mod(targetHour - 1, 24) && minutesIntoHour >= (59 * 60 + WINDOW_SECOND) * 1e3) {
    return NO_WAIT;
  }
  const openAt = (base) => {
    const t = new Date(base.getTime());
    t.setHours(mod(targetHour - 1, 24), 59, WINDOW_SECOND, 0);
    return t.getTime();
  };
  let target = openAt(d);
  if (target <= nowMs) {
    const t = new Date(nowMs + 24 * 36e5);
    target = openAt(t);
  }
  return { needed: true, untilMs: target, ms: target - nowMs };
}

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
function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor(clean.length * 6 / 8));
  let bits2 = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    acc = acc << 6 | v;
    bits2 += 6;
    if (bits2 >= 8) {
      bits2 -= 8;
      out[o] = acc >> bits2 & 255;
      o += 1;
    }
  }
  return out.subarray(0, o);
}
function writeU32LE(out, off, v) {
  out[off] = v & 255;
  out[off + 1] = v >>> 8 & 255;
  out[off + 2] = v >>> 16 & 255;
  out[off + 3] = v >>> 24 & 255;
}
function readU32LE(b, off) {
  return (b[off + 3] << 24 | b[off + 2] << 16 | b[off + 1] << 8 | b[off]) >>> 0;
}
function lengthBits(bytes) {
  const bits2 = bytes * 8;
  return { hi: Math.floor(bits2 / 4294967296) >>> 0, lo: bits2 >>> 0 };
}

// src/mcloud/auth.ts
function lenientB64(s) {
  let payload = "";
  for (const c of s) {
    if (c === "=") break;
    if (/[A-Za-z0-9+/]/.test(c)) payload += c;
  }
  if (payload.length === 0 || payload.length % 4 === 1) return void 0;
  const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - payload.length % 4);
  let text;
  try {
    text = fromUtf8(fromBase64(payload + pad));
  } catch {
    return void 0;
  }
  return text.length === 0 ? void 0 : text;
}
function isPlainDecimal(s) {
  if (s.length === 0) return false;
  let i = 0;
  if (s[0] === "+" || s[0] === "-") i = 1;
  if (i >= s.length) return false;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}
function parseAuth(auth) {
  if (auth.trim() === "") return void 0;
  const i = auth.indexOf("Basic ");
  const clean = i < 0 ? auth : auth.slice(0, i) + auth.slice(i + "Basic ".length);
  const decoded = lenientB64(clean);
  if (decoded === void 0) return void 0;
  const parts = decoded.split(":", 4);
  const platform = parts[0] ?? "";
  const phone = parts[1] ?? "";
  const token = parts[2] ?? "";
  const seg = token.split("|")[3]?.trim();
  const expire = seg !== void 0 && isPlainDecimal(seg) ? Math.trunc(Number(seg)) || 0 : 0;
  return { raw: `Basic ${clean}`, platform, phone, token, expire };
}

// src/mcloud/accounts.ts
var STATE_ACCOUNTS = "mcloud.accounts";
var STATE_CURRENT_ACCOUNT = "mcloud.account.current";
function maskAuth(raw) {
  const phone = phoneOf(raw);
  const len = raw.length;
  if (phone !== void 0) return `${phone.slice(0, 1)}****${phone.slice(-4)} · ${len} 字符`;
  return `（认不出手机号）· ${len} 字符`;
}
function phoneOf(raw) {
  const plain = /1\d{10}/.exec(raw);
  if (plain !== null) return plain[0];
  const m = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(raw);
  if (m === null) return void 0;
  try {
    const decoded = fromUtf8(fromBase64(m[1]));
    const inB64 = /1\d{10}/.exec(decoded);
    return inB64 === null ? void 0 : inB64[0];
  } catch {
    return void 0;
  }
}
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
    const auth = o.auth;
    const info = parseAuth(auth);
    const pc = o.pcPlatform;
    out.push({
      id: o.id,
      label: typeof o.label === "string" && o.label !== "" ? o.label : o.id,
      auth,
      // 老账号没存过这两格 ⇒ 从凭据里现解一次（不用迁移）
      platform: typeof o.platform === "string" ? o.platform : info?.platform ?? "",
      pcPlatform: pc === "win" || pc === "mac" ? pc : void 0,
      addedAt: typeof o.addedAt === "string" ? o.addedAt : ""
    });
  }
  return out;
}
function selectAccount(store2, id, nowIso) {
  if (id !== "" && !loadAccounts(store2).some((a) => a.id === id)) return false;
  store2.setState(STATE_CURRENT_ACCOUNT, id, nowIso);
  return true;
}
function currentAccount(store2) {
  const id = (store2.getState(STATE_CURRENT_ACCOUNT) ?? "").trim();
  if (id === "") return void 0;
  return loadAccounts(store2).find((a) => a.id === id);
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

// src/crypto/hmac.ts
var md5Hex = (d) => toHex(md5(anyBytes(d)));
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
var AES_FIXED_IV = (() => {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = "0102030405060708".charCodeAt(i);
  return out;
})();

// src/crypto/gzip.ts
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

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

// src/mcloud/smidRules.ts
var SKLAND_SM_CONFIG = {
  organization: "FXlyfmWg2AzwbrxDKSv5",
  appId: "default",
  publicKey: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8KHAcHbkCn5rxGgGJE+07tY+pt86D/oZ7sA51FaEBv2jgno2TI9zHJVYKJynmiKpixgwUcv93EfWIrU/p/UCs5Vu+odS3I4UBp3R7IZ1A0W01FkumAHYW2PQpMm8ueQKPLUq/idkpG/9b2JDv/qU+Ks36nbUPwlW4CjdfrV+V9QIDAQAB",
  protocol: "https",
  apiHost: "slw.h5cmpassport.com:9090",
  apiPath: "/deviceprofile/v4"
};

// src/mcloud/smid.ts
var SMID_HOST = `${SKLAND_SM_CONFIG.protocol}://${SKLAND_SM_CONFIG.apiHost}`;
var SMID_PATH = SKLAND_SM_CONFIG.apiPath;

// src/mcloud/sessionExchange.ts
var STATE_AUTH = "mcloud.h5.auth";
function loadAuthRaw(store2) {
  const cur = currentAccount(store2);
  if (cur !== void 0) return cur.auth;
  return store2.getState(STATE_AUTH) ?? "";
}
var JWT_TTL_MS = 100 * 60 * 1e3;
var RETRY_AFTER_MS = 30 * 60 * 1e3;

// src/mcloud/runLog.ts
var RUN_LOG_KEY = "mcloud.run.log";
var RUNS_PER_TASK = 20;
var MAX_STEPS = 40;
var MAX_NOTE = 300;
function clip(s, max2 = MAX_NOTE) {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t.length <= max2 ? t : `…${t.slice(t.length - max2 + 1)}`;
}
function cleanStep(s) {
  return {
    name: clip(s.name, 60),
    ok: s.ok === true,
    note: clip(s.note),
    idle: s.idle === true
  };
}
function readRuns(store2) {
  const raw = store2.getState(RUN_LOG_KEY);
  if (raw === void 0 || raw === null || raw === "") return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r) => typeof r === "object" && r !== null && typeof r.id === "string"
    );
  } catch {
    return [];
  }
}
function appendRun(store2, rec) {
  const steps = rec.steps.slice(0, MAX_STEPS).map(cleanStep);
  const id = `${rec.task}-${Date.parse(rec.at) || 0}`;
  const all = readRuns(store2);
  const next = {
    id,
    task: rec.task,
    at: rec.at,
    ms: Math.max(0, Math.round(rec.ms)),
    ok: rec.ok === true,
    note: clip(rec.note),
    steps,
    truncated: rec.steps.length > MAX_STEPS
  };
  const kept = all.filter((r) => r.id !== id);
  kept.push(next);
  const byTask = /* @__PURE__ */ new Map();
  for (const r of kept) {
    const list = byTask.get(r.task) ?? [];
    list.push(r);
    byTask.set(r.task, list);
  }
  const trimmed = [];
  for (const list of byTask.values()) {
    list.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
    trimmed.push(...list.slice(0, RUNS_PER_TASK));
  }
  trimmed.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  store2.setState(RUN_LOG_KEY, JSON.stringify(trimmed), rec.at);
  return id;
}

// src/mcloud/tasks/base.ts
function depsNowMs(deps) {
  return (deps.nowMs ?? Date.now)();
}
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

// node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var zls = function(d, dict) {
  if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
    err(6, "invalid zlib data");
  if ((d[1] >> 5 & 1) == +!dict)
    err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
  return (d[1] >> 3 & 4) + 2;
};
function unzlibSync(data, opts) {
  return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}

// src/crypto/png.ts
var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function u32(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}
function channelsOf(colorType) {
  switch (colorType) {
    case 0:
      return 1;
    // 灰度
    case 2:
      return 3;
    // RGB
    case 3:
      return 1;
    // 调色板索引
    case 4:
      return 2;
    // 灰度 + alpha
    case 6:
      return 4;
    // RGBA
    default:
      throw new Error(`PNG 色彩类型不认识：${colorType}`);
  }
}
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = new Uint8Array(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[pos + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + (a + b >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`PNG 滤波类型不认识：${ft}（第 ${y} 行）`);
      }
      out[rowStart + x] = v & 255;
    }
    pos += stride;
  }
  return out;
}
function decodeImage(bytes) {
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("不是 PNG（签名不对）");
  }
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette;
  let transparency;
  const idat = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = u32(body, 0);
      h = u32(body, 4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") {
      palette = body.slice();
    } else if (type === "tRNS") {
      transparency = body.slice();
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  if (w <= 0 || h <= 0) throw new Error(`PNG 尺寸不合法：${w}x${h}`);
  if (bitDepth !== 8) throw new Error(`PNG 位深只支持 8（这张是 ${bitDepth}）`);
  if (interlace !== 0) throw new Error("PNG 是隔行的，不支持（硬解会得到错位的图）");
  if (idat.length === 0) throw new Error("PNG 没有 IDAT");
  const ch = channelsOf(colorType);
  let total = 0;
  for (const d of idat) total += d.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const d of idat) {
    merged.set(d, off);
    off += d.length;
  }
  const raw = unfilter(unzlibSync(merged), w, h, ch);
  const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  if (colorType === 0) {
    for (let i = 0; i < n; i += 1) {
      const v = raw[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 2) {
    for (let i = 0; i < n; i += 1) {
      rgba[i * 4] = raw[i * 3];
      rgba[i * 4 + 1] = raw[i * 3 + 1];
      rgba[i * 4 + 2] = raw[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error("PNG 是调色板图但没有 PLTE");
    for (let i = 0; i < n; i += 1) {
      const idx = raw[i];
      rgba[i * 4] = palette[idx * 3] ?? 0;
      rgba[i * 4 + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = transparency?.[idx] ?? 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < n; i += 1) {
      const v = raw[i * 2];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = raw[i * 2 + 1];
    }
  } else {
    rgba.set(raw.subarray(0, n * 4));
  }
  return { data: rgba, width: w, height: h };
}

// src/mcloud/slide.ts
var ALPHA_OPAQUE_THRESHOLD = 128;
function toGrayFast(data, i) {
  return data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 >> 8;
}
function matchSlide(bgData, puzzleData, bgW, bgH, pzW, pzH) {
  const bgPixels = bgData.data;
  const pzPixels = puzzleData.data;
  const contourX = [];
  const contourY = [];
  const bgEdge = new Uint8Array(bgW * bgH);
  for (let y = 1; y < bgH - 1; y += 1) {
    for (let x = 1; x < bgW - 1; x += 1) {
      const tl = toGrayFast(bgPixels, (y - 1) * bgW + (x - 1) << 2);
      const tc = toGrayFast(bgPixels, (y - 1) * bgW + x << 2);
      const tr = toGrayFast(bgPixels, (y - 1) * bgW + (x + 1) << 2);
      const ml = toGrayFast(bgPixels, y * bgW + (x - 1) << 2);
      const mr = toGrayFast(bgPixels, y * bgW + (x + 1) << 2);
      const bl = toGrayFast(bgPixels, (y + 1) * bgW + (x - 1) << 2);
      const bc = toGrayFast(bgPixels, (y + 1) * bgW + x << 2);
      const br = toGrayFast(bgPixels, (y + 1) * bgW + (x + 1) << 2);
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      bgEdge[y * bgW + x] = Math.min(255, Math.abs(gx) + Math.abs(gy) >> 2);
    }
  }
  for (let y = 1; y < pzH - 1; y += 1) {
    for (let x = 1; x < pzW - 1; x += 1) {
      const pi = y * pzW + x << 2;
      if (pzPixels[pi + 3] <= ALPHA_OPAQUE_THRESHOLD) continue;
      const above = pzPixels[((y - 1) * pzW + x) * 4 + 3] <= ALPHA_OPAQUE_THRESHOLD;
      const below = pzPixels[((y + 1) * pzW + x) * 4 + 3] <= ALPHA_OPAQUE_THRESHOLD;
      const left = pzPixels[(y * pzW + (x - 1)) * 4 + 3] <= ALPHA_OPAQUE_THRESHOLD;
      const right = pzPixels[(y * pzW + (x + 1)) * 4 + 3] <= ALPHA_OPAQUE_THRESHOLD;
      if (above || below || left || right) {
        contourX.push(x);
        contourY.push(y);
      }
    }
  }
  const numContours = contourX.length;
  if (numContours === 0) return { offsetX: 0, confidence: 0 };
  const maxOffset = bgW - pzW;
  if (maxOffset < 0) return { offsetX: 0, confidence: 0 };
  let bestOffset = 0;
  let bestScore = 0;
  let totalScore = 0;
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    let sum = 0;
    for (let c = 0; c < numContours; c += 1) {
      const bx = offset + contourX[c];
      if (bx < bgW) sum += bgEdge[contourY[c] * bgW + bx];
    }
    totalScore += sum;
    if (sum > bestScore) {
      bestScore = sum;
      bestOffset = offset;
    }
  }
  const avgScore = totalScore / (maxOffset + 1);
  return { offsetX: bestOffset, confidence: avgScore > 0 ? bestScore / avgScore : 0 };
}
function calcPuzzleOffset(puzzleBase64, pictureBase64) {
  const puzzle = decodeImage(fromBase64(puzzleBase64));
  const picture = decodeImage(fromBase64(pictureBase64));
  return matchSlide(picture, puzzle, picture.width, picture.height, puzzle.width, puzzle.height);
}
var MIN_CONFIDENCE = 1.5;
function usable(r) {
  return r.offsetX > 0 && r.confidence >= MIN_CONFIDENCE;
}

// src/mcloud/tasks/exchangeList.ts
var STATE_LIST = "mcloud.exchangelist.last";
var STATE_RAW = "mcloud.exchangelist.raw";
var LIMIT_AVAILABLE = 0;
var LIMIT_TOMORROW = 1;
var LIMIT_EXCHANGED = 2;
var LIMIT_GROUP_EXCHANGED = 4;
function verdictOf(p) {
  if (p.onLine !== void 0 && p.onLine !== 1) return "offline";
  if (p.monthLimit !== void 0 && p.received !== void 0 && p.received >= p.monthLimit) {
    return "month-limit";
  }
  if (p.limit === void 0) return "unknown";
  switch (p.limit) {
    case LIMIT_AVAILABLE:
      return "ok";
    case LIMIT_TOMORROW:
      return "tomorrow";
    case LIMIT_EXCHANGED:
      return "exchanged";
    case LIMIT_GROUP_EXCHANGED:
      return "group-exchanged";
    default:
      return "unknown";
  }
}
function asInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function asStr(v) {
  return typeof v === "string" && v !== "" ? v : void 0;
}
function parseMonthLimit(v) {
  let o = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return void 0;
    }
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return void 0;
  const r = o;
  return asInt(r.limitMonthQuantity ?? r.limit_month_quantity);
}
function parsePrize(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const o = raw;
  const p = {
    // ⚠ 实拍是**数字**，不是字符串（原项目特意标了这一点）
    prizeId: asInt(o.prizeId ?? o.prize_id),
    // ⚠ 真机 51/51 是 `prizeName`；`name` 保留是为兼容 mock 与将来可能的另一种形状
    name: asStr(o.prizeName ?? o.name),
    monthLimit: parseMonthLimit(o.probability2),
    received: asInt(o.receiveQuantity ?? o.receive_quantity),
    groupId: asInt(o.groupId ?? o.group_id),
    // ⚠⚠ 价格是 **`pOrder`**（不是 `price`）—— 而且同一份响应里 `POrder` 与 `pOrder`
    // **两种拼法并存**，只读一个键的写法会把一部分商品的价格判成"没给"，
    // 于是"余额够不够"那道判断对那几件**恒假**（看着像"没配置价格"，其实是不检查就下单）。
    // 逐字照 mcloud 的 `parse_price`：小写先试，大写兜底。
    price: asInt(o.pOrder) ?? asInt(o.POrder),
    limit: asInt(o.limit),
    count: asInt(o.count),
    totalCount: asInt(o.totalCount ?? o.total_count),
    dailyRemainderCount: asInt(o.dailyRemainderCount ?? o.daily_remainder_count),
    onLine: asInt(o.onLine ?? o.on_line),
    startTime: asStr(o.startTime ?? o.start_time),
    endTime: asStr(o.endTime ?? o.end_time)
  };
  return p.prizeId !== void 0 || p.name !== void 0 ? p : void 0;
}
function parseExchangeList(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  const src = o.groups ?? o;
  const groups = [];
  const all = [];
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const key of Object.keys(src)) {
      const v = src[key];
      if (!Array.isArray(v)) continue;
      const prizes = v.map(parsePrize).filter((x) => !!x);
      groups.push({ group: key, prizes });
      all.push(...prizes);
    }
  }
  groups.sort((a, b) => (Number(a.group) || 0) - (Number(b.group) || 0));
  all.sort((a, b) => (a.groupId ?? 0) - (b.groupId ?? 0) || (a.prizeId ?? 0) - (b.prizeId ?? 0));
  return { groups, prizes: all };
}
function summarizeList(prizes) {
  const byVerdict = {};
  const ok = [];
  for (const p of prizes) {
    const v = verdictOf(p);
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    if (v === "ok" && ok.length < 20) {
      ok.push({ prizeId: p.prizeId, name: p.name, price: p.price, groupId: p.groupId });
    }
  }
  return { total: prizes.length, okCount: byVerdict.ok ?? 0, byVerdict, ok };
}
function runExchangeList(deps) {
  return runTask(
    deps,
    {
      task: "exchange-list",
      endpoint: "exchangeList",
      method: "GET",
      marketName: "sign_in_3",
      isDeviceId: false,
      stateKey: STATE_RAW
    },
    (env) => {
      const { groups, prizes } = parseExchangeList(env.result);
      const s = summarizeList(prizes);
      const reading = { at: deps.nowIso, groups: groups.length, ...s };
      deps.store.setState(STATE_LIST, JSON.stringify(reading), deps.nowIso);
      const names = s.ok.slice(0, 3).map(
        (x) => x.price === void 0 ? x.name ?? "#" + x.prizeId : `${x.name ?? "#" + x.prizeId}(${x.price}豆)`
      );
      return {
        ok: true,
        note: `兑换清单：${groups.length} 组 / ${s.total} 件，可兑 ${s.okCount} 件` + (names.length ? `（${names.join("、")}）` : "") + (s.byVerdict.unknown ? `；判不了 ${s.byVerdict.unknown} 件` : ""),
        snapshot: reading
      };
    }
  );
}

// src/mcloud/tasks/exchangeOrder.ts
var STATE_STEP = "mcloud.exchange.order.step";
var STATE_PLAN = "mcloud.exchange.order.plan";
var STATE_BASE = "mcloud.exchange.order.baseline";
var STATE_ROUND = "mcloud.exchange.order.round";
var SLIDER_ROUNDS = 2;
var EXCHANGE_CLIENT_VERSION = "12.6.0";
var SLIDE_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
var VISIT_LOG_KEYWORD_EXCHANGE = "newsignin_index_to_exchange";
var VISIT_LOG_KEYWORD_EXCHANGE_TIMES = "newsignin_index_exchange_times";
var VISIT_LOG_MARKET_NAME = "sign_in_3";
var CODE_SLIDER_WRONG = 514;
var PREHEAT_DELAY_MS = 500;
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function signedReq(deps, spec) {
  const session = loadSession(deps.store);
  return buildH5Request({
    url: spec.url,
    method: spec.method,
    body: spec.body,
    contentType: spec.contentType,
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    // ⚠ `isDeviceId` 是**逐接口**的：下单那条要，取滑块那条**不要**（照实拍）
    isDeviceId: spec.isDeviceId ?? false,
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
function loadState(deps) {
  const raw = deps.store.getState(STATE_STEP);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v.step === "string" ? v : null;
  } catch {
    return null;
  }
}
function saveState(deps, st) {
  deps.store.setState(STATE_STEP, JSON.stringify(st), deps.nowIso);
}
var STATE_LAST_WAIT = "mcloud.exchange.order.last_wait";
var STATE_LEAD_MS = "mcloud.exchange.order.lead_ms";
var STATE_ORDERED_HOUR = "mcloud.exchange.order.ordered_hour";
function exchangeLeadMs(store2) {
  const raw = store2.getState(STATE_LEAD_MS);
  const n = raw === void 0 || raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(2e3, Math.max(0, n)) : FIRE_LEAD_MS;
}
function spinUntil(targetMs, deps) {
  const nowFn = () => depsNowMs(deps);
  const spin = deps.spin ?? (() => {
    const t0 = Date.now();
    while (Date.now() - t0 < 2) {
    }
  });
  const started = nowFn();
  const hardDeadline = started + MAX_WAIT_MS;
  while (true) {
    const now = nowFn();
    if (now >= targetMs) return Math.max(0, now - started);
    if (now - started > MAX_WAIT_MS || now >= hardDeadline) {
      return Math.max(0, now - started);
    }
    spin();
  }
}
var MAX_WAIT_MS = 61 * 6e4;
var MAX_SPIN_MS = 3e4;
function snapshotOrder(store2) {
  return {
    step: store2.getState(STATE_STEP),
    base: store2.getState(STATE_BASE)
  };
}
function restoreOrder(store2, snap, nowIso) {
  if (snap.step === null) store2.setState(STATE_STEP, "", nowIso);
  else store2.setState(STATE_STEP, snap.step, nowIso);
  if (snap.base === null) store2.setState(STATE_BASE, "", nowIso);
  else store2.setState(STATE_BASE, snap.base, nowIso);
}
function currentStep(store2) {
  const raw = store2.getState(STATE_STEP);
  if (raw === void 0 || raw === null || raw === "") return null;
  try {
    const v = JSON.parse(raw);
    return typeof v.step === "string" ? v.step : null;
  } catch {
    return null;
  }
}
function clearOrder(deps) {
  deps.store.setState(STATE_STEP, "", deps.nowIso);
  deps.store.setState(STATE_PLAN, "", deps.nowIso);
  deps.store.setState(STATE_BASE, "", deps.nowIso);
  deps.store.setState(STATE_ROUND, "", deps.nowIso);
}
function startOrder(deps, query) {
  if (query.trim() === "") {
    return { ok: false, note: "兑换要指定奖品（名字或 prizeId）—— 没有它无从下手" };
  }
  saveState(deps, { step: "list", round: 0 });
  deps.store.setState(STATE_PLAN, query.trim(), deps.nowIso);
  return { ok: true, note: `已排队兑换「${query.trim()}」—— 后面每次触发走一步（一次调用一个请求）` };
}
function pickPrize(prizes, query) {
  const q = query.trim();
  if (/^\d+$/.test(q)) return prizes.find((p) => String(p.prizeId) === q);
  return prizes.find((p) => p.name === q);
}
var STEP_TEXT = {
  list: "① 读清单",
  balance: "② 读基准余额（成交复查要拿它算差值）",
  "warm-1": "③ 预热第一枪",
  "warm-2": "③ 预热第二枪",
  slide: "④ 取滑块题面并本地解",
  order: "⑤ 下单",
  verify: "⑥ 复查余额差",
  done: "完成"
};
function runOrderStep(deps) {
  const st = loadState(deps);
  if (!st) return { ok: true, idle: true, note: "没有在排队的兑换（先用 startOrder 起一单）" };
  const query = deps.store.getState(STATE_PLAN) ?? "";
  const step = st.step;
  const label = STEP_TEXT[step];
  const done = (note, ok = true) => {
    saveState(deps, { ...st, step: "done" });
    return { ok, note };
  };
  if (step === "done") return { ok: true, idle: true, note: "这一单已经走完了（要再来一单得重新起）" };
  if (step === "list") {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/exchangeList?client=app&clientVersion=${encodeURIComponent(EXCHANGE_CLIENT_VERSION)}`,
        method: "GET"
      })
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
    const { prizes } = parseExchangeList(digResult(res.text));
    const p = pickPrize(prizes, query);
    if (!p) return done(`${label}：清单里没有「${query}」—— 这一单不做（名字要**精确**匹配）`, false);
    const prizeId = num(p.prizeId);
    if (prizeId === void 0) {
      return done(`${label}：清单里那条没有可用的 prizeId ⇒ 这一单不做（不许编一个数字发出去）`, false);
    }
    const plan = { prizeId, prizeName: String(p.name ?? ""), price: num(p.price), query };
    saveState(deps, { ...st, step: "balance", plan });
    return { ok: true, note: `${label}：目标「${p.name}」（prizeId=${p.prizeId}）${p.price === void 0 ? "" : `，${p.price} 豆`} —— 下一步读基准余额` };
  }
  if (step === "balance") {
    const res = callRawText(
      deps.transport,
      signedReq(deps, { url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/infoV3?client=app`, method: "GET" })
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
    let balance;
    try {
      const env = digResult(res.text);
      const v = env.total ?? env.point ?? env.balance;
      if (typeof v === "number") balance = v;
      else if (typeof v === "string" && /^\d+$/.test(v)) balance = Number(v);
    } catch {
    }
    if (balance !== void 0) deps.store.setState(STATE_BASE, String(balance), deps.nowIso);
    saveState(deps, { ...st, step: "warm-1" });
    return { ok: true, note: `${label}：${balance ?? "没读到"}${balance === void 0 ? "（照样往下走 —— 它只是基准，不是判据）" : "，作为成交复查的基准"} —— 下一步预热` };
  }
  if (step === "warm-1" || step === "warm-2") {
    if (step === "warm-1") {
      const w = planWindowWait(depsNowMs(deps));
      if (w.needed) {
        if (w.ms > MAX_SPIN_MS) {
          return {
            ok: true,
            idle: true,
            note: `${label}：还没到窗口（还差 ${Math.round(w.ms / 1e3)}s）—— 交给下一次触发，本次零请求`
          };
        }
        const waited = spinUntil(w.untilMs, deps);
        deps.store.setState(STATE_LAST_WAIT, String(Math.round(waited)), deps.nowIso);
      }
    }
    if (step === "warm-2") spinUntil(depsNowMs(deps) + PREHEAT_DELAY_MS, deps);
    const keyword = step === "warm-1" ? VISIT_LOG_KEYWORD_EXCHANGE : VISIT_LOG_KEYWORD_EXCHANGE_TIMES;
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/visitlog/journaling?module=uservisit&optkeyword=${encodeURIComponent(keyword)}&sourceid=1002&marketName=${encodeURIComponent(VISIT_LOG_MARKET_NAME)}`,
        method: "POST",
        body: ""
      })
    );
    const warn3 = res.ok ? "" : `（埋点失败但不挡路：${res.error ?? "未知"}）`;
    if (step === "warm-1") {
      saveState(deps, { ...st, step: "warm-2" });
      return { ok: true, note: `${label}：${keyword}${warn3} —— 下一步第二枪（中间那 500ms 由面板的下一次触发承担）` };
    }
    saveState(deps, { ...st, step: "slide" });
    return { ok: true, note: `${label}：${keyword}${warn3} —— 下一步取滑块题面` };
  }
  if (step === "slide") {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/auth-service/slide/getSlide`,
        method: "POST",
        // ⚠ 这一条用 **form** content-type（不是 JSON）—— 逐接口的，不是一刀切
        contentType: SLIDE_FORM_CONTENT_TYPE,
        body: "{}",
        isDeviceId: false
      })
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
    let puzzle;
    let picture;
    try {
      const env = digResult(res.text);
      const pz = env.puzzleImg ?? env.puzzle ?? env.puzzleImage;
      const bg = env.pictureImg ?? env.picture ?? env.backgroundImg;
      if (typeof pz === "string") puzzle = pz;
      if (typeof bg === "string") picture = bg;
    } catch (e) {
      return { ok: false, note: `${label}：题面解析不了（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (!puzzle || !picture) {
      return { ok: false, note: `${label}：题面上没有两张图（回 ${res.text.slice(0, 120)}）` };
    }
    let solution;
    try {
      solution = calcPuzzleOffset(puzzle, picture);
    } catch (e) {
      return done(
        `${label}：图解码失败（${e instanceof Error ? e.message : String(e)}）⇒ 不发下单那一枪（offset 错了那一枪不可能成功，只会白耗一次题面）`,
        false
      );
    }
    if (!usable(solution)) {
      return done(
        `${label}：算不出可用的 offset（解出 ${solution.offsetX}，置信度 ${solution.confidence.toFixed(2)}）⇒ 不发下单那一枪 —— 这一枪发出去是无效的，不是"少一次机会"而是"多一次白打"`,
        false
      );
    }
    saveState(deps, { ...st, step: "order", offset: solution.offsetX });
    return { ok: true, note: `${label}：offset=${solution.offsetX}（置信度 ${solution.confidence.toFixed(2)}）—— 下一步下单` };
  }
  if (step === "order") {
    const f = planFireWait(depsNowMs(deps), exchangeLeadMs(deps.store));
    if (f.needed) {
      if (f.ms > MAX_SPIN_MS) {
        return done(
          `${label}：离整点还有 ${Math.round(f.ms / 1e3)}s —— 这一单的计划过期了（预热与取题该在窗口内做完），不发`,
          false
        );
      }
      const waited = spinUntil(f.untilMs, deps);
      deps.store.setState(STATE_LAST_WAIT, String(Math.round(waited)), deps.nowIso);
    }
    const plan = st.plan;
    if (!plan) return done("内部状态缺计划，这一单作废", false);
    const sess = loadSession(deps.store);
    const deviceId = sess?.deviceId ?? "";
    if (deviceId === "") {
      return done('没有 deviceId（它要现换，见 smid 链）—— 不带它下单会回 615，文案却像"活动太火爆"', false);
    }
    if (st.offset === void 0) return done("内部状态缺 offset，这一单作废（不发一个没算出来的数）", false);
    const body = `{"prizeId":${plan.prizeId},"client":"app","clientVersion":"${EXCHANGE_CLIENT_VERSION}","puzzleOffset":${st.offset},"smsCode":"","deviceId":"${deviceId}"}`;
    const req = signedReq(deps, {
      url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/exchangeV3`,
      method: "POST",
      body,
      isDeviceId: true
      // 这条**要** isdeviceid，而取滑块那条不要
    });
    req.headers.origin = MCLOUD_HOST;
    const res = callRawText(deps.transport, req);
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
    let code;
    try {
      const env = digResult(res.text);
      const c = env.code;
      code = typeof c === "number" ? c : typeof c === "string" && /^-?\d+$/.test(c) ? Number(c) : void 0;
    } catch {
    }
    if (code === CODE_SLIDER_WRONG) {
      const round = (st.round ?? 0) + 1;
      if (round > SLIDER_ROUNDS) {
        return done(`${label}：滑块连续 ${SLIDER_ROUNDS} 轮被判错 ⇒ 停手（上限 SLIDER_ROUNDS 轮）`, false);
      }
      saveState(deps, { ...st, step: "slide", round, offset: void 0 });
      return { ok: true, note: `${label}：514（滑块算错）⇒ 重取一题再来一枪（第 ${round}/${SLIDER_ROUNDS} 轮），**没有重复下单**` };
    }
    deps.store.setState(STATE_ORDERED_HOUR, hourKey(depsNowMs(deps)), deps.nowIso);
    saveState(deps, { ...st, step: "verify" });
    return { ok: true, note: `${label}：上游回 ${JSON.stringify(env0(res.text)).slice(0, 140)} —— 下一步查余额差（**那句话不算数**）` };
  }
  if (step === "verify") {
    const before = deps.store.getState(STATE_BASE);
    const res = callRawText(
      deps.transport,
      signedReq(deps, { url: `${deps.baseUrl ?? MCLOUD_HOST}/ycloud/signin/page/infoV3?client=app`, method: "GET" })
    );
    if (!res.ok) return { ok: false, note: `${label}失败：${res.error ?? "未知失败"}` };
    let after;
    try {
      const env = digResult(res.text);
      const v = env.total ?? env.point ?? env.balance;
      if (typeof v === "number") after = v;
    } catch {
    }
    if (!before || after === void 0) {
      return done(`${label}：拿不到余额差（基准「${before || "缺"}」/ 现在「${after ?? "缺"}」）⇒ 成交与否**不知道**，如实报`, false);
    }
    const delta = Number(before) - after;
    if (delta > 0) return done(`${label}：✅ 成交（余额 ${before} → ${after}，扣了 ${delta} 豆）`);
    return done(`${label}：❌ 没成交（余额 ${before} → ${after}，没扣豆）—— 上游那句话不算数，只有余额差算数`, false);
  }
  return { ok: false, note: `不认识的步骤「${step}」` };
}
function env0(text) {
  const r = digResult(text);
  return Object.keys(r).length > 0 ? r : text.slice(0, 140);
}

// src/entries/shared.ts
import {
  http_fetch,
  log,
  smtp_send,
  warn,
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
      const pick = (q) => {
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
        lateP50: pick(0.5),
        lateP99: pick(0.99),
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

// src/mcloud/tasks/exchangeRun.ts
var BUDGET_MS = 9e4;
var DEADLINE_MS = BUDGET_MS - 1e4;
var PLAN_KEY = "mcloud.exchange.plan";
function runExchange(deps, opts = {}) {
  const started = Date.now();
  const steps = [];
  const add = (name, ok, note, idle = false) => {
    steps.push({ name, ok, note, idle });
  };
  const finish = (ok, note) => {
    if (opts.dryRun) {
      add("干跑", true, "只看了能不能兑，**一枪都没发**（真下单走定时那一场）", true);
    }
    return {
      ok,
      note,
      detail: steps.map((x) => `${x.name}：${x.ok ? "" : "失败 "}${x.note}`),
      steps
    };
  };
  const targetHour = targetHourOf(deps.store);
  const gate = planTargetWait(depsNowMs(deps), targetHour);
  if (!opts.dryRun && gate.needed && gate.ms > MAX_SPIN_MS) {
    add(
      "时间闸",
      true,
      targetHour === null ? `还没到窗口（还差 ${Math.round(gate.ms / 1e3)}s）—— 本次零请求` : `不是 ${targetHour} 点那一场（还差 ${Math.round(gate.ms / 1e3)}s）—— 本次零请求`,
      true
    );
    return finish(true, `还没到抢兑时间（还差 ${Math.round(gate.ms / 1e3)}s），本次零请求`);
  }
  try {
    const l = runExchangeList(deps);
    add("清单", l.ok, l.note);
  } catch (e) {
    add("清单", false, `抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }
  const plan = deps.store.getState(PLAN_KEY) ?? "";
  if (plan === "") {
    add("下单", true, "没有设兑换目标（设置里填「兑换目标」之后才会下单）", true);
    return finish(true, "没有设兑换目标（设置里填「兑换目标」之后才会下单）");
  }
  if (!deps.store.getState("mcloud.exchange.order.step")) {
    const s = startOrder(deps, plan);
    add("起单", s.ok, s.note);
    if (!s.ok) {
      return finish(false, s.note);
    }
  }
  const accounts = loadAccounts(deps.store);
  const multi = accounts.length > 1;
  const snaps = /* @__PURE__ */ new Map();
  const offsets = [];
  let r;
  if (multi) {
    for (const acc of accounts) {
      selectAccount(deps.store, acc.id, deps.nowIso);
      clearOrder(deps);
      startOrder(deps, plan);
      const a = drain(runOrderStep, deps, {
        label: "兑换",
        maxSteps: 8,
        deadlineMs: Math.min(DEADLINE_MS, started + 3e4),
        startedAt: started,
        // 停在 `order` 之前 —— 下单那一枪留给阶段 B（那时才压整点）
        more: () => currentStep(deps.store) !== "order" && currentStep(deps.store) !== null
      });
      snaps.set(acc.id, snapshotOrder(deps.store));
      add(
        `准备 ${maskAuth(loadAuthRaw(deps.store) ?? "")}`,
        a.ok,
        `${a.note}（已推到只差下单）`
      );
    }
  }
  const fireStart = Date.now();
  for (const acc of accounts) {
    if (multi) {
      const snap = snaps.get(acc.id);
      if (snap === void 0) continue;
      selectAccount(deps.store, acc.id, deps.nowIso);
      restoreOrder(deps.store, snap, deps.nowIso);
    }
    const one = drain(runOrderStep, deps, {
      label: "兑换",
      maxSteps: 10,
      deadlineMs: DEADLINE_MS,
      startedAt: started,
      // ⚠ 干跑：停在 `order` **之前** —— 一枪都不发
      ...opts.dryRun ? { more: () => currentStep(deps.store) !== "order" && currentStep(deps.store) !== null } : {}
    });
    if (multi) {
      offsets.push(`${maskAuth(loadAuthRaw(deps.store) ?? "")} +${Date.now() - fireStart}ms`);
      add(
        `下单 ${maskAuth(loadAuthRaw(deps.store) ?? "")}`,
        one.ok,
        `${one.note} · 离第一枪 ${Date.now() - fireStart}ms`
      );
    }
    if (!multi) {
      r = one;
      break;
    }
  }
  r ?? (r = { ok: true, idle: true, steps: 0, note: "没有账号（先登录一个）", notes: [] });
  if (multi) {
    add(
      "整点这一批",
      offsets.length > 0,
      offsets.length > 0 ? `串行发出，各账号离第一枪：${offsets.join("、")}` : "没有账号可发"
    );
  }
  for (const line of r.notes) {
    const i = line.indexOf("：");
    if (i < 0) add("兑换", true, line);
    else add(line.slice(0, i), true, line.slice(i + 1));
  }
  return finish(r.ok, `${r.note}（用时 ${((Date.now() - started) / 1e3).toFixed(1)}s）`);
}

// src/entries/exchange.ts
worker_hint("exclusive");
var store = makeStore();
var transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
register_cron(
  "兑换",
  // # 为什么是 `@every 10s` 而不是"整点前 20 秒起一次"
  //
  // 抢兑要压到**整点前 10ms**，而 cron 的粒度是秒、调度器还有抖动。
  // 所以分工是：**粗粒度等待交给调度器，细粒度交给链自己**。
  //
  //   · `@every 10s` 的每一次触发几乎都是**零请求秒返回**
  //     （离窗口还远 ⇒ 如实返回 idle，见 `MAX_SPIN_MS`）
  //   · 一旦落进"离窗口 30 秒内"，这一趟就自己自旋到 59:40、
  //     预热、取题解滑块、再自旋到整点−10ms 发单
  //
  // 20 秒宽的窗口配 10 秒的节拍 ⇒ 窗口里至少有一次触发，通常两次。
  "@every 10s",
  (p) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    const deps = taskDeps(store, transport, p);
    const thisHour = hourKey(startedMs);
    if (store.getState(STATE_ORDERED_HOUR) === thisHour) {
      return;
    }
    const r = runExchange(deps);
    appendRun(store, {
      task: "exchange",
      at,
      ms: Date.now() - startedMs,
      ok: r.ok,
      note: r.note,
      steps: r.steps
    });
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.note
    });
    if (r.ok) log2(`兑换：${r.note}`);
    else warn2(`兑换：${r.note}`);
    for (const line of r.detail) {
      if (line.includes("失败")) warn2(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS }
);
log2(`mcloud-exchange：任务「兑换」（预算 ${BUDGET_MS / 1e3}s，独占线程）—— 每 10 秒看一眼，窗口内自己压到整点`);
