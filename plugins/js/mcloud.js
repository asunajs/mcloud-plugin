// 由 src/**/*.ts 打包生成 —— **不要手改这个文件**。
//
//   改代码：编辑 src/，然后 `npm run build`
//   只在构建产物上改动的东西，下一次构建就没了
//   mcloud-plugin 0.0.0

// src/main.ts
import { error, every, http_fetch, log, register_cron, register_route, warn } from "host-api";

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
var SLOW_CALL_MS = 1500;
function callOnce(transport2, req) {
  const t0 = Date.now();
  const fail = (error3) => ({
    status: 0,
    tookMs: Date.now() - t0,
    env: void 0,
    ok: false,
    error: error3,
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
  let error2;
  if (res.status !== 200) {
    error2 = `HTTP ${res.status}`;
  } else {
    try {
      env = parseSignInEnvelope(res.body);
      if (!env.ok) error2 = `code=${env.code}${env.message ? ` msg=${env.message}` : ""}`;
    } catch (e) {
      error2 = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    status: res.status,
    tookMs,
    env,
    ok: res.status === 200 && !!env?.ok,
    error: error2,
    raw,
    setCookies: extractSetCookies(res.headers)
  };
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
  backupGiftInfo: { origin: BACKUP_GIFT_HOST, path: "/market/backupgift/info" },
  backupGiftReceive: { origin: BACKUP_GIFT_HOST, path: "/market/backupgift/receive" }
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
  backupGiftInfo: "GET",
  // 另一个域
  backupGiftReceive: "GET"
  // 另一个域
};
var CLIENT_QUERY = "client=app";
function taskListV3Body(market = MARKET_NAME) {
  return JSON.stringify({ marketname: market, clientVersion: TASK_CLIENT_VERSION, group: "" });
}
var TASK_LIST_V3_CONTENT_TYPE = "application/json;charset=UTF-8";

// src/store/types.ts
var SESSION_KEY = "mcloud.session";
function loadSession(store2) {
  const raw = store2.getState(SESSION_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v.cookie !== "string" || v.cookie === "") return null;
    return {
      cookie: v.cookie,
      jwt: typeof v.jwt === "string" ? v.jwt : void 0,
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

// src/mcloud/tasks/taskList.ts
var TASK_NAMES = [
  "selftest",
  "diag",
  "session-check",
  "task-list",
  "sign",
  "receive",
  "multiple",
  "revival",
  "backup-gift",
  "prizes",
  "cloud-snapshot"
];
var STATE_LAST_TASKLIST = "mcloud.tasklist.last";
function isFinished(t) {
  if (typeof t !== "object" || t === null) return false;
  const state = t.state;
  return typeof state === "string" && state.toUpperCase() === "FINISH";
}
function runTaskList(deps) {
  return runTask(
    deps,
    {
      task: "task-list",
      endpoint: "taskListV3",
      method: "POST",
      body: taskListV3Body(),
      contentType: TASK_LIST_V3_CONTENT_TYPE,
      isDeviceId: false,
      stateKey: STATE_LAST_TASKLIST
    },
    (env) => {
      const list = resultArray(env);
      const done = list.filter(isFinished).length;
      return {
        ok: true,
        note: `清单 ${list.length} 条，已完成 ${done} 条`,
        snapshot: { total: list.length, done, items: list }
      };
    }
  );
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

// src/mcloud/tasks/info.ts
var bool = (v, dflt = false) => typeof v === "boolean" ? v : dflt;
function parseInfoV3(result) {
  const o = resultObject({ code: 0, message: "", result, ok: true });
  const pick = (...keys) => {
    for (const k of keys) if (o[k] !== void 0) return o[k];
    return void 0;
  };
  const listRaw = pick("receiveList", "receive_list");
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
    todaySigned: bool(pick("todaySignIn", "today_sign_in")),
    receiveList,
    curMonthBackup: bool(pick("curMonthBackup", "cur_month_backup")),
    curMonthBackupSignAccept: bool(pick("curMonthBackupSignAccept", "cur_month_backup_sign_accept")),
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
      stateKey: STATE_RECEIVE
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

// src/mcloud/session.ts
function parseSessionInput(raw, nowIso) {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "内容是空的" };
  if (!text.startsWith("{")) {
    if (!text.includes("=")) return { ok: false, reason: "既不是 JSON，也不像 cookie 串" };
    return { ok: true, session: { cookie: normalizeCookie(text), savedAt: nowIso } };
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, reason: "JSON 顶层要是对象" };
  }
  const o = v;
  const inner = typeof o.session === "string" ? (() => {
    try {
      return JSON.parse(o.session);
    } catch {
      return o.session;
    }
  })() : o.session ?? o;
  if (typeof inner === "string") return parseSessionInput(inner, nowIso);
  if (typeof inner !== "object" || inner === null) {
    return { ok: false, reason: "session 字段既不是对象也不是字符串" };
  }
  const s = inner;
  const pick = (k) => {
    const x = s[k];
    if (typeof x !== "string" || x.trim() === "") return void 0;
    return x.trim();
  };
  let cookie = pick("cookie") ?? pick("cookies") ?? "";
  if (!cookie && Array.isArray(s.cookies)) {
    cookie = s.cookies.filter((c) => typeof c === "string").map((c) => c.trim()).filter((c) => c.includes("=")).join("; ");
  }
  if (!cookie && Array.isArray(s.cookie)) {
    cookie = s.cookie.filter((c) => typeof c === "string").join("; ");
  }
  if (!cookie) {
    return { ok: false, reason: "没有 cookie —— 云盘账号的凭据就在 cookie 和 jwt 里，这两样至少要有 cookie" };
  }
  return {
    ok: true,
    session: {
      cookie: normalizeCookie(cookie),
      jwt: pick("jwt") ?? pick("jwttoken") ?? pick("JWT_TOKEN"),
      deviceId: pick("deviceId") ?? pick("deviceid"),
      userAgent: pick("userAgent") ?? pick("user-agent"),
      savedAt: nowIso
    }
  };
}
function normalizeCookie(raw) {
  const parts = [];
  for (const seg of raw.split(";")) {
    const p = seg.trim();
    if (!p || !p.includes("=")) continue;
    const name = p.slice(0, p.indexOf("=")).trim();
    if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) continue;
    parts.push(p);
  }
  return parts.join("; ");
}
function redact(secret) {
  if (!secret) return "（无）";
  if (secret.length <= 8) return `（${secret.length} 字符，太短不显示）`;
  return `${secret.slice(0, 4)}…（共 ${secret.length} 字符）`;
}
var STATE_LAST_CHECK = "mcloud.session.last_check";
function sessionStatus(store2, nowIso) {
  const s = loadSession(store2);
  const checkRaw = store2.getState(STATE_LAST_CHECK);
  let lastCheck = "";
  let lastCheckOk = null;
  let lastCheckNote = "";
  if (checkRaw) {
    try {
      const c = JSON.parse(checkRaw);
      lastCheck = c.at ?? "";
      lastCheckOk = typeof c.ok === "boolean" ? c.ok : null;
      lastCheckNote = c.note ?? "";
    } catch {
      lastCheckNote = "（检查记录坏了）";
    }
  }
  let ageHours = null;
  if (s?.savedAt) {
    const t = Date.parse(s.savedAt);
    const n = Date.parse(nowIso);
    if (!Number.isNaN(t) && !Number.isNaN(n)) {
      ageHours = Math.round((n - t) / 36e5 * 10) / 10;
    }
  }
  return {
    present: !!s,
    savedAt: s?.savedAt ?? "",
    ageHours,
    cookie: redact(s?.cookie),
    jwt: redact(s?.jwt),
    deviceId: s?.deviceId ?? "",
    userAgent: s?.userAgent ?? "",
    lastCheck,
    lastCheckOk,
    lastCheckNote
  };
}
function verifySession(deps) {
  const s = loadSession(deps.store);
  if (!s) {
    const note2 = "没有会话";
    deps.store.setState(STATE_LAST_CHECK, JSON.stringify({ at: deps.nowIso, ok: false, note: note2 }), deps.nowIso);
    return { ok: false, note: note2 };
  }
  const req = buildH5Request({
    url: `${resolveUrl("infoV3", deps.baseUrl)}?${CLIENT_QUERY}`,
    method: EP_METHOD.infoV3 === "GET" ? "GET" : "POST",
    referer: REFERER_SIGN_IN,
    showLoading: SHOW_LOADING,
    isDeviceId: !!s.deviceId,
    saltKey: 1,
    session: sessionHeaders(s)
  });
  const res = callOnce(deps.transport, req);
  const ok = res.ok;
  const note = ok ? `会话有效（${res.tookMs}ms）` : `会话可能已失效：${res.error ?? "未知失败"}`;
  deps.store.setState(
    STATE_LAST_CHECK,
    JSON.stringify({ at: deps.nowIso, ok, note }),
    deps.nowIso
  );
  return { ok, note };
}
function importSession(store2, s, nowIso) {
  saveSession(store2, s, nowIso);
  store2.setState(
    STATE_LAST_CHECK,
    JSON.stringify({ at: nowIso, ok: null, note: "刚导入，还没验" }),
    nowIso
  );
}
var STATE_BASE_URL = "mcloud.base_url";
function loadBaseUrl(store2) {
  const v = store2.getState(STATE_BASE_URL);
  if (!v) return "";
  const t = v.trim();
  if (!/^https?:\/\//.test(t)) return "";
  return t.replace(/\/+$/, "");
}

// src/mcloud/routes.ts
var PLUGIN = "mcloud";
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
var json = (status, obj) => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(obj)
});
function readBody(req) {
  const raw = (req.body ?? "").trim();
  if (raw === "") return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return { session: raw };
  }
}
function mcloudRoutes(deps) {
  const base = `/plugins/${PLUGIN}/api`;
  const verify = () => verifySession({
    store: deps.store,
    transport: deps.transport,
    nowIso: deps.now(),
    baseUrl: loadBaseUrl(deps.store)
  });
  return [
    {
      path: `${base}/session`,
      method: "GET",
      handler: () => json(200, sessionStatus(deps.store, deps.now()))
    },
    {
      path: `${base}/session`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          deps.store.setState("mcloud.session", "", deps.now());
          deps.log("会话已清空");
          return json(200, { cleared: true, status: sessionStatus(deps.store, deps.now()) });
        }
        const raw = typeof body.session === "string" ? body.session : "";
        if (!raw) {
          return json(400, { error: '需要 {"session": "<cookie 串或 JSON>"} 或 {"clear": true}' });
        }
        const parsed = parseSessionInput(raw, deps.now());
        if (!parsed.ok) return json(400, { error: parsed.reason });
        importSession(deps.store, parsed.session, deps.now());
        const check = verify();
        const st = sessionStatus(deps.store, deps.now());
        deps.log(`导入会话：${check.note}（cookie ${st.cookie}）`);
        return json(200, { imported: true, verified: check.ok, note: check.note, status: st });
      }
    },
    {
      path: `${base}/session/verify`,
      method: "POST",
      handler: () => {
        const check = verify();
        return json(200, {
          verified: check.ok,
          note: check.note,
          status: sessionStatus(deps.store, deps.now())
        });
      }
    },
    {
      // 上游基址：CI 指向 mock 用；生产留空 = 用真地址
      path: `${base}/config`,
      method: "GET",
      handler: () => json(200, { baseUrl: loadBaseUrl(deps.store) || "(真上游)" })
    },
    {
      path: `${base}/config`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        const v = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
        if (v && !/^https?:\/\//.test(v)) {
          return json(400, { error: "baseUrl 要以 http:// 或 https:// 开头（清空就传空串）" });
        }
        deps.store.setState(STATE_BASE_URL, v.replace(/\/+$/, ""), deps.now());
        deps.log(v ? `上游基址已改为 ${v}` : "上游基址已恢复为真上游");
        return json(200, { baseUrl: v || "(真上游)" });
      }
    },
    {
      path: `${base}/tasks`,
      method: "GET",
      handler: () => {
        let last = null;
        const raw = deps.store.getState(STATE_LAST_TASKLIST);
        try {
          last = raw ? JSON.parse(raw) : null;
        } catch {
          last = { broken: true };
        }
        const lastErrorByTask = {};
        for (const t of TASK_NAMES) {
          const v = deps.store.getState(`mcloud.last_error.${t}`);
          if (v) lastErrorByTask[t] = v;
        }
        return json(200, {
          lastTaskList: last,
          lastErrorByTask,
          recent: deps.store.recentRuns(20)
        });
      }
    }
  ];
}

