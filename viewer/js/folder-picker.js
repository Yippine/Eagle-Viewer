'use strict';
/* ── folder-picker.js  ▸  資料夾樹狀選擇器 Bottom Sheet（多選）─── */

import { state } from './state.js';
import { h }     from './utils.js';

let _onConfirm     = null;
let _selectedIds   = new Set();
let _selectedNames = new Map();  // id → name
let _fpOpenIds     = new Set();  // 展開狀態（本 picker 獨立管理）

/* ── 三模式共用 key（eagle-tree-mode，與 filter panel 同步）─────── */
const _MODE_CYCLE     = ['collapsed', 'selectedOnly', 'allOpen'];
// 按鈕顯示「下一步動作」icon（與 ui-filters.js 同語意）
const _MODE_NEXT_ICON  = { collapsed: '⊙', selectedOnly: '⊕', allOpen: '⊖' };
const _MODE_NEXT_TITLE = {
  collapsed:    '展開已選節點路徑',
  selectedOnly: '展開全部節點',
  allOpen:      '全部收合',
};

function _getTreeMode() {
  return localStorage.getItem('eagle-tree-mode') || 'collapsed';
}
function _setTreeMode(mode) {
  localStorage.setItem('eagle-tree-mode', mode);
}

/**
 * 開啟資料夾選擇器（多選）。確認後呼叫 onConfirm(folderIds[], folderNames[])
 * @param {Function} onConfirm  確認回呼
 * @param {string[]} [initialIds=[]]  預選的資料夾 id（B02 重開時顯示已加入）
 */
export async function openFolderPicker(onConfirm, initialIds = []) {
  _onConfirm = onConfirm;
  _selectedIds.clear();
  _selectedNames.clear();

  const sheet = document.getElementById('folder-picker-sheet');
  const bd    = document.getElementById('folder-picker-bd');
  if (!sheet || !bd) return;

  // 預載初始選中（B02 修正：直接從 state.folderMap 取名稱）
  const fmap = state.folderMap || {};
  for (const id of (initialIds || [])) {
    _selectedIds.add(id);
    _selectedNames.set(id, fmap[id]?.name || id);
  }

  // 套用展開模式（不觸發渲染，openFolderPicker 末尾一次性渲染）
  _fpApplyTreeMode(_getTreeMode(), false);

  const searchEl = document.getElementById('fp-search');
  if (searchEl) searchEl.value = '';
  _renderChips();
  _renderFpTree('');
  sheet.classList.add('open');
  bd.classList.add('open');
  setTimeout(() => searchEl?.focus(), 300);
}

export function closeFolderPicker() {
  document.getElementById('folder-picker-sheet')?.classList.remove('open');
  document.getElementById('folder-picker-bd')?.classList.remove('open');
  _onConfirm = null;
  _selectedIds.clear();
  _selectedNames.clear();
}

export function onFolderSearch(q) {
  _renderFpTree(q.toLowerCase());
}

export function confirmFolderPicker() {
  const cb    = _onConfirm;
  const ids   = [..._selectedIds];
  const names = ids.map(id => _selectedNames.get(id) || id);
  closeFolderPicker();
  if (cb && ids.length > 0) cb(ids, names);
}

/** Toggle 資料夾選中（點擊 tree-item）*/
export function fpToggle(id) {
  const f = (state.folderMap || {})[id];
  if (!f) return;
  if (_selectedIds.has(id)) {
    _selectedIds.delete(id);
    _selectedNames.delete(id);
  } else {
    _selectedIds.add(id);
    _selectedNames.set(id, f.name);
  }
  _renderChips();
  _renderFpTree(document.getElementById('fp-search')?.value?.toLowerCase() || '');
}

/** 從 chip 移除選中資料夾 */
export function fpRemove(id) {
  _selectedIds.delete(id);
  _selectedNames.delete(id);
  _renderChips();
  _renderFpTree(document.getElementById('fp-search')?.value?.toLowerCase() || '');
}

/* ── 已選 chips 頂部列 ─────────────────────────────────────────── */
function _renderChips() {
  const wrap = document.getElementById('fp-chips');
  const btn  = document.getElementById('fp-confirm-btn');
  if (!wrap) return;
  if (_selectedIds.size === 0) {
    wrap.innerHTML = '';
    if (btn) btn.disabled = true;
    return;
  }
  if (btn) btn.disabled = false;
  wrap.innerHTML = [..._selectedIds].map(id => {
    const name = _selectedNames.get(id) || id;
    return `<span class="fp-chip">${h(name)}<button class="fp-chip-rm" onclick="_fpRemove('${h(id)}')">✕</button></span>`;
  }).join('');
}

