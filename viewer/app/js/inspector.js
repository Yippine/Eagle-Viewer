/* ── inspector.js ▸ 右欄 Inspector 三態（B4，spec §1.4）──────────────────
   空態 = 庫統計｜單選 = 大縮圖 + metadata 全欄位 + inline 編輯（星等/標籤
   自動完成/改名/註記/URL/資料夾）+ Excire 唯讀 AI 區（AI 標籤/美學分數/
   人臉框 overlay）｜多選 = 計數 + 共同標籤 + 批次操作。
   所有寫入走 actions.js（樂觀 patch + toast，不整頁重繪，C53）。 */

import { store } from './store.js';
import { api, mediaURL } from './api.js';
import { h, fmtSize, fmtDate, fmtDuration, serializeTerms } from './items.js';
import { parseLibId } from './router.js';
import { setQuery } from './toolbar.js';
import * as act from './actions.js';

let _ctx = { folderName: id => id, libLabel: () => '' };
export function setInspectorContext(c) { Object.assign(_ctx, c); }

const $ = id => document.getElementById(id);
const _icon = n => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const TYPE_LABEL = { image: '圖片', video: '影片', gif: '動圖', bookmark: '書籤', other: '其他' };

const _facesCache = new Map();   // itemId → faces[]
const _metaCache = new Map();    // itemId → { tags, exif }（E04/E07）

/* ── 初始化 ─────────────────────────────────────────────────────────── */

