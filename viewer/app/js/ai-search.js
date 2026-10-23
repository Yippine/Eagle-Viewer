/* ── ai-search.js ▸ AI 搜尋前端點亮（B5；後端 api_ai.py 既有端點）────────
   - 能力快取：/api/ai/status → ⌘K nl/face provider available()（同步查詢）。
   - 搜尋結果 = 虛擬視圖：#/search?mode=nl|face&q=…&scope={libId}|all[&src=]
     → hits 解析為 vm（單庫沿用 urls_data、Excire 以 pid 組三級路徑）
     → 走同一 grid 管線，卡片附 _score（grid.js 分數 badge）。
   - 202 loading = 「索引中」引導 + 自動重試；503/400 = 引導開 AI 狀態面板。
   - 跨庫結果中「非當前庫」的 Eagle 項標記 readOnly（actions 走當前庫 API，
     避免誤寫）；相似圖（image-to-image）後端無端點 → provider 恆灰態。 */

import { api } from './api.js';
import { store } from './store.js';
import { parseLibId, parseRoute } from './router.js';
import { adaptItem } from './items.js';
import { setItems, showMessage } from './grid.js';
import { renderBreadcrumb, setContentChrome } from './page-chrome.js';
import { openAiStatusPanel } from './ai-status.js';

/* ── 能力快取（⌘K provider available() 為同步 → 先 ensure 再讀）─────── */

let _st = null;            // 最近一次 /api/ai/status
let _stAt = 0;
let _stPending = null;

export async function ensureAiStatus(force = false) {
  if (!force && _st && Date.now() - _stAt < 30_000) return _st;
  if (_stPending) return _stPending;
  _stPending = api.aiStatus()
    .then(st => { _st = st; _stAt = Date.now(); return st; })
    .catch(() => null)
    .finally(() => { _stPending = null; });
  return _stPending;
}

/** 同步能力旗標（status 未載入時全 false） */
export function aiCaps() {
  const libs = Object.values(_st?.libs || {});
  return {
    loaded: !!_st,
    nl:   !!(_st?.onnxruntime && _st?.clip_model_ready &&
             libs.some(l => (l.clip?.indexed || 0) > 0)),
    face: !!(_st?.onnxruntime && libs.some(l => (l.faces?.faces || 0) > 0)),
  };
}

/** 目前路由的搜尋範圍：lib/folder 路由 → libId；否則 null（= 跨庫） */
export function searchScope() {
  const r = parseRoute();
  return (r.name === 'lib' || r.name === 'folder' || r.name === 'trash')
    ? r.params.libId : null;
}

/* ── hits → vm（分數/庫別附掛）──────────────────────────────────────── */

const _libMaps = new Map();   // slug → Promise<Map(id → raw)>（urls_data 快取）

export function invalidateLibCache() { _libMaps.clear(); }

function _eagleMap(slug) {
  if (!_libMaps.has(slug)) {
    _libMaps.set(slug, api.items(slug)
      .then(d => new Map((d.items || []).map(i => [i.id, i])))
      .catch(() => new Map()));
  }
  return _libMaps.get(slug);
}

/** [{lib, id, source, score?, …}] → vm[]（去重、附 _score/_lib）
 *  source 'excire' 以 pid 組 thumb/preview/file；eagle 以 urls_data 完整還原 */
