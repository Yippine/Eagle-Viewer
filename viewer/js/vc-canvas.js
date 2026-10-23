'use strict';
/* ── vc-canvas.js  ▸  Canvas 像素處理 + Canvas Pipeline ──────────────
   HSL 轉換／模糊／銳化／選擇性色相（JS fallback）／canvas 排程
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { _VCS } from './vc-state.js';
import { _glInit, _glUploadTexture, _glUploadVideoFrame, _glRender,
         _glEnsureAttached, _glShowCanvas,
         _hasActiveSel, _getTimedSelective } from './vc-webgl.js';

/* ══════════════════════════════════════════════════════════════════
   Canvas 工具：HSL 轉換 / 模糊 / 銳化 / 選擇性色相
══════════════════════════════════════════════════════════════════ */
export function _rgbToHsl(r, g, b) {
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
    // shader 路徑：additive（hsl.y + uDeltaS）；JS fallback：additive delta（slider 值域 [-1,1]）
    const s2 = clamp(s + dSat);
    const l2 = clamp(l + dBri);

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
let _canvasRaf = null;

export function _needsCanvas() {
  const hasSelective = _VCS.selectiveList.some(s => s.targetHue !== null);
  if (_VCS._mediaType === 'video') return hasSelective;
  return (_VCS.filter.sharpness > 0 || hasSelective);
}

export function _releaseCanvas() {
  if (_VCS._canvasObjectURL) { URL.revokeObjectURL(_VCS._canvasObjectURL); _VCS._canvasObjectURL = null; }
}

export function _scheduleCanvasUpdate() {
  if (_canvasRaf) return;
  _canvasRaf = requestAnimationFrame(() => { _canvasRaf = null; _runCanvasPipeline(); });
}

async function _runCanvasPipeline() {
  const img = _VCS._vid;
  if (!img) return;
  if (_VCS._mediaType === 'video') {
    const vid = img;
    if (!vid.videoWidth || !vid.videoHeight) { _glShowCanvas(false); return; }
    if (vid.readyState < 2) { _glShowCanvas(false); return; }  // 尚未解碼第一幀，避免顯示舊紋理
    const _tActive = _getTimedSelective();
    if (!_tActive.length) { _glShowCanvas(false); return; }
    if (_glInit(vid)) {
      // resize 上傳 → render → show 必須在同一同步流程完成，避免顯示清黑瞬態
      _glUploadVideoFrame(vid);
      _glRender(_tActive);
      _glEnsureAttached(vid);
      _glShowCanvas(true);
    }
    return;
  }
  // 必須在 img.src 被替換成 blob 之前捕捉 originalSrc
  if (!_VCS._imgOriginalSrc) _VCS._imgOriginalSrc = img.src;
  const src = _VCS._imgOriginalSrc;
  if (!src) return;

  const srcImg = new Image();
  srcImg.src = src;
  if (!srcImg.complete) await new Promise((res, rej) => { srcImg.onload = res; srcImg.onerror = rej; });

  // WebGL selective color path（優先）——只在至少一個 item 已取色時啟用
  const hasActiveSel = _hasActiveSel();
  if (hasActiveSel) {
    if (_glInit(img)) {
      _glUploadTexture(srcImg);
      _glRender(_VCS.selectiveList);
      _glEnsureAttached(img);   // 對齊 img 的 layout 尺寸、位置、transform
      _glShowCanvas(true);
      return;
    }
  }
  _glShowCanvas(false);

  const canvas = document.createElement('canvas');
  canvas.width  = srcImg.naturalWidth  || srcImg.width;
  canvas.height = srcImg.naturalHeight || srcImg.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, desynchronized: true });
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

export function _restoreOriginalSrc() {
  const img = _VCS._vid;
  if (!img || !_VCS._imgOriginalSrc) return;
  _releaseCanvas();
  img.src = _VCS._imgOriginalSrc;
}
