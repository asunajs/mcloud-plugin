// mock 上游：让签到族的任务能在 CI 里跑完，而**永远不碰真账号**。
//
// 三件事必须做对，否则这个 mock 只是个自我安慰：
//
//   ① **记录收到的每一个请求**（方法、路径、头、body），通过 `/_debug/requests` 读出来。
//      这样测试断言的不只是「任务返回了 ok」，而是「我们真的发对了头与签名」——
//      签名错是这条链最常见的失败，而它在真机上的表现只有一句「签名错误」。
//   ② **形状照抄实拍**：`{"code":0,"msg":"success","result":…}`（数字 code），
//      以及 result 是数组还是对象——不同端点不一样，别统一。
//   ③ 能**故意失败**：业务失败（`code!=0`）、HTTP 500、超时、非 JSON。
//      错误路径不测，等于没测——上线后遇到的第一件事就是它。
//
// 可以作为模块用（`startMock()`，给测试），也可以直接跑（`node mock/upstream.mjs`，
// 给手工联调：把插件的基址指到它就行）。

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** 固定的会话凭据：mock 不校验，但插件要带，测试就能断言「确实带了」。 */
export const MOCK_JWT = 'mock-jwttoken';
export const MOCK_COOKIE = 'mockcookie=1';
/** 直播侧（`/cmlive`）的 JWT —— 与签到族的 `jwttoken` **不是同一份**（这一族用 `Authorization` 头）。 */
export const MOCK_LIVE_JWT = 'MOCK-LIVE-JWT-180-CHARS-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** 上游的本地时刻串（`YYYY-MM-DD HH:MM:SS`）—— 与真上游同一个格式（**没有时区**）。 */
function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 会发口令的那个主播（与插件 `koulingPool.KOULING_ANCHOR` 同一个值 —— 两处都得是它）。 */
const KOULING_ANCHOR_MOCK = '中国移动云盘';

/** 门看到的房间（按页签）。形状照实拍：房间嵌在 `dataList[].room` 里。 */
const LIVE_ROOMS = {
  // 127 = 盘盘福利
  '127': [
    // ⚠ 坑一：**在播但不是那个主播**（实拍房间号就是 147490）
    { id: 147490, title: '福建移动福利场', status: 1, channelId: 29, expectStartTime: '', anchor: { nickname: '福建移动' } },
    // 那个主播，正在播 —— 门开着靠它
    { id: 147606, title: '云盘直播福利场', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR_MOCK } },
  ],
  // 129 = 精彩回放
  '129': [
    // ⚠ 坑二：**同一间房在两个页签里都出现** ⇒ 必须按 id 去重
    { id: 147606, title: '云盘直播福利场', status: 1, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR_MOCK } },
    // 预告场 ⇒ 「下一场」读的就是它（时间**相对现在**算，见上面那条注释）
    { id: 147608, title: '云盘直播·下一场', status: 0, channelId: 134, expectStartTime: localStamp(Date.now() + 24 * 3600 * 1000), anchor: { nickname: KOULING_ANCHOR_MOCK } },
    // 回放（`status: 6`，**不是 2**）—— 日程要留着它，门不算它
    { id: 147609, title: '云盘直播·上一场回放', status: 6, channelId: 134, expectStartTime: '', anchor: { nickname: KOULING_ANCHOR_MOCK } },
  ],
};


const json = (res, status, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8' });
  res.end(body);
};

/** 默认夹具：形状照抄 mcloud 文档里记的实拍。 */
export const FIXTURES = {
  // taskListV3 的 result 是**数组**
  //
  // ⚠ `state` 只有 **`FINISH` / `WAIT` / `DOING`** 三种（mcloud 逐条扫过实拍，
  //   没有 `UNFINISH` 这种值）。
  // ⚠ `buttonProperty`/`button` 下面按端分（`email`/`app`/`out`），里面那句 `text`
  //   是**上游替这一条、这一阶段写好的话** —— 界面徽章照抄它，别自己造「待做」。
  //   值取自真机实拍（抓包仓 §12.10 / §12.11）：进行中的那条是「开启中」并带
  //   `day`/`total`（App 上那个「完成进度 (1/31)」），完成的那条是「次月可领」。
  taskListV3: {
    code: 0,
    msg: 'success',
    result: [
      {
        id: 596,
        name: '签到',
        state: 'FINISH',
        enable: 1,
        process: 0,
        currstep: 4,
        buttonProperty: { app: { text: '已完成', canReceive: 0 } },
      },
      {
        id: 597,
        name: '分享',
        state: 'WAIT',
        enable: 1,
        process: 0,
        currstep: 6,
        buttonProperty: { app: { text: '去完成', canReceive: 0 } },
      },
      {
        id: 598,
        name: '固定入口',
        state: 'WAIT',
        enable: 1,
        process: 0,
        currstep: 8,
        // 只有 `button`、没有 `buttonProperty` 的那种（实拍 1021 就是这样）
        button: { out: { text: '开启中', day: '5', total: 31, canReceive: 0 } },
      },
    ],
  },
  // taskListV2 的 result 是**以 group 为键的对象**（与 V3 形状不同，故意保留）
  taskListV2: { code: 0, msg: 'success', result: {}, groupState: {} },
  // infoV3 由状态机生成，见下面 case 分支
  infoV3: { code: 0, msg: 'success', result: {} },
  startSignIn: { code: 0, msg: 'success', result: { bean: 10 } },
  receiveV3: { code: 0, msg: 'success', result: { bean: 10 } },
  multiple: { code: 0, msg: 'success', result: { multiple: 2 } },
  receiveRevivalReward: { code: 0, msg: 'success', result: { bean: 5 } },
  // `cloudRecordV2` 的 result 是**对象**、里面才是 `records` 数组（照参考实现
  // `parse_cloud_records`）。字段名照实拍：`num` 是带符号的整数、`summary` 摘要、
  // `mark` 备注、`insertTime` 是 ISO 带显式偏移。
  // ⚠ 具体数值由下面 `cloudRecordsMock()` **按今天现算**（这里只是给一个不会
  //   被别的 case 意外吃到的占位形状）。
  cloudRecordV2: { code: 0, msg: 'success', result: { records: [] } },
  prizeRecord: { code: 0, msg: 'success', result: [{ id: 1, name: 'AI豆', state: 'UNRECEIVED' }] },
  backupGiftInfo: { code: 0, msg: 'success', result: { canReceive: true } },
  backupGiftReceive: { code: 0, msg: 'success', result: {} },
};

