/* ── viewer.js ▸ 統一 Immersive Viewer（B3，spec §3）─────────────────────
   圖片與影片同一容器（#uv-zoom 依 kind 掛 img/video）；恆深色。
   URL 即狀態（§5.4 #1）：開啟 = pushState `?item={id}`、上下切換 =
   replaceState、關閉 = history.back()；popstate 由 router 唯一 handler
   宣告式 diff（app.js render → syncViewerFromRoute）。
   媒體引擎重用舊版 vc-* 模組：影片 = vcInitVid 完整生命週期（P1 濾鏡狀態機
   + WebGL overlay；#uv-zoom = zoomWrapper，父層 #uv-wrap 為 positioned
   ancestor，與 _glEnsureAttached / vcSyncGlCanvas 期望的結構一致）；
   圖片 = vcInitMedia + 本檔 iz 焦點縮放引擎（vcRegisterImageZoom 注入）。
   Excire 圖片 = /excire-preview 三級載入，「原圖」鈕切換 /excire-file。 */

import { store } from './store.js';
import { mediaURL } from './api.js';
import { navigate, parseRoute, parseLibId } from './router.js';
import { h, serializeTerms } from './items.js';
import { vcInitVid, vcInitMedia, vcSetMediaType, vcAbTimeUpdate,
         vcRegisterAutoplayNext, vcRegisterImageZoom, vcRegisterImageNav,
         vcApplyTransform, vcSyncGlCanvas, vcSyncPanel, vcCancelCrop }
  from '../../viewer/js/video-controls.js';
import { openDrawer, closeDrawer, toggleDrawer, isDrawerOpen,
         syncDrawerFromQuery, setDrawerInfo } from './vc-drawer.js';
import { initViewerTouch } from './viewer-touch.js';

const V = {
  open: false, pushed: false, items: [], idx: -1,
  media: null, kind: null,                 // 'video' | 'image'
  playStart: null, sessionDur: 0,          // 停留時間追蹤（C32）
  uiTimer: null, dblTimer: null, wheelAt: 0,
  vz: { s: 1, tx: 0, ty: 0 },              // 影片 zoomWrapper 縮放（Ctrl+滾輪 1–4×）
  iz: { s: 1, px: 0, py: 0, dragging: false, lx: 0, ly: 0 },   // 圖片焦點縮放 1–8×
  touch: null, orig: false,                // orig = Excire 原圖已切換
};
let _expectPush = false;
let _retryOff = null;
let _resolvers = { folderName: id => id, libLabel: () => '' };

const $ = id => document.getElementById(id);
const _fmt = s => { if (!isFinite(s)) return '–:––';
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`; };

/* ── 對外：開啟（selection.js 卡片點擊/Enter 呼叫）───────────────────── */

export function openViewerFor(id) {
  const r = parseRoute();
  r.query.set('item', id);
  _expectPush = true;
  navigate('#' + r.path + '?' + r.query.toString());
}

/* ── 對外：宣告式同步（app.js render 每次呼叫）──────────────────────── */

export function syncViewerFromRoute(route) {
  let id = route.query?.get('item') || null;
  if (!id && route.params?.itemId) {       // 路徑深連結別名 → 正規化為 ?item=
    id = route.params.itemId;
    const q = new URLSearchParams(route.query);
    q.set('item', id);
    history.replaceState(history.state, '', `#/lib/${encodeURIComponent(route.params.libId)}?${q}`);
  }
  if (!id) { if (V.open) _teardown(); return; }
  if (V.open && V.items[V.idx]?.id === id) { syncDrawerFromQuery(route.query); return; }

  const grid = store.state.gridItems || [];
  let items = grid, idx = grid.findIndex(i => i.id === id);
  if (idx < 0) {
    const it = (store.state.allItems || []).find(i => i.id === id);
    if (it) { items = [it]; idx = 0; }
    else {                                  // Excire 分頁尚未載入 → 等一次 grid-items
      if (_retryOff) return;
      _retryOff = store.on('grid-items', () => {
        _retryOff?.(); _retryOff = null;
        syncViewerFromRoute(parseRoute());
      });
      return;
    }
  }
  V.items = items; V.idx = idx;
  V.pushed = V.open ? V.pushed : _expectPush;
  _expectPush = false;
  if (!V.open) { V.open = true; $('uviewer').hidden = false; _resetUITimer(); }
  _load();
  syncDrawerFromQuery(route.query);
}

