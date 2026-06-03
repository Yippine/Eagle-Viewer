'use strict';
/* ── grid.js  ▸  篩選 / 分頁 / 無限滾動 / Lazy video ────────────────────── */

import { state }                         from './state.js';
import { PAGE, isMobile }                from './utils.js';
import { seededShuffle, currentSeed }    from './shuffle.js';
import { computeFiltered }               from './search.js';
import { buildCard }                     from './renderer.js';

/* ── 無限滾動 sentinel ────────────────────────────────────────────────── */
export const sentinelObs = new IntersectionObserver(
  e => { if (e[0].isIntersecting) appendPage(); },
  { rootMargin: '300px' }
);
sentinelObs.observe(document.getElementById('sentinel'));

/* ── Lazy video（桌面才替換為真實 <video>）───────────────────────────── */
export const vidObs = new IntersectionObserver(entries => {
  entries.forEach(({ isIntersecting, target }) => {
    if (!isIntersecting) return;
    if (isMobile()) { vidObs.unobserve(target); return; }
    const src    = target.dataset.vsrc;
    const poster = target.dataset.vposter;
    if (!src) return;
    const vid = document.createElement('video');
    vid.src = src; vid.preload = 'metadata'; vid.playsInline = true;
    if (poster) vid.poster = poster;
    vid.style.cssText = 'opacity:0;width:100%;height:100%;object-fit:contain;display:block;background:#000;transition:opacity .3s';
    target.innerHTML = ''; target.appendChild(vid);
    target.dataset.snapReplaced = '1';
    // 套用快照 transform 到 preview 影片
    const _snapId = target.dataset.snapId;
    if (_snapId) {
      try {
        const _raw = localStorage.getItem('eagle-transform-' + _snapId);
        if (_raw) {
          const _snap = JSON.parse(_raw);
          if (_snap && !_snap.deleted && _snap.tx) {
            const _tx = _snap.tx;
            const _nW = +target.dataset.snapNw, _nH = +target.dataset.snapNh;
            const _w = target.offsetWidth || target.parentElement?.offsetWidth || 0;
            const _h = target.offsetHeight || target.parentElement?.offsetHeight || 0;
            if (_nW && _nH && _w && _h) {
              const _sx = (_tx.flipH ? -1 : 1) * _tx.scaleX;
              const _sy = (_tx.flipV ? -1 : 1) * _tx.scaleY;
              const _txCss = (_tx.scaleX > 0) ? (_w * _tx.translateX / (_nW * _tx.scaleX)) : 0;
              const _tyCss = (_tx.scaleY > 0) ? (_h * _tx.translateY / (_nH * _tx.scaleY)) : 0;
              vid.style.transform = `scaleX(${_sx.toFixed(4)}) scaleY(${_sy.toFixed(4)}) translateX(${_txCss.toFixed(1)}px) translateY(${_tyCss.toFixed(1)}px) rotate(${_tx.rotate || 0}deg)`;
              vid.style.transformOrigin = 'center center';
            }
          }
        }
      } catch {}
    }
    requestAnimationFrame(() => requestAnimationFrame(() => { vid.style.opacity = '1'; }));
    vid.addEventListener('loadedmetadata', () => {
      // 若 renderer 未能從 metadata 取得尺寸，此處補正（避免保留 16:9 黑邊）
      const ratioBox = target.closest('.ratio-box');
      if (ratioBox && vid.videoWidth && vid.videoHeight) {
        const knownW = parseInt(target.dataset.vw || '0');
        const knownH = parseInt(target.dataset.vh || '0');
        if (!knownW || !knownH) {
          ratioBox.style.aspectRatio = `${vid.videoWidth} / ${vid.videoHeight}`;
          // 實際比例更新後觸發 masonry 重排，避免後續卡片位置錯位
          clearTimeout(_relayoutTimer);
          _relayoutTimer = setTimeout(_relayout, 80);
        }
      }
    }, { once: true });
    vidObs.unobserve(target);
  });
}, { rootMargin: '400px 0px' });