/* ── 三模式 ────────────────────────────────────────────────────── */
function _fpApplyTreeMode(mode, render = true) {
  const fmap = state.folderMap || {};
  if (mode === 'collapsed') {
    _fpOpenIds.clear();
  } else if (mode === 'allOpen') {
    Object.entries(fmap).forEach(([id, f]) => { if (!f.isLeaf) _fpOpenIds.add(id); });
  } else if (mode === 'selectedOnly') {
    _fpOpenIds.clear();
    for (const selId of _selectedIds) {
      let pid = fmap[selId]?.parentId;
      while (pid) { _fpOpenIds.add(pid); pid = fmap[pid]?.parentId; }
    }
  }
  if (render) _renderFpTree(document.getElementById('fp-search')?.value?.toLowerCase() || '');
}

window.fpCycleTreeMode = function() {
  const cur  = _getTreeMode();
  const next = _MODE_CYCLE[(_MODE_CYCLE.indexOf(cur) + 1) % _MODE_CYCLE.length];
  _setTreeMode(next);
  _fpApplyTreeMode(next);
  // 兩個 tree 共用 eagle-tree-mode localStorage key，下次開啟時自動讀取最新模式
};

/* ── 展開/收合單節點 ───────────────────────────────────────────── */
window.fpToggleNode = function(id) {
  const childEl = document.getElementById(`fpc-${id}`);
  const chevron = document.querySelector(`.tree-chevron[data-fpid="${CSS.escape(id)}"]`);
  if (!childEl) return;
  const isOpen  = !childEl.hidden;
  childEl.hidden = isOpen;
  if (isOpen) _fpOpenIds.delete(id); else _fpOpenIds.add(id);
  chevron?.classList.toggle('open', !isOpen);
};

/* ── 樹節點渲染（使用 tree-* CSS，與 filter panel 同款）─────── */
function _fpNodeVisible(id, q, fmap) {
  const f = fmap[id];
  if (!f) return false;
  if (f.name.toLowerCase().includes(q)) return true;
  return (f.childrenIds || []).some(cid => _fpNodeVisible(cid, q, fmap));
}

function _fpNode(id, depth, q, fmap) {
  const f = fmap[id];
  if (!f) return '';
  if (q && !_fpNodeVisible(id, q, fmap)) return '';

  const kids   = f.childrenIds || [];
  const isOpen = _fpOpenIds.has(id);
  const isOn   = _selectedIds.has(id);

  const chevron = kids.length
    ? `<button class="tree-chevron${isOpen ? ' open' : ''}" data-fpid="${id}"
         onclick="fpToggleNode('${h(id)}')" title="展開/收合">▶</button>`
    : `<span class="tree-spacer"></span>`;

  const children = kids.length
    ? `<div class="tree-children" id="fpc-${id}"${isOpen ? '' : ' hidden'}>
         ${kids.map(cid => _fpNode(cid, depth + 1, q, fmap)).join('')}
       </div>`
    : '';

  return `<div class="tree-node" data-id="${id}" style="--depth:${depth}">
    ${chevron}
    <button class="tree-item${isOn ? ' on' : ''}" data-id="${id}"
      onclick="_fpToggle('${h(id)}')">${h(f.name)}</button>
  </div>${children}`;
}

function _renderFpTree(q) {
  const container = document.getElementById('fp-tree');
  if (!container) return;
  const fmap  = state.folderMap || {};
  const roots = Object.keys(fmap).filter(id => fmap[id].parentId === null);
  const mode  = _getTreeMode();

  const modeBtn = `<button class="tree-mode-btn" id="fp-tree-mode-btn"
    onclick="fpCycleTreeMode()" title="${_MODE_NEXT_TITLE[mode]}">${_MODE_NEXT_ICON[mode]}</button>`;

  if (!roots.length) {
    container.innerHTML = modeBtn + '<p style="text-align:center;color:var(--text3);padding:24px 0">暫無資料夾資料</p>';
    return;
  }

  const treeHtml = roots.map(id => _fpNode(id, 0, q, fmap)).join('');
  container.innerHTML = modeBtn +
    `<div class="tree-nodes">${treeHtml || '<p style="text-align:center;color:var(--text3);padding:24px 0">無符合資料夾</p>'}</div>`;
}
