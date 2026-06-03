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
import { openActionSheet, closeActionSheet,
         actionArchive, actionRestore, actionMove,
         actionRename, closeRenameSheet, confirmRename,
         actionEditTags, closeTagsEditSheet, confirmTagsEdit, onTagSearch, onTagSearchKey,
         actionStar, closeStarSheet, confirmStar,
         actionAnnotation, closeAnnotationSheet, confirmAnnotation,
         actionUrl, closeItemUrlSheet, confirmUrl,
         actionDelete, closeDeleteSheet, confirmDelete }
  from './actions.js';
import { openTrashView, closeTrashView, trashSelectAll,
         batchTrashRestore, batchTrashDelete, trashHandleSSE,
         _updateTrashCount, _registerBatchFns }
  from './trash.js';
import { enterSelectMode, exitSelectMode, toggleSelect, batchArchive, batchFolders, batchDelete, wireLongPress, isSelectMode } from './batch.js';
import { openFolderPicker, closeFolderPicker, onFolderSearch, fpToggle, fpRemove, confirmFolderPicker }
  from './folder-picker.js';
import { openSettingsPanel, closeSettingsPanel, switchSettingsTab,
         folderTagsDiff, folderTagsApply,
         itemsTagsDiff,  itemsTagsApply,
         setPrefMaxSeeds, clearShuffleHistory, jumpToSeed }
  from './settings.js';
import { openUploadSheet, closeUploadSheet, submitUpload,
         openUrlSheet, closeUrlSheet, submitUrlImport,
         toggleFabMenu, closeFabMenu }
  from './import.js';
import { newSeed, updateSeedNav, setSeedIdx } from './shuffle.js';
import * as Shuffle from './shuffle.js';
import { applyFilter, _relayout }   from './grid.js';
import { buildDomainChips, buildFolderTree, setDomain, toggleFbar,
         toggleTagPanel, closeTagPanel, toggleTag, filterByTag, filterByItemTags,
         applyTagSet, clearAllTags, clearAllFilters, filterFolderTree, toggleTreeNode,
         selectFolderBranch, filterByFolderId, applyFolderFilter, closeFolderPopover,
         renderActiveFolderChips, updateSearchChips,
         buildPresetChips, togglePresetPanel, closePresetPanel,
         setPresetFilter, clearPresetFilter }  from './ui-filters.js';
import { trackView }                from './api.js';
import { renderStatsRow, showLoadError } from './renderer.js';
import { openModal, closeModal }    from './modal.js';
import { renderStatsPanel, delHistItem, clearAllHistory } from './stats.js';
import { addNotification, updateNotifStatus, updateNotifNames, registerRetryFn,
         loadPersistedNotifs, clearMemoryNotifs } from './notifications.js';
import { openItemInMobilePlayer, closeMobilePlayer,
         mpTogglePlay, mpSeekTo, mpSwitch, mpSearchByTags,
         wireMobilePlayer }         from './player-mobile.js';
import { openItemInDesktopPlayer, closeDesktopPlayer,
         dpTogglePlay, dpSeekTo, dpSwitch, dpToggleMute,
         dpCycleWindowMode, dpSearchByTags, wireDesktopPlayer,
         isDesktopPlayerOpen, getDPVid, getDPResetUITimer } from './player-desktop.js';
import { vcSetFilter, vcSetTx, vcFlip, vcRotateBy, vcSetRotate,
         vcSetAbPoint, vcToggleAbLoop, vcClearAb, vcResetAll,
         vcResetFilters, vcResetTransform,
         vcGetVid, toggleVcPanel, closeVcPanel, vcInitDragHandle, vcSwitchTab,
         vcSaveFilterPreset, vcApplyFilterPreset, vcDeleteFilterPreset, vcRenameFilterPreset, vcToggleVideoFilterPreset,
         vcSaveTransformSnapshot, vcResetTransformSnapshot,
         vcSmartCrop, vcToggleCropMode, vcCancelCrop, vcApplyCrop, vcSetLoopMode, vcSetSpeed,
         vcRegisterAutoplayNext,
         vcDismissToast,
         vcImageZoom, vcImageZoomSet, vcImageFit, vcImageActualSize, vcSetModalBg, vcImageNav,
         vcRegisterImageNav,
         vcStartEyedropper, vcStopEyedropper, vcSetSelectiveHue, vcClearSelectiveColor,
         vcAddSelectiveColor, vcSetActiveSelective, vcRemoveSelective } from './video-controls.js';

/* ── SSE（Server-Sent Events）────────────────────────────────────── */
let _sseSource = null;

function _initSSE(libName) {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  try {
    _sseSource = new EventSource(`/api/events?lib=${encodeURIComponent(libName)}`);
    _sseSource.onmessage = e => {
      try { _handleSSE(JSON.parse(e.data)); } catch {}
    };
  } catch {}
}