/* ── Snap thumbnail transform ────────────────────────────────────── */
// 公式推導：visible_center_img = containerW/2 - tx_css
//           cx_frac = 0.5 - translateX / (nativeW * scaleX)
// → tx_css = containerW * translateX / (nativeW * scaleX)
function _applySnapThumb(el) {
  if (!el || el.dataset.snapReplaced || el.dataset.snapOk) return;
  const img = el.querySelector('.snap-thumb');
  if (!img) return;
  const itemId = el.dataset.snapId;
  if (!itemId) return;
  try {
    const raw = localStorage.getItem('eagle-transform-' + itemId);
    if (!raw) return;
    const snap = JSON.parse(raw);
    if (!snap || snap.deleted || !snap.tx) return;
    const tx = snap.tx;
    const nW = +el.dataset.snapNw, nH = +el.dataset.snapNh;
    if (!nW || !nH) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const sx = (tx.flipH ? -1 : 1) * tx.scaleX;
    const sy = (tx.flipV ? -1 : 1) * tx.scaleY;
    const txCss = (tx.scaleX > 0) ? (w * tx.translateX / (nW * tx.scaleX)) : 0;
    const tyCss = (tx.scaleY > 0) ? (h * tx.translateY / (nH * tx.scaleY)) : 0;
    img.style.transform = `scaleX(${sx.toFixed(4)}) scaleY(${sy.toFixed(4)}) translateX(${txCss.toFixed(1)}px) translateY(${tyCss.toFixed(1)}px) rotate(${tx.rotate || 0}deg)`;
    el.dataset.snapOk = '1';
  } catch {}
}

export function updateSnapThumb(el, itemId) {
  if (!el) return;
  // 已被 vidObs 替換為 <video>：只更新 video 的 CSS transform，不操作 img
  if (el.dataset.snapReplaced) {
    const vid = el.querySelector('video');
    if (!vid) return;
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem('eagle-transform-' + itemId) || 'null'); } catch {}
    if (snap && !snap.deleted && snap.tx) {
      const tx = snap.tx;
      const nW = +el.dataset.snapNw, nH = +el.dataset.snapNh;
      const w  = el.offsetWidth  || el.parentElement?.offsetWidth  || 0;
      const h  = el.offsetHeight || el.parentElement?.offsetHeight || 0;
      if (nW && nH && w && h) {
        const sx = (tx.flipH ? -1 : 1) * tx.scaleX;
        const sy = (tx.flipV ? -1 : 1) * tx.scaleY;
        const txCss = (tx.scaleX > 0) ? (w * tx.translateX / (nW * tx.scaleX)) : 0;
        const tyCss = (tx.scaleY > 0) ? (h * tx.translateY / (nH * tx.scaleY)) : 0;
        vid.style.transform = `scaleX(${sx.toFixed(4)}) scaleY(${sy.toFixed(4)}) translateX(${txCss.toFixed(1)}px) translateY(${tyCss.toFixed(1)}px) rotate(${tx.rotate || 0}deg)`;
        vid.style.transformOrigin = 'center center';
      } else {
        vid.style.transform = '';
      }
    } else {
      vid.style.transform = '';
    }
    return;
  }
  let snap = null;
  try {
    const raw = localStorage.getItem('eagle-transform-' + itemId);
    snap = raw ? JSON.parse(raw) : null;
  } catch {}
  const hasTx = snap && !snap.deleted && snap.tx;
  const existingImg = el.querySelector('.snap-thumb');
  const thumbSrc = el.dataset.vposter;
  if (hasTx) {
    if (!existingImg && thumbSrc) {
      el.style.background = '';
      el.classList.add('vid-snap');
      if (!el.dataset.snapNw && el.dataset.vw) el.dataset.snapNw = el.dataset.vw;
      if (!el.dataset.snapNh && el.dataset.vh) el.dataset.snapNh = el.dataset.vh;
      const img = document.createElement('img');
      img.className = 'snap-thumb'; img.src = thumbSrc; img.alt = ''; img.loading = 'lazy';
      el.insertBefore(img, el.firstChild);
    }
    delete el.dataset.snapOk;
    _applySnapThumb(el);
  } else if (!hasTx && (existingImg || el.classList.contains('vid-snap'))) {
    if (existingImg) existingImg.remove();
    el.classList.remove('vid-snap');
    delete el.dataset.snapOk;
    if (thumbSrc) el.style.background = `url('${thumbSrc.replace(/'/g, "\\'")}') center/cover no-repeat`;
  }
}

