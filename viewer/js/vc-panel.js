'use strict';
/* ── vc-panel.js  ▸  控制面板 UI ─────────────────────────────────────
   圖片控制注入／Toast／Tab 切換／面板開合＋拖曳／Panel Sync／ResetAll
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { fmtTime, fmtTimeF } from './utils.js';
import { _VCS, _getActive, _loadFilterPresets, vcBackupNow, vcListBackups, vcRestoreBackup } from './vc-state.js';
import { _restoreOriginalSrc } from './vc-canvas.js';
import { vcRenderSelectiveChips, vcStopEyedropper, vcApplyFilter, vcIsSelectiveLooping, vcSyncColorPopover } from './vc-filters.js';
import { vcRenderFilterPresets, vcRenderAbPresets } from './vc-presets.js';
import { vcCompareOff, vcInitCompareButtons } from './vc-compare.js';
import { vcApplyTransform, vcRenderTransformActions } from './vc-transform.js';
import { vcSyncPlayback } from './vc-playback.js';
import { E2_FILTER_DEFAULT, ensureE2 } from './vc-engine2.js';

/* ══════════════════════════════════════════════════════════════════
   圖片專有控制（Image Tab：Zoom / Fit / BgColor / Navigation）
   ─ 透過 _imageZoomCallbacks 由 modal.js 注入 izZoom / izFit
══════════════════════════════════════════════════════════════════ */
const _imageZoomCB = { zoom: null, fit: null, getScale: null, actualSize: null };

export function vcRegisterImageZoom(zoomFn, fitFn, getScaleFn, actualSizeFn) {
  _imageZoomCB.zoom       = zoomFn;
  _imageZoomCB.fit        = fitFn;
  _imageZoomCB.getScale   = getScaleFn   || null;
  _imageZoomCB.actualSize = actualSizeFn || null;
}

export function vcImageZoom(delta) {
  if (_imageZoomCB.zoom) _imageZoomCB.zoom(delta);
}
export function vcImageZoomSet(val) {
  if (_imageZoomCB.zoom) _imageZoomCB.zoom(0, val);   // delta=0, absolute=val
}
export function vcImageFit() {
  if (_imageZoomCB.fit) _imageZoomCB.fit();
}
export function vcImageActualSize() {
  if (_imageZoomCB.actualSize) _imageZoomCB.actualSize();
}

let _imageNavFn = null;
export function vcRegisterImageNav(fn) { _imageNavFn = fn; }
export function vcImageNav(dir) {
  if (_imageNavFn) _imageNavFn(dir);
}

export function vcSetModalBg(color) {
  const mbox = document.getElementById('mbox');
  if (mbox) mbox.style.background = color || '';
}

/* ── Reset（全部重置）─────────────────────────────────────────── */
export function vcResetAll() {
  vcCompareOff();
  _VCS.filter      = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS.filter2      = { ...E2_FILTER_DEFAULT };
  _VCS.selectiveList = []; _VCS._activeSelectiveId = null;
  _VCS.tx          = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                        rotate: 0, flipH: false, flipV: false };
  _VCS.ab          = { a: null, b: null, active: false };
  _VCS._autoRotate = 0;
  _VCS._activeFilterPresetId = null;
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  vcStopEyedropper();
  _restoreOriginalSrc();
  _VCS._imgOriginalSrc = null;
  const vid = _VCS._vid;
  if (vid) { vcApplyFilter(vid); vcApplyTransform(vid); }
  vcSyncPanel();
  vcRenderFilterPresets();
  vcRenderTransformActions();
}

/* ── 備份與還原 UI ────────────────────────────────────────────── */
export async function vcBackupNowUI() {
  try { await vcBackupNow(); _showToast('<span>已建立備份</span>'); vcRenderBackupList(); }
  catch { _showToast('<span>備份失敗</span>'); }
}

