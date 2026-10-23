'use strict';
/* ── vc-playback.js  ▸  播放控制 + 媒體初始化 + AB Loop ──────────────
   Loop mode／播放速度／Autoplay Next／vcInitVid・vcInitMedia／AB 循環
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { state } from './state.js';
import { _VCS, _selDefault,
         _loadFilterPresets, _loadVideoFilterData, _loadTransformSnapshot,
         _migrateOnce, _migrateVideoFilterLinks,
         _isFilterDefault, _isSelectiveDefault,
         _getAbSeeking, _setAbSeeking } from './vc-state.js';
import { _glShowCanvas, _glResetTexSrc, _glSetReadyFrame, _glClearTexture,
         _glAwaitFirstFrame, _hasActiveSel,
         _startVideoRafLoop, _stopVideoRafLoop } from './vc-webgl.js';
import { _releaseCanvas, _scheduleCanvasUpdate } from './vc-canvas.js';
import { vcStopEyedropper, vcApplyFilter } from './vc-filters.js';
import { vcCompareOff } from './vc-compare.js';
import { vcRenderFilterPresets, vcRenderAbPresets } from './vc-presets.js';
import { vcApplyTransform, vcRenderTransformActions } from './vc-transform.js';
import { _vcClearCropSilently } from './vc-crop.js';
import { _showToast, vcSyncPanel } from './vc-panel.js';

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
  _stopVideoRafLoop();
  _glShowCanvas(false);
  _releaseCanvas();
  _glResetTexSrc();
  _glSetReadyFrame(false);   // 新影片首幀上傳前 overlay 不可見
  // 清除 GL 紋理舊幀，防止切換影片時短暫顯示上一部影片的定格畫面
  _glClearTexture();
  _VCS._imgOriginalSrc = null;
  // 切換影片時靜默清理裁切框（不觸發 panel toggle）
  _vcClearCropSilently();

  _migrateOnce();
  _migrateVideoFilterLinks();

  const _prevItemId = _VCS._itemId;   // 切換前的影片 ID（判斷是否重開同一部影片）
  _VCS._vid        = vid;
  _VCS._itemId     = itemId || null;
  _VCS._autoRotate = 0;
  _VCS.ab          = { a: null, b: null, active: false };
  _VCS.abSeq       = { items: [], idx: 0 };
  _setAbSeeking(false);

  // 首幀確認：真實一幀上傳成功前 overlay 保持隱藏
  _glAwaitFirstFrame(vid);

  // filter + selectiveList 保留為臨時狀態延續到新影片（只清除上部影片專屬的時間戳）
  for (const s of _VCS.selectiveList) { s.abStart = null; s.abEnd = null; }
  const _isSameItem = !!itemId && itemId === _prevItemId;
  const _hasTempFilter = !_isFilterDefault(_VCS.filter) || !_isSelectiveDefault(_VCS.selectiveList);
  // 目前狀態仍等同某 preset 的值（使用者未手動調整過）：漫遊到新影片時提示「連結」而非「另存」
  const _roamPresetId = (_VCS._tempOriginItemId == null) ? _VCS._activeFilterPresetId : null;
  _VCS._activeFilterPresetId = null;

  let _appliedOwnPreset = false;   // 目標影片是否套用了自己已儲存的濾鏡
  if (_isSameItem && _hasTempFilter) {
    // 重開同一部影片：保留現有臨時濾鏡狀態，不套用已儲存濾鏡
  } else if (itemId) {
    const vfl      = _loadVideoFilterData(itemId);
    const presets  = _loadFilterPresets();
    const curPresets = state.curPresets;
    let targetId = null;
    if (curPresets?.size === 1) {
      const [pid] = curPresets;
      if ((vfl.presetIds || []).includes(pid)) targetId = pid;
    }
    if (!targetId && vfl.lastUsed) targetId = vfl.lastUsed;
    if (targetId) {
      const preset = presets.find(p => p.id === targetId && !p.deleted);
      if (preset) {
        // 目標影片有自己已儲存的濾鏡：直接套用（覆蓋臨時狀態），不提示
        _VCS.filter               = { sepia: 0, sharpness: 0, ...preset.filter };
        _VCS._activeFilterPresetId = preset.id;
        if (Array.isArray(preset.selective)) {
          _VCS.selectiveList = preset.selective.map(s => ({ ..._selDefault(s.id), ...s }));
        } else if (preset.selective && preset.selective.targetHue != null) {
          _VCS.selectiveList = [{ ..._selDefault(), ...preset.selective }];
        } else {
          _VCS.selectiveList = [];
        }
        _VCS._activeSelectiveId = _VCS.selectiveList[0]?.id ?? null;
        _VCS._tempOriginItemId  = null;
        _VCS._tempDismissed     = false;
        _appliedOwnPreset       = true;
      }
    }
  }

  // 漫遊中的已儲存 preset：保留 active 標記（狀態值仍等同該 preset）
  if (!_appliedOwnPreset && _hasTempFilter && _roamPresetId) {
    _VCS._activeFilterPresetId = _roamPresetId;
  }

  // 沿用臨時濾鏡且目標影片無自有濾鏡：提示一次
  if (_hasTempFilter && !_isSameItem && _prevItemId &&
      !_appliedOwnPreset && !_VCS._tempDismissed) {
    if (_roamPresetId) {
      // 狀態來自已儲存的濾鏡：提供「連結到這部影片」而非另存新 preset（避免重複）
      _showToast(
        `<span>是否將此濾鏡連結到這部影片？</span>` +
        `<button onclick="vcLinkPresetToVideo('${_roamPresetId}')">連結</button>` +
        `<button onclick="vcKeepTempFilter()">沿用</button>` +
        `<button onclick="vcDiscardTempFilter()">還原</button>`,
        8000
      );
    } else {
      _showToast(
        `<span>有未儲存的濾鏡設定，是否儲存？</span>` +
        `<button onclick="vcSaveFilterPreset()">儲存</button>` +
        `<button onclick="vcKeepTempFilter()">沿用</button>` +
        `<button onclick="vcDiscardTempFilter()">還原</button>`,
        8000
      );
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

  // selective color 影片事件（先移除舊 listener 防止重複累積）
  if (vid._vcPlayHandler)     vid.removeEventListener('play',            vid._vcPlayHandler);
  if (vid._vcPauseHandler)    vid.removeEventListener('pause',           vid._vcPauseHandler);
  if (vid._vcSeekedHandler)   vid.removeEventListener('seeked',          vid._vcSeekedHandler);
  if (vid._vcMetaHandler)     vid.removeEventListener('loadedmetadata',  vid._vcMetaHandler);
  vid._vcPlayHandler   = () => { if (_VCS._mediaType === 'video' && _hasActiveSel()) _startVideoRafLoop(); };
  vid._vcPauseHandler  = () => _stopVideoRafLoop();
  vid._vcSeekedHandler = () => { if (_VCS._mediaType === 'video' && vid.paused && _hasActiveSel()) _scheduleCanvasUpdate(); };
  vid._vcMetaHandler   = () => { if (_VCS._mediaType === 'video' && _hasActiveSel()) _scheduleCanvasUpdate(); };
  vid.addEventListener('play',           vid._vcPlayHandler);
  vid.addEventListener('pause',          vid._vcPauseHandler);
  vid.addEventListener('seeked',         vid._vcSeekedHandler);
  vid.addEventListener('loadedmetadata', vid._vcMetaHandler);

  vcApplyFilter(vid);
  vcApplyTransform(vid);
  vcSyncPanel();
  vcRenderFilterPresets();
  vcRenderTransformActions();
  vcRenderAbPresets();
  const abSection = document.getElementById('vc-ab-preset-section');
  if (abSection) abSection.style.display = _VCS._itemId ? '' : 'none';
}

/** 立即設定 mediaType（供 openModal 在圖片載入前同步 tab 顯示用） */
export function vcSetMediaType(mediaType) {
  _VCS._mediaType = mediaType || 'video';
}

