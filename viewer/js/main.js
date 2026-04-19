'use strict';
/* ── main.js  ▸  應用程式入口點 ─────────────────────────────────────────
   職責：
     1. init()：載入資料 + 啟動 UI
     2. wireEvents()：鍵盤 / 搜尋 / 類型 pill 事件綁定
     3. window.* 曝露：讓 HTML inline onclick 可呼叫模組函式
     4. URL 開啟邏輯（含 X.com deep link）
═══════════════════════════════════════════════════════════════════════════*/

import { state }                    from './state.js';
import { h, HIDE_TAGS, isMobile, encodePath } from './utils.js';
import { newSeed, updateSeedNav, setSeedIdx } from './shuffle.js';
import * as Shuffle from './shuffle.js';
import { applyFilter }              from './grid.js';
import { buildDomainChips, buildTagChips, setDomain, toggleFbar,
         toggleTagPanel, closeTagPanel, toggleTag, filterByTag, filterByItemTags,
         applyTagSet, clearAllTags,
         buildPresetChips, togglePresetPanel, closePresetPanel,
         setPresetFilter, clearPresetFilter }  from './ui-filters.js';
import { trackView }                from './api.js';
import { renderStatsRow, showLoadError } from './renderer.js';
import { openModal, closeModal }    from './modal.js';
import { openStats, closeStats, switchStatsTab,
         renderStatsPanel, delHistItem, clearAllHistory } from './stats.js';
import { openItemInMobilePlayer, closeMobilePlayer,
         mpTogglePlay, mpSeekTo, mpSwitch, mpSearchByTags,
         wireMobilePlayer }         from './player-mobile.js';
import { openItemInDesktopPlayer, closeDesktopPlayer,
         dpTogglePlay, dpSeekTo, dpSwitch, dpToggleMute,
         dpCycleWindowMode, dpSearchByTags, wireDesktopPlayer,
         isDesktopPlayerOpen, getDPVid, getDPResetUITimer } from './player-desktop.js';
import { vcSetFilter, vcSetTx, vcFlip, vcRotateBy, vcSetRotate,
         vcSetAbPoint, vcToggleAbLoop, vcClearAb, vcResetAll,
         vcGetVid, toggleVcPanel, closeVcPanel, vcInitDragHandle,
         vcApplyPreset, vcToggleVideoPreset, vcSaveCurrentAsPreset,
         vcUpdateCurrentPreset, vcRenamePresetPrompt, vcDeletePreset, vcDismissToast,
         vcLinkPresetToCurrentVideo,
         vcRenderPresetPanel } from './video-controls.js';

/* ── X.com / Twitter deep link ───────────────────────────────────── */
function _buildXDeepLink(url) {
  try {
    const u    = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1] === 'status')
      return `twitter://status?id=${parts[2]}`;
    if (parts.length >= 4 && parts[0] === 'i' && parts[1] === 'web' && parts[2] === 'status')
      return `twitter://status?id=${parts[3]}`;
    if (parts.length === 1 && !parts[0].startsWith('i') && !parts[0].startsWith('_'))
      return `twitter://user?screen_name=${parts[0]}`;
  } catch {}
  return null;
}

function _openUrl(url) {
  if (!url) return;
  if (isMobile()) {
    const deep = _buildXDeepLink(url);
    if (deep) {
      let appLaunched = false;
      const onVis = () => { appLaunched = true; };
      document.addEventListener('visibilitychange', onVis, { once: true });
      const a = document.createElement('a');
      a.href = deep; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => document.body.removeChild(a), 200);
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVis);
        if (!appLaunched) window.open(url, '_blank', 'noopener');
      }, 1200);
      return;
    }
  }
  window.open(url, '_blank', 'noopener');
}

/* ── 卡片事件控制器 ──────────────────────────────────────────────── */
function _imgClick(itemId, src) {
  const item = state.ALL.find(x => x.id === itemId);
  if (item) trackView(item);
  openModal(src, 'image');
}

function _cardClick(event, itemId, url) {
  const item = state.ALL.find(x => x.id === itemId); if (!item) return;
  if (item.file && item.media_type === 'video') {
    if (isMobile()) openItemInMobilePlayer(itemId);
    else            openItemInDesktopPlayer(itemId);
    return;
  }
  trackView(item); if (item.file) return; _openUrl(url);
}

