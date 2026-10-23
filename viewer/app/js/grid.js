/* ── grid.js ▸ 虛擬滾動 masonry grid（B2，單引擎）───────────────────────
   設計（spec §1.3 / 開放事項 2：自寫、零依賴）：
   - 一次算出全部卡片座標（O(n)，6 萬項 < 10ms），#grid 設總高，
     只掛載可視窗 ± BUF 範圍內的卡片（DOM 恆 < ~120 張）。
   - 兩種資料模式共用：list（Eagle/dir 全量）與 paged（Excire offset/limit，
     捲近底部觸發 onNeedMore 無限捲動）。
   - 卡片：縮圖 / 時長 badge / 星等 / 選取狀態 / hover 快速動作（eagle:// + URL）。 */

import { store } from './store.js';
import { mediaURL } from './api.js';
import { h, fmtDuration, sortMetaText } from './items.js';

const BUF = 900;                                          // 可視範圍上下緩衝 px
const DENSITY_W = { comfy: 300, cozy: 225, compact: 165 };  // 目標卡寬
const META_H = 54;                                        // cbody 固定高（clean mode = 0）
const GAP = 12;

let wrap, gridEl, loaderEl;
let items = [];            // 顯示清單（篩選/排序後）
let total = 0;             // 顯示 n / m 的 m
let hasMore = false, loading = false, onNeedMore = null;
let pos = [];              // [{x,y,w,h,th}] th = 縮圖高
let gridH = 0, colW = 0;
let mounted = new Map();   // idx → element
let rafId = 0, resizeTimer = 0;

/* ── 公開 API ───────────────────────────────────────────────────────── */

export function initGrid(opts = {}) {
  wrap    = document.getElementById('grid-wrap');
  gridEl  = document.getElementById('grid');
  loaderEl = document.getElementById('grid-loader');
  onNeedMore = opts.onNeedMore || null;
  gridEl.classList.add('vgrid');
  wrap.addEventListener('scroll', _schedule, { passive: true });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(), 150);
  });
  store.on('selection', _syncSelection);
  store.on('view-changed', () => relayout());
}

/** 重設顯示清單（篩選/排序/換庫後） */
export function setItems(list, opts = {}) {
  items = list;
  total = opts.total ?? list.length;
  hasMore = !!opts.hasMore;
  store.set({ gridItems: items, gridTotal: total }, 'grid-items');
  _unmountAll();
  gridEl.hidden = false;
  if (opts.keepScroll !== true) wrap.scrollTop = 0;
  _layout(0);
  _render();
  _updateIbar();
  if (!items.length && !hasMore) {
    _showEmpty();
  } else {
    _clearMessage();
  }
}

/** 追加分頁（Excire 無限捲動） */
export function appendItems(list, opts = {}) {
  const from = items.length;
  items = items.concat(list);
  if (opts.total != null) total = opts.total;
  if (opts.hasMore != null) hasMore = !!opts.hasMore;
  store.set({ gridItems: items, gridTotal: total }, 'grid-items');
  _clearMessage();
  _layout(from);
  _render();
  _updateIbar();
  if (!items.length && !hasMore) _showEmpty();
}

export function setLoading(v) {
  loading = !!v;
  if (loaderEl) loaderEl.hidden = !v;
}

export function getPositions() { return pos; }
export function getWrap() { return wrap; }

/* 空狀態客製（app.js 註冊：篩選無結果時提供「改用 AI 語意搜尋」CTA） */
let _emptyProvider = null;
export function setEmptyStateProvider(fn) { _emptyProvider = fn; }

function _showEmpty() {
  const es = _emptyProvider?.();
  if (es) showMessage(es.icon || 'image', es.title || '沒有項目', es.note || '', es.actionHTML || '');
  else showMessage('image', '沒有項目', '調整篩選條件或切換資料夾');
}