/** `cloudRecordV2` 的 mock：**按"现在"现算**，让预览里"今日"真的有数。
 *
 *  # 为什么不是静态夹具
 *
 *  插件那边判"是不是今天"用的是**东八区日界**（`beans.ts::dayStartMs`）—— 一个
 *  固定日期的静态夹具过一天就对不上"今天"。这里按 `Date.now()` 生成三笔：
 *    · 今天 08:00（东八区）一笔 +
 *    · 昨天 20:00（东八区）一笔（**验窗口过滤**：明细"近 7 天"要看得见，"今日"要看不见）
 *    · 一条没有 `insertTime` 的（**验 undated 那一档**：明细照样列出来，只是排在最后）
 *  每笔都带**显式偏移** `+08:00` —— 与实拍里 `2026-09-16T11:12:54.000+00:00` 同族格式。
 *
 *  # 只有一页
 *
 *  参考实现那边翻到短页为止。这里返回 3 条（< `PAGE_SIZE=100`）⇒ 插件那边第一页就停，
 *  不撞 `MAX_PAGES`。要测翻页与 `hasMore`，改这里返回 `PAGE_SIZE` 满页 ×N 次即可。 */
function cloudRecordsPage(pageNumber) {
  if (pageNumber > 1) return { code: 0, msg: 'success', result: { records: [] } };
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // 东八区"今天 00:00"是 epoch 毫秒的那个点：
  //   把"现在"平移到东八区墙钟看，取那天的 UTC 零点，再减 8 小时回 UTC。
  const bjOffsetMs = 8 * 3_600_000;
  const nowMs = Date.now();
  const asBj = new Date(nowMs + bjOffsetMs);
  const dayStartUtcMs =
    Date.UTC(asBj.getUTCFullYear(), asBj.getUTCMonth(), asBj.getUTCDate()) - bjOffsetMs;
  const iso = (utcMs) => {
    // 写东八区墙钟 + `+08:00` 偏移，两种信息都给全（预览看的是墙钟串）。
    const bj = new Date(utcMs + bjOffsetMs);
    return (
      `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}` +
      `T${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}` +
      `.${pad(bj.getUTCMilliseconds(), 3)}+08:00`
    );
  };
  return {
    code: 0,
    msg: 'success',
    result: {
      records: [
        // 今日两笔：一进一出 —— 卡上"净增 = 收 − 支"要看得出。
        { num: 10, summary: '每日签到', mark: 'MOCK-sign', insertTime: iso(dayStartUtcMs + 8 * 3_600_000) },
        { num: -3, summary: '兑换扣减', mark: 'MOCK-spend', insertTime: iso(dayStartUtcMs + 9 * 3_600_000) },
        // 昨天一笔：**验窗口过滤** —— "今日"看不见，"近 7 天"看得见。
        { num: 5, summary: '昨日签到（对照）', mark: 'MOCK-yest', insertTime: iso(dayStartUtcMs - 4 * 3_600_000) },
        // 没有 `insertTime` 那一笔：**验 undated** —— 明细照样列（排最后），今日汇总里
        //   让**该账号进 failed**（照参考实现：解不出就如实报错，不静默丢）。
        // ⚠ 这一条会让 `/beans/today` 走"解不出 insertTime ⇒ 抛"的分支。
        //   要"今日有数"预览的话把它注释掉；要"失败隔离 + undated"预览的话留着。
        //   默认**注释掉** —— 用户预览要看的是"卡上有数"，不是"卡说读不出"。
        // { num: 7, summary: '时间读不出（对照）', mark: 'MOCK-undated' },
      ],
    },
  };
}

