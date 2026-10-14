// mcloud 插件自己的界面（插件作者写的东西，不是主面板的一部分）。
//
// 只做**插件自己才知道**的事：
//   · 分组视图（按风险与依赖分组 —— 主面板只有"插件 → 任务"两层，没有分组）
//   · 每条任务的最近结果与失败原因（主面板有任务列表，但没有这张表的组织方式）
//   · 会话与移动云盘地址（插件自己的配置）
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

/** 把任务报错里**给开发者看的东西**剥掉，只留用户能懂的。
 *
 *  ⚠ 实机截图上出现过：`失败：未登录：state 里没有会话（见 docs/howto-session.md）
 *  @ 2026-10-14T10:51:52.537Z` —— 仓库文档路径、表名、ISO 时间戳，
 *  三样都是"我们自己人"才需要的信息（见 docs/ui-wording.md）。
 *  ⇒ 统一在这里剥：文档路径、时间戳、`state 表`、`Authorization`、markdown 记号。 */
function humanNote(s) {
  if (s === undefined || s === null || s === '') return '';
  let t = String(s);
  t = t.replace(/（?见\s*docs\/[\w.\-]+）?/g, '');
  t = t.replace(/@?\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '');
  t = t.replace(/state\s*里没有会话/g, '还没登录');
  t = t.replace(/原生凭据\s*[（(]?`?Authorization`?[)）]?/g, '凭据');
  t = t.replace(/\*\*/g, '').replace(/`/g, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/[：:、,，]\s*$/, '').trim();
  // ── 直播那几句：全是我们内部的说法（SockJS/PROVISION/句柄/帧）──
  t = t.replace(/WS 连上了（句柄 \d+），PROVISION 已发.*$/g, '已连上，开始听');
  t = t.replace(/弹幕连接结束：.*$/g, '听完了');
  t = t.replace(/句柄失效（[^）]*）/g, '连接断了，下一拍重来');
  t = t.replace(/^准备中（\w+）$/g, '准备中…');
  // `听着（帧 39、弹幕 1、口令 0、回执 10、h 帧 16）` ⇒ `正在听（本轮口令 0 条）`
  const listen = /听着（[^）]*口令 (\d+)[^）]*）/.exec(t);
  if (listen !== null) t = `正在听（本轮口令 ${listen[1]} 条）`;
  // `门关着（合并后 16 间房）—— 隔 5 分钟再看（上次真探 …）` ⇒ 一句人话
  if (/门关着/.test(t)) t = '主播没在播，等下一场';
  if (/那个主播没在播/.test(t)) t = '主播没在播，等下一场';
  if (t.includes('还没登录')) return '还没登录，先贴一次凭据';
  return t;
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
  // 报错先过话术（见 humanNote）：用户不该看见文档路径与 ISO 时间戳
  const risk = RISK[t.risk] || RISK.none;
  // 最近一次的结果：优先显示失败原因（那才是要看的东西）
  let last = '';
  if (t.lastError) {
    last = `<span class="bad">失败：${esc(humanNote(t.lastError)).slice(0, 90)}</span>`;
  } else if (t.recent && t.recent.length) {
    const r = t.recent[0];
    last = `<span class="dim">${esc(humanNote(r.note)).slice(0, 90)}</span>`;
  } else if (t.note) {
    last = `<span class="dim">${esc(humanNote(t.note)).slice(0, 90)}</span>`;
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

/** 把"插件自身"那一族（自检/调度健康/会话体检/续期）整段收进高级。
 *
 *  ⚠ 按**标题文字**找而不是按 id：那一族是插件自己声明的分组（见 groups.ts），
 *  给它加 id 要动插件侧的数据结构，而这里只需要"用户看不见它"。 */
function hideSelfCheck() {
  for (const sec of document.querySelectorAll('#groups section, #groups .card, #groups > div')) {
    const head = sec.querySelector('h2, h3, .card-head');
    if (head && /插件自身|自检/.test(head.textContent || '')) sec.classList.add('adv');
  }
}

async function loadGroups() {
  const d = await req('/plugins/mcloud/api/groups');
  lastGroups = d;   // 看板要用（见 renderBoard）
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

/** 看板：把读数里的**数字**画成条。
 *
 *  ⚠ 为什么是"通用扫描"而不是给每个任务写一套图表：这些读数的形状是任务自己定的
 *  （余额、奖品条数、快照字节…），逐个写会变成 30 个适配器，而用户要的只是
 *  "一眼看得出多少"。所以这里只做一件事：**找出第一个数字，按最大值画成条**。
 *  形状不对时它什么都不画（宁可空着，也不画错的东西）。 */
let lastGroups = null;

/** 从读数**文字**里抽数字。
 *
 *  ⚠ 为什么抽文字而不是读结构：这些读数是 30 个任务各自写的（"余额 130" / "领到 10 朵" /
 *  "快照 2.1 MB"），形状不统一 —— 给每个任务写一个适配器就是 30 个适配器，
 *  而用户要的只是"一眼看得出多少"。抽不出来就**什么都不画**（宁可空着，也不画错的）。
 *
 *  ⚠ 单位一起抽出来（KB/MB/朵/条…）：不然"2.1 MB"与"2.1 朵"会被画成同一条长度。 */
function numbersInText(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(KB|MB|GB|朵|个|条|张|次|豆|元)?/g)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v) || v <= 0 || v >= 1e9) continue;
    out.push({ value: v, unit: m[2] || '' });
  }
  return out;
}


function renderBoard() {
  const d = lastGroups;
  const box = $('board');
  const rows = [];
  const groups = [];
  if (d && Array.isArray(d.groups)) {
    for (const g of d.groups) {
      // ⚠ "插件自身"那族不画（自检/调度健康的数字对用户没意义）
      if (/插件自身|自检/.test(g.title || '')) continue;
      const inGroup = [];
      for (const t of g.tasks || []) {
        // 从最近的读数文字里抽数字：`recent` 优先（那是跑出来的），其次是报错与说明
        const texts = [
          ...((t.recent || []).map((r) => r && r.note).filter(Boolean)),
          t.lastError,
        ].filter((x) => typeof x === 'string' && x !== '');
        const seen = new Set();
        for (const text of texts.slice(0, 3)) {
          for (const n of numbersInText(text).slice(0, 2)) {
            const key = `${t.title || t.name}·${n.value}${n.unit}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const row = { label: t.title || t.name, key: n.unit || '数量', value: n.value };
            rows.push(row);
            inGroup.push(row);
          }
        }
      }
      if (inGroup.length > 0) groups.push({ title: g.title || '', rows: inGroup });
    }
  }
  if (rows.length === 0) {
    $('board-sub').textContent = '还没有数字可画';
    box.innerHTML = '<p class="hint">先去跑一遍（右上角「全部跑一遍」），有余额/奖品这类读数就会画在这里。</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  $('board-sub').textContent = `${groups.length} 组 · ${rows.length} 项`;
  const bar = (r) => {
    const pct = Math.round((r.value / max) * 100);
    return (
      `<li><b>${esc(r.label)}</b> <span class="hint">${esc(r.key)}</span> = <b>${r.value}</b>` +
      `<div style="height:8px;background:var(--c-line);border-radius:4px;margin-top:4px">` +
      `<div style="height:8px;width:${pct}%;background:var(--c-accent);border-radius:4px"></div></div></li>`
    );
  };
  box.innerHTML = groups
    .map(
      (g) =>
        `<p class="hint" style="margin:var(--sp-2) 0 0"><b>${esc(g.title)}</b></p>` +
        `<ul class="ok-list">${g.rows.map(bar).join('')}</ul>`,
    )
    .join('');
}

