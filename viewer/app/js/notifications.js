/* ── notifications.js ▸ Toast 通知 + SSE 事件消費（B4）──────────────────
   toast()：底部滑入、err 變體、action 槽（undo）、點擊即關（app 樣式
   components.css .toast）。
   SSE：後端既有 bus GET /api/events?lib={slug}（eagle/dir 庫）；
   item 變更事件 → patch store.allItems + emit 'items-mutated'（grid/
   Inspector 即時同步）；watcher 外部事件與 ai-index-progress → 掛提示。 */

import { store } from './store.js';
import { api } from './api.js';
import { adaptItem } from './items.js';
import { parseLibId } from './router.js';

/* ── Toast ──────────────────────────────────────────────────────────── */

/**
 * @param {string} msg
 * @param {object} opts { err?, actionLabel?, onAction?, duration?, sticky? }
 * @returns {{ el, update(msg), close() }}
 */
export function toast(msg, opts = {}) {
  if (!opts.sticky) _record(msg, !!opts.err);      // 通知紀錄（🔔 drawer / 設定頁）
  const root = document.getElementById('toast-root');
  if (!root) return { el: null, update() {}, close() {} };
  const t = document.createElement('div');
  t.className = 'toast' + (opts.err ? ' err' : '');
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);

  let timer = 0;
  const close = () => { clearTimeout(timer); t.remove(); };

  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'toast-action';
    a.textContent = opts.actionLabel;
    a.addEventListener('click', e => { e.stopPropagation(); close(); opts.onAction(); });
    t.appendChild(a);
  }
  t.addEventListener('click', close);

  root.appendChild(t);
  while (root.children.length > 4) root.firstChild.remove();   // 防堆疊
  if (!opts.sticky) timer = setTimeout(close, opts.duration ?? (opts.err ? 5200 : 3200));
  return { el: t, update(m) { text.textContent = m; }, close };
}

/* ── 本地 patch 工具（actions.js / SSE 共用）────────────────────────── */

/** 對 allItems 中指定 ids 套 patch（fn 可回傳部分欄位或直接改 it），
 *  完畢後 emit 'items-mutated'（app.js 重跑當前視圖、Inspector 重繪）。 */
export function patchLocal(ids, fn) {
  const set = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : [ids]);
  let hit = false;
  for (const it of store.state.allItems) {
    if (!set.has(it.id)) continue;
    const patch = fn(it);
    if (patch && patch !== it) Object.assign(it, patch);
    hit = true;
  }
  if (hit) store.emit('items-mutated');
  return hit;
}

/** 從 allItems / selection 移除 ids */
export function removeLocal(ids) {
  const set = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : [ids]);
  store.set({ allItems: store.state.allItems.filter(i => !set.has(i.id)) });
  let selChanged = false;
  for (const id of set)
    if (store.state.selection.delete(id)) selChanged = true;
  store.emit('items-mutated');
  if (selChanged) store.emit('selection');
}

/* ── 通知日誌（C61：三類分類 + localStorage 持久化跨重啟補追 + 🔔 drawer）─ */

const LOG_KEY = 'ev-notif-log';
const CAT_LABEL = { download: '下載', ai: 'AI', system: '系統' };
let _log = [];              // [{ ts, msg, err, cat }]
let _unread = 0;

try {
  const saved = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
  if (saved && Array.isArray(saved.log)) {
    _log = saved.log.slice(-100);
    _unread = Math.min(_log.length, saved.unread | 0);
  }
} catch (_) {}

function _persistLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify({ log: _log, unread: _unread })); }
  catch (_) {}
}

/** 訊息 → 三類分類（download / ai / system） */
function _catOf(msg) {
  if (/下載|上傳|匯入/.test(msg)) return 'download';
  if (/^AI\s|索引/.test(msg)) return 'ai';
  return 'system';
}

export function getNotifLog() { return _log; }
export function clearNotifLog() { _log.length = 0; _unread = 0; _syncBadge(); _persistLog(); }
export function notifCatLabel(cat) { return CAT_LABEL[cat] || '系統'; }

function _record(msg, err = false) {
  _log.push({ ts: Date.now(), msg, err, cat: _catOf(msg) });
  if (_log.length > 100) _log.shift();
  _unread++;
  _syncBadge();
  _persistLog();
}

function _syncBadge() {
  const b = document.getElementById('notif-badge');
  if (!b) return;
  b.hidden = !_unread;
  b.textContent = _unread > 99 ? '99+' : String(_unread);
}

const _esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** 通知列 HTML（drawer / 設定頁共用；cat 過濾） */
export function notifRowsHTML(cat = 'all') {
  const rows = [..._log].reverse().filter(n => cat === 'all' || (n.cat || 'system') === cat);
  if (!rows.length) return '<p class="insp-note" style="padding:12px">尚無通知；即時事件以 toast 顯示</p>';
  return rows.map(n => `<div class="notif-row${n.err ? ' err' : ''}">
      <span class="notif-time">${new Date(n.ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      <span class="notif-cat cat-${n.cat || 'system'}">${CAT_LABEL[n.cat] || '系統'}</span>
      <span>${_esc(n.msg)}</span></div>`).join('');
}