export async function vcRenderBackupList() {
  const el = document.getElementById('vc-backup-list');
  if (!el) return;
  el.textContent = '載入中…';
  try {
    const list = await vcListBackups();
    if (!Array.isArray(list) || !list.length) { el.textContent = '尚無備份'; return; }
    el.innerHTML = '';
    list.forEach(b => {
      const row = document.createElement('div');
      row.className = 'vc-backup-item';
      const ts = b.ts ? new Date(b.ts * 1000).toLocaleString() : '';
      const nameEl = document.createElement('span');
      nameEl.textContent = b.name;
      const tsEl = document.createElement('span');
      tsEl.textContent = ts;
      const btn = document.createElement('button');
      btn.className = 'vc-text-btn';
      btn.textContent = '還原';
      btn.onclick = async () => {
        if (!confirm(`確定要還原「${b.name}」嗎？目前資料將先自動備份。`)) return;
        try {
          await vcRestoreBackup(b.name);
          _showToast('<span>已還原備份</span>');
          vcRenderFilterPresets();
          vcRenderBackupList();
        } catch { _showToast('<span>還原失敗</span>'); }
      };
      row.append(nameEl, tsEl, btn);
      el.appendChild(row);
    });
  } catch { el.textContent = '載入失敗'; }
}

/* ══════════════════════════════════════════════════════════════════
   Toast
══════════════════════════════════════════════════════════════════ */
let _toastTimer   = null;
let _toastSwipeX  = null;

function _attachToastSwipe(el) {
  el.ontouchstart = e => {
    if (e.target.closest('button')) return;
    _toastSwipeX = e.touches[0].clientX;
    el.style.transition = 'opacity .08s';
  };
  el.ontouchmove = e => {
    if (_toastSwipeX === null) return;
    const dx = e.touches[0].clientX - _toastSwipeX;
    el.style.transform = `translateX(calc(-50% + ${dx}px)) translateY(0)`;
    el.style.opacity   = String(Math.max(0, 1 - Math.abs(dx) / 180));
  };
  el.ontouchend = e => {
    if (_toastSwipeX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? _toastSwipeX) - _toastSwipeX;
    _toastSwipeX = null;
    el.style.transition = 'opacity .22s, transform .22s';
    if (Math.abs(dx) > 72) {
      el.style.transform = `translateX(calc(-50% + ${dx > 0 ? 300 : -300}px)) translateY(0)`;
      el.style.opacity   = '0';
      setTimeout(() => vcDismissToast(), 230);
    } else {
      el.style.transform = '';
      el.style.opacity   = '';
    }
  };
}

export function _showToast(html, duration = 5000) {
  const el = document.getElementById('vc-toast');
  if (!el) return;
  el.innerHTML = html + '<button class="vc-toast-close" onclick="vcDismissToast()" aria-label="關閉">✕</button>';
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => vcDismissToast(), duration);
  _attachToastSwipe(el);
}

export function vcDismissToast() {
  const el = document.getElementById('vc-toast');
  if (el) {
    el.classList.remove('show');
    el.style.transform  = '';
    el.style.opacity    = '';
    el.style.transition = '';
  }
  clearTimeout(_toastTimer);
  _toastSwipeX = null;
}

/* ══════════════════════════════════════════════════════════════════
   Tab 切換
══════════════════════════════════════════════════════════════════ */
let _currentTab = 'playback';

export function vcSwitchTab(tab) {
  try { localStorage.setItem('ev-vc-last-tab', tab); } catch (_) {}   // 控制中心單一入口：記住上次 tab
  _currentTab = tab;
  document.querySelectorAll('.vc-tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.vc-tab-pane').forEach(pane =>
    pane.classList.toggle('active', pane.id === `vc-pane-${tab}`));
  if (tab === 'filters')   vcRenderFilterPresets();
  if (tab === 'transform') vcRenderTransformActions();
}

/* ══════════════════════════════════════════════════════════════════
   Panel Toggle + Drag（手機版）
══════════════════════════════════════════════════════════════════ */
const _VC_DEFAULT_H = 0.55;

function _syncVcBtn(isOpen) {
  document.getElementById('m-vc-btn')?.classList.toggle('active', isOpen);
}

export function toggleVcPanel() {
  const panel = document.getElementById('vc-panel');
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  if (opening && window.innerWidth <= 768) {
    panel.style.maxHeight = Math.round(window.innerHeight * _VC_DEFAULT_H) + 'px';
  }
  panel.classList.toggle('open');
  _syncVcBtn(opening);
  if (opening) {
    vcSyncPanel();
    vcRenderFilterPresets();
    vcRenderTransformActions();
  }
}

