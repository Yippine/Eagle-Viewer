/* ── vc-bindings.js ▸ 新 UI 的 window.vc* 綁定（沿用 main.js 模式）───────
   vc-panel HTML（app/index.html 內搬移版）與 vc-* 模組動態生成的 HTML
   （preset 列/選色 chips/toast/crop 工具列）皆以 inline onclick 呼叫全域
   函式；此模組集中將舊版 vc-* 模組 API 曝露到 window，不複製任何實作。
   import 舊版 barrel（video-controls.js）同時完成其模組初始化副作用：
   _migrateMediaFilterKeys / _migrateVideoFilterLinks / _syncLoad（user-data
   跨裝置同步）——與舊 UI 完全同一資料層。 */

import * as VC from '../../viewer/js/video-controls.js';
import { closeDrawer } from './vc-drawer.js';

Object.assign(window, {
  /* 面板 / tab（關閉走 drawer 包裝，順帶清 &drawer= URL 參數） */
  closeVcPanel: closeDrawer,
  vcSwitchTab:  t => VC.vcSwitchTab(t === 'color' ? 'filters' : t),   // 選色已併入濾鏡 tab

  /* 播放 */
  vcSetLoopMode: VC.vcSetLoopMode,
  vcSetSpeed:    VC.vcSetSpeed,
  _vcSetA:       () => VC.vcSetAbPoint(VC.vcGetVid(), 'a'),
  _vcSetB:       () => VC.vcSetAbPoint(VC.vcGetVid(), 'b'),
  _vcToggleAb:   () => VC.vcToggleAbLoop(),
  _vcClearAb:    () => VC.vcClearAb(),
  _vcAbSpanFocus: el => VC.vcAbSpanFocus(el),
  _vcAbSpanEdit:  (pt, el) => VC.vcAbSpanEdit(pt, el),
  vcSaveAbPreset:   () => VC.vcSaveAbPreset(),
  vcLoadAbPreset:   id => VC.vcLoadAbPreset(id),
  vcRenameAbPreset: id => VC.vcRenameAbPreset(id),
  vcDeleteAbPreset: id => VC.vcDeleteAbPreset(id),

  /* 濾鏡 + 濾鏡庫 */
  _vcFilter:      (k, v) => VC.vcSetFilter(k, v),
  vcResetFilters: VC.vcResetFilters,
  vcSaveFilterPreset:      f => VC.vcSaveFilterPreset(f),
  vcApplyFilterPreset:     VC.vcApplyFilterPreset,
  vcToggleVideoFilterPreset: VC.vcToggleVideoFilterPreset,
  vcOverwriteFilterPreset: VC.vcOverwriteFilterPreset,
  vcRenameFilterPreset:    VC.vcRenameFilterPreset,
  vcDeleteFilterPreset:    VC.vcDeleteFilterPreset,
  vcUndoDeletePreset:      VC.vcUndoDeletePreset,

  /* Toast 動作（儲存/沿用/還原/連結） */
  vcDismissToast:     VC.vcDismissToast,
  vcKeepTempFilter:   VC.vcKeepTempFilter,
  vcDiscardTempFilter: VC.vcDiscardTempFilter,
  vcLinkPresetToVideo: VC.vcLinkPresetToVideo,

  /* 選色（WebGL selective color） */
  vcAddSelectiveColor:   VC.vcAddSelectiveColor,
  vcStartEyedropper:     VC.vcStartEyedropper,
  vcClearSelectiveColor: VC.vcClearSelectiveColor,
  vcSetSelectiveHue:     (k, v) => VC.vcSetSelectiveHue(k, v),
  vcSetActiveSelective:  VC.vcSetActiveSelective,
  vcRemoveSelective:     VC.vcRemoveSelective,
  vcBindAbToSelective:   VC.vcBindAbToSelective,
  _vcSelAbEdit:          (pt, el) => VC.vcSelAbEdit(pt, el),
  _vcSelAbNow:           pt => VC.vcSelAbNow(pt),
  vcUnbindAbFromSelective: VC.vcUnbindAbFromSelective,

  /* 幾何 / 裁切 / 快照 */
  _vcTx:       (k, v) => VC.vcSetTx(k, v),
  _vcFlip:     axis => VC.vcFlip(axis),
  _vcRotateBy: deg => VC.vcRotateBy(deg),
  _vcSetRotate: deg => VC.vcSetRotate(deg),
  vcResetTransform:  VC.vcResetTransform,
  vcToggleCropMode:  VC.vcToggleCropMode,
  vcCancelCrop:      VC.vcCancelCrop,
  vcApplyCrop:       VC.vcApplyCrop,
  vcSmartCrop:       VC.vcSmartCrop,
  vcSaveTransformSnapshot:  VC.vcSaveTransformSnapshot,
  vcResetTransformSnapshot: VC.vcResetTransformSnapshot,

  /* 圖片檢視 tab */
  vcImageZoom:       VC.vcImageZoom,
  vcImageZoomSet:    VC.vcImageZoomSet,
  vcImageFit:        VC.vcImageFit,
  vcImageActualSize: VC.vcImageActualSize,

  _vcResetAll: () => VC.vcResetAll(),
});
