'use strict';
/* ── vc-filters.js  ▸  CSS 濾鏡 + 選擇性色彩 + Eyedropper ────────────
   臨時濾鏡狀態機／取色器／選色 setter／chips／vcApplyFilter
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { fmtTime, fmtTimeF } from './utils.js';
import { _registerEyedropperLock } from './vc-compare.js';
import { _VCS, _getActive, _newSelItem,
         _loadFilterPresets, _loadVideoFilterData, _saveVideoFilterData,
         vcSetEngineState }
  from './vc-state.js';
import { _glShowCanvas, _stopVideoRafLoop,
         _glResetTexSrc, _glClearTexture } from './vc-webgl.js';
import { _rgbToHsl, _scheduleCanvasUpdate,
         _restoreOriginalSrc, _needsCanvas } from './vc-canvas.js';
import { vcRenderFilterPresets, vcRenderAbPresets } from './vc-presets.js';
import { _showToast, vcDismissToast, vcSyncPanel } from './vc-panel.js';
import { E2_FILTER_DEFAULT, ensureE2, e2CssFilter, rgbToHex } from './vc-engine2.js';

/* ── 臨時濾鏡狀態機 ───────────────────────────────────────────── */
/* 使用者互動產生新臨時濾鏡狀態：記錄來源並重置「沿用不再問」旗標 */
function _markTempFilterDirty() {
  _VCS._tempOriginItemId = _VCS._itemId;
  _VCS._tempDismissed    = false;
}

/** 沿用臨時濾鏡到後續影片且不再詢問 */
export function vcKeepTempFilter() {
  _VCS._tempDismissed = true;
  vcDismissToast();
}

/** 將漫遊中的已儲存 preset 連結到當前影片（寫入 presetIds + lastUsed，不另存新 preset） */
export function vcLinkPresetToVideo(presetId) {
  const preset = _loadFilterPresets().find(p => p.id === presetId && !p.deleted);
  if (!preset || !_VCS._itemId) { vcDismissToast(); return; }
  const vfl = _loadVideoFilterData(_VCS._itemId);
  if (!vfl.presetIds) vfl.presetIds = [];
  if (!vfl.presetIds.includes(presetId)) vfl.presetIds.push(presetId);
  vfl.lastUsed = presetId;
  _saveVideoFilterData(_VCS._itemId, vfl);
  _VCS._activeFilterPresetId = presetId;
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  vcRenderFilterPresets();
  vcDismissToast();
  _showToast(`<span>已將「${preset.name}」連結到這部影片。</span>`);
}

/** 丟棄臨時濾鏡：還原中性值、隱藏並清 GL overlay */
export function vcDiscardTempFilter() {
  _VCS.filter = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS.selectiveList = []; _VCS._activeSelectiveId = null;
  _VCS._activeFilterPresetId = null;
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  _stopVideoRafLoop();
  _glShowCanvas(false);
  _glResetTexSrc();
  _glClearTexture();
  // 還原 src 僅適用圖片（canvas objectURL 替換過）；影片重設 src 會整部重載跳回 0 秒
  if (_VCS._mediaType !== 'video') {
    _restoreOriginalSrc();
    _VCS._imgOriginalSrc = null;
  }
  vcApplyFilter(_VCS._vid);
  vcSyncPanel();
  vcRenderFilterPresets();
  vcDismissToast();
}

/* ── Eyedropper ───────────────────────────────────────────────── */
let _eyedropperActive = false;
let _eyedropperEndAt = 0;
// 取色中 → viewer 互動鎖；取色完成後再寬限 600ms（vid click 先於 stage click 觸發，否則同一下點擊會被當成播放）
_registerEyedropperLock(() => _eyedropperActive || (Date.now() - _eyedropperEndAt) < 600);
let _eyedropperHandler = null;

