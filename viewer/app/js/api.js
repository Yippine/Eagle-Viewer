/* ── api.js ▸ 薄 API client（fetch wrapper，B1 endpoints）──────────────
   後端 API 面不動（P4 spec §6.1）；所有函式回傳 Promise<json>。 */

/** fetch + JSON 解析 + 非 2xx 拋錯 */
async function _json(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(`${msg} (${url})`);
  }
  return res.json();
}

/** fetch + JSON；非 2xx 不拋錯，統一回 { status, body }（AI 202/503 語意用） */
async function _jsonStatus(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body: body || {} };
}

const _POST_JSON = body => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const enc = encodeURIComponent;

/** 相對媒體路徑（thumb/file 欄位）→ 絕對 URL（逐段 encode，保留斜線） */
export function mediaURL(relPath) {
  if (!relPath) return '';
  return '/' + String(relPath).split('/').map(enc).join('/');
}

export const api = {
  /* ── 設定 / 庫清單 ─────────────────────────────────────────────── */

  /** GET /api/config → { configured, libraries } */
  config: () => _json('/api/config'),

  /** GET /api/libraries → Eagle 庫 + Folder 來源合併清單（或 {configured:false}） */
  libraries: () => _json('/api/libraries'),

  /** GET /api/excire/libraries → [{ name, label, available, ai_available, stats }] */
  excireLibraries: () => _json('/api/excire/libraries'),

  /* ── Eagle / Folder 資料 ───────────────────────────────────────── */

  /** GET /data/{lib}/urls_data.json → { items, stats }（沿用舊版資料來源） */
  items: lib => _json(`/data/${enc(lib)}/urls_data.json`),

  /** GET /api/folders?lib= → { ok, folders: tree } */
  folders: lib => _json(`/api/folders?lib=${enc(lib)}`),

  /** GET /api/item?id=&lib= → { ok, item } */
  item: (lib, id) => _json(`/api/item?id=${enc(id)}&lib=${enc(lib)}`),

  /* ── Excire（唯讀）─────────────────────────────────────────────── */

  /** GET /api/excire/{lib}/folders → { ok, folders: tree } */
  excireFolders: lib => _json(`/api/excire/${enc(lib)}/folders`),

  /** GET /api/excire/{lib}/photos?offset&limit&folder&keyword&collection&sort&order */
  excirePhotos: (lib, params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const q = qs.toString();
    return _json(`/api/excire/${enc(lib)}/photos${q ? '?' + q : ''}`);
  },

  /** GET /api/excire/{lib}/collections → { ok, collections } */
  excireCollections: lib => _json(`/api/excire/${enc(lib)}/collections`),

  /** GET /api/excire/{lib}/faces/{photoId} → { ok, faces:[{cx,cy,w,h,angle}] } */
  excireFaces: (lib, photoId) => _json(`/api/excire/${enc(lib)}/faces/${enc(photoId)}`),

  /* ── Item 寫入（B4；後端 api_mutations.py 既有端點）──────────────── */

  /** PATCH /api/item/{star|tags|folders|rename|annotation|url|move} */
  patchItem: (kind, body) => _json(`/api/item/${kind}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),

  /** POST /api/item/{archive|restore} 或 /api/items/{...-batch} */
  postItems: (path, body) => _json(`/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),

  /** DELETE /api/item?id=&lib=（永久刪除單項） */
  deleteItem: (lib, id) =>
    _json(`/api/item?id=${enc(id)}&lib=${enc(lib)}`, { method: 'DELETE' }),

  /* ── AI（P6 端點，B5 前端點亮）────────────────────────────────── */

  /** GET /api/ai/status → { ok, onnxruntime, clip_model_ready, …, libs } */
  aiStatus: () => _json('/api/ai/status'),

  /** GET /api/ai/search?q=…[&lib=…][&topk=…] → { status, body }
   *  （202 = 模型載入中、503 = 未安裝/模型缺、400 = 尚無索引） */
  aiSearch: (q, { lib, topk } = {}) => _jsonStatus(
    `/api/ai/search?q=${enc(q)}${lib ? `&lib=${enc(lib)}` : ''}${topk ? `&topk=${topk}` : ''}`),

  /** GET /api/ai/faces/persons?lib=… → { ok, clustered, persons } */
  aiFacesPersons: lib => _jsonStatus(`/api/ai/faces/persons?lib=${enc(lib)}`),

  /** GET /api/ai/faces/search?lib=&item=[&face=][&topk=][&all=1] → { status, body } */
  aiFacesSearch: (lib, item, { face, topk, all } = {}) => _jsonStatus(
    `/api/ai/faces/search?lib=${enc(lib)}&item=${enc(item)}` +
    `${face != null ? `&face=${face}` : ''}${topk ? `&topk=${topk}` : ''}${all ? '&all=1' : ''}`),

  /** POST /api/ai/index {lib, kind} → { status, body }（409 = already_running） */
  aiIndex: (lib, kind) => _jsonStatus('/api/ai/index', _POST_JSON({ lib, kind })),

  /** GET /api/ai/index/progress → { ok, job }（SSE 備援輪詢） */
  aiIndexProgress: () => _json('/api/ai/index/progress'),

  /* ── 匯入（B5 下載中心；後端 api_import.py 既有端點）──────────── */

  /** POST /api/import/url {url, lib, name?, folder_id?} → { ok, task_id } */
  importUrl: body => _json('/api/import/url', _POST_JSON(body)),

  /** GET /api/import/status/{taskId} → { ok, status, progress, result?, error? } */
  importStatus: taskId => _json(`/api/import/status/${enc(taskId)}`),

  /* ── 系統 ──────────────────────────────────────────────────────── */

  /** GET /api/services/health → { ok, services } */
  servicesHealth: () => _json('/api/services/health'),
};
