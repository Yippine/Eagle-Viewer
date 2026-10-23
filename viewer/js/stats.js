'use strict';
/* ── stats.js  ▸  統計中心（雙子頁籤：📊 總覽 / 🕐 觀看記錄）────────── */

import { state }                        from './state.js';
import { h, KIND_ICON, fmtDuration, encodePath } from './utils.js';
import { deleteHistoryEntry, clearAllViews } from './api.js';

let _statsTab = 'overview'; // 'overview' | 'history'

/* ── 主渲染（總覽 + 觀看記錄各自填充）──────────────────────────── */
export function renderStatsPanel() {
  const allIds   = new Set(state.ALL.map(i => i.id));
  const viewList = Object.entries(state.VIEWS).map(([id, rec]) => ({
    id, name: rec.name || id, domain: rec.domain || '',
    views: rec.views || 0, history: rec.history || [],
    last: rec.last_viewed || '', deleted: !allIds.has(id),
    item: state.ALL.find(x => x.id === id) || null,
    total_watch_time: rec.total_watch_time || 0,
  })).sort((a, b) => b.views - a.views);

  const overviewEl = document.getElementById('sp-body');
  const historyEl  = document.getElementById('sp-body-history');

  if (overviewEl) overviewEl.innerHTML =
    _renderSummarySection(viewList) +
    _renderAnalysisSection(viewList);

  if (historyEl) historyEl.innerHTML =
    _renderHistorySection(viewList);

  // 切到當前 tab
  _applyInnerTab(_statsTab);
}

/* ── Inner tab 切換 ──────────────────────────────────────────────── */
export function switchStatsTab(tab) {
  _statsTab = tab;
  _applyInnerTab(tab);
}

function _applyInnerTab(tab) {
  document.querySelectorAll('.sp-inner-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.inner === tab));
  const overviewEl = document.getElementById('sp-body');
  const historyEl  = document.getElementById('sp-body-history');
  if (overviewEl) overviewEl.hidden = (tab !== 'overview');
  if (historyEl)  historyEl.hidden  = (tab !== 'history');
}

/* ── 相對時間格式化 ──────────────────────────────────────────────── */
function _relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const sec  = Math.floor(diff / 1000);
  if (sec <  60)  return '剛剛';
  const min  = Math.floor(sec  / 60);
  if (min <  60)  return `${min} 分鐘前`;
  const hr   = Math.floor(min  / 60);
  if (hr  <  24)  return `${hr} 小時前`;
  const day  = Math.floor(hr   / 24);
  if (day <   7)  return `${day} 天前`;
  if (day <  30)  return `${Math.floor(day / 7)} 週前`;
  if (day < 365)  return `${Math.floor(day / 30)} 個月前`;
  return `${Math.floor(day / 365)} 年前`;
}

/* ── 摘要數字（常駐頂部）────────────────────────────────────────── */
function _renderSummarySection(viewList) {
  const totalViews  = viewList.reduce((s, v) => s + v.views, 0);
  const totalTime   = viewList.reduce((s, v) => s + (v.total_watch_time || 0), 0);
  const uniqueItems = viewList.length;
  const timeFontSz  = totalTime >= 3600 ? '18px' : totalTime >= 60 ? '20px' : '24px';
  return `
    <div class="sp-summary">
      <div class="sp-stat"><div class="sv">${totalViews}</div><div class="sl">總觀看次數</div></div>
      <div class="sp-stat"><div class="sv">${uniqueItems}</div><div class="sl">已觀看項目</div></div>
      <div class="sp-stat"><div class="sv" style="font-size:${timeFontSz}">${fmtDuration(totalTime) || '0秒'}</div><div class="sl">總停留時間</div></div>
    </div>`;
}