// src/main.ts
var store = hostStore();
store.ensureSchema();
var REQUEST_TIMEOUT_MS = 1500;
var transport = (req) => (
  // 返回值可能是 {status,headers,body}，也可能是失败形状 {"error":…} ——
  // client.ts 的 callOnce 负责认形状（实测踩过，见 docs/findings.md F-006）
  http_fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    timeout_ms: REQUEST_TIMEOUT_MS
  })
);
function selftest() {
  const checks = [];
  checks.push(['md5("abc")', md5Hex("abc") === "900150983cd24fb0d6963f7d28e17f72"]);
  checks.push([
    'sha256("abc")',
    sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  ]);
  const cn = "签到·AI豆🎉";
  checks.push(["utf8 往返（含 emoji）", fromUtf8(utf8(cn)) === cn]);
  const raw = utf8("mcloud-plugin");
  checks.push(["base64 往返", fromUtf8(fromBase64(toBase64(raw))) === "mcloud-plugin"]);
  const id = store.recordRun({
    task: "__selftest__",
    runs: 0,
    scheduledAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    firedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    lateMs: 0,
    ok: true,
    note: "selftest"
  });
  checks.push(["sqlite 自增主键返回", id > 0]);
  const stats = store.lateStats("__selftest__", 10);
  checks.push(["sqlite 聚合查询可用", stats.n >= 1]);
  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join("、")}`
  };
}
for (const r of mcloudRoutes({
  store,
  transport,
  now: () => (/* @__PURE__ */ new Date()).toISOString(),
  log,
  baseUrl: void 0
  // 路由内部按需读 state（改了配置立刻生效）
})) {
  register_route(r.path, r.method, r.handler);
}
register_cron("session-check", "50 7 * * *", (p) => {
  const check = verifySession({
    store,
    transport,
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    baseUrl: loadBaseUrl(store)
  });
  store.recordRun({
    task: p.name,
    runs: p.runs,
    scheduledAt: p.scheduledAt,
    firedAt: p.firedAt,
    lateMs: p.lateMs,
    ok: check.ok,
    note: check.note
  });
  if (check.ok) log(`会话体检：${check.note}`);
  else warn(`会话体检：${check.note} —— 需要用 POST /plugins/mcloud/api/session 重新导入`);
});
register_cron("task-list", "0 8 * * *", (p) => {
  const t0 = Date.now();
  try {
    const out = runTaskList({
      store,
      transport,
      nowIso: (/* @__PURE__ */ new Date()).toISOString(),
      // 每次调用都重新读：改了基址不用重载插件（CI 与手工联调都靠这条）
      baseUrl: loadBaseUrl(store)
    });
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: out.ok,
      note: out.note
    });
    if (out.ok) log(`任务清单：${out.note}`);
    else warn(`任务清单失败：${out.note}`);
    const took = Date.now() - t0;
    if (took > SLOW_CALL_MS) warn(`这次调用用了 ${took}ms —— 接近执行预算，注意上游是否变慢`);
  } catch (e) {
    error(`任务清单抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
  }
});
function makeRunner(name, run) {
  return (p) => {
    try {
      const out = run({
        store,
        transport,
        nowIso: (/* @__PURE__ */ new Date()).toISOString(),
        baseUrl: loadBaseUrl(store),
        lateMs: p.lateMs
      });
      store.recordRun({
        task: p.name,
        runs: p.runs,
        scheduledAt: p.scheduledAt,
        firedAt: p.firedAt,
        lateMs: p.lateMs,
        ok: out.ok,
        note: out.note
      });
      if (out.ok) log(`${name}：${out.note}`);
      else warn(`${name} 失败：${out.note}`);
    } catch (e) {
      error(`${name} 抛异常（这是插件 bug）：${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
var SIGNIN_CRON = "*/15 7-22 * * *";
register_cron("sign", SIGNIN_CRON, makeRunner("签到", runSign));
register_cron("receive", SIGNIN_CRON, makeRunner("领取AI豆", runReceive));
register_cron("multiple", SIGNIN_CRON, makeRunner("签到翻倍", runMultiple));
register_cron("revival", SIGNIN_CRON, makeRunner("复活卡", runRevival));
register_cron("backup-gift", SIGNIN_CRON, makeRunner("备份好礼", runBackupGift));
register_cron("prizes", "20 8 * * *", makeRunner("待领取奖品", runPrizes));
register_cron("cloud-snapshot", "30 8 * * *", makeRunner("AI豆快照", runCloudSnapshot));
every("selftest", "5m", (p) => {
  try {
    const r = selftest();
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: r.ok,
      note: r.detail
    });
    if (r.ok) {
      log(`自检通过（${r.detail}）· lateMs=${Math.round(p.lateMs)}`);
    } else {
      error(`自检失败（${r.detail}）—— 沙箱环境与预期不符，先别接上游任务`);
    }
  } catch (e) {
    error(`自检抛异常：${e instanceof Error ? e.message : String(e)}`);
  }
});
every("diag", "30s", (p) => {
  try {
    store.recordRun({
      task: p.name,
      runs: p.runs,
      scheduledAt: p.scheduledAt,
      firedAt: p.firedAt,
      lateMs: p.lateMs,
      ok: true
    });
    if (p.runs % 10 === 0) {
      const s = store.lateStats(p.name, 500);
      log(
        `调度健康：n=${s.n} p50=${s.lateP50}ms p99=${s.lateP99}ms max=${s.lateMax}ms` + (s.excluded > 0 ? ` · 排除负延迟 ${s.excluded} 条（手动触发，见 F-001）` : "") + (s.lateP99 > 200 ? " ⚠️ p99 偏高，同轮可能有慢任务" : "")
      );
    }
  } catch (e) {
    warn(`diag 记录失败：${e instanceof Error ? e.message : String(e)}`);
  }
});
store.setState("plugin.loaded_at", (/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString());
log("mcloud 插件已加载（自检 + 调度健康 + 任务清单；其余签到族任务在 M2 逐个接）");
export {
  selftest
};