function _cbodyClick(event, itemId, url) {
  const item = state.ALL.find(x => x.id === itemId); if (!item) return;
  if (item.file && item.media_type === 'video') {
    if (isMobile()) openItemInMobilePlayer(itemId);
    else            openItemInDesktopPlayer(itemId);
    return;
  }
  trackView(item); _openUrl(url);
}

/** 從統計面板播放影片（分派至手機/桌面播放器） */
function _playVideoItem(itemId) {
  const item = state.ALL.find(x => x.id === itemId); if (!item) return;
  closeStats();
  // defer until history.back() popstate fires, avoiding race condition
  setTimeout(() => {
    if (isMobile()) { openItemInMobilePlayer(itemId); }
    else {
      if (item.file) openItemInDesktopPlayer(itemId);
      else if (item.url) { trackView(item); _openUrl(item.url); }
    }
  }, 50);
}

/** 從統計面板開啟圖片（Modal Lightbox） */
function _openImageItem(itemId) {
  const item = state.ALL.find(x => x.id === itemId); if (!item?.file) return;
  closeStats();
  setTimeout(() => {
    trackView(item);
    openModal('/' + encodePath(item.file), 'image');
  }, 50);
}

/** shuffle 按鈕（需協調 shuffle + grid） */
function _newShuffle()  { newSeed();  updateSeedNav(); applyFilter(); }
function _prevSeed() {
  if (Shuffle.seedIdx <= 0) return;
  setSeedIdx(Shuffle.seedIdx - 1);
  updateSeedNav(); applyFilter();
}
function _nextSeed() {
  if (Shuffle.seedIdx >= Shuffle.seeds.length - 1) return;
  setSeedIdx(Shuffle.seedIdx + 1);
  updateSeedNav(); applyFilter();
}

/* ── Library switching ───────────────────────────────────────────── */

/** 首次設定引導頁（尚未設定任何資源庫時） */
function _showSetupForm() {
  state.ALL   = [];
  state.VIEWS = {};
  const grid  = document.getElementById('grid');
  const ibar  = document.getElementById('ibar');
  const stats = document.getElementById('stats-row');
  if (stats) stats.textContent = '';
  if (ibar)  ibar.textContent  = '';
  if (grid) {
    grid.innerHTML = `
      <div class="setup-form">
        <p class="sf-title">新增資源庫</p>
        <p class="sf-sub">選擇一個 Eagle 資源庫資料夾</p>
        <div class="sf-row">
          <input class="sf-input" id="sf-path" type="text" readonly
                 placeholder="點擊「瀏覽」選擇資源庫資料夾…" />
          <button class="sf-browse-btn" id="sf-browse-btn">瀏覽…</button>
        </div>
        <button class="sf-btn" id="sf-save-btn" disabled>新增</button>
        <p class="sf-hint" id="sf-hint"></p>
      </div>`;
    document.getElementById('sf-browse-btn')
      ?.addEventListener('click', _browseDir);
    document.getElementById('sf-save-btn')
      ?.addEventListener('click', _saveConfig);
  }
}

/** 呼叫 server-side 原生目錄選擇器 */
async function _browseDir() {
  const browseBtn = document.getElementById('sf-browse-btn');
  const saveBtn   = document.getElementById('sf-save-btn');
  const pathInput = document.getElementById('sf-path');
  const hint      = document.getElementById('sf-hint');
  if (browseBtn) { browseBtn.disabled = true; browseBtn.textContent = '開啟中…'; }
  try {
    const res  = await fetch('/api/browse');
    const data = await res.json();
    if (data.ok && data.path) {
      pathInput.value = data.path;
      if (hint) hint.textContent = '';
      if (saveBtn) saveBtn.disabled = false;
    } else {
      if (hint) hint.textContent = '未選擇資料夾';
    }
  } catch (e) {
    if (hint) hint.textContent = `錯誤：${e.message}`;
  } finally {
    if (browseBtn) { browseBtn.disabled = false; browseBtn.textContent = '瀏覽…'; }
  }
}

/** 儲存 Eagle Root 設定（POST /api/config），成功後 reload */
async function _saveConfig() {
  const pathVal = document.getElementById('sf-path')?.value.trim();
  const hint    = document.getElementById('sf-hint');
  const btn     = document.getElementById('sf-save-btn');
  if (!pathVal) { if (hint) hint.textContent = '請輸入路徑'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: pathVal }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'unknown');
    // reload 避免 wireEvents 重複綁定
    window.location.reload();
  } catch (e) {
    if (hint) hint.textContent = `錯誤：${e.message}`;
    if (btn) { btn.disabled = false; btn.textContent = '儲存'; }
  }
}

