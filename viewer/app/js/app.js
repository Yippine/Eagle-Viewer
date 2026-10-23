/* ── app.js ▸ App Shell 初始化 + 路由 render dispatch（B1 骨架 + B2 接線）─
   B2：虛擬滾動 masonry（grid.js）、toolbar chips ↔ URL（toolbar.js）、
   ⌘K 語法搜尋（command-k.js）、桌面批次選取（selection.js）、store.js。
   Eagle/dir = 全量 list 模式；Excire = offset/limit 無限捲動分頁。 */

import { api } from './api.js';
import { buildLibId, libHash, navigate, startRouter } from './router.js';
import { store } from './store.js';
import { adaptItem } from './items.js';
import { initGrid, setEmptyStateProvider } from './grid.js';
import { renderBreadcrumb, setContentChrome, renderPlaceholderPage, hidePagePanel }
  from './page-chrome.js';
import { initData, refreshEagle, refreshExcire, refreshTrash, loadExcirePage,
         updateTrashBadge, dropArchivedFromExcireGrid } from './lib-data.js';
import { renderSearchRoute, resetSearchView, invalidateLibCache, aiCaps, ensureAiStatus }
  from './ai-search.js';
import { initPeople, renderPeopleRoute } from './people.js';
import { initDownloadCenter, renderDownloads } from './download-center.js';
import { initToolbar, syncFromRoute, setFolderNameResolver } from './toolbar.js';
import { initFolderTree, renderTree } from './folder-tree.js';
import { initCollections, renderCollections, collectionName } from './collections.js';
import { initCommandK } from './command-k.js';
import { initShell } from './shell.js';
import { renderStatsRoute } from './stats.js';
import { renderSettingsRoute } from './settings.js';
import { openNotifDrawer } from './notifications.js';
import { initSelection, clearSelection } from './selection.js';
import { initViewer, syncViewerFromRoute } from './viewer.js';
import { initDrawer } from './vc-drawer.js';
import { initInspector, setInspectorContext } from './inspector.js';
import { setActionsContext, emptyTrash } from './actions.js';
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

/* ── Chrome（主題/側欄/Inspector/tabbar）：shell.js（B6 抽出）────────── */

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

/* ── 資料夾樹：folder-tree.js（B7 抽出 + 樹內搜尋/三展開模式）─────────── */

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
  const inGrid = r.name === 'lib' || r.name === 'folder' || r.name === 'collection';
  if (!inGrid) return;
  if (store.state.libType === 'excire') { dropArchivedFromExcireGrid(); return; }  // 封存後就地剔除
  if (r.name !== 'collection') refreshEagle(r, { keepScroll: true });
}

/** 統計頁上下文：需要一個已載入的 Eagle/dir 庫（觀看紀錄僅 Eagle/dir 有） */
async function _statsCtx() {
  let lib = state.libs.find(l => l.id === state.activeLibId && l.type !== 'excire');
  if (!lib) {
    const last = localStorage.getItem('ev-last-lib');
    lib = state.libs.find(l => l.id === last && l.type !== 'excire')
       || state.libs.find(l => l.type !== 'excire');
  }
  if (!lib) return null;
  try { await ensureLibLoaded(lib.id); } catch (_) { return null; }
  return {
    libId: lib.id, slug: lib.slug, label: lib.label,
    items: () => state.vmItems,
    folderName: id => state.folderMap[id]?.name || id,
  };
}

/* ── 路由 render dispatch（唯一 popstate handler 的目的地）──────────── */

/** 視圖簽章（path + grid 相關 query，排除 item/drawer 浮層參數）：
 *  簽章不變 = 只有 viewer 浮層狀態改變 → 跳過 grid 重建（§5.4 #1/#2） */