export function vcStartEyedropper(kind = 'pick') {
  const vid = _VCS._vid;
  if (!vid) return;
  if (_VCS._mediaType === 'video' && !vid.paused) vid.pause();
  _eyedropperActive = true;
  document.getElementById('vc-eyedropper-btn')?.classList.add('vc-on');
  const hint = document.getElementById('vc-sel-pick-hint');
  const swatch = document.getElementById('vc-sel-swatch');
  if (hint)   { hint.style.display = ''; hint.textContent = kind === 'target' ? '👆 點擊畫面選目標色' : '👆 點圖取色中…'; }
  if (swatch) swatch.style.display = 'none';
  vid.style.cursor = 'crosshair';

  // viewport 座標 → 媒體原始像素座標
  // 正確處理所有 CSS transform（flip/rotate/scale/translate）+ letterbox 補正
  const _pickAt = (clientX, clientY) => {
    const rect = vid.getBoundingClientRect();

    // 元素版面尺寸（pre-CSS-transform，offsetWidth/Height 不受 transform 影響）
    const elemW = vid.offsetWidth;
    const elemH = vid.offsetHeight;

    // 讀取 transform 狀態（與 vcApplyTransform 使用相同來源）
    const { rotate: txRot = 0, flipH = false, flipV = false,
            scaleX: baseScaleX = 1, scaleY: baseScaleY = 1,
            translateX = 0, translateY = 0 } = _VCS.tx || {};
    const totalRot = (((txRot + (_VCS._autoRotate || 0)) % 360) + 360) % 360;

    // 90°/270° 旋轉的額外 fit 縮放（與 vcApplyTransform 完全一致）
    let fitFactor = 1;
    if (totalRot === 90 || totalRot === 270) {
      const ctr = vid.parentElement;
      const cw  = ctr ? ctr.clientWidth  : 0;
      const ch  = ctr ? ctr.clientHeight : 0;
      const mw0 = vid.videoWidth  || vid.naturalWidth  || 0;
      const mh0 = vid.videoHeight || vid.naturalHeight || 0;
      if (cw > 0 && ch > 0 && mw0 > 0 && mh0 > 0) {
        const ofit = Math.min(cw / mw0, ch / mh0);
        fitFactor   = Math.min(cw / (mh0 * ofit), ch / (mw0 * ofit));
      }
    }

    // 實際 CSS transform sx/sy（含翻轉符號 + fit 縮放）
    const sxActual = (flipH ? -1 : 1) * baseScaleX * fitFactor;
    const syActual = (flipV ? -1 : 1) * baseScaleY * fitFactor;

    // ---- 逆 CSS transform：viewport 點 → 元素版面座標 ----
    // CSS transform 正向：V = Scale(sx,sy) · Translate(tx,ty) · Rotate(deg) · P（以元素中心為原點）
    // 逆向：M⁻¹ = Rotate(-deg) · Translate(-tx,-ty) · Scale(1/sx,1/sy)

    const cxVp = rect.left + rect.width  / 2;  // 元素中心（viewport 空間）
    const cyVp = rect.top  + rect.height / 2;
    let dx = clientX - cxVp;
    let dy = clientY - cyVp;

    // Step 1：逆縮放
    if (sxActual !== 0) dx /= sxActual;
    if (syActual !== 0) dy /= syActual;
    // Step 2：逆位移（translateX/Y 在縮放後、旋轉前的空間中）
    dx -= translateX;
    dy -= translateY;
    // Step 3：逆旋轉 → 得到元素版面空間的位移
    let dex, dey;
    if      (totalRot ===  90) { dex =  dy; dey = -dx; }
    else if (totalRot === 180) { dex = -dx; dey = -dy; }
    else if (totalRot === 270) { dex = -dy; dey =  dx; }
    else                       { dex =  dx; dey =  dy; }

    // 元素版面座標（左上角為原點）
    const elemX = elemW / 2 + dex;
    const elemY = elemH / 2 + dey;

    // ---- letterbox 補正（在元素版面空間計算）→ 媒體像素 ----
    const mw  = vid.videoWidth  || vid.naturalWidth  || elemW;
    const mh  = vid.videoHeight || vid.naturalHeight || elemH;
    const scl = Math.min(elemW / mw, elemH / mh);
    const cx0 = (elemW - mw * scl) / 2;
    const cy0 = (elemH - mh * scl) / 2;
    const px  = Math.max(0, Math.min(mw - 1, Math.round((elemX - cx0) / scl)));
    const py  = Math.max(0, Math.min(mh - 1, Math.round((elemY - cy0) / scl)));

    // ---- drawImage + 取色 ----
    const canvas = document.createElement('canvas');
    canvas.width = mw; canvas.height = mh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, desynchronized: true });
    ctx.drawImage(vid, 0, 0, mw, mh);
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      const _a = _getActive();
      if (kind === 'target') {
        if (_a) { ensureE2(_a); _a.e2.target.hex = rgbToHex([d[0], d[1], d[2]]); }
      } else {
        // 低飽和度像素（接近黑/灰/白）的 HSL hue 數值極不穩定：
        // 例如 (8,8,10) 的 B 僅多 2 單位就得到 hue=240°，不代表真實色相。
        // 飽和度 < 20% 視為中性區域，不更新 targetHue 並給予提示。
        // 黑白灰（飽和度 < 20%）的 hue 不穩定 → 改以「明度選取」模式（Resolve Luminance Qualifier 語彙），
        // 仍可調亮度/對比/飽和(上色)/復古；色調滑桿在此模式下 = 上色色相。
        if (_a) _applyPickedColor(_a, d[0], d[1], d[2]);
        if (_a?.mode === 'lum') _showToast(`<span>已選取中性色（明度 ${Math.round((_a.targetLum ?? 0) * 100)}%）——以明度範圍選取，色調滑桿 = 上色色相</span>`);
      }
      _markTempFilterDirty();
      if (_VCS._mediaType === 'image' && !_VCS._imgOriginalSrc) _VCS._imgOriginalSrc = vid.src;
      vcStopEyedropper();
      vcSyncPanel();
      const sw = document.getElementById('vc-sel-swatch');
      if (sw) { sw.classList.add('vc-swatch-flash'); setTimeout(() => sw.classList.remove('vc-swatch-flash'), 600); }
      _scheduleCanvasUpdate();
    } catch { vcStopEyedropper(); }
  };

  let _touchHandled = false;
  _eyedropperHandler = (e) => {
    if (!_eyedropperActive) return;
    e.preventDefault();
    if (e.type === 'touchend') {
      // 手機：用原始 touch 座標，避免合成 click 的 clientX/Y 偏差
      _touchHandled = true;
      const t = e.changedTouches[0];
      if (t) _pickAt(t.clientX, t.clientY);
    } else {
      // 桌機 click；若已由 touchend 處理則跳過（避免雙觸發）
      if (_touchHandled) { _touchHandled = false; return; }
      _pickAt(e.clientX, e.clientY);
    }
  };

  vid.addEventListener('click',    _eyedropperHandler);
  vid.addEventListener('touchend', _eyedropperHandler);
}