export function initInspector() {
  store.on('selection', render);
  store.on('grid-items', render);
  store.on('items-mutated', render);
  _wireSelectionBar();

  /* 鍵盤 1–5 直接評分、0 清除（C51；viewer/輸入框外） */
  document.addEventListener('keydown', e => {
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
    if (!$('uviewer')?.hidden) return;
    if (!store.state.selection.size || !/^[0-5]$/.test(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    act.setStar([...store.state.selection], parseInt(e.key, 10));
  });
  render();
}

/* ── SelectionBar（批次操作列，C55）─────────────────────────────────── */

function _selIds() { return [...store.state.selection]; }

function _wireSelectionBar() {
  $('btn-sel-archive')?.addEventListener('click', () => act.archiveItems(_selIds()));
  $('btn-sel-tags')?.addEventListener('click', () => act.openTagsDialog(_selIds()));
  $('btn-sel-folders')?.addEventListener('click', () => act.openFolderDialog(_selIds()));
  $('btn-sel-restore')?.addEventListener('click', () => act.restoreItems(_selIds()));
  $('btn-sel-delete')?.addEventListener('click', () => act.deleteItems(_selIds()));
  store.on('selection', _syncBar);
  store.on('lib-context', _syncBar);
}

function _syncBar() {
  const trash = !!store.state.trash;
  const ro = store.state.libType === 'excire';
  $('btn-sel-archive')?.toggleAttribute('hidden', trash);
  $('btn-sel-tags')?.toggleAttribute('hidden', trash);
  $('btn-sel-folders')?.toggleAttribute('hidden', trash);
  $('btn-sel-restore')?.toggleAttribute('hidden', !trash);
  $('btn-sel-delete')?.toggleAttribute('hidden', !trash);
  for (const id of ['btn-sel-archive', 'btn-sel-tags', 'btn-sel-folders']) {
    const b = $(id);
    if (b) { b.disabled = ro; b.title = ro ? 'Excire 庫為唯讀' : ''; }
  }
}

/* ── 三態 render ────────────────────────────────────────────────────── */

function render() {
  const body = $('inspector-body');
  if (!body) return;
  const sel = store.state.selection;
  if (sel.size === 0) return _renderEmpty(body);
  const items = store.state.allItems.filter(i => sel.has(i.id));
  if (!items.length) return _renderEmpty(body);
  items.length === 1 ? _renderSingle(body, items[0]) : _renderMulti(body, items);
}

/* ── 空態：庫統計 ───────────────────────────────────────────────────── */

function _renderEmpty(body) {
  const { gridItems, gridTotal, allItems } = store.state;
  const cnt = k => gridItems.filter(i => i.mediaType === k).length;
  const tags = new Set();
  for (const i of allItems) for (const t of (i.tags || [])) if (t !== 'archived') tags.add(t);
  body.innerHTML = `<div class="insp-summary" data-insp="empty">
    <p class="insp-dim">${h(_ctx.libLabel() || '目前視圖')}</p>
    <p>項目數：<b>${gridTotal.toLocaleString()}</b></p>
    <p class="insp-dim">影片 ${cnt('video').toLocaleString()} · 圖片 ${(cnt('image') + cnt('gif')).toLocaleString()}${cnt('bookmark') ? ` · 書籤 ${cnt('bookmark')}` : ''}</p>
    ${tags.size ? `<p class="insp-dim">標籤 ${tags.size.toLocaleString()} 種</p>` : ''}
    <p class="insp-note">選取項目後在此檢視與編輯</p></div>`;
}

/* ── 單選 ───────────────────────────────────────────────────────────── */

function _renderSingle(body, it) {
  const ro = !!it.readOnly;
  const archived = (it.tags || []).includes('archived');
  const tags = (it.tags || []).filter(t => t !== 'archived');
  const folders = (it.folders || []).map(fid => ({ id: fid, name: _ctx.folderName(fid) }));
  const thumbSrc = mediaURL(it.thumb || it.preview) + (it.thumbV ? `?v=${it.thumbV}` : '');
  const info = [
    ['型別', TYPE_LABEL[it.mediaType] || it.mediaType],
    ['尺寸', it.width && it.height ? `${it.width}×${it.height}` : ''],
    ['大小', fmtSize(it.size)],
    ['時長', fmtDuration(it.duration)],
    ['加入', fmtDate(it.btime)],
    ['修改', fmtDate(it.mtime)],
    ['副檔名', (it.ext || '').toUpperCase()],
    ['網域', it.domain && it.domain !== 'local' ? it.domain : ''],
    ['ID', it.id],
  ].filter(([, v]) => v);

  body.innerHTML = `<div class="insp-item" data-insp="single" data-id="${h(it.id)}">
    <div class="insp-thumb" data-thumb>
      ${it.thumb || it.preview ? `<img src="${h(thumbSrc)}" alt="" decoding="async">` : `<div class="no-thumb">${_icon('image')}</div>`}
      <div class="insp-faces" data-faces></div>
    </div>
    ${ro ? `<div class="insp-ro-banner">${_icon('lock-ro')} Excire 唯讀庫 — 僅供檢視</div>` : ''}
    ${archived ? `<div class="insp-trash-banner">${_icon('trash')} 已在垃圾桶</div>` : ''}

    <label class="insp-label" for="insp-name">名稱</label>
    <div class="insp-name-row">
      <input class="insp-input" id="insp-name" data-name value="${h(it.name)}" ${ro ? 'disabled' : ''}>
      ${it.ext ? `<span class="insp-ext">.${h(it.ext)}</span>` : ''}
    </div>

    <div class="insp-label">星等</div>
    <div class="insp-stars" data-stars role="radiogroup" aria-label="星等">
      ${[1, 2, 3, 4, 5].map(n =>
        `<button class="insp-star${(it.star || 0) >= n ? ' on' : ''}" data-star="${n}" ${ro ? 'disabled' : ''} title="${n} 星">★</button>`).join('')}
    </div>

    <div class="insp-label">${ro ? 'AI 標籤' : '標籤'}</div>
    <div class="insp-tags" data-tags>
      ${tags.map(t => `<span class="chip${ro ? ' chip-ai' : ''}" data-tag="${h(t)}"><span class="tag-body" data-tag-search="${h(t)}">${h(t)}</span>${ro ? '' : `<button class="chip-x" data-tag-rm="${h(t)}" title="移除標籤">✕</button>`}</span>`).join('')}
      ${tags.length ? '' : `<span class="insp-note">無標籤</span>`}
    </div>
    ${ro ? '' : `<div class="insp-tag-add">
      <input class="insp-input" data-tag-input placeholder="新增標籤（自動完成）…">
      <div class="te-suggest" data-tag-suggest hidden></div>
    </div>`}

    ${it.source === 'excire' ? _excireBlock(it) : `
    <div class="insp-label">資料夾</div>
    <div class="insp-folders" data-folders>
      ${folders.map(f => `<span class="chip">${_icon('folder')}${h(f.name)}</span>`).join('') || `<span class="insp-note">未加入資料夾</span>`}
      <button class="btn btn-ghost btn-sm" data-act="folders" ${ro ? 'disabled' : ''}>變更…</button>
    </div>

    <label class="insp-label" for="insp-url">網址</label>
    <input class="insp-input" id="insp-url" data-url value="${h(it.url || '')}" placeholder="https://…" ${ro ? 'disabled' : ''}>

    <label class="insp-label" for="insp-note">註記</label>
    <textarea class="insp-input insp-textarea" id="insp-note" data-annotation rows="2"
      placeholder="註記…" ${ro ? 'disabled' : ''}>${h(it.annotation || '')}</textarea>`}

    <div class="insp-label">資訊</div>
    <div class="insp-info">${info.map(([k, v]) =>
      `<span class="insp-k">${h(k)}</span><span class="insp-v">${h(v)}</span>`).join('')}</div>

    <div class="insp-actions">
      ${it.file || it.preview ? `<button class="btn btn-ghost btn-sm" data-act="open">${_icon('external')}開原始檔</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="copy-name">複製名稱</button>
      ${it.file || it.preview ? `<button class="btn btn-ghost btn-sm" data-act="copy-path">複製路徑</button>` : ''}
      ${it.source === 'eagle' ? `<a class="btn btn-ghost btn-sm" href="eagle://item/${h(it.id)}">${_icon('library-eagle')}Eagle</a>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="refresh-thumb" ${ro ? 'disabled title="Excire 庫為唯讀"' : ''}>${_icon('retry')}縮圖</button>
      ${archived
        ? `<button class="btn btn-ghost btn-sm" data-act="restore" ${ro ? 'disabled' : ''}>${_icon('restore')}還原</button>
           <button class="btn btn-danger btn-sm" data-act="delete" ${ro ? 'disabled' : ''}>${_icon('trash')}永久刪除</button>`
        : `<button class="btn btn-ghost btn-sm" data-act="archive" ${ro ? 'disabled title="Excire 庫為唯讀"' : ''}>${_icon('trash')}加入垃圾桶</button>`}
    </div>
  </div>`;

  _wireSingle(body, it, ro);
  if (it.source === 'excire' && it.photoId != null) {
    _loadFaces(body, it);
    _loadExcireMeta(body, it);
  }
}

/** Excire 專屬唯讀區塊（E04/E06/E07） */
function _excireBlock(it) {
  return `
    <div class="insp-label">Excire AI</div>
    <div class="insp-info">
      ${it.aesthetics != null ? `<span class="insp-k">美學分數</span><span class="insp-v"><b>${it.aesthetics.toFixed(2)}</b><span class="insp-meter"><span style="width:${Math.min(100, it.aesthetics / 5 * 100)}%"></span></span></span>` : ''}
      <span class="insp-k">Excire 星等</span><span class="insp-v">${it.star ? '★'.repeat(Math.min(it.star, 5)) : '—'}</span>
      <span class="insp-k">人臉</span><span class="insp-v" data-face-count>偵測中…</span>
    </div>
    <div data-ai-conf hidden>
      <div class="insp-label">AI 標籤信心度</div>
      <div class="insp-conf" data-ai-conf-list></div>
    </div>
    <div data-exif hidden>
      <div class="insp-label">EXIF</div>
      <div class="insp-info" data-exif-table></div>
    </div>
    <div class="insp-label">相簿路徑</div>
    <div class="insp-folders">${(it.folders || []).map(f => `<span class="chip">${_icon('folder')}${h(f)}</span>`).join('') || '<span class="insp-note">—</span>'}</div>`;
}

/* ── Excire meta：per-tag confidence 條 + EXIF 表（E04/E07）──────────── */

function _fmtExif(k, v) {
  switch (k) {
    case 'ExposureTime': {
      const n = parseFloat(v);
      if (!isFinite(n) || n <= 0) return String(v);
      return n < 1 ? `1/${Math.round(1 / n)}s` : `${n}s`;
    }
    case 'FNumber':          return `f/${v}`;
    case 'FocalLengthMM':    return `${v}mm`;
    case 'FocalLength35MM':  return `${v}mm（等效）`;
    case 'CreationDate':     return String(v).replace('T', ' ');
    default:                 return String(v);
  }
}

const _EXIF_LABEL = {
  Camera: '相機', Lens: '鏡頭', ExposureTime: '快門', FNumber: '光圈',
  Iso: 'ISO', FocalLengthMM: '焦距', FocalLength35MM: '35mm 焦距',
  FlashFired: '閃光燈', CreationDate: '拍攝時間',
  Latitude: '緯度', Longitude: '經度', Altitude: '海拔',
};

async function _loadExcireMeta(body, it) {
  const lib = parseLibId(store.state.libId || '');
  if (!lib) return;
  let meta = _metaCache.get(it.id);
  if (!meta) {
    try {
      meta = await api.excirePhotoMeta(lib.slug, it.photoId);
      _metaCache.set(it.id, meta);
    } catch (_) { meta = { tags: [], exif: {} }; }
  }
  if (body.querySelector('.insp-item')?.dataset.id !== it.id) return;   // 選取已變

  const confBox = body.querySelector('[data-ai-conf]');
  if (confBox && (meta.tags || []).length) {
    confBox.hidden = false;
    confBox.querySelector('[data-ai-conf-list]').innerHTML = meta.tags.map(t => `
      <button class="conf-row" data-conf-tag="${h(t.keyword)}" title="以「${h(t.keyword)}」搜尋">
        <span class="conf-name">${h(t.keyword)}</span>
        <span class="insp-meter"><span style="width:${Math.round(t.confidence * 100)}%"></span></span>
        <span class="conf-val">${Math.round(t.confidence * 100)}%</span>
      </button>`).join('');
    confBox.querySelectorAll('[data-conf-tag]').forEach(el => el.addEventListener('click', () =>
      setQuery(serializeTerms([{ field: 'tag', value: el.dataset.confTag, exclude: false }]))));
  }

  const exifBox = body.querySelector('[data-exif]');
  const entries = Object.entries(meta.exif || {}).filter(([k]) => _EXIF_LABEL[k]);
  if (exifBox && entries.length) {
    exifBox.hidden = false;
    exifBox.querySelector('[data-exif-table]').innerHTML = entries.map(([k, v]) =>
      `<span class="insp-k">${_EXIF_LABEL[k]}</span><span class="insp-v">${h(_fmtExif(k, v))}</span>`).join('');
  }
}

function _wireSingle(body, it, ro) {
  const id = it.id;
  body.querySelector('[data-name]')?.addEventListener('change', e => act.renameItem(id, e.target.value));
  body.querySelector('[data-url]')?.addEventListener('change', e => act.setUrl(id, e.target.value));
  body.querySelector('[data-annotation]')?.addEventListener('change', e => act.setAnnotation(id, e.target.value));

  body.querySelectorAll('[data-star]').forEach(b => b.addEventListener('click', () => {
    const v = parseInt(b.dataset.star, 10);
    act.setStar([id], v === (it.star || 0) ? 0 : v);      // 再點同星 = 取消（C51）
  }));

  /* 標籤：chip 點擊 = 以該標籤搜尋；✕ = 移除；輸入 = 自動完成新增 */
  body.querySelectorAll('[data-tag-search]').forEach(el => el.addEventListener('click', () =>
    setQuery(serializeTerms([{ field: 'tag', value: el.dataset.tagSearch, exclude: false }]))));
  body.querySelectorAll('[data-tag-rm]').forEach(el => el.addEventListener('click', () => {
    const cur = (it.tags || []).filter(t => t !== 'archived' && t !== el.dataset.tagRm);
    act.setTags(id, cur);
  }));
  const tagInput = body.querySelector('[data-tag-input]');
  if (tagInput && !ro) _wireTagInput(body, tagInput, it);

  const ACT = {
    'open':          () => act.openFile(it),
    'copy-name':     () => act.copyName(it),
    'copy-path':     () => act.copyPath(it),
    'refresh-thumb': () => act.refreshThumb([id]),
    'archive':       () => act.archiveItems([id]),
    'restore':       () => act.restoreItems([id]),
    'delete':        () => act.deleteItems([id]),
    'folders':       () => act.openFolderDialog([id]),
  };
  body.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => ACT[b.dataset.act]?.()));
}

/** 標籤自動完成（既有標籤 ∪ 資料夾名，C49） */
function _wireTagInput(body, input, it) {
  const sugEl = body.querySelector('[data-tag-suggest]');
  const sugs = act.tagSuggestions();
  const cur = () => (it.tags || []).filter(t => t !== 'archived');
  const add = t => {
    t = String(t || '').trim();
    if (!t || cur().includes(t)) return;
    act.setTags(it.id, [...cur(), t]);
  };
  const renderSug = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { sugEl.hidden = true; sugEl.innerHTML = ''; return; }
    const list = sugs.filter(s => !cur().includes(s.tag) && s.tag.toLowerCase().includes(q)).slice(0, 12);
    sugEl.innerHTML = list.map(s =>
      `<button class="te-sug" data-t="${h(s.tag)}">${s.isFolder ? '📁 ' : ''}${h(s.tag)}${s.count ? `<span class="menu-count">${s.count}</span>` : ''}</button>`).join('');
    sugEl.hidden = !list.length;
    sugEl.querySelectorAll('[data-t]').forEach(b => b.addEventListener('mousedown', e => {
      e.preventDefault(); add(b.dataset.t);
    }));
  };
  input.addEventListener('input', renderSug);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); add(input.value); }
    if (e.key === 'Escape') { sugEl.hidden = true; }
  });
  input.addEventListener('blur', () => setTimeout(() => { sugEl.hidden = true; }, 150));
}

