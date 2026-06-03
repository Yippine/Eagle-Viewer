'use strict';
/* ── video-controls.js  ▸  三模組影片控制 ────────────────────────────
   Playback   ─ Loop mode / Autoplay Next / AB Loop / 播放速度
   Filters    ─ brightness / contrast / saturate / hue + 命名濾鏡庫
   Transform  ─ scale / offset / flip / rotate + 智慧裁切 + per-video 快照
══════════════════════════════════════════════════════════════════════*/

import { fmtTime } from './utils.js';

const _selDefault = (id = null) =>
  ({ id: id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
     targetHue: null, range: 30, hueShift: 0,
     brightness: 0, contrast: 0, saturate: 0, sepia: 0 });

const _newSelItem = () => _selDefault();
const _getActive = () =>
  _VCS.selectiveList.find(s => s.id === _VCS._activeSelectiveId) ?? null;

/* ── 狀態 ─────────────────────────────────────────────────────────── */
const _VCS = {
  filter:    { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 },
  selectiveList: [],
  _activeSelectiveId: null,
  tx:        { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
               rotate: 0, flipH: false, flipV: false },
  ab:        { a: null, b: null, active: false },
  playback:  { loopMode: 'single', speed: 1.0 },
  _vid:                null,
  _itemId:             null,
  _mediaType:          'video',
  _activeFilterPresetId: null,
  _autoRotate:         0,
  _imgOriginalSrc:     null,   // 圖片原始 src（Canvas 處理前保存）
  _canvasObjectURL:    null,   // Canvas 輸出的 blob URL
};

export function vcGetVid() { return _VCS._vid; }

/** 供播放器偵測到旋轉 metadata 未被瀏覽器套用時呼叫（不存入快照） */
export function vcSetAutoRotate(deg) {
  _VCS._autoRotate = ((deg % 360) + 360) % 360;
  vcApplyTransform(_VCS._vid);
}

/** 供播放器判斷此影片是否有已存快照（有快照→跳過自動旋轉偵測） */
export function vcHasSnapshot(itemId) {
  return !!_loadTransformSnapshot(itemId);
}

/* ══════════════════════════════════════════════════════════════════
   LocalStorage Keys
══════════════════════════════════════════════════════════════════ */
const _FILTER_PRESETS_KEY = 'eagle-filter-presets';
const _txKey  = id => `eagle-transform-${id}`;
const _vflKey = id => `eagle-media-filter-${id}`;
const _VFL_MIGRATED_KEY = 'eagle-vfl-migrated';

/* ══════════════════════════════════════════════════════════════════
   Server Sync（Union Merge + LWW by modifiedAt / savedAt）
══════════════════════════════════════════════════════════════════ */
const _CACHE = { filterPresets: [], transformSnapshots: {}, version: 0, loaded: false };
let _debounceTimer = null;

async function _syncLoad() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    const hasFP = data.filterPresets?.length;
    const hasTS = Object.keys(data.transformSnapshots || {}).length;
    if (hasFP || hasTS) {
      _CACHE.filterPresets      = data.filterPresets      || [];
      _CACHE.transformSnapshots = data.transformSnapshots || {};
      _CACHE.version            = data.version            || 0;
      localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(_CACHE.filterPresets));
      Object.entries(_CACHE.transformSnapshots).forEach(([id, snap]) =>
        localStorage.setItem(_txKey(id), JSON.stringify(snap)));
    } else {
      const local = JSON.parse(localStorage.getItem(_FILTER_PRESETS_KEY) || '[]');
      if (local.length) {
        _CACHE.filterPresets = local;
        _CACHE.version       = data.version || 0;
        _syncSave();
      }
    }
  } catch (e) {
    console.warn('[VCS] server sync unavailable, using localStorage:', e.message);
  }
  _CACHE.loaded = true;
  vcRenderFilterPresets();
  if (window.buildPresetChips) window.buildPresetChips();
  document.dispatchEvent(new CustomEvent('vc-snaps-synced'));
}

async function _syncPoll() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    if ((data.version || 0) > _CACHE.version) {
      _CACHE.filterPresets      = data.filterPresets      || [];
      _CACHE.transformSnapshots = data.transformSnapshots || {};
      _CACHE.version            = data.version;
      localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(_CACHE.filterPresets));
      Object.entries(_CACHE.transformSnapshots).forEach(([id, snap]) =>
        localStorage.setItem(_txKey(id), JSON.stringify(snap)));
      vcRenderFilterPresets();
      if (window.buildPresetChips) window.buildPresetChips();
      document.dispatchEvent(new CustomEvent('vc-snaps-synced'));
    }
  } catch (_) {}
}
setInterval(_syncPoll, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) _syncPoll(); });

function _syncSave() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    try {
      const res    = await fetch('/api/user-data', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clientData: _CACHE, clientVersion: _CACHE.version }),
      });
      const { merged } = await res.json();
      if (merged) {
        _CACHE.filterPresets      = merged.filterPresets      || [];
        _CACHE.transformSnapshots = merged.transformSnapshots || {};
        _CACHE.version            = merged.version            || _CACHE.version;
        vcRenderFilterPresets();
      }
    } catch (e) {
      console.warn('[VCS] sync save failed:', e.message);
    }
  }, 300);
}

/* ══════════════════════════════════════════════════════════════════
   Migration（舊 eagle-presets / eagle-video-* → 新 schema）
══════════════════════════════════════════════════════════════════ */
function _migrateOnce() {
  const oldPresets = localStorage.getItem('eagle-presets');
  if (!oldPresets || localStorage.getItem(_FILTER_PRESETS_KEY)) return;

  try {
    const old = JSON.parse(oldPresets);
    // filter-only presets（移除 tx 欄位）
    const newFP = old.map(p => ({
      id: p.id, name: p.name, filter: p.filter,
      createdAt: p.createdAt, modifiedAt: p.modifiedAt, deleted: p.deleted,
    }));
    localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(newFP));

    // 遷移 per-video TX（從 lastUsed preset 的 tx 欄位）
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('eagle-video-')) toRemove.push(key);
    }
    toRemove.forEach(key => {
      const itemId = key.slice('eagle-video-'.length);
      try {
        const vdata  = JSON.parse(localStorage.getItem(key) || '{}');
        // 保留濾鏡連結資料到新 key（在刪除前保存）
        if (vdata.presetIds?.length || vdata.lastUsed) {
          localStorage.setItem(_vflKey(itemId), JSON.stringify({
            presetIds: vdata.presetIds || [],
            lastUsed:  vdata.lastUsed  || null,
          }));
        }
        const preset = old.find(p => p.id === vdata.lastUsed);
        if (preset?.tx) {
          const hasTx = Object.entries(preset.tx).some(([k, v]) =>
            k === 'flipH' || k === 'flipV' ? v : v !== 0 && v !== 1);
          if (hasTx) {
            localStorage.setItem(_txKey(itemId),
              JSON.stringify({ tx: { ...preset.tx }, savedAt: Date.now() }));
          }
        }
      } catch (_) {}
      localStorage.removeItem(key);
    });
    localStorage.setItem(_VFL_MIGRATED_KEY, '1');

    localStorage.removeItem('eagle-presets');
  } catch (e) {
    console.warn('[VCS] migration failed:', e);
  }
}

/* ── eagle-video-filter-* → eagle-media-filter-* key 遷移 ────────── */
function _migrateMediaFilterKeys() {
  const toRename = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('eagle-video-filter-')) toRename.push(key);
  }
  toRename.forEach(key => {
    const newKey = key.replace('eagle-video-filter-', 'eagle-media-filter-');
    const val = localStorage.getItem(key);
    if (val) localStorage.setItem(newKey, val);
    localStorage.removeItem(key);
  });
}

/* ── Per-video filter link migration（已完成舊版 migration 的用戶補跑）── */
function _migrateVideoFilterLinks() {
  if (localStorage.getItem(_VFL_MIGRATED_KEY)) return;
  const toMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('eagle-video-') &&
        !key.startsWith('eagle-video-filter-') &&
        !key.startsWith('eagle-transform-')) toMigrate.push(key);
  }
  toMigrate.forEach(key => {
    const itemId = key.slice('eagle-video-'.length);
    try {
      const vdata = JSON.parse(localStorage.getItem(key) || '{}');
      if (vdata.presetIds?.length || vdata.lastUsed) {
        localStorage.setItem(_vflKey(itemId), JSON.stringify({
          presetIds: vdata.presetIds || [],
          lastUsed:  vdata.lastUsed  || null,
        }));
      }
    } catch (_) {}
  });
  localStorage.setItem(_VFL_MIGRATED_KEY, '1');
}

