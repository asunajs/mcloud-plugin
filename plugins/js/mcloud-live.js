// 由 src/entries/live.ts 打包生成 —— **不要手改这个文件**。
//
//   改代码：编辑 src/，然后 `npm run build`
//   只在构建产物上改动的东西，下一次构建就没了
//   mcloud-plugin 0.0.0 · 插件 `mcloud-live`

// src/entries/live.ts
import { log as log2, register_cron, warn as warn2, worker_hint } from "host-api";

// src/mcloud/runLog.ts
var RUN_LOG_KEY = "mcloud.run.log";
var RUNS_PER_TASK = 20;
var MAX_STEPS = 40;
var MAX_NOTE = 300;
function clip(s, max = MAX_NOTE) {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
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
function fromHex(h) {
  const clean = h.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

// src/mcloud/koulingPool.ts
var CYCLE_TTL_MS = 5 * 60 * 60 * 1e3;
var GATE_CLOSE_GRACE_MS = 10 * 60 * 1e3;
var VALID_ENOUGH = 2;
var MAX_SESSIONS = 12;
var SCRAPE_MIN_INTERVAL_MS = 180 * 1e3;
var XHS_MIN_INTERVAL_MS = 30 * 60 * 1e3;
var MAX_POOL_CODES = 200;
var KOULING_ANCHOR = "中国移动云盘";
var POOL_KEY = "mcloud.kouling.pool";
function emptyPool() {
  return {
    cycleAtMs: 0,
    codes: [],
    claims: {},
    lastLiveAtMs: null,
    gateClosedAtMs: null,
    lastXhsAtMs: null,
    lastScrapeAtMs: null,
    schedule: [],
    scheduleAtMs: null,
    scheduleAnchor: null,
    sessions: []
  };
}
function startCycle(pool, nowMs) {
  pool.cycleAtMs = nowMs;
  pool.codes = [];
  pool.claims = {};
  pool.lastLiveAtMs = null;
  pool.gateClosedAtMs = null;
}
function isStale(pool, nowMs) {
  if (pool.cycleAtMs === 0) {
    return false;
  }
  if (nowMs - pool.cycleAtMs > CYCLE_TTL_MS) return true;
  return pool.gateClosedAtMs !== null && nowMs - pool.gateClosedAtMs > GATE_CLOSE_GRACE_MS;
}
function closeOpenSession(pool) {
  const open = pool.sessions[pool.sessions.length - 1];
  if (open && open.endedAtMs === void 0) {
    open.endedAtMs = pool.lastLiveAtMs ?? pool.cycleAtMs;
  }
}
function normalize(pool, nowMs) {
  if (isStale(pool, nowMs)) {
    closeOpenSession(pool);
    startCycle(pool, nowMs);
  }
  if (pool.cycleAtMs === 0) pool.cycleAtMs = nowMs;
}
function noteProbe(pool, rooms, active, nowMs) {
  pool.schedule = rooms.slice();
  pool.scheduleAtMs = nowMs;
  noteGate(pool, active, nowMs);
  if (active) {
    const last = pool.sessions[pool.sessions.length - 1];
    const open = last !== void 0 && last.endedAtMs === void 0;
    if (!open) {
      pool.sessions.push({ startedAtMs: nowMs });
      while (pool.sessions.length > MAX_SESSIONS) pool.sessions.shift();
    }
  }
}
function noteGate(pool, live, nowMs) {
  if (live) {
    pool.lastLiveAtMs = nowMs;
    pool.gateClosedAtMs = null;
  } else if (pool.gateClosedAtMs === null) {
    pool.gateClosedAtMs = nowMs;
  }
}
function note(pool, values, source, nowMs) {
  normalize(pool, nowMs);
  let added = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    const existing = pool.codes.find((c) => c.value === value);
    if (existing !== void 0) continue;
    if (pool.codes.length >= MAX_POOL_CODES) break;
    pool.codes.push({
      value,
      state: "unknown",
      source,
      firstSeenMs: nowMs
    });
    added += 1;
  }
  return added;
}
function noteClaim(pool, account, code, verdict, nowMs) {
  normalize(pool, nowMs);
  const value = code.trim();
  if (value === "") return;
  const mine = pool.claims[account] ?? {};
  mine[value] = verdict;
  pool.claims[account] = mine;
  let state;
  let reason;
  switch (verdict) {
    case "claimed":
      state = "valid";
      reason = "已验证有效";
      break;
    case "alreadyClaimed":
      state = "valid";
      reason = "已验证有效（这个账号已领过）";
      break;
    case "invalid":
      state = "invalid";
      reason = "口令无效";
      break;
    case "expired":
      state = "invalid";
      reason = "口令已过期";
      break;
    case "other":
      break;
  }
  if (state === void 0) return;
  const slot = pool.codes.find((c) => c.value === value);
  if (slot !== void 0) {
    const downgrade = slot.state === "valid" && state === "invalid";
    if (!downgrade) slot.state = state;
    slot.reason = reason;
    if (state === "valid" && slot.validAtMs === void 0) slot.validAtMs = nowMs;
    return;
  }
  if (pool.codes.length >= MAX_POOL_CODES) return;
  pool.codes.push({
    value,
    state,
    source: "manual",
    reason,
    firstSeenMs: nowMs,
    ...state === "valid" ? { validAtMs: nowMs } : {}
  });
}
function validCount(pool) {
  return pool.codes.filter((c) => c.state === "valid").length;
}
function stopScraping(pool) {
  return validCount(pool) >= VALID_ENOUGH;
}
function accountClaimed(pool, account, code) {
  const mine = pool.claims[account];
  return mine !== void 0 && Object.prototype.hasOwnProperty.call(mine, code.trim());
}
function codeState(pool, code) {
  return pool.codes.find((c) => c.value === code.trim())?.state;
}
function pickFor(pool, account) {
  const mine = pool.claims[account];
  return pool.codes.filter((c) => c.state !== "invalid").filter((c) => mine === void 0 || !Object.prototype.hasOwnProperty.call(mine, c.value)).map((c) => c.value);
}
function xhsReady(pool, nowMs) {
  return pool.lastXhsAtMs === null || nowMs - pool.lastXhsAtMs >= XHS_MIN_INTERVAL_MS;
}
function noteXhs(pool, nowMs) {
  pool.lastXhsAtMs = nowMs;
}
function xhsWaitMs(pool, nowMs) {
  if (pool.lastXhsAtMs === null) return 0;
  return Math.max(0, XHS_MIN_INTERVAL_MS - (nowMs - pool.lastXhsAtMs));
}
function accountKey(phone) {
  const p = phone.trim();
  if (p === "") return "default";
  return toHex(sha256(utf8(`mcloud.kouling.account:${p}`))).slice(0, 16);
}
function parsePool(raw) {
  if (!raw) return { pool: emptyPool(), reset: false };
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { pool: emptyPool(), reset: true };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return { pool: emptyPool(), reset: true };
  }
  const o = v;
  const pool = emptyPool();
  pool.cycleAtMs = num(o["cycleAtMs"]) ?? 0;
  pool.codes = codeList(o["codes"]);
  pool.claims = claimsOf(o["claims"]);
  pool.lastLiveAtMs = num(o["lastLiveAtMs"]) ?? null;
  pool.gateClosedAtMs = num(o["gateClosedAtMs"]) ?? null;
  pool.lastXhsAtMs = num(o["lastXhsAtMs"]) ?? null;
  pool.lastScrapeAtMs = num(o["lastScrapeAtMs"]) ?? null;
  pool.schedule = roomsOf(o["schedule"]);
  pool.scheduleAtMs = num(o["scheduleAtMs"]) ?? null;
  pool.scheduleAnchor = typeof o["scheduleAnchor"] === "string" ? o["scheduleAnchor"] : null;
  pool.sessions = sessionsOf(o["sessions"]);
  return { pool, reset: false };
}
function serializePool(pool) {
  return JSON.stringify(pool);
}
function loadPoolFrom(store2) {
  return parsePool(store2.getState(POOL_KEY));
}
function savePoolTo(store2, pool, nowIso) {
  store2.setState(POOL_KEY, serializePool(pool), nowIso);
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : void 0;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function codeList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item;
    const value = str(o["value"]);
    if (value === "") continue;
    const state = o["state"];
    const code = {
      value,
      // 认不出的状态按 **unknown**（不是 valid）：保守方向是"还要再验一次"，
      // 而"当成有效"会让 stopScraping 提前为真。
      state: state === "valid" || state === "invalid" ? state : "unknown",
      source: sourceOf(o["source"]),
      firstSeenMs: num(o["firstSeenMs"]) ?? 0
    };
    const reason = str(o["reason"]);
    if (reason !== "") code.reason = reason;
    const validAt = num(o["validAtMs"]);
    if (validAt !== void 0) code.validAtMs = validAt;
    out.push(code);
  }
  return out;
}
function sourceOf(v) {
  return v === "danmaku" || v === "xiaohongshu" || v === "manual" || v === "auto" ? v : "auto";
}
function verdictOf(v) {
  return v === "claimed" || v === "alreadyClaimed" || v === "invalid" || v === "expired" || v === "other" ? v : void 0;
}
function claimsOf(v) {
  const out = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [account, codes] of Object.entries(v)) {
    if (codes === null || typeof codes !== "object" || Array.isArray(codes)) continue;
    const mine = {};
    for (const [code, verdict] of Object.entries(codes)) {
      const v2 = verdictOf(verdict);
      if (v2 !== void 0) mine[code] = v2;
    }
    out[account] = mine;
  }
  return out;
}
function roomsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item;
    out.push({
      roomId: num(o["roomId"]) ?? 0,
      title: str(o["title"]),
      status: num(o["status"]) ?? 0,
      expectStartTime: str(o["expectStartTime"]),
      anchorNickname: str(o["anchorNickname"])
    });
  }
  return out;
}
function sessionsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item;
    const started = num(o["startedAtMs"]);
    if (started === void 0) continue;
    const s = { startedAtMs: started };
    const ended = num(o["endedAtMs"]);
    if (ended !== void 0) s.endedAtMs = ended;
    out.push(s);
  }
  return out;
}
function poolSummary(pool, nowLocal, nowMs) {
  const next = nextRoomAt(pool.schedule, nowLocal);
  const s = {
    cycleAtMs: pool.cycleAtMs,
    validCount: validCount(pool),
    stopScraping: stopScraping(pool),
    codes: pool.codes.slice(),
    scheduleAtMs: pool.scheduleAtMs,
    sessions: pool.sessions.slice().reverse(),
    xhsWaitMs: xhsWaitMs(pool, nowMs)
  };
  if (next !== void 0) {
    s.nextStart = next.expectStartTime;
    if (next.title !== "") s.nextTitle = next.title;
    if (next.anchorNickname !== "") s.nextAnchor = next.anchorNickname;
  }
  return s;
}
function nextRoomAt(rooms, nowLocal) {
  return earliestPreviewIn(rooms, true, nowLocal);
}
function earliestPreviewIn(rooms, onlyTarget, notBefore) {
  let best;
  for (const r of rooms) {
    if (r.status !== 0) continue;
    if (r.expectStartTime === "") continue;
    if (onlyTarget && r.anchorNickname !== KOULING_ANCHOR) continue;
    if (notBefore !== void 0 && r.expectStartTime < notBefore) continue;
    if (best === void 0 || r.expectStartTime < best.expectStartTime) best = r;
  }
  return best;
}