/** 空狀態 / 錯誤 / 佔位頁訊息（佔用 grid 區域） */
export function showMessage(iconName, title, note = '', actionHTML = '') {
  items = []; pos = []; gridH = 0; hasMore = false;
  _unmountAll();
  gridEl.style.height = '0px';
  gridEl.hidden = true;
  let msg = document.getElementById('grid-msg');
  if (!msg) {
    msg = document.createElement('div');
    msg.id = 'grid-msg';
    msg.className = 'empty-state';
    wrap.appendChild(msg);
  }
  msg.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${iconName}"/></svg>
    <p class="empty-title">${h(title)}</p>${note ? `<p>${h(note)}</p>` : ''}${actionHTML}`;
  msg.hidden = false;
}

/** 重新計算欄數與座標（resize / 密度 / clean mode） */
export function relayout() {
  if (!items.length) return;
  _layout(0);
  _unmountAll();
  _render();
}

/* ── 佈局 ───────────────────────────────────────────────────────────── */

let _cols = [];   // 各欄高度

function _layout(from) {
  const w = wrap.clientWidth - 32;                        // grid-wrap padding 16×2
  const target = DENSITY_W[store.state.density] || DENSITY_W.cozy;
  const n = Math.max(1, Math.round((w + GAP) / (target + GAP)));
  colW = (w - GAP * (n - 1)) / n;
  const metaH = store.state.clean ? 0 : META_H;
  if (from === 0) { _cols = new Array(n).fill(0); pos = []; }
  const eps = 2;
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    const ratio = it.width && it.height
      ? Math.min(Math.max(it.height / it.width, 0.4), 2.2) : 1;
    const th = Math.round(colW * ratio);
    const chH = th + metaH;
    const minH = Math.min(..._cols);
    let c = 0;
    for (let k = 0; k < _cols.length; k++)
      if (_cols[k] <= minH + eps) { c = k; break; }
    pos[i] = { x: Math.round(c * (colW + GAP)), y: _cols[c], w: Math.round(colW), h: chH, th };
    _cols[c] += chH + GAP;
  }
  gridH = pos.length ? Math.max(..._cols) : 0;
  gridEl.style.height = gridH + 'px';
}

/* ── 虛擬渲染 ───────────────────────────────────────────────────────── */

function _schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; _render(); });
}

function _render() {
  if (!wrap) return;
  const top = wrap.scrollTop - BUF;
  const bot = wrap.scrollTop + wrap.clientHeight + BUF;
  const want = new Set();
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    if (p.y + p.h >= top && p.y <= bot) want.add(i);
  }
  for (const [i, el] of mounted) {
    if (!want.has(i)) { el.remove(); mounted.delete(i); }
  }
  for (const i of want) {
    if (!mounted.has(i)) {
      const el = _cardEl(items[i], i);
      gridEl.appendChild(el);
      mounted.set(i, el);
    }
  }
  // 無限捲動：接近底部且還有分頁 → 通知資料源
  if (hasMore && !loading && onNeedMore &&
      wrap.scrollTop + wrap.clientHeight > gridH - 1500) {
    onNeedMore();
  }
}

function _unmountAll() {
  for (const el of mounted.values()) el.remove();
  mounted.clear();
}

/* ── 卡片 ───────────────────────────────────────────────────────────── */

const _icon = name => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function _cardEl(it, idx) {
  const p = pos[idx];
  const sel = store.state.selection.has(it.id);
  const thumb = it.thumb ? mediaURL(it.thumb) + (it.thumbV ? `?v=${it.thumbV}` : '') : '';   // B4：cache-bust
  const clean = store.state.clean;

  const kindBadge =
    it.mediaType === 'video'    ? `<span class="kind-badge">${_icon('video')}</span>` :
    it.mediaType === 'gif'      ? `<span class="kind-badge txt">GIF</span>` :
    it.mediaType === 'bookmark' ? `<span class="kind-badge">${_icon('bookmark')}</span>` : '';
  const durBadge  = it.duration ? `<span class="dur-badge">${fmtDuration(it.duration)}</span>` : '';
  const starBadge = it.star ? `<span class="star-badge">★${it.star}</span>` : '';
  // AI 搜尋虛擬視圖：相似度分數 badge（B5；ai-search.js 附掛 _score）
  const scoreBadge = it._score != null
    ? `<span class="score-badge" title="相似度分數">${it._score.toFixed(2)}</span>` : '';

  // hover 快速動作（C24/C68 子集：eagle:// 深連結 + 原始 URL）
  const acts = [];
  if (it.source === 'eagle')
    acts.push(`<a class="ov-btn" href="eagle://item/${h(it.id)}" title="在 Eagle 中開啟" data-noselect>${_icon('library-eagle')}</a>`);
  if (it.url)
    acts.push(`<a class="ov-btn" href="${h(it.url)}" target="_blank" rel="noopener" title="開啟原始連結" data-noselect>${_icon('external')}</a>`);
  const ovBar = acts.length ? `<div class="ov-actions">${acts.join('')}</div>` : '';

  const meta = sortMetaText(it, store.state.sort.key);
  const metaLine = [it.domain && it.domain !== 'local' ? it.domain : '', meta]
    .filter(Boolean).join(' · ');

  const el = document.createElement('article');
  el.className = 'card vcard' + (sel ? ' selected' : '');
  el.dataset.idx = idx;
  el.dataset.id = it.id;
  el.style.cssText = `transform:translate(${p.x}px,${p.y}px);width:${p.w}px`;
  el.innerHTML = `
    <div class="card-thumb" style="height:${p.th}px">
      ${thumb ? `<img src="${h(thumb)}" alt="" decoding="async" loading="lazy" fetchpriority="low" onerror="this.hidden=true">`
              : `<div class="no-thumb">${_icon(it.mediaType === 'bookmark' ? 'bookmark' : 'image')}</div>`}
      ${kindBadge}${durBadge}${starBadge}${scoreBadge}${ovBar}
      <span class="sel-box" data-selbox title="選取">${_icon('check')}</span>
    </div>
    ${clean ? '' : `<div class="cbody">
      <div class="card-title" title="${h(it.name)}">${h(it.name)}</div>
      <div class="card-meta">${h(metaLine)}</div>
    </div>`}`;
  return el;
}

/* ── 同步 ───────────────────────────────────────────────────────────── */

function _syncSelection() {
  const sel = store.state.selection;
  for (const [i, el] of mounted)
    el.classList.toggle('selected', sel.has(items[i]?.id));
}

function _updateIbar() {
  const el = document.getElementById('ibar-count');
  if (!el) return;
  const n = items.length;
  el.textContent = total || n
    ? `顯示 ${n.toLocaleString()} / ${Math.max(total, n).toLocaleString()} 筆${hasMore ? '（捲動載入更多）' : ''}`
    : '';
}

function _clearMessage() {
  const msg = document.getElementById('grid-msg');
  if (msg) msg.hidden = true;
  gridEl.hidden = false;
}
