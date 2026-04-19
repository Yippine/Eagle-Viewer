'use strict';
/* ── video-controls.js  ▸  PotPlayer 風格影片控制模組 ─────────────────
   功能：
     ① AB 循環播放
     ② 濾鏡（brightness / contrast / saturate / hue-rotate）
     ③ 單軸縮放（scaleX / scaleY）
     ④ 位移（translateX / translateY）
     ⑤ 翻轉與旋轉（flipH / flipV / rotate）
   桌面 + 手機通用；由 player-desktop.js / player-mobile.js 整合。
══════════════════════════════════════════════════════════════════════*/

import { fmtTime } from './utils.js';

/* ── 狀態 ─────────────────────────────────────────────────────────── */
const _VCS = {
  filter: { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0 },
  tx:     { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
            rotate: 0, flipH: false, flipV: false },
  ab:          { a: null, b: null, active: false },
  _vid:        null,
  _itemId:     null,
  _activePresetId: null,
};

export function vcGetVid() { return _VCS._vid; }

/* ── Preset System ─────────────────────────────────────────────────── */
const _PRESETS_KEY = 'eagle-presets';

/* ── Server Sync（Union Merge + LWW by modifiedAt）─────────────────── */
const _CACHE = { presets: [], videoPresets: {}, version: 0, loaded: false };
let _debounceTimer = null;

async function _syncLoad() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    if (data.presets?.length || Object.keys(data.videoPresets || {}).length) {
      _CACHE.presets      = data.presets      || [];
      _CACHE.videoPresets = data.videoPresets || {};
      _CACHE.version      = data.version      || 0;
      localStorage.setItem(_PRESETS_KEY, JSON.stringify(_CACHE.presets));
      Object.entries(_CACHE.videoPresets).forEach(([id, vd]) => localStorage.setItem(`eagle-video-${id}`, JSON.stringify(vd)));
    } else {
      const local = JSON.parse(localStorage.getItem(_PRESETS_KEY) || '[]');
      if (local.length) {
        _CACHE.presets  = local;
        _CACHE.version  = data.version || 0;
        _syncSave();
      }
    }
  } catch (e) {
    console.warn('[VCS] server sync unavailable, using localStorage:', e.message);
  }
  _CACHE.loaded = true;
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

async function _syncPoll() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    if ((data.version || 0) > _CACHE.version) {
      _CACHE.presets      = data.presets      || [];
      _CACHE.videoPresets = data.videoPresets || {};
      _CACHE.version      = data.version;
      localStorage.setItem(_PRESETS_KEY, JSON.stringify(_CACHE.presets));
      Object.entries(_CACHE.videoPresets).forEach(([id, vd]) => localStorage.setItem(`eagle-video-${id}`, JSON.stringify(vd)));
      vcRenderPresetPanel();
      if (window.buildPresetChips) window.buildPresetChips();
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
        _CACHE.presets      = merged.presets      || [];
        _CACHE.videoPresets = merged.videoPresets || {};
        _CACHE.version      = merged.version      || _CACHE.version;
        vcRenderPresetPanel();
      }
    } catch (e) {
      console.warn('[VCS] sync save failed:', e.message);
    }
  }, 300);
}

function _loadPresets() {
  if (_CACHE.loaded) return _CACHE.presets;
  try { return JSON.parse(localStorage.getItem(_PRESETS_KEY) || '[]'); }
  catch { return []; }
}
function _savePresets(arr) {
  arr.forEach(p => { if (!p.modifiedAt) p.modifiedAt = Date.now(); });
  _CACHE.presets = arr;
  localStorage.setItem(_PRESETS_KEY, JSON.stringify(arr));
  _syncSave();
}

function _loadVideoData(itemId) {
  if (_CACHE.loaded) return _CACHE.videoPresets[itemId] || { presetIds: [], lastUsed: null };
  try { return JSON.parse(localStorage.getItem(`eagle-video-${itemId}`) || '{"presetIds":[],"lastUsed":null}'); }
  catch { return { presetIds: [], lastUsed: null }; }
}
function _saveVideoData(itemId, data) {
  data.modifiedAt = Date.now();
  _CACHE.videoPresets[itemId] = data;
  localStorage.setItem(`eagle-video-${itemId}`, JSON.stringify(data));
  _syncSave();
}

