'use strict';
/* ── vc-compare.js  ▸  套用前／後比對（Before/After）＋ 互動鎖 ─────────────
   業界語彙：Lightroom「\」before/after + Y 分割；Lightroom Mobile／Snapseed「按住看原圖」；
   Resolve bypass／wipe。本模組提供兩種：
     • hold  ：按住「看原圖」鈕（或桌機 \ 鍵）→ 全畫面顯示原圖，放開即還原。
     • wipe  ：分割比對，左＝套用、右＝原圖，拖曳分割線（滑鼠／觸控，畫面任一處橫拖皆可）。
   「原圖」= 以同來源另建一個 <video>/<img> 疊在媒體上（無 CSS filter、不經 GL 選色），
   以 clip-path 只露出右側；影片 clone 與主影片 currentTime 同步（比對期間播放鎖定 → 只需 seek 同步）。
   互動鎖：比對或取色筆進行中 → vcIsInteractionLocked() = true，viewer 的單擊播放／雙擊全螢幕／空白鍵／
   手機雙擊播暫一律忽略，避免「點下去取色卻開始播放」。
══════════════════════════════════════════════════════════════════════ */
import { _VCS } from './vc-state.js';
import { _showToast, vcSyncPanel } from './vc-panel.js';

const _cmp = { wipe: false, hold: false, pos: 0.5, wrap: null, clone: null, drag: false, resumeAfter: false, holdEndAt: 0 };
let _eyedropperLockFn = () => false;          // 由 vc-filters 註冊（避免循環 import）
export function _registerEyedropperLock(fn) { _eyedropperLockFn = fn; }

export function vcIsInteractionLocked() { return _cmp.wipe || _cmp.hold || (Date.now() - _cmp.holdEndAt) < 450 || !!_eyedropperLockFn(); }   // 放開後寬限：吃掉同一下的 click/dblclick
export function vcCompareState() { return { wipe: _cmp.wipe, hold: _cmp.hold, pos: _cmp.pos }; }

/* ── 媒體框（與 vcSyncGlCanvas 同一套算法：letterbox 置中 + 複製 transform）── */
function _mediaBox(media) {
  const parent = media.parentElement; if (!parent) return null;
  const pw = parent.clientWidth, ph = parent.clientHeight; if (!pw || !ph) return null;
  let w, h;
  if (media.tagName === 'VIDEO' && media.videoWidth && media.videoHeight) {
    const scl = Math.min(pw / media.videoWidth, ph / media.videoHeight);
    w = Math.round(media.videoWidth * scl); h = Math.round(media.videoHeight * scl);
  } else { w = media.clientWidth || pw; h = media.clientHeight || ph; }
  return { w, h, left: Math.round((pw - w) / 2), top: Math.round((ph - h) / 2) };
}
function _syncBox() {
  const media = _VCS._vid, wrap = _cmp.wrap; if (!media || !wrap) return;
  const b = _mediaBox(media); if (!b) return;
  Object.assign(wrap.style, { width: b.w + 'px', height: b.h + 'px', left: b.left + 'px', top: b.top + 'px',
    transform: media.style.transform || '', transformOrigin: media.style.transformOrigin || 'center center' });
  _applyClip();
}
function _applyClip() {
  const wrap = _cmp.wrap; if (!wrap) return;
  const p = _cmp.hold ? 0 : _cmp.pos;                    // hold：整張原圖
  wrap.querySelector('.vc-cmp-clone').style.clipPath = `inset(0 0 0 ${(p * 100).toFixed(2)}%)`;
  const line = wrap.querySelector('.vc-cmp-line');
  line.style.left = (p * 100).toFixed(2) + '%';
  line.style.display = _cmp.wipe && !_cmp.hold ? '' : 'none';
  wrap.querySelector('.vc-cmp-lbl-a').style.display = _cmp.hold ? 'none' : '';
  wrap.querySelector('.vc-cmp-lbl-b').textContent = _cmp.hold ? '原圖' : '原圖 →';
}

