/* ── toolbar.js ▸ Toolbar chips + 排序 + seeded 隨機 + 密度（B2）─────────
   篩選唯一語彙 = toolbar chips（spec §1.3，解 V3）：
   五維 chips（型別/星等/標籤/日期/尺寸）+ 網域/資料夾疊加/搜尋詞 chips，
   各自 ✕、一鍵全清、Escape 逐層退出；狀態 ↔ URL query 雙向同步（§5.2）。
   排序 8+1 鍵；🔀 = 新 seed，ibar 內 ‹seed› 歷史可重播（C17）。 */

import { store, defaultFilters } from './store.js';
import { navigate, parseRoute } from './router.js';
import { SORT_KEYS, h } from './items.js';

const TYPE_OPTS = [['all', '全部'], ['image', '圖片'], ['video', '影片'], ['gif', '動圖'], ['bookmark', '書籤']];
const DATE_OPTS = [['', '任意時間'], ['today', '今天'], ['7d', '7 天內'], ['30d', '30 天內'], ['365d', '一年內']];
const SIZE_OPTS = [['', '任意尺寸'], ['s', '小（<1MP）'], ['m', '中（1–4MP）'], ['l', '大（4–12MP）'], ['xl', '特大（>12MP）']];
const DIM_LABEL = { type: '型別', star: '星等', tags: '標籤', date: '日期', size: '尺寸' };
const ESC_ORDER = ['q', 'folders', 'tags', 'domains', 'size', 'date', 'star', 'type'];   // Escape 逐層
const MAX_SEEDS_KEY = 'eagle-pref-max-seeds';

let _folderName = id => id;      // app.js 注入（chips 顯示資料夾名）
let _menuEl = null;

export function setFolderNameResolver(fn) { _folderName = fn; }

/* ── 初始化 ─────────────────────────────────────────────────────────── */

export function initToolbar() {
  _loadView();
  _loadSeeds();
  document.getElementById('btn-sort').addEventListener('click', e => _sortMenu(e.currentTarget));
  document.getElementById('btn-shuffle').addEventListener('click', () => {
    store.state.sort = { key: 'shuffle', dir: 'desc' };
    _newSeed();
    _updateURL();
  });
  document.getElementById('btn-density').addEventListener('click', e => _densityMenu(e.currentTarget));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (_menuEl) { closeMenu(); return; }
    if (document.querySelector('.palette-backdrop.show')) return;   // ⌘K 自理
    if (store.state.selection.size) return;                          // selection.js 自理
    _escapePop();
  });
  document.addEventListener('click', e => {
    if (_menuEl && !_menuEl.contains(e.target)) closeMenu();
  }, true);
}

/* ── URL ↔ state 雙向同步 ───────────────────────────────────────────── */

/** 路由 query → filters/sort/seed（render 流程唯一入口，URL 即狀態） */
export function syncFromRoute(route) {
  const q = route.query;
  const f = defaultFilters();
  f.q       = q.get('q') || '';
  f.type    = q.get('type') || 'all';
  f.star    = Math.min(5, Math.max(0, parseInt(q.get('star') || '0', 10) || 0));
  f.tags    = (q.get('tags') || '').split(',').filter(Boolean);
  f.date    = q.get('date') || '';
  f.size    = q.get('size') || '';
  f.domains = (q.get('domain') || '').split(',').filter(Boolean);
  f.folders = (q.get('folders') || '').split(',').map(s => s.replace(/^\+/, '')).filter(Boolean);
  const key = q.get('sort') || 'shuffle';
  const dir = q.get('dir') === 'asc' ? 'asc' : 'desc';
  const seed = q.get('seed') ? (parseInt(q.get('seed'), 10) >>> 0) : null;
  store.set({ filters: f, sort: { key, dir } });
  if (seed != null && key === 'shuffle') _adoptSeed(seed);
  else if (key === 'shuffle' && store.state.seed == null) _newSeed(false);
  renderChips();
  _renderSortLabel();
  _renderSeedNav();
}

function _serialize() {
  const { filters: f, sort: s } = store.state;
  const p = new URLSearchParams();
  if (f.type !== 'all') p.set('type', f.type);
  if (f.star > 0)       p.set('star', String(f.star));
  if (f.tags.length)    p.set('tags', f.tags.join(','));
  if (f.date)           p.set('date', f.date);
  if (f.size)           p.set('size', f.size);
  if (f.domains.length) p.set('domain', f.domains.join(','));
  if (f.folders.length) p.set('folders', f.folders.map(x => '+' + x).join(','));
  if (f.q)              p.set('q', f.q);
  if (s.key !== 'shuffle' || s.dir !== 'desc') { p.set('sort', s.key); p.set('dir', s.dir); }
  if (s.key === 'shuffle' && store.state.seed != null) p.set('seed', String(store.state.seed));
  return p.toString();
}

