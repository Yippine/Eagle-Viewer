'use strict';
/* ── player-desktop.js  ▸  桌面沉浸式播放器 ──────────────────────────────
   鍵盤：Space=播/暫停  ←/→=±5s  ↑/↓=切換  F=全螢幕  M=靜音  Esc=關閉
   滑鼠：單擊=播/暫停  雙擊=全螢幕  滾輪=縮放  靜止3s自動隱藏UI
════════════════════════════════════════════════════════════════════════════*/

import { state }                      from './state.js';
import { seededShuffle, currentSeed } from './shuffle.js';
import { trackView }                  from './api.js';
import { fmtTime, HIDE_TAGS, encodePath } from './utils.js';
import { applyTagSet }                from './ui-filters.js';
import { vcInitVid, vcAbTimeUpdate, vcApplyTransform, closeVcPanel,
         vcSetAutoRotate, vcHasSnapshot }
  from './video-controls.js';

/* ── 播放器狀態 ────────────────────────────────────────────────────── */
const _DP = {
  items: [], idx: 0, vid: null,
  zoomWrapper: null,          // zoom 專用包裝 div
  playStart: null, sessionDur: 0,
  uiHideTimer: null, zoomScale: 1, zoomTx: 0, zoomTy: 0, zoomHideTimer: null,
  hintsTimer: null, dblTimer: null,
  dragActive: false, dragStartX: 0, dragStartY: 0, dragStartTx: 0, dragStartTy: 0,
  windowMode: 'windowed',   // 'windowed' | 'maximized' | 'fullscreen'
};
let _dpSavedScrollY = 0;

/* ── 開啟 ────────────────────────────────────────────────────────── */
export function openItemInDesktopPlayer(itemId) {
  const clicked = state.ALL.find(i => i.id === itemId);
  if (!clicked) return;
  // 清單直接取 state.filtered 的影片子序列，與卡池順序及數量完全一致
  let list = state.filtered.filter(i => i.file && i.media_type === 'video');
  let idx  = list.findIndex(i => i.id === itemId);
  if (idx === -1) {
    // fallback：項目不在當前篩選中（例如從統計面板開啟），以全庫同 domain 洗牌
    const base = state.ALL.filter(i => i.file && i.media_type === 'video' && i.domain === clicked.domain);
    list = seededShuffle(base, currentSeed());
    idx  = list.findIndex(i => i.id === itemId);
    if (idx === -1) return;
  }
  _DP.items = list; _DP.idx = idx; _DP.zoomScale = 1; _DP.zoomTx = 0; _DP.zoomTy = 0; _DP.zoomWrapper = null; _DP.windowMode = 'windowed';
  // 暫停任何正在播放的卡片縮圖影片，避免雙軌播放
  document.querySelectorAll('#grid video').forEach(v => { v.pause(); });
  const el = document.getElementById('dplayer');
  el.classList.remove('ui-hidden', 'dp-fullscreen');
  el.classList.add('open');
  document.getElementById('dplayer-backdrop').classList.add('open');
  _dpSavedScrollY = window.scrollY;
  document.body.style.overflow = 'hidden';
  history.pushState({ overlay: 'dplayer' }, '');
  _dpHistoryPushed = true;
  _dpLoad(); _dpShowHints(); _dpResetUITimer();
}

let _dpHistoryPushed = false;

export function closeDesktopPlayer(fromPopstate = false) {
  if (!document.getElementById('dplayer').classList.contains('open')) return;
  dpCommitDuration();
  closeVcPanel();
  if (_DP.vid) { _DP.vid.pause(); _DP.vid.src = ''; } _DP.vid = null; _DP.zoomWrapper = null;
  if (document.fullscreenElement === document.getElementById('dplayer'))
    document.exitFullscreen().catch(() => {});
  clearTimeout(_DP.uiHideTimer); clearTimeout(_DP.dblTimer);
  _DP.windowMode = 'windowed';
  const el = document.getElementById('dplayer');
  el.classList.remove('open', 'ui-hidden', 'dp-fullscreen');
  document.getElementById('dplayer-backdrop').classList.remove('open');
  document.body.style.overflow = '';
  if (!fromPopstate && _dpHistoryPushed) { window._skipPopstateCount = (window._skipPopstateCount || 0) + 1; history.back(); }
  _dpHistoryPushed = false;
  window.scrollTo(0, _dpSavedScrollY);
}

