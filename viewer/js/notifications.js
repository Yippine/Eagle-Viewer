'use strict';
/* ── notifications.js  ▸  通知中心（Eagle 事件自動同步日誌） ── */
/*
 * 設計原則：全自動套用，通知中心只顯示結果日誌
 *   ok      → ✅ 已同步（無需操作）
 *   loading → ⏳ 處理中（如 extract 重載）
 *   error   → ❌ 失敗，顯示重試按鈕
 *
 * 角標：僅在有 error 項目時顯示（紅色），告知使用者需注意
 * 面板開啟時：清除 unread 狀態（角標可降為 0，但 error 仍保留）
 */

const _notifs = [];   // [{ id, type, count, ids, diff, time, status, error, unread }]
let _retryFn    = null;  // 由 main.js 注入 retry callback（避免循環依賴）
let _currentLib = null;  // 當前資源庫名稱，由 loadPersistedNotifs 設定（N01-A）

/* ── 型別設定 ────────────────────────────────────────────────── */
const _TYPE_INFO = {
  'item_added_external':   { icon: '➕', label: '新增素材' },
  'item_trashed_external': { icon: '🗑', label: '移至垃圾桶' },
  'item_removed_external': { icon: '❌', label: '永久刪除' },
};

/* ── 公開 API ─────────────────────────────────────────────────── */

/** 注入 retry callback（main.js 呼叫，解決循環依賴） */
export function registerRetryFn(fn) { _retryFn = fn; }

/** 新增通知（status 預設 'ok'，loading 由呼叫方傳入） */
export function addNotification(type, data, status = 'ok') {
  const n = {
    id:     Date.now() + Math.random(),
    type,
    count:  data.ids?.length || data.diff || data.count || 1,
    ids:    data.ids   || [],
    snaps:  data.snaps || {},   // { id → { name, ext, folder } } 快照
    diff:   data.diff  || 0,
    time:   new Date(),
    status,          // 'ok' | 'loading' | 'error'
    error:  null,
    unread: true,
  };
  _notifs.unshift(n);
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
  return n.id;   // 呼叫方可用 id 更新狀態
}

/** 回填通知的 snaps 快照（item_added_external 在 _loadLibraryData 後呼叫） */
export function updateNotifNames(id, snaps) {
  const n = _notifs.find(x => x.id === id);
  if (!n) return;
  n.snaps = { ...n.snaps, ...snaps };
  if (n.expanded) _renderList();   // 若已展開則即時刷新
  persistNotifs(_currentLib);
}

/** 更新通知狀態（loading → ok / error） */
export function updateNotifStatus(id, status, error = null) {
  const n = _notifs.find(x => x.id === id);
  if (!n) return;
  n.status = status;
  n.error  = error;
  n.unread = status === 'error';  // error 保持 unread 直到重試成功
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
}

/* ── 通知 Tab 開啟（t042 w022-dev）──────────────────────────────── */

/** 切換至 🔔通知 tab 時呼叫：清除 ok/loading unread（error 保留提醒使用者）*/
export function onNotifTabOpen() {
  _notifs.forEach(n => { if (n.status !== 'error') n.unread = false; });
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
}

/** 向後相容：通知面板已整合至 ⚙ 設定面板，此函式導向 openSettingsPanel('notif') */
export function openNotifPanel() {
  window.openSettingsPanel?.('notif');
}
export function closeNotifPanel() { /* no-op：由設定面板統一管理 */ }

/* ── 渲染 ─────────────────────────────────────────────────────── */

function _relTime(date) {
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60)   return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  return `${Math.floor(s / 3600)} 小時前`;
}

function _renderBadge() {
  const badge  = document.getElementById('notif-badge');
  const errors = _notifs.filter(n => n.status === 'error').length;
  if (!badge) return;
  if (errors > 0) {
    badge.textContent = errors > 9 ? '9+' : String(errors);
    badge.removeAttribute('hidden');
    badge.className = 'notif-badge error';
  } else {
    // 有未讀 ok 通知時顯示藍點（小點，無數字）
    const unread = _notifs.filter(n => n.unread).length;
    if (unread > 0) {
      badge.textContent = '';
      badge.removeAttribute('hidden');
      badge.className = 'notif-badge info';
    } else {
      badge.setAttribute('hidden', '');
    }
  }
}

function _statusIcon(status) {
  return { ok: '✅', loading: '⏳', error: '❌' }[status] ?? '🔔';
}

const _KIND_ICON = { video: '🎬', post: '📄', other: '🔗' };

function _renderDetail(n) {
  const lines = [];

  // 錯誤訊息
  if (n.error) {
    lines.push(`<p class="nd-error">⚠️ ${n.error}</p>`);
  }

  // 影響的檔案清單（有 ids 才顯示）
  if (n.ids?.length) {
    const MAX = 5;
    const lookup = window._lookupItem;
    const items = n.ids.slice(0, MAX).map(id => {
      // 即時查詢優先，快照補底
      const live   = lookup?.(id);
      const snap   = n.snaps?.[id] || {};
      const name   = live?.name  || snap.name   || id;
      const ext    = live?.ext   || snap.ext    || '';
      const kind   = live?.kind  || snap.kind   || 'other';
      const folders = snap.folders?.length ? snap.folders : (() => {
        const fmap = window._folderMap?.() || {};
        return (live?.folders || []).map(fid => fmap[fid]?.name).filter(Boolean);
      })();
      const icon        = _KIND_ICON[kind] ?? '🔗';
      const fname       = ext ? `${name}.${ext}` : name;
      const folderHtml  = folders.length
        ? `<div class="nd-folders">${folders.map(f => `<span class="nd-folder">📁 ${f}</span>`).join('')}</div>`
        : '';
      return `<li class="nd-file"><div class="nd-file-row"><span class="nd-kind-icon">${icon}</span><span class="nd-fname">${fname}</span></div>${folderHtml}</li>`;
    });
    const rest = n.ids.length - MAX;
    if (rest > 0) items.push(`<li class="nd-more">…還有 ${rest} 筆</li>`);
    lines.push(`<ul class="nd-file-list">${items.join('')}</ul>`);
  }

  // item_added_external 失敗時無 ids，給操作建議
  if (n.type === 'item_added_external' && n.status === 'error' && !n.ids?.length) {
    lines.push(`<p class="nd-hint">💡 請確認 serve.py 正常運作，或手動重整頁面</p>`);
  }

  if (!lines.length) return '';
  return `<div class="notif-detail" onclick="event.stopPropagation()">${lines.join('')}</div>`;
}

