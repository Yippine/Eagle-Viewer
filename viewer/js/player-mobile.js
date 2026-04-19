'use strict';
/* ── player-mobile.js  ▸  手機 TikTok 風格沉浸式播放器 ───────────────────
   手勢：單擊=清屏  雙擊=播放/暫停  左右拖=快退進  上下滑=切換  左緣右滑=關閉
   兩指捏合=縮放（1~4×）
════════════════════════════════════════════════════════════════════════════*/

import { state }                    from './state.js';
import { seededShuffle, currentSeed } from './shuffle.js';
import { trackView }                from './api.js';
import { fmtTime, HIDE_TAGS, encodePath } from './utils.js';
import { applyTagSet }              from './ui-filters.js';
import { vcInitVid, vcAbTimeUpdate, closeVcPanel, toggleVcPanel }
  from './video-controls.js';

/* ── 播放器狀態 ────────────────────────────────────────────────────── */
const _MP = {
  items: [], idx: 0, vid: null,
  zoomWrapper: null,          // zoom 專用包裝 div（保留捏合焦點）
  tStart: null, axis: null, seekT0: 0,
  tapTimer: null,
  playStart: null, sessionDur: 0,
  uiVisible: true,
  pinchStart: null, pinchScale: 1, baseScale: 1,
};

/* ── 開啟：從 grid 或統計面板 ────────────────────────────────────── */
export function openItemInMobilePlayer(itemId) {
  const clicked = state.ALL.find(i => i.id === itemId);
  if (!clicked) return;
  let list = state.filtered.filter(i => i.file && i.media_type === 'video');
  let idx  = list.findIndex(i => i.id === itemId);
  if (idx === -1) {
    const base = state.ALL.filter(i => i.file && i.media_type === 'video' && i.domain === clicked.domain);
    list = seededShuffle(base, currentSeed());
    idx  = list.findIndex(i => i.id === itemId);
    if (idx === -1) return;
  } else if (state.curDomain === 'all') {
    const dl  = list.filter(i => i.domain === clicked.domain);
    const di  = dl.findIndex(i => i.id === itemId);
    if (di !== -1) { list = dl; idx = di; }
  }
  _mpOpen(list, idx);
}

let _mpHistoryPushed = false;

function _mpOpen(items, idx) {
  _MP.items = items; _MP.idx = idx; _MP.uiVisible = true;
  document.getElementById('mplayer').classList.remove('ui-hidden');
  document.getElementById('mplayer').classList.add('open');
  document.body.style.overflow = 'hidden';
  history.pushState({ overlay: 'mplayer' }, '');
  _mpHistoryPushed = true;
  _mpLoad(); _mpShowHints();
}

export function closeMobilePlayer(fromPopstate = false) {
  if (!document.getElementById('mplayer').classList.contains('open')) return;
  mpCommitDuration();
  closeVcPanel();
  if (_MP.vid) { _MP.vid.pause(); _MP.vid.src = ''; }
  _MP.vid = null; _MP.zoomWrapper = null;
  document.getElementById('mplayer').classList.remove('open');
  document.body.style.overflow = '';
  if (!fromPopstate && _mpHistoryPushed) history.back();
  _mpHistoryPushed = false;
}

/* ── 停留時間追蹤 ────────────────────────────────────────────────── */
export function mpAccumDur() {
  if (_MP.playStart) { _MP.sessionDur += (Date.now() - _MP.playStart) / 1000; _MP.playStart = null; }
}
export function mpCommitDuration() {
  mpAccumDur();
  if (_MP.sessionDur > 1 && _MP.items[_MP.idx]) {
    const item = _MP.items[_MP.idx];
    if (state.VIEWS[item.id]?.history?.length) {
      const last = state.VIEWS[item.id].history[state.VIEWS[item.id].history.length - 1];
      last.d = (last.d || 0) + Math.round(_MP.sessionDur);
      state.VIEWS[item.id].total_watch_time =
        (state.VIEWS[item.id].total_watch_time || 0) + Math.round(_MP.sessionDur);
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, name: item.name, domain: item.domain, duration: Math.round(_MP.sessionDur) }),
      }).catch(() => {});
    }
  }
  _MP.sessionDur = 0; _MP.playStart = null;
}

