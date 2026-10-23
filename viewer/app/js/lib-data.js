/* ── lib-data.js ▸ 中欄資料管線（B2 自 app.js 抽出；B4 +垃圾桶視圖）──────
   Eagle/dir = 全量 list 過濾排序；Excire = offset/limit 無限捲動分頁；
   trash = 僅 archived（C56）。app.js 以 initData() 注入 vmItems /
   folderWithDescendants 取用權（庫結構仍由 app.js 持有）。 */

import { store, defaultFilters } from './store.js';
import { api } from './api.js';
import { parseLibId } from './router.js';
import { adaptItem, filterItems, sortItems, seededShuffle } from './items.js';
import { setItems, appendItems, setLoading, showMessage } from './grid.js';
import { aiTagsSync, loadAiTags } from './ai-tags.js';

/** B5 人數/場景/運動篩選啟用時取 aiTags map；未載入 → 觸發載入 + 完成回呼 */
function _aiTagsFor(f, onLoaded) {
  if (!(f.people || f.scene || f.sport)) return null;
  const slug = parseLibId(store.state.libId || '')?.slug;
  if (!slug) return null;
  const m = aiTagsSync(slug);
  if (m) return m;
  loadAiTags(slug).then(() => {
    if (parseLibId(store.state.libId || '')?.slug === slug) onLoaded();
  });
  return null;                      // 載入前不套用該維度（載入後重繪）
}

let _c = {
  vmItems: () => [],                       // () => 當前庫全部 vm items
  folderWithDescendants: id => new Set([id]),
};
export function initData(ctx) { Object.assign(_c, ctx); }

/* ── Eagle / dir：全量過濾 + 排序 ───────────────────────────────────── */

/** 濾鏡 preset 反查（C12）：presetIds 含任一選中 preset 的 item id 集合（OR） */
function _presetItemIds(pids) {
  const want = new Set(pids), out = new Set();
  const PREFIX = 'eagle-media-filter-';
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    try {
      const d = JSON.parse(localStorage.getItem(k) || '{}');
      if ((d.presetIds || []).some(p => want.has(p))) out.add(k.slice(PREFIX.length));
    } catch (_) {}
  }
  return out;
}

export function refreshEagle(route, opts = {}) {
  const f = store.state.filters, s = store.state.sort;
  let base = _c.vmItems();
  const folderId = route.params.folderId;
  if (folderId) {
    const ids = _c.folderWithDescendants(folderId);
    base = base.filter(i => (i.folders || []).some(x => ids.has(x)));
  }
  if (f.presets?.length) {
    const ids = _presetItemIds(f.presets);
    base = base.filter(i => ids.has(i.id));
  }
  const visibleTotal = base.filter(i => !(i.tags || []).includes('archived')).length;
  const folderSets = (f.folders || []).map(fid => _c.folderWithDescendants(fid));
  const aiTags = _aiTagsFor(f, () => refreshEagle(route, { keepScroll: true }));
  let list = filterItems(base, f, { folderSets, aiTags });
  list = s.key === 'shuffle'
    ? seededShuffle(list, store.state.seed ?? 0)
    : sortItems(list, s.key, s.dir);
  setItems(list, { total: visibleTotal, keepScroll: opts.keepScroll });
}

/* ── 垃圾桶視圖（C56；Phase A：三種庫型統一）───────────────────────────
   Eagle = 快取 archived tag 客端過濾；Excire/dir = journal（.viewer-trash）
   伺服端清單（GET /api/trash/list），修改日期新→舊。 */

let _trashToken = 0;

export function refreshTrash(opts = {}) {
  const t = store.state.libType;
  if (t === 'excire' || t === 'dir') { _refreshTrashRemote(opts); return; }
  const list = sortItems(
    filterItems(_c.vmItems(), defaultFilters(), { trash: true }), 'mtime', 'desc');
  setItems(list, { total: list.length, keepScroll: opts.keepScroll });
  document.getElementById('ibar').hidden = false;
  if (!list.length) showMessage('trash', '垃圾桶是空的', '封存（加入垃圾桶）的項目會顯示在這裡');
}

