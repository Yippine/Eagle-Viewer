'use strict';
/* ── ui-filters.js  ▸  Domain chips / Tag chips / 篩選 UI ───────────────── */

import { state }         from './state.js';
import { h, HIDE_TAGS, isMobile } from './utils.js';
import { applyFilter }   from './grid.js';

/* ── 動態 Panel 高度（MECE × SESE 響應式）────────────────────────────
 *  設計律：篩選區總高度 ≤ 50vh（上半篩選器，下半結果）— 桌面 + 手機均適用
 *  公式：
 *    overhead  = hdr + fbar-toggle + folder-filter-bar（若可見）
 *    budget    = ⌊innerHeight × 0.50⌋ − overhead   ← 50vh 扣固定區
 *    perPanel  = ⌊budget / openCount⌋               ← 等分展開數
 *
 *  CSS custom property 覆寫 max-height 值，transition 動畫不受影響
 *  呼叫時機：
 *    1. 每次 toggle/close（state 已更新、classList 尚未變更）← 時序關鍵
 *    2. window.resize（debounce 100ms）
 */
let _rszTimer = null;
function _syncPanelHeights() {
  const fbarChips   = document.getElementById('fbar-chips');
  const tagPanel    = document.getElementById('tag-panel');
  const presetPanel = document.getElementById('preset-panel');

  // 固定佔用高度：header（2-row + Row2 篩選按鈕，offsetHeight 自動反映）
  // fbar-toggle 已移至 header Row2，folder-filter-bar 已廢棄，均不再單獨計入
  const hdrH    = document.getElementById('hdr')?.offsetHeight || 0;
  const overhead = hdrH;

  // 預算比例：桌面 65%（三欄各約 196px，單欄約 589px），手機 60%（單開不超版面）
  // 至少保留 80px / panel 讓使用者感知到 panel 存在
  const budgetRatio = isMobile() ? 0.60 : 0.65;
  const budget = Math.max(Math.floor(window.innerHeight * budgetRatio) - overhead, 80);

  // 統計目前展開數（呼叫前 state 已更新，openCount 反映本次 toggle 後的狀態）
  const openCount = [state.fbarOpen, state.tagsOpen, state.presetOpen].filter(Boolean).length;
  const perPanel  = openCount > 0 ? Math.max(Math.floor(budget / openCount), 80) : 80;

  // 以 CSS custom property 注入（桌面 + 手機均適用）
  // → max-height: var(--X-panel-mh, fallback) transition 從 0 正確動畫至計算值
  const px = perPanel + 'px';
  fbarChips?.style.setProperty('--fbar-panel-mh',     px);
  tagPanel?.style.setProperty('--tag-panel-mh',       px);
  presetPanel?.style.setProperty('--preset-panel-mh', px);
}

// 視窗 resize / orientation change 時重算（debounce 100ms）
window.addEventListener('resize', () => {
  clearTimeout(_rszTimer);
  _rszTimer = setTimeout(_syncPanelHeights, 100);
}, { passive: true });

/* ── Domain chips ───────────────────────────────────────────────────── */
export function buildDomainChips() {
  const cnt = {};
  state.ALL.forEach(i => { cnt[i.domain] = (cnt[i.domain] || 0) + 1; });
  const rows = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  document.getElementById('dchips').innerHTML =
    _dchip('all', '全部', state.ALL.length, state.curDomains.size === 0) +
    rows.map(([d, c]) => _dchip(d, d, c, state.curDomains.has(d))).join('');
  _updateFbarLabel();
}

function _dchip(d, label, cnt, on) {
  return `<button class="dchip${on ? ' on' : ''}" data-d="${h(d)}"
    onclick="setDomain('${h(d)}')">${h(label)}<span class="n">${cnt}</span></button>`;
}

/** Domain 切換（單選）：點擊已選則取消，否則取代（單選語意）
 *  setDomain 名稱保留供 dchip onclick 使用 */