/* ══════════════════════════════════════════════════════════════════
   Filter Preset CRUD
══════════════════════════════════════════════════════════════════ */
function _loadFilterPresets() {
  if (_CACHE.loaded) return _CACHE.filterPresets;
  try { return JSON.parse(localStorage.getItem(_FILTER_PRESETS_KEY) || '[]'); }
  catch { return []; }
}
function _saveFilterPresets(arr) {
  arr.forEach(p => { if (!p.modifiedAt) p.modifiedAt = Date.now(); });
  _CACHE.filterPresets = arr;
  localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(arr));
  _syncSave();
}

/* ── Per-video filter link CRUD ──────────────────────────────────── */
function _loadVideoFilterData(itemId) {
  if (!itemId) return { presetIds: [], lastUsed: null };
  try { return JSON.parse(localStorage.getItem(_vflKey(itemId)) || '{"presetIds":[],"lastUsed":null}'); }
  catch { return { presetIds: [], lastUsed: null }; }
}
function _saveVideoFilterData(itemId, data) {
  if (!itemId) return;
  localStorage.setItem(_vflKey(itemId), JSON.stringify(data));
}

function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ══════════════════════════════════════════════════════════════════
   Canvas 工具：HSL 轉換 / 模糊 / 銳化 / 選擇性色相
══════════════════════════════════════════════════════════════════ */
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s, l];
}

function _hslToRgb(h, s, l) {
  h /= 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [Math.round(hue2rgb(h + 1/3) * 255), Math.round(hue2rgb(h) * 255), Math.round(hue2rgb(h - 1/3) * 255)];
}

function _hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function _boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < h; i++) {
    let ti = i * w, li = ti, ri = ti + r;
    let fv = src[ti * 4], lv = src[(ti + w - 1) * 4], val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[(ti + j) * 4];
    for (let j = 0; j <= r; j++, ri++) { val += src[ri * 4] - fv; dst[ti++ * 4] = Math.round(val * iarr); }
    for (let j = r + 1; j < w - r; j++, ri++, li++) { val += src[ri * 4] - src[li * 4]; dst[ti++ * 4] = Math.round(val * iarr); }
    for (let j = w - r; j < w; j++, li++) { val += lv - src[li * 4]; dst[ti++ * 4] = Math.round(val * iarr); }
  }
}

function _boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < w; i++) {
    let ti = i, li = ti, ri = ti + r * w;
    let fv = src[ti * 4], lv = src[(ti + w * (h - 1)) * 4], val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[(ti + j * w) * 4];
    for (let j = 0; j <= r; j++, ri += w) { val += src[ri * 4] - fv; dst[ti * 4] = Math.round(val * iarr); ti += w; }
    for (let j = r + 1; j < h - r; j++, ri += w, li += w) { val += src[ri * 4] - src[li * 4]; dst[ti * 4] = Math.round(val * iarr); ti += w; }
    for (let j = h - r; j < h; j++, li += w) { val += lv - src[li * 4]; dst[ti * 4] = Math.round(val * iarr); ti += w; }
  }
}

function _blurChannel(data, w, h, r) {
  // 分離式 box blur（單通道；data 為 Uint8ClampedArray，步距 4）
  const tmp = new Uint8ClampedArray(data.length);
  _boxBlurH(data, tmp, w, h, r);
  _boxBlurV(tmp, data, w, h, r);
}

function _unsharpMask(imgData, amount) {
  const { data, width, height } = imgData;
  const blurred = new Uint8ClampedArray(data);
  _blurChannel(blurred, width, height, 1);
  for (let i = 0; i < data.length - 1; i += 4) {
    data[i]   = Math.min(255, Math.max(0, data[i]   + amount * (data[i]   - blurred[i])));
    data[i+1] = Math.min(255, Math.max(0, data[i+1] + amount * (data[i+1] - blurred[i+1])));
    data[i+2] = Math.min(255, Math.max(0, data[i+2] + amount * (data[i+2] - blurred[i+2])));
  }
  return imgData;
}

function _applySelectiveHue(imgData, sel) {
  const { data } = imgData;
  const { targetHue, range, hueShift = 0,
          brightness: dBri = 0, contrast: dCon = 0,
          saturate: dSat = 0, sepia: dSep = 0 } = sel;
  if (targetHue === null) return imgData;
  const isNoop = hueShift === 0 && dBri === 0 && dCon === 0
                 && dSat === 0 && dSep === 0;
  if (isNoop) return imgData;

  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

  for (let i = 0; i < data.length - 1; i += 4) {
    const [h, s, l] = _rgbToHsl(data[i], data[i+1], data[i+2]);
    if (_hueDist(h, targetHue) > range) continue;

    const h2 = (h + hueShift + 360) % 360;
    const s2 = clamp(s * (1 + dSat));
    const l2 = clamp(l * (1 + dBri));

    let [r, g, b] = _hslToRgb(h2, s2, l2);

    if (dCon !== 0) {
      const f = 1 + dCon;
      r = clamp((r / 255 - 0.5) * f + 0.5) * 255;
      g = clamp((g / 255 - 0.5) * f + 0.5) * 255;
      b = clamp((b / 255 - 0.5) * f + 0.5) * 255;
    }

    if (dSep !== 0) {
      const sr = r * 0.393 + g * 0.769 + b * 0.189;
      const sg = r * 0.349 + g * 0.686 + b * 0.168;
      const sb = r * 0.272 + g * 0.534 + b * 0.131;
      r = clamp(r + (sr - r) * dSep, 0, 255);
      g = clamp(g + (sg - g) * dSep, 0, 255);
      b = clamp(b + (sb - b) * dSep, 0, 255);
    }

    data[i] = Math.round(r);
    data[i+1] = Math.round(g);
    data[i+2] = Math.round(b);
  }
  return imgData;
}

/* ── Canvas Pipeline ──────────────────────────────────────────── */
let _canvasTimer = null;

function _needsCanvas() {
  return _VCS._mediaType === 'image' &&
         (_VCS.filter.sharpness > 0 || _VCS.selectiveList.some(s => s.targetHue !== null));
}

function _releaseCanvas() {
  if (_VCS._canvasObjectURL) { URL.revokeObjectURL(_VCS._canvasObjectURL); _VCS._canvasObjectURL = null; }
}

function _scheduleCanvasUpdate() {
  clearTimeout(_canvasTimer);
  _canvasTimer = setTimeout(_runCanvasPipeline, 180);
}

async function _runCanvasPipeline() {
  const img = _VCS._vid;
  if (!img || _VCS._mediaType !== 'image') return;
  // 必須在 img.src 被替換成 blob 之前捕捉 originalSrc
  if (!_VCS._imgOriginalSrc) _VCS._imgOriginalSrc = img.src;
  const src = _VCS._imgOriginalSrc;
  if (!src) return;

  const srcImg = new Image();
  srcImg.src = src;
  if (!srcImg.complete) await new Promise((res, rej) => { srcImg.onload = res; srcImg.onerror = rej; });

  const canvas = document.createElement('canvas');
  canvas.width  = srcImg.naturalWidth  || srcImg.width;
  canvas.height = srcImg.naturalHeight || srcImg.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(srcImg, 0, 0);

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return; // tainted canvas（跨域）：跳過 Canvas 處理
  }

  const s = _VCS.filter.sharpness;
  if (s > 0) _unsharpMask(imgData, s * 0.12);
  for (const s of _VCS.selectiveList) {
    if (s.targetHue !== null) _applySelectiveHue(imgData, s);
  }

  ctx.putImageData(imgData, 0, 0);
  canvas.toBlob(blob => {
    if (!blob || img !== _VCS._vid) return;
    _releaseCanvas();
    _VCS._canvasObjectURL = URL.createObjectURL(blob);
    img.src = _VCS._canvasObjectURL;
  }, 'image/jpeg', 0.95);
}

function _restoreOriginalSrc() {
  const img = _VCS._vid;
  if (!img || !_VCS._imgOriginalSrc) return;
  _releaseCanvas();
  img.src = _VCS._imgOriginalSrc;
}


/* ── Eyedropper ───────────────────────────────────────────────── */
let _eyedropperActive = false;
let _eyedropperHandler = null;