/* ── Duration tracking ────────────────────────────────────────────── */
export function dpAccumDur() {
  if (_DP.playStart) { _DP.sessionDur += (Date.now() - _DP.playStart) / 1000; _DP.playStart = null; }
}
export function dpCommitDuration() {
  dpAccumDur();
  if (_DP.sessionDur > 1 && _DP.items[_DP.idx]) {
    const item = _DP.items[_DP.idx];
    if (state.VIEWS[item.id]?.history?.length) {
      const last = state.VIEWS[item.id].history[state.VIEWS[item.id].history.length - 1];
      last.d = (last.d || 0) + Math.round(_DP.sessionDur);
      state.VIEWS[item.id].total_watch_time =
        (state.VIEWS[item.id].total_watch_time || 0) + Math.round(_DP.sessionDur);
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, name: item.name, domain: item.domain, duration: Math.round(_DP.sessionDur), lib: state.activeLib }),
      }).catch(() => {});
    }
  }
  _DP.sessionDur = 0; _DP.playStart = null;
}

/* ── 載入影片 ────────────────────────────────────────────────────── */
function _dpLoad() {
  const item = _DP.items[_DP.idx]; if (!item) return;
  dpCommitDuration();
  if (_DP.vid) { _DP.vid.pause(); _DP.vid.src = ''; }
  _DP.zoomScale = 1; _DP.zoomTx = 0; _DP.zoomTy = 0;
  const wrap = document.getElementById('dp-wrap');
  wrap.style.background = '#000';

  /* zoom wrapper：讓游標焦點縮放與 panel 幾何變換各自獨立 */
  const zoomWrapper = document.createElement('div');
  zoomWrapper.className = 'dp-zoom-wrapper';

  const vid = document.createElement('video');
  vid.playsInline = true; vid.autoplay = true; vid.preload = 'auto'; vid.loop = true;
  vid.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;transform-origin:center center;';
  if (item.file)  vid.src    = '/' + encodePath(item.file);
  if (item.thumb) vid.poster = '/' + encodePath(item.thumb);

  zoomWrapper.appendChild(vid);
  wrap.innerHTML = ''; wrap.appendChild(zoomWrapper);
  _DP.vid = vid; _DP.zoomWrapper = zoomWrapper;

  /* video-controls：載入此影片的濾鏡預設，重設 AB loop */
  vcInitVid(vid, item.id);

  document.getElementById('dp-title').textContent   = item.name  || item.id;
  document.getElementById('dp-domain').textContent  = item.domain || '';
  document.getElementById('dp-counter').textContent = `${_DP.idx + 1} / ${_DP.items.length}`;
  _dpResetControls();

  const linkBtn = document.getElementById('dp-link-btn');
  if (linkBtn) {
    if (item.url) { linkBtn.style.display = 'flex'; linkBtn.onclick = () => window._openUrl(item.url); }
    else            linkBtn.style.display = 'none';
  }
  const tagBtn = document.getElementById('dp-tag-btn');
  if (tagBtn) {
    const vt = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
    tagBtn.style.display = vt.length ? 'flex' : 'none';
  }
  const zi = document.getElementById('dp-zoom-ind');
  if (zi) { zi.classList.remove('show'); zi.textContent = ''; }

  vid.addEventListener('play',            () => { _DP.playStart = Date.now(); _dpSetPlayBtn(false); });
  vid.addEventListener('pause',           () => { dpAccumDur(); _dpSetPlayBtn(true); });
  vid.addEventListener('ended',           () => { dpAccumDur(); });
  vid.addEventListener('loadedmetadata',  () => _dpUpdateProgress());
  vid.addEventListener('seeked',          () => _dpUpdateProgress());
  vid.addEventListener('timeupdate',      () => { _dpUpdateProgress(); vcAbTimeUpdate(vid); });
  vid.play().catch(() => {});
  trackView(item);
}