export function setDomain(d) {
  if (d === 'all') {
    state.curDomains.clear();
  } else {
    if (state.curDomains.has(d)) {
      state.curDomains.delete(d);   // 再次點擊 → 取消選取
    } else {
      state.curDomains.clear();     // 單選：清除舊選取
      state.curDomains.add(d);
    }
  }
  document.querySelectorAll('.dchip').forEach(el => {
    const isAll = el.dataset.d === 'all';
    el.classList.toggle('on', isAll ? state.curDomains.size === 0 : state.curDomains.has(el.dataset.d));
  });
  _updateFbarLabel();
  updateSearchChips();
  applyFilter();
}

function _updateFbarLabel() {
  const lbl = document.getElementById('fbar-label');
  const cnt = document.getElementById('fbar-count');
  const btn = document.getElementById('domain-filter-btn');
  if (!lbl) return;

  lbl.textContent = '';

  const hasSelection = state.curDomains.size > 0;
  cnt.textContent = hasSelection ? '1' : '';
  btn?.classList.toggle('on', hasSelection);
  if (btn) {
    const d = hasSelection ? [...state.curDomains][0] : '';
    btn.title = hasSelection ? `網域篩選：${d}` : '網域篩選';
  }
}

/** 互斥關閉其他 filter panels（w019）
 * 不呼叫 history.back，直接更新 state + DOM，避免非同步 nav 干擾。
 * _tagHistoryPushed 清為 false，orphan history state 留存但無害
 * （下次 toggleTagPanel 開啟時會重新 pushState）。
 */
function _closeOtherPanels({ exceptFbar, exceptTag, exceptPreset } = {}) {
  if (!exceptFbar && state.fbarOpen) {
    state.fbarOpen = false;
    document.getElementById('fbar')?.classList.remove('open');
    // fbar-arrow 旋轉由 CSS #fbar.open 控制，無需 JS 更改 textContent
  }
  if (!exceptTag && state.tagsOpen) {
    state.tagsOpen = false;
    document.getElementById('tag-panel')?.classList.remove('open');
    document.getElementById('tag-tog-inline')?.classList.remove('open');
    _tagHistoryPushed = false;
  }
  if (!exceptPreset && state.presetOpen) {
    state.presetOpen = false;
    document.getElementById('preset-panel')?.classList.remove('open');
    document.getElementById('preset-tog-inline')?.classList.remove('open');
  }
  window._closeTypeMenu?.();   // 通知 main.js 關閉 type-menu（如已開啟）
  _syncPanelHeights();
}

export function toggleFbar() {
  _closeOtherPanels({ exceptFbar: true });   // 互斥（w019）
  state.fbarOpen = !state.fbarOpen;
  _syncPanelHeights();  // ← 先算好 custom property，再 toggle class（transition 才正確）
  document.getElementById('fbar').classList.toggle('open', state.fbarOpen);
  // fbar-arrow 旋轉由 CSS `#fbar.open #domain-filter-btn .fbar-filter-arrow` 控制，JS 無需改 textContent
}

/* ── Folder Tree（取代 flat tag chips）───────────────────────────────── */

/** 展開狀態持久化（Set<folder_id>） */
let _treeOpenIds = new Set(
  JSON.parse(localStorage.getItem('eagle-tree-open') || '[]')
);

function _saveTreeOpen() {
  try { localStorage.setItem('eagle-tree-open', JSON.stringify([..._treeOpenIds])); } catch {}
}

