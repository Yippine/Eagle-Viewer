'use strict';
/* ── actions.js  ▸  Item Action Sheet（封存/刪除/移動/改名/標籤/評分/註解/網址）── */

import { state } from './state.js';
import { h }     from './utils.js';
import { openFolderPicker } from './folder-picker.js';
import { patchCardTags, patchCardSortMeta } from './renderer.js';
import { applyFilter } from './grid.js';

let _currentItem = null;

/* ── Action Sheet ────────────────────────────────────────────────── */
export function openActionSheet(itemId) {
  const item = state.ALL.find(x => x.id === itemId);
  if (!item) return;
  _currentItem = item;

  const titleEl = document.getElementById('as-item-title');
  if (titleEl) titleEl.textContent = item.name || item.id;

  const isArchived = (item.tags || []).includes('archived');
  const archiveBtn = document.getElementById('as-archive-btn');
  const restoreBtn = document.getElementById('as-restore-btn');
  const deleteBtn  = document.getElementById('as-delete-btn');
  // 垃圾桶模式：隱藏一般編輯操作，只保留還原 / 刪除
  const inTrash = state.trashMode;
  ['as-rename-btn','as-annotation-btn','as-url-btn','as-tags-btn','as-move-btn','as-star-btn']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = inTrash ? 'none' : ''; });
  if (archiveBtn) archiveBtn.style.display = (isArchived || inTrash) ? 'none' : '';
  if (restoreBtn) restoreBtn.style.display = isArchived ? '' : 'none';
  // 需先封存才能刪除（兩步驟保護），垃圾桶模式直接允許刪除
  if (deleteBtn)  deleteBtn.style.display  = (isArchived || inTrash) ? '' : 'none';

  document.getElementById('action-sheet')?.classList.add('open');
  document.getElementById('action-bd')?.classList.add('open');
}

export function closeActionSheet() {
  document.getElementById('action-sheet')?.classList.remove('open');
  document.getElementById('action-bd')?.classList.remove('open');
  _currentItem = null;
}

/* ── Archive / Restore ───────────────────────────────────────────── */
export async function actionArchive() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  try {
    const res = await fetch('/api/item/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local && !local.tags.includes('archived')) local.tags = [...(local.tags || []), 'archived'];
    _toast('已封存');
    applyFilter();
  } catch (e) { _toast(`封存失敗：${e.message}`, true); }
}

export async function actionRestore() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  try {
    const res = await fetch('/api/item/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.tags = (local.tags || []).filter(t => t !== 'archived');
    _toast('已還原');
    applyFilter();  // 垃圾桶模式下讓卡片從 trash grid 消失；一般模式下無影響
  } catch (e) { _toast(`還原失敗：${e.message}`, true); }
}

/* ── Move（加入資料夾，多選）────────────────────────────────────── */
export function actionMove() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  openFolderPicker(async (folderIds, folderNames) => {
    try {
      const res = await fetch('/api/item/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, lib: state.activeLib, folder_ids: folderIds }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      const local = state.ALL.find(x => x.id === item.id);
      if (local) {
        local.folders = folderIds;
        if (d.new_tags) {
          local.tags = d.new_tags;
          patchCardTags(item.id, d.new_tags);
        }
      }
      _toast(`已加入 ${folderNames.join('、')}`);
    } catch (e) { _toast(`加入失敗：${e.message}`, true); }
  }, item.folders || []);
}

/* ── Rename ──────────────────────────────────────────────────────── */
export function actionRename() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  document.getElementById('rename-input').value = item.name || '';
  // 顯示副檔名提示（只讀）
  const extHint = document.getElementById('rename-ext-hint');
  if (extHint) extHint.textContent = item.ext ? `.${item.ext}` : '';
  document.getElementById('rename-sheet')._item = item;
  document.getElementById('rename-sheet')?.classList.add('open');
  document.getElementById('rename-bd')?.classList.add('open');
  setTimeout(() => document.getElementById('rename-input')?.focus(), 300);
}

export function closeRenameSheet() {
  document.getElementById('rename-sheet')?.classList.remove('open');
  document.getElementById('rename-bd')?.classList.remove('open');
}