/* ── 載入影片 ────────────────────────────────────────────────────── */
function _mpLoad() {
  const item = _MP.items[_MP.idx]; if (!item) return;
  const wrap = document.getElementById('mp-wrap');
  wrap.style.cssText = 'background:#000;';
  mpCommitDuration();
  if (_MP.vid) { _MP.vid.pause(); _MP.vid.src = ''; }
  _MP.pinchScale = 1; _MP.pinchStart = null; _MP.baseScale = 1;

  /* zoom wrapper */
  const zoomWrapper = document.createElement('div');
  zoomWrapper.className = 'mp-zoom-wrapper';

  const vid = document.createElement('video');
  vid.playsInline = true; vid.autoplay = true; vid.preload = 'auto'; vid.loop = true;
  vid.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;transform-origin:center center;';
  if (item.file)  vid.src    = '/' + encodePath(item.file);
  if (item.thumb) vid.poster = '/' + encodePath(item.thumb);

  zoomWrapper.appendChild(vid);
  wrap.innerHTML = ''; wrap.appendChild(zoomWrapper);
  _MP.vid = vid; _MP.zoomWrapper = zoomWrapper;

  /* video-controls：載入此影片的濾鏡預設，重設 AB loop */
  vcInitVid(vid, item.id);

  document.getElementById('mp-title').textContent   = item.name || item.id;
  document.getElementById('mp-domain').textContent  = item.domain || '';
  document.getElementById('mp-counter').textContent = `${_MP.idx + 1} / ${_MP.items.length}`;
  _mpResetControls();

  const linkBtn = document.getElementById('mp-link-btn');
  if (linkBtn) {
    if (item.url) { linkBtn.style.display = 'flex'; linkBtn.onclick = () => window._openUrl(item.url); }
    else            linkBtn.style.display = 'none';
  }
  const tagBtn = document.getElementById('mp-tag-btn');
  if (tagBtn) {
    const vt = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
    tagBtn.style.display = vt.length ? 'flex' : 'none';
  }

  vid.addEventListener('play',       () => { _MP.playStart = Date.now(); _mpSetPlayBtn(false); });
  vid.addEventListener('pause',      () => { mpAccumDur(); _mpSetPlayBtn(true); });
  vid.addEventListener('ended',      () => { mpAccumDur(); });
  vid.addEventListener('timeupdate', () => { _mpUpdateProgress(); vcAbTimeUpdate(vid); });
  vid.play().catch(() => {});
  trackView(item);
}

/* ── 控制列 ──────────────────────────────────────────────────────── */
function _mpResetControls() {
  const range = document.getElementById('mp-prog-range');
  const time  = document.getElementById('mp-time');
  if (range) { range.value = 0; range.style.setProperty('--pct', '0%'); }
  if (time)    time.textContent = '0:00 / –:––';
  _mpSetPlayBtn(false);
}
function _mpSetPlayBtn(isPaused) {
  const btn = document.getElementById('mp-btn-play');
  if (btn) btn.textContent = isPaused ? '▶' : '⏸';
}
function _mpUpdateProgress() {
  const vid = _MP.vid; if (!vid || !vid.duration) return;
  const pct   = (vid.currentTime / vid.duration) * 100;
  const range = document.getElementById('mp-prog-range');
  const time  = document.getElementById('mp-time');
  if (range) { range.value = pct; range.style.setProperty('--pct', `${pct.toFixed(1)}%`); }
  if (time)    time.textContent = `${fmtTime(vid.currentTime)} / ${fmtTime(vid.duration)}`;
}