/* ── 分析圖表（總覽頁）──────────────────────────────────────────── */
function _renderAnalysisSection(viewList) {
  if (!viewList.length) return '';

  // 近 30 天每日趨勢
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const dt = new Date(Date.now() - d * 86400000);
    days.push({
      key:     dt.toISOString().slice(0, 10),
      label:   `${dt.getMonth() + 1}/${dt.getDate()}`,
      isToday: d === 0,
      count:   0,
    });
  }
  const dMap = {}; days.forEach(d => { dMap[d.key] = d; });
  viewList.forEach(v => v.history.forEach(hh => {
    const k = hh.t ? hh.t.slice(0, 10) : '';
    if (dMap[k]) dMap[k].count++;
  }));
  const maxDay = Math.max(1, ...days.map(d => d.count));

  // 資料夾分佈（用 state.folderMap）
  const folderViews = {};
  viewList.forEach(v => {
    if (!v.item) return;
    (v.item.folders || []).forEach(fid => {
      const fname = state.folderMap?.[fid]?.name || fid;
      folderViews[fname] = (folderViews[fname] || 0) + v.views;
    });
  });
  const folderRows = Object.entries(folderViews).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxFV = Math.max(1, folderRows[0]?.[1] || 1);
  const top10 = viewList.slice(0, 10);

  // 近 30 天折線圖（SVG）
  const lineChart = _renderLineChart(days, maxDay);

  const folderSection = folderRows.length ? `
    <div class="sp-h">資料夾觀看分佈</div>
    <div class="bar-chart">
      ${folderRows.map(([name, c]) => `
        <div class="bc-row">
          <div class="bc-label" title="${h(name)}">${h(name)}</div>
          <div class="bc-track"><div class="bc-fill" style="width:${Math.round(c / maxFV * 100)}%"></div></div>
          <div class="bc-val">${c}</div>
        </div>`).join('')}
    </div>` : '';

  return `
    <div class="sp-h">TOP 10 最常觀看</div>
    <div class="sp-items">
      ${top10.map((v, i) => _spItem(v, i + 1)).join('')}
      ${top10.length === 0 ? '<div style="color:var(--text3);font-size:13px;padding:0 20px">尚無觀看紀錄</div>' : ''}
    </div>

    <div class="sp-h">近 30 天趨勢</div>
    <div class="line-chart-wrap">${lineChart}</div>

    ${folderSection}`;
}