export function vcStopEyedropper() {
  if (_eyedropperActive) _eyedropperEndAt = Date.now();
  _eyedropperActive = false;
  document.getElementById('vc-eyedropper-btn')?.classList.remove('vc-on');
  const hint = document.getElementById('vc-sel-pick-hint');
  const swatch = document.getElementById('vc-sel-swatch');
  if (hint)   hint.style.display   = 'none';
  if (swatch) swatch.style.display = '';
  const img = _VCS._vid;
  if (img) {
    img.style.cursor = '';
    img.removeEventListener('click',    _eyedropperHandler);
    img.removeEventListener('touchend', _eyedropperHandler);
  }
  _eyedropperHandler = null;
}

export function vcSetSelectiveHue(key, val) {
  const a = _getActive();
  if (!a) return;
  a[key] = +val;
  _markTempFilterDirty();
  if (a.targetHue !== null) _scheduleCanvasUpdate();
  vcSyncPanel();
}

/** 寫入取色結果（取色筆／顏色圓盤共用）：S<20% → 明度模式，否則色相模式 */
function _applyPickedColor(item, r, g, b) {
  const [h, sat, l] = _rgbToHsl(r, g, b);
  item.pickedRgb = [r, g, b];
  if (sat < 0.20) { item.mode = 'lum'; item.targetLum = l; item.targetHue = Math.round(h); }
  else            { item.mode = 'hue'; item.targetLum = null; item.targetHue = Math.round(h); }
  _markTempFilterDirty();
}
export function vcSetSelectiveRgb(r, g, b) {
  const a = _getActive();
  if (!a) return;
  _applyPickedColor(a, r, g, b);
  _scheduleCanvasUpdate(); vcSyncPanel();
}
export function vcSetSelectiveHex(hex) {
  const m = String(hex || '').trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return false;
  let x = m[1]; if (x.length === 3) x = x.split('').map(c => c + c).join('');
  vcSetSelectiveRgb(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16));
  return true;
}
export function vcSetSelectiveHueDeg(deg) {      // 顏色圓盤點選：以色相 + 中飽和中明度代表色
  const a = _getActive();
  if (!a) return;
  const hh = ((deg % 360) + 360) % 360;
  const [r, g, b] = _hslToRgb(hh / 360, 0.75, 0.5);
  _applyPickedColor(a, r, g, b);
  _scheduleCanvasUpdate(); vcSyncPanel();
}
function _hslToRgb(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
export function vcGetActiveSelectiveColor() {
  const a = _getActive();
  if (!a || a.targetHue === null) return null;
  const rgb = a.pickedRgb || _hslToRgb(a.targetHue / 360, 0.7, 0.5);
  return { rgb, hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''), hue: a.targetHue, mode: a.mode || 'hue', lum: a.targetLum };
}