export function setViewerResolvers(r) { Object.assign(_resolvers, r); }

/* ── 關閉 ────────────────────────────────────────────────────────────── */

function _requestClose() {
  if (V.pushed) { history.back(); return; }      // popstate → render → teardown
  const r = parseRoute();
  r.query.delete('item'); r.query.delete('drawer');
  const qs = r.query.toString();
  navigate('#' + r.path + (qs ? '?' + qs : ''), { replace: true });
}

function _teardown() {
  _commitTrack();
  vcCancelCrop();
  _closeTagsPop();
  if (V.media?.tagName === 'VIDEO') { V.media.pause(); V.media.src = ''; }
  $('uv-zoom').innerHTML = '';
  V.media = null; V.open = false; V.pushed = false;
  closeDrawer();
  $('uv-kbd').hidden = true;
  $('uviewer').hidden = true;
  $('uviewer').classList.remove('ui-hidden');
  if (document.fullscreenElement === $('uviewer')) document.exitFullscreen().catch(() => {});
  clearTimeout(V.uiTimer);
}

/* ── 上/下導覽 ───────────────────────────────────────────────────────── */

function _nav(dir) {
  if (!V.open) return;
  const next = V.idx + dir;
  if (next < 0 || next >= V.items.length) { _flash(dir < 0 ? '已是第一個' : '已是最後一個'); return; }
  V.idx = next;
  const r = parseRoute();                        // 切換 = replaceState（§5.4 #1）
  r.query.set('item', V.items[next].id);
  history.replaceState(history.state, '', '#' + r.path + '?' + r.query.toString());
  _load();
}

/* ── 載入當前項目 ────────────────────────────────────────────────────── */

function _load() {
  const it = V.items[V.idx];
  if (!it) return;
  _commitTrack();
  vcCancelCrop();
  if (V.media?.tagName === 'VIDEO') { V.media.pause(); V.media.src = ''; }
  const zoom = $('uv-zoom');
  zoom.innerHTML = '';
  zoom.style.transform = '';
  V.vz = { s: 1, tx: 0, ty: 0 };
  V.iz = { s: 1, px: 0, py: 0, dragging: false, lx: 0, ly: 0 };
  V.orig = false;

  /* chrome：計數 / 標題 / 資訊層（檔名/庫/資料夾/尺寸） */
  $('uv-counter').textContent = `${V.idx + 1} / ${V.items.length}`;
  $('uv-title').textContent = it.name || it.id;
  $('uv-domain').textContent = it.domain && it.domain !== 'local' ? it.domain : '';
  const folders = (it.folders || []).map(_resolvers.folderName).filter(Boolean);
  $('uv-caption').textContent = [
    _resolvers.libLabel(),
    folders.join('、'),
    it.width && it.height ? `${it.width}×${it.height}` : '',
  ].filter(Boolean).join(' · ');
  const eagleBtn = $('uv-eagle');
  eagleBtn.hidden = it.source !== 'eagle';
  if (!eagleBtn.hidden) eagleBtn.href = `eagle://item/${encodeURIComponent(it.id)}`;
  const linkBtn = $('uv-link');
  linkBtn.hidden = !it.url;
  if (it.url) linkBtn.href = it.url;
  _closeTagsPop();
  $('uv-tags').hidden = !(it.tags || []).some(t => t !== 'archived');   // C31/C34 標籤搜尋鈕
  setDrawerInfo(it, { libLabel: _resolvers.libLabel(), folderNames: folders });

  V.kind = it.mediaType === 'video' ? 'video' : 'image';
  $('uv-orig').hidden = !(it.source === 'excire' && V.kind === 'image');
  $('uv-orig').classList.remove('on');
  $('uv-controls').hidden = V.kind !== 'video';
  V.kind === 'video' ? _buildVideo(it, zoom) : _buildImage(it, zoom);
}