/* ── 觀看記錄（子頁籤）──────────────────────────────────────────── */
function _renderHistorySection(viewList) {
  // 同天同影片合併為一筆（Netflix/Spotify 模式），不同天各自一筆
  const events = [];
  viewList.forEach(v => {
    if (v.history?.length) {
      const byDay = new Map();
      v.history.forEach(hEntry => {
        const day = hEntry.t ? hEntry.t.slice(0, 10) : '';
        if (!byDay.has(day)) byDay.set(day, { t: hEntry.t, dur: 0, dayCount: 0 });
        const e = byDay.get(day);
        e.dur += hEntry.d || 0;
        e.dayCount++;
        if (new Date(hEntry.t) > new Date(e.t)) e.t = hEntry.t; // 保留最新時間
      });
      byDay.forEach(({ t, dur, dayCount }) => events.push({ ...v, t, dur, dayCount }));
    } else if (v.views > 0 && v.last) {
      events.push({ ...v, t: v.last, dur: 0, dayCount: 1 });
    }
  });
  events.sort((a, b) => new Date(b.t) - new Date(a.t));

  if (!events.length) return `
    <div class="sp-hist-toolbar" style="padding:12px 20px 0">
      <span class="sp-hist-total">共 0 筆</span>
    </div>
    <div style="color:var(--text3);font-size:14px;padding:32px 20px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">🎬</div>
      尚無觀看紀錄<br>
      <span style="font-size:12px">點擊任何影片或連結即可開始記錄</span>
    </div>`;

  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // 以日期分組（不限筆數）
  const groups = new Map();
  events.forEach(e => {
    const date  = e.t ? e.t.slice(0, 10) : '';
    const label = date === today ? '今天' : date === yest ? '昨天'
                : date ? new Date(date + 'T00:00').toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' })
                : '較早之前';
    if (!groups.has(label)) groups.set(label, { date, items: [] });
    groups.get(label).items.push(e);
  });

  let html = `
    <div class="sp-hist-toolbar">
      <div class="sp-hist-search-wrap">
        <span class="sp-hist-search-icon">🔍</span>
        <input id="sp-hist-search" class="sp-hist-search" type="search" placeholder="搜尋觀看記錄…" oninput="filterHistoryDisplay(this.value)">
      </div>
      <span class="sp-hist-total" id="sp-hist-count">${events.length} 筆</span>
      <button class="sp-clear-btn" onclick="clearAllHistory()">清除全部</button>
    </div>`;

  for (const [label, { date, items }] of groups) {
    html += `
      <div class="sp-hist-day-hdr">
        <span>${label}</span>
        <button class="sp-day-del-btn" title="清除這天的記錄" onclick="clearDayHistory('${h(date)}')">清除這天</button>
      </div>
      <div class="sp-items sp-hist-group" data-date="${h(date)}">`;
    items.forEach(e => {
      const timeStr = e.t ? new Date(e.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
      const relStr  = _relTime(e.t);
      const isVideo = e.item?.file && e.item?.media_type === 'video';
      const isImage = e.item?.file && e.item?.media_type === 'image';
      const total   = e.views || 0;
      const durStr  = fmtDuration(e.dur);
      const thumbSrc = e.item?.thumb ? `/${encodePath(e.item.thumb)}`
                     : (e.item?.file && isImage) ? `/${encodePath(e.item.file)}`
                     : null;
      let thumb;
      if (thumbSrc) {
        thumb = `<div class="sp-hist-thumb">
          <img src="${thumbSrc}" alt="" loading="lazy">
          <div class="sp-hist-play-overlay">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
        </div>`;
      } else {
        thumb = `<div class="sp-hist-thumb-ph">${KIND_ICON[e.item?.kind || 'other']}</div>`;
      }

      let clickAttr = '';
      if (isVideo)          clickAttr = `onclick="_playVideoItem('${h(e.id)}')"`;
      else if (isImage)     clickAttr = `onclick="_openImageItem('${h(e.id)}')"`;
      else if (e.item?.url) clickAttr = `onclick="trackView(_lookupItem('${h(e.id)}'));_openUrl('${h(e.item.url)}')"`;

      const nameStr   = h(e.name) + (e.deleted ? '<span class="badge-del">已刪除</span>' : '');
      const dayCount  = e.dayCount || 1;

      html += `<div class="sp-hist-item" ${clickAttr} style="${clickAttr ? '' : 'cursor:default'}"
               data-del-id="${h(e.id)}" data-del-t="${h(e.t)}" data-name="${h(e.name.toLowerCase())}">
        ${thumb}
        <div class="sp-hist-info">
          <div class="sp-hist-name">${nameStr}</div>
          <div class="sp-hist-meta">
            ${dayCount > 1 ? `<span class="sp-hist-views">▶ ${dayCount}次</span><span class="dot">·</span>` : ''}
            ${durStr ? `<span class="sp-watch-dur">⏱ ${durStr}</span><span class="dot">·</span>` : ''}
            <span class="sp-hist-time" title="${timeStr}">${relStr}</span>
          </div>
        </div>
        <button class="sp-hist-del" title="刪除此紀錄" onclick="event.stopPropagation();_delHistItem(this)">✕</button>
      </div>`;
    });
    html += '</div>';
  }
  return html;
}

function _spItem(v, rank) {
  const _tSrc   = v.item?.thumb ? `/${encodePath(v.item.thumb)}`
                : (v.item?.file && v.item?.media_type === 'image') ? `/${encodePath(v.item.file)}`
                : null;
  const isVideo = v.item?.file && v.item?.media_type === 'video';
  const isImage = v.item?.file && v.item?.media_type === 'image';
  const del     = v.deleted ? `<span class="badge-del">已刪除</span>` : '';
  const durStr  = v.total_watch_time > 0 ? `<span class="sp-watch-dur">⏱ ${fmtDuration(v.total_watch_time)}</span>` : '';

  const thumb = _tSrc
    ? `<div class="sp-hist-thumb">
        <img src="${_tSrc}" alt="" loading="lazy">
        <div class="sp-top-rank">${rank}</div>
        <div class="sp-hist-play-overlay"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>`
    : `<div class="sp-hist-thumb-ph" style="position:relative">
        ${KIND_ICON[v.item?.kind || 'other']}
        <div class="sp-top-rank">${rank}</div>
      </div>`;

  let ca;
  if (isVideo)          ca = `onclick="_playVideoItem('${h(v.id)}')" style="cursor:pointer"`;
  else if (isImage)     ca = `onclick="_openImageItem('${h(v.id)}')" style="cursor:pointer"`;
  else if (v.item?.url) ca = `onclick="_openUrl('${h(v.item.url)}');trackView(_lookupItem('${h(v.id)}'))" style="cursor:pointer"`;
  else                  ca = 'style="cursor:default"';

  return `<div class="sp-hist-item" ${ca}>
    ${thumb}
    <div class="sp-hist-info">
      <div class="sp-hist-name">${h(v.name)}${del}</div>
      <div class="sp-hist-meta">
        <span class="sp-hist-views">👁 ${v.views}次</span>
        ${durStr ? `<span class="dot">·</span>${durStr}` : ''}
      </div>
    </div>
  </div>`;
}

/* ── 歷史紀錄操作（供 HTML onclick 呼叫）────────────────────────── */
export function delHistItem(btn) {
  const row = btn.closest('[data-del-id]'); if (!row) return;
  deleteHistoryEntry(row.dataset.delId, row.dataset.delT).then(() => renderStatsPanel());
}

export async function clearAllHistory() {
  if (!confirm('確定要清除全部觀看紀錄嗎？此動作無法復原。')) return;
  await clearAllViews();
  renderStatsPanel();
}

export async function clearDayHistory(date) {
  if (!date || !confirm(`確定要清除 ${date} 的所有觀看紀錄嗎？`)) return;
  // 找出該天的所有記錄並逐一刪除
  const events = [];
  Object.entries(state.VIEWS).forEach(([id, rec]) => {
    (rec.history || []).forEach(hh => {
      if (hh.t && hh.t.slice(0, 10) === date) events.push({ id, t: hh.t });
    });
  });
  await Promise.all(events.map(e => deleteHistoryEntry(e.id, e.t)));
  renderStatsPanel();
}

/* ── 近 30 天 SVG 折線圖 ─────────────────────────────────────────── */
function _renderLineChart(days, maxDay) {
  const W = 500, PAD_X = 10, PAD_TOP = 14, AXIS_H = 22;
  const chartH  = 100; // 折線繪圖區高度
  const totalH  = PAD_TOP + chartH + AXIS_H;
  const usableW = W - PAD_X * 2;
  const n       = days.length;

  const xOf = i  => PAD_X + (i / (n - 1)) * usableW;
  const yOf = c  => PAD_TOP + (1 - (maxDay > 0 ? c / maxDay : 0)) * chartH;

  // 平滑貝茲曲線路徑
  const pts = days.map((d, i) => ({ x: xOf(i), y: yOf(d.count), ...d }));
  let linePath = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const cpx = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    linePath += ` C${cpx},${pts[i-1].y.toFixed(1)} ${cpx},${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
  }
  const baseY  = (PAD_TOP + chartH).toFixed(1);
  const fillPath = `${linePath} L${pts[n-1].x.toFixed(1)},${baseY} L${pts[0].x.toFixed(1)},${baseY} Z`;

  // 格線（25% / 50% / 75%）
  const gridLines = [0.25, 0.5, 0.75].map(p => {
    const gy = (PAD_TOP + (1 - p) * chartH).toFixed(1);
    return `<line x1="${PAD_X}" y1="${gy}" x2="${W - PAD_X}" y2="${gy}" class="lc-grid"/>`;
  }).join('');

  // X 軸標籤（每 5 天 + 今天）
  const axisY = (PAD_TOP + chartH + 16).toFixed(1);
  const axisLabels = pts.map((p, i) => {
    if (!p.isToday && i % 5 !== 0) return '';
    return `<text x="${p.x.toFixed(1)}" y="${axisY}" text-anchor="middle"
      class="lc-label${p.isToday ? ' lc-today' : ''}">${p.label}</text>`;
  }).join('');

  // 數據點（只畫有資料的點 + 今天固定畫）+ hover 觸控區（透明大圓）
  const dots = pts.map((p, i) => {
    if (!p.count && !p.isToday) return '';
    const r   = p.isToday ? '4' : '3.5';
    const cls = `lc-dot${p.isToday ? ' lc-dot-today' : ''}`;
    const hit = `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="14"
      fill="transparent" class="lc-hit" data-pt="${i}"
      data-label="${h(p.label)}" data-count="${p.count}"
      onmouseenter="showLcTooltip(event,this)" onmouseleave="hideLcTooltip()"
      onpointerup="toggleLcTooltip(event,this)"/>`;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" class="${cls}" data-pt="${i}"/>${hit}`;
  }).join('');

  return `<svg class="lc-svg" viewBox="0 0 ${W} ${totalH}" width="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="lc-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity=".22"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity=".01"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${fillPath}" fill="url(#lc-grad)"/>
    <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2.2"
          stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${axisLabels}
  </svg>`;
}