/** 快照 ids 的 { name, ext, folder } 供通知中心展開顯示（需在 state 異動前呼叫） */
function _snapItems(ids) {
  const snaps = {};
  ids.forEach(id => {
    const item = state.ALL.find(x => x.id === id);
    if (!item) return;
    const fmap    = state.folderMap || {};
    const folders = (item.folders || [])
      .map(fid => fmap[fid]?.name).filter(Boolean);
    snaps[id] = {
      name:    item.name || '',
      ext:     item.ext  || '',
      kind:    item.kind || 'other',
      folders: folders,
    };
  });
  return snaps;
}

function _handleSSE(evt) {
  if (evt.lib && evt.lib !== state.activeLib) return;
  // 垃圾桶視圖同步
  trashHandleSSE(evt);
  switch (evt.type) {
    case 'tags_synced':
      _loadLibraryData(state.activeLib, { skipDiff: true });
      break;
    case 'item_created':
      _loadLibraryData(state.activeLib, { skipDiff: true });
      break;
    case 'item_deleted': {
      state.ALL = state.ALL.filter(x => x.id !== evt.id);
      document.querySelector(`.card[data-id="${h(evt.id)}"]`)?.remove();
      break;
    }
    case 'items_restored': {
      // 更新 state 即可（trashHandleSSE 已處理 archived tag 移除 + applyFilter）
      // 不再呼叫 _loadLibraryData（避免跳出垃圾桶視圖）
      break;
    }
    case 'item_added_external': {
      // Eagle App 新增素材 → 自動重建索引，通知中心記錄結果
      const nid = addNotification('item_added_external', evt, 'loading');
      _autoExtract(nid, evt.ids || []);
      break;
    }
    case 'item_removed_external': {
      // Eagle App 永久刪除 → 先快照，再同步 state + DOM，通知中心記錄 ✅
      const removedSet = new Set(evt.ids || []);
      // server snaps 優先，但 {} 不算有效（永久刪除時 .info 已消失，server 回傳空物件）
      const removedSnaps = (evt.snaps && Object.keys(evt.snaps).length)
        ? evt.snaps : _snapItems([...removedSet]);
      state.ALL = state.ALL.filter(x => !removedSet.has(x.id));
      removedSet.forEach(id =>
        document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.remove()
      );
      addNotification('item_removed_external', { ids: [...removedSet], snaps: removedSnaps }, 'ok');
      break;
    }
    case 'item_trashed_external': {
      // Eagle App 移至垃圾桶 → 先快照，再同步 state + DOM，通知中心記錄 ✅
      const trashedIds = evt.ids || [];
      // server snaps 優先（含即時 folder 資訊）；空物件時 fallback 至 client 快照
      const trashedSnaps = (evt.snaps && Object.keys(evt.snaps).length)
        ? evt.snaps : _snapItems(trashedIds);
      trashedIds.forEach(id => {
        const item = state.ALL.find(x => x.id === id);
        if (item && !(item.tags || []).includes('archived')) {
          item.tags = [...(item.tags || []), 'archived'];
        }
      });
      if (!state.trashMode) {
        trashedIds.forEach(id =>
          document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.remove()
        );
      } else {
        applyFilter();
      }
      addNotification('item_trashed_external', { ids: trashedIds, snaps: trashedSnaps }, 'ok');
      break;
    }
  }
}

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

/* ── 圖片導覽 callback（ArrowLeft/Right + swipe）────────────────── */
let _imageNavCurId = null;
function _imageNavCallback(dir) {
  const imgs = state.filtered.filter(i => i.file && i.media_type === 'image');
  const idx = imgs.findIndex(i => i.id === _imageNavCurId);
  if (idx < 0) return;
  const next = dir === 'prev' ? imgs[idx - 1] : imgs[idx + 1];
  if (!next) return;
  _imageNavCurId = next.id;
  trackView(next);
  openModal('/' + encodePath(next.file), 'image', next.id);
}

/* ── 卡片事件控制器 ──────────────────────────────────────────────── */
function _imgClick(itemId, src) {
  const item = state.ALL.find(x => x.id === itemId);
  if (item) trackView(item);
  openModal(src, 'image', itemId);
  _imageNavCurId = itemId;
  vcRegisterImageNav(_imageNavCallback);
}

function _cardClick(event, itemId, url) {
  // 在垃圾桶 overlay 內，點擊由 trash-wrap onclick 處理（_trashToggle），這裡不做任何動作
  if (event.target.closest('#trash-overlay')) return;
  if (isSelectMode()) { toggleSelect(itemId); return; }
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
  closeSettingsPanel();
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
  closeSettingsPanel();
  setTimeout(() => {
    trackView(item);
    openModal('/' + encodePath(item.file), 'image', item.id);
    _imageNavCurId = item.id;
    vcRegisterImageNav(_imageNavCallback);
  }, 50);
}

/* ── 類型篩選 dropdown（P3 w018-dev）────────────────────────────── */
const _TYPE_ICONS = { all: '🗂️', bookmark: '🔖', video: '🎬', gif: '🖼', image: '🌅' };

