/* ── app.js ▸ App Shell 初始化 + 路由 render dispatch（B1 骨架 + B2 接線）─
   B2：虛擬滾動 masonry（grid.js）、toolbar chips ↔ URL（toolbar.js）、
   ⌘K 語法搜尋（command-k.js）、桌面批次選取（selection.js）、store.js。
   Eagle/dir = 全量 list 模式；Excire = offset/limit 無限捲動分頁。 */

import { api } from './api.js';
import { buildLibId, libHash, navigate, startRouter } from './router.js';
import { store } from './store.js';
import { adaptItem } from './items.js';
import { initGrid } from './grid.js';
import { renderBreadcrumb, setContentChrome, renderPlaceholderPage, hidePagePanel }
  from './page-chrome.js';
import { initData, refreshEagle, refreshExcire, refreshTrash, loadExcirePage,
         updateTrashBadge } from './lib-data.js';
import { renderSearchRoute, resetSearchView, invalidateLibCache } from './ai-search.js';
import { initPeople, renderPeopleRoute } from './people.js';
import { initDownloadCenter, renderDownloads } from './download-center.js';
import { initToolbar, syncFromRoute, setFolderNameResolver, toggleFolderFilter } from './toolbar.js';
import { initCommandK } from './command-k.js';
import { initSelection, clearSelection } from './selection.js';
import { initViewer, syncViewerFromRoute } from './viewer.js';
import { initDrawer } from './vc-drawer.js';
import { initInspector, setInspectorContext } from './inspector.js';
import { setActionsContext } from './actions.js';
import { initContextMenu } from './context-menu.js';
import { initNotifications } from './notifications.js';
import './vc-bindings.js';   // window.vc* 綁定（vc-panel inline onclick 用）

/* ── App 私有狀態（庫/樹結構；篩選與清單狀態一律在 store）───────────── */

const state = {
  libs: [],            // [{ id, type, slug, label, extracted, readOnly, count }]
  activeLibId: null,
  vmItems: [],         // 當前庫全部 vm items（eagle/dir；excire 走分頁）
  folderTree: [],      // 統一 {id,name,children,total} 形
  folderMap: {},       // id → { name, parentId, childrenIds }
  route: null,
};

const $ = id => document.getElementById(id);
const h = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const icon = (name, cls = 'icon icon-sm') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ── Icon sprite 注入 ──────────────────────────────────────────────── */

async function injectSprite() {
  try {
    const res = await fetch('icons.svg');
    $('sprite-root').innerHTML = await res.text();
  } catch (_) { /* icon 缺失不阻斷啟動 */ }
}

/* ── 主題 ──────────────────────────────────────────────────────────── */

function initTheme() {
  $('btn-theme').addEventListener('click', () => {
    const cur  = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ev-theme', next); } catch (_) {}
  });
}

/* ── Chrome（側欄/Inspector 收合、backdrop、nav 按鈕）───────────────── */

const _isNarrow = () => window.matchMedia('(max-width: 1279px)').matches;

function wireChrome() {
  const shell = $('shell'), sidebar = $('sidebar'), backdrop = $('shell-backdrop');

  if (localStorage.getItem('ev-rail-collapsed') === '1') shell.classList.add('rail-collapsed');
  if (localStorage.getItem('ev-inspector-collapsed') === '1') shell.classList.add('inspector-collapsed');

  const closeDrawer = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };

  $('btn-rail').addEventListener('click', () => {
    if (_isNarrow()) {          // 平板/手機：overlay 抽屜
      const open = sidebar.classList.toggle('open');
      backdrop.classList.toggle('show', open);
    } else {                    // 桌面：56px icon rail 收合
      const c = shell.classList.toggle('rail-collapsed');
      localStorage.setItem('ev-rail-collapsed', c ? '1' : '0');
      $('btn-rail').setAttribute('aria-expanded', String(!c));
    }
  });
  $('tab-browse').addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    backdrop.classList.toggle('show', open);
  });
  backdrop.addEventListener('click', closeDrawer);

  $('btn-inspector').addEventListener('click', () => {
    const c = shell.classList.toggle('inspector-collapsed');
    localStorage.setItem('ev-inspector-collapsed', c ? '1' : '0');
    $('btn-inspector').setAttribute('aria-expanded', String(!c));
  });

  document.querySelectorAll('[data-nav]').forEach(el =>
    el.addEventListener('click', () => { closeDrawer(); navigate(el.dataset.nav); }));

  $('row-trash').addEventListener('click', () => {
    if (state.activeLibId) { closeDrawer(); navigate(`${libHash(state.activeLibId)}/trash`); }
  });

  sidebar.addEventListener('click', e => {
    if (e.target.closest('[data-lib], [data-folder]') && !e.ctrlKey && !e.metaKey) closeDrawer();
  });
}

