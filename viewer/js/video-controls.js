'use strict';
/* ── video-controls.js  ▸  三模組影片控制（façade）───────────────────
   Playback   ─ Loop mode / Autoplay Next / AB Loop / 播放速度
   Filters    ─ brightness / contrast / saturate / hue + 命名濾鏡庫
   Transform  ─ scale / offset / flip / rotate + 智慧裁切 + per-video 快照

   實作已拆分至 vc-*.js 模組（依賴層次由下而上）：
     vc-state.js     狀態單例 + localStorage / Server 同步
     vc-webgl.js     WebGL selective color pipeline
     vc-canvas.js    Canvas 像素處理 pipeline
     vc-filters.js   CSS 濾鏡 + 選擇性色彩 + Eyedropper
     vc-presets.js   濾鏡 Preset CRUD + AB Preset
     vc-transform.js 幾何變換 + per-video 快照
     vc-crop.js      智慧裁切 + 手動裁切框
     vc-playback.js  播放控制 + 媒體初始化 + AB Loop
     vc-panel.js     控制面板 UI
   此檔僅 re-export 公開 API + 模組初始化，既有 import 路徑不變。
══════════════════════════════════════════════════════════════════════*/

export { vcGetVid } from './vc-state.js';

export { vcSyncGlCanvas } from './vc-webgl.js';

export { vcKeepTempFilter, vcLinkPresetToVideo, vcDiscardTempFilter,
         vcStartEyedropper, vcStopEyedropper,
         vcSetSelectiveHue, vcClearSelectiveColor, vcAddSelectiveColor,
         vcSetActiveSelective, vcRemoveSelective,
         vcBindAbToSelective, vcUnbindAbFromSelective, vcSelAbEdit, vcSelAbNow, vcRenderSelectiveChips,
         vcApplyFilter, vcSetFilter, vcResetFilters } from './vc-filters.js';

export { vcSaveFilterPreset, vcApplyFilterPreset, vcToggleVideoFilterPreset,
         vcDeleteFilterPreset, vcUndoDeletePreset, vcRenameFilterPreset,
         vcOverwriteFilterPreset, vcRenderFilterPresets,
         vcSaveAbPreset, vcLoadAbPreset, vcDeleteAbPreset,
         vcRenameAbPreset, vcRenderAbPresets } from './vc-presets.js';

export { vcSetAutoRotate, vcHasSnapshot,
         vcSaveTransformSnapshot, vcResetTransformSnapshot,
         vcRenderTransformActions,
         vcApplyTransform, vcSetTx, vcFlip, vcRotateBy, vcSetRotate,
         vcResetTransform } from './vc-transform.js';

export { vcSmartCrop, vcToggleCropMode, vcCancelCrop, vcApplyCrop }
  from './vc-crop.js';

export { vcSetLoopMode, vcSetSpeed, vcSyncPlayback,
         vcRegisterAutoplayNext, vcOnVideoEnded,
         vcInitVid, vcSetMediaType, vcInitMedia,
         vcSetAbPoint, vcAbSpanFocus, vcAbSpanEdit,
         vcToggleAbLoop, vcClearAb, vcAbTimeUpdate } from './vc-playback.js';

export { vcRegisterImageZoom, vcImageZoom, vcImageZoomSet, vcImageFit,
         vcImageActualSize, vcRegisterImageNav, vcImageNav, vcSetModalBg,
         vcResetAll, vcDismissToast, vcSwitchTab,
         toggleVcPanel, closeVcPanel, vcInitDragHandle, vcInitValueEdit, vcSyncPanel }
  from './vc-panel.js';

import { _migrateMediaFilterKeys, _migrateVideoFilterLinks, _syncLoad }
  from './vc-state.js';

// 模組初始化
_migrateMediaFilterKeys();
_migrateVideoFilterLinks();
_syncLoad();
