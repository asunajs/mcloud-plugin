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
    throw new Error((data && data.error) || `${res.status} ${text.slice(0, 200)}`);
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

function renderAccount(a) {
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

  paintList(
    'acct-list',
    list.map((x) => [
      (x.current ? '✓ ' : '') + (x.label || x.masked),
      `${x.masked}${x.addedAt ? ` · 加入于 ${when(x.addedAt)}` : ''}`,
      x.current
        ? '<span class="tag tag-on">正在用</span>'
        : `<button class="btn btn-sm" data-acc-switch="${esc(x.id)}">切到这个</button>` +
          `<button class="btn btn-sm btn-danger" data-acc-del="${esc(x.id)}">删除</button>`,
    ]),
    '还没有账号。上面选一种方式登录。',
  );

  const dev = $('device-id');
  if (dev && document.activeElement !== dev) dev.value = ses.deviceId || '';

  // 登录方式：没做的**说清楚**，而不是留一个点了没反应的按钮
  setText('login-note', '扫码 / 短信 / 账密登录还没做（阶段 ②-3）。现在能用的两条路在下面。');
}

function renderDaily(d) {
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

  setText('daily-when', run ? `${when(run.at)} 那一次，${run.steps.length} 步` : '');

  // 每一步一行。`idle` 的显示成灰点 —— 「今天不用领」和「领到了」是两件事，
  // 都给绿勾等于骗人。
  paintList(
    'daily-steps',
    run
      ? run.steps.map((s) => [(s.ok ? (s.idle ? '· ' : '✓ ') : '✗ ') + s.name, s.note, ''])
      : [],
    '还没有运行记录。',
  );
}

function renderExchange(e) {
  setText('ex-hero', e.plan ? `要换：${e.plan}` : '还没设兑换目标');
  setText('ex-sub', e.plan ? '' : '设一个之后它才会去下单。');

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
  const pool = l.pool || {};
  const codes = (l.codes || []).filter((c) => c && c.code);
  const valid = pool.validCount || 0;

  setText('live-hero', valid > 0 ? `口令池里有 ${valid} 条能用` : '口令池是空的');
  const bits = [];
  if (pool.nextStart) bits.push(`下一场 ${pool.nextStart}`);
  if (l.auto && l.auto.wakeAt) bits.push(`下一次自动听 ${when(l.auto.wakeAt)}`);
  if (l.listen && l.listen.line) bits.push(l.listen.line);
  setText('live-sub', bits.join(' · ') || '没有日程 —— 等它探到下一场。');

  setText('live-pool-line', pool.line || pool.note || '');
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

function renderPush(p) {
  if (p && p.implemented) {
    setText('push-hero', `${(p.channels || []).length} 个渠道`);
    setText('push-sub', '');
    return;
  }
  // 诚实地说「还没做」，而不是画一个看着像好的空表
  setText('push-hero', '还没做');
  setText('push-sub', '推送（10 个渠道 + 每个任务选一条规则）在阶段 ⑤。');
}

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
  fill('cfg-listenSeconds', s.listenSeconds);
  fill('cfg-wsHeartbeat', s.wsHeartbeat);
  fill('cfg-listenRoom', s.listenRoom);
}

function render(r) {
  renderAccount(r.account || {});
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

$('menu').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.menu-item');
  if (!btn) return;
  const name = btn.dataset.block;
  for (const b of document.querySelectorAll('.menu-item')) b.classList.toggle('is-on', b === btn);
  for (const s of document.querySelectorAll('.block')) {
    s.classList.toggle('is-on', s.id === 'block-' + name);
  }
});

// ──────────────────────────────────────────────────────────── 按钮

$('refresh').addEventListener('click', (e) => act(e.currentTarget, load, '已刷新'));

// 账号
const notYet = (what) => () =>
  toast(`${what}还没做（阶段 ②-3）。先用下面的「贴会话串导入」。`, true);
$('login-qr').addEventListener('click', notYet('扫码登录'));
$('login-sms').addEventListener('click', notYet('短信登录'));
$('login-pwd').addEventListener('click', notYet('账密登录'));

$('paste-open').addEventListener('click', () => {
  $('pane-paste').hidden = !$('pane-paste').hidden;
});
$('paste-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const raw = $('paste-body').value.trim();
      if (!raw) throw new Error('先把会话串贴进来');
      const r = await api('/session', { method: 'POST', write: true, body: { session: raw } });
      if (!r.verified) throw new Error(`导入成功但验证没过：${r.note || ''}`);
      $('paste-body').value = '';
      $('pane-paste').hidden = true;
      return r;
    },
    '导入并验证通过',
  ),
);

$('h5-open').addEventListener('click', () => {
  $('pane-h5').hidden = !$('pane-h5').hidden;
});
$('h5-submit').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    async () => {
      const raw = $('h5-body').value.trim();
      if (!raw) throw new Error('先把 Authorization 贴进来');
      const r = await api('/h5/auth', {
        method: 'POST',
        write: true,
        body: { authorization: raw },
      });
      $('h5-body').value = '';
      $('pane-h5').hidden = true;
      return r;
    },
    (r) => `已存下（指纹 ${r.fingerprint}）—— 点「现在跑一次」时它会自己换票`,
  ),
);

$('device-save').addEventListener('click', (e) =>
  act(
    e.currentTarget,
    () =>
      api('/accounts', {
        method: 'POST',
        write: true,
        body: { op: 'device', deviceId: $('device-id').value.trim() },
      }),
    '设备号已保存',
  ),
);

// 账号列表里的切换 / 删除（按钮是画出来的，用事件代理）
$('acct-list').addEventListener('click', async (ev) => {
  const sw = ev.target.closest('[data-acc-switch]');
  const del = ev.target.closest('[data-acc-del]');
  if (!sw && !del) return;
  try {
    if (sw) {
      await api('/accounts', {
        method: 'POST',
        write: true,
        body: { op: 'switch', id: sw.dataset.accSwitch },
      });
      toast('已切到这个账号');
    } else {
      await api('/accounts', {
        method: 'POST',
        write: true,
        body: { op: 'remove', id: del.dataset.accDel },
      });
      toast('已删除');
    }
    await load();
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
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
$('ex-run').addEventListener('click', (e) =>
  act(e.currentTarget, () => runTask('exchange'), '试完了 —— 看清单'),
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
          listenSeconds: Number($('cfg-listenSeconds').value) || 0,
          wsHeartbeat: $('cfg-wsHeartbeat').value.trim(),
          listenRoom: Number($('cfg-listenRoom').value) || 0,
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

// ──────────────────────────────────────────────────────────── 起手

// 打开页面先画一次。⚠ **不自动轮询** —— 读数只在动作之后刷新。
// 自动轮询会让「我点了一下」和「它自己变了」分不清，而且这个页面在 iframe 里，
// 没人看的时候不该一直打接口。
load();