function _buildVideo(it, zoom) {
  const vid = document.createElement('video');
  vid.playsInline = true; vid.autoplay = true; vid.preload = 'auto';
  vid.fetchPriority = 'high';
  vid.src = mediaURL(it.file);
  if (it.thumb) vid.poster = mediaURL(it.thumb);
  zoom.appendChild(vid);
  V.media = vid;
  vcInitVid(vid, it.id);                   // 濾鏡狀態機 + WebGL overlay + AB + 幾何快照
  vid.addEventListener('play',  () => { V.playStart = Date.now(); _setPlayBtn(false); _resetUITimer(); });
  vid.addEventListener('pause', () => { _accumDur(); _setPlayBtn(true); });
  vid.addEventListener('ended', _accumDur);
  vid.addEventListener('loadedmetadata', _updateProg);
  vid.addEventListener('seeked', _updateProg);
  vid.addEventListener('timeupdate', () => { _updateProg(); vcAbTimeUpdate(vid); });
  vid.play().catch(() => {});
  _setPlayBtn(false);
  _updateProg();
}

function _buildImage(it, zoom) {
  vcSetMediaType('image');                 // 先同步 drawer tab（modal.js 同款時序）
  vcSyncPanel();
  const img = document.createElement('img');
  img.alt = '';
  img.fetchPriority = 'high';
  img.src = mediaURL(it.source === 'excire' ? (it.preview || it.file) : (it.file || it.thumb));
  img.addEventListener('mousedown', _izDown);
  img.addEventListener('dblclick', e => { e.stopPropagation(); V.iz = { ...V.iz, s: 1, px: 0, py: 0 }; _izApply(); });
  zoom.appendChild(img);
  V.media = img;
  const init = () => { if (img === V.media) vcInitMedia(img, it.id, 'image'); };
  img.complete ? requestAnimationFrame(init) : img.addEventListener('load', init, { once: true });
}

/** Excire 原圖切換（preview 1280 ↔ 原檔） */
function _toggleOriginal() {
  const it = V.items[V.idx];
  if (!it || V.kind !== 'image' || it.source !== 'excire') return;
  V.orig = !V.orig;
  $('uv-orig').classList.toggle('on', V.orig);
  const img = V.media;
  img.src = mediaURL(V.orig ? it.file : (it.preview || it.file));
  img.addEventListener('load', () => { if (img === V.media) vcInitMedia(img, it.id, 'image'); }, { once: true });
}

/* ── 圖片焦點縮放引擎（1–8×，vcRegisterImageZoom 注入 drawer 檢視 tab）── */