/* ── 建立／移除疊層 ── */
function _ensureOverlay() {
  if (_cmp.wrap) return true;
  const media = _VCS._vid; if (!media || !media.parentElement) return false;
  const wrap = document.createElement('div');
  wrap.className = 'vc-cmp';
  wrap.innerHTML =
    `<span class="vc-cmp-lbl vc-cmp-lbl-a">← 套用</span><span class="vc-cmp-lbl vc-cmp-lbl-b">原圖 →</span>` +
    `<div class="vc-cmp-line"><div class="vc-cmp-handle">⇆</div></div>`;
  let clone;
  if (media.tagName === 'VIDEO') {
    clone = document.createElement('video');
    clone.muted = true; clone.playsInline = true; clone.preload = 'auto'; clone.disablePictureInPicture = true;
    clone.src = media.currentSrc || media.src;
    const seekTo = () => { if (Math.abs((clone.currentTime || 0) - media.currentTime) > 0.04) { try { clone.currentTime = media.currentTime; } catch {} } };
    clone.addEventListener('loadedmetadata', seekTo, { once: true });
    _cmp._sync = seekTo;
    media.addEventListener('seeked', seekTo); media.addEventListener('timeupdate', seekTo);
  } else {
    clone = document.createElement('img');
    clone.src = _VCS._imgOriginalSrc || media.src;
  }
  clone.className = 'vc-cmp-clone'; clone.draggable = false;
  wrap.prepend(clone);
  media.parentElement.appendChild(wrap);
  _cmp.wrap = wrap; _cmp.clone = clone;
  window.addEventListener('resize', _syncBox);
  _syncBox();
  return true;
}
function _removeOverlay() {
  const media = _VCS._vid;
  if (media && _cmp._sync) { media.removeEventListener('seeked', _cmp._sync); media.removeEventListener('timeupdate', _cmp._sync); }
  _cmp._sync = null;
  if (_cmp.clone && _cmp.clone.tagName === 'VIDEO') { try { _cmp.clone.pause(); _cmp.clone.removeAttribute('src'); _cmp.clone.load(); } catch {} }
  _cmp.wrap?.remove(); _cmp.wrap = null; _cmp.clone = null;
  window.removeEventListener('resize', _syncBox);
}
function _lockPlayback() {
  const v = _VCS._vid;
  if (v && v.tagName === 'VIDEO' && !v.paused) { _cmp.resumeAfter = true; v.pause(); }
}
function _maybeResume() {
  if (_cmp.wipe || _cmp.hold) return;
  const v = _VCS._vid;
  if (_cmp.resumeAfter && v && v.tagName === 'VIDEO') v.play?.().catch?.(() => {});
  _cmp.resumeAfter = false;
}

/* ── 分割比對（wipe）：拖曳分割線；畫面任一處橫拖亦可 ── */
function _posFromClient(x) {
  const r = _cmp.wrap.getBoundingClientRect();
  return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
}
const _onDown = e => {
  if (!_cmp.wipe || _cmp.hold) return;
  if (e.target?.closest?.('#vc-panel, .uv-nav, #uv-controls, .uv-topbar, #vc-toast')) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  _cmp.drag = true; _cmp.pos = _posFromClient(x); _applyClip();
  e.stopPropagation(); if (e.cancelable) e.preventDefault();
};
const _onMove = e => {
  if (!_cmp.drag) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  _cmp.pos = _posFromClient(x); _applyClip();
  e.stopPropagation(); if (e.cancelable) e.preventDefault();
};
const _onUp = e => { if (!_cmp.drag) return; _cmp.drag = false; e.stopPropagation(); };
const _onKill = e => {                                                                   // 擋掉媒體區 click/dblclick（捕獲階段），面板／控制列不擋
  if ((_cmp.wipe || _cmp.hold) && !e.target?.closest?.('#vc-panel, .uv-nav, #uv-controls, .uv-topbar, #vc-toast, #uv-kbd')) e.stopPropagation();
};
function _bindDrag(on) {
  const opts = { capture: true, passive: false };
  const m = on ? 'addEventListener' : 'removeEventListener';
  document[m]('pointerdown', _onDown, opts); document[m]('pointermove', _onMove, opts); document[m]('pointerup', _onUp, opts);
  document[m]('touchstart', _onDown, opts);  document[m]('touchmove', _onMove, opts);  document[m]('touchend', _onUp, opts);
  document[m]('click', _onKill, true);        document[m]('dblclick', _onKill, true);
}

