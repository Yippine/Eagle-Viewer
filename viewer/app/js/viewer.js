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
import { vcState, vcInitVid, vcInitMedia, vcSetMediaType, vcAbTimeUpdate,
         vcRegisterAutoplayNext, vcRegisterImageZoom, vcRegisterImageNav,
         vcApplyTransform, vcSyncGlCanvas, vcSyncPanel, vcCancelCrop, vcIsInteractionLocked, vcCompareHold, vcCompareOff }
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

let _ctxList = null;   // 來源清單覆寫（統計 TOP10／觀看記錄等非 grid 清單 → 上下切換依該清單順序）

/** @param {string} id  @param {Array<vm>=} list 來源清單（可含順序）；省略則用 grid 清單 */
export function openViewerFor(id, list = null) {
  _ctxList = Array.isArray(list) && list.length ? list : null;
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
  if (_ctxList) {                           // 來源清單優先（TOP10／觀看記錄的點擊重播）
    const ci = _ctxList.findIndex(i => i.id === id);
    if (ci >= 0) { items = _ctxList; idx = ci; }
    _ctxList = null;                        // 一次性消費；之後 viewer 內部導覽沿用 V.items
  }
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
  if (!V.open) {
    V.open = true; $('uviewer').hidden = false; _resetUITimer();
    _autoFullscreenOnMobile();
  }
  _load();
  syncDrawerFromQuery(route.query);
}

/* 手機：開啟媒體即進入全螢幕（沉浸式，同 YouTube／TikTok 行為）。
   需在使用者手勢的 transient activation 內（點格子 → hashchange → 此處，仍在 5s 視窗）；
   iOS Safari 不支援非 <video> 全螢幕 → 靜默略過（viewer 本身已滿版）。 */
