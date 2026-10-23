'use strict';
/* ── vc-presets.js  ▸  濾鏡 Preset CRUD + per-video 連結 + AB Preset ─
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { fmtTime, fmtTimeF } from './utils.js';
import { _VCS, _selDefault, _uid,
         _loadFilterPresets, _saveFilterPresets,
         _loadVideoFilterData, _saveVideoFilterData,
         _isFilterDefault, _isSelectiveDefault,
         vcSetEngineState, _isCurrentDefault } from './vc-state.js';
import { ensureE2, ensureFilter2 } from './vc-engine2.js';
import { vcApplyFilter, vcResetFilters } from './vc-filters.js';
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

function _filterAutoNameE2(f2) {
  const parts = [];
  if      (f2.exposure > 20)          parts.push('偏亮');
  else if (f2.exposure < -20)         parts.push('偏暗');
  if      (f2.contrast > 30)          parts.push('高對比');
  if      (f2.saturation > 40)        parts.push('高飽和');
  else if (f2.saturation < -30)       parts.push('褪色');
  const h = f2.hueRotate;
  if      (h >= 20  && h <= 80)       parts.push('暖色調');
  else if (h >= 160 && h <= 260)      parts.push('冷色調');
  if (f2.sepia > 30)                  parts.push('復古');
  if (f2.sharpness > 3)               parts.push('銳化');
  else if (f2.sharpness < -3)         parts.push('柔焦');
  return parts.length ? parts.join('・') : '原色';
}

export function vcSaveFilterPreset(force = false) {
  vcDismissToast();
  if (_isCurrentDefault()) {
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
      if (_VCS.engine === 2) {
        ensureFilter2(p);
        const fMatch = JSON.stringify(p.filter2) === JSON.stringify(_VCS.filter2);
        if (!fMatch) return false;
        const pSelE2 = normList(p.selective).map(s => (ensureE2(s), s.e2));
        const curSelE2 = normList(_VCS.selectiveList).map(s => s.e2);
        return JSON.stringify(pSelE2) === JSON.stringify(curSelE2);
      }
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
  const suggested = _VCS.engine === 2 ? _filterAutoNameE2(_VCS.filter2) : _filterAutoName(_VCS.filter);
  const name = prompt('濾鏡名稱：', suggested);
  if (name === null) return;
  const presets = _loadFilterPresets();
  const id = _uid();
  presets.push({
    id, name: name.trim() || suggested,
    filter:  { ..._VCS.filter },
    filter2: { ..._VCS.filter2 },
    engine:  _VCS.engine,
    e2Auto:  false,
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

/** 濾鏡庫清單專用 toggle：點未套用的 → 套用；點目前套用中的 → 取消套用回到原圖（再點即重新套用）。
    只在清單提供此語意；其他程式化套用路徑仍用 vcApplyFilterPreset。 */