/** filters/sort 變更 → replaceState URL → router 宣告式 re-render（§5.4） */
function _updateURL() {
  const cur = parseRoute();
  const qs = _serialize();
  navigate('#' + cur.path + (qs ? '?' + qs : ''), { replace: true });
}

function _patch(fn) { fn(store.state.filters); _updateURL(); }

/** ⌘K 套用查詢（若不在 lib 路由 → 導回目前庫） */
export function setQuery(q) {
  store.state.filters.q = q;
  const cur = parseRoute();
  if (cur.name === 'lib' || cur.name === 'folder') { _updateURL(); return; }
  const libId = store.state.libId;
  if (!libId) return;
  const qs = _serialize();
  navigate(`#/lib/${encodeURIComponent(libId)}${qs ? '?' + qs : ''}`);
}

/** 資料夾樹 Ctrl/⌘+點擊 → 疊加 AND 篩選（C10） */
export function toggleFolderFilter(id) {
  _patch(f => {
    const i = f.folders.indexOf(id);
    i >= 0 ? f.folders.splice(i, 1) : f.folders.push(id);
  });
}

/* ── Chips 渲染 ─────────────────────────────────────────────────────── */

export function renderChips() {
  const box = document.getElementById('filter-chips');
  if (!box) return;
  const f = store.state.filters;
  const chips = [];
  const dim = (k, active, label) =>
    `<button class="chip${active ? ' active' : ''}" data-dim="${k}">${h(label)}
       <svg class="icon icon-sm" aria-hidden="true"><use href="#i-chevron-d"/></svg></button>`;
  const val = (k, v, label, icon = '') =>
    `<span class="chip chip-filter">${icon}${h(label)}
       <button class="chip-x" data-rm="${k}" data-v="${h(v)}" title="移除">✕</button></span>`;

  chips.push(dim('type', f.type !== 'all', f.type === 'all' ? '型別'
    : TYPE_OPTS.find(o => o[0] === f.type)?.[1] || f.type));
  chips.push(dim('star', f.star > 0, f.star > 0 ? `★${f.star}+` : '星等'));
  chips.push(dim('tags', f.tags.length > 0, f.tags.length ? `標籤 ${f.tags.length}` : '標籤'));
  chips.push(dim('date', !!f.date, DATE_OPTS.find(o => o[0] === f.date)?.[1] || '日期'));
  chips.push(dim('size', !!f.size, SIZE_OPTS.find(o => o[0] === f.size)?.[1] || '尺寸'));

  for (const t of f.tags)     chips.push(val('tags', t, t, '🏷 '));
  for (const d of f.domains)  chips.push(val('domains', d, d, '🌐 '));
  for (const id of f.folders) chips.push(val('folders', id, _folderName(id), '📁 '));
  if (f.q) chips.push(val('q', f.q, f.q, '🔍 '));

  const any = f.type !== 'all' || f.star > 0 || f.tags.length || f.date || f.size
    || f.domains.length || f.folders.length || f.q;
  if (any) chips.push(`<button class="chip" data-clear-all title="清除全部篩選">✕ 全清</button>`);

  box.innerHTML = chips.join('');
  box.querySelectorAll('[data-dim]').forEach(el =>
    el.addEventListener('click', () => _dimMenu(el, el.dataset.dim)));
  box.querySelectorAll('[data-rm]').forEach(el =>
    el.addEventListener('click', () => _remove(el.dataset.rm, el.dataset.v)));
  box.querySelector('[data-clear-all]')?.addEventListener('click', () =>
    _patch(f2 => Object.assign(f2, { ...defaultFilters(), q: '' })));
}

function _remove(k, v) {
  _patch(f => {
    if (k === 'q') f.q = '';
    else if (k === 'tags' || k === 'domains' || k === 'folders')
      f[k] = f[k].filter(x => x !== v);
  });
}

