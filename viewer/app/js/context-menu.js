/* ── context-menu.js ▸ 卡片右鍵選單（B4，狀態感知）───────────────────────
   單項 / 多選 / 垃圾桶 / Excire 唯讀 四種狀態自動切換選項；
   定位翻轉（貼視窗邊界收斂）+ 鍵盤導覽（↑↓ Enter Esc）。
   右鍵目標不在現有選取內 → 改為單選該卡片。 */

import { store } from './store.js';
import { h } from './items.js';
import { openViewerFor } from './viewer.js';
import * as act from './actions.js';

let _menu = null;

export function initContextMenu() {
  document.getElementById('grid')?.addEventListener('contextmenu', _onContext);
  document.addEventListener('click', e => { if (_menu && !_menu.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', _onKey, true);
  window.addEventListener('blur', close);
  store.on('grid-items', close);
}

export function close() { _menu?.remove(); _menu = null; }

/* ── 開啟 ───────────────────────────────────────────────────────────── */

function _onContext(e) {
  const card = e.target.closest('.vcard');
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  const sel = store.state.selection;
  if (!sel.has(id)) {                       // 右鍵目標不在選取內 → 單選它
    sel.clear();
    sel.add(id);
    store.state.selAnchor = parseInt(card.dataset.idx, 10) || 0;
    store.emit('selection');
  }
  const ids = [...sel];
  const items = store.state.allItems.filter(i => sel.has(i.id));
  if (!items.length) return;
  _open(e.clientX, e.clientY, ids, items);
}

function _open(x, y, ids, items) {
  close();
  const single = items.length === 1;
  const it = items[0];
  const ro = act.isReadOnly(items);
  const trash = !!store.state.trash;
  const allArchived = items.every(i => (i.tags || []).includes('archived'));
  const roAttr = ro ? ' disabled title="Excire 庫為唯讀"' : '';

  const mi = (action, label, icon = '', extra = '') =>
    `<button class="menu-item" role="menuitem" data-action="${action}"${extra}>
       ${icon ? `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${icon}"/></svg>` : ''}${h(label)}</button>`;
  const sep = `<div class="menu-sep"></div>`;

  const rows = [];
  if (!single) rows.push(`<div class="menu-head">已選 ${items.length.toLocaleString()} 筆</div>`);

  if (single) {
    if (it.mediaType === 'bookmark' && it.url) rows.push(mi('open-url', '開啟連結', 'external'));
    else rows.push(mi('view', '開啟', 'image'));
    if (it.file || it.preview) rows.push(mi('open-file', '開原始檔', 'external'));
    rows.push(mi('copy-name', '複製名稱'));
    if (it.file || it.preview) rows.push(mi('copy-path', '複製路徑'));
    if (it.source === 'eagle') rows.push(mi('eagle', '在 Eagle 開啟', 'library-eagle'));
    rows.push(sep);
  }

  /* 評分列（1–5 ★ + 清除） */
  rows.push(`<div class="menu-stars" role="menuitem">
    ${[1, 2, 3, 4, 5].map(n =>
      `<button class="insp-star${single && (it.star || 0) >= n ? ' on' : ''}" data-star="${n}"${roAttr}>★</button>`).join('')}
    <button class="menu-star-clear" data-star="0"${roAttr}>清除</button></div>`);

  rows.push(mi('tags', '編輯標籤…', 'tag', roAttr));
  rows.push(mi('folders', '加入資料夾…', 'folder', roAttr));
  if (single) {
    rows.push(mi('rename', '改名…', 'pencil', roAttr));
    rows.push(mi('refresh-thumb', '重新整理縮圖', 'retry', roAttr));
  }
  rows.push(sep);
  if (trash || allArchived) {
    rows.push(mi('restore', '還原', 'restore', roAttr));
    rows.push(mi('delete', '永久刪除…', 'trash', roAttr + ' data-danger'));
  } else {
    rows.push(mi('archive', '加入垃圾桶', 'trash', roAttr));
  }
  if (!single) { rows.push(sep); rows.push(mi('clear-sel', '取消選取', 'close')); }

  const m = document.createElement('div');
  m.className = 'menu ctx-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = rows.join('');
  document.body.appendChild(m);

  /* 定位翻轉：超出視窗 → 反向展開 */
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = Math.max(4, x + w > window.innerWidth - 8 ? x - w : x) + 'px';
  m.style.top  = Math.max(4, y + hh > window.innerHeight - 8 ? y - hh : y) + 'px';
  _menu = m;

  m.querySelectorAll('[data-star]').forEach(b => b.addEventListener('click', () => {
    const v = parseInt(b.dataset.star, 10);
    close();
    act.setStar(ids, single && v === (it.star || 0) ? 0 : v);
  }));

  const ACT = {
    'view':          () => openViewerFor(it.id),
    'open-url':      () => window.open(it.url, '_blank', 'noopener'),
    'open-file':     () => act.openFile(it),
    'copy-name':     () => act.copyName(it),
    'copy-path':     () => act.copyPath(it),
    'eagle':         () => { location.href = `eagle://item/${encodeURIComponent(it.id)}`; },
    'tags':          () => act.openTagsDialog(ids),
    'folders':       () => act.openFolderDialog(ids),
    'rename':        () => act.promptDialog({ title: '改名', value: it.name, hint: it.ext ? `.${it.ext}` : '' })
                             .then(v => { if (v != null && v !== '') act.renameItem(it.id, v); }),
    'refresh-thumb': () => act.refreshThumb(ids),
    'archive':       () => act.archiveItems(ids),
    'restore':       () => act.restoreItems(ids),
    'delete':        () => act.deleteItems(ids),
    'clear-sel':     () => { store.state.selection.clear(); store.emit('selection'); },
  };
  m.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => { const fn = ACT[b.dataset.action]; close(); fn?.(); }));
}

/* ── 鍵盤導覽（↑↓ Enter Esc）────────────────────────────────────────── */

function _onKey(e) {
  if (!_menu) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const items = [..._menu.querySelectorAll('.menu-item:not([disabled])')];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'Enter') {
    if (idx >= 0) { e.preventDefault(); document.activeElement.click(); }
    return;
  }
  e.preventDefault();
  const next = e.key === 'ArrowDown'
    ? items[(idx + 1) % items.length]
    : items[(idx - 1 + items.length) % items.length];
  next.focus();
}