// src/mcloud/liveAuto.ts
var ONE_HOUR_MS = 60 * 60 * 1e3;
var DAY_MS = 24 * ONE_HOUR_MS;
var BEIJING_OFFSET_MS = 8 * ONE_HOUR_MS;
function parseLocalMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (m === null) return void 0;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return void 0;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
  if (formatLocalMs(ms) !== `${y}-${mo}-${d} ${h}:${mi}:${String(second).padStart(2, "0")}`) {
    return void 0;
  }
  return ms;
}
function formatLocalMs(ms) {
  const t = new Date(ms + BEIJING_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
function earliestPlusOneHour(nexts, nowMs) {
  const candidates = nexts.map((s) => s.trim()).filter((s) => s !== "");
  if (candidates.length === 0) return void 0;
  const earliest = candidates.reduce((a, b) => a <= b ? a : b);
  const ms = parseLocalMs(earliest);
  if (ms === void 0) return void 0;
  void nowMs;
  return formatLocalMs(ms + ONE_HOUR_MS);
}
function oneShotExpr(local) {
  const ms = parseLocalMs(local);
  if (ms === void 0) return void 0;
  const t = new Date(ms + BEIJING_OFFSET_MS);
  return `${t.getUTCSeconds()} ${t.getUTCMinutes()} ${t.getUTCHours()} ${t.getUTCDate()} ${t.getUTCMonth() + 1} *`;
}
function planDue(plan, nowMs) {
  return plan !== null && nowMs >= plan.wakeAtMs;
}
function planInWindow(plan, nowMs) {
  return plan !== null && nowMs >= plan.wakeAtMs && nowMs < plan.wakeAtMs + plan.windowMs;
}

// src/mcloud/tasks/liveAutoTask.ts
var STATE_WAKE_PLAN = "mcloud.live.wake_plan";
var SCHEDULE_TRUST_MS = 6 * ONE_HOUR_MS;
function loadWakePlan(store2) {
  const raw = store2.getState(STATE_WAKE_PLAN);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v?.wakeAtMs === "number" && typeof v?.wakeAt === "string" ? v : null;
  } catch {
    return null;
  }
}
function saveWakePlan(store2, plan, nowIso) {
  store2.setState(STATE_WAKE_PLAN, plan === null ? "" : JSON.stringify(plan), nowIso);
}
function planTrusted(scheduleAtMs, nowMs) {
  return scheduleAtMs !== null && nowMs - scheduleAtMs <= SCHEDULE_TRUST_MS;
}
function refreshWakePlan(deps, opts) {
  const nowMs = Date.parse(deps.nowIso);
  const { pool } = loadPoolFrom(deps.store);
  const summary = poolSummary(pool, formatLocalMs(nowMs), nowMs);
  const trusted = planTrusted(summary.scheduleAtMs, nowMs);
  const fromStart = summary.nextStart ?? "";
  const wakeAt = trusted && fromStart !== "" ? earliestPlusOneHour([fromStart], nowMs) : void 0;
  if (wakeAt === void 0) {
    saveWakePlan(deps.store, null, deps.nowIso);
    return {
      plan: null,
      why: fromStart === "" ? "池里没有「下一场」⇒ 不排定时（等门下次探到日程再说）" : "池里那份日程太旧（超过 6 小时）⇒ 不按它睡，退回默认重查"
    };
  }
  const plan = {
    wakeAt,
    wakeAtMs: Date.parse(`${wakeAt.replace(" ", "T")}+08:00`),
    fromStart,
    computedAt: formatLocalMs(nowMs),
    expr: oneShotExpr(wakeAt),
    windowMs: opts.windowMs
  };
  saveWakePlan(deps.store, plan, deps.nowIso);
  return { plan, why: `按「${fromStart}」+1 小时 ⇒ ${wakeAt}` };
}
function runLiveAuto(deps, opts) {
  const nowMs = Date.parse(deps.nowIso);
  const before = loadWakePlan(deps.store);
  const { plan, why } = refreshWakePlan(deps, opts);
  const changed = before?.wakeAt !== plan?.wakeAt;
  const due = planDue(plan, nowMs);
  return {
    ok: true,
    note: plan === null ? `不排定时（${why}）` : `${changed ? "排定" : "仍是"} ${plan.wakeAt} 醒（= ${plan.fromStart} +1h；等价 cron ${plan.expr ?? "?"}）${due ? " —— 已到点" : ""}`
  };
}
function wakeSleepMs(store2, nowMs, windowMs) {
  const plan = loadWakePlan(store2);
  if (plan === null) return void 0;
  if (!planInWindow(plan, nowMs) && planDue(plan, nowMs)) {
    return void 0;
  }
  if (planDue(plan, nowMs)) return void 0;
  void windowMs;
  return plan.wakeAtMs - nowMs;
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

// src/mcloud/h5.ts
var MCLOUD_HOST = "https://m.mcloud.139.com";
var REFERER_SIGN_IN = `${MCLOUD_HOST}/mcloud/sign_in/index.html`;
function rootOrDefault(base, fallback) {
  const t = (base ?? "").trim();
  return t === "" ? fallback : t.replace(/\/+$/, "");
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
function currentAccount(store2) {
  const id = (store2.getState(STATE_CURRENT_ACCOUNT) ?? "").trim();
  if (id === "") return void 0;
  return loadAccounts(store2).find((a) => a.id === id);
}

// src/store/types.ts
var SESSION_KEY = "mcloud.session";
function accountScopedKey(store2, base) {
  const cur = currentAccount(store2);
  return cur === void 0 ? base : `${base}.${cur.id}`;
}
function sessionKey(store2) {
  return accountScopedKey(store2, SESSION_KEY);
}
function loadSession(store2) {
  const raw = store2.getState(sessionKey(store2));
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

// src/mcloud/tasks/base.ts
var ERR_PREFIX = "mcloud.last_error.";
function recordError(store2, task, note2, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, `${note2} @ ${nowIso}`, nowIso);
}
function clearError(store2, task, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, "", nowIso);
}

// src/mcloud/liveFlower.ts
var LIVE_ROOM_ORIGIN = "https://m.mcloud.139.com";
var USER_INFO_PATH = "/ycloud/liveRoomFeedback/user/info";
var JOURNALING_PATH = "/ycloud/visitlog/journaling";
var FIRST_PARTICIPATE_GIVE_PATH = "/ycloud/liveRoomFeedback/firstParticipate/give";
var DRAW_PATH = "/ycloud/liveRoomFeedback/redFlower/draw";
var QUERY_REVIVAL_FLOWERS_PATH = "/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers";
var LIVE_ROOM_MARKET_NAME = "National_LiveRoomFeedback";
var LIVE_ROOM_JOURNALING_SOURCE_ID = "1007";
var LIVE_ROOM_ACTIVITY_ID = "sign_in_3";
var LIVE_ROOM_APP_VERSION = "12.6.0.0";
var TO_SOURCE_ID = "001005";
var LIVE_ROOM_USER_AGENT = "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/12.6.0 iPad AppLanguage/zh-CN";
var CODE_KOULING_INVALID = 200108;
var CODE_KOULING_ALREADY_DRAWN = 200112;
var CODE_KOULING_EXPIRED = 200118;
var JOURNALING_EVENTS = [
  "National_LiveRoomFeedback_pv",
  "National_LiveRoomFeedback_client",
  "National_LiveRoomFeedback_client_isApp",
  "National_LiveRoomFeedback_login",
  "National_LiveRoomFeedback_flowerBtn"
];
function liveRoomPageReferer() {
  return `${LIVE_ROOM_ORIGIN}/portal/yunClound/index.html?path=${LIVE_ROOM_MARKET_NAME}&sourceid=${LIVE_ROOM_JOURNALING_SOURCE_ID}&targetSourceId=${TO_SOURCE_ID}`;
}
function liveRoomHeaders() {
  return {
    Accept: "*/*",
    activityid: LIVE_ROOM_ACTIVITY_ID,
    appversion: LIVE_ROOM_APP_VERSION,
    Origin: LIVE_ROOM_ORIGIN,
    Referer: liveRoomPageReferer(),
    "User-Agent": LIVE_ROOM_USER_AGENT
  };
}
function liveRoomUrl(path, base) {
  return `${rootOrDefault(base, LIVE_ROOM_ORIGIN)}${path}`;
}
function userInfoRequest(base) {
  return {
    url: liveRoomUrl(USER_INFO_PATH, base),
    method: "POST",
    // ⚠ 不带 content-type：真实现（`live_flower::user_info_request`）就没设它。
    // 模块文档那张表写着 application/json，但**代码才是实际发出去的**。
    headers: liveRoomHeaders(),
    body: "{}"
  };
}
function journalingRequest(optkeyword, base) {
  return {
    url: liveRoomUrl(JOURNALING_PATH, base),
    method: "POST",
    headers: {
      ...liveRoomHeaders(),
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: `module=uservisit&optkeyword=${encodeURIComponent(optkeyword)}&sourceid=${LIVE_ROOM_JOURNALING_SOURCE_ID}&marketName=${LIVE_ROOM_MARKET_NAME}`
  };
}
function firstParticipateGiveRequest(base) {
  return {
    url: liveRoomUrl(FIRST_PARTICIPATE_GIVE_PATH, base),
    method: "POST",
    headers: liveRoomHeaders(),
    body: void 0
  };
}
function drawRequest(code, base) {
  return {
    url: `${liveRoomUrl(DRAW_PATH, base)}?code=${encodeURIComponent(code)}`,
    method: "POST",
    headers: liveRoomHeaders(),
    body: void 0
  };
}
function queryRevivalFlowersRequest(base) {
  return {
    url: liveRoomUrl(QUERY_REVIVAL_FLOWERS_PATH, base),
    method: "GET",
    headers: liveRoomHeaders(),
    body: void 0
  };
}
function intAt(o, k) {
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function strAt(o, k) {
  const v = o[k];
  return typeof v === "string" && v !== "" ? v : void 0;
}
function classifyDraw(env) {
  if (!env || env.code === void 0) {
    return { kind: "unparsable", code: env?.code, message: env?.message ?? "响应解不出来" };
  }
  const base = { code: env.code, message: env.message ?? "" };
  switch (env.code) {
    case 0: {
      const r = env.result;
      if (r === null || typeof r !== "object" || Array.isArray(r)) {
        return { ...base, kind: "unparsable" };
      }
      const o = r;
      return {
        ...base,
        kind: "succeeded",
        result: {
          prizeId: intAt(o, "prizeId") ?? 0,
          flowerNum: intAt(o, "flowerNum") ?? 0,
          prizeName: strAt(o, "prizeName"),
          prizeType: intAt(o, "prizeType") ?? 0
        }
      };
    }
    case CODE_KOULING_ALREADY_DRAWN:
      return { ...base, kind: "already-drawn" };
    case CODE_KOULING_INVALID:
      return { ...base, kind: "invalid-kouling" };
    case CODE_KOULING_EXPIRED:
      return { ...base, kind: "kouling-expired" };
    default:
      return { ...base, kind: "other" };
  }
}
function drawLine(code, out) {
  switch (out.kind) {
    case "succeeded":
      return `口令「${code}」领到 ${out.result?.flowerNum ?? 0} 朵`;
    case "already-drawn":
      return `口令「${code}」没领到：已兑换过`;
    case "invalid-kouling":
      return `口令「${code}」没领到：口令无效`;
    case "kouling-expired":
      return `口令「${code}」没领到：本场已结束（口令是对的）`;
    case "other":
      return `口令「${code}」没领到：上游回了未分类的码 ${out.code ?? "?"}${out.message ? `（${out.message}）` : ""}`;
    default:
      return `口令「${code}」没领到：响应解不出来`;
  }
}
function parseBalance(env) {
  const r = env?.result;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return void 0;
  return intAt(r, "flowerCnt");
}

// src/mcloud/liveKouling.ts
var XIAOHONGSHU_KOULING_PROFILE_URL = "https://www.xiaohongshu.com/user/profile/568caf13aed7585949773b30";
function xiaohongshuProfileHeaders() {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9",
    referer: "https://www.xiaohongshu.com/",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  };
}
function isKoulingHead(text) {
  return /(?:复制)?口令\s*\d*\s*[：:]\s*$/.test(text.trim());
}
function hasKouling(text) {
  return /口令|小红花/.test(text);
}
var TRAILING_PUNCT = /[。．.！!？?~～、,，;；:：'"]+$/;
function trimKoulingTail(code) {
  let out = code.trim();
  for (; ; ) {
    const before = out;
    out = out.replace(TRAILING_PUNCT, "").trim();
    out = out.replace(/\s*无随机口令$/, "");
    out = out.replace(/(?:^|\s+)无随机$/, "");
    out = out.replace(/(?:^|\s+)无$/, "");
    out = out.trim();
    if (out === before) break;
  }
  return out;
}
var TRAILING_PARTICLE = /[呀啊吧呢嘛哦]+$/;
var QUESTION_WORDS = ["什么", "啥", "多少", "几", "哪个", "哪些"];
function isQuestion(code) {
  if (/[?？]/.test(code)) return true;
  const t = code.replace(TRAILING_PARTICLE, "");
  return QUESTION_WORDS.includes(t);
}
var SAME_LINE_PATTERN = /(?:复制)?口令\s*\d*\s*[：:]\s*(.*?)(?=\s+(?:复制)?口令\s*\d*\s*[：:]|无随机|$)/g;
function extractKouling(msg) {
  const result = [];
  const m2 = msg.match(/小红花口令[：:]\s*(.+)/);
  if (m2 && m2[1] !== void 0) result.push(m2[1].trim());
  const lines = msg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (isKoulingHead(line)) {
      const next = lines[i + 1];
      if (next !== void 0) {
        const content = trimKoulingTail(next.trim());
        if (content && !/^(?:复制)?口令/.test(content)) {
          result.push(content);
        }
      }
      continue;
    }
    for (const match of line.matchAll(SAME_LINE_PATTERN)) {
      const code = trimKoulingTail((match[1] ?? "").trim());
      if (code) result.push(code);
    }
  }
  const m1 = msg.match(/口令是(.+)/);
  if (m1 && m1[1] !== void 0) result.push(m1[1].trim());
  if (result.length === 0 && /无随机/.test(msg)) {
    const parts = msg.replace(/无随机.*/, "").trim().split(/\s+/);
    for (const part of parts) {
      const v = part.match(/^\d+\s*[：:]\s*(.+)/);
      if (v && v[1] !== void 0) {
        const code = v[1].trim();
        if (code) result.push(code);
      }
    }
  }
  return [...new Set(result.map(trimKoulingTail))].filter((code) => code !== "" && !isQuestion(code));
}
var NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};
function decodeHtmlEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, named) => {
    if (typeof decimal === "string" && decimal !== "") {
      const n = Number(decimal);
      return safeFromCodePoint(n, entity);
    }
    if (typeof hex === "string" && hex !== "") {
      return safeFromCodePoint(Number.parseInt(hex, 16), entity);
    }
    if (typeof named === "string") {
      return NAMED_ENTITIES[named.toLowerCase()] ?? entity;
    }
    return entity;
  });
}
function safeFromCodePoint(n, fallback) {
  if (!Number.isFinite(n) || n < 0 || n > 1114111) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}
