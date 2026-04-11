'use strict';
/* ── stats.js  ▸  觀看統計面板（歷史紀錄 Tab + 統計分析 Tab）───────────── */

import { state }                        from './state.js';
import { h, KIND_ICON, fmtDuration }    from './utils.js';
import { deleteHistoryEntry, clearAllViews } from './api.js';
import { mpCommitDuration }             from './player-mobile.js';
import { dpCommitDuration }             from './player-desktop.js';

let _statsTab = 'history';

/* ── 開啟 / 關閉 ─────────────────────────────────────────────────── */
let _statsHistoryPushed = false;

export async function openStats() {
  mpCommitDuration();
  dpCommitDuration();
  document.getElementById('stats-panel').classList.add('open');
  document.getElementById('stats-backdrop').classList.add('open');
  history.pushState({ overlay: 'stats' }, '');
  _statsHistoryPushed = true;
  document.getElementById('sp-body').innerHTML =
    '<div class="sp-loading"><div class="spin"></div><span>載入中…</span></div>';
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 4000);
    const res  = await fetch('/api/views', { signal: ctrl.signal });
    clearTimeout(tid);
    if (res.ok) state.VIEWS = await res.json();
  } catch (_) {}
  renderStatsPanel();
}

export function closeStats(fromPopstate = false) {
  if (!document.getElementById('stats-panel').classList.contains('open')) return;
  document.getElementById('stats-panel').classList.remove('open');
  document.getElementById('stats-backdrop').classList.remove('open');
  if (!fromPopstate && _statsHistoryPushed) history.back();
  _statsHistoryPushed = false;
}