/* ── 來源載入與渲染（SOURCES 三分組）────────────────────────────────── */

async function loadSources() {
  const [eagleRes, excireRes] = await Promise.allSettled([api.libraries(), api.excireLibraries()]);
  const libs = [];

  if (eagleRes.status === 'fulfilled' && Array.isArray(eagleRes.value)) {
    for (const l of eagleRes.value) {
      const type = l.source === 'folder' ? 'dir' : 'eagle';
      libs.push({
        id: buildLibId(type, l.name), type, slug: l.name,
        label: l.display_label || l.label || l.name,
        extracted: !!l.extracted, readOnly: false, count: l.count ?? null,
      });
    }
  }
  if (excireRes.status === 'fulfilled' && Array.isArray(excireRes.value)) {
    for (const l of excireRes.value) {
      libs.push({
        id: buildLibId('excire', l.name), type: 'excire', slug: l.name,
        label: l.label || l.name, extracted: true, readOnly: true,
        available: l.available, count: l.stats?.photos ?? null,
      });
    }
  }
  state.libs = libs;
}

function _libRow(lib) {
  const active = lib.id === state.activeLibId;
  const iconName = lib.type === 'excire' ? 'library-excire'
                 : lib.type === 'dir' ? 'folder-scan' : 'library-eagle';
  return `<button class="side-row${active ? ' selected' : ''}" data-lib="${h(lib.id)}"
            role="treeitem" aria-selected="${active}">
    ${icon(iconName)}
    <span class="row-label">${h(lib.label)}</span>
    ${!lib.extracted ? `<span class="mark-unindexed" title="尚未索引">✦</span>` : ''}
    ${lib.count != null ? `<span class="count-pill">${lib.count.toLocaleString()}</span>` : ''}
    ${lib.readOnly ? icon('lock-ro') : ''}
  </button>`;
}

function renderSources() {
  const groups = { eagle: $('sources-eagle'), excire: $('sources-excire'), dir: $('sources-dir') };
  for (const [type, el] of Object.entries(groups)) {
    const libs = state.libs.filter(l => l.type === type);
    el.innerHTML = libs.map(_libRow).join('');
  }
  document.querySelectorAll('[data-lib]').forEach(el =>
    el.addEventListener('click', () => navigate(libHash(el.dataset.lib))));
}

/* ── 資料夾樹 ──────────────────────────────────────────────────────── */

function _expandedKey() { return `ev-expanded-${state.activeLibId}`; }
function _loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(_expandedKey()) || '[]')); }
  catch (_) { return new Set(); }
}
function _saveExpanded(set) {
  try { localStorage.setItem(_expandedKey(), JSON.stringify([...set])); } catch (_) {}
}

/** eagle /api/folders 或 excire folder_tree → 統一節點形 + folderMap */
function normalizeTree(nodes, isExcire) {
  const map = {};
  const walk = (list, parentId) => (list || []).map(n => {
    const id = String(n.id);
    const children = walk(n.children, id);
    map[id] = { name: n.name || id, parentId, childrenIds: children.map(c => c.id) };
    return { id, name: n.name || id, children,
             total: isExcire ? (n.total_count ?? n.photo_count ?? 0) : 0 };
  });
  const tree = walk(nodes, null);
  return { tree, map };
}

/** eagle：以 items 的 folders 欄位補上後代彙總計數 */
function fillEagleCounts(tree) {
  const direct = {};
  for (const it of state.vmItems)
    for (const fid of (it.folders || [])) direct[fid] = (direct[fid] || 0) + 1;
  const agg = node => {
    node.total = (direct[node.id] || 0) + node.children.reduce((s, c) => s + agg(c), 0);
    return node.total;
  };
  tree.forEach(agg);
}

function renderTree() {
  const root = $('folder-tree');
  const expanded = _loadExpanded();
  const curFolder = state.route?.params?.folderId || null;
  const overlay = new Set(store.state.filters?.folders || []);

  const nodeHTML = n => {
    const hasKids = n.children.length > 0;
    const open = expanded.has(n.id);
    const cls = curFolder === n.id ? ' selected' : (overlay.has(n.id) ? ' partial' : '');
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

  root.innerHTML = state.folderTree.length
    ? state.folderTree.map(nodeHTML).join('')
    : `<li class="side-placeholder">此庫沒有資料夾</li>`;

  root.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', e => {
      const li = el.closest('.tree-node');
      if (e.target.closest('[data-chevron]') && li.querySelector('ul')) {
        const set = _loadExpanded();   // chevron = 展開/收合（持久化）
        li.classList.toggle('expanded') ? set.add(li.dataset.node) : set.delete(li.dataset.node);
        _saveExpanded(set);
        return;
      }
      if (e.ctrlKey || e.metaKey) {    // Ctrl/⌘+單擊 = 疊加 AND 篩選（C10）
        toggleFolderFilter(el.dataset.folder);
        return;
      }
      // 單擊 = 導覽（REPLACE 語意）
      navigate(`${libHash(state.activeLibId)}/folder/${encodeURIComponent(el.dataset.folder)}`);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
  });
}

