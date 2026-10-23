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

  /* ── 系統 ──────────────────────────────────────────────────────── */

  /** GET /api/services/health → { ok, services } */
  servicesHealth: () => _json('/api/services/health'),
};