function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}
function htmlToText(html) {
  return decodeHtmlEntities(
    html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:a|article|div|h\d|li|p|section)>/gi, "\n").replace(/<[^>]+>/g, " ")
  ).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}
function collectCandidateTexts(html) {
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (value) => {
    const text = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
    if (!text || !hasKouling(text) || seen.has(text)) return;
    seen.add(text);
    candidates.push(text);
  };
  const jsonFieldPattern = /"(?:displayTitle|title|desc)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of html.matchAll(jsonFieldPattern)) add(decodeJsonString(match[1] ?? ""));
  const elementPattern = /<(?:a|article|div|h\d|p)[^>]*>([\s\S]*?)<\/(?:a|article|div|h\d|p)>/gi;
  for (const match of html.matchAll(elementPattern)) add(htmlToText(match[1] ?? ""));
  const metaPattern = /<meta\b[^>]*(?:content=["']([^"']+)["'])[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) add(match[1] ?? "");
  for (const line of htmlToText(html).split(/\r?\n/)) add(line);
  return candidates;
}
function extractKoulingFromXiaohongshuHtml(html) {
  for (const candidate of collectCandidateTexts(html)) {
    const codes = extractKouling(candidate);
    if (codes.length > 0) return codes;
  }
  return [];
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

// src/mcloud/h5session.ts
var BASE_USER_YUN = "https://user-njs.yun.139.com";
var H5_CONTENT_TYPE = "application/json;charset=UTF-8";
var SPEC_TOKEN_PATH = "/user/querySpecTokenV2";
function specTokenRequest(params, authorization, base) {
  return {
    url: `${rootOrDefault(base, BASE_USER_YUN)}${SPEC_TOKEN_PATH}`,
    method: "POST",
    headers: { "Content-Type": H5_CONTENT_TYPE, Authorization: authorization },
    body: JSON.stringify({ toSourceId: params.toSourceId })
  };
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

// src/mcloud/sessionExchange.ts
var STATE_AUTH = "mcloud.h5.auth";
function loadAuthRaw(store2) {
  const cur = currentAccount(store2);
  if (cur !== void 0) return cur.auth;
  return store2.getState(STATE_AUTH) ?? "";
}
var JWT_TTL_MS = 100 * 60 * 1e3;
var RETRY_AFTER_MS = 30 * 60 * 1e3;

// src/mcloud/authRefresh.ts
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

// src/mcloud/tasks/liveRoomRules.ts
function accountOf(store2) {
  const raw = loadAuthRaw(store2);
  if (raw === "") return accountKey("");
  const seg = parseAuthorization(raw);
  return accountKey(seg?.phone ?? "");
}
function mergeKouling(sources) {
  const out = [];
  for (const raw of sources) {
    const code = raw.trim();
    if (code === "" || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}
function claimVerdictOf(kind) {
  switch (kind) {
    case "succeeded":
      return "claimed";
    case "already-drawn":
      return "alreadyClaimed";
    case "invalid-kouling":
      return "invalid";
    case "kouling-expired":
      return "expired";
    default:
      return "other";
  }
}
function planDrawCodes(pool, account, humanCodes) {
  const picked = pickFor(pool, account);
  const out = [];
  for (const code of mergeKouling([...humanCodes, ...picked])) {
    if (codeState(pool, code) === "invalid") continue;
    if (accountClaimed(pool, account, code)) continue;
    out.push(code);
  }
  return out;
}

// src/mcloud/tasks/liveRoom.ts
var STATE_READING = "mcloud.live.reading";
var STATE_CODES = "mcloud.live.codes";
var STATE_LIVE_URL = "mcloud.live.url";
function loadLiveUrl(store2) {
  const v = store2.getState(STATE_LIVE_URL);
  return v && v.trim() ? v.trim() : XIAOHONGSHU_KOULING_PROFILE_URL;
}
var EMPTY_SHELL_HINT_CHARS = 5e3;
function runLiveRoom(deps) {
  const url = loadLiveUrl(deps.store);
  const nowMs = Date.parse(deps.nowIso);
  const loaded = loadPoolFrom(deps.store);
  const pool = loaded.pool;
  normalize(pool, nowMs);
  if (stopScraping(pool)) {
    return {
      ok: true,
      idle: true,
      note: `口令池已有 ${validCount(pool)} 条**有效**口令 ⇒ 按口径停止抓取（这一场只发那么几条，继续抓只会重复撞同一批）`
    };
  }
  if (!xhsReady(pool, nowMs)) {
    const mins = Math.ceil(xhsWaitMs(pool, nowMs) / 6e4);
    return {
      ok: true,
      idle: true,
      note: `距上次抓主页还不到 30 分钟（还要 ${mins} 分钟）—— 频繁抓会被风控挡成空壳，而空壳与"这期没发"在解析层长得一样，混起来没法排查`
    };
  }
  noteXhs(pool, nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);
  const res = callRawText(deps.transport, {
    url,
    method: "GET",
    headers: xiaohongshuProfileHeaders(),
    body: void 0
  });
  if (!res.ok) {
    const note3 = `抓小红书主页失败：${res.error ?? "未知失败"}`;
    recordError(deps.store, "live-room", note3, deps.nowIso);
    return { ok: false, note: note3 };
  }
  const codes = extractKoulingFromXiaohongshuHtml(res.text);
  const added = note(pool, codes, "xiaohongshu", nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);
  const guess = res.chars < EMPTY_SHELL_HINT_CHARS;
  const reset = loaded.reset ? "（⚠ 盘上那份池解不出来，已按空池重开 —— 这一场的领取记录丢了）" : "";
  const poolLine = `池：新增 ${added} 条，有效 ${validCount(pool)} 条${stopScraping(pool) ? "（已够 2 条 ⇒ 停止抓取）" : ""}`;
  const note2 = codes.length ? `小红书主页：${codes.length} 条口令（${codes.join("、")}）· ${poolLine}` : `小红书主页：没读到口令（页面 ${res.chars} 字符）· ${poolLine}` + (guess ? ` —— 页面小得可疑，**猜**是被挡成了空壳（不是判据）` : ` —— 也可能是这期没发：空壳页与"没发"在解析层长得一样`) + reset;
  const reading = {
    at: deps.nowIso,
    url,
    codes,
    chars: res.chars,
    tookMs: res.tookMs,
    note: note2
  };
  deps.store.setState(STATE_READING, JSON.stringify(reading), deps.nowIso);
  clearError(deps.store, "live-room", deps.nowIso);
  return { ok: true, note: note2 };
}
function loadLiveCodes(store2) {
  return parseJson(store2.getState(STATE_CODES));
}
function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// src/mcloud/tasks/liveDraw.ts
var STATE_DRAW = "mcloud.live.draw";
var STATE_CLAIM_ENABLED = "mcloud.live.claim_enabled";
function collectCodes(store2) {
  const human = loadLiveCodes(store2)?.codes ?? [];
  const { pool } = loadPoolFrom(store2);
  return planDrawCodes(pool, accountOf(store2), human);
}
function loadDrawState(store2) {
  const raw = store2.getState(STATE_DRAW);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v?.step === "string" ? v : null;
  } catch {
    return null;
  }
}
function claimEnabled(store2) {
  return store2.getState(STATE_CLAIM_ENABLED) === "1";
}
function stepRequest(s, base) {
  switch (s.step) {
    case "balance-before":
      return { request: userInfoRequest(base), label: "① 读余额（领之前）" };
    case "journaling": {
      const ev = JOURNALING_EVENTS[s.journalingSent];
      if (ev === void 0) return null;
      return { request: journalingRequest(ev, base), label: `② 埋点 ${s.journalingSent + 1}/5` };
    }
    case "first-participate":
      return { request: firstParticipateGiveRequest(base), label: "③ 首次参与惊喜奖" };
    case "draw": {
      const code = s.codes[s.drawIndex];
      if (code === void 0) return null;
      return {
        request: drawRequest(code, base),
        label: `④ 领口令「${code}」（${s.drawIndex + 1}/${s.codes.length}）`
      };
    }
    case "revival":
      return { request: queryRevivalFlowersRequest(base), label: "⑤ 复活花" };
    case "balance-after":
      return { request: userInfoRequest(base), label: "⑥ 再读余额（核对进账）" };
    default:
      return null;
  }
}
function runLiveDraw(deps, opts = {}) {
  const TASK = "live-room";
  if (!opts.force && !claimEnabled(deps.store)) {
    return { ok: true, idle: true, note: "领小红花未开启（界面上那个开关）" };
  }
  let s = loadDrawState(deps.store);
  const codes = collectCodes(deps.store);
  if (!s || s.step === "done") {
    const done = s?.codes ?? [];
    const { pool } = loadPoolFrom(deps.store);
    const account = accountOf(deps.store);
    const allClaimed = done.length > 0 && done.every((c) => accountClaimed(pool, account, c));
    if (codes.length === 0) {
      return allClaimed ? { ok: true, idle: true, note: `这一轮已跑完（${s?.summary ?? ""}）；口令没变，不重复领` } : { ok: true, idle: true, note: "没有口令可领（先抓主页或把口令填进输入框）" };
    }
    if (s?.step === "done" && sameList(done, codes) && s.account === account) {
      return { ok: true, idle: true, note: `这一轮已跑完（${s.summary ?? ""}）；口令没变，不重复领` };
    }
    s = {
      step: "balance-before",
      journalingSent: 0,
      drawIndex: 0,
      codes,
      account,
      results: [],
      startedAt: deps.nowIso
    };
    deps.store.setState(STATE_DRAW, JSON.stringify(s), deps.nowIso);
  }
  const session = loadSession(deps.store);
  if (!session || !session.jwt) {
    const note2 = "未登录：领小红花要 jwttoken（见 docs/howto-session.md）";
    recordError(deps.store, TASK, note2, deps.nowIso);
    return { ok: false, note: note2 };
  }
  const step = stepRequest(s, deps.baseUrl);
  if (!step) {
    s.step = "balance-after";
    deps.store.setState(STATE_DRAW, JSON.stringify(s), deps.nowIso);
    return { ok: true, note: "步骤下标越界，已跳到收尾" };
  }
  const res = callOnce(deps.transport, withSession(step.request, session.jwt));
  const before = s.results.length;
  const advance = judge(s, step.label, res, deps.nowIso);
  deps.store.setState(STATE_DRAW, JSON.stringify(advance.state), deps.nowIso);
  if (s.step === "draw" && advance.state.results.length > before) {
    const row = advance.state.results[advance.state.results.length - 1];
    if (row !== void 0) {
      const loaded = loadPoolFrom(deps.store);
      noteClaim(loaded.pool, accountOf(deps.store), row.code, claimVerdictOf(row.kind), Date.parse(deps.nowIso));
      savePoolTo(deps.store, loaded.pool, deps.nowIso);
    }
  }
  if (!advance.ok) {
    recordError(deps.store, TASK, advance.note, deps.nowIso);
    return { ok: false, note: advance.note };
  }
  clearError(deps.store, TASK, deps.nowIso);
  return { ok: true, note: advance.note };
}
function withSession(req, jwt) {
  return {
    ...req,
    headers: { ...req.headers, showloading: "true", jwttoken: jwt }
  };
}
function judge(s, label, res, nowIso) {
  const st = { ...s, results: [...s.results] };
  if (res.env === void 0) {
    const why = res.error ?? "未知失败";
    return { state: st, ok: false, note: `${label} 失败：${why}` };
  }
  const biz = () => `${label}：上游回 ${res.env?.code ?? "?"}${res.env?.message ? `（${res.env.message}）` : ""}`;
  switch (s.step) {
    case "balance-before": {
      if (res.env.code !== 0) return { state: st, ok: false, note: biz() };
      const v = parseBalance(res.env);
      if (v === void 0) {
        return { state: st, ok: false, note: `${label}：响应里没有 result.flowerCnt（余额）` };
      }
      st.balanceBefore = v;
      st.step = "journaling";
      return { state: st, ok: true, note: `${label}：${v} 朵 → 开始领` };
    }
    case "journaling": {
      st.journalingSent = s.journalingSent + 1;
      if (st.journalingSent >= JOURNALING_EVENTS.length) st.step = "first-participate";
      return {
        state: st,
        ok: true,
        note: res.env.code === 0 ? `${label} 完成` : `${biz()}（埋点失败不拦领取）`
      };
    }
    case "first-participate": {
      const code = res.env.code;
      st.firstParticipate = code === 0 ? "领到首次参与惊喜奖" : code === 200110 ? "已参与过（正常）" : `上游回 ${code ?? "?"}`;
      st.step = "draw";
      return { state: st, ok: true, note: `${label}：${st.firstParticipate}` };
    }
    case "draw": {
      const code = s.codes[s.drawIndex] ?? "";
      const out = classifyDraw(res.env);
      st.results.push({
        code,
        kind: out.kind,
        note: drawLine(code, out),
        flowerNum: out.result?.flowerNum ?? 0
      });
      st.drawIndex = s.drawIndex + 1;
      if (st.drawIndex >= st.codes.length) st.step = "revival";
      return { state: st, ok: true, note: drawLine(code, out) };
    }
    case "revival": {
      const r = res.env.result;
      st.revival = typeof r === "number" ? r : void 0;
      st.step = "balance-after";
      return {
        state: st,
        ok: true,
        note: res.env.code === 0 ? `${label}：${st.revival ?? "?"} 朵（**不是**小红花余额）` : biz()
      };
    }
    case "balance-after": {
      if (res.env.code !== 0) return { state: st, ok: false, note: biz() };
      const v = parseBalance(res.env);
      if (v === void 0) {
        return { state: st, ok: false, note: `${label}：响应里没有 result.flowerCnt` };
      }
      st.balanceAfter = v;
      st.step = "done";
      st.finishedAt = nowIso;
      const gained = (st.balanceAfter ?? 0) - (st.balanceBefore ?? 0);
      const okCount = st.results.filter((r) => r.kind === "succeeded").length;
      st.summary = `${st.results.length} 条口令领到 ${okCount} 条，进账 ${gained} 朵（${st.balanceBefore} → ${st.balanceAfter}）`;
      return { state: st, ok: true, note: st.summary };
    }
    default:
      return { state: st, ok: true, note: "没有可推进的步骤" };
  }
}
function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// src/mcloud/liveGate.ts
var BASE_CMLIVE = "https://v.cmcc-cs.cn/cmlive";
var LIVE_ORIGIN = "https://v.cmcc-cs.cn";
var LIVE_USER_AGENT = "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/12.6.0 iPad AppLanguage/zh-CN";
var LIVE_CHANNEL_ID = "134";
var LIVE_SOURCE_ID = "017027";
var LIVE_TAB_ID_BENEFITS = 127;
var LIVE_TAB_ID_REPLAY = 129;
var STATUS_LIVE = 1;
var GATE_TAB_IDS = [LIVE_TAB_ID_BENEFITS, LIVE_TAB_ID_REPLAY];
function parseCmlive(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `直播侧响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v["rtnCode"];
  if (typeof code !== "string") {
    return {
      ok: false,
      error: `直播侧的 rtnCode 应当是**字符串**，实际是 ${code === void 0 ? "缺字段" : typeof code}（这一族用字符串码；上游若真改成了数字码，这里必须报出来而不是兼容掉）`
    };
  }
  const msg = typeof v["rtnMsg"] === "string" ? v["rtnMsg"] : void 0;
  const env = { rtnCode: code, object: v["object"] };
  if (msg !== void 0) env.rtnMsg = msg;
  return { ok: true, value: env };
}
function cmliveOk(env) {
  return env.rtnCode === "0";
}
function cmliveLine(env) {
  return `rtnCode=${env.rtnCode}${env.rtnMsg ? `（${env.rtnMsg}）` : ""}`;
}
function objectOf(env, what) {
  if (!cmliveOk(env)) {
    return { ok: false, error: `${what}失败：${cmliveLine(env)}` };
  }
  const o = env.object;
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    return { ok: false, error: `${what}：object 不是对象（实际 ${o === null ? "null" : typeof o}）` };
  }
  return { ok: true, value: o };
}
function cmliveHeaders(jwt) {
  const h = {
    accept: "application/json, text/plain, */*",
    "x-requested-with": "XMLHttpRequest",
    "accept-language": "zh-CN,zh-Hans;q=0.9",
    origin: LIVE_ORIGIN,
    "user-agent": LIVE_USER_AGENT
  };
  if (jwt !== void 0 && jwt !== "") h["authorization"] = jwt;
  return h;
}
function gateSpecTokenRequest(authorization, base) {
  const req = specTokenRequest({ toSourceId: LIVE_SOURCE_ID }, authorization, base);
  return req;
}
function cmpassLoginRequest(ssoToken, base) {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/user/auth/cmpassLoginByCmToken`,
    method: "POST",
    headers: { ...cmliveHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ cmpassToken: ssoToken }),
    // ⚠ `v.cmcc-cs.cn` **只给 CBC 套件**（2026-10-14 实测：`ECDHE-RSA-AES128-SHA`）——
    //    rustls 不实现 CBC ⇒ 必须走平台 TLS。见 [`BuiltRequest::tls`] 与 F-030/F-031。
    tls: "native"
  };
}
function parseCmpassLogin(env) {
  if (!cmliveOk(env)) return { ok: false, error: `直播侧登录失败：${cmliveLine(env)}` };
  const raw = env.object;
  if (typeof raw !== "string" || raw === "") {
    return {
      ok: false,
      error: `cmpassLoginByCmToken 的 object 不是非空字符串（应当就是那串 JWT 本身），实际 ${typeof raw}`
    };
  }
  return { ok: true, value: raw };
}
function tabContentListRequest(tabId, jwt, base) {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/channel/channel/tabContentList?tabId=${tabId}&contentType=0&pageNo=1&channelId=${LIVE_CHANNEL_ID}`,
    method: "GET",
    headers: cmliveHeaders(jwt),
    body: void 0,
    // 同一个主机（`v.cmcc-cs.cn`）⇒ 同一条理由：只给 CBC，必须平台 TLS。
    tls: "native"
  };
}
function userTokenRequest(jwt, base) {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/user/customer/userToken`,
    method: "POST",
    headers: { ...cmliveHeaders(jwt), "content-type": "application/json" },
    body: JSON.stringify({}),
    tls: "native"
  };
}
function parseUserToken(body) {
  const env = parseCmlive(body);
  if (!env.ok) return { ok: false, error: env.error ?? "直播侧响应解不出来" };
  if (env.value === void 0) return { ok: false, error: "直播侧响应是空的" };
  const object = env.value.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return { ok: false, error: "userToken 的 object 不是对象" };
  }
  const o = object;
  const token = o["access_token"];
  if (typeof token !== "string" || token === "") {
    return { ok: false, error: "userToken 响应缺少 object.access_token" };
  }
  return {
    ok: true,
    value: {
      accessToken: token,
      expiresIn: typeof o["expires_in"] === "number" ? o["expires_in"] : 0
    }
  };
}
function roomBeatRequest(roomId, jwt, base) {
  return {
    url: `${rootOrDefault(base, BASE_CMLIVE)}/api/room/front/roomBeat`,
    method: "POST",
    headers: { ...cmliveHeaders(jwt), "content-type": "application/json" },
    body: JSON.stringify({ roomId: String(roomId), channelId: LIVE_CHANNEL_ID, sourceApp: 0 }),
    // 同一个主机（`v.cmcc-cs.cn`）⇒ 见 [`BuiltRequest.tls`]：只给 CBC，必须平台 TLS。
    tls: "native"
  };
}
function parseRoomBeat(body) {
  const env = parseCmlive(body);
  if (!env.ok) return { ok: false, error: env.error ?? "直播侧响应解不出来" };
  if (env.value === void 0) return { ok: false, error: "直播侧响应是空的" };
  const object = env.value.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return { ok: false, error: "roomBeat 的 object 不是对象" };
  }
  const o = object;
  const anchor = o["anchor"];
  const nick = typeof anchor === "object" && anchor !== null ? anchor["nickname"] ?? "" : "";
  const rawChat = o["chatRoomId"];
  return {
    ok: true,
    value: {
      status: typeof o["status"] === "number" ? o["status"] : -1,
      title: typeof o["title"] === "string" ? o["title"] : "",
      expectStartTime: typeof o["expectStartTime"] === "string" ? o["expectStartTime"] : "",
      anchorNickname: typeof nick === "string" ? nick : "",
      // ⚠ **空串也当"没有"**：空串进不了 WS（会拼出一个空的 `cmlive_…`）。
      chatRoomId: typeof rawChat === "string" && rawChat !== "" ? rawChat : void 0
    }
  };
}
function parseTabContentList(env) {
  const o = objectOf(env, "查房间列表");
  if (!o.ok || o.value === void 0) return { ok: false, error: o.error ?? "查房间列表失败" };
  const list = o.value["dataList"];
  if (list === null || list === void 0) return { ok: true, value: [] };
  if (!Array.isArray(list)) {
    return { ok: false, error: `dataList 不是数组（实际 ${typeof list}）` };
  }
  const rooms = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const room = entry["room"];
    if (room === null || typeof room !== "object" || Array.isArray(room)) continue;
    const r = room;
    rooms.push({
      id: intAt2(r, "id") ?? 0,
      title: strAt2(r, "title"),
      status: intAt2(r, "status") ?? -1,
      channelId: intAt2(r, "channelId") ?? 0,
      expectStartTime: strAt2(r, "expectStartTime"),
      anchorNickname: r["anchor"] !== null && typeof r["anchor"] === "object" ? strAt2(r["anchor"], "nickname") : ""
    });
  }
  return { ok: true, value: rooms };
}
function mergeRooms(groups) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const group of groups) {
    for (const room of group) {
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      out.push(room);
    }
  }
  return out;
}
function koulingRooms(rooms) {
  return rooms.filter((r) => r.status === STATUS_LIVE && r.anchorNickname === KOULING_ANCHOR);
}
function toProbeRooms(rooms) {
  return rooms.map((r) => ({
    roomId: r.id,
    title: r.title,
    status: r.status,
    expectStartTime: r.expectStartTime,
    anchorNickname: r.anchorNickname
  }));
}
function gateReadingLine(rooms) {
  const live = rooms.filter((r) => r.status === STATUS_LIVE);
  const hit = koulingRooms(rooms);
  if (hit.length > 0) {
    return `门开着：${hit.length} 间在播（${KOULING_ANCHOR}）—— ${hit.map((r) => r.title || `#${r.id}`).join("、")}`;
  }
  if (live.length === 0) return `门关着：谁都没在播（这一趟看到 ${rooms.length} 间房，全是预告/回放）`;
  return `门关着：有 ${live.length} 间在播，但都不是「${KOULING_ANCHOR}」（${live.map((r) => r.anchorNickname || "无名").join("、")}）`;
}
function intAt2(o, k) {
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return void 0;
}
function strAt2(o, k) {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

// src/mcloud/tasks/liveGateTask.ts
var STATE_GATE = "mcloud.live.gate";
var STATE_READING2 = "mcloud.live.gate.reading";
var STATE_GATE_BASE = "mcloud.live.gate_base";
function loadGateBase(store2) {
  const v = store2.getState(STATE_GATE_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : void 0;
}
function loadGateState(store2) {
  return parseJson2(store2.getState(STATE_GATE));
}
function runLiveGate(deps) {
  const base = loadGateBase(deps.store);
  const nowMs = Date.parse(deps.nowIso);
  const prev = loadGateState(deps.store);
  const st = prev && prev.step !== "done" ? prev : { step: "handshake", startedAt: deps.nowIso };
  if (st.step === "handshake") return handshake(deps, st, base);
  return roomsStep(deps, st, base, nowMs);
}
function handshake(deps, st, base) {
  const TASK = "live-gate";
  const auth = loadAuthRaw(deps.store);
  if (auth === "") {
    const note2 = "门要**原生凭据**（`Authorization`）：先去界面贴一份（见 docs/howto-session.md）";
    recordError(deps.store, TASK, note2, deps.nowIso);
    return { ok: false, note: note2 };
  }
  const r1 = callRawText(deps.transport, gateSpecTokenRequest(auth, base));
  if (!r1.ok) return stepFail(deps, TASK, `① 换 SSO token 失败：${r1.error ?? "未知失败"}`);
  const sso = parseSsoToken(r1.text);
  if (!sso.ok || sso.value === void 0) {
    return stepFail(deps, TASK, `① 换 SSO token 失败：${sso.error ?? "响应里没有 data.token"}`);
  }
  const r2 = callRawText(deps.transport, cmpassLoginRequest(sso.value, base));
  if (!r2.ok) return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${r2.error ?? "未知失败"}`);
  const env = parseCmlive(r2.text);
  if (!env.ok || env.value === void 0) {
    return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${env.error ?? "响应解不出来"}`);
  }
  const jwt = parseCmpassLogin(env.value);
  if (!jwt.ok || jwt.value === void 0) {
    return stepFail(deps, TASK, `② 换直播侧 JWT 失败：${jwt.error ?? "object 不是 JWT"}`);
  }
  st.jwt = jwt.value;
  st.step = "rooms";
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  clearError(deps.store, TASK, deps.nowIso);
  return {
    ok: true,
    note: "① 换到 SSO token（**不落盘**，这一步就用掉了）+ ② 换到直播侧 JWT（≈30 天，这一轮用完就抹）"
  };
}
function roomsStep(deps, st, base, nowMs) {
  const TASK = "live-gate";
  const jwt = st.jwt;
  if (jwt === void 0 || jwt === "") {
    st.step = "handshake";
    deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
    return { ok: true, idle: true, note: "这一轮没有 JWT ⇒ 退回第一步（下一趟重新握手）" };
  }
  const groups = [];
  for (const tabId of GATE_TAB_IDS) {
    const res = callRawText(deps.transport, tabContentListRequest(tabId, jwt, base));
    if (!res.ok) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${res.error ?? "未知失败"}`);
    }
    const env = parseCmlive(res.text);
    if (!env.ok || env.value === void 0) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${env.error ?? "响应解不出来"}`);
    }
    const parsed = parseTabContentList(env.value);
    if (!parsed.ok || parsed.value === void 0) {
      return dropJwtAndFail(deps, st, `③ 页签 ${tabId} 失败：${parsed.error ?? "房间列表解不出来"}`);
    }
    groups.push(parsed.value);
  }
  const rooms = mergeRooms(groups);
  const hit = koulingRooms(rooms);
  const note2 = gateReadingLine(rooms);
  const { pool } = loadPoolFrom(deps.store);
  normalize(pool, nowMs);
  noteProbe(pool, toProbeRooms(rooms), hit.length > 0, nowMs);
  savePoolTo(deps.store, pool, deps.nowIso);
  const reading = {
    at: deps.nowIso,
    active: hit.length > 0,
    liveCount: rooms.filter((r) => r.status === 1).length,
    rooms: toProbeRooms(rooms),
    note: note2
  };
  deps.store.setState(STATE_READING2, JSON.stringify(reading), deps.nowIso);
  delete st.jwt;
  st.rooms = rooms;
  st.step = "done";
  st.finishedAt = deps.nowIso;
  st.note = note2;
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  clearError(deps.store, TASK, deps.nowIso);
  return { ok: true, note: `${note2}（页签 ${GATE_TAB_IDS.join("/")}，共 ${rooms.length} 间房）` };
}
function dropJwtAndFail(deps, st, note2) {
  st.step = "handshake";
  delete st.jwt;
  deps.store.setState(STATE_GATE, JSON.stringify(st), deps.nowIso);
  return stepFail(deps, "live-gate", `${note2}（已丢弃 JWT，下一趟重新握手）`);
}
function stepFail(deps, task, note2) {
  recordError(deps.store, task, note2, deps.nowIso);
  return { ok: false, note: note2 };
}
function parseJson2(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// src/mcloud/msync.ts
var CMD_ACK = 0;
var CMD_HEARTBEAT = 1;
var CMD_DANMAKU = 2;
var CMD_PROVISION = 3;
var LIVE_APP_KEY = "cmos#ngvlcs";
var LIVE_DOMAIN = "cmosim.com";
var LIVE_AUTH_PREFIX = "$t$";
var LIVE_RESOURCE_PREFIX = "webim_";
var LIVE_DEVICE_INFO_ASCII = "830652084dda69b6b957e2c3a7bd9b18db65922e29051b1b342ccf15bebc0fdbd9c03439bcd8fff7ea316192960629f2";
var LIVE_IDENTIFICATION_PREFIX = "cmos_im2";
var PROVISION_OS_TYPE_JS = 7;
var PROVISION_VERSION = "23.0.2";
var PROVISION_APP_SIGN = "cmlive_cmos_js_sdk";
var PROVISION_DEVICE_NAME = "webim";
var WIRE_VARINT = 0;
var WIRE_FIXED64 = 1;
var WIRE_BYTES = 2;
var WIRE_FIXED32 = 5;
function readVarint(data, pos) {
  let value = 0n;
  let shift = 0n;
  for (let i = pos; i < data.length; i += 1) {
    const b = data[i];
    const idx = i - pos;
    if (idx >= 10) throw new Error(`varint 超过 10 字节（第 ${idx + 1} 字节 = 0x${b.toString(16)}）`);
    if (idx === 9 && b > 1) throw new Error(`varint 溢出（第 10 字节 = 0x${b.toString(16)}）`);
    value |= BigInt(b & 127) << shift;
    if ((b & 128) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  throw new Error("varint 被截断");
}
function scanProtoFields(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const key = readVarint(data, i);
    i = key.next;
    const num2 = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (num2 === 0) throw new Error(`字段号为 0（key = ${key.value.toString()}）`);
    if (!Number.isSafeInteger(num2)) throw new Error(`字段号超出安全整数（key = ${key.value.toString()}）`);
    let value = 0n;
    let raw = new Uint8Array(0);
    if (wire === WIRE_VARINT) {
      const v = readVarint(data, i);
      i = v.next;
      value = v.value;
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(data, i);
      i = len.next;
      const size = Number(len.value);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`字段 ${num2} 的声明长度超出范围`);
      if (data.length - i < size) {
        throw new Error(`字段 ${num2} 声明长度 ${size}，实际只剩 ${data.length - i} 字节`);
      }
      raw = new Uint8Array(data.subarray(i, i + size));
      i += size;
    } else if (wire === WIRE_FIXED64) {
      if (data.length - i < 8) throw new Error(`字段 ${num2} 的 64 位定长值被截断`);
      i += 8;
    } else if (wire === WIRE_FIXED32) {
      if (data.length - i < 4) throw new Error(`字段 ${num2} 的 32 位定长值被截断`);
      i += 4;
    } else {
      throw new Error(`不支持的 wire type ${wire}（字段 ${num2}）`);
    }
    out.push({ num: num2, wire, value, raw });
  }
  return out;
}
function fieldsOf(data) {
  try {
    return scanProtoFields(data);
  } catch {
    return [];
  }
}
function lastBytesField(fields, num2) {
  let found;
  for (const f of fields) if (f.num === num2 && f.wire === WIRE_BYTES) found = f.raw;
  return found;
}
function lastVarintField(fields, num2) {
  let found;
  for (const f of fields) if (f.num === num2 && f.wire === WIRE_VARINT) found = f.value;
  return found;
}
function putVarint(out, value) {
  let v = value;
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
}
function putTag(out, num2, wire) {
  putVarint(out, BigInt(num2) << 3n | BigInt(wire));
}
function putScalar(out, num2, value) {
  if (value === 0n) return;
  putTag(out, num2, WIRE_VARINT);
  putVarint(out, value);
}
function putScalarForced(out, num2, value) {
  putTag(out, num2, WIRE_VARINT);
  putVarint(out, value);
}
function putString(out, num2, value) {
  if (value.length === 0) return;
  putBytesRaw(out, num2, utf8(value));
}
function putStringKeepingEmpty(out, num2, value) {
  putBytesRaw(out, num2, utf8(value));
}
function putBytesRaw(out, num2, body) {
  putTag(out, num2, WIRE_BYTES);
  putVarint(out, BigInt(body.length));
  for (let i = 0; i < body.length; i += 1) out.push(body[i]);
}
function putBytes(out, num2, body) {
  if (body.length === 0) return;
  putBytesRaw(out, num2, body);
}
function putMessage(out, num2, body) {
  putBytesRaw(out, num2, body);
}
function be64(value) {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function secondsBytes(nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error(`nowMs 必须是有限数：${nowMs}`);
  const sec = Math.floor(nowMs / 1e3);
  if (sec < 0 || sec > 4294967295) {
    throw new Error(`nowMs=${nowMs} 换算成秒后超出 4 字节（${sec}）—— 本协议只给 32 位秒`);
  }
  return new Uint8Array([sec >>> 24 & 255, sec >>> 16 & 255, sec >>> 8 & 255, sec & 255]);
}
function identificationBytes(nowMs, identTail) {
  const prefix = utf8(LIVE_IDENTIFICATION_PREFIX);
  if (prefix.length !== 8) {
    throw new Error(`identification 前缀必须是 8 字节 ASCII，实际 ${prefix.length} 字节`);
  }
  const tail = identTail ?? be64(BigInt(Math.floor(nowMs)));
  if (tail.length !== 8) throw new Error(`identification 的后半段必须是 8 字节，实际 ${tail.length}`);
  const out = new Uint8Array(16);
  out.set(prefix, 0);
  out.set(tail, 8);
  return out;
}
function encodeJid(phone, nowMs) {
  const out = [];
  putString(out, 1, LIVE_APP_KEY);
  putString(out, 2, `cmlive_c_${phone}`);
  putString(out, 3, LIVE_DOMAIN);
  putString(out, 4, `${LIVE_RESOURCE_PREFIX}${Math.floor(nowMs)}`);
  return new Uint8Array(out);
}
function encodeProvisionPayload(input, auth) {
  const out = [];
  putScalar(out, 1, BigInt(PROVISION_OS_TYPE_JS));
  putString(out, 2, PROVISION_VERSION);
  putString(out, 4, PROVISION_APP_SIGN);
  putScalarForced(out, 5, 0n);
  putScalarForced(out, 6, 0n);
  putStringKeepingEmpty(out, 9, input.deviceUuid);
  putString(out, 12, PROVISION_DEVICE_NAME);
  putString(out, 13, input.resource);
  putString(out, 14, auth);
  return new Uint8Array(out);
}
function encodeProvision(input, nowMs, identTail) {
  const auth = `${LIVE_AUTH_PREFIX}${input.accessToken}`;
  const out = [];
  putMessage(out, 2, encodeJid(input.phone, nowMs));
  putString(out, 3, auth);
  putScalarForced(out, 8, BigInt(CMD_PROVISION));
  putMessage(out, 9, encodeProvisionPayload(input, auth));
  putScalarForced(out, 10, 0n);
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}
function encodeHeartbeat(nowMs, identTail) {
  const out = [];
  putScalarForced(out, 8, BigInt(CMD_HEARTBEAT));
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}
function encodeAck(msgId, nowMs, identTail) {
  if (!/^(0|[1-9][0-9]*)$/.test(msgId)) {
    throw new Error(`encodeAck 的 msgId 必须是十进制串（无前导零），收到 ${JSON.stringify(msgId)}`);
  }
  const out = [];
  putScalarForced(out, 8, BigInt(CMD_ACK));
  putMessage(out, 9, ackPayload(BigInt(msgId)));
  putScalarForced(out, 11, 0n);
  putBytes(out, 13, utf8(LIVE_DEVICE_INFO_ASCII));
  putBytes(out, 14, secondsBytes(nowMs));
  putBytes(out, 15, identificationBytes(nowMs, identTail));
  return new Uint8Array(out);
}
function ackPayload(msgId) {
  const inner = [];
  putScalarForced(inner, 1, msgId);
  const out = [];
  putMessage(out, 1, new Uint8Array(inner));
  return new Uint8Array(out);
}
function decodeMsync(bytes) {
  let fields;
  try {
    fields = scanProtoFields(bytes);
  } catch {
    return { command: 0, msgId: void 0, texts: [], isMsync: false };
  }
  if (fields.length === 0) return { command: 0, msgId: void 0, texts: [], isMsync: false };
  const command = Number(lastVarintField(fields, 8) ?? 0n) & 255;
  const payload = lastBytesField(fields, 9);
  if (command === CMD_DANMAKU && payload !== void 0) {
    return { command, ...danmakuOf(payload), isMsync: true };
  }
  if (command === CMD_ACK && payload !== void 0) {
    return { command, msgId: ackMsgIdOf(payload), texts: [], isMsync: true };
  }
  return { command, msgId: void 0, texts: [], isMsync: true };
}
function danmakuOf(payload) {
  const texts = [];
  let msgId;
  for (const meta of fieldsOf(payload)) {
    if (meta.num !== 2) continue;
    if (meta.wire === WIRE_VARINT) {
      msgId = meta.value.toString();
      continue;
    }
    if (meta.wire !== WIRE_BYTES) continue;
    const inner = fieldsOf(meta.raw);
    for (const body of inner) {
      if (body.num !== 6 || body.wire !== WIRE_BYTES) continue;
      for (const content of fieldsOf(body.raw)) {
        if (content.num !== 4 || content.wire !== WIRE_BYTES) continue;
        const text = lastBytesField(fieldsOf(content.raw), 2);
        if (text !== void 0) texts.push(fromUtf8(text));
      }
    }
    const id = msgIdOf(inner);
    if (id !== void 0) msgId = id;
  }
  return { msgId, texts };
}
function msgIdOf(messageFields) {
  const v = lastVarintField(messageFields, 1);
  if (v !== void 0) return v.toString();
  const s = lastBytesField(messageFields, 1);
  if (s === void 0) return void 0;
  const asText = fromUtf8(s);
  return /^[0-9]+$/.test(asText) ? asText : void 0;
}
function ackMsgIdOf(payload) {
  const fields = fieldsOf(payload);
  const direct = lastVarintField(fields, 2);
  if (direct !== void 0) return direct.toString();
  const one = lastBytesField(fields, 1);
  if (one === void 0) return void 0;
  const inner = lastVarintField(fieldsOf(one), 1);
  return inner !== void 0 && inner > 0n ? inner.toString() : void 0;
}

// src/mcloud/liveIm.ts
var BASE_VIDEO_IM = "https://videoim.cmcc-cs.cn:20103";
var LIVE_APPLY_VERSION = "v23.0.2";
function timestampSuffix10(timestamp) {
  return timestamp.length <= 10 ? timestamp : timestamp.slice(timestamp.length - 10);
}
var md5HexBytes = (bytes) => toHex(md5(bytes));
function systemMd5(deviceInfoHex, timestamp) {
  const device = fromHex(deviceInfoHex);
  const ts = utf8(timestampSuffix10(timestamp));
  const payload = new Uint8Array(device.length + ts.length);
  payload.set(device, 0);
  payload.set(ts, device.length);
  return md5HexBytes(payload);
}
function tokenMd5(accessToken, timestamp) {
  const head = accessToken.length > 10 ? accessToken.slice(0, 10) : accessToken;
  const tail = accessToken.length > 10 ? accessToken.slice(10) : "";
  return md5HexBytes(utf8(`Bearer ${head}${timestampSuffix10(timestamp)}${tail}`));
}
function applyRoomRequest(chatRoomId, userName, invoker, accessToken, timestamp, opts = {}) {
  const deviceInfoHex = opts.deviceInfoHex ?? LIVE_DEVICE_INFO_ASCII;
  return {
    url: `${rootOrDefault(opts.base, BASE_VIDEO_IM)}/v3/room/member/apply`,
    method: "POST",
    headers: {
      accept: "*/*",
      version: LIVE_APPLY_VERSION,
      timestamp,
      authorization: `Bearer ${accessToken}`,
      origin: LIVE_ORIGIN,
      "user-agent": LIVE_USER_AGENT,
      deviceinfo: deviceInfoHex,
      systemmd5: systemMd5(deviceInfoHex, timestamp),
      tokenmd5: tokenMd5(accessToken, timestamp),
      "content-type": "application/json"
    },
    body: JSON.stringify({ invoker, message: "", roomId: chatRoomId, userName }),
    // ⚠ 这个主机与直播侧**同一类问题**：2026-10-14 实测只给 CBC 套件
    //   （`ECDSA/ECDHE-RSA-AES128-SHA`），rustls 谈不下来 ⇒ 必须平台 TLS。
    tls: "native"
  };
}
function parseApplyRoom(body) {
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `进聊天室的响应不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v["code"];
  if (code !== 0) {
    const msg = typeof v["msg"] === "string" ? v["msg"] : "";
    return { ok: false, error: `进聊天室失败：code=${JSON.stringify(code)} msg=${msg || "(无)"}` };
  }
  const data = typeof v["data"] === "object" && v["data"] !== null ? v["data"] : {};
  return {
    ok: true,
    value: {
      appId: typeof data["appId"] === "string" ? data["appId"] : "",
      appKey: typeof data["appKey"] === "string" ? data["appKey"] : "",
      roomId: typeof data["roomId"] === "string" ? data["roomId"] : "",
      serverTimestamp: typeof v["timestamp"] === "number" ? v["timestamp"] : 0
    }
  };
}

// src/mcloud/liveWs.ts
var SOCKJS_OPEN = "o";
var SOCKJS_HEARTBEAT = "h";
var SOCKJS_CLOSE_PREFIX = "c[";
var SOCKJS_DATA_PREFIX = "a[";
function sockjsSendFrame(msync) {
  return `["${toBase64(msync)}"]`;
}
function sockjsDataFrames(text) {
  return splitDataFrameJson(text).map((b64) => fromBase64(b64));
}
function splitDataFrameJson(text) {
  const json = text.slice(SOCKJS_DATA_PREFIX.length - 1);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`SockJS 数据帧不是合法 JSON 数组：${String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SockJS 数据帧不是 JSON 数组");
  }
  const out = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      throw new Error("SockJS 数据帧的数组元素必须是 base64 字符串");
    }
    out.push(item);
  }
  return out;
}
var DEFAULT_HEARTBEAT_MS = 15e3;
var DEFAULT_MALFORMED_LIMIT = 8;
var CLOSE_REASON_SERVER = "服务端关闭帧 c[";
var CLOSE_REASON_MALFORMED = "连续 ";
var CLOSE_REASON_SOCKJS_HEARTBEAT = "收到 SockJS 心跳帧 h";
function createListener(o) {
  const heartbeatMs = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const malformedLimit = o.malformedLimit ?? DEFAULT_MALFORMED_LIMIT;
  const st = {
    openSeen: false,
    provisionSent: false,
    provisionAckSeen: false,
    heartbeatCount: 0,
    lastHeartbeatAtMs: void 0,
    consecutiveMalformed: 0,
    closeReason: void 0
  };
  const giveUp = (reason) => {
    st.closeReason = reason;
    return { outbound: [], texts: [], closed: reason };
  };
  const heartbeatFrame = (nowMs) => {
    st.heartbeatCount += 1;
    st.lastHeartbeatAtMs = nowMs;
    return sockjsSendFrame(encodeHeartbeat(nowMs));
  };
  const onFrameInner = (text, nowMs) => {
    if (text === SOCKJS_HEARTBEAT) {
      if (o.sockjsHeartbeatReply !== void 0) {
        return {
          kind: "heartbeat",
          outbound: [o.sockjsHeartbeatReply],
          texts: [],
          closed: void 0
        };
      }
      return {
        kind: "heartbeat",
        outbound: [],
        texts: [],
        closed: `${CLOSE_REASON_SOCKJS_HEARTBEAT}：抓包 §四 4.1 全程零样本（业务帧太密，从未静默满 25 秒）⇒「h 该回什么」判为**未判定**，本层不猜、不回帧；请调用方决定（回 "h" / 回 [""] / 忽略并断开）`
      };
    }
    if (text.startsWith(SOCKJS_CLOSE_PREFIX)) {
      return {
        kind: "closed",
        outbound: [],
        texts: [],
        closed: `${CLOSE_REASON_SERVER}…]：服务端关闭了这条连接，不再往上写任何东西`
      };
    }
    if (text === SOCKJS_OPEN) {
      st.openSeen = true;
      if (st.provisionSent) {
        return { kind: "open", outbound: [], texts: [], closed: void 0 };
      }
      const resource = `webim_${nowMs}`;
      const frame = sockjsSendFrame(
        encodeProvision(
          { accessToken: o.accessToken, resource, deviceUuid: o.deviceUuid, phone: o.phone },
          nowMs
        )
      );
      st.provisionSent = true;
      return { kind: "open", outbound: [frame], texts: [], closed: void 0 };
    }
    if (!text.startsWith(SOCKJS_DATA_PREFIX)) {
      return { kind: "ignored", outbound: [], texts: [], closed: void 0 };
    }
    let pieces;
    try {
      pieces = splitDataFrameJson(text);
    } catch {
      return { kind: "malformed", outbound: [], texts: [], closed: void 0 };
    }
    const outbound = [];
    const texts = [];
    let kind = "silent";
    let malformed = false;
    for (const piece of pieces) {
      const decoded = decodeMsync(fromBase64(piece));
      if (!decoded.isMsync) {
        malformed = true;
        continue;
      }
      const command = decoded.command;
      const msgId = decoded.msgId;
      const frameTexts = decoded.texts;
      switch (command) {
        case CMD_PROVISION: {
          kind = "provision_ack";
          st.provisionAckSeen = true;
          if (st.lastHeartbeatAtMs === void 0) {
            outbound.push(heartbeatFrame(nowMs));
          }
          break;
        }
        case CMD_DANMAKU: {
          kind = "danmaku";
          if (frameTexts.length > 0) {
            texts.push(...frameTexts);
          }
          if (msgId === void 0) {
            break;
          }
          outbound.push(sockjsSendFrame(encodeAck(msgId, nowMs)));
          break;
        }
        case CMD_ACK:
          break;
        case CMD_HEARTBEAT:
          break;
        default:
          break;
      }
    }
    if (malformed && kind === "silent") {
      kind = "malformed";
    }
    return { kind, outbound, texts, closed: void 0 };
  };
  const onFrame = (text, nowMs) => {
    if (st.closeReason !== void 0) {
      return { outbound: [], texts: [], closed: st.closeReason };
    }
    const r = onFrameInner(text, nowMs);
    if (r.kind === "malformed") {
      st.consecutiveMalformed += 1;
    } else {
      st.consecutiveMalformed = 0;
    }
    if (r.kind === "malformed" && malformedLimit !== 0 && st.consecutiveMalformed >= malformedLimit) {
      return giveUp(
        `${CLOSE_REASON_MALFORMED}${st.consecutiveMalformed} 帧解不开（上限 ${malformedLimit} 帧）：这条连接还在通，但说的不是我们的协议 ⇒ 请收工（别挂到超时）`
      );
    }
    if (r.kind === "closed") {
      st.closeReason = r.closed;
    }
    return { outbound: r.outbound, texts: r.texts, closed: r.closed };
  };
  const dueHeartbeat = (nowMs) => {
    if (st.closeReason !== void 0) {
      return [];
    }
    if (!st.provisionAckSeen) {
      return [];
    }
    if (st.lastHeartbeatAtMs !== void 0 && nowMs - st.lastHeartbeatAtMs < heartbeatMs) {
      return [];
    }
    return [heartbeatFrame(nowMs)];
  };
  const state = () => ({
    provisionSent: st.provisionSent,
    provisionAckSeen: st.provisionAckSeen,
    // 判据照 Rust：收到过 `o` **并且**收到过 PROVISION 的响应（cmd=3）才算进过房间。
    enteredRoom: st.openSeen && st.provisionAckSeen,
    heartbeatCount: st.heartbeatCount,
    lastHeartbeatAtMs: st.lastHeartbeatAtMs,
    closed: st.closeReason !== void 0
  });
  return { onFrame, state, dueHeartbeat };
}

