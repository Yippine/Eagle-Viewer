/* ── actions.js ▸ 單項/批次操作層（B4；Phase A 垃圾桶完備化）─────────────
   所有寫入走後端既有端點（api_mutations.py），成功後樂觀 patch store
   （notifications.patchLocal → 'items-mutated'）+ toast；SSE 回聲再以權威
   資料校正。垃圾桶三庫型統一：Eagle = moveToTrash + archived tag（A2：後端
   跨庫 gate，degraded 時 toast 明示「僅本站封存」）；Excire/dir = 檔案層
   .viewer-trash + journal（A1/A3）。永久刪除僅限已在垃圾桶（前後端雙重保護）
   且必經確認 dialog；清空垃圾桶必經「輸入 DELETE」二次確認（A4）。
   Excire 項目編輯類操作（標籤/星等/改名…）維持唯讀 guard。 */

import { store } from './store.js';
import { api, mediaURL } from './api.js';
import { parseLibId } from './router.js';
import { h } from './items.js';
import { toast, patchLocal, removeLocal } from './notifications.js';
import { bustTrashBadge } from './lib-data.js';

let _ctx = { folderTree: () => [], folderName: id => id };
export function setActionsContext(ctx) { Object.assign(_ctx, ctx); }

/* ── 共用工具 ───────────────────────────────────────────────────────── */

export function libSlug() { return parseLibId(store.state.libId || '')?.slug || ''; }

export function itemsByIds(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const found = store.state.allItems.filter(i => set.has(i.id));
  if (found.length === set.size) return found;
  const have = new Set(found.map(i => i.id));           // 垃圾桶（journal）項目可能只在 gridItems
  for (const i of (store.state.gridItems || []))
    if (set.has(i.id) && !have.has(i.id)) { found.push(i); have.add(i.id); }
  return found;
}

export function isReadOnly(items) { return items.some(i => i.readOnly); }

function _guard(items) {
  if (!items.length) return false;
  if (isReadOnly(items)) { toast('Excire 庫為唯讀，無法編輯', { err: true }); return false; }
  return true;
}

/** 垃圾桶操作（封存/還原/永久刪除）不受 Excire 唯讀限制（A1 檔案層垃圾桶） */
function _guardTrash(items) { return items.length > 0; }

/** 既有標籤 ∪ 資料夾名 建議清單：[{ tag, isFolder, count }]（依使用數排序） */
export function tagSuggestions() {
  const cnt = new Map();
  for (const it of store.state.allItems)
    for (const t of (it.tags || []))
      if (t !== 'archived') cnt.set(t, (cnt.get(t) || 0) + 1);
  const folderNames = new Set();
  const walk = nodes => (nodes || []).forEach(n => { folderNames.add(n.name); walk(n.children); });
  walk(_ctx.folderTree());
  const out = [...cnt.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count, isFolder: folderNames.has(tag) }));
  for (const name of folderNames)
    if (!cnt.has(name)) out.push({ tag: name, count: 0, isFolder: true });
  return out;
}

/* ── 星等 / 標籤 / 資料夾 / 欄位 ────────────────────────────────────── */

export async function setStar(ids, star) {
  const items = itemsByIds(ids);
  if (!_guard(items)) return;
  try {
    for (const it of items)
      await api.patchItem('star', { id: it.id, lib: libSlug(), star });
    patchLocal(ids, () => ({ star }));
    toast(star ? `評分 ${star} 星` : '已清除評分');
  } catch (e) { toast(`評分失敗：${e.message}`, { err: true }); }
}

/** 單項標籤全量覆寫（Inspector inline 編輯用；archived 隱藏 tag 自動保留） */
export async function setTags(id, tags) {
  const [it] = itemsByIds([id]);
  if (!it || !_guard([it])) return;
  const hidden = (it.tags || []).filter(t => t === 'archived');
  const newTags = [...new Set([...hidden, ...tags.filter(t => t && t !== 'archived')])];
  try {
    await api.patchItem('tags', { id, lib: libSlug(), tags: newTags });
    patchLocal([id], () => ({ tags: newTags }));
    toast('標籤已更新');
  } catch (e) { toast(`標籤更新失敗：${e.message}`, { err: true }); }
}