/* ── 人臉框 overlay（E06：/api/excire/{lib}/faces/{photoId}）────────── */

async function _loadFaces(body, it) {
  const lib = parseLibId(store.state.libId || '');
  if (!lib) return;
  let faces = _facesCache.get(it.id);
  if (!faces) {
    try {
      const d = await api.excireFaces(lib.slug, it.photoId);
      faces = d.faces || [];
      _facesCache.set(it.id, faces);
    } catch (_) { faces = []; }
  }
  if (body.querySelector('.insp-item')?.dataset.id !== it.id) return;   // 選取已變
  const cntEl = body.querySelector('[data-face-count]');
  if (cntEl) cntEl.textContent = faces.length ? `${faces.length} 張臉` : '未偵測到';
  const box = body.querySelector('[data-faces]');
  if (!box || !faces.length) return;
  box.innerHTML = faces.map(f => {
    const l = (f.cx - f.w / 2) * 100, t = (f.cy - f.h / 2) * 100;
    return `<span class="face-box" style="left:${l.toFixed(2)}%;top:${t.toFixed(2)}%;width:${(f.w * 100).toFixed(2)}%;height:${(f.h * 100).toFixed(2)}%${f.angle ? `;transform:rotate(${f.angle}deg)` : ''}" title="人臉"></span>`;
  }).join('');
}

