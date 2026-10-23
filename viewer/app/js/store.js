/* ── store.js ▸ 輕量 pub/sub store（B2）──────────────────────────────────
   單一 store（state + on/emit/set），取代 window.* 全域匯流排（spec §6.1）。
   模組間以事件溝通：
     'grid-items'      grid 顯示清單更新（setItems/appendItems 後）
     'selection'       選取集合變更
     'view-changed'    密度/clean mode 變更（grid 需 relayout）
     'lib-context'     庫上下文切換（allItems 已就緒）
   規約：state 內容一律透過 set() 變更（可帶事件名），不直接改欄位。 */

const _subs = new Map();   // event → Set<fn>

export const store = {
  state: {
    /* ── 庫上下文 ─────────────────────────────────────────────── */
    libId: null,          // 'eagle--1 - Handsome.library' 等
    libType: null,        // 'eagle' | 'excire' | 'dir'
    folderId: null,       // 路由資料夾（導覽主體）
    allItems: [],         // 當前庫已知 vm items（eagle/dir 全量；excire = 已載入頁）
    gridItems: [],        // 篩選 + 排序後、grid 顯示中的清單
    gridTotal: 0,         // 「顯示 n / m 筆」的 m

    /* ── 篩選 / 排序 / 隨機（↔ URL query 雙向同步，toolbar.js 管理）── */
    filters: null,        // defaultFilters()；boot 時填入
    sort: { key: 'shuffle', dir: 'desc' },
    seed: null,           // 當前 shuffle seed（uint32；URL ?seed=）
    seeds: [],            // seed 歷史（FIFO，localStorage 持久化）
    seedIdx: -1,

    /* ── 檢視 ─────────────────────────────────────────────────── */
    density: 'cozy',      // 'comfy' | 'cozy' | 'compact'
    clean: false,         // true = 卡片隱藏 cbody（clean mode）

    /* ── 選取（B4 Inspector 消費）─────────────────────────────── */
    selection: new Set(), // Set<itemId>
    selAnchor: -1,        // Shift 範圍選取錨點（gridItems index）
    trash: false,         // 垃圾桶視圖（#/lib/{id}/trash；點擊 = 勾選）
  },

  /** 訂閱事件；回傳取消函式 */
  on(ev, fn) {
    if (!_subs.has(ev)) _subs.set(ev, new Set());
    _subs.get(ev).add(fn);
    return () => _subs.get(ev)?.delete(fn);
  },

  emit(ev, data) {
    for (const fn of (_subs.get(ev) || [])) {
      try { fn(data); } catch (e) { console.error(`[store] ${ev} handler:`, e); }
    }
  },

  /** 合併 patch 至 state；ev 提供時廣播事件 */
  set(patch, ev = null) {
    Object.assign(this.state, patch);
    if (ev) this.emit(ev, patch);
  },
};

/** 篩選五維 + 搜尋/網域/資料夾疊加 的預設值（URL 序列化時預設值不寫入） */
export function defaultFilters() {
  return {
    q: '',            // ⌘K 語法查詢字串
    type: 'all',      // 'all' | 'image' | 'video' | 'gif' | 'bookmark'
    star: 0,          // 最低星等（0 = 不限）
    tags: [],         // AND 標籤
    date: '',         // '' | 'today' | '7d' | '30d' | '365d'（mtime 範圍）
    size: '',         // '' | 's' | 'm' | 'l' | 'xl'（百萬像素分級）
    domains: [],      // OR 網域
    folders: [],      // 疊加 AND 資料夾 id（URL: folders=+id1,+id2）
  };
}

store.state.filters = defaultFilters();
