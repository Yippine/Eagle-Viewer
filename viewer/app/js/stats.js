/* ── stats.js ▸ 統計頁（B6，#/stats；C62/C63）────────────────────────────
   舊版 stats.js 平移重繪：三摘要 + TOP10 重播 + 近 30 天 SVG 折線
   （tooltip/pin）+ 資料夾觀看分佈｜觀看記錄（?tab=history：按日分組、
   同日合併、搜尋、逐筆/逐日/全刪、點擊重播）。資料端點沿用
   /api/views、/api/delete-view、/api/clear-views。 */

import { api, mediaURL } from './api.js';
import { navigate } from './router.js';
import { h, fmtDuration } from './items.js';
import { renderBreadcrumb, setContentChrome, pagePanel } from './page-chrome.js';
import { openViewerFor } from './viewer.js';
import { confirmDialog } from './actions.js';
import { toast } from './notifications.js';

let _ctx = null;
let _rows = [];            // 整理後的觀看清單（views 降冪）

const _icon = n => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;

/* ── 路由入口 ───────────────────────────────────────────────────────── */

export async function renderStatsRoute(route, ctx) {
  _ctx = ctx;
  const tab = route.query.get('tab') === 'history' ? 'history' : 'overview';
  renderBreadcrumb([{ label: '統計' }, { label: ctx.label }]);
  setContentChrome(false);
  const panel = pagePanel();
  panel.innerHTML = `<div class="stats-page"><p class="insp-note">載入中…</p></div>`;

  let views = {};
  try { views = await api.views(ctx.slug); } catch (e) {
    panel.innerHTML = `<div class="stats-page"><p class="insp-note">觀看紀錄載入失敗：${h(e.message)}</p></div>`;
    return;
  }
  const items = ctx.items();
  const byId = new Map(items.map(i => [i.id, i]));
  _rows = Object.entries(views).map(([id, rec]) => ({
    id, name: rec.name || id, domain: rec.domain || '',
    views: rec.views || 0, history: rec.history || [],
    last: rec.last_viewed || '', total: rec.total_watch_time || 0,
    item: byId.get(id) || null,
  })).sort((a, b) => b.views - a.views);

  panel.innerHTML = `<div class="stats-page">
    <div class="seg-tabs">
      <button class="seg-tab${tab === 'overview' ? ' on' : ''}" data-tab="overview">總覽</button>
      <button class="seg-tab${tab === 'history' ? ' on' : ''}" data-tab="history">觀看記錄</button>
    </div>
    <div id="stats-body">${tab === 'overview' ? _overviewHTML() : _historyHTML()}</div>
  </div>`;
  panel.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () =>
    navigate(`#/stats?tab=${b.dataset.tab}`, { replace: true })));
  tab === 'overview' ? _wireOverview(panel) : _wireHistory(panel, route);
}

/* ── 總覽 ───────────────────────────────────────────────────────────── */

function _overviewHTML() {
  const totalViews = _rows.reduce((s, v) => s + v.views, 0);
  const totalTime = _rows.reduce((s, v) => s + v.total, 0);
  const top10 = _rows.slice(0, 10);

  // 近 30 天每日次數
  const days = [];
  const dMap = {};
  for (let d = 29; d >= 0; d--) {
    const dt = new Date(Date.now() - d * 86400000);
    const rec = { key: dt.toISOString().slice(0, 10), label: `${dt.getMonth() + 1}/${dt.getDate()}`, isToday: d === 0, count: 0 };
    days.push(rec); dMap[rec.key] = rec;
  }
  for (const v of _rows) for (const e of v.history) {
    const k = e.t ? e.t.slice(0, 10) : '';
    if (dMap[k]) dMap[k].count++;
  }

  // 資料夾觀看分佈
  const fv = {};
  for (const v of _rows) {
    if (!v.item) continue;
    for (const fid of (v.item.folders || [])) {
      const nm = _ctx.folderName(fid);
      fv[nm] = (fv[nm] || 0) + v.views;
    }
  }
  const folderRows = Object.entries(fv).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxFV = Math.max(1, folderRows[0]?.[1] || 1);

  return `
    <div class="stat-tiles">
      <div class="stat-tile"><b>${totalViews.toLocaleString()}</b><span>總觀看次數</span></div>
      <div class="stat-tile"><b>${_rows.length.toLocaleString()}</b><span>已觀看項目</span></div>
      <div class="stat-tile"><b>${h(fmtDuration(totalTime) || '0:00')}</b><span>總停留時間</span></div>
    </div>

    <h3 class="stats-h">TOP 10 最常觀看</h3>
    <div class="hist-list">
      ${top10.map((v, i) => _rowHTML(v, { rank: i + 1 })).join('')
        || `<p class="insp-note">尚無觀看紀錄</p>`}
    </div>

    <h3 class="stats-h">近 30 天趨勢</h3>
    <div class="line-chart">${_lineChart(days)}</div>

    ${folderRows.length ? `<h3 class="stats-h">資料夾觀看分佈</h3>
    <div class="bar-chart">${folderRows.map(([name, c]) => `
      <div class="bc-row"><span class="bc-label" title="${h(name)}">${h(name)}</span>
        <span class="bc-track"><span class="bc-fill" style="width:${Math.round(c / maxFV * 100)}%"></span></span>
        <span class="bc-val">${c}</span></div>`).join('')}</div>` : ''}`;
}

