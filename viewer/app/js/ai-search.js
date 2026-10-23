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
import { filterItems, sortItems } from './items.js';
import { aiTagsSync, loadAiTags } from './ai-tags.js';
import { syncFromRoute } from './toolbar.js';
import { renderBreadcrumb, setContentChrome, hidePagePanel } from './page-chrome.js';
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
  const anyClip = libs.some(l => (l.clip?.indexed || 0) > 0);
  return {
    loaded: !!_st,
    nl:   !!(_st?.onnxruntime && _st?.clip_model_ready && anyClip),
    face: !!(_st?.onnxruntime && libs.some(l => (l.faces?.faces || 0) > 0)),
    similar: anyClip,       // B6：以圖找圖直接用既有向量（免 onnx 文字塔）
  };
}

/** 目前路由的搜尋範圍：lib/folder 路由 → libId；否則 null（= 跨庫） */
export function searchScope() {
  const r = parseRoute();
  return (r.name === 'lib' || r.name === 'folder' || r.name === 'collection' || r.name === 'trash')
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
      // AI 索引可能殘留已刪除／已不在庫中的項目（只剩 id 亂碼、無縮圖）→ 直接捨棄，不顯示幽靈結果
      if (!raw) continue;
      if ((raw.tags || []).includes('archived')) continue;   // 垃圾桶內項目不列入搜尋結果
      vm = adaptItem(raw, 'eagle');
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
  hidePagePanel();
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
let _lastVms = null;        // 上次查詢結果（同簽章下篩選鏈變動 → 不重查，只重套篩選）
let _lastCrumbs = null;

export function resetSearchView() { _sig = null; _lastVms = null; clearTimeout(_retryTimer); }

/** 搜尋結果沿用庫視圖的篩選鏈（type/star/tags/date/size/domain/AI 維度；q 為 NL 查詢本身故排除）
    排序：預設（shuffle）維持相關度排序；使用者明確選排序鍵才重排 */
function _applyChain(vms, route) {
  const f = { ...store.state.filters, q: '' };
  let aiTags = null;
  if (f.people || f.scene || f.sport || f.action || f.expr || f.clothing) {
    const scope = route.query.get('scope') || 'all';
    const slug = scope !== 'all' ? parseLibId(scope)?.slug : null;
    if (slug) {
      aiTags = aiTagsSync(slug);
      if (!aiTags) loadAiTags(slug).then(() => { if (_lastVms) _renderFiltered(route); });
    }
  }
  let list = filterItems(vms, f, { aiTags });
  const s = store.state.sort;
  if (s.key !== 'shuffle') list = sortItems(list, s.key, s.dir);
  return list;
}
function _renderFiltered(route) {
  renderVirtualView(_applyChain(_lastVms, route), { crumbs: _lastCrumbs, note: '此範圍沒有相符結果' });
  setContentChrome(true);               // 顯示篩選鏈（renderVirtualView 預設關閉）
}

const MODE_LABEL = { nl: '語意搜尋', face: '以臉搜尋', similar: '相似圖' };

export async function renderSearchRoute(route) {
  const q     = route.query.get('q') || '';
  const mode  = route.query.get('mode') || 'nl';
  const scope = route.query.get('scope') || 'all';
  const src   = route.query.get('src') || '';
  const sig = [mode, q, scope, src].join('|');
  syncFromRoute(route);                            // URL query → filters/sort + chips（搜尋視圖亦套篩選鏈）
  if (sig === _sig) {                              // 僅 ?item=/篩選參數變動 → 不重查
    if (_lastVms) _renderFiltered(route);
    return;
  }
  _sig = sig; _lastVms = null;
  clearTimeout(_retryTimer);

  const lib = scope !== 'all' ? parseLibId(scope) : null;
  const scopeLabel = lib ? `庫：${lib.slug}` : '全部庫';
  const title = mode === 'face' ? '以臉搜尋' : mode === 'similar' ? '相似圖' : `「${q}」`;
  const crumbs = [{ label: '搜尋結果' },
                  { label: `${title} · ${MODE_LABEL[mode] || mode} · ${scopeLabel}` }];
  renderBreadcrumb(crumbs);
  setContentChrome(false);
  showMessage('sparkle', 'AI 搜尋中…',
    mode === 'nl' ? `正在以語意比對「${q}」`
      : mode === 'similar' ? '正在以 CLIP 向量比對相似圖' : '正在比對人臉向量');

  let r;
  try {
    if (mode === 'face') {
      if (!lib || !src) { _fail('查詢不完整', '以臉搜尋需要來源項目（於 grid 選取後從 ⌘K 啟動）'); return; }
      r = await api.aiFacesSearch(lib.slug, src, { topk: 60 });
    } else if (mode === 'similar') {
      if (!lib || !src) { _fail('查詢不完整', '相似圖搜尋需要來源項目（於 grid 選取後從 ⌘K 啟動）'); return; }
      r = await api.aiSimilar(lib.slug, src, { topk: 60, all: route.query.get('all') === '1' });
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

  let vms = await adaptHits(r.body.hits || []);
  if (sig !== _sig) return;
  if (mode === 'nl' && lib) vms = await _lexicalFirst(vms, q, lib.slug);   // 檔名／標籤命中靠最前（混合搜尋）
  if (sig !== _sig) return;
  _lastVms = vms; _lastCrumbs = crumbs;
  _renderFiltered(route);
}

/* 混合搜尋：使用者常直接打檔名／標籤，純語意向量會把精確命中淹沒。
   → 先列「名稱或標籤包含全部查詢詞」的項目（同庫全量掃描，名稱命中優先於標籤命中），
     再接 AI 語意結果（去重）。業界作法（Google Photos／Spotify）皆為 lexical exact-match boost。 */
async function _lexicalFirst(aiVms, q, slug) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return aiVms;
  const map = await _eagleMap(slug);
  const nameHits = [], tagHits = [];
  for (const raw of map.values()) {
    if ((raw.tags || []).includes('archived')) continue;
    const name = String(raw.name || '').toLowerCase();
    const tags = (raw.tags || []).map(t => String(t).toLowerCase());
    if (tokens.every(t => name.includes(t))) nameHits.push(raw);
    else if (tokens.every(t => tags.some(tag => tag.includes(t)))) tagHits.push(raw);
  }
  if (!nameHits.length && !tagHits.length) return aiVms;
  const seen = new Set();
  const out = [];
  for (const raw of [...nameHits, ...tagHits]) {
    if (seen.has(String(raw.id))) continue;
    seen.add(String(raw.id));
    const vm = adaptItem(raw, 'eagle');
    vm._lib = slug; vm._score = null; vm._lexical = true;
    out.push(vm);
  }
  for (const vm of aiVms) if (!seen.has(vm.id)) { seen.add(vm.id); out.push(vm); }
  return out;
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