function _izApply() {
  const img = V.media;
  if (!img || V.kind !== 'image') return;
  vcApplyTransform(img);                   // 先套 vc 幾何（翻轉/旋轉），再前置 iz 縮放平移
  const { s, px, py } = V.iz;
  if (s > 1.001 || px || py) {
    const base = img.style.transform || '';
    img.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) scale(${s.toFixed(3)})${base ? ' ' + base : ''}`;
  }
  img.style.cursor = s > 1.001 ? (V.iz.dragging ? 'grabbing' : 'grab') : '';
  vcSyncGlCanvas(img);
  _zoomInd(V.iz.s);
}

function _izZoom(delta, absolute) {
  if (V.kind !== 'image') return;
  V.iz.s = Math.max(1, Math.min(8, absolute !== undefined ? absolute : V.iz.s + delta));
  if (V.iz.s <= 1.001) { V.iz.px = 0; V.iz.py = 0; }
  _izApply(); vcSyncPanel();
}
function _izFit() {
  if (V.kind !== 'image') return;
  V.iz.px = 0; V.iz.py = 0; V.iz.s = 1;
  _izApply(); vcSyncPanel();
}
function _izActual() {
  const img = V.media;
  if (V.kind !== 'image' || !img?.naturalWidth || !img.clientWidth) return;
  _izZoom(0, img.naturalWidth / img.clientWidth);
}
function _izDown(e) {
  if (V.iz.s <= 1.001 || e.button !== 0) return;
  V.iz.dragging = true; V.iz.lx = e.clientX; V.iz.ly = e.clientY;
  e.preventDefault();
}
function _izMove(e) {
  if (!V.iz.dragging) return;
  V.iz.px += e.clientX - V.iz.lx; V.iz.py += e.clientY - V.iz.ly;
  V.iz.lx = e.clientX; V.iz.ly = e.clientY;
  _izApply();
}
function _izUp() { if (V.iz.dragging) { V.iz.dragging = false; _izApply(); } }

vcRegisterImageZoom(_izZoom, _izFit, () => V.iz.s, _izActual);
vcRegisterImageNav(dir => _nav(dir === 'next' ? 1 : -1));
vcRegisterAutoplayNext(() => { if (V.open) _nav(1); });

/* ── 影片 Ctrl+滾輪縮放（游標焦點 1–4×，zoomWrapper transform）───────── */

/** 影片縮放（絕對倍率，捏合手勢用；置中縮放） */
function _vzSet(s) {
  const zoom = $('uv-zoom');
  V.vz.s = Math.max(1, Math.min(4, s));
  if (V.vz.s <= 1.005) V.vz = { s: 1, tx: 0, ty: 0 };
  zoom.style.transform = V.vz.s === 1 ? '' :
    `translate(${V.vz.tx.toFixed(1)}px,${V.vz.ty.toFixed(1)}px) scale(${V.vz.s.toFixed(3)})`;
  _zoomInd(V.vz.s);
}

function _vzWheel(e) {
  const zoom = $('uv-zoom');
  const old = V.vz.s;
  const s = Math.max(1, Math.min(4, old + (e.deltaY < 0 ? 0.12 : -0.12)));
  if (s === old) return;
  const rect = zoom.getBoundingClientRect();
  const cx = e.clientX - (rect.left + rect.width / 2);
  const cy = e.clientY - (rect.top + rect.height / 2);
  V.vz.tx = cx * (1 - s / old) + V.vz.tx * (s / old);
  V.vz.ty = cy * (1 - s / old) + V.vz.ty * (s / old);
  V.vz.s = s;
  if (s <= 1.005) V.vz = { s: 1, tx: 0, ty: 0 };
  zoom.style.transform = V.vz.s === 1 ? '' :
    `translate(${V.vz.tx.toFixed(1)}px,${V.vz.ty.toFixed(1)}px) scale(${V.vz.s.toFixed(3)})`;
  _zoomInd(V.vz.s);
}

/* ── 播放控制列 ──────────────────────────────────────────────────────── */

function _togglePlay() {
  const v = V.media;
  if (V.kind !== 'video' || !v) return;
  v.paused ? v.play().catch(() => {}) : v.pause();
}
function _seekBy(sec) {
  const v = V.media;
  if (V.kind === 'video' && v?.duration) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
}
function _setPlayBtn(paused) {
  $('uv-play').innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${paused ? 'play' : 'pause'}"/></svg>`;
}
function _updateProg() {
  const v = V.media;
  if (V.kind !== 'video' || !v) return;
  $('uv-time').textContent = `${_fmt(v.currentTime)} / ${_fmt(v.duration)}`;
  if (v.duration) $('uv-prog').value = (v.currentTime / v.duration) * 100;
}

/* ── 停留時間追蹤（C32：POST /api/track）─────────────────────────────── */