export function vcStartEyedropper() {
  const img = _VCS._vid;
  if (!img || _VCS._mediaType !== 'image') return;
  _eyedropperActive = true;
  document.getElementById('vc-eyedropper-btn')?.classList.add('vc-on');
  img.style.cursor = 'crosshair';

  _eyedropperHandler = (e) => {
    if (!_eyedropperActive) return;
    e.preventDefault();
    // offsetX/offsetY 是 element 本地座標（不受 CSS transform 影響）
    const px = Math.round(e.offsetX * (img.naturalWidth  || img.offsetWidth)  / img.offsetWidth);
    const py = Math.round(e.offsetY * (img.naturalHeight || img.offsetHeight) / img.offsetHeight);

    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth  || img.offsetWidth;
    canvas.height = img.naturalHeight || img.offsetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // 直接從 img 元素 drawImage（已在記憶體，無 async，無 src 切換問題）
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      const [h] = _rgbToHsl(d[0], d[1], d[2]);
      const _a = _getActive();
      if (_a) { _a.targetHue = Math.round(h); }
      // 確保 originalSrc 在第一次 canvas op 前已捕捉
      if (!_VCS._imgOriginalSrc) _VCS._imgOriginalSrc = img.src;
      vcStopEyedropper();
      vcSyncPanel();
      _scheduleCanvasUpdate();
    } catch { vcStopEyedropper(); }
  };

  img.addEventListener('click', _eyedropperHandler);
}

export function vcStopEyedropper() {
  _eyedropperActive = false;
  document.getElementById('vc-eyedropper-btn')?.classList.remove('vc-on');
  const img = _VCS._vid;
  if (img) { img.style.cursor = ''; img.removeEventListener('click', _eyedropperHandler); }
  _eyedropperHandler = null;
}

export function vcSetSelectiveHue(key, val) {
  const a = _getActive();
  if (!a) return;
  a[key] = +val;
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
  vcStopEyedropper();
  _scheduleCanvasUpdate();
  vcSyncPanel();
}

export function vcAddSelectiveColor() {
  const item = _newSelItem();
  _VCS.selectiveList.push(item);
  _VCS._activeSelectiveId = item.id;
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
  _scheduleCanvasUpdate();
  vcSyncPanel();
}

export function vcRenderSelectiveChips() {
  const container = document.getElementById('vc-sel-chips');
  if (!container) return;
  container.innerHTML = '';
  for (const item of _VCS.selectiveList) {
    const isActive = item.id === _VCS._activeSelectiveId;
    const bg = item.targetHue !== null ? `hsl(${item.targetHue},70%,50%)` : '#888';
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
    chip.appendChild(rm);
    container.appendChild(chip);
  }
}

function _filterAutoName(f) {
  const parts = [];
  if      (f.brightness > 1.3)        parts.push('偏亮');
  else if (f.brightness < 0.7)        parts.push('偏暗');
  if      (f.contrast > 1.4)          parts.push('高對比');
  if      (f.saturate > 1.6)          parts.push('高飽和');
  else if (f.saturate < 0.6)          parts.push('褪色');
  const h = f.hueRotate;
  if      (h >= 20  && h <= 80)       parts.push('暖色調');
  else if (h >= 160 && h <= 260)      parts.push('冷色調');
  if (f.sepia > 30)                   parts.push('復古');
  if (f.sharpness > 3)                parts.push('銳化');
  else if (f.sharpness < -3)          parts.push('柔焦');
  return parts.length ? parts.join('・') : '原色';
}

function _isFilterDefault(f) {
  return f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.hueRotate === 0 &&
         !f.sepia && !f.sharpness;
}
function _isSelectiveDefault(s) {
  if (Array.isArray(s)) {
    return s.length === 0 || s.every(_isSelectiveDefault);
  }
  return s.targetHue === null
    && s.hueShift   === 0
    && s.brightness === 0
    && s.contrast   === 0
    && s.saturate   === 0
    && s.sepia      === 0;
}
function _isTxDefault(t) {
  return t.scaleX === 1 && t.scaleY === 1 && t.translateX === 0 && t.translateY === 0 &&
         t.rotate === 0 && !t.flipH && !t.flipV;
}