/** 自動建立索引（選到未索引庫時靜默觸發） */
async function _autoIndex(libName) {
  state.ALL   = [];
  state.VIEWS = {};
  const grid  = document.getElementById('grid');
  const ibar  = document.getElementById('ibar');
  const stats = document.getElementById('stats-row');
  if (stats) stats.textContent = '';
  if (ibar)  ibar.textContent  = '';
  if (grid) grid.innerHTML = `
    <div class="loading-indicator">
      <p>正在建立索引…</p>
      <p class="li-lib">${h(libName)}</p>
    </div>`;

  try {
    const res = await fetch('/api/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lib: libName }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'unknown');
  } catch (e) {
    if (grid) {
      grid.innerHTML = `
        <div class="loading-indicator error">
          <p>索引失敗：${h(String(e))}</p>
          <button id="li-retry-btn">重試</button>
        </div>`;
      document.getElementById('li-retry-btn')
        ?.addEventListener('click', () => _autoIndex(libName));
    }
    return;
  }

  // 成功 → 更新 selector extracted 狀態，再載入資料
  const sel = document.getElementById('lib-select');
  if (sel) {
    const opt = [...sel.options].find(o => o.value === libName);
    if (opt) opt.dataset.extracted = 'true';
    _updateLibSelectStyle(sel);
  }
  await _loadLibraryData(libName);
}

/** 純資料載入（不含未匯出判斷，供 loadLibrary 內部使用） */
async function _loadLibraryData(libName) {
  try {
    const res = await fetch(`/data/${encodeURIComponent(libName)}/urls_data.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.ALL = data.items || [];
    // Deduplicate by ID (guard against urls_data.json having duplicate Eagle IDs)
    const _seenIds = new Set();
    state.ALL = state.ALL.filter(i => _seenIds.has(i.id) ? false : (_seenIds.add(i.id), true));
    renderStatsRow(data.stats);
  } catch (_) { showLoadError(); return; }

  state.VIEWS = {};
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 3000);
    const res  = await fetch(`/api/views?lib=${encodeURIComponent(libName)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (res.ok) state.VIEWS = await res.json();
  } catch (_) {}

  buildDomainChips(); buildTagChips();
  newSeed(); updateSeedNav();
  applyFilter();
}

/** 更新 selector 選項外觀：未匯出的加 ✦ 前綴 */
function _updateLibSelectStyle(sel) {
  [...sel.options].forEach(opt => {
    const isExtracted = opt.dataset.extracted === 'true';
    const baseName    = opt.dataset.label || opt.textContent.replace(/^✦ /, '');
    opt.dataset.label = baseName;
    opt.textContent   = isExtracted ? baseName : `✦ ${baseName}`;
  });
}

/** 載入指定資源庫（含未匯出判斷） */
async function loadLibrary(libName) {
  state.activeLib = libName;

  // 重置篩選條件與搜尋框
  state.curDomain = 'all';
  state.curType   = 'all';
  state.curTags   = new Set();
  state.curQ      = '';
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';
  document.querySelectorAll('.tpill').forEach(b => b.classList.remove('on'));

  // 確認是否已匯出（向 selector 的 data-extracted 查詢，避免額外請求）
  const sel = document.getElementById('lib-select');
  const opt = sel ? [...sel.options].find(o => o.value === libName) : null;
  const isExtracted = opt ? opt.dataset.extracted === 'true' : true;

  if (!isExtracted) {
    await _autoIndex(libName);
    return;
  }

  await _loadLibraryData(libName);
}

/** 切換資源庫（含 localStorage 固化 + R3 持久化） */
function switchLibrary(libName) {
  localStorage.setItem('eagle-active-lib', libName);
  const sel = document.getElementById('lib-select');
  if (sel && sel.value !== libName) sel.value = libName;
  loadLibrary(libName);
}

/* ── BOOT SEQUENCE ───────────────────────────────────────────────── */
async function init() {
  // 1. 取得資源庫列表（含 extracted 狀態）
  let libs = [];
  try {
    const res = await fetch('/api/libraries');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // configured 檢查：EAGLE_ROOT 未設定時顯示設定引導頁
    if (data && data.configured === false) {
      _showSetupForm();
      return;
    }

    // 防禦性賦值，確保 libs 一定是 Array
    libs = Array.isArray(data) ? data : [];
  } catch (_) { showLoadError(); return; }

  if (!Array.isArray(libs) || libs.length === 0) { showLoadError(true); return; }

  // 2. 填充 library selector，將 extracted 狀態存入 data- 屬性
  const sel = document.getElementById('lib-select');
  if (sel) {
    sel.innerHTML = libs.map(l =>
      `<option value="${h(l.name)}" data-extracted="${l.extracted}" data-label="${h(l.label)}">${l.extracted ? h(l.label) : `✦ ${h(l.label)}`}</option>`
    ).join('');
  }

  // 3. R3：從 localStorage 恢復上次選擇，驗證仍存在，fallback 至第一個
  const stored  = localStorage.getItem('eagle-active-lib');
  const isValid = libs.some(l => l.name === stored);
  const defLib  = isValid ? stored : libs[0].name;
  if (sel) sel.value = defLib;

  // 4. 綁定事件（先於 loadLibrary，避免 UI 尚未就緒）
  wireEvents();
  wireMobilePlayer();

  // 5. 載入預設資源庫
  await loadLibrary(defLib);
}

/* ── Event wiring ────────────────────────────────────────────────── */
function wireEvents() {
  // 類型 pill（再次點擊已選取的 pill → 取消選取，回到全部）
  document.querySelectorAll('.tpill').forEach(b => {
    b.addEventListener('click', () => {
      if (b.classList.contains('on')) {
        state.curType = 'all';
        b.classList.remove('on');
      } else {
        state.curType = b.dataset.t;
        document.querySelectorAll('.tpill').forEach(x => x.classList.toggle('on', x === b));
      }
      applyFilter();
    });
  });

  // 搜尋（debounce 180ms）
  let _st;
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(_st);
    _st = setTimeout(() => { state.curQ = e.target.value; applyFilter(); }, 180);
  });

  // 全局鍵盤快捷鍵
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isDesktopPlayerOpen()) {
      const resetUI = getDPResetUITimer();
      switch (e.key) {
        case ' ': case 'Spacebar':
          e.preventDefault(); dpTogglePlay(); resetUI(); return;
        case 'ArrowLeft':
          e.preventDefault();
          { const v = getDPVid(); if (v?.duration) v.currentTime = Math.max(0, v.currentTime - 5); }
          resetUI(); return;
        case 'ArrowRight':
          e.preventDefault();
          { const v = getDPVid(); if (v?.duration) v.currentTime = Math.min(v.duration, v.currentTime + 5); }
          resetUI(); return;
        case 'ArrowUp':   e.preventDefault(); dpSwitch(-1); resetUI(); return;
        case 'ArrowDown': e.preventDefault(); dpSwitch(1);  resetUI(); return;
        case 'f': case 'F': e.preventDefault(); dpCycleWindowMode(); return;
        case 'm': case 'M': dpToggleMute(); return;
        case 'c': case 'C': e.preventDefault(); toggleVcPanel(); return;
        case 'Escape': closeDesktopPlayer(); closeVcPanel(); return;
      }
    }
    if (e.key === 'Escape') { closeModal(); closeStats(); closeMobilePlayer(); }
  });

  // 硬體返回鍵 / 瀏覽器返回：偵聽 popstate，依序關閉最上層的 overlay
  window.addEventListener('popstate', () => {
    if (document.getElementById('mplayer').classList.contains('open')) {
      closeMobilePlayer(true);
    } else if (document.getElementById('dplayer').classList.contains('open')) {
      closeDesktopPlayer(true);
    } else if (document.getElementById('stats-panel').classList.contains('open')) {
      closeStats(true);
    } else if (document.getElementById('tag-panel').classList.contains('open')) {
      closeTagPanel(true);
    } else if (document.getElementById('modal').classList.contains('open')) {
      closeModal(true);
    }
  });

  wireDesktopPlayer();
  vcInitDragHandle();
}