function _escapePop() {
  const f = store.state.filters;
  for (const k of ESC_ORDER) {
    if (k === 'q' && f.q) return _patch(x => { x.q = ''; });
    if (['folders', 'tags', 'domains'].includes(k) && f[k].length)
      return _patch(x => { x[k] = x[k].slice(0, -1); });
    if (k === 'size' && f.size) return _patch(x => { x.size = ''; });
    if (k === 'date' && f.date) return _patch(x => { x.date = ''; });
    if (k === 'star' && f.star) return _patch(x => { x.star = 0; });
    if (k === 'type' && f.type !== 'all') return _patch(x => { x.type = 'all'; });
  }
}

/* ── Menus ──────────────────────────────────────────────────────────── */

export function closeMenu() { _menuEl?.remove(); _menuEl = null; }

function _openMenu(anchor, html) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = html;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top  = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
  _menuEl = m;
  return m;
}

const _mi = (v, label, on, extra = '') =>
  `<button class="menu-item${on ? ' on' : ''}" data-v="${h(v)}">${h(label)}${extra}</button>`;

function _dimMenu(anchor, dim) {
  const f = store.state.filters;
  const all = store.state.allItems;
  let html = '';
  if (dim === 'type') {
    const cnt = {};
    for (const i of all) cnt[i.mediaType] = (cnt[i.mediaType] || 0) + 1;
    html = TYPE_OPTS.map(([v, l]) => _mi(v, l, f.type === v,
      `<span class="menu-count">${v === 'all' ? all.length : (cnt[v] || 0)}</span>`)).join('');
  } else if (dim === 'star') {
    html = [0, 1, 2, 3, 4, 5].map(n =>
      _mi(String(n), n === 0 ? '任意星等' : '★'.repeat(n) + ' 以上', f.star === n)).join('');
  } else if (dim === 'date') {
    html = DATE_OPTS.map(([v, l]) => _mi(v, l, f.date === v)).join('');
  } else if (dim === 'size') {
    html = SIZE_OPTS.map(([v, l]) => _mi(v, l, f.size === v)).join('');
  } else if (dim === 'tags') {
    const cnt = new Map();
    for (const i of all) for (const t of (i.tags || []))
      if (t !== 'archived') cnt.set(t, (cnt.get(t) || 0) + 1);
    const tags = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    html = `<input class="menu-search" placeholder="搜尋標籤…">` +
      `<div class="menu-list">` + tags.slice(0, 40).map(([t, c]) =>
        _mi(t, t, f.tags.includes(t), `<span class="menu-count">${c}</span>`)).join('') + `</div>`;
    const m = _openMenu(anchor, html);
    const listEl = m.querySelector('.menu-list');
    m.querySelector('.menu-search').addEventListener('input', e => {
      const kw = e.target.value.toLowerCase();
      listEl.innerHTML = tags.filter(([t]) => t.toLowerCase().includes(kw)).slice(0, 40)
        .map(([t, c]) => _mi(t, t, f.tags.includes(t), `<span class="menu-count">${c}</span>`)).join('');
    });
    m.addEventListener('click', e => {
      const it = e.target.closest('.menu-item');
      if (!it) return;
      closeMenu();
      _patch(x => {
        const i = x.tags.indexOf(it.dataset.v);
        i >= 0 ? x.tags.splice(i, 1) : x.tags.push(it.dataset.v);
      });
    });
    return;
  }
  const m = _openMenu(anchor, html);
  m.addEventListener('click', e => {
    const it = e.target.closest('.menu-item');
    if (!it) return;
    closeMenu();
    _patch(x => {
      if (dim === 'type') x.type = it.dataset.v;
      else if (dim === 'star') x.star = parseInt(it.dataset.v, 10) || 0;
      else if (dim === 'date') x.date = it.dataset.v;
      else if (dim === 'size') x.size = it.dataset.v;
    });
  });
}

/* ── 排序（8+1 鍵 + 方向）───────────────────────────────────────────── */

function _sortMenu(anchor) {
  const s = store.state.sort;
  const keys = SORT_KEYS.filter(([k]) => k !== 'aesthetics' || store.state.libType === 'excire');
  const html = keys.map(([k, l]) => _mi(k, l, s.key === k)).join('') +
    `<div class="menu-sep"></div>` +
    _mi('dir:desc', '遞減 ↓', s.dir === 'desc') + _mi('dir:asc', '遞增 ↑', s.dir === 'asc');
  const m = _openMenu(anchor, html);
  m.addEventListener('click', e => {
    const it = e.target.closest('.menu-item');
    if (!it) return;
    closeMenu();
    const v = it.dataset.v;
    if (v.startsWith('dir:')) s.dir = v.slice(4);
    else { s.key = v; if (v === 'shuffle' && store.state.seed == null) _newSeed(false); }
    _updateURL();
  });
}