export function vcSaveFilterPreset(force = false) {
  vcDismissToast();
  if (_isFilterDefault(_VCS.filter)) {
    _showToast('<span>目前為預設色調，無需儲存。</span>');
    return;
  }
  if (!force) {
    const normList = (arr) =>
      (Array.isArray(arr) ? arr : (arr ? [arr] : []))
        .map(({id: _, ...rest}) => rest);
    const curSelStr = JSON.stringify(normList(_VCS.selectiveList));
    const dup = _loadFilterPresets().find(p => {
      if (p.deleted) return false;
      const fMatch =
        p.filter?.brightness === _VCS.filter.brightness &&
        p.filter?.contrast   === _VCS.filter.contrast   &&
        p.filter?.saturate   === _VCS.filter.saturate   &&
        p.filter?.hueRotate  === _VCS.filter.hueRotate  &&
        (p.filter?.sepia     ?? 0) === (_VCS.filter.sepia     ?? 0) &&
        (p.filter?.sharpness ?? 0) === (_VCS.filter.sharpness ?? 0);
      if (!fMatch) return false;
      return JSON.stringify(normList(p.selective)) === curSelStr;
    });
    if (dup) {
      _showToast(
        `<span>此色調與「${dup.name}」相同。</span>` +
        `<button onclick="vcSaveFilterPreset(true)">另存新</button>` +
        `<button onclick="vcDismissToast()">取消</button>`);
      return;
    }
  }
  const suggested = _filterAutoName(_VCS.filter);
  const name = prompt('濾鏡名稱：', suggested);
  if (name === null) return;
  const presets = _loadFilterPresets();
  const id = _uid();
  presets.push({
    id, name: name.trim() || suggested,
    filter: { ..._VCS.filter },
    selective: _VCS.selectiveList.map(s => ({ ...s })),
    createdAt:  new Date().toISOString(),
    modifiedAt: Date.now(),
  });
  _saveFilterPresets(presets);
  _VCS._activeFilterPresetId = id;
  // 自動連結到當前影片
  if (_VCS._itemId) {
    const vfl = _loadVideoFilterData(_VCS._itemId);
    if (!vfl.presetIds) vfl.presetIds = [];
    if (!vfl.presetIds.includes(id)) vfl.presetIds.push(id);
    vfl.lastUsed = id;
    _saveVideoFilterData(_VCS._itemId, vfl);
  }
  vcRenderFilterPresets();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcApplyFilterPreset(id) {
  const preset = _loadFilterPresets().find(p => p.id === id);
  if (!preset) return;
  _VCS.filter               = { sepia: 0, sharpness: 0, ...preset.filter };
  if (Array.isArray(preset.selective)) {
    _VCS.selectiveList = preset.selective.map(s => ({ ..._selDefault(s.id), ...s }));
  } else if (preset.selective && preset.selective.targetHue != null) {
    _VCS.selectiveList = [{ ..._selDefault(), ...preset.selective }];
  } else {
    _VCS.selectiveList = [];
  }
  _VCS._activeSelectiveId = _VCS.selectiveList[0]?.id ?? null;
  _VCS._activeFilterPresetId = id;
  // 記錄此素材最後套用的濾鏡，並加入 presetIds（供 header 篩選計數）
  if (_VCS._itemId) {
    const vfl = _loadVideoFilterData(_VCS._itemId);
    vfl.lastUsed = id;
    if (!vfl.presetIds) vfl.presetIds = [];
    if (!vfl.presetIds.includes(id)) vfl.presetIds.push(id);
    _saveVideoFilterData(_VCS._itemId, vfl);
    if (window.buildPresetChips) window.buildPresetChips();
  }
  vcApplyFilter(_VCS._vid);
  vcSyncPanel();
  vcRenderFilterPresets();
  vcDismissToast();
}

export function vcToggleVideoFilterPreset(presetId) {
  if (!_VCS._itemId) return;
  const vfl = _loadVideoFilterData(_VCS._itemId);
  const idx = (vfl.presetIds || []).indexOf(presetId);
  if (idx >= 0) {
    vfl.presetIds.splice(idx, 1);
    if (vfl.lastUsed === presetId) vfl.lastUsed = vfl.presetIds[0] || null;
  } else {
    if (!vfl.presetIds) vfl.presetIds = [];
    vfl.presetIds.push(presetId);
    vfl.lastUsed = presetId;
    _VCS._activeFilterPresetId = presetId;
  }
  _saveVideoFilterData(_VCS._itemId, vfl);
  vcRenderFilterPresets();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcDeleteFilterPreset(id) {
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  if (!confirm(`刪除濾鏡「${preset.name}」？`)) return;
  preset.deleted    = true;
  preset.modifiedAt = Date.now();
  _saveFilterPresets(presets);
  if (_VCS._activeFilterPresetId === id) _VCS._activeFilterPresetId = null;
  vcRenderFilterPresets();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcRenameFilterPreset(id) {
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  const name = prompt('重新命名：', preset.name);
  if (name === null) return;
  preset.name       = name.trim() || preset.name;
  preset.modifiedAt = Date.now();
  _saveFilterPresets(presets);
  vcRenderFilterPresets();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcRenderFilterPresets() {
  const el = document.getElementById('vc-filter-presets');
  if (!el) return;
  const presets  = _loadFilterPresets().filter(p => !p.deleted);
  const activeId = _VCS._activeFilterPresetId;

  if (!presets.length) {
    el.innerHTML = '<div class="vc-preset-empty">尚無濾鏡，調整色調後點下方按鈕儲存</div>';
    return;
  }

  const hasItem = !!_VCS._itemId;
  const vfl     = hasItem ? _loadVideoFilterData(_VCS._itemId) : { presetIds: [] };
  const vidSet  = new Set(vfl.presetIds || []);

  function _row(p, linked) {
    const isActive = p.id === activeId;
    const bmCls = `vc-preset-bm${linked ? ' on' : ''}`;
    const _mediaWord = _VCS._mediaType === 'image' ? '此圖片' : '此影片';
    const bmTip = linked ? `從${_mediaWord}移除` : `套用至${_mediaWord}`;
    return `<div class="vc-preset-row${isActive ? ' active' : ''}">` +
      (hasItem
        ? `<button class="${bmCls}" onclick="vcToggleVideoFilterPreset('${p.id}')" title="${bmTip}">🔖</button>`
        : '') +
      `<button class="vc-preset-name" onclick="vcApplyFilterPreset('${p.id}')">${p.name}</button>` +
      `<button class="vc-preset-edit" onclick="vcRenameFilterPreset('${p.id}')" title="重新命名">✏️</button>` +
      `<button class="vc-preset-del"  onclick="vcDeleteFilterPreset('${p.id}')"  title="刪除">🗑</button>` +
    `</div>`;
  }

  if (!hasItem) {
    el.innerHTML = presets.map(p => _row(p, false)).join('');
    return;
  }

  const videoPresets = presets.filter(p => vidSet.has(p.id));
  const otherPresets = presets.filter(p => !vidSet.has(p.id));

  let html = '';
  if (videoPresets.length) {
    html += `<div class="vc-preset-group">此影片已存</div>`;
    html += videoPresets.map(p => _row(p, true)).join('');
  }
  if (otherPresets.length) {
    html += `<div class="vc-preset-group${videoPresets.length ? ' sep' : ''}">所有濾鏡</div>`;
    html += otherPresets.map(p => _row(p, false)).join('');
  }
  el.innerHTML = html || '<div class="vc-preset-empty">尚無濾鏡，調整色調後點下方按鈕儲存</div>';
}

/* ══════════════════════════════════════════════════════════════════
   Transform Snapshot（per-video 幾何快照）
══════════════════════════════════════════════════════════════════ */
function _loadTransformSnapshot(itemId) {
  let snap;
  if (_CACHE.loaded) {
    snap = _CACHE.transformSnapshots[itemId] || null;
  } else {
    try {
      const raw = localStorage.getItem(_txKey(itemId));
      snap = raw ? JSON.parse(raw) : null;
    } catch { snap = null; }
  }
  // 軟刪除的快照視為不存在
  if (!snap || snap.deleted) return null;
  return snap;
}
function _saveTransformSnapshot(itemId, snap) {
  snap.savedAt = Date.now();
  snap.deleted = false;
  _CACHE.transformSnapshots[itemId] = snap;
  localStorage.setItem(_txKey(itemId), JSON.stringify(snap));
  _syncSave();
  document.dispatchEvent(new CustomEvent('vc-snap-changed', { detail: { itemId } }));
}
function _deleteTransformSnapshot(itemId) {
  // 軟刪除：保留紀錄讓伺服器 LWW merge 正確同步刪除狀態
  const snap = { deleted: true, savedAt: Date.now() };
  _CACHE.transformSnapshots[itemId] = snap;
  localStorage.setItem(_txKey(itemId), JSON.stringify(snap));
  _syncSave();
  document.dispatchEvent(new CustomEvent('vc-snap-changed', { detail: { itemId } }));
}

export function vcSaveTransformSnapshot() {
  if (!_VCS._itemId) return;
  // 裁切框模式下，等同「套用裁切」——計算裁切值後存快照
  if (_cropState) { vcApplyCrop(); return; }
  _saveTransformSnapshot(_VCS._itemId, { tx: { ..._VCS.tx } });
  vcRenderTransformActions();
  _showToast('<span>已儲存此影片的幾何設定</span>');
}

export function vcResetTransformSnapshot() {
  if (!_VCS._itemId) return;
  _deleteTransformSnapshot(_VCS._itemId);
  _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
               rotate: 0, flipH: false, flipV: false };
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
  vcRenderTransformActions();
  _showToast('<span>已清除此影片的幾何快照</span>');
}

export function vcRenderTransformActions() {
  const el = document.getElementById('vc-transform-actions');
  if (!el) return;
  const hasSnap = _VCS._itemId ? !!_loadTransformSnapshot(_VCS._itemId) : false;
  const nonDefault = !_isTxDefault(_VCS.tx);
  el.innerHTML =
    `<div class="vc-snapshot-row">` +
      `<div class="vc-snapshot-dot${hasSnap ? ' on' : ''}" title="已儲存快照"></div>` +
      `<button class="vc-snapshot-save" onclick="vcSaveTransformSnapshot()">` +
        `${hasSnap ? '更新快照' : '儲存幾何設定'}</button>` +
      (hasSnap
        ? `<button class="vc-snapshot-reset" onclick="vcResetTransformSnapshot()" title="清除快照">🗑</button>`
        : '') +
    `</div>`;
}

/* ══════════════════════════════════════════════════════════════════
   Smart Crop（智慧裁切黑邊）
══════════════════════════════════════════════════════════════════ */
export function vcSmartCrop() {
  const vid = _VCS._vid;
  if (!vid || !(vid.naturalWidth || vid.videoWidth) || !(vid.naturalHeight || vid.videoHeight)) {
    _showToast('<span>請等媒體載入完成後再試</span>');
    return;
  }

  const W = vid.videoWidth || vid.naturalWidth, H = vid.videoHeight || vid.naturalHeight;
  const tx = _VCS.tx;
  const rotNorm = ((tx.rotate % 360) + 360) % 360;
  const isSwapped = (rotNorm === 90 || rotNorm === 270);

  // 在視覺座標系繪製（含旋轉/翻轉），偵測結果對應使用者所見的視覺方向
  const cW = isSwapped ? H : W, cH = isSwapped ? W : H;
  const canvas = document.createElement('canvas');
  canvas.width = cW; canvas.height = cH;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(cW / 2, cH / 2);
  if (tx.flipH) ctx.scale(-1, 1);
  if (tx.flipV) ctx.scale(1, -1);
  ctx.rotate(tx.rotate * Math.PI / 180);
  try { ctx.drawImage(vid, -W / 2, -H / 2, W, H); }
  catch {
    ctx.restore();
    _showToast('<span>無法取得影片畫面，請確認影片已開始播放</span>');
    return;
  }
  ctx.restore();

  const THRESH = 12, STEP = 4;

  // 掃描範圍（視覺畫布像素）
  let scanLeft, scanTop, scanRight, scanBottom;
  if (_cropState) {
    // 裁切框模式：從當前 handles 螢幕座標換算到視覺畫布像素
    const { vr, x1, y1, x2, y2 } = _cropState;
    scanLeft   = Math.max(0, Math.round((x1 - vr.x)        / vr.scale));
    scanTop    = Math.max(0, Math.round((y1 - vr.y)        / vr.scale));
    scanRight  = Math.max(0, Math.round((vr.x + vr.w - x2) / vr.scale));
    scanBottom = Math.max(0, Math.round((vr.y + vr.h - y2) / vr.scale));
  } else {
    // 從現有 native crop 換算到視覺掃描範圍
    const ec = _getCropFromTransform(tx, W, H);
    const vs = _nativeToVisualScan(ec, rotNorm, tx.flipH, tx.flipV);
    scanLeft = vs.left; scanTop = vs.top; scanRight = vs.right; scanBottom = vs.bottom;
  }

  const bx1 = scanLeft, by1 = scanTop, bx2 = cW - scanRight, by2 = cH - scanBottom;
  const bw = bx2 - bx1, bh = by2 - by1;
  if (bw < 10 || bh < 10) { _showToast('<span>偵測不到明顯黑邊</span>'); return; }

  function rowIsBlack(y) {
    const d = ctx.getImageData(bx1, y, bw, 1).data;
    for (let x = 0; x < bw; x += STEP) {
      const i = x * 4;
      if (d[i] > THRESH || d[i+1] > THRESH || d[i+2] > THRESH) return false;
    }
    return true;
  }
  function colIsBlack(x) {
    const d = ctx.getImageData(x, by1, 1, bh).data;
    for (let y = 0; y < bh; y += STEP) {
      const i = y * 4;
      if (d[i] > THRESH || d[i+1] > THRESH || d[i+2] > THRESH) return false;
    }
    return true;
  }

  let addT = 0, addB = 0, addL = 0, addR = 0;
  while (addT < bh / 2 && rowIsBlack(by1 + addT))     addT++;
  while (addB < bh / 2 && rowIsBlack(by2 - 1 - addB)) addB++;
  while (addL < bw / 2 && colIsBlack(bx1 + addL))     addL++;
  while (addR < bw / 2 && colIsBlack(bx2 - 1 - addR)) addR++;

  if (addT + addB + addL + addR === 0) {
    _showToast('<span>偵測不到明顯黑邊</span>');
    return;
  }
  if (addT + addB > bh * 0.45 || addL + addR > bw * 0.45) {
    _showToast('<span>黑邊比例異常，可能是純黑畫面，請確認播放位置後再試</span>');
    return;
  }

  // 視覺座標系最終裁切值（直接傳給 _vcStartCropMode / _vcUpdateCropHandles）
  const top = scanTop + addT, bottom = scanBottom + addB;
  const left = scanLeft + addL, right = scanRight + addR;

  if (_cropState) {
    // 已在裁切模式：不重啟，只更新 handles（不覆蓋 _savedTxForCrop）
    _vcUpdateCropHandles({ top, bottom, left, right });
  } else {
    // initCrop 值為視覺像素，_vcStartCropMode 使用 _getVideoVisualRect 定位 handles
    _vcStartCropMode({ top, bottom, left, right });
  }
}

/* ══════════════════════════════════════════════════════════════════
   Manual Crop Overlay（拖曳裁切框）
══════════════════════════════════════════════════════════════════ */
let _cropState     = null;  // { vr, x1, y1, x2, y2 }
let _savedTxForCrop = null;

function _getVideoContentRect(vid) {
  const container = vid.parentElement;
  if (!container) return null;
  const cr  = container.getBoundingClientRect();
  const vw  = vid.videoWidth || vid.naturalWidth || 0;
  const vh  = vid.videoHeight || vid.naturalHeight || 0;
  const scl = Math.min(cr.width / vw, cr.height / vh);
  const rw  = vw * scl, rh = vh * scl;
  return {
    x: cr.left + (cr.width  - rw) / 2,
    y: cr.top  + (cr.height - rh) / 2,
    w: rw, h: rh, scale: scl, vw, vh,
  };
}

// 含旋轉 fit 補正的視覺 rect（裁切 overlay、handles 均使用此座標系）
function _getVideoVisualRect(vid) {
  const container = vid.parentElement;
  if (!container) return null;
  const cr = container.getBoundingClientRect();
  const vw = vid.videoWidth || vid.naturalWidth || 0;
  const vh = vid.videoHeight || vid.naturalHeight || 0;
  const rotNorm = ((_VCS.tx.rotate % 360) + 360) % 360;
  const isSwapped = (rotNorm === 90 || rotNorm === 270);
  const ofit = Math.min(cr.width / vw, cr.height / vh);
  let scale, contentW, contentH, visVW, visVH;
  if (isSwapped) {
    const extraFit = Math.min(cr.width / (vh * ofit), cr.height / (vw * ofit));
    scale = ofit * extraFit;
    contentW = vh * scale; contentH = vw * scale;
    visVW = vh; visVH = vw;
  } else {
    scale = ofit;
    contentW = vw * scale; contentH = vh * scale;
    visVW = vw; visVH = vh;
  }
  return {
    x: cr.left + (cr.width  - contentW) / 2,
    y: cr.top  + (cr.height - contentH) / 2,
    w: contentW, h: contentH, scale, vw: visVW, vh: visVH,
  };
}

// native crop → visual scan bounds（傳給 initCrop / _vcStartCropMode 定位用）
function _nativeToVisualScan(ec, rotNorm, flipH, flipV) {
  let sL, sT, sR, sB;
  const { top: t, bottom: b, left: l, right: r } = ec;
  switch (rotNorm) {
    case 90:  sL=b; sT=l; sR=t; sB=r; break;
    case 180: sL=r; sT=b; sR=l; sB=t; break;
    case 270: sL=t; sT=r; sR=b; sB=l; break;
    default:  sL=l; sT=t; sR=r; sB=b;
  }
  if (flipH) { const tmp=sL; sL=sR; sR=tmp; }
  if (flipV) { const tmp=sT; sT=sB; sB=tmp; }
  return { top: sT, bottom: sB, left: sL, right: sR };
}

// visual crop（視覺像素）→ native crop（原始像素，用於 CSS transform 計算）
function _visualToNativeCrop(vis, rotNorm, flipH, flipV) {
  let t = vis.top, b = vis.bottom, l = vis.left, r = vis.right;
  if (flipH) { const tmp=l; l=r; r=tmp; }
  if (flipV) { const tmp=t; t=b; b=tmp; }
  switch (rotNorm) {
    case 90:  return { top: r, bottom: l, left: t, right: b };
    case 180: return { top: b, bottom: t, left: r, right: l };
    case 270: return { top: l, bottom: r, left: b, right: t };
    default:  return { top: t, bottom: b, left: l, right: r };
  }
}

/* 從現有 transform 反推裁切像素值（vcApplyCrop 的逆運算）
   只在 scaleX ≈ scaleY 時有效（來自 crop 操作），否則回傳全零 */
function _getCropFromTransform(tx, W, H) {
  // 優先使用 vcApplyCrop 儲存的精確值（scale=max(H/effH,W/effW) 的逆運算有損）
  if (tx._cropTop !== undefined) {
    return {
      top:    tx._cropTop,    bottom: tx._cropBottom,
      left:   tx._cropLeft,   right:  tx._cropRight,
    };
  }

  // 舊快照 fallback：數學估算（僅在 H 驅動 scale 時精確；W 驅動時上下邊可能偏差）
  const sx = tx.scaleX, sy = tx.scaleY;
  if (sx <= 1 && sy <= 1) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (Math.abs(sx - sy) > 0.01) return { top: 0, bottom: 0, left: 0, right: 0 };

  const scale = (sx + sy) / 2;
  const tmb   = -tx.translateY * 2 / scale;
  const lmr   = -tx.translateX * 2 / scale;
  // 嘗試用 H 和 W 兩軸分別估算，取各軸的 effX 不超過原始尺寸的合理值
  const tpb_h = H * (1 - 1 / scale);
  const lpr_w = W * (1 - 1 / scale);
  // 若 H 驅動：top+bottom = tpb_h；若 W 驅動：left+right = lpr_w
  // 無法確定哪軸驅動時，兩者都用（可能有一邊不精確）
  return {
    top:    Math.max(0, Math.round((tpb_h + tmb) / 2)),
    bottom: Math.max(0, Math.round((tpb_h - tmb) / 2)),
    left:   Math.max(0, Math.round((lpr_w + lmr) / 2)),
    right:  Math.max(0, Math.round((lpr_w - lmr) / 2)),
  };
}

export function vcToggleCropMode() {
  if (_cropState) {
    vcCancelCrop();
  } else {
    const vid = _VCS._vid;
    if (vid && (vid.videoWidth || vid.naturalWidth)) {
      const nw = vid.videoWidth || vid.naturalWidth;
      const nh = vid.videoHeight || vid.naturalHeight;
      const nc = _getCropFromTransform(_VCS.tx, nw, nh);
      if (nc.top + nc.bottom + nc.left + nc.right > 0) {
        const rotNorm = ((_VCS.tx.rotate % 360) + 360) % 360;
        const vc = _nativeToVisualScan(nc, rotNorm, _VCS.tx.flipH, _VCS.tx.flipV);
        _vcStartCropMode(vc);
      } else {
        _vcStartCropMode(null);
      }
    } else {
      _vcStartCropMode(null);
    }
  }
}

// initCrop: { top, bottom, left, right } 影片自然像素，null 表示全畫面
function _vcStartCropMode(initCrop = null) {
  const vid = _VCS._vid;
  if (!vid || !(vid.naturalWidth || vid.videoWidth) || !(vid.naturalHeight || vid.videoHeight)) {
    _showToast('<span>請等媒體載入完成後再試</span>');
    return;
  }

  // 暫存並重置 transform；僅重置裁切縮放/位移，保留旋轉與翻轉
  _savedTxForCrop = { ..._VCS.tx };
  const { rotate = 0, flipH = false, flipV = false } = _VCS.tx;
  _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, rotate, flipH, flipV };
  vcApplyTransform(vid);

  // 手機版：關閉控制面板騰出空間
  if (window.innerWidth <= 768) closeVcPanel();

  const vr = _getVideoVisualRect(vid);   // 含旋轉 fit 補正的視覺 rect
  if (!vr) return;

  // 若傳入偵測結果，把手預先定位到偵測邊界；否則全畫面
  let x1 = vr.x, y1 = vr.y, x2 = vr.x + vr.w, y2 = vr.y + vr.h;
  if (initCrop) {
    x1 = Math.max(vr.x,        vr.x + initCrop.left   * vr.scale);
    y1 = Math.max(vr.y,        vr.y + initCrop.top    * vr.scale);
    x2 = Math.min(vr.x + vr.w, vr.x + vr.w - initCrop.right  * vr.scale);
    y2 = Math.min(vr.y + vr.h, vr.y + vr.h - initCrop.bottom * vr.scale);
  }

  _cropState = { vr, x1, y1, x2, y2 };
  _buildCropOverlay();

  const btn = document.getElementById('vc-crop-toggle');
  if (btn) btn.textContent = '↩ 取消裁切模式';
}

export function vcCancelCrop() {
  if (!_cropState) return;
  _removeCropOverlay();
  if (_savedTxForCrop) {
    _VCS.tx = _savedTxForCrop;
    vcApplyTransform(_VCS._vid);
    _savedTxForCrop = null;
  }
  _cropState = null;
  if (window.innerWidth <= 768) toggleVcPanel();
  const btn = document.getElementById('vc-crop-toggle');
  if (btn) btn.textContent = '✂ 開始手動裁切';
}

export function vcApplyCrop() {
  if (!_cropState) return;
  const { vr, x1, y1, x2, y2 } = _cropState;

  // 從螢幕座標換算到視覺像素（vr 已是 _getVideoVisualRect，含旋轉補正）
  const visTop    = Math.max(0, Math.round((y1 - vr.y)        / vr.scale));
  const visBottom = Math.max(0, Math.round((vr.y + vr.h - y2) / vr.scale));
  const visLeft   = Math.max(0, Math.round((x1 - vr.x)        / vr.scale));
  const visRight  = Math.max(0, Math.round((vr.x + vr.w - x2) / vr.scale));

  const { rotate = 0, flipH = false, flipV = false } = _VCS.tx;
  const rotNorm = ((rotate % 360) + 360) % 360;

  // 視覺像素 → native 像素（CSS transform 在 native 空間計算）
  const nc = _visualToNativeCrop(
    { top: visTop, bottom: visBottom, left: visLeft, right: visRight },
    rotNorm, flipH, flipV
  );

  const vid = _VCS._vid;
  const NW = vid.videoWidth || vid.naturalWidth || 0;
  const NH = vid.videoHeight || vid.naturalHeight || 0;
  const effH = NH - nc.top - nc.bottom, effW = NW - nc.left - nc.right;
  if (effH < 10 || effW < 10) { _showToast('<span>裁切範圍太小，請重新拖曳</span>'); return; }

  const scale = Math.max(NH / effH, NW / effW);
  _VCS.tx = {
    scaleX:     parseFloat(scale.toFixed(4)),
    scaleY:     parseFloat(scale.toFixed(4)),
    translateX: parseFloat(((-(nc.left - nc.right)   / 2) * scale).toFixed(1)),
    translateY: parseFloat(((-(nc.top  - nc.bottom) / 2) * scale).toFixed(1)),
    rotate, flipH, flipV,
    _cropTop: nc.top, _cropBottom: nc.bottom, _cropLeft: nc.left, _cropRight: nc.right,
  };

  // 先清裁切框（_cropState=null），再呼叫 vcApplyTransform，避免觸發 _vcRefreshCropOverlay
  _removeCropOverlay();
  _savedTxForCrop = null;
  _cropState      = null;

  vcApplyTransform(vid);
  vcSyncPanel();
  if (_VCS._itemId) {
    _saveTransformSnapshot(_VCS._itemId, { tx: { ..._VCS.tx } });
    vcRenderTransformActions();
  }

  if (window.innerWidth <= 768) toggleVcPanel();
  _showToast(`<span>已裁切（上${nc.top} 下${nc.bottom} 左${nc.left} 右${nc.right}px）並儲存</span>`);

  const btn = document.getElementById('vc-crop-toggle');
  if (btn) btn.textContent = '✂ 開始手動裁切';
}

function _buildCropOverlay() {
  if (document.getElementById('vc-crop-overlay')) return;
  const el = document.createElement('div');
  el.id = 'vc-crop-overlay';
  el.innerHTML =
    '<div id="vc-cs-t" class="vc-cs"></div>' +
    '<div id="vc-cs-b" class="vc-cs"></div>' +
    '<div id="vc-cs-l" class="vc-cs"></div>' +
    '<div id="vc-cs-r" class="vc-cs"></div>' +
    '<div id="vc-crop-rect">' +
      '<div class="vc-ch" data-dir="nw"></div>' +
      '<div class="vc-ch" data-dir="n"></div>'  +
      '<div class="vc-ch" data-dir="ne"></div>' +
      '<div class="vc-ch" data-dir="w"></div>'  +
      '<div class="vc-ch" data-dir="e"></div>'  +
      '<div class="vc-ch" data-dir="sw"></div>' +
      '<div class="vc-ch" data-dir="s"></div>'  +
      '<div class="vc-ch" data-dir="se"></div>' +
    '</div>' +
    '<div id="vc-crop-toolbar">' +
      '<button class="vc-ctb vc-ctb-cancel" onclick="vcCancelCrop()">取消</button>' +
      '<button class="vc-ctb vc-ctb-apply"  onclick="vcApplyCrop()">套用裁切</button>' +
    '</div>';
  document.body.appendChild(el);
  _updateCropUI();
  _initCropDrag(el);
}

function _updateCropUI() {
  if (!_cropState) return;
  const { vr, x1, y1, x2, y2 } = _cropState;
  const gs = id => document.getElementById(id)?.style;

  const st = gs('vc-cs-t');
  if (st) { st.left = vr.x+'px'; st.top = vr.y+'px'; st.width = vr.w+'px'; st.height = (y1-vr.y)+'px'; }
  const sb = gs('vc-cs-b');
  if (sb) { sb.left = vr.x+'px'; sb.top = y2+'px'; sb.width = vr.w+'px'; sb.height = (vr.y+vr.h-y2)+'px'; }
  const sl = gs('vc-cs-l');
  if (sl) { sl.left = vr.x+'px'; sl.top = y1+'px'; sl.width = (x1-vr.x)+'px'; sl.height = (y2-y1)+'px'; }
  const sr = gs('vc-cs-r');
  if (sr) { sr.left = x2+'px'; sr.top = y1+'px'; sr.width = (vr.x+vr.w-x2)+'px'; sr.height = (y2-y1)+'px'; }

  const cr = document.getElementById('vc-crop-rect');
  if (cr) { cr.style.cssText = `left:${x1}px;top:${y1}px;width:${x2-x1}px;height:${y2-y1}px`; }
}

// 在裁切模式中直接更新框位置（不重啟模式、不碰 _savedTxForCrop）
function _vcUpdateCropHandles(crop) {
  if (!_cropState) return;
  const vr = _cropState.vr;
  _cropState.x1 = Math.max(vr.x,        vr.x + crop.left   * vr.scale);
  _cropState.y1 = Math.max(vr.y,        vr.y + crop.top    * vr.scale);
  _cropState.x2 = Math.min(vr.x + vr.w, vr.x + vr.w - crop.right  * vr.scale);
  _cropState.y2 = Math.min(vr.y + vr.h, vr.y + vr.h - crop.bottom * vr.scale);
  _updateCropUI();
}

// 翻轉/旋轉等調整後，按比例重新定位框手把（vr 可能因旋轉 fit 因子或視窗縮放而改變）
function _vcRefreshCropOverlay() {
  if (!_cropState) return;
  const vid = _VCS._vid;
  const newVr = _getVideoVisualRect(vid);
  if (!newVr) return;
  const old = _cropState;
  const fracL = (old.x1 - old.vr.x) / old.vr.w;
  const fracT = (old.y1 - old.vr.y) / old.vr.h;
  const fracR = (old.x2 - old.vr.x) / old.vr.w;
  const fracB = (old.y2 - old.vr.y) / old.vr.h;
  _cropState = {
    vr: newVr,
    x1: Math.max(newVr.x,           newVr.x + fracL * newVr.w),
    y1: Math.max(newVr.y,           newVr.y + fracT * newVr.h),
    x2: Math.min(newVr.x + newVr.w, newVr.x + fracR * newVr.w),
    y2: Math.min(newVr.y + newVr.h, newVr.y + fracB * newVr.h),
  };
  _updateCropUI();
}

function _initCropDrag(overlay) {
  let dir = null, sx, sy, snap;

  function onMove(e) {
    if (!dir || !_cropState) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const { vr } = _cropState;
    const MIN = 40;
    let { x1, y1, x2, y2 } = snap;
    if (dir.includes('n')) y1 = Math.max(vr.y,        Math.min(y2 - MIN, snap.y1 + dy));
    if (dir.includes('s')) y2 = Math.min(vr.y + vr.h, Math.max(y1 + MIN, snap.y2 + dy));
    if (dir.includes('w')) x1 = Math.max(vr.x,        Math.min(x2 - MIN, snap.x1 + dx));
    if (dir.includes('e')) x2 = Math.min(vr.x + vr.w, Math.max(x1 + MIN, snap.x2 + dx));
    _cropState = { ..._cropState, x1, y1, x2, y2 };
    _updateCropUI();
    if (e.cancelable) e.preventDefault();
  }
  function onUp() { dir = null; }

  overlay.querySelectorAll('.vc-ch').forEach(h => {
    h.addEventListener('pointerdown', e => {
      dir = h.dataset.dir; sx = e.clientX; sy = e.clientY;
      snap = { x1: _cropState.x1, y1: _cropState.y1, x2: _cropState.x2, y2: _cropState.y2 };
      e.stopPropagation(); e.preventDefault();
    });
  });

  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup',   onUp);
  overlay._cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  };
}

function _removeCropOverlay() {
  const el = document.getElementById('vc-crop-overlay');
  if (el) { if (el._cleanup) el._cleanup(); el.remove(); }
}

/* ══════════════════════════════════════════════════════════════════
   Playback Module
══════════════════════════════════════════════════════════════════ */
export function vcSetLoopMode(mode) {
  _VCS.playback.loopMode = mode;
  const vid = _VCS._vid;
  if (vid) vid.loop = (mode === 'single');
  vcSyncPlayback();
}

export function vcSetSpeed(val) {
  const v = Math.max(0.1, Math.min(10, +val));
  _VCS.playback.speed = v;
  const vid = _VCS._vid;
  if (vid) vid.playbackRate = v;
  const sl = document.getElementById('vc-speed');
  const tx = document.getElementById('vc-speed-v');
  if (sl) sl.value = Math.round((Math.log10(v) + 1) * 100);
  if (tx) tx.textContent = v.toFixed(2).replace(/\.?0+$/, '') + '×';
}

export function vcSyncPlayback() {
  const { loopMode } = _VCS.playback;
  document.getElementById('vc-loop-single')  ?.classList.toggle('active', loopMode === 'single');
  document.getElementById('vc-loop-autoplay')?.classList.toggle('active', loopMode === 'autoplay');
}

/* ── Autoplay Next 回呼（由 player-desktop / player-mobile 提供）──── */
let _autoplayNextFn = null;
export function vcRegisterAutoplayNext(fn) { _autoplayNextFn = fn; }
export function vcOnVideoEnded() {
  if (_VCS.playback.loopMode === 'autoplay' && _autoplayNextFn) _autoplayNextFn();
}

/* ══════════════════════════════════════════════════════════════════
   vcInitVid（新影片載入）
══════════════════════════════════════════════════════════════════ */
export function vcInitVid(vid, itemId) {
  _VCS._mediaType      = 'video';
  vcStopEyedropper();
  _releaseCanvas();
  _VCS._imgOriginalSrc = null;
  // 切換影片時靜默清理裁切框（不觸發 panel toggle）
  if (_cropState) {
    _removeCropOverlay();
    _savedTxForCrop = null;
    _cropState      = null;
    const btn = document.getElementById('vc-crop-toggle');
    if (btn) btn.textContent = '✂ 開始手動裁切';
  }

  _migrateOnce();
  _migrateVideoFilterLinks();

  _VCS._vid        = vid;
  _VCS._itemId     = itemId || null;
  _VCS._autoRotate = 0;
  _VCS.ab          = { a: null, b: null, active: false };

  // 重置色彩濾鏡，再嘗試套用此影片已儲存的濾鏡
  _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS._activeFilterPresetId = null;
  if (itemId) {
    const vfl = _loadVideoFilterData(itemId);
    if (vfl.lastUsed) {
      const preset = _loadFilterPresets().find(p => p.id === vfl.lastUsed && !p.deleted);
      if (preset) {
        _VCS.filter               = { sepia: 0, sharpness: 0, ...preset.filter };
        _VCS._activeFilterPresetId = preset.id;
      }
    }
  }

  // 載入此影片的幾何快照
  if (itemId) {
    const snap = _loadTransformSnapshot(itemId);
    if (snap?.tx) {
      _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                  rotate: 0, flipH: false, flipV: false, ...snap.tx };
    } else {
      _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                  rotate: 0, flipH: false, flipV: false };
    }
  } else {
    _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                rotate: 0, flipH: false, flipV: false };
  }

  // 套用播放速度與 loop 模式
  vid.loop         = (_VCS.playback.loopMode === 'single');
  vid.playbackRate = _VCS.playback.speed;

  // autoplay next 綁定
  vid.addEventListener('ended', vcOnVideoEnded, { once: false });

  vcApplyFilter(vid);
  vcApplyTransform(vid);
  vcSyncPanel();
  vcRenderFilterPresets();
  vcRenderTransformActions();
}