/* ── 庫資料載入 ────────────────────────────────────────────────────── */

async function ensureLibLoaded(libId) {
  if (state.activeLibId === libId) {
    // 自搜尋/人物虛擬視圖返回：還原 allItems（虛擬視圖曾覆蓋，B5）
    if (store.state.libType !== 'excire' && store.state.allItems !== state.vmItems)
      store.set({ allItems: state.vmItems });
    return;
  }
  const lib = state.libs.find(l => l.id === libId);
  if (!lib) throw new Error(`未知的庫：${libId}`);
  state.activeLibId = libId;
  state.vmItems = []; state.folderTree = []; state.folderMap = {};
  clearSelection();
  store.set({ libId, libType: lib.type, allItems: [] }, 'lib-context');
  try { localStorage.setItem('ev-last-lib', libId); } catch (_) {}

  if (lib.type === 'excire') {
    const d = await api.excireFolders(lib.slug);
    const { tree, map } = normalizeTree(d.folders || [], true);
    state.folderTree = tree; state.folderMap = map;
  } else {
    const [itemsRes, foldersRes] = await Promise.allSettled([
      api.items(lib.slug), api.folders(lib.slug),
    ]);
    if (itemsRes.status === 'fulfilled') {
      const seen = new Set();
      state.vmItems = (itemsRes.value.items || [])
        .filter(i => seen.has(i.id) ? false : (seen.add(i.id), true))
        .map(i => adaptItem(i, lib.type));
      store.set({ allItems: state.vmItems });
    }
    if (foldersRes.status === 'fulfilled') {
      const { tree, map } = normalizeTree(foldersRes.value.folders || [], false);
      state.folderTree = tree; state.folderMap = map;
      fillEagleCounts(state.folderTree);
    }
  }
  renderSources();
}

/** folderId + 後代 id 集合（父含後代語意，C10） */
function folderWithDescendants(folderId) {
  const out = new Set([folderId]);
  const walk = id => (state.folderMap[id]?.childrenIds || [])
    .forEach(cid => { out.add(cid); walk(cid); });
  walk(folderId);
  return out;
}

/* ── 中欄渲染 chrome：page-chrome.js（B5 抽出，多頁共用）────────────── */

/* ── 資料管線（lib-data.js）：寫入後同步 ────────────────────────────── */

/** actions.js/SSE patch → 'items-mutated'：重跑當前視圖（不動捲動位置） */
function _onItemsMutated() {
  updateTrashBadge();
  const r = state.route;
  if (!r) return;
  if (r.name === 'trash') { refreshTrash({ keepScroll: true }); return; }
  if ((r.name === 'lib' || r.name === 'folder') && store.state.libType !== 'excire')
    refreshEagle(r, { keepScroll: true });
}

/* ── 路由 render dispatch（唯一 popstate handler 的目的地）──────────── */

/** 視圖簽章（path + grid 相關 query，排除 item/drawer 浮層參數）：
 *  簽章不變 = 只有 viewer 浮層狀態改變 → 跳過 grid 重建（§5.4 #1/#2） */
const _VIEW_KEYS = ['type', 'star', 'tags', 'date', 'size', 'domain', 'folders', 'q', 'sort', 'dir', 'seed'];
let _viewSig = null;

function _sigOf(route) {
  return route.path + '|' + _VIEW_KEYS.map(k => route.query.get(k) || '').join('|');
}

async function render(route) {
  state.route = route;
  await _renderRoute(route);
  syncViewerFromRoute(route);      // 宣告式 viewer 開/關（?item= / ?drawer=）
}