export async function confirmRename() {
  const sheet = document.getElementById('rename-sheet');
  const item  = sheet?._item;
  let   name  = document.getElementById('rename-input')?.value.trim();
  if (!item || !name) return;
  // 自動去除使用者可能誤加的副檔名（e.g. "3.png" → "3"）
  if (item.ext) {
    const suffix = `.${item.ext.toLowerCase()}`;
    if (name.toLowerCase().endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
  }
  if (!name) return;
  closeRenameSheet();
  try {
    const res = await fetch('/api/item/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib, name }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.name = name;
    const titleEl = document.querySelector(`.card[data-id="${h(item.id)}"] .ctitle`);
    if (titleEl) titleEl.textContent = name;
    _toast('已改名');
  } catch (e) { _toast(`改名失敗：${e.message}`, true); }
}

/* ── Tags Edit（Chip UI）────────────────────────────────────────── */
let _editTags = [];   // 目前已選標籤

export function actionEditTags() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  _editTags = (item.tags || []).filter(t => t !== 'archived');
  document.getElementById('tags-edit-sheet')._item = item;
  document.getElementById('tags-edit-sheet')?.classList.add('open');
  document.getElementById('tags-edit-bd')?.classList.add('open');
  document.getElementById('te-search').value = '';
  _renderEditChips();
  _renderSuggestions('');
  setTimeout(() => document.getElementById('te-search')?.focus(), 300);
}

export function closeTagsEditSheet() {
  document.getElementById('tags-edit-sheet')?.classList.remove('open');
  document.getElementById('tags-edit-bd')?.classList.remove('open');
  _editTags = [];
}

export function onTagSearch(q) {
  _renderSuggestions(q.toLowerCase());
}

export function onTagSearchKey(e) {
  if (e.key !== 'Enter') return;
  const val = document.getElementById('te-search')?.value.trim();
  if (val) _addEditTag(val);
}

function _addEditTag(tag) {
  tag = tag.trim();
  if (!tag || _editTags.includes(tag)) return;
  _editTags.push(tag);
  document.getElementById('te-search').value = '';
  _renderEditChips();
  _renderSuggestions('');
}

function _removeEditTag(tag) {
  _editTags = _editTags.filter(t => t !== tag);
  _renderEditChips();
  _renderSuggestions(document.getElementById('te-search')?.value?.toLowerCase() || '');
}

function _renderEditChips() {
  const wrap = document.getElementById('te-chips');
  if (!wrap) return;
  wrap.innerHTML = _editTags.map(tag =>
    `<span class="te-chip">${h(tag)}<button class="te-chip-rm" onclick="_teRemove('${h(tag)}')">✕</button></span>`
  ).join('');
}

function _renderSuggestions(q) {
  const el = document.getElementById('te-suggestions');
  if (!el) return;
  // 聯集：item.tags（排除 archived）+ folderMap folder names（補全 108 個缺失 folder 標籤）
  const folderNames = Object.values(state.folderMap || {}).map(f => f.name).filter(Boolean);
  const allTags = [...new Set([
    ...state.ALL.flatMap(item => (item.tags || []).filter(t => t !== 'archived')),
    ...folderNames,
  ])].sort();
  const filtered = allTags.filter(t =>
    !_editTags.includes(t) && (!q || t.toLowerCase().includes(q))
  );  // 顯示全部標籤，容器設有 max-height + overflow-y:auto
  if (!filtered.length) { el.innerHTML = ''; return; }
  // 資料夾名稱加 📁 前綴以區分（folderMap names）
  const folderNameSet = new Set(Object.values(state.folderMap || {}).map(f => f.name).filter(Boolean));
  el.innerHTML = filtered.map(t => {
    const icon = folderNameSet.has(t) ? '📁 ' : '';
    return `<button class="te-sugg" onclick="_teAdd('${h(t)}')">${icon}${h(t)}</button>`;
  }).join('');
}

export function confirmTagsEdit() {
  const sheet = document.getElementById('tags-edit-sheet');
  const item  = sheet?._item;
  if (!item) return;
  const hidden  = (item.tags || []).filter(t => t === 'archived');
  const newTags = [...new Set([...hidden, ..._editTags])];
  closeTagsEditSheet();
  fetch('/api/item/tags', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, lib: state.activeLib, tags: newTags }),
  }).then(r => r.json()).then(d => {
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.tags = newTags;
    patchCardTags(item.id, newTags);
    _toast('標籤已更新');
  }).catch(e => _toast(`更新失敗：${e.message}`, true));
}

/* 供 HTML inline 使用 */
window._teAdd    = tag => { _addEditTag(tag); };
window._teRemove = tag => { _removeEditTag(tag); };

/* ── 評分 toggle（同星再點 = 取消，不同星 = 切換）─────────────────── */
window._starClick = function(val) {
  const item = document.getElementById('star-sheet')?._item;
  const cur  = item?.star || 0;
  confirmStar(val === cur ? 0 : val);
};