async function _refreshTrashRemote(opts) {
  const lib = parseLibId(store.state.libId || '');
  if (!lib) return;
  const tok = ++_trashToken;
  setLoading(true);
  try {
    const d = await api.trashList(lib.slug);
    if (tok !== _trashToken) return;                        // 視圖已切換，丟棄
    const vms = sortItems((d.items || []).map(r => adaptItem(r, lib.type)), 'mtime', 'desc');
    store.set({ allItems: vms });                           // 供選取/Inspector/操作層查找
    setItems(vms, { total: vms.length, keepScroll: opts.keepScroll });
    document.getElementById('ibar').hidden = false;
    _setBadge(vms.length);
    if (!vms.length) showMessage('trash', '垃圾桶是空的', '刪除（加入垃圾桶）的項目會顯示在這裡');
  } catch (e) {
    if (tok === _trashToken) showMessage('close', '垃圾桶載入失敗', e.message);
  } finally {
    if (tok === _trashToken) setLoading(false);
  }
}

function _setBadge(n) {
  const el = document.getElementById('trash-badge');
  if (!el) return;
  el.hidden = !n;
  el.textContent = n ? String(n) : '';
}

let _badgeCache = { lib: null, ts: 0 };   // journal 計數節流（grid-items 事件頻繁）

export function updateTrashBadge(opts = {}) {
  const t = store.state.libType;
  if (t !== 'excire' && t !== 'dir') {
    _setBadge(store.state.allItems.filter(i => (i.tags || []).includes('archived')).length);
    return;
  }
  const lib = parseLibId(store.state.libId || '');
  if (!lib) { _setBadge(0); return; }
  if (!opts.force && _badgeCache.lib === lib.slug && Date.now() - _badgeCache.ts < 5000) return;
  _badgeCache = { lib: lib.slug, ts: Date.now() };
  api.trashList(lib.slug)
    .then(d => {
      if (parseLibId(store.state.libId || '')?.slug === lib.slug)
        _setBadge(d.total ?? (d.items || []).length);
    })
    .catch(() => _setBadge(0));
}

/** 垃圾桶計數快取失效（封存/還原/刪除後由 actions.js 呼叫） */
export function bustTrashBadge() { _badgeCache = { lib: null, ts: 0 }; updateTrashBadge({ force: true }); }

/** Excire 分頁視圖：寫入操作（封存）後就地剔除 archived 項（分頁狀態不重抓） */
export function dropArchivedFromExcireGrid() {
  const all = store.state.allItems;
  const vms = all.filter(i => !(i.tags || []).includes('archived'));
  const removed = all.length - vms.length;
  if (!removed) return;
  _pg.total = Math.max(0, _pg.total - removed);
  store.set({ allItems: vms });
  setItems(vms, { total: _pg.total, hasMore: !_pg.done, keepScroll: true });
}

/* ── Excire：offset/limit 分頁 ──────────────────────────────────────── */

const _pg = { offset: 0, limit: 200, total: 0, busy: false, done: false, token: 0,
              lib: null, folderId: null, collectionId: null };
const EXCIRE_SORT = { date: 'date', mtime: 'date', name: 'name', star: 'stars', aesthetics: 'aesthetics' };

export function refreshExcire(route, lib) {
  _pg.token++; _pg.offset = 0; _pg.total = 0; _pg.busy = false; _pg.done = false;
  _pg.lib = lib; _pg.folderId = route.params.folderId || null;
  _pg.collectionId = route.name === 'collection' ? (route.params.collectionId || null) : null;
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
      collection: _pg.collectionId || undefined,           // 相簿虛擬集合（E03）
      keyword: f.tags[0] || undefined,                     // 第一個標籤 → Excire AI keyword
      sort: EXCIRE_SORT[s.key] || 'date', order: s.dir,
    });
    if (tok !== _pg.token) return;                         // 視圖已切換，丟棄
    const raw = d.items || [];
    _pg.offset += raw.length;
    _pg.total = d.total ?? 0;
    if (!raw.length || _pg.offset >= _pg.total) _pg.done = true;
    let vms = raw.map(r => adaptItem(r, 'excire'));
    // API 未支援的維度（型別/星等/日期/尺寸/q/第 2+ 標籤/人數/場景/運動）
    // → 已載入頁 client-side 過濾（B5 aiTags 未載入時先 await，避免漏濾）
    let aiTags = null;
    if (f.people || f.scene || f.sport)
      aiTags = aiTagsSync(_pg.lib.slug) || await loadAiTags(_pg.lib.slug);
    vms = filterItems(vms, { ...f, tags: (f.tags || []).slice(1), domains: [], folders: [] },
                      { aiTags });
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