const _MQ_PHONE = window.matchMedia('(max-width: 767px)');
function _autoFullscreenOnMobile() {
  if (!_MQ_PHONE.matches || !document.fullscreenEnabled) return;
  const root = $('uviewer');
  if (document.fullscreenElement === root) return;
  root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
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
  vcCompareOff();                                  // 分割／按住比對：解除 document 層攔截監聽，否則關閉後整頁卡死
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
  vid.addEventListener('loadedmetadata', _renderRanges);
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
  // 書籤（無本地檔）只有縮圖：比照影片自動放大填滿視窗（object-fit:contain），而非以縮圖原尺寸顯示
  img.classList.toggle('uv-fit', it.mediaType === 'bookmark' || (!it.file && !!it.thumb));
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

/** 錨點縮放：以螢幕座標 (ax, ay) 為不動點（省略 = 畫面中心）。
    幾何：元素以自身中心 O 為 transform-origin，螢幕點 p = O + t + s·u；
    保持 u 不變 → t' = (p−O)(1−s'/s) + t·(s'/s)；O = 目前 rect 中心 − t。 */
function _anchorTranslate(el, t, sOld, sNew, ax, ay) {
  const r = el.getBoundingClientRect();
  const ox = r.left + r.width / 2 - t.x, oy = r.top + r.height / 2 - t.y;
  const px = (ax ?? (ox + t.x)) - ox, py = (ay ?? (oy + t.y)) - oy;
  const k = sNew / sOld;
  return { x: px * (1 - k) + t.x * k, y: py * (1 - k) + t.y * k };
}

function _izZoom(delta, absolute, ax, ay) {
  if (V.kind !== 'image') return;
  const old = V.iz.s;
  const s = Math.max(1, Math.min(8, absolute !== undefined ? absolute : old + delta));
  if (s !== old && V.media) {
    const t = _anchorTranslate(V.media, { x: V.iz.px, y: V.iz.py }, old, s, ax, ay);
    V.iz.px = t.x; V.iz.py = t.y;
  }
  V.iz.s = s;
  if (V.iz.s <= 1.001) { V.iz.px = 0; V.iz.py = 0; }
  _izApply(); vcSyncPanel();
}
function _izPanBy(dx, dy) {
  if (V.kind !== 'image' || V.iz.s <= 1.001) return;
  V.iz.px += dx; V.iz.py += dy; _izApply();
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

function _vzApply() {
  const zoom = $('uv-zoom');
  if (V.vz.s <= 1.005) V.vz = { s: 1, tx: 0, ty: 0 };
  zoom.style.transform = V.vz.s === 1 ? '' :
    `translate(${V.vz.tx.toFixed(1)}px,${V.vz.ty.toFixed(1)}px) scale(${V.vz.s.toFixed(3)})`;
  _zoomInd(V.vz.s);
}
/** 影片縮放（絕對倍率）：以螢幕座標 (ax, ay) 為錨點（滾輪游標／捏合中點），省略 = 置中 */
function _vzSet(s, ax, ay) {
  const old = V.vz.s;
  s = Math.max(1, Math.min(4, s));
  if (s !== old) {
    const t = _anchorTranslate($('uv-zoom'), { x: V.vz.tx, y: V.vz.ty }, old, s, ax, ay);
    V.vz.tx = t.x; V.vz.ty = t.y;
  }
  V.vz.s = s;
  _vzApply();
}
function _vzPanBy(dx, dy) {
  if (V.vz.s <= 1.005) return;
  V.vz.tx += dx; V.vz.ty += dy; _vzApply();
}
function _vzWheel(e) {
  _vzSet(V.vz.s + (e.deltaY < 0 ? 0.12 : -0.12), e.clientX, e.clientY);
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
/* 進度條色塊時段標記（vc-ranges-changed：選色時段／AB 變更時重繪；切片時亦重繪） */
function _renderRanges() {
  const box = $('uv-ranges');
  if (!box) return;
  const v = V.media;
  if (V.kind !== 'video' || !v || !v.duration || !isFinite(v.duration)) { box.innerHTML = ''; return; }
  const st = vcState();
  const d = v.duration;
  const segs = [];
  for (const it of (st.selectiveList || [])) {
    if (it.abStart === null || it.targetHue === null) continue;
    const color = it.pickedRgb ? `rgb(${it.pickedRgb[0]},${it.pickedRgb[1]},${it.pickedRgb[2]})` : `hsl(${it.targetHue},70%,50%)`;
    const looping = st.ab.active && st.ab.a !== null && st.ab.b !== null &&
      Math.abs(st.ab.a - it.abStart) < 0.05 && Math.abs(st.ab.b - it.abEnd) < 0.05;
    segs.push({ a: it.abStart, b: it.abEnd, color, looping, title: `色塊時段 ${_fmt(it.abStart)}–${_fmt(it.abEnd)}` });
  }
  /* 播放 AB（非色塊來源）也以中性色標示 */
  if (st.ab.a !== null && st.ab.b !== null && !segs.some(s => s.looping))
    segs.push({ a: st.ab.a, b: st.ab.b, color: 'rgba(255,255,255,.7)', looping: st.ab.active, title: `AB ${_fmt(st.ab.a)}–${_fmt(st.ab.b)}` });
  box.innerHTML = segs.map(s =>
    `<div class="uv-range${s.looping ? ' looping' : ''}" title="${s.title}" style="left:${(Math.max(0, s.a) / d * 100).toFixed(2)}%;width:${(Math.max(0.3, (Math.min(d, s.b) - Math.max(0, s.a)) / d * 100)).toFixed(2)}%;background:${s.color}"></div>`
  ).join('');
}
document.addEventListener('vc-ranges-changed', _renderRanges);

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
    ' ':          () => V.kind === 'video' && !vcIsInteractionLocked() && _togglePlay(),
    '\\':         () => {},                                   // 按住 \ = 看原圖（keydown 開、keyup 關，見下方）
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

/* 全螢幕時瀏覽器只渲染 fullscreenElement 子樹（top layer）；vc-panel／toast／
   裁切 overlay 原為 body 直屬兄弟節點，會被整個遮蔽而「打不開控制面板」。
   → fullscreenchange 時把這些 position:fixed overlay 暫時搬進 #uviewer，離開時搬回 body。 */
const _FS_OVERLAY_IDS = ['vc-panel', 'vc-toast', 'toast-root', 'vc-crop-overlay', 'vc-crop-toolbar'];
function _reparentOverlays() {
  const root = $('uviewer');
  const intoRoot = document.fullscreenElement === root;
  _FS_OVERLAY_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (intoRoot && el.parentElement !== root) root.appendChild(el);
    else if (!intoRoot && el.parentElement === root) document.body.appendChild(el);
  });
}
document.addEventListener('fullscreenchange', _reparentOverlays);
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
  // iOS Safari 不支援非 <video> 元素 requestFullscreen → 隱藏按鈕（viewer 本身已是滿版 overlay）
  if (!document.fullscreenEnabled) $('uv-fs').hidden = true;
  $('uv-orig').addEventListener('click', _toggleOriginal);
  $('uv-tags').addEventListener('click', _toggleTagsPop);
  $('uv-kbd-btn').addEventListener('click', () => { $('uv-kbd').hidden = !$('uv-kbd').hidden; });
  $('uv-kbd').addEventListener('click', () => { $('uv-kbd').hidden = true; });
  /* 單一入口：開啟至上次使用的 tab（drawer 內可切 資訊/播放/濾鏡/幾何）；再按 = 關閉 */
  $('uv-btn-ctrl').addEventListener('click', () => {
    if (isDrawerOpen()) { closeDrawer(); return; }
    let tab = null;
    try { tab = localStorage.getItem('ev-vc-last-tab'); } catch (_) {}
    if (tab === 'playback' && V.kind !== 'video') tab = 'image';
    if (tab === 'image' && V.kind === 'video') tab = 'playback';
    toggleDrawer(tab || (V.kind === 'video' ? 'playback' : 'image'));
  });
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
      V.kind === 'video' ? _vzWheel(e) : _izZoom(e.deltaY < 0 ? 0.15 : -0.15, undefined, e.clientX, e.clientY);
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
    const cur = V.items[V.idx];
    if (vcIsInteractionLocked()) return;                 // 取色筆／比對模式：點畫面不播放、不關閉
    if (V.kind === 'video' && e.target === V.media) {
      clearTimeout(V.dblTimer);
      V.dblTimer = setTimeout(() => _togglePlay(), 260);
    } else if (cur?.mediaType === 'bookmark' && cur.url && e.target === V.media) {
      // 書籤：點縮圖 = 開原始連結（與 grid 點擊行為一致；上下切換到書籤時亦可用）
      window.open(cur.url, '_blank', 'noopener');
    } else if (e.target === stage || e.target === $('uv-wrap') || e.target === $('uv-zoom')) {
      _requestClose();
    }
  });
  stage.addEventListener('dblclick', e => {
    if (vcIsInteractionLocked()) return;
    if (V.kind === 'video' && e.target === V.media) { clearTimeout(V.dblTimer); _toggleFs(); }
  });

  /* 行動輸入層（C33：縱滑/橫拖 seek/邊緣返回/捏合/清屏/雙擊播暫） */
  initViewerTouch(stage, {
    isOpen: () => V.open,
    kind: () => V.kind,
    nav: _nav,
    seekBy: _seekBy,
    seekInfo: () => (V.kind === 'video' && V.media?.duration) ? { t: V.media.currentTime, d: V.media.duration } : null,
    seekTo: sec => { const v = V.media; if (V.kind === 'video' && v?.duration) { v.currentTime = Math.max(0, Math.min(v.duration, sec)); _resetUITimer(); } },
    seekHint: text => {
      let el = $('uv-seek-hint');
      if (!el) { el = document.createElement('div'); el.id = 'uv-seek-hint'; el.className = 'uv-seek-hint'; $('uv-stage').appendChild(el); }
      el.textContent = text || ''; el.classList.toggle('show', !!text);
    },
    requestClose: _requestClose,
    togglePlay: () => { if (!vcIsInteractionLocked()) _togglePlay(); },
    toggleUi: () => { $('uviewer').classList.toggle('ui-hidden'); clearTimeout(V.uiTimer); },
    getZoom: () => (V.kind === 'video' ? V.vz.s : V.iz.s),
    zoomTo: (s, ax, ay) => { V.kind === 'video' ? _vzSet(s, ax, ay) : _izZoom(0, s, ax, ay); },
    panBy: (dx, dy) => { V.kind === 'video' ? _vzPanBy(dx, dy) : _izPanBy(dx, dy); },
  });

  document.addEventListener('mousemove', e => {
    if (V.open) { _izMove(e); _resetUITimer(); }
  });
  document.addEventListener('mouseup', _izUp);
  document.addEventListener('keydown', _onKey, true);
  // Lightroom 語彙：按住 \ 顯示原圖（before），放開還原；不在輸入框時才生效
  document.addEventListener('keydown', e => { if (e.key === '\\' && V.open && !e.repeat && !/^(input|textarea|select)$/i.test(e.target.tagName) && !e.target.isContentEditable) { e.preventDefault(); vcCompareHold(true); } }, true);
  document.addEventListener('keyup',   e => { if (e.key === '\\') vcCompareHold(false); }, true);
  window.addEventListener('blur', () => vcCompareHold(false));
  window.addEventListener('resize', () => {
    if (V.open && V.media) { vcSyncGlCanvas(V.media); if (V.kind === 'image') _izApply(); }
  });
}