export function vcCompareWipeToggle(force) {
  const next = force !== undefined ? !!force : !_cmp.wipe;
  if (next === _cmp.wipe) return;
  if (next) {
    if (!_ensureOverlay()) return;
    _lockPlayback(); _cmp.wipe = true; _bindDrag(true); _applyClip();
    _showToast('<span>分割比對：左＝套用、右＝原圖，左右拖曳分割線（比對中播放已鎖定）</span>', 3500);
  } else {
    _cmp.wipe = false; _bindDrag(false);
    if (!_cmp.hold) _removeOverlay();
    _maybeResume();
  }
  _syncBtn();
  vcSyncPanel();
}
/* 按住看原圖（hold）：pointerdown 開、pointerup/cancel 關；桌機「\」鍵同義 */
export function vcCompareHold(on) {
  on = !!on;
  if (on === _cmp.hold) return;
  if (on) { if (!_ensureOverlay()) return; _lockPlayback(); _cmp.hold = true; _applyClip(); }
  else    { _cmp.hold = false; _cmp.holdEndAt = Date.now(); if (!_cmp.wipe) _removeOverlay(); else _applyClip(); _maybeResume(); }
  _syncBtn();
}
export function vcCompareOff() {                 // 換媒體／重設時呼叫
  _cmp.hold = false; if (_cmp.wipe) { _cmp.wipe = false; _bindDrag(false); }
  _removeOverlay(); _cmp.resumeAfter = false; _cmp.drag = false; _syncBtn();
}
function _syncBtn() {
  document.getElementById('vc-cmp-wipe-btn')?.classList.toggle('vc-on', _cmp.wipe);
  document.getElementById('vc-cmp-hold-btn')?.classList.toggle('vc-on', _cmp.hold);
}
/* 鈕的按住手勢綁定（由 vc-panel init 呼叫一次；pointer + touch 雙保險） */
export function vcInitCompareButtons() {
  const b = document.getElementById('vc-cmp-hold-btn'); if (!b || b._cmpBound) return; b._cmpBound = true;
  const down = e => { e.preventDefault(); vcCompareHold(true); };
  const up   = () => vcCompareHold(false);
  b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
  b.addEventListener('touchstart', down, { passive: false }); b.addEventListener('touchend', up); b.addEventListener('touchcancel', up);
  b.addEventListener('contextmenu', e => e.preventDefault());
}

/* ── 長按畫面看原圖（Lightroom Mobile／Snapseed／VSCO 慣例）：在媒體元素上按住 ≥ 420ms → 原圖，放開還原。
   取色筆進行中／分割比對中／多指（捏合）／移動超過 10px 皆取消；長按期間抑制 contextmenu 與後續 click。 */
let _lp = null;
function _lpCancel() { if (_lp?.timer) clearTimeout(_lp.timer); _lp = null; }
document.addEventListener('pointerdown', e => {
  const media = _VCS._vid;
  if (!media || e.target !== media || _cmp.wipe || _eyedropperLockFn()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  _lpCancel();
  _lp = { x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => { if (_lp) { _lp.fired = true; vcCompareHold(true); } }, 420) };
}, true);
document.addEventListener('pointermove', e => {
  if (!_lp || _lp.fired) return;
  if (Math.hypot(e.clientX - _lp.x, e.clientY - _lp.y) > 10) _lpCancel();
}, true);
const _lpEnd = () => { if (_lp?.fired) { vcCompareHold(false); setTimeout(_lpCancel, 350); } else _lpCancel(); };
document.addEventListener('pointerup', _lpEnd, true);
document.addEventListener('pointercancel', _lpEnd, true);
document.addEventListener('touchstart', e => { if (e.touches.length > 1) _lpCancel(); }, { capture: true, passive: true });
document.addEventListener('contextmenu', e => { if (_lp?.fired || _cmp.hold) e.preventDefault(); }, true);