/** 計算 state.ALL 各類型數量（對應 search.js 的 curType 篩選邏輯）(w020) */
function _getTypeCounts() {
  const c = { all: state.ALL.length, bookmark: 0, video: 0, gif: 0, image: 0 };
  state.ALL.forEach(i => {
    const mt  = (i.media_type || '').toLowerCase();
    const ext = i.file ? i.file.toLowerCase().split('.').pop() : '';
    const isGif = mt === 'gif' || ext === 'gif';
    if (!i.file)              c.bookmark++;
    else if (mt === 'video')  c.video++;
    else if (isGif)           c.gif++;
    else if (mt === 'image')  c.image++;
  });
  return c;
}

function _updateTypeUI() {
  const icon = document.getElementById('type-icon');
  const btn  = document.getElementById('type-filter-btn');
  const isAll = state.curType === 'all';
  if (icon) icon.textContent = _TYPE_ICONS[state.curType] ?? '🗂️';
  btn?.classList.toggle('on', !isAll);
  // Badge：非「全部」時顯示 1，提供與其他篩選器一致的視覺訊號
  const typeBadge = document.getElementById('type-fbar-count');
  if (typeBadge) typeBadge.textContent = isAll ? '' : '1';
  const counts = _getTypeCounts();
  document.querySelectorAll('.type-opt').forEach(b => {
    b.classList.toggle('on', b.dataset.t === state.curType);
    const countEl = b.querySelector('.type-count');
    if (countEl) {
      const n = counts[b.dataset.t] ?? 0;
      // 顯示 '0' 而非空字串，明確告知該類型在資料庫中不存在（BUG 3）
      countEl.textContent = String(n);
    }
  });
}

function toggleTypeMenu() {
  const menu = document.getElementById('type-menu');
  const btn  = document.getElementById('type-filter-btn');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  // 互斥：開啟時關閉其他 filter panels（w019）
  if (willOpen) window._closeOtherPanels?.();
  if (willOpen && isMobile()) {
    const rect = btn.getBoundingClientRect();
    const pad  = 14;
    let l = Math.max(pad, rect.left);
    if (l + 140 > window.innerWidth - pad) l = window.innerWidth - 140 - pad;
    Object.assign(menu.style, {
      position: 'fixed', top: (rect.bottom + 6) + 'px',
      left: l + 'px', right: 'auto',
    });
  } else {
    Object.assign(menu.style, { position: '', top: '', left: '', right: '' });
  }
  menu.classList.toggle('open', willOpen);
  btn?.classList.toggle('open', willOpen);
}

function _setTypeFromMenu(t) {
  state.curType = t;
  document.getElementById('type-menu')?.classList.remove('open');
  document.getElementById('type-filter-btn')?.classList.remove('open');
  _updateTypeUI();
  updateSearchChips();   // BUG 2：同步搜尋框 chip 顯示
  applyFilter();
}

/* ── 排序選單 ────────────────────────────────────────────────────── */
const _SORT_ICONS = {
  shuffle: '🔀', date: '🕐', mtime: '🕑', name: '🔤', star: '⭐', size: '📦',
  ext: '📄', dim: '⬜', duration: '⏱️',
};
const _DEFAULT_DIRS = {
  date: 'desc', mtime: 'desc', name: 'asc', star: 'desc', size: 'desc',
  ext: 'asc', dim: 'desc', duration: 'desc',
};

function _saveSortState() {
  localStorage.setItem('eagle-sort', JSON.stringify({ key: state.curSortKey, dir: state.curSortDir }));
}

function _updateSortUI() {
  const isShuf = state.curSortKey === 'shuffle';
  // t043：shuffle-controls 已整合至 btn-sort（shuffle 模式下點 btn-sort = new shuffle）
  // shuffle-controls 永久隱藏，避免與 btn-sort 的 🔀 重複顯示
  const sc = document.getElementById('shuffle-controls');
  if (sc) sc.style.display = 'none';
  const icon = document.getElementById('sort-icon');
  if (icon) icon.textContent = _SORT_ICONS[state.curSortKey] ?? '⇅';
  const btnSort = document.getElementById('btn-sort');
  if (btnSort) {
    btnSort.classList.toggle('on', !isShuf);
    btnSort.title = isShuf ? '點擊新隨機排列' : '排列方式';
  }
  document.querySelectorAll('.sort-opt[data-sort-key]').forEach(b =>
    b.classList.toggle('on', b.dataset.sortKey === state.curSortKey)
  );
  document.querySelectorAll('.sort-dir[data-sort-key]').forEach(b => {
    const k = b.dataset.sortKey;
    const isActive = k === state.curSortKey;
    const dir = isActive ? state.curSortDir : (_DEFAULT_DIRS[k] ?? 'desc');
    b.textContent = dir === 'asc' ? '↑' : '↓';
    b.classList.toggle('on', isActive);
  });
}

function toggleSortMenu() {
  const menu = document.getElementById('sort-menu');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  if (willOpen && isMobile()) {
    const rect = document.getElementById('btn-sort').getBoundingClientRect();
    const pad = 14;
    const minW = 160;
    // 右對齊按鈕右邊緣，必要時向左推保留 pad
    let r = Math.max(pad, window.innerWidth - rect.right);
    if (window.innerWidth - r - minW < pad) r = window.innerWidth - minW - pad;
    Object.assign(menu.style, {
      position: 'fixed',
      top:   (rect.bottom + 6) + 'px',
      right: r + 'px',
      left:  'auto',
    });
  } else {
    Object.assign(menu.style, { position: '', top: '', left: '', right: '' });
  }
  menu.classList.toggle('open');
}

