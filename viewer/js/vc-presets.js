'use strict';
/* ── vc-presets.js  ▸  濾鏡 Preset CRUD + per-video 連結 + AB Preset ─
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { fmtTime } from './utils.js';
import { _VCS, _selDefault, _uid,
         _loadFilterPresets, _saveFilterPresets,
         _loadVideoFilterData, _saveVideoFilterData,
         _isFilterDefault, _isSelectiveDefault } from './vc-state.js';
import { vcApplyFilter } from './vc-filters.js';
import { _showToast, vcDismissToast, vcSyncPanel } from './vc-panel.js';

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

export function vcSaveFilterPreset(force = false) {
  vcDismissToast();
  if (_isFilterDefault(_VCS.filter) && _isSelectiveDefault(_VCS.selectiveList)) {
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
  // 臨時狀態已固化為 preset：清除臨時濾鏡旗標
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  // 自動連結到當前影片
  if (_VCS._itemId) {
    const vfl = _loadVideoFilterData(_VCS._itemId);
    if (!vfl.presetIds) vfl.presetIds = [];
    if (!vfl.presetIds.includes(id)) vfl.presetIds.push(id);
    vfl.lastUsed = id;
    _saveVideoFilterData(_VCS._itemId, vfl);
  }
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
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
  // 僅記錄 lastUsed（下次開啟自動恢復），不寫入 presetIds
  // presetIds 只由 🔖（vcToggleVideoFilterPreset）管理
  if (_VCS._itemId) {
    const vfl = _loadVideoFilterData(_VCS._itemId);
    vfl.lastUsed = id;
    _saveVideoFilterData(_VCS._itemId, vfl);
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
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
}

export function vcDeleteFilterPreset(id) {
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  preset.deleted    = true;
  preset.modifiedAt = Date.now();
  _saveFilterPresets(presets);
  if (_VCS._activeFilterPresetId === id) _VCS._activeFilterPresetId = null;
  _unlinkPresetFromAllItems(id);
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
  const name = preset.name;
  _showToast(
    `<span>已刪除「${name}」</span>` +
    `<button onclick="vcUndoDeletePreset('${id}')">復原</button>`,
    5000
  );
}

export function vcUndoDeletePreset(id) {
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  preset.deleted    = false;
  preset.modifiedAt = Date.now();
  _saveFilterPresets(presets);
  vcDismissToast();
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
}

function _unlinkPresetFromAllItems(presetId) {
  Object.keys(localStorage)
    .filter(k => k.startsWith('eagle-media-filter-'))
    .forEach(k => {
      try {
        const itemId = k.slice('eagle-media-filter-'.length);
        const d = _loadVideoFilterData(itemId);
        if (!d.presetIds?.includes(presetId)) return;
        d.presetIds = d.presetIds.filter(x => x !== presetId);
        if (d.lastUsed === presetId) d.lastUsed = d.presetIds[0] || null;
        _saveVideoFilterData(itemId, d);   // 經 Server Sync 同步解除連結
      } catch (_) {}
    });
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
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
}

export function vcOverwriteFilterPreset(id) {
  if (_isFilterDefault(_VCS.filter) && _isSelectiveDefault(_VCS.selectiveList)) {
    _showToast('<span>目前為預設色調，無法覆蓋。</span>');
    return;
  }
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  preset.filter     = { ..._VCS.filter };
  preset.selective  = _VCS.selectiveList.map(s => ({ ...s }));
  preset.modifiedAt = Date.now();
  _saveFilterPresets(presets);
  // 臨時狀態已固化為 preset：清除臨時濾鏡旗標（與 vcSaveFilterPreset 一致）
  _VCS._tempOriginItemId = null;
  _VCS._tempDismissed    = false;
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
  _showToast(`<span>「${preset.name}」已更新。</span>`);
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
      (isActive ? `<button class="vc-preset-overwrite" onclick="vcOverwriteFilterPreset('${p.id}')" title="以當前色調覆蓋此預設">↺</button>` : '') +
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
   AB Preset（localStorage-only, per-video）
══════════════════════════════════════════════════════════════════ */
const _abPresetKey = id => `eagle-ab-preset-${id}`;

function _loadAbPresets(itemId) {
  try { return JSON.parse(localStorage.getItem(_abPresetKey(itemId)) || '[]'); }
  catch { return []; }
}
function _saveAbPresets(itemId, arr) {
  localStorage.setItem(_abPresetKey(itemId), JSON.stringify(arr));
}

export function vcSaveAbPreset() {
  if (!_VCS._itemId) { _showToast('無法辨識影片 ID，無法儲存。'); return; }
  const { a, b } = _VCS.ab;
  if (a === null || b === null) { _showToast('請先設定 A / B 點。'); return; }
  const name = prompt('AB 設定名稱：', `${fmtTime(a)}–${fmtTime(b)}`);
  if (!name) return;
  const presets = _loadAbPresets(_VCS._itemId);
  presets.push({ id: `abp-${Date.now()}`, name: name.trim(), abStart: a, abEnd: b });
  _saveAbPresets(_VCS._itemId, presets);
  vcRenderAbPresets();
}

export function vcLoadAbPreset(id) {
  const p = _loadAbPresets(_VCS._itemId).find(x => x.id === id);
  if (!p) return;
  _VCS.ab = { a: p.abStart, b: p.abEnd, active: false };
  vcSyncPanel();
}

export function vcDeleteAbPreset(id) {
  const presets = _loadAbPresets(_VCS._itemId).filter(x => x.id !== id);
  _saveAbPresets(_VCS._itemId, presets);
  vcRenderAbPresets();
}

export function vcRenameAbPreset(id) {
  const presets = _loadAbPresets(_VCS._itemId);
  const p = presets.find(x => x.id === id);
  if (!p) return;
  const name = prompt('重新命名：', p.name);
  if (!name) return;
  p.name = name.trim() || p.name;
  _saveAbPresets(_VCS._itemId, presets);
  vcRenderAbPresets();
}

export function vcRenderAbPresets() {
  const el = document.getElementById('vc-ab-presets');
  if (!el || !_VCS._itemId) return;
  const presets = _loadAbPresets(_VCS._itemId);
  if (!presets.length) {
    el.innerHTML = '<div class="vc-preset-empty">尚無 AB 設定</div>'; return;
  }
  el.innerHTML = presets.map(p =>
    `<div class="vc-preset-row">` +
    `<button class="vc-preset-name" onclick="vcLoadAbPreset('${p.id}')">${p.name}</button>` +
    `<button class="vc-preset-edit" onclick="vcRenameAbPreset('${p.id}')" title="重新命名">✏️</button>` +
    `<button class="vc-preset-del"  onclick="vcDeleteAbPreset('${p.id}')"  title="刪除">🗑</button>` +
    `</div>`
  ).join('');
}
