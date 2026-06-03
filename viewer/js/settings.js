'use strict';
/* ── settings.js  ▸  統一設定面板（⚙ 4-tab: 📊統計/🔔通知/🏷同步/🔧偏好）
 *   t042 w022-dev：整合原 openStats()/notif-panel/openSettingsPanel()
 *   面板 DOM 節點：#stats-panel（右滑出側邊面板）+ #stats-backdrop
 * ─────────────────────────────────────────────────────────────────── */

import { state }          from './state.js';
import { h }              from './utils.js';
import { renderStatsPanel } from './stats.js';
import { seeds, seedIdx, setSeedIdx, getMaxSeeds, DEFAULT_MAX_SEEDS, updateSeedNav } from './shuffle.js';
import * as Shuffle from './shuffle.js';

let _settingsTab            = 'notif';  // 預設：通知（最時間敏感）
let _settingsHistoryPushed  = false;

const _TABS = ['notif', 'stats', 'prefs'];

/* ── Open / Close ────────────────────────────────────────────────── */
export function openSettingsPanel(tab = null) {
  const targetTab = tab ?? _settingsTab;
  _settingsTab    = targetTab;

  const panel = document.getElementById('stats-panel');
  const bd    = document.getElementById('stats-backdrop');
  if (!panel) return;

  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    bd?.classList.add('open');
    history.pushState({ overlay: 'settings' }, '');
    _settingsHistoryPushed = true;
  }

  _switchTabUI(targetTab);
}

export function closeSettingsPanel(fromPopstate = false) {
  const panel = document.getElementById('stats-panel');
  if (!panel?.classList.contains('open')) return;
  panel.classList.remove('open');
  document.getElementById('stats-backdrop')?.classList.remove('open');
  if (!fromPopstate && _settingsHistoryPushed) history.back();
  _settingsHistoryPushed = false;
}

/* ── Tab Switching ───────────────────────────────────────────────── */
export function switchSettingsTab(tab) {
  _settingsTab = tab;
  _switchTabUI(tab);
}

function _switchTabUI(tab) {
  // 更新外層 tab buttons（st-tab class）
  document.querySelectorAll('.st-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));

  // 顯示 / 隱藏 panes
  _TABS.forEach(t => {
    const el = document.getElementById(`sp-pane-${t}`);
    if (el) el.hidden = (t !== tab);
  });

  // 各 tab 的後置動作
  if (tab === 'notif')  _activateNotifPane();
  if (tab === 'stats')  _activateStatsPane();
  if (tab === 'prefs')  _activatePrefsPane();
}

/* ── Stats Pane ──────────────────────────────────────────────────── */
async function _activateStatsPane() {
  const body = document.getElementById('sp-body');
  if (!body) return;
  body.innerHTML = '<div class="sp-loading"><div class="spin"></div><span>載入中…</span></div>';
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 4000);
    const res  = await fetch(`/api/views?lib=${encodeURIComponent(state.activeLib)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (res.ok) state.VIEWS = await res.json();
  } catch (_) {}
  renderStatsPanel();
}

/* ── Notif Pane ──────────────────────────────────────────────────── */
function _activateNotifPane() {
  // 開啟時清除 ok/loading 的 unread badge（error 保留以提醒使用者）
  // 透過 window._notifOnTabOpen 呼叫（避免循環 import）
  window._notifOnTabOpen?.();
}

/* ── Folder Tags Sync ────────────────────────────────────────────── */
export async function folderTagsDiff() {
  const btn    = document.getElementById('folder-tags-diff-btn');
  const diffEl = document.getElementById('folder-tags-diff');
  if (btn) { btn.disabled = true; btn.textContent = '載入中…'; }
  try {
    const res = await fetch(`/api/tags-sync/diff?lib=${encodeURIComponent(state.activeLib)}`);
    const d   = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    _renderDiff(diffEl, d.changes, d.total);
    document.getElementById('folder-tags-apply-btn').disabled = !d.changes?.length;
  } catch (e) {
    if (diffEl) diffEl.innerHTML = `<p class="diff-err">載入失敗：${h(String(e.message))}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '預覽'; }
  }
}