/** 批次標籤：每項 (原 tags − removed) ∪ added */
export async function applyTagsBatch(ids, added, removed = []) {
  const items = itemsByIds(ids);
  if (!_guard(items)) return;
  const rm = new Set(removed);
  try {
    for (const it of items) {
      const cur = (it.tags || []).filter(t => !rm.has(t) || t === 'archived');
      const newTags = [...new Set([...cur, ...added.filter(t => t && t !== 'archived')])];
      await api.patchItem('tags', { id: it.id, lib: libSlug(), tags: newTags });
      patchLocal([it.id], () => ({ tags: newTags }));
    }
    toast(`已更新 ${items.length} 筆標籤`);
  } catch (e) { toast(`標籤更新失敗：${e.message}`, { err: true }); }
}

/** 移動/加入資料夾（單項回傳 new_tags 同步；批次走 batch 端點） */
export async function setFolders(ids, folderIds) {
  const items = itemsByIds(ids);
  if (!_guard(items) || !folderIds.length) return;
  const names = folderIds.map(_ctx.folderName).join('、');
  try {
    if (items.length === 1) {
      const d = await api.patchItem('folders',
        { id: items[0].id, lib: libSlug(), folder_ids: folderIds });
      patchLocal([items[0].id], () =>
        ({ folders: folderIds, ...(d.new_tags ? { tags: d.new_tags } : {}) }));
    } else {
      await api.postItems('items/folders-batch',
        { ids: items.map(i => i.id), lib: libSlug(), folder_ids: folderIds });
      patchLocal(ids, () => ({ folders: folderIds }));
    }
    toast(`已加入 ${names}`);
  } catch (e) { toast(`加入資料夾失敗：${e.message}`, { err: true }); }
}