/* 顏色圓盤 popover（Figma colour popover／iOS UIColorPicker 語彙：預覽 + 色環 + HEX/RGB 直接輸入 + 清除） */
let _wheelDrag = false;
export function vcToggleColorPopover(force) {
  const pop = document.getElementById('vc-sel-color-pop');
  if (!pop) return;
  const show = force !== undefined ? !!force : pop.hidden;
  pop.hidden = !show;
  document.getElementById('vc-sel-swatch')?.classList.toggle('vc-on', show);
  if (show) { _wheelDraw(); vcSyncColorPopover(); }
}
function _wheelDraw() {
  const c = document.getElementById('vc-sel-wheel');
  if (!c || c._drawn) return;
  const ctx = c.getContext('2d'), W = c.width, R = W / 2;
  for (let a = 0; a < 360; a++) {
    ctx.beginPath(); ctx.moveTo(R, R);
    ctx.arc(R, R, R, (a - 91) * Math.PI / 180, (a - 89) * Math.PI / 180);
    ctx.closePath(); ctx.fillStyle = `hsl(${a},100%,50%)`; ctx.fill();
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(R, R, R * 0.58, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  c._drawn = true;
  const pick = (e) => {
    const r = c.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - (r.left + r.width / 2), dy = p.clientY - (r.top + r.height / 2);
    const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
    vcSetSelectiveHueDeg(Math.round(deg));
  };
  c.addEventListener('mousedown', e => { _wheelDrag = true; pick(e); });
  window.addEventListener('mousemove', e => { if (_wheelDrag) pick(e); });
  window.addEventListener('mouseup', () => { _wheelDrag = false; });
  c.addEventListener('touchstart', e => { e.preventDefault(); pick(e); }, { passive: false });
  c.addEventListener('touchmove',  e => { e.preventDefault(); pick(e); }, { passive: false });
}
export function vcSyncColorPopover() {
  const pop = document.getElementById('vc-sel-color-pop');
  if (!pop || pop.hidden) return;
  const col = vcGetActiveSelectiveColor();
  const prev = document.getElementById('vc-sel-color-prev');
  if (prev) prev.style.background = col ? col.hex : 'transparent';
  const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
  set('vc-sel-hex', col ? col.hex.toUpperCase() : '');
  set('vc-sel-r', col ? col.rgb[0] : ''); set('vc-sel-g', col ? col.rgb[1] : ''); set('vc-sel-b', col ? col.rgb[2] : '');
  const dot = document.getElementById('vc-sel-wheel-dot');
  if (dot) {
    if (col && col.mode === 'hue') {
      const rad = (col.hue - 90) * Math.PI / 180, R = 0.79;     // 環中心半徑（0.58–1.0 的中點）
      dot.style.display = '';
      dot.style.left = `${50 + 50 * R * Math.cos(rad)}%`; dot.style.top = `${50 + 50 * R * Math.sin(rad)}%`;
    } else dot.style.display = 'none';
  }
  const modeEl = document.getElementById('vc-sel-color-mode');
  if (modeEl) modeEl.textContent = !col ? '尚未取色' : col.mode === 'lum'
    ? `明度選取（中性色 ${Math.round((col.lum ?? 0) * 100)}%）` : `色相選取 ${col.hue}°`;
}

export function vcClearSelectiveColor() {
  const a = _getActive();
  if (!a) return;
  a.targetHue  = null; a.mode = 'hue'; a.targetLum = null; a.pickedRgb = null;
  a.range      = 30;
  a.hueShift   = 0;
  a.brightness = 0;
  a.contrast   = 0;
  a.saturate   = 0;
  a.sepia      = 0;
  _markTempFilterDirty();
  vcStopEyedropper();
  _scheduleCanvasUpdate();
  vcSyncPanel();
}

export function vcAddSelectiveColor() {
  const item = _newSelItem();
  ensureE2(item);
  _VCS.selectiveList.push(item);
  _VCS._activeSelectiveId = item.id;
  _markTempFilterDirty();
  vcSyncPanel();
  vcStartEyedropper();
}

/* ── 色塊複製（Figma/Photoshop Duplicate 語彙；貼到清單末端）──
   時段接續律：來源有時段 → 新時段 = [T, T + len]，T = 所有有時段色塊的最大終點
   （不一定是清單最後一個）；len = 來源時段長度；超出片長則夾住；無時段 → 原樣複製。 */
export function vcDuplicateSelective(id) {
  const src = id != null ? _VCS.selectiveList.find(s => s.id === id) : _getActive();
  if (!src) return;
  const dup = { ..._newSelItem(), ...JSON.parse(JSON.stringify(src)), id: _newSelItem().id };
  if (src.abStart !== null && src.abEnd !== null) {
    const len = Math.max(0, src.abEnd - src.abStart);
    const tail = _VCS.selectiveList.reduce((m, s) => (s.abEnd !== null ? Math.max(m, s.abEnd) : m), 0);
    const dur = _VCS._vid?.duration;
    let a = tail, b = tail + len;
    if (dur && isFinite(dur)) { a = Math.min(a, dur); b = Math.min(b, dur); }
    dup.abStart = a; dup.abEnd = b;
  }
  ensureE2(dup);
  _VCS.selectiveList.push(dup);
  _VCS._activeSelectiveId = dup.id;
  _markTempFilterDirty();
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
  try { navigator.vibrate?.(15); } catch (_) {}
  _showToast(dup.abStart !== null
    ? `<span>已複製色塊 → 時段 ${fmtTimeF(dup.abStart)}–${fmtTimeF(dup.abEnd)}${dup.abEnd - dup.abStart < (src.abEnd - src.abStart) - 0.01 ? '（已達片尾，時段被截短）' : ''}</span>`
    : `<span>已複製色塊</span>`);
}

export function vcSetActiveSelective(id) {
  _VCS._activeSelectiveId = id;
  vcSyncPanel();
}

export function vcRemoveActiveSelective() { const a = _getActive(); if (a) vcRemoveSelective(a.id); }
export function vcRemoveSelective(id) {
  _releaseDerivedAb(id);
  _VCS.selectiveList = _VCS.selectiveList.filter(s => s.id !== id);
  if (_VCS._activeSelectiveId === id) {
    _VCS._activeSelectiveId = _VCS.selectiveList.at(-1)?.id ?? null;
  }
  _markTempFilterDirty();
  _scheduleCanvasUpdate();
  vcSyncPanel();
}

export function vcBindAbToSelective() {
  const item = _getActive();
  if (!item || _VCS.ab.a === null || _VCS.ab.b === null) return;
  let start = _VCS.ab.a, end = _VCS.ab.b;
  if (start > end) { [start, end] = [end, start]; }
  item.abStart = start;
  item.abEnd   = end;
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
  _showToast(`<span>已綁定 ${fmtTimeF(start)}–${fmtTimeF(end)}</span>`);
}

/** 選色時段直接輸入（m:ss 或秒）：只設一端時另一端補 0／片長，確保時段有效 */
export function vcSelAbEdit(point, el) {
  const item = _getActive();
  if (!item) { vcSyncPanel(); return; }
  const raw = ('value' in el ? el.value : el.textContent).trim().replace(/[^\d:.]/g, '');
  const m = raw.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  let sec = m ? +m[1] * 60 + +m[2] : parseFloat(raw);
  const dur = _VCS._vid?.duration;
  if (!raw) {                                   // 清空 = 移除該端；兩端皆空 = 全片
    if (point === 'start') item.abStart = null; else item.abEnd = null;
    if (item.abStart === null || item.abEnd === null) { item.abStart = null; item.abEnd = null; }
  } else if (!isNaN(sec) && sec >= 0) {
    if (dur && isFinite(dur)) sec = Math.min(sec, dur);
    if (point === 'start') { item.abStart = sec; if (item.abEnd === null) item.abEnd = (dur && isFinite(dur)) ? dur : sec; }
    else                   { item.abEnd = sec;   if (item.abStart === null) item.abStart = 0; }
    if (item.abStart > item.abEnd) [item.abStart, item.abEnd] = [item.abEnd, item.abStart];
  }
  _followDerivedAb(item);
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
}
/** 選色時段 A／B 鈕：播放頁籤已設定該端點 → 對照播放 A／B（SSOT，不隨目前進度漂移）；
    未設定 → 退回目前播放位置 */
export function vcSelAbNow(point) {
  const item = _getActive();
  const vid = _VCS._vid;
  if (!item || !vid) return;
  const fromAb = point === 'start' ? _VCS.ab.a : _VCS.ab.b;
  const t = (fromAb !== null && fromAb !== undefined) ? fromAb : (vid.currentTime || 0), dur = vid.duration;
  if (point === 'start') { item.abStart = t; if (item.abEnd === null) item.abEnd = (dur && isFinite(dur)) ? dur : t; }
  else                   { item.abEnd = t;   if (item.abStart === null) item.abStart = 0; }
  if (item.abStart > item.abEnd) [item.abStart, item.abEnd] = [item.abEnd, item.abStart];
  _followDerivedAb(item);
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
  _showToast(`<span>時段 ${fmtTimeF(item.abStart)}–${fmtTimeF(item.abEnd)}</span>`);
}

export function vcUnbindAbFromSelective() {
  const item = _getActive();
  if (!item) return;
  item.abStart = null; item.abEnd = null;
  if (_releaseDerivedAb(item.id)) _showToast(`<span>已移除時段，並停止由它派生的 AB 循環</span>`);
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
}

/* ── 色塊時段一鍵播放（業界語彙：Resolve range marker → In/Out + Loop；YouTube chapter 分段）──
   套用 = 寫入播放 AB（SSOT _VCS.ab）+ seek 至起點 + 播放；同一時段循環中再按 = 停止（toggle）。 */
export function vcIsSelectiveLooping(item) {
  return !!item && item.abStart !== null && _VCS.ab.active &&
         _VCS.ab.a !== null && _VCS.ab.b !== null &&
         Math.abs(_VCS.ab.a - item.abStart) < 0.05 && Math.abs(_VCS.ab.b - item.abEnd) < 0.05;
}
/* Provenance（派生律）：播放 AB 若由色塊派生（_VCS.ab.srcSel = item.id）→
   來源時段被移除／色塊被刪 → 釋放 AB（停止循環 + 清空）；來源時段被編輯 → AB 跟隨；
   使用者在播放頁籤手動改 AB → 解除綁定（vc-playback 寫入時清 srcSel）。 */
function _releaseDerivedAb(itemId) {
  if (_VCS.ab.srcSel !== itemId) return false;
  _VCS.ab = { a: null, b: null, active: false, srcSel: null };
  return true;
}
function _followDerivedAb(item) {
  // 序列中的色塊時段也跟隨（不然序列自癒檢查會因不一致而失效）
  for (const x of (_VCS.abSeq?.items || [])) if (x.srcSel === item.id && item.abStart !== null) { x.a = item.abStart; x.b = item.abEnd; }
  if (_VCS.ab.srcSel !== item.id) return;
  if (item.abStart === null) { _releaseDerivedAb(item.id); return; }
  _VCS.ab.a = item.abStart; _VCS.ab.b = item.abEnd;
}

export function vcPlaySelectiveRange(id) {
  const item = id != null ? _VCS.selectiveList.find(s => s.id === id) : _getActive();
  const vid = _VCS._vid;
  if (!item || !vid || item.abStart === null) return;
  if (vcIsSelectiveLooping(item)) {
    _VCS.ab = { a: null, b: null, active: false, srcSel: null };     // 停止 = 釋放派生 AB（不殘留）
    _showToast(`<span>已停止時段循環</span>`);
  } else {
    _VCS.abSeq = { items: [], idx: 0 };   // 濾鏡頁籤色塊 = 單段（不參與序列）
    _VCS.ab.a = item.abStart; _VCS.ab.b = item.abEnd; _VCS.ab.active = true; _VCS.ab.srcSel = item.id;
    if (_VCS._activeSelectiveId !== item.id) { _VCS._activeSelectiveId = item.id; }
    vid.currentTime = item.abStart;
    vid.play?.().catch?.(() => {});
    _showToast(`<span>只播放此色塊時段 ${fmtTimeF(item.abStart)}–${fmtTimeF(item.abEnd)}（時段列「⏹ 停止循環」可取消）</span>`);
  }
  vcSyncPanel();
  vcRenderSelectiveChips();
}

let _lpFiredAt = 0;   // 最近一次長按複製的時間戳（chips 重繪後仍可擋掉合成 click）
export function vcRenderSelectiveChips() {
  const container = document.getElementById('vc-sel-chips');
  if (!container) return;
  container.innerHTML = '';
  for (const item of _VCS.selectiveList) {
    const isActive = item.id === _VCS._activeSelectiveId;
    const bg = item.targetHue !== null
      ? (item.pickedRgb ? `rgb(${item.pickedRgb[0]},${item.pickedRgb[1]},${item.pickedRgb[2]})` : `hsl(${item.targetHue},70%,50%)`)
      : '#888';
    const chip = document.createElement('span');
    chip.className = 'vc-sel-chip' + (isActive ? ' vc-on' : '');
    chip.style.background = bg;
    const hasRange = item.abStart !== null;
    const looping = hasRange && vcIsSelectiveLooping(item);
    if (looping) chip.classList.add('vc-sel-chip-looping');
    chip.title = (item.targetHue !== null ? (item.mode === 'lum' ? '中性色（明度選取）' : `色相 ${item.targetHue}°`) : '未取色')
      + (hasRange ? `｜時段 ${fmtTimeF(item.abStart)}–${fmtTimeF(item.abEnd)}（點選即播放此時段）` : '')
      + '｜Ctrl+D／長按 = 複製';
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', chip.title);
    /* 點選 = 切換色塊；有時段者同時套用為播放 AB 循環（派生，來源消失即釋放） */
    chip.onclick = () => {
      if (Date.now() - _lpFiredAt < 600) return;          // 長按後的合成 click 忽略
      vcSetActiveSelective(item.id);
      if (hasRange && !vcIsSelectiveLooping(item)) vcPlaySelectiveRange(item.id);
    };
    chip.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); vcDuplicateSelective(item.id); } };
    /* 手機：長按 500ms = 複製（iOS context-menu 語彙；震動回饋）；移動超過 10px 取消 */
    let lpTimer = 0, lpX = 0, lpY = 0;
    chip.addEventListener('touchstart', (e) => {
      lpX = e.touches[0].clientX; lpY = e.touches[0].clientY;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => { _lpFiredAt = Date.now(); vcDuplicateSelective(item.id); }, 500);
    }, { passive: true });
    chip.addEventListener('touchmove', (e) => {
      if (Math.abs(e.touches[0].clientX - lpX) > 10 || Math.abs(e.touches[0].clientY - lpY) > 10) clearTimeout(lpTimer);
    }, { passive: true });
    chip.addEventListener('touchend', () => clearTimeout(lpTimer), { passive: true });
    chip.addEventListener('touchcancel', () => clearTimeout(lpTimer), { passive: true });
    chip.addEventListener('contextmenu', (e) => e.preventDefault());
    if (hasRange) {                                        // 時段指示點（純顯示，不可點 → 手機不誤觸）
      const dot = document.createElement('span');
      dot.className = 'vc-sel-chip-time' + (looping ? ' vc-on' : '');
      dot.textContent = looping ? '⟲' : '⏱';
      chip.appendChild(dot);
    }
    container.appendChild(chip);
  }
  vcRenderAbPresets();                                    // AB 設定庫的「色塊時段」群組隨色塊同步
  document.dispatchEvent(new CustomEvent('vc-ranges-changed'));
}