/* ── 三模式切換（eagle-tree-mode，與 folder-picker 共用 key）──── */
const _TREE_MODE_CYCLE = ['collapsed', 'selectedOnly', 'allOpen'];
// 按鈕顯示「下一步動作」的 icon（點了之後會發生什麼）
const _TREE_MODE_NEXT_ICON  = { collapsed: '⊙', selectedOnly: '⊕', allOpen: '⊖' };
const _TREE_MODE_NEXT_TITLE = {
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

/** 套用三模式至 _treeOpenIds，並重繪 tree */
function _applyTreeMode(mode) {
  const fmap = state.folderMap || {};
  if (mode === 'collapsed') {
    _treeOpenIds.clear();
  } else if (mode === 'allOpen') {
    Object.entries(fmap).forEach(([id, f]) => { if (!f.isLeaf) _treeOpenIds.add(id); });
  } else if (mode === 'selectedOnly') {
    _treeOpenIds.clear();
    for (const selId of (state.curFolderIds || [])) {
      let pid = fmap[selId]?.parentId;
      while (pid) { _treeOpenIds.add(pid); pid = fmap[pid]?.parentId; }
    }
  }
  _saveTreeOpen();
  buildFolderTree();
}

window.cycleTreeMode = function() {
  const cur  = _getTreeMode();
  const next = _TREE_MODE_CYCLE[(_TREE_MODE_CYCLE.indexOf(cur) + 1) % _TREE_MODE_CYCLE.length];
  _setTreeMode(next);
  _applyTreeMode(next);
  // 兩個 tree 共用 eagle-tree-mode localStorage key，下次開啟時自動讀取最新模式
};

/** 遞迴取得 id 的所有後代葉節點 ID */
function _getAllLeafIds(id) {
  const f = state.folderMap[id];
  if (!f) return [];
  if (f.isLeaf) return [id];
  return (f.childrenIds || []).flatMap(cid => _getAllLeafIds(cid));
}

function _isFullSelected(id) {
  const leaves = _getAllLeafIds(id);
  return leaves.length > 0 && leaves.every(lid => state.curFolderIds.has(lid));
}

function _isPartialSelected(id) {
  const leaves = _getAllLeafIds(id);
  const n = leaves.filter(lid => state.curFolderIds.has(lid)).length;
  return n > 0 && n < leaves.length;
}

/**
 * 遞迴檢查 id 的直接或間接子代中，是否有任意節點在 curFolderIds 中。
 * 用於計算祖先的 partial（淺藍）狀態：selectFolderBranch 選中的是非葉父節點，
 * _isPartialSelected（葉節點路徑）無法偵測到，因此需要此函數。
 */
function _hasAnySelected(id) {
  const f = state.folderMap[id];
  if (!f) return false;
  return (f.childrenIds || []).some(cid =>
    !!(state.curFolderIds?.has(cid)) || _hasAnySelected(cid)
  );
}

/* ── 資料夾計數快取（BUG 4）────────────────────────────────────────
 *  計算每個 folder（含後代）的 item 數量：
 *  1. 先掃描 state.ALL，對每個 item 的直接 folderIds 各加 1
 *  2. 再自根向下後序 DFS，將子代計數累加至父節點
 *  複雜度：O(items × folders_per_item + folder_count) — 千筆以下單毫秒完成
 *
 *  注意：item.folders 存的是「直接所在資料夾」ID，
 *  父節點點選時透過 _isInBranch 遞迴命中後代 → 計數需同樣向上傳遞
 */
let _folderCountMap = {};

function _buildFolderCountMap() {
  _folderCountMap = {};
  const fmap = state.folderMap || {};

  // Step 1：直接計數（每個 item 對其直接 folderIds 各累加）
  state.ALL.forEach(item => {
    (item.folders || []).forEach(fid => {
      _folderCountMap[fid] = (_folderCountMap[fid] || 0) + 1;
    });
  });

  // Step 2：後序 DFS — 子代計數累加至父節點
  //  使用 memo 避免重複計算；同一 item 屬多個同父子資料夾時 Set 防重計
  const memo = {};
  function aggregate(id) {
    if (id in memo) return memo[id];
    const f = fmap[id];
    if (!f || f.isLeaf) { memo[id] = _folderCountMap[id] || 0; return memo[id]; }
    let total = _folderCountMap[id] || 0;
    for (const cid of (f.childrenIds || [])) total += aggregate(cid);
    _folderCountMap[id] = total;
    memo[id] = total;
    return total;
  }
  const roots = Object.keys(fmap).filter(id => fmap[id].parentId === null);
  roots.forEach(id => aggregate(id));
}

/** 渲染單一樹節點（含子節點區塊）*/
function _renderTreeNode(id, depth) {
  const f = state.folderMap[id];
  if (!f) return '';
  const isLeaf = f.isLeaf;
  // 深藍：只有直接被點選的節點（selectFolderBranch / _filterByFolderId 加入 curFolderIds）
  const isDirect  = !!(state.curFolderIds?.has(id));
  const isOn      = isDirect;
  // 淺藍（partial）：自身未直接選中，但有任意後代（葉或非葉）被選中
  const isPartial = !isDirect && !isLeaf && _hasAnySelected(id);
  const isOpen    = _treeOpenIds.has(id);

  const chevron = isLeaf
    ? `<span class="tree-spacer"></span>`
    : `<button class="tree-chevron${isOpen ? ' open' : ''}" data-id="${id}"
         onclick="toggleTreeNode('${h(id)}')" title="展開/收合">▶</button>`;

  const onCls = isOn ? ' on' : (isPartial ? ' partial' : '');
  const clickFn = isLeaf
    ? `_filterByFolderId('${h(id)}')`
    : `selectFolderBranch('${h(id)}')`;

  // BUG 4：顯示資料夾 item 計數（含後代）
  const cnt = _folderCountMap[id] ?? 0;
  const cntSpan = `<span class="tree-count">${cnt}</span>`;

  const children = isLeaf ? '' :
    `<div class="tree-children" id="tc-${id}"${isOpen ? '' : ' hidden'}>
       ${(f.childrenIds || []).map(cid => _renderTreeNode(cid, depth + 1)).join('')}
     </div>`;

  // tree-name 包裝：flex 佈局下 ellipsis 正常截斷，count pill 不被 overflow:hidden 吞掉
  return `<div class="tree-node" data-id="${id}" style="--depth:${depth}">
    ${chevron}
    <button class="tree-item${onCls}" data-id="${id}" onclick="${clickFn}"><span class="tree-name">${h(f.name)}</span>${cntSpan}</button>
  </div>${children}`;
}

/** 建立 folder tree（取代 buildTagChips）—— folderMap 必須已就緒 */
export function buildFolderTree() {
  const fmap = state.folderMap || {};
  // 根節點：parentId === null
  const roots = Object.keys(fmap).filter(id => fmap[id].parentId === null);

  // BUG 4：先建立計數 map，再渲染節點
  _buildFolderCountMap();

  const mode    = _getTreeMode();
  // 搜尋列：[✕清除] [search input] [模式 icon]
  const searchRow = `<div class="tree-search-wrap">
    <button class="ftag-clear" onclick="clearAllTags()" title="清除全部篩選">✕</button>
    <input id="tree-search" class="tree-search" type="search"
           placeholder="搜尋資料夾…" autocomplete="off"
           oninput="filterFolderTree(this.value)">
    <button class="tree-mode-btn" id="tree-mode-btn"
      onclick="cycleTreeMode()"
      title="${_TREE_MODE_NEXT_TITLE[mode]}">${_TREE_MODE_NEXT_ICON[mode]}</button>
  </div>`;
  const treeHtml = roots.map(id => _renderTreeNode(id, 0)).join('');

  document.getElementById('tchips').innerHTML =
    searchRow + `<div class="tree-nodes" id="tree-nodes">${treeHtml}</div>`;
}

/** 即時搜尋過濾資料夾 tree（顯示匹配節點及其所有祖先） */
export function filterFolderTree(q) {
  const lower = q.toLowerCase().trim();
  if (!lower) {
    // 還原所有節點可見性，套用 collapse 狀態
    document.querySelectorAll('.tree-node').forEach(el => { el.hidden = false; });
    document.querySelectorAll('.tree-children').forEach(el => {
      const id = el.id.replace('tc-', '');
      el.hidden = !_treeOpenIds.has(id);
    });
    return;
  }
  // 找出所有匹配節點及其祖先
  const visible = new Set();
  Object.entries(state.folderMap).forEach(([id, f]) => {
    if (f.name.toLowerCase().includes(lower)) {
      visible.add(id);
      let pid = f.parentId;
      while (pid) { visible.add(pid); pid = state.folderMap[pid]?.parentId; }
    }
  });
  document.querySelectorAll('.tree-node').forEach(el => {
    el.hidden = !visible.has(el.dataset.id);
  });
  // 搜尋中展開所有 children（讓父節點下的匹配項可見）
  document.querySelectorAll('.tree-children').forEach(el => { el.hidden = false; });
}

/** 展開/收合父節點 */
export function toggleTreeNode(id) {
  const childrenEl = document.getElementById(`tc-${id}`);
  if (!childrenEl) return;
  const isOpen = !childrenEl.hidden;
  childrenEl.hidden = isOpen;
  if (isOpen) _treeOpenIds.delete(id); else _treeOpenIds.add(id);
  _saveTreeOpen();
  const chevron = document.querySelector(`.tree-chevron[data-id="${CSS.escape(id)}"]`);
  if (chevron) chevron.classList.toggle('open', !isOpen);
}

/** 父節點點選：toggle 節點自身 ID（語意 = 包含其所有後代 items）
 *
 *  篩選邏輯由 search.js _isInBranch 處理：
 *  item.folders 中有 fid 本身 OR 任意後代 folder → 視為命中
 *
 *  ⚠️ 不再展開後代葉節點：點「室內」= 一個 chip「📁 室內」，
 *  而非把房間/教室/廁所... 全部 AND 進去（那樣幾乎沒有結果）
 */
export function selectFolderBranch(id) {
  if (!state.curFolderIds) state.curFolderIds = new Set();
  if (state.curFolderIds.has(id)) state.curFolderIds.delete(id);
  else state.curFolderIds.add(id);
  applyFilter();
  updateSearchChips();
  _syncTreeNodes();
}

/** 重繪所有 tree-item 的 .on/.partial 狀態 */
function _syncTreeNodes() {
  document.querySelectorAll('.tree-item[data-id]').forEach(el => {
    const id = el.dataset.id;
    const f  = state.folderMap[id];
    if (!f) return;
    const isDirect = !!(state.curFolderIds?.has(id));
    if (f.isLeaf) {
      el.classList.toggle('on', isDirect);
      el.classList.remove('partial');
    } else {
      // 深藍：只有直接選中；淺藍：有任意後代被選中
      el.classList.toggle('on', isDirect);
      el.classList.toggle('partial', !isDirect && _hasAnySelected(id));
    }
  });
}

/** ─── Search Chips（取代 folder-filter-bar）───────────────────────────
 *  選中的 domain / folder / preset 顯示為 chips 在搜尋框內
 *  呼叫時機：所有篩選狀態變更後 */
/** 資料夾 + 濾鏡 badge 數字更新（w019）*/
function _updateFilterBtnBadges() {
  // 資料夾 badge
  const tagCnt = document.getElementById('tag-fbar-count');
  if (tagCnt) {
    const n = state.curFolderIds?.size || 0;
    tagCnt.textContent = n > 0 ? String(n) : '';
    document.getElementById('tag-tog-inline')?.classList.toggle('on', n > 0);
  }
  // 濾鏡 badge（w020 多選 OR：顯示已選數量）
  const presetCnt = document.getElementById('preset-fbar-count');
  if (presetCnt) {
    const n = state.curPresets?.size || 0;
    presetCnt.textContent = n > 0 ? String(n) : '';
    document.getElementById('preset-tog-inline')?.classList.toggle('on', n > 0);
  }
}

export function updateSearchChips() {
  const el = document.getElementById('srch-chips');
  if (!el) return;
  const chips = [];
  const fmap = state.folderMap || {};

  // Type chip（BUG 2：類型篩選標籤）
  const _typeLabels = { bookmark: '書籤', video: '影片', gif: '動圖', image: '圖片' };
  const _typeIcons  = { bookmark: '🔖', video: '🎬', gif: '🖼', image: '🌅' };
  if (state.curType && state.curType !== 'all') {
    const label = _typeLabels[state.curType] || state.curType;
    const icon  = _typeIcons[state.curType]  || '🗂️';
    chips.push(`<span class="srch-chip srch-chip-type">${icon} ${h(label)}<button class="srch-chip-rm"
      onclick="clearTypeFilter()" title="取消類型篩選">✕</button></span>`);
  }

  // Domain chips（curDomains 非空時各別顯示）
  for (const d of (state.curDomains || [])) {
    chips.push(`<span class="srch-chip srch-chip-domain">🌐 ${h(d)}<button class="srch-chip-rm"
      onclick="setDomain('${h(d)}')" title="取消此網域">✕</button></span>`);
  }

  // Folder chips（curFolderIds）
  for (const id of (state.curFolderIds || [])) {
    const name = fmap[id]?.name || id;
    chips.push(`<span class="srch-chip srch-chip-folder">📁 ${h(name)}<button class="srch-chip-rm"
      onclick="_filterByFolderId('${h(id)}')" title="取消此資料夾">✕</button></span>`);
  }

  // Preset chips（w020 多選 OR：逐一顯示已選濾鏡）
  if (state.curPresets?.size) {
    let presets = [];
    try { presets = JSON.parse(localStorage.getItem('eagle-filter-presets') || '[]'); } catch {}
    for (const pid of state.curPresets) {
      const p = presets.find(x => x.id === pid);
      if (p) chips.push(`<span class="srch-chip srch-chip-preset">🎛️ ${h(p.name)}<button class="srch-chip-rm"
        onclick="setPresetFilter('${h(pid)}')" title="取消此濾鏡">✕</button></span>`);
    }
  }

  el.innerHTML = chips.join('');
  _updateFilterBtnBadges();   // 同步資料夾 + 濾鏡 badge 數字（w019）

  // 動態調整 placeholder：chips 存在時縮短提示，讓手機版輸入框清楚可讀
  // chips 清空時還原完整語法提示（桌面版發現性提示）
  const searchEl = document.getElementById('search');
  if (searchEl) {
    searchEl.placeholder = chips.length > 0
      ? '搜尋…'
      : '搜尋  tag:標籤  -domain:x.com  "完整詞"';
  }
}

/** 向後相容：renderActiveFolderChips → 改由 updateSearchChips 處理
 *  同時隱藏 folder-filter-bar（amber 色列已由 srch-chips 取代）*/
export function renderActiveFolderChips() {
  updateSearchChips();
  const bar = document.getElementById('folder-filter-bar');
  if (bar) { bar.innerHTML = ''; bar.hidden = true; }
}

/* ── Tag chips（保留舊 API 供向後相容；新入口為 buildFolderTree）─────── */
export function buildTagChips() { buildFolderTree(); }

export function clearAllTags() {
  state.curTags.clear();
  state.curFolderIds?.clear();
  document.querySelectorAll('.ftag').forEach(el => el.classList.remove('on'));
  applyFilter();
  updateSearchChips();
  _syncTreeNodes();  // 清除 tree .on/.partial 狀態
}

/** 一鍵清除全部篩選條件 + 搜尋關鍵字（搜尋框 ✕ 按鈕使用）*/
export function clearAllFilters() {
  state.curDomains.clear();
  state.curFolderIds?.clear();
  state.curTags.clear();
  state.curPresets?.clear();
  state.curType = 'all';
  // 清除搜尋文字
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';
  state.curQ = '';
  // 重置 domain chips UI
  document.querySelectorAll('.dchip').forEach(el =>
    el.classList.toggle('on', el.dataset.d === 'all'));
  _updateFbarLabel();
  // 重置 type dropdown UI（P3）
  window._updateTypeUI?.();
  applyFilter();
  updateSearchChips();
  _syncTreeNodes();
}

let _tagHistoryPushed = false;

export function toggleTagPanel() {
  _closeOtherPanels({ exceptTag: true });   // 互斥（w019）
  state.tagsOpen = !state.tagsOpen;
  _syncPanelHeights();  // ← 先算好 custom property，再 toggle class
  document.getElementById('tag-panel').classList.toggle('open', state.tagsOpen);
  document.getElementById('tag-tog-inline')?.classList.toggle('open', state.tagsOpen);
  if (state.tagsOpen) {
    history.pushState({ overlay: 'tagpanel' }, '');
    _tagHistoryPushed = true;
  } else {
    if (_tagHistoryPushed) history.back();
    _tagHistoryPushed = false;
  }
}

export function closeTagPanel(fromPopstate = false) {
  if (!state.tagsOpen) return;
  state.tagsOpen = false;
  _syncPanelHeights();  // ← 先算好 custom property，再移除 class
  document.getElementById('tag-panel').classList.remove('open');
  document.getElementById('tag-tog-inline')?.classList.remove('open');
  if (!fromPopstate && _tagHistoryPushed) history.back();
  _tagHistoryPushed = false;
}

export function toggleTag(tag) {
  const el = document.querySelector(`.ftag[data-tag="${CSS.escape(tag)}"]`);
  if (state.curTags.has(tag)) { state.curTags.delete(tag); el?.classList.remove('on'); }
  else                        { state.curTags.add(tag);    el?.classList.add('on'); }
  applyFilter();
}

/* ── 標籤篩選動作 ────────────────────────────────────────────────────── */
/** 單一標籤切換（卡片 chip 點擊） */
export function filterByTag(tag) {
  if (state.curTags.has(tag)) state.curTags.delete(tag);
  else state.curTags.add(tag);
  document.querySelectorAll('.ftag').forEach(el =>
    el.classList.toggle('on', state.curTags.has(el.dataset.tag)));
  if (state.curTags.size && !state.tagsOpen) toggleTagPanel();
  applyFilter();
}

/** 套用整組標籤（清除舊選取，代入新集合） */
export function applyTagSet(tags) {
  state.curTags.clear();
  tags.forEach(t => state.curTags.add(t));
  document.querySelectorAll('.ftag').forEach(el =>
    el.classList.toggle('on', state.curTags.has(el.dataset.tag)));
  if (tags.length && !state.tagsOpen) toggleTagPanel();
  applyFilter();
}

/** .cfolders chip 點擊 / tag filter 點擊：以 folder ID 進行 AND 交集篩選（toggle in/out）
 *  多個選取 = 交集（item 必須同時屬於所有 curFolderIds 才顯示）
 *  tag chip 現在也走此函式（data-folder-id 已在 buildTagChips 中設定） */
export function filterByFolderId(id) {
  if (!state.curFolderIds) state.curFolderIds = new Set();
  if (state.curFolderIds.has(id)) {
    state.curFolderIds.delete(id);
  } else {
    state.curFolderIds.add(id);
  }
  applyFilter();
  updateSearchChips();
  _syncTreeNodes();  // 重繪 tree .on/.partial 狀態
}

/** 所有 tag chip active 狀態同步（支援 folder-ID 模式的 chip）*/
function _syncAllTagChips() {
  document.querySelectorAll('.ftag[data-folder-id]').forEach(el => {
    const fid = el.dataset.folderId;
    if (fid) el.classList.toggle('on', state.curFolderIds?.has(fid) ?? false);
  });
}

/** 卡片 📂/🔍 按鈕：以 leaf folder ID 取代目前 curFolderIds 篩選（REPLACE 語意）
 *  若無 leaf folder → fallback：套用所有可見標籤（curTags）
 *  只使用 leaf（isLeaf=true）避免祖先節點污染篩選範圍 */
export function filterByItemTags(btn) {
  const item = state.ALL.find(x => x.id === btn.dataset.itemId);
  if (!item) return;

  const fmap = state.folderMap || {};
  const leafIds = (item.folders || []).filter(id => fmap[id]?.isLeaf);

  if (leafIds.length > 0) {
    // REPLACE：以此項目的 leaf folder IDs 取代目前資料夾篩選
    state.curFolderIds = new Set(leafIds);
    applyFilter();
    updateSearchChips();
    _syncTreeNodes();
  } else {
    // fallback：無 leaf folder → 套用可見標籤（curTags AND 邏輯）
    const tags = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
    applyTagSet(tags);
  }
}

/** 顯示 leaf folder 選擇 popover（定位在 btn 附近） */
export function showFolderPopover(btn, leafFolders) {
  const popover  = document.getElementById('item-folder-popover');
  const chipsEl  = document.getElementById('ifp-chips');
  const backdrop = document.getElementById('ifp-backdrop');
  if (!popover || !chipsEl) return;

  chipsEl.innerHTML = leafFolders
    .map(f => `<button class="ifp-chip" onclick="_applyFolderFilter('${h(f.name)}')">${h(f.name)}</button>`)
    .join('');

  // 定位：讓 popover 出現在按鈕正下方
  const rect = btn.getBoundingClientRect();
  const vw   = window.innerWidth;
  const left = Math.min(rect.left, vw - 300);
  popover.style.display = 'block';
  popover.style.top     = (rect.bottom + window.scrollY + 6) + 'px';
  popover.style.left    = Math.max(8, left) + 'px';
  if (backdrop) backdrop.style.display = 'block';
}

/** 從 popover 選定資料夾後套用篩選並關閉 */
export function applyFolderFilter(name) {
  closeFolderPopover();
  applyTagSet([name]);
}

/** 關閉 leaf folder popover */
export function closeFolderPopover() {
  const popover  = document.getElementById('item-folder-popover');
  const backdrop = document.getElementById('ifp-backdrop');
  if (popover)  popover.style.display  = 'none';
  if (backdrop) backdrop.style.display = 'none';
}

/* ── Preset Filter Panel ─────────────────────────────────────────── */
/** 計算每個 preset 有多少 item 套用（BUG 5）
 *  迭代 state.ALL 一次，從 localStorage 讀取各 item 的 presetIds，
 *  複雜度 O(items)：大型資料庫仍可接受 */
function _buildPresetCountMap() {
  const counts = {};
  state.ALL.forEach(item => {
    try {
      const vd = JSON.parse(localStorage.getItem(`eagle-media-filter-${item.id}`) || '{}');
      (vd.presetIds || []).forEach(pid => {
        counts[pid] = (counts[pid] || 0) + 1;
      });
    } catch {}
  });
  return counts;
}

export function buildPresetChips() {
  const el = document.getElementById('pchips');
  if (!el) return;
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('eagle-filter-presets') || '[]'); } catch {}
  presets = presets.filter(p => !p.deleted);
  // BUG 5：計算各 preset 的 item 數量並顯示
  const presetCounts = _buildPresetCountMap();
  const clearBtn = `<button class="fpreset-clear" onclick="clearPresetFilter()" title="清除全部濾鏡篩選">✕</button>`;
  el.innerHTML = clearBtn + presets.map(p => {
    const cnt = presetCounts[p.id] || 0;
    return `<button class="fpreset${(state.curPresets?.has(p.id)) ? ' on' : ''}" data-pid="${h(p.id)}" ` +
      `onclick="setPresetFilter('${h(p.id)}')">${h(p.name)}<span class="preset-count">${cnt}</span></button>`;
  }).join('');
}

