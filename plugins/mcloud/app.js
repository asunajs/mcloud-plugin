// 界面逻辑：**只调一个读数接口**，把七个区块画出来。
//
// # 三条设计约束（与 index.html 的文件头是同一件事，这里说的是怎么落实）
//
// ① **一次调用画全部**。`/plugins/mcloud/api/readings` 一次给全七个区块的读数。
//    旧版是一个区块一个接口，于是每块各有各的加载/错误状态 —— 用户看到
//    「有的块有数、有的块空着、有的块报错」，而没人知道该看哪个。
//    现在只有两种状态：**有读数** 或者 **一次都没读到**（一个错误信息）。
//
// ② **区块第一行回答用户的问题**，不是复述接口字段。
//    「登录了吗」「今天跑了吗」「下一场几点」—— 这些是用户会问的；
//    「session.expireAt」不是。
//
// ③ **动作按钮只有一个语义**：跑一次 / 领取 / 保存。
//    没有「推进一步」—— 任务是一次跑完的（见 docs/redesign-plan.md 阶段 ②）。
//
// # 关于 `x-panel: 1`
//
// 面板的**写**接口要求这个头（防跨站请求伪造）。插件自己的路由同样适用
// （见面板的 `guard_write`）—— 所以下面每个 POST 都带它。
// 忘了的表现是 403 加一句「写接口要求请求头 x-panel: 1」，不是静默失败。

'use strict';

/** 插件自己的接口。 */
const API = '/plugins/mcloud/api';

/** 三个任务所在的插件与名字（面板的任务接口按这两段定位）。 */
const TASK = {
  daily: ['mcloud-daily', '日常'],
  exchange: ['mcloud-exchange', '兑换'],
  live: ['mcloud-live', '直播'],
};

const $ = (id) => document.getElementById(id);

/** 最近一次读数。 */
let last = null;

// ──────────────────────────────────────────────────────────── 基础

/** 调一个接口。`write` 时带 `x-panel: 1`（面板的写保护）。 */
async function call(url, { method = 'GET', body, write = false } = {}) {
  const headers = {};
  if (write) headers['x-panel'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 不是 JSON ⇒ 面板或反代在中间挡了一道（403/502 那种会回纯文本）。
    // 这时候把原文带上，否则用户只看到「失败」两个字。
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || (data && data.error)) {
    const err = new Error((data && data.error) || `${res.status} ${text.slice(0, 200)}`);
    // ⚠ 把**整个响应体**挂到错误上。
    //
    // 只抛 `message` 的话，调用方拿不到后端除 `error` 之外说的话 ——
    // 而有些接口要用别的字段驱动界面（比如 `/accounts` 的 `needPcPlatform`
    // 决定"要不要把 win/mac 那个选择露出来"）。丢掉它就只能靠字符串比对，
    // 而字符串比对会在改文案时静默失效。
    if (data && typeof data === 'object') err.data = data;
    throw err;
  }
  return data;
}

const api = (path, opts) => call(API + path, opts);

/** 跑一条任务（面板的任务接口）。 */
function runTask(key) {
  const pair = TASK[key];
  return call(
    `/api/tasks/${encodeURIComponent(pair[0])}/${encodeURIComponent(pair[1])}/run`,
    { method: 'POST', write: true },
  );
}

function toast(msg, bad) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' toast-bad' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(
    () => {
      el.hidden = true;
    },
    bad ? 9000 : 3500,
  );
}

/** 把一次动作包起来：按钮禁用 → 跑 → 提示 → 重画。
 *
 *  为什么统一包一层：旧版每个按钮各写一遍 try/catch + 提示 + 刷新，
 *  于是有的忘了刷新（点了没反应）、有的忘了提示（不知道成没成）、
 *  有的错误只 `console.log`（用户看不见）。 */
async function act(btn, fn, okMsg) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fn();
    toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await load();
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ──────────────────────────────────────────────────────────── 小工具

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把 ISO 时刻说成人话。读数是给用户看的，「2026-10-15T00:12:03.000Z」不是人话。 */
function when(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  const now = new Date();
  const hm =
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, new Date(now.getTime() - 86400000))) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

/** 建一个元素。`el('div', 'row')` —— 比到处 `createElement` + `className` 短得多。 */
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/** 调插件的**写**路由（要带 `x-panel: 1`，`call` 里已经处理了）。 */
const post = (path, body) => api(`/${path}`, { method: 'POST', body, write: true });

/** 把一段毫秒说成人话（「1 分 20 秒」而不是「80000」）。 */
function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

const setText = (id, v) => {
  const el = $(id);
  if (el) el.textContent = v === undefined || v === null ? '' : String(v);
};