function _wireOverview(panel) {
  _wireRowClicks(panel);
  _wireChartTooltip(panel);
}

/* ── 觀看記錄（?tab=history）────────────────────────────────────────── */

function _historyEvents() {
  const events = [];
  for (const v of _rows) {
    if (v.history.length) {
      const byDay = new Map();                       // 同日合併（C63）
      for (const e of v.history) {
        const day = e.t ? e.t.slice(0, 10) : '';
        const cur = byDay.get(day) || { t: e.t, dur: 0, n: 0 };
        cur.dur += e.d || 0; cur.n++;
        if (new Date(e.t) > new Date(cur.t)) cur.t = e.t;
        byDay.set(day, cur);
      }
      for (const { t, dur, n } of byDay.values()) events.push({ ...v, t, dur, n });
    } else if (v.views > 0 && v.last) {
      events.push({ ...v, t: v.last, dur: 0, n: 1 });
    }
  }
  return events.sort((a, b) => new Date(b.t) - new Date(a.t));
}

function _historyHTML() {
  const events = _historyEvents();
  if (!events.length) return `<p class="insp-note" style="padding:24px 0">尚無觀看紀錄</p>`;

  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const groups = new Map();
  for (const e of events) {
    const date = e.t ? e.t.slice(0, 10) : '';
    const label = date === today ? '今天' : date === yest ? '昨天'
      : date ? new Date(date + 'T00:00').toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' }) : '較早之前';
    if (!groups.has(label)) groups.set(label, { date, items: [] });
    groups.get(label).items.push(e);
  }

  let html = `<div class="hist-toolbar">
    <input class="insp-input" id="hist-search" type="search" placeholder="搜尋觀看記錄…">
    <span class="insp-note" id="hist-count">${events.length} 筆</span>
    <button class="btn btn-ghost btn-sm" id="hist-clear-all">清除全部</button>
  </div>`;
  for (const [label, { date, items }] of groups) {
    html += `<div class="hist-day-hdr"><span>${h(label)}</span>
      <button class="btn btn-ghost btn-sm" data-clear-day="${h(date)}">清除這天</button></div>
      <div class="hist-list hist-group" data-date="${h(date)}">
        ${items.map(e => _rowHTML(e, { time: true, del: true })).join('')}
      </div>`;
  }
  return html;
}

function _wireHistory(panel, route) {
  _wireRowClicks(panel);

  panel.querySelector('#hist-search')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    let visible = 0;
    panel.querySelectorAll('.hist-group .hist-row').forEach(el => {
      const show = !q || (el.dataset.name || '').includes(q);
      el.hidden = !show;
      if (show) visible++;
    });
    panel.querySelectorAll('.hist-group').forEach(g => {
      const has = [...g.querySelectorAll('.hist-row')].some(el => !el.hidden);
      g.hidden = !has;
      const hdr = g.previousElementSibling;
      if (hdr?.classList.contains('hist-day-hdr')) hdr.hidden = !has;
    });
    const cnt = panel.querySelector('#hist-count');
    if (cnt) cnt.textContent = q ? `${visible} 筆（篩選中）` : `${visible} 筆`;
  });

  const rerender = () => renderStatsRoute(route, _ctx);

  panel.querySelectorAll('[data-del-entry]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const row = b.closest('[data-id]');
    try { await api.deleteView(_ctx.slug, row.dataset.id, row.dataset.t); rerender(); }
    catch (err) { toast(`刪除失敗：${err.message}`, { err: true }); }
  }));

  panel.querySelectorAll('[data-clear-day]').forEach(b => b.addEventListener('click', async () => {
    const date = b.dataset.clearDay;
    if (!await confirmDialog({ title: `清除 ${date} 的觀看紀錄？`, body: '此動作無法復原。', danger: true })) return;
    const jobs = [];
    for (const v of _rows) for (const e of v.history)
      if (e.t && e.t.slice(0, 10) === date) jobs.push(api.deleteView(_ctx.slug, v.id, e.t));
    try { await Promise.all(jobs); } catch (_) {}
    rerender();
  }));

  panel.querySelector('#hist-clear-all')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: '清除全部觀看紀錄？', body: '此動作無法復原。', danger: true })) return;
    try { await api.clearViews(_ctx.slug); rerender(); }
    catch (err) { toast(`清除失敗：${err.message}`, { err: true }); }
  });
}

/* ── 共用：紀錄列 ───────────────────────────────────────────────────── */

