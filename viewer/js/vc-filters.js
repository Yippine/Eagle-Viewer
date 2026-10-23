'use strict';
/* ── vc-filters.js  ▸  CSS 濾鏡 + 選擇性色彩 + Eyedropper ────────────
   臨時濾鏡狀態機／取色器／選色 setter／chips／vcApplyFilter
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { fmtTime } from './utils.js';
import { _VCS, _getActive, _newSelItem,
         _loadFilterPresets, _loadVideoFilterData, _saveVideoFilterData }
  from './vc-state.js';
import { _glShowCanvas, _stopVideoRafLoop,
         _glResetTexSrc, _glClearTexture } from './vc-webgl.js';
import { _rgbToHsl, _scheduleCanvasUpdate,
         _restoreOriginalSrc, _needsCanvas } from './vc-canvas.js';
import { vcRenderFilterPresets } from './vc-presets.js';
import { _showToast, vcDismissToast, vcSyncPanel } from './vc-panel.js';

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
let _eyedropperHandler = null;

export function vcStartEyedropper() {
  const vid = _VCS._vid;
  if (!vid) return;
  if (_VCS._mediaType === 'video' && !vid.paused) vid.pause();
  _eyedropperActive = true;
  document.getElementById('vc-eyedropper-btn')?.classList.add('vc-on');
  const hint = document.getElementById('vc-sel-pick-hint');
  const swatch = document.getElementById('vc-sel-swatch');
  if (hint)   hint.style.display   = '';
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
      const [h, s] = _rgbToHsl(d[0], d[1], d[2]);
      const _a = _getActive();
      // 低飽和度像素（接近黑/灰/白）的 HSL hue 數值極不穩定：
      // 例如 (8,8,10) 的 B 僅多 2 單位就得到 hue=240°，不代表真實色相。
      // 飽和度 < 20% 視為中性區域，不更新 targetHue 並給予提示。
      if (s < 0.20) {
        // 中性像素：顯示警告 toast，不寫入 targetHue
        const hint = document.getElementById('vc-sel-pick-hint');
        if (hint) {
          hint.textContent = '此區域接近中性（無明顯色相）';
          hint.style.display = '';
          setTimeout(() => { if (hint) { hint.textContent = '點擊取色'; hint.style.display = 'none'; } }, 2000);
        }
        vcStopEyedropper();
        return;
      }
      if (_a) { _a.targetHue = Math.round(h); _a.pickedRgb = [d[0], d[1], d[2]]; _markTempFilterDirty(); }
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

export function vcClearSelectiveColor() {
  const a = _getActive();
  if (!a) return;
  a.targetHue  = null;
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
  _VCS.selectiveList.push(item);
  _VCS._activeSelectiveId = item.id;
  _markTempFilterDirty();
  vcSyncPanel();
  vcStartEyedropper();
}

export function vcSetActiveSelective(id) {
  _VCS._activeSelectiveId = id;
  vcSyncPanel();
}

export function vcRemoveSelective(id) {
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
  _showToast(`<span>已綁定 ${fmtTime(start)}–${fmtTime(end)}</span>`);
}

/** 選色時段直接輸入（m:ss 或秒）：只設一端時另一端補 0／片長，確保時段有效 */
export function vcSelAbEdit(point, el) {
  const item = _getActive();
  if (!item) { vcSyncPanel(); return; }
  const raw = el.textContent.trim().replace(/[^\d:.]/g, '');
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
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
}
/** 以目前播放位置設定選色時段端點 */
export function vcSelAbNow(point) {
  const item = _getActive();
  const vid = _VCS._vid;
  if (!item || !vid) return;
  const t = vid.currentTime || 0, dur = vid.duration;
  if (point === 'start') { item.abStart = t; if (item.abEnd === null) item.abEnd = (dur && isFinite(dur)) ? dur : t; }
  else                   { item.abEnd = t;   if (item.abStart === null) item.abStart = 0; }
  if (item.abStart > item.abEnd) [item.abStart, item.abEnd] = [item.abEnd, item.abStart];
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
  _showToast(`<span>時段 ${fmtTime(item.abStart)}–${fmtTime(item.abEnd)}</span>`);
}

export function vcUnbindAbFromSelective() {
  const item = _getActive();
  if (!item) return;
  item.abStart = null; item.abEnd = null;
  _scheduleCanvasUpdate();
  vcSyncPanel();
  vcRenderSelectiveChips();
}

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
    chip.title = item.targetHue !== null ? `色相 ${item.targetHue}°` : '未取色';
    chip.onclick = () => vcSetActiveSelective(item.id);
    const rm = document.createElement('button');
    rm.className = 'vc-sel-chip-rm';
    rm.textContent = '×';
    rm.title = '刪除此色塊';
    rm.onclick = (e) => { e.stopPropagation(); vcRemoveSelective(item.id); };
    if (item.abStart !== null) {
      const badge = document.createElement('span');
      badge.className = 'vc-sel-chip-time';
      badge.textContent = '⏱';
      badge.title = `${fmtTime(item.abStart)}–${fmtTime(item.abEnd)}`;
      chip.appendChild(badge);
    }
    chip.appendChild(rm);
    container.appendChild(chip);
  }
}

/* ══════════════════════════════════════════════════════════════════
   Apply（濾鏡）
══════════════════════════════════════════════════════════════════ */
export function vcApplyFilter(vid) {
  if (!vid) return;
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

/* ── Reset（濾鏡）─────────────────────────────────────────────── */
export function vcResetFilters() {
  _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
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