/* ══════════════════════════════════════════════════════════════════
   Apply（濾鏡）
══════════════════════════════════════════════════════════════════ */
export function vcApplyFilter(vid) {
  if (!vid) return;
  if (_VCS.engine === 2) {
    vid.style.filter = e2CssFilter(_VCS.filter2);
  } else {
    const f = _VCS.filter;
    const blurPx = f.sharpness < 0 ? Math.abs(f.sharpness) * 0.5 : 0;
    const parts = [
      `brightness(${f.brightness})`,
      `contrast(${f.contrast})`,
      `saturate(${f.saturate})`,
      `hue-rotate(${f.hueRotate}deg)`,
      `sepia(${f.sepia ?? 0}%)`,
    ];
    if (blurPx > 0) parts.push(`blur(${blurPx.toFixed(1)}px)`);
    vid.style.filter = parts.join(' ');
  }

  if (_needsCanvas()) {
    if (!_VCS._imgOriginalSrc) _VCS._imgOriginalSrc = vid.src;
    _scheduleCanvasUpdate();
  } else if (_VCS._mediaType === 'image' && _VCS._canvasObjectURL) {
    _restoreOriginalSrc();
  }
}

/* ── Setter（濾鏡）────────────────────────────────────────────── */
export function vcSetFilter(key, val) {
  _VCS.filter[key] = +val;
  _markTempFilterDirty();
  vcApplyFilter(_VCS._vid);
  vcSyncPanel();
}