function _renderList() {
  const list  = document.getElementById('notif-list');
  const empty = document.getElementById('notif-empty');
  if (!list) return;

  const footer = document.getElementById('notif-footer');
  if (_notifs.length === 0) {
    list.innerHTML = '';
    empty?.removeAttribute('hidden');
    footer?.setAttribute('hidden', '');
    return;
  }
  empty?.setAttribute('hidden', '');
  footer?.removeAttribute('hidden');

  list.innerHTML = _notifs.map(n => {
    const info  = _TYPE_INFO[n.type] || { icon: '🔔', label: '通知' };
    const count = n.type === 'item_added_external' ? `${n.diff} 筆` : `${n.count} 筆`;
    const action = n.status === 'error'
      ? `<button class="notif-retry-btn" onclick="event.stopPropagation();window._notifRetry(${n.id})">重試</button>`
      : '';
    const detailEl = n.expanded ? _renderDetail(n) : '';
    return `
      <div class="notif-item status-${n.status}${n.unread ? ' unread' : ''}${n.expanded ? ' expanded' : ''}"
           onclick="event.stopPropagation();window._notifToggle(${n.id})">
        <span class="notif-type-icon">${info.icon}</span>
        <div class="notif-body">
          <p class="notif-desc">${info.label} <strong>${count}</strong></p>
          <span class="notif-time">${_relTime(n.time)}</span>
        </div>
        <span class="notif-status-icon">${_statusIcon(n.status)}</span>
        ${action}
        <button class="notif-delete-btn" title="刪除此通知" onclick="event.stopPropagation();window._notifDelete(${n.id})">✕</button>
        ${detailEl}
      </div>`;
  }).join('');
}

/* ── 展開 / 收合（點擊通知列） ──────────────────────────────── */
window._notifToggle = (id) => {
  const n = _notifs.find(x => x.id === id);
  if (!n) return;
  n.expanded = !n.expanded;
  _renderList();
};

/* ── Retry（由 main.js registerRetryFn 注入）────────────────── */
window._notifRetry = (id) => {
  const n = _notifs.find(x => x.id === id);
  if (!n || !_retryFn) return;
  n.status   = 'loading';
  n.error    = null;
  n.expanded = false;
  _renderList();
  _retryFn(n);
};

/* ── 管理操作（N03）─────────────────────────────────────────── */

/** 全部已讀：清除所有 unread 狀態（不刪除通知） */
export function markAllRead() {
  _notifs.forEach(n => { n.unread = false; });
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
}

/** 刪除單筆通知 */
export function deleteNotif(id) {
  const idx = _notifs.findIndex(x => x.id === id);
  if (idx < 0) return;
  _notifs.splice(idx, 1);
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
}

/** 清除全部通知（二次確認） */
export function clearAllNotifs() {
  if (!confirm('確定清除所有通知？')) return;
  _notifs.length = 0;
  _renderBadge();
  _renderList();
  persistNotifs(_currentLib);
}

window._notifDelete      = (id) => deleteNotif(id);
window._notifClearAll    = ()   => clearAllNotifs();
window._notifMarkAllRead = ()   => markAllRead();
window._notifOnTabOpen   = ()   => onNotifTabOpen();

/* ── 持久化（N01-A）─────────────────────────────────────────── */

/** 序列化 _notifs → localStorage（FIFO 上限 50 筆）*/
function persistNotifs(libName) {
  if (!libName) return;
  const data = _notifs.slice(0, 50).map(n => ({
    id:     n.id,
    type:   n.type,
    count:  n.count,
    ids:    n.ids,
    snaps:  n.snaps,
    diff:   n.diff,
    time:   n.time instanceof Date ? n.time.toISOString() : n.time,
    status: n.status,
    error:  n.error,
    unread: n.unread,
    // expanded 為 UI 暫態，不序列化
  }));
  try {
    localStorage.setItem(`eagle-notifs-${libName}`, JSON.stringify(data));
  } catch (_) { /* localStorage 滿時靜默失敗 */ }
}

/** 載入持久化通知（由 main.js 在 _loadLibraryData 後呼叫）*/
export function loadPersistedNotifs(libName) {
  _currentLib = libName;
  try {
    const raw = localStorage.getItem(`eagle-notifs-${libName}`);
    if (!raw) { _renderBadge(); _renderList(); return; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    _notifs.length = 0;
    _notifs.push(...parsed.map(r => ({
      ...r,
      time:     new Date(r.time),
      expanded: false,
    })));
  } catch (_) { /* parse 失敗靜默處理 */ }
  _renderBadge();
  _renderList();
}

/** 清除記憶體通知（切換資源庫時呼叫）*/
export function clearMemoryNotifs() {
  _notifs.length = 0;
  _currentLib    = null;
  _renderBadge();
  _renderList();
}