export function switchStatsTab(tab) {
  _statsTab = tab;
  document.querySelectorAll('.sp-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  renderStatsPanel();
}

/* ── 主渲染 ──────────────────────────────────────────────────────── */
export function renderStatsPanel() {
  const allIds   = new Set(state.ALL.map(i => i.id));
  const viewList = Object.entries(state.VIEWS).map(([id, rec]) => ({
    id, name: rec.name || id, domain: rec.domain || '',
    views: rec.views || 0, history: rec.history || [],
    last: rec.last_viewed || '', deleted: !allIds.has(id),
    item: state.ALL.find(x => x.id === id) || null,
    total_watch_time: rec.total_watch_time || 0,
  })).sort((a, b) => b.views - a.views);

  document.getElementById('sp-body').innerHTML =
    _statsTab === 'history' ? _renderHistoryTab(viewList) : _renderStatsTab(viewList);
}

/* ── 歷史紀錄 Tab ────────────────────────────────────────────────── */
function _renderHistoryTab(viewList) {
  const events = [];
  viewList.forEach(v => {
    if (v.history?.length) v.history.forEach(hEntry => events.push({ ...v, t: hEntry.t, dur: hEntry.d || 0 }));
    else if (v.views > 0 && v.last) events.push({ ...v, t: v.last, dur: 0 });
  });
  events.sort((a, b) => new Date(b.t) - new Date(a.t));

  if (!events.length) return `
    <div style="color:var(--text3);font-size:14px;padding:48px 0;text-align:center">
      <div style="font-size:40px;margin-bottom:12px">🎬</div>
      尚無觀看紀錄<br>
      <span style="font-size:12px">點擊任何影片或連結即可開始記錄</span>
    </div>`;

  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const groups = new Map();
  events.slice(0, 100).forEach(e => {
    const date  = e.t ? e.t.slice(0, 10) : '';
    const label = date === today ? '今天' : date === yest ? '昨天'
                : date ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : '較早之前';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(e);
  });

  let html = `<div class="sp-hist-toolbar">
    <span class="sp-hist-total">共 ${events.length} 筆${events.length >= 100 ? '（顯示最近 100 筆）' : ''}</span>
    <button class="sp-clear-btn" onclick="clearAllHistory()">清除全部</button>
  </div>`;

  for (const [label, items] of groups) {
    html += `<div class="sp-h">${label}</div><div class="sp-items">`;
    items.forEach(e => {
      const timeStr = e.t ? new Date(e.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
      const isVideo = e.item?.file && e.item?.media_type === 'video';
      const total   = e.views || 0;
      const durStr  = fmtDuration(e.dur);
      let thumb;
      if (e.item?.thumb) {
        thumb = `<div class="sp-hist-thumb"><img src="/${h(e.item.thumb)}" alt="" loading="lazy">
          ${isVideo ? `<div class="play-badge"><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>` : ''}
        </div>`;
      } else { thumb = `<div class="sp-hist-thumb-ph">${KIND_ICON[e.item?.kind || 'other']}</div>`; }

      let clickAttr = '';
      if (isVideo) clickAttr = `onclick="_playVideoItem('${h(e.id)}')"`;
      else if (e.item?.url) clickAttr = `onclick="trackView(_lookupItem('${h(e.id)}'));_openUrl('${h(e.item.url)}')"`;

      html += `<div class="sp-hist-item" ${clickAttr} style="${clickAttr ? '' : 'cursor:default'}"
               data-del-id="${h(e.id)}" data-del-t="${h(e.t)}">
        ${thumb}
        <div class="sp-hist-info">
          <div class="sp-hist-name">${h(e.name)}${e.deleted ? '<span class="badge-del">已刪除</span>' : ''}</div>
          <div class="sp-hist-meta">
            <span>${h(e.domain)}</span>
            ${total > 1 ? `<span class="dot">·</span><span class="sp-hist-views">👁 ${total}次</span>` : ''}
            ${durStr ? `<span class="dot">·</span><span class="sp-watch-dur">⏱ ${durStr}</span>` : ''}
            ${timeStr ? `<span class="dot">·</span><span class="sp-hist-time">${timeStr}</span>` : ''}
          </div>
        </div>
        <button class="sp-hist-del" title="刪除此紀錄" onclick="event.stopPropagation();_delHistItem(this)">✕</button>
      </div>`;
    });
    html += '</div>';
  }
  return html;
}

/* ── 統計分析 Tab ────────────────────────────────────────────────── */
function _renderStatsTab(viewList) {
  const totalViews  = viewList.reduce((s, v) => s + v.views, 0);
  const totalTime   = viewList.reduce((s, v) => s + (v.total_watch_time || 0), 0);
  const uniqueItems = viewList.length;
  const domainViews = {};
  viewList.forEach(v => { domainViews[v.domain] = (domainViews[v.domain] || 0) + v.views; });
  const topDomain = Object.entries(domainViews).sort((a, b) => b[1] - a[1])[0];

  const now = new Date(), months = [];
  for (let m = 11; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${d.getMonth() + 1}月`, count: 0, time: 0 });
  }
  const mMap = {}; months.forEach(m => { mMap[m.key] = m; });
  viewList.forEach(v => v.history.forEach(hh => {
    const k = hh.t ? hh.t.slice(0, 7) : '';
    if (mMap[k]) { mMap[k].count++; mMap[k].time += (hh.d || 0); }
  }));
  const maxMonth = Math.max(1, ...months.map(m => m.count));

  const domainRows = Object.entries(domainViews).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxDV      = Math.max(1, domainRows[0]?.[1] || 1);
  const top20      = viewList.slice(0, 20);

  return `
    <div class="sp-summary">
      <div class="sp-stat"><div class="sv">${totalViews}</div><div class="sl">總觀看次數</div></div>
      <div class="sp-stat"><div class="sv">${uniqueItems}</div><div class="sl">已觀看項目</div></div>
      <div class="sp-stat">
        <div class="sv" style="font-size:${totalTime >= 3600 ? '20px' : totalTime >= 60 ? '18px' : '22px'}">${fmtDuration(totalTime) || '0秒'}</div>
        <div class="sl">總停留時間</div>
      </div>
    </div>
    <div class="sp-summary" style="margin-top:-10px">
      <div class="sp-stat">
        <div class="sv" style="font-size:${topDomain && topDomain[0].length > 8 ? '13px' : '20px'}">${topDomain ? h(topDomain[0]) : '–'}</div>
        <div class="sl">最多看的網域</div>
      </div>
      <div class="sp-stat">
        <div class="sv" style="font-size:18px">${totalViews > 0 ? fmtDuration(Math.round(totalTime / totalViews)) : '–'}</div>
        <div class="sl">平均停留時間</div>
      </div>
      <div class="sp-stat">
        <div class="sv">${viewList.filter(v => v.total_watch_time > 0).length}</div>
        <div class="sl">有時間紀錄</div>
      </div>
    </div>

    <div class="sp-h">TOP 20 最常觀看</div>
    <div class="sp-items">
      ${top20.map((v, i) => _spItem(v, i + 1)).join('')}
      ${top20.length === 0 ? '<div style="color:var(--text3);font-size:13px">尚無觀看紀錄</div>' : ''}
    </div>

    <div class="sp-h">網域觀看分佈</div>
    <div class="bar-chart">
      ${domainRows.map(([d, c]) => `
        <div class="bc-row">
          <div class="bc-label" title="${h(d)}">${h(d)}</div>
          <div class="bc-track"><div class="bc-fill" style="width:${Math.round(c / maxDV * 100)}%"></div></div>
          <div class="bc-val">${c}</div>
        </div>`).join('')}
      ${domainRows.length === 0 ? '<div style="color:var(--text3);font-size:13px">尚無資料</div>' : ''}
    </div>

    <div class="sp-h">近 12 個月觀看趨勢</div>
    <div class="month-chart">
      ${months.map(m => `
        <div class="mc-col">
          <div class="mc-val">${m.count || ''}</div>
          <div class="mc-bar" style="height:${Math.round(m.count / maxMonth * 80)}px"></div>
          <div class="mc-label">${m.label}</div>
        </div>`).join('')}
    </div>`;
}

function _spItem(v, rank) {
  const thumb  = v.item?.thumb
    ? `<img class="sp-thumb" src="/${h(v.item.thumb)}" alt="" loading="lazy">`
    : `<div class="sp-thumb-ph">${KIND_ICON[v.item?.kind || 'other']}</div>`;
  const del    = v.deleted ? `<span class="badge-del">已刪除</span>` : '';
  const isVideo = v.item?.file && v.item?.media_type === 'video';
  const durStr  = v.total_watch_time > 0
    ? `<div style="font-size:11px;color:var(--text3)">⏱ ${fmtDuration(v.total_watch_time)}</div>` : '';
  let ca;
  if (isVideo)       ca = `onclick="_playVideoItem('${h(v.id)}')" style="cursor:pointer"`;
  else if (v.item?.url) ca = `onclick="_openUrl('${h(v.item.url)}');trackView(_lookupItem('${h(v.id)}'))" style="cursor:pointer"`;
  else               ca = 'style="cursor:default"';
  return `<div class="sp-item" ${ca}>
    <div class="sp-rank">${rank}</div>${thumb}
    <div class="sp-info">
      <div class="sp-iname">${h(v.name)}${del}</div>
      <div class="sp-idomain">${h(v.domain)}</div>
      ${durStr}
    </div>
    <div class="sp-views">${v.views}</div>
  </div>`;
}

/* ── 歷史紀錄刪除 helpers（供 HTML onclick 呼叫）────────────────── */
export function delHistItem(btn) {
  const row = btn.closest('[data-del-id]'); if (!row) return;
  deleteHistoryEntry(row.dataset.delId, row.dataset.delT).then(() => renderStatsPanel());
}

export async function clearAllHistory() {
  if (!confirm('確定要清除全部觀看紀錄嗎？此動作無法復原。')) return;
  await clearAllViews();
  renderStatsPanel();
}