function _accumDur() {
  if (V.playStart) { V.sessionDur += (Date.now() - V.playStart) / 1000; V.playStart = null; }
}
function _commitTrack() {
  _accumDur();
  const it = V.items[V.idx];
  const lib = parseLibId(store.state.libId || '');
  if (V.sessionDur > 1 && it && lib && it.source !== 'excire') {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: it.id, name: it.name, domain: it.domain,
                             duration: Math.round(V.sessionDur), lib: lib.slug }),
    }).catch(() => {});
  }
  V.sessionDur = 0; V.playStart = null;
}

/* ── 標籤搜尋（C31/C34：頂列 🏷 → chips popover → 以標籤搜尋並關閉）──── */

function _closeTagsPop() { document.getElementById('uv-tags-pop')?.remove(); }

function _toggleTagsPop() {
  if (document.getElementById('uv-tags-pop')) { _closeTagsPop(); return; }
  const it = V.items[V.idx];
  const tags = (it?.tags || []).filter(t => t !== 'archived');
  if (!tags.length) return;
  const pop = document.createElement('div');
  pop.id = 'uv-tags-pop';
  pop.className = 'uv-tags-pop';
  pop.innerHTML = `<p class="uv-tags-hint">點標籤 = 關閉並以該標籤搜尋</p>` +
    tags.map(t => `<button class="chip" data-t="${h(t)}">🏷 ${h(t)}</button>`).join('');
  $('uviewer').appendChild(pop);
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    _closeTagsPop();
    const libId = store.state.libId;
    if (!libId) return;
    const q = serializeTerms([{ field: 'tag', value: b.dataset.t, exclude: false }]);
    // 導覽至庫根 + q（新 hash 無 ?item= → render 宣告式關閉 viewer）
    navigate(`#/lib/${encodeURIComponent(libId)}?q=${encodeURIComponent(q)}`);
  });
}

/* ── UI 提示 ─────────────────────────────────────────────────────────── */

function _flash(text) {
  const el = $('uv-flash');
  el.textContent = text; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1100);
}
function _zoomInd(s) {
  const el = $('uv-zoomind');
  el.textContent = s > 1.01 ? `${Math.round(s * 100)}%` : '';
  el.classList.toggle('show', s > 1.01);
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1400);
}
function _resetUITimer() {
  const root = $('uviewer');
  root.classList.remove('ui-hidden');
  clearTimeout(V.uiTimer);
  V.uiTimer = setTimeout(() => {
    if (V.open && V.kind === 'video' && V.media && !V.media.paused) root.classList.add('ui-hidden');
  }, 3000);
}

/* ── 鍵盤（capture：viewer 開啟時攔截 grid/toolbar 快捷鍵）───────────── */

function _onKey(e) {
  if (!V.open) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key;
  if (k === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (!$('uv-kbd').hidden) $('uv-kbd').hidden = true;
    else if (isDrawerOpen()) closeDrawer();
    else _requestClose();
    return;
  }
  const map = {
    ' ':          () => V.kind === 'video' && _togglePlay(),
    'ArrowLeft':  () => V.kind === 'video' ? _seekBy(-5) : _nav(-1),
    'ArrowRight': () => V.kind === 'video' ? _seekBy(5) : _nav(1),
    'ArrowUp':    () => _nav(-1),
    'ArrowDown':  () => _nav(1),
    'f': _toggleFs, 'F': _toggleFs,
    'm': _toggleMute, 'M': _toggleMute,
    'c': () => toggleDrawer(V.kind === 'video' ? 'playback' : 'image'),
    'C': () => toggleDrawer(V.kind === 'video' ? 'playback' : 'image'),
    '?': () => { $('uv-kbd').hidden = !$('uv-kbd').hidden; },
  };
  if (map[k]) { e.preventDefault(); e.stopPropagation(); map[k](); _resetUITimer(); }
}

