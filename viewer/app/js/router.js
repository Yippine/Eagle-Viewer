/* ── router.js ▸ hash-based 路由 + 宣告式 popstate 浮層管理 ────────────
   規格：P4 spec §5。核心原則：唯一 popstate handler = render(parseRoute())
   宣告式 diff；ephemeral guard 供手機 dialog/抽屜佔一層返回鍵（§5.4 #4/#5）。

   路由表：
     #/                              home（導向上次使用庫）
     #/lib/{libId}                   庫根 grid
     #/lib/{libId}/folder/{id}       資料夾導覽
     #/lib/{libId}/collection/{id}   Collections / 智慧集合
     #/lib/{libId}/trash             垃圾桶
     #/search?q=…                    搜尋（虛擬集合）
     #/people, #/people/{personId}   P6 人物頁（B1 保留 → 佔位頁）
     #/downloads  #/stats  #/settings/{tab}

   libId = {type}--{slug}，type ∈ eagle | excire | dir */

/* ── libId helpers ─────────────────────────────────────────────────── */

const LIB_TYPES = new Set(['eagle', 'excire', 'dir']);

/** 'eagle--handsome' → { type:'eagle', slug:'handsome' }；非法 → null */
export function parseLibId(libId) {
  const i = String(libId || '').indexOf('--');
  if (i < 0) return null;
  const type = libId.slice(0, i), slug = libId.slice(i + 2);
  if (!LIB_TYPES.has(type) || !slug) return null;
  return { type, slug };
}

/** ('excire','tsjh') → 'excire--tsjh' */
export function buildLibId(type, slug) { return `${type}--${slug}`; }

/* ── URL 解析 ──────────────────────────────────────────────────────── */

/** location.hash → route 物件 { name, params, query, path } */
export function parseRoute(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const query = new URLSearchParams(queryPart);
  const seg = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const r = { name: 'home', params: {}, query, path: pathPart };
  if (seg.length === 0) return r;

  switch (seg[0]) {
    case 'lib': {
      r.params.libId = seg[1] || '';
      if (!parseLibId(r.params.libId)) { r.name = 'notfound'; break; }
      if      (seg[2] === 'folder'     && seg[3]) { r.name = 'folder';     r.params.folderId = seg[3]; }
      else if (seg[2] === 'collection' && seg[3]) { r.name = 'collection'; r.params.collectionId = seg[3]; }
      else if (seg[2] === 'item'       && seg[3]) { r.name = 'lib';        r.params.itemId = seg[3]; }   // 深連結別名（規範形 = ?item=）
      else if (seg[2] === 'trash')                { r.name = 'trash'; }
      else if (seg.length <= 2)                   { r.name = 'lib'; }
      else                                        { r.name = 'notfound'; }
      break;
    }
    case 'search':    r.name = 'search'; break;
    case 'people':    r.name = 'people'; r.params.personId = seg[1] || null; break;
    case 'downloads': r.name = 'downloads'; break;
    case 'stats':     r.name = 'stats'; break;
    case 'settings':  r.name = 'settings'; r.params.tab = seg[1] || 'prefs'; break;
    default:          r.name = 'notfound';
  }
  return r;
}

/** route 片段組 hash：libHash('eagle--x', 'FOLDER1') → '#/lib/eagle--x/folder/FOLDER1' */
export function libHash(libId, folderId = null) {
  const base = `#/lib/${encodeURIComponent(libId)}`;
  return folderId ? `${base}/folder/${encodeURIComponent(folderId)}` : base;
}

/* ── 導覽 ──────────────────────────────────────────────────────────── */

let _render = null;   // 唯一 render callback（app.js 註冊）

function _fire() { if (_render) _render(parseRoute()); }

/** 導覽至 hash。replace=true → replaceState（篩選/排序等同視圖狀態演進） */
export function navigate(hash, { replace = false } = {}) {
  if (!hash.startsWith('#')) hash = '#' + hash;
  if (replace) {
    history.replaceState(history.state, '', hash);
    _fire();                       // replaceState 不觸發 popstate → 手動 render
  } else if (location.hash === hash) {
    _fire();                       // 同 hash 重導：無事件 → 手動 render
  } else {
    location.hash = hash;          // 觸發 popstate → 唯一 handler render
  }
}

/* ── Ephemeral guard（§5.4 #4/#5：手機 dialog/抽屜佔一層返回鍵）────── */

const _ephemerals = [];   // stack of close callbacks

/** 開啟 ephemeral 浮層：push 一層 history guard；返回鍵 = 關閉且不 re-render */
export function pushEphemeral(onClose) {
  history.pushState({ ...(history.state || {}), ephemeral: true }, '', location.href);
  _ephemerals.push(typeof onClose === 'function' ? onClose : null);
}

/** UI 主動關閉 ephemeral 浮層（✕/背板）：吃掉自己那層 history */
export function popEphemeral() {
  if (_ephemerals.length) history.back();   // → popstate handler 出棧並呼叫 onClose
}

/** 即將導覽他處時丟棄 guard（不 history.back()，避免與 hash 導覽競態；
 *  代價 = 殘留一層同 URL entry，back 多按一次無害） */
export function discardEphemerals() { _ephemerals.length = 0; }

/* ── 啟動：唯一 popstate handler ───────────────────────────────────── */

export function startRouter(render) {
  _render = render;
  window.addEventListener('popstate', () => {
    if (_ephemerals.length) {
      const close = _ephemerals.pop();
      if (close) close();
      return;                      // ephemeral pop：router 忽略此次 re-render
    }
    _fire();
  });
  _fire();                         // 初始 render
}
