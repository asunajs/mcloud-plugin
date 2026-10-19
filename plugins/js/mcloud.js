// 由 src/entries/mcloud.ts 打包生成 —— **不要手改这个文件**。
//
//   改代码：编辑 src/，然后 `npm run build`
//   只在构建产物上改动的东西，下一次构建就没了
//   mcloud-plugin 0.1.1 · 插件 `mcloud`

// src/entries/mcloud.ts
import {
  debug,
  error,
  log as log2,
  register_nav,
  register_route,
  worker_hint
} from "host-api";

// src/store/keys.ts
var DEFAULT_ACCT = "default";
var PLUGIN_NS = "mcloud.";
var ACCT_PREFIX = "mcloud.acct.";
var STATE_CURRENT_ACCOUNT = "mcloud.account.current";
var STATE_ACCOUNTS = "mcloud.accounts";
var KEY_SCOPE = {
  // ── 账号运行期状态 ──────────────────────────────────────────
  "mcloud.session": "account",
  "mcloud.session.last_check": "account",
  "mcloud.h5.auth": "account",
  // 宿主"能不能用 tls:native"的探测结论（= 这个面板构建支不支持直播）。
  // **与账号无关**，但按账号存最省事 —— 结论一样，多存几份不花钱。
  "mcloud.host.native_tls": "account",
  "mcloud.h5.exchange": "account",
  "mcloud.h5.jwt": "account",
  "mcloud.daily.done_date": "account",
  "mcloud.daily.last_run": "account",
  // ⚠ 登录这一族是**本机**的，不是某个账号的。
  //
  //   · `deviceId` —— 本机设备指纹。参考实现（`accounts-page.tsx`）的原话：
  //     「扫码时它作为 `dID` 上报，服务端据此定位会话。它**跨重启稳定**；
  //      换掉会让旧的扫码会话立即失效，但已登录账号不受影响。」
  //     ⇒ 它是"这台机器长什么样"，写在**账号**名下是错的。
  //   · `qr` / `sms` —— "我正在进行的那次登录"（还没变成账号）。
  //   · `base` / `userDomainId` —— 登录服下发的主机，同样是本机的。
  //
  //   ⚠ 这几格**原来就是扁平的全局键**。把它们改成按账号是**我的改动**，不是原行为
  //   —— 而"语义说不清楚时保持原行为"才是对的。见下面那段纪律。
  "mcloud.login.deviceId": "global",
  "mcloud.login.qr": "global",
  "mcloud.login.sms": "global",
  // 手机端（App 链路）那次登录。与 `sms` **分开存**：两端的滑块语义不同
  //（PC 取图自己解、App 真机是开 WebView），共用一格会让"进行中的是哪一端"
  // 变成要靠猜。
  "mcloud.login.app": "global",
  // 每条任务跑哪些账号。**global** —— 它说的是这条任务用哪些号，
  // 不是某个号自己的设置（放进账号袋会让 A 的名单被 B 读到）。
  // ⚠ 动态键（键里带任务名）⇒ 靠  登记，见下面那张表。
  "mcloud.task.accounts.": "global",
  // 运行日志的**环形副本**（最近 N 行）。global —— 它记的是"这台机器上发生过什么"，
  // 不属于某个号；而且它要能在**面板重启之后**还读得到（面板的内存日志环是重启就没的，
  // 见 findings F-085）。写的时候按"全局"落，界面上再按插件名过滤。
  "mcloud.log.ring": "global",
  "mcloud.login.base": "global",
  "mcloud.login.userDomainId": "global",
  "mcloud.sign.stage": "account",
  "mcloud.sign.last": "account",
  "mcloud.upload.state": "account",
  "mcloud.taskexpansion.state": "account",
  "mcloud.apptask.state": "account",
  "mcloud.apptaskmatrix.last": "account",
  "mcloud.apptaskmatrix.group_index": "account",
  "mcloud.notice.can_claim": "account",
  "mcloud.notice.info": "account",
  "mcloud.backupgift.can_receive": "account",
  "mcloud.backupgift.info": "account",
  "mcloud.msgpush.can": "account",
  "mcloud.msgpush.last": "account",
  "mcloud.prizes.last": "account",
  "mcloud.multiple.last": "account",
  "mcloud.revival.last": "account",
  "mcloud.receive.last": "account",
  "mcloud.receive.queue": "account",
  "mcloud.cloudsnapshot.last": "account",
  "mcloud.exchangelist.last": "account",
  "mcloud.exchangelist.raw": "account",
  // 界面上「选一件」的下拉缓存（全量清单里挑出来的四格）。
  // **按账号** —— 清单与"能不能换"都是账号级的。日界作废，见 exchangeList.ts。
  "mcloud.exchangelist.pick": "account",
  // 「我关注的奖品」：按账号存（不同账号的清单不同，关注的 id 也可能不同）。
  "mcloud.exchange.subs": "account",
  "mcloud.exchange.plan": "account",
  // 定时抢兑每个账号已经真正发起过几次（按账号）。
  "mcloud.exchange.schedule.runs": "account",
  "mcloud.exchange.schedule.runs_gen": "account",
  "mcloud.exchange.order.step": "account",
  "mcloud.exchange.order.baseline": "account",
  "mcloud.exchange.order.plan": "account",
  "mcloud.exchange.order.round": "account",
  "mcloud.exchange.order.ordered_hour": "account",
  "mcloud.exchange.order.last_wait": "account",
  "mcloud.live.gate": "account",
  "mcloud.live.gate.reading": "account",
  "mcloud.live.gate_base": "account",
  "mcloud.live.reading": "account",
  "mcloud.live.draw": "account",
  "mcloud.live.codes": "account",
  "mcloud.live.listen": "account",
  "mcloud.live.listen_room": "account",
  "mcloud.live.listen_seconds": "account",
  "mcloud.live.url": "account",
  "mcloud.live.wake_plan": "account",
  "mcloud.live.ws_base": "account",
  "mcloud.live.ws_heartbeat_reply": "account",
  "mcloud.live.im_base": "account",
  "mcloud.smid.deviceId": "account",
  "mcloud.smid.fingerprint": "account",
  "mcloud.auth.refresh.last": "account",
  // ── 实例级配置 / 跨账号共享 ────────────────────────────────
  /** 账号表本身。 */
  "mcloud.accounts": "global",
  /** "当前选中哪个账号"。⚠ 它是**选择**，不是某个账号的状态。 */
  "mcloud.account.current": "global",
  /** 上游域名。 */
  "mcloud.base_url": "global",
  /** 登录方式偏好（扫码 / 短信 / 账密）。 */
  "mcloud.login.pref": "global",
  /** 几点抢兑 —— 是**配置**，跟账号无关。 */
  "mcloud.exchange.target_hour": "global",
  // 「定时抢兑」的目标：与手动目标分开，避免改一个把另一个带跑。
  // 全局 —— 定时任务按「任务账号」逐个跑，但只认这一件目标。
  "mcloud.exchange.schedule.plan": "global",
  "mcloud.exchange.schedule.mode": "global",
  "mcloud.exchange.schedule.cron": "global",
  "mcloud.exchange.schedule.until": "global",
  "mcloud.exchange.schedule.once_date": "global",
  "mcloud.exchange.schedule.max_runs": "global",
  "mcloud.exchange.schedule.gen": "global",
  "mcloud.exchange.schedule.plan_name": "global",
  // 多计划：计划表 + 每条计划已跑次数。
  "mcloud.exchange.plans": "global",
  "mcloud.exchange.plan.runs": "global",
  "mcloud.exchange.plans.migrated": "global",
  "mcloud.exchange.schedule.enabled": "global",
  "mcloud.exchange.lead_sec": "global",
  /** 提前量 —— "网络慢的人该调大"，是**这台机器**的调参，与账号无关。 */
  "mcloud.exchange.order.lead_ms": "global",
  /** 领小红花的开关。 */
  "mcloud.live.claim_enabled": "global",
  /** 推送配置（渠道 / 规则 / 事件绑到哪个渠道）。 */
  "mcloud.push.config": "global",
  "mcloud.push.rules": "global",
  "mcloud.push.bindings": "global",
  /** ⚠ 共享口令池 —— 参考实现明写"实例级：跨 mcloud 用户、跨重启"。 */
  "mcloud.kouling.pool": "global",
  /** 运行日志（每条记录里自己带账号）。 */
  "mcloud.run.log": "global",
  /** 任务清单缓存。 */
  "mcloud.tasklist.last": "global"
};
var KEY_PREFIX_SCOPE = [
  // 每条任务"跑哪些账号"（`mcloud.task.accounts.日常`）—— 键里带任务名，
  // 静态扫描扫不到整串，所以按前缀登记。⚠ **global**：它说的是"这条任务用哪些号"，
  // 不是"某个号自己的设置"。
  ["mcloud.task.accounts.", "global"],
  ["mcloud.last_error.", "account"],
  // 票与换票进度：**按配方**分（`mcloud.h5.jwt.sign-in` / `.msg-push-on`）。
  // ⚠ 账号那一维由 `scoped()` 加（袋名），所以这里只剩配方这一段。
  //   两个维度都必要：不分账号会串身份，不分配方会用错页面的票。
  ["mcloud.h5.jwt.", "account"],
  ["mcloud.h5.exchange.", "account"],
  // 矩阵按**市场**分（`mcloud.apptaskmatrix.g.sign_in_3`）—— 动态拼出来的，
  // 静态扫描扫不到整串，所以按前缀登记。
  ["mcloud.apptaskmatrix.g.", "account"]
];
function scopeOf(key) {
  const exact = KEY_SCOPE[key];
  if (exact !== void 0) return exact;
  let best;
  for (const [prefix, scope] of KEY_PREFIX_SCOPE) {
    if (key.startsWith(prefix) && (best === void 0 || prefix.length > best.len)) {
      best = { len: prefix.length, scope };
    }
  }
  return best?.scope;
}
function acctIdOf(store2, override) {
  if (override !== void 0 && override !== "") return override;
  const id = (store2.getState(STATE_CURRENT_ACCOUNT) ?? "").trim();
  return id === "" ? DEFAULT_ACCT : id;
}
function acctBagKey(acctId) {
  return `${ACCT_PREFIX}${acctId}`;
}
function readBag(store2, acctId) {
  const raw = store2.getState(acctBagKey(acctId));
  if (raw === void 0 || raw === null || raw === "") return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}
function writeBag(store2, acctId, bag, nowIso) {
  store2.setState(acctBagKey(acctId), JSON.stringify(bag), nowIso);
}
function clearBag(store2, acctId, nowIso) {
  store2.setState(acctBagKey(acctId), "", nowIso);
}
var UnregisteredKeyError = class extends Error {
  constructor(key) {
    super(
      `状态键「${key}」没有在 store/keys.ts 的 KEY_SCOPE 里登记。
⚠ 不许默认当成全局键 —— 那正是多账号串号那一串 bug 的成因（见该文件头）。
判据：账号 A 写进去之后，账号 B 读到它会不会做出**错的**决定？会 ⇒ 'account'。`
    );
    this.name = "UnregisteredKeyError";
  }
};
function routeGet(store2, key, acctId) {
  if (key.startsWith(ACCT_PREFIX)) return store2.getState(key) ?? null;
  if (!key.startsWith(PLUGIN_NS)) return store2.getState(key) ?? null;
  const scope = scopeOf(key);
  if (scope === void 0) throw new UnregisteredKeyError(key);
  if (scope === "global") return store2.getState(key) ?? null;
  const bag = readBag(store2, acctIdOf(store2, acctId));
  return bag[key] ?? null;
}
function routeSet(store2, key, value, nowIso, acctId) {
  if (key.startsWith(ACCT_PREFIX)) {
    store2.setState(key, value, nowIso);
    return;
  }
  if (!key.startsWith(PLUGIN_NS)) {
    store2.setState(key, value, nowIso);
    return;
  }
  const scope = scopeOf(key);
  if (scope === void 0) throw new UnregisteredKeyError(key);
  if (scope === "global") {
    store2.setState(key, value, nowIso);
    return;
  }
  const acct = acctIdOf(store2, acctId);
  const bag = readBag(store2, acct);
  bag[key] = value;
  writeBag(store2, acct, bag, nowIso);
}
function migrateFlatKeys(store2, nowIso) {
  const acctId = acctIdOf(store2);
  const bag = readBag(store2, acctId);
  const moved = [];
  for (const [key, scope] of Object.entries(KEY_SCOPE)) {
    if (scope !== "account") continue;
    const flat = store2.getState(key);
    if (flat === void 0 || flat === null || flat === "") continue;
    if (bag[key] === void 0) {
      bag[key] = flat;
      moved.push(key);
    }
    store2.setState(key, "", nowIso);
  }
  if (moved.length > 0) writeBag(store2, acctId, bag, nowIso);
  return { moved };
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
  const bits2 = bytes * 8;
  return { hi: Math.floor(bits2 / 4294967296) >>> 0, lo: bits2 >>> 0 };
}