/* ── Engine 切換 ──────────────────────────────────────────────── */
export function vcSetEngine(n) {
  vcSetEngineState(n);
  if (_VCS.engine === 2) _VCS.selectiveList.forEach(ensureE2);
  vcApplyFilter(_VCS._vid);
  _scheduleCanvasUpdate();
  _markTempFilterDirty();
  vcSyncPanel();
}

/* ── Setter（v2 全域濾鏡）─────────────────────────────────────── */
export function vcSetFilter2(key, val) {
  _VCS.filter2[key] = val;
  _markTempFilterDirty();
  vcApplyFilter(_VCS._vid);
  vcSyncPanel();
}

/* ── Setter（v2 選色，點路徑：'qual.hW'、'target.hex' 等）───────── */
export function vcSetSel2(path, val) {
  const a = _getActive();
  if (!a) return;
  ensureE2(a);
  const parts = String(path).split('.');
  let obj = a.e2;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = val;
  _markTempFilterDirty();
  _scheduleCanvasUpdate();
  vcSyncPanel();
}

/* ── Reset（濾鏡）─────────────────────────────────────────────── */
export function vcResetFilters() {
  _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS.filter2               = { ...E2_FILTER_DEFAULT };
  _VCS.selectiveList = []; _VCS._activeSelectiveId = null;
  _VCS._activeFilterPresetId = null;
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  vcStopEyedropper();
  _stopVideoRafLoop();
  _glShowCanvas(false);
  _restoreOriginalSrc();
  _VCS._imgOriginalSrc = null;
  if (_VCS._itemId) {
    const vfl = _loadVideoFilterData(_VCS._itemId);
    vfl.lastUsed = null;
    _saveVideoFilterData(_VCS._itemId, vfl);
  }
  const vid = _VCS._vid;
  if (vid) vid.style.filter = '';
  vcSyncPanel();
  vcRenderFilterPresets();
}