/* ── Star（評分）────────────────────────────────────────────────── */
export function actionStar() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  const current = item.star || 0;
  document.getElementById('star-sheet')._item = item;
  const btns = document.querySelectorAll('.star-btn');
  btns.forEach(b => {
    const v = parseInt(b.dataset.v);
    b.classList.toggle('star-btn--on', v <= current);
  });
  document.getElementById('star-sheet')?.classList.add('open');
  document.getElementById('star-bd')?.classList.add('open');
}

export function closeStarSheet() {
  document.getElementById('star-sheet')?.classList.remove('open');
  document.getElementById('star-bd')?.classList.remove('open');
}

export async function confirmStar(val) {
  const item = document.getElementById('star-sheet')?._item;
  if (!item) return;
  closeStarSheet();
  try {
    const res = await fetch('/api/item/star', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib, star: val }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.star = val;
    patchCardSortMeta(item.id, 'star', val);
    _toast(val ? `評分 ${val} 星` : '已清除評分');
  } catch (e) { _toast(`評分失敗：${e.message}`, true); }
}

/* ── Annotation（註解）─────────────────────────────────────────── */
export function actionAnnotation() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  document.getElementById('annotation-input').value = item.annotation || '';
  document.getElementById('annotation-sheet')._item = item;
  document.getElementById('annotation-sheet')?.classList.add('open');
  document.getElementById('annotation-bd')?.classList.add('open');
  setTimeout(() => document.getElementById('annotation-input')?.focus(), 300);
}

export function closeAnnotationSheet() {
  document.getElementById('annotation-sheet')?.classList.remove('open');
  document.getElementById('annotation-bd')?.classList.remove('open');
}

export async function confirmAnnotation() {
  const sheet      = document.getElementById('annotation-sheet');
  const item       = sheet?._item;
  const annotation = document.getElementById('annotation-input')?.value || '';
  if (!item) return;
  closeAnnotationSheet();
  try {
    const res = await fetch('/api/item/annotation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib, annotation }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.annotation = annotation;
    _toast('已儲存註解');
  } catch (e) { _toast(`儲存失敗：${e.message}`, true); }
}

/* ── URL（網址）─────────────────────────────────────────────────── */
export function actionUrl() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  document.getElementById('item-url-input').value = item.url || '';
  document.getElementById('item-url-sheet')._item = item;
  document.getElementById('item-url-sheet')?.classList.add('open');
  document.getElementById('item-url-bd')?.classList.add('open');
  setTimeout(() => document.getElementById('item-url-input')?.focus(), 300);
}

export function closeItemUrlSheet() {
  document.getElementById('item-url-sheet')?.classList.remove('open');
  document.getElementById('item-url-bd')?.classList.remove('open');
}

export async function confirmUrl() {
  const sheet = document.getElementById('item-url-sheet');
  const item  = sheet?._item;
  const url   = document.getElementById('item-url-input')?.value.trim() || '';
  if (!item) return;
  closeItemUrlSheet();
  try {
    const res = await fetch('/api/item/url', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, lib: state.activeLib, url }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error);
    const local = state.ALL.find(x => x.id === item.id);
    if (local) local.url = url;
    _toast('已儲存網址');
  } catch (e) { _toast(`儲存失敗：${e.message}`, true); }
}

/* ── Delete ──────────────────────────────────────────────────────── */
export function actionDelete() {
  const item = _currentItem;
  if (!item) return;
  closeActionSheet();
  document.getElementById('del-item-name-lbl').textContent = item.name || item.id;
  document.getElementById('delete-sheet')._item = item;
  document.getElementById('delete-sheet')?.classList.add('open');
  document.getElementById('delete-bd')?.classList.add('open');
}

export function closeDeleteSheet() {
  document.getElementById('delete-sheet')?.classList.remove('open');
  document.getElementById('delete-bd')?.classList.remove('open');
}

export async function confirmDelete() {
  const sheet = document.getElementById('delete-sheet');
  const item  = sheet?._item;
  if (!item) return;
  closeDeleteSheet();
  try {
    const p = new URLSearchParams({ id: item.id, lib: state.activeLib });
    const res = await fetch(`/api/item?${p}`, { method: 'DELETE' });
    const d   = await res.json();
    if (!d.ok) throw new Error(d.error);
    state.ALL = state.ALL.filter(x => x.id !== item.id);
    document.querySelector(`.card[data-id="${h(item.id)}"]`)?.remove();
    _toast('已刪除');
  } catch (e) { _toast(`刪除失敗：${e.message}`, true); }
}

/* ── Toast ───────────────────────────────────────────────────────── */
function _toast(msg, isErr = false) {
  const el = document.getElementById('actions-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'actions-toast' + (isErr ? ' err' : '');
  el.classList.add('show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('show'), 2500);
}