const _VIEW_KEYS = ['type', 'star', 'tags', 'date', 'size', 'domain', 'folders', 'presets', 'q', 'sort', 'dir', 'seed'];
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
  if (!['lib', 'folder', 'collection'].includes(route.name)) _viewSig = null;
  if (route.name !== 'search') resetSearchView();
  if (!['downloads', 'people', 'stats', 'settings'].includes(route.name)) hidePagePanel();

  /* 垃圾桶模式旗標（Inspector/SelectionBar/選取語意消費）；切換時清空選取 */
  const inTrash = route.name === 'trash';
  document.getElementById('sec-browse')?.classList.toggle('trash-dim', inTrash);
  const btnEmpty = document.getElementById('btn-trash-empty');
  if (btnEmpty) btnEmpty.hidden = !inTrash;
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
      const qs = route.query.toString();
      navigate(libHash(target) + (qs ? `?${qs}` : ''), { replace: true });
      return;
    }

    case 'lib':
    case 'folder':
    case 'collection': {
      const { libId, folderId, collectionId } = route.params;
      const lib = state.libs.find(l => l.id === libId);
      if (!lib) { renderPlaceholderPage('找不到庫', libId, 'close'); _viewSig = null; return; }
      if (route.name === 'collection' && lib.type !== 'excire') {
        // 智慧集合直接存完整 hash 重播；集合路由僅 Excire 相簿使用
        renderPlaceholderPage('集合', '此庫沒有相簿集合（智慧集合請自左欄 COLLECTIONS 開啟）', 'folder');
        return;
      }
      const sig = _sigOf(route);
      if (sig === _viewSig && state.activeLibId === libId) return;   // 僅浮層參數變動
      try { await ensureLibLoaded(libId); }
      catch (e) { renderPlaceholderPage('載入失敗', e.message, 'close'); _viewSig = null; return; }
      _viewSig = sig;

      syncFromRoute(route);            // URL query → filters/sort/seed + chips
      renderTree();
      await renderCollections(route);  // Excire 相簿快取就緒 → 麵包屑可解析相簿名

      const crumbs = [{ label: lib.label, hash: libHash(libId) }];
      if (folderId) {
        const chain = [];
        for (let id = folderId; id; id = state.folderMap[id]?.parentId)
          chain.unshift({ label: state.folderMap[id]?.name || id,
                          hash: `${libHash(libId)}/folder/${encodeURIComponent(id)}` });
        crumbs.push(...chain);
      }
      if (collectionId) crumbs.push({ label: `相簿：${collectionName(lib.slug, collectionId)}` });
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
      try { await ensureLibLoaded(libId); }
      catch (e) { renderPlaceholderPage('載入失敗', e.message, 'close'); return; }
      renderTree();
      renderCollections(route);
      renderBreadcrumb([{ label: lib.label, hash: libHash(libId) }, { label: '垃圾桶' }]);
      setContentChrome(false);                  // 篩選/排序不適用垃圾桶
      refreshTrash();
      return;
    }
    case 'search': {
      if (['nl', 'face', 'similar'].includes(route.query.get('mode') || '')) { await renderSearchRoute(route); return; }
      renderPlaceholderPage('搜尋', '⌘K 語法查詢已套用於庫視圖（?q= chips）；AI 搜尋走 mode=nl|face|similar', 'search');
      return;
    }
    case 'people':     await renderPeopleRoute(route); return;
    case 'downloads':  renderDownloads(route); return;
    case 'stats': {
      const ctx = await _statsCtx();
      if (!ctx) { renderPlaceholderPage('統計', '尚未設定 Eagle 資源庫', 'chart'); return; }
      await renderStatsRoute(route, ctx);
      return;
    }
    case 'settings':
      renderSettingsRoute(route, {
        libs: () => state.libs,
        reloadSources: async () => { await loadSources(); renderSources(); },
      });
      return;
    default:           renderPlaceholderPage('404', `找不到頁面：${route.path}`, 'close');
  }
}

/* ── Boot ──────────────────────────────────────────────────────────── */

async function boot() {
  await injectSprite();
  initShell({
    trashHash: () => state.activeLibId ? `${libHash(state.activeLibId)}/trash` : null,
    openNotifs: openNotifDrawer,
  });
  initGrid({ onNeedMore: loadExcirePage });
  initData({ vmItems: () => state.vmItems, folderWithDescendants });
  initToolbar();
  initFolderTree({
    tree: () => state.folderTree,
    folderMap: () => state.folderMap,
    activeLibId: () => state.activeLibId,
    route: () => state.route,
  });
  initCollections();
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
  document.getElementById('btn-trash-empty')?.addEventListener('click', () => emptyTrash());
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

  /* 篩選 0 結果 + AI 可用 → 空狀態附「改用 AI 語意搜尋」CTA（B7 後補強） */
  setEmptyStateProvider(() => {
    const q = (store.state.filters?.q || '').trim();
    if (!q || !aiCaps().nl) return null;
    const scope = store.state.libId || 'all';
    return {
      icon: 'search', title: '沒有符合的檔名/標籤',
      note: '這裡是純文字篩選；要找「畫面內容」請改用 AI 語意搜尋',
      actionHTML: `<button class="btn btn-primary" data-nl-cta
        data-q="${h(q)}" data-scope="${h(scope)}">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-sparkle"/></svg>
        以 AI 語意搜尋「${h(q)}」</button>`,
    };
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-nl-cta]');
    if (!btn) return;
    navigate(`#/search?mode=nl&q=${encodeURIComponent(btn.dataset.q)}&scope=${encodeURIComponent(btn.dataset.scope)}`);
  });
  ensureAiStatus();   // 預載 AI 能力（空狀態 CTA / ⌘K 模式列在首次互動前就有資料）

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