/* ── 折線圖 Tooltip（桌機 hover / 手機 tap）─────────────────────── */
let _lcShownByHover = false; // 防止 mobile mouseenter → pointerup 雙觸發
let _lcPinnedRef = null;    // 桌機 click pin：記錄 pinned 的 label，null = 未 pin

function _lcResetDots() {
  document.querySelectorAll('.lc-dot').forEach(d => {
    d.setAttribute('r', d.classList.contains('lc-dot-today') ? '4' : '3.5');
  });
}

function _getLcTooltip() {
  let tip = document.getElementById('lc-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'lc-tooltip';
    tip.className = 'lc-tooltip';
    document.body.appendChild(tip);
    // 點擊其他地方 → 解除 pin 並關閉
    document.addEventListener('click', e => {
      if (!e.target.classList.contains('lc-hit')) {
        _lcPinnedRef = null;
        hideLcTooltip();
      }
    }, { capture: true });
  }
  return tip;
}

export function showLcTooltip(e, el) {
  _lcShownByHover = true;
  const tip = _getLcTooltip();
  const label = el.dataset.label, count = el.dataset.count;
  tip.textContent = `${label}　${count} 次`;
  tip.dataset.ref = label;
  tip.classList.add('on');
  _posLcTooltip(tip, e);
  // 先重置所有點，再高亮目標點（確保只有一個點放大）
  _lcResetDots();
  const svg = el.closest('svg');
  const dot = svg?.querySelector(`.lc-dot[data-pt="${el.dataset.pt}"]`);
  if (dot) dot.setAttribute('r', '5.5');
}

