/* ── collections.js ▸ 左欄 COLLECTIONS 全區（B7；C12 + E03 + spec §1.2 ③）─
   a) Excire Collections：/api/excire/{lib}/collections 五群組（僅 Excire 庫）
      → 點選開 #/lib/{libId}/collection/{id} 虛擬集合視圖
   b) 智慧集合：儲存目前篩選（路由 + query）為具名集合（localStorage
      ev-collections），點選 = 重播該視圖；✕ 刪除
   c) 濾鏡集：vc 濾鏡 preset 庫（eagle-filter-presets）+ presetIds 反查計數，
      點選 = 切換 presets 篩選（OR、URL ?presets=p1|p2，C12） */

import { navigate, parseRoute } from './router.js';
import { store } from './store.js';
import { api } from './api.js';
import { h } from './items.js';
import { togglePresetFilter } from './toolbar.js';
import { toast } from './notifications.js';
import { promptDialog } from './actions.js';

const $ = id => document.getElementById(id);
const icon = (name, cls = 'icon icon-sm') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const SMART_KEY = 'ev-collections';
let _route = null;
const _excireCache = new Map();     // slug → collections[]（本 session 快取）

/* ── 智慧集合（localStorage）────────────────────────────────────────── */

function _loadSmart() {
  try { return JSON.parse(localStorage.getItem(SMART_KEY) || '[]'); }
  catch (_) { return []; }
}
function _saveSmart(list) {
  try { localStorage.setItem(SMART_KEY, JSON.stringify(list)); } catch (_) {}
}

/** 目前視圖可否存為智慧集合（lib/folder/collection/search 且帶狀態） */
function _saveable() {
  const r = parseRoute();
  if (!['lib', 'folder', 'collection', 'search'].includes(r.name)) return false;
  return !!(r.query.toString() || r.name !== 'lib');
}

async function _saveCurrent() {
  if (!_saveable()) { toast('目前視圖沒有可儲存的篩選狀態', { err: true }); return; }
  const r = parseRoute();
  const q = new URLSearchParams(r.query);
  q.delete('item'); q.delete('drawer');            // 浮層參數不入集合
  const qs = q.toString();
  const hash = '#' + r.path + (qs ? '?' + qs : '');
  const name = await promptDialog({
    title: '儲存為智慧集合',
    placeholder: '集合名稱…',
    hint: '儲存目前的篩選/搜尋視圖，之後可自左欄 COLLECTIONS 一鍵重播',
  });
  if (!name || !name.trim()) return;
  const list = _loadSmart();
  list.push({ id: `sc${Date.now().toString(36)}`, name: name.trim(), hash });
  _saveSmart(list);
  toast(`已儲存智慧集合「${name.trim()}」`);
  renderCollections(_route);
}

/* ── 濾鏡集（C12：preset 反查計數）──────────────────────────────────── */

function _loadPresets() {
  try {
    return (JSON.parse(localStorage.getItem('eagle-filter-presets') || '[]'))
      .filter(p => !p.deleted);
  } catch (_) { return []; }
}

/** presetId → 連結項目數（掃 eagle-media-filter-* keys，一次建全表） */
function _presetCounts() {
  const counts = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('eagle-media-filter-')) continue;
    try {
      const d = JSON.parse(localStorage.getItem(k) || '{}');
      for (const pid of (d.presetIds || [])) counts[pid] = (counts[pid] || 0) + 1;
    } catch (_) {}
  }
  return counts;
}

/* ── Excire Collections（E03）───────────────────────────────────────── */

async function _excireCollections(slug) {
  if (!_excireCache.has(slug)) {
    try {
      const d = await api.excireCollections(slug);
      _excireCache.set(slug, d.collections || []);
    } catch (_) { _excireCache.set(slug, []); }
  }
  return _excireCache.get(slug);
}

/** 麵包屑用：相簿名稱解析（快取內同步查） */
export function collectionName(slug, id) {
  const c = (_excireCache.get(slug) || []).find(x => String(x.id) === String(id));
  return c ? c.name : `相簿 ${id}`;
}

function _groupOpenKey(slug) { return `ev-coll-open-${slug}`; }

/* ── 渲染 ───────────────────────────────────────────────────────────── */

export function initCollections() {
  $('btn-save-coll')?.addEventListener('click', _saveCurrent);
  document.addEventListener('vc-filter-presets-changed', () => renderCollections(_route));
}