export async function folderTagsApply() {
  const btn    = document.getElementById('folder-tags-apply-btn');
  const diffEl = document.getElementById('folder-tags-diff');
  if (btn) { btn.disabled = true; btn.textContent = '套用中…'; }
  try {
    const res = await fetch('/api/tags-sync/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    if (diffEl) diffEl.innerHTML = `<p class="diff-ok">✓ 已套用 ${d.applied} 筆變更</p>`;
    if (btn) btn.textContent = '套用';
  } catch (e) {
    if (diffEl) diffEl.innerHTML = `<p class="diff-err">套用失敗：${h(String(e.message))}</p>`;
    if (btn) { btn.disabled = false; btn.textContent = '套用'; }
  }
}

/* ── Items Tags Sync ─────────────────────────────────────────────── */
export async function itemsTagsDiff() {
  const btn    = document.getElementById('items-tags-diff-btn');
  const diffEl = document.getElementById('items-tags-diff');
  if (btn) { btn.disabled = true; btn.textContent = '載入中…'; }
  try {
    const res = await fetch(`/api/items-tags-sync/diff?lib=${encodeURIComponent(state.activeLib)}`);
    const d   = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    _renderDiff(diffEl, d.changes, d.total);
    document.getElementById('items-tags-apply-btn').disabled = !d.changes?.length;
  } catch (e) {
    if (diffEl) diffEl.innerHTML = `<p class="diff-err">載入失敗：${h(String(e.message))}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '預覽'; }
  }
}

export async function itemsTagsApply() {
  const btn    = document.getElementById('items-tags-apply-btn');
  const diffEl = document.getElementById('items-tags-diff');
  if (btn) { btn.disabled = true; btn.textContent = '套用中…'; }
  try {
    const res = await fetch('/api/items-tags-sync/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    if (diffEl) diffEl.innerHTML = `<p class="diff-ok">✓ 已套用 ${d.applied} 筆變更</p>`;
    if (btn) btn.textContent = '套用';
  } catch (e) {
    if (diffEl) diffEl.innerHTML = `<p class="diff-err">套用失敗：${h(String(e.message))}</p>`;
    if (btn) { btn.disabled = false; btn.textContent = '套用'; }
  }
}

/* ── Diff renderer ───────────────────────────────────────────────── */
function _renderDiff(container, changes, total) {
  if (!container) return;
  if (!changes?.length) {
    container.innerHTML = '<p class="diff-ok">✓ 標籤已同步，無需變更</p>';
    return;
  }
  const items = changes.slice(0, 60).map(c => {
    const cur = c.current_tags  || [];
    const exp = c.expected_tags || [];
    const removed = cur.filter(t => !exp.includes(t));
    const added   = exp.filter(t => !cur.includes(t));
    const chips = [
      ...removed.map(t => `<span class="diff-chip diff-chip-remove">−${h(t)}</span>`),
      ...added.map(t =>   `<span class="diff-chip diff-chip-add">+${h(t)}</span>`),
    ].join('');
    return `<div class="diff-card">
      <span class="diff-name">${h(c.name || c.id)}</span>
      <div class="diff-chips">${chips}</div>
    </div>`;
  }).join('');
  const more = total > 60 ? `<p class="diff-more">…還有 ${total - 60} 筆</p>` : '';
  container.innerHTML = `<div class="diff-list">${items}</div>${more}`;
}

/* ── Prefs Pane（t045 w024-dev）────────────────────────────────────── */
function _activatePrefsPane() {
  // 同步 select 顯示當前設定值
  const sel = document.getElementById('pref-max-seeds');
  if (sel) sel.value = String(getMaxSeeds());
  // 重置同步 UI（原 _resetSyncPane，現整合於偏好）
  const fDiff  = document.getElementById('folder-tags-diff');
  const iDiff  = document.getElementById('items-tags-diff');
  const fApply = document.getElementById('folder-tags-apply-btn');
  const iApply = document.getElementById('items-tags-apply-btn');
  if (fDiff)  fDiff.innerHTML = '';
  if (iDiff)  iDiff.innerHTML = '';
  if (fApply) fApply.disabled = true;
  if (iApply) iApply.disabled = true;
  // 更新 seed 導航與歷史
  updateSeedNav();
  _renderSeedHistory();
}

function _renderSeedHistory() {
  const container = document.getElementById('pref-seed-history');
  if (!container) return;
  const ss = Shuffle.seeds;
  if (!ss.length) {
    container.innerHTML = '<p style="color:var(--text3);font-size:13px;margin-top:6px">今日尚無隨機排列記錄</p>';
    return;
  }
  const chips = ss.map((seed, i) => {
    const isActive = i === Shuffle.seedIdx;
    return `<button class="seed-hist-chip${isActive ? ' on' : ''}" title="Seed: ${seed}" onclick="jumpToSeed(${i})">${i + 1}</button>`;
  }).join('');
  container.innerHTML = `<div class="seed-hist-chips">${chips}</div>`;
}

export function setPrefMaxSeeds(val) {
  localStorage.setItem('eagle-pref-max-seeds', String(parseInt(val, 10) || DEFAULT_MAX_SEEDS));
}

export function clearShuffleHistory() {
  // 清除今日 seeds localStorage，重置狀態
  const today = new Date().toISOString().slice(0, 10);
  localStorage.removeItem(`eagle-seeds-${today}`);
  Shuffle.seeds.length = 0;
  Shuffle.setSeedIdx(-1);
  updateSeedNav();
  _renderSeedHistory();
}

export function jumpToSeed(idx) {
  setSeedIdx(idx);
  updateSeedNav();
  _renderSeedHistory();
  // 觸發 grid 重新排列（透過 window.applyFilter，避免循環 import）
  window.applyFilter?.();
}