/** 画一个列表：每项 `[主文案, 副文案, 右侧 HTML]`。 */
function paintList(id, rows, emptyText) {
  const ul = $(id);
  if (!ul) return;
  if (!rows || rows.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(emptyText)}</li>`;
    return;
  }
  ul.innerHTML = rows
    .map(
      (r) =>
        `<li class="item"><div class="item-main"><span class="item-t">${esc(r[0])}</span>` +
        (r[1] ? `<span class="item-s">${esc(r[1])}</span>` : '') +
        `</div>${r[2] ? `<div class="item-r">${r[2]}</div>` : ''}</li>`,
    )
    .join('');
}

// ──────────────────────────────────────────────────────────── 七个区块

/** 登录那一节。三种方式各自的状态由**路由**推，界面只负责显示与触发。 */
function renderLogin(l) {
  const qr = l.qr;
  const sms = l.sms;

  // ⚠ 这里**不再直接改 pane 的 hidden** —— 弹窗里页签的显隐由 `showAddTab` 统一管
  //   （原来改的是 `pane-qr`/`pane-sms`，那两个 id 现在不存在了）。
  //   这里的职责变成"**把页签跳到有事的那一个**"：
  if (qr) {
    if ($('add-dialog').hidden === false) showAddTab('qr');
    $('qr-box').hidden = false;
    // 二维码是**插件这一侧**渲染好的 SVG（浏览器里没有二维码库）
    $('qr-box').innerHTML = qr.svg || '';
    const sec = Math.ceil(qr.expiresInMs / 1000);
    // ⚠ 相位不同文案要不同：`scanned` 之后**该等的是手机**，不是"再扫一次"。
    setText(
      'qr-note',
      qr.scanned ? `已扫码，请在手机上确认 · 剩 ${sec} 秒` : `${qr.note} · 剩 ${sec} 秒`,
    );
  } else {
    $('qr-box').hidden = true;
    $('qr-box').innerHTML = '';
  }

  if (sms) {
    if ($('add-dialog').hidden === false) showAddTab('sms');
    const ph = $('sms-phone');
    if (ph && document.activeElement !== ph) ph.value = sms.phone;
    setText('sms-note', sms.sent ? `${sms.note} · 看短信，填 6 位码` : sms.note);
    // 滑块图只在"要过滑块"时出现 —— 它是**异常路径**（首次发码被风控拦下）
    $('slider-box').hidden = !sms.hasSlider;
    if (sms.hasSlider && sms.slider) {
      setText('slider-note', '移动云盘要滑块：下面这张图已经解出缺口位置，点「发验证码」会带着答案发。');
      $('slider-bg').src = `data:image/jpeg;base64,${sms.slider.backgroundB64}`;
    }
  } else {
    $('slider-box').hidden = true;
  }

  // 手机端那一格（形状与 `sms` 一样，见 `loginReading` 里那段说明）
  const app = l.app;
  if (app) {
    if ($('add-dialog').hidden === false) showAddTab('app');
    const ph = $('app-phone');
    if (ph && document.activeElement !== ph) ph.value = app.phone;
    setText('app-note', app.sent ? `${app.note} · 看短信，填 6 位码` : app.note);
    $('app-slider-box').hidden = !app.hasSlider;
    if (app.hasSlider && app.slider) {
      setText('app-slider-note', '移动云盘要滑块：下面这张图已经解出缺口位置，点「发验证码」会带着答案发。');
      $('app-slider-bg').src = `data:image/jpeg;base64,${app.slider.backgroundB64}`;
    }
  } else {
    $('app-slider-box').hidden = true;
  }
}

function renderAccount(a, login) {
  const chip = $('acct-chip');
  const list = a.accounts || [];
  const n = list.length;

  if (n === 0) {
    setText('acct-hero', '还没登录');
    setText('acct-sub', '登录之后才能签到、领豆、领小红花。');
    chip.textContent = '还没登录';
    chip.className = 'chip chip-idle';
  } else {
    const cur = list.find((x) => x.current) || list[0];
    setText('acct-hero', `已登录 ${cur.label || cur.masked}`);
    setText('acct-sub', n > 1 ? `一共 ${n} 个账号，任务会挨个跑。` : '任务会用这个账号跑。');
    chip.textContent = n > 1 ? `${n} 个账号` : cur.label || cur.masked;
    chip.className = 'chip chip-ok';
  }

  // 会话体检。这一条回答「我的登录还有效吗」—— 票过期时**所有**任务一起失败，
  // 而那个现象看起来像「账号被踢了」，其实是票到期。
  const ses = a.session || {};
  if (n > 0 && ses.note) setText('acct-sub', ses.note);

  // 账号卡 —— 照 mcloud：昵称 + 平台徽章 + `设备 … · 凭据 N 天后` + 五个动作。
  //
  // ⚠ 用 `innerHTML` 直接搭（原来是 `paintList` 的三列网格，形状对不上卡片）。
  const box = $('acct-list');
  box.innerHTML =
    n === 0
      ? '<li class="hint">还没有账号。点右上角「添加账号」。</li>'
      : list
          .map((x) => {
            // 平台徽章：手机端 / macOS / Windows。认不出就**如实说**，不猜。
            const badge =
              x.platform === 'mobile'
                ? '<span class="badge">手机端</span>'
                : x.platform === 'pc'
                  ? `<span class="badge badge-pc">${x.pcPlatform === 'mac' ? 'macOS' : 'Windows'}</span>`
                  : '<span class="badge">平台未知</span>';
            // `凭据 N 天后`：`null` 是"这条凭据里没带到期时间"，**不能画成 0**
            //（那看起来像"已过期"，用户会去重新登录一个本来好好的账号）。
            const exp =
              x.expireDays === null
                ? '凭据到期时间未知'
                : x.expireDays >= 0
                  ? `凭据 ${x.expireDays} 天后`
                  : `凭据已过期 ${-x.expireDays} 天`;
            const dev = x.deviceId ? `设备 ${x.deviceId} · ` : '';
            return `
              <li class="acct-card${x.current ? ' is-current' : ''}">
                <div class="acct-main">
                  <div class="acct-title${x.disabled ? ' is-off' : ''}">
                    ${esc(x.label || x.masked)}${badge}${x.current ? '<span class="tag tag-on">正在用</span>' : ''}${x.disabled ? '<span class="tag">已停用</span>' : ''}
                  </div>
                  <div class="acct-sub">${dev}${exp}</div>
                </div>
                <div class="acct-acts">
                  ${x.current ? '' : `<button class="btn btn-sm" data-acc-select="${esc(x.id)}">切到这个</button>`}
                  <button class="btn btn-sm" data-acc-refresh="${esc(x.id)}">刷新</button>
                  <button class="btn btn-sm" data-acc-rename="${esc(x.id)}">编辑</button>
                  <button class="btn btn-sm" data-acc-settings="${esc(x.id)}">设置</button>
                  <button class="btn btn-sm" data-acc-disable="${esc(x.id)}" data-on="${x.disabled ? '1' : ''}">${x.disabled ? '启用' : '停用'}</button>
                  <button class="btn btn-sm btn-danger" data-acc-del="${esc(x.id)}">移除</button>
                </div>
              </li>`;
          })
          .join('');

  // 本机设备指纹：**只读显示**（它不是用户填的东西 —— 见 index.html 那段说明）。
  setText('device-id-show', login.deviceId || '（还没生成）');

  // ⚠ 这几行原来往 `login-note` 写"扫码/短信/账密都能用…" —— 那个 id 现在是
  //   弹窗里扫码页签的提示，写法也不对了（贴的是**凭据**不是"会话串"）。删掉。
  renderLogin(login || { qr: null, sms: null });
}

function renderDaily(d) {
  renderRecent('daily-recent', 'daily-steps', d.recent);
  const run = d.last;
  if (!run) {
    setText('daily-hero', '还没跑过');
    setText('daily-sub', '点下面的按钮跑一次。之后它自己在白天每 30 分钟跑一次。');
  } else if (d.doneToday) {
    setText('daily-hero', '今天已完成');
    setText('daily-sub', run.note);
  } else if (run.ok) {
    setText('daily-hero', '今天还没跑完');
    setText('daily-sub', run.note);
  } else {
    setText('daily-hero', '上次有失败');
    setText('daily-sub', run.note);
  }

  setText('daily-when', '点「看」展开某一次的每一步。');
  // ⚠ 这里**不再**直接画 `daily-steps` —— 那个容器现在归「最近几次」的详情面板
  //   （`renderRecent` 管它，默认展开最近一次）。两处都画就会叠两层，
  //   而第一版就是这样：列表下面又冒出一份一模一样的步骤。
}

function renderExchange(e) {
  renderRecent('ex-recent', 'ex-steps', e.recent);
  setText('ex-hero', e.plan ? `要换：${e.plan}` : '还没设兑换目标');
  // 第二行回答"现在是什么状态" —— 抢兑这条链大部分时间在**等**，
  // 而"界面不动"和"卡住了"看起来一模一样，所以要说出来。
  const t = e.timing || {};
  const bits = [];
  if (e.orderedThisHour) bits.push('这一场已经试过了');
  else if (t.inWindow) bits.push('正在抢兑窗口里');
  else if (e.toTargetMs > 0) bits.push(`离这一场还有 ${fmtMs(e.toTargetMs)}`);
  bits.push(e.targetHour === null ? '每小时都试' : `每天 ${e.targetHour} 点`);
  bits.push(`压整点前 ${e.leadMs ?? 10}ms 发`);
  setText('ex-sub', e.plan ? bits.join(' · ') : '设一个之后它才会去下单。');
  // 两个输入框回填当前值（**它们不是秘密**，可以回填）
  const hourEl = $('ex-hour');
  if (hourEl && document.activeElement !== hourEl) {
    hourEl.value = e.targetHour === null ? '' : String(e.targetHour);
  }
  const leadEl = $('ex-lead');
  if (leadEl && document.activeElement !== leadEl) leadEl.value = String(e.leadMs ?? 10);

  const plan = $('ex-plan');
  if (plan && document.activeElement !== plan) plan.value = e.plan || '';

  const r = e.reading;
  setText('ex-note', r ? e.verdictText || '' : '还没有清单读数 —— 点「现在试一次」去读一次。');

  const rows = (r && r.prizes) || [];
  const tbl = $('ex-tbl');
  if (!rows.length) {
    tbl.innerHTML = '<tr><td class="empty">还没有清单读数。</td></tr>';
  } else {
    tbl.innerHTML =
      '<tr><th>奖品</th><th>要多少豆</th><th>还剩</th><th>能不能换</th></tr>' +
      rows
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td>${esc(p.price)}</td><td>${esc(p.stock)}</td>` +
            `<td>${esc(p.verdict || '')}</td></tr>`,
        )
        .join('');
  }
}