/* ── window.* 曝露（供 HTML inline onclick 使用）────────────────── */
/** 快速新增資源庫（header ＋ 按鈕用）：直接 browse → save → reload */
async function _addLibrary() {
  let path = '';
  try {
    const res  = await fetch('/api/browse');
    const data = await res.json();
    if (!data.ok || !data.path) return;   // 使用者取消
    path = data.path;
  } catch (e) { console.error('Browse error:', e); return; }

  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: path }),
    });
    const result = await res.json();
    if (!result.ok) { alert(`新增失敗：${result.error || 'unknown'}`); return; }
    window.location.reload();
  } catch (e) { alert(`新增失敗：${e.message}`); }
}

// Library
window.switchLibrary    = switchLibrary;
window._showSetupForm   = _showSetupForm;
window._addLibrary      = _addLibrary;

// UI Filters
window.setDomain          = setDomain;
window.toggleFbar         = toggleFbar;
window.toggleTagPanel     = toggleTagPanel;
window.toggleTag          = toggleTag;
window._filterByTag       = filterByTag;
window._filterByItemTags  = filterByItemTags;
window.clearAllTags       = clearAllTags;
window.togglePresetPanel  = togglePresetPanel;
window.setPresetFilter    = setPresetFilter;
window.clearPresetFilter  = clearPresetFilter;
window.buildPresetChips   = buildPresetChips;