document.addEventListener('vc-snap-changed', ({ detail: { itemId } }) => {
  const el = document.querySelector(`.vid-lazy[data-snap-id="${CSS.escape(itemId)}"]`);
  if (el) updateSnapThumb(el, itemId);
});

document.addEventListener('vc-snaps-synced', () => {
  document.querySelectorAll('.vid-lazy[data-snap-id]').forEach(el => {
    const itemId = el.dataset.snapId;
    if (itemId) { delete el.dataset.snapOk; updateSnapThumb(el, itemId); }
  });
});

/* ── 排序輔助：依 key + dir 排列項目（不影響 shuffle 路徑）────────── */
function _sortItems(arr, key, dir) {
  const a = [...arr];
  const sign = dir === 'asc' ? 1 : -1;
  switch (key) {
    case 'date':  return a.sort((x, y) => sign * (x.id > y.id ? 1 : -1));
    case 'mtime': return a.sort((x, y) => sign * ((x.mtime ?? 0) - (y.mtime ?? 0)));
    case 'name':  return a.sort((x, y) => sign * x.name.localeCompare(y.name, 'zh-TW'));
    case 'ext':   return a.sort((x, y) => {
      const ex = (x.ext || '').toLowerCase();
      const ey = (y.ext || '').toLowerCase();
      const cmp = ex.localeCompare(ey, 'zh-TW');
      return cmp !== 0 ? sign * cmp : sign * x.name.localeCompare(y.name, 'zh-TW');
    });
    case 'dim':   return a.sort((x, y) => {
      const da = (x.width ?? 0) * (x.height ?? 0);
      const db = (y.width ?? 0) * (y.height ?? 0);
      return sign * (da - db);
    });
    case 'duration': return a.sort((x, y) => sign * ((x.duration ?? 0) - (y.duration ?? 0)));
    case 'star':  return a.sort((x, y) => sign * ((x.star ?? 0) - (y.star ?? 0)));
    case 'size':  return a.sort((x, y) => sign * ((x.size ?? 0) - (y.size ?? 0)));
    default: return a;
  }
}

/* ── JS Masonry 引擎（排序模式專用）────────────────────────────────── */
let _masonryCols = [];  // 各欄當前高度（px）


function _getColCount() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--col')) || 4;
}
function _getGapPx() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 14;
}

function _masonryLayout(gridEl, cards) {
  if (!cards.length) return;
  if (gridEl.offsetWidth === 0) return;

  const cols = _getColCount();
  const gap  = _getGapPx();
  const colW = (gridEl.offsetWidth - gap * (cols - 1)) / cols;

  if (_masonryCols.length !== cols) _masonryCols = new Array(cols).fill(0);

  /* Phase 1：設定欄寬 + position:absolute（觸發單次 reflow）*/
  cards.forEach(card => {
    card.style.width        = colW + 'px';
    card.style.position     = 'absolute';
    card.style.marginBottom = '0';
  });

  /* Phase 2：批次讀實際高度（img 有 width/height HTML attr → 未載入也精準）*/
  const heights = cards.map(card => card.offsetHeight);

  /* Phase 3：HorizontalOrder 放置（ε = 2px，補浮點誤差，選最左等高欄）*/
  const epsilon = 2;
  cards.forEach((card, i) => {
    const minH = Math.min(..._masonryCols);
    let col = 0;
    for (let c = 0; c < cols; c++) {
      if (_masonryCols[c] <= minH + epsilon) { col = c; break; }
    }
    card.style.left = (col * (colW + gap)) + 'px';
    card.style.top  = _masonryCols[col] + 'px';
    _masonryCols[col] += heights[i] + gap;
  });

  gridEl.style.height = Math.max(..._masonryCols) + 'px';
}