function _toggleFs() {
  const root = $('uviewer');
  if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
  else root.requestFullscreen().catch(() => {});
}
function _toggleMute() {
  const v = V.media;
  if (V.kind !== 'video' || !v) return;
  v.muted = !v.muted;
  $('uv-mute').innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${v.muted ? 'mute' : 'volume'}"/></svg>`;
}

/* ── 初始化（一次性事件掛載）────────────────────────────────────────── */

export function initViewer(resolvers = {}) {
  Object.assign(_resolvers, resolvers);
  $('uv-close').addEventListener('click', _requestClose);
  $('uv-prev').addEventListener('click', () => _nav(-1));
  $('uv-next').addEventListener('click', () => _nav(1));
  $('uv-play').addEventListener('click', _togglePlay);
  $('uv-mute').addEventListener('click', _toggleMute);
  $('uv-fs').addEventListener('click', _toggleFs);
  $('uv-orig').addEventListener('click', _toggleOriginal);
  $('uv-tags').addEventListener('click', _toggleTagsPop);
  $('uv-kbd-btn').addEventListener('click', () => { $('uv-kbd').hidden = !$('uv-kbd').hidden; });
  $('uv-kbd').addEventListener('click', () => { $('uv-kbd').hidden = true; });
  $('uv-btn-info').addEventListener('click', () => toggleDrawer('info'));
  $('uv-btn-ctrl').addEventListener('click', () =>
    toggleDrawer(V.kind === 'video' ? 'playback' : 'image'));
  $('uv-prog').addEventListener('input', e => {
    const v = V.media;
    if (V.kind === 'video' && v?.duration) v.currentTime = (+e.target.value / 100) * v.duration;
  });

  const stage = $('uv-stage');
  /* 滾輪 = 上/下導覽；Ctrl/⌘+滾輪 = 縮放（圖片 1–8× / 影片 1–4×） */
  stage.addEventListener('wheel', e => {
    if (!V.open) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      V.kind === 'video' ? _vzWheel(e) : _izZoom(e.deltaY < 0 ? 0.15 : -0.15);
      return;
    }
    const now = Date.now();
    if (now - V.wheelAt < 250) return;          // 節流：一格 = 一張
    V.wheelAt = now;
    _nav(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  /* 單擊：影片 = 播/暫停（防抖讓位雙擊）；空白區（圖片模式）= 關閉 */
  stage.addEventListener('click', e => {
    if (e.target.closest('.uv-nav, #uv-controls')) return;
    if (V.iz.dragging) return;
    if (V.kind === 'video' && e.target === V.media) {
      clearTimeout(V.dblTimer);
      V.dblTimer = setTimeout(() => _togglePlay(), 260);
    } else if (e.target === stage || e.target === $('uv-wrap') || e.target === $('uv-zoom')) {
      _requestClose();
    }
  });
  stage.addEventListener('dblclick', e => {
    if (V.kind === 'video' && e.target === V.media) { clearTimeout(V.dblTimer); _toggleFs(); }
  });

  /* 行動輸入層（C33：縱滑/橫拖 seek/邊緣返回/捏合/清屏/雙擊播暫） */
  initViewerTouch(stage, {
    isOpen: () => V.open,
    kind: () => V.kind,
    nav: _nav,
    seekBy: _seekBy,
    requestClose: _requestClose,
    togglePlay: _togglePlay,
    toggleUi: () => { $('uviewer').classList.toggle('ui-hidden'); clearTimeout(V.uiTimer); },
    getZoom: () => (V.kind === 'video' ? V.vz.s : V.iz.s),
    zoomTo: s => { V.kind === 'video' ? _vzSet(s) : _izZoom(0, s); },
  });

  document.addEventListener('mousemove', e => {
    if (V.open) { _izMove(e); _resetUITimer(); }
  });
  document.addEventListener('mouseup', _izUp);
  document.addEventListener('keydown', _onKey, true);
  window.addEventListener('resize', () => {
    if (V.open && V.media) { vcSyncGlCanvas(V.media); if (V.kind === 'image') _izApply(); }
  });
}
