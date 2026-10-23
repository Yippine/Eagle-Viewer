'use strict';
/* ── vc-state.js  ▸  video-controls 狀態單例 + 儲存層 ────────────────
   _VCS 狀態單例／localStorage keys／Server Sync／Migration／
   Preset・Snapshot 儲存 CRUD／預設值判斷／AB seeking 旗標
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { vcRenderFilterPresets } from './vc-presets.js';
import { E2_FILTER_DEFAULT, isE2FilterDefault, isE2SelDefault } from './vc-engine2.js';

export const _selDefault = (id = null) =>
  ({ id: id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
     targetHue: null, pickedRgb: null, range: 30, hueShift: 0,
     mode: 'hue', targetLum: null,          // mode: 'hue' | 'lum'（黑白灰系以明度選取）
     brightness: 0, contrast: 0, saturate: 0, sepia: 0,
     abStart: null, abEnd: null });

export const _newSelItem = () => _selDefault();
export const _getActive = () =>
  _VCS.selectiveList.find(s => s.id === _VCS._activeSelectiveId) ?? null;

const _ENGINE_KEY = 'eagle-vc-engine';
function _initEngine() {
  const n = parseInt(localStorage.getItem(_ENGINE_KEY), 10);
  return n === 2 ? 2 : 1;
}

/* ── 狀態 ─────────────────────────────────────────────────────────── */
export const _VCS = {
  engine:    _initEngine(),
  filter:    { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 },
  filter2:   { ...E2_FILTER_DEFAULT },
  selectiveList: [],
  _activeSelectiveId: null,
  tx:        { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
               rotate: 0, flipH: false, flipV: false },
  ab:        { a: null, b: null, active: false, srcSel: null },   // srcSel = 派生來源色塊 id（null = 手動）
  abSeq:     { items: [], idx: 0 },   // AB 序列播放（播放頁籤設定庫多選）：items=[{key,a,b,label}]，≥2 段時依序循環；任何手動改 AB 即失效
  playback:  { loopMode: 'single', speed: 1.0 },
  _vid:                null,
  _itemId:             null,
  _mediaType:          'video',
  _activeFilterPresetId: null,
  _autoRotate:         0,
  _imgOriginalSrc:     null,   // 圖片原始 src（Canvas 處理前保存）
  _canvasObjectURL:    null,   // Canvas 輸出的 blob URL
  _tempOriginItemId:   null,   // 產生臨時濾鏡狀態的來源 itemId
  _tempDismissed:      false,  // 使用者已對此臨時濾鏡選擇「沿用不再問」
};

export function vcGetVid() { return _VCS._vid; }


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
const _CACHE = { filterPresets: [], transformSnapshots: {}, videoFilterLinks: {}, version: 0, loaded: false };

/* 收集本機 localStorage 既有的 per-video 濾鏡連結（eagle-media-filter-*）
   → 供首次同步時上傳伺服器（桌面先前的連結資料不會遺失）*/
function _collectLocalVfl() {
  const out = {};
  Object.keys(localStorage).filter(k => k.startsWith('eagle-media-filter-')).forEach(k => {
    try {
      const d = JSON.parse(localStorage.getItem(k) || '{}');
      if (d.presetIds?.length || d.lastUsed)
        out[k.slice('eagle-media-filter-'.length)] = { presetIds: d.presetIds || [], lastUsed: d.lastUsed || null, savedAt: d.savedAt || 0 };
    } catch (_) {}
  });
  return out;
}
/* 伺服器資料落地：cache + localStorage 鏡像（離線／未 loaded 前的讀取路徑） */
function _applyServerData(data) {
  _CACHE.filterPresets      = data.filterPresets      || [];
  _CACHE.transformSnapshots = data.transformSnapshots || {};
  _CACHE.videoFilterLinks   = data.videoFilterLinks   || {};
  _CACHE.version            = data.version            || 0;
  localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(_CACHE.filterPresets));
  Object.entries(_CACHE.transformSnapshots).forEach(([id, snap]) =>
    localStorage.setItem(_txKey(id), JSON.stringify(snap)));
  Object.entries(_CACHE.videoFilterLinks).forEach(([id, vfl]) =>
    localStorage.setItem(_vflKey(id), JSON.stringify(vfl)));
}
let _debounceTimer = null;