function renderLive(l) {
  renderRecent('live-recent', 'live-steps', l.recent);
  const pool = l.pool || {};
  const codes = (l.codes || []).filter((c) => c && c.code);
  const valid = pool.validCount || 0;

  setText('live-hero', valid > 0 ? `口令池里有 ${valid} 条能用` : '口令池是空的');
  const bits = [];
  if (pool.nextStart) bits.push(`下一场 ${pool.nextStart}`);
  if (l.auto && l.auto.wakeAt) bits.push(`下一次自动听 ${when(l.auto.wakeAt)}`);
  if (l.listen && l.listen.line) bits.push(l.listen.line);
  setText('live-sub', bits.join(' · ') || '没有日程 —— 等它探到下一场。');

  // 领小红花的结论（四栏 + 进账）。这是「直播」这一块第二重要的读数 ——
  // 它回答「上一轮到底领到没有、没领到是为什么」。
  const draw = l.draw || {};
  const rep = draw.report;
  if (rep) {
    const bits2 = [];
    if (rep.expired.length > 0) bits2.push(`${rep.expired.length} 条本场已结束（不是口令抄错）`);
    if (rep.invalid.length > 0) bits2.push(`${rep.invalid.length} 条口令无效`);
    if (rep.alreadyDrawn.length > 0) bits2.push(`${rep.alreadyDrawn.length} 条这个账号已经领过`);
    if (rep.other.length + rep.unparsable.length > 0) {
      bits2.push(`${rep.other.length + rep.unparsable.length} 条回了没见过的结果`);
    }
    setText('live-pool-line', rep.line + (bits2.length > 0 ? ' · ' + bits2.join(' · ') : ''));
  } else {
    setText('live-pool-line', draw.line || pool.line || pool.note || '');
  }
  paintList(
    'live-codes',
    codes.map((c) => [
      c.code,
      `${c.source || ''}${c.state ? ` · ${c.state}` : ''}${c.reason ? ` · ${c.reason}` : ''}`,
      c.kind ? `<span class="tag">${esc(c.kind)}</span>` : '',
    ]),
    '还没有口令。从直播弹幕里抄一条贴在上面。',
  );
}

function renderData(d) {
  const m = d.matrix || {};
  setText('data-hero', `读了 ${m.read || 0}/${m.total || 0} 个市场`);
  setText('data-sub', '纯读数 —— 这一页没有任何动作。');
  setText('matrix-line', (m.read || 0) === 0 ? '还没有读数（日常跑一次就有了）。' : '');
  paintList(
    'matrix-list',
    (m.groups || []).map((g) => {
      const r = g.reading;
      return [
        g.group,
        r ? `已完成 ${r.done} · 可做 ${r.todo} · 不参与 ${r.skip} · ${when(r.at)}` : '还没读到',
        '',
      ];
    }),
    '还没有矩阵读数。',
  );
  setText('caps-line', d.caps || '');
}

// ── 运行记录（三块共用） ──
//
// # 为什么是「一次运行一行」而不是「一条日志一行」
//
// 面板的环形日志混着所有插件、而且只有 200 行 —— 用它回答
// 「昨天那次兑换为什么没成」是做不到的。所以插件自己记：
// **一次运行 = 一行**，点开才看那一次的步骤。
//
// 列表只给**摘要**（成功几步 / 失败几步 / 没做事几步），步骤按需再取 ——
// 20 次 × 40 步全塞进一次读数就是几百 KB 的 JSON，而这是 iframe 里的页面。

/** 画一个任务的「最近几次」。`boxId` / `stepsId` 是那一块的容器。
 *
 *  ⚠ **最近一次默认展开**。全折起来虽然"干净"，但页面一打开什么都没有 ——
 *  用户得先点一下才知道跑成什么样，而"要点哪个"正是这一版要解决的问题。 */
