/* ── folder-tree.js ▸ 左欄 BROWSE 資料夾樹（B7 自 app.js 抽出 + C11 補完）─
   單擊 = 導覽（REPLACE）；Ctrl/⌘+單擊 = 疊加 AND 篩選（C10）；
   chevron 展開持久化（per-lib localStorage）。
   B7 新增：樹內搜尋（命中 + 祖先鏈顯示、自動展開）+ 三展開模式切換
   （記憶展開 / 僅選中路徑 / 全部展開，C11）。 */

import { navigate, libHash } from './router.js';
import { store } from './store.js';
import { toggleFolderFilter } from './toolbar.js';
import { h } from './items.js';

const $ = id => document.getElementById(id);
const icon = (name, cls = 'icon icon-sm') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const MODES = [
  ['saved', 'chevron-d', '展開模式：記憶（chevron 手動展開）'],
  ['path',  'breadcrumb-sep', '展開模式：僅選中路徑'],
  ['all',   'tree-search', '展開模式：全部展開'],
];
const MODE_KEY = 'ev-tree-mode';

let _ctx = {
  tree: () => [],                  // () => 統一節點形 [{id,name,children,total}]
  folderMap: () => ({}),           // () => { id: { name, parentId, childrenIds } }
  activeLibId: () => null,
  route: () => null,
};
let _kw = '';                      // 樹內搜尋關鍵字（小寫）

export function initFolderTree(ctx) {
  Object.assign(_ctx, ctx);
  const input = $('tree-search-input');
  $('btn-tree-search')?.addEventListener('click', () => {
    const row = $('tree-search-row');
    row.hidden = !row.hidden;
    if (!row.hidden) input.focus();
    else if (_kw) { _kw = ''; input.value = ''; renderTree(); }
  });
  input?.addEventListener('input', () => {
    _kw = input.value.trim().toLowerCase();
    renderTree();
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      _kw = ''; input.value = '';
      $('tree-search-row').hidden = true;
      renderTree();
    }
  });
  $('btn-tree-mode')?.addEventListener('click', () => {
    const i = MODES.findIndex(([m]) => m === _mode());
    const next = MODES[(i + 1) % MODES.length][0];
    try { localStorage.setItem(MODE_KEY, next); } catch (_) {}
    _syncModeBtn();
    renderTree();
  });
  _syncModeBtn();
}

function _mode() {
  const m = localStorage.getItem(MODE_KEY);
  return MODES.some(([k]) => k === m) ? m : 'saved';
}

function _syncModeBtn() {
  const btn = $('btn-tree-mode');
  if (!btn) return;
  const [, ic, title] = MODES.find(([m]) => m === _mode());
  btn.title = title;
  btn.innerHTML = icon(ic);
}

/* ── 展開持久化（記憶模式）──────────────────────────────────────────── */

function _expandedKey() { return `ev-expanded-${_ctx.activeLibId()}`; }
function _loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(_expandedKey()) || '[]')); }
  catch (_) { return new Set(); }
}
function _saveExpanded(set) {
  try { localStorage.setItem(_expandedKey(), JSON.stringify([...set])); } catch (_) {}
}

/** 當前路由資料夾的祖先鏈（含自身）——「僅選中路徑」模式用 */
function _pathChain(folderId) {
  const map = _ctx.folderMap();
  const out = new Set();
  for (let id = folderId; id; id = map[id]?.parentId) out.add(id);
  return out;
}

/* ── 搜尋：命中節點 + 其祖先（顯示鏈）───────────────────────────────── */

function _searchSets(nodes) {
  const visible = new Set(), hit = new Set();
  const walk = n => {
    const selfHit = n.name.toLowerCase().includes(_kw);
    let childHit = false;
    for (const c of n.children) if (walk(c)) childHit = true;
    if (selfHit) hit.add(n.id);
    if (selfHit || childHit) { visible.add(n.id); return true; }
    return false;
  };
  nodes.forEach(walk);
  return { visible, hit };
}

/* ── 渲染 ───────────────────────────────────────────────────────────── */

export function renderTree() {
  const root = $('folder-tree');
  if (!root) return;
  const tree = _ctx.tree();
  const route = _ctx.route();
  const curFolder = route?.params?.folderId || null;
  const mode = _mode();
  const saved = _loadExpanded();
  const pathSet = mode === 'path' && curFolder ? _pathChain(curFolder) : null;
  const search = _kw ? _searchSets(tree) : null;
  const overlay = new Set(store.state.filters?.folders || []);

  const isOpen = n => {
    if (search) return true;                       // 搜尋中：顯示鏈全展開
    if (mode === 'all') return true;
    if (mode === 'path') return pathSet ? pathSet.has(n.id) : false;
    return saved.has(n.id);
  };

  const nodeHTML = n => {
    if (search && !search.visible.has(n.id)) return '';
    const hasKids = n.children.length > 0;
    const open = hasKids && isOpen(n);
    const cls = curFolder === n.id ? ' selected'
      : (overlay.has(n.id) ? ' partial' : (search?.hit.has(n.id) ? ' hit' : ''));
    return `<li class="tree-node${open ? ' expanded' : ''}" role="none" data-node="${h(n.id)}">
      <div class="tree-item${cls}" role="treeitem"
           ${hasKids ? `aria-expanded="${open}"` : ''} data-folder="${h(n.id)}" tabindex="0">
        <span class="tree-chevron${hasKids ? '' : ' leaf'}" data-chevron>${icon('chevron-r')}</span>
        ${icon(open && hasKids ? 'folder-open' : 'folder')}
        <span class="row-label">${h(n.name)}</span>
        ${n.total ? `<span class="count-pill">${n.total.toLocaleString()}</span>` : ''}
      </div>
      ${hasKids ? `<ul role="group">${n.children.map(nodeHTML).join('')}</ul>` : ''}
    </li>`;
  };

  const html = tree.map(nodeHTML).join('');
  root.innerHTML = html
    || (tree.length
        ? `<li class="side-placeholder">沒有符合「${h(_kw)}」的資料夾</li>`
        : `<li class="side-placeholder">此庫沒有資料夾</li>`);

  root.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', e => {
      const li = el.closest('.tree-node');
      if (e.target.closest('[data-chevron]') && li.querySelector('ul')) {
        // chevron = 展開/收合；非記憶模式下先落地為記憶集再切回記憶模式
        const set = _mode() === 'saved' ? _loadExpanded() : _currentOpenSet();
        li.classList.toggle('expanded') ? set.add(li.dataset.node) : set.delete(li.dataset.node);
        _saveExpanded(set);
        if (_mode() !== 'saved') {
          try { localStorage.setItem(MODE_KEY, 'saved'); } catch (_) {}
          _syncModeBtn();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {    // Ctrl/⌘+單擊 = 疊加 AND 篩選（C10）
        toggleFolderFilter(el.dataset.folder);
        return;
      }
      // 單擊 = 導覽（REPLACE 語意）；再點已選中的資料夾 = 取消選中，回到庫根（與濾鏡集 toggle 一致）
      if (curFolder === el.dataset.folder) { navigate(libHash(_ctx.activeLibId())); return; }
      navigate(libHash(_ctx.activeLibId(), el.dataset.folder));
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
  });
}

/** 目前 DOM 上實際展開中的節點集合（模式切換落地用） */
function _currentOpenSet() {
  const set = new Set();
  document.querySelectorAll('#folder-tree .tree-node.expanded')
    .forEach(li => set.add(li.dataset.node));
  return set;
}
