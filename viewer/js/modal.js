'use strict';
/* ── modal.js  ▸  Lightbox 模態視窗（桌面圖片 / 影片預覽）─────────────── */

let _modalHistoryPushed = false;

/* ══════════════════════════════════════════════════════════════════════════
   圖片縮放 / 平移狀態（Image Zoom，縮寫 _IZ）
   ─ s        : 縮放比例 1–8
   ─ px / py  : 平移量（px），相對 #mbody 中心
   ─ ncx / ncy: #mbody 中心的螢幕座標（首次互動時快取）
   ══════════════════════════════════════════════════════════════════════════ */
const _IZ = {
  active   : false,
  s        : 1,
  px       : 0,    py       : 0,
  ncx      : null, ncy      : null,
  dragging : false,
  lastX    : 0,    lastY    : 0,
  didDrag  : false,
  hideTimer: null,
};

function _izReset() {
  _IZ.active = false;
  _IZ.s = 1; _IZ.px = 0; _IZ.py = 0;
  _IZ.ncx = null; _IZ.ncy = null;
  _IZ.dragging = false; _IZ.didDrag = false;
  clearTimeout(_IZ.hideTimer);
}

/* 確保自然中心已快取（#mbody 固定大小後才讀取） */
function _izEnsureCenter() {
  if (_IZ.ncx !== null) return true;
  const mbody = document.getElementById('mbody');
  if (!mbody) return false;
  const r = mbody.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  _IZ.ncx = r.left + r.width  / 2;
  _IZ.ncy = r.top  + r.height / 2;
  return true;
}

/* 套用 transform 到 img */
function _izApply(img) {
  if (_IZ.s <= 1.001) {
    img.style.transform = '';
    img.classList.remove('iz-zoomed', 'iz-dragging');
  } else {
    img.style.transform =
      `translate(${_IZ.px.toFixed(1)}px,${_IZ.py.toFixed(1)}px) scale(${_IZ.s.toFixed(3)})`;
    img.classList.add('iz-zoomed');
    img.classList.toggle('iz-dragging', _IZ.dragging);
  }
}

/* 顯示縮放倍率指示器 */
function _izIndicator() {
  const zi = document.getElementById('m-zoom-ind');
  if (!zi) return;
  clearTimeout(_IZ.hideTimer);
  if (_IZ.s > 1.01) {
    zi.textContent = `${Math.round(_IZ.s * 100)}%`;
    zi.classList.add('show');
    _IZ.hideTimer = setTimeout(() => zi.classList.remove('show'), 1500);
  } else {
    zi.textContent = '';
    zi.classList.remove('show');
  }
}

/* ── 滾輪縮放：以游標位置為焦點 ──────────────────────────────────── */
function _izWheel(e) {
  if (!_IZ.active) return;
  e.preventDefault();
  const img = document.querySelector('#mbody img');
  if (!img || !_izEnsureCenter()) return;

  const oldS = _IZ.s;
  const step = e.deltaY < 0 ? 0.15 : -0.15;
  const newS = Math.max(1, Math.min(8, oldS + step));

  if (newS <= 1.01) {
    _IZ.s = 1; _IZ.px = 0; _IZ.py = 0;
  } else {
    /* 維持游標下方的圖片內容不動：
       新平移 = cursor - ncx - (cursor - ncx - 舊平移) × (新倍率 / 舊倍率) */
    const ratio = newS / oldS;
    const cx = e.clientX, cy = e.clientY;
    _IZ.px = cx - _IZ.ncx - (cx - _IZ.ncx - _IZ.px) * ratio;
    _IZ.py = cy - _IZ.ncy - (cy - _IZ.ncy - _IZ.py) * ratio;
    _IZ.s  = newS;
  }

  _izApply(img);
  _izIndicator();
}

/* ── 拖曳平移（縮放時才作用）────────────────────────────────────── */
function _izMouseDown(e) {
  if (!_IZ.active || _IZ.s <= 1 || e.button !== 0) return;
  _IZ.dragging = true;
  _IZ.didDrag  = false;
  _IZ.lastX    = e.clientX;
  _IZ.lastY    = e.clientY;
  const img = e.currentTarget;
  img.classList.add('iz-dragging');
  e.preventDefault();   // 防止文字選取
}