function renderRecent(boxId, stepsId, recent) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = '';
  const list = recent || [];
  if (list.length === 0) {
    const empty = el('p', 'hint');
    empty.textContent = '还没跑过。';
    box.appendChild(empty);
    const ul = $(stepsId);
    if (ul) ul.innerHTML = '';
    return;
  }

  list.forEach((r, i) => {
    const row = el('div', 'row' + (r.ok ? ' is-on' : ''));
    const name = el('span', 'row-name');
    name.textContent = when(r.at);
    row.appendChild(name);

    const state = el('span', 'row-state');
    // 「几步失败 · 几步成了 · 几步没做事」—— 失败那一栏只在真有失败时出现，
    // 否则每行都挂着「0 步失败」，看着像在报警
    const bits = [];
    if (r.badCount > 0) bits.push(`${r.badCount} 失败`);
    if (r.okCount > 0) bits.push(`${r.okCount} 成了`);
    if (r.idleCount > 0) bits.push(`${r.idleCount} 跳过`);
    state.textContent = bits.join(' · ') || '没有步骤';
    row.appendChild(state);

    const dur = el('span', 'row-dur');
    dur.textContent = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`;
    row.appendChild(dur);

    const btn = el('button', 'btn btn-sm btn-ghost');
    btn.type = 'button';
    btn.textContent = i === 0 ? '收起' : '看';
    btn.addEventListener('click', () => {
      const ul = $(stepsId);
      const open = ul && ul.dataset.run === r.id;
      // 再点一次 = 收起
      if (open) {
        ul.innerHTML = '';
        delete ul.dataset.run;
        btn.textContent = '看';
        return;
      }
      btn.textContent = '收起';
      loadRunDetail(stepsId, r.id);
    });
    row.appendChild(btn);
    box.appendChild(row);

    // 摘要那一句也显示出来（它才是"成没成"的答案）
    const note = el('div', 'row-note');
    note.textContent = r.note + (r.truncated ? '（步骤太多，只留了前面一部分）' : '');
    box.appendChild(note);
  });

  // 默认展开最近一次
  loadRunDetail(stepsId, list[0].id);
}

/** 取某一次运行的步骤并画出来。
 *
 *  ⚠ 取不到（记录已经被新记录挤掉）时说清是**过期**，不是"出错了" ——
 *  运行记录只留最近 N 次，用户手上那个 id 确实可能已经没了。 */
async function loadRunDetail(stepsId, id) {
  const ul = $(stepsId);
  if (!ul) return;
  ul.innerHTML = '';
  // 记下现在展开的是哪一次 —— 按钮靠它判断"再点一次是收起"
  ul.dataset.run = id;
  try {
    const r = await api(`/runs?id=${encodeURIComponent(id)}`);
    for (const s of r.steps || []) {
      const li = el('li', s.ok ? (s.idle ? 'is-idle' : 'is-ok') : 'is-bad');
      const n = el('span', 'step-name');
      n.textContent = s.name;
      const t = el('span', 'step-note');
      t.textContent = s.note;
      li.appendChild(n);
      li.appendChild(t);
      ul.appendChild(li);
    }
    if ((r.steps || []).length === 0) {
      const li = el('li', 'is-idle');
      li.textContent = '这一次没有步骤';
      ul.appendChild(li);
    }
  } catch (e) {
    const li = el('li', 'is-idle');
    li.textContent = `这一次的记录已经过期了（只留最近几次）：${e.message}`;
    ul.appendChild(li);
  }
}

// ── 推送 ──
//
// # 界面的取舍
//
// 10 个渠道 × 每个 1~5 个字段 = 三十几个输入框。**全铺出来就是"文字一大堆"**，
// 而那正是这一版要解决的问题。所以：
//
//   · 渠道**一行一个**，只显示「配了 / 没配」+ 一个按钮
//   · 点「填」才展开**那一个**渠道的字段（同时只展开一个）
//   · 绑定默认"全部渠道"，用户不碰也能用
//
// 配好的渠道显示**掩码**（`abc…yz（共 32 字符）`）—— 值本身从不上屏。

/** 每个渠道要填的字段。`secret` 的会按口令框显示。 */
const PUSH_FIELDS = {
  pushplus: [['token', 'token', true]],
  serverChan: [['token', 'SendKey', true]],
  workWeixin: [
    ['corpid', 'corpid', false],
    ['corpsecret', 'corpsecret', true],
    ['agentid', 'agentid（数字）', false],
  ],
  workWeixinBot: [['url', '群机器人 webhook 地址', false]],
  tgBot: [
    ['token', 'bot token', true],
    ['chat_id', 'chat_id（群 ID 是负数）', false],
  ],
  bark: [['key', 'key', true]],
  twoIm: [
    ['key', 'key', true],
    ['sid', 'sid', true],
  ],
  dingTalk: [
    ['token', 'access_token', true],
    ['secret', '加签密钥（有就填）', true],
  ],
  email: [
    ['host', 'SMTP 主机', false],
    ['from', '发件人', false],
    ['pass', '密码', true],
    ['to', '收件人', false],
    ['port', '端口（不给按 587 / 465 推）', false],
  ],
  customPost: [['url', '请求地址', false]],
};

/** 当前展开的是哪个渠道（同时只展开一个）。 */
let pushEditing = '';

function renderPush(p) {
  const chans = (p && p.channels) || [];
  const configured = (p && p.configured) || [];
  const fields = (p && p.fields) || {};

  if (chans.length === 0) {
    setText('push-hero', '还没做');
    setText('push-sub', '推送在阶段 ⑤。');
    return;
  }

  // 第一行回答"配了没有" —— 这是这一块唯一必须一眼看到的事
  setText('push-hero', configured.length === 0 ? '还没配推送' : `配了 ${configured.length} 个渠道`);
  setText(
    'push-sub',
    configured.length === 0
      ? '配一个渠道，任务跑完就会给你发一条。'
      : configured.map((c) => CH_LABEL(c)).join(' · '),
  );

  const box = $('push-channels');
  if (!box) return;
  box.innerHTML = '';
  for (const ch of chans) {
    const on = configured.includes(ch.id);
    const row = el('div', 'row' + (on ? ' is-on' : ''));

    const name = el('span', 'row-name');
    name.textContent = CH_LABEL(ch.id);
    row.appendChild(name);

    const state = el('span', 'row-state');
    state.textContent = on ? '已配' : '';
    row.appendChild(state);

    const btn = el('button', 'btn btn-sm' + (on ? ' btn-ghost' : ''));
    btn.type = 'button';
    btn.textContent = on ? '改' : '填';
    btn.addEventListener('click', () => {
      pushEditing = pushEditing === ch.id ? '' : ch.id;
      renderPush(last.push);
    });
    row.appendChild(btn);
    box.appendChild(row);

    if (on && fields[ch.id]) {
      const hint = el('div', 'row-note');
      hint.textContent = Object.entries(fields[ch.id])
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
      box.appendChild(hint);
    }

    // 展开：**只这一个**渠道的字段
    if (pushEditing === ch.id) {
      const form = el('div', 'form');
      const inputs = {};
      for (const [key, label, secret] of PUSH_FIELDS[ch.id] || []) {
        const lab = el('label', 'field');
        const span = el('span');
        span.textContent = label;
        const input = document.createElement('input');
        input.type = secret ? 'password' : 'text';
        input.autocomplete = 'off';
        input.placeholder = label;
        // 已配的字段**不回填值**（值在服务端存着，界面拿不到也不该拿）——
        // 留空 = 不改这一项
        lab.appendChild(span);
        lab.appendChild(input);
        form.appendChild(lab);
        inputs[key] = input;
      }
      const note = el('p', 'hint');
      note.textContent = '已经填过的项留空 = 不改。';
      form.appendChild(note);

      const save = el('button', 'btn');
      save.type = 'button';
      save.textContent = '保存';
      save.addEventListener('click', () => {
        // ⚠ 只发**这一个渠道的改动**（`{set, remove}` 形状）——
        //   界面拿不到已存的值（读数里只有掩码），所以没法整份发回去。
        const one = {};
        for (const [key, input] of Object.entries(inputs)) {
          const v = input.value.trim();
          if (v === '') continue; // 留空 = 不改这一项
          one[key] = key === 'agentid' || key === 'port' ? Number(v) : v;
        }
        if (Object.keys(one).length === 0) {
          toast('一项都没填', true);
          return;
        }
        act('push-config', () => post('push/config', { set: { [ch.id]: one } }), '推送配置已保存');
      });
      form.appendChild(save);

      if (on) {
        const del = el('button', 'btn btn-ghost');
        del.type = 'button';
        del.textContent = '不用这个';
        del.addEventListener('click', () => {
          act('push-config', () => post('push/config', { remove: [ch.id] }), '已去掉这个渠道');
        });
        form.appendChild(del);
      }
      box.appendChild(form);
    }
  }

  // ── 绑定：三行下拉 ──
  const bbox = $('push-bindings');
  if (bbox) {
    bbox.innerHTML = '';
    const rules = (p && p.rules) || [];
    const bindings = (p && p.bindings) || {};
    for (const [key, label] of [['daily', '日常'], ['exchange', '兑换'], ['live', '直播']]) {
      const row = el('div', 'row');
      const name = el('span', 'row-name');
      name.textContent = label;
      row.appendChild(name);
      const sel = document.createElement('select');
      sel.className = 'select';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '不发';
      sel.appendChild(none);
      for (const r of rules) {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.name;
        sel.appendChild(o);
      }
      sel.value = bindings[key] || '';
      sel.addEventListener('change', () => {
        const next = { ...bindings, [key]: sel.value };
        act('push-bindings', () => post('push/bindings', next), '绑定已保存');
      });
      row.appendChild(sel);
      bbox.appendChild(row);
    }
  }

  // ── 规则列表 ──
  const rbox = $('push-rules');
  if (rbox) {
    rbox.innerHTML = '';
    const rules = (p && p.rules) || [];
    if (rules.length === 0) {
      const empty = el('p', 'hint');
      empty.textContent = '还没有规则。加一条，然后在上面给任务选上。';
      rbox.appendChild(empty);
    }
    for (const r of rules) {
      const row = el('div', 'row');
      const name = el('span', 'row-name');
      name.textContent = r.name;
      row.appendChild(name);
      const state = el('span', 'row-state');
      const n = (r.channels || []).length;
      state.textContent =
        (n === 0 ? '全部渠道' : `${n} 个渠道`) +
        (r.minLevel === 'error' ? ' · 只在有失败时' : '');
      row.appendChild(state);
      const del = el('button', 'btn btn-sm btn-ghost');
      del.type = 'button';
      del.textContent = '删';
      del.addEventListener('click', () => {
        const next = rules.filter((x) => x.id !== r.id);
        act('push-rules', () => post('push/rules', next), '规则已删除');
      });
      row.appendChild(del);
      rbox.appendChild(row);
    }
  }
}

/** 渠道 id → 界面上的名字（**与 pushConfig.ts 的 CHANNEL_LABELS 一致**）。 */
function CH_LABEL(id) {
  return (
    {
      pushplus: 'pushplus',
      serverChan: 'Server酱',
      workWeixin: '企业微信',
      workWeixinBot: '企业微信机器人',
      tgBot: 'Telegram',
      bark: 'Bark',
      twoIm: '回逍',
      dingTalk: '钉钉',
      email: '邮件',
      customPost: '自定义',
    }[id] || id
  );
}

// ⚠ 这里**故意没有**"整份配置的缓存"：界面拿不到已存的值（只有掩码），
//   所以保存走的是 `{set, remove}` 增量形状。曾经想缓存一份再整份发回去，
//   但那要么要求界面持有秘密、要么在保存时把别的渠道**清空**。

function renderSettings(s) {
  const fill = (id, v) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = v === undefined || v === null ? '' : v;
  };
  fill('cfg-baseUrl', s.baseUrl);
  fill('cfg-liveUrl', s.liveUrl === s.liveUrlDefault ? '' : s.liveUrl);
  fill('cfg-gateBase', s.gateBase);
  fill('cfg-wsBase', s.wsBase);
  fill('cfg-imBase', s.imBase);
  // ⚠ 这三格搬去账号卡片的「设置」弹窗了（它们按账号，见 index.html 那段说明）。
  fill('cfg-loginBase', s.loginBase);
  const plat = $('cfg-loginPlatform');
  if (plat && document.activeElement !== plat && s.loginPlatform) plat.value = s.loginPlatform;
}

function render(r) {
  renderAccount(r.account || {}, r.login || {});
  renderDaily(r.daily || {});
  renderExchange(r.exchange || {});
  renderLive(r.live || {});
  renderData(r.data || {});
  renderPush(r.push || {});
  renderSettings(r.settings || {});
}

// ──────────────────────────────────────────────────────────── 加载

async function load() {
  try {
    last = await api('/readings');
    render(last);
  } catch (e) {
    // 读不到 = 界面全是空的。这时候必须**说出来**，否则用户看到的是
    // 「插件坏了」而不是「没读到」。
    toast(`读数没取到：${e.message}`, true);
  }
}

// ──────────────────────────────────────────────────────────── 区块切换

/** 切到某个区块（顶部菜单与账号页工具栏共用）。
 *
 *  ⚠ 提取出来的理由：工具栏那三个按钮（账号配置 / 上游状态）要跳到别的区块，
 *  而原来这套逻辑**内联在菜单的事件处理里** —— 复用只能靠复制一份，
 *  复制的那份迟早和菜单不一致。 */
function showBlock(name) {
  for (const b of document.querySelectorAll('.menu-item')) {
    b.classList.toggle('is-on', b.dataset.block === name);
  }
  for (const s of document.querySelectorAll('.block')) {
    s.classList.toggle('is-on', s.id === 'block-' + name);
  }
}

$('menu').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.menu-item');
  if (!btn) return;
  showBlock(btn.dataset.block);
});

// ──────────────────────────────────────────────────────────── 按钮

$('refresh').addEventListener('click', (e) => act(e.currentTarget, load, '已刷新'));

// 账号：三种登录
//  ⚠ 推进的触发者是**用户点按钮**（状态机是用户本人：出码 → 用户扫 → 用户确认）。
// ══════════ 添加账号弹窗（复刻 mcloud） ══════════
//
// 参考实现：五个页签 + **客户端形态在最上面**（对全部页签生效）。
// 这里那个"选中的形态"是**弹窗级**状态：扫码/短信/账密/凭据四种方式都按它来。
let addTabNow = 'qr';
/** 弹窗里选的平台。⚠ 只对 PC 端有意义 —— 手机端（App）不存在 win/mac 之分。 */
let addPc = 'win';

function paintAddPc() {
  $('add-win').classList.toggle('is-on', addPc === 'win');
  $('add-mac').classList.toggle('is-on', addPc === 'mac');
  // 手机端那一路用 App 自己的身份，选形态没有意义 ⇒ 如实说明而不是假装有用
  const appPane = $('add-dialog').querySelector('[data-pane="app"]');
  if (appPane) {
    appPane.querySelectorAll('.row').forEach((r) => r.classList.toggle('is-muted', false));
  }
}

function showAddTab(name) {
  addTabNow = name;
  for (const b of $('add-tabs').querySelectorAll('.tab')) {
    b.classList.toggle('is-on', b.dataset.tab === name);
  }
  for (const pane of $('add-dialog').querySelectorAll('[data-pane]')) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

$('acct-add').addEventListener('click', () => {
  $('add-dialog').hidden = false;
  showAddTab(addTabNow);
  paintAddPc();
});
$('add-close').addEventListener('click', () => {
  stopQrPoll();
  $('add-dialog').hidden = true;
});
// 点遮罩关闭（点盒子里面不关）
$('add-dialog').addEventListener('click', (ev) => {
  if (ev.target === $('add-dialog')) $('add-dialog').hidden = true;
});
$('add-tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('.tab');
  if (!b) return;
  // 换页签要把上一路"进行中"的会话清掉（否则两边同时进行，界面不知道显示哪个）
  stopQrPoll();
  void api('/login/cancel', { method: 'POST', write: true }).catch(() => undefined);
  showAddTab(b.dataset.tab);
});
$('add-win').addEventListener('click', () => {
  addPc = 'win';
  paintAddPc();
});
$('add-mac').addEventListener('click', () => {
  addPc = 'mac';
  paintAddPc();
});

// 工具栏里除「上游状态」外的三个（那两个是复刻的，先如实接上已有的能力）
$('acct-upstream').addEventListener('click', () => showBlock('data'));
$('acct-config').addEventListener('click', () => showBlock('settings'));
$('acct-refresh-all').addEventListener('click', (e) =>
  act(e.currentTarget, () => api('/auth/refresh', { method: 'POST', write: true }), (r) => r.note || '已刷新'),
);

// ══════════ 每账号设置（复刻 mcloud 的「设置」） ══════════
//
// ⚠ 这两个字段（听窗口长度 / 只听这间房）**是按账号的键**，而它们原来挂在
//   **全局**的设置区块里 —— 也就是说"改了哪个账号"取决于当前选中，而界面
//   一个字都不说。用户看到的现象会是"我明明改了，怎么另一个号也跟着变了"。
//   搬到这里之后，"改的是哪一条"由**打开弹窗时点的那条**决定，不再靠猜。
let acctSettingsId = '';

function openAcctSettings(id) {
  const list = (last && last.account && last.account.accounts) || [];
  const a = list.find((x) => x.id === id);
  if (!a) return;
  acctSettingsId = id;
  setText('acct-cfg-title', a.label || a.masked || id);
  $('acct-cfg-seconds').value = Number.isFinite(a.listenSeconds) ? String(a.listenSeconds) : '';
  $('acct-cfg-room').value = Number.isFinite(a.listenRoom) && a.listenRoom > 0 ? String(a.listenRoom) : '';
  $('acct-cfg-heartbeat').value = a.wsHeartbeat || '';
  setText('acct-cfg-note', '');
  $('acct-cfg-dialog').hidden = false;
}

$('acct-cfg-close').addEventListener('click', () => {
  $('acct-cfg-dialog').hidden = true;
});
$('acct-cfg-dialog').addEventListener('click', (ev) => {
  if (ev.target === $('acct-cfg-dialog')) $('acct-cfg-dialog').hidden = true;
});
$('acct-cfg-save').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const secs = $('acct-cfg-seconds').value.trim();
      const room = $('acct-cfg-room').value.trim();
      const body = { op: 'set-settings', id: acctSettingsId };
      // 空串 = **这一项不改**（不是"设成 0"）—— 留空就是"保持原样"。
      if (secs !== '') body.listenSeconds = Number(secs);
      if (room !== '') body.listenRoom = Number(room);
      body.wsHeartbeat = $('acct-cfg-heartbeat').value.trim();
      const r = await api('/accounts', { method: 'POST', write: true, body });
      $('acct-cfg-dialog').hidden = true;
      return r;
    },
    (r) => r.note || '设置已存下',
  ),
);

// ══════════ 扫码：自动轮询（**没有**"我扫完了"按钮） ══════════
//
// 参考实现：出码 → `setInterval(pollOnce, 服务端给的 poll_interval_ms)` →
// `scanned` 时显示「已扫码，请在手机上确认」（确认动作在**手机上**）→
// `logged_in` 时收尾。所以推进的触发者是**轮询**，不是用户点按钮。
let qrTimer = null;

function stopQrPoll() {
  if (qrTimer !== null) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
}

function startQrPoll(ms) {
  stopQrPoll();
  qrTimer = setInterval(() => void qrPollOnce(), ms);
}

async function qrPollOnce() {
  try {
    const r = await api('/login/qr/poll', { method: 'POST', write: true });
    if (r.note) setText('qr-note', r.note);
    // ⚠ 只有 `stop` 才停。「还没扫到」是轮询期间**绝大多数**的响应，不是错误。
    if (r.stop) {
      stopQrPoll();
      if (r.ok && !r.account && r.note === undefined) return;
      if (r.ok) {
        toast('登录成功');
        $('add-dialog').hidden = true;
      } else {
        toast(r.note || '扫码登录失败', true);
      }
      await load();
    }
  } catch (err) {
    stopQrPoll();
    toast(err.message || '轮询失败', true);
  }
}

$('login-qr').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      // 换方式要把另一种的会话清掉（否则两边同时"进行中"，界面不知道该显示哪个）
      await api('/login/cancel', { method: 'POST', write: true });
      const r = await api('/login/qr/start', { method: 'POST', write: true });
      // 出码是纯本地拼接（不发上游），所以立刻把码画出来
      // ⚠ 弹窗里页签的显隐统一由 `showAddTab` 管（原来这里是直接改
      //   `pane-qr/pane-sms/pane-pwd` 的 `hidden` —— 那三个 id 现在不存在了）。
      showAddTab('qr');
      $('qr-box').innerHTML = r.svg || '';
      setText('qr-note', r.note);
      return r;
    },
    '出码了 —— 用手机 App 扫',
  ),
);

$('sms-start').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/login/sms/start', {
        method: 'POST',
        write: true,
        body: { phone: $('sms-phone').value.trim() },
      }),
    '手机号记下了 —— 点「发验证码」',
  ),
);

$('sms-send').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const r = await api('/login/sms/send', { method: 'POST', write: true });
      if (r.sent) return r;
      if (r.needSlider) {
        // 被风控拦下 ⇒ 去取图。**缺口坐标是解出来的**，不用人眼量像素。
        const p = await api('/login/sms/slider', { method: 'POST', write: true });
        if (!p.ok) throw new Error(p.note || '取滑块失败');
        $('slider-box').hidden = false;
        setText('slider-note', p.note);
        $('slider-bg').src = `data:image/jpeg;base64,${p.background}`;
        return p;
      }
      throw new Error(r.note || '发码没成');
    },
    (r) => (r && r.needSlider ? '移动云盘要滑块 —— 图已取到，再点一次「发验证码」' : '验证码已发出'),
  ),
);

$('sms-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const r = await api('/login/sms/submit', {
        method: 'POST',
        write: true,
        body: { code: $('sms-code').value.trim() },
      });
      if (r.account) {
        $('sms-code').value = '';
        toast(`登录成功：${r.account.label}`);
        return r;
      }
      throw new Error(r.note || '登录没成');
    },
    '登录成功',
  ),
);

$('paste-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const raw = $('paste-body').value.trim();
      if (!raw) throw new Error('先把凭据贴进来');
      const body = { op: 'add', auth: raw };
      // PC 端才带上形态（手机端带了后端也会丢掉）
      // ⚠ 平台是**弹窗级**的（参考实现把它放在最上面，对全部页签生效）——
      //   所以这里不再看"凭据那一栏有没有露出形态选择"，直接带上。
      //   ⚠ 手机端（App）不存在 win/mac 之分，后端会按凭据里的前缀丢掉它。
      body.pcPlatform = addPc;
      let r;
      try {
        r = await api('/accounts', { method: 'POST', write: true, body });
      } catch (err) {
        // ⚠ 形态选择现在是**弹窗级**的（最上面那一排），所以这里的
        //   `needPcPlatform` 不再是"把选择露出来"，而是**提示用户去上面选**。
        if (err && err.data && err.data.needPcPlatform) {
          $('paste-note').textContent =
            '这条是 PC 端 —— 去上面「客户端形态」选一种（Windows / macOS），再点一次「存下」';
          return { ok: true, note: '先去上面选形态' };
        }
        throw err;
      }
      $('paste-body').value = '';
      $('paste-note').textContent = '';
      $('add-dialog').hidden = true;
      return r;
    },
    '凭据已存下',
  ),
);

// ────────── 手机端（App 链路）──────────
//
// ⚠ 这一路的滑块与 PC **不是同一件事**（参考实现的注释）：
//   两端 `NeedSlider` 名字一样，但 PC 是"取图 → 本地识别 → 重发"，
//   而 App 真机是"开 WebView，短信由那个 H5 发"。
//   我们这边两端都走"取图自己解"（参考实现的 App 那条也是），但**成功载荷的
//   形状不同**：App 的 `data` 是密文字符串、要用**另一把钥匙**解。
//   所以这里是三条独立的路由，不是把 PC 那套换个头。

$('app-start').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/login/app/start', {
        method: 'POST',
        write: true,
        body: { phone: $('app-phone').value.trim() },
      }),
    (r) => r.note || '手机号记下了',
  ),
);

$('app-send').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const r = await api('/login/app/send', { method: 'POST', write: true });
      if (r.sent) return r;
      if (r.needSlider) {
        // 被风控拦下 ⇒ 去取题面。**缺口坐标是解出来的**，不用人眼量像素。
        const p = await api('/login/app/slider', { method: 'POST', write: true });
        if (!p.ok) throw new Error(p.note || '取题面失败');
        $('app-slider-box').hidden = false;
        setText('app-slider-note', p.note);
        $('app-slider-bg').src = `data:image/jpeg;base64,${p.background}`;
        return p;
      }
      throw new Error(r.note || '发码没成');
    },
    (r) => (r && r.needSlider ? '移动云盘要滑块 —— 题面已取到，再点一次「发验证码」' : '验证码已发出'),
  ),
);

$('app-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/login/app/submit', {
        method: 'POST',
        write: true,
        body: { code: $('app-code').value.trim() },
      }),
    (r) => r.note || '登录成功',
  ),
);

// ────────── 补回被误删的四个处理器（切片时把它们一起切掉了）──────────

$('qr-cancel').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      // ⚠ 轮询必须**先停** —— 否则取消之后还在轮，界面会一边"已取消"一边被旧会话改掉。
      stopQrPoll();
      const r = await api('/login/cancel', { method: 'POST', write: true });
      $('qr-box').innerHTML = '';
      $('qr-box').hidden = true;
      return r;
    },
    '已取消',
  ),
);

$('pwd-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/login/pwd', {
        method: 'POST',
        write: true,
        body: {
          phone: $('pwd-phone').value.trim(),
          password: $('pwd-pass').value,
          pcPlatform: addPc,
        },
      }),
    (r) => r.note || '登录成功',
  ),
);

// 「换一台设备」与「我的码一直扫不出来」是**同一个动作**（见 index.html 那段说明）。
const resetDevice = (e) =>
  act(
    e.currentTarget,
    () => api('/login/device/reset', { method: 'POST', write: true }),
    (r) => r.note,
  );
$('device-reset').addEventListener('click', resetDevice);
$('qr-reset').addEventListener('click', resetDevice);

// 账号列表里的切换 / 删除（按钮是画出来的，用事件代理）
$('acct-list').addEventListener('click', async (ev) => {
  const pick = (name) => ev.target.closest(`[data-acc-${name}]`);
  const sel = pick('select');
  const ref = pick('refresh');
  const ren = pick('rename');
  const cfg = pick('settings');
  const dis = pick('disable');
  const del = pick('del');
  if (!sel && !ref && !ren && !cfg && !dis && !del) return;
  const post = (body) => api('/accounts', { method: 'POST', write: true, body });
  try {
    if (sel) {
      // ⚠ 这里是 `select`，**不是** `switch` —— 原来写的是 `switch`，
      //   而后端只认 add/select/remove ⇒ 又一个点了没反应的按钮。
      const r = await post({ op: 'select', id: sel.dataset.accSelect });
      toast(r.note || '已切到这个账号');
    } else if (ref) {
      // ⚠ 这一条**不改当前选中的账号**：后端用 `scoped(store, id)` 作用在
      //   指定账号上。老做法只能"先切过去再刷"，那会让用户莫名其妙的换号。
      const r = await post({ op: 'refresh', id: ref.dataset.accRefresh });
      toast(r.note || '凭据已刷新');
    } else if (ren) {
      const id = ren.dataset.accRename;
      const cur = (last && last.account && last.account.accounts) || [];
      const a = cur.find((x) => x.id === id) || {};
      const label = prompt('这个账号叫什么？留空就回落成手机号。', a.label || '');
      if (label === null) return;
      const r = await post({ op: 'edit', id, label });
      toast(r.note || '已改名');
    } else if (cfg) {
      openAcctSettings(cfg.dataset.accSettings);
      return; // 弹窗自己会 load()，不走下面那一趟
    } else if (dis) {
      const on = dis.dataset.on !== '1'; // 当前是启用 ⇒ 这次要停用
      const r = await post({ op: 'disable', id: dis.dataset.accDisable, disabled: on });
      toast(r.note || (on ? '已停用' : '已启用'));
    } else {
      const id = del.dataset.accDel;
      if (!confirm('移除这个账号？\n⚠ 它名下的票、进度与"这一小时已下单"都会一起清掉。')) return;
      const r = await post({ op: 'remove', id });
      toast(r.note || '已移除');
    }
    await load();
  } catch (err) {
    toast(err.message || '失败了', true);
  }
});

// 日常
$('daily-run').addEventListener('click', (e) =>
  act(e.currentTarget, () => runTask('daily'), '跑完了 —— 看下面的每一步'),
);

// 兑换
$('ex-plan-save').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/exchange/order', {
        method: 'POST',
        write: true,
        body: { query: $('ex-plan').value.trim() },
      }),
    '兑换目标已保存',
  ),
);
// 「现在试一次」走**干跑**路由，不是"真跑一次任务"：
//   干跑做完清单/余额/预热/取题，到"只差下单"就停 —— **一枪都不发**。
//   按钮的标签是"试一次"，用户想知道的是「现在能不能兑」，而那一枪发出去
//   是真扣豆且不可逆的。真下单只走定时那一场。
$('ex-run').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () => post('exchange/try', {}),
    '试完了 —— 一枪都没发，看下面这次的结果',
  ),
);

// 直播
$('live-claim').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const raw = $('live-paste').value.trim();
      if (!raw) throw new Error('先把口令贴进来');
      await api('/live/codes', { method: 'POST', write: true, body: { codes: raw } });
      $('live-paste').value = '';
      await runTask('live');
      return null;
    },
    '口令已收下并跑了一轮',
  ),
);
$('live-run').addEventListener('click', (e) =>
  act(e.currentTarget, () => runTask('live'), '听了一轮'),
);

// 设置
$('cfg-save').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/config', {
        method: 'POST',
        write: true,
        body: {
          baseUrl: $('cfg-baseUrl').value.trim(),
          liveUrl: $('cfg-liveUrl').value.trim(),
          gateBase: $('cfg-gateBase').value.trim(),
          wsBase: $('cfg-wsBase').value.trim(),
          imBase: $('cfg-imBase').value.trim(),
          loginBase: $('cfg-loginBase').value.trim(),
          loginPlatform: $('cfg-loginPlatform').value,
        },
      }),
    '设置已保存',
  ),
);

$('selftest-run').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const r = await api('/selftest');
      paintList(
        'selftest-list',
        (r.checks || []).map((c) => [(c.ok ? '✓ ' : '✗ ') + c.name, '', '']),
        '',
      );
      setText('caps-line', r.caps || '');
      if (!r.ok) throw new Error(r.detail);
      return r;
    },
    (r) => r.detail,
  ),
);

// ── 兑换的两个时间参数 ──
$('ex-hour-save').addEventListener('click', (ev) =>
  act(
    ev.currentTarget,
    () => post('config', { targetHour: $('ex-hour').value.trim() }),
    '兑换时刻已保存',
  ),
);
$('ex-lead-save').addEventListener('click', (ev) =>
  act(
    ev.currentTarget,
    () => post('config', { leadMs: $('ex-lead').value.trim() }),
    '提前量已保存',
  ),
);

// ── 推送：试发一条 ──
$('push-test').addEventListener('click', (ev) =>
  act(
    ev.currentTarget,
    async () => {
      const r = await post('push/test', {});
      // ⚠ 试发**失败也把结果当"成功返回"处理**（接口本身是 200）——
      //   这里要的是把 `line` 显示出来，而不是让 `act` 抛错后只显示一句
      //   笼统的错误。所以成败自己判。
      if (!r.ok) throw new Error(r.line || '没发出去');
      return r;
    },
    (r) => r.line,
  ),
);

// ── 推送：加一条规则 ──
$('push-add-rule').addEventListener('click', (ev) => {
  const name = prompt('这条规则叫什么？（比如「只在有失败时」）', '全部渠道');
  if (!name) return;
  const onlyError = confirm('只在有失败的时候才推？\n确定 = 只在有失败时推；取消 = 每次都推');
  const rules = ((last.push && last.push.rules) || []).slice();
  rules.push({
    // id 用时间戳 —— 不需要稳定，只要在规则列表里唯一
    id: `r${Date.now()}`,
    name,
    channels: [],
    minLevel: onlyError ? 'error' : 'always',
  });
  act(ev.currentTarget, () => post('push/rules', rules), '规则已加，去下面给任务选上');
});

// ──────────────────────────────────────────────────────────── 起手

// 打开页面先画一次。⚠ **不自动轮询** —— 读数只在动作之后刷新。
// 自动轮询会让「我点了一下」和「它自己变了」分不清，而且这个页面在 iframe 里，
// 没人看的时候不该一直打接口。
load();