// src/mcloud/auth.ts
var PC_AUTH_PREFIX = "pc";
var APP_AUTH_PREFIX = "mobile";
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
function normalizeAuth(raw) {
  const t = raw.replace(/\uFEFF/g, "").trim();
  const head = t.charAt(0);
  const unquoted = t.length >= 2 && (head === '"' || head === "'") && t.charAt(t.length - 1) === head ? t.slice(1, -1).trim() : t;
  const m = /^basic[\s:]+([\s\S]+)$/i.exec(unquoted);
  const b64 = (m !== null ? m[1] : unquoted).replace(/\s+/g, "");
  if (b64 === "") return unquoted;
  const info = parseAuth(b64);
  return info !== void 0 && info.raw !== "" ? `Basic ${b64}` : unquoted;
}
function idOf(raw) {
  const phone = phoneOf(raw);
  if (phone !== void 0) return phone;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `anon-${(h >>> 0).toString(36)}`;
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
    const auth = normalizeAuth(o.auth);
    const info = parseAuth(auth);
    const pc = o.pcPlatform;
    out.push({
      id: o.id,
      label: typeof o.label === "string" && o.label !== "" ? o.label : o.id,
      auth,
      // 老账号没存过这两格 ⇒ 从凭据里现解一次（不用迁移）
      platform: typeof o.platform === "string" ? o.platform : info?.platform ?? "",
      pcPlatform: pc === "win" || pc === "mac" ? pc : void 0,
      userDomainId: typeof o.userDomainId === "string" && o.userDomainId !== "" ? o.userDomainId : void 0,
      disabled: o.disabled === true,
      addedAt: typeof o.addedAt === "string" ? o.addedAt : ""
    });
  }
  return out;
}
function saveAccounts(store2, list, nowIso) {
  store2.setState(STATE_ACCOUNTS, JSON.stringify(list), nowIso);
}
function upsertAccount(store2, authInput, nowIso, label, pcPlatform, userDomainId) {
  let auth = authInput;
  const list = loadAccounts(store2);
  auth = normalizeAuth(auth);
  const id = idOf(auth);
  const idx = list.findIndex((a) => a.id === id || idOf(normalizeAuth(a.auth)) === id);
  const info = parseAuth(auth);
  const account = {
    id,
    label: label !== void 0 && label !== "" ? label : phoneOf(auth) ?? `账号 ${list.length + 1}`,
    auth,
    platform: info?.platform ?? "",
    // ⚠ 只在 PC 端才有意义。手机端传进来也丢掉 —— 留着会让"这个账号用哪套
    //   设备头"这件事出现两个互相矛盾的来源。
    pcPlatform: info?.platform === PC_AUTH_PREFIX ? pcPlatform ?? list[idx]?.pcPlatform ?? "win" : void 0,
    // ⚠ 重加同一个号时**保留**用户域（贴凭据/换凭据那条路拿不到它）
    userDomainId: userDomainId !== void 0 && userDomainId !== "" ? userDomainId : list[idx]?.userDomainId,
    // ⚠ 重加同一个号时**保留**停用状态（"刷新凭据"不该顺手把人启用回来）
    disabled: list[idx]?.disabled === true,
    addedAt: idx >= 0 ? list[idx].addedAt : nowIso
  };
  if (idx >= 0) list[idx] = account;
  else list.push(account);
  saveAccounts(store2, list, nowIso);
  return { list, account, created: idx < 0 };
}
function setAccountDisabled(store2, id, disabled, nowIso) {
  const list = loadAccounts(store2);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return void 0;
  list[idx] = { ...list[idx], disabled };
  saveAccounts(store2, list, nowIso);
  return list[idx];
}
function setAccountLabel(store2, id, label, nowIso) {
  const list = loadAccounts(store2);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return void 0;
  const auth = list[idx].auth;
  list[idx] = {
    ...list[idx],
    label: label.trim() !== "" ? label.trim() : phoneOf(auth) ?? `账号 ${idx + 1}`
  };
  saveAccounts(store2, list, nowIso);
  return list[idx];
}
function removeAccount(store2, id, nowIso) {
  const list = loadAccounts(store2).filter((a) => a.id !== id);
  saveAccounts(store2, list, nowIso);
  if (store2.getState(STATE_CURRENT_ACCOUNT) === id) store2.setState(STATE_CURRENT_ACCOUNT, "", nowIso);
  clearBag(store2, id, nowIso);
  return list;
}
function selectAccount(store2, id, nowIso) {
  if (id !== "" && !loadAccounts(store2).some((a) => a.id === id)) return false;
  store2.setState(STATE_CURRENT_ACCOUNT, id, nowIso);
  return true;
}
function setAccountAuth(store2, id, auth, nowIso) {
  if (auth === "") return void 0;
  const list = loadAccounts(store2);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return void 0;
  if (list[idx].auth === auth) return list[idx];
  list[idx] = { ...list[idx], auth };
  saveAccounts(store2, list, nowIso);
  return list[idx];
}
function setAccountDomain(store2, id, domain, nowIso) {
  if (domain === "") return void 0;
  const list = loadAccounts(store2);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return void 0;
  if (list[idx].userDomainId === domain) return list[idx];
  list[idx] = { ...list[idx], userDomainId: domain };
  saveAccounts(store2, list, nowIso);
  return list[idx];
}
function currentAccountDomain(store2) {
  const a = currentAccount(store2);
  return a?.userDomainId !== void 0 && a.userDomainId !== "" ? a.userDomainId : null;
}
function currentAccount(store2) {
  const id = (store2.getState(STATE_CURRENT_ACCOUNT) ?? "").trim();
  if (id === "") return void 0;
  return loadAccounts(store2).find((a) => a.id === id);
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

// src/crypto/sha1.ts
function padBE(bytes) {
  const { hi, lo } = lengthBits(bytes.length);
  const total = (bytes.length + 8 >> 6) + 1 << 6;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 128;
  writeU32BE(out, total - 8, hi);
  writeU32BE(out, total - 4, lo);
  return out;
}
function rotl2(x, n) {
  return (x << n | x >>> 32 - n) >>> 0;
}
function sha1(bytes) {
  let h0 = 1732584193;
  let h1 = 4023233417;
  let h2 = 2562383102;
  let h3 = 271733878;
  let h4 = 3285377520;
  const padded = padBE(bytes);
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = readU32BE(padded, off + i * 4);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl2(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (i < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708;
      } else {
        f = b ^ c ^ d;
        k = 3395469782;
      }
      const t = rotl2(a, 5) + f + e + k + w[i] >>> 0;
      e = d;
      d = c;
      c = rotl2(b, 30);
      b = a;
      a = t;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
  }
  const out = new Uint8Array(20);
  writeU32BE(out, 0, h0);
  writeU32BE(out, 4, h1);
  writeU32BE(out, 8, h2);
  writeU32BE(out, 12, h3);
  writeU32BE(out, 16, h4);
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
function hmac(hash, blockSize, key, msg) {
  let k = key;
  if (k.length > blockSize) k = hash(k);
  const ipad = new Uint8Array(blockSize + msg.length);
  for (let i = 0; i < blockSize; i += 1) {
    ipad[i] = (i < k.length ? k[i] : 0) ^ 54;
  }
  ipad.set(msg, blockSize);
  const inner = hash(ipad);
  const opad = new Uint8Array(blockSize + inner.length);
  for (let i = 0; i < blockSize; i += 1) {
    opad[i] = (i < k.length ? k[i] : 0) ^ 92;
  }
  opad.set(inner, blockSize);
  return hash(opad);
}
var BLOCK = 64;
function hmacSha256(key, msg) {
  return hmac(sha256, BLOCK, key, msg);
}
var md5Hex = (d) => toHex(md5(anyBytes(d)));
var sha256Hex = (d) => toHex(sha256(anyBytes(d)));
function anyBytes(d) {
  return typeof d === "string" ? utf8(d) : d;
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
  const fail = (error3) => ({
    status: 0,
    tookMs: Date.now() - t0,
    env: void 0,
    ok: false,
    error: error3,
    raw: "",
    body: "",
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
    body: res.body,
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
  const fail = (error2) => ({
    ok: false,
    status: 0,
    text: "",
    chars: 0,
    tookMs: Date.now() - t0,
    error: error2
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
var CLIENT_QUERY = "client=app";
function rootOrDefault(base, fallback) {
  const t = (base ?? "").trim();
  return t === "" ? fallback : t.replace(/\/+$/, "");
}

// src/mcloud/tasks/base.ts
function hostBase(deps, fallback) {
  const b = (deps.baseUrl ?? "").trim();
  return b === "" ? fallback : b.replace(/\/+$/, "");
}
function depsNowMs(deps) {
  return (deps.nowMs ?? Date.now)();
}
var ERR_PREFIX = "mcloud.last_error.";
function recordError(store2, task, note2, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, `${note2} @ ${nowIso}`, nowIso);
}
function clearError(store2, task, nowIso) {
  store2.setState(`${ERR_PREFIX}${task}`, "", nowIso);
}
function sessionHeaders(s) {
  return { jwt: s.jwt, deviceId: s.deviceId, userAgent: s.userAgent, cookie: s.cookie };
}
function runTask(deps, spec, judge2) {
  const late = deps.lateMs ?? 0;
  if (spec.skipIfLaterThanMs !== void 0 && late > spec.skipIfLaterThanMs) {
    const mins = Math.round(late / 6e4);
    const note3 = `错过太久（晚了 ${mins} 分钟，阈值 ${Math.round(spec.skipIfLaterThanMs / 6e4)} 分钟）→ 主动跳过`;
    recordError(deps.store, spec.task, note3, deps.nowIso);
    return { ok: true, skipped: true, note: note3 };
  }
  const session = loadSession(deps.store);
  if (!session) {
    const note3 = "还没有网页会话 —— 上面「换票」那一步说了原因";
    recordError(deps.store, spec.task, note3, deps.nowIso);
    return { ok: false, note: note3 };
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
    var note2 = res.error ?? "未知失败";
    if (res.env?.code === 90001) {
      const exp = jwtExpiry(deps.store, deps.nowIso);
      const clock = (iso) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "刚才";
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      note2 = exp !== null && exp.expired ? `凭据过期了（今天 ${clock(exp.atIso)} 就到期）—— 去「账号」页重新导入会话` : "这一环要的票没被认（不是账号被踢）—— 重新导入会话最快";
    }
    if (spec.okWhenError?.(note2)) {
      clearError(deps.store, spec.task, deps.nowIso);
      const plain = note2.replace(
        /^code=(-?\d+)(?: msg=(.*))?$/,
        (_m, _c, msg) => msg === void 0 || msg.trim() === "" ? "" : msg.trim()
      );
      return { ok: true, note: plain === "" ? "已经做过了" : `已经做过了（服务端说：${plain}）` };
    }
    recordError(deps.store, spec.task, note2, deps.nowIso);
    return { ok: false, note: note2 };
  }
  const verdict = judge2(res.env, res);
  if (verdict.snapshot !== void 0 && spec.stateKey) {
    deps.store.setState(spec.stateKey, JSON.stringify({ at: deps.nowIso, lateMs: late, value: verdict.snapshot }), deps.nowIso);
  }
  if (verdict.ok) clearError(deps.store, spec.task, deps.nowIso);
  else recordError(deps.store, spec.task, verdict.note, deps.nowIso);
  return { ok: verdict.ok, note: verdict.note };
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
  const pick2 = (k) => {
    const x = s[k];
    if (typeof x !== "string" || x.trim() === "") return void 0;
    return x.trim();
  };
  let cookie = pick2("cookie") ?? pick2("cookies") ?? "";
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
      jwt: pick2("jwt") ?? pick2("jwttoken") ?? pick2("JWT_TOKEN"),
      deviceId: pick2("deviceId") ?? pick2("deviceid"),
      userAgent: pick2("userAgent") ?? pick2("user-agent"),
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
function jwtExpiryOf(raw, nowIso) {
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  let payload;
  try {
    payload = fromUtf8(fromBase64(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  let exp;
  try {
    exp = JSON.parse(payload).exp;
  } catch {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const atMs = exp * 1e3;
  const now = Date.parse(nowIso);
  return {
    atIso: new Date(atMs).toISOString(),
    // `now` 坏了就当没过期（宁可不吓人）
    expired: Number.isNaN(now) ? false : now >= atMs
  };
}
function jwtExpiry(store2, nowIso) {
  return jwtExpiryOf(loadSession(store2)?.jwt ?? "", nowIso);
}
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
    lastCheckNote,
    jwtExpiry: jwtExpiry(store2, nowIso)
  };
}
function verifySession(deps) {
  const s = loadSession(deps.store);
  if (!s) {
    const note3 = "没有会话";
    deps.store.setState(STATE_LAST_CHECK, JSON.stringify({ at: deps.nowIso, ok: false, note: note3 }), deps.nowIso);
    return { ok: false, note: note3 };
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
  const note2 = ok ? `会话有效（${res.tookMs}ms）` : `会话可能已失效：${res.error ?? "未知失败"}`;
  deps.store.setState(STATE_LAST_CHECK, JSON.stringify({ at: deps.nowIso, ok, note: note2 }), deps.nowIso);
  return { ok, note: note2 };
}
function importSession(store2, s, nowIso) {
  saveSession(store2, s, nowIso);
  store2.setState(STATE_LAST_CHECK, JSON.stringify({ at: nowIso, ok: null, note: "刚导入，还没验" }), nowIso);
}
var STATE_BASE_URL = "mcloud.base_url";
function loadBaseUrl(store2) {
  const v = store2.getState(STATE_BASE_URL);
  if (!v) return "";
  const t = v.trim();
  if (!/^https?:\/\//.test(t)) return "";
  return t.replace(/\/+$/, "");
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

// src/mcloud/taskAccounts.ts
var SCHEDULED_TASKS = ["日常", "兑换", "直播"];
function taskAccountsKey(task) {
  return `mcloud.task.accounts.${task}`;
}
var DEFAULT_TASK_ACCOUNTS = { all: true, ids: [] };
var DEFAULT_TASK_ACCOUNTS_BY_TASK = {
  兑换: { all: false, ids: [] }
};
function defaultTaskAccounts(task) {
  const v = DEFAULT_TASK_ACCOUNTS_BY_TASK[task];
  return v ? { ...v } : { ...DEFAULT_TASK_ACCOUNTS };
}
function loadTaskAccounts(store2, task) {
  const raw = (store2.getState(taskAccountsKey(task)) ?? "").trim();
  if (raw === "") return defaultTaskAccounts(task);
  try {
    const v = JSON.parse(raw);
    const ids = Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === "string") : [];
    return { all: v.all === true, ids };
  } catch {
    return defaultTaskAccounts(task);
  }
}
function saveTaskAccounts(store2, task, v, nowIso) {
  store2.setState(taskAccountsKey(task), JSON.stringify({ all: v.all, ids: v.ids }), nowIso);
}
function resolveTaskAccounts(store2, task) {
  const sel = loadTaskAccounts(store2, task);
  const all = loadAccounts(store2);
  const enabled = all.filter((a) => a.disabled !== true);
  if (sel.all) return enabled.map((a) => a.id);
  const want = new Set(sel.ids);
  return enabled.filter((a) => want.has(a.id)).map((a) => a.id);
}
function taskAccountsView(store2, task) {
  const sel = loadTaskAccounts(store2, task);
  return {
    all: sel.all,
    picked: sel.ids,
    resolved: resolveTaskAccounts(store2, task),
    accounts: loadAccounts(store2).map((a) => ({
      id: a.id,
      label: a.label,
      disabled: a.disabled === true
    }))
  };
}

// src/mcloud/groups.ts
var GROUPS = [
  {
    id: "plugin",
    title: "插件自身",
    why: "不是云盘的事，是这个插件自己的健康检查与自检",
    order: 0
  },
  {
    id: "signin",
    title: "签到族",
    why: "无害且幂等：重复只会回「今日已签到」。可以放心点、可以补跑",
    order: 1
  },
  { id: "daily", title: "通知与趣玩", why: "记账类，幂等，漏了可以补", order: 2 },
  { id: "query", title: "查询与快照", why: "只读，点多少次都无所谓", order: 3 },
  {
    id: "activity",
    title: "活动与站票",
    why: "要**另一套凭据**（活动会话票，与 jwt 无关）—— 那份票不在，点了必然失败",
    order: 4
  },
  {
    id: "cloud-write",
    title: "要用网盘",
    // ⚠ 措辞改过（2026-10-14）：原先写的是"会往你的网盘里写文件……想清楚再点"，
    //    把**任务的目的**说成了风险。可任务的定义就是改服务端状态 ——
    //    "上传任务不上传文件"根本不是完成任务，"做任务"不落到服务端那也不叫做过。
    //    写文件不是副作用，**它就是这一组任务本身**。要提醒的只是"它会占用你的网盘"。
    why: "这一组任务**本身就是往网盘写**（上传文件 / 建外链 / 发邮件）—— 不是副作用，是它的内容。会在你的网盘里留下东西",
    order: 5
  },
  {
    id: "risky",
    title: "要花豆",
    // ⚠ 措辞改过（2026-10-14）：原先写的是"真扣 AI豆、不可回滚"，把**扣豆讲成了损失**。
    //    扣豆是**成交的标志** —— 扣了就是拿到奖品了，那正是用户要的结果。
    //    真正不可回滚的是**选择**（花掉豆换到的是不是你想要的那一件）；
    //    而"花了豆什么也没拿到"这一族里不会发生：不成交就不扣豆。
    why: "会花掉 AI豆去换东西。扣豆即成交（拿到了才算），不可回滚的是**选择**本身 —— 花之前先看清是哪一件",
    order: 6
  }
];
var TASK_META = [
  // ── 插件自身 ──
  { name: "selftest", title: "沙箱自检", group: "plugin", kind: "Query", risk: "none", missed: "catch-up", deps: [], batch: false, hidden: false, implemented: true, note: "密码学/UTF-8/base64/SQLite 都跑一遍" },
  { name: "diag", title: "调度健康", group: "plugin", kind: "Query", risk: "none", missed: "catch-up", deps: [], batch: false, hidden: false, implemented: true, note: "记录每次触发的调度延迟（面板 F-001 的那条测量）" },
  { name: "session-check", title: "会话体检", group: "plugin", kind: "Query", risk: "none", missed: "catch-up", deps: [], batch: false, hidden: false, implemented: true, note: "每天 7:50 先问一次服务端还认不认这份凭据" },
  // H5 换票（三步）：原生凭据 → `jwttoken`。**这是插件能不能用的前提** ——
  // 之前只能靠人手从浏览器抄票，而票 2 小时即废（过期时所有任务一起回 90001，
  // 看起来像"账号被踢了"）。现在自己换、自己续，鉴权细节见 mcloud/h5session.ts。
  { name: "session-refresh", title: "会话续期（H5 换票）", group: "plugin", kind: "Action", risk: "none", missed: "catch-up", deps: [], batch: false, hidden: false, implemented: true, evidence: "captured", note: "原生凭据 → 三步换 jwttoken，约 2 小时自动续；票新鲜时**一个请求都不发**" },
  // ── 签到族（8 条，全实现）──
  { name: "sign", title: "每日签到", group: "signin", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: true, hidden: false, implemented: true, evidence: "captured", note: "三段式：问状态 → 提交 → 回查（判据是回查）" },
  { name: "receive", title: "领取AI豆", group: "signin", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: true, hidden: false, implemented: true, evidence: "captured", note: "逐条独立；延期领取走另一口端点" },
  { name: "multiple", title: "签到翻倍", group: "signin", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: true, hidden: false, implemented: true, evidence: "captured", note: "每月一次机会 —— 门槛由插件自己判，条件不成立时一个字节都不发" },
  { name: "backup-gift", title: "备份好礼", group: "signin", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: true, hidden: false, implemented: true, evidence: "captured", note: "**GET 却是写**；两步：先问能不能领，能领才领" },
  { name: "revival", title: "用复活卡/回馈卡", group: "signin", kind: "Action", risk: "irreversible", missed: "skip", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "**不可逆** —— 晚超过 2 小时就不做" },
  { name: "prizes", title: "待领取奖品", group: "query", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured" },
  { name: "task-list", title: "任务清单", group: "query", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured" },
  { name: "cloud-snapshot", title: "AI豆余额快照", group: "query", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "只取第一页；一页装满会如实说可能还有下一页" },
  // ── 通知与趣玩（未实现）──
  // 它用**签到页那张票**（`SessionRecipe::SignInPage`）—— 就是本插件手里已有的会话，
  // 所以「只依赖 jwt」这条是对的。`getTaskInfo` 有实拍；`reward` 只实拍到成功那一枪。
  { name: "exchange-list", title: "兑换清单（只看）", group: "activity", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "逐件判能不能兑；**不碰余额、不碰滑块、不下单**" },
  { name: "app-task-matrix", title: "App 任务矩阵（只看）", group: "signin", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "8 个 group 一次读一个；只读，一个字节都不写" },
  { name: "notice", title: "开启通知领AI豆", group: "daily", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: true, hidden: false, implemented: true, evidence: "partial", note: "有手动前置（判不出来，见 notice.ts 文件头 ③）；reward 不报到账数 ⇒ 靠下一轮回查" },
  // ⚠️ 2026-10-14 第三次更正：**换票那一步现在有了**（通用机制，见 mcloud/h5session.ts
  //    与 sessionExchange.ts：原生凭据 → querySpecTokenV2 → 时间戳 → tyrzLogin → jwttoken）。
  //    所以"换票做不了"这句话**不再成立** —— 我连着两轮把"我没有"说成了"不能做"：
  //      ① 「实拍归档里没有」→ 那是**实拍**没有，**实现**有（Rust 侧那三百行）
  //      ② 「⇒ 现在做不了」 → 做不到的只是"照实拍逐字复刻"，而通用那套是**照实现**复刻的
  //    这一条真正缺的是**它自己那一页的换票参数**（`marketName` / `sourceId`）——
  //    签到页与 msgpushon 页有实拍，这一页没有。缺参数 ≠ 缺机制。
  { name: "fun-ai", title: "趣玩AI抽奖", group: "activity", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["activity-token"], batch: true, hidden: false, implemented: false, evidence: "no-ticket", note: "换票那步没抓到 ⇒ 做不了" },
  // 更正：整条链在 `/ycloud/msgPushOn/` 下、要**另一张票**（marketName=msgpushon /
  // sourceId=1062）。`task/status` 有实拍，`task/obtain` **零样本** ——
  // "什么值该做什么"仍是旧项目口径，一条都没被服务端证实过。
  // ⚠️ 2026-10-14 修正认知：这一族与 `notice` **不是同一件事**（域/配方/端点全不同，
  //    见 tasks/msgPush.ts 的文件头对照表）。两步：问状态（只读）+ 领（写）。
  { name: "msg-push", title: "消息推送奖励", group: "activity", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "两步：问状态 + 领（`secondTaskStatus===2` 才领）。⚠ `pushOn===0` 与首次奖励都要用户去 App 手动" },
  { name: "msg-push-obtain", title: "消息推送奖励（领）", group: "activity", kind: "Action", risk: "ledger", missed: "skip", deps: ["jwt"], batch: false, hidden: true, implemented: true, evidence: "captured", note: "上一步说可领才发" },
  // ── 活动与站票（未实现）──
  { name: "cloud-phone-redpack", title: "红包派对", group: "activity", kind: "Action", risk: "ledger", missed: "catch-up", deps: ["activity-token"], batch: false, hidden: false, implemented: false, note: "⚠ 读到没见过的状态码时**刻意不发写**（旧 TS 会发）" },
  { name: "play-ai-special", title: "拍拍盘点", group: "activity", kind: "Query", risk: "none", missed: "catch-up", deps: ["jwt", "activity-token"], batch: false, hidden: false, implemented: false },
  // ⚠️ 这条我**改过两次口径**，第三次才对：
  //   ① 先说「需要 WebSocket ⇒ 做不了」✗
  //   ② 再说「两个来源地位相同（WS 弹幕 / 小红书主页），少一条腿不等于走不了」——
  //      这一半是对的：小红书主页确实只是一次**公开 GET**
  //   ③ 但源码里还有一句我漏了：**口令（codes）不是可选项** ——
  //      「小红书那条口令**没法自动化**（那边**无法鉴权**）」，只能由**人给**
  //   ⇒ 能自动的是「抓主页」，不能自动的是「口令本身」。这是两件事。
  //   所以拦路石不是 WS，是**缺一个输入口**（让人把口令填进来）。
  //
  // 2026-10-13：**只读那一半已实现**（用户选的方案：加口令输入框 + 只做「抓主页 + 列出口令」）。
  // 抓主页走的是原项目 `xiaohongshu.ts` 的公开 GET + 逐字移植的提取器（41 条黄金向量守着）。
  // 领小红花那一步（写、会入群足迹）**仍然没做** —— 所以 risk 维持 `ledger` 不变。
  { name: "live-room", title: "直播口令（只看）", group: "activity", kind: "Query", risk: "none", missed: "catch-up", deps: [], batch: false, hidden: false, implemented: true, evidence: "partial", note: "抓口令发布方的**公开**主页 + 列出口令（**不需要凭据**）；口令要人给（那边无法鉴权）" },
  // 门（直播日程）：只读地问服务端「今天开播了吗 / 下一场几点」。
  // ⚠ 它**不需要**会话（云盘那套），要的是**原生凭据**（换直播侧 JWT 用）——
  //   所以 deps 是 ['auth'] 而不是 ['jwt']。缺凭据时它如实失败并说清缺什么。
  // 证据等级 `captured`：mcloud 那边这一段是**实证**的（只读探针主动走过一遍，
  //   出处 `docs/capture/app-live-redflower-samples.txt` §5.3），与 WS 那半段分开标。
  { name: "live-gate", title: "直播日程（门）", group: "activity", kind: "Query", risk: "none", missed: "catch-up", deps: ["basic"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "只读：①②换直播侧 JWT（SSO 只活几分钟 ⇒ 两发同一次调用）+ ③两个页签各一发。结果落**口令池**（日程/门/场次）与界面读数" },
  // 写那半。**默认关**（`mcloud.live.claim_enabled`），开关与二次确认都在插件界面上。
  // 它虽然记账，但**基本幂等**：同一条口令再领一次回 `200112`（已兑换过），不会重复发奖。
  // 所以 risk 是 `ledger` 而不是 `irreversible`。
  { name: "live-listen", title: "听弹幕口令（只读）", group: "activity", kind: "Query", risk: "none", missed: "catch-up", deps: ["basic"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "真机验过：SockJS 握手 + PROVISION + 心跳（15s 一拍）+ ack + 弹幕文本进池（来源 danmaku）。一次调用读 ~1.6 秒（面板预算 2000ms），窗口默认 10 分钟；门关着时**一个请求都不发**" },
  // 定时器：**只算时刻、零服务端请求**（mcloud 的 `live_auto`）。
  // 它和听弹幕那条链的分工写在 liveAuto.ts 模块头：定时器负责**叫醒**，
  // 链自己负责"窗口到点 → 收尾 → 下一拍重走门"。
  { name: "live-auto", title: "直播自动定时", group: "activity", kind: "Query", risk: "none", missed: "skip", deps: ["basic"], batch: false, hidden: false, implemented: true, evidence: "captured", note: '照 mcloud 的 `live_auto`：时刻 = **最早的「下一场」+ 1 小时**（那一小时留给主播发口令）；每 5 分钟重算一次、**一个服务端请求都不发**。听弹幕那条链被判"门关着"时就睡到那一刻（原来固定 5 分钟 ⇒ 一天白问 288 次门）。⚠ 面板的 cron 不能在运行时改表达式 ⇒ 精度最坏晚 5 分钟' },
  { name: "live-draw", title: "领小红花（写）", group: "activity", kind: "Action", risk: "ledger", missed: "skip", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "partial", note: "六步链 9+N 个请求，一次调用一步；**默认关**。同口令重领回 200112 ⇒ 基本幂等。⚠ 请求头形状未在真账号上验过" },
  // ── 要用网盘（未实现；原因见各条的 note，**不是**"它会写网盘"）──
  // ⚠ 未实现 —— 而理由**不是**"它会写网盘"（那是它的内容，不是风险）。
  //    真理由：App 原生族（上传 / 分享 / 固定入口）的报文形状还没抓全。
  // ✅ 2026-10-14 实现（判据层纯函数 + 动作层一枪一步）。
  //    ⚠ 与 `app-task-matrix` **不是同一个 code**：只读那半填读数，这半消费读数去行动。
  //    ⚠ 传上去的文件**必须收尾**（移回收站）—— 不收，用户网盘里就会慢慢堆垃圾。
  //    ⚠ `task/click` **不可回滚** ⇒ 同一轮不重发；`batchTrash` **不许发空 fileIds**。
  { name: "app-task", title: "App 任务（做任务）", group: "activity", kind: "Action", risk: "write-cloud", missed: "skip", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "partial", note: "一枪一步：传文件（需要时）→ `task/click`（不可回滚，同一轮不重发）→ 收尾移回收站。判据是纯函数（106/113/522 与 beiyong1 两道门）；矩阵得先跑过" },
  // ⚠ 实现时两处**照抓包、别照 TS**：
  //   ① `receiveTaskExpansion` 发的是**裸 GET**，不许写 `?acceptDate=`。
  //      抓包 §3.6.6 实测：H5 传的是 `{acceptDate: t.acceptDate}`，而两个真实账号的
  //      `receiveList[]` 里**根本没有 acceptDate 这个字段**（只有 cloudNum/cloudType）
  //      ⇒ 值是 undefined ⇒ axios 把整个键丢掉 ⇒ 线上是**一个查询参数都没有**。
  //      多一个空参数就是**另一个请求**。（`receive` 那条同坑，那边已经照做了。）
  //   ② 云朵与「云盘专属 AI豆」是**同一个东西的两个名字**（2026-07-31 按 1:1 改名），
  //      不是两种货币 —— 别把它们当两笔账记。
  // ✅ 2026-10-14 实现：读状态 → （**严格**读到 curMonthBackup===false 才）传文件触发备份
  //    → 裸 GET 领云朵。⚠ 领那枪缺成功样本（两个测试号本月都已领过，见 app_signin.rs:28），
  //    所以成功形状没被实拍验过 —— 实现照源码逐字，不假装验过。
  //    ⚠ 与 mcloud 一处刻意分歧：它只在 `curMonthTaskRecordCount > 0` 才发领那一枪；
  //    本插件**不判**（用户定的口径）：那枪只读、成了有云朵、败了什么也不花 ⇒ 直接发。
  //    ⚠ 领那一枪**必须带 `?acceptDate=`**（值可空，键必须在）—— 真机实测：裸 GET 回 404。
  //      抓包 §3.6.6 说"要裸 GET"那条被真机推翻了，见 F-021（抓包记的是"客户端发了什么"，
  //      而那个请求本身是失败的）。
  { name: "task-expansion", title: "任务拓展", group: "cloud-write", kind: "Action", risk: "write-cloud", missed: "skip", deps: ["jwt"], batch: false, hidden: false, implemented: true, evidence: "partial", note: "三件：读状态 → 传一个文件触发本月备份 → 领云朵（**裸 GET**）。传上去的文件**不留 id、不删**（删了就是删用户的东西）" },
  // ❌ 2026-10-14 真机探过：**整族 404/405**，且**不是**签名或 marketName 的问题
  //    （带签名/不带签名、两个 marketName 各试一遍，读数一字不差；与 mcloud 2026-09-25
  //    的读数逐条一致）。405 说明网关**认得** `/market/rabactive/ai/image/` 这个 location
  //    但不服务该组合；`image/*` 那一支连 location 都没有。仍不足以判定"活动下线"
  //    还是"方法不对" ⇒ **不据此改路径**（那些字面量来自能跑的那份旧 TS）。
  //    所以**默认不开**：一跑就 404 的任务开着只会烧请求并让人以为"跑过了"。见 F-022。
  { name: "ai-avatar", title: "AI 头像生成与抽奖", group: "activity", kind: "Action", risk: "write-cloud", missed: "skip", deps: ["basic+jwt"], batch: false, hidden: true, implemented: false, evidence: "dead", note: "八口全在 `/market/rabactive/*`，今天真机 404/405（已排除签名与 marketName）⇒ 默认关。恢复条件与读数见 F-022" },
  // ── 高风险（未实现）──
  // ✅ 2026-10-14 实现并**真机跑通**（50 豆换到「移动云盘100G云空间月卡」，服务端回 oid，
  //    余额 9238 → 9188 正好少 50）。
  //
  // 口径（用户定的）：**优先发出去** —— 清单判据说不能兑、余额看着不够，都**照样发**
  // （那两处是本地估算，服务端仍可能放行；失败不扣豆）。
  // ⚠ 但**滑块**不属这一类：offset 算错那一枪**不可能成功**（回 514、不成交也不扣豆），
  //    所以算不出就不发 —— 那不是"少一次机会"，是"多一次白打"。
  { name: "exchange", title: "兑换奖品", group: "risky", kind: "Action", risk: "spend", missed: "skip", deps: ["jwt", "slider"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "枪序：清单 → 余额 → 预热×2 → 取滑块本地解 → 下单 → 查余额差。**成交判据是余额差**（服务端没有幂等，那句话不算数）；滑块算不出就不发" },
  // ⚠️ 2026-10-14 更正一处**我口头说过的错话**：我曾讲这条"会换掉现有授权"——
  //    那句话**没有出处**。`auth_refresh.rs` 的叙述是「**续期**」：刷新返回一个自带
  //    30 天有效期的新 token，并被编进后续请求的 `Authorization`；而**旧凭据会不会被
  //    这一枪作废，没有任何一处说过**（我把它当成了"替换"）。
  //    另外它在本插件里是 `implemented: false` —— **根本没实装**，
  //    所以"我不替你动"这个说法本身就站不住（当时没有可动的东西）。
  //    ⚠ `risk` 暂时维持 `irreversible`（风险档保守取值的默认），
  //    但这一档的**依据同样缺样本** —— 真要落地前先把"旧 token 是否仍可用"测出来。
  // ✅ 2026-10-14 实现。**一个字段都不用用户给**：手机号/端别在 `Authorization` 里解出来，
  //    `userDomainId` 在 jwttoken 的 `payload.sub` 里。判据照 mcloud 的 `decide`（默认提前 10 天）。
  // ⚠ `risk` 从 `spend` 改成 `none`：**续期不花任何豆**，原先那一档没有依据
  //    （我早先说它"会换掉现有授权"，那句没有出处）。真机实测过：
  //    续期后**旧凭据仍然可用**（两枚都 200），所以它也不是 `irreversible`。
  { name: "auth-refresh", title: "凭据续期", group: "daily", kind: "Action", risk: "none", missed: "skip", deps: ["basic+jwt"], batch: false, hidden: false, implemented: true, evidence: "captured", note: "离过期还远时**一个请求都不发**；续出的是一枚**全新的** token（30 天），不是把旧的延长。真机验过：旧凭据不会因此失效" }
];
function groupView(store2) {
  const recent = store2.recentRuns(200);
  const byTask = /* @__PURE__ */ new Map();
  for (const r of recent) {
    const t = String(r.task ?? "");
    if (!t) continue;
    const list = byTask.get(t) ?? [];
    if (list.length < 3) {
      list.push({
        firedAt: String(r.fired_at ?? ""),
        ok: Number(r.ok ?? 0) === 1,
        note: String(r.note ?? ""),
        lateMs: Number(r.late_ms ?? 0)
      });
    }
    byTask.set(t, list);
  }
  const groups = GROUPS.map((g) => {
    const tasks = TASK_META.filter((t) => t.group === g.id).map((t) => ({
      ...t,
      lastError: store2.getState(`mcloud.last_error.${t.name}`) ?? "",
      recent: byTask.get(t.name) ?? []
    }));
    return {
      ...g,
      tasks,
      implemented: tasks.filter((t) => t.implemented).length,
      total: tasks.length
    };
  });
  return {
    groups,
    totals: {
      tasks: TASK_META.length,
      implemented: TASK_META.filter((t) => t.implemented).length,
      risky: TASK_META.filter((t) => t.risk === "spend" || t.risk === "irreversible").length
    }
  };
}

// src/mcloud/caps.ts
function sandboxCaps() {
  const g = globalThis;
  let applyOk = "ok";
  try {
    String.fromCharCode.apply(null, new Array(1e5).fill(65));
  } catch (e) {
    applyOk = e instanceof Error ? `抛(${e.constructor.name})` : "抛";
  }
  return [
    `BigInt=${typeof g.BigInt}`,
    `DataView=${typeof g.DataView}`,
    `10万字符apply=${applyOk}`
  ].join(" ");
}
function hasBigInt() {
  return typeof globalThis.BigInt === "function";
}

// src/store/scoped.ts
var WRAPPED = Symbol.for("__mcloud_scoped_store__");
var RAW = Symbol.for("__mcloud_raw_store__");
var ACCT = Symbol.for("__mcloud_scoped_account__");
function scopedAccountOf(store2) {
  const v = store2[ACCT];
  return typeof v === "string" && v !== "" ? v : void 0;
}
function rawStoreOf(s) {
  const raw = s[RAW];
  return raw ?? s;
}
function scoped(base, acctId) {
  if (base[WRAPPED] === true) {
    throw new Error(
      "store 已经被 scoped() 包过一次了 —— 双重包装会让 `mcloud.acct.*` 也去查登记表然后抛错。"
    );
  }
  const wrapped = {
    ...base,
    getState: (key) => routeGet(base, key, acctId),
    setState: (key, value, nowIso) => routeSet(base, key, value, nowIso, acctId)
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
  if (acctId !== void 0 && acctId !== "") {
    Object.defineProperty(wrapped, ACCT, { value: acctId, enumerable: false });
  }
  Object.defineProperty(wrapped, RAW, { value: base, enumerable: false });
  return wrapped;
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
function aes128DecryptBlock(rk, block) {
  if (block.length !== 16) throw new Error(`AES: 块必须是 16 字节（得到 ${block.length}）`);
  const s = new Uint8Array(block);
  const addRoundKey = (round) => {
    for (let i = 0; i < 16; i += 1) s[i] = s[i] ^ rk[round * 16 + i];
  };
  const invSubBytes = () => {
    for (let i = 0; i < 16; i += 1) s[i] = INV_SBOX[s[i]];
  };
  const invShiftRows = () => {
    for (let r = 1; r < 4; r += 1) {
      const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
      for (let c = 0; c < 4; c += 1) s[r + 4 * c] = row[(c - r + 4) % 4];
    }
  };
  const invMixColumns = () => {
    for (let c = 0; c < 4; c += 1) {
      const i = 4 * c;
      const a0 = s[i];
      const a1 = s[i + 1];
      const a2 = s[i + 2];
      const a3 = s[i + 3];
      s[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
      s[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
      s[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
      s[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
    }
  };
  addRoundKey(10);
  for (let round = 9; round >= 1; round -= 1) {
    invShiftRows();
    invSubBytes();
    addRoundKey(round);
    invMixColumns();
  }
  invShiftRows();
  invSubBytes();
  addRoundKey(0);
  return s;
}
function pkcs7Unpad(data) {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error(`AES: 密文长度不是 16 的整数倍（得到 ${data.length}）`);
  }
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) throw new Error(`AES: PKCS7 填充长度非法（${pad}）`);
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) throw new Error("AES: PKCS7 填充字节不一致（密钥或模式不对）");
  }
  return data.subarray(0, data.length - pad);
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
function aes128CbcDecrypt(key, iv, ct) {
  if (iv.length !== 16) throw new Error("AES: IV 必须是 16 字节");
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new Error(`AES: 密文必须是 16 的整数倍（得到 ${ct.length}）`);
  }
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(ct.length);
  let prev = new Uint8Array(iv);
  for (let off = 0; off < ct.length; off += 16) {
    const blk = ct.subarray(off, off + 16);
    const plain = aes128DecryptBlock(rk, blk);
    for (let i = 0; i < 16; i += 1) out[off + i] = plain[i] ^ prev[i];
    prev = new Uint8Array(blk);
  }
  return out;
}
function aes128EcbDecrypt(key, ct) {
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new Error(`AES: 密文必须是 16 的整数倍（得到 ${ct.length}）`);
  }
  const rk = aes128KeyExpansion(key);
  const out = new Uint8Array(ct.length);
  for (let off = 0; off < ct.length; off += 16) {
    out.set(aes128DecryptBlock(rk, ct.subarray(off, off + 16)), off);
  }
  return out;
}
function aes128EcbEncrypt(key, msg) {
  const rk = aes128KeyExpansion(key);
  const padded = pkcs7Pad(msg, 16);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    out.set(aes128EncryptBlock(rk, padded.subarray(off, off + 16)), off);
  }
  return out;
}
function aesEcbPkcs7EncryptHex(key, message) {
  return toHex(aes128EcbEncrypt(fitKey16(key), utf8(message)));
}
function encryptWithDynamicIv(key, iv, plaintext) {
  const ct = aes128CbcEncrypt(key, iv, pkcs7Pad(utf8(plaintext), 16));
  const joined = new Uint8Array(16 + ct.length);
  joined.set(iv);
  joined.set(ct, 16);
  return toBase64(joined);
}
function decryptWithDynamicIv(key, payloadB64) {
  const raw = fromBase64(payloadB64);
  if (raw.length < 32) throw new Error("AES: 动态 IV 载荷太短（至少 IV + 一个块）");
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  return fromUtf8(pkcs7Unpad(aes128CbcDecrypt(key, iv, ct)));
}
function aesEcbPkcs7DecryptHex(key, ciphertextHex) {
  const ct = fromHex(ciphertextHex.trim());
  return fromUtf8(pkcs7Unpad(aes128EcbDecrypt(fitKey16(key), ct)));
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
  const bits2 = derRead(der, algo.end);
  if (bits2.tag !== 3) throw new Error("RSA: BIT STRING 缺失");
  if (der[bits2.start] !== 0) throw new Error("RSA: BIT STRING 有未用位");
  const inner = derRead(der, bits2.start + 1);
  if (inner.tag !== 48) throw new Error("RSA: 公钥不是 SEQUENCE");
  const intAt3 = (p) => {
    const it = derRead(der, p);
    if (it.tag !== 2) throw new Error("RSA: 期望 INTEGER");
    let v = 0n;
    for (let i = it.start; i < it.end; i += 1) v = v << 8n | BigInt(der[i]);
    return { v, next: it.end };
  };
  const nn = intAt3(inner.start);
  const ee = intAt3(nn.next);
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
var MSG_PUSH_ON_RECIPE = {
  toSourceId: "001005",
  marketName: "msgpushon",
  sourceId: "1062",
  h5AppId: void 0,
  pagePath: "openNoticeGift",
  portalPage: "hcyview",
  targetSourceId: void 0
};
var FALLBACK_RECIPE = "sign-in";
function recipeParams(recipe) {
  return recipe === "msg-push-on" ? MSG_PUSH_ON_RECIPE : SIGN_IN_RECIPE;
}
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
  const scopedId = scopedAccountOf(store2);
  if (scopedId !== void 0) {
    const one = loadAccounts(store2).find((a) => a.id === scopedId);
    if (one !== void 0) return one.auth;
  }
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
function authStatus(store2) {
  const v = store2.getState(STATE_AUTH);
  if (!v) return { present: false };
  return { present: true, fingerprint: authFingerprint(sha256Hex(v)), length: v.length };
}
function scopedKey(base, store2, recipe) {
  const acct = scopedAccountOf(store2) ?? currentAccount(store2)?.id;
  if (acct === void 0 && recipe === FALLBACK_RECIPE) return base;
  return `${base}.${acct ?? "default"}.${recipe}`;
}
function jwtUserDomainId(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  let payload;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    payload = JSON.parse(fromUtf8(fromBase64(padded)));
  } catch {
    return null;
  }
  const top = payload["userDomainId"];
  if (typeof top === "string" && top !== "") return top;
  const sub = payload["sub"];
  if (typeof sub === "string" && sub.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(sub);
      const v = inner["userDomainId"];
      if (typeof v === "string" && v !== "") return v;
    } catch {
    }
  }
  return null;
}
function backfillDomainFromJwt(store2, jwt, nowIso) {
  const cur = currentAccount(store2);
  if (cur === void 0 || (cur.userDomainId ?? "") !== "") return null;
  const dom = jwtUserDomainId(jwt);
  if (dom === null) return null;
  setAccountDomain(store2, cur.id, dom, nowIso);
  return dom;
}
function jwtKey(store2, recipe = FALLBACK_RECIPE) {
  return scopedKey(STATE_JWT, store2, recipe);
}
function exchangeKey(store2, recipe = FALLBACK_RECIPE) {
  return scopedKey(STATE_EXCHANGE, store2, recipe);
}
function loadExchange(store2, recipe = FALLBACK_RECIPE) {
  return parse(store2.getState(exchangeKey(store2, recipe)));
}
function loadJwt(store2, recipe = FALLBACK_RECIPE) {
  return parse(store2.getState(jwtKey(store2, recipe)));
}
function jwtFresh(store2, nowMs, recipe = FALLBACK_RECIPE) {
  const r = loadJwt(store2, recipe);
  if (!r) return false;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && nowMs - at < JWT_TTL_MS;
}
function startExchange(store2, raw, nowIso, recipe = FALLBACK_RECIPE) {
  const norm = normalizeAuthorization(raw);
  if (!norm.ok || norm.value === void 0) return { ok: false, error: norm.error };
  const fingerprint = authFingerprint(sha256Hex(norm.value));
  store2.setState(STATE_AUTH, norm.value, nowIso);
  store2.setState(exchangeKey(store2, recipe), JSON.stringify({
    step: "spec-token",
    recipe,
    fingerprint,
    startedAt: nowIso
  }), nowIso);
  return { ok: true, fingerprint };
}
function clearAuth(store2, nowIso) {
  store2.setState(STATE_AUTH, "", nowIso);
  store2.setState(exchangeKey(store2), "", nowIso);
  store2.setState(jwtKey(store2), "", nowIso);
}
function runExchangeStep(deps, recipe = FALLBACK_RECIPE) {
  const st = loadExchange(deps.store, recipe);
  const auth = loadAuthRaw(deps.store) || null;
  if (!st || st.step === "done" || !auth) {
    return { ok: true, note: "今天不用换票", done: true };
  }
  const rp = recipeParams(st.recipe ?? recipe);
  const finish3 = (s, ok, note2) => {
    s.step = "done";
    s.finishedAt = deps.nowIso;
    s.ok = ok;
    s.note = note2;
    delete s.ssoToken;
    delete s.ts;
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(s), deps.nowIso);
    return { ok, note: note2, done: true };
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
    return finish3(st, true, `④ 换到 deviceId（${got.deviceId.length} 字符，B 开头）—— 领取类接口现在能用了`);
  }
  if (st.step === "spec-token") {
    const res2 = callRawText(deps.transport, specTokenRequest(rp, auth, deps.baseUrl));
    if (!res2.ok) return failStep(deps, st, `① 换 SSO token 失败：${res2.error ?? "未知失败"}`);
    const p2 = parseSsoToken(res2.text);
    if (!p2.ok || p2.value === void 0) return failStep(deps, st, `① ${p2.error}`);
    st.ssoToken = p2.value;
    st.referer = pageUrl(rp, p2.value);
    st.step = "timestamp";
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
    return { ok: true, note: "① 换到 SSO token（**不缓存**，下一步立刻用）", done: false };
  }
  if (st.step === "timestamp") {
    const res2 = callRawText(deps.transport, timestampRequest(rp, st.referer ?? "", deps.baseUrl));
    if (!res2.ok) return failStep(deps, st, `② 取时间戳失败：${res2.error ?? "未知失败"}`);
    const p2 = parseServerTimestamp(res2.text);
    if (!p2.ok || p2.value === void 0) return failStep(deps, st, `② ${p2.error}`);
    st.ssoToken = st.ssoToken ?? "";
    st.ts = p2.value;
    st.step = "tyrz-login";
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
    return { ok: true, note: `② 服务端时间戳 ${p2.value}（**必须用它**，本地时钟偏一点就是 401）`, done: false };
  }
  const ts = st.ts;
  if (ts === void 0 || !st.ssoToken) {
    return finish3(st, false, "③ 前置状态丢了（SSO token 或时间戳）—— SSO token 不缓存，得从头再来");
  }
  const res = callRawText(
    deps.transport,
    tyrzLoginRequest(rp, st.ssoToken, makeSign(ts), st.referer ?? "", deps.baseUrl)
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
  deps.store.setState(jwtKey(deps.store, recipe), JSON.stringify(rec), deps.nowIso);
  backfillDomainFromJwt(deps.store, p.value.jwt, deps.nowIso);
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
    deps.store.setState(exchangeKey(deps.store, recipe), JSON.stringify(st), deps.nowIso);
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
  return finish3(
    st,
    true,
    `③ 换到 jwttoken（${p.value.jwt.length} 字符${p.value.mobile ? `，回显 ${maskMobile(p.value.mobile)}` : ""}）—— 约 ${Math.round(JWT_TTL_MS / 6e4)} 分钟后该续` + // ⚠ 主动说出"缺 deviceId"：不说的话，用户第一次用 `receive` 会看到
    // 「活动太火爆啦」，然后以为过会儿就好 —— 而它其实永远不会好（是参数问题）。
    ((sess?.deviceId ?? "") === "" && (loadSession(deps.store)?.deviceId ?? "") === "" ? "。⚠ 这份会话**没有 `deviceId`**：领取类接口（receive）会回 615，而它的文案是「活动太火爆啦」—— 那不是在限流，是缺参数。要修：在会话 JSON 里带上 `deviceId`（H5 那一份是 `B` + 88 字符 base64）" : "")
  );
}
function failStep(deps, st, note2) {
  st.step = "done";
  st.finishedAt = deps.nowIso;
  st.ok = false;
  st.note = note2;
  delete st.ssoToken;
  delete st.ts;
  deps.store.setState(exchangeKey(deps.store, st.recipe ?? FALLBACK_RECIPE), JSON.stringify(st), deps.nowIso);
  return { ok: false, note: note2, done: true };
}
var RETRY_AFTER_MS = 30 * 60 * 1e3;
function needExchange(store2, nowMs, recipe = FALLBACK_RECIPE) {
  if (loadAuthRaw(store2) === "") return false;
  if (jwtFresh(store2, nowMs, recipe)) return false;
  const st = loadExchange(store2, recipe);
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
  const domain = userDomainId === "" ? "" : `"userDomainId":"${escapeJsonString(userDomainId)}",`;
  const body = `{${domain}"clientType":"${escapeJsonString(clientTypeFor(platform))}"}`;
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
    return { ok: false, error: `回来的不是 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const code = v.code;
  const codeOk = typeof code === "string" && (code === "0000" || code === "0") || typeof code === "number" && code === 0;
  const success = typeof v.success === "boolean" ? v.success : codeOk;
  if (!success || !codeOk) {
    const msg = String(v.message ?? v.msg ?? "");
    const c = String(code ?? "");
    if (c === "05050009") return { ok: false, error: "这个号已经失效了 —— 重新登录一次" };
    return { ok: false, error: msg === "" ? "服务端拒绝了这一枪" : msg };
  }
  const data = v.data;
  if (!data || typeof data !== "object") return { ok: false, error: "没拿到新的登录信息" };
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
  if (!seg) return { ok: false, error: "存的那串登录信息读不出来 —— 重新登录一次" };
  if (seg.phone === "") return { ok: false, error: "那串登录信息里没有手机号 —— 重新登录一次" };
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
  if (!seg) return { ok: false, error: "服务端回来的东西读不出来" };
  if (seg.platform === "" || seg.phone === "" || seg.token === "") {
    return { ok: false, error: "服务端回来的东西是空的，没存" };
  }
  return { ok: true };
}
var STATE_LAST = "mcloud.auth.refresh.last";
function runAuthRefresh(deps, force = false, leadDays = DEFAULT_LEAD_DAYS, target = {}) {
  const raw = target.auth ?? loadAuthRaw(deps.store);
  if (raw === "") {
    return { ok: true, skipped: true, note: "还没有账号 —— 先加一个" };
  }
  const nowMs = Date.parse(deps.nowIso);
  const expireMs = credentialExpireMs(raw);
  const decision = force ? "needed" : decide(expireMs, nowMs, leadDays);
  if (decision === "manual-only") {
    return {
      ok: true,
      skipped: true,
      note: "这条存的东西读不出来 —— 要重新登录一次"
    };
  }
  if (decision === "not-yet") {
    const d2 = daysLeft(expireMs, nowMs);
    return {
      ok: true,
      skipped: true,
      note: `还有 ${d2 ?? "?"} 天，不用刷`
    };
  }
  const jwt = loadJwt(deps.store);
  const targetDomain = target.accountId === void 0 ? null : loadAccounts(deps.store).find((a) => a.id === target.accountId)?.userDomainId ?? null;
  const domain = targetDomain ?? currentAccountDomain(deps.store) ?? (jwt ? jwtUserDomainId(jwt.jwt) : null) ?? "";
  const seg = parseAuthorization(raw);
  const req = refreshRequest(raw, domain, seg.platform);
  const res = callRawText(deps.transport, req);
  if (!res.ok) return { ok: false, note: `没刷成：${res.error ?? "连不上"}` };
  const parsed = parseRefresh(res.text);
  if (!parsed.ok || !parsed.result) return { ok: false, note: `没刷成：${parsed.error ?? "看不懂回来的东西"}` };
  const applied = applyRefreshResult(raw, parsed.result);
  if (!applied.ok) return { ok: false, note: `没刷成：${applied.error}` };
  const usable2 = assertUsable(applied.raw);
  if (!usable2.ok) return { ok: false, note: `没存下来：${usable2.error}` };
  const who = target.accountId !== void 0 ? loadAccounts(deps.store).find((a) => a.id === target.accountId) : currentAccount(deps.store);
  if (who !== void 0) setAccountAuth(deps.store, who.id, applied.raw, deps.nowIso);
  else deps.store.setState(STATE_AUTH, applied.raw, deps.nowIso);
  deps.store.setState(STATE_LAST, JSON.stringify({
    at: deps.nowIso,
    expireSeconds: parsed.result.expireSeconds ?? null,
    oldFingerprint: seg.token.slice(-6),
    newFingerprint: parsed.result.token.slice(-6)
  }), deps.nowIso);
  startExchange(deps.store, applied.raw, deps.nowIso);
  const newExpire = tokenExpireMs(parsed.result.token);
  const d = daysLeft(newExpire, nowMs);
  return {
    ok: true,
    raw: applied.raw,
    note: d === void 0 ? "已续期" : `已续期，还能用 ${d} 天`
  };
}

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
function timingReading(nowMs, leadMs = FIRE_LEAD_MS) {
  const w = planWindowWait(nowMs);
  const f = planFireWait(nowMs, leadMs);
  const hourAt = hourStartMs(nowMs) + HOUR_MS;
  return {
    hourAt: new Date(hourAt).toISOString(),
    msToHour: hourAt - nowMs,
    inWindow: !w.needed,
    msToWindow: w.ms,
    msToFire: f.ms,
    windowSecond: WINDOW_SECOND,
    leadMs
  };
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
  if (p.limit === void 0) return "limit-missing";
  if (p.limit === LIMIT_AVAILABLE) {
    if (p.minRemainderCount === 0) return "min-remainder-zero";
    if (p.count !== void 0 && p.count <= 0) return "sold-out";
    if (p.dailyRemainderCount !== void 0 && p.dailyRemainderCount <= 0) return "daily-empty";
  }
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
var VERDICT_TEXT = {
  ok: "可兑",
  tomorrow: "明日再来",
  exchanged: "本件本月已兑",
  "group-exchanged": "这一组本月兑过了",
  "limit-missing": "移动云盘没给可兑状态",
  "min-remainder-zero": "已抢光",
  "sold-out": "池子已兑完",
  "daily-empty": "今日已抢完",
  offline: "已下架",
  "month-limit": "本月额度可能已用完",
  unknown: "移动云盘没给可兑状态"
};
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
    dailyCount: asInt(o.dailyCount ?? o.daily_count),
    minRemainderCount: asInt(o.minRemainderCount ?? o.min_remainder_count),
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
      savePickCache(deps.store, prizes, deps.nowIso);
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
function readExchangeList(store2) {
  const raw = store2.getState(STATE_LIST);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
var STATE_PICK = "mcloud.exchangelist.pick";
function toPickItems(prizes) {
  const out = [];
  for (const p of prizes) {
    const name = p.name?.trim();
    if (name === void 0 || name === "") continue;
    const item = { name, verdict: verdictOf(p) };
    if (p.prizeId !== void 0) item.id = p.prizeId;
    if (p.groupId !== void 0) item.groupId = p.groupId;
    if (p.price !== void 0) item.price = p.price;
    if (p.dailyRemainderCount !== void 0) item.remain = p.dailyRemainderCount;
    if (p.count !== void 0) item.count = p.count;
    if (p.totalCount !== void 0) item.totalCount = p.totalCount;
    if (p.dailyRemainderCount !== void 0) item.dailyRemainderCount = p.dailyRemainderCount;
    if (p.dailyCount !== void 0) item.dailyCount = p.dailyCount;
    if (p.minRemainderCount !== void 0) item.minRemainderCount = p.minRemainderCount;
    if (p.startTime !== void 0) item.startTime = p.startTime;
    if (p.endTime !== void 0) item.endTime = p.endTime;
    if (p.monthLimit !== void 0) item.monthLimit = p.monthLimit;
    if (p.received !== void 0) item.received = p.received;
    out.push(item);
  }
  return out;
}
function savePickCache(store2, prizes, nowIso) {
  const cache = { date: nowIso.slice(0, 10), items: toPickItems(prizes) };
  store2.setState(STATE_PICK, JSON.stringify(cache), nowIso);
}
function readPickCache(store2, nowIso) {
  const raw = store2.getState(STATE_PICK);
  if (raw === null || raw === void 0 || raw === "") return null;
  const today = nowIso.slice(0, 10);
  let c = null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v.items)) {
      c = { date: typeof v.date === "string" ? v.date : "", items: v.items };
    }
  } catch {
    c = null;
  }
  if (c === null || c.date !== today) {
    store2.setState(STATE_PICK, "", nowIso);
    return null;
  }
  return c;
}
var STATE_SUBS = "mcloud.exchange.subs";
function readSubscriptions(store2) {
  const raw = store2.getState(STATE_SUBS);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      if (x === null || typeof x !== "object") continue;
      const o = x;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (name === "") continue;
      const id = typeof o.id === "number" && Number.isFinite(o.id) ? Math.trunc(o.id) : void 0;
      out.push(id === void 0 ? { name } : { id, name });
    }
    return out;
  } catch {
    return [];
  }
}
function toggleSubscription(store2, sub, on, nowIso) {
  const name = sub.name.trim();
  if (name === "") return readSubscriptions(store2);
  const same = (x) => sub.id !== void 0 ? x.id === sub.id : x.name === name;
  const cur = readSubscriptions(store2).filter((x) => !same(x));
  if (on) {
    cur.push(sub.id === void 0 ? { name } : { id: sub.id, name });
  }
  store2.setState(STATE_SUBS, JSON.stringify(cur), nowIso);
  return cur;
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
  const done = (note2, ok = true) => {
    saveState(deps, { ...st, step: "done" });
    return { ok, note: note2 };
  };
  if (step === "done") return { ok: true, idle: true, note: "这一单已经走完了（要再来一单得重新起）" };
  if (step === "list") {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/signin/page/exchangeList?client=app&clientVersion=${encodeURIComponent(EXCHANGE_CLIENT_VERSION)}`,
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
      signedReq(deps, { url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/signin/page/infoV3?client=app`, method: "GET" })
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
        url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/visitlog/journaling?module=uservisit&optkeyword=${encodeURIComponent(keyword)}&sourceid=1002&marketName=${encodeURIComponent(VISIT_LOG_MARKET_NAME)}`,
        method: "POST",
        body: ""
      })
    );
    const warn2 = res.ok ? "" : `（埋点失败但不挡路：${res.error ?? "未知"}）`;
    if (step === "warm-1") {
      saveState(deps, { ...st, step: "warm-2" });
      return { ok: true, note: `${label}：${keyword}${warn2} —— 下一步第二枪（中间那 500ms 由面板的下一次触发承担）` };
    }
    saveState(deps, { ...st, step: "slide" });
    return { ok: true, note: `${label}：${keyword}${warn2} —— 下一步取滑块题面` };
  }
  if (step === "slide") {
    const res = callRawText(
      deps.transport,
      signedReq(deps, {
        url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/auth-service/slide/getSlide`,
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
      url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/signin/page/exchangeV3`,
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
    return { ok: true, note: `${label}：服务端回 ${JSON.stringify(env0(res.text)).slice(0, 140)} —— 下一步查余额差（**那句话不算数**）` };
  }
  if (step === "verify") {
    const before = deps.store.getState(STATE_BASE);
    const res = callRawText(
      deps.transport,
      signedReq(deps, { url: `${hostBase(deps, MCLOUD_HOST)}/ycloud/signin/page/infoV3?client=app`, method: "GET" })
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
    return done(`${label}：❌ 没成交（余额 ${before} → ${after}，没扣豆）—— 服务端那句话不算数，只有余额差算数`, false);
  }
  return { ok: false, note: `不认识的步骤「${step}」` };
}
function env0(text) {
  const r = digResult(text);
  return Object.keys(r).length > 0 ? r : text.slice(0, 140);
}

// src/mcloud/push.ts
var CHANNELS = [
  "pushplus",
  "serverChan",
  "workWeixin",
  "workWeixinBot",
  "tgBot",
  "bark",
  "twoIm",
  "dingTalk",
  "email",
  "customPost"
];
var CHANNEL_LABELS = {
  pushplus: "pushplus",
  serverChan: "Server酱",
  workWeixin: "企业微信推送",
  workWeixinBot: "企业微信Bot推送",
  tgBot: "Telegram Bot 推送",
  bark: "Bark ios 推送",
  twoIm: "回逍推送",
  dingTalk: "钉钉推送",
  email: "邮件消息",
  customPost: "自定义消息"
};
function encodeUriComponent(s) {
  return encodeURIComponent(s);
}
function formUrlencode(pairs) {
  return pairs.map(([k, v]) => `${encodeUriComponent(k)}=${encodeUriComponent(v)}`).join("&");
}
function jsTruthy(v) {
  if (v === null || v === void 0 || v === false) return false;
  if (typeof v === "string") return v !== "";
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  return true;
}
function hmacSha256Base64(key, message) {
  return toBase64(hmacSha256(utf8(key), utf8(message)));
}
function postJson(url, body) {
  return {
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}
function buildPushplus(c, title, text) {
  return {
    ok: true,
    request: postJson("http://www.pushplus.plus/send", {
      token: c.token,
      title,
      content: text,
      ...c.extra ?? {}
    })
  };
}
function buildServerChan(c, title, text) {
  return {
    ok: true,
    request: postJson(`https://sctapi.ftqq.com/${c.token}.send`, {
      text: title,
      title,
      desp: text.replace(/\n/g, "\n\n"),
      ...c.extra ?? {}
    })
  };
}
function buildWorkWeixinToken(c) {
  const body = {};
  if (c.corpid !== void 0) body["corpid"] = c.corpid;
  if (c.corpsecret !== void 0) body["corpsecret"] = c.corpsecret;
  return postJson("https://qyapi.weixin.qq.com/cgi-bin/gettoken", body);
}
function buildWorkWeixinMessage(c, accessToken, title, text) {
  const msgtype = c.msgtype ?? "text";
  const body = {
    touser: c.touser ?? "@all",
    msgtype
  };
  if (c.agentid !== void 0) body["agentid"] = c.agentid;
  body[msgtype] = { content: `${title}

${text}` };
  return postJson(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
    { ...body, ...c.extra ?? {} }
  );
}
function buildWorkWeixinBot(c, title, text) {
  const msgtype = c.msgtype ?? "text";
  const body = { msgtype };
  body[msgtype] = { content: `${title}

${text}` };
  return { ok: true, request: postJson(c.url, { ...body, ...c.extra ?? {} }) };
}
function buildTgBot(c, title, text) {
  if (c.token === "" || !jsTruthy(c.chat_id)) {
    return { ok: false, skip: "缺少 token 或 chat_id" };
  }
  const host2 = c.apiHost ?? "api.telegram.org";
  const body = {
    disable_web_page_preview: c.disable_web_page_preview ?? true
  };
  if (c.chat_id !== void 0) body["chat_id"] = c.chat_id;
  if (c.proxy !== void 0) body["proxy"] = c.proxy;
  Object.assign(body, c.extra ?? {});
  body["text"] = `${title}

${text}`;
  return { ok: true, request: postJson(`https://${host2}/bot${c.token}/sendMessage`, body) };
}
function buildBark(c, title, text) {
  if (c.key === "") return { ok: false, skip: "缺少 key" };
  return {
    ok: true,
    request: postJson(`https://api.day.app/${c.key}`, {
      body: text,
      title,
      level: c.level ?? "passive",
      ...c.extra ?? {}
    })
  };
}
function buildTwoIm(c, title, text) {
  const pairs = [
    ["key", c.key],
    ["sid", c.sid]
  ];
  const q = c.query;
  if (q) {
    if (q.plat !== void 0) pairs.push(["plat", q.plat]);
    if (q.group !== void 0) pairs.push(["group", q.group]);
    if (q.icon !== void 0) pairs.push(["icon", String(q.icon)]);
    for (const [k, v] of Object.entries(q.extra ?? {})) pairs.push([k, String(v)]);
  }
  return {
    ok: true,
    request: postJson(`https://api.2im.cn/push?${formUrlencode(pairs)}`, {
      msgtype: c.msgtype ?? "text",
      content: text,
      title,
      ...c.extra ?? {}
    })
  };
}
function buildDingTalk(c, title, text, timestampMs) {
  let query = "";
  if (c.secret !== void 0 && c.secret !== "") {
    const sign = hmacSha256Base64(c.secret, `${timestampMs}
${c.secret}`);
    query = `&timestamp=${timestampMs}&sign=${encodeUriComponent(sign)}`;
  }
  return {
    ok: true,
    request: postJson(
      `https://oapi.dingtalk.com/robot/send?access_token=${c.token}${query}`,
      {
        msgtype: "text",
        // ⚠ 正文前面那个**前导空格**是 TS 原文，别顺手删掉
        text: { content: ` ${title}

${text}` },
        ...c.extra ?? {}
      }
    )
  };
}
function buildCustomPost(item, title, text) {
  if (item.url === "") return { ok: false, skip: "这个模板没有 URL" };
  const method = (item.method ?? "POST").toUpperCase();
  const url = item.url.replace("{title}", encodeUriComponent(title)).replace("{text}", encodeUriComponent(text));
  const fields = item.data ?? item.body;
  let body;
  if (fields !== void 0 && Object.keys(fields).length > 0) {
    const raw = JSON.stringify(fields);
    const patched = raw.replace(/\{title\}/g, title).replace(/\{text\}/g, text).replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    try {
      JSON.parse(patched);
      body = patched;
    } catch (e) {
      return { ok: false, error: `模板体替换后不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return {
    ok: true,
    request: {
      url,
      method,
      headers: { ...item.headers ?? {} },
      body
    }
  };
}
function sendPush(deps, config, title, text) {
  const results = [];
  const add = (channel, outcome, note2) => {
    results.push({ channel, label: CHANNEL_LABELS[channel], outcome, note: note2 });
  };
  const deliver = (channel, built) => {
    if (!built.ok) {
      add(channel, "skipped", built.skip);
      return;
    }
    const res = deps.http(built.request);
    if (!res.ok) {
      add(channel, "failed", res.error ?? `HTTP ${res.status}`);
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      add(channel, "failed", `HTTP ${res.status}`);
      return;
    }
    add(channel, "sent", `HTTP ${res.status}`);
  };
  if (config.pushplus) deliver("pushplus", buildPushplus(config.pushplus, title, text));
  if (config.serverChan) deliver("serverChan", buildServerChan(config.serverChan, title, text));
  if (config.workWeixin) {
    const c = config.workWeixin;
    const tok = deps.http(buildWorkWeixinToken(c));
    let accessToken;
    if (tok.ok && tok.status >= 200 && tok.status < 300) {
      try {
        const j = JSON.parse(tok.body);
        if (typeof j["access_token"] === "string") accessToken = j["access_token"];
      } catch {
      }
    }
    if (accessToken === void 0) {
      add("workWeixin", "failed", tok.ok ? "换 access_token 失败（响应里没有）" : `换 access_token 失败：${tok.error ?? `HTTP ${tok.status}`}`);
    } else {
      deliver("workWeixin", {
        ok: true,
        request: buildWorkWeixinMessage(c, accessToken, title, text)
      });
    }
  }
  if (config.workWeixinBot) deliver("workWeixinBot", buildWorkWeixinBot(config.workWeixinBot, title, text));
  if (config.tgBot) deliver("tgBot", buildTgBot(config.tgBot, title, text));
  if (config.bark) deliver("bark", buildBark(config.bark, title, text));
  if (config.twoIm) deliver("twoIm", buildTwoIm(config.twoIm, title, text));
  if (config.dingTalk) deliver("dingTalk", buildDingTalk(config.dingTalk, title, text, deps.nowMs()));
  if (config.email) {
    const e = config.email;
    if (e.host === "" || e.from === "") {
      add("email", "skipped", "缺少 host 或 from");
    } else {
      try {
        const r = deps.smtp({
          host: e.host,
          ...e.port !== void 0 ? { port: e.port } : {},
          ...e.tls !== void 0 ? { tls: e.tls } : {},
          ...e.user !== void 0 ? { user: e.user } : {},
          pass: e.pass,
          from: e.from,
          to: e.to ?? "",
          subject: title,
          text
        });
        if (r.ok) add("email", "sent", r.response.slice(0, 80));
        else add("email", "failed", r.response.slice(0, 120));
      } catch (err2) {
        add("email", "failed", err2 instanceof Error ? err2.message : String(err2));
      }
    }
  }
  if (config.customPost && config.customPost.length > 0) {
    let anySent = false;
    let anyFailed = false;
    for (const item of config.customPost) {
      const built = buildCustomPost(item, title, text);
      if (!built.ok) {
        if ("skip" in built) add("customPost", "skipped", built.skip);
        else {
          anyFailed = true;
          add("customPost", "failed", built.error);
        }
        continue;
      }
      const res = deps.http(built.request);
      if (!res.ok) {
        anyFailed = true;
        add("customPost", "failed", res.error ?? `HTTP ${res.status}`);
      } else if (res.status < 200 || res.status >= 300) {
        anyFailed = true;
        add("customPost", "failed", `HTTP ${res.status}`);
      } else {
        anySent = true;
        add("customPost", "sent", `HTTP ${res.status}`);
      }
    }
    void anySent;
    void anyFailed;
  }
  const sent = results.filter((r) => r.outcome === "sent").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  let line;
  if (results.length === 0) line = "没有配置推送渠道";
  else if (failed > 0) line = `${sent} 个渠道发到了，${failed} 个失败${skipped > 0 ? `，${skipped} 个跳过` : ""}`;
  else if (sent > 0) line = `${sent} 个渠道发到了${skipped > 0 ? `，${skipped} 个跳过` : ""}`;
  else line = `${skipped} 个渠道都跳过了（没配全）`;
  return { attempted: sent + failed, sent, skipped, failed, results, line };
}
function configuredChannels(config) {
  return CHANNELS.filter((c) => {
    if (c === "customPost") return (config.customPost ?? []).length > 0;
    return config[c] !== void 0 && config[c] !== null;
  });
}

// src/mcloud/pushConfig.ts
var STATE_PUSH_CONFIG = "mcloud.push.config";
var STATE_PUSH_RULES = "mcloud.push.rules";
var STATE_PUSH_BINDINGS = "mcloud.push.bindings";
function parse2(raw, fallback) {
  if (raw === void 0 || raw === null || raw === "") return fallback;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v : fallback;
  } catch {
    return fallback;
  }
}
function loadPushConfig(store2) {
  return parse2(store2.getState(STATE_PUSH_CONFIG), {});
}
function savePushConfig(store2, cfg, nowIso) {
  store2.setState(STATE_PUSH_CONFIG, JSON.stringify(cfg), nowIso);
}
function loadPushRules(store2) {
  const raw = parse2(store2.getState(STATE_PUSH_RULES), []);
  return Array.isArray(raw) ? raw.filter((r) => typeof r?.id === "string") : [];
}
function savePushRules(store2, rules, nowIso) {
  store2.setState(STATE_PUSH_RULES, JSON.stringify(rules), nowIso);
}
function loadPushBindings(store2) {
  const raw = parse2(store2.getState(STATE_PUSH_BINDINGS), {});
  return {
    daily: typeof raw.daily === "string" ? raw.daily : "",
    exchange: typeof raw.exchange === "string" ? raw.exchange : "",
    live: typeof raw.live === "string" ? raw.live : ""
  };
}
function savePushBindings(store2, b, nowIso) {
  store2.setState(STATE_PUSH_BINDINGS, JSON.stringify(b), nowIso);
}
function maskSecret(v) {
  if (typeof v !== "string" || v === "") return "";
  if (v.length <= 8) return "（已配）";
  return `${v.slice(0, 3)}…${v.slice(-2)}（共 ${v.length} 字符）`;
}
function pushFields(cfg) {
  const out = {};
  const take = (ch, obj) => {
    if (obj === void 0) return;
    const fields = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "extra") continue;
      if (v === void 0 || v === null || v === "") continue;
      const secretish = /token|secret|pass|key|sid|corpsecret/i.test(k);
      fields[k] = secretish ? maskSecret(v) : String(v);
    }
    out[ch] = fields;
  };
  take("pushplus", cfg.pushplus);
  take("serverChan", cfg.serverChan);
  take("workWeixin", cfg.workWeixin);
  take("workWeixinBot", cfg.workWeixinBot);
  take("tgBot", cfg.tgBot);
  take("bark", cfg.bark);
  take("twoIm", cfg.twoIm);
  take("dingTalk", cfg.dingTalk);
  take("email", cfg.email);
  if (cfg.customPost && cfg.customPost.length > 0) {
    out["customPost"] = { 模板数: String(cfg.customPost.length) };
  }
  return out;
}
var CHANNEL_HINTS = {
  pushplus: "要一个 token（pushplus 网站上拿）",
  serverChan: "要一个 SendKey",
  workWeixin: "要 corpid + corpsecret + agentid（**两步**：先换 access_token）",
  workWeixinBot: "要一个群机器人 webhook 地址",
  tgBot: "要 bot token + chat_id（群 ID 是负数）",
  bark: "要一个 key（Bark App 里拿）",
  twoIm: "要 key + sid",
  dingTalk: "要 access_token（有加签密钥就一起填）",
  email: "要 SMTP 主机 + 发件人 + 密码（走面板的 smtp_send）",
  customPost: "自己写请求模板（URL + 请求体）"
};
function pushReading(store2) {
  const cfg = loadPushConfig(store2);
  const configured = CHANNELS.filter((c) => {
    if (c === "customPost") return (cfg.customPost ?? []).length > 0;
    return cfg[c] !== void 0 && cfg[c] !== null;
  });
  return {
    configured,
    channels: CHANNELS.map((id) => ({
      id,
      label: id,
      configured: configured.includes(id),
      hint: CHANNEL_HINTS[id]
    })),
    rules: loadPushRules(store2),
    bindings: loadPushBindings(store2),
    fields: pushFields(cfg)
  };
}

// src/mcloud/query.ts
function parseQuery(raw) {
  const out = {};
  if (typeof raw !== "string" || raw === "") return out;
  const s = raw.startsWith("?") ? raw.slice(1) : raw;
  for (const pair of s.split("&")) {
    if (pair === "") continue;
    const i = pair.indexOf("=");
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? "" : pair.slice(i + 1);
    const key = safeDecode(k.replace(/\+/g, " "));
    if (key in out) continue;
    out[key] = safeDecode(v.replace(/\+/g, " "));
  }
  return out;
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// src/mcloud/scheduleCron.ts
var MIN = 0;
var MAX_HOUR = 23;
function parseNum(s, min, max2) {
  if (!/^\d+$/.test(s)) throw new Error(`不是数字：${s}`);
  const n = Number(s);
  if (n < min || n > max2) throw new Error(`超出范围：${s}`);
  return n;
}
function parseField(field, min, max2) {
  const f = field.trim();
  if (f === "") throw new Error("cron 字段不能为空");
  if (f === "*") return null;
  const out = /* @__PURE__ */ new Set();
  for (const part of f.split(",")) {
    const p = part.trim();
    if (p === "") throw new Error("cron 字段里有空项");
    const base = p.split("/")[0];
    const stepRaw = p.split("/")[1];
    const step = stepRaw === void 0 ? 1 : parseNum(stepRaw, 1, 999);
    let start = min;
    let end = max2;
    if (base !== "*") {
      if (base.includes("-")) {
        const [a, b] = base.split("-");
        start = parseNum(a, min, max2);
        end = parseNum(b, min, max2);
        if (start > end) throw new Error(`范围反了：${base}`);
      } else {
        start = parseNum(base, min, max2);
        end = start;
      }
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 要 5 段：分 时 日 月 周");
  const minute = parseField(parts[0], 0, 59);
  if (minute === null || minute.length !== 1 || minute[0] !== 0) {
    throw new Error("分钟只能是 0（抢兑点都是整点）");
  }
  const hoursRaw = parseField(parts[1], MIN, MAX_HOUR);
  const hours2 = hoursRaw ?? Array.from({ length: MAX_HOUR + 1 }, (_, i) => i);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  return {
    hours: hours2,
    dom,
    month,
    dow: dow === null ? null : [...new Set(dow.map((d) => d === 7 ? 0 : d))].sort((a, b) => a - b)
  };
}
function dayMatches(spec, d) {
  if (spec.month !== null && !spec.month.includes(d.getMonth() + 1)) return false;
  const domOk = spec.dom === null || spec.dom.includes(d.getDate());
  const dowOk = spec.dow === null || spec.dow.includes(d.getDay());
  if (spec.dom !== null && spec.dow !== null) return domOk || dowOk;
  return domOk && dowOk;
}
function nextCronTargetMs(expr, nowMs) {
  const spec = parseCron(expr);
  const base = new Date(nowMs);
  for (let day = 0; day < 370; day += 1) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + day);
    if (!dayMatches(spec, d)) continue;
    for (const h of spec.hours) {
      const t = new Date(d.getTime());
      t.setHours(h, 0, 0, 0);
      if (t.getTime() >= nowMs) return t.getTime();
    }
  }
  return null;
}

// src/mcloud/runLog.ts
var RUN_LOG_KEY = "mcloud.run.log";
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
function readRunsOf(store2, task) {
  return readRuns(store2).filter((r) => r.task === task).sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
}
function readRun(store2, id) {
  return readRuns(store2).find((r) => r.id === id) ?? null;
}
function summarize(r) {
  return {
    id: r.id,
    ...r.acct === void 0 ? {} : { acct: r.acct },
    ...r.who === void 0 ? {} : { who: r.who },
    at: r.at,
    ms: r.ms,
    ok: r.ok,
    note: r.note,
    okCount: r.steps.filter((s) => s.ok && !s.idle).length,
    badCount: r.steps.filter((s) => !s.ok).length,
    idleCount: r.steps.filter((s) => s.idle).length,
    truncated: r.truncated
  };
}
function recentRuns(store2, task, limit = 5) {
  return readRunsOf(store2, task).slice(0, limit).map(summarize);
}

// src/mcloud/logRing.ts
var RING_KEY = "mcloud.log.ring";
function parse3(raw) {
  if (raw === "") return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x) => typeof x === "object" && x !== null && typeof x.m === "string"
    );
  } catch {
    return [];
  }
}
function readRing(store2) {
  return parse3(store2.getState(RING_KEY) ?? "");
}

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
      return { ok: true, idle: true, steps, note: brief(r.note, opts.label), notes };
    }
  }
  return {
    ok: true,
    idle: false,
    steps,
    // ⚠ 这里**不说**"还有没做完的"。踩过的坑：领取AI豆的队列刚好在第 12 步领空，
    //   而"到上限"和"刚好做完"从这一步看不出区别 —— 于是每一趟都说"还有没做完的"，
    //   用户看到的是一句假话（他的原话：「领取云朵应该没有步数啊」）。
    //   对用户只报**结论**：成了。真想看走到哪一步，运行记录里每一步都在。
    // 同样用最后一步自己的话（跑到上限时，它刚做完的那件事就是结论），
    // 但**截短**：这一格要进 runs 表当一行摘要，不能塞整段原话。
    note: brief(lastNote ?? "", opts.label),
    notes
  };
}
var BRIEF_MAX = 40;
function brief(s, label) {
  const t = s.trim();
  return t.length === 0 || t.length > BRIEF_MAX ? `${label}：好了` : t;
}

// src/mcloud/tokenGate.ts
var LoginExpiredError = class extends Error {
  constructor(message = "这一环要的票没被认（90001）") {
    super(message);
    this.name = "LoginExpiredError";
  }
};
var MAX_RESETS = 2;
function exchangeOnce(deps, recipe) {
  const auth = loadAuthRaw(deps.store);
  if (auth === "") return { ok: false, note: "没有可换票的原生凭据 —— 先加一个账号" };
  const started = startExchange(deps.store, auth, deps.nowIso, recipe);
  if (!started.ok) return { ok: false, note: started.error ?? "这串登录信息用不了" };
  const taskDeps = {
    store: deps.store,
    transport: deps.transport,
    nowIso: deps.nowIso,
    baseUrl: deps.baseUrl
  };
  const r = drain(
    (d) => {
      const x = runExchangeStep(d, recipe);
      return { ok: x.ok, note: x.note, idle: x.done };
    },
    taskDeps,
    { label: `换票（${recipe}）`, maxSteps: 4, deadlineMs: 3e4, startedAt: Date.now() }
  );
  return { ok: r.ok && jwtFresh(deps.store, Date.now(), recipe), note: r.note };
}
function withTokenGate(deps, read, recipe = FALLBACK_RECIPE) {
  const doRefresh = deps.refreshToken ?? ((rp) => exchangeOnce(deps, rp));
  if (!jwtFresh(deps.store, Date.now(), recipe)) doRefresh(recipe);
  let resets = 0;
  for (; ; ) {
    try {
      return read();
    } catch (e) {
      if (!(e instanceof LoginExpiredError)) throw e;
      if (resets >= MAX_RESETS) {
        throw new Error("这个号读不到：换了两次票还是不认 —— 多半是登录信息坏了，去「账号」页重新登录一次");
      }
      resets++;
      doRefresh(recipe);
    }
  }
}

// src/mcloud/tasks/exchangeRun.ts
var BUDGET_MS = 48e4;
var DEADLINE_MS = BUDGET_MS - 1e4;
var PLAN_KEY = "mcloud.exchange.plan";
var STATE_SCHEDULE_PLAN = "mcloud.exchange.schedule.plan";
var STATE_SCHEDULE_PLAN_NAME = "mcloud.exchange.schedule.plan_name";
var STATE_SCHEDULE_CRON = "mcloud.exchange.schedule.cron";
var STATE_SCHEDULE_MODE = "mcloud.exchange.schedule.mode";
var STATE_SCHEDULE_UNTIL = "mcloud.exchange.schedule.until";
var STATE_SCHEDULE_ONCE_DATE = "mcloud.exchange.schedule.once_date";
var STATE_SCHEDULE_MAX_RUNS = "mcloud.exchange.schedule.max_runs";
var STATE_SCHEDULE_RUNS = "mcloud.exchange.schedule.runs";
var STATE_SCHEDULE_RUNS_GEN = "mcloud.exchange.schedule.runs_gen";
var STATE_SCHEDULE_GEN = "mcloud.exchange.schedule.gen";
var STATE_SCHEDULE_ENABLED = "mcloud.exchange.schedule.enabled";
function scheduleEnabled(store2) {
  const raw = (store2.getState(STATE_SCHEDULE_ENABLED) ?? "").trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return (store2.getState(STATE_SCHEDULE_PLAN) ?? "").trim() !== "";
}
function setScheduleEnabled(store2, on, nowIso) {
  store2.setState(STATE_SCHEDULE_ENABLED, on ? "1" : "0", nowIso);
}
var STATE_LEAD_SEC = "mcloud.exchange.lead_sec";
var DEFAULT_LEAD_SEC = 120;
function scheduleNextTargetMs(store2, nowMs) {
  const raw = (store2.getState(STATE_SCHEDULE_CRON) ?? "").trim();
  if (raw !== "") {
    try {
      return nextCronTargetMs(raw, nowMs);
    } catch {
      return null;
    }
  }
  const targetHour = targetHourOf(store2);
  const d = new Date(nowMs);
  const t = new Date(d);
  if (targetHour === null) t.setHours(d.getHours() + 1, 0, 0, 0);
  else {
    t.setHours(targetHour, 0, 0, 0);
    if (t.getTime() < nowMs) t.setDate(t.getDate() + 1);
  }
  return t.getTime();
}
function scheduleMaxRuns(store2) {
  const raw = Number((store2.getState(STATE_SCHEDULE_MAX_RUNS) ?? "0").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
function scheduleRuns(store2) {
  const gen = (store2.getState(STATE_SCHEDULE_GEN) ?? "").trim();
  const runsGen = (store2.getState(STATE_SCHEDULE_RUNS_GEN) ?? "").trim();
  if (gen !== "" && runsGen !== gen) return 0;
  const raw = Number((store2.getState(STATE_SCHEDULE_RUNS) ?? "0").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
function scheduleLeadSec(store2) {
  const raw = Number((store2.getState(STATE_LEAD_SEC) ?? String(DEFAULT_LEAD_SEC)).trim());
  return Number.isFinite(raw) ? Math.min(300, Math.max(60, Math.floor(raw))) : DEFAULT_LEAD_SEC;
}
function runExchange(deps, opts = {}) {
  const started = Date.now();
  const steps = [];
  const add = (name, ok, note2, idle = false) => {
    steps.push({ name, ok, note: note2, idle });
  };
  const ensureToken = () => {
    if (jwtFresh(deps.store, Date.now(), FALLBACK_RECIPE)) return true;
    const x = exchangeOnce(
      {
        store: deps.store,
        transport: deps.transport,
        nowIso: deps.nowIso,
        baseUrl: deps.baseUrl
      },
      FALLBACK_RECIPE
    );
    add("换票", x.ok, x.note);
    return x.ok && jwtFresh(deps.store, Date.now(), FALLBACK_RECIPE);
  };
  const finish3 = (ok, note2, idle = false) => {
    if (opts.dryRun) {
      add("干跑", true, "只看了能不能兑，**一枪都没发**（真下单走「立即兑换」或定时那一场）", true);
    }
    return {
      ok,
      ...idle ? { idle: true } : {},
      note: note2,
      detail: steps.map((x) => `${x.name}：${x.ok ? "" : "失败 "}${x.note}`),
      steps
    };
  };
  const targetHour = opts.targetHour !== void 0 ? opts.targetHour : targetHourOf(deps.store);
  const gate = planTargetWait(depsNowMs(deps), targetHour);
  if (!opts.dryRun && gate.needed && gate.ms > (opts.maxWaitMs ?? MAX_SPIN_MS)) {
    add(
      "时间闸",
      true,
      targetHour === null ? `还没到窗口（还差 ${Math.round(gate.ms / 1e3)}s）—— 本次零请求` : `不是 ${targetHour} 点那一场（还差 ${Math.round(gate.ms / 1e3)}s）—— 本次零请求`,
      true
    );
    return finish3(
      true,
      `还没到抢兑时间（还差 ${Math.round(gate.ms / 1e3)}s），本次零请求`,
      true
    );
  }
  if (!ensureToken()) {
    return finish3(false, "网页会话续期失败 —— 登录凭据可能已过期，去「账号」页重新登录一次");
  }
  try {
    const l = runExchangeList(deps);
    add("清单", l.ok, l.note);
  } catch (e) {
    add("清单", false, `抛异常 ${e instanceof Error ? e.message : String(e)}`);
  }
  const plan = opts.target ?? deps.store.getState(STATE_SCHEDULE_PLAN) ?? deps.store.getState(PLAN_KEY) ?? "";
  if (plan === "") {
    add("下单", true, "没有设定时兑换目标（在「定时抢兑」里选一件之后才会下单）", true);
    return finish3(true, "没有设定时兑换目标（在「定时抢兑」里选一件之后才会下单）");
  }
  if (!deps.store.getState("mcloud.exchange.order.step")) {
    const s = startOrder(deps, plan);
    add("起单", s.ok, s.note);
    if (!s.ok) {
      return finish3(false, s.note);
    }
  }
  const scopedId = scopedAccountOf(deps.store);
  const allAccounts = loadAccounts(deps.store);
  const accounts = scopedId === void 0 ? allAccounts : allAccounts.filter((a) => a.id === scopedId);
  const multi = accounts.length > 1;
  const snaps = /* @__PURE__ */ new Map();
  const offsets = [];
  let r;
  if (multi) {
    for (const acc of accounts) {
      selectAccount(deps.store, acc.id, deps.nowIso);
      if (!ensureToken()) {
        add(`准备 ${maskAuth(loadAuthRaw(deps.store) ?? "")}`, false, "网页会话续期失败");
        continue;
      }
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
  return finish3(r.ok, `${r.note}（用时 ${((Date.now() - started) / 1e3).toFixed(1)}s）`);
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
      return `口令「${code}」没领到：服务端回了没见过的码 ${out.code ?? "?"}${out.message ? `（${out.message}）` : ""}`;
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
function isKoulingHead(text) {
  return /(?:复制)?口令\s*\d*\s*[：:]\s*$/.test(text.trim());
}
function hasKouling(text) {
  return /口令|小红花/.test(text);
}
function isKoulingMarker(text) {
  return /无随机/.test(text);
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
function looksLikeQuestionAboutKouling(line) {
  if (/[?？]/.test(line)) return true;
  const stripped = line.replace(/^第?\d*个?口令\s*[是为：:]?\s*/, "").trim();
  return isQuestion(line) || isQuestion(stripped);
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
var MAX_CODE_CHARS = 128;
var MAX_CODES = 10;
function parseCodeInput(raw) {
  const text = raw.trim();
  if (!text) return { ok: false, codes: [], how: "", matchedFormat: false, error: "先贴一条口令" };
  const extracted = extractKouling(text);
  if (extracted.length > 0) {
    return finish(extracted, `按弹幕格式解出 ${extracted.length} 条`, true);
  }
  const lines = text.split(/\r?\n/).map((l) => trimKoulingTail(l)).filter((l) => l !== "");
  if (lines.length === 0) {
    return { ok: false, codes: [], how: "", matchedFormat: false, error: "先贴一条口令" };
  }
  const bad = lines.find((l) => looksLikeQuestionAboutKouling(l));
  if (bad !== void 0) {
    return {
      ok: false,
      codes: [],
      how: "",
      matchedFormat: false,
      error: `「${bad.slice(0, 20)}」看着是观众的提问，不是口令 —— 拿去领只会白跑一枪（服务端回 200108）`
    };
  }
  return finish(lines, `按原文收下 ${lines.length} 条（没匹配到任何弹幕格式）`, false);
}
function checkCodeLimits(codes) {
  return finish(codes.slice(), "（只做护栏检查）", false);
}
function finish(codes, how, matchedFormat) {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ""))];
  const tooLong = uniq.find((c) => c.length > MAX_CODE_CHARS);
  if (tooLong !== void 0) {
    return {
      ok: false,
      codes: [],
      how: "",
      matchedFormat: false,
      error: `有一条 ${tooLong.length} 个字符，超过 ${MAX_CODE_CHARS} 的上限 —— 这不像口令`
    };
  }
  if (uniq.length > MAX_CODES) {
    return {
      ok: false,
      codes: [],
      how: "",
      matchedFormat: false,
      error: `一次最多 ${MAX_CODES} 条（收到 ${uniq.length} 条）`
    };
  }
  return { ok: true, codes: uniq, how, matchedFormat };
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
  pool.cycleAtMs = num2(o["cycleAtMs"]) ?? 0;
  pool.codes = codeList(o["codes"]);
  pool.claims = claimsOf(o["claims"]);
  pool.lastLiveAtMs = num2(o["lastLiveAtMs"]) ?? null;
  pool.gateClosedAtMs = num2(o["gateClosedAtMs"]) ?? null;
  pool.lastXhsAtMs = num2(o["lastXhsAtMs"]) ?? null;
  pool.lastScrapeAtMs = num2(o["lastScrapeAtMs"]) ?? null;
  pool.schedule = roomsOf(o["schedule"]);
  pool.scheduleAtMs = num2(o["scheduleAtMs"]) ?? null;
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
function loadFreshPool(store2, nowMs) {
  const got = loadPoolFrom(store2);
  normalize(got.pool, nowMs);
  return got;
}
function savePoolTo(store2, pool, nowIso) {
  store2.setState(POOL_KEY, serializePool(pool), nowIso);
}
function num2(v) {
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
      firstSeenMs: num2(o["firstSeenMs"]) ?? 0
    };
    const reason = str(o["reason"]);
    if (reason !== "") code.reason = reason;
    const validAt = num2(o["validAtMs"]);
    if (validAt !== void 0) code.validAtMs = validAt;
    out.push(code);
  }
  return out;
}
function sourceOf(v) {
  return v === "danmaku" || v === "xiaohongshu" || v === "manual" || v === "auto" ? v : "auto";
}
function verdictOf2(v) {
  return v === "claimed" || v === "alreadyClaimed" || v === "invalid" || v === "expired" || v === "other" ? v : void 0;
}
function claimsOf(v) {
  const out = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [account, codes] of Object.entries(v)) {
    if (codes === null || typeof codes !== "object" || Array.isArray(codes)) continue;
    const mine = {};
    for (const [code, verdict] of Object.entries(codes)) {
      const v2 = verdictOf2(verdict);
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
      roomId: num2(o["roomId"]) ?? 0,
      title: str(o["title"]),
      status: num2(o["status"]) ?? 0,
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
    const started = num2(o["startedAtMs"]);
    if (started === void 0) continue;
    const s = { startedAtMs: started };
    const ended = num2(o["endedAtMs"]);
    if (ended !== void 0) s.endedAtMs = ended;
    out.push(s);
  }
  return out;
}
function localStamp(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
function splitKouling(raw) {
  return mergeKouling(raw.split(/[\s,，、]+/));
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
function saveLiveUrl(store2, url, nowIso) {
  store2.setState(STATE_LIVE_URL, url.trim().replace(/\/+$/, ""), nowIso);
}
var EMPTY_SHELL_HINT_CHARS = 5e3;
function readPoolSummary(store2, nowLocal, nowMs) {
  const { pool } = loadPoolFrom(store2);
  return poolSummary(pool, nowLocal, nowMs);
}
function readLiveReading(store2) {
  return parseJson(store2.getState(STATE_READING));
}
function loadLiveCodes(store2) {
  return parseJson(store2.getState(STATE_CODES));
}
function saveLiveCodes(store2, raw, nowIso) {
  const parsed = parseCodeInput(raw);
  if (!parsed.ok) return { ok: false, codes: [], how: "", error: parsed.error ?? "解不出口令" };
  const cut = parsed.codes.flatMap((c) => splitKouling(c)).map(trimKoulingTail);
  const kept = cut.filter((c) => c !== "" && !isQuestion(c) && !isKoulingMarker(c));
  const limited = checkCodeLimits(kept);
  if (!limited.ok) return { ok: false, codes: [], how: "", error: limited.error ?? "解不出口令" };
  const codes = limited.codes;
  if (codes.length === 0) {
    return { ok: false, codes: [], how: "", error: "拆完之后一条口令都不剩（剩下的看着都像提问或格式标记）" };
  }
  const how = cut.length === codes.length ? parsed.how : `${parsed.how}；按分隔符切开 ${cut.length} 段，滤掉提问/标记、去重后剩 ${codes.length} 条`;
  const v = { at: nowIso, codes, raw: raw.trim(), how };
  store2.setState(STATE_CODES, JSON.stringify(v), nowIso);
  return { ok: true, codes, how };
}
function clearLiveCodes(store2, nowIso) {
  store2.setState(STATE_CODES, "", nowIso);
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
function collectCodes(store2, nowMs = Date.now()) {
  const human = loadLiveCodes(store2)?.codes ?? [];
  const { pool } = loadFreshPool(store2, nowMs);
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
function setClaimEnabled(store2, on, nowIso) {
  store2.setState(STATE_CLAIM_ENABLED, on ? "1" : "0", nowIso);
}
function probeLiveRoom(deps) {
  const session = loadSession(deps.store);
  if (!session || !session.jwt) {
    return { ok: false, note: "这个号还没换到票 —— 上面「换票」那一步说了原因" };
  }
  const res = callOnce(deps.transport, withSession(userInfoRequest(deps.baseUrl), session.jwt));
  if (res.env === void 0) {
    return { ok: false, note: `读余额失败：${res.error ?? "未知失败"}` };
  }
  const code = res.env.code;
  if (code === 0) {
    const v = parseBalance(res.env);
    if (v === void 0) return { ok: false, note: "读到了 code=0，但响应里没有 result.flowerCnt" };
    return { ok: true, balance: v, note: `这一族能通：小红花余额 ${v} 朵` };
  }
  if (code === 90001) {
    return {
      ok: false,
      note: "服务端回 90001（未登录）—— 凭据是有的，所以问题在**请求头形状**：先怀疑少了 `jwttoken` / `showloading`，或多了签到族那套头（见 liveDraw.ts 文件头）"
    };
  }
  return { ok: false, note: `服务端回 ${code}${res.env.message ? `（${res.env.message}）` : ""}` };
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
    return { ok: true, idle: true, note: "领小红花没开（要先在服务端那边开启）" };
  }
  let s = loadDrawState(deps.store);
  const codes = collectCodes(deps.store, Date.parse(deps.nowIso));
  if (!s || s.step === "done") {
    const done = s?.codes ?? [];
    const { pool } = loadFreshPool(deps.store, Date.parse(deps.nowIso));
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
    const note2 = "领小红花要先有票 —— 上面「换票」那一步说了原因";
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
      const loaded = loadFreshPool(deps.store, Date.parse(deps.nowIso));
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
  const biz = () => `${label}：服务端回 ${res.env?.code ?? "?"}${res.env?.message ? `（${res.env.message}）` : ""}`;
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
      st.firstParticipate = code === 0 ? "领到首次参与惊喜奖" : code === 200110 ? "已参与过（正常）" : `服务端回 ${code ?? "?"}`;
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
function drawReport(st) {
  if (st === null) return null;
  const of = (k) => st.results.filter((r) => r.kind === k).map((r) => r.code);
  const succeeded = st.results.filter((r) => r.kind === "succeeded").length;
  const gained = st.balanceBefore === void 0 || st.balanceAfter === void 0 ? 0 : st.balanceAfter - st.balanceBefore;
  const parts = [];
  if (st.results.length === 0) parts.push("还没发出口令");
  else parts.push(`${st.results.length} 条口令领到 ${succeeded} 条`);
  if (st.balanceBefore !== void 0 && st.balanceAfter !== void 0) {
    parts.push(`进账 ${gained} 朵（${st.balanceBefore} → ${st.balanceAfter}）`);
  }
  const expired = of("kouling-expired");
  if (expired.length > 0) {
    parts.push(`${expired.length} 条口令认识但本场已经结束了（不是口令抄错）`);
  }
  const invalid = of("invalid-kouling");
  if (invalid.length > 0) parts.push(`${invalid.length} 条口令无效`);
  const other = [...of("other"), ...of("unparsable")];
  if (other.length > 0) parts.push(`${other.length} 条回了没见过的结果`);
  return {
    attempted: st.results.length,
    succeeded,
    gained,
    balanceBefore: st.balanceBefore,
    balanceAfter: st.balanceAfter,
    alreadyDrawn: of("already-drawn"),
    invalid,
    expired,
    other: of("other"),
    unparsable: of("unparsable"),
    line: parts.join(" · ")
  };
}

// src/mcloud/tasks/appTaskMatrix.ts
var MATRIX_MARKETS = ["sign_in_3", "newsign_139mail"];
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

// src/mcloud/dailyState.ts
var DAILY_DONE_KEY = "mcloud.daily.done_date";
var DAILY_LAST_KEY = "mcloud.daily.last_run";
function readDailyRun(store2) {
  const raw = store2.getState(DAILY_LAST_KEY);
  if (raw === void 0 || raw === null || raw === "") return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || !Array.isArray(v.steps)) return null;
    return v;
  } catch {
    return null;
  }
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
      error: `直播侧的 rtnCode 应当是**字符串**，实际是 ${code === void 0 ? "缺字段" : typeof code}（这一族用字符串码；服务端若真改成了数字码，这里必须报出来而不是兼容掉）`
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
    return `正在听：${KOULING_ANCHOR} 开播了（${hit.map((r) => r.title || `#${r.id}`).join("、")}）`;
  }
  if (live.length === 0) return `现在没在听：谁都没开播（看到 ${rooms.length} 间房，全是预告/回放）`;
  return `现在没在听：有 ${live.length} 间在播，但不是「${KOULING_ANCHOR}」的（${live.map((r) => r.anchorNickname || "无名").join("、")}）`;
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
function saveGateBase(store2, base, nowIso) {
  store2.setState(STATE_GATE_BASE, base.trim().replace(/\/+$/, ""), nowIso);
}
function loadGateState(store2) {
  return parseJson2(store2.getState(STATE_GATE));
}
function readGateReading(store2) {
  return parseJson2(store2.getState(STATE_READING2));
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
    const note2 = "这个号还没有原生凭据 —— 先在账号页把它加上";
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
    // 日志里一行一步，这里只说结果（怎么换的、留不留盘是代码的事，见文件头）
    // 这只是**第一步**（换票）；下一步才去看有没有开播 —— 说清楚，别让人以为已经看过了
    note: "票换好了，下一步去看有没有开播"
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
    const num3 = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (num3 === 0) throw new Error(`字段号为 0（key = ${key.value.toString()}）`);
    if (!Number.isSafeInteger(num3)) throw new Error(`字段号超出安全整数（key = ${key.value.toString()}）`);
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
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`字段 ${num3} 的声明长度超出范围`);
      if (data.length - i < size) {
        throw new Error(`字段 ${num3} 声明长度 ${size}，实际只剩 ${data.length - i} 字节`);
      }
      raw = new Uint8Array(data.subarray(i, i + size));
      i += size;
    } else if (wire === WIRE_FIXED64) {
      if (data.length - i < 8) throw new Error(`字段 ${num3} 的 64 位定长值被截断`);
      i += 8;
    } else if (wire === WIRE_FIXED32) {
      if (data.length - i < 4) throw new Error(`字段 ${num3} 的 32 位定长值被截断`);
      i += 4;
    } else {
      throw new Error(`不支持的 wire type ${wire}（字段 ${num3}）`);
    }
    out.push({ num: num3, wire, value, raw });
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
function lastBytesField(fields, num3) {
  let found;
  for (const f of fields) if (f.num === num3 && f.wire === WIRE_BYTES) found = f.raw;
  return found;
}
function lastVarintField(fields, num3) {
  let found;
  for (const f of fields) if (f.num === num3 && f.wire === WIRE_VARINT) found = f.value;
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
function putTag(out, num3, wire) {
  putVarint(out, BigInt(num3) << 3n | BigInt(wire));
}
function putScalar(out, num3, value) {
  if (value === 0n) return;
  putTag(out, num3, WIRE_VARINT);
  putVarint(out, value);
}
function putScalarForced(out, num3, value) {
  putTag(out, num3, WIRE_VARINT);
  putVarint(out, value);
}
function putString(out, num3, value) {
  if (value.length === 0) return;
  putBytesRaw(out, num3, utf8(value));
}
function putStringKeepingEmpty(out, num3, value) {
  putBytesRaw(out, num3, utf8(value));
}
function putBytesRaw(out, num3, body) {
  putTag(out, num3, WIRE_BYTES);
  putVarint(out, BigInt(body.length));
  for (let i = 0; i < body.length; i += 1) out.push(body[i]);
}
function putBytes(out, num3, body) {
  if (body.length === 0) return;
  putBytesRaw(out, num3, body);
}
function putMessage(out, num3, body) {
  putBytesRaw(out, num3, body);
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

// src/mcloud/liveAuto.ts
var ONE_HOUR_MS = 60 * 60 * 1e3;
var DAY_MS = 24 * ONE_HOUR_MS;
var BEIJING_OFFSET_MS = 8 * ONE_HOUR_MS;
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
function planTrusted(scheduleAtMs, nowMs) {
  return scheduleAtMs !== null && nowMs - scheduleAtMs <= SCHEDULE_TRUST_MS;
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
  const json2 = text.slice(SOCKJS_DATA_PREFIX.length - 1);
  let parsed;
  try {
    parsed = JSON.parse(json2);
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
function saveListenRoom(store2, v, nowIso) {
  store2.setState(STATE_LISTEN_ROOM, v.trim(), nowIso);
}
var DEFAULT_WS_HEARTBEAT = "h";
function loadWsHeartbeat(store2) {
  const v = store2.getState(STATE_WS_HEARTBEAT);
  return v === null || v === void 0 ? DEFAULT_WS_HEARTBEAT : v;
}
function saveWsHeartbeat(store2, v, nowIso) {
  store2.setState(STATE_WS_HEARTBEAT, v, nowIso);
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
function saveWsBase(store2, base, nowIso) {
  store2.setState(STATE_WS_BASE, base.trim().replace(/\/+$/, ""), nowIso);
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
    const d = new Date(st.nextCheckAtMs);
    const pad = (n) => String(n).padStart(2, "0");
    const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `现在没在听，${at} 之后再去看`;
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
      return finish2(deps, st, "窗口已结束");
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
  return { ok: true, note: "开始听了" };
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
    st.note = forced !== void 0 ? `指定的房间 ${forced} 不在这次探到的 ${merged.length} 间房里（诊断口子）` : coolMs > IDLE_RECHECK_MS ? `现在没在听（看到 ${merged.length} 间房，都不是它）—— 到下一场之后再去看（${hours(coolMs)}）` : `现在没在听（看到 ${merged.length} 间房，都不是它）—— 隔 ${hours(coolMs)}再看（上次真探 ${deps.nowIso.slice(11, 19)}）`;
    persist(deps, st);
    return { ok: true, note: humanNote(st.note) };
  }
  st.roomId = chosen;
  st.step = "userToken";
  st.probedAt = deps.nowIso;
  persist(deps, st);
  return {
    ok: true,
    note: forced === void 0 ? `找到了：房间 ${st.roomId} 在播，接着去听` : `诊断口子：直接听指定的房间 ${st.roomId}，接着取 WS 凭据`
  };
}
function humanNote(note2) {
  return note2.replace(/门关着（合并后 (\d+) 间房）/g, "现在没在听（看到 $1 间房）").replace(/门关着/g, "现在没在听").replace(/门开着/g, "正在听").replace(/（(\d+) 分钟）/g, (_m, n) => `（${hours(Number(n) * 6e4)}）`);
}
function hours(ms) {
  const min = Math.round(ms / 6e4);
  if (min < 90) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return `${h} 小时`;
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
        if (st.pendingHead === true) {
          const t = text.trim();
          if (t !== "" && !isKoulingHead(t) && !isKoulingMarker(t)) {
            found.push(t);
          }
          st.pendingHead = false;
        }
        if (hasKouling(text)) {
          for (const code of extractKouling(text)) found.push(code);
        }
        if (isKoulingHead(text)) st.pendingHead = true;
      }
    }
    if (actions.closed !== void 0) {
      if (actions.closed.includes("SockJS 心跳帧")) continue;
      endReason = actions.closed;
      break;
    }
  }
  if (found.length > 0) {
    const { pool } = loadFreshPool(deps.store, Date.now());
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
    // 与 `listenReadingLine` 同一套说法：只报弹幕/口令，帧数是排查用的
    note: `正在听（收到 ${st.danmakuFrames} 条弹幕，捡到 ${st.codes.length} 条口令${got}）`
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
function finish2(deps, st, note2) {
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
function saveImBase(store2, base, nowIso) {
  store2.setState(STATE_IM_BASE, base.trim().replace(/\/+$/, ""), nowIso);
}
function loadGateBaseOf(store2) {
  const v = store2.getState("mcloud.live.gate_base");
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : void 0;
}
function listenReadingLine(st) {
  if (st === null) return "还没听过";
  if (st.step === "listen") {
    const bits2 = [`收到 ${st.danmakuFrames} 条弹幕`];
    if (st.codes.length > 0) bits2.push(`捡到 ${st.codes.length} 条口令`);
    if ((st.serverAcks ?? 0) > 0) bits2.push(`回了 ${st.serverAcks} 次`);
    return `正在听（${bits2.join("、")}）`;
  }
  if (st.step === "done") {
    return humanNote(st.note ?? "这一轮结束");
  }
  return `准备中（${st.step}）`;
}

// src/crypto/qr.ts
function gfMul2(a, b) {
  let r = 0;
  let x = a & 255;
  let y = b & 255;
  while (y > 0) {
    if (y & 1) r ^= x;
    x <<= 1;
    if (x & 256) x ^= 285;
    y >>= 1;
  }
  return r & 255;
}
function gfExp(i) {
  let r = 1;
  for (let k = 0; k < i; k += 1) r = gfMul2(r, 2);
  return r;
}
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      const coef = poly[j];
      next[j] = next[j] ^ coef;
      next[j + 1] = next[j + 1] ^ gfMul2(coef, gfExp(i));
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const out = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    for (let i = 0; i < n; i += 1) out[i] = out[i] ^ gfMul2(gen[i + 1], factor);
  }
  return out;
}
var CAPACITY = {
  1: { data: 19, ecc: 7, blocks: [[1, 19]], align: [] },
  2: { data: 34, ecc: 10, blocks: [[1, 34]], align: [6, 18] },
  3: { data: 55, ecc: 15, blocks: [[1, 55]], align: [6, 22] },
  4: { data: 80, ecc: 20, blocks: [[1, 80]], align: [6, 26] },
  5: { data: 108, ecc: 26, blocks: [[1, 108]], align: [6, 30] },
  6: { data: 136, ecc: 18, blocks: [[2, 68]], align: [6, 34] },
  7: { data: 156, ecc: 20, blocks: [[2, 78]], align: [6, 22, 38] },
  8: { data: 194, ecc: 24, blocks: [[2, 97]], align: [6, 24, 42] },
  9: { data: 232, ecc: 30, blocks: [[2, 116]], align: [6, 26, 46] },
  10: { data: 274, ecc: 18, blocks: [[2, 68], [2, 69]], align: [6, 28, 50] }
};
var MAX_VERSION = 10;
function byteCapacity(version) {
  const cap = CAPACITY[version];
  if (cap === void 0) throw new Error(`二维码：不支持版本 ${version}`);
  const overhead = 4 + (version <= 9 ? 8 : 16);
  return cap.data - Math.ceil(overhead / 8);
}
var BitBuffer = class {
  constructor() {
    this.bits = [];
  }
  push(value, len) {
    for (let i = len - 1; i >= 0; i -= 1) this.bits.push(value >> i & 1);
  }
  get length() {
    return this.bits.length;
  }
};
function chooseVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    if (byteLen <= byteCapacity(v)) return v;
  }
  throw new Error(`二维码：载荷 ${byteLen} 字节太长（最大支持 ${byteCapacity(MAX_VERSION)}）`);
}
function encodeData(bytes, version) {
  const cap = CAPACITY[version];
  const buf = new BitBuffer();
  buf.push(4, 4);
  buf.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.push(b, 8);
  const totalBits = cap.data * 8;
  buf.push(0, Math.min(4, totalBits - buf.length));
  while (buf.length % 8 !== 0) buf.push(0, 1);
  const dataCw = [];
  for (let i = 0; i < buf.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = b << 1 | buf.bits[i + j];
    dataCw.push(b);
  }
  for (let i = 0; dataCw.length < cap.data; i += 1) dataCw.push(i % 2 === 0 ? 236 : 17);
  const blocks = [];
  const eccs = [];
  let off = 0;
  for (const [count, size] of cap.blocks) {
    for (let b = 0; b < count; b += 1) {
      const chunk = dataCw.slice(off, off + size);
      off += size;
      blocks.push(chunk);
      eccs.push(rsEncode(chunk, cap.ecc));
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < cap.ecc; i += 1) {
    for (const e of eccs) out.push(e[i]);
  }
  return out;
}
var VERSION_INFO = {
  7: 31892,
  8: 34236,
  9: 39577,
  10: 42195
};
var FORMAT_INFO = (() => {
  const out = [];
  for (let mask = 0; mask < 8; mask += 1) {
    const data = 1 << 3 | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if (rem >> i & 1) rem ^= 1335 << i - 10;
    }
    out.push((data << 10 | rem) ^ 21522);
  }
  return out;
})();
function placeFinder(m, size, r0, c0) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr * size + cc] = dark;
    }
  }
}
function placeAlign(m, size, r0, c0) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      m[rr * size + cc] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
}
function buildMatrix(codewords, version) {
  const size = version * 4 + 17;
  const dark = new Array(size * size).fill(false);
  const reserved = new Array(size * size).fill(false);
  const mark = (r, c, v) => {
    dark[r * size + c] = v;
    reserved[r * size + c] = true;
  };
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    placeFinder(dark, size, r0, c0);
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        reserved[rr * size + cc] = true;
      }
    }
  }
  const centers = CAPACITY[version].align;
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder = r <= 8 && c <= 8 || r <= 8 && c >= size - 9 || r >= size - 9 && c <= 8;
      if (nearFinder) continue;
      placeAlign(dark, size, r, c);
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) reserved[(r + dr) * size + (c + dc)] = true;
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i, i % 2 === 0);
    mark(i, 6, i % 2 === 0);
  }
  mark(size - 8, 8, true);
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8 * size + i]) mark(8, i, false);
    if (!reserved[i * size + 8]) mark(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8 * size + (size - 1 - i)]) mark(8, size - 1 - i, false);
    if (!reserved[(size - 1 - i) * size + 8]) mark(size - 1 - i, 8, false);
  }
  if (version >= 7) {
    const bits2 = VERSION_INFO[version];
    for (let i = 0; i < 18; i += 1) {
      const bit = (bits2 >> i & 1) === 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      mark(r, size - 11 + c, bit);
      mark(size - 11 + c, r, bit);
    }
  }
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i) => {
    if (i >= totalBits) return false;
    return (codewords[i >> 3] >> 7 - (i & 7) & 1) === 1;
  };
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row * size + c]) continue;
        dark[row * size + c] = bitAt(bitIdx);
        bitIdx += 1;
      }
    }
    upward = !upward;
  }
  return { dark, reserved };
}
var MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => r * c % 2 + r * c % 3 === 0,
  (r, c) => (r * c % 2 + r * c % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + r * c % 3) % 2 === 0
];
function penalty(m, size) {
  let score = 0;
  const at = (r, c) => m[r * size + c];
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (at(r, c) === at(r, c - 1)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (at(r, c) === at(r - 1, c)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  const patA = [true, false, true, true, true, false, true, false, false, false, false];
  const patB = [false, false, false, false, true, false, true, true, true, false, true];
  const match = (get, start) => {
    const at2 = (pat) => {
      for (let i = 0; i < 11; i += 1) if (get(start + i) !== pat[i]) return false;
      return true;
    };
    return at2(patA) || at2(patB);
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 11 <= size; c += 1) {
      if (match((i) => at(r, i), c)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r + 11 <= size; r += 1) {
      if (match((i) => at(i, c), r)) score += 40;
    }
  }
  let darkCount = 0;
  for (const d of m) if (d) darkCount += 1;
  const pct = darkCount * 100 / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}
var FORMAT_COORDS = [
  [8, 0],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 4],
  [8, 5],
  [8, 7],
  [8, 8],
  [7, 8],
  [5, 8],
  [4, 8],
  [3, 8],
  [2, 8],
  [1, 8],
  [0, 8]
];
function placeFormat(dark, size, mask) {
  const bits2 = FORMAT_INFO[mask];
  const bit = (i) => (bits2 >> i & 1) === 1;
  for (let i = 0; i < 15; i += 1) {
    const v = bit(i);
    const [c, r] = FORMAT_COORDS[i];
    dark[r * size + c] = v;
    if (i < 8) dark[8 * size + (size - 1 - i)] = v;
    else dark[(size - 15 + i) * size + 8] = v;
  }
  dark[(size - 8) * size + 8] = true;
}
function encodeQr(payload) {
  const bytes = Array.from(utf8(payload));
  const version = chooseVersion(bytes.length);
  const codewords = encodeData(bytes, version);
  const size = version * 4 + 17;
  const base = buildMatrix(codewords, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = base.dark.slice();
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (base.reserved[r * size + c]) continue;
        if (MASKS[mask](r, c)) m[r * size + c] = !m[r * size + c];
      }
    }
    placeFormat(m, size, mask);
    const score = penalty(m, size);
    if (best === null || score < best.score) best = { dark: m, score, mask };
  }
  return { version, size, dark: best.dark, reserved: base.reserved, mask: best.mask };
}
function qrSvg(payload, opts = {}) {
  const quiet = opts.quiet ?? 4;
  const scale = opts.scale ?? 6;
  const { size, dark, version } = encodeQr(payload);
  const side = size + quiet * 2;
  const px = side * scale;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!dark[r * size + c]) continue;
      rects.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges" data-version="${version}"><rect width="${px}" height="${px}" fill="#fff"/><path d="${rects.join("")}" fill="#000"/></svg>`;
}

// src/mcloud/login.ts
var LOGIN_HOST = "https://user-njs.yun.139.com";
var THIRD_LOGIN_PATH = "/user/thirdlogin";
var SEND_SMS_CODE_PATH = "/user/sms/getSmsCode";
var SLIDER_PUZZLE_PATH = "/user/verfycode";
var DEFAULT_PC_PLATFORM = "windows";
function parsePcPlatform(raw) {
  if (raw === "win" || raw === "windows") return "windows";
  if (raw === "mac" || raw === "macos") return "macos";
  return null;
}
function accountForm(platform) {
  return platform === "macos" ? "mac" : "win";
}
function pcClient(platform, deviceId) {
  return { platform, deviceId };
}
function clientType(c) {
  return c.platform === "windows" ? "656" : "710";
}
function cpid(c) {
  return c.platform === "windows" ? "277" : "332";
}
function appVersion(c) {
  return c.platform === "windows" ? "8.8.6.20260829" : "4.2.1";
}
var HUAWEI_CHANNEL_SRC = "10200153";
var MM_SOURCE = "000";
function deviceInfo(c) {
  return `||11|${appVersion(c)}|PC|QkYtMjAyMDAzMTAxNjQ3|${c.deviceId}|| Windows 10 (10.0)|1920X1040|Q2hpbmVzZSAoU2ltcGxpZmllZCk=|||`;
}
function pcHeaders(c) {
  const info = deviceInfo(c);
  return {
    "x-yun-client-info": info,
    "x-DeviceInfo": info,
    "x-MM-Source": MM_SOURCE,
    "x-huawei-channelSrc": HUAWEI_CHANNEL_SRC,
    "x-UserAgent": "PC"
  };
}
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256) & 255;
  return out;
}
function newPcDeviceId() {
  return `${toHex(randomBytes(16)).toUpperCase()}-ENDIN`;
}
function newSessionId() {
  return toHex(randomBytes(16)).toUpperCase();
}
function newSmsRandom() {
  return toHex(randomBytes(12));
}
var QR_LOGIN_URL = "https://yun.139.com/w/#/qrcLogin";
function qrPayload(c, sessionId) {
  return `${QR_LOGIN_URL}?dID=${c.deviceId}&sID=${sessionId}&cType=11&ver=${appVersion(c)}`;
}
function pintype(kind) {
  return kind === "qr" ? "21" : kind === "sms" ? "5" : "9";
}
function ifOpenAccount(kind) {
  return kind === "sms" ? 1 : 0;
}
var CODES = {
  OK_ZERO: 0,
  OK_200: 200,
  /** 未找到设备的二维码信息 —— 码还没被扫。 */
  QR_NOT_SCANNED: 200059541,
  /** 二维码信息未授权 —— **已扫码，等用户在手机上确认**。 */
  QR_SCANNED: 200059548,
  /** 二维码信息与登录二维码信息不一致 —— `sID` 不匹配。 */
  QR_MISMATCH: 200059544,
  /** 二维码已失效 —— 超时，必须重新出码。 */
  QR_EXPIRED: 200059542,
  /** 扫码登录过于频繁 —— 语义是**限流**：该退避，不该换张码立刻重试。 */
  QR_TOO_FREQUENT: 200059545,
  /** 请先获取滑块拼图验证码。 */
  NEED_SLIDER: 200059554,
  /** 同一滑块验证码校验失败次数超限 —— 挑战作废，**必须重新取图**。 */
  SLIDER_EXHAUSTED: 200059553,
  /** 用户 token 不能为空（退出登录的实测常态：客户端先清 token 再调 logout）。 */
  TOKEN_EMPTY: 1000001,
  /** 输入参数不合法 —— 服务端**解不开请求体**。 */
  UNDECRYPTABLE_BODY: 9103,
  /** 验证码不正确 —— 请求体已被正确解析，只是短信码不对/过期。 */
  SMS_CODE_WRONG: 9441,
  /** 登录失败！—— 设备头缺失/不完整时的表现。 */
  LOGIN_FAILED: 9999
};
function isSuccessCode(code) {
  return code === CODES.OK_ZERO || code === CODES.OK_200;
}
function thirdloginBody(c, kind, dycpwd, msisdn) {
  return {
    clientType: clientType(c),
    cpid: cpid(c),
    dycpwd,
    extInfo: { ifOpenAccount: ifOpenAccount(kind) },
    loginMode: "0",
    msisdn,
    pintype: pintype(kind),
    verType: "2",
    version: appVersion(c)
  };
}
function qrThirdloginBody(c, sessionId) {
  return thirdloginBody(c, "qr", sessionId, "");
}
function smsThirdloginBody(c, phone, smsCode) {
  return thirdloginBody(c, "sms", smsCode, phone);
}
function passwordThirdloginBody(c, username, password) {
  return thirdloginBody(c, "password", passwordHash(password), username);
}
function sendSmsCodeBody(c, phone, random) {
  return {
    phoneNumber: phone,
    random,
    mode: 0,
    reqType: 3,
    clientType: clientType(c)
  };
}
function sliderPuzzleBody(phone) {
  return { account: phone, type: 2 };
}
function sendSmsCodeBodyWithSlider(c, phone, random, sliderAnswer2) {
  return {
    ...sendSmsCodeBody(c, phone, random),
    puzzleVerfycode: puzzleVerfycodeEncrypt(sliderAnswer2)
  };
}
var PASSWORD_HASH_PREFIX = "fetion.com.cn:";
function passwordHash(password) {
  return toHex(sha1(utf8(`${PASSWORD_HASH_PREFIX}${password}`))).toUpperCase();
}
var PUZZLE_AES_KEY = "CREATPUZZLE03F9A";
var PUZZLE_AES_IV = "E526E1F3F9765444";
function puzzleVerfycodeEncrypt(sliderAnswer2) {
  return encryptWithDynamicIv(utf8(PUZZLE_AES_KEY), utf8(PUZZLE_AES_IV), sliderAnswer2);
}
function sliderAnswer(p) {
  const plain = decryptWithDynamicIv(utf8(PUZZLE_AES_KEY), p.leftEncrypted).trim();
  if (plain === "" || !/^\d+$/.test(plain)) {
    throw new Error(`滑块缺口坐标不是十进制数：${JSON.stringify(plain)}`);
  }
  const x = Number(plain);
  if (p.picWidth !== null && (x < 0 || x > p.picWidth)) {
    throw new Error(`滑块缺口坐标 ${x} 超出图宽 ${p.picWidth}`);
  }
  return plain;
}
function parseLoginEnvelope(body) {
  if (body.trim() === "") throw new Error("空响应");
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    throw new Error(`登录响应不是 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof v !== "object" || v === null) throw new Error("登录响应不是 JSON 对象");
  const raw = v["code"];
  const rawCode = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : raw == null ? "" : JSON.stringify(raw);
  const code = rawCode === "" ? null : /^-?\d+$/.test(rawCode) ? Number(rawCode) : null;
  const msg = v["message"] ?? v["msg"];
  return {
    code,
    rawCode,
    message: typeof msg === "string" ? msg : "",
    data: v["data"] ?? null
  };
}
function classifyPoll(env) {
  switch (env.code) {
    case CODES.QR_NOT_SCANNED:
      return { kind: "not-scanned" };
    case CODES.QR_SCANNED:
      return { kind: "scanned" };
    case CODES.QR_MISMATCH:
      return { kind: "session-mismatch" };
    case CODES.QR_EXPIRED:
      return { kind: "expired" };
    case CODES.QR_TOO_FREQUENT:
      return { kind: "too-frequent" };
    default:
      break;
  }
  if (isSuccessCode(env.code)) {
    if (typeof env.data === "string") return { kind: "success", encrypted: env.data };
    return { kind: "other", code: env.code, message: "登录成功但 data 不是密文字符串" };
  }
  return { kind: "other", code: env.code, message: env.message };
}
function classifySendSms(env) {
  const payload = env.data && typeof env.data === "object" ? env.data : {};
  const captchaType = typeof payload["captchaType"] === "number" ? payload["captchaType"] : null;
  if (isSuccessCode(env.code)) {
    const remain = payload["remainGetTimes"];
    return { kind: "sent", remainGetTimes: typeof remain === "number" ? remain : null };
  }
  if (env.code === CODES.NEED_SLIDER) return { kind: "need-slider", captchaType };
  if (env.code === CODES.SLIDER_EXHAUSTED) return { kind: "slider-exhausted", captchaType };
  return { kind: "other", code: env.code, message: env.message };
}
var LOGIN_AES_KEY = "qPqDw263XgFgL3u8";
function decryptUserInfo(ciphertext, key = LOGIN_AES_KEY) {
  const plain = aesEcbPkcs7DecryptHex(key, ciphertext);
  let v;
  try {
    v = JSON.parse(plain);
  } catch (e) {
    throw new Error(
      `userInfo 不是合法 JSON（密钥不对或用错模式都会落到这里）：${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (typeof v !== "object" || v === null) throw new Error("userInfo 不是 JSON 对象");
  return v;
}
function formatAuth(prefix, account, authToken) {
  if (account === "" || authToken === "") {
    throw new Error("拼 auth 缺少账号或 authToken");
  }
  return `Basic ${toBase64(utf8(`${prefix}:${account}:${authToken}`))}`;
}
function maskPhone(phone) {
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 2)}****${phone.slice(-2)}`;
}
function authFromUserInfo(userInfo, prefix = PC_AUTH_PREFIX) {
  const field = (name) => {
    const v = userInfo[name];
    if (typeof v !== "string" || v === "") throw new Error(`登录结果缺少字段 ${name}`);
    return v;
  };
  return formatAuth(prefix, field("account"), field("authToken"));
}
function userDomainIdFrom(userInfo) {
  const v = userInfo["userDomainId"];
  return typeof v === "string" ? v : "";
}
function withClientHeaders(req, c, tid) {
  return { ...req, headers: { ...req.headers, ...pcHeaders(c), "x-yun-tid": tid } };
}
function loginUrl(path, base) {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  return `${b === "" ? LOGIN_HOST : b}${path}`;
}
function postJson2(path, body, base) {
  return {
    url: loginUrl(path, base),
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ⚠⚠ `accept-encoding: identity` 是**必须**的，不是优化（F-072）。
      //
      //   宿主（面板）会替我们发 `accept-encoding: gzip`，**但它不解压** ——
      //   压缩过的响应体到了插件这边是一串二进制，`JSON.parse` 必然失败。
      //   而移动云盘只在响应**够大**时才压：错误响应 94 字节（不压），
      //   登录成功那个带 `data` 密文的响应 1–2 KB（压）——
      //   于是表现成"扫码确认之后什么也没发生"。
      //
      //   实测：登录基址指向一个"你要 gzip 我就压"的本地服务器时，
      //   `accept-encoding: gzip` 拿回来的是乱码；改口要 identity 就拿到完整 JSON。
      //
      //   ⚠ 放在这里而不是 `pcHeaders`：那里是**冒充哪台设备**的 5 个头
      //   （有测试钉死"就是这 5 个"），而这一条是传输层的事。
      "accept-encoding": "identity"
    },
    body: JSON.stringify(body)
  };
}
function thirdloginRequest(c, tid, body, base) {
  return withClientHeaders(postJson2(THIRD_LOGIN_PATH, body, base), c, tid);
}
function sendSmsCodeRequest(c, tid, body, base) {
  return withClientHeaders(postJson2(SEND_SMS_CODE_PATH, body, base), c, tid);
}
function sliderPuzzleRequest(c, tid, body, base) {
  return withClientHeaders(postJson2(SLIDER_PUZZLE_PATH, body, base), c, tid);
}
function parseSliderPuzzle(env) {
  const payload = env.data;
  if (!payload || typeof payload !== "object") throw new Error("取滑块响应里没有 data");
  const p = payload;
  const field = (name) => {
    const v = p[name];
    if (typeof v !== "string" || v === "") throw new Error(`取滑块响应里缺少 ${name}`);
    return v;
  };
  const size = (name) => {
    const v = p[name];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    return null;
  };
  return {
    backgroundB64: field("picture"),
    puzzleB64: field("puzzle"),
    picWidth: size("picWidth"),
    puzzleWidth: size("puzzleWidth"),
    leftEncrypted: field("puzzleLeft")
  };
}
var QR_TTL_SECONDS = 120;
function newQrSession(deviceId, nowMs, platform = DEFAULT_PC_PLATFORM) {
  return {
    sessionId: newSessionId(),
    deviceId,
    platform,
    startedAtMs: nowMs,
    // ⚠ 整趟一个 `x-yun-tid`（参考实现也是这么做的，见 `QrSession.tid`）
    tid: uuidV4(),
    scanned: false,
    done: false,
    lastNote: "等手机扫码"
  };
}
function qrExpiresAt(s) {
  return s.startedAtMs + QR_TTL_SECONDS * 1e3;
}
function qrExpired(s, nowMs) {
  return nowMs >= qrExpiresAt(s);
}
function qrRemainingMs(s, nowMs) {
  return Math.max(0, qrExpiresAt(s) - nowMs);
}
function applyPoll(s, out, nowMs) {
  switch (out.kind) {
    case "not-scanned":
      if (s.scanned) {
        const note2 = "扫到了，但手机上没确认 —— 再扫一次，扫完就点「确认登录」";
        return { session: { ...s, lastNote: note2 }, stop: false, ok: true, note: note2 };
      }
      return { session: { ...s, lastNote: "等手机扫码" }, stop: false, ok: true, note: "等手机扫码" };
    case "scanned":
      return {
        session: { ...s, scanned: true, lastNote: "已扫码，去手机上点「确认登录」" },
        stop: false,
        ok: true,
        note: "已扫码，去手机上点「确认登录」"
      };
    case "success":
      return {
        session: { ...s, done: true, lastNote: "登录成功" },
        stop: true,
        ok: true,
        note: "登录成功",
        encrypted: out.encrypted
      };
    case "expired":
      return {
        session: { ...s, lastNote: "二维码过期了，重新出码" },
        stop: true,
        ok: false,
        note: "二维码过期了（超过 120 秒），点「扫码登录」重新出码"
      };
    case "too-frequent":
      return {
        session: { ...s, lastNote: "扫码太频繁，等一下" },
        // ⚠ **停下来**，不是继续轮。注释与代码一度不一致（注释写"停在这里
        //   让用户自己等"、代码写的 `stop: false`）—— 测试把这条抓出来了。
        //   继续每秒轮的表现是把限流喂得更狠，然后上游给更长的封禁。
        stop: true,
        ok: true,
        note: "扫码登录过于频繁，等一会儿再试（不要重新出码）"
      };
    case "session-mismatch":
      return {
        session: { ...s, lastNote: "会话对不上，重新出码" },
        stop: true,
        ok: false,
        note: "会话对不上（`sID` 变了），点「扫码登录」重新出码"
      };
    default:
      return {
        session: { ...s, lastNote: `服务端说：${out.message || `code=${out.code}`}` },
        stop: true,
        ok: false,
        note: `登录没成：${out.message || `code=${out.code}`}`
      };
  }
}
function newSmsSession(phone, nowMs, platform = DEFAULT_PC_PLATFORM) {
  return {
    phone,
    random: newSmsRandom(),
    platform,
    startedAtMs: nowMs,
    sent: false,
    slider: null,
    lastNote: "还没发码"
  };
}

// src/mcloud/appLogin.ts
var APP_LOGIN_AES_KEY = "lYzvvBMUjucw+h^R";
var SEND_SMS_RANDOM = "qwert";
var APP_CLIENT_TYPE2 = "412";
var APP_CPID = "55";
var APP_VERSION = "12.6.0";
var APP_CHANNEL = "10000020";
var APP_SERVICE_IDENTIFIER = "service_identifier_userDomain";
var APP_USER_AGENT = "mCloud_iPhone/12.6.0 (iPad; iOS 26.6; Scale/2.00)";
var APP_X_USER_AGENT = "412|iPad|ios 26.6|12.6.0-200";
var APP_X_YUN_USER_AGENT = "iPad|iPad|ios 26.6|mCloud12.6.0-200";
var APP_DEVICE_NAME_B64 = "aVBhZA==";
var APP_DEFAULT_IP = "192.168.3.179";
var APP_DEVICE_MODEL = "iPad8,6";
var APP_SEND_SMS_CODE_PATH = "/user/sms/getSmsCode";
var APP_THIRDLOGIN_PATH = "/user/thirdlogin";
function shiftTail10ToFront(hex) {
  if (hex.length <= 10) return hex;
  return hex.slice(-10) + hex.slice(0, -10);
}
function encryptBody(plaintext, key = APP_LOGIN_AES_KEY) {
  return shiftTail10ToFront(aesEcbPkcs7EncryptHex(key, plaintext));
}
function sendSmsCodeBody2(phone, puzzleVerfycode = "") {
  return {
    mode: "0",
    phoneNumber: phone,
    reqType: "3",
    clientType: APP_CLIENT_TYPE2,
    random: SEND_SMS_RANDOM,
    puzzleVerfycode
  };
}
function smsThirdloginBody2(phone, smsCode, random) {
  return {
    cpid: APP_CPID,
    extInfo: { ifOpenAccount: "1" },
    dycpwd: smsCode,
    pintype: "8",
    loginMode: "0",
    verType: "1",
    version: APP_VERSION,
    msisdn: phone,
    random,
    clienttype: APP_CLIENT_TYPE2
  };
}
function newLoginRandom() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function appDeviceInfo(deviceId) {
  return `1|${APP_DEFAULT_IP}|2|${APP_VERSION}|APPLE|${APP_DEVICE_MODEL}|${deviceId}|AAA000000000|ipados 26.6|375 * 667|zh-Hans-CN|0.0000|0.0000|`;
}
function appClientInfo(deviceId) {
  return `${appDeviceInfo(deviceId)}${APP_DEVICE_NAME_B64}|0|;`;
}
function appHeaders(deviceId, timestamp) {
  return {
    // ⚠ 与 `pcHeaders` 同一个理由（F-072）：宿主替我们发 `accept-encoding: gzip`
    //   但**不解压**，而登录成功的响应体是压过的 ⇒ 明确要 identity。
    "accept-encoding": "identity",
    Pragma: "no-cache",
    "x-yun-user-timestamp": String(timestamp),
    "x-yun-app-channel": APP_CHANNEL,
    "x-yun-net-type": "1",
    "x-yun-svc-type": "1",
    "x-huawei-channelSrc": APP_CHANNEL,
    "x-yun-api-version": "v1",
    "x-UserAgent": APP_X_USER_AGENT,
    "x-yun-client-info": appClientInfo(deviceId),
    "Accept-Language": "zh-CN",
    service_identifier_key: APP_SERVICE_IDENTIFIER,
    "User-Agent": APP_USER_AGENT,
    "x-DeviceName": APP_DEVICE_NAME_B64,
    "x-DeviceInfo": appDeviceInfo(deviceId),
    "x-yun-user-agent": APP_X_YUN_USER_AGENT,
    "x-SvcType": "1",
    // ⚠ 这里**故意没有** `hcy-cool-flag`（见上面的说明）。
    //   要加的话响应体会变成一段没有密钥的加密串。
    "Content-Type": "application/json;charset=UTF-8"
  };
}
var APP_LOGIN_HOST = "https://user-njs.yun.139.com";
function appPost(path, rawBody, deviceId, timestamp, base) {
  const host2 = base === void 0 || base.trim() === "" ? APP_LOGIN_HOST : base.trim().replace(/\/+$/, "");
  return {
    url: `${host2}${path}`,
    method: "POST",
    headers: appHeaders(deviceId, timestamp),
    body: rawBody
  };
}
function appSendSmsCodeRequest(deviceId, timestamp, phone, puzzleVerfycode = "", base) {
  return appPost(
    APP_SEND_SMS_CODE_PATH,
    JSON.stringify(sendSmsCodeBody2(phone, puzzleVerfycode)),
    deviceId,
    timestamp,
    base
  );
}
function appThirdloginRequest(deviceId, timestamp, phone, smsCode, random, key = APP_LOGIN_AES_KEY, base) {
  const plaintext = JSON.stringify(smsThirdloginBody2(phone, smsCode, random));
  return appPost(APP_THIRDLOGIN_PATH, encryptBody(plaintext, key), deviceId, timestamp, base);
}
var APP_SLIDER_PUZZLE_PATH = "/user/verfycode";
function classifyAppSendSms(env) {
  if (isSuccessCode(env.code)) {
    const d = env.data ?? {};
    const remain = typeof d["remainGetTimes"] === "number" ? d["remainGetTimes"] : null;
    return { kind: "sent", remainGetTimes: remain };
  }
  if (env.code === CODES.NEED_SLIDER) {
    return { kind: "need-captcha", note: "移动云盘要滑块 —— 先点「发验证码」取题面" };
  }
  if (env.code === CODES.SLIDER_EXHAUSTED) {
    return { kind: "slider-exhausted", note: "这道滑块的尝试次数用完了 —— 会重取一道新题" };
  }
  return { kind: "other", note: `发码没成：${env.message || `code=${env.code}`}` };
}
function classifyAppLogin(env) {
  if (isSuccessCode(env.code)) {
    if (typeof env.data === "string") return { kind: "success", encrypted: env.data };
    return { kind: "other", note: "登录成功了，但返回的载荷不是密文字符串（形状不对）" };
  }
  if (env.code === CODES.UNDECRYPTABLE_BODY) {
    return { kind: "undecryptable", note: "服务端解不开请求体（9103）—— 加密或错位那一层不对" };
  }
  if (env.code === CODES.SMS_CODE_WRONG) {
    return { kind: "code-wrong", note: "验证码不对（或者过期了），再看一眼短信" };
  }
  if (env.code === CODES.LOGIN_FAILED) {
    return { kind: "failed", note: "登录失败（9999）—— 设备头缺失或不完整" };
  }
  return { kind: "other", note: `登录没成：${env.message || `code=${env.code}`}` };
}

// src/mcloud/loginSession.ts
var STATE_DEVICE_ID2 = "mcloud.login.deviceId";
var STATE_QR_SESSION = "mcloud.login.qr";
var STATE_SMS_SESSION = "mcloud.login.sms";
var STATE_APP_SESSION = "mcloud.login.app";
var STATE_LOGIN_PREF = "mcloud.login.pref";
var STATE_LOGIN_BASE = "mcloud.login.base";
var STATE_LOGIN_DOMAIN = "mcloud.login.userDomainId";
function loadDeviceId(store2, nowIso) {
  const cur = store2.getState(STATE_DEVICE_ID2);
  if (cur !== void 0 && cur !== null && cur !== "") return cur;
  const fresh = newPcDeviceId();
  store2.setState(STATE_DEVICE_ID2, fresh, nowIso);
  return fresh;
}
function resetDeviceId(store2, nowIso) {
  const fresh = newPcDeviceId();
  store2.setState(STATE_DEVICE_ID2, fresh, nowIso);
  clearLogin(store2);
  return fresh;
}
function parseJson4(raw) {
  if (raw === void 0 || raw === null || raw === "") return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}
function derivedTid(sessionId) {
  const h = toHex(sha1(utf8(`mcloud-qr-tid:${sessionId}`)));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function loadQrSession(store2) {
  const s = parseJson4(store2.getState(STATE_QR_SESSION));
  if (s === null) return null;
  if (typeof s.sessionId !== "string" || typeof s.deviceId !== "string") return null;
  return {
    ...s,
    platform: parsePcPlatform(s.platform) ?? DEFAULT_PC_PLATFORM,
    tid: typeof s.tid === "string" && s.tid !== "" ? s.tid : derivedTid(s.sessionId)
  };
}
function saveQrSession(store2, s, nowIso) {
  store2.setState(STATE_QR_SESSION, JSON.stringify(s), nowIso);
}
function loadSmsSession(store2) {
  const s = parseJson4(store2.getState(STATE_SMS_SESSION));
  if (s === null) return null;
  if (typeof s.phone !== "string" || typeof s.random !== "string") return null;
  return { ...s, platform: parsePcPlatform(s.platform) ?? DEFAULT_PC_PLATFORM };
}
function saveSmsSession(store2, s, nowIso) {
  store2.setState(STATE_SMS_SESSION, JSON.stringify(s), nowIso);
}
function loadAppSession(store2) {
  return parseJson4(store2.getState(STATE_APP_SESSION));
}
function saveAppSession(store2, a, nowIso) {
  store2.setState(STATE_APP_SESSION, JSON.stringify(a), nowIso);
}
function startAppSession(store2, phone, nowMs, nowIso) {
  const a = {
    phone,
    // ⚠ 用 App 的随机串构造（`newLoginRandom`），**不是** PC 那个 ——
    //   它是 `smsThirdloginBody` 的一个字段，两端格式不同。
    random: newLoginRandom(),
    startedAtMs: nowMs,
    sent: false,
    slider: null,
    lastNote: "还没发码"
  };
  saveAppSession(store2, a, nowIso);
  return a;
}
function clearLogin(store2) {
  store2.setState(STATE_QR_SESSION, "", (/* @__PURE__ */ new Date()).toISOString());
  store2.setState(STATE_SMS_SESSION, "", (/* @__PURE__ */ new Date()).toISOString());
  store2.setState(STATE_APP_SESSION, "", (/* @__PURE__ */ new Date()).toISOString());
}
function startQrSession(store2, nowMs, nowIso, platform = DEFAULT_PC_PLATFORM) {
  const deviceId = loadDeviceId(store2, nowIso);
  const s = newQrSession(deviceId, nowMs, platform);
  saveQrSession(store2, s, nowIso);
  return s;
}
function startSmsSession(store2, phone, nowMs, nowIso, platform = DEFAULT_PC_PLATFORM) {
  const s = newSmsSession(phone, nowMs, platform);
  saveSmsSession(store2, s, nowIso);
  return s;
}
function setSmsSlider(store2, s, slider, nowIso) {
  const next = { ...s, slider };
  saveSmsSession(store2, next, nowIso);
  return next;
}
var QR_POLL_MS = 1e3;
function loginReading(store2, nowMs, qrPayloadOf) {
  const qr = loadQrSession(store2);
  const sms = loadSmsSession(store2);
  return {
    deviceId: store2.getState(STATE_DEVICE_ID2) ?? "",
    qr: qr === null ? null : {
      active: true,
      sessionId: qr.sessionId,
      payload: qrPayloadOf(qr.sessionId, qr.deviceId),
      platform: qr.platform,
      pollMs: QR_POLL_MS,
      scanned: qr.scanned,
      expiresInMs: qrRemainingMs(qr, nowMs),
      expired: qrExpired(qr, nowMs),
      note: qr.lastNote
    },
    sms: sms === null ? null : {
      active: true,
      phone: sms.phone,
      platform: sms.platform,
      sent: sms.sent,
      hasSlider: sms.slider !== null,
      slider: sms.slider,
      // 验证码 5 分钟（上游实测），从**发码**那一刻算 —— 这里用会话开始时刻近似
      expiresInMs: Math.max(0, sms.startedAtMs + 3e5 - nowMs),
      note: sms.lastNote
    },
    // 手机端（App 那条）。形状与 `sms` 刻意一致 —— 界面上两者的进度显示一样，
    // 差别只在**这一趟走的是哪一套头/体**，而那件事由页签决定，不用读数来说。
    app: (() => {
      const a = loadAppSession(store2);
      return a === null ? null : {
        active: true,
        phone: a.phone,
        sent: a.sent,
        hasSlider: a.slider !== null,
        slider: a.slider,
        expiresInMs: Math.max(0, a.startedAtMs + 3e5 - nowMs),
        note: a.lastNote
      };
    })()
  };
}

// src/mcloud/exchangePlans.ts
var STATE_PLANS = "mcloud.exchange.plans";
var STATE_PLAN_RUNS = "mcloud.exchange.plan.runs";
function newPlanId() {
  return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function loadPlans(store2) {
  const raw = (store2.getState(STATE_PLANS) ?? "").trim();
  if (raw === "") return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => {
      if (x === null || typeof x !== "object") return false;
      const p = x;
      return typeof p.id === "string" && typeof p.accountId === "string" && typeof p.prizeName === "string" && typeof p.cron === "string" && typeof p.leadSec === "number" && typeof p.until === "string" && typeof p.maxRuns === "number" && typeof p.enabled === "boolean";
    });
  } catch {
    return [];
  }
}
function savePlans(store2, plans, nowIso) {
  store2.setState(STATE_PLANS, JSON.stringify(plans), nowIso);
}
function enabledPlans(plans) {
  return plans.filter((p) => p.enabled);
}
function unionCron(plans) {
  const hours2 = /* @__PURE__ */ new Set();
  for (const p of plans) {
    if (!p.enabled) continue;
    try {
      for (const h of parseCron(p.cron).hours) hours2.add(h);
    } catch {
    }
  }
  if (hours2.size === 0) return "0 10 * * *";
  return "0 " + [...hours2].sort((a, b) => a - b).join(",") + " * * *";
}
function maxLeadMs(plans) {
  let ms = 6e4;
  for (const p of plans) {
    if (!p.enabled) continue;
    ms = Math.max(ms, Math.min(300, Math.max(60, p.leadSec)) * 1e3);
  }
  return ms;
}
function nextPlanTargetMs(plans, afterMs) {
  let best = null;
  for (const p of plans) {
    if (!p.enabled) continue;
    const t = nextCronTargetMs(p.cron, afterMs);
    if (t === null) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}
function fmtLocal(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:00`;
}
function planSummary(store2, nowMs = Date.now()) {
  const plans = loadPlans(store2);
  const on = enabledPlans(plans);
  if (on.length === 0) return plans.length === 0 ? "还没设定时计划" : `${plans.length} 个计划（都未启用）`;
  const next = nextPlanTargetMs(on, nowMs);
  const head = `${on.length} 个计划`;
  return next === null ? head : `${head} · 下次 ${fmtLocal(next)}`;
}
function loadPlanRuns(store2) {
  const raw = (store2.getState(STATE_PLAN_RUNS) ?? "").trim();
  if (raw === "") return {};
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function resetPlanRuns(store2, planId, nowIso) {
  const all = loadPlanRuns(store2);
  delete all[planId];
  store2.setState(STATE_PLAN_RUNS, JSON.stringify(all), nowIso);
}
function planViews(store2) {
  const accounts = loadAccounts(store2);
  const runs = loadPlanRuns(store2);
  return loadPlans(store2).map((p) => {
    const a = accounts.find((x) => x.id === p.accountId);
    const next = nextCronTargetMs(p.cron, Date.now());
    return {
      id: p.id,
      accountId: p.accountId,
      accountLabel: a?.label ?? p.accountId,
      accountOk: !!a && a.disabled !== true,
      prizeId: p.prizeId ?? null,
      prizeName: p.prizeName,
      cron: p.cron,
      leadSec: p.leadSec,
      until: p.until,
      maxRuns: p.maxRuns,
      enabled: p.enabled,
      runs: runs[p.id] ?? 0,
      nextRun: p.enabled && next !== null ? new Date(next).toISOString() : ""
    };
  });
}

// src/mcloud/taskReadiness.ts
var H = globalThis.host ?? globalThis.host_api ?? {};
function call(name, ...args) {
  const fn = H[name];
  if (typeof fn !== "function") return;
  try {
    fn(...args);
  } catch {
  }
}
function enabledAccountCount(store2) {
  return loadAccounts(store2).filter((a) => a.disabled !== true).length;
}
function exchangePlanTarget(store2) {
  return (store2.getState("mcloud.exchange.schedule.plan") ?? "").trim();
}
function blockersFor(store2, task) {
  if (task === "兑换") {
    const plans = loadPlans(store2);
    if (plans.length === 0) return ["还没设定时计划"];
    const on = plans.filter((p) => p.enabled);
    if (on.length === 0) return ["所有计划都未启用"];
    const accounts = loadAccounts(store2);
    const bad = on.filter((p) => {
      const a = accounts.find((x) => x.id === p.accountId);
      return !a || a.disabled === true;
    });
    if (bad.length === on.length) return ["计划里的账号都不可用"];
    return [];
  }
  return enabledAccountCount(store2) === 0 ? ["还没有账号"] : [];
}
function accountLabels(store2, ids) {
  const all = loadAccounts(store2);
  const out = ids.map((id) => all.find((a) => a.id === id)?.label ?? id);
  if (out.length === 0) return "无";
  const head = out.slice(0, 3).join("、");
  return out.length > 3 ? head + " 等" : head;
}
function summaryFor(store2, task) {
  if (task === "兑换") return planSummary(store2);
  const n = enabledAccountCount(store2);
  if (n === 0) return "还没有账号";
  const ids = loadAccounts(store2).filter((a) => a.disabled !== true).map((a) => a.id);
  return n <= 3 ? n + " 个账号（" + accountLabels(store2, ids) + "）" : n + " 个账号";
}
var TASK_KEYS = {
  日常: "mcloud-daily/日常",
  兑换: "mcloud-exchange/兑换",
  直播: "mcloud-live/直播"
};
function setTaskSummary(task, text) {
  call("set_job_summary", TASK_KEYS[task] ?? task, text);
}
function setTaskBlockers(task, blockers) {
  call("set_job_blockers", TASK_KEYS[task] ?? task, blockers);
}
function setTaskSchedule(task, expr, leadMs) {
  call("set_job_schedule", TASK_KEYS[task] ?? task, { expr, lead_ms: leadMs });
}
function setTaskPaused(task, paused) {
  call("set_job_paused", TASK_KEYS[task] ?? task, paused);
}
function migrateLegacyExchange(store2, nowIso) {
  if (exchangePlanTarget(store2) === "") return false;
  if ((store2.getState("mcloud.exchange.schedule.enabled") ?? "").trim() !== "") return false;
  if ((store2.getState(taskAccountsKey("兑换")) ?? "").trim() !== "") return false;
  saveTaskAccounts(store2, "兑换", { all: true, ids: [] }, nowIso);
  store2.setState("mcloud.exchange.schedule.enabled", "1", nowIso);
  return true;
}
function syncTaskReadiness(store2, tasks = ["日常", "兑换", "直播"]) {
  for (const task of tasks) {
    const key = TASK_KEYS[task] ?? task;
    call("set_job_blockers", key, blockersFor(store2, task));
    call("set_job_summary", key, summaryFor(store2, task));
  }
}

// src/mcloud/beans.ts
var LEDGER_AI_DOU = 1;
var TYPE_ALL = 0;
var PAGE_SIZE = 100;
var MAX_PAGES = 20;
var MAX_DETAIL_RECORDS = 500;
var DAY_MS2 = 864e5;
var BEIJING_OFFSET_SECS = 8 * 3600;
function beanQuery(pageNumber) {
  return `aiDou=${LEDGER_AI_DOU}&type=${TYPE_ALL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
}
function dayStartMs(nowMs) {
  const offsetMs = BEIJING_OFFSET_SECS * 1e3;
  const local = Math.floor((nowMs + offsetMs) / DAY_MS2) * DAY_MS2;
  return local - offsetMs;
}
function isToday(tsMs, nowMs) {
  const start = dayStartMs(nowMs);
  return tsMs >= start && tsMs < start + DAY_MS2;
}
function rangeSinceMs(days, nowMs) {
  if (!(days > 0)) return void 0;
  return dayStartMs(nowMs) - (days - 1) * DAY_MS2;
}
function parseInsertTimeMs(raw) {
  const s = raw.trim();
  const tAt = s.indexOf("T");
  if (tAt < 0) return void 0;
  const date = s.slice(0, tAt);
  const rest = s.slice(tAt + 1);
  let time;
  let offsetSecs;
  if (rest.endsWith("Z") || rest.endsWith("z")) {
    time = rest.slice(0, -1);
    offsetSecs = 0;
  } else {
    const signAt = Math.max(rest.lastIndexOf("+"), rest.lastIndexOf("-"));
    if (signAt <= 0) return void 0;
    time = rest.slice(0, signAt);
    const off = rest.slice(signAt);
    const sign = off.startsWith("-") ? -1 : 1;
    const [hhRaw, mmRaw] = off.slice(1).split(":");
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return void 0;
    offsetSecs = sign * (hh * 3600 + mm * 60);
  }
  const dotAt = time.indexOf(".");
  const hms = dotAt < 0 ? time : time.slice(0, dotAt);
  const frac = dotAt < 0 ? "" : time.slice(dotAt + 1);
  if (frac !== "" && !/^\d+$/.test(frac)) return void 0;
  const millis = frac === "" ? 0 : Number((frac + "000").slice(0, 3));
  const tp = hms.split(":");
  if (tp.length !== 3) return void 0;
  const hour = Number(tp[0]);
  const minute = Number(tp[1]);
  const second = Number(tp[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return void 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return void 0;
  const dp = date.split("-");
  if (dp.length !== 3) return void 0;
  const year = Number(dp[0]);
  const month = Number(dp[1]);
  const day = Number(dp[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return void 0;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return void 0;
  const days = daysFromCivil(year, month, day);
  const utcSecs = days * 86400 + hour * 3600 + minute * 60 + second - offsetSecs;
  return utcSecs * 1e3 + millis;
}
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = y >= 0 ? Math.floor(y / 400) : Math.floor((y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function daysInMonth(year, month) {
  if (month === 1 || month === 3 || month === 5 || month === 7 || month === 8 || month === 10 || month === 12) {
    return 31;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  const leap = year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
  return leap ? 29 : 28;
}
var isRecord2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function numAt(o, key) {
  const v = o[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}
function strAt3(o, key) {
  const v = o[key];
  return typeof v === "string" ? v : "";
}
function parseCloudRecords(result) {
  if (!isRecord2(result)) {
    throw new Error("cloudRecordV2 响应缺少 result 对象");
  }
  const records = result.records;
  if (!Array.isArray(records)) {
    throw new Error("cloudRecordV2 响应缺少 result.records 数组");
  }
  return records.map((x) => {
    const o = isRecord2(x) ? x : {};
    const it = o.inserttime ?? o.insertTime;
    return {
      num: numAt(o, "num"),
      summary: strAt3(o, "summary"),
      mark: strAt3(o, "mark"),
      insertTime: typeof it === "string" ? it : void 0
    };
  });
}
function aggregateToday(records, nowMs) {
  let gained = 0;
  let spent = 0;
  let count = 0;
  for (const r of records) {
    if (r.insertTime === void 0) {
      throw new Error(`流水里有一笔没有 insertTime（${r.summary || "（无摘要）"}），读不出它是不是今天`);
    }
    const ts = parseInsertTimeMs(r.insertTime);
    if (ts === void 0) {
      throw new Error(`流水的 insertTime 解不出（${r.insertTime}）—— 不猜它属于哪一天`);
    }
    if (!isToday(ts, nowMs)) continue;
    count += 1;
    if (r.num >= 0) gained += r.num;
    else spent += -r.num;
  }
  return { net: gained - spent, gained, spent, count };
}
function buildRecords(all, sinceMs, limit, truncated) {
  let recs = all.map((r) => ({
    atMs: r.insertTime === void 0 ? void 0 : parseInsertTimeMs(r.insertTime),
    rawTime: r.insertTime,
    num: r.num,
    summary: r.summary,
    mark: r.mark
  }));
  if (sinceMs !== void 0) {
    recs = recs.filter((r) => r.atMs === void 0 || r.atMs >= sinceMs);
  }
  recs.sort((a, b) => {
    const x = a.atMs;
    const y = b.atMs;
    if (x === void 0 && y === void 0) return 0;
    if (x === void 0) return 1;
    if (y === void 0) return -1;
    return y - x;
  });
  let hasMore = truncated;
  if (recs.length > limit) {
    recs = recs.slice(0, limit);
    hasMore = true;
  }
  const undated = recs.filter((r) => r.atMs === void 0).length;
  return { records: recs, undated, hasMore };
}
function fetchAll(fetch) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = fetch(page);
    const full = batch.length === PAGE_SIZE;
    all.push(...batch);
    if (!full) return { all, truncated: false };
    if (page === MAX_PAGES) return { all, truncated: true };
  }
  return { all, truncated: true };
}
function readDay(fetch, nowMs) {
  const { all, truncated } = fetchAll(fetch);
  if (truncated) {
    throw new Error(`AI豆流水翻满 ${MAX_PAGES} 页仍是满页，读不到底 —— 不报一个可能少算的数`);
  }
  return aggregateToday(all, nowMs);
}
function readRecords(fetch, sinceMs, limit) {
  const { all, truncated } = fetchAll(fetch);
  return buildRecords(all, sinceMs, limit, truncated);
}

// src/mcloud/beansRead.ts
function makeFetchPage(deps) {
  const nowIso = deps.nowIso ?? (/* @__PURE__ */ new Date()).toISOString();
  const base = hostBase({ baseUrl: deps.baseUrl }, "");
  return (pageNumber) => {
    const session = loadSession(deps.store);
    if (session === null) throw new LoginExpiredError("这个账号还没有网页会话");
    const url = resolveUrl("cloudRecordV2", base === "" ? void 0 : base) + `?${beanQuery(pageNumber)}`;
    const req = buildH5Request({
      url,
      method: "GET",
      referer: REFERER_SIGN_IN,
      showLoading: SHOW_LOADING,
      isDeviceId: false,
      saltKey: 1,
      session: sessionHeaders(session)
    });
    const res = callOnce(deps.transport, req);
    if (res.setCookies.length > 0) {
      saveSession(
        deps.store,
        { ...session, cookie: mergeCookieJar(session.cookie, res.setCookies) },
        nowIso
      );
    }
    if (res.env?.code === 90001) throw new LoginExpiredError();
    if (!res.ok) {
      throw new Error(res.error ?? "cloudRecordV2 请求失败");
    }
    const env = res.env ?? parseSignInEnvelope(res.body);
    return parseCloudRecords(resultObject(env));
  };
}
function gateDeps(deps) {
  return {
    store: deps.store,
    transport: deps.transport,
    nowIso: deps.nowIso ?? (/* @__PURE__ */ new Date()).toISOString(),
    baseUrl: deps.baseUrl
  };
}
function readDayForAccount(deps, nowMs) {
  return withTokenGate(gateDeps(deps), () => readDay(makeFetchPage(deps), nowMs));
}
function normalizeDays(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n === 1 || n === 7 || n === 30 ? n : 0;
}
function readRecordsForAccount(deps, nowMs, days) {
  return withTokenGate(
    gateDeps(deps),
    () => readRecords(makeFetchPage(deps), rangeSinceMs(days, nowMs), MAX_DETAIL_RECORDS)
  );
}

// src/mcloud/routes.ts
var PLUGIN = "mcloud";
function parseJson5(body) {
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function accountsView(store2) {
  const cur = currentAccount(store2);
  const nowMs = Date.now();
  const raw = rawStoreOf(store2);
  return {
    current: cur?.id ?? "",
    accounts: loadAccounts(store2).map((a) => {
      const info = parseAuth(a.auth);
      const exp = info?.expire ?? 0;
      return {
        id: a.id,
        label: a.label,
        masked: maskAuth(a.auth),
        current: cur?.id === a.id,
        addedAt: a.addedAt,
        platform: a.platform,
        pcPlatform: a.pcPlatform ?? "",
        expireDays: exp > 0 ? Math.floor((exp - nowMs) / 864e5) : null,
        ...(() => {
          const bag = readBag(raw, a.id);
          let jwt = "";
          try {
            jwt = JSON.parse(bag["mcloud.session"] ?? "{}").jwt ?? "";
          } catch {
            jwt = "";
          }
          const e = jwtExpiryOf(jwt, new Date(nowMs).toISOString());
          return { jwtExpiresAt: e?.atIso ?? "", jwtExpired: e?.expired ?? false };
        })(),
        deviceId: readBag(raw, a.id)["mcloud.smid.deviceId"] ?? "",
        disabled: a.disabled === true,
        // ⚠ 这两个键**是按账号的**（`KEY_SCOPE` 里登记成 `account`）。
        //   所以"哪一条的设置"必须**按 id 读那一条的袋** —— 用当前账号那一格
        //   会把 A 的设置显示在 B 的弹窗里。
        listenSeconds: Number.parseInt(readBag(raw, a.id)["mcloud.live.listen_seconds"] ?? "", 10),
        listenRoom: Number.parseInt(readBag(raw, a.id)["mcloud.live.listen_room"] ?? "", 10),
        wsHeartbeat: readBag(raw, a.id)["mcloud.live.ws_heartbeat_reply"] ?? ""
      };
    })
  };
}
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
function buildReadings(deps) {
  const nowMs = Date.parse(deps.now());
  const nowIso = deps.now();
  const view = accountsView(deps.store);
  return {
    at: nowIso,
    account: {
      loggedIn: view.accounts.length > 0,
      current: view.current,
      accounts: view.accounts,
      session: sessionStatus(deps.store, nowIso)
    },
    // 三条任务各自"跑哪些账号"。⚠ 与上面那个 `account`（账号表）**分开给**：
    //   一个是"有哪些号"，一个是"这条任务用哪些号"—— 界面上它们在不同页
    //  （账号页 / 任务页）。合成一个的话，界面分不清该显示哪一个。
    taskAccounts: {
      日常: taskAccountsView(deps.store, "日常"),
      兑换: taskAccountsView(deps.store, "兑换"),
      直播: taskAccountsView(deps.store, "直播")
    },
    // 登录会话（三种方式的进行中状态）。挂在 `account` 块里 ——
    // 界面上的「登录」那一节就是它。
    //
    // ⚠ `svg` 要在这里也带上：界面**只调 `/readings`**（见 app.js 的文件头），
    //   所以码必须由这个接口给出来。只在 `/login/qr/start` 上给的话，
    //   `act()` 之后的 `load()` 会用"没有 svg 的读数"把码**擦掉** ——
    //   表现是"点了扫码登录，二维码框是空的"。
    login: (() => {
      const r = loginReading(
        deps.store,
        nowMs,
        (sid, did) => qrPayload(pcClient(sessionPlatform(deps.store), did), sid)
      );
      return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
    })(),
    daily: {
      // ⚠ `doneToday` 是**读数**，不是闸 —— 日常一天两趟都照跑（第二趟兜底，
      //   见 `entries/daily.ts` 里那段）。界面上别把它说成"今天已完成（不会再跑）"。
      // 「今天跑过没」看标记；「上次跑成什么样」看读数。两个都要，
      // 因为它们回答的是不同的问题（用户真正会问的是后面那个）。
      // ⚠ 用常量，**不要**写键名字面量 —— 那处原来是硬编码的
      //   `'mcloud.daily.done_date'`；改名/改分法时字面量不会跟着动。
      //   按账号那一层由 `scoped()` 负责（store 自己路由）。
      doneToday: (deps.store.getState(DAILY_DONE_KEY) ?? "") === nowIso.slice(0, 10),
      last: readDailyRun(deps.store),
      // 最近几次的**摘要**（只有一行一句）。步骤要按需再取 ——
      // 20 条 × 40 步全塞进来，首屏就是几百 KB 的 JSON。
      recent: recentRuns(deps.store, "daily")
    },
    exchange: {
      recent: recentRuns(deps.store, "exchange"),
      // 时间读数：链上一大半时间在**等**（等到窗口、压到整点）。
      // 用户点了"现在试一次"然后看界面十几秒不动，第一反应是"卡住了" ——
      // 这个读数就是回答那个问题的。
      timing: timingReading(nowMs, exchangeLeadMs(deps.store)),
      // 到目标时刻那一场还有多久（界面第一行用）
      toTargetMs: Math.max(0, (scheduleNextTargetMs(deps.store, nowMs) ?? nowMs) - nowMs),
      // 这一小时已经发过单了吗（那道防重复花豆的闸）
      orderedThisHour: deps.store.getState(STATE_ORDERED_HOUR) === hourKey(scheduleNextTargetMs(deps.store, nowMs) ?? nowMs),
      // 目标时刻（几点抢）。`null` = 每小时都试。
      targetHour: targetHourOf(deps.store),
      leadMs: exchangeLeadMs(deps.store),
      plan: deps.store.getState("mcloud.exchange.plan") ?? "",
      // 定时目标与手动目标分开存：页面上的「手动兑换」和「定时抢兑」不再互相改。
      // `schedulePlan` 是**显示名**（界面一直用它）；目标是 prizeId 或旧库的名字。
      schedulePlan: deps.store.getState(STATE_SCHEDULE_PLAN_NAME) ?? deps.store.getState(STATE_SCHEDULE_PLAN) ?? "",
      schedulePlanTarget: deps.store.getState(STATE_SCHEDULE_PLAN) ?? "",
      // 多计划：一条 = 一个账号 + 一个目标 + 一个整点。
      plans: planViews(deps.store),
      scheduleEnabled: scheduleEnabled(deps.store),
      scheduleCron: deps.store.getState(STATE_SCHEDULE_CRON) ?? "",
      scheduleMode: deps.store.getState(STATE_SCHEDULE_MODE) ?? "daily",
      scheduleUntil: deps.store.getState(STATE_SCHEDULE_UNTIL) ?? "",
      scheduleOnceDate: deps.store.getState(STATE_SCHEDULE_ONCE_DATE) ?? "",
      scheduleMaxRuns: scheduleMaxRuns(deps.store),
      scheduleRuns: scheduleRuns(deps.store),
      leadSec: scheduleLeadSec(deps.store),
      reading: readExchangeList(deps.store),
      // 「选一件」那份缓存。**过期即清**发生在读的时候（本地写一格，不打上游）——
      // 用户点开这一屏就是"今天第一次看"，那一份昨天的清单在这一刻作废。
      picks: readPickCache(deps.store, nowIso),
      subs: readSubscriptions(deps.store),
      verdictText: VERDICT_TEXT
    },
    live: {
      reading: readLiveReading(deps.store),
      codes: loadLiveCodes(deps.store),
      url: loadLiveUrl(deps.store),
      pool: readPoolSummary(deps.store, localStamp(nowMs), nowMs),
      gate: readGateReading(deps.store),
      listen: {
        reading: loadListenState(deps.store),
        line: listenReadingLine(loadListenState(deps.store))
      },
      recent: recentRuns(deps.store, "live"),
      auto: (() => {
        const plan = loadWakePlan(deps.store);
        return {
          wakeAt: plan?.wakeAt ?? "",
          wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs)
        };
      })(),
      // 领小红花的**结论**（四栏 + 进账）。界面第一行显示的就是 `line`。
      // ⚠ 「本场已结束」与「口令无效」分栏的理由见 liveDraw.drawReport 的注释 ——
      //   分错的后果是用户去重抄一条本来就对的口令。
      draw: (() => {
        const st = loadDrawState(deps.store);
        const r = drawReport(st);
        return {
          enabled: claimEnabled(deps.store),
          step: st?.step ?? "",
          report: r,
          // 这个开关只是"允许插件去领"；功能本身要服务端那边开（用户口径 2026-10-17）
          line: r === null ? claimEnabled(deps.store) ? "还没领过" : "领小红花没开 —— 要先在服务端那边开启（这里的开关只是允许插件去领）" : r.line
        };
      })()
    },
    data: {
      hasBigInt: hasBigInt(),
      matrix: {
        groups: readMatrix(deps.store).map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
        read: readMatrix(deps.store).filter(Boolean).length,
        total: MATRIX_MARKETS.length
      }
    },
    // ⚠ 推送（10 渠道）在**阶段 ⑤**。这里给一个诚实的空壳而不是编一个假读数 ——
    //    界面据此显示「还没做」，而不是显示一个看着像好的空表。
    // 推送：配了哪几个渠道、有几条规则、三个任务各绑了哪条。
    //
    // ⚠ 是**顶层**块，不是挂在 `live` 里 —— 推送是「一次运行结束」的出口，
    //   三条任务都用它，与直播没有从属关系。（第一版插错了位置，
    //   表现是读数里 `live.push.channels` 为空而顶层根本没有 `push`。）
    // **秘密只给掩码**（见 pushConfig.maskSecret）—— token / pass / secret
    // 一个字符都不进这里。
    push: pushReading(deps.store),
    settings: {
      baseUrl: loadBaseUrl(deps.store),
      liveUrl: loadLiveUrl(deps.store),
      liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
      gateBase: loadGateBase(deps.store),
      wsBase: loadWsBase(deps.store),
      wsHeartbeat: loadWsHeartbeat(deps.store),
      listenRoom: loadListenRoom(deps.store) ?? 0,
      imBase: loadImBase(deps.store),
      listenSeconds: loadListenSeconds(deps.store),
      // 登录主机是**另一个口子**：登录那一族接口在 `user-njs.yun.139.com`，
      // 与云盘业务主机不是同一台。混用的话指到 mock 之后登录仍然打真上游。
      loginBase: loadLoginBase(deps.store),
      loginPlatform: loginPlatform(deps.store),
      // ⚠ 现在是**当前账号**的域（账号级那一格），不是全局那格 —— 见 F-075
      loginDomain: currentAccountDomain(deps.store) ?? ""
    }
  };
}
function loadLoginBase(store2) {
  return store2.getState(STATE_LOGIN_BASE) ?? "";
}
function loginCall(deps, req) {
  const res = callOnce(deps.transport, req);
  if (res.env === void 0) {
    return { ok: false, env: null, error: res.error ?? `http ${res.status}`, tookMs: res.tookMs };
  }
  try {
    return { ok: true, env: parseLoginEnvelope(res.body), error: "", tookMs: res.tookMs };
  } catch (e) {
    return { ok: false, env: null, error: e instanceof Error ? e.message : String(e), tookMs: res.tookMs };
  }
}
var SLIDER_MAX_ATTEMPTS = 2;
function autoPassSlider(deps, logTag, fetchAnswer, sendWith) {
  for (let attempt = 1; attempt <= SLIDER_MAX_ATTEMPTS; attempt += 1) {
    const got = fetchAnswer();
    if ("error" in got) return { ok: false, error: got.error };
    const r = sendWith(got.answer);
    if (r.kind === "sent") {
      deps.log(`${logTag}：滑块过了（第 ${attempt} 轮），验证码已发出`);
      return { ok: true, remainGetTimes: r.remainGetTimes };
    }
    if (r.kind === "other") return { ok: false, error: r.note };
    deps.log(`${logTag}：滑块没过（${r.kind}），换一道新题再试`);
  }
  return { ok: false, error: "滑块连着两轮没过 —— 过一会儿再点一次" };
}
function newTid() {
  return uuidV4();
}
function loginPlatform(store2) {
  return parsePcPlatform(store2.getState(STATE_LOGIN_PREF)) ?? DEFAULT_PC_PLATFORM;
}
function sessionPlatform(store2) {
  return loadQrSession(store2)?.platform ?? loginPlatform(store2);
}
function adoptLoginResult(deps, encrypted, note2, prefix = PC_AUTH_PREFIX, key = LOGIN_AES_KEY, pcPlatform) {
  let info;
  try {
    info = decryptUserInfo(encrypted, key);
  } catch (e) {
    return { ok: false, note: `登录成功了，但结果解不开：${e instanceof Error ? e.message : String(e)}` };
  }
  let auth;
  try {
    auth = authFromUserInfo(info, prefix);
  } catch (e) {
    return { ok: false, note: `登录结果缺字段：${e instanceof Error ? e.message : String(e)}` };
  }
  const phone = typeof info["account"] === "string" ? info["account"] : "";
  const domain = userDomainIdFrom(info);
  const up = upsertAccount(
    deps.store,
    auth,
    deps.now(),
    phone === "" ? void 0 : maskPhone(phone),
    // ⚠ 词表在这里换一次（`windows` → `win`）—— 见 `accountForm` 的注释
    pcPlatform === void 0 ? void 0 : accountForm(pcPlatform),
    domain === "" ? void 0 : domain
  );
  selectAccount(deps.store, up.account.id, deps.now());
  deps.store.setState(STATE_LOGIN_DOMAIN, "", deps.now());
  clearLogin(deps.store);
  deps.log(`登录成功：${up.account.label}${up.created ? "（新账号）" : "（已有账号，凭据已更新）"}`);
  syncTaskReadiness(deps.store);
  return { ok: true, note: `${note2} · ${up.account.label}`, account: { id: up.account.id, label: up.account.label } };
}
function syncExchangeJob(store2) {
  const plans = loadPlans(store2);
  const on = plans.filter((p) => p.enabled);
  const expr = unionCron(on);
  const lead = maxLeadMs(on);
  setTaskSchedule("兑换", expr, lead);
  setTaskPaused("兑换", on.length === 0);
  setTaskBlockers("兑换", blockersFor(store2, "兑换"));
  setTaskSummary("兑换", planSummary(store2));
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
      // 沙箱能力（**随时可问**，不用等 5 分钟一跳的自检）
      path: `${base}/caps`,
      method: "GET",
      handler: () => json(200, { caps: sandboxCaps(), hasBigInt: hasBigInt() })
    },
    // ── 运行记录 ────────────────────────────────────────────────────
    {
      // 某一次运行的**步骤**。列表只给摘要，点开才取这个 ——
      // 理由见 `runLog.ts` 的 `RunSummary`。
      // ⚠ 走**查询串**而不是 `/runs/:id`：宿主给的是 `req.query`，
      //   没有路径参数（见 `host-api.d.ts` 的 `RouteRequest`）。
      path: `${base}/runs`,
      method: "GET",
      handler: (req) => {
        const id = parseQuery(req.query)["id"] ?? "";
        if (id === "") return json(400, { error: "要带一个 id" });
        const r = readRun(deps.store, id);
        if (r === null) return json(404, { error: `没有这次运行（可能已经被新记录挤掉了）：${id}` });
        return json(200, r);
      }
    },
    {
      // 运行日志的**历史**（最近 N 行）。
      //
      // 终端面板平时靠面板的日志流（SSE），可那条流的底子是内存环 ——
      // **面板一重启就空**。所以插件自己留了一份副本（`logRing.ts`），
      // 界面首屏先读这一份，再接流看新的。
      //
      // ⚠ 这是"上一次跑到哪"的答案，不是日志系统本身：没有级别过滤、没有续传，
      //   只留最近 400 行。别拿它当审计。
      path: `${base}/log/tail`,
      method: "GET",
      handler: (req) => {
        const q = parseQuery(req.query);
        const want = Number(q.limit ?? "200");
        const limit = Number.isFinite(want) ? Math.min(Math.max(Math.trunc(want), 1), 400) : 200;
        const all = readRing(deps.store);
        return json(200, {
          lines: all.slice(Math.max(0, all.length - limit)),
          total: all.length
        });
      }
    },
    // ── 推送 ────────────────────────────────────────────────────────
    {
      // 存推送配置。
      //
      // # 为什么是**合并**而不是整份覆盖
      //
      // 界面上**拿不到已经存着的值**（读数里只有掩码 —— token 不上屏是硬规则）。
      // 所以界面没法"把整份发回来"，它只知道用户这次改了什么。
      //
      // 但纯合并又做不到"删掉一个渠道"（删了下次会被旧值补回来）——
      // 所以请求体里带一个**显式的 `remove` 列表**：
      //
      //     { "set": { "bark": { "key": "…" } }, "remove": ["pushplus"] }
      //
      // 两种形状都收：给一个裸的配置对象就是"合并这几项"（写脚本时更顺手），
      // 给 `{set, remove}` 就是完整语义。
      path: `${base}/push/config`,
      method: "POST",
      handler: (req) => {
        const body = parseJson5(req.body);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return json(400, { error: "请求体要是 JSON 对象" });
        }
        const raw = body;
        const isPatch = raw["set"] !== void 0 || raw["remove"] !== void 0;
        const setObj = isPatch ? raw["set"] : raw;
        const remove = Array.isArray(raw["remove"]) ? raw["remove"] : [];
        const cur = loadPushConfig(deps.store);
        if (setObj !== void 0 && setObj !== null) {
          for (const [k, v] of Object.entries(setObj)) {
            if (k === "title") {
              cur.title = typeof v === "string" ? v : void 0;
              continue;
            }
            if (!CHANNELS.includes(k)) continue;
            if (v === null) delete cur[k];
            else if (k === "customPost") cur.customPost = v;
            else cur[k] = v;
          }
        }
        for (const k of remove) {
          if (typeof k === "string" && CHANNELS.includes(k)) {
            delete cur[k];
          }
        }
        savePushConfig(deps.store, cur, deps.now());
        const n = configuredChannels(cur);
        deps.log(`推送配置已保存（配了 ${n.length} 个渠道）`);
        return json(200, { ok: true, configured: n });
      }
    },
    {
      // 存推送规则（整份覆盖，同上的理由）。
      path: `${base}/push/rules`,
      method: "POST",
      handler: (req) => {
        const body = parseJson5(req.body);
        if (!Array.isArray(body)) return json(400, { error: "请求体要是数组" });
        const rules = body.filter(
          (r) => r !== null && typeof r === "object" && typeof r.id === "string" && r.id !== ""
        );
        savePushRules(deps.store, rules, deps.now());
        deps.log(`推送规则已保存（${rules.length} 条）`);
        return json(200, { ok: true, count: rules.length });
      }
    },
    {
      // 存「哪个任务用哪条规则」。
      path: `${base}/push/bindings`,
      method: "POST",
      handler: (req) => {
        const body = parseJson5(req.body);
        if (body === null || typeof body !== "object") {
          return json(400, { error: "请求体要是 JSON 对象" });
        }
        const src = body;
        const b = {
          daily: typeof src["daily"] === "string" ? src["daily"] : "",
          exchange: typeof src["exchange"] === "string" ? src["exchange"] : "",
          live: typeof src["live"] === "string" ? src["live"] : ""
        };
        savePushBindings(deps.store, b, deps.now());
        deps.log("推送绑定已保存");
        return json(200, { ok: true, bindings: b });
      }
    },
    {
      // **试发一条**。存在的理由：推送最难受的失败方式是"配好了、但收不到"，
      // 而那时用户不知道是配置错了、还是任务没跑、还是根本没到发送那一步。
      // 这个按钮把这三件事分开：它直接发一条，成不成当场告诉你。
      path: `${base}/push/test`,
      method: "POST",
      handler: () => {
        const cfg = loadPushConfig(deps.store);
        const chans = configuredChannels(cfg);
        if (chans.length === 0) {
          return json(200, { ok: false, line: "一个渠道都没配", results: [] });
        }
        const r = sendPush(deps.pushDeps, cfg, "云盘 · 试发", "这是一条试发的推送。\n收到就说明配置对了。");
        deps.log(`试发推送：${r.line}`);
        return json(200, { ok: r.failed === 0 && r.sent > 0, line: r.line, results: r.results });
      }
    },
    // ── 登录：读数 ──────────────────────────────────────────────────
    {
      // 登录页的读数（一次给全）。凭据**不进这里** —— 只给掩码过的形状。
      path: `${base}/login/state`,
      method: "GET",
      handler: () => json(200, {
        ...(() => {
          const r = loginReading(
            deps.store,
            Date.parse(deps.now()),
            (sid, did) => qrPayload(pcClient(sessionPlatform(deps.store), did), sid)
          );
          return { ...r, qr: r.qr === null ? null : { ...r.qr, svg: qrSvg(r.qr.payload) } };
        })(),
        platform: sessionPlatform(deps.store)
      })
    },
    // ── 登录：扫码 ──────────────────────────────────────────────────
    {
      // 出码。**不发任何上游请求** —— 客户端源码里就是字符串拼接，
      // 实测 1622 个 body 文件里也没有对应的取码接口。
      path: `${base}/login/qr/start`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const nowMs = Date.parse(deps.now());
        const s = startQrSession(deps.store, nowMs, deps.now(), platform);
        const c = pcClient(s.platform, s.deviceId);
        const payload = qrPayload(c, s.sessionId);
        deps.log(`扫码登录：已出码（${s.platform === "macos" ? "macOS" : "Windows"}），等手机扫`);
        return json(200, {
          sessionId: s.sessionId,
          payload,
          platform: s.platform,
          // **在插件这一侧编码**、界面只画格子：浏览器里没有二维码库，
          // 在那里现写一个等于把"码对不对"交给前端（见 crypto/qr.ts 的文件头）。
          svg: qrSvg(payload),
          expiresInMs: QR_TTL_SECONDS * 1e3,
          // ⚠ 轮询间隔**由这一侧给**，界面不许自己写死一个数 ——
          //   参考实现的注释：「客户端写死一个数会和状态机分叉」。
          //   2 秒是"人扫完到界面看到"的延迟与上游压力的折中。
          pollMs: QR_POLL_MS,
          note: "用手机上的移动云盘 App 扫这个码，然后在手机上确认"
        });
      }
    },
    {
      // 轮一次。**"还没扫"不是错误** —— 轮询期间绝大多数响应都是它。
      path: `${base}/login/qr/poll`,
      method: "POST",
      handler: () => {
        const s = loadQrSession(deps.store);
        if (s === null) return json(400, { error: "没有正在进行的扫码登录（先点「扫码登录」）" });
        const nowMs = Date.parse(deps.now());
        const remain = qrRemainingMs(s, nowMs);
        if (qrExpired(s, nowMs)) {
          return json(200, {
            stop: true,
            ok: false,
            note: "二维码过期了，点「扫码登录」重新出码",
            expiresInMs: 0,
            pollMs: QR_POLL_MS
          });
        }
        const c = pcClient(s.platform, s.deviceId);
        const r = loginCall(
          deps,
          // ⚠ 用**会话里那一个** `x-yun-tid`（整趟复用），不要每轮新生成 ——
          //   参考实现的会话表存的就是 `(qr, tid, owner)`（F-071）。
          thirdloginRequest(c, s.tid, qrThirdloginBody(c, s.sessionId), loadLoginBase(deps.store))
        );
        if (r.env === null) {
          const err2 = r.error ?? "没有回应";
          deps.log(`扫码登录：问服务端没成（${err2}）`);
          const empty = /不是 JSON/.test(err2);
          const offline = /Connection refused|connection reset|io: |dns error|timed out|timeout/i.test(err2);
          const code = /\b(?:HTTP|status:)\s*(\d{3})\b/.exec(err2)?.[1];
          const why = empty ? "移动云盘回了个空响应 —— 过一会儿再点一次" : offline ? "连不上移动云盘 —— 过一会儿再点一次" : `移动云盘没回应（${code ?? err2}），过一会儿再点一次`;
          return json(200, {
            stop: false,
            ok: true,
            note: why,
            retry: true,
            expiresInMs: remain,
            pollMs: QR_POLL_MS
          });
        }
        const out = classifyPoll(r.env);
        const applied = applyPoll(s, out, nowMs);
        saveQrSession(deps.store, applied.session, deps.now());
        if (applied.encrypted !== void 0) {
          const adopted = adoptLoginResult(
            deps,
            applied.encrypted,
            "扫码登录成功",
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform
          );
          return json(200, { ...applied, ...adopted, stop: true });
        }
        if (applied.note !== s.lastNote) {
          const raw = `${r.env.code ?? "无 code"}${r.env.message ? ` ${r.env.message}` : ""}`;
          deps.log(`扫码登录：${applied.note}（服务端 code=${raw}）`);
        }
        return json(200, {
          stop: applied.stop,
          ok: applied.ok,
          note: applied.note,
          scanned: applied.session.scanned,
          // ⚠ 终态（过期 / 会话对不上 / 限流）时剩余时间必须给 0：
          //   否则界面上会出现「二维码过期了 · 剩 119 秒」这种自相矛盾的一行
          //   （实测到过：出码后第一次轮询恰好撞上上游回 `200059542`）。
          expiresInMs: applied.stop ? 0 : remain,
          pollMs: QR_POLL_MS
        });
      }
    },
    // ── 登录：短信 ──────────────────────────────────────────────────
    {
      path: `${base}/login/sms/start`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const phone = typeof b.phone === "string" ? b.phone.trim() : "";
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: "手机号要 11 位、以 1 开头" });
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const s = startSmsSession(deps.store, phone, Date.parse(deps.now()), deps.now(), platform);
        return json(200, { phone: s.phone, platform: s.platform, note: "点「发验证码」" });
      }
    },
    {
      // 发码。**可能被风控拦下** ⇒ 这一侧**自己去过滑块**，人只负责等短信。
      path: `${base}/login/sms/send`,
      method: "POST",
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: "没有正在进行的短信登录（先填手机号）" });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const base2 = loadLoginBase(deps.store);
        const attempt = (answer) => {
          const body = answer === void 0 ? sendSmsCodeBody(c, s.phone, s.random) : sendSmsCodeBodyWithSlider(c, s.phone, s.random, answer);
          const r = loginCall(deps, sendSmsCodeRequest(c, newTid(), body, base2));
          if (r.env === null) return { kind: "other", note: `发码请求没成功：${r.error}` };
          const out = classifySendSms(r.env);
          if (out.kind === "sent") return { kind: "sent", remainGetTimes: out.remainGetTimes };
          if (out.kind === "need-slider") return { kind: "need-slider" };
          if (out.kind === "slider-exhausted") return { kind: "exhausted" };
          return { kind: "other", note: `发码没成：${out.message || `code=${out.code}`}` };
        };
        const fetchAnswer = () => {
          const pr = loginCall(deps, sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), base2));
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            saveSmsSession(deps.store, { ...s, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };
        let sent = null;
        const first = attempt();
        if (first.kind === "sent") {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === "other") {
          return json(200, { ok: false, note: first.note });
        } else {
          deps.log(`短信登录：要过滑块（${first.kind === "exhausted" ? "旧图已作废" : "首次发码被拦"}），自动过`);
          const passed = autoPassSlider(deps, "短信登录", fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }
        const next = { ...s, sent: true, lastNote: "验证码已发出" };
        saveSmsSession(deps.store, next, deps.now());
        deps.log("短信登录：验证码已发出");
        return json(200, {
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note: "看手机短信，把 6 位验证码填进来"
        });
      }
    },
    {
      // 取滑块拼图。**缺口坐标是解出来的**，不需要图像识别。
      path: `${base}/login/sms/slider`,
      method: "POST",
      handler: () => {
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: "没有正在进行的短信登录（先填手机号）" });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          sliderPuzzleRequest(c, newTid(), sliderPuzzleBody(s.phone), loadLoginBase(deps.store))
        );
        if (r.env === null) return json(502, { error: `取滑块失败：${r.error}` });
        if (!isSuccessCode(r.env.code)) {
          return json(200, { ok: false, note: `取滑块被拒：${r.env.message || `code=${r.env.code}`}` });
        }
        let puzzle;
        try {
          puzzle = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(502, { error: `滑块响应看不懂：${e instanceof Error ? e.message : String(e)}` });
        }
        let answer;
        try {
          answer = sliderAnswer(puzzle);
        } catch (e) {
          return json(502, { error: `滑块缺口解不开（服务端换字段了？）：${e instanceof Error ? e.message : String(e)}` });
        }
        setSmsSlider(deps.store, s, puzzle, deps.now());
        return json(200, {
          ok: true,
          background: puzzle.backgroundB64,
          piece: puzzle.puzzleB64,
          picWidth: puzzle.picWidth,
          puzzleWidth: puzzle.puzzleWidth,
          answer,
          note: "答案已经解出来了，点「带滑块发码」"
        });
      }
    },
    {
      // 提交验证码。
      path: `${base}/login/sms/submit`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const code = typeof b.code === "string" ? b.code.trim() : "";
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: "验证码要 4–8 位数字" });
        const s = loadSmsSession(deps.store);
        if (s === null) return json(400, { error: "没有正在进行的短信登录（先填手机号）" });
        const c = pcClient(s.platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), smsThirdloginBody(c, s.phone, code), loadLoginBase(deps.store))
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === "success") {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            "短信登录成功",
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            s.platform
          );
          return json(200, { ...adopted, stop: true });
        }
        const note2 = r.env.code === CODES.SMS_CODE_WRONG ? "验证码不对（或者过期了），再看一眼短信" : `登录没成：${out.kind === "other" ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: false, note: note2 });
      }
    },
    {
      // 写"这条任务跑哪些账号"。
      //
      // ⚠ 校验两件事：任务名必须是我们认识的那三个（不然键会被人拼出来乱写），
      //   以及**选中的 id 必须真的存在** —— 存一堆不存在的 id 会让任务静默不跑，
      //   而界面上看起来"选好了"。
      path: `${base}/task/accounts`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const task = typeof b.task === "string" ? b.task : "";
        if (!SCHEDULED_TASKS.includes(task)) {
          return json(400, { error: `不认识的任务：${task || "(空)"}` });
        }
        const all = b.all === true;
        const known = new Set(loadAccounts(deps.store).map((a) => a.id));
        const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string" && known.has(x)) : [];
        saveTaskAccounts(deps.store, task, { all, ids }, deps.now());
        deps.log(`任务账号（${task}）：${all ? "全部" : `${ids.length} 个`}`);
        syncTaskReadiness(deps.store, [task]);
        return json(200, {
          ...taskAccountsView(deps.store, task),
          note: all ? `${task}：全部账号` : `${task}：${ids.length} 个账号`
        });
      }
    },
    // ── 登录：手机端（App 链路）─────────────────────────────────────
    //
    // ⚠ 与短信那条**不是一个东西**，所以四条路由都是新的：
    //   · 请求头是 App 那套（`appHeaders`），凭据前缀是 `mobile`
    //   · 第三枪的体是**加密的**（AES-128-ECB + 末 10 位错位）
    //   · 响应的成功载荷是**密文字符串**，要用 **App 那把钥匙**解
    //   参考实现特意没复用 PC 的枚举，理由写得很直白：「共用一个枚举会让调用方
    //   写错分支却仍然编译通过」。
    {
      path: `${base}/login/app/start`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const phone = typeof b.phone === "string" ? b.phone.trim() : "";
        if (!/^1\d{10}$/.test(phone)) return json(400, { error: "手机号要 11 位（1 开头）" });
        const a = startAppSession(deps.store, phone, Date.parse(deps.now()), deps.now());
        deps.log("手机端登录：手机号记下了");
        return json(200, { ok: true, phone: a.phone, note: "手机号记下了 —— 点「发验证码」" });
      }
    },
    {
      path: `${base}/login/app/send`,
      method: "POST",
      handler: () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: "没有正在进行的手机端登录（先填手机号）" });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const nowMs = Date.parse(deps.now());
        const attempt = (answer) => {
          const puzzle = answer === void 0 ? "" : puzzleVerfycodeEncrypt(answer);
          const r = loginCall(
            deps,
            appSendSmsCodeRequest(deviceId, nowMs, a.phone, puzzle, loadLoginBase(deps.store))
          );
          if (r.env === null) return { kind: "other", note: `发码请求没成功：${r.error}` };
          const out = classifyAppSendSms(r.env);
          if (out.kind === "sent") return { kind: "sent", remainGetTimes: out.remainGetTimes };
          if (out.kind === "need-captcha") return { kind: "need-slider" };
          if (out.kind === "slider-exhausted") return { kind: "exhausted" };
          return { kind: "other", note: out.note };
        };
        const fetchAnswer = () => {
          const pr = loginCall(
            deps,
            appPost(
              APP_SLIDER_PUZZLE_PATH,
              JSON.stringify(sliderPuzzleBody(a.phone)),
              deviceId,
              nowMs,
              loadLoginBase(deps.store)
            )
          );
          if (pr.env === null) return { error: `取滑块没成功：${pr.error}` };
          if (!isSuccessCode(pr.env.code)) {
            return { error: `取滑块被拒：${pr.env.message || `code=${pr.env.code}`}` };
          }
          try {
            const puzzle = parseSliderPuzzle(pr.env);
            saveAppSession(deps.store, { ...a, slider: puzzle }, deps.now());
            return { answer: sliderAnswer(puzzle) };
          } catch (e) {
            return { error: `滑块图解不开：${e instanceof Error ? e.message : String(e)}` };
          }
        };
        let sent = null;
        const first = attempt();
        if (first.kind === "sent") {
          sent = { remainGetTimes: first.remainGetTimes };
        } else if (first.kind === "other") {
          return json(200, { ok: false, sent: false, note: first.note });
        } else {
          deps.log(`手机端登录：要过滑块（${first.kind === "exhausted" ? "旧图已作废" : "首次发码被拦"}），自动过`);
          const passed = autoPassSlider(deps, "手机端登录", fetchAnswer, attempt);
          if (!passed.ok) return json(200, { ok: false, sent: false, note: passed.error });
          sent = { remainGetTimes: passed.remainGetTimes };
        }
        saveAppSession(deps.store, { ...a, sent: true, lastNote: "验证码已发出" }, deps.now());
        deps.log("手机端登录：验证码已发出");
        return json(200, {
          ok: true,
          sent: true,
          remainGetTimes: sent.remainGetTimes,
          note: sent.remainGetTimes === null ? "验证码已发出" : `验证码已发出（今天还能发 ${sent.remainGetTimes} 次）`
        });
      }
    },
    {
      path: `${base}/login/app/slider`,
      method: "POST",
      handler: () => {
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: "没有正在进行的手机端登录（先填手机号）" });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const r = loginCall(
          deps,
          appPost(
            APP_SLIDER_PUZZLE_PATH,
            JSON.stringify(sliderPuzzleBody(a.phone)),
            deviceId,
            Date.parse(deps.now()),
            loadLoginBase(deps.store)
          )
        );
        if (r.env === null) return json(502, { error: `取题面没成功：${r.error}` });
        let p;
        try {
          p = parseSliderPuzzle(r.env);
        } catch (e) {
          return json(200, { ok: false, note: `题面解不开：${e instanceof Error ? e.message : String(e)}` });
        }
        saveAppSession(deps.store, { ...a, slider: p, lastNote: "题面已取到" }, deps.now());
        return json(200, {
          ok: true,
          background: p.backgroundB64,
          note: "题面已取到 —— 缺口位置由这一侧解出，再点一次「发验证码」会带着答案发"
        });
      }
    },
    {
      path: `${base}/login/app/submit`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const code = typeof b.code === "string" ? b.code.trim() : "";
        if (!/^\d{4,8}$/.test(code)) return json(400, { error: "验证码要 4–8 位数字" });
        const a = loadAppSession(deps.store);
        if (a === null) return json(400, { error: "没有正在进行的手机端登录（先填手机号）" });
        const deviceId = loadDeviceId(deps.store, deps.now());
        const r = loginCall(
          deps,
          appThirdloginRequest(
            deviceId,
            Date.parse(deps.now()),
            a.phone,
            code,
            a.random,
            void 0,
            loadLoginBase(deps.store)
          )
        );
        if (r.env === null) return json(502, { error: `提交请求没成功：${r.error}` });
        const out = classifyAppLogin(r.env);
        if (out.kind === "success") {
          const adopted = adoptLoginResult(deps, out.encrypted, "手机端登录成功", APP_AUTH_PREFIX, APP_LOGIN_AES_KEY);
          return json(200, { ...adopted, stop: true });
        }
        return json(200, { ok: false, stop: false, note: out.note });
      }
    },
    // ── 登录：账密 ──────────────────────────────────────────────────
    {
      // 账密登录**一个路由就完成** —— 它没有用户交互，所以不是状态机。
      path: `${base}/login/pwd`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const phone = typeof b.phone === "string" ? b.phone.trim() : "";
        const password = typeof b.password === "string" ? b.password : "";
        if (phone === "") return json(400, { error: "要填手机号" });
        if (password === "") return json(400, { error: "要填口令" });
        const platform = parsePcPlatform(b.pcPlatform) ?? loginPlatform(deps.store);
        const c = pcClient(platform, loadDeviceId(deps.store, deps.now()));
        const r = loginCall(
          deps,
          thirdloginRequest(c, newTid(), passwordThirdloginBody(c, phone, password), loadLoginBase(deps.store))
        );
        if (r.env === null) return json(502, { error: `登录请求没成功：${r.error}` });
        const out = classifyPoll(r.env);
        if (out.kind === "success") {
          const adopted = adoptLoginResult(
            deps,
            out.encrypted,
            "账密登录成功",
            PC_AUTH_PREFIX,
            LOGIN_AES_KEY,
            platform
          );
          return json(200, { ...adopted, stop: true });
        }
        const note2 = r.env.code === CODES.LOGIN_FAILED ? "服务端说登录失败 —— 手机号或口令不对（也可能是设备头被拒）" : `登录没成：${out.kind === "other" ? out.message || `code=${out.code}` : out.kind}`;
        return json(200, { ok: false, stop: true, note: note2 });
      }
    },
    // ── 登录：取消 / 换设备 ─────────────────────────────────────────
    {
      path: `${base}/login/cancel`,
      method: "POST",
      handler: () => {
        clearLogin(deps.store);
        deps.log("登录：已取消");
        return json(200, { ok: true, note: "已取消" });
      }
    },
    {
      // 「我的码一直扫不出来」的救命按钮。
      // ⚠ 换设备指纹**必须同时清会话** —— 旧会话的 dID 是旧指纹，继续轮只会
      //   一直 200059541（而这看起来像"码过期了"）。
      path: `${base}/login/device/reset`,
      method: "POST",
      handler: () => {
        const fresh = resetDeviceId(deps.store, deps.now());
        deps.log("登录：换了设备指纹（旧会话已清）");
        return json(200, { deviceId: fresh, note: "设备指纹已换新，旧会话已清 —— 重新出码" });
      }
    },
    {
      // **七个区块的读数一次给全** —— 界面只调这一个
      path: `${base}/readings`,
      method: "GET",
      handler: () => json(200, buildReadings(deps))
    },
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
      // 上游基址：CI 指向 mock 用；生产留空 = 用真地址。
      // 口令主页地址：同一条路（**完整 URL**，不是源 —— 见 liveRoom.ts 的 loadLiveUrl）
      path: `${base}/config`,
      method: "GET",
      handler: () => json(200, {
        baseUrl: loadBaseUrl(deps.store) || "(真主机)",
        liveUrl: loadLiveUrl(deps.store),
        liveUrlDefault: XIAOHONGSHU_KOULING_PROFILE_URL,
        // 门的两个主机（user-njs / v.cmcc-cs.cn）—— 一个口子，见 liveGateTask.loadGateBase
        gateBase: loadGateBase(deps.store) || "(真主机)",
        // 弹幕那条 WS 的主机（videoim.cmcc-cs.cn:20102）—— **另一个口子**：
        // 它是 `wss://` 且带端口，与上面那两台 http 主机不是同一族（混成一个会写出
        // "指到 mock 之后协议的 scheme/端口丢了"这种错）。
        wsBase: loadWsBase(deps.store),
        // 收到 SockJS 心跳帧 `h` 回什么（空=不回）。默认 `h`（2026-10-14 真机验过）。
        wsHeartbeat: loadWsHeartbeat(deps.store) || "(不回)",
        // 听哪一间房的**诊断口子**（空 = 按主播昵称选）。见 liveListen.loadListenRoom 的注释。
        listenRoom: loadListenRoom(deps.store) ?? 0,
        // 进房间那一台（videoim.cmcc-cs.cn:20103，HTTPS）—— **第三个口子**：
        // 与上面两台 http 主机、以及带端口的 wss 主机都不是同一个。
        imBase: loadImBase(deps.store) || "(真主机)",
        listenSeconds: loadListenSeconds(deps.store)
      })
    },
    {
      path: `${base}/config`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        const out = {};
        if ("baseUrl" in body) {
          const v = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: "baseUrl 要以 http:// 或 https:// 开头（清空就传空串）" });
          }
          deps.store.setState(STATE_BASE_URL, v.replace(/\/+$/, ""), deps.now());
          deps.log(v ? `接口基址已改为 ${v}` : "接口基址已恢复成真主机");
          out.baseUrl = v || "(真主机)";
        }
        if ("targetHour" in body) {
          const raw = body.targetHour;
          const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
          if (v !== "") {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 23) {
              return json(400, { error: "兑换时刻要是 0~23 的整点（清空 = 每小时都试）" });
            }
          }
          deps.store.setState(STATE_TARGET_HOUR, v, deps.now());
          deps.log(v === "" ? "兑换时刻：每小时都试" : `兑换时刻：每天 ${v} 点`);
          out.targetHour = v;
        }
        if ("leadMs" in body) {
          const raw = body.leadMs;
          const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
          if (!Number.isFinite(n) || n < 0 || n > 2e3) {
            return json(400, { error: "提前量要是 0~2000 毫秒（网络慢就调大）" });
          }
          deps.store.setState(STATE_LEAD_MS, String(Math.round(n)), deps.now());
          deps.log(`兑换提前量：${Math.round(n)}ms`);
          out.leadMs = String(Math.round(n));
        }
        if ("liveUrl" in body) {
          const v = typeof body.liveUrl === "string" ? body.liveUrl.trim() : "";
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, {
              error: "liveUrl 要以 http:// 或 https:// 开头（清空 = 用默认主页）"
            });
          }
          saveLiveUrl(deps.store, v, deps.now());
          deps.log(v ? `口令主页已改为 ${v}` : "口令主页已恢复为默认（发布方的小红书主页）");
          out.liveUrl = v || XIAOHONGSHU_KOULING_PROFILE_URL;
        }
        if ("loginBase" in body) {
          const v = typeof body.loginBase === "string" ? body.loginBase.trim() : "";
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: "loginBase 要以 http:// 或 https:// 开头（清空 = 用真主机）" });
          }
          deps.store.setState(STATE_LOGIN_BASE, v.replace(/\/+$/, ""), deps.now());
          deps.log(v ? `登录主机已改为 ${v}` : "登录主机已恢复为真主机");
          out.loginBase = v || "(真主机)";
        }
        if ("loginPlatform" in body) {
          const v = parsePcPlatform(body.loginPlatform) ?? DEFAULT_PC_PLATFORM;
          deps.store.setState(STATE_LOGIN_PREF, v, deps.now());
          out.loginPlatform = v;
        }
        if ("gateBase" in body) {
          const v = typeof body.gateBase === "string" ? body.gateBase.trim() : "";
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: "gateBase 要以 http:// 或 https:// 开头（清空 = 用真主机）" });
          }
          saveGateBase(deps.store, v, deps.now());
          deps.log(v ? `直播日程的接口基址已改为 ${v}` : "直播日程的接口基址已恢复成真主机");
          out.gateBase = v || "(真主机)";
        }
        if ("wsBase" in body) {
          const v = typeof body.wsBase === "string" ? body.wsBase.trim() : "";
          if (v && !/^wss?:\/\//.test(v)) {
            return json(400, { error: "wsBase 要以 ws:// 或 wss:// 开头（清空 = 用真主机）" });
          }
          saveWsBase(deps.store, v, deps.now());
          deps.log(v ? `听弹幕的 WS 主机已改为 ${v}` : "听弹幕的 WS 主机已恢复为真主机");
          out.wsBase = v || BASE_VIDEO_IM_WS;
        }
        if ("imBase" in body) {
          const v = typeof body.imBase === "string" ? body.imBase.trim() : "";
          if (v && !/^https?:\/\//.test(v)) {
            return json(400, { error: "imBase 要以 http:// 或 https:// 开头（清空 = 用真主机）" });
          }
          saveImBase(deps.store, v, deps.now());
          deps.log(v ? `进房间的主机已改为 ${v}` : "进房间的主机已恢复为真主机");
          out.imBase = v || "(真主机)";
        }
        if ("wsHeartbeat" in body) {
          const given = typeof body.wsHeartbeat === "string" ? body.wsHeartbeat.trim() : "";
          const raw = given === "none" ? "" : given;
          if (raw !== "" && raw !== "h") {
            return json(400, { error: 'wsHeartbeat 只能是 "h"（默认）或 "none"（不回）' });
          }
          saveWsHeartbeat(deps.store, raw, deps.now());
          deps.log(raw === "" ? "读到 SockJS 心跳帧 h 时**不回**" : "读到 h 时回一帧 h");
          out.wsHeartbeat = raw === "" ? "(不回)" : raw;
        }
        if ("listenRoom" in body) {
          const raw = String(body.listenRoom ?? "").trim();
          if (raw !== "" && !/^\d+$/.test(raw)) {
            return json(400, { error: "listenRoom 要给房间号（纯数字）或空串（= 按主播昵称选）" });
          }
          saveListenRoom(deps.store, raw, deps.now());
          deps.log(raw === "" ? "听弹幕：恢复按主播昵称选房" : `听弹幕：诊断口子 —— 只听房间 ${raw}`);
          out.listenRoom = raw === "" ? "0" : raw;
        }
        if ("listenSeconds" in body) {
          const n = Number.parseInt(String(body.listenSeconds), 10);
          if (!Number.isFinite(n) || n <= 0 || n > 3600) {
            return json(400, { error: "listenSeconds 要给 1..3600 之间的整数（秒）" });
          }
          deps.store.setState(STATE_LISTEN_SECONDS, String(n), deps.now());
          deps.log(`听弹幕的窗口改为 ${n} 秒`);
          out.listenSeconds = String(n);
        }
        if (Object.keys(out).length === 0) {
          return json(400, {
            error: "要传 baseUrl / liveUrl / gateBase / wsBase / imBase / wsHeartbeat / listenRoom / listenSeconds（清空就传空串）"
          });
        }
        return json(200, out);
      }
    },
    {
      // 兑换清单的读数（只读任务采集，界面展示）—— 含"没有余额读数"那句提醒
      path: `${base}/exchange`,
      method: "GET",
      handler: () => {
        const reading = readExchangeList(deps.store);
        return json(200, {
          reading,
          // 界面上必须写出来：没有余额读数 ⇒ 标"可兑"的仍可能被余额挡下
          note: "没有余额读数：标「可兑」的仍可能被余额挡下（但那次挡下有错误码，不会静默）",
          verdictText: VERDICT_TEXT
        });
      }
    },
    {
      // App 任务矩阵的读数（8 个 group 各一条）—— 只读任务采集，界面展示。
      // 界面要能看见，否则"只读"就只是日志里的一行数。
      path: `${base}/matrix`,
      method: "GET",
      handler: () => {
        const rows = readMatrix(deps.store);
        return json(200, {
          // ⚠ 标签必须跟着 **market** 走，不是 group：`readMatrix` 返回的是
          //   按市场的两条（游标早就从 group 改成 market 了，见 appTaskMatrix.ts
          //   里那句「游标现在是**市场**（不是 group）」）。
          //   用 MATRIX_GROUPS 打标签的话，`sign_in_3` 会被标成 "new"、
          //   `newsign_139mail` 标成 "beiyong1"，而且 total 报 8 ——
          //   界面会显示 8 行、只有 2 行有数、两行还都标错。
          //   （这个 bug 是给 readings 写测试时顺带发现的。）
          groups: rows.map((r, i) => ({ group: MATRIX_MARKETS[i], reading: r })),
          read: rows.filter(Boolean).length,
          total: MATRIX_MARKETS.length
        });
      }
    },
    {
      // 直播口令（只读那半）：自动抓到的读数 + **人给的口令**。
      // 界面要能看见 —— 否则"抓主页"就只是日志里的一行数。
      path: `${base}/live`,
      method: "GET",
      handler: () => json(200, {
        reading: readLiveReading(deps.store),
        codes: loadLiveCodes(deps.store),
        url: loadLiveUrl(deps.store),
        emptyShellHintChars: EMPTY_SHELL_HINT_CHARS,
        // 口令池（业务档，照 mcloud）：**口令的权威来源**（读数只是最近一次抓取的快照）。
        // 界面要能看见「够没够 2 条有效」「还要等多久才能再抓」「哪些判过无效」。
        pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now())),
        // 直播日程（门）：只读探针的读数 —— 门开没开、看到几间房、「下一场」在 pool 里
        gate: readGateReading(deps.store),
        // 听弹幕（第二十三轮）：窗口里的过程事实 —— 收到几帧、几条弹幕、哪几条口令
        listen: {
          reading: loadListenState(deps.store),
          line: listenReadingLine(loadListenState(deps.store))
        },
        // 直播自动定时（mcloud 的 `live_auto`）：**下一次几点醒**。
        // 它只有读数、没有动作 —— 定时器算时刻，听弹幕那条链到点才动。
        auto: (() => {
          const nowMs = Date.parse(deps.now());
          const plan = loadWakePlan(deps.store);
          const sum = readPoolSummary(deps.store, localStamp(nowMs), nowMs);
          return {
            nextStart: sum.nextStart ?? "",
            wakeAt: plan?.wakeAt ?? "",
            wakeInMs: plan === null ? 0 : Math.max(0, plan.wakeAtMs - nowMs),
            expr: plan?.expr ?? "",
            fromStart: plan?.fromStart ?? "",
            trusted: planTrusted(sum.scheduleAtMs, nowMs),
            line: plan === null ? sum.nextStart === void 0 || sum.nextStart === "" ? "没有日程 ⇒ 不排定时（门探到「下一场」才会排）" : "日程太旧 ⇒ 不按它睡（等门下次探到再说）" : `下一次醒 ${plan.wakeAt}（= ${plan.fromStart} +1 小时）`
          };
        })(),
        note: "口令本身**没法自动化**（主播在弹幕/小红书发，那边无法鉴权）⇒ 要人给；能自动的只有「抓主页 + 列出看到的口令」。",
        // 写那半（领小红花）：默认关，开关在这里
        claim: {
          enabled: claimEnabled(deps.store),
          codes: collectCodes(deps.store, Date.parse(deps.now())),
          state: loadDrawState(deps.store)
        }
      })
    },
    {
      // H5 换票（三步）：凭据状态 + 进度 + 换到的票。**都不回显凭据本身。**
      path: `${base}/h5`,
      method: "GET",
      handler: () => {
        const jwt = loadJwt(deps.store);
        return json(200, {
          auth: authStatus(deps.store),
          exchange: loadExchange(deps.store),
          // ⚠ 票**不**回显（长度也不给 —— 它比凭据更接近"能直接用"）
          jwt: jwt ? {
            present: true,
            at: jwt.at,
            fresh: jwtFresh(deps.store, Date.now()),
            // 脱敏放**响应边界**（存储里留真值）：回显值不是凭据，
            // 但也没必要整串进界面与日志 —— 与凭据的处理同一套纪律。
            // ⚠ 上游字段叫 `mobile`，但真机上它不是手机号（见 maskMobile）
            mobile: jwt.mobile ? maskMobile(jwt.mobile) : null,
            ttlMinutes: Math.round(JWT_TTL_MS / 6e4)
          } : { present: false },
          note: '贴一份**原生凭据**（`Basic base64("mobile:号:token")`，也就是 mcloud 的 `auth.raw` 那个形状），插件自己走三步换成 H5 的 jwttoken，并按 100 分钟自动续 —— 不用再手工从浏览器抄票（它 2 小时就废）。'
        });
      }
    },
    {
      // ⚠ **这条没有界面入口了**（2026-10-15 删掉了那个「H5 换票」按钮）。
      //
      // 为什么删：它是个**用户看不懂**的按钮 —— 而参考实现里根本没有它。
      // 那边换票是**任务里自动的一步**，而且**每个页面有自己的票**
      // （`SessionRecipe`：`SignInPage` → `sign_in_3`/`1002`、
      //  `MsgPushOn` → `msgpushon`/`1062`；实拍一趟抓到**三张互不相等的
      //  `jwttoken`**）。一个叫「H5 换票」的按钮会让人以为换的是"通用的票"。
      //
      // 留着这条路由的理由：它是**单账号那套**（`mcloud.h5.auth`）唯一的写入口，
      // 而 `loadAuthRaw` 还回落到那一格（老数据）。也留一条不带界面的
      // "清空"路径（`{clear:true}`）。
      //
      // 界面上的凭据入口是 `/accounts` 的 `op:'add'`（那个「凭据」页签）。
      path: `${base}/h5/auth`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearAuth(deps.store, deps.now());
          deps.log("原生凭据与换到的票：已清空");
          return json(200, { cleared: true });
        }
        const raw = typeof body.authorization === "string" ? body.authorization : typeof body.session === "string" ? body.session : "";
        if (!raw.trim()) {
          return json(400, { error: '需要 {"authorization": "Basic …"} 或 {"clear": true}' });
        }
        const r = startExchange(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error });
        deps.log(`原生凭据已收下（指纹 ${r.fingerprint}）—— 点「换票」走三步`);
        return json(200, { stored: true, fingerprint: r.fingerprint, ...authStatus(deps.store) });
      }
    },
    {
      // **推进一步**（一次调用一个上游请求）。界面上的按钮循环调这里直到 done。
      path: `${base}/h5/step`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const id = typeof b.id === "string" ? b.id : "";
        const one = id === "" ? deps.store : scoped(rawStoreOf(deps.store), id);
        if (needExchange(one, Date.now())) {
          const st0 = loadExchange(one);
          if (st0 === null || st0.step === "done") {
            startExchange(one, loadAuthRaw(one), deps.now());
          }
        }
        const r = runExchangeStep({
          store: one,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store)
        });
        deps.log(`换票${id === "" ? "" : `（${id}）`}：${r.note}`);
        return json(200, { ...r, exchange: loadExchange(one) });
      }
    },
    {
      // 「现在试一次」—— **干跑**：清单 / 余额 / 预热 / 取题解滑块都做完，
      // 到"只差下单"就停，**一枪都不发**。
      //
      // ⚠ 为什么不做成"现在就发一枪"：下单**不可逆**（没有幂等键，发出去就扣真豆）。
      //   用户点这个按钮想知道的是「**现在能不能兑**」—— 判据过不过、余额够不够、
      //   滑块算不算得出来。这些**不需要发那一枪**就能答。
      //   真下单走界面上的「立即兑换」（会二次确认）或定时那一场（时间闸 + 压整点）。
      path: `${base}/exchange/try`,
      method: "POST",
      handler: () => {
        const d = {
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store)
        };
        clearOrder(d);
        const r = runExchange(d, { dryRun: true });
        deps.log(`兑换试一次：${r.note}`);
        return json(200, r);
      }
    },
    {
      // 刷新「选一件」那份缓存 —— 界面上那颗「刷新清单」，以及"今天还没读到过"时自动打一次。
      //
      // ⚠ 只发**清单那一枪**（只读）：不碰余额、不碰滑块、更不下单。
      // 与 `/exchange/try` 的区别就在这个"轻"字上 —— 干跑是把整条链走到"只差发枪"，
      // 而这一条只是把清单重新拿一遍（用户点开界面不该惊动整条链）。
      path: `${base}/exchange/picks`,
      method: "POST",
      handler: () => {
        const d = {
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store)
        };
        const r = runExchangeList(d);
        deps.log(`兑换清单：${r.note}`);
        return json(200, { ...r, picks: readPickCache(d.store, d.nowIso) });
      }
    },
    {
      // 「我关注的奖品」—— 读。
      path: `${base}/exchange/subs`,
      method: "GET",
      handler: () => json(200, { ok: true, subs: readSubscriptions(deps.store) })
    },
    {
      // 「我关注的奖品」—— 开/关。按 id（有）或名字（没有）定位。
      path: `${base}/exchange/subs`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (name === "") return json(400, { error: "要传奖品名字（name）" });
        const id = typeof b.id === "number" && Number.isFinite(b.id) ? Math.trunc(b.id) : typeof b.id === "string" && /^\d+$/.test(b.id.trim()) ? Number(b.id.trim()) : void 0;
        const on = b.on !== false;
        const subs = toggleSubscription(
          deps.store,
          id === void 0 ? { name } : { id, name },
          on,
          deps.now()
        );
        deps.log(`兑换关注：${on ? "关注" : "取消关注"}「${name}」`);
        return json(200, {
          ok: true,
          subs,
          note: on ? `已关注「${name}」` : `已取消关注「${name}」`
        });
      }
    },
    {
      // 定时抢兑的「计划表」—— 一条计划 = 一个账号 + 一个目标 + 一个整点。
      path: `${base}/exchange/plans`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const store2 = deps.store;
        const plans = loadPlans(store2);
        const nowIso = deps.now();
        const action = typeof b.action === "string" ? b.action : "save";
        if (action === "delete") {
          const id2 = typeof b.id === "string" ? b.id : "";
          const next2 = plans.filter((p) => p.id !== id2);
          if (next2.length === plans.length) return json(404, { ok: false, error: "计划不存在" });
          savePlans(store2, next2, nowIso);
          resetPlanRuns(store2, id2, nowIso);
          syncExchangeJob(store2);
          deps.log("定时计划已删除");
          return json(200, { ok: true, note: "计划已删除", plans: planViews(store2) });
        }
        if (action === "toggle") {
          const id2 = typeof b.id === "string" ? b.id : "";
          const on = b.enabled === true;
          const idx2 = plans.findIndex((p) => p.id === id2);
          if (idx2 < 0) return json(404, { ok: false, error: "计划不存在" });
          const next2 = plans.slice();
          next2[idx2] = { ...next2[idx2], enabled: on };
          savePlans(store2, next2, nowIso);
          syncExchangeJob(store2);
          deps.log("定时计划「" + next2[idx2].prizeName + "」：" + (on ? "启用" : "暂停"));
          return json(200, {
            ok: true,
            note: on ? "计划已启用" : "计划已暂停",
            plans: planViews(store2)
          });
        }
        const accountId = typeof b.accountId === "string" ? b.accountId.trim() : "";
        if (accountId === "") return json(400, { ok: false, error: "要选一个账号" });
        const acct = loadAccounts(store2).find((a) => a.id === accountId);
        if (!acct) return json(400, { ok: false, error: "账号不存在" });
        if (acct.disabled === true) return json(400, { ok: false, error: "这个账号已停用" });
        const prizeName = typeof b.prizeName === "string" ? b.prizeName.trim() : "";
        const prizeIdRaw = Number(b.prizeId);
        const prizeId = Number.isInteger(prizeIdRaw) && prizeIdRaw > 0 ? prizeIdRaw : void 0;
        if (prizeName === "" && prizeId === void 0) {
          return json(400, { ok: false, error: "要选一个兑换目标" });
        }
        const cron = typeof b.cron === "string" ? b.cron.trim() : "";
        try {
          parseCron(cron);
        } catch (e) {
          return json(400, {
            ok: false,
            error: "cron 不对：" + (e instanceof Error ? e.message : String(e))
          });
        }
        const leadRaw = Number(b.leadSec);
        const leadSec = Number.isFinite(leadRaw) ? Math.min(300, Math.max(60, Math.floor(leadRaw))) : 120;
        const until = typeof b.until === "string" ? b.until.trim() : "";
        if (until !== "" && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(until)) {
          return json(400, { ok: false, error: "截止时间格式：YYYY-MM-DD 或 YYYY-MM-DDTHH:mm" });
        }
        const maxRaw = Number(b.maxRuns);
        const maxRuns = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(999, Math.floor(maxRaw)) : 0;
        const id = typeof b.id === "string" && b.id.trim() !== "" ? b.id.trim() : "";
        const idx = id === "" ? -1 : plans.findIndex((p) => p.id === id);
        if (id !== "" && idx < 0) return json(404, { ok: false, error: "计划不存在" });
        const plan = {
          id: idx >= 0 ? id : newPlanId(),
          accountId,
          ...prizeId === void 0 ? {} : { prizeId },
          prizeName: prizeName === "" ? String(prizeId) : prizeName,
          cron,
          leadSec,
          until,
          maxRuns,
          enabled: b.enabled === false ? false : true
        };
        const next = plans.slice();
        if (idx >= 0) next[idx] = plan;
        else next.push(plan);
        savePlans(store2, next, nowIso);
        resetPlanRuns(store2, plan.id, nowIso);
        syncExchangeJob(store2);
        deps.log(
          "定时计划：" + acct.label + " · " + plan.prizeName + " · " + cron + " · 提前 " + leadSec + "s" + (until ? " · 截止 " + until : "") + (maxRuns > 0 ? " · 最多 " + maxRuns + " 次" : "")
        );
        return json(200, {
          ok: true,
          note: "计划已保存：" + acct.label + " · " + plan.prizeName,
          plans: planViews(store2)
        });
      }
    },
    {
      // 兑换下单 —— **不可逆**（真扣豆）。起单只是写字（**不发请求**），
      // 后面每次 `step` 走一步、发一枪。见 tasks/exchangeOrder.ts 的枪序。
      path: `${base}/exchange/order`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const d = { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) };
        if (b.action === "clear") {
          clearOrder(d);
          return json(200, { ok: true, note: "这一单已清掉" });
        }
        if (b.action === "manual-plan") {
          const query2 = typeof b.query === "string" ? b.query.trim() : "";
          if (query2 === "") return json(400, { ok: false, error: "手动目标不能为空" });
          deps.store.setState("mcloud.exchange.plan", query2, d.nowIso);
          deps.log(`手动目标：${query2}`);
          return json(200, { ok: true, note: `手动目标已设为「${query2}」` });
        }
        if (b.action === "schedule-pause" || b.action === "schedule-resume") {
          const on = b.action === "schedule-resume";
          setTaskPaused("兑换", !on);
          setScheduleEnabled(deps.store, on, deps.now());
          deps.log(`定时抢兑：${on ? "启用" : "暂停"}`);
          return json(200, { ok: true, note: on ? "定时已启用" : "定时已暂停" });
        }
        if (b.action === "plan") {
          const query2 = typeof b.query === "string" ? b.query.trim() : "";
          const prizeIdRaw = Number(b.prizeId);
          const prizeId = Number.isInteger(prizeIdRaw) && prizeIdRaw > 0 ? prizeIdRaw : void 0;
          const prizeName = typeof b.prizeName === "string" && b.prizeName.trim() !== "" ? b.prizeName.trim() : query2;
          const target = prizeId === void 0 ? query2 : String(prizeId);
          if (target === "") return json(400, { ok: false, error: "定时目标不能为空" });
          const cron = typeof b.cron === "string" ? b.cron.trim() : "";
          if (cron === "") return json(400, { ok: false, error: "cron 表达式不能为空" });
          try {
            parseCron(cron);
          } catch (e) {
            return json(400, { ok: false, error: `cron 不对：${e.message}` });
          }
          const until = typeof b.until === "string" ? b.until.trim() : "";
          if (until !== "" && !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/.test(until)) {
            return json(400, { ok: false, error: "截止时间要写成 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm" });
          }
          const maxRunsRaw = Number(b.maxRuns ?? 0);
          if (!Number.isInteger(maxRunsRaw) || maxRunsRaw < 0 || maxRunsRaw > 999) {
            return json(400, { ok: false, error: "次数要是 0~999 的整数（0 = 不限）" });
          }
          const leadRaw = Number(b.leadSec ?? 120);
          if (!Number.isFinite(leadRaw) || leadRaw < 60 || leadRaw > 300) {
            return json(400, { ok: false, error: "提前触发要在 60~300 秒之间" });
          }
          const gen = String(Date.now());
          deps.store.setState(STATE_SCHEDULE_PLAN, target, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_PLAN_NAME, prizeName, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_CRON, cron, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_UNTIL, until, d.nowIso);
          deps.store.setState(STATE_SCHEDULE_MAX_RUNS, String(maxRunsRaw), d.nowIso);
          deps.store.setState(STATE_LEAD_SEC, String(Math.round(leadRaw)), d.nowIso);
          deps.store.setState(STATE_SCHEDULE_GEN, gen, d.nowIso);
          const accounts = resolveTaskAccounts(deps.store, "兑换");
          const plans = loadPlans(deps.store);
          for (const accountId of accounts) {
            const idx = plans.findIndex((p) => p.accountId === accountId);
            const plan = {
              id: idx >= 0 ? plans[idx].id : newPlanId(),
              accountId,
              ...prizeId === void 0 ? {} : { prizeId },
              prizeName,
              cron,
              leadSec: Math.round(leadRaw),
              until,
              maxRuns: maxRunsRaw,
              enabled: true
            };
            if (idx >= 0) plans[idx] = plan;
            else plans.push(plan);
          }
          savePlans(deps.store, plans, d.nowIso);
          setScheduleEnabled(deps.store, true, d.nowIso);
          syncExchangeJob(deps.store);
          deps.log(
            `定时目标：${prizeName}${prizeId === void 0 ? "" : `（prizeId=${prizeId}）`}（cron ${cron}，提前 ${Math.round(leadRaw)}s，每号最多 ${maxRunsRaw || "不限"} 次）`
          );
          return json(200, {
            ok: true,
            note: `定时已保存：${prizeName}（提前 ${Math.round(leadRaw)}s）`
          });
        }
        if (b.action === "step") {
          const r2 = runOrderStep(d);
          const step = d.store.getState(STATE_STEP) ?? "";
          deps.log(`兑换：${r2.note}`);
          return json(200, { ...r2, step, done: step === "done" });
        }
        const query = typeof b.query === "string" ? b.query.trim() : "";
        if (query !== "") deps.store.setState("mcloud.exchange.plan", query, d.nowIso);
        const r = startOrder(d, query);
        deps.log(`兑换起单：${r.note}`);
        return json(200, { ...r, queue: deps.store.getState("mcloud.exchange.order.step") ?? "" });
      }
    },
    {
      // 凭据续期。默认**按判据**（离过期还远就一个请求都不发）；
      // `{"force":true}` 对应 mcloud CLI 的 `--force`，用来"我现在就想试一下"。
      path: `${base}/auth/refresh`,
      method: "POST",
      handler: (req) => {
        const b = readBody(req);
        const force = b.force === true;
        const leadDays = typeof b.leadDays === "number" ? b.leadDays : void 0;
        const cur = currentAccount(deps.store);
        const r = runAuthRefresh(
          { store: deps.store, transport: deps.transport, nowIso: deps.now(), baseUrl: loadBaseUrl(deps.store) },
          force,
          leadDays,
          // 明确"刷当前这一条、写回这一条"（没有账号时才是单账号那格）
          cur === void 0 ? {} : { auth: cur.auth, accountId: cur.id }
        );
        deps.log(`凭据续期：${r.note}`);
        return json(200, { ...r, auth: authStatus(deps.store) });
      }
    },
    {
      // **只读探针**：一枪 `user/info`，回答"这一族能不能通"（不记账、不写状态）。
      // 没有它，"验请求头"得先有真口令，而口令只在直播那一小时有效。
      path: `${base}/live/draw/probe`,
      method: "POST",
      handler: () => {
        const r = probeLiveRoom({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store)
        });
        deps.log(`小红花探针：${r.note}`);
        return json(200, r);
      }
    },
    {
      // 账号列表（多账号第 2 片，见 accounts.ts 模块头）。
      //
      // ⚠ 只回**掩码**：凭据本身不许出这个口子（它已经能从别处拿，但少一个出口就少一处泄露面）。
      path: `${base}/accounts`,
      method: "GET",
      handler: () => json(200, { ...accountsView(deps.store) })
    },
    {
      path: `${base}/accounts`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        const op = typeof body.op === "string" ? body.op : "";
        const now = deps.now();
        if (op === "add") {
          const auth = typeof body.auth === "string" ? body.auth.trim() : "";
          if (auth === "") return json(400, { error: "要传 auth（原生凭据那一串）" });
          const info = parseAuth(auth);
          if (info === void 0) {
            return json(400, {
              error: "这段凭据解不开。它应该是 `Basic <base64>`（或只有 base64 那段），里面是 `<平台>:<手机号>:<token>`"
            });
          }
          const pcRaw = typeof body.pcPlatform === "string" ? body.pcPlatform : "";
          if (pcRaw !== "" && pcRaw !== "win" && pcRaw !== "mac") {
            return json(400, { error: "pcPlatform 只能是 win 或 mac" });
          }
          if (info.platform === PC_AUTH_PREFIX && pcRaw === "") {
            return json(400, {
              error: "这条是 PC 端 —— 选一下它当初是 Windows 还是 macOS（决定以后的请求头）",
              needPcPlatform: true
            });
          }
          const r = upsertAccount(
            deps.store,
            auth,
            now,
            void 0,
            pcRaw === "" ? void 0 : pcRaw
          );
          deps.log(`账号：${r.created ? "添加" : "更新"} ${r.account.label}`);
          if (loadAccounts(deps.store).length === 1) selectAccount(deps.store, r.account.id, now);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `${r.created ? "已添加" : "已更新"} ${r.account.label}` });
        }
        if (op === "set-settings") {
          const id = typeof body.id === "string" ? body.id : "";
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          const one = scoped(rawStoreOf(deps.store), id);
          const secs = typeof body.listenSeconds === "number" ? body.listenSeconds : null;
          const room = typeof body.listenRoom === "number" ? body.listenRoom : null;
          if (secs !== null) {
            const clamped = Math.max(10, Math.min(3600, Math.round(secs)));
            one.setState("mcloud.live.listen_seconds", String(clamped), now);
          }
          if (room !== null) {
            one.setState("mcloud.live.listen_room", room > 0 ? String(Math.round(room)) : "", now);
          }
          if (typeof body.wsHeartbeat === "string") {
            one.setState("mcloud.live.ws_heartbeat_reply", body.wsHeartbeat.trim(), now);
          }
          deps.log(`账号设置（${found.label}）：窗口 ${secs ?? "不变"}s / 房间 ${room ?? "不变"}`);
          return json(200, {
            ...accountsView(deps.store),
            note: `${found.label} 的设置已存下`
          });
        }
        if (op === "refresh") {
          const id = typeof body.id === "string" ? body.id : "";
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          const r = runAuthRefresh(
            {
              store: deps.store,
              transport: deps.transport,
              nowIso: deps.now(),
              baseUrl: loadBaseUrl(deps.store)
            },
            true,
            void 0,
            { auth: found.auth, accountId: found.id }
          );
          deps.log(`凭据续期（${found.label}）：${r.note}`);
          return json(200, {
            ...accountsView(deps.store),
            note: `${found.label}：${r.note}`
          });
        }
        if (op === "disable") {
          const id = typeof body.id === "string" ? body.id : "";
          const disabled = body.disabled === true;
          const a = setAccountDisabled(deps.store, id, disabled, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：${disabled ? "停用" : "启用"} ${a.label}`);
          syncTaskReadiness(deps.store);
          return json(200, {
            ...accountsView(deps.store),
            note: `${disabled ? "已停用" : "已启用"} ${a.label}`
          });
        }
        if (op === "edit") {
          const id = typeof body.id === "string" ? body.id : "";
          const label = typeof body.label === "string" ? body.label : "";
          const a = setAccountLabel(deps.store, id, label, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：改名为 ${a.label}`);
          return json(200, {
            ...accountsView(deps.store),
            note: `已改名为 ${a.label}`
          });
        }
        if (op === "select") {
          const id = typeof body.id === "string" ? body.id : "";
          if (!selectAccount(deps.store, id, now)) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(id === "" ? '账号：清掉"当前"（回到单账号那格）' : `账号：当前切到 ${id}`);
          return json(200, { ...accountsView(deps.store), note: id === "" ? "已清掉当前账号" : `当前：${id}` });
        }
        if (op === "remove") {
          const id = typeof body.id === "string" ? body.id : "";
          removeAccount(deps.store, id, now);
          deps.log(`账号：删掉 ${id}`);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `已删掉 ${id}` });
        }
        return json(400, { error: '需要 {"op":"add|select|remove", …}' });
      }
    },
    {
      // 开关：领小红花（写）。默认关。
      path: `${base}/live/claim`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        if (typeof body.enabled !== "boolean") {
          return json(400, { error: '需要 {"enabled": true|false}' });
        }
        setClaimEnabled(deps.store, body.enabled, deps.now());
        deps.log(`领小红花：${body.enabled ? "已开启（会真往账号里写）" : "已关闭"}`);
        return json(200, { enabled: claimEnabled(deps.store) });
      }
    },
    {
      // **推进一步**（一次调用一个上游请求 —— 面板执行预算 2000ms，见 liveDraw.ts 文件头）。
      //
      // 为什么是"一步"而不是"跑完整条链"：一个从头发到尾的函数会在第 2、3 个请求处
      // 被判超时，而那时**上游的账已经记了**。界面上那个按钮是**浏览器循环调这里**
      // 直到 `done` —— 每步一次 HTTP，每次一个上游请求。
      path: `${base}/live/draw/step`,
      method: "POST",
      handler: () => {
        const out = runLiveDraw(
          {
            store: deps.store,
            transport: deps.transport,
            nowIso: deps.now(),
            baseUrl: loadBaseUrl(deps.store)
          },
          { force: true }
          // 手动那一枪不受开关限制（开关只管 cron）
        );
        const state = loadDrawState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: state?.step === "done" || out.idle === true,
          state
        });
      }
    },
    {
      // 直播日程（门）：**推进一步**（handshake 步两发 / rooms 步两发，见 liveGateTask.ts）。
      // 与 `live/draw/step` 同一个形状：界面上的按钮是浏览器循环调这里直到 `done`。
      path: `${base}/live/gate/step`,
      method: "POST",
      handler: () => {
        const out = runLiveGate({
          store: deps.store,
          transport: deps.transport,
          nowIso: deps.now()
        });
        const st = loadGateState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === "done" || out.idle === true,
          step: st?.step ?? "handshake",
          reading: readGateReading(deps.store),
          pool: readPoolSummary(deps.store, localStamp(Date.parse(deps.now())), Date.parse(deps.now()))
        });
      }
    },
    {
      // 听弹幕推进一步（界面上的「听一拍」/ e2e 用）。
      // ⚠ 与门那个 step 口子同样的形状（`done` + `note` + `reading`），
      //   因为它们是**同一类**东西：一个按步骤推进的只读探针。
      path: `${base}/live/listen/step`,
      method: "POST",
      handler: () => {
        const st0 = loadListenState(deps.store);
        if (deps.ws === void 0) {
          return json(503, { error: "宿主没有长连接能力（ws_*）—— 这一族只有嵌入式 JS 宿主有" });
        }
        const out = runLiveListen({
          store: deps.store,
          transport: deps.transport,
          host: deps.ws,
          nowIso: deps.now(),
          baseUrl: loadBaseUrl(deps.store),
          lateMs: 0
        });
        const st = loadListenState(deps.store);
        return json(200, {
          ok: out.ok,
          note: out.note,
          done: st?.step === "done" || st?.step === void 0,
          step: st?.step ?? "idle",
          reading: st,
          line: listenReadingLine(st),
          windowOpen: st0?.step === "listen" || st0?.step === "open"
        });
      }
    },
    {
      path: `${base}/live/codes`,
      method: "POST",
      handler: (req) => {
        const body = readBody(req);
        if (body.clear === true) {
          clearLiveCodes(deps.store, deps.now());
          deps.log("直播口令：已清空");
          return json(200, { cleared: true });
        }
        const raw = typeof body.codes === "string" ? body.codes : typeof body.session === "string" ? body.session : "";
        if (!raw.trim()) {
          return json(400, { error: '需要 {"codes": "<口令，一行一条>"} 或 {"clear": true}' });
        }
        const r = saveLiveCodes(deps.store, raw, deps.now());
        if (!r.ok) return json(400, { error: r.error ?? "解不出口令" });
        deps.log(`直播口令：存了 ${r.codes.length} 条（${r.how}）`);
        return json(200, {
          saved: r.codes.length,
          codes: r.codes,
          how: r.how,
          stored: loadLiveCodes(deps.store)
        });
      }
    },
    {
      // 分组视图：把 20 条云盘任务按**风险与依赖**分组，附每条的实际状态。
      // 界面（M4）直接吃这个; 现在也能 curl 看。
      path: `${base}/groups`,
      method: "GET",
      handler: () => json(200, groupView(deps.store))
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
    },
    {
      // 「今日AI豆」—— **只读**，一枪 `cloudRecordV2` 翻到底再按**东八区自然日**汇总。
      //
      // 照参考实现（`mcloud-tasks/src/beans.rs` + 路由 `GET /api/beans/today`）：
      //   · **按账号一列**，**没有 `total` / `net` 这种跨账号字段** ——
      //     豆是每个账号各一本账，加出来的总数哪个账号都花不了。
      //   · **失败按账号隔离**：某个账号读不到（无会话 / 网络 / 上游码 /
      //     翻不到底 / 解不出 `insertTime`）只让它那一行进 `failed[]`，
      //     其余账号照常出数。这一条**不返回错误状态** —— 一个账号挂了不该
      //     把整张卡打成"服务挂了"。
      //   · **点了才取**：界面上那一格不做自动刷新；这一条路由每次点都真打上游。
      path: `${base}/beans/today`,
      method: "GET",
      // 逐账号 × 翻页 + **当场续票**的只读链：一发上游的超时就有 1500ms，
      // 面板默认 2 秒撑不到"把所有账号读一遍"。现在票过期还会**内联换票**
      // （`withTokenGate`：到期主动一轮 + `90001` 被动最多两轮，每轮四步 × 1500ms）。
      // 按最坏一档留预算：几个账号各可能"读失败→换票→再读"若干轮。健康路径秒回，
      // 这一档只在票全烂时才顶到。
      budget_ms: 6e4,
      handler: () => {
        const raw = rawStoreOf(deps.store);
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        const baseUrl = loadBaseUrl(deps.store);
        const rows = [];
        const failed = [];
        for (const a of loadAccounts(deps.store)) {
          if (a.disabled === true) continue;
          const one = scoped(raw, a.id);
          try {
            const day = readDayForAccount(
              { store: one, transport: deps.transport, baseUrl, nowIso },
              nowMs
            );
            rows.push({ id: a.id, label: a.label, ...day });
          } catch (e) {
            failed.push({
              id: a.id,
              label: a.label,
              reason: e instanceof Error ? e.message : String(e)
            });
          }
        }
        return json(200, { nowMs, accounts: rows, failed });
      }
    },
    {
      // 「查看明细」—— 一个账号的流水，**不限于今日**。窗口 `days ∈ 1/7/30/0`
      // （`0` = 全部）；`MAX_DETAIL_RECORDS` 撞上时 `hasMore=true`，界面写一句
      // "还有更多没列出来"，**不静默截断**。
      //
      // ⚠ 数据源与 `/beans/today` **同一条**：还是上游 `cloudRecordV2`。
      //   **不是**本仓的运行记录 / 明细账本 —— 那是"我们做过什么"，
      //   流水是"上游账上发生了什么"，两者对不上是常态（重试、手动操作、别的端）。
      //   这一条要回答的是后者。
      path: `${base}/beans/records`,
      method: "GET",
      // 「全部」那一档要把这个账号的流水**翻到底**（最多 `MAX_PAGES`=20 页）才能
      // 如实说"有没有更多"，一页一发 ⇒ 最坏 20 发 × 1500ms = 30s；再叠上"当场续票"
      // （到期主动一轮 + `90001` 被动最多两轮，每轮四步）⇒ 比今日那条再宽一档。
      budget_ms: 9e4,
      handler: (req) => {
        const q = parseQuery(req.query ?? "");
        const id = q["id"] ?? "";
        const days = normalizeDays(q["days"]);
        const found = loadAccounts(deps.store).find((a) => a.id === id);
        if (!found) return json(400, { error: `列表里没有这个账号：${id || "（没给 id）"}` });
        const raw = rawStoreOf(deps.store);
        const nowIso = deps.now();
        const nowMs = Date.parse(nowIso);
        const baseUrl = loadBaseUrl(deps.store);
        const one = scoped(raw, id);
        try {
          const data = readRecordsForAccount(
            { store: one, transport: deps.transport, baseUrl, nowIso },
            nowMs,
            days
          );
          return json(200, {
            account: found.label,
            days,
            nowMs,
            records: data.records,
            undated: data.undated,
            hasMore: data.hasMore
          });
        } catch (e) {
          return json(200, {
            account: found.label,
            days,
            nowMs,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }
  ];
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

// src/store/host.ts
import { sqlite_exec, sqlite_query } from "host-api";
function sqlQ(sql, params) {
  const rows = sqlite_query(sql, params);
  if (!Array.isArray(rows)) {
    throw new Error(`sqlite_query 失败：${rows.error ?? "未知错误"}`);
  }
  return rows;
}
function sqlX(sql, params) {
  const r = sqlite_exec(sql, params);
  if (typeof r?.error === "string" && r.error !== "") {
    throw new Error(`sqlite_exec 失败：${r.error}`);
  }
  return { changes: Number(r?.changes ?? 0), lastInsertRowid: Number(r?.lastInsertRowid ?? 0) };
}
function hostStore() {
  let schemaReady = false;
  return {
    ensureSchema: () => {
      if (schemaReady) return;
      sqlX(
        `CREATE TABLE IF NOT EXISTS mcloud_runs (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           task         TEXT    NOT NULL,
           runs         INTEGER NOT NULL,
           scheduled_at TEXT    NOT NULL,
           fired_at     TEXT    NOT NULL,
           late_ms      INTEGER NOT NULL,
           ok           INTEGER NOT NULL,
           note         TEXT
         )`,
        []
      );
      sqlX(
        `CREATE INDEX IF NOT EXISTS idx_mcloud_runs_task_fired ON mcloud_runs (task, fired_at)`,
        []
      );
      sqlX(
        `CREATE TABLE IF NOT EXISTS state (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`,
        []
      );
      schemaReady = true;
    },
    getState: (key) => {
      const rows = sqlQ(`SELECT value FROM state WHERE key = ?1`, [key]);
      const row = rows[0];
      return row ? String(row.value) : null;
    },
    setState: (key, value, nowIso) => {
      sqlX(
        `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
        [key, value, nowIso]
      );
    },
    recordRun: (r) => {
      const res = sqlX(
        `INSERT INTO mcloud_runs (task, runs, scheduled_at, fired_at, late_ms, ok, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [r.task, r.runs, r.scheduledAt, r.firedAt, Math.round(r.lateMs), r.ok ? 1 : 0, r.note ?? null]
      );
      return res.lastInsertRowid;
    },
    // 分位数在 SQL 里算，不把行拉回来算：`sqlite_query` 一次最多返回 1000 行，
    // 跑到几万次触发之后「拉回来再算」会静默丢数据 —— 那种错很难发现（数字看着还合理）。
    // 另外两点和内存实现必须同口径：**排除负延迟**（F-001）、**按值排序取分位**（不是按 id）。
    lateStats: (task, lastN = 500) => {
      const agg = sqlQ(
        `SELECT COUNT(*) AS n, MAX(late_ms) AS mx FROM (
           SELECT late_ms FROM mcloud_runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
         )`,
        [task, lastN]
      );
      const n = Number(agg[0]?.n ?? 0);
      const neg = sqlQ(
        `SELECT COUNT(*) AS c FROM (
           SELECT late_ms FROM mcloud_runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2
         ) WHERE late_ms < 0`,
        [task, lastN]
      );
      const pick2 = (q) => {
        if (n === 0) return 0;
        const offset = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
        const rows = sqlQ(
          `SELECT late_ms AS v FROM (
             SELECT late_ms FROM mcloud_runs WHERE task = ?1 AND late_ms >= 0 ORDER BY id DESC LIMIT ?2
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
    recentRuns: (limit = 20) => sqlQ(
      `SELECT task, runs, fired_at, late_ms, ok, note FROM mcloud_runs ORDER BY id DESC LIMIT ?1`,
      [Math.min(limit, 1e3)]
    )
  };
}

// src/entries/shared.ts
var DEFAULT_REQUEST_TIMEOUT_MS = 1500;
function makeTransport(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return (req) => {
    const r = applyDefaultContentType(req);
    return http_fetch(r.url, hostFetchOptions(r, timeoutMs));
  };
}
function makeStore() {
  const store2 = hostStore();
  store2.ensureSchema();
  const { moved } = migrateFlatKeys(store2, (/* @__PURE__ */ new Date()).toISOString());
  const s = scoped(store2);
  if (moved.length > 0) {
    log(`状态迁移：${moved.length} 个键搬进账号袋（${moved.join(", ")}）`);
  }
  return s;
}
function makeHost() {
  return {
    wsOpen: (url, opts) => ws_open(url, opts),
    wsSend: (id, text) => ws_send(id, text),
    wsRecv: (id, timeoutMs) => ws_recv(id, timeoutMs),
    wsClose: (id) => ws_close(id)
  };
}
function makePushDeps(transport2) {
  return {
    http: (r) => {
      const res = transport2(r);
      if (isFetchError(res)) {
        return { ok: false, status: 0, body: "", error: res.error };
      }
      return { ok: true, status: res.status, body: res.body ?? "", error: void 0 };
    },
    smtp: (opts) => {
      const res = smtp_send(opts);
      return { ok: res.ok === true, response: String(res.response ?? "") };
    },
    nowMs: () => Date.now(),
    log: (msg) => log(msg)
  };
}

// src/selftest.ts
import { http_fetch as http_fetch2 } from "host-api";
function selftest(store2) {
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
  let id = 0;
  let statsOk = false;
  let sqliteWhy = "";
  try {
    id = store2.recordRun({
      task: "__selftest__",
      runs: 0,
      scheduledAt: (/* @__PURE__ */ new Date(0)).toISOString(),
      firedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
      lateMs: 0,
      ok: true,
      note: "selftest"
    });
    statsOk = store2.lateStats("__selftest__", 10).n >= 1;
  } catch (e) {
    statsOk = false;
    sqliteWhy = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  checks.push(["sqlite 自增主键返回", id > 0]);
  checks.push(["sqlite 聚合查询可用", statsOk]);
  let nativeTls = false;
  let tlsWhy = "";
  try {
    const r = http_fetch2("https://127.0.0.1:9/", { tls: "native", timeout_ms: 2e3 });
    const err2 = r.error ?? "";
    nativeTls = !/legacy-tls/.test(err2);
    if (!nativeTls) tlsWhy = err2;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    nativeTls = !/legacy-tls/.test(m);
    if (!nativeTls) tlsWhy = m;
  }
  checks.push(["宿主支持 native TLS（直播那条链要它）", nativeTls]);
  const caps = sandboxCaps();
  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: bad.length === 0,
    detail: (bad.length === 0 ? `${checks.length}/${checks.length} 通过` : `失败：${bad.join("、")}`) + (sqliteWhy === "" ? "" : `（sqlite：${sqliteWhy}）`) + (tlsWhy === "" ? "" : `（tls：${tlsWhy}）`) + ` · ${caps}`,
    checks: checks.map(([name, ok]) => ({ name, ok })),
    caps
  };
}

// src/entries/mcloud.ts
worker_hint("exclusive");
var store = makeStore();
var bootIso = (/* @__PURE__ */ new Date()).toISOString();
if (migrateLegacyExchange(store, bootIso)) {
  log2("老库迁移：兑换的账号选择沿用“全部账号”（这一版改成显式选择）");
}
syncTaskReadiness(store);
var transport = makeTransport();
var host = makeHost();
register_nav({
  label: "云盘",
  icon: "☁"
  // 不写 path：面板默认 `plugins/mcloud/index.html`，正是我们放页面的地方
});
var registered = 0;
try {
  for (const r of mcloudRoutes({
    store,
    transport,
    now: () => (/* @__PURE__ */ new Date()).toISOString(),
    log: (msg) => log2(msg),
    ws: host,
    pushDeps: makePushDeps(transport)
  })) {
    register_route(r.path, r.method, r.handler, r.budget_ms === void 0 ? void 0 : { budget_ms: r.budget_ms });
    registered++;
  }
} catch (e) {
  error(`路由注册失败（第 ${registered + 1} 条）：${e instanceof Error ? e.message : String(e)}`);
  throw e;
}
var selftestRoute = {
  path: "/plugins/mcloud/api/selftest",
  method: "GET",
  handler: () => {
    const r = selftest(store);
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(r)
    };
  }
};
register_route(selftestRoute.path, selftestRoute.method, selftestRoute.handler);
store.setState("plugin.loaded_at", (/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString());
debug(`mcloud（服务型）：${registered + 1} 条路由 + 侧边栏入口，**没有 cron 任务**`);