async function loadMatrix() {
  const d = await req('/plugins/mcloud/api/matrix');
  lastMatrix = d;   // 看板要用（见 renderBoard）
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

// ──────────────────────────── 账号（多账号：列表 + 当前）

async function loadAccounts() {
  const d = await req('/plugins/mcloud/api/accounts');
  const card = $('accounts-card');
  if (!d.ok) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const list = d.accounts || [];
  $('accounts-sub').textContent = list.length
    ? `${list.length} 个 · 当前 ${d.current || '（没选，用单独那格凭据）'}`
    : '还没有账号（用上面那一格单独凭据）';
  $('accounts-hint').textContent = list.length
    ? '点一行就是"选它当当前"。删除只删本地这一份，不影响上游。'
    : '还没有账号 —— 贴一串原生凭据点「添加」。';
  $('accounts-list').innerHTML = list.length
    ? '<ul class="ok-list">' +
      list
        .map(
          (a) =>
            `<li>${a.current ? '<b>当前</b> · ' : ''}<code>${esc(a.label)}</code>` +
            ` <span class="hint">${esc(a.masked)}</span>` +
            ` <button class="btn acc-pick" data-id="${esc(a.id)}">选它</button>` +
            ` <button class="btn acc-del" data-id="${esc(a.id)}">删</button></li>`,
        )
        .join('') +
      '</ul>'
    : '';
}

async function accountsOp(body) {
  const d = await req('/plugins/mcloud/api/accounts', { method: 'POST', body });
  if (!d.ok) {
    showError('账号操作失败：' + d.error);
    return;
  }
  showError('');
  await loadAccounts();
  await loadLive();
}

async function addAccount() {
  const v = $('acc-input').value.trim();
  if (v === '') return;
  await accountsOp({ op: 'add', auth: v });
  $('acc-input').value = '';
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

  // ── 听弹幕（第二十三轮）：窗口里的过程事实 ──
  //
  // ⚠ 这一块必须把"到哪一步了"写出来：那条链有 6 步（门/凭据/聊天室/进房间/连/听），
  //   卡在"准备中（apply）"与"听着（帧 0）"是**完全不同的两件事**
  //   （前者进不去房间，后者进去了但没人说话）。
  const lis = d.listen || {};
  const lr = lis.reading;
  // ⚠ `line` 已经是人话（"听着（帧 3、弹幕 0、口令 1）"/"准备中（apply）"），
  //   后面再补的只有"本轮口令"与收尾原因 —— 那两样 `line` 里放不下。
  $('live-listen-hint').textContent = humanNote(
    lr
      ? [lis.line || '', lr.codes && lr.codes.length ? `本轮口令：${lr.codes.join('、')}` : '', lr.closedReason ? `收尾：${lr.closedReason}` : '']
          .filter((x) => x !== '')
          .join(' · ')
      : lis.line || '还没听过',
  );

  // ── 自动定时（第二十四轮）：下一次几点醒 ──
  const au = d.auto || {};
  $('live-auto-hint').textContent = humanNote(au.line) || '还没算过';

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
    ? `<ul class="ok-list">${rows.map((r) => `<li>${esc(humanNote(r.note))}</li>`).join('')}</ul>`
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

/** 听弹幕：**浏览器循环调「推进一步」**，推到"开始听"就停。
 *
 *  ⚠ 与领小红花那条一样的纪律：面板一次调用只有 2 秒预算，而这条链有 6 步
 *  （门 → 凭据 → 聊天室 → 进房间 → 连 WS → 听）。
 *  推到 `listen` 就够了 —— 之后的每一拍由 cron（`@every 10s`）接着读。 */
async function listenNow() {
  const btn = $('live-listen');
  btn.disabled = true;
  const hint = $('live-listen-hint');
  let steps = 0;
  try {
    for (;;) {
      const d = await req('/plugins/mcloud/api/live/listen/step', { method: 'POST' });
      if (d.error) {
        showError('听弹幕失败：' + d.error);
        break;
      }
      hint.textContent = d.note || '';
      showError(d.ok ? '' : d.note || '这一步失败了');
      steps += 1;
      if (d.step === 'listen' || d.done) break;
      if (steps > 12) {
        hint.textContent = `推了 ${steps} 步还停在「${d.step}」—— 停下（${d.note || ''}）`;
        break;
      }
    }
  } finally {
    btn.disabled = false;
    await loadLive();
  }
}

/** 自动定时：算一次「下一次几点醒」（**零上游请求**，点一下没有代价）。 */
async function autoNow() {
  const btn = $('live-auto');
  btn.disabled = true;
  try {
    const d = await req('/api/tasks/mcloud/live-auto/run', { method: 'POST' });
    if (!d.ok) showError('算定时失败：' + (d.error || ''));
    else showError('');
    await loadLive();
  } finally {
    btn.disabled = false;
  }
}

/** 现在领一次：**浏览器循环调「推进一步」**，直到跑完。
 *
 *  为什么不在服务端一次跑完：面板的单次执行预算只有 2000ms，而六步链有 9+N 个请求
 *  —— 一个"从头跑到尾"的调用会在第 2、3 个请求处被判超时，而那时**上游的账已经记了**。
 *  每次 HTTP 调用一个上游请求，这是这套架构的纪律。 */
async function drawNow() {
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
  else if (ex && ex.note) parts.push(`上一轮：${esc(humanNote(ex.note))}`);
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

// ──────────────────────────── 会话与移动云盘地址

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
    ? '当前：来自移动云盘：' + b
    : '当前用默认上游（移动云盘正式地址）。（高级里才需要改） http://127.0.0.1:19040。';

  // 口令主页：**与移动云盘地址不是一回事**（那是个源，这是个完整 URL）。
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
    ? '当前用真主机（user-njs.yun.139.com / v.cmcc-cs.cn）。（高级里才需要改） http://127.0.0.1:19040。'
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
  hideSelfCheck();
  renderBoard();
}

async function saveBase() {
  const v = $('base-url').value.trim();
  const d = await req('/plugins/mcloud/api/config', { method: 'POST', body: { baseUrl: v } });
  if (!d.ok) {
    showError('保存移动云盘地址失败：' + d.error);
    return;
  }
  showError('');
  await loadBase();
}

// ──────────────────────────── 启动

// ── 「高级 / 诊断」：默认藏起来，点一下才露 ──
//
// ⚠ 这一串 id 就是"用户不该看见的东西"：打到哪个地址、抓哪个主页、
//   听弹幕那条链、自动定时的重算、以及插件自身的自检族。
//   见 docs/ui-wording.md —— 主界面只说"你要做什么、成了没有"。
const ADV_IDS = [
  // ⚠ 任务矩阵（`#groups`）整体退到高级：用户日常只需要"全部跑一遍"那一个按钮，
  //   30 条任务 + 30 个「立即执行」是**内部结构**，不该当产品摆着（见 docs/ui-wording.md）。
  'groups',
  // ⚠ 看板退到高级：YG 明确"要做的就三个 —— 日常任务、兑换、直播小红花"，
  //   看板是**结果展示**，不是要办的事（它留着，只是默认不占主界面）。
  'board-card',
  // 直播卡里"门/池/抓到的口令"是过程细节：用户只关心"口令贴了、领没领到"
  'live-gate', 'live-gate-hint', 'live-gate-rooms', 'live-found', 'live-pool', 'live-codes-hint',
  // ⚠ 会话卡整张：它与"账号"卡**在问同一件事**（同一串凭据）—— 用户不该看到两个框
  //   问同一个东西。贴凭据的地方只留"账号"卡那一处；会话/换票的机制进高级。
  'session-card',
  'base-url', 'base-hint', 'base-save', 'gate-base', 'gate-base-hint', 'gate-base-save',
  'live-url', 'live-url-hint', 'live-url-save',
  'live-listen', 'live-listen-hint', 'live-auto', 'live-auto-hint',
  'h5-card', 'accounts-sub',
];
for (const id of ADV_IDS) {
  const el = $(id);
  if (el !== null) el.classList.add('adv');
  const row = el?.closest?.('.row');
  if (row) row.classList.add('adv');
}
$('adv-toggle').addEventListener('click', () => document.body.classList.toggle('show-adv'));

/** 默认编排（学 mcloud：给用户一份"直接跑"的编排，而不是一张任务表）。
 *
 *  ⚠ 为什么是"前端按顺序点"而不是插件里写一条大任务：面板单次执行预算 2000ms，
 *  而这一串是几十个请求 ⇒ 一次跑完必然在第 2、3 个请求处被判超时（见 F-007）。
 *  浏览器按顺序逐个点，每一步都落在预算内。
 *
 *  顺序：会话体检/续期 → 签到族 → 查询族 → 直播（听 + 领）。
 *  "插件自身"那族（自检/调度健康）**不跑** —— 那是排查用的。 */
const RUN_ORDER = [
  'session-check', 'session-refresh',
  'sign', 'receive', 'multiple', 'backup-gift',
  'prizes', 'task-list', 'cloud-snapshot',
  'live-gate', 'live-listen', 'live-draw',
];

async function runAll() {
  const btn = $('run-all');
  btn.disabled = true;
  const old = btn.textContent;
  try {
    for (let i = 0; i < RUN_ORDER.length; i++) {
      const name = RUN_ORDER[i];
      // ⚠ 进度里**不许出现任务名**（`multiple`/`cloud-snapshot` 是内部叫法，见 docs/ui-wording.md）
      btn.textContent = `正在处理 ${i + 1}/${RUN_ORDER.length}…`;
      $('action-hint').textContent = '正在一条条做，别关页面 —— 做完这里会写结果。';
      const d = await req(`/api/tasks/mcloud/${name}/run`, { method: 'POST' });
      if (!d.ok) {
        // 单个失败不停 —— 用户要的是"一遍过完"，具体哪条失败在下面看
        showError(humanNote(d.error || '有一步没成，稍后会自动重试'));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    showError('');
    $('action-hint').textContent = '做完了。下面的「看板」和「口令」里能看到结果。';
    await loadGroups();
    await loadLive();
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

$('run-all').addEventListener('click', runAll);

$('refresh').addEventListener('click', () => {
  loadGroups();
  loadAccounts();
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
$('live-listen').addEventListener('click', listenNow);
$('acc-add').addEventListener('click', addAccount);
// ⚠ 列表里的按钮是**渲染出来的**，只能用事件委托（挂上去的时候它们还不存在）
$('accounts-list').addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const id = t.dataset.id;
  if (id === undefined) return;
  if (t.classList.contains('acc-pick')) accountsOp({ op: 'select', id });
  else if (t.classList.contains('acc-del')) accountsOp({ op: 'remove', id });
});
$('live-auto').addEventListener('click', autoNow);

loadGroups();
loadAccounts();
loadSession();
loadMatrix();
loadExchange();
loadLive();
loadH5();
loadBase();