export function hideLcTooltip() {
  if (_lcPinnedRef) return; // pin 狀態：mouseleave 不關閉
  _lcShownByHover = false;
  const tip = document.getElementById('lc-tooltip');
  if (!tip) return;
  tip.classList.remove('on');
  _lcResetDots();
}

export function toggleLcTooltip(e, el) {
  e.stopPropagation();

  if (e.pointerType === 'mouse') {
    // 桌機 click：toggle pin
    if (_lcPinnedRef === el.dataset.label) {
      // 再次點擊同一個點 → 解除 pin 並強制關閉
      _lcPinnedRef = null;
      _lcShownByHover = false;
      const tip = document.getElementById('lc-tooltip');
      if (tip) tip.classList.remove('on');
      _lcResetDots();
    } else {
      // 第一次點擊 → pin 住（mouseenter 已 show tooltip）
      _lcPinnedRef = el.dataset.label;
    }
    return;
  }

  // 手機 touch：mouseenter 已先顯示 → 略過，保留顯示
  if (_lcShownByHover) { _lcShownByHover = false; return; }
  const tip = _getLcTooltip();
  const isOn = tip.classList.contains('on') && tip.dataset.ref === el.dataset.label;
  if (isOn) { hideLcTooltip(); return; }
  showLcTooltip(e, el);
}

function _posLcTooltip(tip, e) {
  tip.style.left = '0'; tip.style.top = '0'; // reset
  const rect = tip.getBoundingClientRect();
  let x = e.clientX - rect.width / 2;
  let y = e.clientY - rect.height - 12;
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  if (y < 8) y = e.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
}

export function filterHistoryDisplay(query) {
  const q = (query || '').trim().toLowerCase();
  const countEl = document.getElementById('sp-hist-count');
  let visible = 0;

  document.querySelectorAll('#sp-body-history .sp-hist-item').forEach(el => {
    const name = el.dataset.name || '';
    const show = !q || name.includes(q);
    el.hidden = !show;
    if (show) visible++;
  });

  // 隱藏空群組 header
  document.querySelectorAll('#sp-body-history .sp-hist-group').forEach(group => {
    const hasVisible = [...group.querySelectorAll('.sp-hist-item')].some(el => !el.hidden);
    const hdr = group.previousElementSibling;
    if (hdr?.classList.contains('sp-hist-day-hdr')) hdr.hidden = !hasVisible;
    group.hidden = !hasVisible;
  });

  if (countEl) countEl.textContent = q ? `${visible} 筆（篩選中）` : `${visible} 筆`;
}
