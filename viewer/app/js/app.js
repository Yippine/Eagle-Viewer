/* ── app.js ▸ 新版 App Shell 初始化（B1）───────────────────────────────
   職責：sprite 注入、主題、chrome 事件、SOURCES 三分組、資料夾樹、
   路由 render dispatch、佔位 grid（資料打通證明；虛擬滾動 B2 上）。
   SearchProvider 擴充槽（P4 spec §2.4）於此定義（P6 零改版接入）。 */

import { api, mediaURL } from './api.js';
import { buildLibId, libHash, navigate, startRouter } from './router.js';

/* ── App state（單檔內部狀態；正式 store.js 於 B2 併入）─────────────── */

const state = {
  libs: [],            // [{ id, type, slug, label, extracted, readOnly, count }]
  activeLibId: null,
  folderTree: [],      // 當前庫資料夾樹（統一 {id,name,children,total} 形）
  folderMap: {},       // id → { name, parentId, childrenIds }
  items: [],           // 當前庫全部項目（eagle/dir）；excire 依路由分頁抓
  route: null,
};

const $ = id => document.getElementById(id);
const h = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const icon = (name, cls = 'icon icon-sm') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ── SearchProvider 擴充槽（§2.4：B1 定義契約，P6 啟用）─────────────── */

const _searchProviders = new Map();

export function registerSearchProvider(p) {
  if (!p || !p.id) throw new Error('SearchProvider 需要 id');
  _searchProviders.set(p.id, {
    label: p.id, icon: 'search', available: () => false,
    suggest: () => [], execute: () => ({ ids: [], provider: p.id, query: '' }),
    ...p,
  });
}

export function getSearchProviders() { return [..._searchProviders.values()]; }

registerSearchProvider({ id: 'syntax', label: '語法', icon: 'command', available: () => true });
registerSearchProvider({ id: 'nl', label: '自然語言', icon: 'sparkle', available: () => false });
registerSearchProvider({ id: 'face', label: '人物', icon: 'face-scan', available: () => false });
registerSearchProvider({ id: 'similar', label: '相似圖', icon: 'similar', available: () => false });