function _izMouseMove(e) {
  if (!_IZ.dragging) return;
  const dx = e.clientX - _IZ.lastX;
  const dy = e.clientY - _IZ.lastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) _IZ.didDrag = true;
  _IZ.lastX = e.clientX;
  _IZ.lastY = e.clientY;
  _IZ.px += dx;
  _IZ.py += dy;
  const img = document.querySelector('#mbody img');
  if (img) _izApply(img);
}

function _izMouseUp() {
  if (!_IZ.dragging) return;
  _IZ.dragging = false;
  const img = document.querySelector('#mbody img');
  if (img) {
    img.classList.remove('iz-dragging');
    if (_IZ.s > 1) img.classList.add('iz-zoomed');
  }
}

/* 拖曳結束後的 click 事件可能觸發背景關閉，在 capture 階段攔截 */
function _izClickCapture(e) {
  if (_IZ.didDrag) {
    _IZ.didDrag = false;
    e.stopPropagation();
  }
}

/* ── 雙擊重置縮放 ─────────────────────────────────────────────────── */
function _izDblClick(e) {
  e.stopPropagation();
  _IZ.s = 1; _IZ.px = 0; _IZ.py = 0;
  _izApply(e.currentTarget);
  _izIndicator();
}

/* ── 點擊 #mbox / #mbody 的空白區域關閉（img-mode 專用）────────── */
function _izMboxClick(e) {
  const img = document.querySelector('#mbody img');
  if (e.target !== img) closeModal();
}

/* ════════════════════════════════════════════════════════════════════
   openModal / closeModal
   ════════════════════════════════════════════════════════════════════ */
export function openModal(src, type) {
  _izReset();
  const mbody = document.getElementById('mbody');
  const mbox  = document.getElementById('mbox');
  mbody.innerHTML = '';

  if (type === 'image') {
    mbox.classList.add('img-mode');
    _IZ.active = true;

    const img = document.createElement('img');
    img.alt = '';
    img.src = src;

    /* 預熱自然中心快取（等 DOM paint 後） */
    requestAnimationFrame(() => _izEnsureCenter());

    img.addEventListener('mousedown', _izMouseDown);
    img.addEventListener('dblclick',  _izDblClick);
    mbody.appendChild(img);

    /* 點擊 #mbox / #mbody 空白區域（letterbox）→ 關閉 */
    mbox.addEventListener('click', _izMboxClick);

    /* 滾輪在整個 modal 範圍都可使用（capture 以確保 preventDefault 生效） */
    document.addEventListener('wheel',     _izWheel,       { passive: false, capture: true });
    document.addEventListener('mousemove', _izMouseMove);
    document.addEventListener('mouseup',   _izMouseUp);
    document.addEventListener('click',     _izClickCapture, true);
  } else {
    mbox.classList.remove('img-mode');
    const vid = document.createElement('video');
    vid.src = src; vid.controls = true; vid.autoplay = true;
    vid.setAttribute('playsinline', '');
    mbody.appendChild(vid);
  }

  document.getElementById('modal').classList.add('open');
  history.pushState({ overlay: 'modal' }, '');
  _modalHistoryPushed = true;
}

export function closeModal(fromPopstate = false) {
  if (!document.getElementById('modal').classList.contains('open')) return;
  const v = document.querySelector('#mbody video');
  if (v) { v.pause(); v.src = ''; }
  document.getElementById('modal').classList.remove('open');
  document.getElementById('mbox').classList.remove('img-mode');
  document.getElementById('mbody').innerHTML = '';

  document.getElementById('mbox').removeEventListener('click', _izMboxClick);
  document.removeEventListener('wheel',     _izWheel,       { capture: true });
  document.removeEventListener('mousemove', _izMouseMove);
  document.removeEventListener('mouseup',   _izMouseUp);
  document.removeEventListener('click',     _izClickCapture, true);

  _izReset();
  if (!fromPopstate && _modalHistoryPushed) history.back();
  _modalHistoryPushed = false;
}