/* ── 多選 ───────────────────────────────────────────────────────────── */

function _renderMulti(body, items) {
  const ro = act.isReadOnly(items);
  const trash = !!store.state.trash;
  const common = (items[0].tags || [])
    .filter(t => t !== 'archived' && items.every(i => (i.tags || []).includes(t)));
  const allArchived = items.every(i => (i.tags || []).includes('archived'));
  const dis = ro ? 'disabled title="Excire 庫為唯讀"' : '';

  body.innerHTML = `<div class="insp-item" data-insp="multi">
    <p class="insp-count">已選 <b>${items.length.toLocaleString()}</b> 個項目</p>
    <div class="insp-label">共同標籤</div>
    <div class="insp-tags">
      ${common.map(t => `<span class="chip">${h(t)}</span>`).join('') || `<span class="insp-note">無共同標籤</span>`}
    </div>
    <div class="insp-label">批次評分</div>
    <div class="insp-stars" data-stars>
      ${[1, 2, 3, 4, 5].map(n => `<button class="insp-star" data-star="${n}" ${ro ? 'disabled' : ''}>★</button>`).join('')}
      <button class="btn btn-ghost btn-sm" data-star="0" ${ro ? 'disabled' : ''}>清除</button>
    </div>
    <div class="insp-label">批次操作</div>
    <div class="insp-actions">
      <button class="btn btn-ghost btn-sm" data-act="tags" ${dis}>${_icon('tag')}加標籤</button>
      <button class="btn btn-ghost btn-sm" data-act="folders" ${dis}>${_icon('folder')}加資料夾</button>
      ${trash || allArchived
        ? `<button class="btn btn-ghost btn-sm" data-act="restore" ${dis}>${_icon('restore')}還原</button>
           <button class="btn btn-danger btn-sm" data-act="delete" ${dis}>${_icon('trash')}永久刪除</button>`
        : `<button class="btn btn-ghost btn-sm" data-act="archive" ${dis}>${_icon('trash')}加入垃圾桶</button>`}
    </div>
    ${ro ? `<div class="insp-ro-banner">${_icon('lock-ro')} Excire 唯讀庫 — 僅供檢視</div>` : ''}
  </div>`;

  const ids = items.map(i => i.id);
  body.querySelectorAll('[data-star]').forEach(b =>
    b.addEventListener('click', () => act.setStar(ids, parseInt(b.dataset.star, 10))));
  const ACT = {
    tags:    () => act.openTagsDialog(ids),
    folders: () => act.openFolderDialog(ids),
    archive: () => act.archiveItems(ids),
    restore: () => act.restoreItems(ids),
    delete:  () => act.deleteItems(ids),
  };
  body.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => ACT[b.dataset.act]?.()));
}