export async function renderCollections(route) {
  _route = route;
  const body = $('collections-body');
  if (!body) return;
  const libId = store.state.libId;
  const libType = store.state.libType;
  const slug = libId ? libId.slice(libId.indexOf('--') + 2) : null;
  const parts = [];

  /* a) Excire Collections 五群組 */
  if (libType === 'excire' && slug) {
    const cols = await _excireCollections(slug);
    if (route !== _route) return;                  // 視圖已切換
    if (cols.length) {
      let open;
      try { open = new Set(JSON.parse(localStorage.getItem(_groupOpenKey(slug)) || '[]')); }
      catch (_) { open = new Set(); }
      const cur = route?.name === 'collection' ? String(route.params.collectionId) : null;
      const groups = new Map();
      for (const c of cols) {
        const g = c.group || '（未分組）';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(c);
      }
      parts.push([...groups.entries()].map(([g, list]) => `
        <div class="coll-group${open.has(g) ? ' open' : ''}" data-group="${h(g)}">
          <button class="side-row coll-group-hd" data-coll-group="${h(g)}">
            <span class="tree-chevron">${icon('chevron-r')}</span>
            <span class="row-label">${h(g)}</span>
            <span class="count-pill">${list.length}</span>
          </button>
          <div class="coll-group-body">
            ${list.map(c => `<button class="side-row coll-row${cur === String(c.id) ? ' selected' : ''}"
                data-coll="${h(String(c.id))}" title="${h(c.name)}">
              ${icon('folder')}<span class="row-label">${h(c.name)}</span>
              <span class="count-pill">${(c.photo_count || 0).toLocaleString()}</span></button>`).join('')}
          </div>
        </div>`).join(''));
    }
  }

  /* b) 智慧集合（全庫共通） */
  const smart = _loadSmart();
  if (smart.length) {
    parts.push(`<div class="coll-sub">${icon('sparkle')} 智慧集合</div>` +
      smart.map(s => `<button class="side-row coll-row" data-smart="${h(s.id)}" title="${h(s.hash)}">
        ${icon('search')}<span class="row-label">${h(s.name)}</span>
        <span class="chip-x" data-smart-rm="${h(s.id)}" title="刪除集合" role="button" tabindex="0">✕</span>
      </button>`).join(''));
  }

  /* c) 濾鏡集（eagle/dir 庫；C12） */
  if (libType && libType !== 'excire') {
    const presets = _loadPresets();
    if (presets.length) {
      const counts = _presetCounts();
      const active = new Set(store.state.filters?.presets || []);
      parts.push(`<div class="coll-sub">${icon('sliders')} 濾鏡集</div>` +
        presets.map(p => `<button class="side-row coll-row${active.has(p.id) ? ' selected' : ''}"
            data-preset="${h(p.id)}" title="篩選套用此濾鏡的影片（可多選 OR）">
          ${icon('swatch')}<span class="row-label">${h(p.name)}</span>
          <span class="count-pill">${counts[p.id] || 0}</span></button>`).join(''));
    }
  }

  body.innerHTML = parts.join('')
    || `<p class="side-placeholder">尚無集合——以 ☆ 儲存目前篩選，或於 viewer 建立濾鏡 preset</p>`;

  /* 事件 */
  body.querySelectorAll('[data-coll-group]').forEach(el => el.addEventListener('click', () => {
    const g = el.dataset.collGroup;
    const box = el.closest('.coll-group');
    box.classList.toggle('open');
    const opens = [...body.querySelectorAll('.coll-group.open')].map(x => x.dataset.group);
    try { localStorage.setItem(_groupOpenKey(slug), JSON.stringify(opens)); } catch (_) {}
  }));
  body.querySelectorAll('[data-coll]').forEach(el => el.addEventListener('click', () =>
    navigate(`#/lib/${encodeURIComponent(libId)}/collection/${encodeURIComponent(el.dataset.coll)}`)));
  body.querySelectorAll('[data-smart]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-smart-rm]')) return;
    const s = _loadSmart().find(x => x.id === el.dataset.smart);
    if (s) navigate(s.hash);
  }));
  body.querySelectorAll('[data-smart-rm]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation();
    const list = _loadSmart();
    const s = list.find(x => x.id === el.dataset.smartRm);
    _saveSmart(list.filter(x => x.id !== el.dataset.smartRm));
    renderCollections(_route);
    if (s) toast(`已刪除智慧集合「${s.name}」`, {
      actionLabel: '復原',
      onAction: () => { _saveSmart([..._loadSmart(), s]); renderCollections(_route); },
    });
  }));
  body.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () =>
    togglePresetFilter(el.dataset.preset)));
}
