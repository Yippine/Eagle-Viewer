/* ── lib-data.js ▸ 中欄資料管線（B2 自 app.js 抽出；B4 +垃圾桶視圖）──────
   Eagle/dir = 全量 list 過濾排序；Excire = offset/limit 無限捲動分頁；
   trash = 僅 archived（C56）。app.js 以 initData() 注入 vmItems /
   folderWithDescendants 取用權（庫結構仍由 app.js 持有）。 */

import { store, defaultFilters } from './store.js';
import { api } from './api.js';
import { adaptItem, filterItems, sortItems, seededShuffle } from './items.js';
import { setItems, appendItems, setLoading, showMessage } from './grid.js';

let _c = {
  vmItems: () => [],                       // () => 當前庫全部 vm items
  folderWithDescendants: id => new Set([id]),
};
export function initData(ctx) { Object.assign(_c, ctx); }

/* ── Eagle / dir：全量過濾 + 排序 ───────────────────────────────────── */

export function refreshEagle(route, opts = {}) {
  const f = store.state.filters, s = store.state.sort;
  let base = _c.vmItems();
  const folderId = route.params.folderId;
  if (folderId) {
    const ids = _c.folderWithDescendants(folderId);
    base = base.filter(i => (i.folders || []).some(x => ids.has(x)));
  }
  const visibleTotal = base.filter(i => !(i.tags || []).includes('archived')).length;
  const folderSets = (f.folders || []).map(fid => _c.folderWithDescendants(fid));
  let list = filterItems(base, f, { folderSets });
  list = s.key === 'shuffle'
    ? seededShuffle(list, store.state.seed ?? 0)
    : sortItems(list, s.key, s.dir);
  setItems(list, { total: visibleTotal, keepScroll: opts.keepScroll });
}

/* ── 垃圾桶視圖（C56）：僅 archived、修改日期新→舊 ─────────────────── */

export function refreshTrash(opts = {}) {
  const list = sortItems(
    filterItems(_c.vmItems(), defaultFilters(), { trash: true }), 'mtime', 'desc');
  setItems(list, { total: list.length, keepScroll: opts.keepScroll });
  document.getElementById('ibar').hidden = false;
  if (!list.length) showMessage('trash', '垃圾桶是空的', '封存（加入垃圾桶）的項目會顯示在這裡');
}

export function updateTrashBadge() {
  const el = document.getElementById('trash-badge');
  if (!el) return;
  const n = store.state.libType === 'excire' ? 0
    : store.state.allItems.filter(i => (i.tags || []).includes('archived')).length;
  el.hidden = !n;
  el.textContent = n ? String(n) : '';
}

/* ── Excire：offset/limit 分頁 ──────────────────────────────────────── */

const _pg = { offset: 0, limit: 200, total: 0, busy: false, done: false, token: 0, lib: null, folderId: null };
const EXCIRE_SORT = { date: 'date', mtime: 'date', name: 'name', star: 'stars', aesthetics: 'aesthetics' };

export function refreshExcire(route, lib) {
  _pg.token++; _pg.offset = 0; _pg.total = 0; _pg.busy = false; _pg.done = false;
  _pg.lib = lib; _pg.folderId = route.params.folderId || null;
  store.set({ allItems: [] });
  setItems([], { total: 0, hasMore: true });
  loadExcirePage();
}

export async function loadExcirePage() {
  if (_pg.busy || _pg.done || !_pg.lib) return;
  _pg.busy = true; setLoading(true);
  const tok = _pg.token;
  const f = store.state.filters, s = store.state.sort;
  try {
    const d = await api.excirePhotos(_pg.lib.slug, {
      offset: _pg.offset, limit: _pg.limit,
      folder: _pg.folderId || undefined,
      keyword: f.tags[0] || undefined,                     // 第一個標籤 → Excire AI keyword
      sort: EXCIRE_SORT[s.key] || 'date', order: s.dir,
    });
    if (tok !== _pg.token) return;                         // 視圖已切換，丟棄
    const raw = d.items || [];
    _pg.offset += raw.length;
    _pg.total = d.total ?? 0;
    if (!raw.length || _pg.offset >= _pg.total) _pg.done = true;
    let vms = raw.map(r => adaptItem(r, 'excire'));
    // API 未支援的維度（型別/星等/日期/尺寸/q/第 2+ 標籤）→ 已載入頁 client-side 過濾
    vms = filterItems(vms, { ...f, tags: (f.tags || []).slice(1), domains: [], folders: [] });
    // 隨機排序：分頁內 seeded shuffle（seed^offset 決定性 → 同 seed 可重播）
    if (s.key === 'shuffle') vms = seededShuffle(vms, ((store.state.seed ?? 0) ^ _pg.offset) >>> 0);
    store.set({ allItems: store.state.allItems.concat(vms) });
    appendItems(vms, { total: _pg.total, hasMore: !_pg.done });
  } catch (e) {
    if (tok === _pg.token) { _pg.done = true; showMessage('close', '載入失敗', e.message); }
  } finally {
    if (tok === _pg.token) { _pg.busy = false; setLoading(false); }
  }
}
