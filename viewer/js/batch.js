'use strict';
/* ── batch.js  ▸  批量多選操作 ─────────────────────────────────────────── */
import { state }      from './state.js';
import { h }          from './utils.js';
import { applyFilter } from './grid.js';
import { openFolderPicker } from './folder-picker.js';

let _selectMode = false;
const _selectedSet = new Set();

export function isSelectMode() { return _selectMode; }
export function getSelectedIds() { return [..._selectedSet]; }

export function enterSelectMode() {
  _selectMode = true;
  document.body.classList.add('select-mode');
  // 根據是否在垃圾桶模式切換 batch-bar 的操作按鈕
  const inTrash = state.trashMode;
  document.getElementById('batch-archive-btn')?.toggleAttribute('hidden',  inTrash);
  document.getElementById('batch-folders-btn')?.toggleAttribute('hidden',  inTrash);
  document.getElementById('batch-restore-btn')?.toggleAttribute('hidden', !inTrash);
  _updateBatchBar();
}

export function exitSelectMode() {
  _selectMode = false;
  _selectedSet.clear();
  document.body.classList.remove('select-mode');
  document.querySelectorAll('.card-sel').forEach(c => c.classList.remove('card-sel'));
  _updateBatchBar();
}

export function toggleSelect(id) {
  if (_selectedSet.has(id)) _selectedSet.delete(id);
  else _selectedSet.add(id);
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.toggle('card-sel', _selectedSet.has(id));
  _updateBatchBar();
}

function _updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  const cnt = document.getElementById('batch-sel-count');
  if (!bar) return;
  const n = _selectedSet.size;
  // 垃圾桶模式：圓圈自動顯示（select-mode class），底部 batch-bar 只在 n > 0 才出現
  // 一般多選模式：n >= 0 即顯示（顯示「點擊卡片選取」提示）
  const show = _selectMode && (state.trashMode ? n > 0 : true);
  bar.style.display = show ? 'flex' : 'none';
  if (cnt) cnt.textContent = n > 0 ? `已選 ${n} 筆` : '點擊卡片選取';
}

export async function batchArchive() {
  const ids = [..._selectedSet];
  if (!ids.length) return;
  try {
    const res = await fetch('/api/items/archive-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const archivedSet = new Set(d.archived || ids);
    state.ALL.forEach(i => {
      if (archivedSet.has(i.id) && !i.tags.includes('archived'))
        i.tags = [...(i.tags || []), 'archived'];
    });
    exitSelectMode();
    applyFilter();
    _batchToast(`已封存 ${archivedSet.size} 筆`);
  } catch (e) { _batchToast(`封存失敗：${e.message}`, true); }
}

export function batchFolders() {
  const ids = [..._selectedSet];
  if (!ids.length) return;
  openFolderPicker(async (folderIds, folderNames) => {
    try {
      const res = await fetch('/api/items/folders-batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, lib: state.activeLib, folder_ids: folderIds }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      exitSelectMode();
      _batchToast(`已加入 ${folderNames.join('、')}`);
    } catch (e) { _batchToast(`加入失敗：${e.message}`, true); }
  });
}

export async function batchDelete() {
  const ids = [..._selectedSet];
  if (!ids.length) return;
  if (!confirm(`確定永久刪除 ${ids.length} 筆素材？此操作無法復原。`)) return;
  try {
    const res = await fetch('/api/items/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const deletedSet = new Set(d.deleted || ids);
    state.ALL = state.ALL.filter(i => !deletedSet.has(i.id));
    deletedSet.forEach(id => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.remove());
    exitSelectMode();
    applyFilter();
    _batchToast(`已刪除 ${deletedSet.size} 筆`);
  } catch (e) { _batchToast(`刪除失敗：${e.message}`, true); }
}

function _batchToast(msg, isErr = false) {
  const el = document.getElementById('actions-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'actions-toast' + (isErr ? ' err' : '');
  el.classList.add('show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('show'), 2500);
}

/* 長按進入多選 */
export function wireLongPress() {
  let _timer = null;
  document.getElementById('grid')?.addEventListener('touchstart', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    _timer = setTimeout(() => {
      if (!_selectMode) enterSelectMode();
      toggleSelect(id);
      _timer = null;
    }, 500);
  }, { passive: true });
  document.getElementById('grid')?.addEventListener('touchmove', () => { clearTimeout(_timer); _timer = null; }, { passive: true });
  document.getElementById('grid')?.addEventListener('touchend', () => { clearTimeout(_timer); _timer = null; }, { passive: true });
}