function _renderSortLabel() {
  const el = document.querySelector('#btn-sort span');
  if (!el) return;
  const s = store.state.sort;
  const label = SORT_KEYS.find(([k]) => k === s.key)?.[1] || s.key;
  el.textContent = s.key === 'shuffle' ? label : `${label}${s.dir === 'asc' ? '↑' : '↓'}`;
}

/* ── Seeded shuffle 歷史（沿用舊版 FIFO 上限演算法，C17）────────────── */

function _maxSeeds() { return parseInt(localStorage.getItem(MAX_SEEDS_KEY) || '7', 10) || 7; }

function _loadSeeds() {
  let seeds = [];
  try { seeds = JSON.parse(localStorage.getItem('ev-seeds') || '[]'); } catch (_) {}
  store.set({ seeds, seedIdx: seeds.length - 1, seed: seeds[seeds.length - 1] ?? null });
}

function _saveSeeds() {
  try { localStorage.setItem('ev-seeds', JSON.stringify(store.state.seeds)); } catch (_) {}
}

function _newSeed(update = true) {
  const st = store.state;
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  if (st.seeds.length >= _maxSeeds()) st.seeds.shift();
  st.seeds.push(seed);
  st.seedIdx = st.seeds.length - 1;
  st.seed = seed;
  _saveSeeds();
  if (update) _renderSeedNav();
}

/** URL 帶入 seed（可重播）：存在歷史則跳至該格，否則納入歷史 */
function _adoptSeed(seed) {
  const st = store.state;
  let i = st.seeds.indexOf(seed);
  if (i < 0) {
    if (st.seeds.length >= _maxSeeds()) st.seeds.shift();
    st.seeds.push(seed);
    i = st.seeds.length - 1;
    _saveSeeds();
  }
  st.seedIdx = i;
  st.seed = seed;
}

function _renderSeedNav() {
  const el = document.getElementById('ibar-seed');
  if (!el) return;
  const st = store.state;
  if (st.sort.key !== 'shuffle' || st.seed == null) { el.innerHTML = ''; return; }
  const prev = st.seedIdx > 0, next = st.seedIdx < st.seeds.length - 1;
  el.innerHTML = `
    <button class="seed-btn" data-seed-nav="-1" ${prev ? '' : 'disabled'} title="上一個 seed">‹</button>
    <span class="seed-label" title="seed 可重播（URL ?seed=）">seed ${st.seed}${st.seeds.length > 1 ? ` · ${st.seedIdx + 1}/${st.seeds.length}` : ''}</span>
    <button class="seed-btn" data-seed-nav="1" ${next ? '' : 'disabled'} title="下一個 seed">›</button>`;
  el.querySelectorAll('[data-seed-nav]').forEach(b => b.addEventListener('click', () => {
    const st2 = store.state;
    st2.seedIdx = Math.min(st2.seeds.length - 1, Math.max(0, st2.seedIdx + parseInt(b.dataset.seedNav, 10)));
    st2.seed = st2.seeds[st2.seedIdx];
    _updateURL();
  }));
}

/* ── 密度 / clean mode（C22）────────────────────────────────────────── */

function _loadView() {
  const d = localStorage.getItem('ev-density');
  store.set({
    density: ['comfy', 'cozy', 'compact'].includes(d) ? d : 'cozy',
    clean: localStorage.getItem('ev-clean') === '1',
  });
}

function _densityMenu(anchor) {
  const st = store.state;
  const html =
    _mi('comfy', '舒適（大卡片）', st.density === 'comfy') +
    _mi('cozy', '標準', st.density === 'cozy') +
    _mi('compact', '緊湊（多欄）', st.density === 'compact') +
    `<div class="menu-sep"></div>` +
    _mi('clean', st.clean ? '✓ 精簡卡片（隱藏資訊）' : '精簡卡片（隱藏資訊）', st.clean);
  const m = _openMenu(anchor, html);
  m.addEventListener('click', e => {
    const it = e.target.closest('.menu-item');
    if (!it) return;
    closeMenu();
    const v = it.dataset.v;
    if (v === 'clean') st.clean = !st.clean;
    else st.density = v;
    try {
      localStorage.setItem('ev-density', st.density);
      localStorage.setItem('ev-clean', st.clean ? '1' : '0');
    } catch (_) {}
    store.emit('view-changed');
  });
}