function _isDefault(f, t) {
  return f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.hueRotate === 0 &&
         t.scaleX === 1 && t.scaleY === 1 && t.translateX === 0 && t.translateY === 0 &&
         t.rotate === 0 && !t.flipH && !t.flipV;
}

function _filterTxEqual(f1, t1, f2, t2) {
  return f1.brightness === f2.brightness && f1.contrast === f2.contrast &&
         f1.saturate   === f2.saturate   && f1.hueRotate === f2.hueRotate &&
         t1.scaleX     === t2.scaleX     && t1.scaleY    === t2.scaleY    &&
         t1.translateX === t2.translateX && t1.translateY === t2.translateY &&
         t1.rotate     === t2.rotate     && t1.flipH      === t2.flipH     &&
         t1.flipV      === t2.flipV;
}

function _findMatchingPreset(f, t) {
  return _loadPresets().find(p => _filterTxEqual(f, t, p.filter, p.tx)) || null;
}

function _autoName(f) {
  const parts = [];
  if      (f.brightness > 1.3)             parts.push('偏亮');
  else if (f.brightness < 0.7)             parts.push('偏暗');
  if      (f.contrast > 1.4)               parts.push('高對比');
  if      (f.saturate > 1.6)               parts.push('高飽和');
  else if (f.saturate < 0.6)               parts.push('褪色');
  const h = f.hueRotate;
  if      (h >= 20  && h <= 80)            parts.push('暖色調');
  else if (h >= 160 && h <= 260)           parts.push('冷色調');
  return parts.length ? parts.join('・') : '原色';
}

function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

_syncLoad();

let _toastTimer = null;
function _showToast(html) {
  const el = document.getElementById('vc-toast');
  if (!el) return;
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 8000);
}

export function vcDismissToast() {
  const el = document.getElementById('vc-toast');
  if (el) el.classList.remove('show');
  clearTimeout(_toastTimer);
}

function _showCarryOverToast(prevPresetId) {
  if (prevPresetId) {
    const name = (_loadPresets().find(p => p.id === prevPresetId)?.name) || '上一部的濾鏡';
    _showToast(
      `<span>套用了「${name}」，要連結到此影片嗎？</span>` +
      `<button onclick="vcLinkPresetToCurrentVideo('${prevPresetId}')">儲存</button>` +
      `<button onclick="vcDismissToast()">略過</button>`
    );
  } else {
    _showToast(
      `<span>套用了上一部影片的濾鏡，要存到此影片嗎？</span>` +
      `<button onclick="vcSaveCurrentAsPreset()">儲存</button>` +
      `<button onclick="vcDismissToast()">略過</button>`
    );
  }
}

function _showDuplicateToast(match) {
  _showToast(
    `<span>此濾鏡與「${match.name}」相同，要連結到此影片嗎？</span>` +
    `<button onclick="vcLinkPresetToCurrentVideo('${match.id}')">連結</button>` +
    `<button onclick="vcSaveCurrentAsPreset(true)">另存新</button>` +
    `<button onclick="vcDismissToast()">取消</button>`
  );
}