/* ══════════════════════════════════════════════════════════════════
   vcInitMedia（圖片 / 影片通用入口）
══════════════════════════════════════════════════════════════════ */
export function vcInitMedia(el, itemId, mediaType) {
  _VCS._mediaType = mediaType || 'video';
  vcStopEyedropper();
  _releaseCanvas();
  _VCS._imgOriginalSrc = null;
  if (mediaType === 'image') {
    _migrateOnce();
    _VCS._vid    = el;
    _VCS._itemId = itemId || null;
    _VCS.ab      = { a: null, b: null, active: false };
    _VCS.selectiveList = []; _VCS._activeSelectiveId = null;

    _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
    _VCS._activeFilterPresetId = null;
    if (itemId) {
      const vfl = _loadVideoFilterData(itemId);
      if (vfl.lastUsed) {
        const preset = _loadFilterPresets().find(p => p.id === vfl.lastUsed && !p.deleted);
        if (preset) { _VCS.filter = { ...preset.filter }; _VCS._activeFilterPresetId = preset.id; }
      }
    }

    _VCS.tx = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                rotate: 0, flipH: false, flipV: false };
    if (itemId) {
      const snap = _loadTransformSnapshot(itemId);
      if (snap?.tx) _VCS.tx = { ..._VCS.tx, ...snap.tx };
    }

    vcApplyFilter(el);
    vcApplyTransform(el);
    vcSyncPanel();
    vcRenderFilterPresets();
    vcRenderTransformActions();
  } else {
    vcInitVid(el, itemId);
  }
}

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