/** 選擇排序欄位（自動套用該欄位預設方向）並關閉選單 */
function setSortKey(key) {
  document.getElementById('sort-menu')?.classList.remove('open');
  // shuffle 重新點選 = new shuffle（產生新種子）
  if (key === 'shuffle' && state.curSortKey === 'shuffle') { _newShuffle(); return; }
  state.curSortKey = key;
  state.curSortDir = _DEFAULT_DIRS[key] ?? 'desc';
  _saveSortState();
  _updateSortUI();
  applyFilter();
}

/** 點擊方向按鈕：若已是當前欄位則 toggle 方向；否則選取欄位並套用預設方向 */
function setSortDirToggle(key) {
  if (key === state.curSortKey) {
    state.curSortDir = state.curSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.curSortKey = key;
    state.curSortDir = _DEFAULT_DIRS[key] ?? 'desc';
  }
  _saveSortState();
  _updateSortUI();
  applyFilter();
}

/** 卡片資訊（cbody）顯示切換 */
function toggleCardInfo() {
  const isClean = document.body.classList.toggle('clean-cards');
  localStorage.setItem('eagle-card-info', isClean ? '0' : '1');
  const btn = document.getElementById('btn-card-info');
  if (btn) btn.classList.toggle('on', isClean);
  requestAnimationFrame(_relayout);
}

function _initCardInfoState() {
  const stored = localStorage.getItem('eagle-card-info');
  if (stored === '0') {
    document.body.classList.add('clean-cards');
    const btn = document.getElementById('btn-card-info');
    if (btn) btn.classList.add('on');
  }
}