/* ── 控制列 ──────────────────────────────────────────────────────── */
function _dpResetControls() {
  const r = document.getElementById('dp-prog-range');
  if (r) { r.value = 0; r.style.setProperty('--pct', '0%'); }
  const t = document.getElementById('dp-time');
  if (t) t.textContent = '0:00 / –:––';
  _dpSetPlayBtn(false);
}
function _dpSetPlayBtn(paused) {
  const b = document.getElementById('dp-btn-play');
  if (b) b.textContent = paused ? '▶' : '⏸';
}
function _dpUpdateProgress() {
  const vid = _DP.vid; if (!vid || !vid.duration) return;
  const pct = (vid.currentTime / vid.duration) * 100;
  const r   = document.getElementById('dp-prog-range');
  if (r) { r.value = pct; r.style.setProperty('--pct', pct.toFixed(1) + '%'); }
  const t = document.getElementById('dp-time');
  if (t) t.textContent = `${fmtTime(vid.currentTime)} / ${fmtTime(vid.duration)}`;
}

export function dpSeekTo(val) {
  if (!_DP.vid || !_DP.vid.duration) return;
  _DP.vid.currentTime = (val / 100) * _DP.vid.duration;
  const r = document.getElementById('dp-prog-range');
  if (r) r.style.setProperty('--pct', parseFloat(val).toFixed(1) + '%');
}
export function dpTogglePlay() {
  if (!_DP.vid) return;
  const flash = document.getElementById('dp-flash');
  if (_DP.vid.paused) { _DP.vid.play().catch(() => {}); if (flash) flash.textContent = '▶'; }
  else                { _DP.vid.pause();                if (flash) flash.textContent = '⏸'; }
  if (flash) {
    flash.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => flash.classList.remove('show'), 650);
  }
}
export function dpToggleMute() {
  if (!_DP.vid) return;
  _DP.vid.muted = !_DP.vid.muted;
  const b = document.getElementById('dp-vol-btn');
  if (b) b.textContent = _DP.vid.muted ? '🔇' : '🔊';
}
function _dpShowSwipeOv(text) {
  const ov = document.getElementById('dp-swipe-ov');
  if (!ov) return;
  ov.textContent = text; ov.classList.add('show');
  clearTimeout(ov._t); ov._t = setTimeout(() => ov.classList.remove('show'), 1200);
}
export function dpSwitch(dir) {
  const next = _DP.idx + dir;
  if (next < 0 || next >= _DP.items.length) {
    _dpShowSwipeOv(dir < 0 ? '已是第一部' : '已是最後一部');
    return;
  }
  _DP.idx = next; _dpLoad();
}
/* ── 三模式視窗切換：windowed → maximized → fullscreen → windowed ── */
const _FS_ICONS = {
  windowed: {
    title: '最大化 (F)',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  },
  maximized: {
    title: '完全全螢幕 (F)',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 3 3 3 3 8"/><polyline points="21 8 21 3 16 3"/><polyline points="3 16 3 21 8 21"/><polyline points="16 21 21 21 21 16"/></svg>`,
  },
  fullscreen: {
    title: '還原視窗 (F)',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`,
  },
};
export function dpCycleWindowMode() {
  const modes = ['windowed', 'maximized', 'fullscreen'];
  const next  = modes[(modes.indexOf(_DP.windowMode) + 1) % modes.length];
  _dpSetWindowMode(next);
}
function _dpSetWindowMode(mode) {
  const el = document.getElementById('dplayer');
  _DP.windowMode = mode;
  if (mode === 'windowed') {
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    el.classList.remove('dp-fullscreen');
  } else if (mode === 'maximized') {
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    el.classList.add('dp-fullscreen');
  } else {
    el.classList.add('dp-fullscreen');
    el.requestFullscreen().catch(() => {
      // 瀏覽器不支援 requestFullscreen → 維持最大化
      _DP.windowMode = 'maximized';
    });
  }
  _dpUpdateFsBtn();
}
function _dpUpdateFsBtn() {
  const btn = document.getElementById('dp-fs-btn'); if (!btn) return;
  const { svg, title } = _FS_ICONS[_DP.windowMode] || _FS_ICONS.windowed;
  btn.innerHTML = svg;
  btn.title     = title;
}
export function dpSearchByTags() {
  const item = _DP.items[_DP.idx]; if (!item) return;
  const tags = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
  closeDesktopPlayer(); applyTagSet(tags);
}

/* ── UI 自動隱藏 ──────────────────────────────────────────────────── */
function _dpResetUITimer() {
  clearTimeout(_DP.uiHideTimer);
  const el = document.getElementById('dplayer');
  el.classList.remove('ui-hidden'); el.style.cursor = '';
  _DP.uiHideTimer = setTimeout(() => {
    if (_DP.vid && !_DP.vid.paused) { el.classList.add('ui-hidden'); el.style.cursor = 'none'; }
  }, 3000);
}
function _dpShowHints() {
  const h = document.getElementById('dp-hints'); if (!h) return;
  h.classList.add('show'); clearTimeout(_DP.hintsTimer);
  _DP.hintsTimer = setTimeout(() => h.classList.remove('show'), 3500);
}

/* ── 統一套用 zoomWrapper transform ─────────────────────────────── */
function _dpApplyTransform() {
  const zw = _DP.zoomWrapper; if (!zw) return;
  if (_DP.zoomScale <= 1.005 && _DP.zoomTx === 0 && _DP.zoomTy === 0) {
    zw.style.transform = '';
  } else {
    zw.style.transform = `translate(${_DP.zoomTx.toFixed(2)}px, ${_DP.zoomTy.toFixed(2)}px) scale(${_DP.zoomScale.toFixed(3)})`;
  }
  zw.style.cursor = _DP.zoomScale > 1.005 ? 'grab' : '';
}

/* ── 滾輪縮放（游標焦點縮放 + 維持平移狀態）────────────────────── */
function _dpHandleWheel(e) {
  e.preventDefault();
  const zw = _DP.zoomWrapper; if (!zw) return;
  const oldScale = _DP.zoomScale;
  const newScale = Math.max(1, Math.min(4, oldScale + (e.deltaY < 0 ? 0.12 : -0.12)));
  if (newScale === oldScale) return;

  // 以游標為焦點縮放：維持游標下的影像點不動
  const rect = zw.getBoundingClientRect();
  const cx = e.clientX - (rect.left + rect.width  / 2);
  const cy = e.clientY - (rect.top  + rect.height / 2);
  _DP.zoomTx = cx * (1 - newScale / oldScale) + _DP.zoomTx * (newScale / oldScale);
  _DP.zoomTy = cy * (1 - newScale / oldScale) + _DP.zoomTy * (newScale / oldScale);
  _DP.zoomScale = newScale;

  if (newScale <= 1.005) { _DP.zoomScale = 1; _DP.zoomTx = 0; _DP.zoomTy = 0; }
  _dpApplyTransform();

  const zi = document.getElementById('dp-zoom-ind');
  if (zi) {
    zi.textContent = _DP.zoomScale > 1.01 ? `${Math.round(_DP.zoomScale * 100)}%` : '';
    if (_DP.zoomScale > 1.01) zi.classList.add('show'); else zi.classList.remove('show');
    clearTimeout(_DP.zoomHideTimer);
    _DP.zoomHideTimer = setTimeout(() => zi.classList.remove('show'), 1500);
  }
}

/* ── 拖曳平移 ────────────────────────────────────────────────────── */
function _dpHandleDragStart(e) {
  if (document.getElementById('modal')?.classList.contains('open')) return; // modal 打開時禁用
  if (e.target.closest('.dp-controls') || e.target.closest('.dp-topbar')) return;
  if (!_DP.zoomWrapper || e.button !== 0) return;
  _DP.dragActive = false; // 先不啟動，等移動超過閾值才啟動
  _DP.dragStartX = e.clientX; _DP.dragStartY = e.clientY;
  _DP.dragStartTx = _DP.zoomTx; _DP.dragStartTy = _DP.zoomTy;
}
function _dpHandleDragMove(e) {
  if (document.getElementById('modal')?.classList.contains('open')) return; // modal 打開時禁用
  if (_DP.dragStartX === undefined) return;
  const dx = e.clientX - _DP.dragStartX, dy = e.clientY - _DP.dragStartY;
  if (!_DP.dragActive) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // 閾值：5px 才觸發 drag
    _DP.dragActive = true;
  }
  _DP.zoomTx = _DP.dragStartTx + dx;
  _DP.zoomTy = _DP.dragStartTy + dy;
  _dpApplyTransform();
  if (_DP.zoomWrapper) _DP.zoomWrapper.style.cursor = 'grabbing';
}
function _dpHandleDragEnd() {
  if (document.getElementById('modal')?.classList.contains('open')) {
    _DP.dragActive = false;
    _DP.dragStartX = undefined;
    return;
  }
  if (_DP.dragActive) {
    _dpApplyTransform(); // 恢復 grab/default cursor
    _DP._wasDragging = true;
    setTimeout(() => { _DP._wasDragging = false; }, 0);
  }
  _DP.dragActive = false;
  _DP.dragStartX = undefined;
}

/* ── 影片區點擊（單擊=播/暫停，雙擊=全螢幕）防抖 ────────────────── */
function _dpHandleClick(e) {
  if (e.target.closest('.dp-controls') || e.target.closest('.dp-topbar')) return;
  if (_DP._wasDragging) return; // drag 結束後的 click 事件忽略
  clearTimeout(_DP.dblTimer);
  _DP.dblTimer = setTimeout(() => { _DP.dblTimer = null; dpTogglePlay(); }, 260);
}
function _dpHandleDblClick(e) {
  if (e.target.closest('.dp-controls') || e.target.closest('.dp-topbar')) return;
  if (_DP._wasDragging) return;
  clearTimeout(_DP.dblTimer); _DP.dblTimer = null;
  dpCycleWindowMode();
}

/* ── 一次性事件掛載 ────────────────────────────────────────────── */
export function wireDesktopPlayer() {
  const el   = document.getElementById('dplayer');
  const wrap = document.getElementById('dp-wrap');

  wrap.addEventListener('click',       _dpHandleClick);
  wrap.addEventListener('dblclick',    _dpHandleDblClick);
  wrap.addEventListener('wheel',       _dpHandleWheel, { passive: false });
  wrap.addEventListener('pointerdown', _dpHandleDragStart);
  window.addEventListener('pointermove', _dpHandleDragMove);
  window.addEventListener('pointerup',   _dpHandleDragEnd);
  window.addEventListener('pointercancel', _dpHandleDragEnd);

  el.addEventListener('mousemove',  () => { if (el.classList.contains('open')) _dpResetUITimer(); });
  el.addEventListener('mouseleave', () => {
    clearTimeout(_DP.uiHideTimer);
    _DP.uiHideTimer = setTimeout(() => {
      if (_DP.vid && !_DP.vid.paused) { el.classList.add('ui-hidden'); el.style.cursor = 'none'; }
    }, 800);
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && _DP.windowMode === 'fullscreen') {
      // 使用者按 Esc 退出 OS 全螢幕 → 退回最大化（保留 dp-fullscreen class）
      _DP.windowMode = 'maximized';
      _dpUpdateFsBtn();
    }
  });
  const range = document.getElementById('dp-prog-range');
  range?.addEventListener('mousedown', e => e.stopPropagation());
  range?.addEventListener('change', e => dpSeekTo(e.target.value));

  document.getElementById('dp-controls')?.addEventListener('mouseenter', () => {
    if (el.classList.contains('open')) _dpResetUITimer();
  });
}

/** 供外部判斷播放器是否開啟 */
export function isDesktopPlayerOpen() {
  return document.getElementById('dplayer').classList.contains('open');
}

/** 供外部取得目前影片（鍵盤快捷鍵需要） */
export function getDPVid()          { return _DP.vid; }
export function getDPZoomWrapper()  { return _DP.zoomWrapper; }
export function getDPResetUITimer() { return _dpResetUITimer; }