/* ══════════════════════════════════════════════════════════════════
   Apply
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

export function vcApplyTransform(vid) {
  if (!vid) return;
  const t  = _VCS.tx;
  let sx = (t.flipH ? -1 : 1) * t.scaleX;
  let sy = (t.flipV ? -1 : 1) * t.scaleY;

  // 合併使用者旋轉 + 瀏覽器旋轉補正
  const totalRotate = t.rotate + _VCS._autoRotate;

  // 恆等式時清空 transform：讓瀏覽器自行套用影片的旋轉 metadata（rotation tag）
  // 若強制設 rotate(0deg)，部分 Android 瀏覽器的硬體解碼器會忽略旋轉 metadata
  if (sx === 1 && sy === 1 && t.translateX === 0 && t.translateY === 0 && totalRotate === 0) {
    vid.style.transform       = '';
    vid.style.transformOrigin = '';
    if (_cropState) _vcRefreshCropOverlay();
    return;
  }

  const rotNorm = ((totalRotate % 360) + 360) % 360;
  if (rotNorm === 90 || rotNorm === 270) {
    const ctr = vid.parentElement;
    const cw  = ctr ? ctr.clientWidth  : 0;
    const ch  = ctr ? ctr.clientHeight : 0;
    const vw  = vid.videoWidth  || vid.naturalWidth  || 0;
    const vh  = vid.videoHeight || vid.naturalHeight || 0;
    // 必須等 metadata 載入（vw/vh > 0）才能算正確的 fit；未就緒則等載入完成再補算
    if (cw > 0 && ch > 0 && vw > 0 && vh > 0) {
      const ofit = Math.min(cw / vw, ch / vh);
      const fit  = Math.min(cw / (vh * ofit), ch / (vw * ofit));
      sx *= fit;
      sy *= fit;
    } else if ((vw === 0 || vh === 0) && vid.tagName === 'VIDEO') {
      vid.addEventListener('loadedmetadata', () => vcApplyTransform(vid), { once: true });
    } else if ((vw === 0 || vh === 0) && vid.tagName === 'IMG') {
      vid.addEventListener('load', () => vcApplyTransform(vid), { once: true });
    }
  }

  vid.style.transform =
    `scaleX(${sx.toFixed(4)}) scaleY(${sy.toFixed(4)}) ` +
    `translateX(${t.translateX}px) translateY(${t.translateY}px) ` +
    `rotate(${totalRotate}deg)`;
  vid.style.transformOrigin = 'center center';

  // 裁切框模式中若有翻轉/旋轉/位移調整，刷新 overlay 手把的視窗座標
  if (_cropState) _vcRefreshCropOverlay();
}

/* ══════════════════════════════════════════════════════════════════
   Setters
══════════════════════════════════════════════════════════════════ */
export function vcSetFilter(key, val) {
  _VCS.filter[key] = +val;
  vcApplyFilter(_VCS._vid);
  vcSyncPanel();
}
export function vcSetTx(key, val) {
  _VCS.tx[key] = +val;
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
}
export function vcFlip(axis) {
  if (axis === 'H') _VCS.tx.flipH = !_VCS.tx.flipH;
  else              _VCS.tx.flipV = !_VCS.tx.flipV;
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
}
export function vcRotateBy(deg) {
  _VCS.tx.rotate = ((_VCS.tx.rotate + deg) % 360 + 360) % 360;
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
}
export function vcSetRotate(deg) {
  _VCS.tx.rotate = ((+deg % 360) + 360) % 360;
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
}

