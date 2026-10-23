/* ── command-k.js ▸ ⌘K 搜尋指揮中心（B2 語法；B5 AI provider 點亮）───────
   - 語法模式：6 欄位語法（parse 沿用舊版 search.js 邏輯，items.js 共用）
     + 語法 chips 化（tag:/domain:/kind: 即時建議 → 結構化 chip，可 ✕）。
   - SearchProvider 註冊制（§2.4）：syntax + nl（/api/ai/search，跨庫/單庫
     跟隨當前路由，可切範圍）+ face（以目前選取項的臉搜尋）；similar 後端
     缺 image-to-image 端點 → 恆灰態（缺口見 B5 報告）。
   - 模型未就緒：搜尋結果頁顯示「索引中/未索引」引導（ai-search.js）。
   - 桌面 palette 不入 history（§5.4 #3）：Esc/點外關閉。 */

import { store } from './store.js';
import { h, parseQuery, serializeTerms, QUERY_FIELDS } from './items.js';
import { setQuery } from './toolbar.js';
import { navigate } from './router.js';
import { toast } from './notifications.js';
import { ensureAiStatus, aiCaps, searchScope } from './ai-search.js';

/* ── SearchProvider 擴充槽 ──────────────────────────────────────────── */

const _providers = new Map();

export function registerSearchProvider(p) {
  if (!p || !p.id) throw new Error('SearchProvider 需要 id');
  _providers.set(p.id, {
    label: p.id, icon: 'search', available: () => false,
    suggest: () => [], execute: () => ({ ids: [], provider: p.id, query: '' }),
    ...p,
  });
}

export function getSearchProviders() { return [..._providers.values()]; }

let _scopeAll = false;      // nl 範圍：false = 跟隨當前庫路由、true = 全部庫

function _scopeParam() {
  const libScope = searchScope();
  return _scopeAll || !libScope ? 'all' : libScope;
}

registerSearchProvider({
  id: 'syntax', label: '語法', icon: 'command',
  available: () => true,
  execute: q => { setQuery(q); return { provider: 'syntax', query: q }; },
});
registerSearchProvider({
  id: 'nl', label: '自然語言', icon: 'sparkle',
  available: () => aiCaps().nl,
  tip: () => aiCaps().loaded ? 'AI 模型/語意索引未就緒（People 區可建立索引）' : 'AI 狀態載入中…',
  execute: q => {
    if (!q) { toast('請以自然語言描述想找的畫面', { err: true }); return null; }
    navigate(`#/search?mode=nl&q=${encodeURIComponent(q)}&scope=${encodeURIComponent(_scopeParam())}`);
    return { provider: 'nl', query: q };
  },
});
registerSearchProvider({
  id: 'face', label: '人物（以選取項找臉）', icon: 'face-scan',
  available: () => aiCaps().face,
  tip: () => aiCaps().loaded ? '人臉索引未就緒（People 區可建立索引）' : 'AI 狀態載入中…',
  execute: () => {
    const sel = [...store.state.selection];
    const libId = store.state.libId;
    if (sel.length !== 1 || !libId) {
      toast('請先在 grid 選取 1 個項目，再以臉搜尋', { err: true });
      return null;
    }
    navigate(`#/search?mode=face&scope=${encodeURIComponent(libId)}&src=${encodeURIComponent(sel[0])}`);
    return { provider: 'face', query: sel[0] };
  },
});
registerSearchProvider({
  id: 'similar', label: '相似圖（以選取項）', icon: 'similar',
  available: () => aiCaps().similar,
  tip: () => aiCaps().loaded ? '需先建立語意索引（People 區／AI 狀態面板）' : 'AI 狀態載入中…',
  execute: () => {
    const sel = [...store.state.selection];
    const libId = store.state.libId;
    if (sel.length !== 1 || !libId) {
      toast('請先在 grid 選取 1 個項目，再找相似圖', { err: true });
      return null;
    }
    navigate(`#/search?mode=similar&scope=${encodeURIComponent(libId)}&src=${encodeURIComponent(sel[0])}`);
    return { provider: 'similar', query: sel[0] };
  },
});