export function mpSeekTo(val) {
  if (_MP.vid && _MP.vid.duration) _MP.vid.currentTime = (val / 100) * _MP.vid.duration;
}
export function mpTogglePlay() {
  if (!_MP.vid) return;
  const flash = document.getElementById('mp-flash');
  if (_MP.vid.paused) { _MP.vid.play().catch(() => {}); if (flash) flash.textContent = '▶'; }
  else                { _MP.vid.pause();                if (flash) flash.textContent = '⏸'; }
  if (flash) {
    flash.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => flash.classList.remove('show'), 700);
  }
}
function _mpToggleUI() {
  _MP.uiVisible = !_MP.uiVisible;
  document.getElementById('mplayer').classList.toggle('ui-hidden', !_MP.uiVisible);
}
export function mpSwitch(dir) {
  const next = _MP.idx + dir;
  const wrap = document.getElementById('mp-wrap');
  if (next < 0 || next >= _MP.items.length) {
    wrap.style.transition = 'transform .3s ease'; wrap.style.transform = 'translateY(0)';
    _mpShowSwipeOv(dir < 0 ? '🚫 已是第一部' : '🚫 已是最後一部'); return;
  }
  _MP.idx = next; _mpLoad();
}
function _mpShowSwipeOv(text) {
  const ov = document.getElementById('mp-swipe-ov');
  ov.textContent = text; ov.classList.add('show');
  clearTimeout(ov._t); ov._t = setTimeout(() => ov.classList.remove('show'), 1200);
}
let _seekHideTimer;
function _mpShowSeek(text) {
  const i = document.getElementById('mp-seek');
  i.textContent = text; i.classList.add('show');
  clearTimeout(_seekHideTimer);
}
function _mpHideSeek() {
  clearTimeout(_seekHideTimer);
  _seekHideTimer = setTimeout(() => document.getElementById('mp-seek')?.classList.remove('show'), 350);
}
function _mpShowHints() {
  const hints = document.getElementById('mp-hints'); if (!hints) return;
  hints.classList.add('show');
  clearTimeout(hints._t); hints._t = setTimeout(() => hints.classList.remove('show'), 3500);
}

/** 手機播放器標籤搜尋 */
export function mpSearchByTags() {
  const item = _MP.items[_MP.idx]; if (!item) return;
  const tags = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
  closeMobilePlayer();
  applyTagSet(tags);
}