/* ══════════════════════════════════════════════════════════════════
   AB Loop
══════════════════════════════════════════════════════════════════ */
export function vcSetAbPoint(vid, point) {
  if (!vid) return;
  const t = vid.currentTime;
  if (point === 'a') {
    _VCS.ab.a = t;
    if (_VCS.ab.b !== null && _VCS.ab.b <= t + 0.3) _VCS.ab.b = null;
  } else {
    _VCS.ab.b = t;
    if (_VCS.ab.a !== null && _VCS.ab.a >= t - 0.3) _VCS.ab.a = null;
  }
  vcSyncPanel();
}
export function vcToggleAbLoop() {
  if (_VCS.ab.a === null || _VCS.ab.b === null) return;
  _VCS.ab.active = !_VCS.ab.active;
  vcSyncPanel();
}
export function vcClearAb() {
  _VCS.ab = { a: null, b: null, active: false };
  vcSyncPanel();
}
export function vcAbTimeUpdate(vid) {
  if (!_VCS.ab.active || _VCS.ab.a === null || _VCS.ab.b === null) return;
  if (vid.currentTime >= _VCS.ab.b || vid.currentTime < _VCS.ab.a)
    vid.currentTime = _VCS.ab.a;
}

/* ══════════════════════════════════════════════════════════════════
   Reset（各模組獨立 + 全部重置）
══════════════════════════════════════════════════════════════════ */
export function vcResetFilters() {
  _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS.selectiveList = []; _VCS._activeSelectiveId = null;
  _VCS._activeFilterPresetId = null;
  vcStopEyedropper();
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
export function vcResetTransform() {
  _VCS.tx          = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                        rotate: 0, flipH: false, flipV: false };
  _VCS._autoRotate = 0;
  const vid = _VCS._vid;
  if (vid) { vid.style.transform = ''; vid.style.transformOrigin = ''; }
  vcSyncPanel();
}
export function vcResetAll() {
  _VCS.filter      = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
  _VCS.selectiveList = []; _VCS._activeSelectiveId = null;
  _VCS.tx          = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                        rotate: 0, flipH: false, flipV: false };
  _VCS.ab          = { a: null, b: null, active: false };
  _VCS._autoRotate = 0;
  _VCS._activeFilterPresetId = null;
  vcStopEyedropper();
  _restoreOriginalSrc();
  _VCS._imgOriginalSrc = null;
  const vid = _VCS._vid;
  if (vid) { vid.style.filter = ''; vid.style.transform = ''; vid.style.transformOrigin = ''; }
  vcSyncPanel();
  vcRenderFilterPresets();
  vcRenderTransformActions();
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