async function _renderRoute(route) {
  if (route.name !== 'lib' && route.name !== 'folder') _viewSig = null;
  if (route.name !== 'search') resetSearchView();
  if (route.name !== 'downloads' && route.name !== 'people') hidePagePanel();

  /* 垃圾桶模式旗標（Inspector/SelectionBar/選取語意消費）；切換時清空選取 */
  const inTrash = route.name === 'trash';
  document.getElementById('sec-browse')?.classList.toggle('trash-dim', inTrash);
  if (!!store.state.trash !== inTrash) {
    store.set({ trash: inTrash });
    clearSelection();
  }

  switch (route.name) {
    case 'home': {
      if (!state.libs.length) {
        renderPlaceholderPage('尚未設定來源', '請以「＋ 新增來源」加入 Eagle 資源庫', 'plus');
        return;
      }
      const last = localStorage.getItem('ev-last-lib');
      const target = state.libs.some(l => l.id === last) ? last : state.libs[0].id;
      navigate(libHash(target), { replace: true });
      return;
    }

    case 'lib':
    case 'folder': {
      const { libId, folderId } = route.params;
      const lib = state.libs.find(l => l.id === libId);
      if (!lib) { renderPlaceholderPage('找不到庫', libId, 'close'); _viewSig = null; return; }
      const sig = _sigOf(route);
      if (sig === _viewSig && state.activeLibId === libId) return;   // 僅浮層參數變動
      try { await ensureLibLoaded(libId); }
      catch (e) { renderPlaceholderPage('載入失敗', e.message, 'close'); _viewSig = null; return; }
      _viewSig = sig;

      syncFromRoute(route);            // URL query → filters/sort/seed + chips
      renderTree();

      const crumbs = [{ label: lib.label, hash: libHash(libId) }];
      if (folderId) {
        const chain = [];
        for (let id = folderId; id; id = state.folderMap[id]?.parentId)
          chain.unshift({ label: state.folderMap[id]?.name || id,
                          hash: `${libHash(libId)}/folder/${encodeURIComponent(id)}` });
        crumbs.push(...chain);
      }
      renderBreadcrumb(crumbs);
      setContentChrome(true);

      if (lib.type === 'excire') refreshExcire(route, lib);
      else refreshEagle(route);
      return;
    }

    case 'trash': {
      const { libId } = route.params;
      const lib = state.libs.find(l => l.id === libId);
      if (!lib) { renderPlaceholderPage('找不到庫', libId, 'close'); return; }
      if (lib.type === 'excire') {
        renderPlaceholderPage('垃圾桶', 'Excire 唯讀庫沒有垃圾桶', 'lock-ro'); return;
      }
      try { await ensureLibLoaded(libId); }
      catch (e) { renderPlaceholderPage('載入失敗', e.message, 'close'); return; }
      renderTree();
      renderBreadcrumb([{ label: lib.label, hash: libHash(libId) }, { label: '垃圾桶' }]);
      setContentChrome(false);                  // 篩選/排序不適用垃圾桶
      refreshTrash();
      return;
    }
    case 'collection': renderPlaceholderPage('集合', 'Collections / 智慧集合於 B6 實作', 'folder'); return;
    case 'search': {
      if (['nl', 'face'].includes(route.query.get('mode') || '')) { await renderSearchRoute(route); return; }
      renderPlaceholderPage('搜尋', '⌘K 語法查詢已套用於庫視圖（?q= chips）；AI 搜尋走 mode=nl|face', 'search');
      return;
    }
    case 'people':     await renderPeopleRoute(route); return;
    case 'downloads':  renderDownloads(route); return;
    case 'stats':      renderPlaceholderPage('統計', '折線/TOP10/觀看記錄於 B6 實作', 'chart'); return;
    case 'settings':   renderPlaceholderPage(`設定 · ${route.params.tab}`, '偏好/同步/通知/來源分頁於 B6 實作', 'settings'); return;
    default:           renderPlaceholderPage('404', `找不到頁面：${route.path}`, 'close');
  }
}

/* ── Boot ──────────────────────────────────────────────────────────── */

async function boot() {
  await injectSprite();
  initTheme();
  wireChrome();
  initGrid({ onNeedMore: loadExcirePage });
  initData({ vmItems: () => state.vmItems, folderWithDescendants });
  initToolbar();
  initCommandK();
  initSelection();
  initDrawer();
  initViewer({
    folderName: id => state.folderMap[id]?.name || id,
    libLabel: () => state.libs.find(l => l.id === state.activeLibId)?.label || '',
  });
  setFolderNameResolver(id => state.folderMap[id]?.name || id);

  /* B4：Inspector / 操作 / 右鍵選單 / toast+SSE */
  const b4ctx = {
    folderName: id => state.folderMap[id]?.name || id,
    folderTree: () => state.folderTree,
    libLabel: () => state.libs.find(l => l.id === state.activeLibId)?.label || '',
  };
  setActionsContext(b4ctx);
  setInspectorContext(b4ctx);
  initInspector();
  initContextMenu();
  initNotifications();
  store.on('items-mutated', _onItemsMutated);
  store.on('grid-items', updateTrashBadge);   // 庫載入/清單更新後同步垃圾桶計數

  /* B5：下載中心 + People + AI 搜尋 */
  initPeople();
  initDownloadCenter({ libs: () => state.libs });
  store.on('lib-invalidate', () => {          // 下載完成跳轉：強制重載庫資料
    state.activeLibId = null;
    invalidateLibCache();
  });

  try {
    await api.config();
    await loadSources();
  } catch (e) {
    renderPlaceholderPage('無法連線後端', e.message, 'close');
  }
  renderSources();
  startRouter(render);
}

boot();