function _relTime(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  const day = Math.floor(sec / 86400);
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 週前`;
  if (day < 365) return `${Math.floor(day / 30)} 個月前`;
  return `${Math.floor(day / 365)} 年前`;
}

function _rowHTML(v, { rank = 0, time = false, del = false } = {}) {
  const it = v.item;
  const thumbSrc = it?.thumb ? mediaURL(it.thumb)
    : (it?.file && it.mediaType === 'image') ? mediaURL(it.file) : '';
  const clickable = !!it;
  const meta = [
    v.n > 1 ? `▶ ${v.n} 次` : (rank ? `▶ ${v.views} 次` : ''),
    (v.dur || v.total) ? `⏱ ${fmtDuration(time ? v.dur : v.total)}` : '',
    time ? _relTime(v.t) : '',
  ].filter(Boolean).join(' · ');
  return `<div class="hist-row${clickable ? ' clickable' : ''}" data-id="${h(v.id)}" ${v.t ? `data-t="${h(v.t)}"` : ''}
       data-name="${h((v.name || '').toLowerCase())}" ${clickable ? 'data-open' : ''}>
    ${thumbSrc ? `<span class="hist-thumb"><img src="${h(thumbSrc)}" alt="" loading="lazy">${rank ? `<b class="hist-rank">${rank}</b>` : ''}</span>`
               : `<span class="hist-thumb ph">${_icon('video')}${rank ? `<b class="hist-rank">${rank}</b>` : ''}</span>`}
    <span class="hist-info">
      <span class="hist-name">${h(v.name)}${it ? '' : '<i class="hist-del-badge">已刪除</i>'}</span>
      <span class="hist-meta">${h(meta)}</span>
    </span>
    ${del ? `<button class="btn btn-ghost btn-sm btn-icon" data-del-entry title="刪除此紀錄">✕</button>` : ''}
  </div>`;
}

function _wireRowClicks(panel) {
  panel.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-del-entry]')) return;
    openViewerFor(el.dataset.id);                    // 點擊重播（C63）
  }));
}

/* ── 近 30 天 SVG 折線（tooltip + pin，C62）─────────────────────────── */

function _lineChart(days) {
  const W = 520, PADX = 12, PADT = 14, CH = 96, AXH = 22;
  const maxDay = Math.max(1, ...days.map(d => d.count));
  const n = days.length;
  const xOf = i => PADX + (i / (n - 1)) * (W - PADX * 2);
  const yOf = c => PADT + (1 - c / maxDay) * CH;
  const pts = days.map((d, i) => ({ x: xOf(i), y: yOf(d.count), ...d }));

  let path = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const cx = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    path += ` C${cx},${pts[i - 1].y.toFixed(1)} ${cx},${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
  }
  const baseY = (PADT + CH).toFixed(1);
  const fill = `${path} L${pts[n - 1].x.toFixed(1)},${baseY} L${pts[0].x.toFixed(1)},${baseY} Z`;
  const grid = [0.25, 0.5, 0.75].map(p =>
    `<line x1="${PADX}" y1="${(PADT + (1 - p) * CH).toFixed(1)}" x2="${W - PADX}" y2="${(PADT + (1 - p) * CH).toFixed(1)}" class="lc-grid"/>`).join('');
  const labels = pts.map((p, i) => (p.isToday || i % 5 === 0)
    ? `<text x="${p.x.toFixed(1)}" y="${(PADT + CH + 16).toFixed(1)}" text-anchor="middle" class="lc-label${p.isToday ? ' today' : ''}">${p.label}</text>` : '').join('');
  const dots = pts.map((p, i) => (p.count || p.isToday)
    ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.isToday ? 4 : 3.5}" class="lc-dot" data-pt="${i}"/>
       <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="13" fill="transparent" class="lc-hit" data-pt="${i}" data-label="${h(p.label)}" data-count="${p.count}"/>` : '').join('');

  return `<svg viewBox="0 0 ${W} ${PADT + CH + AXH}" width="100%" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="lc-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity=".22"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity=".01"/>
    </linearGradient></defs>
    ${grid}<path d="${fill}" fill="url(#lc-grad)"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}</svg>`;
}

function _wireChartTooltip(panel) {
  const chart = panel.querySelector('.line-chart');
  if (!chart) return;
  let tip = null, pinned = null;
  const getTip = () => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'lc-tooltip'; document.body.appendChild(tip); }
    return tip;
  };
  const show = (e, el) => {
    const t = getTip();
    t.textContent = `${el.dataset.label}　${el.dataset.count} 次`;
    t.classList.add('on');
    const r = t.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(e.clientX - r.width / 2, window.innerWidth - r.width - 8)) + 'px';
    t.style.top = Math.max(8, e.clientY - r.height - 12) + 'px';
  };
  const hide = () => { if (!pinned) tip?.classList.remove('on'); };
  chart.addEventListener('mouseover', e => { const el = e.target.closest('.lc-hit'); if (el) show(e, el); });
  chart.addEventListener('mouseout', e => { if (e.target.closest('.lc-hit')) hide(); });
  chart.addEventListener('click', e => {
    const el = e.target.closest('.lc-hit');
    if (!el) { pinned = null; tip?.classList.remove('on'); return; }
    if (pinned === el.dataset.label) { pinned = null; tip?.classList.remove('on'); }
    else { pinned = el.dataset.label; show(e, el); }         // pin（C62）
  });
}
