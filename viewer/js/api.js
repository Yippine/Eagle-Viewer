'use strict';
/* ── api.js  ▸  伺服器 API 呼叫（fetch wrapper）────────────────────────── */

import { state } from './state.js';

/** 記錄一次觀看（同步本地 VIEWS + 送伺服器） */
export async function trackView(item, duration = 0) {
  if (!item || !item.id) return;
  const now   = new Date().toISOString();
  const entry = { t: now };
  if (duration > 0) entry.d = Math.round(duration);

  if (state.VIEWS[item.id]) {
    state.VIEWS[item.id].views = (state.VIEWS[item.id].views || 0) + 1;
    state.VIEWS[item.id].last_viewed = now;
    if (duration > 0)
      state.VIEWS[item.id].total_watch_time =
        (state.VIEWS[item.id].total_watch_time || 0) + Math.round(duration);
  } else {
    state.VIEWS[item.id] = {
      views: 1, name: item.name, domain: item.domain,
      history: [], last_viewed: now,
      total_watch_time: duration > 0 ? Math.round(duration) : 0,
    };
  }
  if (!state.VIEWS[item.id].history) state.VIEWS[item.id].history = [];
  state.VIEWS[item.id].history.push(entry);

  try {
    await fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id, name: item.name, domain: item.domain,
        duration: Math.round(duration),
        lib: state.activeLib,
      }),
    });
  } catch (_) {}
}

/** 刪除單筆觀看紀錄 */
export async function deleteHistoryEntry(itemId, t) {
  if (!state.VIEWS[itemId]) return;
  const hist = state.VIEWS[itemId].history || [];
  const idx  = hist.findIndex(e => e.t === t);
  if (idx === -1) return;
  const removed = hist.splice(idx, 1)[0];
  state.VIEWS[itemId].views = hist.length;
  state.VIEWS[itemId].total_watch_time =
    Math.max(0, (state.VIEWS[itemId].total_watch_time || 0) - (removed.d || 0));
  if (hist.length === 0) delete state.VIEWS[itemId];

  try {
    await fetch('/api/delete-view', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: itemId, t, lib: state.activeLib }),
    });
  } catch (_) {}
}

/** 清除全部觀看紀錄（目前資源庫） */
export async function clearAllViews() {
  state.VIEWS = {};
  try {
    await fetch('/api/clear-views', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lib: state.activeLib }),
    });
  } catch (_) {}
}