export function closeVcPanel() {
  document.getElementById('vc-panel')?.classList.remove('open');
  _syncVcBtn(false);
}

let _vcDragInited = false;

function _sliderValueAt(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const min  = +(slider.min  || 0);
  const max  = +(slider.max  || 100);
  const step = +(slider.step || 1);
  const raw  = min + pct * (max - min);
  return parseFloat((Math.round(raw / step) * step).toFixed(10));
}

function _initSliderScrollFix(content) {
  content.querySelectorAll('input[type="range"]').forEach(slider => {
    let startX, startY, scrollStartTop, mode;
    slider.addEventListener('touchstart', e => {
      if (window.innerWidth > 768) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      scrollStartTop = content.scrollTop; mode = null;
      e.preventDefault();
    }, { passive: false });
    slider.addEventListener('touchmove', e => {
      if (window.innerWidth > 768) return;
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      if (mode === null) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) { e.preventDefault(); return; }
        mode = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
      }
      e.preventDefault();
      if (mode === 'v') content.scrollTop = scrollStartTop - dy;
      else {
        const val = _sliderValueAt(slider, e.touches[0].clientX);
        if (+slider.value !== val) { slider.value = val; slider.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }, { passive: false });
    slider.addEventListener('touchend', e => {
      if (window.innerWidth > 768) return;
      if (mode === null || mode === 'h') {
        const val = _sliderValueAt(slider, e.changedTouches[0].clientX);
        slider.value = val; slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      mode = null;
    }, { passive: true });
  });
}

/* ── 數值點擊直接輸入（.vc-val → inline number input → 寫回 range 並觸發 input）──
   特例：vc-speed 為對數刻度（顯示 x× ↔ range=(log10 x+1)*100）、vc-img-zoom 顯示 %。 */
let _valEditInited = false;
export function vcInitValueEdit() {
  if (_valEditInited) return;
  const panel = document.getElementById('vc-panel');
  if (!panel) return;
  _valEditInited = true;
  panel.addEventListener('click', e => {
    const val = e.target.closest('.vc-val');
    if (!val || val.querySelector('input')) return;
    const row = val.closest('.vc-slider-row');
    const range = row?.querySelector('input[type="range"]');
    if (!range) return;
    const id = range.id;
    const shown = parseFloat(val.textContent.replace(/[^\d.\-+]/g, ''));
    // 顯示值 → range 值
    const toRange = x => id === 'vc-speed' ? (Math.log10(x) + 1) * 100
                      : id === 'vc-img-zoom' ? x / 100 : x;
    const fromRange = v => id === 'vc-speed' ? Math.pow(10, v / 100 - 1)
                        : id === 'vc-img-zoom' ? v * 100 : v;
    const cur = isFinite(shown) ? shown : fromRange(+range.value);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.inputMode = 'decimal'; inp.className = 'vc-val-input';
    inp.value = String(+cur.toFixed(2));
    const prev = val.textContent;
    val.textContent = ''; val.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = ok => {
      if (done) return; done = true;
      const x = parseFloat(inp.value);
      if (ok && isFinite(x)) {
        const min = +range.min, max = +range.max;
        const v = Math.min(max, Math.max(min, toRange(x)));
        range.value = String(v);
        range.dispatchEvent(new Event('input', { bubbles: true }));   // 走原 oninput（即時套用＋數值重繪）
      } else val.textContent = prev;
      if (val.contains(inp)) inp.remove();
    };
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      ev.stopPropagation();
    });
    inp.addEventListener('blur', () => commit(true));
    inp.addEventListener('click', ev => ev.stopPropagation());
  });
}