/** 頂列 🔔：右側 drawer 快速檢視（spec §1.2 ⑤）；開啟即標示已讀 */
export function openNotifDrawer() {
  document.querySelector('.notif-drawer')?.remove();
  _unread = 0; _syncBadge(); _persistLog();
  const d = document.createElement('div');
  d.className = 'notif-drawer';
  const catBtn = (c, l) => `<button class="chip${c === 'all' ? ' active' : ''}" data-nd-cat="${c}">${l}</button>`;
  d.innerHTML = `<div class="notif-drawer-hd"><b>通知</b>
      <button class="btn btn-ghost btn-sm" data-nd-clear ${_log.length ? '' : 'disabled'}>清除</button>
      <button class="btn btn-ghost btn-sm btn-icon" data-nd-close aria-label="關閉">✕</button></div>
    <div class="notif-cats">${catBtn('all', '全部')}${catBtn('system', '系統')}${catBtn('download', '下載')}${catBtn('ai', 'AI')}</div>
    <div class="notif-list">${notifRowsHTML()}</div>`;
  document.body.appendChild(d);
  const close = () => { d.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = e => { if (!d.contains(e.target)) close(); };
  document.addEventListener('mousedown', onDoc, true);
  d.querySelector('[data-nd-close]').addEventListener('click', close);
  d.querySelector('[data-nd-clear]').addEventListener('click', () => { clearNotifLog(); close(); });
  d.querySelectorAll('[data-nd-cat]').forEach(b => b.addEventListener('click', () => {
    d.querySelectorAll('[data-nd-cat]').forEach(x => x.classList.toggle('active', x === b));
    d.querySelector('.notif-list').innerHTML = notifRowsHTML(b.dataset.ndCat);
  }));
}

/* ── SSE ────────────────────────────────────────────────────────────── */

let _src = null;
let _sseLib = null;         // 目前連線的 lib slug
let _aiToast = null;        // ai-index-progress 進度 toast（覆用單一）

export function initNotifications() {
  _syncBadge();                    // 持久化補追：重啟後還原未讀 badge（C61）
  store.on('lib-context', _reconnect);
  _reconnect();
}

function _reconnect() {
  const lib = parseLibId(store.state.libId || '');
  const slug = lib && lib.type !== 'excire' ? lib.slug : null;   // Excire 唯讀無事件流
  if (slug === _sseLib) return;
  if (_src) { _src.close(); _src = null; }
  _sseLib = slug;
  if (!slug) return;
  try {
    _src = new EventSource(`/api/events?lib=${encodeURIComponent(slug)}`);
    _src.onmessage = e => { try { _handle(JSON.parse(e.data)); } catch (_) {} };
  } catch (_) { /* SSE 不可用時靜默（功能仍可操作） */ }
}

function _handle(evt) {
  const cur = parseLibId(store.state.libId || '');
  if (evt.lib && cur && evt.lib !== cur.slug) return;   // 其他庫事件忽略

  switch (evt.type) {
    /* ── item 變更（本端寫入的回聲 or 其他 client）：重抓權威資料 ── */
    case 'item_updated':
      _refetch(evt.id);
      break;

    case 'items_archived':
      patchLocal(evt.ids || [], it =>
        ({ tags: (it.tags || []).includes('archived') ? it.tags : [...(it.tags || []), 'archived'] }));
      break;

    case 'items_restored':
      patchLocal(evt.ids || [], it =>
        ({ tags: (it.tags || []).filter(t => t !== 'archived') }));
      break;

    case 'item_deleted':
      removeLocal([evt.id]);
      break;

    case 'item_created':
      toast('已新增項目（重新整理後顯示）');
      break;

    case 'tags_synced':
      toast('標籤同步完成（重新整理後生效）');
      break;

    /* ── Eagle App 外部異動（watcher）─────────────────────────── */
    case 'item_added_external':
      toast(`Eagle 新增 ${evt.diff ?? (evt.ids || []).length} 筆素材（重新整理後顯示）`);
      break;

    case 'item_trashed_external':
      patchLocal(evt.ids || [], it =>
        ({ tags: (it.tags || []).includes('archived') ? it.tags : [...(it.tags || []), 'archived'] }));
      toast(`Eagle 移入垃圾桶 ${(evt.ids || []).length} 筆`);
      break;

    case 'item_removed_external':
      removeLocal(evt.ids || []);
      toast(`Eagle 永久刪除 ${(evt.ids || []).length} 筆`);
      break;

    /* ── AI 索引進度：toast + 轉發（people.js / ai-status.js 進度條）── */
    case 'ai-index-progress':
      store.emit('ai-progress', evt);
      _aiProgress(evt);
      break;
  }
}

async function _refetch(id) {
  const lib = parseLibId(store.state.libId || '');
  if (!lib || lib.type === 'excire' || !id) return;
  try {
    const d = await api.item(lib.slug, id);
    if (!d?.item) return;
    const vm = adaptItem(d.item, lib.type);
    patchLocal([id], () => vm);
  } catch (_) { /* 已刪除等情況：忽略 */ }
}

const _AI_KIND = { clip: '語意索引', faces: '人臉索引' };

function _aiProgress(evt) {
  const kind = _AI_KIND[evt.kind] || evt.kind;
  if (evt.phase === 'done') {
    _aiToast?.close(); _aiToast = null;
    toast(`AI ${kind} 完成`);
    return;
  }
  if (evt.phase === 'error') {
    _aiToast?.close(); _aiToast = null;
    toast(`AI ${kind} 失敗：${evt.error || ''}`, { err: true });
    return;
  }
  const msg = evt.total
    ? `AI ${kind} ${evt.done ?? 0} / ${evt.total}…`
    : `AI ${kind} 進行中…`;
  if (_aiToast?.el?.isConnected) _aiToast.update(msg);
  else _aiToast = toast(msg, { sticky: true });
}
