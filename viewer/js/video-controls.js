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
  ab:     { a: null, b: null, active: false },
  _vid:   null,
};

export function vcGetVid() { return _VCS._vid; }

/* ── 新影片載入時呼叫（保留 filter/tx 設定、重設 AB） ───────────── */
export function vcInitVid(vid) {
  _VCS._vid = vid;
  _VCS.ab   = { a: null, b: null, active: false };
  vcApplyFilter(vid);
  vcApplyTransform(vid);
  vcSyncPanel();
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
  if (opening && window.innerWidth <= 768) {
    // 每次開啟重置為預設高度
    panel.style.maxHeight = Math.round(window.innerHeight * _VC_DEFAULT_H) + 'px';
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
}