export async function renameItem(id, name) {
  const [it] = itemsByIds([id]);
  if (!it || !_guard([it])) return;
  name = String(name || '').trim();
  if (it.ext) {                                   // 副檔名保護：去除誤加副檔名
    const suffix = `.${it.ext.toLowerCase()}`;
    if (name.toLowerCase().endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
  }
  if (!name || name === it.name) return;
  try {
    await api.patchItem('rename', { id, lib: libSlug(), name });
    patchLocal([id], () => ({ name }));
    toast('已改名');
  } catch (e) { toast(`改名失敗：${e.message}`, { err: true }); }
}

export async function setAnnotation(id, annotation) {
  const [it] = itemsByIds([id]);
  if (!it || !_guard([it])) return;
  try {
    await api.patchItem('annotation', { id, lib: libSlug(), annotation });
    patchLocal([id], () => ({ annotation }));
    toast('已儲存註解');
  } catch (e) { toast(`儲存失敗：${e.message}`, { err: true }); }
}

export async function setUrl(id, url) {
  const [it] = itemsByIds([id]);
  if (!it || !_guard([it])) return;
  try {
    await api.patchItem('url', { id, lib: libSlug(), url: String(url || '').trim() });
    patchLocal([id], () => ({ url: String(url || '').trim() }));
    toast('已儲存網址');
  } catch (e) { toast(`儲存失敗：${e.message}`, { err: true }); }
}

/* ── 垃圾桶雙軌（封存/還原/永久刪除）────────────────────────────────── */

export async function archiveItems(ids) {
  const items = itemsByIds(ids);
  if (!_guardTrash(items)) return;
  try {
    const d = await api.postItems('items/archive-batch',
      { ids: items.map(i => i.id), lib: libSlug() });
    const done = d.archived || items.map(i => i.id);
    patchLocal(done, it =>
      ({ tags: (it.tags || []).includes('archived') ? it.tags : [...(it.tags || []), 'archived'] }));
    bustTrashBadge();
    if (d.degraded && store.state.libType === 'eagle') {
      // A2：跨庫 / Eagle 未執行 / API 失敗 → 明示降級，不再靜默假成功
      toast(`已封存 ${done.length} 筆（僅本站封存，未同步 Eagle 垃圾桶）`,
        { err: true, duration: 6000, actionLabel: '復原', onAction: () => restoreItems(done) });
    } else {
      toast(`已封存 ${done.length} 筆`, { actionLabel: '復原', onAction: () => restoreItems(done) });
    }
  } catch (e) { toast(`封存失敗：${e.message}`, { err: true }); }
}

export async function restoreItems(ids) {
  const items = itemsByIds(ids);
  if (!_guardTrash(items)) return;
  try {
    const d = await api.postItems('items/restore-batch',
      { ids: items.map(i => i.id), lib: libSlug() });
    const done = d.restored || items.map(i => i.id);
    patchLocal(done, it => ({ tags: (it.tags || []).filter(t => t !== 'archived') }));
    bustTrashBadge();
    if (store.state.libType !== 'eagle') store.emit('lib-invalidate');  // dir/excire：下次進庫重載
    if (d.degraded && store.state.libType === 'eagle')
      toast(`已還原 ${done.length} 筆（僅本站還原，未同步 Eagle）`, { err: true, duration: 6000 });
    else
      toast(`已還原 ${done.length} 筆`);
  } catch (e) { toast(`還原失敗：${e.message}`, { err: true }); }
}

/** 永久刪除（兩步保護：僅限已在垃圾桶項目；必經確認 dialog；後端亦驗證） */
export async function deleteItems(ids) {
  const items = itemsByIds(ids);
  if (!_guardTrash(items)) return;
  const notArchived = items.filter(i => !(i.tags || []).includes('archived'));
  if (notArchived.length) {
    toast('需先加入垃圾桶（封存）才能永久刪除', { err: true });
    return;
  }
  const ok = await confirmDialog({
    title: '永久刪除',
    body: items.length === 1
      ? `確定永久刪除「${items[0].name}」？此操作無法復原。`
      : `確定永久刪除 ${items.length} 筆素材？此操作無法復原。`,
    okLabel: '永久刪除', danger: true,
  });
  if (!ok) return;
  try {
    const d = await api.postItems('items/delete-batch',
      { ids: items.map(i => i.id), lib: libSlug() });
    removeLocal(d.deleted || items.map(i => i.id));
    bustTrashBadge();
    toast(`已永久刪除 ${(d.deleted || items).length} 筆`);
  } catch (e) { toast(`刪除失敗：${e.message}`, { err: true }); }
}

/** 清空垃圾桶（A4：三種庫型統一；必經「輸入 DELETE」二次確認） */
export async function emptyTrash() {
  const slug = libSlug();
  if (!slug) return;
  const n = (store.state.gridItems || []).length;
  if (!n) { toast('垃圾桶已是空的'); return; }
  const ok = await confirmTypeDialog({
    title: '清空垃圾桶',
    body: `將永久刪除垃圾桶內全部 ${n} 筆素材，此操作無法復原。`,
    keyword: 'DELETE', okLabel: '永久刪除全部',
  });
  if (!ok) return;
  try {
    const d = await api.trashEmpty(slug);
    removeLocal(d.deleted || []);
    bustTrashBadge();
    toast(`已清空垃圾桶（永久刪除 ${(d.deleted || []).length} 筆）`);
  } catch (e) { toast(`清空失敗：${e.message}`, { err: true }); }
}

/* ── 複製 / 開檔 / 縮圖 ─────────────────────────────────────────────── */

async function _copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已複製${label}`);
  } catch (_) {
    const ta = document.createElement('textarea');       // clipboard API 失敗時 fallback
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(`已複製${label}`); }
    catch (e) { toast('複製失敗', { err: true }); }
    ta.remove();
  }
}

export function copyName(it) { _copy(it.ext ? `${it.name}.${it.ext}` : it.name, '名稱'); }
export function copyPath(it) { _copy(location.origin + mediaURL(it.file || it.preview || it.thumb), '路徑'); }

export function openFile(it) {
  const url = mediaURL(it.file || it.preview);
  if (url) window.open(url, '_blank', 'noopener');
}

/** 重新整理縮圖：cache-bust 版本號（grid/Inspector 讀 thumbV 綴 ?v=） */
export function refreshThumb(ids) {
  patchLocal(ids, () => ({ thumbV: Date.now() }));
  toast('已重新整理縮圖');
}

/* ── Dialog 元件（取代 prompt/confirm，F7）──────────────────────────── */

function _dlg(html) {
  const d = document.createElement('dialog');
  d.className = 'dlg';
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('cancel', () => d.close(''));
  return d;
}

/** 確認 dialog → Promise<boolean> */
export function confirmDialog({ title, body = '', okLabel = '確定', danger = false }) {
  return new Promise(resolve => {
    const d = _dlg(`
      <h3 class="dlg-title">${h(title)}</h3>
      ${body ? `<p class="dlg-body">${h(body)}</p>` : ''}
      <div class="dlg-actions">
        <button class="btn btn-ghost" value="">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" data-testid="dlg-ok">${h(okLabel)}</button>
      </div>`);
    d.querySelectorAll('.dlg-actions .btn').forEach(b =>
      b.addEventListener('click', () => d.close(b.value)));
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

/** 高危二次確認 dialog（A4 清空垃圾桶）：須輸入 keyword 才能按下確認 → Promise<boolean> */
export function confirmTypeDialog({ title, body = '', keyword = 'DELETE', okLabel = '永久刪除' }) {
  return new Promise(resolve => {
    const d = _dlg(`
      <h3 class="dlg-title">${h(title)}</h3>
      ${body ? `<p class="dlg-body">${h(body)}</p>` : ''}
      <div class="dlg-input-row">
        <input class="dlg-input" type="text" placeholder="輸入 ${h(keyword)} 以確認" autocomplete="off">
        <span class="dlg-hint">輸入 ${h(keyword)} 解鎖刪除按鈕</span>
      </div>
      <div class="dlg-actions">
        <button class="btn btn-ghost" value="">取消</button>
        <button class="btn btn-danger" value="ok" disabled data-testid="dlg-ok">${h(okLabel)}</button>
      </div>`);
    const input = d.querySelector('.dlg-input');
    const okBtn = d.querySelector('[value="ok"]');
    input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== keyword; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !okBtn.disabled) d.close('ok');
    });
    d.querySelectorAll('.dlg-actions .btn').forEach(b =>
      b.addEventListener('click', () => d.close(b.value)));
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
    requestAnimationFrame(() => input.focus());
  });
}

/** 輸入 dialog → Promise<string|null>（取消 = null） */
export function promptDialog({ title, value = '', placeholder = '', hint = '' }) {
  return new Promise(resolve => {
    const d = _dlg(`
      <h3 class="dlg-title">${h(title)}</h3>
      <div class="dlg-input-row">
        <input class="dlg-input" type="text" value="${h(value)}" placeholder="${h(placeholder)}">
        ${hint ? `<span class="dlg-hint">${h(hint)}</span>` : ''}
      </div>
      <div class="dlg-actions">
        <button class="btn btn-ghost" value="">取消</button>
        <button class="btn btn-primary" value="ok">確定</button>
      </div>`);
    const input = d.querySelector('.dlg-input');
    d.querySelectorAll('.dlg-actions .btn').forEach(b =>
      b.addEventListener('click', () => d.close(b.value)));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') d.close('ok'); });
    d.addEventListener('close', () =>
      resolve(d.returnValue === 'ok' ? input.value.trim() : null), { once: true });
    d.showModal();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/* ── 批次標籤 dialog（共同標籤可移除 + 建議自動完成新增）────────────── */

export function openTagsDialog(ids) {
  const items = itemsByIds(ids);
  if (!_guard(items)) return;
  const common = items[0] ? (items[0].tags || [])
    .filter(t => t !== 'archived' && items.every(i => (i.tags || []).includes(t))) : [];
  const removed = new Set(), added = [];
  const d = _dlg(`
    <h3 class="dlg-title">編輯標籤${items.length > 1 ? `（${items.length} 筆）` : ''}</h3>
    <div class="te-chips" data-te-chips></div>
    <input class="dlg-input" data-te-input placeholder="輸入或挑選標籤，Enter 加入…">
    <div class="te-suggest" data-te-suggest></div>
    <div class="dlg-actions">
      <button class="btn btn-ghost" value="">取消</button>
      <button class="btn btn-primary" value="ok" data-testid="tags-ok">套用</button>
    </div>`);
  const chipsEl = d.querySelector('[data-te-chips]');
  const input = d.querySelector('[data-te-input]');
  const sugEl = d.querySelector('[data-te-suggest]');
  const sugs = tagSuggestions();

  const active = () => [...common.filter(t => !removed.has(t)), ...added];
  const render = () => {
    chipsEl.innerHTML = active().map(t =>
      `<span class="chip chip-filter">${h(t)}<button class="chip-x" data-t="${h(t)}">✕</button></span>`)
      .join('') || `<span class="te-empty">尚無共同標籤</span>`;
    chipsEl.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.t;
      const i = added.indexOf(t);
      i >= 0 ? added.splice(i, 1) : removed.add(t);
      render(); renderSug();
    }));
  };
  const add = t => {
    t = String(t || '').trim();
    if (!t || t === 'archived' || active().includes(t)) return;
    removed.delete(t);
    if (!common.includes(t)) added.push(t);
    input.value = '';
    render(); renderSug();
  };
  const renderSug = () => {
    const q = input.value.trim().toLowerCase();
    const cur = new Set(active());
    sugEl.innerHTML = sugs
      .filter(s => !cur.has(s.tag) && (!q || s.tag.toLowerCase().includes(q)))
      .slice(0, 30)
      .map(s => `<button class="te-sug" data-t="${h(s.tag)}">${s.isFolder ? '📁 ' : ''}${h(s.tag)}${s.count ? `<span class="menu-count">${s.count}</span>` : ''}</button>`)
      .join('');
    sugEl.querySelectorAll('[data-t]').forEach(b =>
      b.addEventListener('click', () => add(b.dataset.t)));
  };
  input.addEventListener('input', renderSug);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); add(input.value); }
  });
  d.querySelectorAll('.dlg-actions .btn').forEach(b =>
    b.addEventListener('click', () => d.close(b.value)));
  d.addEventListener('close', () => {
    if (d.returnValue !== 'ok') return;
    if (added.length || removed.size)
      applyTagsBatch(items.map(i => i.id), added, [...removed]);
  }, { once: true });
  render(); renderSug();
  d.showModal();
  input.focus();
}

/* ── 資料夾 picker dialog（樹狀多選 + 搜尋 + 預選）──────────────────── */

export function openFolderDialog(ids) {
  const items = itemsByIds(ids);
  if (!_guard(items)) return;
  const tree = _ctx.folderTree();
  if (!tree.length) { toast('此庫沒有資料夾', { err: true }); return; }
  const pre = new Set(items.length === 1 ? (items[0].folders || [])
    : (items[0]?.folders || []).filter(f => items.every(i => (i.folders || []).includes(f))));
  const sel = new Set(pre);

  const node = n => `
    <li><label class="fp-row"><input type="checkbox" data-f="${h(n.id)}" ${sel.has(n.id) ? 'checked' : ''}>
      <span class="fp-name">${h(n.name)}</span></label>
      ${n.children?.length ? `<ul>${n.children.map(node).join('')}</ul>` : ''}</li>`;
  const d = _dlg(`
    <h3 class="dlg-title">加入資料夾${items.length > 1 ? `（${items.length} 筆）` : ''}</h3>
    <input class="dlg-input" data-fp-search placeholder="搜尋資料夾…">
    <ul class="fp-tree" data-fp-tree>${tree.map(node).join('')}</ul>
    <div class="dlg-actions">
      <button class="btn btn-ghost" value="">取消</button>
      <button class="btn btn-primary" value="ok" data-testid="folders-ok">套用</button>
    </div>`);
  const treeEl = d.querySelector('[data-fp-tree]');
  treeEl.addEventListener('change', e => {
    const cb = e.target.closest('[data-f]');
    if (cb) cb.checked ? sel.add(cb.dataset.f) : sel.delete(cb.dataset.f);
  });
  d.querySelector('[data-fp-search]').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    treeEl.querySelectorAll('li').forEach(li => {
      const hit = !q || li.textContent.toLowerCase().includes(q);
      li.style.display = hit ? '' : 'none';
    });
  });
  d.querySelectorAll('.dlg-actions .btn').forEach(b =>
    b.addEventListener('click', () => d.close(b.value)));
  d.addEventListener('close', () => {
    if (d.returnValue !== 'ok') return;
    if (!sel.size) { toast('請至少選擇一個資料夾', { err: true }); return; }
    setFolders(items.map(i => i.id), [...sel]);
  }, { once: true });
  d.showModal();
}
