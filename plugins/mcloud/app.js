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
});
$('session-save').addEventListener('click', saveSession);
$('session-check').addEventListener('click', checkSession);
$('base-save').addEventListener('click', saveBase);

loadGroups();
loadSession();
loadMatrix();
loadExchange();
loadBase();