export function vcToggleApplyFilterPreset(id) {
  if (_VCS._activeFilterPresetId === id) {
    _unapplyFilterPreset();
    _showToast('<span>已取消套用（原圖）。再點同一濾鏡即重新套用</span>', 2500);
    return;
  }
  vcApplyFilterPreset(id);
}
function _unapplyFilterPreset() {
  vcResetFilters();                                    // 與「重設」同一條路（含 GL canvas 隱藏、lastUsed=null、面板同步）
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
}
export function vcApplyFilterPreset(id) {
  const preset = _loadFilterPresets().find(p => p.id === id);
  if (!preset) return;
  ensureFilter2(preset);
  _VCS.filter               = { sepia: 0, sharpness: 0, ...preset.filter };
  _VCS.filter2              = { ...preset.filter2 };
  if (Array.isArray(preset.selective)) {
    _VCS.selectiveList = preset.selective.map(s => ensureE2({ ..._selDefault(s.id), ...s }));
  } else if (preset.selective && preset.selective.targetHue != null) {
    _VCS.selectiveList = [ensureE2({ ..._selDefault(), ...preset.selective })];
  } else {
    _VCS.selectiveList = [];
  }
  _VCS._activeSelectiveId = _VCS.selectiveList[0]?.id ?? null;
  _VCS._activeFilterPresetId = id;
  vcSetEngineState(preset.engine ?? 1);
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

/** 複製濾鏡：深拷貝一份（含 v1/v2 全欄位與選色），命名「原名 2」（已存在則 3、4…），
    自動套用並連結到本影片 → 之後的調整只動複製品，原濾鏡不受影響。 */
export function vcDuplicateFilterPreset(id) {
  const presets = _loadFilterPresets();
  const src = presets.find(p => p.id === id);
  if (!src) return;
  const base = src.name.replace(/\s\d+$/, '');
  const names = new Set(presets.filter(p => !p.deleted).map(p => p.name));
  let n = 2, name = `${base} ${n}`;
  while (names.has(name)) { n++; name = `${base} ${n}`; }
  const dup = JSON.parse(JSON.stringify(src));
  dup.id = _uid(); dup.name = name; dup.deleted = false;
  dup.createdAt = new Date().toISOString(); dup.modifiedAt = Date.now();
  const idx = presets.indexOf(src);
  presets.splice(idx + 1, 0, dup);            // 緊接在原濾鏡之後
  _saveFilterPresets(presets);
  vcApplyFilterPreset(dup.id);               // 套用複製品（成為目前濾鏡、記 lastUsed）
  if (_VCS._itemId) {                        // 連結到本影片（🔖），與儲存新濾鏡行為一致
    const vfl = _loadVideoFilterData(_VCS._itemId);
    if (!vfl.presetIds) vfl.presetIds = [];
    if (!vfl.presetIds.includes(dup.id)) vfl.presetIds.push(dup.id);
    vfl.lastUsed = dup.id;
    _saveVideoFilterData(_VCS._itemId, vfl);
  }
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
  _showToast(`<span>已複製為「${name}」並套用；現在的調整只會存到複製品</span>`);
}

export function vcOverwriteFilterPreset(id) {
  if (_isCurrentDefault()) {
    _showToast('<span>目前為預設色調，無法覆蓋。</span>');
    return;
  }
  const presets = _loadFilterPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;
  preset.filter     = { ..._VCS.filter };
  preset.filter2    = { ..._VCS.filter2 };
  preset.engine     = _VCS.engine;
  preset.e2Auto     = false;
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
      `<button class="vc-preset-name" onclick="vcToggleApplyFilterPreset('${p.id}')" title="${isActive ? '再點一次：取消套用（回到原圖）' : '套用此濾鏡'}">${p.name}</button>` +
      (isActive ? `<button class="vc-preset-overwrite" onclick="vcOverwriteFilterPreset('${p.id}')" title="以當前色調覆蓋此預設">↺</button>` : '') +
      `<button class="vc-preset-edit" onclick="vcDuplicateFilterPreset('${p.id}')" title="複製此濾鏡（命名「${p.name} 2」並套用；之後調整只動複製品）">⧉</button>` +
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
  const name = prompt('AB 設定名稱：', `${fmtTimeF(a)}–${fmtTimeF(b)}`);
  if (!name) return;
  const presets = _loadAbPresets(_VCS._itemId);
  presets.push({ id: `abp-${Date.now()}`, name: name.trim(), abStart: a, abEnd: b });
  _saveAbPresets(_VCS._itemId, presets);
  vcRenderAbPresets();
}

/* 點選設定庫列 = 一鍵套用（與色塊「一鍵播放」同語彙：寫入 AB + 開啟循環 + seek 至起點 + 播放；
   同一時段循環中再點 = 停止）。不再需要另外上滑點「AB 開啟」。 */
function _applyAbRange(a, b, srcSel, label) {
  const vid = _VCS._vid;
  const same = _VCS.ab.active && _VCS.ab.a !== null && _VCS.ab.b !== null && _near(_VCS.ab.a, a) && _near(_VCS.ab.b, b);
  if (same) {
    _VCS.abSeq = { items: [], idx: 0 };
    _VCS.ab = { a: null, b: null, active: false, srcSel: null };
    _showToast('<span>已停止 AB 循環</span>');
  } else {
    _VCS.abSeq = { items: [], idx: 0 };             // 單點 = 單段，離開序列模式
    _VCS.ab = { a, b, active: true, srcSel };
    if (vid) { vid.currentTime = a; vid.play?.().catch?.(() => {}); }
    _showToast(`<span>AB 循環 ${label}（再點一次停止）</span>`);
  }
  vcSyncPanel();
}
/* ── AB 序列播放（播放頁籤限定）：勾選 ≥2 列 → 依勾選順序循環（A→C→A）。
   濾鏡頁籤色塊維持單選（色塊點擊主語意為編輯，多選會與欄位調整衝突）。 */
function _seqHas(key) { return _VCS.abSeq.items.findIndex(x => x.key === key); }
export function vcToggleAbSeq(key, a, b, label, srcSel = null) {
  const seq = _VCS.abSeq;
  const i = _seqHas(key);
  if (i >= 0) seq.items.splice(i, 1); else seq.items.push({ key, a, b, label, srcSel });
  const vid = _VCS._vid;
  if (seq.items.length === 0) {
    _VCS.ab = { a: null, b: null, active: false, srcSel: null };
  } else {
    // 重新從第一段開始（順序 = 勾選順序）；單段時等同一般 AB 循環
    seq.idx = 0;
    const f = seq.items[0];
    _VCS.ab = { a: f.a, b: f.b, active: true, srcSel: f.srcSel ?? null };
    if (vid) { vid.currentTime = f.a; vid.play?.().catch?.(() => {}); }
    if (seq.items.length >= 2) _showToast(`<span>序列播放 ${seq.items.map((x, k) => `${'①②③④⑤⑥⑦⑧⑨⑩'[k] || k + 1}`).join('→')}（循環）</span>`);
  }
  vcSyncPanel();
}
export function vcClearAbSeq() {
  _VCS.abSeq = { items: [], idx: 0 };
  _VCS.ab = { a: null, b: null, active: false, srcSel: null };
  vcSyncPanel();
}
export function vcLoadAbPreset(id) {
  const p = _loadAbPresets(_VCS._itemId).find(x => x.id === id);
  if (!p) return;
  _applyAbRange(p.abStart, p.abEnd, null, `${fmtTimeF(p.abStart)}–${fmtTimeF(p.abEnd)}`);
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

/* ── 色塊時段（live 派生清單，不落地）────────────────────────────
   AB 設定庫 = 已儲存（手動、無條件可存）∪ 色塊時段（自選色色塊即時抓取，隨色塊增刪自動同步）。
   去重律：色塊時段若與某已儲存設定完全相同（±0.05s）→ 只顯示已儲存那筆並加色點標示，不重複列。 */
const _near = (x, y) => Math.abs(x - y) < 0.05;
const _isAbOn = (a, b) => _VCS.ab.active && _VCS.ab.a !== null && _VCS.ab.b !== null && _near(_VCS.ab.a, a) && _near(_VCS.ab.b, b);
function _chipRanges() {
  return (_VCS.selectiveList || []).filter(s => s.abStart !== null && s.abEnd !== null)
    .map((s, i) => ({ id: s.id, a: s.abStart, b: s.abEnd, idx: _VCS.selectiveList.indexOf(s) + 1,
      color: s.pickedRgb ? `rgb(${s.pickedRgb[0]},${s.pickedRgb[1]},${s.pickedRgb[2]})` : (s.targetHue !== null ? `hsl(${s.targetHue},70%,50%)` : '#888') }))
    .sort((x, y) => x.a - y.a);
}
/** 載入色塊時段為 AB（派生：srcSel 綁定色塊，色塊時段改動會跟隨） */
export function vcLoadChipRange(selId) {
  const s = (_VCS.selectiveList || []).find(x => x.id === selId);
  if (!s || s.abStart === null) return;
  _applyAbRange(s.abStart, s.abEnd, s.id, `色塊 ${_VCS.selectiveList.indexOf(s) + 1}・${fmtTimeF(s.abStart)}–${fmtTimeF(s.abEnd)}`);
}
/** 把色塊時段落地成一筆已儲存設定（之後獨立於色塊） */
export function vcSaveChipRangeAsPreset(selId) {
  if (!_VCS._itemId) return;
  const s = (_VCS.selectiveList || []).find(x => x.id === selId);
  if (!s || s.abStart === null) return;
  const presets = _loadAbPresets(_VCS._itemId);
  presets.push({ id: `abp-${Date.now()}`, name: `色塊 ${_VCS.selectiveList.indexOf(s) + 1}・${fmtTimeF(s.abStart)}–${fmtTimeF(s.abEnd)}`, abStart: s.abStart, abEnd: s.abEnd });
  _saveAbPresets(_VCS._itemId, presets);
  vcRenderAbPresets();
  _showToast('<span>已存入 AB 設定庫</span>');
}

export function vcRenderAbPresets() {
  const el = document.getElementById('vc-ab-presets');
  if (!el || !_VCS._itemId) return;
  const presets = _loadAbPresets(_VCS._itemId);
  const chips = _chipRanges();
  const dupOf = p => chips.find(c => _near(c.a, p.abStart) && _near(c.b, p.abEnd));
  const derived = chips.filter(c => !presets.some(p => _near(c.a, p.abStart) && _near(c.b, p.abEnd)));
  if (!presets.length && !derived.length) {
    el.innerHTML = '<div class="vc-preset-empty">尚無 AB 設定（手動 A/B 後按「儲存」，或為選色色塊設定時段）</div>'; return;
  }
  const dot = (color, title) => `<span class="vc-ab-chip-dot" style="background:${color}" title="${title}"></span>`;
  const seq = _VCS.abSeq.items;
  const seqOn = seq.length >= 2 && _VCS.ab.active;
  const ord = key => { const k = seq.findIndex(x => x.key === key); return k < 0 ? '' : ('①②③④⑤⑥⑦⑧⑨⑩'[k] || String(k + 1)); };
  const seqBtn = (key, a, b, label, srcSel) => {
    const k = seq.findIndex(x => x.key === key);
    return `<button class="vc-ab-seq-btn${k >= 0 ? ' vc-on' : ''}" title="${k >= 0 ? '自序列移除' : '加入序列播放（勾選 2 段以上會依序循環）'}" ` +
      `onclick="event.stopPropagation();vcToggleAbSeq('${key}',${a},${b},'${label.replace(/'/g, '')}',${srcSel ? `'${srcSel}'` : 'null'})">${k >= 0 ? ord(key) : '☐'}</button>`;
  };
  let html = '';
  if (seq.length) {
    html += `<div class="vc-ab-seq-bar${seqOn ? ' vc-on' : ''}">` +
      `<span>${seqOn ? '🔁 序列播放' : '序列'} ${seq.map((x, k) => ('①②③④⑤⑥⑦⑧⑨⑩'[k] || k + 1) + ' ' + x.label).join(' → ')}${seqOn ? ' → ①' : '（再勾 1 段以上開始循環）'}</span>` +
      `<button class="vc-icon-btn" onclick="vcClearAbSeq()" title="清除序列並停止">✕</button></div>`;
  }
  if (presets.length) {
    html += presets.map(p => { const d = dupOf(p); return (
      `<div class="vc-preset-row${_isAbOn(p.abStart, p.abEnd) ? ' active' : ''}">` +
      seqBtn(p.id, p.abStart, p.abEnd, p.name, null) +
      `<button class="vc-preset-name" onclick="vcLoadAbPreset('${p.id}')" title="點擊套用並循環播放；再點停止">${_isAbOn(p.abStart, p.abEnd) ? '🔁 ' : ''}${d ? dot(d.color, `與色塊 ${d.idx} 時段相同`) : ''}${p.name}</button>` +
      `<button class="vc-preset-edit" onclick="vcRenameAbPreset('${p.id}')" title="重新命名">✏️</button>` +
      `<button class="vc-preset-del"  onclick="vcDeleteAbPreset('${p.id}')"  title="刪除">🗑</button>` +
      `</div>`); }).join('');
  }
  if (derived.length) {
    html += `<div class="vc-preset-group-hd">色塊時段（自選色自動抓取，隨色塊同步）</div>` +
      derived.map(c =>
        `<div class="vc-preset-row vc-preset-row-derived${_isAbOn(c.a, c.b) ? ' active' : ''}">` +
        seqBtn(c.id, c.a, c.b, `色塊 ${c.idx}`, c.id) +
        `<button class="vc-preset-name" onclick="vcLoadChipRange('${c.id}')" title="點擊套用並循環播放（跟隨色塊時段變動）；再點停止">${_isAbOn(c.a, c.b) ? '🔁 ' : ''}${dot(c.color, `色塊 ${c.idx}`)}色塊 ${c.idx}・${fmtTimeF(c.a)}–${fmtTimeF(c.b)}</button>` +
        `<button class="vc-preset-edit" onclick="vcSaveChipRangeAsPreset('${c.id}')" title="存為獨立 AB 設定（之後不再跟隨色塊）">💾</button>` +
        `</div>`).join('');
  }
  el.innerHTML = html;
}