// Video Preset
window.vcApplyPreset          = vcApplyPreset;
window.vcToggleVideoPreset    = vcToggleVideoPreset;
window.vcSaveCurrentAsPreset  = vcSaveCurrentAsPreset;
window.vcUpdateCurrentPreset  = vcUpdateCurrentPreset;
window.vcRenamePresetPrompt   = vcRenamePresetPrompt;
window.vcDeletePreset             = vcDeletePreset;
window.vcLinkPresetToCurrentVideo = vcLinkPresetToCurrentVideo;
window.vcDismissToast             = vcDismissToast;

// Shuffle
window.newShuffle       = _newShuffle;
window.prevSeed         = _prevSeed;
window.nextSeed         = _nextSeed;

// Stats
window.openStats        = openStats;
window.closeStats       = closeStats;
window.switchStatsTab   = switchStatsTab;
window.clearAllHistory  = clearAllHistory;
window._delHistItem     = delHistItem;
window._playVideoItem   = _playVideoItem;
window._openImageItem   = _openImageItem;
window.trackView        = trackView;

// Mobile player
window.closeMobilePlayer = closeMobilePlayer;
window._mpTogglePlay    = mpTogglePlay;
window._mpSeekTo        = mpSeekTo;
window._mpSwitch        = mpSwitch;
window._mpSearchByTags  = mpSearchByTags;

// Desktop player
window.closeDesktopPlayer = closeDesktopPlayer;
window._dpSeekTo        = dpSeekTo;
window._dpTogglePlay    = dpTogglePlay;
window._dpSwitch        = dpSwitch;
window._dpToggleMute    = dpToggleMute;
window._dpCycleWindowMode = dpCycleWindowMode;
window._dpSearchByTags  = dpSearchByTags;

// Video Controls Panel
window.toggleVcPanel    = toggleVcPanel;
window.closeVcPanel     = closeVcPanel;
window._vcFilter        = (key, val) => vcSetFilter(key, val);
window._vcTx            = (key, val) => vcSetTx(key, val);
window._vcFlip          = (axis)     => vcFlip(axis);
window._vcRotateBy      = (deg)      => vcRotateBy(deg);
window._vcSetRotate     = (deg)      => vcSetRotate(deg);
window._vcSetA          = ()         => vcSetAbPoint(vcGetVid(), 'a');
window._vcSetB          = ()         => vcSetAbPoint(vcGetVid(), 'b');
window._vcToggleAb      = ()         => vcToggleAbLoop();
window._vcClearAb       = ()         => vcClearAb();
window._vcResetAll      = ()         => vcResetAll();

// Modal
window.closeModal       = closeModal;

// Card handlers
window._imgClick        = _imgClick;
window._cardClick       = _cardClick;
window._cbodyClick      = _cbodyClick;

// URL
window._openUrl         = _openUrl;

// Misc（供 stats.js 內嵌 HTML 使用）
window._HIDE_TAGS       = HIDE_TAGS;
window._lookupItem      = id => state.ALL.find(x => x.id === id);  // 永遠讀到最新 state.ALL
window.h                = h;

/* ── 啟動 ────────────────────────────────────────────────────────── */
init();
