/* ── selection.js ▸ 桌面批次選取（B2；C54 桌面子集）─────────────────────
   點擊選取 / Ctrl(⌘)+click 加選 / Shift+click 範圍 / 空白處拖曳框選 marquee /
   Ctrl+A 全選 / Esc 清除。選取集合存於 store（B4 Inspector 消費）。
   卡片內 <a data-noselect>（eagle:///URL）不觸發選取；書籤卡片
   plain click 直接開原始 URL（C24 子集）。 */

import { store } from './store.js';
import { getPositions, getWrap } from './grid.js';
import { openViewerFor } from './viewer.js';

let wrap, gridEl;
let marqueeEl = null;
let dragStart = null;      // {x, y, base:Set}（grid 內容座標）

export function initSelection() {
  wrap = getWrap();
  gridEl = document.getElementById('grid');

  gridEl.addEventListener('click', _onCardClick);
  wrap.addEventListener('mousedown', _onMarqueeStart);
  document.getElementById('btn-select')?.addEventListener('click', () => {
    // 選取模式切換：有選取 → 清除；無 → 提示以點擊/框選開始
    store.state.selection.size ? clearSelection() : _toast('點擊卡片選取；Ctrl 加選、Shift 範圍、空白處拖曳框選');
  });
  document.getElementById('btn-sel-close')?.addEventListener('click', clearSelection);

  document.addEventListener('keydown', e => {
    const typing = /^(input|textarea)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) return;
    if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); selectAll();
    } else if (e.key === 'Enter' && store.state.selection.size === 1) {
      openViewerFor([...store.state.selection][0]);          // Enter = 開啟 Viewer（B3）
    } else if (e.key === 'Escape' && store.state.selection.size &&
               !document.querySelector('.menu') &&
               !document.querySelector('.palette-backdrop.show')) {
      clearSelection();
    }
  });

  _wireLongPress();                                        // 行動長按 500ms 進入多選（C54）
  store.on('selection', _renderBar);
}

/* ── 選取操作 ───────────────────────────────────────────────────────── */

function _commit() { store.emit('selection'); }

export function clearSelection() {
  store.state.selection.clear();
  store.state.selAnchor = -1;
  _commit();
}

export function selectAll() {
  const sel = store.state.selection;
  for (const it of store.state.gridItems) sel.add(it.id);
  _commit();
}

function _onCardClick(e) {
  if (e.target.closest('a[data-noselect]')) return;         // 快速動作連結
  const card = e.target.closest('.vcard');
  if (!card) return;
  const idx = parseInt(card.dataset.idx, 10);
  const items = store.state.gridItems;
  const it = items[idx];
  if (!it) return;
  const sel = store.state.selection;
  const onSelBox = !!e.target.closest('[data-selbox]');

  if (e.shiftKey && store.state.selAnchor >= 0) {
    const [a, b] = [store.state.selAnchor, idx].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) sel.clear();
    for (let i = a; i <= b; i++) sel.add(items[i].id);
  } else if (store.state.trash) {
    sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id);    // 垃圾桶：點擊 = 勾選（C56 自動多選）
    store.state.selAnchor = idx;
  } else if (e.ctrlKey || e.metaKey || onSelBox || sel.size) {
    sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id);    // 加選/取消（選取態下點擊 = toggle）
    store.state.selAnchor = idx;
  } else if (it.mediaType === 'bookmark' && it.url) {
    window.open(it.url, '_blank', 'noopener'); return;      // 書籤：點擊開原始 URL
  } else {
    store.state.selAnchor = idx;                            // 單擊 = 開啟 Viewer（B3）
    openViewerFor(it.id);
    return;
  }
  _commit();
}

/* ── Marquee 框選（空白處拖曳）──────────────────────────────────────── */

function _contentXY(e) {
  const r = wrap.getBoundingClientRect();
  return { x: e.clientX - r.left + wrap.scrollLeft - 16,      // grid-wrap padding
           y: e.clientY - r.top + wrap.scrollTop - 16 };
}

function _onMarqueeStart(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.vcard') || e.target.closest('#grid-msg')) return;
  dragStart = { ..._contentXY(e), base: (e.ctrlKey || e.metaKey) ? new Set(store.state.selection) : new Set() };
  document.addEventListener('mousemove', _onMarqueeMove);
  document.addEventListener('mouseup', _onMarqueeEnd, { once: true });
  e.preventDefault();
}

function _onMarqueeMove(e) {
  if (!dragStart) return;
  const cur = _contentXY(e);
  const x1 = Math.min(dragStart.x, cur.x), y1 = Math.min(dragStart.y, cur.y);
  const x2 = Math.max(dragStart.x, cur.x), y2 = Math.max(dragStart.y, cur.y);
  if (!marqueeEl && (x2 - x1 > 4 || y2 - y1 > 4)) {
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    gridEl.appendChild(marqueeEl);
  }
  if (!marqueeEl) return;
  marqueeEl.style.cssText = `left:${x1}px;top:${y1}px;width:${x2 - x1}px;height:${y2 - y1}px`;

  const sel = store.state.selection;
  sel.clear();
  for (const id of dragStart.base) sel.add(id);
  const pos = getPositions(), items = store.state.gridItems;
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    if (p.x < x2 && p.x + p.w > x1 && p.y < y2 && p.y + p.h > y1) sel.add(items[i].id);
  }
  _commit();
}

function _onMarqueeEnd() {
  document.removeEventListener('mousemove', _onMarqueeMove);
  if (!marqueeEl && dragStart) { clearSelection(); }         // 空白單擊 = 清除
  marqueeEl?.remove();
  marqueeEl = null;
  dragStart = null;
}

/* ── SelectionBar ───────────────────────────────────────────────────── */

function _renderBar() {
  const bar = document.getElementById('selection-bar');
  const n = store.state.selection.size;
  if (!bar) return;
  bar.hidden = n === 0;
  const cnt = document.getElementById('sel-count');
  if (cnt) cnt.textContent = `已選 ${n.toLocaleString()}`;
}

/* ── 行動長按 500ms 進入多選（C54；沿用舊版 batch.js 語意）──────────── */

function _wireLongPress() {
  let timer = null;
  gridEl.addEventListener('touchstart', e => {
    const card = e.target.closest('.vcard');
    if (!card) return;
    const id = card.dataset.id;
    timer = setTimeout(() => {
      const sel = store.state.selection;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      _commit();
      timer = null;
    }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  gridEl.addEventListener('touchmove', cancel, { passive: true });
  gridEl.addEventListener('touchend', () => {
    if (timer !== null) cancel();                            // 短按：交給 click
  }, { passive: true });
}

/* ── Toast ──────────────────────────────────────────────────────────── */

function _toast(msg) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