const P6_TIP = 'AI 搜尋將於後續版本啟用';

/* ── Palette 狀態 ───────────────────────────────────────────────────── */

let _root = null, _input = null, _chipsEl = null, _sugsEl = null;
let _chips = [];        // 結構化 terms [{field,value,exclude}]
let _mode = 'syntax';
let _sugIdx = -1;

/* 自然語言偵測：無 chips、無欄位語法、非 URL 的自由詞（含 CJK 或多詞）
   → Enter 預設走 AI 語意搜尋（建議清單保留「僅篩選」出口） */
const _FIELD_RE = /(^|\s)-?[^\s:]+:\S/;
function _looksNatural(q) {
  if (!q || _chips.length) return false;
  if (_FIELD_RE.test(q) || /^https?:\/\//i.test(q)) return false;
  return /[぀-ヿ一-鿿]/.test(q) || q.trim().split(/\s+/).length >= 2;
}

function _saveMode() { try { localStorage.setItem('ev-ck-mode', _mode); } catch (_) {} }
function _restoreMode() {
  try {
    const saved = localStorage.getItem('ev-ck-mode');
    if (saved && _providers.get(saved)?.available()) _mode = saved;
  } catch (_) {}
}
const FIELD_TIPS = { name: '名稱', tag: '標籤', domain: '網域', url: '網址', kind: '類型', id: '編號' };
const _icon = n => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;

export function initCommandK() {
  document.getElementById('btn-omni')?.addEventListener('click', openPalette);
  document.addEventListener('keydown', e => {
    const typing = /^(input|textarea)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); togglePalette(); }
    else if (e.key === '/' && !typing && !_isOpen()) { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape' && _isOpen()) { e.stopPropagation(); closePalette(); }
  }, true);
}

function _isOpen() { return !!_root?.classList.contains('show'); }
function togglePalette() { _isOpen() ? closePalette() : openPalette(); }

export function closePalette() { _root?.classList.remove('show'); }

export function openPalette() {
  if (!_root) _build();
  // 帶入目前查詢：欄位 terms → chips，自由詞 → input
  const terms = parseQuery(store.state.filters?.q || '');
  _chips = terms.filter(t => t.field !== '*');
  _input.value = serializeTerms(terms.filter(t => t.field === '*'));
  _root.classList.add('show');
  _restoreMode();
  _renderModes();
  _renderChips();
  _suggest();
  _input.focus();
  // AI 能力非同步刷新 → 模式列點亮 + 恢復上次模式（30s 快取）
  ensureAiStatus().then(() => {
    if (!_isOpen()) return;
    _restoreMode();
    _renderModes(); _suggest();
  });
}

/* ── DOM ────────────────────────────────────────────────────────────── */