export async function _syncLoad() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    const hasFP = data.filterPresets?.length;
    const hasTS = Object.keys(data.transformSnapshots || {}).length;
    if (hasFP || hasTS) {
      // 伺服器尚無 per-video 連結（舊版升級）但本機有 → 先把本機連結併入再落地上傳
      const localVfl = _collectLocalVfl();
      const needUploadVfl = !Object.keys(data.videoFilterLinks || {}).length && Object.keys(localVfl).length;
      if (needUploadVfl) data.videoFilterLinks = localVfl;
      _applyServerData(data);
      if (needUploadVfl) _syncSave();
    } else {
      const local = JSON.parse(localStorage.getItem(_FILTER_PRESETS_KEY) || '[]');
      if (local.length) {
        _CACHE.filterPresets    = local;
        _CACHE.videoFilterLinks = _collectLocalVfl();
        _CACHE.version          = data.version || 0;
        _syncSave();
      }
    }
  } catch (e) {
    console.warn('[VCS] server sync unavailable, using localStorage:', e.message);
  }
  _CACHE.loaded = true;
  vcRenderFilterPresets();
  document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
  document.dispatchEvent(new CustomEvent('vc-snaps-synced'));
  _migrateToE2Once();
}

/* ══════════════════════════════════════════════════════════════════
   Engine 2 首次升級備份（一次性）
══════════════════════════════════════════════════════════════════ */
const _E2_MIGRATED_KEY  = 'eagle-vc-e2-migrated';
const _E2_BACKUP_KEY    = 'eagle-filter-presets-backup-v1';

async function _migrateToE2Once() {
  if (localStorage.getItem(_E2_MIGRATED_KEY)) return;
  try {
    await fetch('/api/user-data/backup', { method: 'POST' });
    localStorage.setItem(_E2_BACKUP_KEY, JSON.stringify(_CACHE.filterPresets));
    localStorage.setItem(_E2_MIGRATED_KEY, '1');
  } catch (e) {
    console.warn('[VCS] e2 migration backup failed (non-blocking):', e.message);
  }
}

/* ── 備份／還原（W3 接 UI）─────────────────────────────────────────── */
export async function vcBackupNow() {
  const res = await fetch('/api/user-data/backup', { method: 'POST' });
  if (!res.ok) throw new Error('backup failed');
  return res.json();
}

export async function vcListBackups() {
  const res = await fetch('/api/user-data/backups');
  if (!res.ok) throw new Error('list backups failed');
  return res.json();
}