export async function adaptHits(hits) {
  const curSlug = parseLibId(store.state.libId || '')?.slug || null;
  const out = [];
  const seen = new Set();
  for (const hit of hits || []) {
    if (!hit?.id || seen.has(hit.id)) continue;   // face 搜尋同 item 多臉 → 去重
    seen.add(hit.id);
    let vm;
    if (hit.source === 'excire') {
      const pid = String(hit.id).replace(/^excire_/, '');
      vm = adaptItem({
        id: hit.id, name: hit.name || hit.id, media_type: 'image',
        thumb:   `excire-thumb/${hit.lib}/${pid}`,
        preview: `excire-preview/${hit.lib}/${pid}`,
        file:    `excire-file/${hit.lib}/${pid}`,
        folders: hit.folders || [],
      }, 'excire');
    } else {
      const raw = (await _eagleMap(hit.lib)).get(hit.id);
      vm = adaptItem(raw || {
        id: hit.id, name: hit.name || hit.id,
        media_type: hit.media_type || 'image',
        thumb: String(hit.thumb || '').replace(/^\//, ''),
      }, 'eagle');
      if (hit.lib !== curSlug) vm.readOnly = true;   // 跨庫：以唯讀防誤寫
    }
    vm._score = typeof hit.score === 'number' ? hit.score : null;
    vm._lib = hit.lib;
    out.push(vm);
  }
  return out;
}

/* ── 虛擬視圖（人物照片頁共用）──────────────────────────────────────── */

export function renderVirtualView(vms, { crumbs, note = '' } = {}) {
  if (crumbs) renderBreadcrumb(crumbs);
  setContentChrome(false);
  document.getElementById('ibar').hidden = false;   // 顯示 n 筆計數
  document.getElementById('ibar-seed').innerHTML = '';   // 清掉庫視圖殘留 seed 導覽
  if (store.state.selection.size) {                 // 舊選取不屬於虛擬視圖
    store.state.selection.clear();
    store.emit('selection');
  }
  store.set({ allItems: vms });                     // Inspector / 選取消費
  setItems(vms, { total: vms.length });
  if (!vms.length) showMessage('search', '沒有結果', note || '換個描述再試試');
}

/* ── #/search 路由渲染（app.js dispatch）───────────────────────────── */

let _sig = null;            // mode|q|scope|src 簽章（?item= 浮層變動不重查）
let _retryTimer = 0;

export function resetSearchView() { _sig = null; clearTimeout(_retryTimer); }

const MODE_LABEL = { nl: '語意搜尋', face: '以臉搜尋' };

export async function renderSearchRoute(route) {
  const q     = route.query.get('q') || '';
  const mode  = route.query.get('mode') || 'nl';
  const scope = route.query.get('scope') || 'all';
  const src   = route.query.get('src') || '';
  const sig = [mode, q, scope, src].join('|');
  if (sig === _sig) return;                        // 僅 ?item=/viewer 參數變動
  _sig = sig;
  clearTimeout(_retryTimer);

  const lib = scope !== 'all' ? parseLibId(scope) : null;
  const scopeLabel = lib ? `庫：${lib.slug}` : '全部庫';
  const title = mode === 'face' ? '以臉搜尋' : `「${q}」`;
  const crumbs = [{ label: '搜尋結果' },
                  { label: `${title} · ${MODE_LABEL[mode] || mode} · ${scopeLabel}` }];
  renderBreadcrumb(crumbs);
  setContentChrome(false);
  showMessage('sparkle', 'AI 搜尋中…', mode === 'nl' ? `正在以語意比對「${q}」` : '正在比對人臉向量');

  let r;
  try {
    if (mode === 'face') {
      if (!lib || !src) { _fail('查詢不完整', '以臉搜尋需要來源項目（於 grid 選取後從 ⌘K 啟動）'); return; }
      r = await api.aiFacesSearch(lib.slug, src, { topk: 60 });
    } else {
      if (!q) { _fail('缺少查詢字串', '請由 ⌘K 輸入自然語言描述'); return; }
      r = await api.aiSearch(q, { lib: lib?.slug, topk: 60 });
    }
  } catch (e) { _fail('搜尋失敗', e.message); return; }
  if (sig !== _sig) return;                        // 視圖已切換

  if (r.status === 202) {                          // 模型載入中 → 自動重試
    showMessage('sparkle', 'AI 模型載入中…', r.body.message || '首次載入約需數秒，將自動重試',
      `<button class="btn btn-sm" data-ai-panel>檢視 AI 狀態</button>`);
    _wirePanelBtn();
    _retryTimer = setTimeout(() => { if (sig === _sig) { _sig = null; renderSearchRoute(route); } }, 2500);
    return;
  }
  if (r.status !== 200 || r.body.ok === false) {   // 503/400：未安裝/未索引
    _fail(r.status === 503 ? 'AI 引擎未就緒' : '搜尋失敗',
          r.body.error || `HTTP ${r.status}`, true);
    return;
  }

  const vms = await adaptHits(r.body.hits || []);
  if (sig !== _sig) return;
  renderVirtualView(vms, { crumbs, note: '此範圍沒有相符結果' });
}

function _fail(title, note, panelBtn = false) {
  showMessage('close', title, note,
    panelBtn ? `<button class="btn btn-sm" data-ai-panel>檢視 AI 狀態／建立索引</button>` : '');
  if (panelBtn) _wirePanelBtn();
}

function _wirePanelBtn() {
  document.querySelector('#grid-msg [data-ai-panel]')
    ?.addEventListener('click', () => openAiStatusPanel());
}