/**
 * 起一个 mock 上游。
 * @returns {{ url: string, port: number, requests: object[], reset(): void, setBehavior(b): void, close(): Promise<void> }}
 */
// ══════════════════ 最小 WS + SockJS + msync 工具（够 mock 用就行）══════════════════
//
// ⚠ 这里是**测试夹具**，不是生产实现 —— 它只需要"能让插件那条链真的跑起来"：
//   帧要能被插件的解析路径读懂（所以必须按抓包 §3.1 的字段路径拼），
//   但不需要实现 RFC6455 的全部（无分片、无压缩 —— 抓包 §一 判据 3 说服务端本来也不接受压缩）。

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

/** protobuf：`(字段号 << 3) | wireType` 的 tag + 内容。 */
function pbField(num, wire, body) {
  return Buffer.concat([varint((num << 3) | wire), body]);
}
const pbVarint = (num, n) => pbField(num, 0, varint(n));
const pbBytes = (num, buf) => pbField(num, 2, Buffer.concat([varint(buf.length), buf]));

/** 拼一条 MSync 字节串。
 *
 *  - `command=2`（弹幕）：文本放在 **MSync.9 → .2 → .6 → .4 → .2**（抓包 §3.1 逐字节核过的路径）
 *  - `command=3`（PROVISION 响应）：只带一只有形状的 payload 壳
 *  - `command=0/1`（ack / 心跳）：由插件那边发，mock 只用得着解它
 */
export function msyncBytes({ command, msgId = null, text = null }) {
  let payload;
  if (text !== null) {
    const content = pbBytes(4, pbBytes(2, Buffer.from(text, 'utf8')));
    const message = Buffer.concat([pbBytes(1, Buffer.from(msgId ?? 'm0', 'utf8')), pbBytes(6, content)]);
    payload = pbBytes(2, message);
  } else if (msgId !== null) {
    payload = pbBytes(2, pbBytes(1, Buffer.from(msgId, 'utf8')));
  } else {
    payload = pbBytes(1, pbVarint(1, 0));
  }
  return Buffer.concat([pbVarint(8, command), pbBytes(9, payload)]);
}

/** SockJS 的**服务端推送**形状：`a["<b64>"]`。 */
export function sockjsData(msync) {
  return `a[${JSON.stringify(Buffer.from(msync).toString('base64'))}]`;
}

/** 解 **客户端**发来的 SockJS 帧 `["<b64>"]` → `{ command, hex }`；解不出返回 null。 */
export function decodeSockjsSend(text) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || typeof arr[0] !== 'string') return null;
  const bytes = Buffer.from(arr[0], 'base64');
  // 只找字段 8（command）—— mock 不需要解全
  let i = 0;
  let command = -1;
  while (i < bytes.length) {
    let tag = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const num = tag >>> 3;
    const wire = tag & 0x07;
    if (wire === 0) {
      let v = 0;
      shift = 0;
      while (i < bytes.length) {
        const b = bytes[i++];
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (num === 8) command = v;
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      while (i < bytes.length) {
        const b = bytes[i++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      i += len;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else return null;
  }
  return { command, hex: bytes.toString('hex').slice(0, 64) };
}

/** 写一条**服务端→客户端**的文本帧（服务端**不加掩码**）。 */
export function wsSendText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([head, payload]));
}

/** 解一帧**客户端→服务端**（客户端**一定加掩码**）。不够就返回 null。 */
export function readWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const masked = (buf[1] & 0x80) !== 0;
  if (masked) {
    if (buf.length < off + 4 + len) return null;
    const mask = buf.subarray(off, off + 4);
    const body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
    return { opcode, payload: body, rest: buf.subarray(off + 4 + len) };
  }
  if (buf.length < off + len) return null;
  return { opcode, payload: buf.subarray(off, off + len), rest: buf.subarray(off + len) };
}