// src/mcloud/tasks/liveListen.ts
var STATE_LISTEN = "mcloud.live.listen";
var STATE_WS_BASE = "mcloud.live.ws_base";
var STATE_WS_HEARTBEAT = "mcloud.live.ws_heartbeat_reply";
var STATE_LISTEN_ROOM = "mcloud.live.listen_room";
function loadListenRoom(store2) {
  const v = (store2.getState(STATE_LISTEN_ROOM) ?? "").trim();
  if (v === "") return void 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : void 0;
}
var DEFAULT_WS_HEARTBEAT = "h";
function loadWsHeartbeat(store2) {
  const v = store2.getState(STATE_WS_HEARTBEAT);
  return v === null || v === void 0 ? DEFAULT_WS_HEARTBEAT : v;
}
var BASE_VIDEO_IM_WS = "wss://videoim.cmcc-cs.cn:20102";
var DEFAULT_LISTEN_SECONDS = 600;
var IDLE_RECHECK_MS = 5 * 60 * 1e3;
var MAX_IDLE_RECHECK_MS = 12 * 60 * 60 * 1e3;
function idleCooldownMs(deps, nowMs) {
  const sleep = wakeSleepMs(deps.store, nowMs, loadListenSeconds(deps.store) * 1e3);
  if (sleep === void 0 || sleep <= 0) return IDLE_RECHECK_MS;
  return Math.min(sleep, MAX_IDLE_RECHECK_MS);
}
var READ_BURST_MS = 1600;
var RECV_SLICE_MS = 700;
var WS_OPEN_TIMEOUT_MS = 8e3;
var parseJson3 = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
function loadListenState(store2) {
  return parseJson3(store2.getState(STATE_LISTEN));
}
function loadWsBase(store2) {
  const v = store2.getState(STATE_WS_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : BASE_VIDEO_IM_WS;
}
function liveWsUrl(base, serverId, sessionId) {
  return `${base.replace(/\/+$/, "")}/ws/${serverId}/${sessionId}/websocket`;
}
function sockjsSessionId(rand = Math.random) {
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) out += alpha[Math.floor(rand() * alpha.length)] ?? "a";
  return out;
}
function randomServerId(rand = Math.random) {
  return Math.floor(rand() * 1e3);
}
function wsHandshakeHeaders() {
  return { origin: LIVE_ORIGIN, "user-agent": LIVE_USER_AGENT };
}
function listenerIdle(st, nowMs) {
  if (st.nextCheckAtMs !== void 0 && nowMs < st.nextCheckAtMs) {
    const at = new Date(st.nextCheckAtMs).toISOString().slice(11, 19);
    return `门关着，等下一次检查（${at}Z 之后）`;
  }
  return void 0;
}
var current;
function hbPolicyOf(v) {
  return v === "h" ? "reply" : "none";
}
function parseHeartbeatReply(v) {
  return hbPolicyOf(v) === "reply" ? v : void 0;
}
function listenerFor(deps, st, nowMs, opts) {
  const handle = st.handle ?? -1;
  if (current !== void 0 && current.handle === handle && current.windowStartMs === st.windowStartMs && current.chatRoomId === opts.chatRoomId) {
    return current.listener;
  }
  const listener = createListener({
    accessToken: opts.accessToken,
    chatRoomId: opts.chatRoomId,
    phone: opts.phone,
    // ⚠ 这一格照抓包给**空串**（§5.5：字段在、长度为 0），不是毫秒串。
    deviceUuid: "",
    // ⚠⚠ `h`（SockJS 心跳）抓包**零样本**（§四 4.1），所以这一格是**实机试出来的**：
    //   2026-10-14 那场房间里安静满 25 秒 ⇒ 服务端真的发了 `h`；回一帧 `h`
    //   之后连接继续可用（读数与判据见 docs/findings.md F-032）。
    //   回 `[""]` 是**错的**：那是 SockJS 的**关闭**帧（抓包 §二 末帧）。
    sockjsHeartbeatReply: parseHeartbeatReply(loadWsHeartbeat(deps.store))
  });
  current = {
    handle,
    windowStartMs: st.windowStartMs,
    chatRoomId: opts.chatRoomId,
    listener
  };
  return listener;
}
function runLiveListen(deps) {
  const nowMs = Date.parse(deps.nowIso);
  const prev = loadListenState(deps.store);
  const windowMs = loadListenSeconds(deps.store) * 1e3;
  if (prev !== null && prev.step === "done") {
    const idle = listenerIdle(prev, nowMs);
    if (idle !== void 0) return { ok: true, note: idle };
  }
  const inWindow = prev !== null && (prev.step === "listen" || prev.step === "open");
  const stale = prev === null || prev.step === "done" || !inWindow && nowMs - prev.windowStartMs > windowMs;
  const st = !stale ? prev : {
    step: "handshake",
    windowStartMs: nowMs,
    frames: 0,
    danmakuFrames: 0,
    acks: 0,
    codes: [],
    startedAt: deps.nowIso
  };
  switch (st.step) {
    case "handshake":
      return handshakeStep(deps, st);
    case "rooms":
      return roomsStep2(deps, st, nowMs);
    case "userToken":
      return userTokenStep(deps, st);
    case "roomBeat":
      return roomBeatStep(deps, st, nowMs);
    case "apply":
      return applyStep(deps, st, nowMs);
    case "open":
      return openStep(deps, st, nowMs);
    case "listen":
      return listenStep(deps, st, nowMs, windowMs);
    default:
      return finish(deps, st, "窗口已结束");
  }
}
var STATE_LISTEN_SECONDS = "mcloud.live.listen_seconds";
function loadListenSeconds(store2) {
  const raw = store2.getState(STATE_LISTEN_SECONDS);
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : DEFAULT_LISTEN_SECONDS;
}
function persist(deps, st) {
  deps.store.setState(STATE_LISTEN, JSON.stringify(st), deps.nowIso);
}
function stepFail2(deps, st, note2) {
  recordError(deps.store, "live-listen", note2, deps.nowIso);
  persist(deps, st);
  return { ok: false, note: note2 };
}
function handshakeStep(deps, st) {
  const base = loadGateBaseOf(deps.store);
  const auth = loadAuthRaw(deps.store);
  if (auth === "") {
    return stepFail2(deps, st, "听弹幕要**原生凭据**（`Authorization`）：先去界面贴一份");
  }
  const r1 = callRawText(deps.transport, gateSpecTokenRequest(auth, base));
  if (!r1.ok) return stepFail2(deps, st, `① 换 SSO token 失败：${r1.error ?? "未知失败"}`);
  const sso = parseSsoToken(r1.text);
  if (!sso.ok || sso.value === void 0) {
    return stepFail2(deps, st, `① 换 SSO token 失败：${sso.error ?? "响应里没有 data.token"}`);
  }
  const r2 = callRawText(deps.transport, cmpassLoginRequest(sso.value, base));
  if (!r2.ok) return stepFail2(deps, st, `② 换直播侧 JWT 失败：${r2.error ?? "未知失败"}`);
  const env = parseCmlive(r2.text);
  if (!env.ok || env.value === void 0) {
    return stepFail2(deps, st, `② 换直播侧 JWT 失败：${env.error ?? "响应解不出来"}`);
  }
  const jwt = parseCmpassLogin(env.value);
  if (!jwt.ok || jwt.value === void 0) {
    return stepFail2(deps, st, `② 换直播侧 JWT 失败：${jwt.error ?? "object 不是 JWT"}`);
  }
  st.jwt = jwt.value;
  st.step = "rooms";
  persist(deps, st);
  clearError(deps.store, "live-listen", deps.nowIso);
  return { ok: true, note: "① SSO + ② 直播侧 JWT 都换到了（JWT 只在这一个窗口里活）" };
}
function roomsStep2(deps, st, nowMs) {
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? "";
  if (jwt === "") return stepFail2(deps, st, "③ 没有票（上一拍的 JWT 不在）");
  const groups = [];
  for (const tabId of GATE_TAB_IDS) {
    const r = callRawText(deps.transport, tabContentListRequest(tabId, jwt, base));
    if (!r.ok) return stepFail2(deps, st, `③ 页签 ${tabId} 失败：${r.error ?? "未知失败"}`);
    const env = parseCmlive(r.text);
    if (!env.ok || env.value === void 0) {
      return stepFail2(deps, st, `③ 页签 ${tabId} 失败：${env.error ?? "响应解不出来"}`);
    }
    const parsed = parseTabContentList(env.value);
    if (!parsed.ok || parsed.value === void 0) {
      return stepFail2(deps, st, `③ 页签 ${tabId} 失败：${parsed.error ?? "房间列表解不出来"}`);
    }
    groups.push([...parsed.value]);
  }
  const merged = mergeRooms(groups);
  void nowMs;
  const forced = loadListenRoom(deps.store);
  const chosen = forced !== void 0 ? forced : koulingRooms(merged)[0]?.id;
  if (chosen === void 0) {
    st.step = "done";
    const coolMs = idleCooldownMs(deps, Date.parse(deps.nowIso));
    st.nextCheckAtMs = Date.parse(deps.nowIso) + coolMs;
    st.closedReason = "那个主播没在播";
    st.finishedAt = deps.nowIso;
    st.probedAt = deps.nowIso;
    st.note = forced !== void 0 ? `指定的房间 ${forced} 不在这次探到的 ${merged.length} 间房里（诊断口子）` : coolMs > IDLE_RECHECK_MS ? `门关着（合并后 ${merged.length} 间房）—— 按日程睡到下一场之后（${Math.round(coolMs / 6e4)} 分钟）` : `门关着（合并后 ${merged.length} 间房）—— 隔 ${Math.round(coolMs / 6e4)} 分钟再看（上次真探 ${deps.nowIso.slice(11, 19)}）`;
    persist(deps, st);
    return { ok: true, note: st.note };
  }
  st.roomId = chosen;
  st.step = "userToken";
  st.probedAt = deps.nowIso;
  persist(deps, st);
  return {
    ok: true,
    note: forced === void 0 ? `门开着：房间 ${st.roomId}，接着取 WS 凭据` : `诊断口子：直接听指定的房间 ${st.roomId}，接着取 WS 凭据`
  };
}
function userTokenStep(deps, st) {
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? "";
  if (jwt === "") return stepFail2(deps, st, "③ 没有票（上一拍的 JWT 不在）");
  const r = callRawText(deps.transport, userTokenRequest(jwt, base));
  if (!r.ok) return stepFail2(deps, st, `③ 取 WS 凭据失败：${r.error ?? "未知失败"}`);
  const parsed = parseUserToken(r.text);
  if (!parsed.ok || parsed.value === void 0) {
    return stepFail2(deps, st, `③ 取 WS 凭据失败：${parsed.error ?? "响应里没有 access_token"}`);
  }
  st.accessToken = parsed.value.accessToken;
  st.step = "roomBeat";
  persist(deps, st);
  return { ok: true, note: `③ 取到 WS 凭据（${parsed.value.accessToken.length} 字符，${parsed.value.expiresIn}s）` };
}
function roomBeatStep(deps, st, nowMs) {
  void nowMs;
  const base = loadGateBaseOf(deps.store);
  const jwt = st.jwt ?? "";
  if (st.roomId === void 0 || jwt === "") {
    return stepFail2(deps, st, "④ 缺房间号或票（上一拍的状态不完整）");
  }
  const r = callRawText(deps.transport, roomBeatRequest(st.roomId, jwt, base));
  if (!r.ok) return stepFail2(deps, st, `④ roomBeat 失败：${r.error ?? "未知失败"}`);
  const parsed = parseRoomBeat(r.text);
  if (!parsed.ok || parsed.value === void 0) {
    return stepFail2(deps, st, `④ roomBeat 失败：${parsed.error ?? "响应解不出来"}`);
  }
  const beat = parsed.value;
  if (beat.chatRoomId === void 0) {
    st.step = "done";
    st.nextCheckAtMs = Date.parse(deps.nowIso) + idleCooldownMs(deps, Date.parse(deps.nowIso));
    st.closedReason = `房间 ${st.roomId} 没有聊天室（status=${beat.status}）`;
    st.finishedAt = deps.nowIso;
    st.note = st.closedReason;
    persist(deps, st);
    return { ok: true, note: st.note };
  }
  st.chatRoomId = beat.chatRoomId;
  st.step = "apply";
  persist(deps, st);
  return {
    ok: true,
    note: `房间 ${st.roomId}（${beat.title || "无标题"}）聊天室 ${st.chatRoomId}，接着进房间`
  };
}
function applyStep(deps, st, nowMs) {
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null) return stepFail2(deps, st, "⑤ 进房间要手机号（`userName` 用 `cmlive_c_<手机>`）");
  if (st.chatRoomId === void 0 || st.accessToken === void 0) {
    return stepFail2(deps, st, "⑤ 进房间缺聊天室号或 WS 凭据（上一拍的状态不完整）");
  }
  const userName = `cmlive_c_${parsed.phone}`;
  const req = applyRoomRequest(st.chatRoomId, userName, userName, st.accessToken, String(nowMs), {
    // 没配口子 ⇒ `applyRoomRequest` 自己用真主机（`BASE_VIDEO_IM`）
    base: loadImBase(deps.store)
  });
  const r = callRawText(deps.transport, req);
  if (!r.ok) return stepFail2(deps, st, `⑤ 进房间失败：${r.error ?? "未知失败"}`);
  const out = parseApplyRoom(r.text);
  if (!out.ok) return stepFail2(deps, st, `⑤ 进房间失败：${out.error}`);
  st.applied = true;
  st.step = "open";
  persist(deps, st);
  return {
    ok: true,
    note: `⑤ 进房间成功（appId=${out.value.appId || "?"}，回显聊天室 ${out.value.roomId || "?"}）`
  };
}
function openStep(deps, st, nowMs) {
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null) {
    return stepFail2(deps, st, "WS 那一步要手机号（PROVISION 的 `guid.name` 用它）—— 凭据解不出来");
  }
  if (st.chatRoomId === void 0 || st.jwt === void 0) {
    return stepFail2(deps, st, "开 WS 缺聊天室号或票（上一拍的状态不完整）");
  }
  const url = liveWsUrl(loadWsBase(deps.store), randomServerId(), sockjsSessionId());
  const opts = {
    headers: wsHandshakeHeaders(),
    timeout_ms: WS_OPEN_TIMEOUT_MS
  };
  if (url.startsWith("wss:")) opts.tls = "native";
  let handle;
  try {
    handle = deps.host.wsOpen(url, opts);
  } catch (e) {
    return stepFail2(deps, st, `开 WS 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  st.handle = handle;
  const listener = listenerFor(deps, st, nowMs, {
    accessToken: st.jwt,
    chatRoomId: st.chatRoomId,
    phone: parsed.phone
  });
  let first;
  try {
    first = deps.host.wsRecv(handle, RECV_SLICE_MS);
  } catch (e) {
    try {
      deps.host.wsClose(handle);
    } catch {
    }
    current = void 0;
    st.handle = void 0;
    st.step = "done";
    st.closedReason = `句柄失效（${e instanceof Error ? e.message : String(e)}）`;
    st.finishedAt = deps.nowIso;
    persist(deps, st);
    return { ok: false, note: `WS 句柄失效：${st.closedReason}` };
  }
  if (first.type === "close" || first.type === "error") {
    deps.host.wsClose(handle);
    st.handle = void 0;
    st.step = "done";
    st.closedReason = first.type === "close" ? first.reason : first.message;
    st.finishedAt = deps.nowIso;
    persist(deps, st);
    return { ok: false, note: `WS 刚连上就断了：${st.closedReason ?? ""}` };
  }
  let sent = 0;
  if (first.type === "text") {
    const actions = listener.onFrame(first.data, nowMs);
    sent += flush(deps, handle, actions.outbound);
    st.frames += 1;
  }
  if (sent === 0) {
    persist(deps, st);
    return { ok: true, note: "WS 连上了，还没等到 SockJS 的 `o`（下一拍接着等）" };
  }
  st.lastHeartbeatAtMs = nowMs;
  st.step = "listen";
  persist(deps, st);
  return { ok: true, note: `WS 连上了（句柄 ${handle}），PROVISION 已发 —— 开始听弹幕` };
}
function listenStep(deps, st, nowMs, windowMs) {
  const handle = st.handle;
  if (handle === void 0) {
    current = void 0;
    st.step = "handshake";
    persist(deps, st);
    return { ok: true, note: "WS 句柄不在了（面板重启过？）⇒ 重新走一遍门" };
  }
  const auth = loadAuthRaw(deps.store);
  const parsed = parseAuthorization(auth);
  if (parsed === null || st.jwt === void 0 || st.chatRoomId === void 0) {
    return stepFail2(deps, st, "听的那一步缺凭据/票/聊天室号");
  }
  const listener = listenerFor(deps, st, nowMs, {
    accessToken: st.jwt,
    chatRoomId: st.chatRoomId,
    phone: parsed.phone
  });
  const deadline = Date.now() + READ_BURST_MS;
  const found = [];
  let endReason;
  while (Date.now() < deadline) {
    const sliceMs = Math.min(RECV_SLICE_MS, Math.max(120, deadline - Date.now()));
    let frame;
    try {
      frame = deps.host.wsRecv(handle, sliceMs);
    } catch (e) {
      endReason = `句柄失效（${e instanceof Error ? e.message : String(e)}）`;
      break;
    }
    if (frame.type === "close") {
      endReason = frame.reason;
      break;
    }
    if (frame.type === "error") {
      endReason = frame.message;
      break;
    }
    if (frame.type !== "text") continue;
    st.frames += 1;
    if (frame.data === "h") st.sockjsHb = (st.sockjsHb ?? 0) + 1;
    try {
      for (const bytes of sockjsDataFrames(frame.data)) {
        const cmd = decodeMsync(bytes).command;
        const k = String(cmd);
        st.kinds = { ...st.kinds ?? {}, [k]: ((st.kinds ?? {})[k] ?? 0) + 1 };
        if (cmd === CMD_ACK) st.serverAcks = (st.serverAcks ?? 0) + 1;
      }
    } catch {
      st.decodeFail = (st.decodeFail ?? 0) + 1;
    }
    const actions = listener.onFrame(frame.data, Date.now());
    flush(deps, handle, actions.outbound);
    if (actions.outbound.length > 0) st.acks += 1;
    if (actions.texts.length > 0) {
      st.danmakuFrames += 1;
      for (const text of actions.texts) {
        if (!hasKouling(text)) continue;
        const codes = extractKouling(text);
        for (const code of codes) found.push(code);
      }
    }
    if (actions.closed !== void 0) {
      if (actions.closed.includes("SockJS 心跳帧")) continue;
      endReason = actions.closed;
      break;
    }
  }
  if (found.length > 0) {
    const { pool } = loadPoolFrom(deps.store);
    note(pool, found, "danmaku", Date.now());
    savePoolTo(deps.store, pool, deps.nowIso);
    for (const code of found) if (!st.codes.includes(code)) st.codes.push(code);
  }
  const due = listener.dueHeartbeat(Date.now());
  if (due.length > 0) {
    flush(deps, handle, due);
    st.lastHeartbeatAtMs = Date.now();
  }
  if (endReason !== void 0) {
    try {
      deps.host.wsClose(handle);
    } catch {
    }
    current = void 0;
    st.handle = void 0;
    st.step = "done";
    st.closedReason = endReason;
    st.finishedAt = deps.nowIso;
    st.note = `弹幕连接结束：${endReason}（这一段里收到 ${st.frames} 帧、弹幕 ${st.danmakuFrames} 条）`;
    persist(deps, st);
    return { ok: true, note: st.note };
  }
  if (Date.now() - st.windowStartMs >= windowMs) {
    try {
      deps.host.wsClose(handle);
    } catch {
    }
    current = void 0;
    st.handle = void 0;
    st.step = "done";
    st.closedReason = "窗口到点";
    st.finishedAt = deps.nowIso;
    st.note = `窗口到点，主动断开（收到 ${st.frames} 帧、弹幕 ${st.danmakuFrames} 条、口令 ${st.codes.length} 条）`;
    persist(deps, st);
    return { ok: true, note: st.note };
  }
  persist(deps, st);
  const got = found.length > 0 ? `，本轮口令 ${found.join(" / ")}` : "";
  return {
    ok: true,
    note: `听着（帧 ${st.frames}、弹幕 ${st.danmakuFrames}、口令 ${st.codes.length}${got}）`
  };
}
function flush(deps, handle, outbound) {
  let n = 0;
  for (const text of outbound) {
    try {
      deps.host.wsSend(handle, text);
      n += 1;
    } catch {
      break;
    }
  }
  return n;
}
function finish(deps, st, note2) {
  current = void 0;
  if (st.handle !== void 0) {
    try {
      deps.host.wsClose(st.handle);
    } catch {
    }
    st.handle = void 0;
  }
  st.step = "done";
  st.finishedAt = deps.nowIso;
  st.note = note2;
  persist(deps, st);
  return { ok: true, note: note2 };
}
var STATE_IM_BASE = "mcloud.live.im_base";
function loadImBase(store2) {
  const v = store2.getState(STATE_IM_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : void 0;
}
function loadGateBaseOf(store2) {
  const v = store2.getState("mcloud.live.gate_base");
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : void 0;
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
function makeHost() {
  return {
    wsOpen: (url, opts) => ws_open(url, opts),
    wsSend: (id, text) => ws_send(id, text),
    wsRecv: (id, timeoutMs) => ws_recv(id, timeoutMs),
    wsClose: (id) => ws_close(id)
  };
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

// src/entries/live.ts
worker_hint("exclusive");
var store = makeStore();
var transport = makeTransport(LONG_REQUEST_TIMEOUT_MS);
var host = makeHost();
var BUDGET_MS = 7e4;
var LISTEN_DEADLINE_MS = BUDGET_MS - 15e3;
function listenDeps(deps) {
  return { ...deps, host };
}
function runLive(deps) {
  const started = Date.now();
  const steps = [];
  const step = (name, fn) => {
    try {
      const r2 = fn();
      steps.push({ name, ok: r2.ok, note: r2.note, idle: r2.idle === true });
      return r2;
    } catch (e) {
      const note2 = `抛异常 ${e instanceof Error ? e.message : String(e)}`;
      steps.push({ name, ok: false, note: note2, idle: false });
      return { ok: false, note: note2 };
    }
  };
  step(
    "自动定时",
    () => runLiveAuto(deps, { windowMs: loadListenSeconds(store) * 1e3 })
  );
  step("日程门", () => runLiveGate(deps));
  step("口令笔记", () => runLiveRoom(deps));
  let frames = 0;
  let listenNote = "";
  const ld = listenDeps(deps);
  while (Date.now() - started < LISTEN_DEADLINE_MS) {
    const r2 = step("听弹幕", () => runLiveListen(ld));
    listenNote = r2.note;
    if (!r2.ok || r2.idle) break;
    frames++;
    if (frames > 60) break;
  }
  if (frames > 0) {
    steps.push({ name: "听弹幕", ok: true, note: `共读 ${frames} 轮`, idle: false });
  }
  const r = drain(runLiveDraw, deps, {
    label: "领小红花",
    maxSteps: 12,
    deadlineMs: BUDGET_MS - (Date.now() - started) - 3e3,
    startedAt: started
  });
  steps.push({ name: "领小红花", ok: r.ok, note: r.note, idle: false });
  const detail = steps.map((s) => `${s.name}：${s.ok ? "" : "失败 "}${s.note}`);
  const failed = steps.filter((s) => !s.ok);
  const elapsed = ((Date.now() - started) / 1e3).toFixed(1);
  if (failed.length > 0) {
    return {
      ok: false,
      note: `${failed.length} 步有问题：${failed[0].name}：${failed[0].note}`,
      detail,
      steps
    };
  }
  return {
    ok: true,
    note: `${listenNote || "未进入听窗口"}（用时 ${elapsed}s）`,
    detail,
    steps
  };
}
register_cron(
  "直播",
  // 一分钟一跳，配合 70 秒预算 ⇒ 窗口之间几乎不留缝。
  // 门关着时第一次调用就进冷却、零请求秒返回。
  "@every 1m",
  (p) => {
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    const deps = taskDeps(store, transport, p);
    const r = runLive(deps);
    appendRun(store, {
      task: "live",
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
    if (r.ok) log2(`直播：${r.note}`);
    else warn2(`直播：${r.note}`);
    for (const line of r.detail) {
      if (line.includes("失败") || line.includes("抛异常")) warn2(`  · ${line}`);
    }
  },
  { budget_ms: BUDGET_MS }
);
log2(`mcloud-live：任务「直播」（预算 ${BUDGET_MS / 1e3}s，独占线程）`);