export function togglePresetPanel() {
  _closeOtherPanels({ exceptPreset: true });   // 互斥（w019）
  state.presetOpen = !state.presetOpen;
  _syncPanelHeights();  // ← 先算好 custom property，再 toggle class
  document.getElementById('preset-panel').classList.toggle('open', state.presetOpen);
  document.getElementById('preset-tog-inline')?.classList.toggle('open', state.presetOpen);
  if (state.presetOpen) buildPresetChips();
}

export function closePresetPanel() {
  if (!state.presetOpen) return;
  state.presetOpen = false;
  _syncPanelHeights();  // ← 先算好 custom property，再移除 class
  document.getElementById('preset-panel').classList.remove('open');
  document.getElementById('preset-tog-inline')?.classList.remove('open');
}

/** 切換單一濾鏡（單選：點擊已選則取消，否則取代）*/
export function setPresetFilter(id) {
  if (!state.curPresets) state.curPresets = new Set();
  if (state.curPresets.has(id)) {
    state.curPresets.delete(id);   // 再次點擊 → 取消選取
  } else {
    state.curPresets.clear();      // 單選：清除舊選取
    state.curPresets.add(id);
  }
  buildPresetChips();
  updateSearchChips();
  applyFilter();
}

/** 清除全部濾鏡篩選 (w020) */
export function clearPresetFilter() {
  state.curPresets?.clear();
  buildPresetChips();
  updateSearchChips();
  applyFilter();
}

// 互斥面板關閉 - 掛 window 供 main.js toggleTypeMenu 呼叫（w019）
window._closeOtherPanels = _closeOtherPanels;
