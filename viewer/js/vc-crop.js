'use strict';
/* ── vc-crop.js  ▸  智慧裁切 + 手動裁切框 ────────────────────────────
   Smart Crop 黑邊偵測／拖曳裁切 overlay／視覺⇄原生座標換算
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { _VCS, _saveTransformSnapshot } from './vc-state.js';
import { vcApplyTransform, vcRenderTransformActions } from './vc-transform.js';
import { _showToast, vcSyncPanel, closeVcPanel, toggleVcPanel } from './vc-panel.js';

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
  // 全螢幕中建立時掛進 fullscreenElement（否則位於 top layer 之外不可見）
  (document.fullscreenElement || document.body).appendChild(el);
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
export function _vcRefreshCropOverlay() {
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

/* ── 跨模組存取器（_cropState 為 module-level let，收攏於此）─────── */
export function _getCropState() { return _cropState; }

/** 切換影片時靜默清理裁切框（不觸發 panel toggle；供 vcInitVid 使用） */
export function _vcClearCropSilently() {
  if (!_cropState) return;
  _removeCropOverlay();
  _savedTxForCrop = null;
  _cropState      = null;
  const btn = document.getElementById('vc-crop-toggle');
  if (btn) btn.textContent = '✂ 開始手動裁切';
}