export function vcLinkPresetToCurrentVideo(presetId) {
  vcDismissToast();
  if (!_VCS._itemId) return;
  const vdata = _loadVideoData(_VCS._itemId);
  if (!vdata.presetIds) vdata.presetIds = [];
  if (!vdata.presetIds.includes(presetId)) vdata.presetIds.push(presetId);
  vdata.lastUsed       = presetId;
  _VCS._activePresetId = presetId;
  _saveVideoData(_VCS._itemId, vdata);
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

/* ── 新影片載入時呼叫 ────────────────────────────────────────────── */
export function vcInitVid(vid, itemId) {
  const prevItemId        = _VCS._itemId;
  const prevActivePresetId = _VCS._activePresetId;
  const hadNonDefault     = !_isDefault(_VCS.filter, _VCS.tx);

  _VCS._vid            = vid;
  _VCS._itemId         = itemId || null;
  _VCS.ab              = { a: null, b: null, active: false };
  _VCS._activePresetId = null;

  if (itemId) {
    const vdata   = _loadVideoData(itemId);
    const presets = _loadPresets();

    if (vdata.lastUsed) {
      const preset = presets.find(p => p.id === vdata.lastUsed);
      if (preset) {
        _VCS.filter          = { ...preset.filter };
        _VCS.tx              = { ...preset.tx };
        _VCS._activePresetId = preset.id;
      } else {
        const surviving = (vdata.presetIds || []).filter(pid => presets.find(p => p.id === pid));
        vdata.presetIds = surviving;
        vdata.lastUsed  = surviving[0] || null;
        _saveVideoData(itemId, vdata);
        if (!vdata.lastUsed && hadNonDefault && prevItemId && prevItemId !== itemId) {
          _showCarryOverToast(prevActivePresetId || null);
        }
      }
    } else if (hadNonDefault && prevItemId && prevItemId !== itemId) {
      // 前一部影片有濾鏡（named preset 或自由調整）時均提示
      _showCarryOverToast(prevActivePresetId || null);
    }
  }

  vcApplyFilter(vid);
  vcApplyTransform(vid);
  vcSyncPanel();
  vcRenderPresetPanel();
}

/* ── Preset 操作 ─────────────────────────────────────────────────── */
export function vcApplyPreset(id) {
  const presets = _loadPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  _VCS.filter          = { ...preset.filter };
  _VCS.tx              = { ...preset.tx };
  _VCS._activePresetId = id;
  if (_VCS._itemId) {
    const vdata = _loadVideoData(_VCS._itemId);
    vdata.lastUsed = id;
    _saveVideoData(_VCS._itemId, vdata);
  }
  vcApplyFilter(_VCS._vid);
  vcApplyTransform(_VCS._vid);
  vcSyncPanel();
  vcRenderPresetPanel();
  vcDismissToast();
}

export function vcToggleVideoPreset(presetId) {
  if (!_VCS._itemId) return;
  const vdata = _loadVideoData(_VCS._itemId);
  const idx   = (vdata.presetIds || []).indexOf(presetId);
  if (idx >= 0) {
    vdata.presetIds.splice(idx, 1);
    if (vdata.lastUsed === presetId) vdata.lastUsed = vdata.presetIds[0] || null;
  } else {
    if (!vdata.presetIds) vdata.presetIds = [];
    vdata.presetIds.push(presetId);
    vdata.lastUsed = presetId;
    _VCS._activePresetId = presetId;
  }
  _saveVideoData(_VCS._itemId, vdata);
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcSaveCurrentAsPreset(force = false) {
  vcDismissToast();
  if (!force) {
    const match = _findMatchingPreset(_VCS.filter, _VCS.tx);
    if (match) { _showDuplicateToast(match); return; }
  }
  const suggestName = _autoName(_VCS.filter);
  const name        = prompt('濾鏡名稱：', suggestName);
  if (name === null) return;
  const presets = _loadPresets();
  const id      = _uid();
  presets.push({
    id, name: name.trim() || suggestName,
    filter:    { ..._VCS.filter },
    tx:        { ..._VCS.tx },
    createdAt:  new Date().toISOString(),
    modifiedAt: Date.now(),
  });
  _savePresets(presets);
  _VCS._activePresetId = id;
  if (_VCS._itemId) {
    const vdata = _loadVideoData(_VCS._itemId);
    if (!vdata.presetIds) vdata.presetIds = [];
    if (!vdata.presetIds.includes(id)) vdata.presetIds.push(id);
    vdata.lastUsed = id;
    _saveVideoData(_VCS._itemId, vdata);
  }
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcUpdateCurrentPreset() {
  if (!_VCS._activePresetId) return;
  const presets = _loadPresets();
  const idx     = presets.findIndex(p => p.id === _VCS._activePresetId);
  if (idx < 0) return;
  presets[idx].filter      = { ..._VCS.filter };
  presets[idx].tx          = { ..._VCS.tx };
  presets[idx].modifiedAt  = Date.now();
  _savePresets(presets);
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcRenamePresetPrompt(id) {
  const presets = _loadPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  const name = prompt('重新命名：', preset.name);
  if (name === null) return;
  preset.name = name.trim() || preset.name;
  _savePresets(presets);
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcDeletePreset(id) {
  const presets = _loadPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  if (!confirm(`刪除濾鏡「${preset.name}」？`)) return;
  preset.deleted    = true;
  preset.modifiedAt = Date.now();
  _savePresets(presets);
  if (_VCS._activePresetId === id) _VCS._activePresetId = null;
  vcRenderPresetPanel();
  if (window.buildPresetChips) window.buildPresetChips();
}

export function vcRenderPresetPanel() {
  const el = document.getElementById('vc-presets');
  if (!el) return;

  const presets  = _loadPresets().filter(p => !p.deleted);
  const vdata    = _VCS._itemId ? _loadVideoData(_VCS._itemId) : { presetIds: [], lastUsed: null };
  const vidSet   = new Set(vdata.presetIds || []);
  const activeId = _VCS._activePresetId;

  const videoPresets = presets.filter(p => vidSet.has(p.id));
  const otherPresets = presets.filter(p => !vidSet.has(p.id));

  function rowLinked(p) {
    const isActive = p.id === activeId;
    return `<div class="vc-preset-row${isActive ? ' active' : ''}">` +
      `<button class="vc-preset-bm on" onclick="vcToggleVideoPreset('${p.id}')" title="從此影片移除">🔖</button>` +
      `<button class="vc-preset-name" onclick="vcApplyPreset('${p.id}')">${p.name}</button>` +
      `<button class="vc-preset-edit" onclick="vcRenamePresetPrompt('${p.id}')" title="重新命名">✏️</button>` +
      `<button class="vc-preset-del" onclick="vcDeletePreset('${p.id}')" title="刪除濾鏡">🗑</button>` +
    `</div>`;
  }

  function rowOther(p) {
    const isActive = p.id === activeId;
    return `<div class="vc-preset-row${isActive ? ' active' : ''}">` +
      `<button class="vc-preset-name" onclick="vcApplyPreset('${p.id}')">${p.name}</button>` +
      `<button class="vc-preset-edit" onclick="vcRenamePresetPrompt('${p.id}')" title="重新命名">✏️</button>` +
      `<button class="vc-preset-del" onclick="vcDeletePreset('${p.id}')" title="刪除濾鏡">🗑</button>` +
    `</div>`;
  }

  let html = '';
  if (videoPresets.length) {
    html += `<div class="vc-preset-group">此影片已存</div>`;
    html += videoPresets.map(p => rowLinked(p)).join('');
  }
  if (otherPresets.length) {
    html += `<div class="vc-preset-group${videoPresets.length ? ' sep' : ''}">濾鏡庫（其他）</div>`;
    html += otherPresets.map(p => rowOther(p)).join('');
  }
  if (!presets.length) {
    html = `<div class="vc-preset-empty">尚無濾鏡，調整後點「另存為新濾鏡」</div>`;
  }

  const nonDefault = !_isDefault(_VCS.filter, _VCS.tx);
  const activeName = activeId ? (presets.find(p => p.id === activeId)?.name || '') : '';
  const activeIsOther = activeId && !vidSet.has(activeId);
  html += `<div class="vc-preset-actions">` +
    (nonDefault
      ? `<button class="vc-preset-save" onclick="vcSaveCurrentAsPreset()">＋ 另存為新濾鏡</button>`
      : '') +
    (activeId && nonDefault
      ? `<button class="vc-preset-upd" onclick="vcUpdateCurrentPreset()">更新「${activeName}」</button>`
      : '') +
    (activeIsOther
      ? `<button class="vc-preset-upd" onclick="vcToggleVideoPreset('${activeId}')">🔖 加入此影片</button>`
      : '') +
  `</div>`;

  el.innerHTML = html;
}

/* ── Apply ──────────────────────────────────────────────────────── */
export function vcApplyFilter(vid) {
  if (!vid) return;
  const f = _VCS.filter;
  vid.style.filter =
    `brightness(${f.brightness}) contrast(${f.contrast}) ` +
    `saturate(${f.saturate}) hue-rotate(${f.hueRotate}deg)`;
}

export function vcApplyTransform(vid) {
  if (!vid) return;
  const t  = _VCS.tx;
  const sx = (t.flipH ? -1 : 1) * t.scaleX;
  const sy = (t.flipV ? -1 : 1) * t.scaleY;
  vid.style.transform =
    `scaleX(${sx.toFixed(4)}) scaleY(${sy.toFixed(4)}) ` +
    `translateX(${t.translateX}px) translateY(${t.translateY}px) ` +
    `rotate(${t.rotate}deg)`;
  vid.style.transformOrigin = 'center center';
}

/* ── Setters ─────────────────────────────────────────────────────── */
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

/* ── AB Loop ─────────────────────────────────────────────────────── */
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

/** 在 video timeupdate handler 中呼叫 */
export function vcAbTimeUpdate(vid) {
  if (!_VCS.ab.active || _VCS.ab.a === null || _VCS.ab.b === null) return;
  // 超過 B 點 → 跳回 A；拖到 A 點之前 → 也快進到 A
  if (vid.currentTime >= _VCS.ab.b || vid.currentTime < _VCS.ab.a) {
    vid.currentTime = _VCS.ab.a;
  }
}

/* ── Reset All ───────────────────────────────────────────────────── */
export function vcResetAll() {
  _VCS.filter = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0 };
  _VCS.tx     = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                  rotate: 0, flipH: false, flipV: false };
  _VCS.ab     = { a: null, b: null, active: false };
  const vid = _VCS._vid;
  if (vid) { vid.style.filter = ''; vid.style.transform = ''; vid.style.transformOrigin = ''; }
  vcSyncPanel();
}

/* ── Panel Toggle ────────────────────────────────────────────────── */
const _VC_DEFAULT_H = 0.55; // 預設高度比例（55vh）

export function toggleVcPanel() {
  const panel = document.getElementById('vc-panel');
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  if (opening) {
    if (window.innerWidth <= 768) {
      // 每次開啟重置為預設高度
      panel.style.maxHeight = Math.round(window.innerHeight * _VC_DEFAULT_H) + 'px';
    }
    vcRenderPresetPanel();
  }
  panel.classList.toggle('open');
}

export function closeVcPanel() {
  const panel = document.getElementById('vc-panel');
  if (!panel) return;
  panel.classList.remove('open');
}

/* ── 底部面板可拖動調整高度 + Slider 捲動修正 ───────────────────── */
let _vcDragInited = false;

/** 計算觸碰位置對應 slider 的值 */
function _sliderValueAt(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const min  = +(slider.min  || 0);
  const max  = +(slider.max  || 100);
  const step = +(slider.step || 1);
  const raw  = min + pct * (max - min);
  return parseFloat((Math.round(raw / step) * step).toFixed(10));
}

/**
 * Slider 捲動干擾修正：
 * 手機版在 .vc-content 上下捲動時，若手指起點落在 range input 上，
 * 原生行為會讓 slider 跳動。此函式接管觸控邏輯：
 *   - 垂直移動 → 手動捲動 .vc-content，不改 slider 值
 *   - 水平移動 → 更新 slider 值（模擬原生行為）
 */
function _initSliderScrollFix(content) {
  content.querySelectorAll('input[type="range"]').forEach(slider => {
    let startX, startY, scrollStartTop, mode; // mode: null=決定中 | 'v'=捲動 | 'h'=調值

    slider.addEventListener('touchstart', e => {
      if (window.innerWidth > 768) return;
      startX         = e.touches[0].clientX;
      startY         = e.touches[0].clientY;
      scrollStartTop = content.scrollTop;
      mode           = null;
      // 接管全部觸控，防止原生 slider 在決定方向前就跳動
      e.preventDefault();
    }, { passive: false });

    slider.addEventListener('touchmove', e => {
      if (window.innerWidth > 768) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      // 決定方向（移動超過 5px 才判定）
      if (mode === null) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
          e.preventDefault(); return;
        }
        mode = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
      }

      e.preventDefault(); // 始終接管，防止原生 slider 干擾

      if (mode === 'v') {
        // 手動捲動容器
        content.scrollTop = scrollStartTop - dy;
      } else {
        // 手動更新 slider 值並觸發 input 事件
        const val = _sliderValueAt(slider, e.touches[0].clientX);
        if (+slider.value !== val) {
          slider.value = val;
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }, { passive: false });

    slider.addEventListener('touchend', e => {
      if (window.innerWidth > 768) return;
      // 點擊（未移動）或水平拖動結束 → 套用最終值
      if (mode === null || mode === 'h') {
        const val = _sliderValueAt(slider, e.changedTouches[0].clientX);
        slider.value = val;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
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

  // ── Slider 捲動干擾修正 ────────────────────────────────────────
  _initSliderScrollFix(content);

  // ── 把手拖動調整面板高度 ───────────────────────────────────────
  let dragging = false;
  let startY   = 0;
  let startH   = 0;
  const MIN_H  = 140;

  header.addEventListener('touchstart', e => {
    if (window.innerWidth > 768) return;
    dragging = true;
    startY   = e.touches[0].clientY;
    startH   = panel.getBoundingClientRect().height;
    panel.classList.add('dragging');
    e.stopPropagation();
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy   = startY - e.touches[0].clientY; // 上拉為正 → 高度增加
    const newH = Math.max(MIN_H, Math.min(startH + dy, window.innerHeight * 0.92));
    panel.style.maxHeight = newH + 'px';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');

    const h  = panel.getBoundingClientRect().height;
    const vh = window.innerHeight;

    if (h < 100) {
      closeVcPanel();
    } else {
      // 吸附到最近的 40% / 55% / 80% 三個錨點
      const anchors = [0.40, 0.55, 0.80].map(r => r * vh);
      const snap    = anchors.reduce((best, a) =>
        Math.abs(a - h) < Math.abs(best - h) ? a : best, anchors[0]);
      panel.style.maxHeight = Math.round(snap) + 'px';
    }
  }, { passive: true });
}

/* ── Panel Sync ──────────────────────────────────────────────────── */
function _setSlider(id, val, txt) {
  const sl = document.getElementById(id);       if (sl)  sl.value       = val;
  const tv = document.getElementById(id + '-v'); if (tv) tv.textContent = txt;
}

export function vcSyncPanel() {
  const f = _VCS.filter, t = _VCS.tx, ab = _VCS.ab;

  _setSlider('vc-brightness', f.brightness, f.brightness.toFixed(2));
  _setSlider('vc-contrast',   f.contrast,   f.contrast.toFixed(2));
  _setSlider('vc-saturate',   f.saturate,   f.saturate.toFixed(2));
  _setSlider('vc-hue',        f.hueRotate,  f.hueRotate + '°');

  _setSlider('vc-scalex', t.scaleX,     t.scaleX.toFixed(2) + '×');
  _setSlider('vc-scaley', t.scaleY,     t.scaleY.toFixed(2) + '×');
  _setSlider('vc-tx',     t.translateX, t.translateX + 'px');
  _setSlider('vc-ty',     t.translateY, t.translateY + 'px');

  const rv = document.getElementById('vc-rotate-v');
  if (rv) rv.textContent = t.rotate + '°';

  const fh = document.getElementById('vc-flip-h');
  const fv = document.getElementById('vc-flip-v');
  if (fh) fh.classList.toggle('vc-on', t.flipH);
  if (fv) fv.classList.toggle('vc-on', t.flipV);

  /* AB loop */
  const aEl = document.getElementById('vc-a-time');
  const bEl = document.getElementById('vc-b-time');
  const tog = document.getElementById('vc-ab-toggle');
  const btnA = document.getElementById('vc-btn-a');
  const btnB = document.getElementById('vc-btn-b');

  if (aEl)  aEl.textContent = ab.a !== null ? fmtTime(ab.a) : '–';
  if (bEl)  bEl.textContent = ab.b !== null ? fmtTime(ab.b) : '–';
  if (tog) {
    tog.textContent = ab.active ? 'AB 開啟' : 'AB 關閉';
    tog.classList.toggle('vc-on', ab.active);
  }
  if (btnA) btnA.classList.toggle('vc-on', ab.a !== null);
  if (btnB) btnB.classList.toggle('vc-on', ab.b !== null);

  vcRenderPresetPanel();
}