export async function startMock(options = {}) {
  const requests = [];

  // ── 一个小小状态机 ──────────────────────────────────────────────────────
  //
  // 一开始这里是纯静态夹具，结果测不了**多步流程**：签到是「提交 → 回查状态」，
  // 静态夹具永远回「今天还没签」，于是回查那一步必然报失败 —— 那是 mock 的毛病，
  // 不是插件的。所以给它一点状态：动作打过来就改变后续的只读响应。
  //
  // 默认起点：今天还没签、有 2 条待领（其中 1 条是延期领取）、有翻倍机会、备份好礼可领。
  const st = {
    // 通知任务：能不能领（reward 之后翻成 false）
    noticeClaimable: true,
    todaySigned: false,
    receiveList: [{ recordId: 'r1', cloudType: 2 }, { recordId: 'r2', cloudType: 1 }],
    curMonthBackup: true,
    curMonthBackupSignAccept: false,
    backupCanReceive: true,
    // 小红花：余额刻意做成**会变**的（插件的"进账"是 ⑥ − ①，夹具不变那条断言就等于没测）
    flowerCnt: 100,
    firstParticipated: false,
  };
  // behavior: 'normal' | 'biz-fail' | 'http-500' | 'not-json' | 'timeout'
  let behavior = options.behavior ?? 'normal';
  const delayMs = options.delayMs ?? 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      // `/_debug/*` 是 mock 自己的管理接口，不算"上游收到的请求" —— 记进去只会
      // 让断言里多出噪声（而且分分钟把 clear 自己也算成一次请求）
      if (!url.pathname.startsWith('/_debug/')) {
        requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      }

      if (url.pathname === '/_debug/requests') return json(res, 200, requests);
      // 清空记录：CI 里分段落断言时用（不然前面步骤发的请求也会混进来）
      if (url.pathname === '/_debug/requests/clear') {
        const n = requests.length;
        requests.length = 0;
        return json(res, 200, { cleared: n });
      }
      if (url.pathname === '/_debug/state') return json(res, 200, st);
      // ── 弹幕那条链的口子（e2e 用）────────────────────────────────────
      // 为什么走 HTTP 而不是直接调 mock 的函数：e2e 是**另一个进程**（bash + python）
      // 在驱动面板，它拿不到 mock 的对象 ⇒ 只能走一个能观察/能推的口子。
      if (url.pathname === '/_debug/ws') {
        return json(res, 200, {
          connected: wsConn !== null,
          provisioned: wsConn !== null && wsConn.provisioned,
          acked: wsConn === null ? 0 : wsConn.acked,
          danmakuSent: wsConn === null ? 0 : wsConn.danmakuSent,
          upgradeHeaders: wsUpgradeHeaders,
          frames: wsFrames.map((f) => ({ command: f.command, hex: f.hex })),
        });
      }
      if (url.pathname === '/_debug/ws/danmaku' && req.method === 'POST') {
        let text = '小红花口令：一键9图出圈';
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed?.text === 'string' && parsed.text) text = parsed.text;
        } catch {
          /* 空 body 就用默认文本 */
        }
        const ok = pushDanmaku(text);
        return json(res, ok ? 200 : 409, { pushed: ok, text });
      }
      if (url.pathname === '/_debug/behavior') {
        if (req.method === 'POST') {
          behavior = body || 'normal';
          return json(res, 200, { behavior });
        }
        return json(res, 200, { behavior });
      }

      // ── 口令主页（直播那条链的**第三方**源）────────────────────────────────
      //
      // 为什么 mock 要管这一口：`live-room` 抓的是小红书主页，是本仓库里**唯一**
      // 会打第三方站点的一条链。仓库的纪律是「CI 全程只打 mock」，所以插件必须
      // 能把这个地址指走（`POST /plugins/mcloud/api/config {"liveUrl": …}`），
      // 而这里就是它指过来的落点。
      //
      // ⚠ 页面**故意做得大**（> 5 KB）：插件的读数里有一条"页面小得可疑 ⇒ **猜**是
      // 被挡成空壳"的提示。夹具太小会让那次断言看起来像被挡了，而那是在测夹具、不是测插件。
      if (url.pathname === '/xhs/profile') {
        const filler = '<div class="note">这一期云盘的笔记正文占位</div>'.repeat(200);
        const html =
          '<html><head><script>window.__INITIAL_STATE__=' +
          JSON.stringify({ noteList: [{ displayTitle: '小红花口令：云盘AI高效复盘' }] }) +
          '</script></head><body>' +
          filler +
          '</body></html>';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // ── 直播侧（`/cmlive`）：**门的三步**（日程 / 门开没开）──────────────────
      //
      // 这一族用的是**第三套信封**：`{rtnCode: "0", rtnMsg, object}` —— 码是**字符串**、
      // 数据键叫 `object`。夹具必须真是这个形状：喂 `{code:0,result:…}` 的话，
      // 插件那个"只认字符串码"的报警灯就永远测不到（而它正是刻意留出来的）。
      //
      // ⚠ 房间夹具里刻意摆了两个"坑"（都是 mcloud 实拍里真出现过的形状）：
      //   · `147490`「福建移动」也是 `status: 1` —— 只看状态会把门判成开着
      //   · `147606` 在**两个页签里都出现** —— 不去重就会对同一间房做两次动作
      // ⚠ 预告场的时间是**相对 now 算的**（不是写死的日期）：写死的话，
      //   过了那天这条断言就会翻 —— 那是 F-019 那一类错（测试依赖运行机器的时间）。
      if (url.pathname === '/api/user/auth/cmpassLoginByCmToken') {
        return json(res, 200, { rtnCode: '0', rtnMsg: null, object: MOCK_LIVE_JWT });
      }
      if (url.pathname === '/api/channel/channel/tabContentList') {
        const tabId = url.searchParams.get('tabId');
        if (tabId !== '127' && tabId !== '129') {
          return json(res, 200, { rtnCode: '404', rtnMsg: '页签不存在', object: null });
        }
        const dataList = (LIVE_ROOMS[tabId] || []).map((room) => ({ type: 1, room }));
        return json(res, 200, { rtnCode: '0', rtnMsg: null, object: { dataList } });
      }

      // ③ 取 WS 凭据（`userToken`）—— ⚠ 与门的 JWT 不是同一枚：PROVISION 的 auth 用它
      if (url.pathname === '/api/user/customer/userToken') {
        return json(res, 200, {
          rtnCode: '0',
          rtnMsg: null,
          object: { access_token: 'MOCK-WS-ACCESS-TOKEN', expires_in: 7200 },
        });
      }
      // ⑤ 进聊天室（`member/apply`）—— **第三套信封**：数字码 + `data`
      //    ⚠ 两个签名头服务端**不校验**（抓包 §8.6），这里也不校验 ——
      //    但 mock 会把它们记下来，让 e2e 能断言"算出来的形状对"。
      if (url.pathname === '/v3/room/member/apply') {
        return json(res, 200, {
          code: 0,
          msg: '接口调用成功',
          data: { appId: 'cmosim', appKey: 'mock-app-key', roomId: '1500000000000000000000000000001' },
          timestamp: Date.now(),
        });
      }

      // 进直播间（`roomBeat`）—— **POST**，房间号在 body 里（不是 GET + query）。
      //
      // ⚠ 它是「这间房**有没有聊天室**」的唯一判据：未开播时 `chatRoomId` 是 null，
      //   而那意味着 WS 与 `member/apply` 都**不该发**（抓包 §5.2）。
      //   这里给一只有值的，让"能听"那条链在 mock 上跑得起来；
      //   "没有聊天室"那一支由插件的单测覆盖（它更便宜、也更准确）。
      if (url.pathname === '/api/room/front/roomBeat') {
        let roomId = '';
        try {
          roomId = String(JSON.parse(body)?.roomId ?? '');
        } catch {
          /* body 坏 ⇒ 当成没给 */
        }
        const room = Object.values(LIVE_ROOMS)
          .flat()
          .find((r) => String(r.id) === roomId);
        if (!room) return json(res, 200, { rtnCode: '404', rtnMsg: '房间不存在', object: null });
        return json(res, 200, {
          rtnCode: '0',
          rtnMsg: null,
          object: {
            status: room.status,
            title: room.title,
            channelId: room.channelId,
            expectStartTime: room.expectStartTime,
            // 31 位数字串（抓包 §5.2 那个形状）
            chatRoomId: '15000000000000000000000000000 1'.replace(' ', ''),
            anchor: { nickname: room.anchor.nickname },
          },
        });
      }

      // ── 小红花（`liveRoomFeedback`）：领小红花那条链 ────────────────────────
      //
      // 六步链，四口的**请求体形态各不相同**（见插件侧 liveFlower.ts 文件头）：
      //   user/info          → POST `{}`（json）
      //   visitlog/journaling→ POST 表单
      //   firstParticipate   → POST **无 body**
      //   redFlower/draw     → POST **无 body**，口令在 query
      // 所以这里不能"统一按 JSON 读 body"——`draw` 的 body 是空的。
      //
      // ⚠ 余额刻意做成**会变**的：插件的"进账"是 **⑥ − ①**，
      // 夹具不变的话那一条断言永远等于 0，等于没测。
      if (url.pathname === '/ycloud/liveRoomFeedback/user/info') {
        return json(res, 200, { code: 0, msg: 'success', result: { flowerCnt: st.flowerCnt } });
      }
      if (url.pathname === '/ycloud/visitlog/journaling') {
        return json(res, 200, { code: 0, msg: 'success' });
      }
      if (url.pathname === '/ycloud/liveRoomFeedback/firstParticipate/give') {
        // 第二次起就是 `200110`（已参与过）—— 那是**正常**的一支，不是失败
        const first = !st.firstParticipated;
        st.firstParticipated = true;
        return first
          ? json(res, 200, { code: 0, msg: 'success' })
          : json(res, 200, { code: 200110, msg: '已参与过' });
      }
      if (url.pathname === '/ycloud/liveRoomFeedback/redFlower/draw') {
        const code = url.searchParams.get('code') ?? '';
        // 口令里带「过期」⇒ 回 `200118`（本场已结束）。这是**刻意**留的一支：
        // 它和 `200108`（口令无效）在插件里走**不同的**分支，必须能被端到端验到。
        if (code.includes('过期')) return json(res, 200, { code: 200118, msg: '口令已失效' });
        st.flowerCnt += 10;
        return json(res, 200, {
          code: 0,
          msg: 'success',
          result: { prizeId: 1, flowerNum: 10, prizeName: '小红花', prizeType: 1 },
        });
      }
      if (url.pathname === '/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers') {
        return json(res, 200, { code: 0, msg: 'success', result: 3 });
      }

      // ── H5 换票三步 ──────────────────────────────────────────────────────
      //
      // ① `querySpecTokenV2`（**原生族**：Authorization 鉴权、无签名；双层信封、
      //    `code` 是**字符串** `"0000"`）
      // ② `api/timestamp`（无鉴权，只回一个 13 位毫秒）
      // ③ `tyrzLogin`（H5 族：带签名，`code` 是**数字** 0）
      //
      // 三个信封形状**各不相同** —— 插件那边有三套解析器，这里就要有三套形状，
      // 否则"解析器能认"这件事根本没被测到。
      if (url.pathname === '/user/querySpecTokenV2') {
        return json(res, 200, {
          success: true,
          code: '0000',
          message: 'ok',
          data: { token: 'SSO-MOCK' },
        });
      }
      if (url.pathname === '/ycloud/api/timestamp') {
        return json(res, 200, { code: 0, msg: 'success', result: 1700000000000 });
      }
      // ④ smid 风控上报 —— **另一台主机、另一套码**（数字 1100，不是字符串 "0000"）。
      // 没有它，换票链的第 4 步会去真的打第三方域（见 smid.ts 的 base 覆盖那条注释）
      if (url.pathname === '/deviceprofile/v4') {
        return json(res, 200, { code: 1100, detail: { deviceId: 'MOCKDEV' } });
      }
      if (url.pathname === '/ycloud/auth-service/auth/tyrzLogin') {
        return json(res, 200, {
          code: 0,
          msg: 'success',
          result: { token: 'JWT-MOCK-0123456789', mobile: '13800000000' },
        });
      }

      const finish = () => {
        if (behavior === 'http-500') return json(res, 500, { code: -1, msg: 'boom' });
        if (behavior === 'not-json') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>502 Bad Gateway</html>');
        }
        if (behavior === 'biz-fail') return json(res, 200, { code: 1001, msg: '今天已经签过了' });

        // `cloudRecordV2` 走**分页 + 按今天现算**的分支（见下面 `cloudRecordsPage`）。
        if (url.pathname === '/ycloud/signin/public/cloudRecordV2') {
          const pageNumber = Number(url.searchParams.get('pageNumber') ?? '1') || 1;
          return json(res, 200, cloudRecordsPage(pageNumber));
        }

        const map = {
          '/ycloud/signin/task/taskListV3': FIXTURES.taskListV3,
          '/ycloud/signin/task/taskListV2': FIXTURES.taskListV2,
          '/ycloud/signin/page/infoV3': FIXTURES.infoV3,
          '/ycloud/signin/page/startSignIn': FIXTURES.startSignIn,
          '/ycloud/signin/page/receiveV3': FIXTURES.receiveV3,
          '/ycloud/signin/page/multiple': FIXTURES.multiple,
          '/ycloud/signin/page/receiveRevivalReward': FIXTURES.receiveRevivalReward,
          '/ycloud/signin/public/record': FIXTURES.prizeRecord,
          '/market/backupgift/info': FIXTURES.backupGiftInfo,
          '/market/backupgift/receive': FIXTURES.backupGiftReceive,
        };
        // ── 会改变状态的那几口 ──
        if (url.pathname === '/ycloud/openemailsms-service/openEmailsms/getTaskInfo') {
          // 四个字段名来自实拍：cloudStatus / sum / progress / taskStatus。
          // sum 与 progress 是**假数**（含义未证实，插件只原样搬运）。
          const cloud = st.noticeClaimable ? 1 : 2;
          return json(res, 200, {
            code: 0,
            msg: 'success',
            result: {
              taskOneInfo: { cloudStatus: cloud, sum: 10, progress: 16, taskStatus: 3 },
              taskTwoInfo: { cloudStatus: cloud, sum: 10, progress: 16, taskStatus: 3 },
            },
          });
        }
        if (url.pathname === '/ycloud/openemailsms-service/openEmailsms/reward') {
          st.noticeClaimable = false;
          // 实拍响应就是这个形状 —— 连 result 都没有，报不出到账数
          return json(res, 200, { code: 0, msg: 'success' });
        }
        if (url.pathname === '/ycloud/signin/page/exchangeList') {
          // ⚠ group 键**不连续**（实拍是 0,1,2,5,7,8,9,11,15）—— 夹具就摆成这样，
          // 谁按 0..n 遍历，这里就会漏。
          return json(res, 200, {
            code: 0,
            msg: 'success',
            result: {
              0: [
                // ⚠ 名字字段是 **`prizeName`**（2026-10-14 真机 51/51 都是它，而一件都没有 `name`）
                { prizeId: 251230053, prizeName: '云朵1个', groupId: 0, limit: 0, onLine: 1 },
                // 这一件故意用旧字段名，覆盖 `prizeName ?? name` 的回退那一条
                { prizeId: 251230054, name: '会员1天', groupId: 0, price: 500, limit: 2, onLine: 1 },
                // 月度额度用完：`limit` 说可兑（0），而 `probability2` 说本月已领满
                // ⇒ 判据必须落在更保守的那一边（不然就是"白发一笔真扣豆的请求"）
                { prizeId: 251230055, prizeName: '月度额度款', groupId: 0, limit: 0, onLine: 1,
                  probability2: '{"multi":true,"limitMonthQuantity":3}', receiveQuantity: 3 },
              ],
              2: [{ prizeId: 251230061, name: '明日再来款', groupId: 2, price: 300, limit: 1, onLine: 1 }],
              15: [
                { prizeId: 251230099, name: '已下架款', groupId: 15, price: 999, limit: 0, onLine: 0 },
                { prizeId: 251230100, name: '缺 limit 款', groupId: 15, price: 200, onLine: 1 },
              ],
            },
          });
        }
        if (url.pathname === '/ycloud/signin/task/taskListV2') {
          // 只读：按 group 给不同的矩阵。两个实拍坑都要在夹具里出现一次：
          //   · `new` 这一组回**空对象**（实拍就是 result:{}，不是 []）
          //   · 一条 `enable != 1`（旧实现的门是 enable != 1 ⇒ 跳过）
          // mock 里 `body` 是原始字符串，要自己解
          let g = 'new';
          try {
            g = JSON.parse(body || '{}').group || 'new';
          } catch {}
          if (g === 'new') {
            return json(res, 200, { code: 0, msg: 'success', result: {}, groupState: {} });
          }
          if (g === 'beiyong1') {
            return json(res, 200, {
              code: 0,
              msg: 'success',
              result: [
                { id: 106, name: '永葆童心', description: '领38云朵', groupid: 'beiyong1', state: 'FINISH', limitType: 'EVER', enable: 1, currstep: 4 },
                { id: 522, name: '备份有礼', description: '领5云朵', groupid: 'beiyong1', state: 'DOING', limitType: 'DAY', enable: 1, currstep: 2 },
              ],
              groupState: { beiyong1: { taskFinishState: 2 } },
            });
          }
          if (g === 'cloudEmail') {
            return json(res, 200, {
              code: 0,
              msg: 'success',
              result: [
                // enable != 1 ⇒ 不参与（不是"可做"）
                { id: 1021, name: '邮箱通知', groupid: 'cloudEmail', state: 'DOING', enable: 0 },
                // 驼峰 groupId（拍拍那一族的真实差异）也要认得
                { id: 2001, name: '拍拍盘点', groupId: 'cloudEmail', state: 'DOING', enable: 1 },
              ],
            });
          }
          return json(res, 200, { code: 0, msg: 'success', result: [], groupState: {} });
        }
        if (url.pathname === '/ycloud/signin/page/infoV3') {
          return json(res, 200, {
            code: 0,
            msg: 'success',
            result: {
              todaySignIn: st.todaySigned,
              cal: [{ d: 19, s: st.todaySigned, n: 3, p: 0, t: true, currentMonth: 1 }],
              receiveList: st.receiveList,
              curMonthBackup: st.curMonthBackup,
              curMonthBackupSignAccept: st.curMonthBackupSignAccept,
            },
          });
        }
        if (url.pathname === '/ycloud/signin/page/startSignIn') {
          // 上游的语义：提交之后**状态可能还没变**（真实世界里会延迟入账）。
          // 这里让它立刻变 —— 好测「回查确认」那条路径；想测"没入账"的话把
          // `st.todaySigned` 后面的赋值去掉即可。
          st.todaySigned = true;
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 10 } });
        }
        if (url.pathname === '/ycloud/signin/page/receiveV3') {
          let rid = '';
          try {
            rid = JSON.parse(body || '{}').cloudId ?? '';
          } catch {
            /* 体不是 JSON 就算了 */
          }
          st.receiveList = st.receiveList.filter((x) => x.recordId !== rid);
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 5, cloudId: rid } });
        }
        if (url.pathname === '/ycloud/signin/page/receiveTaskExpansion') {
          // 延期领取：真实客户端发的是**裸 GET**（没有 acceptDate）——
          // 这一口把 cloudType=1 的条目消化掉
          st.receiveList = st.receiveList.filter((x) => x.cloudType !== 1);
          return json(res, 200, { code: 0, msg: 'success', result: { bean: 3 } });
        }
        if (url.pathname === '/ycloud/signin/page/multiple') {
          st.curMonthBackupSignAccept = true; // 每月只用一次
          return json(res, 200, { code: 0, msg: 'success', result: { multiple: 2 } });
        }
        if (url.pathname === '/market/backupgift/receive') {
          st.backupCanReceive = false;
          return json(res, 200, { code: 0, msg: 'success', result: {} });
        }

        const hit = map[url.pathname];
        if (!hit) return json(res, 404, { code: -1, msg: `mock 没有这个端点：${url.pathname}` });
        if (url.pathname === '/market/backupgift/info') {
          return json(res, 200, { code: 0, msg: 'success', result: { canReceive: st.backupCanReceive } });
        }
        return json(res, 200, hit);
      };

      if (behavior === 'timeout' || delayMs > 0) {
        setTimeout(finish, behavior === 'timeout' ? 60_000 : delayMs);
      } else {
        finish();
      }
    });
  });

  // ── 直播弹幕那条链的 SockJS/WebSocket 端点 ────────────────────────────────
  //
  // 为什么要在这里手写一个：**Node 没有内置 WebSocket 服务端**，而本仓 e2e 的纪律是
  // 「全程只打 mock」—— 不写它，弹幕那一支就只能靠单测，e2e 里就成了"没覆盖但看起来绿"。
  //
  // 它只实现**这条链用到的那几件事**（SockJS 的 `o` / `["<b64>"]` / `a["<b64>"]`），
  // 不做 RFC6455 的全部（没有分片、没有 permessage-deflate —— 抓包 §一 判据 3 说
  // 服务端本来也不接受压缩）。
  const wsFrames = [];   // 收到的**客户端**帧（解出来的 msync 字节的 hex），给 e2e 断言用
  let wsConn = null;

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    wsConn = { socket, buf: Buffer.alloc(0), provisioned: false, danmakuSent: 0, acked: 0 };
    wsUpgradeHeaders = { ...req.headers, path: req.url };

    // SockJS：连上先发 `o`（**抓包 §二 的第 0 帧就是它**）
    wsSendText(socket, 'o');

    socket.on('data', (chunk) => {
      wsConn.buf = Buffer.concat([wsConn.buf, chunk]);
      for (;;) {
        const f = readWsFrame(wsConn.buf);
        if (f === null) break;
        wsConn.buf = f.rest;
        if (f.opcode === 0x8) {
          socket.end();
          wsConn = null;
          return;
        }
        if (f.opcode !== 0x1) continue; // 只看文本（SockJS 全是文本）
        const text = f.payload.toString('utf8');
        const msync = decodeSockjsSend(text);
        wsFrames.push({ text, command: msync?.command ?? -1, hex: msync?.hex ?? '' });
        if (msync === null) continue;
        if (msync.command === 3) {
          wsConn.provisioned = true;
          // PROVISION 的响应：`a["<b64>"]`（抓包 §二 的第 2 帧）
          wsSendText(socket, sockjsData(msyncBytes({ command: 3, msgId: null, text: null })));
        } else if (msync.command === 0) {
          wsConn.acked += 1;
        }
      }
    });
    socket.on('error', () => {
      wsConn = null;
    });
    socket.on('close', () => {
      wsConn = null;
    });
  });

  /** 推一条弹幕（`command=2`，文本在 MSync.9.2.6.4.2）。e2e 用它验"文本能解出来"。 */
  function pushDanmaku(text) {
    if (wsConn === null) return false;
    // ⚠ `msgId` 必须是**19 位数字**（抓包形状）。插件侧把它当成判据：
    //   形状不对 ⇒ 当成"没有 msgId" ⇒ **不 ack**（不许编一个）。
    //   用 `m<时间戳>` 那种短串的话，e2e 会得到"没有 ack"而看不出原因 —— 我第一版就是。
    // 19 位、**无前导零**（`1` + 13 位毫秒 + 5 位序号 = 19）。
    // ⚠ 前导零会被插件的 `encodeAck` 当场拒掉（它按"19 位十进制"校验，
    //   照抓包形状）—— 我第一版用 `padStart(19,'0')`，e2e 就在那一步拿到一个 500。
    //   这不是插件太严：msgId 的形状**本身是判据**（编不出对形状的值就不该 ack）。
    const msgId = '1' + String(Date.now()) + '06041';
    wsSendText(wsConn.socket, sockjsData(msyncBytes({ command: 2, msgId, text })));
    wsConn.danmakuSent += 1;
    return true;
  }
  let wsUpgradeHeaders = {};

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    /** 收到的请求（按时间顺序） */
    get requests() {
      return requests;
    },
    headerOf(pathSuffix, name) {
      const r = requests.find((x) => x.path?.endsWith(pathSuffix));
      return r ? (r.headers[String(name).toLowerCase()] ?? undefined) : undefined;
    },
    reset() {
      requests.length = 0;
      wsFrames.length = 0;
    },
    /** 弹幕那条链：收到的客户端帧、升级请求头、以及主动推一条弹幕的口子。 */
    ws: {
      get frames() {
        return wsFrames;
      },
      get upgradeHeaders() {
        return wsUpgradeHeaders;
      },
      get connected() {
        return wsConn !== null;
      },
      get provisioned() {
        return wsConn !== null && wsConn.provisioned;
      },
      get acked() {
        return wsConn === null ? 0 : wsConn.acked;
      },
      pushDanmaku,
    },
    setBehavior(b, ms = 0) {
      behavior = b;
      if (ms) options.delayMs = ms;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 直接运行：给手工联调用，把插件的基址指到 http://127.0.0.1:<port>
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: Number(process.argv[2] ?? 18080) });
  console.log(`mock 上游已起：${m.url}`);
  console.log(`  · 收到的请求：${m.url}/_debug/requests`);
  console.log(`  · 切换行为：  curl -X POST -d 'biz-fail' ${m.url}/_debug/behavior`);
  console.log(`    （normal / biz-fail / http-500 / not-json / timeout）`);
}