function _build() {
  _root = document.createElement('div');
  _root.className = 'palette-backdrop';
  _root.innerHTML = `
    <div class="palette" role="dialog" aria-label="搜尋指揮中心">
      <div class="palette-input-row">
        ${_icon('search')}
        <div class="qchips" id="ck-chips"></div>
        <input id="ck-input" autocomplete="off" spellcheck="false"
               placeholder='搜尋、tag:標籤、-domain:x.com、"完整詞"…'>
      </div>
      <div class="palette-modes" id="ck-modes"></div>
      <div class="palette-sugs" id="ck-sugs"></div>
      <div class="palette-foot"><kbd>Enter</kbd> 搜尋 · <kbd>↑↓</kbd> 選擇 · <kbd>Esc</kbd> 關閉</div>
    </div>`;
  document.body.appendChild(_root);
  _input = _root.querySelector('#ck-input');
  _chipsEl = _root.querySelector('#ck-chips');
  _sugsEl = _root.querySelector('#ck-sugs');

  _root.addEventListener('mousedown', e => { if (e.target === _root) closePalette(); });
  _input.addEventListener('input', () => { _sugIdx = -1; _suggest(); });
  _input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [..._sugsEl.querySelectorAll('.sug-item:not(.disabled)')];
      if (!items.length) return;
      if (e.key === 'ArrowDown') _sugIdx = _sugIdx + 1 >= items.length ? 0 : _sugIdx + 1;
      else                       _sugIdx = _sugIdx <= 0 ? items.length - 1 : _sugIdx - 1;
      items.forEach((el, i) => el.classList.toggle('active', i === _sugIdx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = _sugsEl.querySelectorAll('.sug-item:not(.disabled)')[_sugIdx];
      if (active) active.click();
      else _commit();
    } else if (e.key === 'Backspace' && !_input.value && _chips.length) {
      _chips.pop(); _renderChips(); _suggest();
    }
  });
  _sugsEl.addEventListener('click', e => {
    const el = e.target.closest('.sug-item');
    if (!el || el.classList.contains('disabled')) return;
    _applySuggestion(el.dataset);
  });
}

const _PLACEHOLDER = {
  syntax: '搜尋、tag:標籤、-domain:x.com、"完整詞"…',
  nl: '以自然語言描述想找的畫面（例：教室裡穿制服的男生）…',
  face: '以目前 grid 選取項的臉搜尋（Enter 執行）',
  similar: '以目前 grid 選取項找相似圖（Enter 執行）',
};

function _renderModes() {
  const box = _root.querySelector('#ck-modes');
  if (!_providers.get(_mode)?.available()) {
    // 能力消失回退：狀態已載入才提示（避免載入期誤報），不再靜默切換
    if (_mode !== 'syntax' && aiCaps().loaded) {
      const p = _providers.get(_mode);
      toast(`「${p?.label || _mode}」暫不可用，已切回語法篩選`, { err: true });
    }
    _mode = 'syntax';
  }
  const scopeChip = _mode === 'nl'
    ? `<button class="chip mode-chip scope-chip${_scopeAll || !searchScope() ? ' active' : ''}"
         data-scope-toggle title="搜尋範圍（跟隨當前庫路由 / 全部庫）">
         ${_icon('folder-scan')}${_scopeAll || !searchScope() ? '全部庫' : '當前庫'}</button>`
    : '';
  box.innerHTML = getSearchProviders().map(p => {
    const ok = p.available();
    const tip = ok ? '' : (typeof p.tip === 'function' ? p.tip() : P6_TIP);
    return `<button class="chip mode-chip${_mode === p.id ? ' active' : ''}${ok ? '' : ' disabled'}"
      data-mode="${p.id}" ${ok ? '' : `title="${h(tip)}" aria-disabled="true"`}>
      ${_icon(p.icon)}${h(p.label)}</button>`;
  }).join('') + scopeChip;
  box.querySelectorAll('[data-mode]').forEach(el => el.addEventListener('click', () => {
    const p = _providers.get(el.dataset.mode);
    if (!p?.available()) return;                    // 灰態佔位
    _mode = el.dataset.mode;
    _saveMode();
    _input.placeholder = _PLACEHOLDER[_mode] || _PLACEHOLDER.syntax;
    _renderModes(); _suggest(); _input.focus();
  }));
  box.querySelector('[data-scope-toggle]')?.addEventListener('click', () => {
    if (searchScope()) { _scopeAll = !_scopeAll; _renderModes(); _input.focus(); }
  });
}

function _renderChips() {
  _chipsEl.innerHTML = _chips.map((t, i) =>
    `<span class="qchip${t.exclude ? ' exclude' : ''}">${t.exclude ? '−' : ''}${h(t.field)}:${h(t.value)}
      <button class="chip-x" data-i="${i}">✕</button></span>`).join('');
  _chipsEl.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
    _chips.splice(parseInt(b.dataset.i, 10), 1);
    _renderChips(); _suggest(); _input.focus();
  }));
}

