'use strict';
/* ── trash.js  ▸  垃圾桶模式（直接複用主 grid，透過 state.trashMode 切換）── */

import { state }          from './state.js';
import { applyFilter }    from './grid.js';
import { enterSelectMode, exitSelectMode, getSelectedIds } from './batch.js';

/* ── 開啟 / 關閉 ─────────────────────────────────────────────────────── */

export function openTrashView() {
  // 再次點擊同一按鈕 → 關閉（toggle 語意）
  if (state.trashMode) { closeTrashView(); return; }
  state.trashMode = true;
  document.body.classList.add('trash-mode');
  // btn-trash 保持可見，改用 .on class 表示進入垃圾桶模式
  document.getElementById('btn-trash')?.classList.add('on');
  applyFilter();
  _updateTrashCount();
  // 自動進入多選模式：每張卡片自動顯示圓圈，點擊即勾選
  enterSelectMode();
}

export function closeTrashView() {
  state.trashMode = false;
  document.body.classList.remove('trash-mode');
  document.getElementById('btn-trash')?.classList.remove('on');
  exitSelectMode();
  applyFilter();
}

export function _updateTrashCount() {
  const count = state.ALL.filter(i => (i.tags || []).includes('archived')).length;
  const el = document.getElementById('trash-mode-count');
  if (el) el.textContent = count ? `${count} 筆` : '空的';
}

/* ── 批量操作（使用 batch.js 的 _selectedSet）────────────────────────── */

export async function batchTrashRestore() {
  // 僅操作已選取的項目（請先透過「↩ 選取」進入多選模式勾選）
  const ids = getSelectedIds();
  if (!ids.length) { _toast('請先勾選要還原的項目'); return; }
  try {
    const res = await fetch('/api/items/restore-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const restoredSet = new Set(d.restored || ids);
    state.ALL.forEach(i => {
      if (restoredSet.has(i.id)) i.tags = (i.tags || []).filter(t => t !== 'archived');
    });
    exitSelectMode();
    applyFilter();
    _updateTrashCount();
    _toast(`已還原 ${restoredSet.size} 筆`);
  } catch (e) { _toast(`還原失敗：${e.message}`, true); }
}

export async function batchTrashDelete() {
  // 僅操作已選取的項目（請先透過「🗑 選取」進入多選模式勾選）
  const ids = getSelectedIds();
  if (!ids.length) { _toast('請先勾選要刪除的項目'); return; }
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
    exitSelectMode();
    applyFilter();
    _updateTrashCount();
    _toast(`已永久刪除 ${deletedSet.size} 筆`);
  } catch (e) { _toast(`刪除失敗：${e.message}`, true); }
}

/* ── 全選（選取所有目前可見卡片）────────────────────────────────────── */
export function trashSelectAll() {
  const { enterSelectMode, toggleSelect } = _batchFns;
  enterSelectMode();
  document.querySelectorAll('#grid .card').forEach(card => {
    if (card.dataset.id && !card.classList.contains('card-sel'))
      toggleSelect(card.dataset.id);
  });
}

// 延遲取得 batch.js 函式（避免 circular import 問題）
const _batchFns = {};
export function _registerBatchFns(fns) { Object.assign(_batchFns, fns); }

/* ── SSE 同步（垃圾桶模式下 re-filter 即可，不需重載頁面）────────────── */
export function trashHandleSSE(evt) {
  if (evt.type === 'items_restored') {
    const set = new Set(evt.ids || []);
    state.ALL.forEach(i => {
      if (set.has(i.id)) i.tags = (i.tags || []).filter(t => t !== 'archived');
    });
    if (state.trashMode) { applyFilter(); _updateTrashCount(); }
  } else if (evt.type === 'item_deleted') {
    state.ALL = state.ALL.filter(x => x.id !== evt.id);
    if (state.trashMode) { applyFilter(); _updateTrashCount(); }
  }
}

function _toast(msg, isErr = false) {
  const el = document.getElementById('actions-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'actions-toast' + (isErr ? ' err' : '');
  el.classList.add('show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('show'), 2500);
}