/* ── 觸控手勢綁定（一次性，由 wireMobilePlayer 呼叫）─────────────── */
export function wireMobilePlayer() {
  const el = document.getElementById('mplayer');

  el.addEventListener('touchstart', e => {
    if (e.target.closest('.mp-controls') || e.target.closest('.mp-topbar')) return;
    if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      _MP.pinchStart = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      _MP.baseScale  = _MP.pinchScale;
      if (_MP.zoomWrapper) {
        const rect = _MP.zoomWrapper.getBoundingClientRect();
        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;
        const ox = ((midX - rect.left) / rect.width)  * 100;
        const oy = ((midY - rect.top)  / rect.height) * 100;
        _MP.zoomWrapper.style.transformOrigin = `${ox.toFixed(1)}% ${oy.toFixed(1)}%`;
      }
      _MP.tStart = null; return;
    }
    const t = e.touches[0];
    _MP.tStart = { x: t.clientX, y: t.clientY };
    _MP.axis = null; _MP.seekT0 = _MP.vid ? _MP.vid.currentTime : 0;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (e.target.closest('.mp-controls')) return;
    if (e.touches.length === 2 && _MP.pinchStart !== null) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist  = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = Math.max(1, Math.min(4, _MP.baseScale * (dist / _MP.pinchStart)));
      _MP.pinchScale = scale;
      if (_MP.zoomWrapper) _MP.zoomWrapper.style.transform = scale > 1 ? `scale(${scale.toFixed(3)})` : '';
      e.preventDefault(); return;
    }
    if (!_MP.tStart) return;
    const t = e.touches[0], dx = t.clientX - _MP.tStart.x, dy = t.clientY - _MP.tStart.y;
    if (!_MP.axis) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
      _MP.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    e.preventDefault();
    if (_MP.axis === 'x') {
      if (_MP.vid && _MP.vid.duration) {
        const d = (dx / window.innerWidth) * 30;
        _mpShowSeek(`${d >= 0 ? '+' : ''}${Math.round(d)}s`);
      }
    } else {
      if (_MP.pinchScale > 1) return;
      const wrap = document.getElementById('mp-wrap');
      wrap.style.transition = 'none'; wrap.style.transform = `translateY(${dy * 0.65}px)`;
    }
  }, { passive: false });

  el.addEventListener('touchend', e => {
    if (_MP.pinchStart !== null && e.touches.length < 2) {
      _MP.pinchStart = null;
      if (_MP.pinchScale < 1.05) {
        _MP.pinchScale = 1;
        if (_MP.zoomWrapper) { _MP.zoomWrapper.style.transform = ''; _MP.zoomWrapper.style.transformOrigin = 'center center'; }
      }
      return;
    }
    if (!_MP.tStart) return;
    if (e.target.closest('.mp-controls')) return;
    const t = e.changedTouches[0], dx = t.clientX - _MP.tStart.x, dy = t.clientY - _MP.tStart.y;
    const moved = Math.abs(dx) > 10 || Math.abs(dy) > 10;

    if (_MP.pinchScale <= 1 && _MP.tStart.x < 32 && dx > 80 && Math.abs(dy) < 100) {
      closeMobilePlayer(); _MP.tStart = null; return;
    }
    if (_MP.axis === 'x') {
      if (_MP.vid && _MP.vid.duration) {
        const d = (dx / window.innerWidth) * 30;
        _MP.vid.currentTime = Math.max(0, Math.min(_MP.vid.duration, _MP.seekT0 + d));
      }
      _mpHideSeek();
    } else if (_MP.axis === 'y') {
      if (_MP.pinchScale > 1) { _MP.tStart = null; _MP.axis = null; return; }
      const thr  = window.innerHeight * 0.22;
      const wrap = document.getElementById('mp-wrap');
      if      (dy < -thr) { wrap.style.transition = 'transform .28s ease'; wrap.style.transform = 'translateY(-108%)'; setTimeout(() => mpSwitch(1),  280); }
      else if (dy > thr)  { wrap.style.transition = 'transform .28s ease'; wrap.style.transform = 'translateY(108%)';  setTimeout(() => mpSwitch(-1), 280); }
      else                { wrap.style.transition = 'transform .3s ease';  wrap.style.transform = 'translateY(0)'; }
    } else if (!moved) {
      if (_MP.tapTimer) {
        clearTimeout(_MP.tapTimer); _MP.tapTimer = null;
        if (_MP.pinchScale > 1) {
          _MP.pinchScale = 1; _MP.baseScale = 1;
          if (_MP.zoomWrapper) { _MP.zoomWrapper.style.transform = ''; _MP.zoomWrapper.style.transformOrigin = 'center center'; }
        } else { mpTogglePlay(); }
      } else {
        _MP.tapTimer = setTimeout(() => { _MP.tapTimer = null; _mpToggleUI(); }, 280);
      }
    }
    _MP.tStart = null; _MP.axis = null;
  }, { passive: true });

  const range = document.getElementById('mp-prog-range');
  if (range) {
    ['touchstart', 'touchmove', 'touchend'].forEach(ev =>
      range.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
  }

  // touchcancel：手勢被打斷時確保狀態清除，防止 tStart 髒值影響後續觸控
  el.addEventListener('touchcancel', () => {
    _MP.tStart = null; _MP.axis = null; _MP.pinchStart = null;
    if (_MP.tapTimer) { clearTimeout(_MP.tapTimer); _MP.tapTimer = null; }
  }, { passive: true });

  // Topbar 按鈕：touchstart/touchend stopPropagation 防止手勢誤觸發
  // 不呼叫 preventDefault，讓 iOS 仍能產生 native click，並在 touchend 直接呼叫作為保險
  function _wireTopbarBtn(el, fn) {
    el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    el.addEventListener('touchend',   e => {
      e.stopPropagation();
      if (document.getElementById('mplayer').classList.contains('open')) fn();
    }, { passive: true });
  }

  const backBtn = document.querySelector('.mp-back');
  backBtn.addEventListener('click', closeMobilePlayer);
  _wireTopbarBtn(backBtn, closeMobilePlayer);

  const tagBtnEl = document.getElementById('mp-tag-btn');
  if (tagBtnEl) _wireTopbarBtn(tagBtnEl, mpSearchByTags);

  const vcBtnEl = document.getElementById('mp-vc-btn');
  if (vcBtnEl) _wireTopbarBtn(vcBtnEl, toggleVcPanel);

  const linkBtnEl = document.getElementById('mp-link-btn');
  if (linkBtnEl) {
    linkBtnEl.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    linkBtnEl.addEventListener('touchend',   e => {
      e.stopPropagation();
      const item = _MP.items[_MP.idx];
      if (item?.url) window._openUrl(item.url);
    }, { passive: true });
  }
}