/* ── 即時建議 ───────────────────────────────────────────────────────── */

function _counts(getter) {
  const m = new Map();
  for (const it of store.state.allItems)
    for (const v of getter(it)) if (v) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

const _sug = (d, label, extra = '', icon = '') =>
  `<button class="sug-item" ${Object.entries(d).map(([k, v]) => `data-${k}="${h(v)}"`).join(' ')}>
     ${icon}${h(label)}${extra}</button>`;

function _suggest() {
  const raw = _input.value;
  const token = raw.split(/\s+/).pop() || '';
  const groups = [];

  // URL 偵測 → 下載中心（B5：帶 URL 導向 #/downloads）
  if (/^https?:\/\/\S+$/i.test(token)) {
    groups.push(`<div class="sug-group">動作</div>` +
      _sug({ act: 'download', q: token }, '下載此網址…（下載中心）', '', _icon('download')));
  }

  if (_mode !== 'syntax') {                        // AI 模式：不做語法建議
    if (_mode === 'nl') groups.push(`<div class="sug-group">自然語言</div>
      <div class="sug-item disabled">輸入描述後 Enter 搜尋（結果附相似度分數）</div>`);
    if (_mode === 'face') groups.push(`<div class="sug-group">人物</div>
      <div class="sug-item disabled">以目前選取的 1 個項目找相同的臉（Enter 執行）</div>`);
    if (_mode === 'similar') groups.push(`<div class="sug-group">相似圖</div>
      <div class="sug-item disabled">以目前選取的 1 個項目找構圖/內容相似的圖（Enter 執行）</div>`);
    _sugsEl.innerHTML = groups.join('');
    return;
  }

  // 自由詞判定為自然語言且 AI 可用 → 置頂建議（Enter 預設即走 AI，此處是明示 + 「僅篩選」出口）
  const full = raw.trim();
  if (_looksNatural(full) && !aiCaps().loaded) {
    // 首次 status 載入中：完成後補渲染（loaded=true 後不會再進此分支）
    ensureAiStatus().then(() => { if (_isOpen()) _suggest(); });
  }
  if (_looksNatural(full) && aiCaps().nl) {
    groups.push(`<div class="sug-group">AI 語意搜尋（Enter 預設）</div>` +
      _sug({ act: 'nl', q: full }, `以 AI 語意搜尋「${full}」`, '', _icon('sparkle')) +
      _sug({ act: 'filter', q: full }, '僅篩選檔名/標籤（不使用 AI）', '', _icon('filter')));
  }

  const m = token.match(/^(-?)([^\s:]+):(.*)$/);
  const alias = { '名稱': 'name', '標籤': 'tag', '網域': 'domain', '網址': 'url', '類型': 'kind', '編號': 'id' };
  const field = m ? (alias[m[2]] || m[2].toLowerCase()) : null;

  if (m && QUERY_FIELDS.includes(field)) {
    const part = m[3].toLowerCase();
    let opts = [];
    if (field === 'tag')    opts = [..._counts(i => i.tags || []).entries()];
    if (field === 'domain') opts = [..._counts(i => [i.domain]).entries()].filter(([d]) => d !== 'local');
    if (field === 'kind')   opts = [['video', 0], ['image', 0], ['gif', 0], ['bookmark', 0]];
    opts = opts.filter(([v]) => v.toLowerCase().includes(part))
               .sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (opts.length) {
      groups.push(`<div class="sug-group">${h(FIELD_TIPS[field])}建議 → chip</div>` +
        opts.map(([v, c]) => _sug({ act: 'chip', field, value: v, exclude: m[1] ? '1' : '' },
          v, c ? `<span class="menu-count">${c}</span>` : '', _icon('tag'))).join(''));
    } else if (m[3]) {
      groups.push(`<div class="sug-group">建議</div>` +
        _sug({ act: 'chip', field, value: m[3], exclude: m[1] ? '1' : '' },
          `${field}:${m[3]}（加入條件）`, '', _icon('plus')));
    }
  } else {
    groups.push(`<div class="sug-group">欄位語法（含中文別名）</div><div class="sug-fields">` +
      QUERY_FIELDS.map(f2 =>
        _sug({ act: 'field', field: f2 }, `${f2}:`, `<span class="menu-count">${FIELD_TIPS[f2]}</span>`)).join('') +
      `</div>`);
    if (token) {
      const tags = [..._counts(i => i.tags || []).entries()]
        .filter(([t]) => t.toLowerCase().includes(token.toLowerCase()))
        .sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (tags.length) groups.push(`<div class="sug-group">標籤</div>` +
        tags.map(([t, c]) => _sug({ act: 'chip', field: 'tag', value: t }, t,
          `<span class="menu-count">${c}</span>`, _icon('tag'))).join(''));
    } else {
      const hist = _history();
      if (hist.length) groups.push(`<div class="sug-group">最近搜尋</div>` +
        hist.map(q => _sug({ act: 'history', q }, q, '', _icon('history'))).join(''));
    }
  }
  _sugsEl.innerHTML = groups.join('');
}

function _applySuggestion(d) {
  if (d.act === 'field') {
    const parts = _input.value.split(/\s+/);
    parts[parts.length - 1] = d.field + ':';
    _input.value = parts.join(' ');
    _input.focus(); _suggest();
  } else if (d.act === 'chip') {
    _chips.push({ field: d.field, value: d.value, exclude: d.exclude === '1' });
    const parts = _input.value.split(/\s+/); parts.pop();
    _input.value = parts.join(' ');
    _renderChips(); _input.focus(); _sugIdx = -1; _suggest();
  } else if (d.act === 'history') {
    _input.value = d.q; _chips = [];
    _renderChips(); _commit();
  } else if (d.act === 'nl') {
    _saveHistory(d.q);
    if (_providers.get('nl').execute(d.q) !== null) closePalette();
  } else if (d.act === 'filter') {
    _saveHistory(d.q);
    _providers.get('syntax').execute(d.q);
    closePalette();
  } else if (d.act === 'download') {
    closePalette();
    navigate(`#/downloads?url=${encodeURIComponent(d.q)}`);
  }
}

/* ── 執行（Enter → 虛擬集合 = ?q= 進路由，走同一 grid 管線）─────────── */

async function _commit() {
  // 語法 = chips 序列化 + 自由詞；AI 模式 = 原始輸入（不解析語法，§2.4）
  const q = _mode === 'syntax'
    ? (serializeTerms(_chips) + ' ' + _input.value.trim()).trim()
    : _input.value.trim();
  if (_mode === 'syntax' || _mode === 'nl') _saveHistory(q);
  let mode = _mode;
  if (mode === 'syntax' && _looksNatural(q)) {
    if (!aiCaps().loaded) await ensureAiStatus();  // 首次載入中：等能力確認再決定路徑
    if (aiCaps().nl) {
      // 自由詞 = 自然語言 → 自動走語意搜尋（「僅篩選」可由建議清單選）
      mode = 'nl';
    } else if (aiCaps().loaded) {
      // AI 不可用時明講，不讓使用者誤以為在做語意搜尋
      toast('此範圍語意索引未就緒，僅做檔名/標籤篩選（AI 狀態面板可建立索引）', { err: true });
    }
  }
  const p = _providers.get(mode) || _providers.get('syntax');
  const res = p.execute(q);
  if (res !== null) closePalette();       // null = 前置條件不足（palette 保持開啟）
}

function _history() {
  try { return JSON.parse(localStorage.getItem('ev-search-history') || '[]'); } catch (_) { return []; }
}

function _saveHistory(q) {
  if (!q) return;
  const hst = [q, ..._history().filter(x => x !== q)].slice(0, 8);
  try { localStorage.setItem('ev-search-history', JSON.stringify(hst)); } catch (_) {}
}
