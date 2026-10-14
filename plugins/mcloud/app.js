// mcloud 插件自己的界面（插件作者写的东西，不是主面板的一部分）。
//
// 只做**插件自己才知道**的事：
//   · 分组视图（按风险与依赖分组 —— 主面板只有"插件 → 任务"两层，没有分组）
//   · 每条任务的最近结果与失败原因（主面板有任务列表，但没有这张表的组织方式）
//   · 会话与上游地址（插件自己的配置）
//   · 逐条「立即执行」
//
// 不重复主面板的界面：调度、启停、实时日志、插件管理都在主面板上。

const $ = (id) => document.getElementById(id);

/** 统一请求封装：**不抛异常**，返回 { ok, ... } 或 { ok:false, error }。
 *  与主面板 web/js/api.js、demo 插件同一套约定。 */
async function req(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    // 插件写路由要带这个头（面板侧的规定，见插件仓库 docs/findings.md F-007）
    init.headers['x-panel'] = '1';
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    return { ok: false, error: '连不上后端：' + (e.message || e) };
  }
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
    return { ok: false, error: '未登录' };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, error: `HTTP ${res.status}（响应不是 JSON）：${text.slice(0, 160)}` };
  }
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return Object.assign({ ok: true }, data);
}

function showError(msg) {
  const el = $('error');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

// ──────────────────────────── 渲染

const RISK = {
  none: { label: '', cls: '' },
  ledger: { label: '记账', cls: 'risk-ledger' },
  'write-cloud': { label: '写网盘', cls: 'risk-write' },
  irreversible: { label: '不可逆', cls: 'risk-hard' },
  spend: { label: '扣豆', cls: 'risk-spend' },
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 一条任务在界面上的行。 */
function taskRow(t) {
  const risk = RISK[t.risk] || RISK.none;
  // 最近一次的结果：优先显示失败原因（那才是要看的东西）
  let last = '';
  if (t.lastError) {
    last = `<span class="bad">失败：${esc(t.lastError).slice(0, 90)}</span>`;
  } else if (t.recent && t.recent.length) {
    const r = t.recent[0];
    last = `<span class="dim">${esc(r.note).slice(0, 90)}</span>`;
  } else if (t.note) {
    last = `<span class="dim">${esc(t.note).slice(0, 90)}</span>`;
  }

  const mark = t.implemented ? '✅' : '·';
  const runBtn = t.implemented
    ? `<button class="btn btn-sm" data-run="${esc(t.name)}" data-risk="${esc(t.risk)}">立即执行</button>`
    : `<span class="dim">未实现</span>`;

  return `<tr class="${t.implemented ? '' : 'row-off'}">
    <td class="c">${mark}</td>
    <td><code>${esc(t.name)}</code></td>
    <td>${esc(t.title)}</td>
    <td>${risk.label ? `<span class="badge ${risk.cls}">${risk.label}</span>` : ''}</td>
    <td class="note">${last}</td>
    <td class="c">${runBtn}</td>
  </tr>`;
}

function groupSection(g) {
  return `<section class="card">
    <div class="card-head">
      <h2>${esc(g.title)}</h2>
      <span class="card-sub">${g.implemented}/${g.total} 条已实现</span>
    </div>
    <p class="why">${esc(g.why)}</p>
    <table class="tasks">
      <thead><tr><th></th><th>任务</th><th>说明</th><th>风险</th><th>最近一次</th><th></th></tr></thead>
      <tbody>${g.tasks.map(taskRow).join('')}</tbody>
    </table>
  </section>`;
}

async function loadGroups() {
  const d = await req('/plugins/mcloud/api/groups');
  if (!d.ok) {
    showError('读分组失败：' + d.error);
    return;
  }
  showError('');
  const t = d.totals || {};
  $('summary').innerHTML =
    `合计 <b>${t.tasks}</b> 条任务，已实现 <b>${t.implemented}</b> 条，` +
    `高风险 <b>${t.risky}</b> 条。` +
    `<span class="dim">（未实现的也列出来 —— 这一列本身就是路线图）</span>`;
  $('groups').innerHTML = (d.groups || []).map(groupSection).join('');
  for (const btn of document.querySelectorAll('[data-run]')) {
    btn.addEventListener('click', () => runTask(btn));
  }
}

async function runTask(btn) {
  const name = btn.dataset.run;
  const risk = btn.dataset.risk;
  // 会真扣豆 / 不可逆的，先问一句
  if ((risk === 'spend' || risk === 'irreversible') && !confirm(`「${name}」是不可逆的写操作，确定现在执行？`)) {
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '执行中…';
  const d = await req(`/api/tasks/mcloud/${encodeURIComponent(name)}/run`, { method: 'POST' });
  btn.textContent = old;
  btn.disabled = false;
  if (!d.ok) {
    showError(`执行 ${name} 失败：${d.error}`);
  } else {
    showError('');
  }
  await loadGroups();
}

// ──────────────────────────── App 任务矩阵（只读任务的读数）

async function loadMatrix() {
  const d = await req('/plugins/mcloud/api/matrix');
  const card = $('matrix-card');
  if (!d.ok || !Array.isArray(d.groups)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('matrix-sub').textContent = `已读到 ${d.read}/${d.total} 个 group`;
  const rows = d.groups.map((g) => {
    const r = g.reading;
    if (!r) {
      return `<tr><td><code>${esc(g.group)}</code></td><td colspan="5" class="dim">还没读到（下一次触发读它）</td></tr>`;
    }
    const names = (r.todoNames || []).join('、');
    return `<tr>
      <td><code>${esc(g.group)}</code></td>
      <td class="c">${r.done}</td>
      <td class="c">${r.todo ? `<b>${r.todo}</b>` : 0}</td>
      <td class="c dim">${r.skip}</td>
      <td class="note">${names ? esc(names) : '<span class="dim">—</span>'}</td>
      <td class="dim">${esc((r.at || '').slice(11, 19))}</td>
    </tr>`;
  });
  $('matrix-table').querySelector('tbody').innerHTML = rows.join('');
}

// ──────────────────────────── 兑换清单（只读任务的读数）

async function loadExchange() {
  const d = await req('/plugins/mcloud/api/exchange');
  const card = $('exchange-card');
  if (!d.ok || !d.reading) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const r = d.reading;
  const t = d.verdictText || {};
  $('exchange-sub').textContent = `${r.groups} 组 / ${r.total} 件 · 读到 ${esc((r.at || '').slice(11, 19))}`;
  $('exchange-note').innerHTML = `<b>只读</b>：${esc(d.note || '')}`;
  const rows = (r.ok || []).map(
    (p) => `<li><code>${esc(p.name || '#' + p.prizeId)}</code> · ${p.price ?? '?'} 豆</li>`,
  );
  $('exchange-ok').innerHTML = rows.length
    ? `<div class="hint">现在可兑（${r.okCount} 件）：</div><ul class="ok-list">${rows.join('')}</ul>`
    : '<div class="hint">现在没有可兑的</div>';
  const tiers = Object.entries(r.byVerdict || {})
    .map(([k, v]) => `${esc(t[k] || k)} ${v}`)
    .join(' · ');
  $('exchange-tiers').textContent = tiers ? '各档计数：' + tiers : '';
}

// ──────────────────────────── 直播口令（只读那半 + 人给的口令）

async function loadLive() {
  const d = await req('/plugins/mcloud/api/live');
  const card = $('live-card');
  if (!d.ok) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('live-note').innerHTML = esc(d.note || '');

  const r = d.reading;
  const sub = [];
  if (r) {
    sub.push(`读到 ${(r.at || '').slice(11, 19)}`);
    sub.push(`${r.chars} 字符`);
    if (r.tookMs !== undefined) sub.push(`${r.tookMs}ms`);
  } else {
    sub.push('还没抓过');
  }
  $('live-sub').textContent = sub.join(' · ');

  // 抓到的口令：**一条也没有**与"页面被挡成空壳"在解析层长得一样，
  // 所以这里把读数里那句 note 原样贴出来（它已经写了两种可能），别自己下结论。
  if (!r) {
    $('live-found').innerHTML = '<div class="hint">还没抓过 —— 去任务列表点 <code>live-room</code> 的「立即执行」</div>';
  } else if (r.codes && r.codes.length) {
    $('live-found').innerHTML =
      '<ul class="ok-list">' +
      r.codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('') +
      '</ul>';
  } else {
    $('live-found').innerHTML = `<div class="hint">${esc(r.note || '没读到口令')}</div>`;
  }

  const c = d.codes;
  $('live-codes-hint').textContent = c
    ? `已存 ${c.codes.length} 条（${c.how}）· ${(c.at || '').slice(0, 16).replace('T', ' ')}：${c.codes.join('、')}`
    : '还没存过口令。口令不是账号凭据 —— 它是**共享资源**（谁拿到都能拿去领小红花），所以这里如实显示。';

  // ── 口令池（业务档，照 mcloud）──
  //
  // 界面上必须看得见三件事，否则池就成了一个"隐形的节流器"：
  //   · 够没够 2 条**有效**（够了就不再抓主页）
  //   · 还要等多久才能再抓（30 分钟窗口）
  //   · 每一条口令现在是什么状态（未知 / 有效 / 无效，无效的带原因）
  $('live-pool').innerHTML = renderPool(d.pool);

  // ── 门（直播日程，只读）──
  $('live-gate-rooms').innerHTML = renderGate(d.gate);

  // ── 写那半（领小红花）──
  const claim = d.claim || {};
  $('live-claim').checked = !!claim.enabled;
  const st = claim.state;
  if (!st) {
    $('live-draw-hint').textContent = '还没领过。要试的口令：' + ((claim.codes || []).join('、') || '（一条都没有）');
  } else if (st.step === 'done') {
    $('live-draw-hint').textContent = `上一轮：${st.summary || ''}`;
  } else {
    $('live-draw-hint').textContent = `进行中：第「${st.step}」步 · 口令 ${st.drawIndex}/${(st.codes || []).length}`;
  }
  const rows = (st && st.results) || [];
  $('live-draw-result').innerHTML = rows.length
    ? `<ul class="ok-list">${rows.map((r) => `<li>${esc(r.note)}</li>`).join('')}</ul>`
    : '';
}

/** 池那一行：状态计数 + 两条口径的可见化 + 逐条状态。
 *
 *  ⚠ 措辞**不许**下结论：`未知` 不等于"能用"（那只是"抓到了、还没验过"）。
 *  判一条口令能不能用**只有**一个途径 —— 拿去领（上游当场校验）。 */
function renderPool(pool) {
  if (!pool) return '';
  const stateText = { unknown: '未知', valid: '有效', invalid: '无效' };
  const bits = [`池：${pool.validCount} 条有效`];
  if (pool.stopScraping) bits.push('够 2 条 ⇒ 已停止抓主页');
  if (pool.xhsWaitMs > 0) bits.push(`距下次可抓主页约 ${Math.ceil(pool.xhsWaitMs / 60000)} 分钟`);
  if (pool.nextStart) bits.push(`下一场 ${pool.nextStart}${pool.nextTitle ? ' · ' + pool.nextTitle : ''}`);
  else if (pool.scheduleAtMs) bits.push('这一场没有预告场');
  else bits.push('还没探测过直播日程');

  const codes = pool.codes || [];
  const list = codes.length
    ? '<ul class="ok-list">' +
      codes
        .map((c) => {
          const st = stateText[c.state] || c.state;
          const why = c.reason ? `（${esc(c.reason)}）` : '';
          return `<li><code>${esc(c.value)}</code> <span class="dim">${esc(st)}${why}</span></li>`;
        })
        .join('') +
      '</ul>'
    : '';

  const sessions = (pool.sessions || []).length;
  return esc(bits.join(' · ')) + (sessions ? ` · 见过 ${sessions} 场` : '') + list;
}

/** 门那一行：**只读**探针看到的日程。
 *
 *  ⚠ 措辞照读数里那句 `note` 来（它已经分好了三种情形：门开着 / 谁都没在播 /
 *  有在播但不是那个主播）—— 界面**不许**自己再下结论。
 *  ⚠ 预告场是这一行的**主要产出**：口令只在开播那一小时有效，而"今天几点开"
 *  是预告给的（`expectStartTime`，**原样显示**，别解析成时间戳）。 */
function renderGate(gate) {
  if (!gate) return '<div class="hint">还没探过 —— 点「现在探一次」（只读，不需要口令）</div>';
  const at = (gate.at || '').slice(11, 19);
  const head = `看到 ${gate.rooms.length} 间房 · 在播 ${gate.liveCount} 间 · ${at}`;
  const rows = (gate.rooms || [])
    .map((r) => {
      const state = r.status === 1 ? '在播' : r.status === 6 ? '回放' : '预告';
      const when = r.expectStartTime ? ` <code>${esc(r.expectStartTime)}</code>` : '';
      const mine = r.anchorNickname === '中国移动云盘' ? '' : ' <span class="dim">（不是那个主播）</span>';
      return `<li><span class="dim">${state}</span> ${esc(r.title || '#' + r.roomId)}${when}${mine}</li>`;
    })
    .join('');
  return (
    `<div class="hint">${esc(head)}</div>` +
    `<div class="hint">${esc(gate.note || '')}</div>` +
    (rows ? `<ul class="ok-list">${rows}</ul>` : '')
  );
}

async function toggleClaim() {  const on = $('live-claim').checked;
  if (on && !confirm('开启后 cron 会**自动**去领小红花（往账号里写）。确定开启？')) {
    $('live-claim').checked = false;
    return;
  }
  const d = await req('/plugins/mcloud/api/live/claim', { method: 'POST', body: { enabled: on } });
  if (!d.ok) {
    showError('改开关失败：' + d.error);
    $('live-claim').checked = !on;
    return;
  }
  showError('');
  await loadLive();
}

/** 现在领一次：**浏览器循环调「推进一步」**，直到跑完。
 *
 *  为什么不在服务端一次跑完：面板的单次执行预算只有 2000ms，而六步链有 9+N 个请求
 *  —— 一个"从头跑到尾"的调用会在第 2、3 个请求处被判超时，而那时**上游的账已经记了**。
 *  每次 HTTP 调用一个上游请求，这是这套架构的纪律。 */
async function drawNow() {
  if (!confirm('领小红花会**真的往你的账号里写**（记账、留活动足迹）。同一条口令重领只会回「已兑换过」，不会重复发奖。确定现在领？')) {
    return;
  }
  const btn = $('live-draw');
  btn.disabled = true;
  const hint = $('live-draw-hint');
  let steps = 0;
  for (;;) {
    const d = await req('/plugins/mcloud/api/live/draw/step', { method: 'POST' });
    if (d.error) {
      showError('领取失败：' + d.error);
      break;
    }
    hint.textContent = d.note || '';
    if (!d.ok) showError(d.note || '这一步失败了');
    else showError('');
    steps += 1;
    if (d.done) break;
    // 上限只是防死循环：9 + 口令数 + 余量。真到了说明状态机卡住了。
    if (steps > 40) {
      hint.textContent = `推了 ${steps} 步还没跑完，停下（${d.note || ''}）—— 状态可能卡住了`;
      break;
    }
  }
  btn.disabled = false;
  await loadLive();
}

/** 现在探一次：与 `drawNow` 同一个形状 —— 浏览器循环调「推进一步」。
 *
 *  一次调用**最多两发**上游（handshake 步 ①② / rooms 步 ③③）：
 *  SSO token 只活几分钟，①② 拆开必然过期（见 liveGateTask.ts 文件头）。
 *  这条路**全是只读**，所以"多探几次"没有任何代价。 */
async function probeGate() {
  const btn = $('live-gate');
  btn.disabled = true;
  const hint = $('live-gate-hint');
  let steps = 0;
  for (;;) {
    const d = await req('/plugins/mcloud/api/live/gate/step', { method: 'POST' });
    if (d.error) {
      showError('探测失败：' + d.error);
      break;
    }
    hint.textContent = d.note || '';
    if (!d.ok) showError(d.note || '这一步失败了');
    else showError('');
    steps += 1;
    if (d.done) break;
    if (steps > 6) {
      hint.textContent = `推了 ${steps} 步还没完，停下（${d.note || ''}）`;
      break;
    }
  }
  btn.disabled = false;
  await loadLive();
}

async function saveLiveCodes() {
  const v = $('live-input').value.trim();
  if (!v) {
    showError('先贴一条口令');
    return;
  }
  const d = await req('/plugins/mcloud/api/live/codes', { method: 'POST', body: { codes: v } });
  if (!d.ok) {
    showError('存口令失败：' + d.error);
    return;
  }
  $('live-input').value = '';
  showError('');
  await loadLive();
}

async function clearLiveCodes() {
  const d = await req('/plugins/mcloud/api/live/codes', { method: 'POST', body: { clear: true } });
  if (!d.ok) {
    showError('清空失败：' + d.error);
    return;
  }
  showError('');
  await loadLive();
}

// ──────────────────────────── H5 换票（原生凭据 → jwttoken）

async function loadH5() {
  const d = await req('/plugins/mcloud/api/h5');
  if (!d.ok) return;
  const h = $('h5-hint');
  const a = d.auth || {};
  const j = d.jwt || {};
  const parts = [];
  if (a.present) parts.push(`已收下凭据（指纹 ${esc(a.fingerprint)}，${a.length} 字符）`);
  else parts.push('还没贴原生凭据 —— 没它就只能手工贴 jwttoken（那个 2 小时就废）');
  if (j.present) {
    parts.push(j.fresh
      ? `票新鲜（${esc((j.at || '').slice(0, 16).replace('T', ' '))} 换的${j.mobile ? `，账号 ${esc(j.mobile)}` : ''}）`
      : `票**已过期**（该续了，cron 每 2 分钟会自己推一步）`);
  } else {
    parts.push('还没有票');
  }
  const ex = d.exchange;
  if (ex && ex.step !== 'done') parts.push(`换票进行中：${esc(ex.step)}`);
  else if (ex && ex.note) parts.push(`上一轮：${esc(ex.note)}`);
  h.textContent = parts.join(' · ');
}

async function saveH5Auth() {
  const v = $('h5-auth').value.trim();
  if (!v) {
    showError('先贴一份原生凭据');
    return;
  }
  const d = await req('/plugins/mcloud/api/h5/auth', { method: 'POST', body: { authorization: v } });
  if (!d.ok) {
    showError('收下凭据失败：' + d.error);
    return;
  }
  $('h5-auth').value = '';
  showError('');
  await runH5Steps();
}

/** 循环推三步 —— 每次 HTTP 一个上游请求（面板预算 2000ms，见 sessionExchange.ts）。 */
async function runH5Steps() {
  const btn = $('h5-save');
  btn.disabled = true;
  const h = $('h5-hint');
  for (let i = 0; ; i += 1) {
    const d = await req('/plugins/mcloud/api/h5/step', { method: 'POST' });
    if (d.error) {
      showError('换票失败：' + d.error);
      break;
    }
    h.textContent = d.note || '';
    if (!d.ok) showError(d.note || '这一步失败了');
    else showError('');
    if (d.done) break;
    if (i > 8) {
      h.textContent = `推了 ${i + 1} 步还没完，停下（${d.note || ''}）`;
      break;
    }
  }
  btn.disabled = false;
  await loadH5();
  await loadLive();
}

async function clearH5() {
  const d = await req('/plugins/mcloud/api/h5/auth', { method: 'POST', body: { clear: true } });
  if (!d.ok) {
    showError('清空失败：' + d.error);
    return;
  }
  showError('');
  await loadH5();
}

// ──────────────────────────── 会话与上游地址

async function loadSession() {
  const d = await req('/plugins/mcloud/api/session');
  if (!d.ok) {
    $('session-status').textContent = '读不到（' + d.error + '）';
    return;
  }
  // 形状取防御性读法：插件只保证"不回显凭据"，字段名可能变
  const s = d.session ?? d.status ?? d;
  const bits = [];
  if (s && typeof s === 'object') {
    if (s.ok !== undefined) bits.push(s.ok ? '会话可用' : '会话不可用');
    if (s.hasCookie !== undefined) bits.push(s.hasCookie ? '有 cookie' : '没有 cookie');
    if (s.hasJwt !== undefined) bits.push(s.hasJwt ? '有 jwt' : '没有 jwt');
    if (s.deviceId) bits.push('deviceId 有');
    if (s.savedAt) bits.push('保存于 ' + s.savedAt);
    if (s.note) bits.push(String(s.note));
  }
  $('session-status').textContent = bits.length ? bits.join(' · ') : JSON.stringify(s).slice(0, 120);
}

async function saveSession() {
  const v = $('session-input').value.trim();
  if (!v) {
    showError('先粘一份 cookie 串');
    return;
  }
  const d = await req('/plugins/mcloud/api/session', { method: 'POST', body: { session: v } });
  $('session-input').value = ''; // 不回填
  if (!d.ok) {
    showError('导入失败：' + d.error);
    return;
  }
  showError('');
  const note = d.note || d.message || d.status || '已导入';
  $('session-status').textContent = String(note);
  await loadSession();
}

async function checkSession() {
  const d = await req('/plugins/mcloud/api/session/verify', { method: 'POST' });
  if (!d.ok) {
    showError('验证失败：' + d.error);
    return;
  }
  showError('');
  $('session-status').textContent = String(d.note || d.message || d.status || '验证完成');
}

async function loadBase() {
  const d = await req('/plugins/mcloud/api/config');
  if (!d.ok) return;
  const b = d.baseUrl ?? d.base_url ?? (d.config && d.config.baseUrl) ?? '';
  $('base-url').value = b || '';
  $('base-hint').textContent = b
    ? '当前指向上游：' + b
    : '当前用默认上游（移动云盘正式地址）。指向本地 mock 时填 http://127.0.0.1:19040。';

  // 口令主页：**与上游地址不是一回事**（那是个源，这是个完整 URL）。
  // 值等于默认时输入框留空 —— 那样"留空 = 用默认"这句话才成立。
  const lv = d.liveUrl || '';
  const lvDefault = d.liveUrlDefault || '';
  $('live-url').value = lv === lvDefault ? '' : lv;
  $('live-url-hint').textContent = lv
    ? (lv === lvDefault ? '当前抓发布方的小红书主页（默认）：' : '当前抓：') + lv
    : '还没配（任务会用默认主页）';

  // 直播主机（门的两个主机 —— 一个口子，见 liveGateTask.loadGateBase）
  const gb = d.gateBase || '';
  const gbReal = gb === '(真主机)';
  $('gate-base').value = gbReal ? '' : gb;
  $('gate-base-hint').textContent = gbReal
    ? '当前用真主机（user-njs.yun.139.com / v.cmcc-cs.cn）。指向本地 mock 时填 http://127.0.0.1:19040。'
    : '当前指向：' + gb;
}

async function saveGateBase() {
  const v = $('gate-base').value.trim();
  const d = await req('/plugins/mcloud/api/config', { method: 'POST', body: { gateBase: v } });
  if (!d.ok) {
    showError('保存直播主机失败：' + d.error);
    return;
  }
  showError('');
  await loadBase();
  await loadLive();
}

async function saveLiveUrl() {
  const v = $('live-url').value.trim();
  const d = await req('/plugins/mcloud/api/config', { method: 'POST', body: { liveUrl: v } });
  if (!d.ok) {
    showError('保存口令主页失败：' + d.error);
    return;
  }
  showError('');
  await loadBase();
  await loadLive();
}

async function saveBase() {
  const v = $('base-url').value.trim();
  const d = await req('/plugins/mcloud/api/config', { method: 'POST', body: { baseUrl: v } });
  if (!d.ok) {
    showError('保存上游地址失败：' + d.error);
    return;
  }
  showError('');
  await loadBase();
}

// ──────────────────────────── 启动

$('refresh').addEventListener('click', () => {
  loadGroups();
  loadSession();
  loadMatrix();
  loadExchange();
  loadLive();
  loadH5();
});
$('session-save').addEventListener('click', saveSession);
$('session-check').addEventListener('click', checkSession);
$('base-save').addEventListener('click', saveBase);
$('h5-save').addEventListener('click', saveH5Auth);
$('h5-clear').addEventListener('click', clearH5);
$('live-url-save').addEventListener('click', saveLiveUrl);
$('gate-base-save').addEventListener('click', saveGateBase);
$('live-gate').addEventListener('click', probeGate);
$('live-save').addEventListener('click', saveLiveCodes);
$('live-clear').addEventListener('click', clearLiveCodes);
$('live-claim').addEventListener('change', toggleClaim);
$('live-draw').addEventListener('click', drawNow);

loadGroups();
loadSession();
loadMatrix();
loadExchange();
loadLive();
loadH5();
loadBase();