function _showToast(html) {
  const el = document.getElementById('vc-toast');
  if (!el) return;
  el.innerHTML = html + '<button class="vc-toast-close" onclick="vcDismissToast()" aria-label="關閉">✕</button>';
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => vcDismissToast(), 5000);
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

export function vcInitDragHandle() {
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

  // 多色塊 UI 同步
  vcRenderSelectiveChips();
  const sel      = _getActive();
  const eyedropRow = document.getElementById('vc-sel-eyedropper-row');
  const swatchEl   = document.getElementById('vc-sel-swatch');
  const deltasEl   = document.getElementById('vc-sel-deltas');
  const hasActive  = sel !== null;
  const hasPick    = sel?.targetHue !== null;
  if (eyedropRow) eyedropRow.style.display = hasActive ? '' : 'none';
  if (swatchEl) {
    swatchEl.style.background = hasPick ? `hsl(${sel.targetHue},70%,50%)` : 'transparent';
    swatchEl.title = hasPick ? `色相 ${sel.targetHue}°` : '未取色';
  }
  if (deltasEl) deltasEl.style.display = hasPick ? '' : 'none';
  const _fmtDelta = v => (v > 0 ? '+' : '') + v.toFixed(2);
  const _s = sel ?? { hueShift: 0, range: 30, brightness: 0, contrast: 0, saturate: 0, sepia: 0 };
  _setSlider('vc-sel-hueshift',   _s.hueShift,   (_s.hueShift > 0 ? '+' : '') + _s.hueShift + '°');
  _setSlider('vc-sel-range',      _s.range,      '±' + _s.range + '°');
  _setSlider('vc-sel-brightness', _s.brightness, _fmtDelta(_s.brightness));
  _setSlider('vc-sel-contrast',   _s.contrast,   _fmtDelta(_s.contrast));
  _setSlider('vc-sel-saturate',   _s.saturate,   _fmtDelta(_s.saturate));
  _setSlider('vc-sel-sepia',      _s.sepia,      _s.sepia.toFixed(2));

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
  if (aEl)  aEl.textContent = ab.a !== null ? fmtTime(ab.a) : '–';
  if (bEl)  bEl.textContent = ab.b !== null ? fmtTime(ab.b) : '–';
  if (tog)  { tog.textContent = ab.active ? 'AB 開啟' : 'AB 關閉'; tog.classList.toggle('vc-on', ab.active); }
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

  // 自動切換 tab
  if (isImage  && _currentTab === 'playback') vcSwitchTab('image');
  if (!isImage && _currentTab === 'image')    vcSwitchTab('filters');

  vcSyncPlayback();
  vcRenderTransformActions();
}

// 模組初始化
_migrateMediaFilterKeys();
_migrateVideoFilterLinks();
_syncLoad();