/* ══════════════════════════════════════════════════════════════════
   vcInitMedia（圖片 / 影片通用入口）
══════════════════════════════════════════════════════════════════ */
export function vcInitMedia(el, itemId, mediaType) {
  _VCS._mediaType = mediaType || 'video';
  vcCompareOff();                                   // 換媒體：結束比對疊層／解鎖
  vcStopEyedropper();
  _stopVideoRafLoop();
  _releaseCanvas();
  _glShowCanvas(false);       // 圖片切換時隱藏舊的 GL canvas，重新掛載前保持隱藏
  _glResetTexSrc();           // 強制下次 _glUploadTexture 重傳新圖片紋理
  _glSetReadyFrame(false);    // 新媒體真實內容上傳前 overlay 不可見
  _VCS._imgOriginalSrc = null;
  if (mediaType === 'image') {
    _migrateOnce();
    _VCS._vid    = el;
    _VCS._itemId = itemId || null;
    _VCS.ab      = { a: null, b: null, active: false };
    _VCS.abSeq   = { items: [], idx: 0 };
    _VCS.selectiveList = []; _VCS._activeSelectiveId = null;

    _VCS.filter               = { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 };
    _VCS._activeFilterPresetId = null;
    if (itemId) {
      const vfl     = _loadVideoFilterData(itemId);
      const presets = _loadFilterPresets();
      // 優先：若格線目前只篩選一個濾鏡且該 item 有此標記，直接套用（UX：點哪個濾鏡看哪個）
      const curPresets = state.curPresets;
      let targetId = null;
      if (curPresets?.size === 1) {
        const [pid] = curPresets;
        if ((vfl.presetIds || []).includes(pid)) targetId = pid;
      }
      // fallback：lastUsed
      if (!targetId && vfl.lastUsed) targetId = vfl.lastUsed;
      if (targetId) {
        const preset = presets.find(p => p.id === targetId && !p.deleted);
        if (preset) {
          _VCS.filter = { sepia: 0, sharpness: 0, ...preset.filter };
          _VCS._activeFilterPresetId = preset.id;
          if (Array.isArray(preset.selective)) {
            _VCS.selectiveList = preset.selective.map(s => ({ ..._selDefault(s.id), ...s }));
          } else if (preset.selective && preset.selective.targetHue != null) {
            _VCS.selectiveList = [{ ..._selDefault(), ...preset.selective }];
          } else {
            _VCS.selectiveList = [];
          }
          _VCS._activeSelectiveId = _VCS.selectiveList[0]?.id ?? null;
        }
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
   AB Loop
══════════════════════════════════════════════════════════════════ */
export function vcSetAbPoint(vid, point) {
  if (!vid) return;
  const t = vid.currentTime;
  _VCS.ab.srcSel = null;              // 手動設定 = 解除與色塊時段的派生綁定
  if (point === 'a') {
    _VCS.ab.a = t;
    if (_VCS.ab.b !== null && _VCS.ab.b <= t + 0.3) _VCS.ab.b = null;
  } else {
    _VCS.ab.b = t;
    if (_VCS.ab.a !== null && _VCS.ab.a >= t - 0.3) _VCS.ab.a = null;
  }
  vcSyncPanel();
}
/* 時段欄位為 <input>（非 contenteditable：面板 user-select:none 下 iOS 無法輸入）→ 聚焦全選即可 */
export function vcAbSpanFocus(el) {
  if ('value' in el) { if (el.value.trim() === '–') el.value = ''; try { el.select(); } catch {} return; }
  if (el.textContent.trim() === '–') el.textContent = '';
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
const _abFieldText = el => ('value' in el ? el.value : el.textContent);

export function vcAbSpanEdit(point, el) {
  _VCS.ab.srcSel = null;              // 手動輸入 = 解除派生綁定
  const raw = _abFieldText(el).trim().replace(/[^\d:.]/g, '');
  const m = raw.match(/^(\d+):(\d{2}(?:\.\d+)?)$/);
  let sec = m ? +m[1] * 60 + +m[2] : parseFloat(raw);
  if (!isNaN(sec) && sec >= 0) {
    const dur = _VCS._vid?.duration;
    _VCS.ab[point] = (dur && isFinite(dur)) ? Math.min(sec, dur) : sec;
  }
  vcSyncPanel();
}

export function vcToggleAbLoop() {
  if (_VCS.ab.a === null || _VCS.ab.b === null) return;
  _VCS.ab.active = !_VCS.ab.active;
  vcSyncPanel();
}
export function vcClearAb() {
  _VCS.ab = { a: null, b: null, active: false, srcSel: null };
  _VCS.abSeq = { items: [], idx: 0 };
  _setAbSeeking(false);
  vcSyncPanel();
}

const _nearT = (x, y) => x !== null && y !== null && Math.abs(x - y) < 0.05;
/** AB 序列（多選）：目前 AB 必須等於序列第 idx 段，否則視為被手動改寫 → 序列失效（自癒，不需每個寫入點都清） */
function _seqCurrent() {
  const seq = _VCS.abSeq;
  if (!seq || seq.items.length < 2) return null;
  const cur = seq.items[seq.idx];
  if (!cur || !_nearT(_VCS.ab.a, cur.a) || !_nearT(_VCS.ab.b, cur.b)) { seq.items = []; seq.idx = 0; return null; }
  return seq;
}
export function vcAbTimeUpdate(vid) {
  if (!_VCS.ab.active || _VCS.ab.a === null || _VCS.ab.b === null || _getAbSeeking()) return;
  const seq = _seqCurrent();
  if (seq && vid.currentTime >= _VCS.ab.b) {          // 序列：到段尾 → 跳下一段（環狀 A→C→A）
    seq.idx = (seq.idx + 1) % seq.items.length;
    const nx = seq.items[seq.idx];
    _VCS.ab.a = nx.a; _VCS.ab.b = nx.b; _VCS.ab.srcSel = nx.srcSel ?? null;
    _setAbSeeking(true);
    vid.currentTime = nx.a;
    vid.addEventListener('seeked', () => { _setAbSeeking(false); }, { once: true });
    vcSyncPanel();
    return;
  }
  if (vid.currentTime >= _VCS.ab.b || vid.currentTime < _VCS.ab.a) {
    _setAbSeeking(true);
    vid.currentTime = _VCS.ab.a;
    vid.addEventListener('seeked', () => { _setAbSeeking(false); }, { once: true });
  }
}
