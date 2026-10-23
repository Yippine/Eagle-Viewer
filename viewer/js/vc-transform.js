'use strict';
/* ── vc-transform.js  ▸  幾何變換 + per-video 快照 ───────────────────
   vcApplyTransform／scale・translate・flip・rotate setter／快照存取
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { _VCS, _isTxDefault, _loadTransformSnapshot,
         _saveTransformSnapshot, _deleteTransformSnapshot } from './vc-state.js';
import { _hasActiveSel }          from './vc-webgl.js';
import { _scheduleCanvasUpdate }  from './vc-canvas.js';
import { _getCropState, _vcRefreshCropOverlay, vcApplyCrop } from './vc-crop.js';
import { _showToast, vcSyncPanel } from './vc-panel.js';

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
   Transform Snapshot（per-video 幾何快照）
══════════════════════════════════════════════════════════════════ */
export function vcSaveTransformSnapshot() {
  if (!_VCS._itemId) return;
  // 裁切框模式下，等同「套用裁切」——計算裁切值後存快照
  if (_getCropState()) { vcApplyCrop(); return; }
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
   Apply（幾何）
══════════════════════════════════════════════════════════════════ */
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
    if (_getCropState()) _vcRefreshCropOverlay();
    if (_hasActiveSel()) _scheduleCanvasUpdate();
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
  if (_getCropState()) _vcRefreshCropOverlay();
  // GL canvas overlay 需跟著幾何變更重新對位（位移/翻轉/旋轉重置後同步）
  if (_hasActiveSel()) _scheduleCanvasUpdate();
}

/* ── Setter（幾何）────────────────────────────────────────────── */
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

/* ── Reset（幾何）─────────────────────────────────────────────── */
export function vcResetTransform() {
  _VCS.tx          = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                        rotate: 0, flipH: false, flipV: false };
  _VCS._autoRotate = 0;
  const vid = _VCS._vid;
  if (vid) vcApplyTransform(vid);  // 必須透過 vcApplyTransform，才會同步 GL canvas
  vcSyncPanel();
}