export async function vcRestoreBackup(name) {
  const res = await fetch('/api/user-data/restore', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error('restore failed');
  const { data } = await res.json();
  if (data) {
    _applyServerData(data);
    vcRenderFilterPresets();
    document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
  }
  return data;
}

async function _syncPoll() {
  try {
    const res  = await fetch('/api/user-data');
    const data = await res.json();
    if ((data.version || 0) > _CACHE.version) {
      _applyServerData(data);
      vcRenderFilterPresets();
      document.dispatchEvent(new CustomEvent('vc-filter-presets-changed'));
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
        _CACHE.videoFilterLinks   = merged.videoFilterLinks   || _CACHE.videoFilterLinks;
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
export function _migrateOnce() {
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
export function _migrateMediaFilterKeys() {
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
export function _migrateVideoFilterLinks() {
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
export function _loadFilterPresets() {
  if (_CACHE.loaded) return _CACHE.filterPresets;
  try { return JSON.parse(localStorage.getItem(_FILTER_PRESETS_KEY) || '[]'); }
  catch { return []; }
}
export function _saveFilterPresets(arr) {
  arr.forEach(p => { if (!p.modifiedAt) p.modifiedAt = Date.now(); });
  _CACHE.filterPresets = arr;
  localStorage.setItem(_FILTER_PRESETS_KEY, JSON.stringify(arr));
  _syncSave();
}

/* ── Per-video filter link CRUD ──────────────────────────────────── */
export function _loadVideoFilterData(itemId) {
  if (!itemId) return { presetIds: [], lastUsed: null };
  if (_CACHE.loaded && _CACHE.videoFilterLinks[itemId]) {
    const v = _CACHE.videoFilterLinks[itemId];
    return { presetIds: [...(v.presetIds || [])], lastUsed: v.lastUsed ?? null, savedAt: v.savedAt };
  }
  try { return JSON.parse(localStorage.getItem(_vflKey(itemId)) || '{"presetIds":[],"lastUsed":null}'); }
  catch { return { presetIds: [], lastUsed: null }; }
}
export function _saveVideoFilterData(itemId, data) {
  if (!itemId) return;
  // 與 transformSnapshots 同一套 Server Sync（LWW by savedAt）→ 手機／其他裝置可共用連結
  const rec = { presetIds: data.presetIds || [], lastUsed: data.lastUsed ?? null, savedAt: Date.now() };
  _CACHE.videoFilterLinks[itemId] = rec;
  localStorage.setItem(_vflKey(itemId), JSON.stringify(rec));
  _syncSave();
}

export function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function _isFilterDefault(f) {
  return f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.hueRotate === 0 &&
         !f.sepia && !f.sharpness;
}
export function _isSelectiveDefault(s) {
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
/* ── Engine 切換（僅寫 state + localStorage，不碰 UI；UI 副作用由 W3 vcSetEngine 負責）── */
export function vcSetEngineState(n) {
  _VCS.engine = n === 2 ? 2 : 1;
  localStorage.setItem(_ENGINE_KEY, String(_VCS.engine));
}

export function _isCurrentDefault() {
  if (_VCS.engine === 2) {
    return isE2FilterDefault(_VCS.filter2) && isE2SelDefault(_VCS.selectiveList.map(s => s.e2));
  }
  return _isFilterDefault(_VCS.filter) && _isSelectiveDefault(_VCS.selectiveList);
}

export function _isTxDefault(t) {
  return t.scaleX === 1 && t.scaleY === 1 && t.translateX === 0 && t.translateY === 0 &&
         t.rotate === 0 && !t.flipH && !t.flipV;
}

/* ══════════════════════════════════════════════════════════════════
   Transform Snapshot（per-video 幾何快照）
══════════════════════════════════════════════════════════════════ */
export function _loadTransformSnapshot(itemId) {
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
export function _saveTransformSnapshot(itemId, snap) {
  snap.savedAt = Date.now();
  snap.deleted = false;
  _CACHE.transformSnapshots[itemId] = snap;
  localStorage.setItem(_txKey(itemId), JSON.stringify(snap));
  _syncSave();
  document.dispatchEvent(new CustomEvent('vc-snap-changed', { detail: { itemId } }));
}
export function _deleteTransformSnapshot(itemId) {
  // 軟刪除：保留紀錄讓伺服器 LWW merge 正確同步刪除狀態
  const snap = { deleted: true, savedAt: Date.now() };
  _CACHE.transformSnapshots[itemId] = snap;
  localStorage.setItem(_txKey(itemId), JSON.stringify(snap));
  _syncSave();
  document.dispatchEvent(new CustomEvent('vc-snap-changed', { detail: { itemId } }));
}

/* ── AB seeking 旗標（跨模組共享的 module-level let，收攏於此）────── */
let _abSeeking = false;
export function _getAbSeeking()  { return _abSeeking; }
export function _setAbSeeking(v) { _abSeeking = v; }