/* ── Icon sprite 注入（外部 sprite → inline，<use href="#i-*"> 全瀏覽器安定）─ */

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
  $('btn-sel-close').addEventListener('click', () => { $('selection-bar').hidden = true; });

  // 導覽後（樹/庫列動態產生的按鈕以 delegation 處理）收抽屜
  sidebar.addEventListener('click', e => {
    if (e.target.closest('[data-lib], [data-folder]')) closeDrawer();
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
  for (const it of state.items)
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

  const nodeHTML = n => {
    const hasKids = n.children.length > 0;
    const open = expanded.has(n.id);
    return `<li class="tree-node${open ? ' expanded' : ''}" role="none" data-node="${h(n.id)}">
      <div class="tree-item${curFolder === n.id ? ' selected' : ''}" role="treeitem"
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
        // chevron 點擊 = 展開/收合（持久化）
        const set = _loadExpanded();
        li.classList.toggle('expanded') ? set.add(li.dataset.node) : set.delete(li.dataset.node);
        _saveExpanded(set);
        return;
      }
      // 單擊 = 導覽（REPLACE 語意 → 路由 push；Ctrl/⌘ 疊加篩選為 B2）
      navigate(`${libHash(state.activeLibId)}/folder/${encodeURIComponent(el.dataset.folder)}`);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
  });
}

/* ── 庫資料載入 ────────────────────────────────────────────────────── */

async function ensureLibLoaded(libId) {
  if (state.activeLibId === libId) return;
  const lib = state.libs.find(l => l.id === libId);
  if (!lib) throw new Error(`未知的庫：${libId}`);
  state.activeLibId = libId;
  state.items = []; state.folderTree = []; state.folderMap = {};
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
      state.items = (itemsRes.value.items || [])
        .filter(i => seen.has(i.id) ? false : (seen.add(i.id), true));
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

/* ── 中欄渲染 ──────────────────────────────────────────────────────── */

function renderBreadcrumb(parts) {
  $('breadcrumb').innerHTML = parts.map((p, i) =>
    (i ? `<span class="crumb-sep">${icon('chevron-r', 'icon icon-sm')}</span>` : '') +
    (p.hash && i < parts.length - 1
      ? `<button class="crumb" data-crumb="${h(p.hash)}">${h(p.label)}</button>`
      : `<span class="crumb current">${h(p.label)}</span>`)
  ).join('');
  $('breadcrumb').querySelectorAll('[data-crumb]').forEach(el =>
    el.addEventListener('click', () => navigate(el.dataset.crumb)));
}

function _cardHTML(it) {
  const isVideo = it.media_type === 'video' || it.kind === 'video';
  const thumb = mediaURL(it.thumb);
  return `<article class="card" data-id="${h(it.id)}">
    <div class="card-thumb">
      ${thumb ? `<img src="${h(thumb)}" loading="lazy" alt="${h(it.name)}"
                    onerror="this.closest('.card').style.display='none'">` : ''}
      ${isVideo ? `<span class="kind-badge">${icon('video')}</span>` : ''}
    </div>
    <div class="cbody">
      <div class="card-title">${h(it.name)}</div>
      ${it.domain && it.domain !== 'local' ? `<div class="card-meta">${h(it.domain)}</div>` : ''}
    </div>
  </article>`;
}

const GRID_CAP = 240;   // B1 佔位上限；虛擬滾動 B2 解除

function renderGrid(items, total = items.length) {
  const grid = $('grid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      ${icon('image', 'icon')}<p class="empty-title">沒有項目</p></div>`;
  } else {
    grid.innerHTML = items.slice(0, GRID_CAP).map(_cardHTML).join('');
  }
  $('ibar-count').textContent =
    `顯示 ${Math.min(items.length, GRID_CAP).toLocaleString()} / ${total.toLocaleString()} 筆` +
    (items.length > GRID_CAP ? '（B1 佔位上限；虛擬滾動 B2）' : '');
}

function renderInspectorSummary(items, total) {
  const n = k => items.filter(i => (i.media_type || i.kind) === k).length;
  $('inspector-body').innerHTML = `<div>
    <p style="color:var(--text2);font-size:var(--fs-sm)">當前視圖摘要</p>
    <p>項目數：<b>${total.toLocaleString()}</b></p>
    <p style="color:var(--text2);font-size:var(--fs-sm)">
      影片 ${n('video').toLocaleString()} ·
      圖片 ${(items.length - n('video')).toLocaleString()}（載入中樣本）</p>
    <p style="color:var(--text3);font-size:var(--fs-xs)">單選/多選編輯於 B4 實作</p>
  </div>`;
}

function renderPlaceholderPage(title, note, iconName = 'info') {
  renderBreadcrumb([{ label: title }]);
  $('grid').innerHTML = `<div class="empty-state" style="grid-column:1/-1">
    ${icon(iconName, 'icon')}
    <p class="empty-title">${h(title)}</p><p>${h(note)}</p></div>`;
  $('ibar-count').textContent = '';
}

/* ── 路由 render dispatch（唯一 popstate handler 的目的地）──────────── */

async function render(route) {
  state.route = route;

  switch (route.name) {
    case 'home': {
      if (!state.libs.length) {
        renderPlaceholderPage('尚未設定來源', '請以「＋ 新增來源」加入 Eagle 資源庫（dialog 於 B2 實作）', 'plus');
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
      if (!lib) { renderPlaceholderPage('找不到庫', libId, 'close'); return; }
      try { await ensureLibLoaded(libId); }
      catch (e) { renderPlaceholderPage('載入失敗', e.message, 'close'); return; }
      renderTree();

      // 麵包屑：庫 ▸ 夾 ▸ 子夾
      const crumbs = [{ label: lib.label, hash: libHash(libId) }];
      if (folderId) {
        const chain = [];
        for (let id = folderId; id; id = state.folderMap[id]?.parentId)
          chain.unshift({ label: state.folderMap[id]?.name || id,
                          hash: `${libHash(libId)}/folder/${encodeURIComponent(id)}` });
        crumbs.push(...chain);
      }
      renderBreadcrumb(crumbs);

      if (lib.type === 'excire') {
        const d = await api.excirePhotos(lib.slug,
          { folder: folderId || undefined, limit: GRID_CAP });
        renderGrid(d.items || [], d.total ?? (d.items || []).length);
        renderInspectorSummary(d.items || [], d.total ?? 0);
      } else {
        let items = state.items.filter(i => !(i.tags || []).includes('archived'));
        if (folderId) {
          const ids = folderWithDescendants(folderId);
          items = items.filter(i => (i.folders || []).some(f => ids.has(f)));
        }
        renderGrid(items, items.length);
        renderInspectorSummary(items.slice(0, GRID_CAP), items.length);
      }
      return;
    }

    case 'trash':      renderPlaceholderPage('垃圾桶', '兩步保護垃圾桶視圖於 B4 實作', 'trash'); return;
    case 'collection': renderPlaceholderPage('集合', 'Collections / 智慧集合於 B2/B5 實作', 'folder'); return;
    case 'search':     renderPlaceholderPage('搜尋', '⌘K 語法模式於 B2 實作', 'search'); return;
    case 'people':     renderPlaceholderPage('人物', '人臉搜尋將於 AI 階段（P6）啟用', 'people'); return;
    case 'downloads':  renderPlaceholderPage('下載中心', '佇列/歷史/服務健康於 B5 實作', 'download'); return;
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
  $('btn-omni').addEventListener('click', () =>
    renderPlaceholderPage('⌘K 搜尋指揮中心', '語法/NL/人物/相似圖模式於 B2/P6 實作', 'command'));

  try {
    const cfg = await api.config();
    if (cfg && cfg.configured === false) { /* 空來源：home 路由顯示引導卡 */ }
    await loadSources();
  } catch (e) {
    renderPlaceholderPage('無法連線後端', e.message, 'close');
  }
  renderSources();
  startRouter(render);
}

boot();