/** 從 localStorage 恢復排序狀態 */
function _initSortState() {
  try {
    const raw = localStorage.getItem('eagle-sort');
    if (raw) {
      const { key, dir } = JSON.parse(raw);
      // tags 已移除，fallback 到 date
      const validKey = key === 'tags' ? 'date' : key;
      if (validKey) state.curSortKey = validKey;
      if (dir === 'asc' || dir === 'desc') state.curSortDir = dir;
    }
  } catch {}
  _updateSortUI();
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

async function _autoIndexFolder(folderName) {
  state.ALL   = [];
  state.VIEWS = {};
  const grid  = document.getElementById('grid');
  const ibar  = document.getElementById('ibar');
  const stats = document.getElementById('stats-row');
  if (stats) stats.textContent = '';
  if (ibar)  ibar.textContent  = '';

  const _setMsg = (msg) => {
    if (grid) grid.innerHTML = `<div class="loading-indicator"><p>${msg}</p><p class="li-lib">${h(folderName)}</p></div>`;
  };
  const _setErr = (msg) => {
    if (grid) {
      grid.innerHTML = `<div class="loading-indicator error"><p>${h(msg)}</p><button id="li-retry-btn">重試</button></div>`;
      document.getElementById('li-retry-btn')?.addEventListener('click', () => _autoIndexFolder(folderName));
    }
  };

  _setMsg('正在啟動掃描…');

  let taskId;
  try {
    const res = await fetch('/api/folder-extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderName }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'unknown');
    taskId = result.task_id;
  } catch (e) {
    _setErr(`掃描啟動失敗：${String(e)}`); return;
  }

  // 輪詢掃描狀態（每 2s）
  let elapsed = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    elapsed += 2;
    _setMsg(`正在掃描資料夾… (${elapsed}s)`);
    try {
      const st = await fetch(`/api/folder-extract/status/${taskId}`).then(r => r.json());
      if (st.status === 'done') break;
      if (st.status === 'error') { _setErr(`掃描失敗：${st.error || 'unknown'}`); return; }
    } catch (_) { /* 網路暫斷繼續等待 */ }
  }

  const sel = document.getElementById('lib-select');
  if (sel) {
    const opt = [...sel.options].find(o => o.value === folderName);
    if (opt) opt.dataset.extracted = 'true';
    _updateLibSelectStyle(sel);
  }
  await _loadLibraryData(folderName);
}

/** 純資料載入（不含未匯出判斷，供 loadLibrary 內部使用） */
async function _loadLibraryData(libName, { skipDiff = false } = {}) {
  try {
    const res = await fetch(`/data/${encodeURIComponent(libName)}/urls_data.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.ALL = data.items || [];
    // Deduplicate by ID (guard against urls_data.json having duplicate Eagle IDs)
    const _seenIds = new Set();
    state.ALL = state.ALL.filter(i => _seenIds.has(i.id) ? false : (_seenIds.add(i.id), true));
    // 計算大小範圍供 log scale 進度條使用
    const _sizes = state.ALL.reduce((acc, i) => { if (i.size > 0) acc.push(i.size); return acc; }, []);
    state.sizeMin = _sizes.length ? _sizes.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    state.sizeMax = _sizes.length ? _sizes.reduce((a, b) => Math.max(a, b), -Infinity) : 0;
    // 計算尺寸範圍（width×height）供 dim log scale 進度條使用
    const _dims = state.ALL.reduce((acc, i) => { const px = (i.width || 0) * (i.height || 0); if (px > 0) acc.push(px); return acc; }, []);
    state.dimMin = _dims.length ? _dims.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    state.dimMax = _dims.length ? _dims.reduce((a, b) => Math.max(a, b), -Infinity) : 0;
    // 計算時長範圍供 duration log scale 進度條使用
    const _durs = state.ALL.reduce((acc, i) => { if (i.duration > 0) acc.push(i.duration); return acc; }, []);
    state.durationMin = _durs.length ? _durs.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    state.durationMax = _durs.length ? _durs.reduce((a, b) => Math.max(a, b), -Infinity) : 0;
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

  buildDomainChips();
  _updateTypeUI();                  // ← 資料就緒後同步更新類型計數（BUG 1 修復）
  newSeed(); updateSeedNav();
  await _fetchFolderMap(libName);   // ← 先 fetch folderMap（含 parentId/childrenIds）
  buildFolderTree();                // ← 再 build（folderMap 已就緒，才能渲染樹狀結構）
  applyFilter();
  // N01：先載入持久化通知（設定 _currentLib），再補追關閉期間異動
  loadPersistedNotifs(libName);          // ① 還原舊通知，_currentLib = libName
  if (!skipDiff) _runStartupDiff(libName); // ② diff（SSE reload 路徑跳過，避免重複通知）
}

/* ── N01-B：關閉期間異動補追 ─────────────────────────────────── */

/** 儲存當前 state.ALL 為 last-known state（每次 _loadLibraryData 後呼叫）*/
function _saveKnownState(libName) {
  const ids     = state.ALL.map(i => i.id);
  const trashed = state.ALL.filter(i => i.tags?.includes('archived')).map(i => i.id);
  try {
    localStorage.setItem(`eagle-known-${libName}`, JSON.stringify({ ids, trashed }));
  } catch (_) { /* 靜默失敗 */ }
}

/** startup diff：比對 last-known vs 當前 state.ALL，產生補追通知 */
function _runStartupDiff(libName) {
  let prev;
  try {
    const raw = localStorage.getItem(`eagle-known-${libName}`);
    prev = raw ? JSON.parse(raw) : null;
  } catch (_) { prev = null; }

  // 第一次啟動或無紀錄：直接存快照，不產生通知（避免假陽性）
  if (!prev || prev.ids.length === 0) { _saveKnownState(libName); return; }

  const currentIds     = new Set(state.ALL.map(i => i.id));
  const currentTrashed = new Set(state.ALL.filter(i => i.tags?.includes('archived')).map(i => i.id));
  const prevIds        = new Set(prev.ids);
  const prevTrashed    = new Set(prev.trashed || []);

  const newAdded   = [...currentIds].filter(id => !prevIds.has(id));
  const newTrashed = [...currentTrashed].filter(id => !prevTrashed.has(id));
  // 永久刪除：不在 currentIds，且先前非垃圾桶狀態
  const newRemoved = [...prevIds].filter(id => !currentIds.has(id) && !prevTrashed.has(id));

  // 在 state.ALL 仍有這些項目時立即快照，避免後續刪除後降級為 ID 顯示
  if (newAdded.length)   addNotification('item_added_external',   { ids: newAdded,   diff: newAdded.length, snaps: _snapItems(newAdded) }, 'ok');
  if (newTrashed.length) addNotification('item_trashed_external', { ids: newTrashed, snaps: _snapItems(newTrashed) }, 'ok');
  if (newRemoved.length) addNotification('item_removed_external', { ids: newRemoved, snaps: _snapItems(newRemoved) }, 'ok');

  _saveKnownState(libName);
}

/** 建立 client-side folderMap：{ [id]: { name, isLeaf, parentId, childrenIds } }
 *  呼叫 /api/folders，遞迴遍歷 tree，保留完整父子關係供 folder tree 渲染使用 */
async function _fetchFolderMap(libName) {
  try {
    const res = await fetch(`/api/folders?lib=${encodeURIComponent(libName)}`);
    if (!res.ok) { state.folderMap = {}; return; }
    const d = await res.json();
    const map = {};
    function _walk(nodes, parentId = null) {
      for (const node of (nodes || [])) {
        if (node.id) {
          map[node.id] = {
            name:       node.name || node.id,
            isLeaf:     !(node.children?.length),
            parentId,
            childrenIds: (node.children || []).map(c => c.id),
          };
        }
        _walk(node.children, node.id);
      }
    }
    _walk(d.folders || []);
    state.folderMap = map;
  } catch (_) { state.folderMap = {}; }
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
  state.curDomains = new Set();
  state.curType   = 'all';
  state.curTags   = new Set();
  state.curQ      = '';
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';
  _updateTypeUI();  // P3: 更新 type dropdown UI（取代 tpill.remove('on')）

  // 確認是否已匯出（向 selector 的 data-extracted 查詢，避免額外請求）
  const sel = document.getElementById('lib-select');
  const opt = sel ? [...sel.options].find(o => o.value === libName) : null;
  const isExtracted = opt ? opt.dataset.extracted === 'true' : true;

  const isFolder = opt ? opt.dataset.source === 'folder' : false;

  if (!isExtracted) {
    await (isFolder ? _autoIndexFolder(libName) : _autoIndex(libName));
    return;
  }

  await _loadLibraryData(libName);
  if (!isFolder) _initSSE(libName);
}

/** 切換資源庫（含 localStorage 固化 + R3 持久化） */
function switchLibrary(libName) {
  // N01：切換前先 snapshot 舊 lib 的 known state，並清除記憶體通知
  if (state.activeLib && state.ALL.length > 0) _saveKnownState(state.activeLib);
  clearMemoryNotifs();
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
    sel.innerHTML = libs.map(l => {
      const src       = l.source === 'folder' ? 'folder' : 'eagle';
      const notExtracted = (!l.extracted && src !== 'folder') ? '✦ ' : '';
      const icon      = l.source === 'folder' ? '🌸 ' : '🦅 ';
      const dispLabel = l.display_label || l.label;
      return `<option value="${h(l.name)}" data-extracted="${l.extracted}" data-label="${h(dispLabel)}" data-source="${src}">${notExtracted}${icon}${h(dispLabel)}</option>`;
    }).join('');
  }

  // 3. R3：從 localStorage 恢復上次選擇，驗證仍存在，fallback 至第一個
  const stored  = localStorage.getItem('eagle-active-lib');
  const isValid = libs.some(l => l.name === stored);
  const defLib  = isValid ? stored : libs[0].name;
  if (sel) sel.value = defLib;

  // 4. 綁定事件（先於 loadLibrary，避免 UI 尚未就緒）
  wireEvents();
  wireMobilePlayer();
  _initSortState();
  _initCardInfoState();
  _updateTypeUI();   // P3: 初始化 type dropdown UI

  // 5. 載入預設資源庫
  await loadLibrary(defLib);
}

/* ── Event wiring ────────────────────────────────────────────────── */
function wireEvents() {
  // 類型 dropdown（P3 w018-dev：取代 type-pills）
  document.querySelectorAll('.type-opt').forEach(b => {
    b.addEventListener('click', () => _setTypeFromMenu(b.dataset.t));
  });

  // 搜尋（debounce 180ms）
  let _st;
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(_st);
    _st = setTimeout(() => { state.curQ = e.target.value; applyFilter(); }, 180);
  });

  // 搜尋框 Escape 鍵：依序移除最後一個 chip → 清除搜尋文字
  document.getElementById('search').addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    const val = e.target.value;
    if (val) {
      // 先清搜尋文字
      e.target.value = ''; state.curQ = ''; applyFilter(); return;
    }
    // 文字已空：逐一移除最後一個 chip（folder → domain → preset）
    if (state.curFolderIds?.size) {
      const ids = [...state.curFolderIds];
      filterByFolderId(ids[ids.length - 1]); return;
    }
    if (state.curDomains.size) {
      const doms = [...state.curDomains];
      setDomain(doms[doms.length - 1]); return;
    }
    if (state.curPreset) { clearPresetFilter(); return; }
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
    if (e.key === 'Escape') { closeModal(); closeSettingsPanel(); closeMobilePlayer(); }
  });

  // 硬體返回鍵 / 瀏覽器返回：偵聽 popstate，依序關閉最上層的 overlay
  window.addEventListener('popstate', () => {
    if (document.getElementById('mplayer').classList.contains('open')) {
      closeMobilePlayer(true);
    } else if (document.getElementById('dplayer').classList.contains('open')) {
      closeDesktopPlayer(true);
    } else if (document.getElementById('stats-panel').classList.contains('open')) {
      closeSettingsPanel(true);
    } else if (document.getElementById('tag-panel').classList.contains('open')) {
      closeTagPanel(true);
    } else if (document.getElementById('modal').classList.contains('open')) {
      closeModal(true);
    }
  });

  // 排序選單：點外部關閉
  document.addEventListener('click', e => {
    const sortWrap = document.getElementById('sort-wrap');
    const sortMenu = document.getElementById('sort-menu');
    if (sortMenu?.classList.contains('open') && !sortWrap?.contains(e.target))
      sortMenu.classList.remove('open');

    // type-menu outside-click 關閉（P3）
    const typeWrap = document.getElementById('type-wrap');
    const typeMenu = document.getElementById('type-menu');
    if (typeMenu?.classList.contains('open') && !typeWrap?.contains(e.target)) {
      typeMenu.classList.remove('open');
      document.getElementById('type-filter-btn')?.classList.remove('open');
    }
  });

  wireDesktopPlayer();
  vcInitDragHandle();

  // 註冊 Autoplay Next：依目前開啟的播放器切換下一部
  vcRegisterAutoplayNext(() => {
    if (isDesktopPlayerOpen()) dpSwitch(1);
    else mpSwitch(1);
  });

  wireLongPress();

  // 向 trash.js 注入 batch.js 函式（避免 circular import）
  _registerBatchFns({ enterSelectMode, toggleSelect });
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
window._filterByTag          = filterByTag;
window._filterByItemTags     = filterByItemTags;
window._filterByFolderId        = filterByFolderId;
window._applyFolderFilter       = applyFolderFilter;
window.closeFolderPopover       = closeFolderPopover;
window.clearAllTags             = clearAllTags;
window.clearAllFilters          = clearAllFilters;
window.renderActiveFolderChips  = renderActiveFolderChips;
window.filterFolderTree         = filterFolderTree;
window.toggleTreeNode           = toggleTreeNode;
window.selectFolderBranch       = selectFolderBranch;
window.updateSearchChips        = updateSearchChips;
window.togglePresetPanel  = togglePresetPanel;
window.setPresetFilter    = setPresetFilter;
window.clearPresetFilter  = clearPresetFilter;
window.buildPresetChips   = buildPresetChips;

// Video Controls — Filter Presets
window.vcSaveFilterPreset          = vcSaveFilterPreset;
window.vcApplyFilterPreset         = vcApplyFilterPreset;
window.vcDeleteFilterPreset        = vcDeleteFilterPreset;
window.vcRenameFilterPreset        = vcRenameFilterPreset;
window.vcToggleVideoFilterPreset   = vcToggleVideoFilterPreset;
// Video Controls — Transform Snapshot
window.vcSaveTransformSnapshot  = vcSaveTransformSnapshot;
window.vcResetTransformSnapshot = vcResetTransformSnapshot;
window.vcSmartCrop              = vcSmartCrop;
window.vcToggleCropMode         = vcToggleCropMode;
window.vcCancelCrop             = vcCancelCrop;
window.vcApplyCrop              = vcApplyCrop;
// Video Controls — Playback
window.vcSetLoopMode  = vcSetLoopMode;
window.vcSetSpeed     = vcSetSpeed;
// Video Controls — Tab
window.vcSwitchTab    = vcSwitchTab;
// Video Controls — Reset
window.vcResetFilters   = vcResetFilters;
window.vcResetTransform = vcResetTransform;
window.vcDismissToast   = vcDismissToast;

// Type filter dropdown（P3 w018-dev）
window.toggleTypeMenu   = toggleTypeMenu;
window._updateTypeUI    = _updateTypeUI;   // 供 ui-filters.js clearAllFilters 呼叫
window.clearTypeFilter  = () => _setTypeFromMenu('all');  // 供 srch-chip ✕ 按鈕呼叫（BUG 2）
// 互斥面板關閉（w019）
window._closeTypeMenu   = () => {
  document.getElementById('type-menu')?.classList.remove('open');
  document.getElementById('type-filter-btn')?.classList.remove('open');
};

// Sort
window.toggleSortMenu   = toggleSortMenu;
window.setSortKey       = setSortKey;
window.setSortDirToggle = setSortDirToggle;

// Shuffle
window.newShuffle       = _newShuffle;
window.prevSeed         = _prevSeed;
window.nextSeed         = _nextSeed;
window.applyFilter      = applyFilter;   // jumpToSeed / settings 觸發重排用

// Stats（openStats/closeStats 改由 openSettingsPanel/closeSettingsPanel 統一管理）
window.openStats        = () => openSettingsPanel('stats');
window.closeStats       = closeSettingsPanel;
window.clearAllHistory  = clearAllHistory;
window._delHistItem     = delHistItem;
window._playVideoItem   = _playVideoItem;
window._openImageItem   = _openImageItem;
window.trackView        = trackView;

// Mobile player
window.closeMobilePlayer = () => { vcCancelCrop(); closeMobilePlayer(); };
window._mpTogglePlay    = mpTogglePlay;
window._mpSeekTo        = mpSeekTo;
window._mpSwitch        = mpSwitch;
window._mpSearchByTags  = mpSearchByTags;

// Desktop player
window.closeDesktopPlayer = () => { vcCancelCrop(); closeDesktopPlayer(); };
window._dpSeekTo        = dpSeekTo;
window._dpTogglePlay    = dpTogglePlay;
window._dpSwitch        = dpSwitch;
window._dpToggleMute    = dpToggleMute;
window._dpCycleWindowMode = dpCycleWindowMode;
window._dpSearchByTags  = dpSearchByTags;

// Video Controls Panel
window.toggleVcPanel    = toggleVcPanel;
window.closeVcPanel     = closeVcPanel;
window._vcFilter          = (key, val) => vcSetFilter(key, val);
window.vcStartEyedropper  = vcStartEyedropper;
window.vcSetSelectiveHue  = (key, val) => vcSetSelectiveHue(key, val);
window.vcClearSelectiveColor  = vcClearSelectiveColor;
window.vcAddSelectiveColor    = vcAddSelectiveColor;
window.vcSetActiveSelective   = vcSetActiveSelective;
window.vcRemoveSelective      = vcRemoveSelective;
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

// Action Sheet
window.openActionSheet      = openActionSheet;
window.closeActionSheet     = closeActionSheet;
window.actionArchive        = actionArchive;
window.actionRestore        = actionRestore;
window.actionMove           = actionMove;
window.actionRename         = actionRename;
window.closeRenameSheet     = closeRenameSheet;
window.confirmRename        = confirmRename;
window.actionEditTags       = actionEditTags;
window.closeTagsEditSheet   = closeTagsEditSheet;
window.confirmTagsEdit      = confirmTagsEdit;
window.onTagSearch          = onTagSearch;
window.onTagSearchKey       = onTagSearchKey;
window.actionStar           = actionStar;
window.closeStarSheet       = closeStarSheet;
window.confirmStar          = confirmStar;
window.actionAnnotation     = actionAnnotation;
window.closeAnnotationSheet = closeAnnotationSheet;
window.confirmAnnotation    = confirmAnnotation;
window.actionUrl            = actionUrl;
window.closeItemUrlSheet    = closeItemUrlSheet;
window.confirmUrl           = confirmUrl;
window.actionDelete         = actionDelete;
window.closeDeleteSheet     = closeDeleteSheet;
window.confirmDelete        = confirmDelete;

// Card info toggle
window.toggleCardInfo   = toggleCardInfo;

// Trash View
window.openTrashView    = openTrashView;
window.closeTrashView   = closeTrashView;
window.trashSelectAll   = trashSelectAll;
window.batchTrashRestore = batchTrashRestore;
window.batchTrashDelete  = batchTrashDelete;

// Batch Select
window.enterSelectMode = enterSelectMode;
window.exitSelectMode  = exitSelectMode;
window.batchArchive    = batchArchive;
window.batchFolders    = batchFolders;
window.batchDelete     = batchDelete;

// Folder Picker
window._fpToggle          = fpToggle;
window._fpRemove          = fpRemove;
window.confirmFolderPicker = confirmFolderPicker;
window.closeFolderPicker  = closeFolderPicker;
window.onFolderSearch     = onFolderSearch;

// Settings / Tags Sync（⚙ 4-tab 統一面板，t042 w022-dev）
window.openSettingsPanel  = openSettingsPanel;
window.closeSettingsPanel = closeSettingsPanel;
window.switchSettingsTab  = switchSettingsTab;
window.folderTagsDiff     = folderTagsDiff;
window.folderTagsApply    = folderTagsApply;
window.itemsTagsDiff      = itemsTagsDiff;
window.itemsTagsApply     = itemsTagsApply;
window.setPrefMaxSeeds    = setPrefMaxSeeds;
window.clearShuffleHistory = clearShuffleHistory;
window.jumpToSeed         = jumpToSeed;

// Import / Upload (wf-007)
window.openUploadSheet    = openUploadSheet;
window.closeUploadSheet   = closeUploadSheet;
window.submitUpload       = submitUpload;

// URL Import (wf-008)
window.openUrlSheet       = openUrlSheet;
window.closeUrlSheet      = closeUrlSheet;
window.submitUrlImport    = submitUrlImport;
window.toggleFabMenu      = toggleFabMenu;
window.closeFabMenu       = closeFabMenu;

// 通知中心：自動重建索引（item_added_external 專用）
async function _autoExtract(notifId, addedIds = []) {
  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lib: state.activeLib }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    await _loadLibraryData(state.activeLib, { skipDiff: true });   // SSE 路徑跳過 diff
    // 載入後從 state.ALL 快照新增項目的資訊
    if (addedIds.length) {
      updateNotifNames(notifId, _snapItems(addedIds));
    }
    updateNotifStatus(notifId, 'ok');
  } catch (e) {
    updateNotifStatus(notifId, 'error', e.message || '重建索引失敗');
  }
}

// 注入重試 callback（notifications.js 的 _notifRetry 呼叫）
registerRetryFn(async (notif) => {
  if (notif.type === 'item_added_external') {
    await _autoExtract(notif.id);
  }
});

// 通知中心（已整合至 ⚙ 設定面板 notif tab，t042 w022-dev）
// openNotifPanel/closeNotifPanel 向後相容保留在 notifications.js

// 圖片控制（供 #vc-pane-image 內 onclick 使用）
window.vcImageZoom        = vcImageZoom;
window.vcImageZoomSet     = vcImageZoomSet;
window.vcImageFit         = vcImageFit;
window.vcImageActualSize  = vcImageActualSize;
window.vcSetModalBg     = vcSetModalBg;
window.vcImageNav       = vcImageNav;

// URL
window._openUrl         = _openUrl;

// Misc（供 stats.js 內嵌 HTML 使用）
window._HIDE_TAGS       = HIDE_TAGS;
window._lookupItem      = id => state.ALL.find(x => x.id === id);  // 永遠讀到最新 state.ALL
window._folderMap       = () => state.folderMap;                    // 供通知中心 live fallback 用
window.h                = h;

/* ── 啟動 ────────────────────────────────────────────────────────── */
init();