/* ── 全面板通用滑桿細調：Shift 拖曳/方向鍵 = ×0.1 step；雙擊 = 還原預設 ── */
let _sliderFineInited = false;
export function vcInitSliderFine() {
  if (_sliderFineInited) return;
  const panel = document.getElementById('vc-panel');
  if (!panel) return;
  _sliderFineInited = true;
  const isRange = el => el && el.tagName === 'INPUT' && el.type === 'range';
  const fineOn = el => {
    if (el.dataset.origStep != null) return;
    el.dataset.origStep = el.step || '1';
    const fine = parseFloat(el.dataset.origStep) * 0.1;
    el.step = fine > 0 ? String(fine) : el.step;
  };
  const fineOff = el => {
    if (el.dataset.origStep == null) return;
    el.step = el.dataset.origStep;
    delete el.dataset.origStep;
  };
  panel.addEventListener('pointerdown', e => {
    const el = e.target;
    if (isRange(el) && e.shiftKey) fineOn(el);
  }, true);
  panel.addEventListener('pointerup', e => { if (isRange(e.target)) fineOff(e.target); }, true);
  panel.addEventListener('keydown', e => {
    const el = e.target;
    if (!isRange(el)) return;
    if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) fineOn(el);
  });
  panel.addEventListener('keyup', e => { if (isRange(e.target)) fineOff(e.target); });
  panel.addEventListener('dblclick', e => {
    const el = e.target;
    if (!isRange(el)) return;
    const def = el.dataset.default != null ? el.dataset.default : el.defaultValue;
    if (def == null) return;
    el.value = def;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function vcInitDragHandle() {
  vcInitValueEdit();
  vcInitSliderFine();
  vcInitCompareButtons();
  if (_vcDragInited) return;
  _vcDragInited = true;
  const panel   = document.getElementById('vc-panel');
  const header  = panel?.querySelector('.vc-header');
  const content = panel?.querySelector('.vc-content');
  if (!panel || !header || !content) return;
  _initSliderScrollFix(content);
  let dragging = false, startY = 0, startH = 0;
  const MIN_H = 140;
  header.addEventListener('touchstart', e => {
    if (window.innerWidth > 768) return;
    dragging = true; startY = e.touches[0].clientY;
    startH = panel.getBoundingClientRect().height;
    panel.classList.add('dragging'); e.stopPropagation();
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy   = startY - e.touches[0].clientY;
    const newH = Math.max(MIN_H, Math.min(startH + dy, window.innerHeight * 0.92));
    panel.style.maxHeight = newH + 'px';
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false; panel.classList.remove('dragging');
    const h = panel.getBoundingClientRect().height, vh = window.innerHeight;
    if (h < 100) { closeVcPanel(); return; }
    const anchors = [0.40, 0.55, 0.80].map(r => r * vh);
    const snap    = anchors.reduce((best, a) =>
      Math.abs(a - h) < Math.abs(best - h) ? a : best, anchors[0]);
    panel.style.maxHeight = Math.round(snap) + 'px';
  }, { passive: true });
}

/* ══════════════════════════════════════════════════════════════════
   Panel Sync
══════════════════════════════════════════════════════════════════ */
function _setSlider(id, val, txt) {
  const sl = document.getElementById(id);        if (sl)  sl.value       = val;
  const tv = document.getElementById(id + '-v'); if (tv)  tv.textContent = txt;
}

export function vcSyncPanel() {
  const f = _VCS.filter, t = _VCS.tx, ab = _VCS.ab;
  const isImage = _VCS._mediaType === 'image';

  _setSlider('vc-brightness', f.brightness,        f.brightness.toFixed(2));
  _setSlider('vc-contrast',   f.contrast,          f.contrast.toFixed(2));
  _setSlider('vc-saturate',   f.saturate,          f.saturate.toFixed(2));
  _setSlider('vc-hue',        f.hueRotate,         f.hueRotate + '°');
  _setSlider('vc-sepia',     f.sepia     ?? 0, (f.sepia ?? 0) + '%');
  _setSlider('vc-sharpness', f.sharpness ?? 0, (f.sharpness > 0 ? '+' : '') + (f.sharpness ?? 0));

  /* ── Engine 切換 + v1/v2 區塊顯示 ─────────────────────────────── */
  const engine = _VCS.engine === 2 ? 2 : 1;
  document.querySelectorAll('#vc-engine-seg [data-engine]').forEach(btn =>
    btn.classList.toggle('active', +btn.dataset.engine === engine));
  const v1El = document.getElementById('vc-filters-v1');
  const v2El = document.getElementById('vc-filters-v2');
  if (v1El) v1El.style.display = engine === 1 ? '' : 'none';
  if (v2El) v2El.style.display = engine === 2 ? '' : 'none';

  if (engine === 2) {
    const f2 = { ...E2_FILTER_DEFAULT, ..._VCS.filter2 };
    _setSlider('vc-f2-exposure',   f2.exposure,   (f2.exposure / 50 >= 0 ? '+' : '') + (f2.exposure / 50).toFixed(2));
    _setSlider('vc-f2-contrast',   f2.contrast,   (f2.contrast > 0 ? '+' : '') + Math.round(f2.contrast));
    _setSlider('vc-f2-saturation', f2.saturation, (f2.saturation > 0 ? '+' : '') + Math.round(f2.saturation));
    _setSlider('vc-f2-vibrance',   f2.vibrance,   Math.round(f2.vibrance));
    _setSlider('vc-f2-hueRotate',  f2.hueRotate,  Math.round(f2.hueRotate) + '°');
    _setSlider('vc-f2-sepia',      f2.sepia,      Math.round(f2.sepia) + '%');
    _setSlider('vc-f2-sharpness',  f2.sharpness,  (f2.sharpness > 0 ? '+' : '') + Math.round(f2.sharpness));
  }

  // 多色塊 UI 同步
  vcRenderSelectiveChips();
  const sel      = _getActive();
  const eyedropRow = document.getElementById('vc-sel-eyedropper-row');
  const swatchEl   = document.getElementById('vc-sel-swatch');
  const deltasEl   = document.getElementById('vc-sel-deltas');
  const hasActive  = sel !== null;
  const hasPick    = sel !== null && sel.targetHue !== null;
  if (eyedropRow) eyedropRow.style.display = hasActive ? '' : 'none';
  if (swatchEl) {
    swatchEl.style.background = hasPick
      ? (sel.pickedRgb ? `rgb(${sel.pickedRgb[0]},${sel.pickedRgb[1]},${sel.pickedRgb[2]})` : `hsl(${sel.targetHue},70%,50%)`)
      : 'transparent';
    swatchEl.title = (hasPick ? (sel.mode === 'lum' ? `中性色（明度 ${Math.round((sel.targetLum ?? 0) * 100)}%）` : `色相 ${sel.targetHue}°`) : '未取色') + '——點開顏色圓盤';
    swatchEl.classList.toggle('vc-sel-swatch-empty', !hasPick);
  }
  if (deltasEl) deltasEl.style.display = (hasPick && engine === 1) ? '' : 'none';
  const isLum = hasPick && sel.mode === 'lum';
  const hl = document.getElementById('vc-sel-hueshift-l'), rl = document.getElementById('vc-sel-range-l');
  if (hl) hl.textContent = isLum ? '上色色調' : '色調';
  if (rl) rl.textContent = isLum ? '明度寬度' : '選色寬度';
  vcSyncColorPopover();
  const bindAbBtn = document.getElementById('vc-sel-bind-ab-btn');
  if (bindAbBtn) {
    const canBind = _VCS._activeSelectiveId !== null &&
                    _VCS.ab.a !== null && _VCS.ab.b !== null;
    bindAbBtn.style.display = canBind ? '' : 'none';
  }
  const unbindAbBtn = document.getElementById('vc-sel-unbind-ab-btn');
  if (unbindAbBtn) {
    unbindAbBtn.style.display = (sel !== null && sel.abStart !== null) ? '' : 'none';
  }
  const playRangeBtn = document.getElementById('vc-sel-play-range-btn');
  if (playRangeBtn) {
    const has = sel !== null && sel.abStart !== null;
    playRangeBtn.style.display = has ? '' : 'none';
    if (has) {
      const looping = vcIsSelectiveLooping(sel);
      playRangeBtn.textContent = looping ? '⏹ 停止循環' : '▶ 只播此時段';
      playRangeBtn.classList.toggle('active', looping);
    }
  }
  document.dispatchEvent(new CustomEvent('vc-ranges-changed'));
  // 選色時段列（併入濾鏡 tab 後可直接輸入；取色後即顯示）
  const abRow = document.getElementById('vc-sel-ab-row');
  if (abRow) {
    abRow.style.display = hasPick ? '' : 'none';
    const sEl = document.getElementById('vc-sel-ab-start'), eEl = document.getElementById('vc-sel-ab-end');
    // A／B 鈕提示：對照播放頁籤 A/B 或目前位置（vcSelAbNow 同一規則）
    abRow.querySelectorAll('.vc-sel-ab-now').forEach((btn, i) => {
      const v = i === 0 ? _VCS.ab.a : _VCS.ab.b, lbl = i === 0 ? '起點' : '終點';
      btn.title = v !== null ? `套用播放頁籤 ${i === 0 ? 'A' : 'B'}（${fmtTimeF(v)}）為${lbl}` : `以目前播放位置設為${lbl}（播放頁籤未設 ${i === 0 ? 'A' : 'B'}）`;
      btn.classList.toggle('vc-sel-ab-linked', v !== null);
    });
    if (sEl && document.activeElement !== sEl) sEl.value = sel && sel.abStart !== null ? fmtTimeF(sel.abStart) : '';
    if (eEl && document.activeElement !== eEl) eEl.value = sel && sel.abEnd   !== null ? fmtTimeF(sel.abEnd)   : '';
  }
  const _fmtDelta = v => (v > 0 ? '+' : '') + v.toFixed(2);
  const _s = sel ?? { hueShift: 0, range: 30, brightness: 0, contrast: 0, saturate: 0, sepia: 0 };
  _setSlider('vc-sel-hueshift',   _s.hueShift,   (_s.hueShift > 0 ? '+' : '') + _s.hueShift + '°');
  _setSlider('vc-sel-range',      _s.range,      '±' + _s.range + '°');
  _setSlider('vc-sel-brightness', _s.brightness, _fmtDelta(_s.brightness));
  _setSlider('vc-sel-contrast',   _s.contrast,   _fmtDelta(_s.contrast));
  _setSlider('vc-sel-saturate',   _s.saturate,   _fmtDelta(_s.saturate));
  _setSlider('vc-sel-sepia',      _s.sepia,      _s.sepia.toFixed(2));

  /* ── v2 選色（e2）UI 同步 ─────────────────────────────────────── */
  const deltasV2El = document.getElementById('vc-sel-deltas-v2');
  if (deltasV2El) deltasV2El.style.display = (hasPick && engine === 2) ? '' : 'none';
  if (hasPick && engine === 2) {
    ensureE2(sel);
    const e2 = sel.e2;
    document.querySelectorAll('#vc-sel2-mode-seg [data-mode]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === e2.mode));
    const tgtRow = document.getElementById('vc-sel2-target-row');
    const offRow = document.getElementById('vc-sel2-offset-row');
    if (tgtRow) tgtRow.style.display = e2.mode === 'set' ? '' : 'none';
    if (offRow) offRow.style.display = e2.mode === 'offset' ? '' : 'none';
    const tgtSwatch = document.getElementById('vc-sel2-tgt-swatch');
    if (tgtSwatch) tgtSwatch.style.background = e2.target?.hex || '#000';
    const tgtHex = document.getElementById('vc-sel2-tgt-hex');
    if (tgtHex && document.activeElement !== tgtHex) tgtHex.value = (e2.target?.hex || '').toUpperCase();
    _setSlider('vc-sel2-strength', e2.target?.strength ?? 100, Math.round(e2.target?.strength ?? 100));
    _setSlider('vc-sel2-keepl',    e2.target?.keepL    ?? 100, Math.round(e2.target?.keepL    ?? 100));
    _setSlider('vc-sel2-dh', e2.dH, (e2.dH > 0 ? '+' : '') + Math.round(e2.dH) + '°');
    _setSlider('vc-sel2-dc', e2.dC, (e2.dC > 0 ? '+' : '') + Math.round(e2.dC));
    _setSlider('vc-sel2-dl', e2.dL, (e2.dL > 0 ? '+' : '') + Math.round(e2.dL));
    _setSlider('vc-sel2-contrast', e2.contrast, (e2.contrast > 0 ? '+' : '') + Math.round(e2.contrast));
    _setSlider('vc-sel2-vibrance', e2.vibrance, Math.round(e2.vibrance));
    _setSlider('vc-sel2-sepia',    e2.sepia,    Math.round(e2.sepia));
    _setSlider('vc-sel2-hw', e2.qual.hW, '±' + Math.round(e2.qual.hW) + '°');
    _setSlider('vc-sel2-hsoft', e2.qual.hSoft, Math.round(e2.qual.hSoft) + '°');
    _setSlider('vc-sel2-sc',    e2.qual.sC,    Math.round(e2.qual.sC));
    _setSlider('vc-sel2-sw',    e2.qual.sW,    Math.round(e2.qual.sW));
    _setSlider('vc-sel2-ssoft', e2.qual.sSoft, Math.round(e2.qual.sSoft));
    _setSlider('vc-sel2-lc',    e2.qual.lC,    Math.round(e2.qual.lC));
    _setSlider('vc-sel2-lw',    e2.qual.lW,    Math.round(e2.qual.lW));
    _setSlider('vc-sel2-lsoft', e2.qual.lSoft, Math.round(e2.qual.lSoft));
  }

  _setSlider('vc-scalex', t.scaleX,     t.scaleX.toFixed(2) + '×');
  _setSlider('vc-scaley', t.scaleY,     t.scaleY.toFixed(2) + '×');
  _setSlider('vc-tx',     t.translateX, t.translateX + 'px');
  _setSlider('vc-ty',     t.translateY, t.translateY + 'px');

  const rv = document.getElementById('vc-rotate-v');
  if (rv) rv.textContent = t.rotate + '°';

  document.getElementById('vc-flip-h')?.classList.toggle('vc-on', t.flipH);
  document.getElementById('vc-flip-v')?.classList.toggle('vc-on', t.flipV);

  const aEl  = document.getElementById('vc-a-time');
  const bEl  = document.getElementById('vc-b-time');
  const tog  = document.getElementById('vc-ab-toggle');
  const btnA = document.getElementById('vc-btn-a');
  const btnB = document.getElementById('vc-btn-b');
  if (aEl && document.activeElement !== aEl) aEl.value = ab.a !== null ? fmtTimeF(ab.a) : '';
  if (bEl && document.activeElement !== bEl) bEl.value = ab.b !== null ? fmtTimeF(ab.b) : '';
  if (tog)  { tog.textContent = ab.active ? 'AB 開啟' : 'AB 關閉'; tog.classList.toggle('vc-on', ab.active); }
  vcRenderAbPresets();   // 設定庫列的 🔁 高亮跟隨 AB 狀態（手動關閉/清除時同步）
  if (btnA) btnA.classList.toggle('vc-on', ab.a !== null);
  if (btnB) btnB.classList.toggle('vc-on', ab.b !== null);

  // 標題動態更新
  const titleEl = document.getElementById('vc-title');
  if (titleEl) titleEl.textContent = isImage ? '圖片控制' : '影片控制';

  // 圖片縮放滑桿同步
  if (isImage && _imageZoomCB.getScale) {
    const s = _imageZoomCB.getScale();
    _setSlider('vc-img-zoom', s, Math.round(s * 100) + '%');
  }

  // 播放 tab：圖片時隱藏
  const playbackBtn  = document.querySelector('.vc-tab-btn[data-tab="playback"]');
  const playbackPane = document.getElementById('vc-pane-playback');
  if (playbackBtn)  playbackBtn.style.display  = isImage ? 'none' : '';
  if (playbackPane) playbackPane.style.display = isImage ? 'none' : '';

  // 圖片 tab：僅圖片時顯示
  const imageTabBtn  = document.querySelector('.vc-tab-btn[data-tab="image"]');
  const imageTabPane = document.getElementById('vc-pane-image');
  if (imageTabBtn)  imageTabBtn.style.display  = isImage ? '' : 'none';
  if (imageTabPane) imageTabPane.style.display = isImage ? '' : 'none';

  // 自動切換 tab（圖片模式不得停在 playback；影片模式不得停在 image）
  if (isImage  && _currentTab === 'playback') vcSwitchTab('image');
  if (!isImage && _currentTab === 'image')    vcSwitchTab('playback');

  vcSyncPlayback();
  vcRenderTransformActions();
}