/** 視窗 resize 後重新定位（debounce 150ms）*/
export function _relayout() {
  if (state.curSortKey === 'shuffle') return;
  const gridEl = document.getElementById('grid');
  _masonryCols = [];
  _masonryLayout(gridEl, [...gridEl.querySelectorAll('.card')]);
}
let _resizeTimer;
let _relayoutTimer;
window.addEventListener('resize', () => { clearTimeout(_resizeTimer); _resizeTimer = setTimeout(_relayout, 150); });

/* ── applyFilter：重算 filtered 並重繪 grid ─────────────────────────── */
export function applyFilter() {
  const base = computeFiltered();
  if (state.curSortKey === 'shuffle') {
    state.shuffled = seededShuffle(base, currentSeed());
    state.filtered = state.shuffled;
  } else {
    state.filtered = _sortItems(base, state.curSortKey, state.curSortDir);
  }
  state.page   = 0;
  _masonryCols = [];
  const gridEl     = document.getElementById('grid');
  const isMasonry  = state.curSortKey !== 'shuffle';
  gridEl.classList.toggle('grid--masonry', isMasonry);
  if (!isMasonry) gridEl.style.height = '';  // 恢復 column-count 自然高度
  gridEl.innerHTML = '';
  document.getElementById('ibar').textContent = `顯示 ${state.filtered.length} / ${state.ALL.length} 筆`;
  if (!state.filtered.length) {
    gridEl.style.height = '';  // 清除 masonry 舊高度（避免空狀態在高容器中偏移）
    gridEl.innerHTML = `<div class="state-empty"><div class="ei">🔍</div><span>沒有符合的項目</span></div>`;
    return;
  }
  appendPage();
}

/* ── appendPage：渲染下一頁卡片 ────────────────────────────────────── */
export function appendPage() {
  const start = state.page * PAGE;
  if (start >= state.filtered.length) return;
  state.page++;                              // 立即遞增，封鎖 IO 競態重入
  const loader = document.getElementById('loader');
  loader.classList.add('visible');
  requestAnimationFrame(() => {
    const slice    = state.filtered.slice(start, start + PAGE);
    const frag     = document.createDocumentFragment();
    const tmp      = document.createElement('div');
    const newCards = [];
    slice.forEach(item => {
      tmp.innerHTML = buildCard(item);
      while (tmp.firstChild) {
        const el = tmp.firstChild;
        if (el.nodeType === 1 && el.classList?.contains('card')) newCards.push(el);
        frag.appendChild(el);
      }
    });
    const gridEl = document.getElementById('grid');
    gridEl.appendChild(frag);
    if (state.curSortKey !== 'shuffle') _masonryLayout(gridEl, newCards);
    loader.classList.remove('visible');
    gridEl.querySelectorAll('.vid-lazy[data-vsrc]:not([data-obs])').forEach(el => {
      el.dataset.obs = '1'; vidObs.observe(el);
    });
    gridEl.querySelectorAll('.vid-snap[data-snap-id]:not([data-snap-ok])').forEach(_applySnapThumb);
    // 對沒有明確尺寸的圖片（如 Excire Foto），載入後觸發 relayout
    newCards.forEach(card => {
      const img = card.querySelector('img.nat:not([width])');
      if (img && !img.complete) {
        img.addEventListener('load', () => {
          clearTimeout(_relayoutTimer);
          _relayoutTimer = setTimeout(_relayout, 80);
        }, { once: true });
      }
    });
  });
}
